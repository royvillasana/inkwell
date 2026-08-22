"use strict";
/* Tests for the connection registry. Two themes: the record is durable and the
   status is not, and nothing credential-shaped can reach the renderer. */
const assert = require("assert");
const fsp = require("fs").promises;
const os = require("os");
const path = require("path");

const connections = require("../src/main/connections");
const secrets = require("../src/main/secrets");

/* A stand-in for store.js, which reaches for Electron on require. */
function fakeStore(){
  const state = { connections: [] };
  return {
    get: () => state,
    save: patch => { Object.assign(state, patch); return state; },
    _state: state
  };
}

function fakeBackend(){
  return {
    isEncryptionAvailable: () => true,
    encrypt: async t => Buffer.from("v1:" + Buffer.from(t, "utf8").toString("hex")),
    decrypt: async b => Buffer.from(Buffer.from(b).toString("utf8").slice(3), "hex").toString("utf8")
  };
}

const HTTP = { label: "Google Drive", transport: "http", config: { url: "https://drivemcp.googleapis.com/mcp/v1", scopes: ["drive.file"] } };
const STDIO = { label: "Local files", transport: "stdio", config: { command: "node", args: ["server.mjs"] } };

module.exports = async function run(test){
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "inkju-conn-"));
  let store;
  const reset = async () => {
    store = fakeStore();
    connections.setStore(store);
    connections.resetLive();
    connections.events.removeAllListeners();
    secrets.setBackend(fakeBackend());
    secrets.setFile(path.join(dir, "secrets.json"));
    await fsp.rm(path.join(dir, "secrets.json"), { force: true });
  };

  /* ------------------------------------------------------------- records */

  await test("adding a connection persists a record with a stable id", async () => {
    await reset();
    const c = connections.add(HTTP);
    assert.ok(/^conn_[0-9a-f]{16}$/.test(c.id), "unexpected id: " + c.id);
    assert.strictEqual(store._state.connections.length, 1);
    assert.strictEqual(connections.get(c.id).label, "Google Drive");
  });

  await test("a new connection can call nothing at all", async () => {
    await reset();
    const c = connections.add(HTTP);
    assert.deepStrictEqual(c.allow, [], "a new connection should start with an empty allowlist");
    connections.setTools(c.id, [{ name: "search_files" }, { name: "create_file" }]);
    assert.strictEqual(connections.isAllowed(c.id, "search_files"), false);
    assert.strictEqual(connections.isAllowed(c.id, "create_file"), false);
  });

  await test("renaming keeps the id, the allowlist and the credentials", async () => {
    await reset();
    const c = connections.add(HTTP);
    connections.setTools(c.id, [{ name: "search_files" }]);
    connections.update(c.id, { allow: ["search_files"] });
    await secrets.set(c.id, "access_token", "tok");
    const after = connections.update(c.id, { label: "Work Drive" });
    assert.strictEqual(after.id, c.id);
    assert.strictEqual(after.label, "Work Drive");
    assert.deepStrictEqual(after.allow, ["search_files"]);
    assert.strictEqual(await secrets.get(c.id, "access_token"), "tok");
  });

  await test("a patch merges config rather than replacing it", async () => {
    await reset();
    const c = connections.add(HTTP);
    const after = connections.update(c.id, { config: { clientId: "123.apps.googleusercontent.com" } });
    assert.strictEqual(after.config.url, "https://drivemcp.googleapis.com/mcp/v1", "the url was lost by a partial patch");
    assert.strictEqual(after.config.clientId, "123.apps.googleusercontent.com");
  });

  await test("removing a connection deletes its credentials and disposes the transport", async () => {
    await reset();
    const c = connections.add(HTTP);
    await secrets.set(c.id, "access_token", "tok");
    await secrets.set(c.id, "refresh_token", "ref");
    let disposed = null;
    await connections.remove(c.id, id => { disposed = id; });
    assert.strictEqual(disposed, c.id, "the transport was not disposed");
    assert.strictEqual(store._state.connections.length, 0);
    assert.deepStrictEqual(await secrets.keys(c.id), [], "credentials outlived the connection");
  });

  await test("a disposer that throws does not strand the record", async () => {
    await reset();
    const c = connections.add(HTTP);
    await connections.remove(c.id, () => { throw new Error("process would not die"); });
    assert.strictEqual(store._state.connections.length, 0);
  });

  /* ---------------------------------------------------------- validation */

  await test("plain http to a remote host is refused", async () => {
    await reset();
    assert.throws(() => connections.add({ label: "x", transport: "http", config: { url: "http://example.com/mcp" } }),
      /https/i);
    assert.strictEqual(store._state.connections.length, 0, "a refused connection was still recorded");
  });

  await test("plain http to loopback is allowed for development", async () => {
    await reset();
    const c = connections.add({ label: "dev", transport: "http", config: { url: "http://127.0.0.1:8931/mcp" } });
    assert.ok(c.id);
  });

  await test("a server address with a fragment is refused", async () => {
    await reset();
    assert.throws(() => connections.add({ label: "x", transport: "http", config: { url: "https://mcp.example.com/mcp#frag" } }),
      /fragment/i);
  });

  await test("a connection needs a name and a command", async () => {
    await reset();
    assert.throws(() => connections.add({ label: "  ", transport: "http", config: { url: "https://a.example/mcp" } }), /name/i);
    assert.throws(() => connections.add({ label: "x", transport: "stdio", config: {} }), /command/i);
    assert.throws(() => connections.add({ label: "x", transport: "nonsense", config: {} }), /Unknown connection type/i);
  });

  /* -------------------------------------------------------------- status */

  await test("status starts disconnected and is never persisted", async () => {
    await reset();
    const c = connections.add(HTTP);
    assert.strictEqual(connections.get(c.id).status, "disconnected");
    connections.setStatus(c.id, "connecting");
    connections.setStatus(c.id, "connected");
    assert.strictEqual(connections.get(c.id).status, "connected");
    assert.ok(!JSON.stringify(store._state.connections).includes("connected"),
      "status leaked into the persisted record");
  });

  await test("an abandoned attempt cannot flip a disconnected connection back", async () => {
    await reset();
    const c = connections.add(HTTP);
    connections.setStatus(c.id, "connecting");
    connections.setStatus(c.id, "disconnected");        // user disabled it mid-connect
    const late = connections.setStatus(c.id, "connected");   // the old attempt finally replies
    assert.strictEqual(late, false, "a stale reply was allowed through");
    assert.strictEqual(connections.get(c.id).status, "disconnected");
  });

  await test("status changes are announced", async () => {
    await reset();
    const c = connections.add(HTTP);
    const seen = [];
    connections.events.on("status", e => seen.push(e.status));
    connections.setStatus(c.id, "connecting");
    connections.setStatus(c.id, "needs-authorization");
    assert.deepStrictEqual(seen, ["connecting", "needs-authorization"]);
  });

  /* --------------------------------------------------------------- tools */

  await test("write-shaped tools are classified as writes", async () => {
    assert.strictEqual(connections.isWriteTool("search_files"), false);
    assert.strictEqual(connections.isWriteTool("read_file_content"), false);
    assert.strictEqual(connections.isWriteTool("get_file_metadata"), false);
    assert.strictEqual(connections.isWriteTool("list_recent_files"), false);
    assert.strictEqual(connections.isWriteTool("create_file"), true);
    assert.strictEqual(connections.isWriteTool("delete_everything"), true);
    assert.strictEqual(connections.isWriteTool("copy_file"), true);
    assert.strictEqual(connections.isWriteTool("wipe"), true, "an unrecognised tool must count as a write");
  });

  await test("a newly advertised tool arrives disabled and is announced", async () => {
    await reset();
    const c = connections.add(HTTP);
    connections.setTools(c.id, [{ name: "search_files" }]);
    connections.update(c.id, { allow: ["search_files"] });
    let announced = null;
    connections.events.on("tools-appeared", e => { announced = e.tools; });
    connections.setTools(c.id, [{ name: "search_files" }, { name: "delete_everything" }]);
    assert.deepStrictEqual(announced, ["delete_everything"], "the new tool was not announced");
    assert.strictEqual(connections.isAllowed(c.id, "delete_everything"), false);
    assert.strictEqual(connections.isAllowed(c.id, "search_files"), true, "the existing allowance was lost");
  });

  await test("a tool that disappears and returns does not come back allowed", async () => {
    await reset();
    const c = connections.add(HTTP);
    connections.setTools(c.id, [{ name: "search_files" }]);
    connections.update(c.id, { allow: ["search_files"] });
    connections.setTools(c.id, [{ name: "read_file_content" }]);          // search_files gone
    assert.strictEqual(connections.isAllowed(c.id, "search_files"), false);
    connections.setTools(c.id, [{ name: "search_files" }]);               // and back
    assert.strictEqual(connections.isAllowed(c.id, "search_files"), false,
      "an allowance survived the tool disappearing");
  });

  await test("the proposed allowlist pre-ticks reads and never writes", async () => {
    await reset();
    const c = connections.add(HTTP);
    connections.setTools(c.id, [
      { name: "search_files" }, { name: "read_file_content" },
      { name: "create_file" }, { name: "copy_file" }
    ]);
    const proposed = connections.proposeAllow(c.id, ["search_files", "read_file_content", "create_file"]);
    assert.deepStrictEqual(proposed.sort(), ["read_file_content", "search_files"],
      "a write tool was proposed pre-ticked");
  });

  await test("a disabled connection is allowed nothing", async () => {
    await reset();
    const c = connections.add(HTTP);
    connections.setTools(c.id, [{ name: "search_files" }]);
    connections.update(c.id, { allow: ["search_files"] });
    assert.strictEqual(connections.isAllowed(c.id, "search_files"), true);
    connections.update(c.id, { enabled: false });
    assert.strictEqual(connections.isAllowed(c.id, "search_files"), false);
  });

  await test("a removed connection is allowed nothing", async () => {
    await reset();
    const c = connections.add(HTTP);
    connections.setTools(c.id, [{ name: "search_files" }]);
    connections.update(c.id, { allow: ["search_files"] });
    await connections.remove(c.id);
    assert.strictEqual(connections.isAllowed(c.id, "search_files"), false);
  });

  /* ------------------------------------------------- the renderer's view */

  await test("the public record carries no credential of any kind", async () => {
    await reset();
    const c = connections.add({
      label: "Drive", transport: "http",
      config: {
        url: "https://drivemcp.googleapis.com/mcp/v1",
        clientId: "123.apps.googleusercontent.com",
        clientSecret: "GOCSPX-averyrealsecret",
        accessToken: "ya29.notreal",
        refreshToken: "1//refresh"
      }
    });
    const body = JSON.stringify(connections.get(c.id));
    for (const leak of ["GOCSPX-averyrealsecret", "ya29.notreal", "1//refresh"]) {
      assert.ok(!body.includes(leak), "a credential reached the renderer's view: " + leak);
    }
    assert.ok(body.includes("123.apps.googleusercontent.com"), "the client id should be visible");
  });

  await test("an unknown config field cannot smuggle itself out", async () => {
    /* the public shape is an allowlist, so a field nobody has thought about
       yet — the next one might be a token — does not travel by default */
    await reset();
    const c = connections.add({
      label: "x", transport: "stdio",
      config: { command: "node", args: [], somethingNew: "sk-live-notreal" }
    });
    assert.ok(!JSON.stringify(connections.get(c.id)).includes("sk-live-notreal"));
  });

  await test("secret environment variables are named but not valued", async () => {
    await reset();
    const c = connections.add({
      label: "x", transport: "stdio",
      config: { command: "node", args: [], env: { LOG: "debug" }, secretEnv: ["API_KEY"] }
    });
    await secrets.set(c.id, "env:API_KEY", "sk-live-notreal");
    const view = connections.get(c.id);
    assert.deepStrictEqual(view.config.secretEnv, ["API_KEY"]);
    assert.strictEqual(view.config.env.LOG, "debug");
    assert.ok(!JSON.stringify(view).includes("sk-live-notreal"));
  });

  await test("listing every connection leaks nothing either", async () => {
    await reset();
    connections.add(HTTP);
    connections.add(STDIO);
    const body = JSON.stringify(connections.list());
    assert.ok(!body.includes("clientSecret"));
    assert.ok(!body.includes("accessToken"));
    assert.strictEqual(connections.list().length, 2);
  });

  await fsp.rm(dir, { recursive: true, force: true });
};
