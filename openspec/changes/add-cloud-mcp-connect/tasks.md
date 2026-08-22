## 1. Foundations

- [x] 1.1 Move `@modelcontextprotocol/sdk` from `devDependencies` to `dependencies` in `desktop/package.json`, pinned to the v1.x minor already in use, and confirm `npm run test:mcp` and `npm start` still pass
- [x] 1.2 Add a `connections: []` default to `src/main/store.js` and confirm an existing `settings.json` without the key loads unchanged
- [x] 1.3 Add a `--connections` dev flag in `src/main/main.js` that gates every new surface, so the feature can ship dark
- [x] 1.4 Create `src/main/secrets.js`: async `safeStorage` wrapper over a `secrets.json` in `userData`, with `isEncryptionAvailable()` checked first, in-memory-only fallback, no plaintext path, and `delete(connectionId)`
- [x] 1.5 Unit-test `secrets.js` for round-trip, unavailable-encryption fallback, decryption failure, and that nothing is ever written unencrypted

## 2. Connection registry

- [x] 2.1 Create `src/main/connections.js`: the record shape (id, label, transport, config, enabled, allowlist), CRUD over the store, and the status state machine (`disconnected` / `connecting` / `connected` / `needs-authorization` / `failed`)
- [x] 2.2 Wire removal to disconnect the transport, terminate any child process, and call `secrets.delete()`
- [x] 2.3 Add IPC handlers in `main.js` for list, add, update, remove, connect, disconnect and status, all returning the existing `{ok,data}` shape
- [x] 2.4 Add the `inkju.connections` namespace to `src/preload/preload.js`, plus a status-change listener, and assert no credential field can appear in any payload it returns
- [x] 2.5 Test that a fresh profile with no connections makes no outbound request and spawns no child process

## 3. MCP client — transports

- [x] 3.1 Create `src/main/mcp-client.js` with a `connect(record)` that returns a live client, handling the initialize handshake and `tools/list`
- [x] 3.2 Implement the stdio transport path: spawn command/args/env, surface stderr on failure, no auto-install, no respawn loop
- [x] 3.3 Implement the Streamable HTTP transport path with `StreamableHTTPClientTransport`, refusing non-loopback `http://` URLs
- [x] 3.4 Implement `callTool(connectionId, name, args)` with the allowlist check performed **before** any request leaves the process
- [x] 3.5 Validate every tool response against its expected schema and enforce the remote size limit, failing the operation rather than coercing
- [x] 3.6 Record the tool list per connection, mark newly appeared tools disabled, and emit a notification when the tool surface changes
- [x] 3.7 Test against a local fixture MCP server over stdio: connect, list tools, call an allowed tool, be refused on a disallowed one

## 4. OAuth

- [x] 4.1 Create `src/main/oauth.js` implementing the SDK's `OAuthClientProvider` interface backed by `secrets.js`
- [x] 4.2 Implement discovery: parse `WWW-Authenticate` for `resource_metadata` and `scope`, fetch RFC 9728 protected resource metadata, then AS metadata via **both** RFC 8414 and OpenID Connect Discovery
- [x] 4.3 Implement client registration precedence: pre-registered client ID/secret (the Google Drive path), Client ID Metadata Documents, then RFC 7591 dynamic registration as the fallback
- [x] 4.4 Implement the loopback callback listener — bound to `127.0.0.1` only, ephemeral port, one flow, torn down on completion, failure or cancellation — with `state` bound to the flow
- [x] 4.5 Build the authorization request: PKCE parameters, RFC 8707 `resource` set to the server's canonical URI, scope per the selection strategy, expected issuer recorded alongside the verifier; open it with `shell.openExternal`
- [x] 4.6 Implement RFC 9207 `iss` validation before the code is sent anywhere, including the rule that error responses must not be acted on or displayed on mismatch
- [x] 4.7 Implement the token exchange, credential storage, and reconnect on a **fresh** transport instance
- [x] 4.8 Implement silent refresh, and mark the connection `needs-authorization` when refresh fails
- [x] 4.9 Implement step-up on `403 insufficient_scope`: re-authorize with the union of prior and challenged scopes, at most three retries, then permanent failure
- [x] 4.10 Test the flow end to end against a local fake authorization server: happy path, `state` mismatch, `iss` mismatch, cancelled flow, expired token refresh, insufficient-scope step-up

## 5. Cloud file access

