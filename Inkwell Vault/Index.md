---
title: Inkwell
tags: [inkwell]
---

# Inkwell

A quiet markdown editor for the desktop, in the spirit of Typora: the block
under your caret shows its markdown source, everything else shows finished,
rendered prose.

This vault is the project's own documentation, kept as notes so the app can
read its own manual.

## Start here

- [[README]]: the full project readme: both builds, what the desktop build adds, layout, security, tests, packaging, Typora parity.
- [[Updates]]: release history by version, plus what has landed since 2.1.2.
- [[MCP Server]]: the fifteen tools an agent gets when it works inside a vault.
- [[Roadmap]]: what is still open, and ideas worth trying.

## At a glance

| | |
| --- | --- |
| Version | 2.1.2 |
| Builds | `Inkwell.html` (light) and `desktop/` (Electron) |
| Licence | MIT |
| Author | Roy Villasana |
| Site | https://royvillasana.github.io/inkwell/ |
| Releases | https://github.com/royvillasana/inkwell/releases/latest |

## The shape of it

Two builds share one hand written markdown engine and one editing model. They
differ in what the surrounding application can do: the light build is a single
156 KB file you can email, the desktop build has a real filesystem, a vault, a
search index, Mermaid, KaTeX and a TipTap rich text surface.

Neither build fetches anything from a network while you write. The desktop
build makes exactly one request, ever: an update check against GitHub's
releases API, which carries no identifiers and can be switched off.

#inkwell #docs
