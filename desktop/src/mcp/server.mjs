#!/usr/bin/env node
/* ===========================================================================
   Inkju MCP server — lets an agent work inside a vault.
   =========================================================================== */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/* The app's own vault logic, reused rather than reimplemented: the same
   atomic writes, the same tree rules, the same index the sidebar searches. */
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const files = require(path.join(here, "..", "main", "files.js"));
const search = require(path.join(here, "..", "main", "search.js"));

/* ---- which vault ---------------------------------------------------------
   An explicit --vault wins. Otherwise use whatever the app has open, so the
   agent and the window you are looking at are never out of step. */
function settingsPath(){
  if (process.platform === "darwin")
    return path.join(os.homedir(), "Library", "Application Support", "Inkju", "settings.json");
  if (process.platform === "win32")
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Inkju", "settings.json");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Inkju", "settings.json");
}

/* Pinned by --vault or INKJU_VAULT: that choice is fixed for the process.
   With neither, we follow the app, and "follow" has to mean per call — the app
   can switch vaults at any time, and a server that resolved once at startup
   would keep reading and writing the previous one, quietly, while the window
   showed something else. */
function pinnedVault(){
  const flag = process.argv.indexOf("--vault");
  if (flag > -1 && process.argv[flag + 1]) return path.resolve(process.argv[flag + 1]);
  if (process.env.INKJU_VAULT) return path.resolve(process.env.INKJU_VAULT);
  return null;
}

function appVault(){
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    if (saved.vault) return saved.vault;
  } catch (err) { /* no app settings yet */ }
  return null;
}

const PINNED = pinnedVault();
const resolveVault = () => PINNED || appVault();

let VAULT = resolveVault();
if (!VAULT || !fs.existsSync(VAULT)) {
  console.error("inkju-mcp: no vault. Pass --vault <folder>, set INKJU_VAULT, or open a vault in Inkju first.");
  process.exit(1);
}

/* The search index belongs to one root, so re-point it whenever the app moves. */
let indexedRoot = null;
async function syncVault(){
  const next = resolveVault();
  if (!next) throw new Error("Inkju has no vault open. Open one, or start this server with --vault.");
  if (!fs.existsSync(next)) throw new Error("The vault at " + next + " is not there any more.");
  VAULT = next;
  if (VAULT !== indexedRoot) {
    await search.setRoot(VAULT);
    indexedRoot = VAULT;
    console.error("inkju-mcp: serving " + VAULT);
  }
}

/* ---- helpers -------------------------------------------------------------- */
const rel = p => path.relative(VAULT, p) || path.basename(p);

/* Every path an agent hands us is treated as untrusted and must land inside
   the vault. A note can be given by relative path or by name. */
function resolveNote(nameOrPath, { mustExist = true } = {}){
  const raw = String(nameOrPath || "").trim();
  if (!raw) throw new Error("Give a note name or path.");

  let full = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(VAULT, raw);
  if (!files.within(VAULT, full)) throw new Error("That path is outside the vault.");

  if (!fs.existsSync(full) && !path.extname(full)) full += ".md";
  if (!fs.existsSync(full)) {
    /* fall back to a name match anywhere in the tree */
    const hit = search.resolveLink(raw);
    if (hit) full = hit.path;
  }
  if (mustExist && !fs.existsSync(full)) throw new Error("No note called " + raw + " in this vault.");
  if (!files.within(VAULT, full)) throw new Error("That path is outside the vault.");
  return full;
}

const text = s => ({ content: [{ type: "text", text: s }] });
const json = o => ({ content: [{ type: "text", text: JSON.stringify(o, null, 2) }] });

/* Snapshot before every change, so the app's version history covers agent
   edits exactly as it covers yours, and nothing an agent does is one-way. */
async function snapshot(file){
  try { await files.writeSnapshot(VAULT, path.basename(file), await fsp.readFile(file, "utf8")); }
  catch (err) { /* a new file has nothing to snapshot */ }
}

async function reindex(file){
  if (file) await search.touch(file);
}

/* ---- server --------------------------------------------------------------- */
const server = new McpServer({ name: "inkju", version: "1.0.0" });

/* Wrap once rather than remembering to call syncVault() in fifteen handlers —
   the one that gets forgotten is the one that writes to the wrong vault. */
const registerTool = server.registerTool.bind(server);
server.registerTool = (name, meta, handler) =>
  registerTool(name, meta, async (...args) => { await syncVault(); return handler(...args); });

