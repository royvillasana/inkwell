"use strict";
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Menu, clipboard } = require("electron");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");

/* Automated runs get their own profile. This MUST happen before requiring
   store, which resolves the settings path at module load: with the override
   after the require, smoke runs were still reading and writing the real
   profile — rewriting saved preferences and leaving scratch documents in the
   restored session. */
if (process.env.INKWELL_SMOKE) {
  app.setPath("userData", path.join(os.tmpdir(), "inkwell-smoke-" + process.pid));
}

const store = require("./store");
const files = require("./files");
const search = require("./search");
const { buildMenu } = require("./menu");
const updates = require("./updates");
const pandoc = require("./pandoc");

const isDev = process.argv.includes("--dev");
const windows = new Set();
let watcher = null;
let watchTimer = null;
let pendingOpen = [];          // files handed to us before a window exists

/* ------------------------------------------------------------------ window */
function createWindow(openPath){
  const saved = store.get().windowBounds;
  const win = new BrowserWindow({
    width: saved && saved.width || 1180,
    height: saved && saved.height || 820,
    x: saved && saved.x,
    y: saved && saved.y,
    minWidth: 620,
    minHeight: 440,
    show: false,
    title: "Inkwell",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#16171a" : "#f7f6f3",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 14, y: 15 },
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  });

  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  win.once("ready-to-show", () => {
    win.show();
    if (isDev) win.webContents.openDevTools({ mode: "detach" });
  });

  /* renderer console shows up in the terminal, which is what you want while
     developing and when a user sends you a log */
  /* Electron 36+ passes a single event object; the old positional form silently
     dropped every message, which made renderer errors invisible here. */
  win.webContents.on("console-message", (...args) => {
    const e = args[0];
    const modern = e && typeof e === "object" && "message" in e;
    const level = modern ? e.level : args[1];
    const message = modern ? e.message : args[2];
    const line = modern ? e.lineNumber : args[3];
    const source = modern ? e.sourceId : args[4];
    const bad = level === "error" || level === "warning" || (typeof level === "number" && level >= 2);
    if (!isDev && !bad) return;
    console.log("[renderer:" + level + "]", message,
      source ? "(" + String(source).split("/").pop() + ":" + line + ")" : "");
  });

  win.webContents.on("did-finish-load", () => {
    const queue = openPath ? [openPath] : pendingOpen.splice(0);
    if (queue.length) win.webContents.send("open-paths", queue);
    if (process.env.INKWELL_SMOKE) runSmoke(win);
    if (process.env.INKWELL_SHOT) captureShot(win);
  });

  /* external links open in the real browser, never inside the app */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file://")) { e.preventDefault(); shell.openExternal(url); }
  });

  const remember = () => { if (!win.isDestroyed() && !win.isFullScreen()) store.save({ windowBounds: win.getBounds() }); };
  win.on("resize", remember);
  win.on("move", remember);
  win.on("closed", () => windows.delete(win));

  windows.add(win);
  return win;
}

/* INKWELL_SHOT=<file> boots, optionally opens INKWELL_SHOT_VAULT, writes a PNG
   of the window and exits. Used to review the interface without a screen. */
async function captureShot(win){
  try {
    const v = process.env.INKWELL_SHOT_VAULT;
    if (v) {
      await search.setRoot(v);
      store.save({ vault: v });
      await win.webContents.executeJavaScript(
        'import("./js/vault.js").then(V => V.restoreVault(' + JSON.stringify(v) + '))', true);
    }
    await new Promise(r => setTimeout(r, 900));
    if (process.env.INKWELL_SHOT_SCRIPT) {
      await win.webContents.executeJavaScript(
        require("fs").readFileSync(process.env.INKWELL_SHOT_SCRIPT, "utf8"), true);
      await new Promise(r => setTimeout(r, 700));
    }
    const img = await win.webContents.capturePage();
    await fsp.writeFile(process.env.INKWELL_SHOT, img.toPNG());
    console.log("SHOT " + process.env.INKWELL_SHOT);
  } catch (err) { console.log("SHOT FAILED " + err.message); }
  setTimeout(() => app.quit(), 150);
}

