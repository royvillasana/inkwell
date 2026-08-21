# Inkwell

**[Download for Mac](https://github.com/royvillasana/inkwell/releases/latest) · [Try it in your browser](https://royvillasana.github.io/inkwell/try.html) · [Website](https://royvillasana.github.io/inkwell/)**

A markdown editor in the spirit of Typora: the block under your caret shows its
markdown source, everything else shows finished, rendered prose.

There are two builds in this repository. They share the same markdown engine and
the same editing model — they differ in what the surrounding application can do.

| | **Light** | **Desktop** |
| --- | --- | --- |
| File | `Inkwell.html` | `desktop/` |
| Size | one 156 KB file | Electron app, 115 MB download |
| Install | none — double-click it | `npm install && npm start` |
| Dependencies | zero | Electron only |
| Files | one at a time, browser pickers | real filesystem, autosave, file watching |
| Folders | flat list (Chrome/Edge only) | full vault with nested folders |
| Search | current document | every note in the vault |
| Links | `[[wiki links]]` inside one folder | resolved across the vault, with backlinks |
| Diagrams | built-in flowcharts | real Mermaid, every diagram type |
| Editing | block live preview | block live preview **plus** TipTap rich text |
| Maths | MathML subset | real KaTeX with mhchem |
| Images | embedded as base64 | saved beside the note, linked relatively |
| Sharing | email the file, it just works | package a real app |

Both support: live block preview, tabs, split view, presentation mode, outline,
version history, focus and typewriter modes, four themes, a command palette,
slash commands, auto-pairing, table tools, find and replace with regex, writing
goals, and export to HTML, PDF, Word, plain text and markdown.

Markdown coverage in both: headings, emphasis, strikethrough, highlight, inline
and fenced code with syntax highlighting for ~90 languages, links, images,
footnotes, tables with alignment, nested and task lists, blockquotes and
callouts, horizontal rules, YAML front matter, `[TOC]`, `#tags`, emoji
shortcodes, LaTeX maths and diagrams.

The markdown parser is hand-written and shared by both builds. Where they part
company is maths and diagrams: the light build renders LaTeX to native MathML
and draws its own flowcharts, so it stays a single file with nothing bundled;
the desktop build ships real KaTeX and real Mermaid. Neither fetches anything
from a network.

---

## Light build

```bash
open Inkwell.html
```

That is the whole story. It runs from `file://`, needs no server, and keeps a
draft in the browser's local storage so a refresh never loses work. In Chrome
and Edge, `⌘S` writes back to the original file through the File System Access
API; in other browsers it downloads a copy.

Use it when you want to hand someone an editor as a single attachment.

---

## Desktop build

Prebuilt: **[Inkwell-2.1.6-arm64.dmg](https://github.com/royvillasana/inkwell/releases/latest)**
(macOS, Apple Silicon). The build is unsigned, so on first launch right-click the
app and choose **Open**, or run `xattr -dr com.apple.quarantine /Applications/Inkwell.app`.

From source:

```bash
cd desktop
npm install
npm start
```

If your npm blocks install scripts, approve Electron's so the runtime binary
downloads: `npm approve-scripts electron`.

### What the desktop build adds

- **Rich text mode** — the default view (`⌘R` switches back), a full WYSIWYG surface built on
  [TipTap](https://tiptap.dev) / ProseMirror, over the same markdown file.
  Markdown syntax never appears; formatting applies to the selection through a
  floating bubble menu, tables resize by dragging, and the document is written
  back out as plain markdown when you leave. Two menus follow the caret: a
  bubble menu over a selection, and a floating insert menu on an empty line.
  Typing `/` opens the same vocabulary as a filterable list, driven from the
  keyboard — headings, lists, quotes, code, tables, maths, diagrams, images,
  rules and the date. The block editor and rich mode are two views of one file
  — switch freely.
- **Vaults.** Open a folder and get a real tree with nested directories, plus
  create, rename, reveal and move-to-trash from the context menu.
- **Search across every note**, with case, whole-word and regex switches, line
  numbers and match context. Click a hit to open that note at that line.
- **Wiki links that resolve**, with a backlinks panel and an offer to create a
  note that does not exist yet.
- **Quick open** (`⌘⇧K`) with fuzzy name matching over the whole vault.
- **A vault bar** at the top of the sidebar naming the vault you are in and how
  much is in it. Click it to make a note, reveal the folder, copy its path,
  rename the vault, switch to another, or close it.
- **Autosave** to disk, **file watching** with reload, and a conflict prompt if
  a file changes underneath unsaved edits.
- **Images** are written into an `assets/` folder next to the note and linked
  relatively, instead of being inlined as base64.
- **Version history** on disk in `.inkwell/history`, one snapshot per save and
  one every five minutes while writing.
- **Native menus**, recent files, multiple windows, session restore, file
  associations for `.md`, and PDF export rendered by the app rather than a
  browser print dialog.
- **Update notices.** Inkwell asks GitHub's releases API whether a newer
  version exists, and shows a small card in the bottom left if so. Its button
  downloads the disk image and opens it. This is the only network request the
  app makes, it carries no identifiers, and Preferences can switch it off.
  Applying an update in place would need a Developer ID signature, which these
  builds do not have — see the note under Packaging.

### Letting an agent work in your vault

`desktop/src/mcp/server.mjs` is an [MCP](https://modelcontextprotocol.io) server
that gives Claude Code — or any MCP client — vault-aware access to your notes:

```bash
claude mcp add inkwell --scope user -- node /path/to/desktop/src/mcp/server.mjs
```

That path is a **source checkout** with `npm install` run in `desktop/` — the
server needs the MCP SDK from `node_modules`. The copy inside the packaged
`.app` cannot run on its own: the SDK is a build-time dependency and is not
shipped in the bundle.

With no `--vault` argument it serves whichever vault Inkwell currently has
open, and keeps doing so: it re-reads the app's choice on every call, so
switching vaults in the window moves the agent too. Pass `--vault <folder>` or
set `INKWELL_VAULT` to pin it somewhere instead, for the life of the process.

An agent could already edit these files with ordinary filesystem tools — they
are plain markdown. What this adds is the vault: full-text search, backlinks,
tags, wiki-link resolution, outlines, and edits that work on structure
(`append_to_note` under a heading, `replace_section`) rather than raw text.

Fourteen tools: `list_notes`, `read_note`, `search_notes`, `create_note`,
`write_note`, `append_to_note`, `replace_section`, `note_outline`,
`rename_note`, `trash_note`, `backlinks`, `list_tags`, `notes_by_tag`,
`unresolved_links`, `vault_info`.

Three rules it will not break:

- **Nothing leaves the vault.** Every path an agent supplies is resolved and
  checked against the vault root; `../../../etc/passwd` is refused, as is an
  absolute path elsewhere.
- **Nothing is deleted.** `trash_note` moves a note to `.trash` inside the
  vault.
- **Nothing is one-way.** Every edit snapshots the previous version first, so
  an agent's changes appear in Inkwell's version history like your own.

The app picks agent edits up through the same file watcher it uses for any
other external change, so notes refresh while you watch.

### Layout

```
desktop/
  src/
    main/          Node side: windows, IPC, filesystem, vault index, menu
      main.js        app lifecycle, all IPC handlers, watcher
      files.js       atomic writes, tree listing, images, snapshots
      search.js      full-text index, backlinks, tags, quick open
      store.js       settings in the OS app-data folder
      menu.js        native menu; items send commands to the renderer
    preload/
      preload.js     the only bridge — contextBridge, no Node in the renderer
    renderer/
      index.html     shell
      css/           app.css (document + themes), desktop.css (window chrome)
      js/
        markdown.js  the engine: pure functions, no DOM
        editor.js    block editor; owns the document and caret, emits hooks
        dialogs.js   in-app dialogs
        aids.js      auto-pairing, slash menu, table tools, goal ring
        vault.js     sidebar: tree, search, tags, backlinks
        app.js       tabs, disk I/O, views, commands, boot
        rich.js      real Mermaid and KaTeX, loaded from vendor/
        rich-editor.js  rich text mode: TipTap over the same markdown
        convert.js   HTML <-> markdown, clipboard, smart punctuation
      vendor/        mermaid, katex, turndown and the tiptap bundle
  test/
    run.js             main-process tests, plain node
    smoke-renderer.js  runs inside a real window
```

### Security

`contextIsolation` on, `nodeIntegration` off, `sandbox` on, and a
Content-Security-Policy that permits only local scripts. The renderer has no
`require`, no `fs` and no `ipcRenderer`; every privileged action goes through a
named channel in `preload.js`. External links open in the real browser. Deletes
go to the system Trash, never `unlink`. Saves are written to a temp file and
renamed, so a crash cannot truncate a note.

### Tests

```bash
npm test          # 31 main-process tests: files, search, backlinks, assets, vendor, pandoc
npm run test:app  # boots a real window and asserts 21 renderer checks
npm run test:all
```

### Packaging

```bash
npm run dist:mac     # dmg + zip
npm run dist:win     # nsis installer + portable
npm run dist:linux   # AppImage + deb
```

Unsigned builds warn on first launch. Add signing credentials to the `build`
block in `package.json` before shipping to anyone else.

Ad-hoc signing is what makes the app launch at all (`scripts/adhoc-sign.js`),
but it is not enough for Squirrel.Mac to replace the app in place, so the
updater downloads and opens the DMG rather than installing silently. With a
Developer ID and notarisation, that last step could become a real
auto-update.

### Sample content

`desktop/example-vault/` holds four linked notes so the tree, search, tags and
backlinks have something to show on a first run. Point the app at your own
folder whenever you like — nothing about a vault is special, it is just a
directory of markdown files.

---

## Typora parity

The desktop build is the one chasing full parity; the light build stays small on
purpose. ✓ = done, ~ = partial, ✗ = not yet.

| Typora feature | Light | Desktop | Note |
| --- | :---: | :---: | --- |
| Live preview while typing | ~ | ✓ | Light: source shows for the focused **block**. Desktop adds a true inline WYSIWYG via TipTap (`⌘R`) |
| Selection formatting toolbar | ✗ | ✓ | Bubble menu on a selection, insert menu on an empty line |
| Drag to resize table columns | ✗ | ✓ | In rich text mode |
| Auto-pair brackets and quotes | ✓ | ✓ | |
| Smart quotes, dashes, ellipses | ✗ | ✓ | Toggle in preferences |
| Emoji autocomplete on `:` | ~ | ✓ | Light build offers emoji through `/` only |
| Paste rich text as markdown | ✗ | ✓ | Via turndown, with GFM tables |
| Copy as markdown / rich text | ✗ | ✓ | |
| Focus and typewriter modes | ✓ | ✓ | |
| Source mode | ✓ | ✓ | |
| Headings, emphasis, strike, highlight, sub/sup | ✓ | ✓ | |
| Code fences, ~90 languages, line numbers | ✓ | ✓ | |
| Tables with alignment | ✓ | ✓ | Toolbar for rows, columns, alignment |
| Lists, nested lists, task lists | ✓ | ✓ | |
| Footnotes, YAML front matter, `[TOC]` | ✓ | ✓ | |
| Automatic heading numbers | ✗ | ✓ | |
| **Maths** | ~ | **✓** | Light: a LaTeX→MathML subset. Desktop: **real KaTeX** with mhchem |
| Equation auto-numbering | ✗ | ✗ | `\tag{}` works; automatic counters do not |
| **Diagrams** | ~ | **✓** | Light: hand-written `graph TD/LR`. Desktop: **real Mermaid** — flowchart, sequence, class, state, ER, gantt, pie, journey, mindmap, gitGraph |
| `flow` and `sequence` legacy fences | ✗ | ✗ | Typora also bundles flowchart.js and js-sequence-diagrams |
| File tree / vault | ~ | ✓ | |
| Search across all notes | ✗ | ✓ | Case, whole word, regex, line hits |
| Outline panel | ✓ | ✓ | |
| Recent files, autosave, file watching | ~ | ✓ | |
| Images copied beside the note | ✗ | ✓ | Relative links into `assets/` |
| Image upload services (PicGo, iPic) | ✗ | ✗ | |
| Image sizing via `<img>` attributes | ✗ | ✗ | |
| Export HTML / PDF / plain text | ✓ | ✓ | Desktop bakes diagrams and maths into both |
| PDF bookmarks | ✗ | ✗ | |
| Export docx, odt, rtf, LaTeX, EPUB, RST, MediaWiki, Textile, AsciiDoc, Org, OPML | ✗ | ✓ | Through Pandoc when installed |
| Themes | ✓ | ✓ | Four built in |
| Custom CSS themes from a folder | ✗ | ✗ | |
| Custom keybindings | ✗ | ✗ | |
| Multiple windows and tabs | ~ | ✓ | Light build has tabs, not windows |
| Word count | ✓ | ✓ | Selection-only count not done |

### Diagrams and maths in the desktop build

Mermaid and KaTeX are vendored into `src/renderer/vendor` by `npm run vendor`
(which `npm install` runs for you) and loaded from disk — the Content-Security-
Policy allows scripts from `'self'` only, so nothing is ever fetched. Diagrams
render asynchronously into placeholder hosts after a block is painted, are
cached by source and theme, and are baked into HTML and PDF exports because the
PDF window runs with JavaScript disabled.

### Pandoc

Install it and the extra export formats appear on their own:

```bash
brew install pandoc          # macOS
winget install --id JohnMacFarlane.Pandoc   # Windows
sudo apt install pandoc      # Debian, Ubuntu
```

Without it, HTML, PDF, `.doc`, markdown and plain text still work.

---

## Known limits

- The focused block shows raw markdown; Typora hides syntax inline, per element.
  Matching that needs a contenteditable engine, which is where most clones lose
  their footing.
- In the **light** build, diagrams cover `graph TD/LR` only and LaTeX covers the
  common set. The desktop build has the real libraries and neither limit.
- Rich text mode round-trips through HTML, so it normalises what it writes:
  loose lists come back tight, and reference-style links become inline. Diagrams
  and display maths appear as editable code blocks there rather than rendered —
  the block editor still renders them.
- Raw HTML in a document is escaped and shown as text rather than executed.

---

## Releasing

```bash
cd desktop
npm run vendor              # refresh src/renderer/vendor from node_modules
npx electron scripts/icon.js  # regenerate build/icon.icns
npm run test:all
npm run dist:mac            # dist/Inkwell-<version>-arm64.dmg
gh release create v<version> desktop/dist/*.dmg
```

The landing page lives in `docs/` and is served by GitHub Pages from `main`.
`docs/try.html` is a copy of `Inkwell.html`, so refresh it when the light build
changes:

```bash
cp Inkwell.html docs/try.html
```
