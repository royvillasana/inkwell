/* ===========================================================================
   Conversions between markdown, HTML and the clipboard.
   Pasting rich text from a browser or Word arrives as HTML; Typora turns that
   into markdown rather than dropping tags into the document, and so do we.
   =========================================================================== */
import { renderBlock } from "./markdown.js";

let td = null;

export function initTurndown(){
  if (td) return td;
  if (typeof window.TurndownService === "undefined") return null;
  td = new window.TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    fence: "```",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined"
  });
  if (window.turndownPluginGfm) {
    td.use([window.turndownPluginGfm.tables, window.turndownPluginGfm.strikethrough,
            window.turndownPluginGfm.taskListItems]);
  }
  /* KaTeX output pasted from another Inkwell window comes back as maths */
  td.addRule("katex", {
    filter: node => node.classList && node.classList.contains("katex"),
    replacement: (content, node) => {
      const tex = node.querySelector("annotation[encoding='application/x-tex']");
      return tex ? "$" + tex.textContent.trim() + "$" : content;
    }
  });
  td.addRule("keepBreaks", { filter: "br", replacement: () => "  \n" });
  td.addRule("dropStyleAndScript", { filter: ["style", "script", "noscript"], replacement: () => "" });
  return td;
}

/* Returns markdown, or null when the HTML is not worth converting. */
export function htmlToMarkdown(html){
  const svc = initTurndown();
  if (!svc || !html) return null;
  /* Word and Google Docs wrap everything in enormous style blocks */
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/\sclass="[^"]*"/g, "")
    .replace(/\sstyle="[^"]*"/g, "");
  try {
    const md = svc.turndown(cleaned).replace(/\n{3,}/g, "\n\n").trim();
    return md || null;
  } catch (err) {
    console.warn("paste conversion failed:", err.message);
    return null;
  }
}

/* Plain HTML of the document, used by "Copy as HTML" and the clipboard. */
export function blocksToHTML(blocks){
  return blocks.map(b => renderBlock(b.src)).join("\n");
}

export async function copyBoth(markdown, html){
  try {
    if (html && window.ClipboardItem) {
      await navigator.clipboard.write([new window.ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([markdown], { type: "text/plain" })
      })]);
      return true;
    }
    await navigator.clipboard.writeText(markdown);
    return true;
  } catch (err) {
    return false;
  }
}

/* ---- smart punctuation ---------------------------------------------------
   Applied only to the characters just typed, so it can never rewrite text the
   writer already settled on, and never inside code.                          */
const OPENERS = new Set(["", " ", "\n", "\t", "(", "[", "{", "“", "‘", "-", "/"]);

export function smartPunctuate(ta){
  const pos = ta.selectionStart;
  if (pos !== ta.selectionEnd || pos < 1) return false;
  const v = ta.value;
  const last = v[pos - 1];
  let replacement = null, back = 1;

  if (last === '"') {
    const before = pos >= 2 ? v[pos - 2] : "";
    replacement = OPENERS.has(before) ? "“" : "”";
  } else if (last === "'") {
    const before = pos >= 2 ? v[pos - 2] : "";
    replacement = OPENERS.has(before) ? "‘" : "’";
  } else if (last === "." && v.slice(pos - 3, pos) === "...") {
    replacement = "…"; back = 3;
  } else if (last === "-" && v.slice(pos - 3, pos) === "---") {
    replacement = "—"; back = 3;
  } else if (last === "-" && v.slice(pos - 2, pos) === "--" && v[pos - 3] !== "-" && v[pos] !== "-") {
    replacement = "–"; back = 2;
  }
  if (!replacement) return false;

  ta.value = v.slice(0, pos - back) + replacement + v.slice(pos);
  const caret = pos - back + replacement.length;
  ta.setSelectionRange(caret, caret);
  return true;
}

/* Turn curly punctuation back into plain ASCII, for when it is in the way. */
export const unsmarten = text => text
  .replace(/[‘’]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/…/g, "...")
  .replace(/—/g, "---")
  .replace(/–/g, "--");
