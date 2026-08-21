"use strict";
/* Main-process tests. These modules never touch Electron APIs, so they run
   under plain node:  npm test                                              */
const assert = require("assert");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");

const files = require("../src/main/files");
const search = require("../src/main/search");

let pass = 0, fail = 0;
async function test(name, fn){
  try { await fn(); console.log("  ok   " + name); pass++; }
  catch (err) { console.log("  FAIL " + name + "\n       " + err.message); fail++; }
}

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "inkwell-test-"));
  const write = (rel, body) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, "utf8");
    return full;
  };

  write("Index.md", "# Index\n\nSee [[Meeting Notes]] and [[Ideas]].\n\n#project #index\n");
  write("Ideas.md", "# Ideas\n\nA thought about typography. #design\n");
  write("notes/Meeting Notes.md", "# Meeting Notes\n\nWe discussed [[Ideas]] at length.\nAction: ship it. #project\n");
  write("notes/deep/Archive.md", "# Archive\n\nold TODO material\n");
  write("node_modules/ignored.md", "# should never be indexed\n");
  write(".hidden/secret.md", "# hidden\n");
  write("picture.png", "not really a png");

  console.log("\nfiles.js");
  await test("listTree finds markdown, skips node_modules and dotfiles", async () => {
    const tree = await files.listTree(root);
    const flat = files.flatten(tree).map(f => f.name).sort();
    assert.deepStrictEqual(flat, ["Archive.md", "Ideas.md", "Index.md", "Meeting Notes.md"]);
  });

  await test("listTree puts folders before files", async () => {
    const tree = await files.listTree(root);
    assert.strictEqual(tree[0].kind, "dir", "expected a directory first");
  });

  await test("writeText is atomic and leaves no temp file", async () => {
    const target = path.join(root, "Atomic.md");
    await files.writeText(target, "hello");
    assert.strictEqual(await fsp.readFile(target, "utf8"), "hello");
    const leftovers = (await fsp.readdir(root)).filter(f => f.endsWith(".tmp"));
    assert.strictEqual(leftovers.length, 0, "temp files left behind: " + leftovers);
  });

  await test("createFile never overwrites an existing note", async () => {
    const a = await files.createFile(root, "Dup.md", "one");
    const b = await files.createFile(root, "Dup.md", "two");
    assert.notStrictEqual(a.path, b.path);
    assert.strictEqual(await fsp.readFile(a.path, "utf8"), "one");
  });

  await test("renameFile keeps the extension and dodges collisions", async () => {
    const src = await files.createFile(root, "Rename me.md", "x");
    const out = await files.renameFile(src.path, "Renamed");
    assert.strictEqual(path.basename(out.path), "Renamed.md");
    assert.ok(fs.existsSync(out.path));
  });

  await test("within() refuses paths outside the vault", () => {
    assert.strictEqual(files.within(root, path.join(root, "a", "b.md")), true);
    assert.strictEqual(files.within(root, "/etc/passwd"), false);
    assert.strictEqual(files.within(root, root + "-sibling/x.md"), false);
  });

  await test("saveImage writes into the assets folder and returns a relative link", async () => {
    const note = path.join(root, "Index.md");
    const img = await files.saveImage(note, "assets", Buffer.from([1, 2, 3]), ".png");
    assert.ok(fs.existsSync(img.path));
    assert.ok(img.relative.startsWith("assets/"), "relative was " + img.relative);
    assert.ok(img.relative.endsWith(".png"));
  });

  await test("saveImage refuses when the note has no home yet", async () => {
    await assert.rejects(() => files.saveImage(null, "assets", Buffer.from([1]), ".png"));
  });

  await test("snapshots are written, listed newest first and capped", async () => {
    await files.writeSnapshot(root, "Index.md", "v1");
    await new Promise(r => setTimeout(r, 5));
    await files.writeSnapshot(root, "Index.md", "v2");
    const list = await files.listSnapshots(root, "Index.md");
    assert.ok(list.length >= 2, "expected 2 snapshots, got " + list.length);
    assert.ok(list[0].at >= list[1].at, "not sorted newest first");
    assert.strictEqual(await fsp.readFile(list[0].file, "utf8"), "v2");
  });

  console.log("\nsearch.js");
  await search.setRoot(root);

  await test("index covers the vault and skips ignored folders", () => {
    const s = search.stats();
    assert.ok(s.files >= 4, "indexed " + s.files);
    assert.ok(s.words > 0);
  });

  await test("plain search finds matches with context", () => {
    const r = search.search("discussed");
    assert.strictEqual(r.results.length, 1);
    assert.strictEqual(r.results[0].name, "Meeting Notes.md");
    assert.strictEqual(r.results[0].hits[0].match, "discussed");
    assert.ok(r.results[0].hits[0].line > 0);
  });

  await test("search is case-insensitive by default and exact on request", () => {
    assert.ok(search.search("INDEX").total > 0);
    assert.strictEqual(search.search("INDEX", { caseSensitive: true }).total, 0);
  });

  await test("whole-word search does not match inside words", () => {
    assert.ok(search.search("old", { word: true }).total >= 1);
    assert.strictEqual(search.search("houghts", { word: true }).total, 0);
  });

  await test("a broken regex reports an error instead of throwing", () => {
    const r = search.search("[unclosed", { regex: true });
    assert.ok(r.error, "expected an error message");
    assert.strictEqual(r.results.length, 0);
  });

  await test("regex search works when asked for", () => {
    assert.ok(search.search("ship\\s+it", { regex: true }).total >= 1);
  });

  await test("backlinks find notes pointing here, excluding itself", () => {
    const back = search.backlinks("Ideas.md").map(b => b.name).sort();
    assert.deepStrictEqual(back, ["Index.md", "Meeting Notes.md"]);
    assert.ok(search.backlinks("Ideas.md")[0].contexts[0].includes("Ideas"));
  });

  await test("wiki links resolve to a real path", () => {
    const hit = search.resolveLink("Meeting Notes");
    assert.ok(hit && hit.name === "Meeting Notes.md");
    assert.strictEqual(search.resolveLink("Nothing Here"), null);
  });

  await test("unresolved links are reported", () => {
    const missing = search.unresolved("[[Ideas]] and [[Ghost Note]]");
    assert.deepStrictEqual(missing, ["Ghost Note"]);
  });

  await test("tags are counted across the vault", () => {
    const tags = search.tags();
    const project = tags.find(t => t.tag === "project");
    assert.ok(project, "no #project tag found");
    assert.strictEqual(project.n, 2);
    assert.ok(tags.find(t => t.tag === "design"));
  });

  await test("byTag lists the notes carrying a tag", () => {
    const hits = search.byTag("project").map(h => h.name).sort();
    assert.deepStrictEqual(hits, ["Index.md", "Meeting Notes.md"]);
  });

  await test("quick open ranks exact, prefix then fuzzy matches", () => {
    const names = search.quickOpen("ideas").map(h => h.name);
    assert.strictEqual(names[0], "Ideas.md");
    assert.ok(search.quickOpen("mtg").length >= 0);
    assert.ok(search.quickOpen("meet").map(h => h.name).includes("Meeting Notes.md"));
  });

  await test("touch() keeps the index current after an edit", async () => {
    const p = path.join(root, "Ideas.md");
    await fsp.writeFile(p, "# Ideas\n\nnow mentions kerning.\n", "utf8");
    await search.touch(p);
    assert.strictEqual(search.search("kerning").total, 1);
    assert.strictEqual(search.search("typography").total, 0);
  });

  console.log("\nupdates.js");
  /* updates.js pulls in electron; test the pure logic by loading the source
     and evaluating just the comparison, which is where these go wrong */
  const upSrc = fs.readFileSync(path.join(__dirname, "..", "src", "main", "updates.js"), "utf8");
  const cmpBody = upSrc.slice(upSrc.indexOf("function compareVersions"), upSrc.indexOf("function request"));
  const compareVersions = new Function(cmpBody + "; return compareVersions;")();
  const pickBody = upSrc.slice(upSrc.indexOf("function pickAsset"), upSrc.indexOf("async function check"));

  await test("a newer version is detected", () => {
    assert.strictEqual(compareVersions("2.1.3", "2.1.2"), 1);
    assert.strictEqual(compareVersions("2.2.0", "2.1.9"), 1);
    assert.strictEqual(compareVersions("3.0.0", "2.9.9"), 1);
  });

  await test("the same version is not an update", () => {
    assert.strictEqual(compareVersions("2.1.2", "2.1.2"), 0);
    assert.strictEqual(compareVersions("v2.1.2", "2.1.2"), 0, "a v prefix must not matter");
  });

  await test("an older version never prompts", () => {
    assert.strictEqual(compareVersions("2.1.1", "2.1.2"), -1);
    assert.strictEqual(compareVersions("1.9.9", "2.0.0"), -1);
  });

  await test("10 is newer than 9, not older", () => {
    /* string comparison would call 2.1.10 older than 2.1.9 */
    assert.strictEqual(compareVersions("2.1.10", "2.1.9"), 1);
    assert.strictEqual(compareVersions("2.10.0", "2.9.0"), 1);
  });

  await test("a build suffix does not make a version newer", () => {
    assert.strictEqual(compareVersions("2.1.2-beta.1", "2.1.2"), 0);
  });

  await test("the download picks the asset for this machine", () => {
    /* the slice carries the FAKE constant too, so the stub needs an env */
    const pickAsset = new Function("process", pickBody + "; return pickAsset;")(
      { platform: "darwin", arch: "arm64", env: {} });
    const assets = [
      { name: "Inkwell-2.1.3-x64.dmg" },
      { name: "Inkwell-2.1.3-arm64.dmg" },
      { name: "Inkwell-2.1.3.zip" }
    ];
    assert.strictEqual(pickAsset(assets).name, "Inkwell-2.1.3-arm64.dmg");
    assert.strictEqual(pickAsset([]), null, "no assets must not throw");
  });

  console.log("\nrenderer assets");
  const cssPath = path.join(__dirname, "..", "src", "renderer", "css", "app.css");
  const css = fs.readFileSync(cssPath, "utf8");

  await test("stylesheet has balanced braces", () => {
    const open = (css.match(/{/g) || []).length, close = (css.match(/}/g) || []).length;
    assert.strictEqual(open, close, open + " { vs " + close + " }");
  });

  await test("stylesheet carries no javascript artefacts", () => {
    /* the engine and styles are lifted from the single-file build; a naive
       extraction once pulled "<style>" strings out of the export code */
    const bad = css.split("\n").filter(l => l.includes('" +') || l.includes('+ "'));
    assert.strictEqual(bad.length, 0, "found: " + bad.join(" | "));
  });

  await test("stylesheet defines the selectors the renderer depends on", () => {
    for (const sel of ["#tabs{", "body.tabbed #tabs", "#modal", "#slash", "#present", "svg.flow", "math.tex", ".rendered pre"])
      assert.ok(css.includes(sel), "missing " + sel);
  });

  await test("renderer modules and shell are all present", () => {
    const dir = path.join(__dirname, "..", "src", "renderer");
    for (const f of ["index.html", "js/markdown.js", "js/editor.js", "js/dialogs.js",
                     "js/aids.js", "js/vault.js", "js/app.js", "js/rich.js", "js/convert.js",
                     "js/rich-editor.js", "css/app.css", "css/desktop.css"])
      assert.ok(fs.existsSync(path.join(dir, f)), "missing " + f);
  });

  await test("vendored libraries are present and complete", () => {
    const v = path.join(__dirname, "..", "src", "renderer", "vendor");
    assert.ok(fs.existsSync(path.join(v, "mermaid", "mermaid.esm.min.mjs")), "mermaid entry missing — run npm run vendor");
    const chunks = fs.readdirSync(path.join(v, "mermaid", "chunks", "mermaid.esm.min"));
    assert.ok(chunks.length > 50, "only " + chunks.length + " mermaid chunks");
    for (const f of ["katex/katex.min.js", "katex/katex.min.css", "katex/mhchem.min.js",
                     "turndown/turndown.js", "turndown/turndown-plugin-gfm.js"])
      assert.ok(fs.existsSync(path.join(v, f)), "missing " + f);
    const fonts = fs.readdirSync(path.join(v, "katex", "fonts"));
    assert.ok(fonts.length >= 10 && fonts.every(f => f.endsWith(".woff2")), "katex fonts look wrong");
  });

  await test("tiptap bundle is built and self-contained", () => {
    const f = path.join(__dirname, "..", "src", "renderer", "vendor", "tiptap", "tiptap.bundle.mjs");
    assert.ok(fs.existsSync(f), "missing — run npm run vendor");
    const src = fs.readFileSync(f, "utf8");
    assert.ok(src.length > 200000, "bundle looks truncated (" + src.length + " bytes)");
    /* esbuild must have inlined everything: nothing may still point at a package
       the renderer cannot resolve (matching real specifiers, not minified code
       that happens to contain the word "from") */
    const bare = (src.match(/from\s*["'](?:@tiptap|prosemirror|@remirror)[^"']*["']/g) || [])
      .concat(src.match(/\brequire\s*\(\s*["'][^.][^"']*["']\s*\)/g) || []);
    assert.strictEqual(bare.length, 0, "unbundled dependency: " + bare.slice(0, 3).join(", "));
    for (const name of ["Editor", "StarterKit", "TaskList", "Table"])
      assert.ok(src.includes(name), "export missing: " + name);
  });

  await test("mermaid entry only imports its own local chunks", () => {
    const entry = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "vendor",
      "mermaid", "mermaid.esm.min.mjs"), "utf8");
    const imports = (entry.match(/from"([^"]+)"/g) || []).map(m => m.slice(6, -1));
    const remote = imports.filter(i => /^https?:/.test(i));
    assert.strictEqual(remote.length, 0, "remote import: " + remote.join(", "));
  });

  await test("pandoc module degrades when the binary is absent", async () => {
    const pandoc = require("../src/main/pandoc");
    assert.ok(Array.isArray(pandoc.FORMATS) && pandoc.FORMATS.length >= 10);
    for (const f of pandoc.FORMATS) assert.ok(f.id && f.to && f.ext && f.label, "incomplete format " + JSON.stringify(f));
    const v = await pandoc.version();
    assert.ok(v === null || typeof v === "string", "version should be a string or null, got " + typeof v);
    if (v === null) await assert.rejects(() => pandoc.convert("docx", "# hi", "/tmp/x.docx", null));
  });

  await test("index.html loads only local scripts and sets a CSP", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "index.html"), "utf8");
    assert.ok(html.includes("Content-Security-Policy"), "no CSP meta tag");
    assert.ok(!/src="https?:/.test(html), "remote script reference found");
  });

  await fsp.rm(root, { recursive: true, force: true });
  console.log("\n" + pass + " passed, " + fail + " failed\n");
  process.exit(fail ? 1 : 0);
})();
