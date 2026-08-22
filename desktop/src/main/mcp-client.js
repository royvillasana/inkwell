"use strict";
/* ===========================================================================
   The other half of the protocol. src/mcp/server.mjs lets an agent work
   inside a vault; this lets Inkju work inside someone else's store.

   Everything here runs in the main process and nothing it returns is handed
   to the renderer unfiltered. Two rules carry most of the weight:

   * the allowlist is consulted before a request leaves the process, never
     after a reply comes back;
   * a reply is checked for shape and size before anything reads it, because
     the thing on the other end is a program the user pointed at, not a
     program we wrote.
   =========================================================================== */
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { UnauthorizedError } = require("@modelcontextprotocol/sdk/client/auth.js");

const connections = require("./connections");
const secrets = require("./secrets");

const { STATUS } = connections;

const CLIENT_INFO = { name: "inkju", version: require("../../package.json").version };

/* A tool reply large enough to be a problem is a problem. Text we would put in
   an editor is measured in kilobytes; anything past this is either a mistake
   or someone testing what we do with it. */
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 30000;
const CALL_TIMEOUT_MS = 60000;

/* Live transports, by connection id. Never persisted, never exposed. */
const open = new Map();   // id -> { client, transport, kind }

/* Supplied by the wiring in main.js so this module never has to know about
   browser windows or OAuth. Returns an OAuthClientProvider for a record. */
let makeAuthProvider = null;
function setAuthProviderFactory(fn){ makeAuthProvider = fn; }

/* ------------------------------------------------------------------ errors */

/* Anything that reaches a user's screen goes through here first. An OAuth
   failure loves to quote the request that caused it, and that request has a
   token in it. */
const SECRET_KEY = "access_token|refresh_token|client_secret|code_verifier|code_challenge|id_token|authorization|assertion";

function scrub(message){
  let s = String(message == null ? "" : message);
  /* Two forms, and both matter: a query string or header, key=value or
     key: value; and a JSON body, "key":"value". The JSON one is the form an
     OAuth failure actually arrives in — the first version of this only caught
     the unquoted one, and a refresh token walked straight through it. */
  s = s.replace(new RegExp('"(' + SECRET_KEY + ')"\\s*:\\s*"[^"]*"', "gi"), '"$1":"[removed]"');
  s = s.replace(new RegExp("\\b(" + SECRET_KEY + ")\\b\\s*[=:]\\s*\\S+", "gi"), "$1=[removed]");
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [removed]");
  /* token-shaped strings that arrive with no label at all */
  s = s.replace(/\bya29\.[A-Za-z0-9._~-]+/g, "[removed]");
  s = s.replace(/\bGOCSPX-[A-Za-z0-9._~-]+/g, "[removed]");
  s = s.replace(/\b1\/\/[A-Za-z0-9._~-]{10,}/g, "[removed]");
  s = s.replace(/\b(?:sk|rt|pat)-[A-Za-z0-9]{16,}/gi, "[removed]");
  return s;
}
const failure = err => new Error(scrub(err && err.message ? err.message : err));

/* --------------------------------------------------------------- transport */

async function stdioTransport(rec){
  const cfg = rec.config || {};
  const command = String(cfg.command || "").trim();
  if (!command) throw new Error("This connection has no command to run.");

  /* Secret environment values are fetched at spawn time and never live in the
     record. A missing one is worth saying out loud: the server will usually
     fail in some less obvious way further along. */
  const env = Object.assign({}, cfg.env || {});
  for (const name of (cfg.secretEnv || [])) {
    const value = await secrets.get(rec.id, "env:" + name);
    if (value == null) throw new Error("This connection needs " + name + " and it is not stored. Open its settings and enter it again.");
    env[name] = value;
  }

  return new StdioClientTransport({
    command,
    args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
    env,
    /* the server's own diagnostics, kept out of the user's way but available
       when a connection will not come up */
    stderr: "pipe"
  });
}

function httpTransport(rec){
  const url = new URL(rec.config.url);
  const opts = {};
  if (makeAuthProvider) {
    const provider = makeAuthProvider(rec);
    if (provider) opts.authProvider = provider;
  }
  return new StreamableHTTPClientTransport(url, opts);
}

