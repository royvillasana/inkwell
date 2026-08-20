"use strict";
/* Typora leans on Pandoc for docx, LaTeX, epub and friends. So do we: shelling
   out to a tool the user already has beats shipping a half-correct converter.
   Everything here degrades to "not installed" rather than throwing. */
const { execFile } = require("child_process");
const path = require("path");
const os = require("os");

/* Homebrew, MacPorts and the usual Linux prefixes are not always on the PATH
   an app inherits when launched from the Finder or a desktop launcher. */
const EXTRA_PATHS = [
  "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
  "/opt/local/bin", "/snap/bin", path.join(os.homedir(), ".local", "bin"),
  "C:\\Program Files\\Pandoc"
];

function env(){
  const sep = process.platform === "win32" ? ";" : ":";
  const current = (process.env.PATH || "").split(sep);
  const merged = current.concat(EXTRA_PATHS.filter(p => !current.includes(p)));
  return Object.assign({}, process.env, { PATH: merged.join(sep) });
}

function run(args, stdin, cwd){
  return new Promise((resolve, reject) => {
    const child = execFile("pandoc", args, { env: env(), cwd, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === "ENOENT") return reject(new Error("Pandoc is not installed."));
          return reject(new Error((stderr || err.message).trim().split("\n").slice(0, 3).join(" ")));
        }
        resolve(stdout);
      });
    if (stdin != null) { child.stdin.end(stdin, "utf8"); }
  });
}

let cachedVersion;
async function version(){
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const out = await run(["--version"]);
    cachedVersion = (out.split("\n")[0] || "").replace(/^pandoc\s*/i, "").trim() || "unknown";
  } catch (err) {
    cachedVersion = null;
  }
  return cachedVersion;
}

/* The formats Typora offers, minus the ones we already do natively. */
const FORMATS = [
  { id: "docx",      to: "docx",            ext: "docx",  label: "Word (.docx)",        detail: "A real Word document, not HTML in disguise" },
  { id: "odt",       to: "odt",             ext: "odt",   label: "OpenDocument (.odt)", detail: "LibreOffice and OpenOffice" },
  { id: "rtf",       to: "rtf",             ext: "rtf",   label: "Rich Text (.rtf)",    detail: "Opens almost anywhere" },
  { id: "latex",     to: "latex",           ext: "tex",   label: "LaTeX (.tex)",        detail: "For a TeX toolchain" },
  { id: "epub",      to: "epub3",           ext: "epub",  label: "EPUB",                detail: "E-reader format" },
  { id: "rst",       to: "rst",             ext: "rst",   label: "reStructuredText",    detail: "Sphinx and Python docs" },
  { id: "mediawiki", to: "mediawiki",       ext: "wiki",  label: "MediaWiki",           detail: "Wikipedia-style markup" },
  { id: "textile",   to: "textile",         ext: "textile", label: "Textile",           detail: "Redmine and older CMSes" },
  { id: "asciidoc",  to: "asciidoc",        ext: "adoc",  label: "AsciiDoc",            detail: "AsciiDoctor" },
  { id: "org",       to: "org",             ext: "org",   label: "Org mode",            detail: "Emacs" },
  { id: "opml",      to: "opml",            ext: "opml",  label: "OPML",                detail: "Outliners" }
];

/* Convert markdown, resolving relative image paths against the note's folder. */
async function convert(formatId, markdown, outFile, noteDir){
  const fmt = FORMATS.find(f => f.id === formatId);
  if (!fmt) throw new Error("Unknown export format: " + formatId);

  const args = [
    "--from", "markdown+tex_math_dollars+pipe_tables+task_lists+footnotes+strikeout+yaml_metadata_block",
    "--to", fmt.to,
    "--standalone",
    "--output", outFile
  ];
  if (noteDir) args.push("--resource-path", noteDir);
  if (fmt.to === "epub3" || fmt.to === "docx" || fmt.to === "odt") args.push("--toc");

  await run(args, markdown, noteDir || undefined);
  return outFile;
}

module.exports = { version, convert, FORMATS, run };
