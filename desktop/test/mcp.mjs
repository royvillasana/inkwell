/* Speaks MCP over stdio exactly as an agent would. */
import { spawn } from "node:child_process";
import fs from "node:fs";

import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = process.argv[2] || path.join(here, "..", "src", "mcp", "server.mjs");
const VAULT = process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), "inkju-mcp-"));

/* a small vault to work against, rebuilt every run */
fs.mkdirSync(path.join(VAULT, "notes"), { recursive: true });
fs.writeFileSync(path.join(VAULT, "Index.md"), "# Index\n\nSee [[Ideas]] and [[Ghost]].\n\n#project\n");
fs.writeFileSync(path.join(VAULT, "Ideas.md"), "# Ideas\n\n## Old\n\nstale text\n\n## Keep\n\nkeep me\n\n#design\n");
fs.writeFileSync(path.join(VAULT, "notes", "Meeting.md"), "# Meeting\n\nWe discussed [[Ideas]].\n");
const child = spawn("node", [SERVER, "--vault", VAULT], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const pending = new Map();
let id = 0;

child.stdout.on("data", d => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch (e) { /* not for us */ }
  }
});
const stderr = [];
child.stderr.on("data", d => stderr.push(d.toString()));

const rpc = (method, params) => new Promise((res, rej) => {
  const myId = ++id;
  pending.set(myId, m => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  setTimeout(() => rej(new Error("timeout on " + method)), 12000);
});
const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args || {} });
  const body = r.content.map(c => c.text).join("\n");
  /* the SDK reports a refusing tool as a result with isError, not as a
     protocol error — treating that as success is how a test passes while the
     thing it guards is wide open */
  if (r.isError) throw new Error(body);
  return body;
};

const failures = [];
let passed = 0;
const check = (n, c, x) => { if (c) passed++; else failures.push(n + (x ? " — " + x : "")); };

