/* ===========================================================================
   Block editor.
   The document is a list of block sources. Exactly one block is "active" and
   shows its markdown in a textarea; every other block shows rendered HTML.
   This module owns the document and the caret. It knows nothing about files,
   tabs or the sidebar — those listen through on().
   =========================================================================== */
import { splitBlocks, renderBlock, blockType, MULTILINE, RE_FENCE, RE_LI } from "./markdown.js";

export const $  = s => document.querySelector(s);
export const $$ = s => Array.from(document.querySelectorAll(s));

export let paper, scroll;

let uid = 0;
export const mkBlock = src => ({ id: ++uid, src: src == null ? "" : src });

export const state = {
  blocks: [mkBlock("")],
  activeId: null,
  name: "Untitled.md",
  path: null,
  mtime: 0,
  dirty: false,
  committing: false
};

export const prefs = {
  theme: "paper", followSystemTheme: true, font: "serif", fontSize: 17, lineHeight: 1.72,
  measure: 46, sidebar: true, focus: false, typewriter: false, wide: false,
  lineNumbers: false, autopair: true, spellcheck: true, goal: 0,
  autosave: true, autosaveDelay: 1200, source: false, split: false,
  smartPunctuation: false, pasteAsMarkdown: true, numberHeadings: false,
  rich: undefined,     // undefined means "not chosen yet" — boot picks styled
  checkUpdates: true
};

/* ---- events -------------------------------------------------------------- */
const hooks = new Map();
export function on(name, fn){
  if (!hooks.has(name)) hooks.set(name, []);
  hooks.get(name).push(fn);
  return () => hooks.set(name, hooks.get(name).filter(f => f !== fn));
}
export function emit(name, ...args){
  (hooks.get(name) || []).forEach(fn => {
    try { fn(...args); } catch (err) { console.error("hook " + name + ":", err); }
  });
}

let imageHandler = null;
export const setImageHandler = fn => { imageHandler = fn; };

/* Given clipboard HTML, return markdown to insert, or null to let the browser
   paste plain text as usual. */
let htmlPasteHandler = null;
export const setHtmlPasteHandler = fn => { htmlPasteHandler = fn; };

/* Called after each keystroke so an aid can rewrite what was just typed. */
let typingFilter = null;
export const setTypingFilter = fn => { typingFilter = fn; };

