"use strict";
/* Tiny JSON settings store in the OS application-data folder.
   Writes are atomic and debounced so a crash cannot leave a half file. */
const { app } = require("electron");
const fs = require("fs");
const path = require("path");

const FILE = path.join(app.getPath("userData"), "settings.json");

const DEFAULTS = {
  theme: "paper",
  followSystemTheme: true,
  font: "serif",
  fontSize: 17,
  lineHeight: 1.72,
  measure: 46,
  sidebar: true,
  focus: false,
  typewriter: false,
  wide: false,
  lineNumbers: false,
  autopair: true,
  spellcheck: true,
  goal: 0,
  autosave: true,
  checkUpdates: true,
  autosaveDelay: 1200,
  imageFolder: "assets",
  recent: [],
  vault: null,
  session: null,
  windowBounds: null,
  /* Connections to outside sources. Records only: labels, transport config and
     the tool allowlist. Credentials live in secrets.js, never here — this file
     is small, rewritten constantly, and the one users paste into bug reports. */
  connections: []
};

let cache = null;
let timer = null;

/* Object.assign copies the array defaults by reference, so a caller that
   pushed onto settings.recent or settings.connections would be editing
   DEFAULTS itself and every later load would inherit it. Clone them. */
function fresh(){
  const base = Object.assign({}, DEFAULTS);
  base.recent = [];
  base.connections = [];
  return base;
}

function load(){
  if (cache) return cache;
  try {
    cache = Object.assign(fresh(), JSON.parse(fs.readFileSync(FILE, "utf8")));
  } catch (err) {
    cache = fresh();
  }
  if (!Array.isArray(cache.connections)) cache.connections = [];
  return cache;
}

function flush(){
  timer = null;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.error("settings write failed:", err.message);
  }
}

function save(patch){
  load();
  Object.assign(cache, patch || {});
  clearTimeout(timer);
  timer = setTimeout(flush, 250);
  return cache;
}

function get(){ return load(); }

function addRecent(file){
  const s = load();
  const list = (s.recent || []).filter(r => r.path !== file.path);
  list.unshift({ path: file.path, name: file.name, at: Date.now() });
  return save({ recent: list.slice(0, 15) }).recent;
}

module.exports = { get, save, flush, addRecent, DEFAULTS, FILE };
