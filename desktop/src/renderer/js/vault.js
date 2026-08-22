/* ===========================================================================
   The sidebar: file tree, outline, vault-wide search, tags and backlinks.
   Everything here talks to disk through window.inkju, never directly.
   =========================================================================== */
import { $, $$ } from "./editor.js";
import { dialog, say, askText } from "./dialogs.js";

const api = window.inkju;

export const vault = { root: null, tree: [], collapsed: new Set(), stats: null };
let openFile = () => {};
let activePath = null;

export function setOpener(fn){ openFile = fn; }
/* Renaming a vault moves every file in it, so the app repoints its open tabs. */
let remapPaths = () => {};
export function setPathRemap(fn){ remapPaths = fn; }
let toast = () => {};
export function setToast(fn){ toast = fn; }
export function setActivePath(p){
  activePath = p;
  $$(".tree-item").forEach(el => el.classList.toggle("on", el.dataset.path === p));
}

/* ---- tree ---------------------------------------------------------------- */
const icon = {
  dir: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  chevron: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M9 6l6 6-6 6"/></svg>'
};

export async function openVaultDialog(){
  const res = await api.vault.openDialog();
  if (!res) return;
  applyVault(res);
}
export async function restoreVault(root){
  if (!root) return;
  try { applyVault(await api.vault.open(root)); }
  catch (err) { /* the folder moved or was deleted: start without one */ }
}
export async function refreshVault(){
  if (!vault.root) return;
  const res = await api.vault.tree();
  if (res) applyVault(res, true);
}
function applyVault(res, keepScroll){
  if (!res) return;
  vault.root = res.root;
  vault.tree = res.tree;
  vault.stats = res.stats;
  const host = $("#tree");
  const top = keepScroll ? host.parentElement.scrollTop : 0;
  drawTree();
  host.parentElement.scrollTop = top;
  drawVaultName();
}

/* Paths are long and the interesting end is the right-hand one. Trim whole
   folders off the front rather than leaning on CSS: direction:rtl truncates
   from the correct side but reorders the leading slash, so "/Users/…" renders
   as "Users/…". */
export function shortPath(p, max = 46){
  if (!p || p.length <= max) return p || "";
  const parts = p.split("/").filter(Boolean);
  let out = parts.pop() || "";
  while (parts.length && out.length + parts[parts.length - 1].length + 1 <= max - 2) {
    out = parts.pop() + "/" + out;
  }
  return "\u2026/" + out;
}

export const vaultName = () => (vault.root ? vault.root.split(/[\\/]/).filter(Boolean).pop() : null);

function drawVaultName(){
  const el = $("#vault-name"), sub = $("#vault-sub"), bar = $("#vault-bar");
  if (!el) return;
  if (!vault.root) {
    el.textContent = "No vault";
    if (sub) sub.textContent = "Click to open a folder of notes";
    if (bar) bar.title = "Open a vault";
    return;
  }
  el.textContent = vaultName();
  if (sub) {
    sub.textContent = vault.stats
      ? vault.stats.files + (vault.stats.files === 1 ? " note" : " notes") + "  \u00b7  " + vault.stats.words.toLocaleString() + " words"
      : shortPath(vault.root);
  }
  if (bar) bar.title = vault.root;
}

export function drawTree(){
  const host = $("#tree");
  host.textContent = "";
  if (!vault.root) {
    host.innerHTML = '<div class="side-empty">No vault open.<br>A vault is just a folder of markdown files — open one to browse, search and link across notes.</div>';
    return;
  }
  if (!vault.tree.length) {
    host.innerHTML = '<div class="side-empty">This folder has no markdown files yet.</div>';
    return;
  }
  host.appendChild(nodeList(vault.tree, 0));
  setActivePath(activePath);
}

