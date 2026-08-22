#!/usr/bin/env node
/* A deliberately small MCP server for the client tests. It exposes one tool of
   each shape the client has to cope with: a normal read, a write, a reply too
   large to accept, a reply with the wrong shape, and one that fails. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

if (process.env.FIXTURE_DIE === "1") {
  process.stderr.write("fixture: refusing to start, as instructed\n");
  process.exit(3);
}

const server = new McpServer({ name: "fixture", version: "1.0.0" });
const text = t => ({ content: [{ type: "text", text: t }] });

/* An in-memory store, so the conflict tests have something that can actually
   move under the client. */
const store = new Map([
  ["f1", { id: "f1", name: "Notes.md", size: 20, mimeType: "text/markdown", version: "1", body: "# Notes\n\nbody\n" }],
  ["big", { id: "big", name: "Huge.md", size: 9 * 1024 * 1024, mimeType: "text/markdown", version: "1", body: "" }],
  ["pic", { id: "pic", name: "Photo.png", size: 400, mimeType: "image/png", version: "1", body: "not text" }],
  ["dir", { id: "dir", name: "Folder", mimeType: "application/vnd.google-apps.folder", version: "1", isFolder: true }],
  ["evil", { id: "evil", name: "../../.ssh/authorized_keys", size: 10, mimeType: "text/plain", version: "1", body: "ssh-rsa AAAA\n" }]
]);
const meta = f => ({ id: f.id, name: f.name, size: f.size, mimeType: f.mimeType, version: f.version, isFolder: !!f.isFolder });

server.registerTool("list_recent_files",
  { description: "List files" },
  async () => text(JSON.stringify({ files: Array.from(store.values()).map(meta) })));

server.registerTool("get_file_metadata",
  { description: "One file's metadata", inputSchema: { fileId: z.string() } },
  async ({ fileId }) => {
    const f = store.get(fileId);
    if (!f) return { content: [{ type: "text", text: "no such file" }], isError: true };
    return text(JSON.stringify(meta(f)));
  });

server.registerTool("list_prose",
  { description: "List files, badly" },
  async () => text("here are your files, more or less"));

/* Moves a file under the client, the way a second device would. */
server.registerTool("bump_version",
  { description: "Test hook", inputSchema: { fileId: z.string() } },
  async ({ fileId }) => {
    const f = store.get(fileId);
    f.version = String(Number(f.version) + 1);
    return text(f.version);
  });

server.registerTool("search_files",
  { description: "Find files", inputSchema: { query: z.string() } },
  async ({ query }) => text(JSON.stringify([{ id: "f1", name: query + ".md", size: 12 }])));

server.registerTool("read_file_content",
  { description: "Read a file", inputSchema: { fileId: z.string().optional(), id: z.string().optional() } },
  async ({ fileId, id }) => {
    const f = store.get(fileId || id);
    if (!f) return text("# " + (fileId || id) + "\n\nbody\n");
    if (f.id === "big") return text("x".repeat(1024));   // claims 9 MB, sends little
    return text(f.body);
  });

server.registerTool("create_file",
  { description: "Write a file", inputSchema: { fileId: z.string().optional(), content: z.string().optional() } },
  async ({ fileId, content }) => {
    const f = store.get(fileId);
    if (f) { f.body = content || ""; f.version = String(Number(f.version) + 1); return text(JSON.stringify(meta(f))); }
    return text(JSON.stringify({ id: "new", name: "new.md", version: "1" }));
  });

server.registerTool("read_enormous",
  { description: "Reply with far too much" },
  async () => text("x".repeat(3 * 1024 * 1024)));

server.registerTool("read_misshapen",
  { description: "Reply with the wrong shape" },
  async () => ({ content: "not an array" }));

server.registerTool("read_angry",
  { description: "Fail" },
  async () => ({ content: [{ type: "text", text: "no" }], isError: true }));

if (process.env.FIXTURE_EXTRA === "1") {
  server.registerTool("delete_everything", { description: "New since last time" }, async () => text("gone"));
}

await server.connect(new StdioServerTransport());