- [x] 5.1 Define the provider shape that maps a connection's tools onto list / search / read / write / metadata, with a Google Drive mapping (`search_files`, `read_file_content`, `get_file_metadata`, `list_recent_files`, `create_file`) as the first implementation
- [x] 5.2 Build the cloud browser panel in `src/renderer/js/connections.js`: list, search, name/modified/size columns, connection status when not connected, no file bodies transferred
- [x] 5.3 Open a remote markdown file in a tab carrying `{connectionId, remoteId, version, writable}`; show the originating connection in the tab
- [x] 5.4 Refuse non-text and oversized files in the editor and offer save-to-vault instead
- [x] 5.5 Disable autosave for remote tabs and state it in the UI
- [x] 5.6 Implement save: re-read the version marker, detect conflict, and offer keep-mine / keep-theirs / save-a-copy; treat a missing version marker as always potentially conflicting
- [x] 5.7 Implement read-only degradation — no allowed write tool means `⌘S` offers save-to-vault
- [x] 5.8 Implement import-to-vault through the existing atomic write path, with filename sanitisation and the `within()` path guard, choosing a non-colliding name
- [x] 5.9 Keep the remote tab readable and non-lossy when the connection drops; make saving fail loudly rather than silently
- [x] 5.10 Make version history, backlinks and the search index state plainly that they cover vault files only when invoked in a remote tab

## 6. Connections UI

- [x] 6.1 Build the Connections surface in Settings: list, status, add, edit, enable/disable, remove
- [x] 6.2 Build the add-connection flow for stdio, showing the exact command, arguments and non-secret environment before confirmation, with the package named on any install prompt
- [x] 6.3 Build the add-connection flow for HTTP, including the HTTPS-only validation message
- [x] 6.4 Build the tool allowlist editor: deny-by-default, read tools pre-ticked, write tools unticked, newly appeared tools flagged
- [x] 6.5 Build the confirmation dialog for remote writes, renames, moves and deletes, with a per-connection "don't ask again" defaulting to off and never applying to deletions
- [x] 6.6 Ship the Google Drive preset as a JSON descriptor plus a setup walkthrough that links the Google Cloud console and validates the client ID/secret before connecting
- [x] 6.7 Add menu entries in `src/main/menu.js` for Connections and the cloud browser

## 7. iCloud Drive

- [x] 7.1 Create `src/main/icloud.js`: detect `~/Library/Mobile Documents/com~apple~CloudDocs/` on macOS, absent elsewhere without error
- [x] 7.2 Add the iCloud entry to the Connections list, worded as a synced folder — no account, no API, no MCP claim
- [x] 7.3 Detect dataless placeholders before reading, and guarantee that tree walks and index builds never trigger materialization
- [x] 7.4 Materialize on explicit open with a downloading indicator, and report failure rather than opening empty content
- [x] 7.5 Resolve `.<name>.icloud` stubs to their real note and filter the stubs out of the sidebar, marking the note as not downloaded
- [x] 7.6 Detect conflicted copies, surface them as conflicts with a compare option, and never merge or delete on the app's own initiative
- [x] 7.7 Verify the atomic write against iCloud file coordination; move the temp file outside the synced tree if `.tmp` artefacts sync or race the rename — **verified against a real iCloud Drive: ~4 ms window, no artefacts, nothing pending. No change needed.**
- [x] 7.8 Handle eviction of an open note: keep the in-memory copy, re-materialize before saving
- [x] 7.9 Test against a large, mostly-evicted iCloud vault and confirm indexing triggers no downloads

## 8. Security verification

- [x] 8.1 Assert in tests that no IPC payload reaching the renderer contains a token, code, verifier or client secret, and that error messages are scrubbed
- [x] 8.2 Assert the renderer CSP, `contextIsolation`, `sandbox` and `nodeIntegration: false` are unchanged by this work
- [x] 8.3 Test that remote markdown containing script tags and event-handler attributes renders as escaped text
- [x] 8.4 Test path traversal in remote filenames (`../../.ssh/authorized_keys`) and collision handling on import
- [x] 8.5 Test that a disabled connection is neither connected nor token-refreshed
- [x] 8.6 Run `/security-review` over the finished diff and resolve every finding before release — **2 findings, both true positives, both fixed and regression-tested against a hostile MCP server.**

## 9. Documentation and release

- [x] 9.1 Document Connections in the README, keeping the offline claim accurate: with no connections configured, Inkju fetches nothing
- [x] 9.2 Write the Google Drive setup guide (own OAuth client, scopes, Developer Preview caveat)
- [x] 9.3 Document the iCloud Drive limitation honestly — no Apple API exists; this is the local synced folder
- [x] 9.4 Add the new tests to `npm run test:all`
- [x] 9.5 Ship behind `--connections` — **done; the flag is in place and the smoke run proves a build without it is inert.** Promotion to prerelease and removal of the flag are release steps, not code, and need a real Google account.

## 10. Phase 2 handoff

- [x] 10.1 Decide the encryption posture (client-side E2EE for note bodies vs server-side only) **before** any Supabase schema exists — it is not retrofittable — **DECIDED: client-side E2EE for note bodies, plaintext metadata, recovery key at setup. Recorded in design.md and carried into both Phase 2 proposals.**
- [x] 10.2 Open a follow-up change `add-inkju-accounts` for Supabase auth, per-user Storage with the folder-isolation RLS policy, and entitlements
- [x] 10.3 Open a follow-up change `add-vault-sync` for the sync engine, reusing this change's conflict UI for last-writer-wins
