---
title: MCP Server
tags: [inkju, mcp, agents]
---

# MCP Server

`desktop/src/mcp/server.mjs` is an [MCP](https://modelcontextprotocol.io) server
that gives Claude Code, or any MCP client, vault aware access to your notes.
Back to [[Index]]. Shipped in the unreleased work listed in [[Updates]].

## Adding it

```bash
claude mcp add inkju --scope user -- node /path/to/desktop/src/mcp/server.mjs
```

With no `--vault` argument it serves whichever vault Inkju currently has
open, read from the app's own `settings.json`, so the agent and the window you
are looking at never disagree. Pass `--vault <folder>` or set `INKJU_VAULT`
to point it somewhere else. It refuses to start if neither resolves to a real
folder.

## Why not plain filesystem tools

An agent could already edit these files with ordinary read and write tools:
they are plain markdown. What the server adds is the vault. Full text search,
backlinks, tags, wiki link resolution, outlines, and edits that work on
structure (`append_to_note` under a heading, `replace_section`) rather than on
raw text.

It reuses the app's own `files.js` and `search.js` rather than reimplementing
them, so an agent gets the same atomic writes, the same tree rules and the same
index the sidebar searches.

## The three rules

- **Nothing leaves the vault.** Every path an agent supplies is resolved and
  checked against the vault root. `../../../etc/passwd` is refused, as is an
  absolute path elsewhere.
- **Nothing is deleted.** `trash_note` moves a note into `.trash` inside the
  vault.
- **Nothing is one way.** Every edit snapshots the previous version first, so an
  agent's changes appear in Inkju's version history exactly like your own.

The app picks agent edits up through the same file watcher it uses for any
other external change, so notes refresh while you watch.

## The tools

Fifteen, in four groups.

### Reading

| Tool | What it does |
| --- | --- |
| `list_notes` | Every markdown note as paths relative to the vault root. Optional `folder`. |
| `read_note` | The full markdown of one note. Accepts a relative path or just the name. |
| `search_notes` | Full text search with the matching lines and their context. Switches for `regex`, `caseSensitive`, `word`. |
| `note_outline` | The headings of a note with their levels and line numbers. |
| `vault_info` | Where the vault is and how much is in it. |

### Writing

| Tool | What it does |
| --- | --- |
| `create_note` | Makes a new note. Never overwrites: an existing name gets a numbered sibling. |
| `write_note` | Overwrites a note with new markdown, snapshotting first. |
| `append_to_note` | Adds markdown at the end of a note, or at the end of one section when a `heading` is given. |
| `replace_section` | Swaps everything under one heading, leaving the rest untouched. |

### Moving

| Tool | What it does |
| --- | --- |
| `rename_note` | Renames a note in place. Other notes' links are not rewritten. |
| `trash_note` | Moves a note into `.trash` inside the vault. |

### Structure

| Tool | What it does |
| --- | --- |
| `backlinks` | Notes whose `[[wiki links]]` point at the given note, with surrounding text. |
| `list_tags` | Every `#tag` in the vault with how often it appears. |
| `notes_by_tag` | The notes carrying one tag. |
| `unresolved_links` | `[[links]]` in a note that do not point at anything yet. |

## Note

The README currently says "Fourteen tools" and then lists fifteen. The code
registers fifteen. Worth a one word fix.

#mcp #agents
