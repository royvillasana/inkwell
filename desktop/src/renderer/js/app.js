/* ===========================================================================
   Application shell: documents and tabs, disk I/O, views, commands, boot.
   Everything that touches the filesystem goes through window.inkwell.
   =========================================================================== */
import {
  renderDoc, renderBlock, esc, mdOptions, setHeadingSource, blockType, splitBlocks
} from "./markdown.js";
import {
  $, $$, state, prefs, mount, loadText, serialize, renderAll, repaint, activate, commit,
  blockIndex, blockEls, headings, on, emit, mkBlock, wrapSel, linkSel, setHeading,
  insertBlockAfter, activeTextarea, setImageHandler, insertAt,
  setHtmlPasteHandler, setTypingFilter
} from "./editor.js";
import { mountDialogs, dialog, say, ask, askText, closeModal } from "./dialogs.js";
import { mountAids, positionTableTools, drawGoal, tableOp, closeSlash } from "./aids.js";
import * as V from "./vault.js";
import * as Rich from "./rich.js";
import * as Convert from "./convert.js";
import * as Rich9 from "./rich-editor.js";

const api = window.inkwell;
const IS_MAC = api.platform === "darwin";

/* ---------------------------------------------------------------- helpers */
export function toast(msg){
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove("on"), 1900);
}
const fmtTime = t => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/* The live document text, wherever the caret currently lives. Rich text mode
   keeps the document inside TipTap, so serialize() alone is not enough. */
function docText(){
  if (prefs.rich && Rich9.isReady()) {
    const md = Rich9.getMarkdown();
    if (md != null) return md;
  }
  if (prefs.source) return $("#source").value;
  if (prefs.split) return $("#split-src").value;
  return serialize();
}

/* ------------------------------------------------------------------- tabs */
const docs = [];
let docSeq = 0, curDoc = null;

function snapshotDoc(commitFirst){
  if (curDoc == null) return;
  /* Session saves run on a timer while the user types: committing there would
     collapse the block under the caret. Block sources are already live because
     every keystroke writes through, so serialising without a commit is safe. */
  if (commitFirst !== false) commit();
  const d = docs.find(x => x.id === curDoc);
  if (!d) return;
  Object.assign(d, {
    text: docText(), name: state.name, path: state.path,
    mtime: state.mtime, dirty: state.dirty, scrollTop: $("#scroll").scrollTop
  });
}

function adopt(text, name, path, mtime){
  snapshotDoc();
  let d = path ? docs.find(x => x.path === path) : null;
  if (d) Object.assign(d, { text, name, mtime, dirty: false });
  else {
    d = { id: ++docSeq, text, name, path: path || null, mtime: mtime || 0, dirty: false, scrollTop: 0 };
    docs.push(d);
  }
  curDoc = d.id;
  loadText(d.text, d.name, { path: d.path, mtime: d.mtime });
  if (prefs.rich && Rich9.isReady()) Rich9.setMarkdown(d.text);
  renderTabs();
  V.setActivePath(d.path);
  return d;
}

function switchDoc(id){
  if (id === curDoc) return;
  snapshotDoc();
  const d = docs.find(x => x.id === id);
  if (!d) return;
  curDoc = id;
  loadText(d.text, d.name, { path: d.path, mtime: d.mtime });
  state.dirty = d.dirty;
  if (prefs.rich && Rich9.isReady()) Rich9.setMarkdown(d.text);
  renderTabs();
  V.setActivePath(d.path);
  updateStatus();
  requestAnimationFrame(() => { $("#scroll").scrollTop = d.scrollTop || 0; });
}

async function closeDoc(id){
  const i = docs.findIndex(x => x.id === id);
  if (i < 0) return;
  if (id === curDoc) snapshotDoc();
  const d = docs[i];
  if (d.dirty) {
    const r = await dialog({
      title: "Close " + d.name + "?",
      message: "It has changes that are not written to disk.",
      buttons: [
        { label: "Discard", value: "discard", danger: true },
        { spacer: true },
        { label: "Cancel", value: "cancel" },
        { label: "Save", value: "save", primary: true }
      ]
    });
    if (r === "cancel" || r == null) return;
    if (r === "save") { if (id === curDoc) { await saveDoc(false); if (state.dirty) return; } }
  }
  docs.splice(i, 1);
  if (!docs.length) { curDoc = null; renderTabs(); return newDoc(); }
  if (id === curDoc) { curDoc = null; switchDoc(docs[Math.max(0, i - 1)].id); }
  renderTabs();
  saveSession();
}

function renderTabs(){
  const bar = $("#tabs");
  document.body.classList.toggle("tabbed", docs.length > 1);
  bar.textContent = "";
  docs.forEach(d => {
    const t = document.createElement("button");
    t.className = "tab" + (d.id === curDoc ? " on" : "");
    t.title = d.path || d.name;
    if (d.id === curDoc ? state.dirty : d.dirty) t.appendChild(Object.assign(document.createElement("span"), { className: "dot" }));
    t.appendChild(Object.assign(document.createElement("span"), { className: "nm", textContent: d.name }));
    const x = document.createElement("span");
    x.className = "cl"; x.textContent = "×";
    x.onclick = e => { e.stopPropagation(); closeDoc(d.id); };
    t.appendChild(x);
    t.onclick = () => switchDoc(d.id);
    bar.appendChild(t);
  });
  const plus = document.createElement("button");
  plus.className = "newtab"; plus.textContent = "+"; plus.title = "New document (⌘N)";
  plus.onclick = () => newDoc();
  bar.appendChild(plus);
}

function cycleTab(dir){
  if (docs.length < 2) return;
  const i = docs.findIndex(x => x.id === curDoc);
  switchDoc(docs[(i + dir + docs.length) % docs.length].id);
}

/* ------------------------------------------------------------------- files */
function newDoc(){
  const d = adopt("# Untitled\n\n", "Untitled.md", null, 0);
  updateStatus();
  if (state.blocks[0]) activate(state.blocks[0].id);
  return d;
}

async function openPath(path, opts){
  const existing = docs.find(x => x.path === path);
  if (existing && existing.id !== curDoc) { switchDoc(existing.id); }
  else if (!existing) {
    try {
      const f = await api.file.read(path);
      adopt(f.text, f.name, f.path, f.mtime);
    } catch (err) { return say(err.message, "Could not open that file"); }
  }
  updateStatus();
  if (opts && opts.find) { openFind(true); $("#find-q").value = opts.find; runFind(); }
  if (opts && opts.line) jumpToLine(opts.line);
}

function jumpToLine(line){
  let n = 1;
  for (const b of state.blocks) {
    const len = b.src.split("\n").length;
    if (line < n + len) {
      const el = blockEls(b.id);
      if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
      activate(b.id, 0);
      return;
    }
    n += len + 1;
  }
}

async function openFileDialog(){
  commit();
  const list = await api.file.openDialog();
  if (!list || !list.length) return;
  list.forEach(f => adopt(f.text, f.name, f.path, f.mtime));
  updateStatus();
  toast("Opened " + list[list.length - 1].name);
}

async function saveDoc(forceDialog){
  const text = docText();        // no commit: keeps the caret where the user left it
  try {
    if (!forceDialog && state.path) {
      const res = await api.file.write(state.path, text);
      state.mtime = res.mtime;
    } else {
      const res = await api.file.saveAs(state.name, text);
      if (!res) return false;
      state.path = res.path; state.name = res.name; state.mtime = res.mtime;
    }
  } catch (err) { say(err.message, "Save failed"); return false; }

  state.dirty = false;
  const d = docs.find(x => x.id === curDoc);
  if (d) Object.assign(d, { path: state.path, name: state.name, mtime: state.mtime, dirty: false });
  api.history.save(state.name, text).catch(() => {});
  updateStatus();
  renderTabs();
  V.refreshVault();
  V.setActivePath(state.path);
  $("#st-saved").textContent = "saved " + fmtTime(Date.now());
  saveSession();
  return true;
}

