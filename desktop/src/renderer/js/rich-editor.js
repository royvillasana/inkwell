/* ===========================================================================
   Rich text mode — TipTap (ProseMirror) editing over the same markdown files.

   Inkwell's own editor reveals source one BLOCK at a time. This mode is the
   other half of that idea: syntax never appears at all, formatting is applied
   to the selection, and the document is still written back out as markdown.

   Markdown never leaves the disk format:
     opening   markdown -> renderDoc()  -> HTML -> TipTap
     saving    TipTap   -> getHTML()    -> turndown -> markdown
   Both halves are the converters the app already uses everywhere else.
   =========================================================================== */
import { renderDoc } from "./markdown.js";
import { htmlToMarkdown } from "./convert.js";

let T = null;              // the bundle
let editor = null;
let host = null;
let onChange = null;
let bubble = null;
let floater = null;
let slash = null;
let slashState = null;   // { from, query, items, sel }

export const isReady = () => !!editor;
/* the underlying TipTap instance, for callers that need ProseMirror directly */
export const instance = () => editor;

async function load(){
  if (T) return T;
  T = await import("../vendor/tiptap/tiptap.bundle.mjs");
  return T;
}

/* ---- open / close -------------------------------------------------------- */
export async function open(container, markdown, opts = {}){
  const lib = await load();
  onChange = opts.onChange || null;
  host = container;
  close();

  const holder = document.createElement("div");
  holder.className = "rich-doc rendered";
  container.textContent = "";
  container.appendChild(holder);
  buildBubble(container);
  buildFloater(container);
  buildSlash(container);

  editor = new lib.Editor({
    element: holder,
    content: mdToHTML(markdown),
    autofocus: opts.autofocus !== false ? "start" : false,
    editorProps: {
      attributes: { class: "rich-surface", spellcheck: String(opts.spellcheck !== false) },
      /* the slash menu has to win these keys before ProseMirror moves the caret */
      handleKeyDown: (view, event) => handleSlashKey(event)
    },
    extensions: [
      lib.StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        codeBlock: { HTMLAttributes: { class: "rich-code" } },
        link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: "noopener" } }
      }),
      lib.Highlight,
      lib.Typography,
      lib.Image.configure({ inline: false, allowBase64: true }),
      lib.Table.configure({ resizable: true, lastColumnResizable: false }),
      lib.TableRow, lib.TableHeader, lib.TableCell,
      lib.TaskList,
      lib.TaskItem.configure({ nested: true }),
      lib.Placeholder.configure({
        placeholder: 'Type "/" for blocks, or just write',
        showOnlyCurrent: true,
        includeChildren: false
      })
    ],
    onUpdate: () => { if (onChange) onChange(); watchSlash(); placeFloater(); },
    onSelectionUpdate: () => { placeBubble(); watchSlash(); placeFloater(); },
    onFocus: () => placeFloater(),
    onBlur: () => { hideBubble(); hideFloater(); closeSlash(); }
  });

  /* links open in the real browser rather than navigating the app */
  holder.addEventListener("click", e => {
    const a = e.target.closest("a[href]");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href");
    if (/^https?:|^mailto:/.test(href) && window.inkwell) window.inkwell.system.openExternal(href);
  });

  return editor;
}

export function close(){
  hideBubble();
  hideFloater();
  closeSlash();
  if (editor) { editor.destroy(); editor = null; }
}

export function focus(){ if (editor) editor.commands.focus(); }