server.registerTool("list_notes", {
  title: "List notes",
  description: "Every markdown note in the Inkju vault, as paths relative to the vault root.",
  inputSchema: { folder: z.string().optional().describe("Limit to a subfolder, relative to the vault root") }
}, async ({ folder }) => {
  const root = folder ? resolveNote(folder, { mustExist: false }) : VAULT;
  const tree = await files.listTree(root);
  const flat = files.flatten(tree).map(f => rel(f.path)).sort();
  return json({ vault: VAULT, count: flat.length, notes: flat });
});

server.registerTool("read_note", {
  title: "Read a note",
  description: "The full markdown of one note. Accepts a relative path or just the note's name.",
  inputSchema: { note: z.string().describe("Note name or path, e.g. 'Index' or 'notes/Meeting Notes.md'") }
}, async ({ note }) => {
  const file = resolveNote(note);
  const { text: body } = await files.readText(file);
  return text(body);
});

server.registerTool("search_notes", {
  title: "Search the vault",
  description: "Full text search across every note, with the matching lines and their context.",
  inputSchema: {
    query: z.string().describe("What to look for"),
    regex: z.boolean().optional().describe("Treat the query as a regular expression"),
    caseSensitive: z.boolean().optional(),
    word: z.boolean().optional().describe("Whole words only")
  }
}, async ({ query, regex, caseSensitive, word }) => {
  const res = search.search(query, { regex, caseSensitive, word });
  if (res.error) throw new Error(res.error);
  return json({
    total: res.total,
    results: res.results.map(r => ({
      note: rel(r.path),
      hits: r.hits.map(h => ({ line: h.line, text: (h.before + h.match + h.after).trim() }))
    }))
  });
});

server.registerTool("create_note", {
  title: "Create a note",
  description: "Make a new note. Never overwrites: an existing name gets a numbered sibling.",
  inputSchema: {
    name: z.string().describe("File name, with or without .md"),
    content: z.string().optional().describe("Markdown body"),
    folder: z.string().optional().describe("Subfolder, relative to the vault root")
  }
}, async ({ name, content, folder }) => {
  const dir = folder ? resolveNote(folder, { mustExist: false }) : VAULT;
  if (!files.within(VAULT, dir)) throw new Error("That folder is outside the vault.");
  await fsp.mkdir(dir, { recursive: true });
  const made = await files.createFile(dir, name, content == null ? "" : content);
  await reindex(made.path);
  return text("Created " + rel(made.path));
});

server.registerTool("write_note", {
  title: "Replace a note's contents",
  description: "Overwrite a note with new markdown. The previous version is snapshotted first, so it stays recoverable from Inkju's version history.",
  inputSchema: {
    note: z.string().describe("Note name or path"),
    content: z.string().describe("The complete new markdown")
  }
}, async ({ note, content }) => {
  const file = resolveNote(note);
  await snapshot(file);
  await files.writeText(file, content);
  await reindex(file);
  return text("Wrote " + rel(file) + " (" + content.length + " characters)");
});

