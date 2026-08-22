/* ===========================================================================
   Markdown engine — pure functions, no DOM, no app state.
   Shared verbatim with the single-file build of Inkju.
   =========================================================================== */
export const mdOptions = {
  lineNumbers: false,
  mermaid: false,        // desktop swaps in the real mermaid library
  numberEquations: false
};

/* The single-file build renders maths to MathML with the parser below.
   The desktop build installs KaTeX here instead, which covers all of LaTeX. */
let mathRenderer = null;
export function setMathRenderer(fn){ mathRenderer = fn; }

/* ===========================================================================
   1. MARKDOWN ENGINE
   Blocks are the unit of editing: a document is a list of source strings.
   =========================================================================== */
"use strict";

const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

/* ---- block splitting ---------------------------------------------------- */
const RE_ATX   = /^\s{0,3}#{1,6}(\s|$)/;

/* Whether the document being rendered came from somewhere other than this
   disk. See setUntrusted() below — this is document-scoped, not call-scoped. */
let untrusted = false;
const RE_HR    = /^\s{0,3}([-*_])[ \t]*(\1[ \t]*){2,}$/;
const RE_FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const RE_LI    = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)/;
const RE_QUOTE = /^\s{0,3}>/;
const RE_DELIM = /^\s{0,3}(#{1,6}(\s|$)|`{3,}|~{3,}|>)/;
const RE_TSEP  = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

function splitBlocks(text){
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;

  // YAML front matter, only at the very top of the file
  if (/^---\s*$/.test(lines[0] || "")) {
    let j = 1;
    while (j < lines.length && !/^(---|\.\.\.)\s*$/.test(lines[j])) j++;
    if (j < lines.length) { out.push(lines.slice(0, j + 1).join("\n")); i = j + 1; }
  }

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;                 // blank lines separate blocks

    let m = line.match(RE_FENCE);
    if (m) {                                    // fenced code
      const ch = m[1][0], n = m[1].length;
      const close = new RegExp("^\\s{0,3}\\" + ch + "{" + n + ",}\\s*$");
      let j = i + 1;
      while (j < lines.length && !close.test(lines[j])) j++;
      const end = Math.min(j, lines.length - 1);
      out.push(lines.slice(i, end + 1).join("\n"));
      i = end; continue;
    }
    if (RE_HR.test(line))  { out.push(line); continue; }
    if (RE_ATX.test(line)) { out.push(line); continue; }

    if (RE_QUOTE.test(line)) {                  // blockquote, with lazy continuation
      let j = i;
      while (j + 1 < lines.length && lines[j+1].trim() && !RE_ATX.test(lines[j+1]) && !RE_FENCE.test(lines[j+1])) j++;
      out.push(lines.slice(i, j + 1).join("\n")); i = j; continue;
    }

    if (line.includes("|") && lines[i+1] !== undefined && lines[i+1].includes("-") && RE_TSEP.test(lines[i+1])) {
      let j = i + 1;                            // table
      while (j + 1 < lines.length && lines[j+1].trim() && lines[j+1].includes("|")) j++;
      out.push(lines.slice(i, j + 1).join("\n")); i = j; continue;
    }

    if (RE_LI.test(line)) {                     // list, blank lines inside allowed
      const ordered = /^\s*\d/.test(line);
      let j = i;
      while (j + 1 < lines.length) {
        const nx = lines[j+1];
        if (!nx.trim()) {
          const nn = lines[j+2];
          // a blank line only stays inside the list for an indented continuation
          // or another item of the same kind; switching bullets to numbers splits
          if (nn && (/^\s{2,}\S/.test(nn) || (RE_LI.test(nn) && /^\s*\d/.test(nn) === ordered))) { j += 1; continue; }
          break;
        }
        if (RE_ATX.test(nx) || RE_FENCE.test(nx) || RE_HR.test(nx)) break;
        j++;
      }
      out.push(lines.slice(i, j + 1).join("\n")); i = j; continue;
    }

    if (/^\s{0,3}<[a-zA-Z!\/]/.test(line)) {    // raw HTML block
      let j = i;
      while (j + 1 < lines.length && lines[j+1].trim()) j++;
      out.push(lines.slice(i, j + 1).join("\n")); i = j; continue;
    }

    if (/^ {4,}\S/.test(line)) {                // indented code
      let j = i;
      while (j + 1 < lines.length && (/^ {4,}/.test(lines[j+1]) || !lines[j+1].trim())) j++;
      while (j > i && !lines[j].trim()) j--;
      out.push(lines.slice(i, j + 1).join("\n")); i = j; continue;
    }

    let j = i;                                  // paragraph
    while (j + 1 < lines.length && lines[j+1].trim() && !RE_DELIM.test(lines[j+1]) && !RE_LI.test(lines[j+1]) && !RE_HR.test(lines[j+1])) j++;
    out.push(lines.slice(i, j + 1).join("\n")); i = j;
  }

  return out.length ? out : [""];
}

/* ---- inline spans ------------------------------------------------------- */
/* Finished fragments are parked behind a sentinel so later passes cannot
   re-process their contents (e.g. underscores inside a URL).                */
const SENT = String.fromCharCode(1);
const RE_SENT = new RegExp(SENT + "(\\d+)" + SENT, "g");

/* A URL out of a document, made safe to put in an href or a src.

   The text has already been escaped by the time these run, so an attacker
   cannot break out of the attribute — but the *scheme* is still whatever the
   document said, and "javascript:" in an href is a script that runs on click.
   The renderer's CSP would refuse it and the desktop app now only hands http
   and https to the browser, but neither of those is a reason to emit it: a
   note is text, and text that came from someone else's Drive is text we did
   not write.

   Whitespace and control characters are stripped before the scheme is read,
   because "java\tscript:" and "java&#10;script:" are the same URL to a browser
   and a different string to a naive check. */
const UNSAFE_SCHEME = new RegExp("^[\\u0000-\\u0020]*(javascript|vbscript|data|about|blob)\\s*:", "i");
function safeUrl(url, opts){
  let u = String(url == null ? "" : url);
  const bare = u.replace(new RegExp("[\\u0000-\\u0020]", "g"), "");
  /* images may carry a data: URL — that is how a pasted screenshot is stored —
     but only a real image one, never a document that would be scripted */
  if (opts && opts.image && /^data:image\/(png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=]+$/i.test(bare)) {
    return u;
  }
  if (UNSAFE_SCHEME.test(bare)) return "#";
  return u;
}