/* INKWELL_SMOKE=1 boots the app, asserts the renderer came up, prints a report
   and exits. Used by the release checks; invisible in normal runs. */
async function runSmoke(win){
  const file = process.env.INKWELL_SMOKE_FILE || path.join(__dirname, "..", "..", "test", "smoke-renderer.js");
  let script;
  try { script = require("fs").readFileSync(file, "utf8"); }
  catch (err) {
    /* fail fast: a missing script used to leave the app hanging with no output */
    console.log("SMOKE FAILED cannot read " + file + ": " + err.message);
    process.exitCode = 1;
    return app.quit();
  }
  /* A throwaway vault for the smoke run: the renderer has no way to name a real
     directory, and the packaged app does not ship example-vault. */
  let prelude = "";
  try {
    const fsn = require("fs");
    const dir = path.join(os.tmpdir(), "inkwell-smoke-vault-" + process.pid);
    fsn.rmSync(dir, { recursive: true, force: true });
    fsn.mkdirSync(path.join(dir, "notes"), { recursive: true });
    fsn.writeFileSync(path.join(dir, "Alpha.md"), "# Alpha\n\nPoints at [[Beta]].\n");
    fsn.writeFileSync(path.join(dir, "notes", "Beta.md"), "# Beta\n\n#fixture\n");
    prelude = "globalThis.__smokeVault = " + JSON.stringify(dir) + ";\n";
  } catch (err) {
    console.log("smoke: could not build the fixture vault: " + err.message);
  }
  prelude += "globalThis.__fakeUpdate = " + JSON.stringify(process.env.INKWELL_FAKE_UPDATE || null) + ";\n";
  try {
    const report = await win.webContents.executeJavaScript(prelude + script, true);
    console.log("SMOKE " + JSON.stringify(report, null, 2));
    process.exitCode = report && report.failures && report.failures.length ? 1 : 0;
  } catch (err) {
    console.log("SMOKE FAILED " + err.message);
    process.exitCode = 1;
  }
  setTimeout(() => app.quit(), 120);
}

const focused = () => BrowserWindow.getFocusedWindow() || Array.from(windows)[0];
const broadcast = (ch, payload) => windows.forEach(w => { if (!w.isDestroyed()) w.webContents.send(ch, payload); });

/* ----------------------------------------------------------------- watcher */
function watchVault(root){
  if (watcher) { try { watcher.close(); } catch (e) {} watcher = null; }
  if (!root) return;
  try {
    watcher = fs.watch(root, { recursive: true }, (evt, name) => {
      if (!name) return;
      const base = path.basename(name);
      if (base.startsWith(".") || base.endsWith(".tmp")) return;
      const full = path.join(root, name);
      if (files.isMarkdown(full)) search.touch(full);
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => broadcast("vault:changed", { path: full }), 260);
    });
  } catch (err) {
    console.warn("vault watching unavailable:", err.message);
  }
}

/* --------------------------------------------------------------------- IPC */
const ok = data => ({ ok: true, data });
const fail = err => ({ ok: false, error: err && err.message ? err.message : String(err) });
const handle = (channel, fn) => ipcMain.handle(channel, async (event, ...args) => {
  try { return ok(await fn(...args)); }
  catch (err) { return fail(err); }
});

handle("settings:get", () => store.get());
handle("settings:set", patch => store.save(patch));

handle("dialog:openFile", async () => {
  const r = await dialog.showOpenDialog(focused(), {
    title: "Open Markdown",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd", "txt"] }, { name: "All Files", extensions: ["*"] }]
  });
  if (r.canceled) return null;
  const out = [];
  for (const p of r.filePaths) {
    const d = await files.readText(p);
    store.addRecent({ path: p, name: path.basename(p) });
    out.push({ path: p, name: path.basename(p), text: d.text, mtime: d.mtime });
  }
  buildMenu({ newWindow: () => createWindow() });
  return out;
});

