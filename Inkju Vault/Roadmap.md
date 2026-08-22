---
title: Roadmap
tags: [inkju, roadmap]
---

# Roadmap

Open threads, taken from the known limits and the Typora parity table in
[[README]]. Nothing here is committed work. Back to [[Index]].

## Known limits worth closing

- **Inline syntax hiding.** The focused block shows raw markdown. Typora hides
  syntax inline, per element. Matching that needs a contenteditable engine,
  which is where most clones lose their footing. Rich text mode sidesteps it
  rather than solving it.
- **Rich text round trip.** Rich mode goes through HTML, so it normalises what
  it writes: loose lists come back tight, reference style links become inline.
  Diagrams and display maths appear there as editable code blocks rather than
  rendered.
- **Light build maths and diagrams.** Diagrams cover `graph TD/LR` only, LaTeX
  covers the common set. Deliberate, to keep the file single and unbundled.

## Parity gaps still marked missing

- Equation auto numbering. `\tag{}` works, automatic counters do not.
- `flow` and `sequence` legacy fences, which Typora bundles.
- Image upload services (PicGo, iPic).
- Image sizing via `<img>` attributes.
- PDF bookmarks on export.
- Custom CSS themes loaded from a folder.
- Custom keybindings.
- Selection only word count.

## Shipping and updates

Applying an update in place would need a Developer ID signature, which these
builds do not have, so the updater downloads and opens the DMG instead. With a
Developer ID and notarisation that last step could become a real auto update.

## Small fixes

- The README says "Fourteen tools" above a list of fifteen. See [[MCP Server]].

#roadmap