/* autosave: quiet, debounced, only for documents that already live on disk */
let autosaveTimer = null;
function scheduleAutosave(){
  clearTimeout(autosaveTimer);
  if (!prefs.autosave || !state.path || !state.dirty) return;
  autosaveTimer = setTimeout(async () => {
    if (!state.dirty || !state.path) return;
    const text = docText();
    try {
      const res = await api.file.write(state.path, text);
      state.mtime = res.mtime;
      state.dirty = false;
      const d = docs.find(x => x.id === curDoc);
      if (d) { d.dirty = false; d.mtime = res.mtime; }
      $("#st-saved").textContent = "autosaved " + fmtTime(Date.now());
      renderTabs();
      markTitle();
    } catch (err) {
      /* say what went wrong rather than a bare "failed" — a silent lie here
         would have people believing their work is not being written */
      console.error("autosave:", err);
      $("#st-saved").textContent = "autosave failed: " + (err.message || "unknown");
    }
  }, Math.max(400, prefs.autosaveDelay));
}

/* a file changed underneath us */
async function checkExternal(changedPath){
  if (!state.path) return;
  if (changedPath && changedPath !== state.path) return;
  const st = await api.file.stat(state.path);
  if (!st || !state.mtime || st.mtime <= state.mtime) return;

  if (!state.dirty) {
    const f = await api.file.read(state.path);
    const at = $("#scroll").scrollTop;
    loadText(f.text, f.name, { path: f.path, mtime: f.mtime });
    $("#scroll").scrollTop = at;
    toast(f.name + " reloaded from disk");
    return;
  }
  const r = await dialog({
    title: state.name + " changed on disk",
    message: "You have unsaved edits here and the file was modified by something else. Which version should win?",
    buttons: [
      { label: "Keep mine", value: "mine" },
      { spacer: true },
      { label: "Load from disk", value: "theirs", danger: true }
    ]
  });
  if (r === "theirs") {
    const f = await api.file.read(state.path);
    loadText(f.text, f.name, { path: f.path, mtime: f.mtime });
  } else {
    state.mtime = st.mtime;                       // our next save wins
  }
}

/* ------------------------------------------------------------- status bar */
let statusTimer = null;
function updateStatus(){
  const text = docText();
  const words = (text.replace(/[#>*_`~\-\[\]()!|]/g, " ").match(/\S+/g) || []).length;
  $("#st-words").textContent = words.toLocaleString();
  $("#st-chars").textContent = text.length.toLocaleString();
  $("#st-lines").textContent = text.split("\n").length.toLocaleString();
  $("#st-read").textContent = Math.max(1, Math.round(words / 220));
  $("#docname").innerHTML = "<b>" + esc(state.name) + "</b>" + (state.dirty ? ' <span class="dirty">•</span>' : "");
  drawGoal(words);
  buildOutline();
  markTitle();

  const d = docs.find(x => x.id === curDoc);
  if (d && d.dirty !== state.dirty) { d.dirty = state.dirty; renderTabs(); }

  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    V.drawTags(state.name, serialize());
    saveSession();
  }, 400);
}

function markTitle(){
  const t = state.name + (state.dirty ? " — edited" : "");
  api.win.title(t, state.path || undefined);
  api.win.edited(state.dirty);
}

function buildOutline(){
  const toc = $("#toc");
  const list = headings();
  if (!list.length) {
    toc.innerHTML = '<div class="side-empty">No headings yet.<br>Start a line with <code>#</code>.</div>';
    return;
  }
  toc.textContent = "";
  list.forEach(h => {
    const b = document.createElement("button");
    b.className = "toc-item";
    b.dataset.lvl = h.lvl;
    b.textContent = h.text;
    b.title = h.text;
    b.onclick = () => {
      const el = blockEls(h.id);
      if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
      activate(h.id);
    };
    toc.appendChild(b);
  });
}

/* ---------------------------------------------------------- find in doc */
let matches = [], mIdx = -1;
function findRegex(){
  const q = $("#find-q").value;
  $("#find-q").classList.remove("bad");
  if (!q) return null;
  let body = $("#find-re").checked ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if ($("#find-word").checked) body = "\\b(?:" + body + ")\\b";
  try { return new RegExp(body, $("#find-case").checked ? "g" : "gi"); }
  catch (err) { $("#find-q").classList.add("bad"); return null; }
}
function runFind(){
  matches = []; mIdx = -1;
  const re = findRegex();
  if (re) state.blocks.forEach((b, i) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(b.src))) {
      matches.push({ i, at: m.index, len: m[0].length });
      if (!m[0].length) re.lastIndex++;
      if (matches.length > 5000) break;
    }
  });
  $("#find-count").textContent = (matches.length ? 1 : 0) + "/" + matches.length;
  if (matches.length) gotoMatch(0);
}
function gotoMatch(k){
  if (!matches.length) return;
  mIdx = (k + matches.length) % matches.length;
  const m = matches[mIdx];
  const b = state.blocks[m.i];
  if (!b) return;
  $("#find-count").textContent = (mIdx + 1) + "/" + matches.length;
  activate(b.id, m.at, m.at + m.len);
  const el = blockEls(b.id);
  if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
}
function replaceOne(){
  if (mIdx < 0 || !matches[mIdx]) return;
  const m = matches[mIdx], r = $("#find-r").value;
  const b = state.blocks[m.i];
  if (!b) return;
  b.src = b.src.slice(0, m.at) + r + b.src.slice(m.at + m.len);
  state.activeId = null;
  repaint(b.id);
  emit("change", true);
  runFind();
}
function replaceAll(){
  const re = findRegex();
  if (!re) return;
  commit();
  const r = $("#find-r").value;
  let n = 0;
  state.blocks.forEach(b => { b.src = b.src.replace(re, () => { n++; return r; }); });
  renderAll();
  emit("change", true);
  runFind();
  toast(n ? "Replaced " + n + " occurrence" + (n === 1 ? "" : "s") : "Nothing to replace");
}
function openFind(onFlag){
  $("#find").classList.toggle("on", onFlag);
  $("#btn-find").classList.toggle("on", onFlag);
  if (onFlag) { $("#find-q").focus(); $("#find-q").select(); }
  else { matches = []; mIdx = -1; }
}

