"use strict";
/* Tests for the layer between a connection's tools and the file browser. */
const assert = require("assert");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");

const connections = require("../src/main/connections");
const secrets = require("../src/main/secrets");
const mcp = require("../src/main/mcp-client");
const cloud = require("../src/main/cloud");

const FIXTURE = path.join(__dirname, "fixtures", "mcp-server.mjs");
const ALL = ["list_recent_files", "search_files", "read_file_content", "get_file_metadata", "create_file", "bump_version"];
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f]");

function fakeStore(){
  const state = { connections: [] };
  return { get: () => state, save: p => (Object.assign(state, p), state), _state: state };
}

module.exports = async function run(test){
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "inkju-cloud-"));
  secrets.setBackend({
    isEncryptionAvailable: () => true,
    encrypt: async t => Buffer.from("v1:" + Buffer.from(t, "utf8").toString("hex")),
    decrypt: async b => Buffer.from(Buffer.from(b).toString("utf8").slice(3), "hex").toString("utf8")
  });
  secrets.setFile(path.join(dir, "secrets.json"));

  let id = null;
  const start = async (allow) => {
    await mcp.disconnectAll();
    connections.setStore(fakeStore());
    connections.resetLive();
    connections.events.removeAllListeners();
    const c = connections.add({
      label: "Fixture", transport: "stdio",
      config: { command: process.execPath, args: [FIXTURE] }
    });
    id = c.id;
    await mcp.connect(id);
    connections.update(id, { allow: allow || ALL });
    return id;
  };

  /* ------------------------------------------------------- capabilities */

  await test("capabilities follow the allowlist, not just the tool list", async () => {
    await start([]);
    let caps = cloud.capabilities(id);
    assert.strictEqual(caps.canRead, false, "a tool nobody ticked is not a capability");
    assert.strictEqual(caps.canWrite, false);
    connections.update(id, { allow: ["read_file_content", "list_recent_files"] });
    caps = cloud.capabilities(id);
    assert.strictEqual(caps.canRead, true);
    assert.strictEqual(caps.canList, true);
    assert.strictEqual(caps.canWrite, false, "write appeared without being allowed");
  });

  await test("a connection with no write tool allowed is read-only", async () => {
    await start(["list_recent_files", "read_file_content", "get_file_metadata"]);
    assert.strictEqual(cloud.capabilities(id).canWrite, false);
    await assert.rejects(() => cloud.writeFile(id, "f1", "x"), /read-only/i);
  });

  await test("conflict detection is off when there is no metadata tool", async () => {
    await start(["list_recent_files", "read_file_content"]);
    assert.strictEqual(cloud.capabilities(id).canDetectConflicts, false);
    const c = await cloud.checkForConflict(id, "f1", "1");
    assert.strictEqual(c.known, false, "a connection that cannot tell must answer unknown");
  });

  /* ------------------------------------------------------------ listing */

  await test("listing normalises whatever the server called its fields", async () => {
    await start();
    const rows = await cloud.listFiles(id, {});
    const notes = rows.find(r => r.id === "f1");
    assert.strictEqual(notes.name, "Notes.md");
    assert.strictEqual(notes.version, "1");
    assert.strictEqual(rows.find(r => r.id === "dir").folder, true);
  });

  await test("listing transfers no file bodies", async () => {
    await start();
    const rows = await cloud.listFiles(id, {});
    assert.ok(rows.length > 1);
    assert.ok(!JSON.stringify(rows).includes("# Notes"), "a listing carried file contents");
  });

  await test("searching uses the search tool", async () => {
    await start();
    const rows = await cloud.listFiles(id, { query: "Report" });
    assert.deepStrictEqual(rows.map(r => r.name), ["Report.md"]);
  });

  await test("searching without a search tool filters the listing instead", async () => {
    await start(["list_recent_files", "get_file_metadata"]);
    const rows = await cloud.listFiles(id, { query: "notes" });
    assert.deepStrictEqual(rows.map(r => r.name), ["Notes.md"]);
  });

  await test("a listing Inkju cannot read fails rather than reading as empty", async () => {
    assert.throws(() => cloud.entriesFrom({ content: [{ type: "text", text: "not json" }] }),
      /could not read/i);
    assert.throws(() => cloud.entriesFrom({ content: [{ type: "text", text: '{"nope":1}' }] }),
      /could not read/i);
  });

  await test("rows without an id or a name are dropped, not shown blank", () => {
    assert.strictEqual(cloud.normaliseEntry({ name: "x" }), null);
    assert.strictEqual(cloud.normaliseEntry({ id: "x" }), null);
    assert.strictEqual(cloud.normaliseEntry(null), null);
    assert.strictEqual(cloud.normaliseEntry({ id: "a", name: "b" }).id, "a");
  });

  await test("no list tool and no search tool is said plainly", async () => {
    await start(["read_file_content"]);
    await assert.rejects(() => cloud.listFiles(id, {}), /does not offer a way to list/i);
  });

  /* ------------------------------------------------------------ reading */

  await test("reading a markdown file gives text and a version", async () => {
    await start();
    const doc = await cloud.readFile(id, "f1");
    assert.strictEqual(doc.name, "Notes.md");
    assert.ok(doc.text.includes("# Notes"));
    assert.strictEqual(doc.version, "1");
    assert.strictEqual(doc.writable, true);
    assert.strictEqual(doc.conflictBlind, false);
  });

  await test("a file the server calls huge is refused before it is transferred", async () => {
    await start();
    await assert.rejects(() => cloud.readFile(id, "big"), /9\.0 MB/);
  });

  await test("a file that is not text is refused with somewhere to go", async () => {
    await start();
    await assert.rejects(() => cloud.readFile(id, "pic"), err => {
      assert.strictEqual(err.notTextual, true);
      assert.match(err.message, /Save a copy to your vault/i);
      return true;
    });
  });

  await test("a folder is not a file", async () => {
    await start();
    await assert.rejects(() => cloud.readFile(id, "dir"), /folder, not a file/i);
  });

  await test("a file with no version marker reads as conflict-blind", async () => {
    await start(["list_recent_files", "search_files", "read_file_content", "create_file"]);
    const doc = await cloud.readFile(id, "f1");
    assert.strictEqual(doc.conflictBlind, true, "no metadata tool means every save must ask");
  });

  /* ----------------------------------------------------------- conflicts */

  await test("an unchanged file reports no conflict", async () => {
    await start();
    const c = await cloud.checkForConflict(id, "f1", "1");
    assert.deepStrictEqual({ known: c.known, changed: c.changed }, { known: true, changed: false });
  });

  await test("a file that moved under us reports a conflict", async () => {
    await start();
    await mcp.callTool(id, "bump_version", { fileId: "f1" });
    const c = await cloud.checkForConflict(id, "f1", "1");
    assert.strictEqual(c.changed, true, "the file moved and nobody noticed");
    assert.strictEqual(c.version, "2");
  });

  await test("a save with no expected version is always potentially conflicting", async () => {
    await start();
    const c = await cloud.checkForConflict(id, "f1", null);
    assert.strictEqual(c.known, false);
  });

  /* ------------------------------------------------------------ writing */

  await test("writing returns the next version marker", async () => {
    await start();
    const before = await cloud.readFile(id, "f1");
    const r = await cloud.writeFile(id, "f1", "# Changed\n");
    assert.notStrictEqual(r.version, before.version, "the version marker did not move");
    assert.strictEqual((await cloud.readFile(id, "f1")).text, "# Changed\n");
  });

  /* ---------------------------------------------------------- importing */

  await test("importing writes into the vault through the atomic path", async () => {
    await start();
    const vault = await fsp.mkdtemp(path.join(dir, "vault-"));
    const f = await cloud.importToVault(id, "f1", vault);
    assert.strictEqual(f.name, "Notes.md");
    assert.ok(fs.readFileSync(f.path, "utf8").includes("# Notes"));
    assert.strictEqual(path.dirname(f.path), vault);
  });

  await test("a name that tries to traverse cannot leave the folder", async () => {
    await start();
    const vault = await fsp.mkdtemp(path.join(dir, "vault-"));
    const f = await cloud.importToVault(id, "evil", vault);
    assert.strictEqual(path.dirname(path.resolve(f.path)), path.resolve(vault),
      "an imported file escaped the vault: " + f.path);
    assert.ok(!f.name.includes("/") && !f.name.includes(".."), "unsafe name survived: " + f.name);
  });

  await test("importing twice does not overwrite the first copy", async () => {
    await start();
    const vault = await fsp.mkdtemp(path.join(dir, "vault-"));
    const a = await cloud.importToVault(id, "f1", vault);
    const b = await cloud.importToVault(id, "f1", vault);
    assert.notStrictEqual(a.path, b.path, "the second import overwrote the first");
    assert.ok(fs.existsSync(a.path) && fs.existsSync(b.path));
  });

  await test("importing with no vault open says so", async () => {
    await start();
    await assert.rejects(() => cloud.importToVault(id, "f1", null), /Open a vault first/i);
  });

  /* ------------------------------------------------------- name safety */

  await test("safeName reduces anything to a plain filename", () => {
    const cases = [
      ["../../.ssh/authorized_keys", "authorized_keys.md"],
      ["..\\..\\windows\\system32\\config", "config.md"],
      ["....//....//etc/passwd", "passwd.md"],
      [".bashrc", "bashrc.md"],
      ["/etc/passwd", "passwd.md"],
      ["", "Untitled.md"],
      ["...", "Untitled.md"],
      ["nul", "_nul.md"],
      ["CON.md", "_CON.md"],
      ["a<b>c:d|e?f*g.md", "a-b-c-d-e-f-g.md"],
      ["trailing space   ", "trailing space.md"],
      ["Report.md", "Report.md"]
    ];
    for (const [input, expected] of cases) {
      assert.strictEqual(cloud.safeName(input), expected, JSON.stringify(input));
    }
  });

  await test("safeName strips control characters", () => {
    const sneaky = "note" + String.fromCharCode(0) + String.fromCharCode(10) + ".md";
    const out = cloud.safeName(sneaky);
    assert.strictEqual(out, "note.md");
    assert.ok(!CONTROL.test(out));
  });

  await test("safeName keeps names to a sane length", () => {
    const out = cloud.safeName("x".repeat(400) + ".md");
    assert.ok(out.length <= 120, out.length);
    assert.ok(out.endsWith(".md"));
  });

  await mcp.disconnectAll();
  await fsp.rm(dir, { recursive: true, force: true });
};