async function buildTransport(rec){
  if (rec.transport === "stdio") return await stdioTransport(rec);
  if (rec.transport === "http") return httpTransport(rec);
  throw new Error("A " + rec.transport + " connection does not speak MCP.");
}

/* ------------------------------------------------------------------ connect */

function withTimeout(promise, ms, what){
  let timer;
  const bell = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(what + " timed out after " + Math.round(ms / 1000) + "s.")), ms);
  });
  return Promise.race([promise, bell]).finally(() => clearTimeout(timer));
}

/* Connect, handshake, and record the tool surface.

   Errors are deliberately not retried here. A stdio server that exits on
   startup will exit again; retrying in a loop turns one broken configuration
   into a fork bomb, and the user cannot see any of it. */
async function connect(id){
  const rec = connections.raw(id);
  if (rec.enabled === false) throw new Error("That connection is turned off.");
  if (rec.transport === "local") throw new Error("A folder connection does not need connecting.");

  const already = open.get(id);
  if (already) return { id, tools: connections.toolsOf(id) };

  if (!connections.setStatus(id, STATUS.CONNECTING)) {
    throw new Error("That connection is already being set up.");
  }

  let transport = null;
  let client = null;
  let stderr = "";
  try {
    transport = await buildTransport(rec);
    if (transport.stderr) {
      transport.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    }
    client = new Client(CLIENT_INFO, { capabilities: {} });
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, "Connecting");

    const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, "Listing tools");
    const { appeared } = connections.setTools(id, (listed && listed.tools) || []);

    open.set(id, { client, transport, kind: rec.transport });
    connections.setStatus(id, STATUS.CONNECTED);
    return { id, tools: connections.toolsOf(id), appeared };
  } catch (err) {
    try { if (client) await client.close(); } catch (e) { /* already gone */ }
    try { if (transport) await transport.close(); } catch (e) { /* already gone */ }
    open.delete(id);

    /* An authorization problem is not a failure — it is a question for the
       user. Keeping the two apart is what stops the interface from showing a
       red error where it should be showing a Connect button. */
    if (err instanceof UnauthorizedError) {
      connections.setStatus(id, STATUS.NEEDS_AUTH, "This connection needs you to sign in.");
      const e = failure("This connection needs you to sign in.");
      e.needsAuthorization = true;
      throw e;
    }
    const detail = scrub(err.message) + (stderr ? "\n" + scrub(stderr.trim()) : "");
    connections.setStatus(id, STATUS.FAILED, detail);
    throw failure(detail);
  }
}

async function disconnect(id){
  const live = open.get(id);
  open.delete(id);
  if (live) {
    try { await live.client.close(); } catch (err) { /* already gone */ }
    try { await live.transport.close(); } catch (err) { /* already gone */ }
  }
  connections.setStatus(id, STATUS.DISCONNECTED);
  return true;
}

async function disconnectAll(){
  await Promise.all(Array.from(open.keys()).map(id => disconnect(id)));
}

const isConnected = id => open.has(id);

/* ---------------------------------------------------------------- calling */

/* The size check happens on the serialised reply, before anything walks it.
   Checking a parsed object's fields one by one means the oversized thing is
   already in memory and already being read. */
function checkSize(result){
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(result) || "", "utf8"); }
  catch (err) { throw new Error("That reply could not be read."); }
  if (bytes > MAX_RESULT_BYTES) {
    throw new Error("That reply is " + Math.round(bytes / 1024 / 1024) + " MB, larger than Inkju will accept from a connection.");
  }
  return result;
}

/* MCP tool results are `{ content: [...], isError?: boolean }`. Anything else
   is a server that is not doing what it said it would; we fail rather than
   guess at what it meant. */
function checkShape(result){
  if (!result || typeof result !== "object") throw new Error("That connection sent a reply Inkju could not read.");
  if (!Array.isArray(result.content)) throw new Error("That connection sent a reply Inkju could not read.");
  for (const part of result.content) {
    if (!part || typeof part !== "object" || typeof part.type !== "string") {
      throw new Error("That connection sent a reply Inkju could not read.");
    }
  }
  return result;
}

/* Call a tool. The allowlist question is asked first, and asked of the record
   rather than of anything the caller passed in. */
