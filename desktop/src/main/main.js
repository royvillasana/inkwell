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
if (process.env.INKJU_SMOKE) {
  app.setPath("userData", path.join(os.tmpdir(), "inkju-smoke-" + process.pid));
}

/* The app used to be called Inkwell, and Electron derives the settings folder
   from the app's name — so renaming it moves the folder and a returning user
   would be met by a first-run app: no vault, no session, no preferences. Carry
   the old profile across once, before store resolves its path at load. The old
   folder is left where it is rather than moved, so an older build still runs. */
(function adoptOldProfile(){
  if (process.env.INKJU_SMOKE) return;
  try {
    const here = app.getPath("userData");
    if (fs.existsSync(path.join(here, "settings.json"))) return;   // already ours
    const before = path.join(path.dirname(here), "Inkwell");
    if (!fs.existsSync(path.join(before, "settings.json"))) return;
    fs.mkdirSync(here, { recursive: true });
    for (const name of fs.readdirSync(before)) {
      if (name.startsWith(".")) continue;
      const from = path.join(before, name), to = path.join(here, name);
      if (fs.statSync(from).isFile() && !fs.existsSync(to)) fs.copyFileSync(from, to);
    }
    console.log("carried the Inkwell profile over to Inkju");
  } catch (err) {
    console.warn("could not carry the old profile over:", err.message);
  }
})();

const store = require("./store");
const files = require("./files");
const search = require("./search");
const { buildMenu } = require("./menu");
const updates = require("./updates");
const pandoc = require("./pandoc");
const connections = require("./connections");
const mcp = require("./mcp-client");
const oauth = require("./oauth");
const icloud = require("./icloud");
const cloud = require("./cloud");

const isDev = process.argv.includes("--dev");
/* Connections — the MCP host and the cloud browser — ship dark until the OAuth
   flow has been exercised against real accounts. Everything the feature adds is
   gated on this one flag, so a build without it behaves exactly as 2.2.0 did:
   no connection is loaded, no token is refreshed, nothing is spawned. */
const connectionsEnabled = process.argv.includes("--connections") || !!process.env.INKJU_CONNECTIONS;
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
    title: "Inkju",
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
    if (process.env.INKJU_SMOKE) runSmoke(win);
    if (process.env.INKJU_SHOT) captureShot(win);
  });

  /* external links open in the real browser, never inside the app */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith("file://")) return;
    e.preventDefault();
    /* Only the web. This used to hand anything that was not file:// straight to
       the operating system, which was fine while every document came off the
       user's own disk — and is not fine now that a note can arrive from someone
       else's Drive. javascript:, data:, smb: and whatever scheme some other
       installed application has registered are all things a note should not be
       able to reach through us. Matches setWindowOpenHandler, which was already
       strict about this. */
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  const remember = () => { if (!win.isDestroyed() && !win.isFullScreen()) store.save({ windowBounds: win.getBounds() }); };
  win.on("resize", remember);
  win.on("move", remember);
  win.on("closed", () => windows.delete(win));

  windows.add(win);
  return win;
}

/* INKJU_SHOT=<file> boots, optionally opens INKJU_SHOT_VAULT, writes a PNG
   of the window and exits. Used to review the interface without a screen. */
async function captureShot(win){
  try {
    const v = process.env.INKJU_SHOT_VAULT;
    if (v) {
      await search.setRoot(v);
      store.save({ vault: v });
      await win.webContents.executeJavaScript(
        'import("./js/vault.js").then(V => V.restoreVault(' + JSON.stringify(v) + '))', true);
    }
    await new Promise(r => setTimeout(r, 900));
    if (process.env.INKJU_SHOT_SCRIPT) {
      await win.webContents.executeJavaScript(
        require("fs").readFileSync(process.env.INKJU_SHOT_SCRIPT, "utf8"), true);
      await new Promise(r => setTimeout(r, 700));
    }
    const img = await win.webContents.capturePage();
    await fsp.writeFile(process.env.INKJU_SHOT, img.toPNG());
    console.log("SHOT " + process.env.INKJU_SHOT);
  } catch (err) { console.log("SHOT FAILED " + err.message); }
  setTimeout(() => app.quit(), 150);
}