/* ------------------------------------------------------------------ views */
export function setPane(name){
  $$(".side-tabs button").forEach(b => b.classList.toggle("on", b.dataset.pane === name));
  $$(".side-pane").forEach(p => p.classList.toggle("on", p.id === "pane-" + name));
  if (name === "search") $("#vs-q").focus();
  if (name === "tags") V.drawTags(state.name, serialize());
}
const darkTheme = t => t === "night" || t === "slate";
function setTheme(t){
  prefs.theme = t;
  document.documentElement.dataset.theme = t;
  Rich.setDiagramTheme(darkTheme(t) ? "dark" : "default");
  $$(".theme-dot").forEach(d => d.classList.toggle("on", d.dataset.theme === t));
  savePrefs();
}
function toggleSidebar(v){
  prefs.sidebar = v == null ? !prefs.sidebar : v;
  document.body.classList.toggle("no-sidebar", !prefs.sidebar);
  $("#btn-sidebar").classList.toggle("on", prefs.sidebar);
  savePrefs();
}
function toggleFocus(){
  prefs.focus = !prefs.focus;
  document.body.classList.toggle("focus", prefs.focus);
  $("#btn-focus").classList.toggle("on", prefs.focus);
  savePrefs();
}
function toggleTypewriter(){
  prefs.typewriter = !prefs.typewriter;
  document.body.classList.toggle("typewriter", prefs.typewriter);
  $("#btn-type").style.color = prefs.typewriter ? "var(--accent)" : "";
  savePrefs();
}
function toggleWide(){
  prefs.wide = !prefs.wide;
  document.body.classList.toggle("wide", prefs.wide);
  $("#btn-wide").style.color = prefs.wide ? "var(--accent)" : "";
  savePrefs();
}
function toggleSource(){
  prefs.source = !prefs.source;
  if (prefs.source && prefs.split) toggleSplit();
  const src = $("#source");
  if (prefs.source) {
    commit();
    src.value = serialize();
    document.body.classList.add("mode-source");
    $("#btn-src").classList.add("on");
    src.focus();
  } else {
    document.body.classList.remove("mode-source");
    $("#btn-src").classList.remove("on");
    loadText(src.value, state.name, { path: state.path, mtime: state.mtime });
    state.dirty = true;
    updateStatus();
  }
}
async function toggleRich(){
  prefs.rich = !prefs.rich;
  if (prefs.rich) {
    if (prefs.source) toggleSource();
    if (prefs.split) toggleSplit();
    commit();
    const md = serialize();
    document.body.classList.add("mode-rich");
    $("#btn-rich").classList.add("on");
    try {
      await Rich9.open($("#richwrap"), md, {
        spellcheck: prefs.spellcheck,
        onChange: () => { state.dirty = true; updateStatus(); scheduleAutosave(); }
      });
      Rich9.setLinkAsker((prev, opts) => askText(
        (opts && opts.title === "Image") ? "Where is the image?" : "Where should this link point?",
        prev,
        Object.assign({ title: "Link", label: "URL", ok: "Apply", placeholder: "https://" }, opts || {})));
    } catch (err) {
      prefs.rich = false;
      document.body.classList.remove("mode-rich");
      $("#btn-rich").classList.remove("on");
      say("The rich text editor could not start: " + err.message, "Rich text unavailable");
      return;
    }
  } else {
    const md = Rich9.getMarkdown();
    Rich9.close();
    document.body.classList.remove("mode-rich");
    $("#btn-rich").classList.remove("on");
    if (md != null) {
      loadText(md, state.name, { path: state.path, mtime: state.mtime });
      state.dirty = true;
    }
  }
  updateStatus();
  savePrefs();
}

let splitTimer = null;
function toggleSplit(){
  prefs.split = !prefs.split;
  if (prefs.split && prefs.source) toggleSource();
  document.body.classList.toggle("mode-split", prefs.split);
  $("#btn-split").classList.toggle("on", prefs.split);
  if (prefs.split) {
    commit();
    $("#split-src").value = serialize();
    paintSplit();
    $("#split-src").focus();
  } else {
    loadText($("#split-src").value, state.name, { path: state.path, mtime: state.mtime });
    state.dirty = true;
    updateStatus();
  }
}
function paintSplit(){
  $("#split-prev").innerHTML = '<div class="rendered">' + renderDoc($("#split-src").value) + "</div>";
  Rich.hydrate($("#split-prev"));
}

/* ---- presentation -------------------------------------------------------- */
let slides = [], slideAt = 0;
function startPresentation(){
  commit();
  const text = serialize();
  slides = text.split(/\n\s*-{3,}\s*\n/).map(s => s.trim()).filter(Boolean);
  if (slides.length < 2) slides = text.split(/\n(?=#\s)/).map(s => s.trim()).filter(Boolean);
  if (!slides.length) return say("There is nothing to present yet.", "Empty document");
  slideAt = 0;
  $("#present").classList.add("on");
  drawSlide();
  document.addEventListener("keydown", presentKeys, true);
}
function endPresentation(){
  $("#present").classList.remove("on");
  document.removeEventListener("keydown", presentKeys, true);
}
function drawSlide(){
  $("#present").innerHTML =
    '<div class="prog" style="width:' + (((slideAt + 1) / slides.length) * 100) + '%"></div>' +
    '<div class="slide"><div class="rendered">' + renderDoc(slides[slideAt]) + "</div></div>" +
    '<div class="bar"><span>' + (slideAt + 1) + " / " + slides.length + "</span>" +
    '<span class="grow"></span><span>← → to move · Esc to leave</span>' +
    '<button id="pres-prev">Prev</button><button id="pres-next">Next</button><button id="pres-exit">Exit</button></div>';
  Rich.hydrate($("#present"));
  $("#pres-prev").onclick = () => moveSlide(-1);
  $("#pres-next").onclick = () => moveSlide(1);
  $("#pres-exit").onclick = endPresentation;
}
function moveSlide(d){
  slideAt = Math.max(0, Math.min(slides.length - 1, slideAt + d));
  drawSlide();
}
function presentKeys(e){
  if (e.key === "Escape") { e.preventDefault(); endPresentation(); }
  else if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(e.key)) { e.preventDefault(); moveSlide(1); }
  else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(e.key)) { e.preventDefault(); moveSlide(-1); }
  else if (e.key === "Home") { slideAt = 0; drawSlide(); }
  else if (e.key === "End") { slideAt = slides.length - 1; drawSlide(); }
  e.stopPropagation();
}

/* ---- version history ----------------------------------------------------- */
setInterval(() => { if (state.dirty) api.history.save(state.name, serialize()).catch(() => {}); }, 5 * 60 * 1000);

