---
title: Updates
tags: [inkju, releases]
---

# Updates

Release history for Inkju, newest first. Current version: **2.1.2**.
Back to [[Index]].

| Version | Tag | Date | Headline |
| --- | --- | --- | --- |
| Unreleased | none | 2026-08-21 | MCP server, update notices, tooltips |
| 2.1.2 | `v2.1.2` | 2026-08-21 | Rich text by default |
| 2.1.1 | `v2.1.1` | 2026-08-21 | Slash menu, truthful autosave indicator |
| 2.1.0 | `v2.1.0` | 2026-08-20 | Rich text mode, landing page, DMG fix |
| 2.0.0 | `v2.0.0` | 2026-08-20 | A markdown editor in two builds |

## Unreleased

On `main`, not yet cut as a release.

- **An MCP server.** `desktop/src/mcp/server.mjs` gives Claude Code, or any MCP
  client, vault aware access to your notes: full text search, backlinks, tags,
  wiki link resolution, outlines, and edits that work on structure rather than
  raw text. Three rules it will not break: nothing leaves the vault, nothing is
  deleted outright, nothing is one way. Details in [[MCP Server]].
- **Update notices.** Inkju asks GitHub's releases API whether a newer version
  exists and shows a small card in the bottom left if so. Its button downloads
  the disk image and opens it. This is the only network request the app makes,
  it carries no identifiers, and Preferences can switch it off.
- **Rename the document by double-clicking its name.**
- **Views become one choice**, with styled as the default, instead of two
  separate toggles.
- **Toolbar tooltips**: instant rather than delayed, wrapping instead of
  truncating, and the styled tooltip now says just that.

## 2.1.2: rich text by default

Rich text is now the view you land in. Styling moves out of the toolbar and
into the menus, so the writing surface stays quiet. `⌘R` switches back to the
block editor at any time; the two are views of one file, so you can move
between them freely.

## 2.1.1: slash menu, and a truthful autosave indicator

- **The slash menu.** Typing `/` in rich text opens the whole insert vocabulary
  as a filterable, keyboard driven list: headings, lists, quotes, code, tables,
  maths, diagrams, images, rules and the date.
- **A floating insert menu** on an empty line, alongside the bubble menu that
  already appeared over a selection.
- Rich text mode moved to `⌘R`.
- The autosave indicator now reports what actually happened rather than
  assuming success.

## 2.1.0: rich text mode, and a landing page

- **Rich text mode built on TipTap / ProseMirror**, a full WYSIWYG surface over
  the same markdown file. Markdown syntax never appears, formatting applies to
  the selection through a floating bubble menu, tables resize by dragging, and
  the document is written back out as plain markdown when you leave.
- **A landing page** in `docs/`, served by GitHub Pages, with the real editor
  embedded and a build comparison table.
- **App icon and MIT licence.**
- **Fixed the DMG failing to launch.** Ad hoc signing in
  `scripts/adhoc-sign.js` is what makes an unsigned build open at all.

## 2.0.0: a markdown editor in two builds

The first release: the light single file build and the Electron desktop build,
sharing one hand written markdown parser and one editing model. Live block
preview, tabs, split view, presentation mode, outline, version history, focus
and typewriter modes, four themes, a command palette, auto pairing, table
tools, find and replace with regex, writing goals, and export to HTML, PDF,
Word, plain text and markdown.

#releases
