# Field Notes

Rich text mode runs **TipTap** over the same markdown file. Formatting applies to the selection — the syntax never appears at all, and the document is written back out as plain markdown when you leave.

## What survives the round trip

- [x] Headings, emphasis, `code` and ~~strikethrough~~
- [x] Tables, with drag-to-resize columns
- [ ] Task lists, links and images

| Feature | Block mode | Rich mode |
| --- | --- | --- |
| Sees markdown | on focus | never |
| Same file | yes | yes |

> Select any of this text and the formatting bubble appears.

```js
const mode = 'rich';
```
