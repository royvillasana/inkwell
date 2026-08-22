## Why

Inkju is a local-first markdown editor: everything it can edit has to be a file already sitting on this Mac. The notes people actually keep live somewhere else too — in Google Drive, in iCloud Drive — and today the only way to bring them together is to drag files around by hand. Meanwhile Inkju already ships an MCP *server* (`desktop/src/mcp/server.mjs`) that lets an agent work inside a vault, so the protocol is already in the codebase and already understood.

Turning that around — making Inkju an MCP **host** that connects *out* to the user's own cloud accounts — is the differentiator. It is also the load-bearing first step toward Inkju accounts and paid, cross-device sandbox space: a connection model, a credential vault, and a consent model that a later Supabase-backed sync can reuse rather than reinvent.

## What Changes

- **Inkju desktop becomes an MCP client (host).** A new main-process connection manager speaks MCP over two transports: `stdio` (spawns a local server the user configured) and Streamable HTTP (remote servers, with OAuth 2.1 + PKCE per the MCP authorization spec). The existing Inkju MCP server is untouched and keeps working in the other direction.
- **A Connections surface in Settings.** Add, name, authorize, health-check, disable and remove MCP servers. Each connection shows exactly which tools it exposes and which of those Inkju is allowed to call.
- **Google Drive as the flagship connection.** Google publishes an official remote Drive MCP server at `https://drivemcp.googleapis.com/mcp/v1` (Developer Preview; scopes `drive.readonly` and `drive.file`; tools including `search_files`, `read_file_content`, `create_file`). Inkju ships it as a one-click preset; the user supplies their own OAuth client ID/secret, exactly as Claude Desktop's custom connectors do. Any other Drive MCP server the user prefers works through the same generic path.
- **A cloud file browser.** Browse and search a connection's files from inside Inkju, preview markdown, and open a remote note in a normal Inkju tab. Saving writes back through the connection's write tool when the connection is writable, or lands a copy in the vault when it is not.
- **iCloud Drive, honestly.** Apple exposes no MCP server and no third-party API for iCloud Drive files — CloudKit only reaches a developer's own container, not the user's Documents. So iCloud is implemented as a **local provider**: Inkju can open a vault under `~/Library/Mobile Documents/com~apple~CloudDocs/…`, and learns to handle what that folder actually does — dataless placeholder files, on-demand materialization, sync conflicts, `.icloud` stubs. It appears in the same Connections list so the model stays coherent for the user, but nothing pretends it is MCP.
- **A security model, written down before the code.** Credentials never reach the renderer and are encrypted with Electron `safeStorage` (Keychain/DPAPI/libsecret). Every connection is deny-by-default on tools. Writes and deletes require explicit user confirmation. Remote content is treated as untrusted input: no auto-execution, size caps, and the same path guard the vault already uses.
- **Supabase researched, not built.** `design.md` records the evaluated design for Phase 2 — accounts, per-user sandbox space, cross-device sync, encryption posture, billing — so that work is decided rather than discovered. No Supabase dependency, table, or bucket is created by this change.
- Scope is the **desktop build only**. `Inkju.html` stays a single zero-dependency offline file. **No breaking changes.**

## Capabilities

### New Capabilities
- `mcp-connections`: adding, authorizing, connecting to, health-checking and removing MCP servers over stdio and Streamable HTTP; the OAuth 2.1 + PKCE flow; connection lifecycle and failure behaviour.
- `cloud-file-access`: discovering, previewing, opening, saving and importing files exposed by a connected source, and how remote documents behave in the editor's tabs, autosave and version history.
- `icloud-drive-vault`: opening a vault inside iCloud Drive, and correct behaviour around dataless placeholders, materialization, eviction and sync conflicts.
- `connection-security`: credential storage and lifetime, the per-connection tool allowlist, consent prompts for destructive operations, and the trust boundary applied to remote content.

### Modified Capabilities

None. `openspec/specs/` is empty; this change introduces the first specs.

## Impact

**New code** — `desktop/src/main/connections.js` (connection registry and lifecycle), `desktop/src/main/mcp-client.js` (transports, tool invocation), `desktop/src/main/oauth.js` (PKCE flow, loopback redirect listener), `desktop/src/main/secrets.js` (`safeStorage` wrapper), `desktop/src/main/icloud.js` (materialization-aware local provider), `desktop/src/renderer/js/connections.js` plus a cloud browser panel.

**Modified code** — `src/main/main.js` (new IPC handlers, loopback/protocol registration), `src/preload/preload.js` (a new `inkju.connections` bridge, still `{ok,data}`-shaped), `src/main/store.js` (connection records; secrets stored separately, never in `settings.json`), `src/main/files.js` (materialization-aware stat and read), `src/main/menu.js`, `desktop/test/`.

**Dependencies** — `@modelcontextprotocol/sdk` moves from `devDependencies` to `dependencies` (it is currently dev-only because the MCP server runs as a separate process). That is the only new runtime dependency; Electron's own `safeStorage` and `shell.openExternal` cover the rest.

**Security surface** — the first time Inkju holds user credentials, makes outbound network requests from the app process, and renders content it did not read off the local disk. `contextIsolation`, `sandbox`, `nodeIntegration: false` and the renderer CSP all stay as they are.

**Not in this change** — Supabase, Inkju accounts, billing, cross-device sync, the light build, and the web app.
