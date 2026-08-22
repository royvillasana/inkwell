"use strict";
/* Tests for the credential store. The whole point of this module is that a
   token never lands on disk in a form anyone can read, so most of these are
   about what must NOT be in the file. */
const assert = require("assert");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");

const secrets = require("../src/main/secrets");

/* A stand-in for safeStorage. Reversible, obviously not secure — it exists so
   the tests can assert that the plaintext is absent from the file, and so that
   "the OS refused" is something we can actually provoke. */
function fakeBackend(opts){
  const o = opts || {};
  return {
    isEncryptionAvailable: () => (o.available !== false),
    encrypt: async text => {
      if (o.encryptThrows) throw new Error("keychain locked");
      return Buffer.from("v1:" + Buffer.from(text, "utf8").toString("hex"), "utf8");
    },
    decrypt: async buf => {
      const s = Buffer.from(buf).toString("utf8");
      if (!s.startsWith("v1:")) throw new Error("cannot decrypt");
      return Buffer.from(s.slice(3), "hex").toString("utf8");
    }
  };
}

module.exports = async function run(test){
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "inkju-secrets-"));
  const file = path.join(dir, "secrets.json");
  const reset = async (opts) => {
    secrets.setBackend(fakeBackend(opts));
    secrets.setFile(file);
    await fsp.rm(file, { force: true });
  };
  const raw = () => { try { return fs.readFileSync(file, "utf8"); } catch (e) { return ""; } };

  const TOKEN = "ya29.a0AfB_notarealtoken_abcdefghijklmnop";

  await test("stores and returns a credential", async () => {
    await reset();
    const r = await secrets.set("conn1", "access_token", TOKEN);
    assert.strictEqual(r.stored, "disk");
    assert.strictEqual(await secrets.get("conn1", "access_token"), TOKEN);
  });

  await test("the plaintext is never in the file", async () => {
    await reset();
    await secrets.set("conn1", "access_token", TOKEN);
    await secrets.set("conn1", "client_secret", "GOCSPX-averyrealsecret");
    const body = raw();
    assert.ok(body.length, "the file should exist");
    assert.ok(!body.includes(TOKEN), "the access token leaked into secrets.json");
    assert.ok(!body.includes("GOCSPX-averyrealsecret"), "the client secret leaked into secrets.json");
  });

  await test("credentials are kept out of settings.json", async () => {
    /* Structural, not incidental: the module has one storage location and it
       is not the settings file. If someone points it there, this fails. */
    await reset();
    await secrets.set("conn1", "access_token", TOKEN);
    assert.ok(path.basename(file) !== "settings.json");
    assert.ok(!raw().includes("windowBounds"), "secrets are sharing a file with settings");
  });

  await test("the file is not world readable", async () => {
    if (process.platform === "win32") return;
    await reset();
    await secrets.set("conn1", "access_token", TOKEN);
    const mode = (await fsp.stat(file)).mode & 0o777;
    assert.strictEqual(mode, 0o600, "expected 0600, got 0" + mode.toString(8));
  });

  await test("several connections do not overwrite each other", async () => {
    await reset();
    await secrets.set("a", "access_token", "token-a");
    await secrets.set("b", "access_token", "token-b");
    assert.strictEqual(await secrets.get("a", "access_token"), "token-a");
    assert.strictEqual(await secrets.get("b", "access_token"), "token-b");
  });

  await test("removing one key leaves the others", async () => {
    await reset();
    await secrets.set("a", "access_token", "token-a");
    await secrets.set("a", "refresh_token", "refresh-a");
    await secrets.remove("a", "access_token");
    assert.strictEqual(await secrets.get("a", "access_token"), null);
    assert.strictEqual(await secrets.get("a", "refresh_token"), "refresh-a");
  });

  await test("removing a connection clears every credential it had", async () => {
    await reset();
    await secrets.set("a", "access_token", "token-a");
    await secrets.set("a", "refresh_token", "refresh-a");
    await secrets.set("b", "access_token", "token-b");
    await secrets.remove("a");
    assert.deepStrictEqual(await secrets.keys("a"), []);
    assert.strictEqual(await secrets.get("a", "refresh_token"), null);
    assert.strictEqual(await secrets.get("b", "access_token"), "token-b", "removing one connection took another with it");
  });

  await test("keys() lists names and never values", async () => {
    await reset();
    await secrets.set("a", "access_token", TOKEN);
    await secrets.set("a", "client_secret", "shh");
    const k = await secrets.keys("a");
    assert.deepStrictEqual(k, ["access_token", "client_secret"]);
    assert.ok(!JSON.stringify(k).includes(TOKEN));
  });

  await test("when the OS cannot encrypt, nothing is written to disk", async () => {
    await reset({ available: false });
    const r = await secrets.set("conn1", "access_token", TOKEN);
    assert.strictEqual(r.stored, "memory", "expected an in-memory fallback");
    assert.strictEqual(raw(), "", "a credential was written to disk without encryption");
  });

  await test("an in-memory credential is still usable this session", async () => {
    await reset({ available: false });
    await secrets.set("conn1", "access_token", TOKEN);
    assert.strictEqual(await secrets.get("conn1", "access_token"), TOKEN);
  });

  await test("an undecryptable credential is discarded, not returned as garbage", async () => {
    await reset();
    await secrets.set("conn1", "access_token", TOKEN);
    /* the keychain moved under us: the ciphertext no longer decrypts */
    const data = JSON.parse(raw());
    data.conn1.access_token = Buffer.from("garbage from another machine").toString("base64");
    fs.writeFileSync(file, JSON.stringify(data));
    assert.strictEqual(await secrets.get("conn1", "access_token"), null);
    assert.deepStrictEqual(await secrets.keys("conn1"), [], "the unreadable credential should have been dropped");
  });

  await test("reading a credential the OS can no longer decrypt does not throw", async () => {
    await reset();
    await secrets.set("conn1", "access_token", TOKEN);
    secrets.setBackend(fakeBackend({ available: false }));
    assert.strictEqual(await secrets.get("conn1", "access_token"), null);
  });

  await test("setting an empty value removes the credential", async () => {
    await reset();
    await secrets.set("conn1", "access_token", TOKEN);
    await secrets.set("conn1", "access_token", "");
    assert.strictEqual(await secrets.get("conn1", "access_token"), null);
  });

  await test("a persisted credential does not linger in memory as well", async () => {
    /* stored while the OS was unavailable, then stored properly: a later
       revocation must not find the stale in-memory copy still answering */
    await reset({ available: false });
    await secrets.set("conn1", "access_token", "old-token");
    secrets.setBackend(fakeBackend());
    await secrets.set("conn1", "access_token", "new-token");
    assert.strictEqual(await secrets.get("conn1", "access_token"), "new-token");
  });

  await test("a missing store reads as empty rather than throwing", async () => {
    await reset();
    assert.strictEqual(await secrets.get("nobody", "access_token"), null);
    assert.deepStrictEqual(await secrets.keys("nobody"), []);
  });

  await test("a corrupt store does not take the app down", async () => {
    await reset();
    fs.writeFileSync(file, "{ this is not json");
    assert.strictEqual(await secrets.get("conn1", "access_token"), null);
  });

  await fsp.rm(dir, { recursive: true, force: true });
};