handle("dialog:openVault", async () => {
  const r = await dialog.showOpenDialog(focused(), { title: "Open Vault", properties: ["openDirectory"] });
  if (r.canceled) return null;
  const root = r.filePaths[0];
  store.save({ vault: root });
  await search.setRoot(root);
  watchVault(root);
  return { root, tree: await files.listTree(root), stats: search.stats() };
});

handle("vault:open", async root => {
  if (!root) return null;
  await fsp.access(root);
  store.save({ vault: root });
  await search.setRoot(root);
  watchVault(root);
  return { root, tree: await files.listTree(root), stats: search.stats() };
});
/* Renaming a vault renames the folder itself, so every open document inside it
   moves with it. We hand the renderer both the old and the new root so it can
   repoint its tabs — otherwise the next autosave would write to a path that no
   longer exists, and quietly recreate the file at the old location. */
handle("vault:rename", async (root, nextName) => {
  if (!root) throw new Error("No vault is open.");
  const clean = String(nextName || "").trim().replace(/[/\\]/g, "").replace(/^\.+/, "");
  if (!clean) throw new Error("A vault needs a name.");
  const target = path.join(path.dirname(root), clean);
  if (path.resolve(target) === path.resolve(root)) {
    return { root, from: root, tree: await files.listTree(root), stats: search.stats() };
  }
  const taken = await fsp.access(target).then(() => true, () => false);
  if (taken) throw new Error("Something called \u201c" + clean + "\u201d is already there.");
  await fsp.rename(root, target);
  store.save({ vault: target });
  await search.setRoot(target);
  watchVault(target);
  return { root: target, from: root, tree: await files.listTree(target), stats: search.stats() };
});

/* Closing a vault only forgets it. Nothing on disk is touched, and open
   documents stay open — they are just no longer part of a browsable folder. */
handle("vault:close", async () => {
  store.save({ vault: null });
  await search.setRoot(null);
  watchVault(null);
  return true;
});

handle("clipboard:write", async text => { clipboard.writeText(String(text == null ? "" : text)); return true; });

handle("vault:tree", async () => {
  const root = store.get().vault;
  return root ? { root, tree: await files.listTree(root), stats: search.stats() } : null;
});
handle("vault:search", (q, opts) => search.search(q, opts || {}));
handle("vault:backlinks", name => search.backlinks(name));
handle("vault:unresolved", text => search.unresolved(text));
handle("vault:resolve", name => search.resolveLink(name));
handle("vault:tags", () => search.tags());
handle("vault:byTag", tag => search.byTag(tag));
handle("vault:quickOpen", q => search.quickOpen(q));
handle("vault:reindex", () => search.build());

handle("file:read", async p => {
  const d = await files.readText(p);
  store.addRecent({ path: p, name: path.basename(p) });
  return { path: p, name: path.basename(p), text: d.text, mtime: d.mtime };
});

handle("file:write", async (p, text) => {
  const res = await files.writeText(p, text);
  await search.touch(p);
  return { path: p, name: path.basename(p), mtime: res.mtime };
});

handle("file:saveAs", async (suggested, text) => {
  const r = await dialog.showSaveDialog(focused(), {
    title: "Save As",
    defaultPath: suggested || "Untitled.md",
    filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }]
  });
  if (r.canceled) return null;
  const res = await files.writeText(r.filePath, text);
  store.addRecent({ path: r.filePath, name: path.basename(r.filePath) });
  await search.touch(r.filePath);
  buildMenu({ newWindow: () => createWindow() });
  return { path: r.filePath, name: path.basename(r.filePath), mtime: res.mtime };
});

