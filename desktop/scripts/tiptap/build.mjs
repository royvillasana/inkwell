"use strict";
/* Builds the TipTap bundle the renderer loads. Run through `npm run vendor`. */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "..", "src", "renderer", "vendor", "tiptap", "tiptap.bundle.mjs");

const res = await build({
  entryPoints: [path.join(here, "entry.mjs")],
  bundle: true,
  format: "esm",
  target: ["chrome120"],
  minify: true,
  sourcemap: false,
  legalComments: "none",
  outfile: out,
  logLevel: "warning"
});
if (res.errors.length) process.exit(1);
const kb = (fs.statSync(out).size / 1024).toFixed(0);
console.log("tiptap: bundled " + kb + " KB -> " + path.relative(path.join(here, "..", ".."), out));
