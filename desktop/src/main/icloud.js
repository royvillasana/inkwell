"use strict";
/* ===========================================================================
   iCloud Drive.

   Not MCP, and the interface does not pretend otherwise. Apple publishes no
   third-party API for a user's iCloud Drive documents — CloudKit reaches a
   developer's own container, never the user's Documents — so the only
   supported way in is the local mirror macOS keeps at
   ~/Library/Mobile Documents/com~apple~CloudDocs. Inkju opens a vault inside
   it and treats it as what it is: a folder that syncs.

   The whole of the difficulty is that this folder lies to a naive reader. A
   file listed in it may have no bytes on this machine; reading one blocks
   while macOS fetches it; an evicted file is not even there under its own
   name. Getting that wrong does not produce a bug report, it produces a vault
   that hangs on open and a laptop that quietly downloads twenty gigabytes.
   =========================================================================== */
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const CONTAINER = "com~apple~CloudDocs";
const STUB = /^\.(.+)\.icloud$/;

/* How long to wait for macOS to fetch a file the user asked to open. Long
   enough for a note over a poor connection, short enough that the interface
   can say something rather than appearing to have died. */
const MATERIALIZE_TIMEOUT_MS = 60000;
const POLL_MS = 250;

/* Injected in tests: a fake root, and a downloader that does not need iCloud. */
let rootOverride = null;
let downloader = null;
function setRoot(p){ rootOverride = p; }
function setDownloader(fn){ downloader = fn; }

/* ------------------------------------------------------------- detection */

/* The container, or null. Absent on Windows and Linux, and absent on a Mac
   where the user has never turned iCloud Drive on — in both cases the entry
   simply does not appear, rather than appearing and failing. */
function root(){
  if (rootOverride) return rootOverride;
  if (process.platform !== "darwin") return null;
  const dir = path.join(os.homedir(), "Library", "Mobile Documents", CONTAINER);
  try { return fs.statSync(dir).isDirectory() ? dir : null; }
  catch (err) { return null; }
}

const available = () => !!root();

/* Is this path inside iCloud Drive? Used to decide whether the extra care
   below is needed at all — a vault on the local disk should pay none of it. */
function isInside(target){
  const base = root();
  if (!base || !target) return false;
  const a = path.resolve(base) + path.sep;
  const b = path.resolve(target);
  return b === path.resolve(base) || b.startsWith(a);
}

/* --------------------------------------------------------------- stubs */

/* An evicted file is not present under its own name. macOS replaces it with a
   hidden placeholder: Notes.md becomes .Notes.md.icloud. */
const stubPath = file => path.join(path.dirname(file), "." + path.basename(file) + ".icloud");
const isStubName = name => STUB.test(name);
const nameFromStub = name => { const m = STUB.exec(name); return m ? m[1] : null; };

/* Is this file's content actually on this machine?

   Deliberately synchronous and cheap: two stat calls, no read. Called for
   every entry in a tree walk, so anything that touched the file itself would
   be the very download this exists to avoid. */
function statusOf(file){
  try {
    fs.statSync(file);
    return "present";
  } catch (err) {
    /* not under its own name — an .icloud placeholder means it is in iCloud
       but not here; anything else means it is simply gone */
    try { fs.statSync(stubPath(file)); return "evicted"; }
    catch (e) { return "missing"; }
  }
}

const isEvicted = file => statusOf(file) === "evicted";

/* ---------------------------------------------------------------- trees */

/* Collapse a directory listing the way the sidebar should show it: one entry
   per note, evicted ones marked rather than hidden, and no .icloud
   placeholders shown as notes in their own right.

   Takes names rather than reading the directory itself so it can be dropped
   into whatever listing the caller already has. */
function collapse(names){
  const out = new Map();
  for (const name of names) {
    const real = nameFromStub(name);
    if (real) {
      /* a placeholder only announces a file that is not here; if the real one
         also appeared, that wins */
      if (!out.has(real)) out.set(real, { name: real, downloaded: false });
    } else {
      out.set(name, { name, downloaded: true });
    }
  }
  return Array.from(out.values());
}

