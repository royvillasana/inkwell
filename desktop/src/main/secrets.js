"use strict";
/* ===========================================================================
   Credentials for outside connections: OAuth tokens, client secrets, and any
   environment value the user marked secret.

   Two rules, and neither of them bends:

   1. Nothing here is ever written in plaintext. The bytes on disk are whatever
      the operating system's key store gives us — Keychain on macOS, DPAPI on
      Windows, libsecret on Linux — through Electron's safeStorage. When the OS
      cannot encrypt, we keep the value in memory for this session and tell the
      user it will need entering again. We do not "fall back" to a plain file.

   2. These values live in their own file, never in settings.json. That file is
      small, rewritten on a 250 ms debounce, copied between machines, and pasted
      into bug reports. It is the last place a refresh token should be.
   =========================================================================== */
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

/* Resolved lazily so this module can be required by the plain-node tests,
   which have no Electron to hand. Tests call setBackend()/setFile(). */
let backend = null;         // { isEncryptionAvailable, encrypt, decrypt }
let resolved = false;
let FILE = null;

function electronBackend(){
  let safeStorage;
  try { ({ safeStorage } = require("electron")); }
  catch (err) { return null; }
  if (!safeStorage) return null;
  return {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    /* The async pair is non-blocking, supports key rotation, and copes with the
       key store being briefly unavailable; the sync pair may be deprecated.
       Older Electron only has the sync one, so fall back rather than break. */
    encrypt: async text => (safeStorage.encryptStringAsync
      ? await safeStorage.encryptStringAsync(text)
      : safeStorage.encryptString(text)),
    decrypt: async buf => (safeStorage.decryptStringAsync
      ? await safeStorage.decryptStringAsync(buf)
      : safeStorage.decryptString(buf))
  };
}

function getBackend(){
  if (!resolved) { backend = electronBackend(); resolved = true; }
  return backend;
}

function getFile(){
  if (FILE) return FILE;
  try {
    const { app } = require("electron");
    FILE = path.join(app.getPath("userData"), "secrets.json");
  } catch (err) {
    throw new Error("secrets: no storage location has been set.");
  }
  return FILE;
}

/* Test seams. Nothing in the app calls these. */
function setBackend(b){ backend = b; resolved = true; }
function setFile(p){ FILE = p; }

/* ------------------------------------------------------------------ state */
/* Values held only for this session, because the OS declined to encrypt them.
   Shaped like the on-disk file so every read path can look in both places. */
const memory = new Map();          // connectionId -> Map(key -> plaintext)
let warned = false;

function available(){
  const b = getBackend();
  if (!b) return false;
  try { return !!b.isEncryptionAvailable(); }
  catch (err) { return false; }
}

async function readFile(){
  try { return JSON.parse(await fsp.readFile(getFile(), "utf8")) || {}; }
  catch (err) { return {}; }
}

/* Same atomic dance as the vault: temp file, then rename. A crash mid-write
   must not leave a half-parsed store that loses every other connection's
   credentials along with the one being changed. */
async function writeFile(data){
  const file = getFile();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  /* 0600 before it is in place, not after: between rename and chmod the file
     would briefly be readable by every other account on the machine. */
  try { await fsp.chmod(tmp, 0o600); } catch (err) { /* not POSIX */ }
  await fsp.rename(tmp, file);
}

function remember(id, key, value){
  if (!memory.has(id)) memory.set(id, new Map());
  memory.get(id).set(key, value);
  if (!warned) {
    warned = true;
    console.warn("secrets: this system cannot encrypt stored credentials, so they are kept for this session only.");
  }
}

/* ------------------------------------------------------------------- api */

/* Store one credential. Returns how it was stored so the caller can tell the
   user the truth: "saved" or "for this session only". */
async function set(id, key, value){
  if (!id || !key) throw new Error("secrets: a connection id and a key are required.");
  if (value == null || value === "") return remove(id, key).then(() => ({ stored: "none" }));
  if (!available()) { remember(id, key, String(value)); return { stored: "memory" }; }
  const cipher = await getBackend().encrypt(String(value));
  const data = await readFile();
  if (!data[id]) data[id] = {};
  data[id][key] = Buffer.from(cipher).toString("base64");
  await writeFile(data);
  /* A value that has just been persisted must not also linger in memory,
     or a later revocation would leave the stale copy answering reads. */
  const held = memory.get(id);
  if (held) held.delete(key);
  return { stored: "disk" };
}

/* Read one credential. A value that cannot be decrypted — the keychain moved,
   the user migrated machines, the OS rotated a key — is discarded rather than
   returned as garbage, and the caller is expected to re-authorize. */
async function get(id, key){
  const held = memory.get(id);
  if (held && held.has(key)) return held.get(key);
  const data = await readFile();
  const cipher = data[id] && data[id][key];
  if (!cipher) return null;
  if (!available()) return null;
  try {
    return await getBackend().decrypt(Buffer.from(cipher, "base64"));
  } catch (err) {
    await remove(id, key);
    return null;
  }
}

/* Remove one credential, or every credential for a connection when key is
   omitted. Called whenever a connection is removed. */
async function remove(id, key){
  const held = memory.get(id);
  if (held) { if (key) held.delete(key); else memory.delete(id); }
  const data = await readFile();
  if (!data[id]) return true;
  if (key) {
    delete data[id][key];
    if (!Object.keys(data[id]).length) delete data[id];
  } else {
    delete data[id];
  }
  await writeFile(data);
  return true;
}

/* Which keys a connection has stored. Names only — never the values. Used by
   the UI to show "signed in" without ever handling a token. */
async function keys(id){
  const data = await readFile();
  const onDisk = Object.keys((data && data[id]) || {});
  const held = memory.get(id);
  const inMemory = held ? Array.from(held.keys()) : [];
  return Array.from(new Set(onDisk.concat(inMemory))).sort();
}

module.exports = { available, set, get, remove, keys, setBackend, setFile };
