"use strict";
const { Menu, app, shell, BrowserWindow } = require("electron");
const store = require("./store");

/* Menu items do not act directly: they send a command to the focused window,
   so the renderer keeps a single code path for menus, palette and shortcuts. */
function send(cmd, arg){
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (win) win.webContents.send("menu", { cmd, arg });
}
const item = (label, accelerator, cmd, extra) =>
  Object.assign({ label, accelerator, click: () => send(cmd) }, extra || {});

function buildMenu(handlers){
  const mac = process.platform === "darwin";
  const recent = (store.get().recent || []).slice(0, 10);

  const template = [];

  if (mac) template.push({
    label: app.name,
    submenu: [
      { role: "about" },
      { type: "separator" },
      item("Preferences…", "Cmd+,", "prefs"),
      { type: "separator" },
      { role: "services" }, { type: "separator" },
      { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
      { type: "separator" }, { role: "quit" }
    ]
  });

  template.push({
    label: "File",
    submenu: [
      item("New Document", "CmdOrCtrl+N", "new"),
      item("New Window", "CmdOrCtrl+Shift+N", "new-window", { click: () => handlers.newWindow() }),
      { type: "separator" },
      item("Open File…", "CmdOrCtrl+O", "open"),
      item("Open Folder as Vault…", "CmdOrCtrl+Shift+O", "open-vault"),
      {
        label: "Open Recent",
        submenu: recent.length
          ? recent.map(r => ({ label: r.name, click: () => send("open-path", r.path) }))
              .concat([{ type: "separator" }, { label: "Clear Menu", click: () => { store.save({ recent: [] }); buildMenu(handlers); } }])
          : [{ label: "Nothing yet", enabled: false }]
      },
      { type: "separator" },
      item("Save", "CmdOrCtrl+S", "save"),
      item("Save As…", "CmdOrCtrl+Shift+S", "save-as"),
      item("Rename…", null, "rename"),
      { type: "separator" },
      {
        label: "Export",
        submenu: [
          item("HTML…", null, "export-html"),
          item("PDF…", null, "export-pdf"),
          item("Word (.doc)…", null, "export-doc"),
          item("Plain Text…", null, "export-txt"),
          { type: "separator" },
          item("More formats… (Pandoc)", null, "export-more")
        ]
      },
      item("Print…", "CmdOrCtrl+P", "print"),
      { type: "separator" },
      item("Reveal in " + (mac ? "Finder" : "File Manager"), null, "reveal"),
      item("Close Tab", "CmdOrCtrl+W", "close-tab"),
      mac ? { role: "close", label: "Close Window", accelerator: "Cmd+Shift+W" } : { role: "quit" }
    ]
  });

  template.push({
    label: "Edit",
    submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" },
      { role: "pasteAndMatchStyle", label: "Paste as Plain Text" },
      { type: "separator" },
      item("Copy as Markdown", "CmdOrCtrl+Shift+C", "copy-md"),
      item("Copy as Rich Text", null, "copy-html"),
      { role: "selectAll" },
      { type: "separator" },
      item("Find & Replace", "CmdOrCtrl+F", "find"),
      item("Search Vault", "CmdOrCtrl+Shift+F", "search-vault"),
      item("Quick Open", "CmdOrCtrl+O".replace("O", "P"), "quick-open"),
      { type: "separator" },
      {
        label: "Format",
        submenu: [
          item("Bold", "CmdOrCtrl+B", "fmt-bold"),
          item("Italic", "CmdOrCtrl+I", "fmt-italic"),
          item("Code", "CmdOrCtrl+E", "fmt-code"),
          item("Strikethrough", "CmdOrCtrl+U", "fmt-strike"),
          item("Highlight", "CmdOrCtrl+Shift+H", "fmt-mark"),
          item("Link…", "CmdOrCtrl+K", "fmt-link"),
          { type: "separator" },
          item("Heading 1", "CmdOrCtrl+1", "h1"),
          item("Heading 2", "CmdOrCtrl+2", "h2"),
          item("Heading 3", "CmdOrCtrl+3", "h3"),
          item("Paragraph", "CmdOrCtrl+0", "h0")
        ]
      },
      {
        label: "Insert",
        submenu: [
          item("Table", null, "ins-table"),
          item("Code Block", null, "ins-code"),
          item("Math Block", null, "ins-math"),
          item("Diagram", null, "ins-diagram"),
          item("Table of Contents", null, "ins-toc"),
          item("Horizontal Rule", null, "ins-hr"),
          item("Image from File…", null, "ins-image")
        ]
      }
    ]
  });

  template.push({
    label: "View",
    submenu: [
      item("Toggle Sidebar", "CmdOrCtrl+\\", "sidebar"),
      item("Outline", null, "pane-outline"),
      item("Vault Search", null, "pane-search"),
      item("Tags", null, "pane-tags"),
      { type: "separator" },
      item("Source Mode", "CmdOrCtrl+/", "source"),
      item("Styled Mode", null, "styled"),
      item("Rich Text Mode", "CmdOrCtrl+R", "rich"),
      item("Split View", "CmdOrCtrl+Shift+P".replace("P", "E"), "split"),
      item("Focus Mode", "CmdOrCtrl+Shift+F", "focus"),
      item("Typewriter Mode", null, "typewriter"),
      item("Presentation", "F5", "present"),
      { type: "separator" },
      item("Version History", "CmdOrCtrl+Shift+H".replace("H", "Y"), "history"),
      { type: "separator" },
      { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
      { role: "toggleDevTools", accelerator: mac ? "Alt+Cmd+I" : "Ctrl+Shift+I" }
    ]
  });

  template.push({
    label: "Window",
    submenu: mac
      ? [{ role: "minimize" }, { role: "zoom" }, { type: "separator" },
         item("Next Tab", "Ctrl+Tab", "next-tab"), item("Previous Tab", "Ctrl+Shift+Tab", "prev-tab"),
         { type: "separator" }, { role: "front" }]
      : [{ role: "minimize" }, item("Next Tab", "Ctrl+Tab", "next-tab"),
         item("Previous Tab", "Ctrl+Shift+Tab", "prev-tab")]
  });

  template.push({
    role: "help",
    submenu: [
      item("Check for Updates…", null, "check-updates"),
      { type: "separator" },
      item("Keyboard Shortcuts", null, "help"),
      item("Command Palette", "CmdOrCtrl+Shift+P", "palette"),
      { type: "separator" },
      { label: "Markdown Guide", click: () => shell.openExternal("https://commonmark.org/help/") }
    ]
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu, send };