async function historyDialog(){
  const list = await api.history.list(state.name).catch(() => []);
  if (!list.length) return say("No snapshots for this note yet. Inkwell keeps one every five minutes while you write, and one on every save.", "Version history");
  const pick = await dialog({
    title: "Version history — " + state.name,
    wide: true,
    choices: list.slice(0, 30).map((h, i) => ({
      icon: "🕘",
      label: new Date(h.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
      detail: h.file.split(/[\\/]/).pop(),
      value: i
    })),
    buttons: [{ label: "Close", value: null }]
  });
  if (pick == null) return;
  const text = await api.history.read(list[pick].file);
  const what = await dialog({
    title: "Restore this version?",
    message: (text.match(/\S+/g) || []).length + " words, from " + new Date(list[pick].at).toLocaleString() + ".",
    buttons: [
      { label: "Cancel", value: null },
      { label: "Open in a new tab", value: "tab" },
      { label: "Replace current", value: "replace", primary: true }
    ]
  });
  if (what === "tab") adopt(text, state.name.replace(/\.md$/, "") + " (restored).md", null, 0);
  else if (what === "replace") { loadText(text, state.name, { path: state.path, mtime: state.mtime }); state.dirty = true; updateStatus(); }
}

/* ------------------------------------------------------------------ export */
let cssCache = null;
async function appCSS(){
  if (cssCache == null) {
    try { cssCache = await api.assets.css(); }
    catch (err) { cssCache = ""; }
  }
  return cssCache;
}
/* A note's images are written next to the note, so "assets/x.png" is relative
   to the note's folder — not to the renderer's own index.html. Point them at
   the real file so they actually appear. */
function noteDir(){
  if (!state.path) return null;
  const sep = api.platform === "win32" ? "\\" : "/";
  return state.path.slice(0, state.path.lastIndexOf(sep) + 1);
}
function resolveImages(root){
  const dir = noteDir();
  if (!dir || !root) return;
  root.querySelectorAll("img[src]").forEach(img => {
    const src = img.getAttribute("src") || "";
    if (/^(https?:|data:|file:|blob:|\/)/.test(src)) return;
    img.src = "file://" + encodeURI(dir + src).replace(/#/g, "%23");
  });
}

function renderedBody(){
  const blocks = prefs.rich && Rich9.isReady() ? splitBlocks(docText()) : state.blocks.map(b => b.src);
  return blocks.map(src => '<div class="block"><div class="rendered">' + renderBlock(src) + "</div></div>").join("\n");
}
async function exportHTMLDoc(){
  commit();
  const css = await appCSS();
  const katexCss = Rich.mathReady() ? await api.assets.katexCss().catch(() => "") : "";
  /* exports must carry finished diagrams: the PDF window runs with JS disabled */
  const body = await Rich.bake(renderedBody());
  const title = state.name.replace(/\.[^.]+$/, "");
  return '<!doctype html>\n<html lang="en" data-theme="' + prefs.theme + '">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>' + esc(title) + "</title>\n" +
    "<style>\n" + katexCss + "\n" + css + "\nbody{overflow:auto;background:var(--page)}#paper{max-width:46rem;margin:0 auto;padding:56px 28px;" +
    "font-family:var(--font-text);font-size:17px;line-height:1.72;color:var(--ink)}\n" +
    ".diagram{display:flex;justify-content:center;margin:0 0 1em}.diagram svg{max-width:100%;height:auto}\n</style>\n</head>\n<body>\n" +
    '<div id="paper">' + body + "</div>\n</body>\n</html>";
}
let pandocInfo = null;
async function exportMenu(){
  if (pandocInfo === null) pandocInfo = await api.pandoc.info().catch(() => ({ version: null, formats: [] }));

  const choices = [
    { icon: "🌐", label: "HTML page",     detail: "One self-contained file, styles included", value: "html" },
    { icon: "📄", label: "PDF",           detail: "Rendered by the app, diagrams and maths baked in", value: "pdf" },
    { icon: "📝", label: "Word (.doc)",   detail: "HTML flavour — opens anywhere, no Pandoc needed",  value: "doc" },
    { icon: "⤓",  label: "Markdown copy", detail: "Save the raw .md somewhere else",          value: "md" },
    { icon: "🅣",  label: "Plain text",    detail: "Formatting stripped out",                  value: "txt" }
  ];

  if (pandocInfo.version) {
    pandocInfo.formats.forEach(f =>
      choices.push({ icon: "◇", label: f.label, detail: f.detail + " · via Pandoc " + pandocInfo.version, value: "pandoc:" + f.id }));
  } else {
    choices.push({ icon: "◇", label: "More formats…", detail: "docx, LaTeX, EPUB, RTF and others need Pandoc", value: "pandoc-missing" });
  }

  const pick = await dialog({
    title: "Export " + state.name,
    wide: true,
    choices,
    buttons: [{ label: "Cancel", value: null }]
  });
  if (pick) runExport(pick);
}

async function pandocHelp(){
  const how = api.platform === "darwin" ? "brew install pandoc"
            : api.platform === "win32" ? "winget install --id JohnMacFarlane.Pandoc"
            : "sudo apt install pandoc";
  const r = await dialog({
    title: "Pandoc is not installed",
    message: "Word (.docx), LaTeX, EPUB, RTF, reStructuredText and the rest are produced by Pandoc, a free converter. " +
             "Install it and Inkwell will pick it up automatically:\n\n    " + how +
             "\n\nThe HTML, PDF, .doc and plain text exports work without it.",
    buttons: [
      { label: "Close", value: null },
      { label: "Copy the command", value: "copy" },
      { label: "Pandoc website", value: "web", primary: true }
    ]
  });
  if (r === "web") api.system.openExternal("https://pandoc.org/installing.html");
  else if (r === "copy") { navigator.clipboard.writeText(how).catch(() => {}); toast("Command copied"); }
}
async function runExport(kind){
  const base = state.name.replace(/\.[^.]+$/, "");
  try {
    if (kind === "pandoc-missing") return pandocHelp();
    if (kind.startsWith("pandoc:")) {
      const dir = state.path ? state.path.slice(0, state.path.lastIndexOf(api.platform === "win32" ? "\\" : "/")) : null;
      toast("Converting with Pandoc…");
      const out = await api.pandoc.export(kind.slice(7), serialize(), base, dir);
      if (out) toast("Exported " + out.split(/[\\/]/).pop());
      return;
    }
    if (kind === "html") {
      const p = await api.exporter.save(base + ".html", await exportHTMLDoc(), [{ name: "HTML", extensions: ["html"] }]);
      if (p) toast("Exported " + p.split(/[\\/]/).pop());
    } else if (kind === "pdf") {
      const p = await api.exporter.pdf(base + ".pdf", await exportHTMLDoc());
      if (p) toast("Exported " + p.split(/[\\/]/).pop());
    } else if (kind === "doc") {
      const css = "body{font-family:Georgia,serif;font-size:12pt;line-height:1.6;margin:2.5cm}" +
        "h1,h2,h3,h4{font-family:Calibri,Arial,sans-serif}pre{background:#f4f4f4;padding:10px;border:1px solid #ddd;" +
        "font-family:Consolas,monospace;font-size:10pt}code{font-family:Consolas,monospace;background:#f4f4f4}" +
        "blockquote{border-left:3px solid #ccc;margin-left:0;padding-left:14px;color:#555}" +
        "table{border-collapse:collapse}td,th{border:1px solid #999;padding:5px 9px}img{max-width:100%}";
      const html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">' +
        '<head><meta charset="utf-8"><title>' + esc(base) + "</title><style>" + css + "</style></head><body>" +
        renderedBody().replace(/<div class="block"><div class="rendered">|<\/div><\/div>/g, "") + "</body></html>";
      const p = await api.exporter.save(base + ".doc", html, [{ name: "Word", extensions: ["doc"] }]);
      if (p) toast("Exported for Word");
    } else if (kind === "md") {
      commit();
      const p = await api.exporter.save(base + ".md", serialize(), [{ name: "Markdown", extensions: ["md"] }]);
      if (p) toast("Saved a copy");
    } else if (kind === "txt") {
      commit();
      const tmp = document.createElement("div");
      tmp.innerHTML = renderedBody();
      const p = await api.exporter.save(base + ".txt", tmp.textContent.replace(/\n{3,}/g, "\n\n").trim(), [{ name: "Text", extensions: ["txt"] }]);
      if (p) toast("Exported plain text");
    }
  } catch (err) { say(err.message, "Export failed"); }
}

/* --------------------------------------------------------------- settings */
function savePrefs(){
  api.settings.set({
    theme: prefs.theme, followSystemTheme: prefs.followSystemTheme, font: prefs.font,
    fontSize: prefs.fontSize, lineHeight: prefs.lineHeight, measure: prefs.measure,
    sidebar: prefs.sidebar, focus: prefs.focus, typewriter: prefs.typewriter, wide: prefs.wide,
    lineNumbers: prefs.lineNumbers, autopair: prefs.autopair, spellcheck: prefs.spellcheck,
    goal: prefs.goal, autosave: prefs.autosave, autosaveDelay: prefs.autosaveDelay,
    smartPunctuation: prefs.smartPunctuation, pasteAsMarkdown: prefs.pasteAsMarkdown,
    numberHeadings: prefs.numberHeadings
  }).catch(() => {});
}

const FONTS = {
  serif: '"Iowan Old Style","Palatino Linotype",Palatino,Georgia,"Times New Roman",serif',
  sans: '-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif',
  mono: 'ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace',
  humanist: 'Optima,Candara,"Gill Sans","Trebuchet MS",sans-serif'
};
function applyPrefs(){
  const r = document.documentElement.style;
  r.setProperty("--font-text", FONTS[prefs.font] || FONTS.serif);
  r.setProperty("--measure", prefs.measure + "rem");
  const paper = $("#paper");
  paper.style.fontSize = prefs.fontSize + "px";
  paper.style.lineHeight = prefs.lineHeight;
  mdOptions.lineNumbers = !!prefs.lineNumbers;
  document.body.classList.toggle("numbered", !!prefs.numberHeadings);
  $$(".src").forEach(t => { t.spellcheck = !!prefs.spellcheck; });
}

async function settingsDialog(){
  const before = JSON.stringify(prefs);
  const r = await dialog({
    title: "Preferences",
    wide: true,
    fields: [
      { name: "font", label: "Typeface", type: "select", value: prefs.font, options: [
        { value: "serif", label: "Serif — Iowan / Palatino" },
        { value: "sans", label: "Sans — system UI" },
        { value: "humanist", label: "Humanist — Optima / Gill Sans" },
        { value: "mono", label: "Monospace" }
      ] },
      { name: "fontSize", label: "Text size", type: "range", value: prefs.fontSize, min: 13, max: 24, step: 1, unit: "px",
        live: v => { $("#paper").style.fontSize = v + "px"; } },
      { name: "lineHeight", label: "Line height", type: "range", value: prefs.lineHeight, min: 1.3, max: 2.2, step: .02, unit: "",
        live: v => { $("#paper").style.lineHeight = v; } },
      { name: "measure", label: "Column width", type: "range", value: prefs.measure, min: 32, max: 72, step: 1, unit: "rem",
        live: v => document.documentElement.style.setProperty("--measure", v + "rem") },
      { name: "goal", label: "Word goal (0 = off)", type: "number", value: prefs.goal, min: 0, max: 100000, step: 50 },
      { name: "autosave", label: "Save to disk automatically while writing", type: "checkbox", value: prefs.autosave },
      { name: "followSystemTheme", label: "Follow the system light/dark setting", type: "checkbox", value: prefs.followSystemTheme },
      { name: "autopair", label: "Auto-close brackets and wrap the selection", type: "checkbox", value: prefs.autopair },
      { name: "smartPunctuation", label: "Smart quotes, dashes and ellipses while typing", type: "checkbox", value: prefs.smartPunctuation },
      { name: "pasteAsMarkdown", label: "Convert pasted rich text to markdown", type: "checkbox", value: prefs.pasteAsMarkdown },
      { name: "numberHeadings", label: "Number headings automatically", type: "checkbox", value: prefs.numberHeadings },
      { name: "lineNumbers", label: "Line numbers in code blocks", type: "checkbox", value: prefs.lineNumbers },
      { name: "spellcheck", label: "Check spelling while writing", type: "checkbox", value: prefs.spellcheck }
    ],
    buttons: [{ label: "Cancel", value: "cancel" }, { label: "Apply", value: "ok", primary: true }]
  });
  if (!r || r.action !== "ok") { Object.assign(prefs, JSON.parse(before)); applyPrefs(); return; }
  Object.assign(prefs, {
    font: r.font, fontSize: +r.fontSize, lineHeight: +r.lineHeight, measure: +r.measure,
    goal: Math.max(0, parseInt(r.goal, 10) || 0), autosave: r.autosave,
    followSystemTheme: r.followSystemTheme, autopair: r.autopair,
    lineNumbers: r.lineNumbers, spellcheck: r.spellcheck,
    smartPunctuation: r.smartPunctuation, pasteAsMarkdown: r.pasteAsMarkdown,
    numberHeadings: r.numberHeadings
  });
  applyPrefs();
  const wasActive = state.activeId;
  commit();
  renderAll();
  if (wasActive != null && blockIndex(wasActive) >= 0) activate(wasActive);
  updateStatus();
  savePrefs();
}

/* ------------------------------------------------------- palette & quick open */
const COMMANDS = [
  { name: "New document", key: "⌘N", run: () => newDoc() },
  { name: "Open file…", key: "⌘O", run: () => openFileDialog() },
  { name: "Open vault…", key: "⇧⌘O", run: () => V.openVaultDialog() },
  { name: "New note in vault…", key: "", run: () => V.newNote(V.vault.root) },
  { name: "Save", key: "⌘S", run: () => saveDoc(false) },
  { name: "Save as…", key: "⇧⌘S", run: () => saveDoc(true) },
  { name: "Rename…", key: "", run: () => renameDoc() },
  { name: "Reveal in file manager", key: "", run: () => state.path ? api.file.reveal(state.path) : say("Save the document first.", "Nothing to reveal") },
  { name: "Export…", key: "", run: () => exportMenu() },
  { name: "Copy as markdown", key: "", run: () => copyAs("markdown") },
  { name: "Copy as rich text (HTML)", key: "", run: () => copyAs("html") },
  { name: "Print…", key: "⌘P", run: () => doPrint() },
  { name: "Quick open a note…", key: "⌘⇧K", run: () => quickOpen() },
  { name: "Search the vault", key: "⇧⌘F", run: () => { toggleSidebar(true); setPane("search"); } },
  { name: "Find & replace", key: "⌘F", run: () => openFind(true) },
  { name: "Source mode", key: "⌘/", run: () => toggleSource() },
  { name: "Rich text mode", key: "⌘R", run: () => toggleRich() },
  { name: "Split view", key: "⇧⌘E", run: () => toggleSplit() },
  { name: "Focus mode", key: "⇧⌘F", run: () => toggleFocus() },
  { name: "Typewriter mode", key: "", run: () => toggleTypewriter() },
  { name: "Wide layout", key: "", run: () => toggleWide() },
  { name: "Presentation mode", key: "F5", run: () => startPresentation() },
  { name: "Version history…", key: "", run: () => historyDialog() },
  { name: "Preferences…", key: "⌘,", run: () => settingsDialog() },
  { name: "Toggle sidebar", key: "⌘\\", run: () => toggleSidebar() },
  { name: "Outline", key: "", run: () => { toggleSidebar(true); setPane("outline"); } },
  { name: "Tags and backlinks", key: "", run: () => { toggleSidebar(true); setPane("tags"); } },
  { name: "Close tab", key: "⌘W", run: () => curDoc != null && closeDoc(curDoc) },
  { name: "New window", key: "⇧⌘N", run: () => api.win.create() },
  { name: "Reindex vault", key: "", run: async () => { await api.vault.reindex(); await V.refreshVault(); toast("Vault reindexed"); } },
  { name: "Theme: Paper", key: "", run: () => setTheme("paper") },
  { name: "Theme: Sepia", key: "", run: () => setTheme("sepia") },
  { name: "Theme: Night", key: "", run: () => setTheme("night") },
  { name: "Theme: Slate", key: "", run: () => setTheme("slate") },
  { name: "Insert table", key: "", run: () => insertBlockAfter("| Column | Column |\n| --- | --- |\n| cell | cell |") },
  { name: "Insert code block", key: "", run: () => insertBlockAfter("```js\n\n```") },
  { name: "Insert math block", key: "", run: () => insertBlockAfter("$$\n\n$$") },
  { name: "Insert diagram", key: "", run: () => insertBlockAfter("```mermaid\ngraph TD\n  A[Start] --> B[End]\n```") },
  { name: "Insert table of contents", key: "", run: () => insertBlockAfter("[TOC]") },
  { name: "Insert image from file…", key: "", run: () => insertImage() },
  { name: "Keyboard shortcuts", key: "", run: () => showHelp() }
];

let palSel = 0, palList = [], palMode = "commands";
function openPalette(mode){
  palMode = mode || "commands";
  $("#palette").classList.add("on");
  $("#pal-q").value = "";
  $("#pal-q").placeholder = palMode === "files" ? "Find a note by name…" : "Type a command…";
  fillPalette("");
  $("#pal-q").focus();
}
function closePalette(){ $("#palette").classList.remove("on"); }
async function fillPalette(q){
  const list = $("#pal-list");
  if (palMode === "files") {
    const hits = V.vault.root ? await api.vault.quickOpen(q) : [];
    palList = hits.map(h => ({ name: h.name.replace(/\.md$/i, ""), path: h.path, run: () => openPath(h.path) }));
    if (!palList.length) palList = [{ name: V.vault.root ? "No note matches" : "Open a vault first", run: () => V.openVaultDialog() }];
  } else {
    const s = q.toLowerCase();
    palList = COMMANDS.filter(c => c.name.toLowerCase().includes(s));
  }
  palSel = 0;
  list.textContent = "";
  palList.forEach((c, i) => {
    const d = document.createElement("div");
    d.className = "opt" + (i === 0 ? " sel" : "");
    d.appendChild(Object.assign(document.createElement("span"), { textContent: c.name }));
    if (c.path) {
      const p = document.createElement("span");
      p.className = "path";
      p.textContent = c.path.replace(V.vault.root || "", "").replace(/^[\\/]/, "");
      d.appendChild(p);
    } else if (c.key) {
      d.appendChild(Object.assign(document.createElement("span"), { className: "k", textContent: c.key }));
    }
    d.onmouseenter = () => { palSel = i; markPalette(); };
    d.onclick = () => { closePalette(); c.run(); };
    list.appendChild(d);
  });
}
function markPalette(){
  Array.from($("#pal-list").children).forEach((el, i) => el.classList.toggle("sel", i === palSel));
  const el = $("#pal-list").children[palSel];
  if (el) el.scrollIntoView({ block: "nearest" });
}
const quickOpen = () => openPalette("files");

async function copyAs(kind){
  commit();
  if (kind === "markdown") {
    const ok = await Convert.copyBoth(serialize(), null);
    return toast(ok ? "Copied as markdown" : "Could not reach the clipboard");
  }
  const html = await Rich.bake(Convert.blocksToHTML(state.blocks));
  const ok = await Convert.copyBoth(serialize(), html);
  toast(ok ? "Copied as rich text" : "Could not reach the clipboard");
}

/* ------------------------------------------------------------------ misc */
async function renameDoc(){
  const v = await askText("Give this document a new file name.", state.name, { title: "Rename", label: "File name", ok: "Rename" });
  if (!v) return;
  const next = /\.[a-z0-9]+$/i.test(v) ? v : v + ".md";
  if (state.path) {
    try {
      const f = await api.file.rename(state.path, next);
      state.path = f.path; state.name = f.name;
      const d = docs.find(x => x.id === curDoc);
      if (d) { d.path = f.path; d.name = f.name; }
      await V.refreshVault();
      V.setActivePath(state.path);
    } catch (err) { return say(err.message, "Rename failed"); }
  } else {
    state.name = next;
    const d = docs.find(x => x.id === curDoc);
    if (d) d.name = next;
    state.dirty = true;
  }
  renderTabs();
  updateStatus();
  toast("Renamed to " + state.name);
}

async function insertImage(){
  if (!state.path) return say("Save this note first so the image has somewhere to live beside it.", "Save first");
  try {
    const img = await api.image.pick(state.path);
    if (!img) return;
    insertBlockAfter("![](" + img.relative + ")");
  } catch (err) { say(err.message, "Could not insert the image"); }
}

async function doPrint(){
  try { await api.exporter.print(await exportHTMLDoc()); }
  catch (err) { say(err.message, "Print failed"); }
}

function showHelp(){
  insertBlockAfter([
    "# Keyboard shortcuts",
    "",
    "| Keys | Action |",
    "| --- | --- |",
    "| `⌘⇧P` | Command palette |",
    "| `⌘⇧K` | Quick open a note |",
    "| `⌘N` / `⌘O` / `⌘S` | New / Open / Save |",
    "| `⇧⌘O` | Open a vault |",
    "| `⌘W` / `⌃Tab` | Close tab / next tab |",
    "| `/` | Block menu |",
    "| `⌘B` `⌘I` `⌘E` `⌘U` `⌘K` | Bold, italic, code, strike, link |",
    "| `⌘1`…`⌘6`, `⌘0` | Heading level, plain text |",
    "| `⌘F` / `⇧⌘F` | Find in note / search the vault |",
    "| `⌘/` / `⇧⌘E` | Source mode / split view |",
    "| `F5` | Presentation |",
    "| `⌘,` | Preferences |",
    "",
    "On Windows and Linux use `Ctrl` wherever this says `⌘`."
  ].join("\n"));
}

/* --------------------------------------------------------------- session */
let sessionTimer = null;
function saveSession(){
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    snapshotDoc(false);
    const session = docs.map(d => ({
      path: d.path,
      name: d.name,
      text: d.path && !d.dirty ? null : d.text.slice(0, 400000),
      active: d.id === curDoc
    }));
    api.settings.set({ session }).catch(() => {});
  }, 900);
}

