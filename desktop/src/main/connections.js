"use strict";
/* ===========================================================================
   The connection registry: what outside sources this copy of Inkju knows
   about, what each one is allowed to do, and which of them are up right now.

   A record is durable and boring — a label, a transport, an allowlist. Status
   is the opposite: it lives only in memory, because "connected" is a fact
   about this process, not about the user's preferences. Persisting it would
   mean starting up claiming a connection that has not been made yet.

   Nothing credential-shaped passes through here. Tokens and secrets belong to
   secrets.js; this module holds their *names* at most.
   =========================================================================== */
const { EventEmitter } = require("events");
const crypto = require("crypto");

const secrets = require("./secrets");

/* store.js reaches for Electron's app path the moment it is required, so it is
   pulled in lazily: these tests run under plain node. */
let store = null;
function getStore(){
  if (!store) store = require("./store");
  return store;
}
function setStore(s){ store = s; }   // test seam

const TRANSPORTS = new Set(["stdio", "http", "local"]);

const STATUS = {
  DISCONNECTED: "disconnected",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  NEEDS_AUTH: "needs-authorization",
  FAILED: "failed"
};

/* Which moves the status machine allows. The point is not bureaucracy: it is
   that a late reply from an abandoned connection attempt must not be able to
   flip a connection the user has since disabled back to "connected". */
const ALLOWED = {
  [STATUS.DISCONNECTED]: [STATUS.CONNECTING, STATUS.DISCONNECTED],
  [STATUS.CONNECTING]:   [STATUS.CONNECTED, STATUS.FAILED, STATUS.NEEDS_AUTH, STATUS.DISCONNECTED],
  [STATUS.CONNECTED]:    [STATUS.FAILED, STATUS.NEEDS_AUTH, STATUS.DISCONNECTED, STATUS.CONNECTED],
  [STATUS.NEEDS_AUTH]:   [STATUS.CONNECTING, STATUS.DISCONNECTED, STATUS.FAILED],
  [STATUS.FAILED]:       [STATUS.CONNECTING, STATUS.DISCONNECTED]
};

const events = new EventEmitter();
const live = new Map();   // id -> { status, detail, tools, since }

/* ------------------------------------------------------------------ shape */

/* Tools that change something. Matched on the name because MCP does not label
   a tool as destructive, and the allowlist has to default to "no" for anything
   that might be. A tool we cannot classify counts as a write. */
const READ_TOOL = /^(list|read|get|search|find|fetch|download|stat|info|describe|preview|query|outline|backlinks|tags)(_|$)/i;
const isWriteTool = name => !READ_TOOL.test(String(name || ""));

function blankRecord(){
  return {
    id: "",
    label: "",
    transport: "http",
    config: {},
    enabled: true,
    /* deny by default: an empty allowlist can call nothing at all */
    allow: [],
    tools: [],
    preset: null,
    /* per-connection, off by default, and never applied to deletions */
    confirmWrites: true
  };
}

function validate(rec){
  if (!rec || typeof rec !== "object") throw new Error("A connection needs a configuration.");
  const label = String(rec.label || "").trim();
  if (!label) throw new Error("A connection needs a name.");
  if (!TRANSPORTS.has(rec.transport)) throw new Error("Unknown connection type: " + rec.transport);
  const config = rec.config || {};

  if (rec.transport === "stdio") {
    if (!String(config.command || "").trim()) throw new Error("A local connection needs a command to run.");
    if (config.args && !Array.isArray(config.args)) throw new Error("Arguments must be a list.");
  }
  if (rec.transport === "http") {
    let url;
    try { url = new URL(String(config.url || "")); }
    catch (err) { throw new Error("That is not a valid server address."); }
    /* HTTPS or loopback, nothing else. A bearer token on a plaintext link to
       someone else's host is a token you have given away. */
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new Error("Connections must use https. Plain http is only allowed to 127.0.0.1 while developing.");
    }
    if (url.hash) throw new Error("A server address cannot contain a fragment.");
  }
  if (rec.transport === "local") {
    if (!String(config.root || "").trim()) throw new Error("A local folder connection needs a folder.");
  }
  return true;
}