server.registerTool("append_to_note", {
  title: "Append to a note",
  description: "Add markdown to the end of a note, or to the end of one section when a heading is given.",
  inputSchema: {
    note: z.string(),
    content: z.string().describe("Markdown to add"),
    heading: z.string().optional().describe("Append inside this section instead of at the end of the file")
  }
}, async ({ note, content, heading }) => {
  const file = resolveNote(note);
  const { text: body } = await files.readText(file);
  await snapshot(file);

  let next;
  if (!heading) {
    next = body.replace(/\s*$/, "") + "\n\n" + content.trim() + "\n";
  } else {
    const lines = body.split("\n");
    const at = lines.findIndex(l => /^#{1,6}\s/.test(l)
      && l.replace(/^#{1,6}\s+/, "").trim().toLowerCase() === heading.trim().toLowerCase());
    if (at < 0) throw new Error('No heading called "' + heading + '" in ' + rel(file));
    const level = (lines[at].match(/^#+/) || ["#"])[0].length;
    let end = at + 1;
    while (end < lines.length) {
      const m = lines[end].match(/^(#{1,6})\s/);
      if (m && m[1].length <= level) break;
      end++;
    }
    while (end > at + 1 && !lines[end - 1].trim()) end--;      // sit above the blank gap
    lines.splice(end, 0, "", content.trim());
    next = lines.join("\n").replace(/\s*$/, "") + "\n";
  }
  await files.writeText(file, next);
  await reindex(file);
  return text("Appended to " + rel(file) + (heading ? " under " + heading : ""));
});

server.registerTool("replace_section", {
  title: "Replace a section",
  description: "Swap everything under one heading, leaving the rest of the note untouched.",
  inputSchema: {
    note: z.string(),
    heading: z.string().describe("The heading text, without the # marks"),
    content: z.string().describe("The new body for that section")
  }
}, async ({ note, heading, content }) => {
  const file = resolveNote(note);
  const { text: body } = await files.readText(file);
  const lines = body.split("\n");
  const at = lines.findIndex(l => /^#{1,6}\s/.test(l)
    && l.replace(/^#{1,6}\s+/, "").trim().toLowerCase() === heading.trim().toLowerCase());
  if (at < 0) throw new Error('No heading called "' + heading + '" in ' + rel(file));

  const level = (lines[at].match(/^#+/) || ["#"])[0].length;
  let end = at + 1;
  while (end < lines.length) {
    const m = lines[end].match(/^(#{1,6})\s/);
    if (m && m[1].length <= level) break;
    end++;
  }
  await snapshot(file);
  const next = lines.slice(0, at + 1)
    .concat("", content.trim(), "")
    .concat(lines.slice(end))
    .join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "") + "\n";
  await files.writeText(file, next);
  await reindex(file);
  return text("Replaced the " + heading + " section of " + rel(file));
});

server.registerTool("note_outline", {
  title: "Outline a note",
  description: "The headings of a note, with their levels and line numbers.",
  inputSchema: { note: z.string() }
}, async ({ note }) => {
  const file = resolveNote(note);
  const { text: body } = await files.readText(file);
  const out = [];
  body.split("\n").forEach((l, i) => {
    const m = l.match(/^(#{1,6})\s+(.*)$/);
    if (m) out.push({ level: m[1].length, heading: m[2].trim(), line: i + 1 });
  });
  return json({ note: rel(file), headings: out });
});

server.registerTool("rename_note", {
  title: "Rename a note",
  description: "Rename a note in place. Other notes' links are not rewritten.",
  inputSchema: { note: z.string(), newName: z.string().describe("New file name, with or without .md") }
}, async ({ note, newName }) => {
  const file = resolveNote(note);
  const safe = String(newName).replace(/[\\/:]+/g, "-");
  const out = await files.renameFile(file, safe);
  await reindex(out.path);
  return text("Renamed to " + rel(out.path));
});

server.registerTool("trash_note", {
  title: "Move a note to the vault trash",
  description: "Moves a note into .trash inside the vault. Nothing is deleted outright.",
  inputSchema: { note: z.string() }
}, async ({ note }) => {
  const file = resolveNote(note);
  const trash = path.join(VAULT, ".trash");
  await fsp.mkdir(trash, { recursive: true });
  const target = await files.uniquePath(trash, path.basename(file, path.extname(file)), path.extname(file) || ".md");
  await fsp.rename(file, target);
  await reindex(file);
  return text("Moved " + rel(file) + " to .trash");
});

server.registerTool("backlinks", {
  title: "What links here",
  description: "Notes whose [[wiki links]] point at the given note, with the surrounding text.",
  inputSchema: { note: z.string() }
}, async ({ note }) => {
  const file = resolveNote(note, { mustExist: false });
  const hits = search.backlinks(path.basename(file));
  return json({ note: path.basename(file, path.extname(file)), linkedFrom: hits.map(h => ({ note: rel(h.path), contexts: h.contexts })) });
});

server.registerTool("list_tags", {
  title: "List tags",
  description: "Every #tag in the vault with how often it appears.",
  inputSchema: {}
}, async () => json({ tags: search.tags() }));

server.registerTool("notes_by_tag", {
  title: "Notes with a tag",
  inputSchema: { tag: z.string().describe("The tag, with or without the leading #") }
}, async ({ tag }) => {
  const hits = search.byTag(String(tag).replace(/^#/, ""));
  return json({ tag, notes: hits.map(h => rel(h.path)) });
});

server.registerTool("unresolved_links", {
  title: "Wiki links with no note behind them",
  description: "Find [[links]] in a note that do not point at anything yet.",
  inputSchema: { note: z.string() }
}, async ({ note }) => {
  const file = resolveNote(note);
  const { text: body } = await files.readText(file);
  return json({ note: rel(file), missing: search.unresolved(body) });
});

server.registerTool("vault_info", {
  title: "About this vault",
  description: "Where the vault is and how much is in it.",
  inputSchema: {}
}, async () => json({ vault: VAULT, following: PINNED ? "pinned" : "whichever vault Inkju has open", ...search.stats() }));

/* ---- go ------------------------------------------------------------------- */
await search.setRoot(VAULT);
indexedRoot = VAULT;
await server.connect(new StdioServerTransport());
console.error("inkju-mcp: serving " + VAULT + (PINNED ? " (pinned)" : " (following Inkju)"));