/* ---- document ------------------------------------------------------------ */
export const serialize = () => state.blocks.map(b => b.src).join("\n\n").replace(/\n{3,}/g, "\n\n");
export const blockIndex = id => state.blocks.findIndex(b => b.id === id);
export const blockEls = id => paper.querySelector('.block[data-id="' + id + '"]');
export const headings = () => state.blocks.reduce((acc, b) => {
  const m = b.src.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
  if (m) acc.push({ id: b.id, lvl: m[1].length, text: m[2].replace(/[*_`~]/g, "").trim() });
  return acc;
}, []);

export function mount(paperEl, scrollEl){
  paper = paperEl;
  scroll = scrollEl;
  paper.addEventListener("mousedown", onPaperDown);
  paper.addEventListener("click", onPaperClick);
  scroll.addEventListener("click", e => {
    if (e.target !== scroll) return;
    const last = state.blocks[state.blocks.length - 1];
    if (last) activate(last.id);
  });
}

export function loadText(text, name, meta){
  state.blocks = splitBlocks(text).map(mkBlock);
  state.activeId = null;
  if (name) state.name = name;
  if (meta) { state.path = meta.path || null; state.mtime = meta.mtime || 0; }
  state.dirty = false;
  renderAll();
  if (scroll) scroll.scrollTop = 0;
  emit("load");
  emit("change", false);
}

/* ---- painting ------------------------------------------------------------ */
function blockEl(b){
  const el = document.createElement("div");
  el.className = "block";
  el.dataset.id = b.id;
  if (b.id === state.activeId) {
    el.classList.add("active");
    el.appendChild(makeTextarea(b));
  } else {
    const r = document.createElement("div");
    r.className = "rendered";
    r.innerHTML = renderBlock(b.src);
    el.appendChild(r);
  }
  return el;
}

export function renderAll(){
  paper.textContent = "";
  const frag = document.createDocumentFragment();
  for (const b of state.blocks) frag.appendChild(blockEl(b));
  paper.appendChild(frag);
  emit("render");
}

export function repaint(id){
  const el = blockEls(id);
  const b = state.blocks[blockIndex(id)];
  if (el && b) { el.replaceWith(blockEl(b)); emit("render"); }
}

function makeTextarea(b){
  const ta = document.createElement("textarea");
  ta.className = "src t-" + blockType(b.src);
  ta.spellcheck = !!prefs.spellcheck;
  ta.rows = 1;
  ta.value = b.src;
  ta.addEventListener("input", onInput);
  ta.addEventListener("keydown", onKey);
  ta.addEventListener("blur", () => { if (!state.committing) commit(); });
  ta.addEventListener("paste", onPaste);
  requestAnimationFrame(() => autosize(ta));
  return ta;
}

export const autosize = ta => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };

function onInput(e){
  const ta = e.target;
  if (typingFilter && e.inputType && e.inputType.startsWith("insert")) typingFilter(ta);
  autosize(ta);
  const idx = blockIndex(state.activeId);
  if (idx >= 0) state.blocks[idx].src = ta.value;
  ta.className = "src t-" + blockType(ta.value);
  emit("input", ta);
  emit("change", true);
}

/* ---- activation and commit ----------------------------------------------- */
export function activate(id, caret, caretEnd){
  if (state.activeId === id) {
    const el = blockEls(id);
    const ta = el && el.querySelector(".src");
    if (ta && caret != null) { ta.focus(); ta.setSelectionRange(caret, caretEnd == null ? caret : caretEnd); }
    return;
  }
  commit();
  if (blockIndex(id) < 0) return;
  state.activeId = id;
  repaint(id);
  const el = blockEls(id);
  const ta = el && el.querySelector(".src");
  if (!ta) return;
  autosize(ta);
  ta.focus();
  const n = caret == null ? ta.value.length : Math.max(0, Math.min(caret, ta.value.length));
  ta.setSelectionRange(n, caretEnd == null ? n : Math.min(caretEnd, ta.value.length));
  if (prefs.typewriter) el.scrollIntoView({ block: "center", behavior: "smooth" });
  else keepInView(el);
  emit("activate", el, ta);
}

function keepInView(el){
  const r = el.getBoundingClientRect(), s = scroll.getBoundingClientRect();
  if (r.top < s.top + 60) scroll.scrollTop -= (s.top + 60 - r.top);
  else if (r.bottom > s.bottom - 60) scroll.scrollTop += (r.bottom - s.bottom + 60);
}

export function commit(){
  emit("commit");
  const id = state.activeId;
  if (id == null) return;
  const idx = blockIndex(id);
  state.activeId = null;
  if (idx < 0) return;

  const el = blockEls(id);
  const ta = el && el.querySelector(".src");
  if (ta) state.blocks[idx].src = ta.value;

  const val = state.blocks[idx].src;
  const fresh = (!val.trim() && state.blocks.length > 1) ? [] : splitBlocks(val).map(mkBlock);

  state.committing = true;
  state.blocks.splice(idx, 1, ...fresh);
  if (el) {
    if (!fresh.length) el.remove();
    else {
      const frag = document.createDocumentFragment();
      fresh.forEach(b => frag.appendChild(blockEl(b)));
      el.replaceWith(frag);
    }
  }
  state.committing = false;
  if (!state.blocks.length) { state.blocks = [mkBlock("")]; renderAll(); }
  emit("render");
  emit("change", false);
}

export const activeTextarea = () => {
  const el = state.activeId != null ? blockEls(state.activeId) : null;
  return el ? el.querySelector(".src") : null;
};

/* ---- typing -------------------------------------------------------------- */
export function insertAt(ta, text){
  const s = ta.selectionStart, e = ta.selectionEnd;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  ta.setSelectionRange(s + text.length, s + text.length);
  ta.dispatchEvent(new Event("input"));
}

export function splitBlockAtCaret(ta){
  const pos = ta.selectionStart;
  const after = ta.value.slice(pos);
  ta.value = ta.value.slice(0, pos);
  const idx = blockIndex(state.activeId);
  const nb = mkBlock(after);
  state.blocks.splice(idx + 1, 0, nb);
  const el = blockEls(state.activeId);
  if (el) el.after(blockEl(nb));
  commit();
  activate(nb.id, 0);
}

function mergeInto(prevIdx, curIdx){
  const prev = state.blocks[prevIdx], cur = state.blocks[curIdx];
  const caret = prev.src.length;
  prev.src = prev.src + (cur.src ? "\n" + cur.src : "");
  const curEl = blockEls(cur.id);
  state.activeId = null;
  state.blocks.splice(curIdx, 1);
  if (curEl) curEl.remove();
  repaint(prev.id);
  activate(prev.id, caret);
}

function onKey(e){
  const ta = e.target;
  const pos = ta.selectionStart, end = ta.selectionEnd;
  const val = ta.value;
  const idx = blockIndex(state.activeId);
  const type = blockType(val);
  const mod = e.metaKey || e.ctrlKey;

  if (mod && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === "b") { e.preventDefault(); wrapSel(ta, "**", "**"); return; }
    if (k === "i") { e.preventDefault(); wrapSel(ta, "*", "*"); return; }
    if (k === "k") { e.preventDefault(); linkSel(ta); return; }
    if (k === "e") { e.preventDefault(); wrapSel(ta, "`", "`"); return; }
    if (k === "u") { e.preventDefault(); wrapSel(ta, "~~", "~~"); return; }
    if (e.shiftKey && k === "h") { e.preventDefault(); wrapSel(ta, "==", "=="); return; }
    if (k >= "1" && k <= "6") { e.preventDefault(); setHeading(ta, +k); return; }
    if (k === "0") { e.preventDefault(); setHeading(ta, 0); return; }
  }

  if (e.key === "Escape") { e.preventDefault(); commit(); return; }

  if (e.key === "Tab") {
    e.preventDefault();
    if (e.shiftKey) {
      const ls = val.lastIndexOf("\n", pos - 1) + 1;
      if (val.slice(ls, ls + 2) === "  ") {
        ta.value = val.slice(0, ls) + val.slice(ls + 2);
        ta.setSelectionRange(Math.max(ls, pos - 2), Math.max(ls, pos - 2));
        ta.dispatchEvent(new Event("input"));
      }
    } else insertAt(ta, "  ");
    return;
  }

  if (e.key === "Enter") {
    if (e.shiftKey) { e.preventDefault(); insertAt(ta, MULTILINE.has(type) ? "\n" : "  \n"); return; }
    if (type === "code" || type === "front" || type === "table") return;

    if (type === "quote") {
      const line = val.slice(val.lastIndexOf("\n", pos - 1) + 1, pos);
      e.preventDefault();
      if (/^\s{0,3}>\s*$/.test(line)) {
        ta.value = val.slice(0, pos - line.length) + val.slice(pos);
        ta.setSelectionRange(pos - line.length, pos - line.length);
        ta.dispatchEvent(new Event("input"));
        splitBlockAtCaret(ta);
      } else insertAt(ta, "\n> ");
      return;
    }

    if (type === "list") {
      const ls = val.lastIndexOf("\n", pos - 1) + 1;
      const line = val.slice(ls, pos);
      const m = line.match(/^(\s*)([-*+]|\d{1,9}[.)])\s+(\[[ xX]\]\s+)?(.*)$/);
      e.preventDefault();
      if (m && !m[4].trim()) {
        ta.value = val.slice(0, ls) + val.slice(pos);
        ta.setSelectionRange(ls, ls);
        ta.dispatchEvent(new Event("input"));
        splitBlockAtCaret(ta);
      } else if (m) {
        let marker = m[2];
        if (/\d/.test(marker)) marker = (parseInt(marker, 10) + 1) + marker.slice(-1);
        insertAt(ta, "\n" + m[1] + marker + " " + (m[3] ? "[ ] " : ""));
      } else insertAt(ta, "\n");
      return;
    }

    e.preventDefault();
    splitBlockAtCaret(ta);
    return;
  }

  if (e.key === "Backspace" && pos === 0 && end === 0) {
    if (idx > 0) { e.preventDefault(); state.blocks[idx].src = val; mergeInto(idx - 1, idx); }
    return;
  }
  if (e.key === "Delete" && pos === val.length && end === val.length) {
    if (idx >= 0 && idx < state.blocks.length - 1) {
      e.preventDefault();
      state.blocks[idx].src = val;
      const next = state.blocks[idx + 1];
      const nextEl = blockEls(next.id);
      state.blocks[idx].src += next.src ? "\n" + next.src : "";
      state.blocks.splice(idx + 1, 1);
      if (nextEl) nextEl.remove();
      const b = state.blocks[idx];
      state.activeId = null;
      repaint(b.id);
      activate(b.id, val.length);
    }
    return;
  }

  if (e.key === "ArrowUp" && !e.shiftKey) {
    if (val.lastIndexOf("\n", pos - 1) === -1 && idx > 0) {
      e.preventDefault();
      const prev = state.blocks[idx - 1];
      const lastLine = prev.src.length - (prev.src.lastIndexOf("\n") + 1);
      activate(prev.id, prev.src.length - lastLine + Math.min(pos, lastLine));
    }
    return;
  }
  if (e.key === "ArrowDown" && !e.shiftKey) {
    if (val.indexOf("\n", pos) === -1 && idx >= 0 && idx < state.blocks.length - 1) {
      e.preventDefault();
      const col = pos - (val.lastIndexOf("\n", pos - 1) + 1);
      const next = state.blocks[idx + 1];
      const firstLine = next.src.indexOf("\n") === -1 ? next.src.length : next.src.indexOf("\n");
      activate(next.id, Math.min(col, firstLine));
    }
    return;
  }
  if (e.key === "ArrowLeft" && pos === 0 && end === 0 && idx > 0) {
    e.preventDefault(); activate(state.blocks[idx - 1].id); return;
  }
  if (e.key === "ArrowRight" && pos === val.length && end === val.length && idx < state.blocks.length - 1) {
    e.preventDefault(); activate(state.blocks[idx + 1].id, 0);
  }
}

export function wrapSel(ta, a, b){
  const s = ta.selectionStart, e = ta.selectionEnd;
  const sel = ta.value.slice(s, e);
  if (sel) {
    const already = ta.value.slice(s - a.length, s) === a && ta.value.slice(e, e + b.length) === b;
    if (already) {
      ta.value = ta.value.slice(0, s - a.length) + sel + ta.value.slice(e + b.length);
      ta.setSelectionRange(s - a.length, e - a.length);
    } else {
      ta.value = ta.value.slice(0, s) + a + sel + b + ta.value.slice(e);
      ta.setSelectionRange(s + a.length, e + a.length);
    }
  } else {
    ta.value = ta.value.slice(0, s) + a + b + ta.value.slice(s);
    ta.setSelectionRange(s + a.length, s + a.length);
  }
  ta.dispatchEvent(new Event("input"));
}

export function linkSel(ta, url){
  const s = ta.selectionStart, e = ta.selectionEnd;
  const sel = ta.value.slice(s, e) || "text";
  if (url) {
    const md = "[" + sel + "](" + url + ")";
    ta.value = ta.value.slice(0, s) + md + ta.value.slice(e);
    ta.setSelectionRange(s + md.length, s + md.length);
    ta.dispatchEvent(new Event("input"));
    return;
  }
  const isUrl = /^(https?:\/\/|mailto:|\/|#)/.test(sel);
  const md = isUrl ? "[](" + sel + ")" : "[" + sel + "](url)";
  ta.value = ta.value.slice(0, s) + md + ta.value.slice(e);
  const caret = isUrl ? s + 1 : s + sel.length + 3;
  ta.setSelectionRange(caret, isUrl ? caret : caret + 3);
  ta.dispatchEvent(new Event("input"));
}

export function setHeading(ta, level){
  const ls = ta.value.lastIndexOf("\n", ta.selectionStart - 1) + 1;
  const le = ta.value.indexOf("\n", ls) === -1 ? ta.value.length : ta.value.indexOf("\n", ls);
  const line = ta.value.slice(ls, le).replace(/^\s{0,3}#{1,6}\s*/, "");
  const next = (level ? "#".repeat(level) + " " : "") + line;
  ta.value = ta.value.slice(0, ls) + next + ta.value.slice(le);
  ta.setSelectionRange(ls + next.length, ls + next.length);
  ta.dispatchEvent(new Event("input"));
}

function onPaste(e){
  const data = e.clipboardData;
  if (!data) return;

  if (imageHandler) {
    for (const it of data.items || []) {
      if (it.type && it.type.startsWith("image/")) {
        const file = it.getAsFile();
        if (!file) continue;
        e.preventDefault();
        imageHandler(file, md => insertAt(e.target, md));
        return;
      }
    }
  }

  /* rich text becomes markdown rather than a wall of tags */
  if (htmlPasteHandler && !e.shiftKey) {
    const html = data.getData("text/html");
    if (html && blockType(e.target.value) !== "code") {
      const md = htmlPasteHandler(html, data.getData("text/plain"));
      if (md != null) { e.preventDefault(); insertAt(e.target, md); }
    }
  }
}

/* ---- clicking into a block ----------------------------------------------- */
function srcOffsetFor(src, plain, n){
  let si = 0, pi = 0;
  while (si < src.length && pi < n) {
    if (src[si] === plain[pi]) { si++; pi++; }
    else si++;
  }
  return si;
}

function caretFromClick(el, block, ev){
  let range = null;
  if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(ev.clientX, ev.clientY);
  else if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(ev.clientX, ev.clientY);
    if (p) { range = document.createRange(); range.setStart(p.offsetNode, p.offset); }
  }
  const rendered = el.querySelector(".rendered");
  if (!range || !rendered || !rendered.contains(range.startContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(rendered);
  pre.setEnd(range.startContainer, range.startOffset);
  return srcOffsetFor(block.src, rendered.textContent, pre.toString().length);
}

function onPaperDown(e){
  if (e.target.closest("a")) return;
  const el = e.target.closest(".block");
  if (!el) return;
  if (e.target.matches('input[type="checkbox"]')) { toggleTask(el, e.target); e.preventDefault(); return; }
  const b = state.blocks[blockIndex(+el.dataset.id)];
  if (!b || b.id === state.activeId) return;
  e.preventDefault();
  activate(b.id, caretFromClick(el, b, e));
}

function onPaperClick(e){
  if (e.target !== paper) return;
  const last = state.blocks[state.blocks.length - 1];
  if (last && !last.src.trim()) return activate(last.id);
  const nb = mkBlock("");
  state.blocks.push(nb);
  paper.appendChild(blockEl(nb));
  activate(nb.id, 0);
}

export function toggleTask(el, box){
  const idx = blockIndex(+el.dataset.id);
  if (idx < 0) return;
  const boxes = Array.from(el.querySelectorAll('input[type="checkbox"]'));
  const n = boxes.indexOf(box);
  let seen = -1;
  state.blocks[idx].src = state.blocks[idx].src.replace(/\[([ xX])\]/g, (m, c) => {
    seen++;
    return seen === n ? (c.toLowerCase() === "x" ? "[ ]" : "[x]") : m;
  });
  repaint(state.blocks[idx].id);
  emit("change", true);
}

export function insertBlockAfter(src){
  const idx = state.activeId != null ? blockIndex(state.activeId) : state.blocks.length - 1;
  commit();
  const nb = mkBlock(src);
  state.blocks.splice(Math.min(idx + 1, state.blocks.length), 0, nb);
  renderAll();
  activate(nb.id, src.indexOf("\n") + 1);
  emit("change", true);
}