/* ---- markdown in and out ------------------------------------------------- */
function mdToHTML(markdown){
  const html = renderDoc(markdown || "");
  /* Diagram hosts and KaTeX spans are rendered output, not editable structure.
     Keep the source visible as a code block so a round trip cannot lose it. */
  const box = document.createElement("div");
  box.innerHTML = html;
  box.querySelectorAll(".diagram[data-diagram]").forEach(el => {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.className = "language-mermaid";
    code.textContent = el.dataset.diagram || "";
    pre.appendChild(code);
    el.replaceWith(pre);
  });
  box.querySelectorAll(".math-block").forEach(el => {
    const tex = el.querySelector("annotation[encoding='application/x-tex']");
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.className = "language-math";
    code.textContent = tex ? tex.textContent : el.textContent;
    pre.appendChild(code);
    el.replaceWith(pre);
  });
  /* Our parser keeps "- a" and "- [ ] b" in one list when they sit in the same
     block — same bullet, same list. TipTap needs them apart: a task list is its
     own node type. Split each mixed <ul> into consecutive runs first. */
  box.querySelectorAll("ul").forEach(list => {
    const items = Array.from(list.children).filter(el => el.tagName === "LI");
    if (!items.some(li => li.classList.contains("task"))) return;

    const runs = [];
    items.forEach(li => {
      const task = li.classList.contains("task");
      const last = runs[runs.length - 1];
      if (last && last.task === task) last.items.push(li);
      else runs.push({ task, items: [li] });
    });

    const frag = document.createDocumentFragment();
    runs.forEach(run => {
      const ul = document.createElement("ul");
      if (run.task) ul.setAttribute("data-type", "taskList");
      run.items.forEach(li => {
        if (run.task) {
          const input = li.querySelector('input[type="checkbox"]');
          const span = li.querySelector("span");
          const inner = span ? span.innerHTML : li.innerHTML;
          li.setAttribute("data-type", "taskItem");
          li.setAttribute("data-checked", input && input.checked ? "true" : "false");
          li.innerHTML = "<p>" + inner + "</p>";
        }
        li.classList.remove("task", "done");
        if (!li.className) li.removeAttribute("class");
        ul.appendChild(li);
      });
      frag.appendChild(ul);
    });
    list.replaceWith(frag);
  });

  /* Hand code blocks to TipTap as plain text with the language on the class,
     which is where both TipTap and turndown look for it. Our renderer keeps
     the untouched source on the <pre>, so nothing is lost to highlighting. */
  box.querySelectorAll("pre").forEach(pre => {
    const langEl = pre.querySelector(".lang");
    const lang = langEl ? langEl.textContent.trim() : "";
    const code = pre.querySelector("code");
    const raw = pre.dataset.code != null ? pre.dataset.code : (code ? code.textContent : pre.textContent);
    const fresh = document.createElement("code");
    if (lang) fresh.className = "language-" + lang;
    else if (code && /language-/.test(code.className)) fresh.className = code.className;
    fresh.textContent = raw;
    pre.textContent = "";
    pre.removeAttribute("data-code");
    pre.appendChild(fresh);
  });

  box.querySelectorAll("button.copy, .lang, .gutter").forEach(el => el.remove());
  return box.innerHTML;
}

