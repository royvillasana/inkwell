"use strict";
/* Every filesystem touch the app makes goes through here, so path safety and
   atomic writes live in one place instead of being sprinkled over IPC handlers. */
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const icloud = require("./icloud");

const MD = /\.(md|markdown|mdown|mkd|txt)$/i;
const IMG = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
const SKIP_DIRS = new Set(["node_modules", ".git", ".obsidian", ".trash", "dist", "build", ".inkju", ".inkwell"]);

const isMarkdown = p => MD.test(p);
const isImage = p => IMG.test(p);

/* Guard against a renderer asking for something outside the open vault. */
function within(root, target){
  if (!root) return true;
  const a = path.resolve(root) + path.sep;
  const b = path.resolve(target);
  return b.startsWith(a) || b === path.resolve(root);
}

async function readText(file){
  const stat = await fsp.stat(file);
  if (stat.size > 40 * 1024 * 1024) throw new Error("That file is larger than 40 MB.");
  return { text: await fsp.readFile(file, "utf8"), mtime: stat.mtimeMs, size: stat.size };
}

/* write to a sibling temp file, then rename: a crash can never truncate the note */
async function writeText(file, text){
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), "." + path.basename(file) + ".tmp");
  await fsp.writeFile(tmp, text, "utf8");
  await fsp.rename(tmp, file);
  const stat = await fsp.stat(file);
  return { mtime: stat.mtimeMs, size: stat.size };
}

async function uniquePath(dir, base, ext){
  let n = 0;
  for (;;) {
    const name = base + (n ? " " + n : "") + ext;
    const full = path.join(dir, name);
    try { await fsp.access(full); n++; }
    catch (err) { return full; }
  }
}

/* Recursive listing of a vault, folders first, capped so a huge tree cannot hang the UI. */
async function listTree(root, depth = 0, budget = { n: 0 }){
  const out = [];
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); }
  catch (err) { return out; }

  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });

  /* A note that iCloud has evicted is not present under its own name — macOS
     leaves a hidden .Notes.md.icloud placeholder in its place. Skipping every
     dotfile, as we do below, would therefore hide the note completely: the
     sidebar would simply lose entries as the disk filled up. Collect the
     placeholders first so those notes can be listed, marked as not downloaded.

     Nothing here reads a file, and nothing here asks iCloud for one. A tree
     walk over a mostly-evicted vault must not start a download; that is what
     turns opening a vault into a twenty-gigabyte surprise. */
  const evicted = new Map();
  for (const e of entries) {
    if (e.isDirectory()) continue;
    const real = icloud.nameFromStub(e.name);
    if (real && isMarkdown(real)) evicted.set(real, path.join(root, real));
  }

  const seen = new Set();
  for (const e of entries) {
    if (budget.n > 4000 || depth > 8) break;
    if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      const kids = await listTree(full, depth + 1, budget);
      if (kids.length) out.push({ kind: "dir", name: e.name, path: full, children: kids });
    } else if (isMarkdown(e.name)) {
      budget.n++;
      seen.add(e.name);
      out.push({ kind: "file", name: e.name, path: full });
    }
  }

  /* Notes that exist only as a placeholder. A stale placeholder beside a real
     file is ignored — the real file has already been listed. */
  for (const [name, full] of evicted) {
    if (seen.has(name) || budget.n > 4000) continue;
    budget.n++;
    out.push({ kind: "file", name, path: full, downloaded: false });
  }
  if (evicted.size) {
    out.sort((a, b) => {
      if ((a.kind === "dir") !== (b.kind === "dir")) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
  }
  return out;
}

function flatten(nodes, acc = []){
  for (const n of nodes) {
    if (n.kind === "file") acc.push(n);
    else flatten(n.children, acc);
  }
  return acc;
}

async function createFile(dir, name, contents){
  const ext = path.extname(name) || ".md";
  const base = path.basename(name, path.extname(name));
  const full = await uniquePath(dir, base, ext);
  await writeText(full, contents == null ? "" : contents);
  return { path: full, name: path.basename(full) };
}

async function renameFile(file, nextName){
  const dir = path.dirname(file);
  const ext = path.extname(nextName) || path.extname(file) || ".md";
  const base = path.basename(nextName, path.extname(nextName));
  let target = path.join(dir, base + ext);
  if (path.resolve(target) !== path.resolve(file)) {
    try { await fsp.access(target); target = await uniquePath(dir, base, ext); }
    catch (err) { /* free */ }
    await fsp.rename(file, target);
  }
  return { path: target, name: path.basename(target) };
}

/* Save a pasted or dropped image next to the note and hand back a relative link. */
async function saveImage(noteFile, folderName, data, ext){
  const dir = noteFile ? path.dirname(noteFile) : null;
  if (!dir) throw new Error("Save the document first so images have somewhere to live.");
  const assets = path.join(dir, folderName || "assets");
  await fsp.mkdir(assets, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const full = await uniquePath(assets, "image-" + stamp, ext || ".png");
  await fsp.writeFile(full, Buffer.from(data));
  return {
    path: full,
    relative: path.posix.join(folderName || "assets", path.basename(full))
  };
}

/* On-disk snapshots, kept beside the vault in .inkju/history. Vaults written
   by earlier versions used .inkju, and those snapshots are still someone's
   history, so they are read as well as the new location — renaming the app must
   not make a vault's past disappear. */
const LEGACY_DIR = ".inkwell";
function historyDir(root){ return path.join(root, ".inkju", "history"); }
function legacyHistoryDir(root){ return path.join(root, LEGACY_DIR, "history"); }

async function writeSnapshot(root, noteName, text){
  const dir = historyDir(root);
  await fsp.mkdir(dir, { recursive: true });
  const safe = noteName.replace(/[^\w.-]+/g, "_");
  const file = path.join(dir, safe + "." + Date.now() + ".snapshot");
  await fsp.writeFile(file, text, "utf8");
  const all = (await fsp.readdir(dir)).filter(f => f.startsWith(safe + ".")).sort();
  while (all.length > 60) {
    await fsp.unlink(path.join(dir, all.shift())).catch(() => {});
  }
  return file;
}

async function listSnapshots(root, noteName){
  const safe = noteName ? noteName.replace(/[^\w.-]+/g, "_") : null;
  const out = [];
  for (const dir of [historyDir(root), legacyHistoryDir(root)]) {
    let names;
    try { names = await fsp.readdir(dir); } catch (err) { continue; }
    for (const f of names) {
      if (!f.endsWith(".snapshot")) continue;
      if (safe && !f.startsWith(safe + ".")) continue;
      const parts = f.split(".");
      out.push({ file: path.join(dir, f), at: Number(parts[parts.length - 2]) || 0, name: parts.slice(0, -2).join(".") });
    }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, 80);
}

module.exports = {
  isMarkdown, isImage, within, readText, writeText, listTree, flatten,
  createFile, renameFile, saveImage, uniquePath,
  writeSnapshot, listSnapshots, historyDir, legacyHistoryDir, SKIP_DIRS
};
