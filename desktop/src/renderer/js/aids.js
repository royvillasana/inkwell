/* ===========================================================================
   Writing aids: auto-pairing, the slash menu, table tools and the goal ring.
   These attach to the editor through its hooks rather than patching it.
   =========================================================================== */
import { EMOJI, blockType } from "./markdown.js";
import {
  $, $$, state, prefs, on, blockEls, blockIndex, commit, activate,
  activeTextarea, insertAt
} from "./editor.js";

/* ---- auto-pairing -------------------------------------------------------- */
const PAIRS = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'", "`": "`", "*": "*", "_": "_", "$": "$", "~": "~" };
const WRAPPERS = new Set(["*", "_", "`", "~", "=", '"', "'", "(", "[", "{", "$"]);

function autoPairKey(e){
  if (slashOpen && handleSlashKey(e)) { e.stopImmediatePropagation(); return; }
  if (!prefs.autopair) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const ta = e.target;
  const s = ta.selectionStart, en = ta.selectionEnd, v = ta.value;

  if (e.key === "Backspace" && s === en && s > 0) {
    const a = v[s - 1], b = v[s];
    if (PAIRS[a] && PAIRS[a] === b) {
      e.preventDefault(); e.stopImmediatePropagation();
      ta.value = v.slice(0, s - 1) + v.slice(s + 1);
      ta.setSelectionRange(s - 1, s - 1);
      ta.dispatchEvent(new Event("input"));
    }
    return;
  }
  if (e.key.length !== 1) return;

  if (s !== en && WRAPPERS.has(e.key)) {
    e.preventDefault(); e.stopImmediatePropagation();
    const close = PAIRS[e.key] || e.key;
    ta.value = v.slice(0, s) + e.key + v.slice(s, en) + close + v.slice(en);
    ta.setSelectionRange(s + 1, en + 1);
    ta.dispatchEvent(new Event("input"));
    return;
  }
  if (s === en && ")]}".includes(e.key) && v[s] === e.key) {
    e.preventDefault(); e.stopImmediatePropagation();
    ta.setSelectionRange(s + 1, s + 1);
    return;
  }
  if (s === en && "([{".includes(e.key)) {
    e.preventDefault(); e.stopImmediatePropagation();
    ta.value = v.slice(0, s) + e.key + PAIRS[e.key] + v.slice(s);
    ta.setSelectionRange(s + 1, s + 1);
    ta.dispatchEvent(new Event("input"));
  }
}

/* ---- slash menu ---------------------------------------------------------- */
export const SLASH = [
  { g: "#",  label: "Heading 1",     insert: "# " },
  { g: "#",  label: "Heading 2",     insert: "## " },
  { g: "#",  label: "Heading 3",     insert: "### " },
  { g: "•",  label: "Bullet list",   insert: "- " },
  { g: "1.", label: "Numbered list", insert: "1. " },
  { g: "☑",  label: "Task list",     insert: "- [ ] " },
  { g: "❝",  label: "Quote",         insert: "> " },
  { g: "‹›", label: "Code block",    insert: "```\n\n```",  kind: "block", caret: 4 },
  { g: "⊞",  label: "Table",         insert: "| Column | Column |\n| --- | --- |\n| cell | cell |", kind: "block", caret: 2 },
  { g: "—",  label: "Divider",       insert: "---",         kind: "block" },
  { g: "∑",  label: "Math block",    insert: "$$\n\n$$",    kind: "block", caret: 3 },
  { g: "⤳",  label: "Diagram",       insert: "```mermaid\ngraph TD\n  A[Start] --> B[End]\n```", kind: "block", caret: 12 },
  { g: "☰",  label: "Table of contents", insert: "[TOC]",   kind: "block" },
  { g: "🔗", label: "Link",          insert: "[](url)",     kind: "inline", caret: 1 },
  { g: "🖼",  label: "Image",         insert: "![](url)",    kind: "inline", caret: 2 },
  { g: "⁋",  label: "Footnote",      insert: "[^1]",        kind: "inline" },
  { g: "📅", label: "Today's date",  kind: "inline", dyn: () => new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) },
  { g: "⌚", label: "Timestamp",      kind: "inline", dyn: () => new Date().toLocaleString() }
];

let slashOpen = false, slashSel = 0, slashItems = [], slashTa = null, slashStart = 0;
export const isSlashOpen = () => slashOpen;

function openSlash(ta, start, query){
  slashTa = ta; slashStart = start;
  const q = query.toLowerCase();
  slashItems = SLASH.filter(x => x.label.toLowerCase().includes(q));
  if (q) {
    slashItems = slashItems.concat(
      Object.keys(EMOJI).filter(k => k.includes(q)).slice(0, 8)
        .map(k => ({ g: EMOJI[k], label: ":" + k + ":", insert: EMOJI[k], kind: "inline" })));
  }
  if (!slashItems.length) return closeSlash();
  slashSel = 0;
  paintSlash(ta);
}