export function getMarkdown(){
  if (!editor) return null;
  const md = htmlToMarkdown(editor.getHTML(), { trusted: true });
  if (md == null) return null;
  /* Normalise before tightening: turndown pads list markers and leaves lines
     that look blank but hold spaces, which would hide the gaps from tighten(). */
  const clean = md
    .replace(/^[ \t]+$/gm, "")
    .replace(/^([ \t]*)[-*+][ \t]{2,}/gm, "$1- ");
  return tighten(clean).replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/* TipTap wraps every list item in a paragraph, which turndown reads as a LOOSE
   list and writes with a blank line between items. Close those back up so a
   round trip returns the list the writer actually typed. */
const ITEM = "[ \\t]*(?:[-*+]|\\d+[.)])[ \\t]";
function tighten(md){
  const re = new RegExp("^(" + ITEM + ".*)\\n\\n(?=" + ITEM + ")", "gm");
  let out = md, prev;
  do { prev = out; out = out.replace(re, "$1\n"); } while (out !== prev);
  return out;
}

export function setMarkdown(markdown){
  if (editor) editor.commands.setContent(mdToHTML(markdown), false);
}

export const wordCount = () => {
  if (!editor) return 0;
  return (editor.getText().match(/\S+/g) || []).length;
};

/* ---- selection bubble ---------------------------------------------------- */
const BUBBLE_ITEMS = [
  { cmd: "bold", label: "B", title: "Bold", style: "font-weight:800" },
  { cmd: "italic", label: "I", title: "Italic", style: "font-style:italic;font-family:Georgia,serif" },
  { cmd: "strike", label: "S", title: "Strikethrough", style: "text-decoration:line-through" },
  { cmd: "code", label: "‹›", title: "Inline code" },
  { cmd: "highlight", label: "▮", title: "Highlight" },
  { sep: true },
  { cmd: "h1", label: "H1", title: "Heading 1" },
  { cmd: "h2", label: "H2", title: "Heading 2" },
  { cmd: "quote", label: "❝", title: "Quote" },
  { cmd: "bullet", label: "•", title: "Bullet list" },
  { sep: true },
  { cmd: "link", label: "🔗", title: "Link" },
  { cmd: "clear", label: "⌫", title: "Clear formatting" }
];

function buildBubble(container){
  if (bubble && bubble.isConnected) return;
  bubble = document.createElement("div");
  bubble.id = "rich-bubble";
  BUBBLE_ITEMS.forEach(it => {
    if (it.sep) {
      bubble.appendChild(Object.assign(document.createElement("span"), { className: "sep" }));
      return;
    }
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = it.label;
    b.title = it.title;
    b.dataset.cmd = it.cmd;
    if (it.style) b.setAttribute("style", it.style);
    b.onmousedown = e => e.preventDefault();
    b.onclick = () => runBubble(it.cmd);
    bubble.appendChild(b);
  });
  (container.closest("#main") || document.body).appendChild(bubble);
}

function runBubble(cmd){
  if (!editor) return;
  const c = editor.chain().focus();
  if (cmd === "bold") c.toggleBold().run();
  else if (cmd === "italic") c.toggleItalic().run();
  else if (cmd === "strike") c.toggleStrike().run();
  else if (cmd === "code") c.toggleCode().run();
  else if (cmd === "highlight") c.toggleHighlight().run();
  else if (cmd === "h1") c.toggleHeading({ level: 1 }).run();
  else if (cmd === "h2") c.toggleHeading({ level: 2 }).run();
  else if (cmd === "quote") c.toggleBlockquote().run();
  else if (cmd === "bullet") c.toggleBulletList().run();
  else if (cmd === "clear") c.unsetAllMarks().clearNodes().run();
  else if (cmd === "link") {
    askLink(editor.getAttributes("link").href || "");
    return;
  }
  placeBubble();
}

let linkAsker = null;
export const setLinkAsker = fn => { linkAsker = fn; };
async function askLink(prev){
  if (!linkAsker) return;
  const href = await linkAsker(prev, { title: "Link", label: "URL", ok: "Apply" });
  if (href == null) return;
  if (!href) editor.chain().focus().unsetLink().run();
  else editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
  placeBubble();
}

function placeBubble(){
  if (!editor || !bubble) return;
  const { from, to, empty } = editor.state.selection;
  if (empty || from === to) return hideBubble();

  const a = editor.view.coordsAtPos(from);
  const b = editor.view.coordsAtPos(to);
  const left = (a.left + b.right) / 2;
  const top = Math.min(a.top, b.top);

  bubble.classList.add("on");
  const w = bubble.offsetWidth || 340;
  bubble.style.left = Math.max(12, Math.min(left - w / 2, window.innerWidth - w - 12)) + "px";
  bubble.style.top = Math.max(46, top - bubble.offsetHeight - 10) + "px";

  Array.from(bubble.querySelectorAll("button")).forEach(btn => {
    const c = btn.dataset.cmd;
    const on =
      c === "bold" ? editor.isActive("bold") :
      c === "italic" ? editor.isActive("italic") :
      c === "strike" ? editor.isActive("strike") :
      c === "code" ? editor.isActive("code") :
      c === "highlight" ? editor.isActive("highlight") :
      c === "h1" ? editor.isActive("heading", { level: 1 }) :
      c === "h2" ? editor.isActive("heading", { level: 2 }) :
      c === "quote" ? editor.isActive("blockquote") :
      c === "bullet" ? editor.isActive("bulletList") :
      c === "link" ? editor.isActive("link") : false;
    btn.classList.toggle("on", !!on);
  });
}
function hideBubble(){ if (bubble) bubble.classList.remove("on"); }

/* ---- floating menu -------------------------------------------------------
   TipTap's third menu shape: where the bubble menu acts on a SELECTION, this
   one offers blocks to insert, and shows whenever the caret sits on an empty
   line. It is the discovery path for everything the syntax used to announce. */
const ICON = {
  h1:'<path d="M4 5v14M12 5v14M4 12h8"/><path d="M17 9.5 19.5 8V19"/>',
  h2:'<path d="M4 5v14M11 5v14M4 12h7"/><path d="M15.5 9.2a2.4 2.4 0 1 1 3.9 2.5L15.5 19h4.4"/>',
  bullet:'<circle cx="4.6" cy="7" r="1.3"/><circle cx="4.6" cy="12" r="1.3"/><circle cx="4.6" cy="17" r="1.3"/><path d="M9 7h11M9 12h11M9 17h11"/>',
  task:'<rect x="3" y="4.6" width="6" height="6" rx="1.6"/><path d="M4.4 7.6 5.7 8.9 8 6.4"/><rect x="3" y="13.4" width="6" height="6" rx="1.6"/><path d="M12.5 7.6H21M12.5 16.4H21"/>',
  quote:'<path d="M7.5 6.5C5.6 7.6 4.5 9.4 4.5 11.6c0 2 1.2 3.4 2.9 3.4 1.5 0 2.6-1.1 2.6-2.6 0-1.4-1-2.5-2.4-2.5-.3 0-.5 0-.7.1.2-1 .9-2 2-2.7zM17 6.5c-1.9 1.1-3 2.9-3 5.1 0 2 1.2 3.4 2.9 3.4 1.5 0 2.6-1.1 2.6-2.6 0-1.4-1-2.5-2.4-2.5-.3 0-.5 0-.7.1.2-1 .9-2 2-2.7z"/>',
  code:'<path d="M8.5 7 3.5 12l5 5M15.5 7l5 5-5 5"/>',
  table:'<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 10h18M9.5 10v9.5M15.5 10v9.5"/>',
  math:'<path d="M5 5h11l-6.5 7L16 19H5"/><path d="M19.5 5v14"/>',
  diagram:'<rect x="3" y="3.5" width="7" height="5.5" rx="1.5"/><rect x="14" y="15" width="7" height="5.5" rx="1.5"/><path d="M6.5 9v4a2 2 0 0 0 2 2H14"/>',
  image:'<rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="8.5" cy="10" r="1.6"/><path d="m4 17 5-4.5 4 3.5 3-2.5 4 3.5"/>',
  rule:'<path d="M3 12h18"/>'
};

const FLOAT_ITEMS = [
  { key: "h1",      title: "Heading 1",      run: () => command("heading", 1) },
  { key: "h2",      title: "Heading 2",      run: () => command("heading", 2) },
  { key: "bullet",  title: "Bullet list",    run: () => command("bullet") },
  { key: "task",    title: "Task list",      run: () => command("task") },
  { key: "quote",   title: "Quote",          run: () => command("quote") },
  { key: "code",    title: "Code block",     run: () => command("codeblock") },
  { key: "table",   title: "Table",          run: () => command("table") },
  { key: "math",    title: "Maths block",    run: () => insertFenced("math") },
  { key: "diagram", title: "Diagram",        run: () => insertFenced("mermaid") },
  { key: "image",   title: "Image",          run: () => askImage() },
  { key: "rule",    title: "Divider",        run: () => command("hr") }
];

function svg(key){
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
         'stroke-linecap="round" stroke-linejoin="round">' + ICON[key] + "</svg>";
}

function buildFloater(container){
  if (floater && floater.isConnected) return;
  floater = document.createElement("div");
  floater.id = "rich-floating";
  FLOAT_ITEMS.forEach(it => {
    const b = document.createElement("button");
    b.type = "button";
    b.title = it.title;
    b.setAttribute("aria-label", it.title);
    b.innerHTML = svg(it.key);
    b.onmousedown = e => e.preventDefault();
    b.onclick = () => { it.run(); placeFloater(); };
    floater.appendChild(b);
  });
  (container.closest("#main") || document.body).appendChild(floater);
}

/* a fenced block with a language, which the block editor renders on the way out */
function insertFenced(lang){
  if (!editor) return;
  editor.chain().focus().insertContent({
    type: "codeBlock",
    attrs: { language: lang },
    content: [{ type: "text", text: lang === "mermaid" ? "graph TD\n  A[Start] --> B[End]" : "E = mc^2" }]
  }).run();
}

async function askImage(){
  if (!linkAsker || !editor) return;
  const src = await linkAsker("", { title: "Image", label: "Image URL or path", ok: "Insert" });
  if (src) command("image", src);
}

/* Shown when the caret sits on an empty block — the moment there is nothing to
   format and everything to insert. */
function placeFloater(){
  if (!editor || !floater) return hideFloater();
  const { state } = editor;
  const { empty, $from } = state.selection;
  const node = $from.parent;
  const onEmptyBlock = empty
    && node.isTextblock
    && node.content.size === 0
    && node.type.name !== "codeBlock";

  if (!onEmptyBlock || !editor.isFocused || slashOpen()) return hideFloater();

  const at = editor.view.coordsAtPos($from.pos);
  floater.classList.add("on");
  const w = floater.offsetWidth || 380;
  const left = Math.min(at.left, window.innerWidth - w - 16);
  floater.style.left = Math.max(12, left) + "px";
  floater.style.top = Math.min(at.bottom + 9, window.innerHeight - floater.offsetHeight - 12) + "px";
}
function hideFloater(){ if (floater) floater.classList.remove("on"); }

export const floatingMenuVisible = () => !!(floater && floater.classList.contains("on"));

/* ---- slash menu ----------------------------------------------------------
   Type "/" and the blocks come to you. Same vocabulary as the floating menu,
   but filterable and reachable without leaving the keyboard.                */
const SLASH_ITEMS = [
  { icon: "h1",      label: "Heading 1",     keys: "h1 title",        apply: c => c.toggleHeading({ level: 1 }).run() },
  { icon: "h2",      label: "Heading 2",     keys: "h2 subtitle",     apply: c => c.toggleHeading({ level: 2 }).run() },
  { icon: "h2",      label: "Heading 3",     keys: "h3",              apply: c => c.toggleHeading({ level: 3 }).run() },
  { icon: "bullet",  label: "Bullet list",   keys: "ul unordered",    apply: c => c.toggleBulletList().run() },
  { icon: "bullet",  label: "Numbered list", keys: "ol ordered",      apply: c => c.toggleOrderedList().run() },
  { icon: "task",    label: "Task list",     keys: "todo checkbox",   apply: c => c.toggleTaskList().run() },
  { icon: "quote",   label: "Quote",         keys: "blockquote",      apply: c => c.toggleBlockquote().run() },
  { icon: "code",    label: "Code block",    keys: "pre fence",       apply: c => c.toggleCodeBlock().run() },
  { icon: "table",   label: "Table",         keys: "grid",            apply: c => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { icon: "math",    label: "Maths block",   keys: "latex equation formula", apply: c => fenced(c, "math", "E = mc^2") },
  { icon: "diagram", label: "Diagram",       keys: "mermaid flowchart graph", apply: c => fenced(c, "mermaid", "graph TD\n  A[Start] --> B[End]") },
  { icon: "rule",    label: "Divider",       keys: "hr line separator", apply: c => c.setHorizontalRule().run() },
  { icon: "image",   label: "Image",         keys: "picture photo",   apply: c => { c.run(); askImage(); } },
  { icon: "date",    label: "Today's date",  keys: "now time",        apply: c => c.insertContent(new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })).run() }
];
ICON.date = '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>';