async function restoreSession(session){
  if (!session || !session.length) return false;
  let restored = 0, activeId = null;
  for (const s of session) {
    let text = s.text;
    let mtime = 0;
    if (s.path && text == null) {
      try { const f = await api.file.read(s.path); text = f.text; mtime = f.mtime; }
      catch (err) { continue; }
    }
    if (text == null) continue;
    const d = { id: ++docSeq, text, name: s.name, path: s.path || null, mtime, dirty: !!(s.path && s.text != null), scrollTop: 0 };
    docs.push(d);
    if (s.active) activeId = d.id;
    restored++;
  }
  if (!restored) return false;
  curDoc = activeId || docs[0].id;
  const d = docs.find(x => x.id === curDoc);
  loadText(d.text, d.name, { path: d.path, mtime: d.mtime });
  state.dirty = d.dirty;
  renderTabs();
  V.setActivePath(d.path);
  return true;
}

/* -------------------------------------------------------------- menu bridge */
const MENU = {
  "new": () => newDoc(),
  "open": () => openFileDialog(),
  "open-vault": () => V.openVaultDialog(),
  "open-path": p => openPath(p),
  "save": () => saveDoc(false),
  "save-as": () => saveDoc(true),
  "rename": () => renameDoc(),
  "close-tab": () => curDoc != null && closeDoc(curDoc),
  "reveal": () => state.path ? api.file.reveal(state.path) : say("Save the document first.", "Nothing to reveal"),
  "export-html": () => runExport("html"),
  "export-pdf": () => runExport("pdf"),
  "export-doc": () => runExport("doc"),
  "export-txt": () => runExport("txt"),
  "export-more": () => exportMenu(),
  "copy-md": () => copyAs("markdown"),
  "copy-html": () => copyAs("html"),
  "print": () => doPrint(),
  "find": () => openFind(true),
  "search-vault": () => { toggleSidebar(true); setPane("search"); },
  "quick-open": () => quickOpen(),
  "palette": () => openPalette("commands"),
  "prefs": () => settingsDialog(),
  "sidebar": () => toggleSidebar(),
  "pane-outline": () => { toggleSidebar(true); setPane("outline"); },
  "pane-search": () => { toggleSidebar(true); setPane("search"); },
  "pane-tags": () => { toggleSidebar(true); setPane("tags"); },
  "source": () => toggleSource(),
  "split": () => toggleSplit(),
  "rich": () => toggleRich(),
  "focus": () => toggleFocus(),
  "typewriter": () => toggleTypewriter(),
  "present": () => startPresentation(),
  "history": () => historyDialog(),
  "next-tab": () => cycleTab(1),
  "prev-tab": () => cycleTab(-1),
  "help": () => showHelp(),
  "ins-table": () => insertBlockAfter("| Column | Column |\n| --- | --- |\n| cell | cell |"),
  "ins-code": () => insertBlockAfter("```js\n\n```"),
  "ins-math": () => insertBlockAfter("$$\n\n$$"),
  "ins-diagram": () => insertBlockAfter("```mermaid\ngraph TD\n  A[Start] --> B[End]\n```"),
  "ins-toc": () => insertBlockAfter("[TOC]"),
  "ins-hr": () => insertBlockAfter("---"),
  "ins-image": () => insertImage(),
  "fmt-bold": () => withActive(ta => wrapSel(ta, "**", "**")),
  "fmt-italic": () => withActive(ta => wrapSel(ta, "*", "*")),
  "fmt-code": () => withActive(ta => wrapSel(ta, "`", "`")),
  "fmt-strike": () => withActive(ta => wrapSel(ta, "~~", "~~")),
  "fmt-mark": () => withActive(ta => wrapSel(ta, "==", "==")),
  "fmt-link": () => withActive(ta => linkSel(ta)),
  "h1": () => withActive(ta => setHeading(ta, 1)),
  "h2": () => withActive(ta => setHeading(ta, 2)),
  "h3": () => withActive(ta => setHeading(ta, 3)),
  "h0": () => withActive(ta => setHeading(ta, 0))
};