function inline(md){
  const bin = [];
  const K = html => SENT + (bin.push(html) - 1) + SENT;
  let t = String(md);

  t = t.replace(/(`+)([\s\S]*?)\1/g, (_, f, c) => K("<code>" + esc(c.replace(/^ (.*) $/, "$1")) + "</code>"));
  t = t.replace(/\$\$([\s\S]+?)\$\$/g, (_, x) => K(tex2mml(x, true)));
  t = t.replace(/(^|[^\\$])\$([^\s$][^$\n]*?)\$(?!\d)/g, (_, pre, x) => pre + K(tex2mml(x, false)));
  t = t.replace(/\\([\\`*_{}\[\]()#+\-.!>~=|^$])/g, (_, c) => K(esc(c)));
  t = esc(t);
  t = t.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
      (_, page, label) => K('<a class="wiki" href="#" data-page="' + page.trim() + '">' + (label || page).trim() + "</a>"));

  t = t.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+["']([^"']*)["'])?\s*\)/g,
      (_, alt, src, ti) => K('<img src="' + safeUrl(src, { image: true }) + '" alt="' + alt + '"' + (ti ? ' title="' + ti + '"' : "") + ">"));
  t = t.replace(/\[\^([^\]\s]+)\]/g,
      (_, id) => K('<sup class="fnref"><a href="#fn-' + id + '">' + esc(id) + "</a></sup>"));
  t = t.replace(/\[([^\]]*)\]\(\s*([^)\s]*)(?:\s+["']([^"']*)["'])?\s*\)/g,
      (_, txt, href, ti) => K('<a href="' + safeUrl(href) + '"' + (ti ? ' title="' + ti + '"' : "") + ' target="_blank" rel="noopener">') + txt + K("</a>"));
  t = t.replace(/&lt;((?:https?|mailto):[^\s&]+)&gt;/g,
      (_, u) => K('<a href="' + u + '" target="_blank" rel="noopener">' + u + "</a>"));
  t = t.replace(/(^|[\s(])(https?:\/\/[^\s<>"']+[^\s<>"'.,:;)\]])/g,
      (_, pre, u) => pre + K('<a href="' + u + '" target="_blank" rel="noopener">' + u + "</a>"));

  t = t.replace(/\*\*\*([^\s][\s\S]*?)\*\*\*/g, "<strong><em>$1</em></strong>");
  t = t.replace(/\*\*([^\s][\s\S]*?)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^\w\\])__([^\s][\s\S]*?)__(?!\w)/g, "$1<strong>$2</strong>");
  t = t.replace(/(^|[^*\w])\*([^\s*][\s\S]*?)\*(?!\*)/g, "$1<em>$2</em>");
  t = t.replace(/(^|[^\w_])_([^\s_][\s\S]*?)_(?!\w)/g, "$1<em>$2</em>");
  t = t.replace(/~~([\s\S]+?)~~/g, "<del>$1</del>");
  t = t.replace(/==([\s\S]+?)==/g, "<mark>$1</mark>");
  t = t.replace(/\^([^\s^]+)\^/g, "<sup>$1</sup>");
  t = t.replace(/(  +|\\)\n/g, "<br>\n");
  t = emojify(t);
  t = t.replace(/(^|[\s(])#([A-Za-z][\w\/-]{0,40})/g,
      (_, pre, tag) => pre + '<a class="tag" href="#" data-tag="' + tag + '">#' + tag + "</a>");

  for (let n = 0; n < 8 && t.indexOf(SENT) >= 0; n++)
    t = t.replace(RE_SENT, (_, i) => bin[+i]);
  return t;
}

/* ---- syntax highlighting ------------------------------------------------ */
const KEYWORDS = {
  js: "await async break case catch class const continue default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while yield true false null undefined interface type enum implements public private readonly",
  python: "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self",
  clike: "auto bool break case catch char class const continue default delete do double else enum extern false float for friend goto if inline int long namespace new nullptr operator private protected public return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while func package var type map chan go defer range interface fn let mut impl pub match trait use crate mod where String",
  bash: "if then else elif fi for while do done case esac function return export local source alias echo cd ls set unset read exit sudo",
  sql: "select from where insert into values update set delete create table drop alter add join left right inner outer on group by order having limit offset distinct as and or not null primary key foreign references index union all",
  ruby: "def end class module if elsif else unless while until for do begin rescue ensure return yield self nil true false require attr_accessor puts"
};
const ALIAS = {
  javascript:"js", js:"js", jsx:"js", ts:"js", tsx:"js", typescript:"js", node:"js", json:"json",
  py:"python", python:"python", sh:"bash", shell:"bash", bash:"bash", zsh:"bash", console:"bash",
  html:"html", xml:"html", svg:"html", vue:"html", css:"css", scss:"css", less:"css",
  c:"clike", cpp:"clike", cs:"clike", csharp:"clike", java:"clike", go:"clike", golang:"clike",
  rust:"clike", rs:"clike", php:"clike", swift:"clike", kotlin:"clike", dart:"clike",
  rb:"ruby", ruby:"ruby", sql:"sql", yaml:"yaml", yml:"yaml", toml:"yaml", ini:"yaml", diff:"diff",
  // everything below reuses the closest tokenizer family
  scala:"clike", groovy:"clike", objc:"clike", "objective-c":"clike", m:"clike", zig:"clike", nim:"clike",
  v:"clike", d:"clike", haxe:"clike", solidity:"clike", sol:"clike", glsl:"clike", hlsl:"clike", cuda:"clike",
  arduino:"clike", processing:"clike", verilog:"clike", vhdl:"clike", pascal:"clike", delphi:"clike",
  lua:"clike", julia:"python", jl:"python", r:"python", rlang:"python", perl:"python", pl:"python",
  elixir:"ruby", ex:"ruby", exs:"ruby", erlang:"ruby", crystal:"ruby", haskell:"clike", hs:"clike",
  ocaml:"clike", fsharp:"clike", clojure:"clike", clj:"clike", lisp:"clike", scheme:"clike", racket:"clike",
  powershell:"bash", ps1:"bash", bat:"bash", cmd:"bash", fish:"bash", dockerfile:"bash", docker:"bash",
  makefile:"bash", make:"bash", cmake:"bash", nginx:"bash", apache:"bash", awk:"bash", sed:"bash",
  graphql:"clike", gql:"clike", proto:"clike", protobuf:"clike", thrift:"clike", prisma:"clike",
  hcl:"clike", terraform:"clike", tf:"clike", groovyscript:"clike", gradle:"clike", kt:"clike", kts:"clike",
  svelte:"html", astro:"html", jinja:"html", twig:"html", erb:"html", ejs:"html", handlebars:"html", hbs:"html",
  jsonc:"json", json5:"json", jsonl:"json", ndjson:"json", properties:"yaml", env:"yaml", dotenv:"yaml",
  sass:"css", stylus:"css", postcss:"css", tailwind:"css", plsql:"sql", tsql:"sql", mysql:"sql", psql:"sql"
};

function highlight(code, lang){
  const fam = ALIAS[String(lang || "").toLowerCase()];
  if (!fam) return esc(code);

  if (fam === "html") {
    return esc(code)
      .replace(/&lt;!--[\s\S]*?--&gt;/g, m => '<span class="tok-com">' + m + "</span>")
      .replace(/(&lt;\/?)([\w:-]+)([\s\S]*?)(\/?&gt;)/g, (_, o, name, attrs, c) =>
        '<span class="tok-punc">' + o + '</span><span class="tok-tag">' + name + "</span>" +
        attrs.replace(/([\w:-]+)(=)(&quot;[^&]*&quot;)?/g,
          (_, a, eq, v) => '<span class="tok-attr">' + a + "</span>" + eq + (v ? '<span class="tok-str">' + v + "</span>" : "")) +
        '<span class="tok-punc">' + c + "</span>");
  }
  if (fam === "diff") {
    return esc(code).split("\n").map(l =>
      l.startsWith("+") ? '<span class="tok-fn">' + l + "</span>" :
      l.startsWith("-") ? '<span class="tok-tag">' + l + "</span>" :
      l.startsWith("@") ? '<span class="tok-kw">' + l + "</span>" : l).join("\n");
  }
  if (fam === "yaml") {
    return esc(code).split("\n").map(l =>
      /^\s*#/.test(l) ? '<span class="tok-com">' + l + "</span>"
        : l.replace(/^(\s*-?\s*)([\w.-]+)(\s*:)/, '$1<span class="tok-kw">$2</span><span class="tok-punc">$3</span>')).join("\n");
  }
  if (fam === "css") {
    return esc(code)
      .replace(/\/\*[\s\S]*?\*\//g, m => '<span class="tok-com">' + m + "</span>")
      .replace(/^([^{}\n:]+)(\{)/gm, '<span class="tok-tag">$1</span>$2')
      .replace(/([\w-]+)(\s*:\s*)([^;{}\n]+)/g, '<span class="tok-attr">$1</span>$2<span class="tok-str">$3</span>');
  }
  if (fam === "json") {
    return esc(code)
      .replace(/(&quot;[^&]*?&quot;)(\s*:)/g, '<span class="tok-kw">$1</span>$2')
      .replace(/(:\s*)(&quot;[^&]*?&quot;)/g, '$1<span class="tok-str">$2</span>')
      .replace(/\b(true|false|null)\b/g, '<span class="tok-kw">$1</span>')
      .replace(/\b(-?\d+(?:\.\d+)?)\b/g, '<span class="tok-num">$1</span>');
  }

  const kw = new Set((KEYWORDS[fam] || "").split(" "));
  const rx = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d[\w.]*\b)|([A-Za-z_$][\w$]*)/g;
  let out = "", last = 0, m;
  while ((m = rx.exec(code))) {
    out += esc(code.slice(last, m.index));
    if (m[1])      out += '<span class="tok-com">' + esc(m[1]) + "</span>";
    else if (m[2]) out += '<span class="tok-str">' + esc(m[2]) + "</span>";
    else if (m[3]) out += '<span class="tok-num">' + esc(m[3]) + "</span>";
    else {
      const w = m[4];
      out += kw.has(w) ? '<span class="tok-kw">' + w + "</span>"
           : code[rx.lastIndex] === "(" ? '<span class="tok-fn">' + w + "</span>"
           : esc(w);
    }
    last = rx.lastIndex;
  }
  return out + esc(code.slice(last));
}

/* ---- block rendering ---------------------------------------------------- */
const slug = s => String(s).toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-") || "section";

function renderList(src){
  const items = [];
  let cur = null;
  for (const line of src.split("\n")) {
    const m = line.match(/^(\s*)([-*+]|\d{1,9}[.)])(?:\s+([\s\S]*)|\s*$)/);
    if (m) {
      cur = { indent: m[1].length, ordered: /\d/.test(m[2]), start: parseInt(m[2], 10) || 1,
              lines: [m[3] || ""], kids: [] };
      items.push(cur);
    } else if (cur) {
      cur.lines.push(line.replace(/^ {0,4}/, ""));
    }
  }
  const roots = [], stack = [];
  for (const it of items) {
    while (stack.length && stack[stack.length - 1].indent >= it.indent) stack.pop();
    if (stack.length) stack[stack.length - 1].kids.push(it); else roots.push(it);
    stack.push(it);
  }
  const emit = list => {
    if (!list.length) return "";
    // a run of siblings can switch marker kind; emit one list element per run
    let html = "";
    for (let a = 0; a < list.length; ) {
      let b = a + 1;
      while (b < list.length && list[b].ordered === list[a].ordered) b++;
      html += emitRun(list.slice(a, b));
      a = b;
    }
    return html;
  };
  const emitRun = list => {
    const ord = list[0].ordered;
    const tag = ord ? "ol" : "ul";
    const start = ord && list[0].start !== 1 ? ' start="' + list[0].start + '"' : "";
    let html = "<" + tag + start + ">";
    for (const it of list) {
      const body = it.lines.join("\n").replace(/\s+$/, "");
      const task = body.match(/^\[([ xX])\]\s*([\s\S]*)$/);
      let cls = "", innerHtml;
      if (task) {
        const done = task[1].toLowerCase() === "x";
        cls = ' class="task' + (done ? " done" : "") + '"';
        innerHtml = '<input type="checkbox" ' + (done ? "checked" : "") + "><span>" + inline(task[2]) + "</span>";
      } else {
        innerHtml = (/\n\s*\n/.test(body) || RE_FENCE.test(body.split("\n")[0])) ? renderDoc(body) : inline(body);
      }
      html += "<li" + cls + ">" + innerHtml + emit(it.kids) + "</li>";
    }
    return html + "</" + tag + ">";
  };
  return emit(roots);
}

function renderTable(src){
  const rows = src.split("\n").filter(l => l.trim());
  const cells = r => {
    const s = r.trim().replace(/^\|/, "").replace(/\|$/, "");
    const out = []; let buf = "";
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "\\" && s[i+1] === "|") { buf += "|"; i++; }
      else if (s[i] === "|") { out.push(buf); buf = ""; }
      else buf += s[i];
    }
    out.push(buf);
    return out.map(c => c.trim());
  };
  const head = cells(rows[0]);
  const align = cells(rows[1]).map(c =>
    /^:.*:$/.test(c) ? "center" : /:$/.test(c) ? "right" : /^:/.test(c) ? "left" : "");
  const at = i => align[i] ? ' style="text-align:' + align[i] + '"' : "";
  let html = "<table><thead><tr>";
  head.forEach((h, i) => { html += "<th" + at(i) + ">" + inline(h) + "</th>"; });
  html += "</tr></thead><tbody>";
  for (let r = 2; r < rows.length; r++) {
    const cs = cells(rows[r]);
    html += "<tr>";
    for (let i = 0; i < head.length; i++) html += "<td" + at(i) + ">" + inline(cs[i] || "") + "</td>";
    html += "</tr>";
  }
  return html + "</tbody></table>";
}

