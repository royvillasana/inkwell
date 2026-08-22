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

contextBridge.exposeInMainWorld("inkju", {
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
    rename: (root, name) => call("vault:rename", root, name),
    close: () => call("vault:close"),
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

  /* Outside sources. Every reply here has already been through the public
     shape in connections.js, so what arrives is a label, a status and a list
     of tool names — never a token, a client secret or a transport handle.
     Secrets only ever travel outward, one at a time, on setSecret. */
  connections: {
    enabled: () => call("connections:enabled"),
    list: () => call("connections:list"),
    get: id => call("connections:get", id),
    add: input => call("connections:add", input),
    update: (id, patch) => call("connections:update", id, patch),
    remove: id => call("connections:remove", id),
    connect: id => call("connections:connect", id),
    authorize: id => call("connections:authorize", id),
    disconnect: id => call("connections:disconnect", id),
    proposeAllow: (id, needs) => call("connections:proposeAllow", id, needs),
    setSecret: (id, key, value) => call("connections:setSecret", id, key, value),
    secretKeys: id => call("connections:secretKeys", id),
    presets: () => call("connections:presets")
  },

  /* Files that live in a connection, never on this disk. */
  cloud: {
    capabilities: id => call("cloud:capabilities", id),
    list: (id, opts) => call("cloud:list", id, opts),
    read: (id, remoteId, entry) => call("cloud:read", id, remoteId, entry),
    write: (id, remoteId, text, opts) => call("cloud:write", id, remoteId, text, opts),
    conflict: (id, remoteId, version) => call("cloud:conflict", id, remoteId, version),
    import: (id, remoteId, entry) => call("cloud:import", id, remoteId, entry)
  },

  /* iCloud Drive. A folder that syncs, not a connection — kept separate in the
     bridge for the same reason it is kept separate in the interface. */
  icloud: {
    info: () => call("icloud:info"),
    openVault: () => call("icloud:openVault"),
    conflicts: dir => call("icloud:conflicts", dir)
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

  updates: {
    check: () => call("updates:check"),
    download: asset => call("updates:download", asset),
    install: file => call("updates:install", file),
    openPage: () => call("updates:page")
  },

  win: {
    create: () => call("window:new"),
    title: (title, filePath) => call("window:title", title, filePath),
    edited: flag => call("window:edited", flag)
  },

  system: {
    openExternal: url => call("shell:open", url),
    copy: text => call("clipboard:write", text),
    confirm: opts => call("confirm", opts),
    prefersDark: () => call("theme:system")
  },

  on: {
    menu: fn => listen("menu", fn),
    openPaths: fn => listen("open-paths", fn),
    vaultChanged: fn => listen("vault:changed", fn),
    themeChanged: fn => listen("theme:changed", fn),
    updateProgress: fn => listen("update:progress", fn),
    connectionStatus: fn => listen("connections:status", fn),
    connectionsChanged: fn => listen("connections:changed", fn),
    connectionToolsAppeared: fn => listen("connections:tools-appeared", fn),
    icloudDownloading: fn => listen("icloud:downloading", fn)
  }
});
