"use strict";
/* ===========================================================================
   Turning a connection's tools into the five things the browser panel needs:
   list, search, read, metadata, write.

   MCP does not standardise what a file tool is called or what it answers with,
   so this is where the guessing lives — kept in one place, driven by data, and
   written so a server we have never seen still works if it names its tools the
   way everybody else does. Everything below assumes the reply is untrustworthy
   until it has been checked: a listing is only a listing once every row has an
   id and a name.
   =========================================================================== */
const path = require("path");

const connections = require("./connections");
const mcp = require("./mcp-client");
const files = require("./files");

/* A remote file we would put in the editor. Far below the 40 MB the vault
   allows, because that ceiling is about a local disk and this one is about a
   network, someone else's quota, and text a person is going to read. */
const MAX_REMOTE_BYTES = 2 * 1024 * 1024;

const TEXTUAL = /\.(md|markdown|mdown|mkd|txt|text)$/i;
const TEXT_MIME = /^(text\/|application\/(json|xml|x-yaml|yaml))/i;

/* ------------------------------------------------------------- the mapping */

/* Candidate tool names per operation, best first. A connection is mapped by
   asking which of these the server actually advertised — so Google's Drive
   server, a community Drive server and somebody's own filesystem server all
   land on the same five operations without a special case each. */
const CANDIDATES = {
  list:     ["list_recent_files", "list_files", "list_notes", "list", "list_directory"],
  search:   ["search_files", "search", "search_notes", "find_files", "query"],
  read:     ["read_file_content", "read_file", "read_note", "get_file_content", "read"],
  metadata: ["get_file_metadata", "file_metadata", "stat", "get_metadata"],
  write:    ["create_file", "write_file", "write_note", "update_file", "upload_file"]
};

/* Argument names differ as much as tool names do. Rather than guess once and
   be wrong, the call sends the identifier under every name the common servers
   use — extra properties are ignored by a schema that does not want them, and
   a schema strict enough to reject them is one we cannot serve anyway. */
const idArgs = id => ({ fileId: String(id), file_id: String(id), id: String(id), path: String(id), uri: String(id) });
const queryArgs = q => ({ query: String(q), q: String(q), search: String(q), name: String(q) });

function toolFor(id, op){
  const offered = new Set(connections.toolsOf(id).map(t => t.name));
  const allowed = connections.raw(id).allow || [];
  for (const name of CANDIDATES[op]) {
    /* offered AND allowed: a tool the user has not ticked does not count as a
       capability, or the interface would offer a button that always fails */
    if (offered.has(name) && allowed.indexOf(name) >= 0) return name;
  }
  return null;
}

/* What this connection can actually do right now. Drives the interface: a
   connection with no write tool allowed opens files read-only rather than
   offering a save that cannot work. */
function capabilities(id){
  const tools = {};
  for (const op of Object.keys(CANDIDATES)) tools[op] = toolFor(id, op);
  return {
    tools,
    canList: !!(tools.list || tools.search),
    canSearch: !!tools.search,
    canRead: !!tools.read,
    canWrite: !!tools.write,
    /* without metadata there is no version marker, and every save has to be
       treated as potentially conflicting */
    canDetectConflicts: !!tools.metadata
  };
}

/* --------------------------------------------------------------- reading */

/* A row in a listing, whatever the server called its fields. Anything without
   an id and a name is dropped rather than shown as a blank line the user
   cannot click. */
function normaliseEntry(raw){
  if (!raw || typeof raw !== "object") return null;
  const id = raw.id || raw.fileId || raw.file_id || raw.path || raw.uri || raw.key;
  const name = raw.name || raw.title || raw.filename || raw.displayName ||
    (typeof raw.path === "string" ? path.basename(raw.path) : null);
  if (!id || !name) return null;
  const modified = raw.modifiedTime || raw.modified_time || raw.modified || raw.mtime || raw.updatedAt || null;
  return {
    id: String(id),
    name: String(name),
    size: Number(raw.size || raw.bytes || 0) || null,
    modified: modified ? String(modified) : null,
    mime: raw.mimeType || raw.mime_type || raw.mime || null,
    folder: !!(raw.isFolder || raw.folder || raw.mimeType === "application/vnd.google-apps.folder"),
    /* whatever the server calls a version. Any of these is enough to notice
       that a file moved under us; none of them means every save is a risk. */
    version: raw.version || raw.etag || raw.revisionId || raw.headRevisionId ||
      (modified ? String(modified) : null)
  };
}