try {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" }
  });
  check("handshake", init.serverInfo.name === "inkju", JSON.stringify(init.serverInfo));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const tools = (await rpc("tools/list", {})).tools;
  check("advertises its tools", tools.length >= 12, tools.length + " tools");
  const names = tools.map(t => t.name);
  ["list_notes","read_note","search_notes","create_note","write_note","append_to_note",
   "replace_section","backlinks","list_tags","trash_note"].forEach(n =>
    check("exposes " + n, names.includes(n)));

  const list = JSON.parse(await call("list_notes"));
  check("lists every note", list.count === 3, JSON.stringify(list.notes));

  const idx = await call("read_note", { note: "Index" });
  check("reads by bare name", /See \[\[Ideas\]\]/.test(idx), idx.slice(0, 40));
  const meet = await call("read_note", { note: "notes/Meeting.md" });
  check("reads by relative path", /We discussed/.test(meet));

  const found = JSON.parse(await call("search_notes", { query: "discussed" }));
  check("searches the vault", found.total === 1 && found.results[0].note === "notes/Meeting.md",
        JSON.stringify(found.results));

  await call("create_note", { name: "Agent Note", content: "# Agent Note\n\nmade by an agent\n" });
  check("creates a note", fs.existsSync(VAULT + "/Agent Note.md"));
  await call("create_note", { name: "Agent Note", content: "second" });
  check("never overwrites on create", fs.existsSync(VAULT + "/Agent Note 1.md"));

  await call("append_to_note", { note: "Ideas", content: "appended line" });
  check("appends to the end", /appended line\s*$/.test(fs.readFileSync(VAULT + "/Ideas.md", "utf8")));

  await call("append_to_note", { note: "Ideas", content: "under old", heading: "Old" });
  const ideas = fs.readFileSync(VAULT + "/Ideas.md", "utf8");
  check("appends inside a section", /## Old[\s\S]*under old/.test(ideas), JSON.stringify(ideas));
  check("the section append stopped at the next heading",
        ideas.indexOf("under old") < ideas.indexOf("## Keep"), "spilled past its section");

  await call("replace_section", { note: "Ideas", heading: "Old", content: "fresh text" });
  const after = fs.readFileSync(VAULT + "/Ideas.md", "utf8");
  check("replaces a section", /## Old\s*\n\s*fresh text/.test(after) && !/stale text/.test(after), JSON.stringify(after));
  check("leaves other sections alone", /keep me/.test(after));

  const back = JSON.parse(await call("backlinks", { note: "Ideas" }));
  check("finds backlinks", back.linkedFrom.map(b => b.note).sort().join(",") === "Index.md,notes/Meeting.md",
        JSON.stringify(back.linkedFrom));

  const missing = JSON.parse(await call("unresolved_links", { note: "Index" }));
  check("spots links with nothing behind them", missing.missing.includes("Ghost"), JSON.stringify(missing));

  const tags = JSON.parse(await call("list_tags"));
  check("lists tags", tags.tags.some(t => t.tag === "project"), JSON.stringify(tags.tags));

  const outline = JSON.parse(await call("note_outline", { note: "Ideas" }));
  check("outlines a note", outline.headings.length === 3, JSON.stringify(outline.headings));

  await call("trash_note", { note: "Agent Note 1" });
  check("trashes rather than deletes", !fs.existsSync(VAULT + "/Agent Note 1.md")
        && fs.readdirSync(VAULT + "/.trash").length === 1, "trash: " + fs.readdirSync(VAULT + "/.trash"));

  /* history: an agent edit must be recoverable */
  const snaps = fs.existsSync(VAULT + "/.inkju/history") ? fs.readdirSync(VAULT + "/.inkju/history") : [];
  check("agent edits leave a snapshot behind", snaps.length > 0, "snapshots: " + snaps.length);

  /* the vault boundary must hold */
  let escaped = null;
  try { await call("read_note", { note: "../../../etc/passwd" }); escaped = "read succeeded"; }
  catch (e) { escaped = null; }
  check("refuses to read outside the vault", escaped === null, escaped);
  try { await call("write_note", { note: "/etc/inkju-test", content: "x" }); escaped = "write succeeded"; }
  catch (e) { escaped = null; }
  check("refuses to write outside the vault", escaped === null, escaped);
} catch (err) {
  failures.push("threw: " + err.message);
}

child.kill();

/* ---- following the app ----------------------------------------------------
   A second server, unpinned, with a throwaway HOME so it reads a settings.json
   we control rather than the real one. Switching the vault there must move the
   server with it: resolving once at startup meant an agent kept working in the
   old vault while the window showed a different one. */
try {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "inkju-home-"));
  const settingsDir = process.platform === "darwin"
    ? path.join(home, "Library", "Application Support", "Inkju")
    : path.join(home, ".config", "Inkju");
  fs.mkdirSync(settingsDir, { recursive: true });
  const settings = path.join(settingsDir, "settings.json");

  const A = fs.mkdtempSync(path.join(os.tmpdir(), "inkju-vault-a-"));
  const B = fs.mkdtempSync(path.join(os.tmpdir(), "inkju-vault-b-"));
  fs.writeFileSync(path.join(A, "OnlyInA.md"), "# Only in A\n");
  fs.writeFileSync(path.join(B, "OnlyInB.md"), "# Only in B\n");
  fs.writeFileSync(settings, JSON.stringify({ vault: A }));

  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") };
  delete env.INKJU_VAULT;
  const kid = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"], env });
  let kbuf = "";
  const kpending = new Map();
  let kid_ = 0;
  kid.stdout.on("data", d => {
    kbuf += d.toString();
    let nl;
    while ((nl = kbuf.indexOf("\n")) >= 0) {
      const line = kbuf.slice(0, nl).trim();
      kbuf = kbuf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && kpending.has(msg.id)) { kpending.get(msg.id)(msg); kpending.delete(msg.id); }
      } catch (e) { /* not for us */ }
    }
  });
  kid.stderr.on("data", () => {});
  const krpc = (method, params) => new Promise((res, rej) => {
    const myId = ++kid_;
    kpending.set(myId, m => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    kid.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    setTimeout(() => rej(new Error("timeout on " + method)), 12000);
  });
  const kcall = async (name, args) => {
    const r = await krpc("tools/call", { name, arguments: args || {} });
    const body = r.content.map(c => c.text).join("\n");
    if (r.isError) throw new Error(body);
    return body;
  };

  await krpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  kid.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const first = JSON.parse(await kcall("list_notes", {}));
  check("unpinned server starts on the app's vault", first.vault === A && first.notes.includes("OnlyInA.md"),
    JSON.stringify(first.notes));
  const infoA = JSON.parse(await kcall("vault_info", {}));
  check("it says it is following the app", /following|whichever/i.test(infoA.following || ""), infoA.following);

  /* the app switches vaults underneath it */
  fs.writeFileSync(settings, JSON.stringify({ vault: B }));

  const second = JSON.parse(await kcall("list_notes", {}));
  check("it follows the app to another vault", second.vault === B && second.notes.includes("OnlyInB.md"),
    JSON.stringify(second));
  check("and stops serving the old one", !second.notes.includes("OnlyInA.md"), JSON.stringify(second.notes));

  /* searching is index-backed, so the index has to move too, not just paths */
  const hits = JSON.parse(await kcall("search_notes", { query: "Only in B" }));
  check("the search index moves with it", hits.total > 0, JSON.stringify(hits).slice(0, 120));
  const stale = JSON.parse(await kcall("search_notes", { query: "Only in A" }));
  check("the old vault is no longer searchable", stale.total === 0, JSON.stringify(stale).slice(0, 120));

  /* writes must land in the vault the app is actually showing */
  await kcall("create_note", { name: "Written While Following", content: "# Here\n" });
  check("writes land in the current vault",
    fs.existsSync(path.join(B, "Written While Following.md"))
    && !fs.existsSync(path.join(A, "Written While Following.md")));

  /* a pinned server must ignore the app entirely */
  const pinned = spawn("node", [SERVER, "--vault", A], { stdio: ["pipe", "pipe", "pipe"], env });
  let pbuf = "";
  const ppending = new Map();
  let pid_ = 0;
  pinned.stdout.on("data", d => {
    pbuf += d.toString();
    let nl;
    while ((nl = pbuf.indexOf("\n")) >= 0) {
      const line = pbuf.slice(0, nl).trim();
      pbuf = pbuf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && ppending.has(msg.id)) { ppending.get(msg.id)(msg); ppending.delete(msg.id); }
      } catch (e) { /* not for us */ }
    }
  });
  pinned.stderr.on("data", () => {});
  const prpc = (method, params) => new Promise((res, rej) => {
    const myId = ++pid_;
    ppending.set(myId, m => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    pinned.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    setTimeout(() => rej(new Error("timeout on " + method)), 12000);
  });
  await prpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  pinned.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const pinnedList = JSON.parse((await prpc("tools/call", { name: "list_notes", arguments: {} }))
    .content.map(c => c.text).join("\n"));
  check("--vault still pins, app or no app", pinnedList.vault === A, pinnedList.vault);
  pinned.kill();

  kid.kill();
} catch (err) {
  failures.push("vault following threw: " + err.message);
}

const ran = failures.length + passed;
console.log(failures.length
  ? "mcp: " + failures.length + " FAILED\n  " + failures.join("\n  ")
  : "mcp: all " + ran + " checks passed");
process.exit(failures.length ? 1 : 0);
