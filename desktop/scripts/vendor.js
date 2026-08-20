"use strict";
/* Copy the parts of mermaid and KaTeX the renderer actually loads into
   src/renderer/vendor. The renderer runs under a strict CSP with script-src
   'self', so libraries have to sit beside the page rather than come from a CDN,
   and packaging only has to include one predictable folder. */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const vendor = path.join(root, "src", "renderer", "vendor");

function copy(from, to){
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
function copyDir(from, to, filter){
  if (!fs.existsSync(from)) return 0;
  let n = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) n += copyDir(src, dst, filter);
    else if (!filter || filter(entry.name)) { copy(src, dst); n++; }
  }
  return n;
}

function main(){
  const mermaidDist = path.join(root, "node_modules", "mermaid", "dist");
  const katexDist = path.join(root, "node_modules", "katex", "dist");

  if (!fs.existsSync(mermaidDist) || !fs.existsSync(katexDist)) {
    console.error("vendor: run npm install first (mermaid or katex missing)");
    process.exit(0);                       // never fail an install over this
  }

  fs.rmSync(vendor, { recursive: true, force: true });

  /* mermaid: the ESM entry plus the lazy chunks it imports at render time */
  copy(path.join(mermaidDist, "mermaid.esm.min.mjs"), path.join(vendor, "mermaid", "mermaid.esm.min.mjs"));
  const chunks = copyDir(
    path.join(mermaidDist, "chunks", "mermaid.esm.min"),
    path.join(vendor, "mermaid", "chunks", "mermaid.esm.min"),
    name => name.endsWith(".mjs"));

  /* katex: script, stylesheet, fonts, and the mhchem extension Typora supports */
  copy(path.join(katexDist, "katex.min.js"), path.join(vendor, "katex", "katex.min.js"));
  copy(path.join(katexDist, "katex.min.css"), path.join(vendor, "katex", "katex.min.css"));
  const fonts = copyDir(path.join(katexDist, "fonts"), path.join(vendor, "katex", "fonts"),
    name => name.endsWith(".woff2"));
  copy(path.join(katexDist, "contrib", "mhchem.min.js"), path.join(vendor, "katex", "mhchem.min.js"));

  /* turndown converts pasted rich text into markdown, the way Typora does */
  copy(path.join(root, "node_modules", "turndown", "dist", "turndown.js"),
       path.join(vendor, "turndown", "turndown.js"));
  copy(path.join(root, "node_modules", "turndown-plugin-gfm", "dist", "turndown-plugin-gfm.js"),
       path.join(vendor, "turndown", "turndown-plugin-gfm.js"));

  const size = du(vendor);
  console.log("vendor: mermaid (" + chunks + " chunks), katex (" + fonts + " fonts), turndown — " +
              (size / 1024 / 1024).toFixed(1) + " MB");
}

function du(dir){
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? du(p) : fs.statSync(p).size;
  }
  return total;
}

main();