function paintSlash(ta){
  const box = $("#slash");
  box.textContent = "";
  slashItems.forEach((it, i) => {
    const b = document.createElement("button");
    b.className = "si" + (i === 0 ? " sel" : "");
    const g = document.createElement("span");
    g.className = "g"; g.textContent = it.g;
    b.appendChild(g);
    b.appendChild(Object.assign(document.createElement("span"), { textContent: it.label }));
    b.onmousedown = ev => { ev.preventDefault(); runSlash(i); };
    box.appendChild(b);
  });
  const r = ta.closest(".block").getBoundingClientRect();
  box.style.left = Math.min(r.left, window.innerWidth - 268) + "px";
  box.style.top = Math.min(r.bottom + 6, window.innerHeight - 300) + "px";
  box.classList.add("on");
  slashOpen = true;
}
export function closeSlash(){ slashOpen = false; const b = $("#slash"); if (b) b.classList.remove("on"); }

function markSlash(){
  Array.from($("#slash").children).forEach((el, i) => el.classList.toggle("sel", i === slashSel));
  const el = $("#slash").children[slashSel];
  if (el) el.scrollIntoView({ block: "nearest" });
}
function handleSlashKey(e){
  if (e.key === "Escape")    { closeSlash(); return true; }
  if (e.key === "ArrowDown") { slashSel = (slashSel + 1) % slashItems.length; markSlash(); e.preventDefault(); return true; }
  if (e.key === "ArrowUp")   { slashSel = (slashSel - 1 + slashItems.length) % slashItems.length; markSlash(); e.preventDefault(); return true; }
  if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); runSlash(slashSel); return true; }
  return false;
}
function runSlash(i){
  const it = slashItems[i];
  closeSlash();
  if (!it || !slashTa) return;
  const ta = slashTa;
  const head = ta.value.slice(0, slashStart);
  const tail = ta.value.slice(ta.selectionStart);
  const text = it.dyn ? it.dyn() : it.insert;

  if (it.kind === "block" && !head.trim() && !tail.trim()) {
    ta.value = text;
    const c = it.caret != null ? (text.split("\n").slice(0, it.caret).join("\n").length || text.length) : text.length;
    ta.setSelectionRange(Math.min(c, text.length), Math.min(c, text.length));
    ta.dispatchEvent(new Event("input"));
    commit();
    return;
  }
  ta.value = head + text + tail;
  const caret = head.length + (it.caret != null && it.kind === "inline" ? it.caret : text.length);
  ta.setSelectionRange(caret, caret);
  ta.dispatchEvent(new Event("input"));
  ta.focus();
}
function slashWatch(ta){
  if (!ta) return closeSlash();
  const pos = ta.selectionStart;
  const line = ta.value.slice(ta.value.lastIndexOf("\n", pos - 1) + 1, pos);

  const slash = line.match(/(?:^|\s)\/([\w+-]*)$/);
  if (slash) return openSlash(ta, pos - slash[1].length - 1, slash[1]);

  /* ":emo" offers emoji, as Typora does */
  const colon = line.match(/(?:^|\s):([a-z0-9_+-]{2,})$/i);
  if (colon) return openEmoji(ta, pos - colon[1].length - 1, colon[1]);

  closeSlash();
}

function openEmoji(ta, start, query){
  const q = query.toLowerCase();
  const hits = Object.keys(EMOJI).filter(k => k.startsWith(q))
    .concat(Object.keys(EMOJI).filter(k => !k.startsWith(q) && k.includes(q)))
    .slice(0, 12);
  if (!hits.length) return closeSlash();
  slashTa = ta; slashStart = start;
  slashItems = hits.map(k => ({ g: EMOJI[k], label: ":" + k + ":", insert: EMOJI[k], kind: "inline" }));
  slashSel = 0;
  paintSlash(ta);
}

/* ---- table tools --------------------------------------------------------- */
const cellsOf = line => line.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());