/* Servers answer a listing as a JSON array, as an object with a `files` or
   `items` key, or — often enough to be worth handling — wrapped in something
   else again. Anything we cannot recognise fails rather than reads as empty. */
function entriesFrom(result){
  let payload;
  try { payload = mcp.jsonOf(result); }
  catch (err) { throw new Error("That connection listed its files in a form Inkju could not read."); }
  const rows = Array.isArray(payload) ? payload
    : Array.isArray(payload && payload.files) ? payload.files
    : Array.isArray(payload && payload.items) ? payload.items
    : Array.isArray(payload && payload.results) ? payload.results
    : Array.isArray(payload && payload.entries) ? payload.entries
    : null;
  if (!rows) throw new Error("That connection listed its files in a form Inkju could not read.");
  return rows.map(normaliseEntry).filter(Boolean);
}

async function listFiles(id, opts){
  const o = opts || {};
  const caps = capabilities(id);
  const query = String(o.query || "").trim();

  /* A search with no search tool falls back to filtering the listing, which is
     worse but honest — better than an empty panel with a working search box. */
  if (query && caps.tools.search) {
    return entriesFrom(await mcp.callToolWithStepUp(id, caps.tools.search, queryArgs(query)));
  }
  if (!caps.tools.list) {
    if (!caps.tools.search) throw new Error("This connection does not offer a way to list files.");
    return entriesFrom(await mcp.callToolWithStepUp(id, caps.tools.search, queryArgs(query || "")));
  }
  const args = o.folder ? idArgs(o.folder) : {};
  const rows = entriesFrom(await mcp.callToolWithStepUp(id, caps.tools.list, args));
  if (!query) return rows;
  const needle = query.toLowerCase();
  return rows.filter(r => r.name.toLowerCase().includes(needle));
}

async function metadata(id, remoteId){
  const caps = capabilities(id);
  if (!caps.tools.metadata) return null;
  let payload;
  try { payload = mcp.jsonOf(await mcp.callToolWithStepUp(id, caps.tools.metadata, idArgs(remoteId))); }
  catch (err) { return null; }
  return normaliseEntry(payload) || normaliseEntry(payload && payload.file) || null;
}

/* Is this something we would put in the editor? Name first, because a server
   that reports no mime type at all is common and a .md file is a .md file. */
function isTextual(entry){
  if (!entry) return false;
  if (TEXTUAL.test(entry.name)) return true;
  if (entry.mime && TEXT_MIME.test(entry.mime)) return true;
  return false;
}

function tooBig(bytes){
  const mb = (bytes / 1024 / 1024).toFixed(1);
  return "That file is " + mb + " MB. Inkju opens remote files up to " +
    (MAX_REMOTE_BYTES / 1024 / 1024) + " MB — save a copy to your vault instead.";
}

/* Read a remote file for the editor.

   The size is checked twice on purpose: once against what the listing claimed,
   so an obviously huge file is refused before it is transferred, and once
   against what actually arrived — because the claim came from the same server
   as the file. mcp-client enforces its own ceiling underneath both. */
async function readFile(id, remoteId, entry){
  const caps = capabilities(id);
  if (!caps.tools.read) throw new Error("This connection does not offer a way to read files.");

  const known = entry || await metadata(id, remoteId);
  if (known && known.folder) throw new Error("That is a folder, not a file.");
  if (known && known.size && known.size > MAX_REMOTE_BYTES) throw new Error(tooBig(known.size));
  if (known && !isTextual(known)) {
    const err = new Error("Inkju opens text and markdown. Save a copy to your vault to keep this one.");
    err.notTextual = true;
    throw err;
  }

  const text = mcp.textOf(await mcp.callToolWithStepUp(id, caps.tools.read, idArgs(remoteId)));
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_REMOTE_BYTES) throw new Error(tooBig(bytes));

  return {
    connectionId: id,
    remoteId: String(remoteId),
    name: (known && known.name) || String(remoteId),
    text,
    version: known ? known.version : null,
    writable: caps.canWrite,
    /* no version marker means no way to notice someone else's edit, so every
       save on this file has to ask */
    conflictBlind: !known || !known.version
  };
}