/* The only shape that ever leaves this process for the renderer.

   Built by naming what may pass rather than by deleting what may not — a
   denylist would let the next field someone adds to config through by
   default, and the next field might be a token. */
function publicRecord(rec){
  const status = live.get(rec.id) || { status: STATUS.DISCONNECTED };
  const config = rec.config || {};
  const safeConfig = {};
  if (rec.transport === "stdio") {
    safeConfig.command = config.command;
    safeConfig.args = Array.isArray(config.args) ? config.args.slice() : [];
    /* names only: the values of secret variables live in secrets.js, and the
       plain ones are shown so the user can see what the process will run */
    safeConfig.env = Object.assign({}, config.env || {});
    safeConfig.secretEnv = Array.isArray(config.secretEnv) ? config.secretEnv.slice() : [];
  } else if (rec.transport === "http") {
    safeConfig.url = config.url;
    safeConfig.scopes = Array.isArray(config.scopes) ? config.scopes.slice() : [];
    /* a client id is an identifier, not a credential, and the user needs to
       see it to check they pasted the right one; the secret never appears */
    safeConfig.clientId = config.clientId || null;
    safeConfig.hasClientSecret = !!status.hasClientSecret;
  } else if (rec.transport === "local") {
    safeConfig.root = config.root;
    safeConfig.kind = config.kind || null;
  }
  return {
    id: rec.id,
    label: rec.label,
    transport: rec.transport,
    preset: rec.preset || null,
    enabled: rec.enabled !== false,
    confirmWrites: rec.confirmWrites !== false,
    allow: (rec.allow || []).slice(),
    tools: (status.tools || rec.tools || []).map(t => ({
      name: t.name,
      description: t.description || "",
      write: isWriteTool(t.name)
    })),
    config: safeConfig,
    status: status.status,
    detail: status.detail || null
  };
}

/* --------------------------------------------------------------- registry */

function all(){
  const list = getStore().get().connections;
  return Array.isArray(list) ? list : [];
}

function find(id){
  return all().find(c => c.id === id) || null;
}

function require_(id){
  const rec = find(id);
  if (!rec) throw new Error("That connection no longer exists.");
  return rec;
}

function persist(list){
  getStore().save({ connections: list });
  return list;
}

function list(){
  return all().map(publicRecord);
}

function get(id){
  return publicRecord(require_(id));
}

/* The raw record, for the transport layer inside this process only. Never
   handed to an IPC reply. */
function raw(id){
  return require_(id);
}

function add(input){
  const rec = Object.assign(blankRecord(), {
    label: String((input && input.label) || "").trim(),
    transport: input && input.transport,
    config: (input && input.config) || {},
    preset: (input && input.preset) || null,
    enabled: !(input && input.enabled === false),
    confirmWrites: !(input && input.confirmWrites === false),
    /* whatever the user ticked in the add flow, filtered to real tool names
       once we have connected; nothing is trusted from the caller wholesale */
    allow: Array.isArray(input && input.allow) ? input.allow.map(String) : []
  });
  validate(rec);
  rec.id = "conn_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  persist(all().concat([rec]));
  events.emit("changed", { id: rec.id, reason: "added" });
  return publicRecord(rec);
}

/* Patches are merged field by field. `config` merges rather than replaces so a
   caller updating a label cannot blank a server address by omission. */
function update(id, patch){
  const list = all();
  const i = list.findIndex(c => c.id === id);
  if (i < 0) throw new Error("That connection no longer exists.");
  const next = Object.assign({}, list[i]);
  if (patch.label != null) next.label = String(patch.label).trim();
  if (patch.enabled != null) next.enabled = !!patch.enabled;
  if (patch.confirmWrites != null) next.confirmWrites = !!patch.confirmWrites;
  if (patch.allow) next.allow = patch.allow.map(String);
  if (patch.config) next.config = Object.assign({}, next.config, patch.config);
  validate(next);
  list[i] = next;
  persist(list);
  events.emit("changed", { id, reason: "updated" });
  return publicRecord(next);
}

