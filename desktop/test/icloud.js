"use strict";
/* Tests for the iCloud Drive provider.

   The tree is simulated: a real evicted file cannot be conjured on demand, and
   the tests must not touch the user's own iCloud Drive. What is simulated is
   exactly the thing macOS does — the file disappears and a hidden
   .Name.md.icloud placeholder appears in its place — so the logic under test
   is the real logic. */
const assert = require("assert");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");

const icloud = require("../src/main/icloud");

module.exports = async function run(test){
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "inkju-icloud-"));
  const vault = path.join(dir, "Vault");
  fs.mkdirSync(vault, { recursive: true });

  const present = (name, body) => {
    fs.writeFileSync(path.join(vault, name), body == null ? "# " + name + "\n" : body, "utf8");
    return path.join(vault, name);
  };
  /* what macOS does when it evicts a file */
  const evict = (name) => {
    fs.rmSync(path.join(vault, name), { force: true });
    fs.writeFileSync(path.join(vault, "." + name + ".icloud"), "placeholder", "utf8");
  };
  const listing = () => fs.readdirSync(vault);

  icloud.setRoot(dir);

  /* -------------------------------------------------------- detection */

  await test("a path inside the container is recognised", () => {
    assert.strictEqual(icloud.isInside(vault), true);
    assert.strictEqual(icloud.isInside(dir), true);
    assert.strictEqual(icloud.isInside(path.join(os.tmpdir(), "somewhere-else")), false);
    assert.strictEqual(icloud.isInside(null), false);
  });

  await test("a sibling folder whose name merely starts the same is outside", () => {
    /* string-prefix path checks are how "/data" comes to contain "/data-evil" */
    assert.strictEqual(icloud.isInside(dir + "-evil"), false);
  });

  await test("the real container is found on this Mac and nowhere else", () => {
    icloud.setRoot(null);
    const r = icloud.root();
    if (process.platform === "darwin") {
      assert.ok(r === null || r.endsWith("com~apple~CloudDocs"), String(r));
    } else {
      assert.strictEqual(r, null, "iCloud Drive should not be offered off macOS");
    }
    icloud.setRoot(dir);
  });

  /* ------------------------------------------------------------ stubs */

  await test("a present file reads as present", () => {
    present("Notes.md");
    assert.strictEqual(icloud.statusOf(path.join(vault, "Notes.md")), "present");
    assert.strictEqual(icloud.isEvicted(path.join(vault, "Notes.md")), false);
  });

  await test("an evicted file is recognised by its placeholder", () => {
    present("Away.md");
    evict("Away.md");
    const file = path.join(vault, "Away.md");
    assert.strictEqual(icloud.statusOf(file), "evicted");
    assert.strictEqual(icloud.isEvicted(file), true);
  });

  await test("a file that is simply gone is not confused with an evicted one", () => {
    assert.strictEqual(icloud.statusOf(path.join(vault, "NeverExisted.md")), "missing");
  });

  await test("checking status reads no file contents", () => {
    /* the whole point: a tree walk over a mostly-evicted vault must not
       trigger a single download, so this may only ever stat */
    present("Big.md", "x".repeat(1000));
    const file = path.join(vault, "Big.md");
    const opened = [];
    const realOpen = fs.openSync;
    fs.openSync = function(p, ...rest){ opened.push(p); return realOpen.call(fs, p, ...rest); };
    try { icloud.statusOf(file); } finally { fs.openSync = realOpen; }
    assert.deepStrictEqual(opened, [], "statusOf opened a file: " + opened.join(", "));
  });

  await test("placeholder names map back to the note they stand for", () => {
    assert.strictEqual(icloud.nameFromStub(".Notes.md.icloud"), "Notes.md");
    assert.strictEqual(icloud.nameFromStub("Notes.md"), null);
    assert.strictEqual(icloud.nameFromStub(".hidden"), null);
    assert.strictEqual(icloud.stubPath("/a/b/Notes.md"), "/a/b/.Notes.md.icloud");
  });

  await test("a note called something.icloud is not mistaken for a placeholder", () => {
    /* the placeholder is a dotfile; a note that merely ends in .icloud is not */
    assert.strictEqual(icloud.isStubName("myfile.icloud"), false);
    assert.strictEqual(icloud.isStubName(".myfile.icloud"), true);
  });

  /* ------------------------------------------------------------ trees */

  await test("the sidebar shows one entry per note, never a placeholder", () => {
    const rows = icloud.collapse([".Away.md.icloud", "Notes.md", "Big.md", ".DS_Store"]);
    const names = rows.map(r => r.name).sort();
    assert.deepStrictEqual(names, [".DS_Store", "Away.md", "Big.md", "Notes.md"]);
    assert.ok(!names.some(n => n.endsWith(".icloud")), "a placeholder was shown as a note");
  });

  await test("an evicted note is marked as not downloaded", () => {
    const rows = icloud.collapse([".Away.md.icloud", "Notes.md"]);
    assert.strictEqual(rows.find(r => r.name === "Away.md").downloaded, false);
    assert.strictEqual(rows.find(r => r.name === "Notes.md").downloaded, true);
  });

  await test("a note present alongside a stale placeholder counts as downloaded", () => {
    const rows = icloud.collapse([".Notes.md.icloud", "Notes.md"]);
    assert.strictEqual(rows.length, 1, "the note was listed twice");
    assert.strictEqual(rows[0].downloaded, true);
  });

  await test("the real directory collapses the way the sidebar needs", () => {
    const rows = icloud.collapse(listing());
    assert.ok(rows.some(r => r.name === "Away.md" && r.downloaded === false));
    assert.ok(!rows.some(r => r.name.endsWith(".icloud")));
  });

  /* -------------------------------------------------------- conflicts */

  await test("a conflicted copy is recognised and attributed", () => {
    const info = icloud.conflictInfo("Notes (Roy's MacBook Pro conflicted copy 2026-08-22).md");
    assert.ok(info, "the conflicted copy was not recognised");
    assert.strictEqual(info.of, "Notes.md");
  });

  await test("an ordinary note is never called a conflict", () => {
    assert.strictEqual(icloud.conflictInfo("Notes.md"), null);
    assert.strictEqual(icloud.conflictInfo("Meeting Notes.md"), null);
    assert.strictEqual(icloud.conflictInfo("Conflict Resolution.md"), null,
      "a note about conflicts is not a conflict");
  });

  await test("conflicts are grouped under the note they belong to", () => {
    const map = icloud.findConflicts([
      "Notes.md",
      "Notes (conflicted copy 1).md",
      "Notes (Roy's iMac conflicted copy 2026-08-22).md",
      "Ideas.md"
    ]);
    assert.strictEqual(map.get("Notes.md").length, 2);
    assert.strictEqual(map.has("Ideas.md"), false);
  });

  await test("nothing here resolves, merges or deletes a conflict", () => {
    /* structural: the module offers no such function, on purpose */
    for (const name of ["resolve", "merge", "deleteConflict", "keepMine", "keepTheirs"]) {
      assert.strictEqual(typeof icloud[name], "undefined",
        "icloud.js should not decide a conflict for the user: " + name);
    }
  });

  /* ---------------------------------------------------- materializing */

  await test("an evicted file is fetched on an explicit open", async () => {
    present("Fetch.md", "# Fetched\n");
    evict("Fetch.md");
    const file = path.join(vault, "Fetch.md");
    icloud.setDownloader(async p => {
      /* what iCloud does when the bytes arrive */
      fs.rmSync(icloud.stubPath(p), { force: true });
      fs.writeFileSync(p, "# Fetched\n", "utf8");
      return true;
    });
    const r = await icloud.materialize(file);
    assert.strictEqual(r.downloaded, true);
    assert.strictEqual(icloud.statusOf(file), "present");
  });

  await test("a download that never arrives times out with something to do", async () => {
    present("Stuck.md");
    evict("Stuck.md");
    icloud.setDownloader(async () => true);          // says yes, delivers nothing
    await assert.rejects(
      () => icloud.materialize(path.join(vault, "Stuck.md"), { timeout: 400 }),
      /Check your connection/i);
  });

  await test("a file that is not there at all is not waited for", async () => {
    let called = false;
    icloud.setDownloader(async () => { called = true; return true; });
    await assert.rejects(() => icloud.materialize(path.join(vault, "Ghost.md")),
      /not in this folder any more/i);
    assert.strictEqual(called, false, "we asked iCloud for a file that does not exist");
  });

  await test("reading a present file downloads nothing", async () => {
    present("Local.md", "# Local\n");
    let called = false;
    icloud.setDownloader(async () => { called = true; return true; });
    const text = await icloud.readWithMaterialize(path.join(vault, "Local.md"),
      p => fs.readFileSync(p, "utf8"));
    assert.strictEqual(text, "# Local\n");
    assert.strictEqual(called, false, "a present file triggered a download");
  });

  await test("reading an evicted file says so before it waits", async () => {
    present("Slow.md", "# Slow\n");
    evict("Slow.md");
    let announced = null;
    icloud.setDownloader(async p => {
      fs.rmSync(icloud.stubPath(p), { force: true });
      fs.writeFileSync(p, "# Slow\n", "utf8");
      return true;
    });
    const text = await icloud.readWithMaterialize(
      path.join(vault, "Slow.md"),
      p => fs.readFileSync(p, "utf8"),
      name => { announced = name; });
    assert.strictEqual(announced, "Slow.md", "the interface was never told to show a spinner");
    assert.strictEqual(text, "# Slow\n");
  });

  await test("a note evicted while open is fetched back before it is saved", async () => {
    present("Open.md", "# Open\n");
    evict("Open.md");
    const file = path.join(vault, "Open.md");
    icloud.setDownloader(async p => {
      fs.rmSync(icloud.stubPath(p), { force: true });
      fs.writeFileSync(p, "# Open\n", "utf8");
      return true;
    });
    await icloud.prepareForWrite(file);
    assert.strictEqual(icloud.statusOf(file), "present");
  });

  await test("a note that never left is not re-fetched before a save", async () => {
    present("Here.md");
    let called = false;
    icloud.setDownloader(async () => { called = true; return true; });
    await icloud.prepareForWrite(path.join(vault, "Here.md"));
    assert.strictEqual(called, false);
  });

  /* ------------------------------------------- the vault, end to end */

  await test("a mostly-evicted vault opens without downloading anything", async () => {
    /* The failure this exists to prevent: opening a folder in iCloud Drive and
       having macOS quietly pull the whole thing down while the index builds. */
    const files = require("../src/main/files");
    const search = require("../src/main/search");

    const big = path.join(dir, "BigVault");
    fs.mkdirSync(path.join(big, "notes"), { recursive: true });
    const evictedNames = [];
    for (let i = 0; i < 40; i++) {
      const name = "Evicted " + i + ".md";
      fs.writeFileSync(path.join(big, "notes", "." + name + ".icloud"), "placeholder", "utf8");
      evictedNames.push(name);
    }
    fs.writeFileSync(path.join(big, "Here.md"), "# Here\n\nreal content\n", "utf8");

    let downloads = 0;
    icloud.setDownloader(async () => { downloads++; return true; });

    const tree = await files.listTree(big);
    const flat = files.flatten(tree);
    await search.setRoot(big);

    assert.strictEqual(downloads, 0, "opening the vault triggered " + downloads + " downloads");

    /* every evicted note is still listed, and marked */
    const listed = flat.filter(f => evictedNames.includes(f.name));
    assert.strictEqual(listed.length, 40, "evicted notes vanished from the sidebar: " + listed.length);
    assert.ok(listed.every(f => f.downloaded === false), "evicted notes were not marked");

    /* and no placeholder is shown as a note in its own right */
    assert.ok(!flat.some(f => f.name.endsWith(".icloud")), "a placeholder was listed as a note");

    /* the one real note is indexed; the evicted ones are not */
    const hits = search.search("real content", {});
    assert.strictEqual(hits.results.length, 1, "the present note should be searchable");
    assert.strictEqual(hits.results[0].name, "Here.md");
    assert.strictEqual(downloads, 0, "indexing triggered a download");

    await search.setRoot(null);
  });

  icloud.setDownloader(null);
  icloud.setRoot(null);
  await fsp.rm(dir, { recursive: true, force: true });
};
