/* Speaks MCP over stdio exactly as an agent would. */
import { spawn } from "node:child_process";
import fs from "node:fs";

import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = process.argv[2] || path.join(here, "..", "src", "mcp", "server.mjs");
const VAULT = process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), "inkwell-mcp-"));

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
  check("handshake", init.serverInfo.name === "inkwell", JSON.stringify(init.serverInfo));
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
  const snaps = fs.existsSync(VAULT + "/.inkwell/history") ? fs.readdirSync(VAULT + "/.inkwell/history") : [];
  check("agent edits leave a snapshot behind", snaps.length > 0, "snapshots: " + snaps.length);

  /* the vault boundary must hold */
  let escaped = null;
  try { await call("read_note", { note: "../../../etc/passwd" }); escaped = "read succeeded"; }
  catch (e) { escaped = null; }
  check("refuses to read outside the vault", escaped === null, escaped);
  try { await call("write_note", { note: "/etc/inkwell-test", content: "x" }); escaped = "write succeeded"; }
  catch (e) { escaped = null; }
  check("refuses to write outside the vault", escaped === null, escaped);
} catch (err) {
  failures.push("threw: " + err.message);
}

child.kill();
const ran = failures.length + passed;
console.log(failures.length
  ? "mcp: " + failures.length + " FAILED\n  " + failures.join("\n  ")
  : "mcp: all " + ran + " checks passed");
process.exit(failures.length ? 1 : 0);