handle("file:create", async (dir, name, contents) => {
  const target = dir || store.get().vault;
  if (!target) throw new Error("Open a vault first so new notes have a home.");
  const f = await files.createFile(target, name, contents);
  await search.touch(f.path);
  return f;
});

handle("file:rename", async (p, next) => {
  const f = await files.renameFile(p, next);
  await search.touch(f.path);
  return f;
});

handle("file:delete", async p => {
  await shell.trashItem(p);
  await search.touch(p);
  return true;
});

handle("file:reveal", p => { shell.showItemInFolder(p); return true; });
handle("file:stat", async p => {
  try { const s = await fsp.stat(p); return { mtime: s.mtimeMs, size: s.size }; }
  catch (err) { return null; }
});

handle("image:save", async (noteFile, data, ext) =>
  files.saveImage(noteFile, store.get().imageFolder, data, ext));

handle("image:pick", async noteFile => {
  const r = await dialog.showOpenDialog(focused(), {
    title: "Insert Image",
    properties: ["openFile"],
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"] }]
  });
  if (r.canceled) return null;
  const src = r.filePaths[0];
  const data = await fsp.readFile(src);
  return files.saveImage(noteFile, store.get().imageFolder, data, path.extname(src));
});

/* history snapshots live inside the vault, or in userData when there is none */
const historyRoot = () => store.get().vault || app.getPath("userData");
handle("history:save", (name, text) => files.writeSnapshot(historyRoot(), name, text));
handle("history:list", name => files.listSnapshots(historyRoot(), name));
handle("history:read", async file => (await files.readText(file)).text);

handle("export:save", async (suggested, contents, filters) => {
  const r = await dialog.showSaveDialog(focused(), { title: "Export", defaultPath: suggested, filters });
  if (r.canceled) return null;
  await fsp.writeFile(r.filePath, contents, "utf8");
  return r.filePath;
});

/* Render to PDF in a hidden window so app chrome never leaks into the file. */
handle("export:pdf", async (suggested, html) => {
  const r = await dialog.showSaveDialog(focused(), {
    title: "Export PDF",
    defaultPath: suggested,
    filters: [{ name: "PDF", extensions: ["pdf"] }]
  });
  if (r.canceled) return null;

  const tmp = path.join(os.tmpdir(), "inkwell-print-" + Date.now() + ".html");
  await fsp.writeFile(tmp, html, "utf8");
  const hidden = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    await hidden.loadFile(tmp);
    await new Promise(res => setTimeout(res, 220));      // let fonts and MathML settle
    const pdf = await hidden.webContents.printToPDF({
      printBackground: true,
      margins: { top: 0.8, bottom: 0.8, left: 0.8, right: 0.8 },
      pageSize: "A4"
    });
    await fsp.writeFile(r.filePath, pdf);
    return r.filePath;
  } finally {
    hidden.destroy();
    fsp.unlink(tmp).catch(() => {});
  }
});

handle("print", async html => {
  const tmp = path.join(os.tmpdir(), "inkwell-print-" + Date.now() + ".html");
  await fsp.writeFile(tmp, html, "utf8");
  const hidden = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  await hidden.loadFile(tmp);
  return new Promise(res => {
    hidden.webContents.print({ silent: false, printBackground: true }, () => {
      hidden.destroy();
      fsp.unlink(tmp).catch(() => {});
      res(true);
    });
  });
});

handle("updates:check", () => updates.check());

handle("updates:download", async asset => {
  const win = focused();
  const res = await updates.download(asset, (pct, got, total) => {
    if (win && !win.isDestroyed()) win.webContents.send("update:progress", { pct, got, total });
  });
  return res;
});

/* Replace ourselves if we can, and hand over the disk image if we cannot —
   a locked-down install location or an image that fails vetting should end in
   the old manual path, not in an error the user can do nothing with. */