/* menu formatting: in rich text mode TipTap owns the selection */
const RICH_CMD = {
  "fmt-bold": ["bold"], "fmt-italic": ["italic"], "fmt-code": ["code"],
  "fmt-strike": ["strike"], "fmt-mark": ["highlight"], "fmt-link": ["link"],
  h1: ["heading", 1], h2: ["heading", 2], h3: ["heading", 3], h0: ["heading", 0],
  "ins-table": ["table"], "ins-code": ["codeblock"], "ins-hr": ["hr"]
};
function richHandles(cmd){
  if (!prefs.rich || !Rich9.isReady()) return false;
  const spec = RICH_CMD[cmd];
  if (!spec) return false;
  return Rich9.command(spec[0], spec[1]);
}

function withActive(fn){
  if (state.activeId == null) {
    const last = state.blocks[state.blocks.length - 1];
    if (last) activate(last.id);
  }
  const ta = activeTextarea();
  if (ta) { ta.focus(); fn(ta); }
}

/* --------------------------------------------------------------------- boot */
async function boot(){
  document.body.classList.toggle("mac", IS_MAC);
  mount($("#paper"), $("#scroll"));
  mountDialogs();
  mountAids();
  V.mountSearch();
  V.setOpener((p, opts) => openPath(p, opts));
  setHeadingSource(() => headings().map(h => ({ lvl: h.lvl, text: h.text })));

  /* real KaTeX and real Mermaid, both loaded from the local vendor folder */
  if (!Rich.initMath()) console.warn("KaTeX did not load; maths falls back to MathML");
  Rich.initDiagrams(darkTheme(prefs.theme) ? "dark" : "default")
    .then(() => { renderAll(); Rich.hydrate($("#paper")); })
    .catch(err => console.warn("Mermaid unavailable, keeping built-in flowcharts:", err.message));

  /* settings */
  let saved = {};
  try { saved = await api.settings.get(); } catch (err) {}
  Object.assign(prefs, saved || {});
  setTheme(prefs.theme || "paper");
  toggleSidebar(prefs.sidebar !== false);
  if (prefs.focus) { prefs.focus = false; toggleFocus(); }
  if (prefs.typewriter) { prefs.typewriter = false; toggleTypewriter(); }
  if (prefs.wide) { prefs.wide = false; toggleWide(); }
  prefs.source = false; prefs.split = false; prefs.rich = false;
  applyPrefs();

  if (prefs.followSystemTheme) {
    const dark = await api.system.prefersDark();
    if (dark && (prefs.theme === "paper" || prefs.theme === "sepia")) setTheme("night");
  }

  /* editor hooks */
  on("change", () => { updateStatus(); scheduleAutosave(); });
  on("render", () => { Rich.hydrate($("#paper")); resolveImages($("#paper")); });
  on("load", () => { closeSlash(); });
  Convert.initTurndown();
  setHtmlPasteHandler(html => prefs.pasteAsMarkdown ? Convert.htmlToMarkdown(html) : null);
  setTypingFilter(ta => { if (prefs.smartPunctuation) Convert.smartPunctuate(ta); });

  setImageHandler(async (file, insert) => {
    if (!state.path) return say("Save this note first so images can be stored beside it.", "Save first");
    const buf = new Uint8Array(await file.arrayBuffer());
    try {
      const img = await api.image.save(state.path, buf, "." + (file.type.split("/")[1] || "png"));
      insert("![](" + img.relative + ")");
    } catch (err) { say(err.message, "Could not save the image"); }
  });

  /* vault + documents */
  if (saved.vault) await V.restoreVault(saved.vault);
  const restored = await restoreSession(saved.session);
  if (!restored) adopt(WELCOME, "Welcome.md", null, 0);
  updateStatus();

  wireUI();
  api.on.menu(({ cmd, arg }) => {
    if (richHandles(cmd)) return;
    const fn = MENU[cmd];
    if (fn) fn(arg);
  });
  api.on.openPaths(list => (list || []).forEach(p => openPath(p)));
  api.on.vaultChanged(({ path }) => { V.refreshVault(); checkExternal(path); });
  api.on.themeChanged(dark => {
    if (!prefs.followSystemTheme) return;
    setTheme(dark ? "night" : "paper");
  });
  window.addEventListener("focus", () => checkExternal());
}