/* --------------------------------------------------------------- writing */

/* Nothing here decides whether a write may happen. The allowlist is asked by
   mcp-client, and the user is asked by the caller in main.js; by the time
   control arrives here both have already said yes. */
async function writeFile(id, remoteId, text, opts){
  const o = opts || {};
  const caps = capabilities(id);
  if (!caps.tools.write) throw new Error("This connection is read-only.");

  const args = Object.assign(idArgs(remoteId), {
    content: String(text), body: String(text), text: String(text), data: String(text)
  });
  if (o.name) { args.name = o.name; args.filename = o.name; args.title = o.name; }

  const result = await mcp.callToolWithStepUp(id, caps.tools.write, args);
  /* A server that answers with the new metadata gives us the next version
     marker for free; one that answers with prose leaves us to go and ask. */
  let next = null;
  try { next = normaliseEntry(mcp.jsonOf(result)); } catch (err) { /* prose */ }
  if (!next) next = await metadata(id, remoteId);
  return { version: next ? next.version : null, name: next ? next.name : (o.name || null) };
}

/* Has this file moved since we opened it?

   A connection that cannot tell us always answers "unknown", which is what
   makes the caller ask every time rather than silently overwrite. */
async function checkForConflict(id, remoteId, expectedVersion){
  const caps = capabilities(id);
  if (!caps.canDetectConflicts || !expectedVersion) {
    return { known: false, changed: null, version: null };
  }
  const now = await metadata(id, remoteId);
  if (!now || !now.version) return { known: false, changed: null, version: null };
  return { known: true, changed: String(now.version) !== String(expectedVersion), version: now.version };
}

/* ------------------------------------------------------------- importing */

const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]", "g");
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/* A name that came from somewhere else, reduced to something that can only
   ever be a file inside the folder we chose.

   Separators go first, then anything that would make the name a traversal, a
   hidden file, or a Windows device. The vault path guard in files.js is the
   second line of defence, not the first: by the time a path has been assembled
   the damage is much easier to miss. */
function safeName(name){
  let base = String(name == null ? "" : name);
  base = base.split(/[/\\]/).pop();                    // any path, only its last part
  base = base.replace(CONTROL_CHARS, "");
  base = base.replace(/^\.+/, "");                     // ".." and dotfiles
  base = base.replace(/[<>:"|?*]/g, "-");              // reserved on Windows
  base = base.replace(/\s+$/, "").replace(/\.+$/, ""); // trailing space or dot
  base = base.trim();
  if (WINDOWS_DEVICE.test(base)) base = "_" + base;
  if (!base) base = "Untitled";
  if (base.length > 120) {
    const ext = path.extname(base).slice(0, 12);
    base = base.slice(0, 120 - ext.length) + ext;
  }
  if (!path.extname(base)) base += ".md";
  return base;
}

/* Copy a remote file into the vault as an ordinary note. Writes through
   files.createFile, so it gets the atomic write, the vault path guard and a
   non-colliding name without any of that being reimplemented here. */
async function importToVault(id, remoteId, dir, entry){
  if (!dir) throw new Error("Open a vault first so the file has somewhere to go.");
  const caps = capabilities(id);
  if (!caps.tools.read) throw new Error("This connection does not offer a way to read files.");
  const known = entry || await metadata(id, remoteId);

  const text = mcp.textOf(await mcp.callToolWithStepUp(id, caps.tools.read, idArgs(remoteId)));
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_REMOTE_BYTES) throw new Error(tooBig(bytes));

  const name = safeName((known && known.name) || remoteId);
  return files.createFile(dir, name, text);
}

module.exports = {
  capabilities, listFiles, metadata, readFile, writeFile,
  checkForConflict, importToVault,
  safeName, isTextual, normaliseEntry, entriesFrom, tooBig,
  MAX_REMOTE_BYTES
};