function nodeList(nodes, depth){
  const frag = document.createDocumentFragment();
  for (const n of nodes) {
    const row = document.createElement("button");
    row.className = "tree-item" + (n.kind === "dir" ? " dir" : "");
    row.style.paddingLeft = 8 + depth * 12 + "px";
    row.dataset.path = n.path;
    row.title = n.name;

    if (n.kind === "dir") {
      const open = !vault.collapsed.has(n.path);
      row.innerHTML = icon.chevron + icon.dir;
      row.classList.toggle("open", open);
      row.appendChild(document.createTextNode(n.name));
      row.onclick = () => {
        if (open) vault.collapsed.add(n.path); else vault.collapsed.delete(n.path);
        drawTree();
      };
      frag.appendChild(row);
      if (open) frag.appendChild(nodeList(n.children, depth + 1));
    } else {
      row.innerHTML = icon.file;
      row.appendChild(document.createTextNode(n.name.replace(/\.(md|markdown|mdown|mkd)$/i, "")));
      row.onclick = () => openFile(n.path);
      frag.appendChild(row);
    }
    row.oncontextmenu = e => { e.preventDefault(); contextMenu(e, n); };
  }
  return frag;
}

/* ---- menus --------------------------------------------------------------- */
/* One menu element serves the tree rows and the vault bar. An item is "-" for a
   rule, {head, sub} for a caption, or {label, run, danger}. */
function buildMenu(items){
  const menu = $("#ctx");
  menu.textContent = "";
  menu.className = "";
  for (const it of items) {
    if (!it) continue;
    if (it === "-") { menu.appendChild(document.createElement("hr")); continue; }
    if (it.head != null) {
      const h = document.createElement("div");
      h.className = "ctx-head";
      h.appendChild(document.createTextNode(it.head));
      if (it.sub) {
        const small = document.createElement("small");
        small.textContent = it.sub;
        h.appendChild(small);
      }
      menu.appendChild(h);
      continue;
    }
    const b = document.createElement("button");
    b.textContent = it.label;
    if (it.danger) b.className = "danger";
    b.onclick = () => { hideCtx(); it.run(); };
    menu.appendChild(b);
  }
  return menu;
}

/* Show it, then measure: the menu has no size until it is displayed, and an
   unmeasured one hangs off the bottom of a short window. */
function showMenuAt(menu, x, y){
  menu.classList.add("on");
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 6)) + "px";
  menu.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 6)) + "px";
}

/* Everything you can do to a vault, hanging off the bar that names it. */
export function vaultMenu(anchor){
  if (!vault.root) return openVaultDialog();
  const open = $("#ctx");
  if (open.classList.contains("on") && open.classList.contains("anchored")) return hideCtx();
  const bar = anchor || $("#vault-bar");
  const finder = api.platform === "darwin" ? "Finder" : "file manager";
  const menu = buildMenu([
    { head: vaultName(), sub: shortPath(vault.root) },
    "-",
    { label: "New note in this vault\u2026", run: () => newNote(vault.root) },
    { label: "Reveal in " + finder, run: () => api.file.reveal(vault.root) },
    { label: "Copy path", run: copyVaultPath },
    "-",
    { label: "Rename vault\u2026", run: renameVault },
    { label: "Open a different vault\u2026", run: openVaultDialog },
    { label: "Close vault", run: closeVault }
  ]);
  menu.classList.add("anchored");
  const r = bar.getBoundingClientRect();
  menu.style.minWidth = r.width + "px";
  showMenuAt(menu, r.left, r.bottom + 6);
  bar.classList.add("open");
  bar.setAttribute("aria-expanded", "true");
}

async function copyVaultPath(){
  try { await api.system.copy(vault.root); toast("Vault path copied"); }
  catch (err) { say(err.message, "Could not copy the path"); }
}

async function renameVault(){
  const current = vaultName();
  const next = await askText(
    "This renames the vault folder on disk. The notes inside it are untouched.",
    current, { title: "Rename vault", label: "Folder name", ok: "Rename" }
  );
  if (!next || next === current) return;
  try {
    const res = await api.vault.rename(vault.root, next);
    /* every open tab inside the vault now lives at a new path */
    if (res.from && res.root !== res.from) remapPaths(res.from, res.root);
    applyVault(res, true);
    toast("Vault renamed to " + vaultName());
  } catch (err) { say(err.message, "Could not rename the vault"); }
}