function wireUI(){
  $("#btn-sidebar").onclick = () => toggleSidebar();
  $("#btn-new").onclick = () => newDoc();
  $("#btn-open").onclick = () => openFileDialog();
  $("#btn-save").onclick = () => saveDoc(false);
  $("#btn-vault").onclick = () => V.openVaultDialog();
  $("#btn-openfolder").onclick = () => V.openVaultDialog();
  $("#btn-newnote").onclick = () => V.newNote(V.vault.root);
  $("#btn-find").onclick = () => openFind(!$("#find").classList.contains("on"));
  $("#btn-focus").onclick = () => toggleFocus();
  $("#btn-rich").onclick = () => toggleRich();
  $("#btn-split").onclick = () => toggleSplit();
  $("#btn-present").onclick = () => startPresentation();
  $("#btn-hist").onclick = () => historyDialog();
  $("#btn-src").onclick = () => toggleSource();
  $("#btn-export").onclick = () => exportMenu();
  $("#btn-type").onclick = () => toggleTypewriter();
  $("#btn-wide").onclick = () => toggleWide();
  $("#btn-prefs").onclick = () => settingsDialog();
  $("#btn-help").onclick = () => openPalette("commands");
  $("#docname").onclick = () => renameDoc();
  $("#docname").title = "Click to rename";

  ["#btn-bold", "#btn-italic", "#btn-link"].forEach(sel => $(sel).addEventListener("mousedown", e => e.preventDefault()));
  $("#btn-bold").onclick = () => withActive(ta => wrapSel(ta, "**", "**"));
  $("#btn-italic").onclick = () => withActive(ta => wrapSel(ta, "*", "*"));
  $("#btn-link").onclick = () => withActive(ta => linkSel(ta));

  $$(".side-tabs button").forEach(b => { b.onclick = () => setPane(b.dataset.pane); });
  $$(".theme-dot").forEach(d => { d.onclick = () => setTheme(d.dataset.theme); });

  $("#find-q").addEventListener("input", runFind);
  $("#find-q").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); gotoMatch(e.shiftKey ? mIdx - 1 : mIdx + 1); }
    if (e.key === "Escape") openFind(false);
  });
  ["find-case", "find-word", "find-re"].forEach(id => $("#" + id).addEventListener("change", runFind));
  $("#find-next").onclick = () => gotoMatch(mIdx + 1);
  $("#find-prev").onclick = () => gotoMatch(mIdx - 1);
  $("#find-close").onclick = () => openFind(false);
  $("#find-one").onclick = replaceOne;
  $("#find-all").onclick = replaceAll;

  $("#source").addEventListener("input", () => { state.dirty = true; markTitle(); });
  $("#split-src").addEventListener("input", () => {
    state.dirty = true;
    clearTimeout(splitTimer);
    splitTimer = setTimeout(paintSplit, 220);
  });

  $("#pal-q").addEventListener("input", e => fillPalette(e.target.value));
  $("#pal-q").addEventListener("keydown", e => {
    if (e.key === "Escape") closePalette();
    else if (e.key === "ArrowDown") { e.preventDefault(); palSel = Math.min(palSel + 1, palList.length - 1); markPalette(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); palSel = Math.max(palSel - 1, 0); markPalette(); }
    else if (e.key === "Enter") { e.preventDefault(); const c = palList[palSel]; closePalette(); if (c) c.run(); }
  });
  $("#palette").addEventListener("mousedown", e => { if (e.target.id === "palette") closePalette(); });
  window.addEventListener("mousedown", e => { if (!e.target.closest("#ctx")) V.hideCtx(); });

  /* in-document clicks: code copy, wiki links, tags, external links */
  $("#paper").addEventListener("click", async e => {
    const copy = e.target.closest("pre .copy");
    if (copy) {
      e.preventDefault(); e.stopPropagation();
      try { await navigator.clipboard.writeText(copy.closest("pre").dataset.code || ""); } catch (err) {}
      copy.textContent = "copied"; copy.classList.add("done");
      setTimeout(() => { copy.textContent = "copy"; copy.classList.remove("done"); }, 1400);
      return;
    }
    const wiki = e.target.closest("a.wiki");
    if (wiki) { e.preventDefault(); e.stopPropagation(); return followWiki(wiki.dataset.page); }
    const tag = e.target.closest("a.tag");
    if (tag) {
      e.preventDefault(); e.stopPropagation();
      toggleSidebar(true); setPane("search");
      $("#vs-q").value = "#" + tag.dataset.tag;
      $("#vs-re").checked = false;
      V.runVaultSearch();
      return;
    }
    const link = e.target.closest("a[href]");
    if (link && /^https?:|^mailto:/.test(link.getAttribute("href"))) {
      e.preventDefault();
      api.system.openExternal(link.getAttribute("href"));
    }
  }, true);

  /* keys the native menu does not already own */
  document.addEventListener("keydown", e => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) {
      if (e.key === "Escape" && $("#find").classList.contains("on")) openFind(false);
      return;
    }
    const k = e.key.toLowerCase();
    if (e.shiftKey && k === "p") { e.preventDefault(); $("#palette").classList.contains("on") ? closePalette() : openPalette("commands"); }
    else if (e.shiftKey && k === "k") { e.preventDefault(); quickOpen(); }
    else if (k === "," ) { e.preventDefault(); settingsDialog(); }
    else if (k === "\\") { e.preventDefault(); toggleSidebar(); }
    else if (e.key === "Tab") { e.preventDefault(); cycleTab(e.shiftKey ? -1 : 1); }
    else if (/^[1-9]$/.test(k) && docs.length > 1 && e.altKey) {
      const d = docs[+k - 1];
      if (d) { e.preventDefault(); switchDoc(d.id); }
    }
  });

  /* drag and drop from the file manager */
  let dragDepth = 0;
  window.addEventListener("dragenter", e => { e.preventDefault(); dragDepth++; $("#drop").classList.add("on"); });
  window.addEventListener("dragover", e => e.preventDefault());
  window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#drop").classList.remove("on"); } });
  window.addEventListener("drop", async e => {
    e.preventDefault();
    dragDepth = 0;
    $("#drop").classList.remove("on");
    for (const f of Array.from(e.dataTransfer.files || [])) {
      const p = api.file.pathOf(f);
      if (!p) continue;
      if (/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(p)) {
        if (!state.path) { say("Save this note first so images can live beside it.", "Save first"); continue; }
        const buf = new Uint8Array(await f.arrayBuffer());
        try {
          const img = await api.image.save(state.path, buf, p.slice(p.lastIndexOf(".")));
          insertBlockAfter("![](" + img.relative + ")");
        } catch (err) { say(err.message, "Could not save the image"); }
      } else openPath(p);
    }
  });
}