handle("updates:install", async file => {
  try {
    const res = await updates.installInPlace(file);
    /* the helper is waiting on this process to exit before it swaps */
    setTimeout(() => app.quit(), 400);
    return res;
  } catch (err) {
    console.warn("in-place update unavailable:", err.message);
    await updates.install(file);
    return { mode: "dmg", reason: err.message };
  }
});
handle("updates:page", () => { shell.openExternal(updates.RELEASES_PAGE); return true; });

handle("assets:css", () =>
  /* app.css is document styling and themes; desktop.css is window chrome and is
     deliberately kept out of exported files */
  fsp.readFile(path.join(__dirname, "..", "renderer", "css", "app.css"), "utf8"));

handle("pandoc:info", async () => ({ version: await pandoc.version(), formats: pandoc.FORMATS }));

handle("pandoc:export", async (formatId, markdown, suggestedBase, noteDir) => {
  const fmt = pandoc.FORMATS.find(f => f.id === formatId);
  if (!fmt) throw new Error("Unknown format");
  if (!(await pandoc.version())) throw new Error("Pandoc is not installed.");
  const r = await dialog.showSaveDialog(focused(), {
    title: "Export as " + fmt.label,
    defaultPath: (suggestedBase || "Untitled") + "." + fmt.ext,
    filters: [{ name: fmt.label, extensions: [fmt.ext] }]
  });
  if (r.canceled) return null;
  await pandoc.convert(formatId, markdown, r.filePath, noteDir || null);
  return r.filePath;
});

handle("assets:katexCss", async () => {
  /* inlined into exported HTML and PDF so equations survive outside the app */
  const dir = path.join(__dirname, "..", "renderer", "vendor", "katex");
  const css = await fsp.readFile(path.join(dir, "katex.min.css"), "utf8");
  /* rewrite the relative font URLs to absolute ones the export can resolve */
  return css.replace(/url\(fonts\//g, "url(file://" + path.join(dir, "fonts") + "/");
});

handle("window:new", () => { createWindow(); return true; });
handle("window:title", (title, filePath) => {
  const w = focused();
  if (w) { w.setTitle(title); if (filePath) w.setRepresentedFilename(filePath); }
  return true;
});
handle("window:edited", flag => {
  const w = focused();
  if (w && process.platform === "darwin") w.setDocumentEdited(!!flag);
  return true;
});

handle("shell:open", url => {
  if (/^https?:|^mailto:/.test(url)) shell.openExternal(url);
  return true;
});

handle("confirm", async opts => {
  const r = await dialog.showMessageBox(focused(), {
    type: opts.type || "question",
    buttons: opts.buttons || ["Cancel", "OK"],
    defaultId: opts.defaultId != null ? opts.defaultId : 1,
    cancelId: opts.cancelId != null ? opts.cancelId : 0,
    message: opts.message,
    detail: opts.detail
  });
  return r.response;
});

handle("theme:system", () => nativeTheme.shouldUseDarkColors);
nativeTheme.on("updated", () => broadcast("theme:changed", nativeTheme.shouldUseDarkColors));

/* --------------------------------------------------------------- lifecycle */
const single = app.requestSingleInstanceLock();
if (!single) app.quit();
else {
  app.on("second-instance", (e, argv) => {
    const paths = argv.slice(1).filter(a => !a.startsWith("-") && files.isMarkdown(a));
    const win = focused();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (paths.length) win.webContents.send("open-paths", paths);
    }
  });

  app.on("open-file", (e, p) => {                 // macOS file association / drop on dock
    e.preventDefault();
    const win = focused();
    if (win) win.webContents.send("open-paths", [p]);
    else pendingOpen.push(p);
  });

  app.whenReady().then(async () => {
    buildMenu({ newWindow: () => createWindow() });
    const vault = store.get().vault;
    if (vault && fs.existsSync(vault)) { await search.setRoot(vault); watchVault(vault); }
    const argPaths = process.argv.slice(1).filter(a => !a.startsWith("-") && files.isMarkdown(a));
    pendingOpen.push(...argPaths);
    createWindow();

    app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });

  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("before-quit", () => store.flush());
}