async function closeVault(){
  const name = vaultName();
  const yes = await dialog({
    title: "Close this vault?",
    message: "Inkju will stop showing \u201c" + name + "\u201d in the sidebar. Nothing is deleted, and any tabs you have open stay open.",
    buttons: [{ label: "Cancel", value: false }, { label: "Close vault", value: true }]
  });
  if (!yes) return;
  try { await api.vault.close(); } catch (err) { /* forgetting it locally is enough */ }
  vault.root = null; vault.tree = []; vault.stats = null; vault.collapsed.clear();
  drawTree();
  drawVaultName();
}

/* ---- context menu -------------------------------------------------------- */
function contextMenu(e, node){
  const menu = $("#ctx");
  menu.textContent = "";
  menu.className = "";
  const add = (label, fn, danger) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (danger) b.className = "danger";
    b.onclick = () => { hideCtx(); fn(); };
    menu.appendChild(b);
  };
  if (node.kind === "dir") {
    add("New note here…", () => newNote(node.path));
    add("New folder…", () => say("Create folders in your file manager for now.", "Not yet"));
  } else {
    add("Open", () => openFile(node.path));
    add("Rename…", () => renameNode(node));
  }
  menu.appendChild(document.createElement("hr"));
  add("Reveal in " + (api.platform === "darwin" ? "Finder" : "file manager"), () => api.file.reveal(node.path));
  if (node.kind === "file") add("Move to Trash", () => trashNode(node), true);

  menu.style.minWidth = "";
  showMenuAt(menu, e.clientX, e.clientY);
}
export function hideCtx(){
  const m = $("#ctx");
  if (m) { m.classList.remove("on", "anchored"); m.style.minWidth = ""; }
  const bar = $("#vault-bar");
  if (bar) { bar.classList.remove("open"); bar.setAttribute("aria-expanded", "false"); }
}

export async function newNote(dir){
  const name = await askText("What should the note be called?", "Untitled", { title: "New note", label: "Name", ok: "Create" });
  if (!name) return;
  try {
    const f = await api.file.create(dir || vault.root, name.endsWith(".md") ? name : name + ".md", "# " + name.replace(/\.md$/, "") + "\n\n");
    await refreshVault();
    openFile(f.path);
  } catch (err) { say(err.message, "Could not create the note"); }
}

async function renameNode(node){
  const next = await askText("Rename this note.", node.name, { title: "Rename", label: "File name", ok: "Rename" });
  if (!next) return;
  try {
    const f = await api.file.rename(node.path, next);
    await refreshVault();
    if (activePath === node.path) openFile(f.path);
  } catch (err) { say(err.message, "Rename failed"); }
}

async function trashNode(node){
  const yes = await dialog({
    title: "Move to Trash?",
    message: node.name + " will be moved to the system Trash. You can put it back from there.",
    buttons: [{ label: "Cancel", value: false }, { label: "Move to Trash", value: true, danger: true }]
  });
  if (!yes) return;
  try { await api.file.remove(node.path); await refreshVault(); }
  catch (err) { say(err.message, "Could not delete"); }
}

/* ---- vault search -------------------------------------------------------- */
let searchTimer = null;
export function mountSearch(){
  const input = $("#vs-q");
  const run = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runVaultSearch, 180);
  };
  input.addEventListener("input", run);
  ["vs-case", "vs-word", "vs-re"].forEach(id => $("#" + id).addEventListener("change", runVaultSearch));
  input.addEventListener("keydown", e => { if (e.key === "Escape") { input.value = ""; runVaultSearch(); } });
}