const slashOpen = () => !!slashState;

function buildSlash(container){
  if (slash && slash.isConnected) return;
  slash = document.createElement("div");
  slash.id = "rich-slash";
  (container.closest("#main") || document.body).appendChild(slash);
}

function fenced(chain, lang, text){
  return chain.insertContent({
    type: "codeBlock",
    attrs: { language: lang },
    content: [{ type: "text", text }]
  }).run();
}

/* Looks behind the caret for "/query" at a word boundary. */
function watchSlash(){
  if (!editor) return;
  const { state } = editor;
  const { empty, $from } = state.selection;
  if (!empty || $from.parent.type.name === "codeBlock") return closeSlash();

  const start = $from.start();
  const before = state.doc.textBetween(start, $from.pos, "\n", "\n");
  const m = before.match(/(?:^|\s)\/([\w+-]*)$/);
  if (!m) return closeSlash();

  const query = m[1];
  const from = $from.pos - query.length - 1;      // the "/" itself
  const items = SLASH_ITEMS.filter(it =>
    !query || (it.label + " " + it.keys).toLowerCase().includes(query.toLowerCase()));

  if (!items.length) return closeSlash();
  const keepSel = slashState && slashState.query === query ? slashState.sel : 0;
  slashState = { from, query, items, sel: Math.min(keepSel, items.length - 1) };
  drawSlash();
}

