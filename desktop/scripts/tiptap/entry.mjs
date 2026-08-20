/* Bundle entry for the rich-text editor. esbuild rolls this and everything it
   imports into one ESM file under src/renderer/vendor/tiptap, because the
   renderer's CSP only allows scripts from the app itself. */
export { Editor } from "@tiptap/core";
export { StarterKit } from "@tiptap/starter-kit";
export { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
export { TaskList } from "@tiptap/extension-task-list";
export { TaskItem } from "@tiptap/extension-task-item";
export { Link } from "@tiptap/extension-link";
export { Highlight } from "@tiptap/extension-highlight";
export { Typography } from "@tiptap/extension-typography";
export { Placeholder } from "@tiptap/extension-placeholder";
export { Image } from "@tiptap/extension-image";