/* INKJU_SMOKE=1 boots the app, asserts the renderer came up, prints a report
   and exits. Used by the release checks; invisible in normal runs. */
async function runSmoke(win){
  const file = process.env.INKJU_SMOKE_FILE || path.join(__dirname, "..", "..", "test", "smoke-renderer.js");
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
    const dir = path.join(os.tmpdir(), "inkju-smoke-vault-" + process.pid);
    fsn.rmSync(dir, { recursive: true, force: true });
    fsn.mkdirSync(path.join(dir, "notes"), { recursive: true });
    fsn.writeFileSync(path.join(dir, "Alpha.md"), "# Alpha\n\nPoints at [[Beta]].\n");
    fsn.writeFileSync(path.join(dir, "notes", "Beta.md"), "# Beta\n\n#fixture\n");
    prelude = "globalThis.__smokeVault = " + JSON.stringify(dir) + ";\n";
  } catch (err) {
    console.log("smoke: could not build the fixture vault: " + err.message);
  }
  prelude += "globalThis.__fakeUpdate = " + JSON.stringify(process.env.INKJU_FAKE_UPDATE || null) + ";\n";
  /* Bring the window forward before the checks run. Parts of the editor hide
     themselves on blur — the floating menu most of all — so a window that never
     came to the front fails checks for reasons that have nothing to do with
     what they test. test:all launches two apps back to back, which is exactly
     when one can start behind the other. */
  try { app.focus({ steal: true }); win.focus(); } catch (err) { /* headless */ }
  await new Promise(r => setTimeout(r, 150));
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
  /* Opening a note is the one moment iCloud is allowed to fetch: an explicit
     act by the user, on one file. The renderer is told first, so a download
     over a slow connection reads as "downloading" rather than as a frozen app.
     Nothing else in the app takes this path — the tree walk and the indexer
     both step around evicted files entirely. */
  const d = await icloud.readWithMaterialize(
    p,
    file => files.readText(file),
    name => broadcast("icloud:downloading", { path: p, name }));
  store.addRecent({ path: p, name: path.basename(p) });
  return { path: p, name: path.basename(p), text: d.text, mtime: d.mtime };
});

handle("file:write", async (p, text) => {
  /* A note open in a tab can be evicted underneath the app. Writing then would
     land the file beside its own placeholder and leave iCloud with two ideas
     about what the note is, so it is fetched back first. */
  await icloud.prepareForWrite(p);
  const res = await files.writeText(p, text);
  await search.touch(p);
  return { path: p, name: path.basename(p), mtime: res.mtime };
});

/* iCloud Drive as a place to keep a vault. Not a connection, not an account —
   a folder that syncs, offered beside the connections so the idea stays in one
   place. Absent off macOS and absent when iCloud Drive is switched off. */
handle("icloud:info", async () => {
  const base = icloud.root();
  if (!base) return null;
  const vault = store.get().vault;
  return { root: base, vaultIsInside: !!vault && icloud.isInside(vault) };
});

handle("icloud:openVault", async () => {
  const base = icloud.root();
  if (!base) throw new Error("iCloud Drive is not set up on this Mac.");
  const r = await dialog.showOpenDialog(focused(), {
    title: "Open a Vault in iCloud Drive",
    defaultPath: base,
    properties: ["openDirectory", "createDirectory"]
  });
  if (r.canceled) return null;
  const root = r.filePaths[0];
  if (!icloud.isInside(root)) {
    throw new Error("That folder is not in iCloud Drive. Open it as an ordinary vault instead.");
  }
  store.save({ vault: root });
  await search.setRoot(root);
  watchVault(root);
  return { root, tree: await files.listTree(root), stats: search.stats() };
});

/* Which notes in this folder have a conflicting copy. Reported, never fixed:
   iCloud keeps both sides and choosing between them is the user's call. */