function tableToText(rows, align){
  const w = [];
  rows.concat([align]).forEach(r => r.forEach((c, i) => { w[i] = Math.max(w[i] || 3, String(c).length); }));
  const pad = (c, i) => String(c) + " ".repeat(Math.max(0, w[i] - String(c).length));
  const sep = align.map((a, i) => {
    const n = Math.max(3, w[i]);
    return a === "center" ? ":" + "-".repeat(n - 2) + ":"
         : a === "right"  ? "-".repeat(n - 1) + ":"
         : a === "left"   ? ":" + "-".repeat(n - 1)
         : "-".repeat(n);
  });
  const out = ["| " + rows[0].map(pad).join(" | ") + " |", "| " + sep.join(" | ") + " |"];
  for (let i = 1; i < rows.length; i++) out.push("| " + rows[i].map(pad).join(" | ") + " |");
  return out.join("\n");
}
function readTable(src){
  const lines = src.split("\n").filter(l => l.trim());
  const rows = lines.filter((_, i) => i !== 1).map(cellsOf);
  const align = cellsOf(lines[1] || "").map(c =>
    /^:.*:$/.test(c) ? "center" : /:$/.test(c) ? "right" : /^:/.test(c) ? "left" : "");
  const cols = Math.max.apply(null, rows.map(r => r.length));
  rows.forEach(r => { while (r.length < cols) r.push(""); });
  while (align.length < cols) align.push("");
  return { rows, align };
}
function caretCell(ta){
  const pos = ta.selectionStart, v = ta.value;
  const lineNo = v.slice(0, pos).split("\n").length - 1;
  const lineStart = v.lastIndexOf("\n", pos - 1) + 1;
  const line = v.split("\n")[lineNo] || "";
  const col = (line.slice(0, pos - lineStart).match(/\|/g) || []).length - 1;
  return { row: Math.max(0, lineNo <= 1 ? 0 : lineNo - 1), col: Math.max(0, col) };
}
export function tableOp(op){
  const ta = activeTextarea();
  if (!ta) return;
  const { rows, align } = readTable(ta.value);
  const at = caretCell(ta);
  at.col = Math.max(0, Math.min(at.col, align.length - 1));
  at.row = Math.max(0, Math.min(at.row, rows.length - 1));
  const cols = align.length;
  if (op === "row+") rows.splice(Math.min(rows.length, at.row + 1), 0, new Array(cols).fill(""));
  if (op === "row-" && rows.length > 2 && at.row > 0) rows.splice(at.row, 1);
  if (op === "col+") { rows.forEach(r => r.splice(at.col + 1, 0, "")); align.splice(at.col + 1, 0, ""); }
  if (op === "col-" && cols > 1) { rows.forEach(r => r.splice(at.col, 1)); align.splice(at.col, 1); }
  if (["left", "center", "right"].includes(op)) align[at.col] = op;
  if (op === "none") align[at.col] = "";
  ta.value = tableToText(rows, align);
  const lines = ta.value.split("\n");
  const line = Math.min(lines.length - 1, at.row === 0 ? 0 : at.row + 1);
  const caret = lines.slice(0, line).join("\n").length + (line ? 1 : 0);
  ta.dispatchEvent(new Event("input"));
  ta.focus();
  ta.setSelectionRange(caret, caret);
  positionTableTools();
}
function buildTableTools(){
  const bar = $("#tabletools");
  if (bar.children.length) return;
  const add = (label, op, title) => {
    const b = document.createElement("button");
    b.textContent = label; b.title = title;
    b.onmousedown = e => e.preventDefault();
    b.onclick = () => tableOp(op);
    bar.appendChild(b);
  };
  const sep = () => bar.appendChild(Object.assign(document.createElement("span"), { className: "sep" }));
  add("+ row", "row+", "Add a row below"); add("− row", "row-", "Delete this row"); sep();
  add("+ col", "col+", "Add a column after"); add("− col", "col-", "Delete this column"); sep();
  add("⌐", "left", "Align left"); add("≡", "center", "Align centre"); add("¬", "right", "Align right");
}
export function positionTableTools(){
  const bar = $("#tabletools");
  if (!bar) return;
  const el = state.activeId != null ? blockEls(state.activeId) : null;
  const b = el && state.blocks[blockIndex(state.activeId)];
  if (!el || !b || blockType(b.src) !== "table") { bar.classList.remove("on"); return; }
  buildTableTools();
  const r = el.getBoundingClientRect();
  bar.style.left = r.left + "px";
  bar.style.top = Math.max(48, r.top - 34) + "px";
  bar.classList.add("on");
}

/* ---- writing goal -------------------------------------------------------- */
export function drawGoal(words){
  const host = $("#goal");
  if (!host) return;
  if (!prefs.goal) { host.style.display = "none"; return; }
  host.style.display = "flex";
  const pct = Math.min(1, words / prefs.goal);
  const C = 2 * Math.PI * 5.5;
  host.classList.toggle("done", pct >= 1);
  host.innerHTML = '<svg viewBox="0 0 16 16"><circle class="ring-bg" cx="8" cy="8" r="5.5"/>' +
    '<circle class="ring-fg" cx="8" cy="8" r="5.5" stroke-dasharray="' + (C * pct).toFixed(1) + " " + C.toFixed(1) + '"/></svg>' +
    "<span>" + words.toLocaleString() + " / " + prefs.goal.toLocaleString() + "</span>";
  host.title = "Writing goal";
}

/* ---- attach to the editor ------------------------------------------------ */
export function mountAids(){
  on("input", ta => { slashWatch(ta); positionTableTools(); });
  on("activate", () => positionTableTools());
  on("commit", () => { closeSlash(); const b = $("#tabletools"); if (b) b.classList.remove("on"); });

  /* auto-pair must see the key before the editor does, so it is captured */
  document.addEventListener("keydown", e => {
    if (e.target && e.target.classList && e.target.classList.contains("src")) autoPairKey(e);
  }, true);
}