export async function runVaultSearch(){
  const host = $("#vs-results");
  const q = $("#vs-q").value;
  if (!vault.root) { host.innerHTML = '<div class="side-empty">Open a vault to search across notes.</div>'; return; }
  if (!q.trim()) { host.innerHTML = '<div class="side-empty">Type to search every note in the vault.</div>'; return; }

  const res = await api.vault.search(q, {
    caseSensitive: $("#vs-case").checked,
    word: $("#vs-word").checked,
    regex: $("#vs-re").checked
  });
  if (res.error) { host.innerHTML = '<div class="side-empty">' + res.error + "</div>"; return; }
  if (!res.results.length) { host.innerHTML = '<div class="side-empty">Nothing matched.</div>'; return; }

  host.textContent = "";
  const head = document.createElement("div");
  head.className = "side-h";
  head.textContent = res.total + " match" + (res.total === 1 ? "" : "es") + " in " + res.results.length + " note" + (res.results.length === 1 ? "" : "s");
  host.appendChild(head);

  for (const r of res.results) {
    const group = document.createElement("div");
    group.className = "vs-file";
    const title = document.createElement("button");
    title.className = "tree-item";
    title.innerHTML = icon.file;
    title.appendChild(document.createTextNode(r.name.replace(/\.md$/i, "")));
    title.onclick = () => openFile(r.path, { find: q });
    group.appendChild(title);
    for (const h of r.hits) {
      const line = document.createElement("button");
      line.className = "vs-hit";
      line.appendChild(Object.assign(document.createElement("span"), { className: "ln", textContent: h.line }));
      const frag = document.createElement("span");
      frag.appendChild(document.createTextNode(h.before));
      frag.appendChild(Object.assign(document.createElement("mark"), { textContent: h.match }));
      frag.appendChild(document.createTextNode(h.after));
      line.appendChild(frag);
      line.onclick = () => openFile(r.path, { find: q, line: h.line });
      group.appendChild(line);
    }
    host.appendChild(group);
  }
}

/* ---- tags and backlinks --------------------------------------------------- */
export async function drawTags(currentName, docText){
  const host = $("#pane-tags");
  host.textContent = "";
  const h = t => host.appendChild(Object.assign(document.createElement("div"), { className: "side-h", textContent: t }));

  const local = new Map();
  const re = /(^|[\s(])#([A-Za-z][\w/-]{0,40})/g;
  let m;
  while ((m = re.exec(docText || ""))) local.set(m[2], (local.get(m[2]) || 0) + 1);

  h("In this note");
  if (!local.size) host.appendChild(Object.assign(document.createElement("div"), { className: "side-empty", textContent: "Write #like-this to tag a note." }));
  else host.appendChild(chips(Array.from(local.entries()).map(([tag, n]) => ({ tag, n }))));

  if (vault.root) {
    const all = await api.vault.tags();
    h("Across the vault");
    host.appendChild(all.length ? chips(all.slice(0, 60)) :
      Object.assign(document.createElement("div"), { className: "side-empty", textContent: "No tags found yet." }));

    h("Linked from");
    const back = await api.vault.backlinks(currentName || "");
    if (!back.length) host.appendChild(Object.assign(document.createElement("div"), { className: "side-empty", textContent: "Nothing links here yet." }));
    else back.forEach(b => {
      const row = document.createElement("button");
      row.className = "tree-item";
      row.innerHTML = icon.file;
      row.appendChild(document.createTextNode(b.name.replace(/\.md$/i, "")));
      row.title = b.contexts.join("\n\n");
      row.onclick = () => openFile(b.path);
      host.appendChild(row);
    });
  }
}

function chips(list){
  const row = document.createElement("div");
  row.className = "tagrow";
  list.forEach(({ tag, n }) => {
    const c = document.createElement("button");
    c.className = "tagchip";
    c.textContent = "#" + tag;
    c.appendChild(Object.assign(document.createElement("b"), { textContent: n }));
    c.onclick = async () => {
      if (!vault.root) return;
      $("#vs-q").value = "#" + tag;
      $("#vs-re").checked = false;
      const { setPane } = await import("./app.js");
      setPane("search");
      runVaultSearch();
    };
    row.appendChild(c);
  });
  return row;
}