function drawSlash(){
  if (!slashState || !slash) return;
  slash.textContent = "";
  slashState.items.forEach((it, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "si" + (i === slashState.sel ? " sel" : "");
    b.innerHTML = '<span class="g">' + svg(it.icon) + "</span>";
    b.appendChild(Object.assign(document.createElement("span"), { textContent: it.label }));
    b.onmousedown = e => e.preventDefault();
    b.onclick = () => pickSlash(i);
    b.onmouseenter = () => { slashState.sel = i; markSlash(); };
    slash.appendChild(b);
  });
  slash.classList.add("on");

  const at = editor.view.coordsAtPos(slashState.from);
  const w = slash.offsetWidth || 250;
  const h = slash.offsetHeight || 260;
  slash.style.left = Math.max(12, Math.min(at.left, window.innerWidth - w - 16)) + "px";
  /* flip above the caret when there is no room below */
  const below = at.bottom + 8;
  slash.style.top = (below + h > window.innerHeight - 12 ? Math.max(12, at.top - h - 8) : below) + "px";
}

function markSlash(){
  if (!slash) return;
  Array.from(slash.children).forEach((el, i) => el.classList.toggle("sel", i === slashState.sel));
  const el = slash.children[slashState.sel];
  if (el) el.scrollIntoView({ block: "nearest" });
}