/* ------------------------------------------------------------ conflicts */

/* iCloud does not merge. When two devices edit the same note it keeps both,
   naming the loser after the device that made it. Those are surfaced as
   conflicts rather than shown as ordinary notes, and nothing here resolves,
   merges or deletes either side — that is the user's call and only theirs. */
/* The marker is a bracketed group carrying the words "conflicted copy" —
   "Notes (Roy's MacBook Pro conflicted copy 2026-08-22).md". The extension is
   taken off first: matching it inside the same expression means the device
   name, which is free text and often contains its own punctuation, has to be
   matched around, and it will not be. */
const CONFLICT = new RegExp("^(.*?)\\s*[\\(\\[][^()\\[\\]]*conflicted?\\s+copy[^()\\[\\]]*[\\)\\]]\\s*$", "i");

function conflictInfo(name){
  const ext = path.extname(String(name || ""));
  const stem = ext ? String(name).slice(0, -ext.length) : String(name || "");
  const m = CONFLICT.exec(stem);
  if (!m) return null;
  const base = m[1].trim();
  if (!base) return null;
  return { of: base + ext, name };
}

/* Group a listing into notes and the conflicting copies that belong to them. */
function findConflicts(names){
  const map = new Map();
  for (const name of names) {
    const info = conflictInfo(name);
    if (!info) continue;
    if (!map.has(info.of)) map.set(info.of, []);
    map.get(info.of).push(name);
  }
  return map;
}

/* -------------------------------------------------------- materializing */

function runDownload(file){
  if (downloader) return downloader(file);
  return new Promise((resolve, reject) => {
    /* brctl is the supported way to ask for a file. Arguments are passed as a
       list, never through a shell, so a note called "; rm -rf ~" is a note. */
    execFile("/usr/bin/brctl", ["download", file], { timeout: 15000 }, err => {
      /* A non-zero exit is not fatal on its own: brctl is terse, and the poll
         below is what actually decides whether the bytes arrived. */
      resolve(!err);
    });
  });
}

/* Fetch an evicted file, for an explicit open and never for anything else.

   Returns when the file is really there. A caller that shows a spinner should
   show it around this call; a caller walking a tree should not be here at all.
*/
async function materialize(file, opts){
  const o = opts || {};
  if (statusOf(file) === "present") return { downloaded: true, waited: 0 };
  if (statusOf(file) === "missing") throw new Error("That file is not in this folder any more.");

  await runDownload(file);

  const deadline = Date.now() + (o.timeout || MATERIALIZE_TIMEOUT_MS);
  let waited = 0;
  for (;;) {
    if (statusOf(file) === "present") return { downloaded: true, waited };
    if (Date.now() >= deadline) {
      throw new Error("iCloud has not finished downloading “" + path.basename(file) +
        "”. Check your connection and try again.");
    }
    await new Promise(r => setTimeout(r, POLL_MS));
    waited += POLL_MS;
  }
}

/* Read a file that may not be here yet.

   This is the only path allowed to trigger a download, and it is reached only
   from an explicit open — never from the tree walk, never from the indexer.
   `onWaiting` fires when a download is actually needed, so the interface can
   say "downloading from iCloud" instead of appearing to have frozen. */
async function readWithMaterialize(file, read, onWaiting){
  if (statusOf(file) !== "evicted") return read(file);
  if (onWaiting) { try { onWaiting(path.basename(file)); } catch (err) { /* cosmetic */ } }
  await materialize(file);
  return read(file);
}

/* An open note can be evicted underneath the app. Saving has to bring it back
   first, or the write lands beside a placeholder and the next sync has two
   ideas about what the note is. */
async function prepareForWrite(file){
  if (statusOf(file) === "evicted") await materialize(file);
  return true;
}

module.exports = {
  root, available, isInside,
  stubPath, isStubName, nameFromStub,
  statusOf, isEvicted,
  collapse, conflictInfo, findConflicts,
  materialize, readWithMaterialize, prepareForWrite,
  setRoot, setDownloader,
  CONTAINER, MATERIALIZE_TIMEOUT_MS
};
