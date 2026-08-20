/* ===========================================================================
   Real Mermaid and real KaTeX, loaded from src/renderer/vendor.
   Nothing here reaches the network: the CSP only allows scripts from 'self'.

   Maths is synchronous, so it plugs straight into the engine. Diagrams are
   asynchronous, so the engine emits a host element and hydrate() fills it in
   after the block has been painted.
   =========================================================================== */
import { setMathRenderer, mdOptions, esc } from "./markdown.js";

let mermaid = null;
let mermaidTheme = "default";
let loading = null;
let seq = 0;

const cache = new Map();          // diagram source -> rendered svg
const CACHE_MAX = 200;

/* ---- maths --------------------------------------------------------------- */
export function initMath(){
  if (typeof window.katex === "undefined") return false;
  setMathRenderer((tex, display) =>
    window.katex.renderToString(tex, {
      displayMode: !!display,
      throwOnError: false,
      errorColor: "#c0392b",
      strict: "ignore",
      trust: ctx => ["\\htmlId", "\\href"].includes(ctx.command),
      macros: {
        "\\RR": "\\mathbb{R}", "\\NN": "\\mathbb{N}", "\\ZZ": "\\mathbb{Z}",
        "\\QQ": "\\mathbb{Q}", "\\CC": "\\mathbb{C}"
      }
    }));
  return true;
}

/* ---- diagrams ------------------------------------------------------------ */
export async function initDiagrams(theme){
  if (mermaid) return mermaid;
  if (loading) return loading;
  loading = (async () => {
    const mod = await import("../vendor/mermaid/mermaid.esm.min.mjs");
    mermaid = mod.default;
    mermaidTheme = theme;
    mermaid.initialize({
      startOnLoad: false,
      theme,
      themeVariables: paletteVars(),
      securityLevel: "strict",
      fontFamily: getComputedStyle(document.body).getPropertyValue("--font-ui") || "sans-serif",
      flowchart: { htmlLabels: true, curve: "basis" },
      sequence: { useMaxWidth: true },
      gantt: { useMaxWidth: true }
    });
    mdOptions.mermaid = true;
    loading = null;
    return mermaid;
  })();
  return loading;
}

/* Pull the app's own colours out of CSS so diagrams match the page. */
function paletteVars(){
  const css = getComputedStyle(document.documentElement);
  const v = n => css.getPropertyValue(n).trim();
  return {
    background: v("--panel"),
    primaryColor: v("--accent-soft"),
    primaryBorderColor: v("--accent"),
    primaryTextColor: v("--ink"),
    lineColor: v("--ink-faint"),
    secondaryColor: v("--panel-2"),
    tertiaryColor: v("--page"),
    textColor: v("--ink"),
    mainBkg: v("--page"),
    nodeBorder: v("--ink-faint"),
    clusterBkg: v("--panel-2"),
    fontSize: "14px"
  };
}

export async function setDiagramTheme(theme){
  if (!mermaid || theme === mermaidTheme) return;
  mermaidTheme = theme;
  mermaid.initialize({ startOnLoad: false, theme, themeVariables: paletteVars(), securityLevel: "strict" });
  cache.clear();
  document.querySelectorAll(".diagram[data-rendered]").forEach(el => {
    el.removeAttribute("data-rendered");
    el.innerHTML = '<div class="diagram-wait">…</div>';
  });
  await hydrate(document);
}

/* Fill every un-rendered diagram host inside root. Safe to call repeatedly. */
export async function hydrate(root){
  if (!mermaid) return;
  const hosts = Array.from((root || document).querySelectorAll(".diagram[data-diagram]:not([data-rendered])"));
  if (!hosts.length) return;

  for (const host of hosts) {
    const src = host.dataset.diagram;
    host.setAttribute("data-rendered", "1");

    const hit = cache.get(src + "|" + mermaidTheme);
    if (hit) { host.innerHTML = hit; continue; }

    try {
      const { svg } = await mermaid.render("inkwell-d" + (++seq), src);
      cache.set(src + "|" + mermaidTheme, svg);
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      host.innerHTML = svg;
    } catch (err) {
      const msg = (err && err.message ? err.message : String(err)).split("\n")[0];
      host.innerHTML = '<div class="diagram-error"><strong>Diagram error</strong>' +
        "<span>" + esc(msg) + "</span><pre>" + esc(src) + "</pre></div>";
    }
  }
}

/* Render a detached copy for export: the PDF window has JavaScript disabled,
   so diagrams and maths must already be baked into the markup. */
export async function bake(html){
  const box = document.createElement("div");
  box.style.cssText = "position:absolute;left:-99999px;top:0;width:800px";
  box.innerHTML = html;
  document.body.appendChild(box);
  try {
    await hydrate(box);
    return box.innerHTML;
  } finally {
    box.remove();
  }
}

export const diagramsReady = () => !!mermaid;
export const mathReady = () => typeof window.katex !== "undefined";
