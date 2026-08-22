"use strict";
/* Tests for the MCP client, run against the fixture server over stdio.
   These are the ones that would notice if the allowlist stopped being asked
   before the request, or if an oversized reply started being rendered. */
const assert = require("assert");
const fsp = require("fs").promises;
const os = require("os");
const path = require("path");

const connections = require("../src/main/connections");
const secrets = require("../src/main/secrets");
const mcp = require("../src/main/mcp-client");
const cloud = require("../src/main/cloud");

const FIXTURE = path.join(__dirname, "fixtures", "mcp-server.mjs");
const HOSTILE = path.join(__dirname, "fixtures", "hostile.mjs");

function fakeStore(){
  const state = { connections: [] };
  return { get: () => state, save: p => (Object.assign(state, p), state), _state: state };
}

module.exports = async function run(test){
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "inkju-mcpclient-"));
  secrets.setBackend({
    isEncryptionAvailable: () => true,
    encrypt: async t => Buffer.from("v1:" + Buffer.from(t, "utf8").toString("hex")),
    decrypt: async b => Buffer.from(Buffer.from(b).toString("utf8").slice(3), "hex").toString("utf8")
  });
  secrets.setFile(path.join(dir, "secrets.json"));

  const reset = async () => {
    await mcp.disconnectAll();
    connections.setStore(fakeStore());
    connections.resetLive();
    connections.events.removeAllListeners();
  };
  const addFixture = (env) => connections.add({
    label: "Fixture", transport: "stdio",
    config: { command: process.execPath, args: [FIXTURE], env: env || {} }
  });

  await test("connects over stdio and lists the server's tools", async () => {
    await reset();
    const c = addFixture();
    const r = await mcp.connect(c.id);
    const names = r.tools.map(t => t.name).sort();
    assert.ok(names.includes("search_files"), "expected search_files, got " + names.join(", "));
    assert.ok(names.includes("create_file"));
    assert.strictEqual(connections.get(c.id).status, "connected");
    await mcp.disconnect(c.id);
  });

  await test("the tool list marks writes as writes", async () => {
    await reset();
    const c = addFixture();
    await mcp.connect(c.id);
    const view = connections.get(c.id);
    const byName = Object.fromEntries(view.tools.map(t => [t.name, t.write]));
    assert.strictEqual(byName.search_files, false);
    assert.strictEqual(byName.create_file, true);
    await mcp.disconnect(c.id);
  });

  await test("a tool that is not allowed is refused before anything is sent", async () => {
    await reset();
    const c = addFixture();
    await mcp.connect(c.id);
    /* nothing has been allowed yet */
    await assert.rejects(() => mcp.callTool(c.id, "search_files", { query: "a" }), /not allowed/i);
    await mcp.disconnect(c.id);
  });

  await test("an allowed tool answers", async () => {
    await reset();
    const c = addFixture();
    await mcp.connect(c.id);
    connections.update(c.id, { allow: ["search_files"] });
    const out = mcp.jsonOf(await mcp.callTool(c.id, "search_files", { query: "notes" }));
    assert.deepStrictEqual(out, [{ id: "f1", name: "notes.md", size: 12 }]);
    await mcp.disconnect(c.id);
  });

  await test("disabling a connection stops its allowed tools working", async () => {
    await reset();
    const c = addFixture();
    await mcp.connect(c.id);
    connections.update(c.id, { allow: ["search_files"] });
    connections.update(c.id, { enabled: false });
    await assert.rejects(() => mcp.callTool(c.id, "search_files", { query: "a" }), /not allowed/i);
    await mcp.disconnect(c.id);
  });

  await test("a reply larger than the limit is refused rather than rendered", async () => {
    await reset();
    const c = addFixture();
    await mcp.connect(c.id);
    connections.update(c.id, { allow: ["read_enormous"] });
    await assert.rejects(() => mcp.callTool(c.id, "read_enormous", {}), /larger than Inkju will accept/i);
    /* and the connection survives it */
    connections.update(c.id, { allow: ["read_enormous", "read_file_content"] });
    assert.ok(mcp.textOf(await mcp.callTool(c.id, "read_file_content", { id: "x" })).includes("body"));
    await mcp.disconnect(c.id);
  });

  await test("a misshapen reply fails the operation, not the connection", async () => {
    await reset();
    const c = addFixture();
    await mcp.connect(c.id);
    connections.update(c.id, { allow: ["read_misshapen", "read_file_content"] });
    await assert.rejects(() => mcp.callTool(c.id, "read_misshapen", {}), /could not read/i);
    assert.ok(mcp.textOf(await mcp.callTool(c.id, "read_file_content", { id: "x" })).includes("body"),
      "the connection should still be usable");
    await mcp.disconnect(c.id);
  });

  await test("a tool that reports an error surfaces it as a failure", async () => {
    await reset();
    const c = addFixture();
    await mcp.connect(c.id);
    connections.update(c.id, { allow: ["read_angry"] });
    await assert.rejects(() => mcp.callTool(c.id, "read_angry", {}), /no/);
    await mcp.disconnect(c.id);
  });

  await test("prose where data was promised fails rather than reading as empty", async () => {
    await reset();
    const c = addFixture();
    await mcp.connect(c.id);
    connections.update(c.id, { allow: ["read_file_content"] });
    const r = await mcp.callTool(c.id, "read_file_content", { id: "x" });
    assert.throws(() => mcp.jsonOf(r), /could not read as data/i);
  });

  await test("a server that exits on startup fails once, with its own words", async () => {
    await reset();
    const c = addFixture({ FIXTURE_DIE: "1" });
    await assert.rejects(() => mcp.connect(c.id), /refusing to start/);
    assert.strictEqual(connections.get(c.id).status, "failed");
    assert.strictEqual(mcp.isConnected(c.id), false);
  });

  await test("a tool that appears between sessions arrives disabled", async () => {
    await reset();
    const c = addFixture();
    await mcp.connect(c.id);
    connections.update(c.id, { allow: ["search_files"] });
    await mcp.disconnect(c.id);

    connections.update(c.id, { config: { env: { FIXTURE_EXTRA: "1" } } });
    let announced = null;
    connections.events.on("tools-appeared", e => { announced = e.tools; });
    const r = await mcp.connect(c.id);
    assert.ok(r.tools.some(t => t.name === "delete_everything"), "the fixture did not grow a tool");
    assert.deepStrictEqual(announced, ["delete_everything"]);
    await assert.rejects(() => mcp.callTool(c.id, "delete_everything", {}), /not allowed/i);
    assert.strictEqual(connections.isAllowed(c.id, "search_files"), true, "the old allowance was lost");
    await mcp.disconnect(c.id);
  });

  await test("calling a tool on a connection that is not connected fails plainly", async () => {
    await reset();
    const c = addFixture();
    connections.update(c.id, { allow: ["search_files"] });
    await assert.rejects(() => mcp.callTool(c.id, "search_files", { query: "a" }), /not connected/i);
  });

  await test("disconnecting reaps the child process", async () => {
    await reset();
    const c = addFixture();
    await mcp.connect(c.id);
    assert.strictEqual(mcp.isConnected(c.id), true);
    await mcp.disconnect(c.id);
    assert.strictEqual(mcp.isConnected(c.id), false);
    assert.strictEqual(connections.get(c.id).status, "disconnected");
  });

  await test("a stdio connection missing a stored secret says which one", async () => {
    await reset();
    const c = connections.add({
      label: "Needs a key", transport: "stdio",
      config: { command: process.execPath, args: [FIXTURE], secretEnv: ["API_KEY"] }
    });
    await assert.rejects(() => mcp.connect(c.id), /API_KEY/);
  });

  /* ------------------------------- a server behaving badly ------------- */

  await test("a forged step-up challenge in a tool reply is not honoured", async () => {
    /* The security review's second finding. An MCP tool result carrying
       isError becomes an Error whose message is the server's own text, and the
       step-up path used to fall back to that message when there was no
       WWW-Authenticate header — so any connected server could ask Inkju to
       rewrite that connection's scopes and open a consent screen, arriving in
       the middle of an unrelated action. A challenge comes from an HTTP layer.
       Text in a reply body only looks like one. */
    await reset();
    const c = connections.add({
      label: "Hostile", transport: "stdio",
      config: { command: process.execPath, args: [HOSTILE] }
    });
    await mcp.connect(c.id);
    connections.update(c.id, { allow: ["search_files", "read_file_content"] });

    let reauthorized = null;
    mcp.setReauthorizer(async (id, scope) => { reauthorized = { id, scope }; });
    try {
      await assert.rejects(() => mcp.callToolWithStepUp(c.id, "search_files", { query: "x" }),
        /insufficient_scope/);
      assert.strictEqual(reauthorized, null,
        "a forged challenge triggered a re-authorization: " + JSON.stringify(reauthorized));
      const after = connections.get(c.id);
      assert.ok(!(after.config.scopes || []).some(x => /gmail|auth\/drive/.test(x)),
        "the server rewrote the stored scopes: " + JSON.stringify(after.config.scopes));
    } finally {
      mcp.setReauthorizer(null);
      await mcp.disconnect(c.id);
    }
  });

  await test("a hostile document comes back byte for byte, not acted on", async () => {
    /* cloud.js hands the bytes over untouched — the document is never altered,
       only rendered differently. The renderer's half of this is asserted at the
       DOM in test/smoke-renderer.js, which is the only place it can be. */
    await reset();
    const c = connections.add({
      label: "Hostile", transport: "stdio",
      config: { command: process.execPath, args: [HOSTILE] }
    });
    await mcp.connect(c.id);
    connections.update(c.id, { allow: ["read_file_content", "get_file_metadata", "list_recent_files"] });
    const doc = await cloud.readFile(c.id, "f1");
    assert.ok(doc.text.includes("<script>"), "the note should arrive unaltered");
    assert.strictEqual(doc.writable, false, "no write tool was allowed");
    await mcp.disconnect(c.id);
  });

  await test("error text never carries a credential", async () => {
    const dirty = 'request failed: {"access_token":"ya29.averyrealtoken","client_secret":"GOCSPX-alsoreal"} Bearer ya29.averyrealtoken';
    const clean = mcp.scrub(dirty);
    assert.ok(!clean.includes("ya29.averyrealtoken"), clean);
    assert.ok(!clean.includes("GOCSPX-alsoreal"), clean);
  });

  await mcp.disconnectAll();
  await fsp.rm(dir, { recursive: true, force: true });
};
