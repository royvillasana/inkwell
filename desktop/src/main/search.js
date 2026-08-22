"use strict";
/* Vault-wide full text search, wiki-link graph and tag index.
   The index is a plain in-memory map rebuilt lazily; for the note counts a
   personal vault reaches (thousands of files) this is faster than it sounds
   and avoids shipping a database. */
const fsp = require("fs").promises;
const path = require("path");
const files = require("./files");
const icloud = require("./icloud");

let root = null;
let docs = new Map();          // absolute path -> { name, base, text, mtime }
let building = null;

const baseName = p => path.basename(p, path.extname(p));

async function setRoot(dir){
  root = dir;
  docs = new Map();
  if (dir) await build();
  return stats();
}

async function build(){
  if (building) return building;
  building = (async () => {
    const tree = await files.listTree(root);
    const list = files.flatten(tree);
    docs = new Map();
    for (const f of list) {
      /* A note iCloud has evicted has no bytes on this machine, and reading it
         would make macOS fetch them. Indexing a mostly-evicted vault would
         then download the entire thing — in the background, unasked, while the
         user was only opening a folder. It is left out of the index instead:
         it is still listed in the sidebar, and opening it downloads it. */
      if (f.downloaded === false || icloud.isEvicted(f.path)) continue;
      try {
        const stat = await fsp.stat(f.path);
        const text = await fsp.readFile(f.path, "utf8");
        docs.set(f.path, { name: f.name, base: baseName(f.path), text, mtime: stat.mtimeMs });
      } catch (err) { /* unreadable file: skip it rather than fail the whole index */ }
    }
    building = null;
    return stats();
  })();
  return building;
}

async function touch(file){
  if (!root || !file.startsWith(root)) return;
  /* same reason as build(): re-indexing must never be what pulls a file down */
  if (icloud.isEvicted(file)) { docs.delete(file); return; }
  try {
    const stat = await fsp.stat(file);
    docs.set(file, { name: path.basename(file), base: baseName(file), text: await fsp.readFile(file, "utf8"), mtime: stat.mtimeMs });
  } catch (err) { docs.delete(file); }
}

function stats(){
  let words = 0;
  for (const d of docs.values()) words += (d.text.match(/\S+/g) || []).length;
  return { files: docs.size, words, root };
}

function buildQuery(q, opts){
  const body = opts.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wrapped = opts.word ? "\\b(?:" + body + ")\\b" : body;
  return new RegExp(wrapped, opts.caseSensitive ? "g" : "gi");
}

/* Returns one entry per file with up to 5 line-level hits and their context. */
function search(q, opts = {}){
  if (!q || !q.trim()) return { results: [], total: 0 };
  let re;
  try { re = buildQuery(q, opts); }
  catch (err) { return { results: [], total: 0, error: "That is not a valid regular expression." }; }

  const results = [];
  let total = 0;
  for (const [file, doc] of docs) {
    const lines = doc.text.split("\n");
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      const m = re.exec(lines[i]);
      if (!m) continue;
      total++;
      if (hits.length < 5) {
        hits.push({
          line: i + 1,
          before: lines[i].slice(Math.max(0, m.index - 32), m.index),
          match: m[0],
          after: lines[i].slice(m.index + m[0].length, m.index + m[0].length + 48)
        });
      }
    }
    if (hits.length) results.push({ path: file, name: doc.name, hits, count: hits.length });
  }
  results.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { results: results.slice(0, 120), total };
}

/* Files whose [[wiki links]] point at the given note. */
function backlinks(noteName){
  const want = baseName(noteName).toLowerCase();
  const out = [];
  for (const [file, doc] of docs) {
    if (doc.base.toLowerCase() === want) continue;
    const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    let m;
    const contexts = [];
    while ((m = re.exec(doc.text))) {
      if (m[1].trim().toLowerCase() !== want) continue;
      const start = Math.max(0, m.index - 60);
      contexts.push(doc.text.slice(start, m.index + m[0].length + 60).replace(/\s+/g, " ").trim());
      if (contexts.length >= 3) break;
    }
    if (contexts.length) out.push({ path: file, name: doc.name, contexts });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/* Wiki targets in this note that do not exist yet. */
function unresolved(text){
  const known = new Set(Array.from(docs.values()).map(d => d.base.toLowerCase()));
  const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  const missing = new Set();
  let m;
  while ((m = re.exec(text))) {
    const t = m[1].trim();
    if (!known.has(t.toLowerCase())) missing.add(t);
  }
  return Array.from(missing);
}

function resolveLink(name){
  const want = baseName(name).toLowerCase();
  for (const [file, doc] of docs) {
    if (doc.base.toLowerCase() === want) return { path: file, name: doc.name };
  }
  return null;
}

function tags(){
  const counts = new Map();
  for (const doc of docs.values()) {
    const re = /(^|[\s(])#([A-Za-z][\w/-]{0,40})/g;
    let m;
    while ((m = re.exec(doc.text))) counts.set(m[2], (counts.get(m[2]) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([tag, n]) => ({ tag, n }))
    .sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag));
}

function byTag(tag){
  const re = new RegExp("(^|[\\s(])#" + tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");
  const out = [];
  for (const [file, doc] of docs) if (re.test(doc.text)) out.push({ path: file, name: doc.name });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/* Quick-open: fuzzy subsequence match on the file name, best matches first. */
function quickOpen(q){
  const list = Array.from(docs.entries()).map(([file, d]) => ({ path: file, name: d.name, base: d.base }));
  if (!q) return list.slice(0, 40);
  const needle = q.toLowerCase();
  const scored = [];
  for (const item of list) {
    const hay = item.base.toLowerCase();
    let score = -1;
    if (hay === needle) score = 1000;
    else if (hay.startsWith(needle)) score = 500 - hay.length;
    else if (hay.includes(needle)) score = 300 - hay.indexOf(needle);
    else {
      let i = 0, gaps = 0;
      for (const ch of hay) {
        if (ch === needle[i]) i++;
        else if (i > 0) gaps++;
        if (i === needle.length) break;
      }
      if (i === needle.length) score = 120 - gaps;
    }
    if (score > -1) scored.push({ item, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 40).map(s => s.item);
}

module.exports = { setRoot, build, touch, search, backlinks, unresolved, resolveLink, tags, byTag, quickOpen, stats };