export function closeSlash(){
  slashState = null;
  if (slash) slash.classList.remove("on");
}

function pickSlash(i){
  if (!slashState || !editor) return;
  const it = slashState.items[i];
  const from = slashState.from;
  const to = editor.state.selection.from;
  closeSlash();
  if (!it) return;
  it.apply(editor.chain().focus().deleteRange({ from, to }));
}

/* Returns true when the menu consumed the key. */
function handleSlashKey(event){
  if (!slashState) return false;
  const k = event.key;
  if (k === "Escape") { closeSlash(); return true; }
  if (k === "ArrowDown") { slashState.sel = (slashState.sel + 1) % slashState.items.length; markSlash(); return true; }
  if (k === "ArrowUp") { slashState.sel = (slashState.sel - 1 + slashState.items.length) % slashState.items.length; markSlash(); return true; }
  if (k === "Enter" || k === "Tab") { pickSlash(slashState.sel); return true; }
  return false;
}

export const slashMenuVisible = () => !!(slash && slash.classList.contains("on"));

/* ---- commands the app's menus drive ------------------------------------- */
export function command(name, arg){
  if (!editor) return false;
  const c = editor.chain().focus();
  const map = {
    bold: () => c.toggleBold().run(),
    italic: () => c.toggleItalic().run(),
    code: () => c.toggleCode().run(),
    strike: () => c.toggleStrike().run(),
    highlight: () => c.toggleHighlight().run(),
    link: () => askLink(editor.getAttributes("link").href || ""),
    heading: () => (arg ? c.toggleHeading({ level: arg }).run() : c.setParagraph().run()),
    bullet: () => c.toggleBulletList().run(),
    ordered: () => c.toggleOrderedList().run(),
    task: () => c.toggleTaskList().run(),
    quote: () => c.toggleBlockquote().run(),
    codeblock: () => c.toggleCodeBlock().run(),
    hr: () => c.setHorizontalRule().run(),
    table: () => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    rowAfter: () => c.addRowAfter().run(),
    colAfter: () => c.addColumnAfter().run(),
    rowDel: () => c.deleteRow().run(),
    colDel: () => c.deleteColumn().run(),
    image: () => (arg ? c.setImage({ src: arg }).run() : false),
    undo: () => c.undo().run(),
    redo: () => c.redo().run()
  };
  if (!map[name]) return false;
  map[name]();
  return true;
}
