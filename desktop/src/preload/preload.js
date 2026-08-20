"use strict";
/* The only bridge between the renderer and Node. Nothing else is exposed:
   contextIsolation is on and the renderer never sees require, fs or ipcRenderer. */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

/* Every main-process handler answers {ok,data} or {ok:false,error}.
   Unwrap here so callers can simply await a value and catch a throw. */
async function call(channel, ...args){
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res) return null;
  if (res.ok) return res.data;
  throw new Error(res.error || "Unknown error");
}

const listen = (channel, fn) => {
  const wrapped = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld("inkwell", {
  platform: process.platform,
  isDesktop: true,
  /* webUtils is the only way to learn a dropped file's path since Electron 32,
     and it must survive the sandboxed preload for drag-and-drop to work */
  canReadDroppedPaths: !!(webUtils && webUtils.getPathForFile),

  settings: {
    get: () => call("settings:get"),
    set: patch => call("settings:set", patch)
  },

  file: {
    openDialog: () => call("dialog:openFile"),
    read: p => call("file:read", p),
    write: (p, text) => call("file:write", p, text),
    saveAs: (suggested, text) => call("file:saveAs", suggested, text),
    create: (dir, name, contents) => call("file:create", dir, name, contents),
    rename: (p, next) => call("file:rename", p, next),
    remove: p => call("file:delete", p),
    reveal: p => call("file:reveal", p),
    stat: p => call("file:stat", p),
    /* Electron 32+ hides File.path; this is the supported way to read it */
    pathOf: f => { try { return webUtils.getPathForFile(f); } catch (e) { return null; } }
  },

  vault: {
    openDialog: () => call("dialog:openVault"),
    open: root => call("vault:open", root),
    tree: () => call("vault:tree"),
    search: (q, opts) => call("vault:search", q, opts),
    backlinks: name => call("vault:backlinks", name),
    unresolved: text => call("vault:unresolved", text),
    resolve: name => call("vault:resolve", name),
    tags: () => call("vault:tags"),
    byTag: tag => call("vault:byTag", tag),
    quickOpen: q => call("vault:quickOpen", q),
    reindex: () => call("vault:reindex")
  },

  image: {
    save: (noteFile, data, ext) => call("image:save", noteFile, data, ext),
    pick: noteFile => call("image:pick", noteFile)
  },

  history: {
    save: (name, text) => call("history:save", name, text),
    list: name => call("history:list", name),
    read: file => call("history:read", file)
  },

  pandoc: {
    info: () => call("pandoc:info"),
    export: (format, markdown, base, dir) => call("pandoc:export", format, markdown, base, dir)
  },

  exporter: {
    save: (suggested, contents, filters) => call("export:save", suggested, contents, filters),
    pdf: (suggested, html) => call("export:pdf", suggested, html),
    print: html => call("print", html)
  },

  assets: {
    css: () => call("assets:css"),
    katexCss: () => call("assets:katexCss")
  },

  win: {
    create: () => call("window:new"),
    title: (title, filePath) => call("window:title", title, filePath),
    edited: flag => call("window:edited", flag)
  },

  system: {
    openExternal: url => call("shell:open", url),
    confirm: opts => call("confirm", opts),
    prefersDark: () => call("theme:system")
  },

  on: {
    menu: fn => listen("menu", fn),
    openPaths: fn => listen("open-paths", fn),
    vaultChanged: fn => listen("vault:changed", fn),
    themeChanged: fn => listen("theme:changed", fn)
  }
});