handle("icloud:conflicts", async dir => {
  const target = dir || store.get().vault;
  if (!target || !icloud.isInside(target)) return [];
  let names;
  try { names = await fsp.readdir(target); }
  catch (err) { return []; }
  const map = icloud.findConflicts(names);
  return Array.from(map.entries()).map(([of, copies]) => ({ of, copies }));
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

  const tmp = path.join(os.tmpdir(), "inkju-print-" + Date.now() + ".html");
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
  const tmp = path.join(os.tmpdir(), "inkju-print-" + Date.now() + ".html");
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

/* ------------------------------------------------------------ connections */

/* Every handler below is gated on the flag. A build without --connections is
   not a build where these fail politely; it is a build where the renderer is
   told the feature is not here, so nothing loads, nothing connects, and no
   token is refreshed. */
function requireConnections(){
  if (!connectionsEnabled) throw new Error("Connections are not enabled in this build.");
}

/* The renderer is told what a connection needs, never how to satisfy it. */
mcp.setAuthProviderFactory(rec => oauth.makeProvider(rec, {
  /* A provider built outside an interactive flow has no loopback listener and
     no state: it exists so a stored token can be replayed and refreshed
     silently. Anything that would need the browser throws instead, and the
     connection is marked as needing authorization. */
  redirectUrl: undefined,
  state: null
}));

mcp.setReauthorizer(async (id, scope) => authorizeConnection(id, scope));

/* One interactive sign-in, then a connection on a fresh transport. A started
   transport cannot be restarted, which is why the flow builds its own and this
   throws the first one away. */
async function authorizeConnection(id, scope){
  requireConnections();
  const rec = connections.raw(id);
  if (rec.transport !== "http") throw new Error("Only server connections sign in. A local one takes its credentials from its environment.");

  connections.setStatus(id, connections.STATUS.CONNECTING);
  try {
    const flow = await oauth.authorize(rec, {
      /* a step-up scope, if this is one — not stored, just used here */
      build: opts => new (require("@modelcontextprotocol/sdk/client/streamableHttp.js").StreamableHTTPClientTransport)(
        new URL(rec.config.url), { authProvider: opts.authProvider, scope: scope || undefined }),
      connect: async transport => {
        const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
        const probe = new Client({ name: "inkju", version: app.getVersion() }, { capabilities: {} });
        await probe.connect(transport);
        await probe.close();
      },
      finish: (transport, code) => transport.finishAuth(code)
    }, { scope: scope || null });
    try { await flow.transport.close(); } catch (err) { /* already gone */ }
    connections.setStatus(id, connections.STATUS.DISCONNECTED);
    return await mcp.connect(id);
  } catch (err) {
    connections.setStatus(id, connections.STATUS.NEEDS_AUTH, mcp.scrub(err.message));
    throw new Error(mcp.scrub(err.message));
  }
}

handle("connections:enabled", () => connectionsEnabled);

/* Presets are data, so a change to Google's preview server is a change to a
   JSON file rather than to a release. */
handle("connections:presets", () => {
  if (!connectionsEnabled) return [];
  try {
    const raw = fs.readFileSync(path.join(__dirname, "presets", "connections.json"), "utf8");
    return JSON.parse(raw).presets || [];
  } catch (err) {
    console.warn("connections: presets unreadable:", err.message);
    return [];
  }
});

/* The cloud browser. Everything below is a connection doing the work; the
   renderer only ever sees rows and text. */
handle("cloud:capabilities", id => { requireConnections(); return cloud.capabilities(id); });
handle("cloud:list", (id, opts) => { requireConnections(); return cloud.listFiles(id, opts || {}); });
handle("cloud:read", (id, remoteId, entry) => { requireConnections(); return cloud.readFile(id, remoteId, entry || null); });
handle("cloud:conflict", (id, remoteId, version) => { requireConnections(); return cloud.checkForConflict(id, remoteId, version); });

/* A write is the one place the user is asked directly. The allowlist has
   already said the tool may be used; this asks whether it may be used now, on
   this file. "Don't ask again" is per connection, off by default, and a
   deletion is never covered by it. */
async function confirmRemoteChange(rec, what, name){
  const destructive = what === "delete";
  if (!destructive && rec.confirmWrites === false) return true;
  const r = await dialog.showMessageBox(focused(), {
    type: destructive ? "warning" : "question",
    buttons: ["Cancel", destructive ? "Delete" : "Save"],
    defaultId: 1,
    cancelId: 0,
    message: destructive
      ? "Delete “" + name + "” from " + rec.label + "?"
      : "Save “" + name + "” to " + rec.label + "?",
    detail: destructive
      ? "This removes the file from the connected account. Inkju cannot undo it."
      : "This writes the file in the connected account, replacing what is there now."
  });
  return r.response === 1;
}

handle("cloud:write", async (id, remoteId, text, opts) => {
  requireConnections();
  const rec = connections.raw(id);
  const o = opts || {};
  if (!await confirmRemoteChange(rec, "write", o.name || remoteId)) return null;
  return cloud.writeFile(id, remoteId, text, o);
});

handle("cloud:import", async (id, remoteId, entry) => {
  requireConnections();
  const dir = (entry && entry.dir) || store.get().vault;
  const f = await cloud.importToVault(id, remoteId, dir, entry || null);
  await search.touch(f.path);
  return f;
});

handle("connections:list", () => {
  if (!connectionsEnabled) return [];
  return connections.list();
});

handle("connections:get", id => { requireConnections(); return connections.get(id); });

handle("connections:add", input => { requireConnections(); return connections.add(input); });

handle("connections:update", (id, patch) => { requireConnections(); return connections.update(id, patch); });

/* Secrets travel on their own channel, one at a time, and go straight into the
   credential store. They are never part of a connection record, so they cannot
   come back out on connections:get. */
handle("connections:setSecret", async (id, key, value) => {
  requireConnections();
  const allowed = ["client_id", "client_secret"];
  const name = String(key);
  const ok = allowed.includes(name) || /^env:[A-Za-z_][A-Za-z0-9_]*$/.test(name);
  if (!ok) throw new Error("That is not a credential Inkju stores.");
  const r = await secretsFor(id, name, value);
  return { stored: r.stored };
});

async function secretsFor(id, key, value){
  const secrets = require("./secrets");
  connections.raw(id);                       // throws if it does not exist
  return secrets.set(id, key, value);
}

/* Which credentials a connection has, by name. Never a value. */
handle("connections:secretKeys", async id => {
  requireConnections();
  const secrets = require("./secrets");
  connections.raw(id);
  return secrets.keys(id);
});

handle("connections:remove", async id => {
  requireConnections();
  return connections.remove(id, cid => mcp.disconnect(cid));
});

handle("connections:connect", async id => {
  requireConnections();
  const rec = connections.raw(id);
  try {
    return await mcp.connect(id);
  } catch (err) {
    /* An HTTP connection that needs authorization is a question, not a fault:
       answer it by running the flow rather than making the user find a button
       they have not been shown yet. */
    if (err.needsAuthorization && rec.transport === "http") return authorizeConnection(id);
    throw err;
  }
});

handle("connections:authorize", id => { requireConnections(); return authorizeConnection(id); });

handle("connections:disconnect", id => { requireConnections(); return mcp.disconnect(id); });

/* What the allowlist editor should propose for a freshly connected server. */
handle("connections:proposeAllow", (id, needs) => {
  requireConnections();
  return connections.proposeAllow(id, needs);
});

/* Status and tool-surface changes are pushed rather than polled, so a
   connection that drops updates the interface without anyone asking. */
connections.events.on("status", e => broadcast("connections:status", e));
connections.events.on("changed", e => broadcast("connections:changed", e));
connections.events.on("tools-appeared", e => broadcast("connections:tools-appeared", e));

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
  /* Child processes and sockets do not outlive the app. Without this a stdio
     server keeps running after the window closes, holding the vault open. */
  app.on("before-quit", () => { store.flush(); mcp.disconnectAll().catch(() => {}); });
}