function renderBlock(src){
  const s = String(src);
  if (!s.trim()) return '<p class="empty-line"><br></p>';
  const first = s.split("\n")[0];

  if (/^---\s*$/.test(first) && /\n(---|\.\.\.)\s*$/.test(s))
    return '<div class="frontmatter">' + esc(s.replace(/^---\n?/, "").replace(/\n?(---|\.\.\.)\s*$/, "")) + "</div>";

  if (/^\s*\[TOC\]\s*$/i.test(s)) return renderTOC();
  if (/^\$\$[\s\S]*\$\$$/.test(s.trim()))
    return '<div class="math-block">' + tex2mml(s.trim().slice(2, -2), true) + "</div>";

  let m = first.match(RE_FENCE);
  if (m) {
    const lang = (m[2] || "").trim().split(/\s+/)[0];
    const all = s.split("\n").slice(1);
    if (all.length && RE_FENCE.test(all[all.length - 1])) all.pop();
    const code = all.join("\n");
    const lc = lang.toLowerCase();
    if (lc === "mermaid" || lc === "flow" || lc === "flowchart") {
      /* Real diagrams render asynchronously, so emit a host the app fills in
         after the block is painted; the fallback stays synchronous. */
      if (mdOptions.mermaid)
        return '<div class="diagram" data-diagram="' + esc(code) + '"><div class="diagram-wait">' +
               esc(code.split("\n")[0] || "diagram") + "…</div></div>";
      return renderFlow(code);
    }
    if (lc === "math" || lc === "latex" || lc === "tex")
      return '<div class="math-block">' + tex2mml(code, true) + "</div>";
    const numbered = !!mdOptions.lineNumbers;
    const gutter = numbered ? '<span class="gutter">' + code.split("\n").map((_, i) => i + 1).join("\n") + "</span>" : "";
    return '<pre' + (numbered ? ' class="numbered"' : "") + ' data-code="' + esc(code) + '">' +
           (lang ? '<span class="lang">' + esc(lang) + "</span>" : "") +
           '<button class="copy" type="button">copy</button>' + gutter +
           "<code>" + highlight(code, lang) + "</code></pre>";
  }
  if (RE_HR.test(first)) return "<hr>";

  m = first.match(/^\s{0,3}(#{1,6})\s*(.*?)\s*#*\s*$/);
  if (m) {
    const lv = m[1].length;
    return "<h" + lv + ' id="' + slug(m[2]) + '">' + inline(m[2]) + "</h" + lv + ">";
  }
  if (RE_QUOTE.test(first)) {
    const inner = s.split("\n").map(l => l.replace(/^\s{0,3}>\s?/, "")).join("\n");
    const callout = inner.match(/^\[!(\w+)\]\s*\n?([\s\S]*)$/);
    if (callout)
      return "<blockquote><p><strong>" + esc(callout[1].toUpperCase()) + "</strong></p>" + renderDoc(callout[2]) + "</blockquote>";
    return "<blockquote>" + renderDoc(inner) + "</blockquote>";
  }
  if (s.includes("|") && s.split("\n")[1] && RE_TSEP.test(s.split("\n")[1])) return renderTable(s);
  if (RE_LI.test(first)) return renderList(s);
  if (/^ {4,}\S/.test(first)) return "<pre><code>" + esc(s.replace(/^ {4}/gm, "")) + "</code></pre>";
  /* Raw HTML passes through, because that is what markdown does and people
     write it in their own notes on purpose. It does not pass through when the
     document came from somewhere else: see renderUntrusted below. */
  if (/^\s{0,3}<[a-zA-Z!\/]/.test(first)) return untrusted ? "<p>" + esc(s) + "</p>" : s;

  const lines = s.split("\n");
  if (lines.length >= 2 && /^\s{0,3}=+\s*$/.test(lines[lines.length - 1])) {
    const txt = lines.slice(0, -1).join("\n");
    return '<h1 id="' + slug(txt) + '">' + inline(txt) + "</h1>";
  }
  if (lines.length >= 2 && /^\s{0,3}-+\s*$/.test(lines[lines.length - 1])) {
    const txt = lines.slice(0, -1).join("\n");
    return '<h2 id="' + slug(txt) + '">' + inline(txt) + "</h2>";
  }

  const fn = s.match(/^\[\^([^\]\s]+)\]:\s*([\s\S]*)$/);
  if (fn) return '<div class="footnotes" id="fn-' + fn[1] + '"><strong>' + esc(fn[1]) + ".</strong> " + inline(fn[2]) + "</div>";

  return "<p>" + inline(s) + "</p>";
}

const renderDoc = text => splitBlocks(text).map(renderBlock).join("\n");

/* Render a document Inkju did not get off the user's own disk.

   The only difference is that raw HTML blocks are shown as text rather than
   inserted into the page. Inline HTML is already escaped for every document,
   and link schemes are already filtered for every document; this closes the
   one remaining hole, which markdown leaves open on purpose.

   The document itself is never altered — this changes how it is displayed, not
   what it says. A note fetched from a connection is still the note that is in
   the connection, byte for byte, and saving it back writes what the user typed
   rather than what we felt safe rendering.

   A flag rather than an argument because renderBlock recurses through blockquotes,
   list items and table cells; threading an option through all of them would
   leave exactly one path that forgot, and that path would be the interesting one. */
function renderUntrusted(text){
  const before = untrusted;
  untrusted = true;
  try { return renderDoc(text); }
  finally { untrusted = before; }
}

/* Mark the *document* as untrusted, for as long as it is the open document.

   The first version of this offered only renderUntrusted() and expected every
   caller to opt in. That was the wrong shape and it failed exactly as you would
   expect: there are six places that turn markdown into HTML — the block
   renderer, the split preview, presentation mode, the rich-text editor, the
   converter and the HTML exporter — and remote documents reached all six
   through the ordinary path, so the safe renderer was never called at all.

   Trust is a property of the document, not of the call site. It is set once,
   where a document is loaded, and every renderer inherits it without having to
   remember. Adding a seventh renderer later cannot reintroduce the hole. */
function setUntrusted(flag){ untrusted = !!flag; }
function isUntrusted(){ return untrusted; }

/* ---- block classification (drives live textarea styling + Enter rules) --- */
function blockType(src){
  const first = (src || "").split("\n")[0];
  if (/^---\s*$/.test(first) && /\n(---|\.\.\.)\s*$/.test(src)) return "front";
  if (RE_FENCE.test(first))    return "code";
  if (RE_QUOTE.test(first))    return "quote";
  if (RE_LI.test(first))       return "list";
  if (src.includes("|") && RE_TSEP.test(src.split("\n")[1] || "")) return "table";
  const h = first.match(/^\s{0,3}(#{1,6})\s/);
  if (h) return "h" + Math.min(3, h[1].length);
  return "p";
}
const MULTILINE = new Set(["front", "code", "quote", "list", "table"]);

/* ---- LaTeX to MathML ----------------------------------------------------
   Browsers render MathML natively, so real math needs no library at all.   */
const TEX_SYM = {
  alpha:"α",beta:"β",gamma:"γ",delta:"δ",epsilon:"ε",varepsilon:"ε",zeta:"ζ",eta:"η",
  theta:"θ",vartheta:"ϑ",iota:"ι",kappa:"κ",lambda:"λ",mu:"μ",nu:"ν",xi:"ξ",pi:"π",
  rho:"ρ",sigma:"σ",tau:"τ",upsilon:"υ",phi:"φ",varphi:"φ",chi:"χ",psi:"ψ",omega:"ω",
  Gamma:"Γ",Delta:"Δ",Theta:"Θ",Lambda:"Λ",Xi:"Ξ",Pi:"Π",Sigma:"Σ",Upsilon:"Υ",Phi:"Φ",Psi:"Ψ",Omega:"Ω",
  infty:"∞",partial:"∂",nabla:"∇",forall:"∀",exists:"∃",emptyset:"∅",varnothing:"∅",
  hbar:"ℏ",ell:"ℓ",Re:"ℜ",Im:"ℑ",aleph:"ℵ",degree:"°",prime:"′",dots:"…",ldots:"…",cdots:"⋯",vdots:"⋮",ddots:"⋱"
};
const TEX_OP = {
  times:"×",div:"÷",cdot:"⋅",pm:"±",mp:"∓",ast:"∗",star:"⋆",circ:"∘",bullet:"∙",
  leq:"≤",le:"≤",geq:"≥",ge:"≥",neq:"≠",ne:"≠",approx:"≈",equiv:"≡",sim:"∼",simeq:"≃",cong:"≅",
  propto:"∝",ll:"≪",gg:"≫",subset:"⊂",supset:"⊃",subseteq:"⊆",supseteq:"⊇",
  in:"∈",notin:"∉",ni:"∋",cup:"∪",cap:"∩",setminus:"∖",
  to:"→",rightarrow:"→",leftarrow:"←",leftrightarrow:"↔",Rightarrow:"⇒",Leftarrow:"⇐",Leftrightarrow:"⇔",
  mapsto:"↦",implies:"⟹",iff:"⟺",land:"∧",lor:"∨",neg:"¬",oplus:"⊕",otimes:"⊗",
  perp:"⊥",parallel:"∥",angle:"∠",triangle:"△",square:"□",checkmark:"✓"
};
const TEX_BIG = { sum:"∑", prod:"∏", coprod:"∐", int:"∫", iint:"∬", iiint:"∭", oint:"∮",
                  bigcup:"⋃", bigcap:"⋂", bigoplus:"⨁", bigotimes:"⨂", lim:"lim", limsup:"lim sup", liminf:"lim inf", max:"max", min:"min", sup:"sup", inf:"inf" };
const TEX_FN = ["sin","cos","tan","cot","sec","csc","arcsin","arccos","arctan","sinh","cosh","tanh",
                "log","ln","lg","exp","det","dim","ker","deg","gcd","arg","Pr","mod"];
const TEX_DELIM = { "(":"(", ")":")", "[":"[", "]":"]", "\\{":"{", "\\}":"}", "|":"|", "\\|":"‖",
                    "langle":"⟨", "rangle":"⟩", "lceil":"⌈", "rceil":"⌉", "lfloor":"⌊", "rfloor":"⌋", ".":"" };
const MATRIX_FENCE = { pmatrix:["(",")"], bmatrix:["[","]"], Bmatrix:["{","}"], vmatrix:["|","|"], Vmatrix:["‖","‖"], matrix:["",""], cases:["{",""], aligned:["",""], array:["",""] };

function lexTex(s){
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "\\") {
      const m = /^\\([a-zA-Z]+|.)/.exec(s.slice(i));
      if (!m) { i++; continue; }
      out.push({ t: "cmd", v: m[1] }); i += m[0].length; continue;
    }
    if ("{}^_&".includes(c)) { out.push({ t: c }); i++; continue; }
    if (/[0-9]/.test(c)) { const m = /^[0-9]*\.?[0-9]+/.exec(s.slice(i)); out.push({ t: "num", v: m[0] }); i += m[0].length; continue; }
    if (/[a-zA-Z]/.test(c)) { out.push({ t: "id", v: c }); i++; continue; }
    out.push({ t: "op", v: c }); i++;
  }
  return out;
}

function texParse(toks){
  let i = 0;
  const mo = (v, extra) => "<mo" + (extra || "") + ">" + esc(v) + "</mo>";
  const peek = () => toks[i];

  function group(){                              // one argument
    const t = peek();
    if (!t) return "<mrow></mrow>";
    if (t.t === "{") { i++; const r = list("}"); if (peek() && peek().t === "}") i++; return "<mrow>" + r + "</mrow>"; }
    return atom();          // a bare argument never takes the outer scripts
  }

  function matrix(kind){
    const rows = [];
    let cells = [], cell = [];
    while (i < toks.length) {
      const t = toks[i];
      if (t.t === "cmd" && t.v === "end") { i++; if (peek() && peek().t === "{") { i++; while (peek() && peek().t !== "}") i++; if (peek()) i++; } break; }
      if (t.t === "&") { i++; cells.push(cell.join("")); cell = []; continue; }
      if (t.t === "cmd" && (t.v === "\\" || t.v === "cr")) { i++; cells.push(cell.join("")); cell = []; rows.push(cells); cells = []; continue; }
      cell.push(atomWithScripts());
    }
    cells.push(cell.join("")); rows.push(cells);
    const body = rows.filter(r => r.join("").trim() !== "").map(r =>
      "<mtr>" + r.map(c => "<mtd>" + (c || "") + "</mtd>").join("") + "</mtr>").join("");
    const f = MATRIX_FENCE[kind] || ["", ""];
    return (f[0] ? mo(f[0], ' stretchy="true"') : "") + "<mtable>" + body + "</mtable>" + (f[1] ? mo(f[1], ' stretchy="true"') : "");
  }

  function atom(){
    const t = toks[i];
    if (!t) return "";
    if (t.t === "num") { i++; return "<mn>" + t.v + "</mn>"; }
    if (t.t === "id")  { i++; return "<mi>" + t.v + "</mi>"; }
    if (t.t === "op")  { i++; return mo(t.v); }
    if (t.t === "{")   { return group(); }
    if (t.t === "}" || t.t === "&") { return ""; }
    if (t.t === "^" || t.t === "_") { return ""; }

    i++;
    const c = t.v;
    if (c === "frac" || c === "dfrac" || c === "tfrac") return "<mfrac>" + group() + group() + "</mfrac>";
    if (c === "binom") return mo("(") + "<mfrac linethickness=\"0\">" + group() + group() + "</mfrac>" + mo(")");
    if (c === "sqrt") {
      if (peek() && peek().t === "op" && peek().v === "[") {
        i++; const idx = [];
        while (peek() && !(peek().t === "op" && peek().v === "]")) idx.push(atomWithScripts());
        if (peek()) i++;
        return "<mroot>" + group() + "<mrow>" + idx.join("") + "</mrow></mroot>";
      }
      return "<msqrt>" + group() + "</msqrt>";
    }
    if (c === "text" || c === "textrm" || c === "mbox") {
      if (peek() && peek().t === "{") {
        i++; let s = "";
        let depth = 1;
        while (peek()) {
          const x = toks[i];
          if (x.t === "{") depth++;
          if (x.t === "}") { depth--; if (!depth) { i++; break; } }
          s += x.v != null ? x.v : (x.t === "cmd" ? "\\" + x.v : x.t);
          if (x.t === "id" || x.t === "num") s = s;
          i++;
          if (toks[i - 1] && (toks[i - 1].t === "id" || toks[i - 1].t === "num" || toks[i - 1].t === "op")) s += "";
        }
        return "<mtext>" + esc(s) + "</mtext>";
      }
      return "";
    }
    if (c === "mathbb" || c === "mathbf" || c === "mathrm" || c === "mathit" || c === "mathcal" || c === "mathsf" || c === "boldsymbol") {
      const variant = { mathbb: "double-struck", mathbf: "bold", mathrm: "normal", mathit: "italic", mathcal: "script", mathsf: "sans-serif", boldsymbol: "bold" }[c];
      const inner = group().replace(/<mi>/g, '<mi mathvariant="' + variant + '">').replace(/<mn>/g, '<mn mathvariant="' + variant + '">');
      return inner;
    }
    if (c === "begin") {
      if (peek() && peek().t === "{") {
        i++; let kind = "";
        while (peek() && peek().t !== "}") { kind += toks[i].v || ""; i++; }
        if (peek()) i++;
        return matrix(kind);
      }
      return "";
    }
    if (c === "left" || c === "right") {
      const d = toks[i];
      let sym = "";
      if (d) {
        sym = d.t === "cmd" ? (TEX_DELIM["\\" + d.v] || TEX_DELIM[d.v] || "") : (TEX_DELIM[d.v] || d.v);
        i++;
      }
      return sym ? mo(sym, ' stretchy="true"') : "";
    }
    if (TEX_BIG[c]) return mo(TEX_BIG[c], ' movablelimits="true"') ;
    if (TEX_SYM[c]) return "<mi>" + esc(TEX_SYM[c]) + "</mi>";
    if (TEX_OP[c])  return mo(TEX_OP[c]);
    if (TEX_FN.includes(c)) return '<mi mathvariant="normal">' + c + "</mi>";
    if (c === "\\" || c === "cr") return "";
    if (c === "quad") return "<mspace width=\"1em\"/>";
    if (c === "qquad") return "<mspace width=\"2em\"/>";
    if (c === ",") return "<mspace width=\"0.17em\"/>";
    if (c === ";") return "<mspace width=\"0.28em\"/>";
    if (c === "{" || c === "}") return mo(c);
    return "<mi>" + esc(c) + "</mi>";
  }

  const SIDE_LIMITS = new Set(["int", "iint", "iiint", "oint"]);
  function atomWithScripts(){
    const startTok = toks[i];
    const isBig = startTok && startTok.t === "cmd" && TEX_BIG[startTok.v] && !SIDE_LIMITS.has(startTok.v);
    let base = atom();
    let sub = null, sup = null;
    while (peek() && (peek().t === "_" || peek().t === "^")) {
      const kind = toks[i].t; i++;
      const arg = group();
      if (kind === "_") sub = arg; else sup = arg;
    }
    if (sub && sup) return (isBig ? "<munderover>" : "<msubsup>") + base + sub + sup + (isBig ? "</munderover>" : "</msubsup>");
    if (sub) return (isBig ? "<munder>" : "<msub>") + base + sub + (isBig ? "</munder>" : "</msub>");
    if (sup) return (isBig ? "<mover>" : "<msup>") + base + sup + (isBig ? "</mover>" : "</msup>");
    return base;
  }

  function list(stop){
    let out = "";
    while (i < toks.length) {
      const t = toks[i];
      if (stop && t.t === stop) break;
      const before = i;
      out += atomWithScripts();
      if (i === before) i++;
    }
    return out;
  }

  return list(null);
}

function tex2mml(tex, display){
  if (mathRenderer) {
    try { return mathRenderer(tex, display); }
    catch (err) { return '<code class="tex-error" title="' + esc(err.message) + '">' + esc(tex) + "</code>"; }
  }
  try {
    const body = texParse(lexTex(tex));
    return '<math xmlns="http://www.w3.org/1998/Math/MathML"' + (display ? ' display="block"' : "") +
           ' class="tex"><mrow>' + body + "</mrow></math>";
  } catch (err) {
    return '<code class="tex-error">' + esc(tex) + "</code>";
  }
}

/* ---- flowchart diagrams (a compact mermaid subset) ---------------------- */
function renderFlow(src){
  const lines = src.split("\n").map(l => l.trim()).filter(Boolean);
  let dir = "TD";
  const head = lines[0] && lines[0].match(/^(?:graph|flowchart)\s+(TD|TB|LR|RL|BT)\s*$/i);
  if (head) { dir = head[1].toUpperCase(); lines.shift(); }
  else if (/^(graph|flowchart)\b/i.test(lines[0] || "")) lines.shift();

  const nodes = new Map(), edges = [];
  const shapeOf = (open) => open === "{" ? "diamond" : open === "((" ? "circle" : open === "(" ? "round" : "rect";
  const nodeRe = /([A-Za-z0-9_]+)(?:(\(\(|\[|\(|\{)([^\]\)\}]*)(?:\)\)|\]|\)|\}))?/g;

  const touchNode = (id, open, label) => {
    if (!nodes.has(id)) nodes.set(id, { id, label: id, shape: "rect", order: nodes.size });
    const n = nodes.get(id);
    if (label != null && label !== "") { n.label = label.replace(/^["']|["']$/g, ""); n.shape = shapeOf(open); }
    return n;
  };

  for (const line of lines) {
    const m = line.match(/^(.*?)\s*(-{2,3}>|-{3}|-\.->|={2,}>)\s*(?:\|([^|]*)\|)?\s*(.*)$/);
    if (m && m[4]) {
      const parse = side => { nodeRe.lastIndex = 0; const r = nodeRe.exec(side.trim()); return r ? touchNode(r[1], r[2], r[3]) : null; };
      const a = parse(m[1]), b = parse(m[4]);
      if (a && b) edges.push({ from: a.id, to: b.id, label: m[3] || "", dashed: m[2].includes("."), thick: m[2].includes("=") , arrow: m[2].includes(">") });
      continue;
    }
    nodeRe.lastIndex = 0;
    const r = nodeRe.exec(line);
    if (r && r[1]) touchNode(r[1], r[2], r[3]);
  }
  if (!nodes.size) return '<pre><code>' + esc(src) + "</code></pre>";

  // rank nodes by longest path, ignoring back edges so cycles stay readable
  const list = Array.from(nodes.values());
  const incoming = new Map(list.map(n => [n.id, 0]));
  edges.forEach(e => incoming.set(e.to, (incoming.get(e.to) || 0) + 1));

  const adj = new Map(list.map(n => [n.id, []]));
  edges.forEach(e => { if (adj.has(e.from)) adj.get(e.from).push(e.to); });
  const mark = new Map(), back = new Set();
  (function order(){
    const stack = [];
    const visit = id => {
      mark.set(id, 1);
      for (const to of adj.get(id) || []) {
        const st = mark.get(to) || 0;
        if (st === 1) back.add(id + ">" + to);      // edge to an ancestor: a loop
        else if (st === 0) visit(to);
      }
      mark.set(id, 2);
      stack.push(id);
    };
    list.filter(n => !incoming.get(n.id)).forEach(n => { if (!mark.get(n.id)) visit(n.id); });
    list.forEach(n => { if (!mark.get(n.id)) visit(n.id); });
  })();

  const forward = edges.filter(e => !back.has(e.from + ">" + e.to));
  list.forEach(n => n.rank = 0);
  let changed = true, guard = 0;
  while (changed && guard++ < 80) {
    changed = false;
    for (const e of forward) {
      const a = nodes.get(e.from), b = nodes.get(e.to);
      if (b.rank < a.rank + 1) { b.rank = a.rank + 1; changed = true; }
    }
  }

  const horizontal = dir === "LR" || dir === "RL";
  const rows = new Map();
  list.forEach(n => { if (!rows.has(n.rank)) rows.set(n.rank, []); rows.get(n.rank).push(n); });

  const PAD = 16, GAPX = 34, GAPY = 62, H = 42;
  const widthOf = n => Math.max(64, n.label.length * 7.6 + (n.shape === "diamond" ? 42 : 26));
  let cross = 0, along = 0;
  const ranks = Array.from(rows.keys()).sort((a, b) => a - b);

  for (const r of ranks) {
    const row = rows.get(r);
    let span = row.reduce((s, n) => s + widthOf(n), 0) + GAPX * (row.length - 1);
    if (horizontal) {
      const rowH = row.length * H + GAPY * 0.5 * (row.length - 1);
      cross = Math.max(cross, rowH);
    } else cross = Math.max(cross, span);
  }
  for (const r of ranks) {
    const row = rows.get(r);
    if (horizontal) {
      const rowH = row.length * H + (GAPY * 0.5) * (row.length - 1);
      let y = (cross - rowH) / 2;
      row.forEach(n => { n.w = widthOf(n); n.h = H; n.y = y + PAD; n.x = PAD + along; y += H + GAPY * 0.5; });
      along += Math.max.apply(null, row.map(widthOf)) + GAPY + 20;
    } else {
      const span = row.reduce((s, n) => s + widthOf(n), 0) + GAPX * (row.length - 1);
      let x = (cross - span) / 2;
      row.forEach(n => { n.w = widthOf(n); n.h = H; n.x = x + PAD; n.y = PAD + along; x += n.w + GAPX; });
      along += H + GAPY;
    }
  }
  const W = (horizontal ? along : cross) + PAD * 2;
  const HT = (horizontal ? cross : along) + PAD * 2;

  const shape = n => {
    const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
    if (n.shape === "diamond")
      return '<polygon points="' + [ [cx, n.y - 6], [n.x + n.w + 8, cy], [cx, n.y + n.h + 6], [n.x - 8, cy] ].map(p => p.join(",")).join(" ") + '" class="fl-shape"/>';
    if (n.shape === "circle")
      return '<ellipse cx="' + cx + '" cy="' + cy + '" rx="' + (n.w / 2 + 4) + '" ry="' + (n.h / 2 + 2) + '" class="fl-shape"/>';
    const r = n.shape === "round" ? n.h / 2 : 7;
    return '<rect x="' + n.x + '" y="' + n.y + '" width="' + n.w + '" height="' + n.h + '" rx="' + r + '" class="fl-shape"/>';
  };

  let svg = '<svg class="flow" viewBox="0 0 ' + Math.ceil(W) + " " + Math.ceil(HT) + '" width="' + Math.ceil(W) + '" role="img">' +
    '<defs><marker id="fl-ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
    '<path d="M0,0 L10,5 L0,10 z" class="fl-arrow"/></marker></defs>';

  for (const e of edges) {
    const a = nodes.get(e.from), b = nodes.get(e.to);
    if (!a || !b) continue;
    let x1, y1, x2, y2;
    if (horizontal) { x1 = a.x + a.w; y1 = a.y + a.h / 2; x2 = b.x; y2 = b.y + b.h / 2; }
    else { x1 = a.x + a.w / 2; y1 = a.y + a.h; x2 = b.x + b.w / 2; y2 = b.y; }
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const d = horizontal
      ? "M" + x1 + "," + y1 + " C" + (mx) + "," + y1 + " " + (mx) + "," + y2 + " " + x2 + "," + y2
      : "M" + x1 + "," + y1 + " C" + x1 + "," + my + " " + x2 + "," + my + " " + x2 + "," + y2;
    svg += '<path d="' + d + '" class="fl-edge' + (e.dashed ? " dashed" : "") + (e.thick ? " thick" : "") + '"' +
           (e.arrow ? ' marker-end="url(#fl-ar)"' : "") + "/>";
    if (e.label) {
      const tw = e.label.length * 6.2 + 10;
      svg += '<rect x="' + (mx - tw / 2) + '" y="' + (my - 9) + '" width="' + tw + '" height="17" rx="4" class="fl-lbl-bg"/>' +
             '<text x="' + mx + '" y="' + (my + 3.5) + '" class="fl-lbl">' + esc(e.label) + "</text>";
    }
  }
  for (const n of list) {
    svg += shape(n) + '<text x="' + (n.x + n.w / 2) + '" y="' + (n.y + n.h / 2 + 4.5) + '" class="fl-text">' + esc(n.label) + "</text>";
  }
  return '<div class="flow-wrap">' + svg + "</svg></div>";
}

/* ---- emoji shortcodes --------------------------------------------------- */
const EMOJI = {
  smile:"😄",smiley:"😃",grin:"😁",joy:"😂",rofl:"🤣",wink:"😉",blush:"😊",heart_eyes:"😍",
  thinking:"🤔",neutral_face:"😐",confused:"😕",cry:"😢",sob:"😭",angry:"😠",scream:"😱",
  sunglasses:"😎",nerd:"🤓",zany:"🤪",sleeping:"😴",yawn:"🥱",shrug:"🤷",facepalm:"🤦",
  wave:"👋",thumbsup:"👍","+1":"👍",thumbsdown:"👎","-1":"👎",ok_hand:"👌",clap:"👏",pray:"🙏",
  muscle:"💪",point_right:"👉",point_left:"👈",eyes:"👀",brain:"🧠",
  heart:"❤️",broken_heart:"💔",sparkling_heart:"💖",fire:"🔥",star:"⭐",star2:"🌟",sparkles:"✨",
  zap:"⚡",boom:"💥",tada:"🎉",confetti:"🎊",gift:"🎁",balloon:"🎈",trophy:"🏆",medal:"🏅",
  rocket:"🚀",airplane:"✈️",car:"🚗",house:"🏠",office:"🏢",earth:"🌍",moon:"🌙",sun:"☀️",
  rainbow:"🌈",cloud:"☁️",snowflake:"❄️",ocean:"🌊",tree:"🌳",seedling:"🌱",flower:"🌸",
  coffee:"☕",tea:"🍵",beer:"🍺",wine:"🍷",pizza:"🍕",burger:"🍔",cake:"🍰",apple:"🍎",
  dog:"🐶",cat:"🐱",fox:"🦊",bear:"🐻",panda:"🐼",penguin:"🐧",bird:"🐦",bug:"🐛",ant:"🐜",
  snail:"🐌",turtle:"🐢",whale:"🐳",dolphin:"🐬",unicorn:"🦄",dragon:"🐉",
  book:"📖",books:"📚",memo:"📝",pencil:"✏️",pen:"🖊️",paperclip:"📎",pushpin:"📌",
  calendar:"📅",clock:"🕐",hourglass:"⏳",alarm_clock:"⏰",stopwatch:"⏱️",
  bulb:"💡",wrench:"🔧",hammer:"🔨",gear:"⚙️",lock:"🔒",unlock:"🔓",key:"🔑",
  mag:"🔍",link:"🔗",bell:"🔔",mute:"🔕",loudspeaker:"📢",envelope:"✉️",inbox:"📥",
  computer:"💻",desktop:"🖥️",keyboard:"⌨️",phone:"📱",camera:"📷",tv:"📺",headphones:"🎧",
  chart:"📈",chart_down:"📉",bar_chart:"📊",clipboard:"📋",file:"📄",folder:"📁",
  package:"📦",label:"🏷️",card:"💳",money:"💰",gem:"💎",crown:"👑",
  white_check_mark:"✅",heavy_check_mark:"✔️",x:"❌",warning:"⚠️",no_entry:"⛔",
  question:"❓",exclamation:"❗",bangbang:"‼️",100:"💯",recycle:"♻️",infinity:"♾️",
  arrow_right:"➡️",arrow_left:"⬅️",arrow_up:"⬆️",arrow_down:"⬇️",repeat:"🔁",
  green_circle:"🟢",yellow_circle:"🟡",red_circle:"🔴",blue_circle:"🔵",black_circle:"⚫",
  construction:"🚧",bug_report:"🐞",rotating_light:"🚨",shield:"🛡️",telescope:"🔭",
  ghost:"👻",alien:"👽",robot:"🤖",skull:"💀",poop:"💩",wave_hand:"👋",salute:"🫡",
  handshake:"🤝",raised_hands:"🙌",writing_hand:"✍️",art:"🎨",music:"🎵",guitar:"🎸",
  soccer:"⚽",basketball:"🏀",dart:"🎯",game_die:"🎲",chess:"♟️",puzzle:"🧩"
};
const emojify = t => t.replace(/:([a-z0-9_+-]{1,24}):/gi, (m, n) => EMOJI[n.toLowerCase()] || m);

/* ---- [TOC] -------------------------------------------------------------- */
let headingSource = () => [];
export function setHeadingSource(fn){ headingSource = fn; }

export function renderTOC(){
  const items = headingSource();
  if (!items.length) return '<div class="toc-box"><em>No headings yet.</em></div>';
  const min = Math.min.apply(null, items.map(i => i.lvl));
  return '<div class="toc-box"><div class="toc-h">Contents</div><ul>' +
    items.map(i => '<li style="margin-left:' + ((i.lvl - min) * 15) + 'px"><a href="#' + slug(i.text) + '">' + inline(i.text) + "</a></li>").join("") +
    "</ul></div>";
}

export {
  esc, splitBlocks, inline, highlight, renderList, renderTable, renderBlock,
  renderDoc, renderUntrusted, setUntrusted, isUntrusted, blockType, slug, tex2mml, texParse, lexTex, renderFlow, emojify,
  EMOJI, MULTILINE, RE_ATX, RE_HR, RE_FENCE, RE_LI, RE_QUOTE, RE_TSEP
};