async function callTool(id, name, args){
  if (!connections.isAllowed(id, name)) {
    /* deliberately the same message whether the tool is unknown, disallowed or
       on a disabled connection — the caller has no business telling them apart */
    throw new Error("Inkju is not allowed to use “" + name + "” on this connection.");
  }
  const live = open.get(id);
  if (!live) throw new Error("That connection is not connected.");

  let result;
  try {
    result = await withTimeout(
      live.client.callTool({ name: String(name), arguments: args || {} }),
      CALL_TIMEOUT_MS, "That request");
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      connections.setStatus(id, STATUS.NEEDS_AUTH, "This connection needs you to sign in again.");
      const e = failure("This connection needs you to sign in again.");
      e.needsAuthorization = true;
      throw e;
    }
    /* A transport that has died takes the connection down with it, rather than
       leaving a client that looks connected and fails every call. */
    if (/closed|EPIPE|ECONNRESET|socket hang up/i.test(String(err.message))) {
      await disconnect(id);
      connections.setStatus(id, STATUS.FAILED, scrub(err.message));
    }
    /* The SDK validates a tool result against the protocol schema before we
       ever see it, and says so in the protocol's own words — a JSON dump of
       Zod issues with an error code in front. True, and useless on screen.
       A reply that does not match the schema is the same event checkShape()
       below exists to catch, so it gets the same sentence. */
    if (/Invalid tools\/call result/i.test(String(err.message))) {
      throw new Error("That connection sent a reply Inkju could not read.");
    }
    throw failure(err);
  }

  checkSize(result);
  checkShape(result);
  if (result.isError) {
    const text = (result.content || []).filter(p => p.type === "text").map(p => p.text).join("\n");
    throw failure(text || "That request was refused by the connection.");
  }
  return result;
}

/* Most tools answer with one block of text. This is the convenience the rest
   of the app actually uses; anything richer reads `content` itself. */
function textOf(result){
  return (result.content || [])
    .filter(p => p.type === "text" && typeof p.text === "string")
    .map(p => p.text)
    .join("\n");
}

/* Some servers answer with a JSON document in a text block. Parsed defensively:
   a tool that says it returns a list and returns prose fails the operation
   rather than producing an empty list nobody can explain. */
function jsonOf(result){
  const text = textOf(result).trim();
  if (!text) throw new Error("That connection returned nothing.");
  try { return JSON.parse(text); }
  catch (err) { throw new Error("That connection returned something Inkju could not read as data."); }
}

/* ----------------------------------------------------------- step-up auth */

/* A 403 saying `insufficient_scope` is not a failure, it is the server telling
   us which permission this particular operation needs. The retry asks for the
   union of what we had and what was demanded — asking for only the new scope
   is how a client loses the permissions it was already granted — and it is
   bounded, because a server that keeps demanding a scope it will not grant
   would otherwise bounce the user through the browser forever.

   `reauthorize` is injected by the wiring in main.js; without it, an
   insufficient-scope error is simply reported. */
let reauthorize = null;
function setReauthorizer(fn){ reauthorize = fn; }

async function callToolWithStepUp(id, name, args){
  const oauth = require("./oauth");
  let attempts = 0;
  for (;;) {
    try {
      return await callTool(id, name, args);
    } catch (err) {
      const challenge = oauth.parseInsufficientScope(err);
      if (!challenge || !reauthorize) throw err;
      if (++attempts >= oauth.MAX_STEP_UP_ATTEMPTS) {
        throw failure("This connection will not grant Inkju the permission this needs — “" +
          challenge.scope + "”. Check what the account is allowed to do.");
      }
      const rec = connections.raw(id);
      const wanted = oauth.scopeUnion((rec.config.scopes || []).join(" "), challenge.scope);
      /* Deliberately not written to the connection record. The scopes came off
         the wire, and persisting them would make one challenge change what
         every future sign-in asks for — permanently, from a single reply. They
         are handed to this one authorization and no further. */
      await disconnect(id);
      await reauthorize(id, wanted);
    }
  }
}

module.exports = {
  connect, disconnect, disconnectAll, isConnected,
  callTool, callToolWithStepUp, setReauthorizer, textOf, jsonOf,
  setAuthProviderFactory,
  scrub, checkShape, checkSize,
  MAX_RESULT_BYTES
};