async function followWiki(page){
  const hit = V.vault.root ? await api.vault.resolve(page) : null;
  if (hit) return openPath(hit.path);
  const r = await dialog({
    title: "No note called " + page,
    message: V.vault.root
      ? "Nothing in this vault matches that name."
      : "Wiki links resolve inside a vault. Open a folder of notes to link them together.",
    buttons: V.vault.root
      ? [{ label: "Cancel", value: null }, { label: "Create it", value: "create", primary: true }]
      : [{ label: "Cancel", value: null }, { label: "Open vault…", value: "vault", primary: true }]
  });
  if (r === "vault") V.openVaultDialog();
  else if (r === "create") {
    try {
      const f = await api.file.create(V.vault.root, page + ".md", "# " + page + "\n\n");
      await V.refreshVault();
      openPath(f.path);
    } catch (err) { say(err.message, "Could not create the note"); }
  }
}

const WELCOME = [
  "# Inkwell",
  "",
  "A quiet markdown editor. This is the desktop build: it reads and writes real files,",
  "keeps a whole folder of notes in view, and searches across all of them.",
  "",
  "## Start with a vault",
  "",
  "A vault is just a folder of markdown files. Open one from the sidebar and you get a file",
  "tree, search across every note, tags, and `[[wiki links]]` that resolve between them —",
  "with backlinks showing what points here.",
  "",
  "## Editing feels like paper",
  "",
  "Click any paragraph to see its markdown source. Click away, or press `Esc`, and it renders",
  "again. Type `/` for the block menu, `⌘⇧P` for commands and `⌘⇧K` to jump to any note.",
  "",
  "- [x] Task lists that write back into the file",
  "- [ ] Tables with a toolbar for rows and columns",
  "- [ ] Math like $e^{i\\pi} + 1 = 0$, rendered as MathML",
  "",
  "```mermaid",
  "graph LR",
  "  A[Draft] --> B[Revise] --> C[Publish]",
  "```",
  "",
  "Your work saves itself as you type once the note lives on disk, and every save keeps a",
  "snapshot you can walk back through. Press `⌘⇧P` and pick *Keyboard shortcuts* for the rest.",
  ""
].join("\n");

boot().catch(err => {
  console.error(err);
  document.body.innerHTML = '<pre style="padding:40px;font:13px/1.6 monospace;color:#c0392b">Inkwell failed to start:\n\n' +
    esc(err.stack || err.message) + "</pre>";
});