/* Removing a connection has to take everything with it. A record deleted while
   its token stayed behind in secrets.json would leave a live credential with
   nothing in the interface pointing at it — invisible, and still valid. The
   caller passes a disposer so the transport can close the socket and reap the
   child process before the record disappears. */
async function remove(id, dispose){
  const rec = find(id);
  if (!rec) return false;
  if (typeof dispose === "function") {
    try { await dispose(id); }
    catch (err) { console.warn("connections: could not shut down " + id + ": " + err.message); }
  }
  live.delete(id);
  persist(all().filter(c => c.id !== id));
  await secrets.remove(id);
  events.emit("changed", { id, reason: "removed" });
  events.emit("status", { id, status: STATUS.DISCONNECTED, detail: null, removed: true });
  return true;
}

/* ----------------------------------------------------------------- status */

function statusOf(id){
  const s = live.get(id);
  return s ? s.status : STATUS.DISCONNECTED;
}

function setStatus(id, status, detail){
  if (!Object.values(STATUS).includes(status)) throw new Error("Unknown status: " + status);
  const from = statusOf(id);
  if (!ALLOWED[from].includes(status)) return false;
  const prev = live.get(id) || {};
  live.set(id, Object.assign({}, prev, {
    status,
    detail: detail == null ? null : String(detail),
    since: Date.now()
  }));
  events.emit("status", { id, status, detail: detail == null ? null : String(detail) });
  return true;
}

/* The tool surface a server advertised on this connection. Recorded in memory
   and mirrored into the record so the allowlist editor has something to show
   before the next connect. */
function setTools(id, tools){
  const rec = find(id);
  const clean = (tools || []).map(t => ({ name: String(t.name), description: String(t.description || "") }));
  const prev = live.get(id) || { status: statusOf(id) };
  live.set(id, Object.assign({}, prev, { tools: clean }));

  /* Anything that was not there last time arrives disabled, and the user is
     told. A remote server can grow a tool overnight; deny-by-default is worth
     nothing if a new name is quietly inherited into the allowlist. */
  const known = new Set((rec && rec.tools || []).map(t => t.name));
  const appeared = clean.filter(t => !known.has(t.name)).map(t => t.name);

  if (rec) {
    const list = all();
    const i = list.findIndex(c => c.id === id);
    if (i >= 0) {
      /* prune the allowlist to what the server still offers, so a tool that
         disappears and later returns does not come back pre-allowed */
      const offered = new Set(clean.map(t => t.name));
      list[i] = Object.assign({}, list[i], {
        tools: clean,
        allow: (list[i].allow || []).filter(n => offered.has(n))
      });
      persist(list);
    }
  }
  if (appeared.length) events.emit("tools-appeared", { id, tools: appeared });
  return { tools: clean, appeared };
}

function toolsOf(id){
  const s = live.get(id);
  if (s && s.tools) return s.tools;
  const rec = find(id);
  return (rec && rec.tools) || [];
}

/* The single question the whole security model rests on. Asked before any
   request leaves the process, never after. */
function isAllowed(id, tool){
  const rec = find(id);
  if (!rec) return false;
  if (rec.enabled === false) return false;
  return (rec.allow || []).indexOf(String(tool)) >= 0;
}

/* What the allowlist editor should propose for a freshly connected server:
   the read tools this connection needs to be useful, and nothing that writes.
   `needs` is the provider's read mapping — those are pre-ticked; every other
   read tool is offered unticked, and every write tool is offered unticked. */
function proposeAllow(id, needs){
  const wanted = new Set((needs || []).map(String));
  return toolsOf(id)
    .filter(t => wanted.has(t.name) && !isWriteTool(t.name))
    .map(t => t.name);
}

/* Only for tests and for a clean shutdown. */
function resetLive(){ live.clear(); }

module.exports = {
  STATUS, events,
  list, get, raw, add, update, remove,
  statusOf, setStatus, setTools, toolsOf, isAllowed, proposeAllow,
  publicRecord, isWriteTool, validate,
  setStore, resetLive
};
