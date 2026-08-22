## Context

Inkju desktop is an Electron app with a deliberately narrow trust boundary. The renderer runs with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` and a CSP in `index.html`; the only bridge is `src/preload/preload.js`, whose every call unwraps a `{ok, data} | {ok:false, error}` reply from the main process. All filesystem access funnels through `src/main/files.js`, which owns the atomic write (temp file + rename) and the `within(root, target)` path guard. Settings are a small debounced JSON file in `app.getPath("userData")`. The app fetches nothing from the network except update checks.

The repo already contains an MCP **server** (`src/mcp/server.mjs`, `@modelcontextprotocol/sdk` ^1.30.0 as a devDependency, run as a separate process via `npm run mcp`). It exposes sixteen vault tools to an outside agent and reuses `files.js` and `search.js` rather than reimplementing them. That is the agent → vault direction.

This change adds the opposite direction: Inkju → the user's cloud. That means, for the first time, the app process holds user credentials, opens outbound connections, spawns child processes on the user's behalf, and renders bytes that did not come off the local disk. The design below is mostly about keeping that from eroding the trust boundary above.

Two external facts shape everything:

1. **Google ships a real remote Drive MCP server.** `https://drivemcp.googleapis.com/mcp/v1`, HTTP transport, OAuth 2.0, scopes `drive.readonly` and `drive.file`, tools `search_files`, `read_file_content`, `download_file_content`, `get_file_metadata`, `get_file_permissions`, `list_recent_files`, `create_file`, `copy_file`. It is in the Google Workspace Developer Preview Program and, like Claude Desktop's custom connectors, expects the client to bring its own OAuth client ID and secret. So the Drive story is a *client* problem, not an API-integration problem.
2. **iCloud Drive has no equivalent and will not get one.** Apple's only third-party cloud APIs are CloudKit and CloudKit Web Services, and those reach a *developer's own container*, never the user's iCloud Drive Documents. The only supported way for a non-Apple app to read a user's iCloud Drive is the local mirror at `~/Library/Mobile Documents/com~apple~CloudDocs/`. Any design that promises "iCloud via MCP" is promising something that does not exist.

## Goals / Non-Goals

**Goals:**

- Inkju desktop acts as a generic MCP host: any MCP server the user trusts can be added, over stdio or Streamable HTTP, with OAuth where the server demands it.
- Google Drive works end to end — connect, browse, search, open a markdown file in a tab, edit, save back — with the user's own OAuth client.
- iCloud Drive works end to end as a *vault location*, with the placeholder/materialization behaviour that folder actually has, and is not misrepresented as MCP.
- Credentials never enter the renderer and are at rest only under OS key management.
- The connection, credential and consent model is reusable by a later Supabase-backed account and sync layer, so Phase 2 extends this rather than replacing it.
- No regression to the existing local-first, offline, zero-telemetry behaviour. Inkju with no connections configured behaves exactly as it does today.

**Non-Goals:**

- Any Supabase code, dependency, schema or bucket. Phase 2 is *researched here* (see "Supabase research — Phase 2") and specified in a separate change.
- Inkju accounts, sign-in, billing, entitlements.
- Continuous background sync of a cloud folder into a vault. This change opens and saves files on demand; it does not run a sync engine.
- The light build (`Inkju.html`) and any web app. The single-file build stays zero-dependency and offline.
- Inkju hosting or proxying anyone's OAuth credentials. The user brings their own client ID/secret.
- Acting as an LLM client. Inkju calls MCP tools that the user or the UI initiated; it does not hand a model a tool loop.

## Decisions

### D1 — Inkju becomes an MCP host, rather than integrating each cloud's API directly

*Chosen:* a generic MCP client in the main process, plus presets for well-known servers.

*Why:* the alternative — a first-party Google OAuth app talking to the Drive REST API — requires a Google Cloud project, an OAuth consent screen, and Google's verification review for anything beyond `drive.file`, and buys a single vendor. The MCP path is vendor-neutral, reuses the SDK already in the repo, ships without any review gate, and means Dropbox, Notion, a corporate document store or the user's own script all arrive for free the day someone writes an MCP server for them. It also matches how the team already thinks: the codebase has an MCP server, so both halves of the protocol now live in one place.

*Considered and rejected:* direct Drive API (vendor lock-in, verification burden); bundling a first-party Drive MCP server (best UX, but doubles the work and puts Inkju on the hook for Drive API changes). Bundling stays available as a follow-up once the generic host exists.

### D2 — Everything MCP lives in the main process; the renderer only ever sees results

Transports, tokens, child processes and HTTP all live in `src/main/`. The renderer gets a new `inkju.connections` namespace on the preload bridge with the same `{ok,data}` shape as everything else, and receives only: connection metadata (id, label, transport kind, status, tool names), file listings, and file text. It never sees a token, a client secret, a raw HTTP response, or a transport handle.

*Why:* the renderer is sandboxed for a reason and now displays untrusted remote text. Any credential reachable from it is a credential reachable from a malicious note.

### D3 — Two transports, and a hard line between them

- **stdio** — Inkju spawns a local server (`command` + `args` + `env`). Explicitly a "run this program on my machine" decision: the add-connection UI says so in those words, and the command is shown verbatim before the user confirms. `env` values marked secret go to `secrets.js`, not `settings.json`. Never auto-installed: Inkju will not run `npx -y` on the user's behalf without a confirmation that names the package.
- **Streamable HTTP** — `StreamableHTTPClientTransport` with an `authProvider`. HTTPS only; `http://` is refused except for `127.0.0.1`/`localhost` during development.

Per the MCP authorization spec, stdio servers take credentials from the environment and do **not** run the OAuth flow; only HTTP transports do.

### D4 — OAuth follows the MCP authorization spec, not a hand-rolled flow

The flow implemented in `src/main/oauth.js`, driven by the SDK's `OAuthClientProvider` interface:

1. Connect without a token; read the `401` and its `WWW-Authenticate` header, extracting `resource_metadata` and the challenged `scope`.
2. Fetch OAuth 2.0 Protected Resource Metadata (RFC 9728) to discover the authorization server; then fetch AS metadata via RFC 8414 *or* OpenID Connect Discovery — clients must support both.
3. Obtain a `client_id`: pre-registered (what Google Drive needs — the user pastes their own client ID/secret), Client ID Metadata Documents where offered, or Dynamic Client Registration (RFC 7591) as the deprecated fallback.
4. Generate PKCE parameters, include the `resource` parameter (RFC 8707) set to the server's canonical URI in **both** the authorization and token requests, record the expected `issuer`, and open the system browser with `shell.openExternal`.
5. Receive the code on a **loopback listener** — an ephemeral `http://127.0.0.1:<port>/callback` bound to localhost only, started for the duration of one flow and torn down after it, with a `state` value bound to the flow.
6. Validate `iss` against the recorded issuer (RFC 9207) *before* the code is sent to any token endpoint, including on error responses.
7. Exchange code + verifier for tokens; store them via `secrets.js`; retry the connection on a **fresh** transport instance (a started transport cannot be restarted).
8. On a runtime `403 insufficient_scope`, step up: re-authorize with the **union** of previously requested scopes and the challenged scopes, retry a bounded number of times, then fail permanently.

*Why loopback over a custom `inkju://` protocol handler:* loopback is the OAuth-for-native-apps norm (RFC 8252), needs no OS registration, cannot be hijacked by another app claiming the same scheme, and works identically for a dev build and a signed one. A custom scheme is kept as a fallback only for authorization servers that reject loopback redirect URIs.

*Why the user's own OAuth client:* Google's Drive MCP is in Developer Preview and expects a per-installation client, and shipping an embedded client secret in a distributed desktop app is not a secret at all. It costs the user a setup step; the Connections UI walks them through it and links the Google console page.

### D5 — Credentials at rest use Electron `safeStorage`, in a file separate from settings

`secrets.js` wraps `safeStorage.encryptStringAsync` / `decryptStringAsync` (async: non-blocking, supports key rotation, tolerates temporary unavailability; the sync pair may be deprecated) and writes ciphertext to `secrets.json` in `userData`, never `settings.json`. `isEncryptionAvailable()` is checked first: if it returns false — realistically Linux without a configured keyring — Inkju **refuses to persist the credential** and keeps it in memory for the session only, telling the user plainly. It does not silently fall back to plaintext.

Keeping secrets out of `settings.json` matters because that file is small, debounced, frequently rewritten, and the thing users copy between machines or paste into a bug report.

### D6 — Deny-by-default tool allowlist per connection

On connect, Inkju calls `tools/list` and stores the tool names. Nothing is callable until it is allowed. Read-shaped tools that Inkju itself needs to render its browser (`search_files`, `read_file_content`, `get_file_metadata`, `list_recent_files` and their equivalents) are proposed pre-ticked; every write-shaped tool is unticked and requires a deliberate opt-in. When a server's tool list changes between sessions, newly appeared tools arrive disabled and the user is told.

Beyond the allowlist, **every write, rename, move or delete against a remote source requires a confirmation dialog naming the file and the connection**, unless the user has ticked "don't ask again for this connection" — which is itself a per-connection setting, off by default.

*Why:* an MCP server is arbitrary code the user pointed at, and a remote one can change its tool surface at any time. Deny-by-default means a server that grows a `delete_everything` tool overnight gains nothing.

### D7 — Remote content is untrusted input

- Size cap before render, reusing the existing 40 MB ceiling in `files.js` and applying a much lower default (2 MB) to remote fetches.
- Only text/markdown is opened in the editor; anything else offers download-to-vault instead.
- No remote content ever reaches `shell.openExternal`, a `<script>`, or `eval`. The renderer CSP is unchanged and remote text goes through the same markdown pipeline as local text, which already escapes rather than executes.
- Prompt-injection posture is stated explicitly: Inkju does not feed remote content to a model or run an agent loop, so a note containing instructions is just a note. If that ever changes, this decision has to be revisited first.
- Tool results are schema-validated before use; a malformed or oversized response fails the operation rather than being coerced.

### D8 — Remote documents are first-class tabs with an explicit origin

A remote file opens in a normal tab carrying `{connectionId, remoteId, etag/mtime, writable}` instead of a local path. Consequences, decided now rather than discovered later:

- **Autosave is off for remote documents by default.** Autosave to a local file is cheap and reversible; autosave over a network to someone else's store is neither. Remote tabs save on `⌘S`, and the UI says so.
- **Conflict detection is mandatory.** Before writing, re-read the remote metadata; if the version marker moved since the tab was opened, stop and offer "keep mine / keep theirs / save a copy to the vault". Never silently overwrite.
- **Read-only connections degrade gracefully.** A connection with no allowed write tool opens files read-only and `⌘S` offers "save a copy to the vault" instead of failing.
- **Version history and backlinks stay vault-only** in this change. Both are index-backed and vault-scoped today; extending them across a remote namespace is Phase 2 work.
- **Offline is a first-class state**, not an error: a remote tab with no connectivity stays open and readable from the in-memory copy, and says it cannot save.

### D9 — iCloud Drive is a local provider, presented in the same list

`src/main/icloud.js` detects `~/Library/Mobile Documents/com~apple~CloudDocs/` (macOS only; the entry is absent elsewhere) and lets the user open a vault inside it. It is *not* MCP, and the UI does not claim it is — it says "this folder syncs through iCloud".

What it has to handle, because this is where naive implementations break:

- **Dataless placeholders.** A file listed in the tree may not have its bytes locally. Reading one blocks while macOS materializes it — which, on a large vault, means the existing tree walk and the search index can stall or trigger mass downloads. So: detect the dataless state before reading, materialize on demand for an explicit open, and **never** materialize during a background index or tree walk.
- **`.icloud` stubs.** Evicted files appear as `.<name>.icloud`. These are filtered from the tree and resolved to their real names.
- **Conflicts.** iCloud writes sibling "conflicted copy" files rather than merging. These are surfaced in the sidebar as conflicts instead of being shown as ordinary notes.
- **Atomic write interaction.** `files.js` writes to `.<name>.tmp` then renames. **Measured against a real iCloud Drive rather than assumed** (2026-08-22, macOS 25.6): the temp file exists for about 4 ms even for a 4 MB note, no `.tmp` artefact survives the rename, and `brctl status` shows nothing pending for it. The existing in-place temp-then-rename is correct and needs no change. Moving the temp file outside the synced tree was rejected on the evidence — it would trade a measured non-problem for a real one, since a rename across volumes is not atomic and would have to degrade to copy-then-delete.
- **Eviction.** A note open in a tab can be evicted underneath the app. Detect it, keep the in-memory copy, and re-materialize on save.

*Considered and rejected:* CloudKit / CloudKit Web Services (reaches only Inkju's own container, not the user's Documents — wrong tool); scraping iCloud.com (unsupported, breaks, and would require the user's Apple ID password); telling users to use a third-party "iCloud MCP" server (none is trustworthy for Apple ID credentials).

### D10 — SDK version

Stay on `@modelcontextprotocol/sdk` v1.x, matching the server already in the repo, and move it to `dependencies`. The v2 packages (`@modelcontextprotocol/client`) reorganize imports and transports; adopting them is a separate, mechanical change that should not ride along with a feature this size. Pin the minor version and cover the client in `desktop/test/`.

## Risks / Trade-offs

- **Google's Drive MCP is in Developer Preview** → its URL, scopes or tool names can change without notice. Mitigated by the preset being *data* (a JSON descriptor) rather than code, and by the generic path working with any Drive MCP server. If Google's preview closes, users can point at a community server without an Inkju release.
- **The user must create their own Google OAuth client** → real friction, and the step most likely to lose people. Mitigated with a walkthrough in the Connections UI, a deep link to the Google console, and precise validation errors. Accepted, because embedding a secret in a distributed desktop app is worse.
- **"iCloud via MCP" is not what ships** → the user asked for iCloud through MCP; what is technically possible is a local iCloud Drive folder provider. Flagged up front, and the UI is worded so nobody expects an account connection. The user-visible outcome — "my iCloud markdown files open in Inkju" — is delivered.
- **stdio connections run arbitrary local programs** → an MCP server is a process with the user's full privileges. Mitigated by never auto-installing, showing the exact command before confirmation, and treating the add-connection step as the trust decision it is. Not fully mitigable; documented plainly.
- **`safeStorage` is unavailable on some Linux setups** → mitigated by in-memory-only credentials for that session and an explicit message. Never a plaintext fallback.
- **Prompt injection through remote notes** → currently inert (D7), but the moment Inkju gains an agent feature this becomes live. Recorded as a standing constraint, not a solved problem.
- **Scope creep into a sync engine** → "open a remote file" quietly becomes "keep a folder in sync". Held back by D8: no background sync, explicit saves, conflicts surfaced not resolved. Sync is Phase 2, with a design of its own.
- **iCloud materialization storms** → a vault in iCloud could pull gigabytes down during indexing. Mitigated by never materializing during background work; needs testing against a genuinely large, mostly-evicted vault before release.
- **First outbound network traffic in the app process** → Inkju's "fetches nothing from a network" property is now conditional. Mitigated by making it strictly opt-in per connection, and by keeping the claim accurate in the README: with no connections configured, nothing is fetched.

## Migration Plan

Additive throughout. No schema migration, no user-visible change until a connection is added; `store.js` gains a `connections: []` default, and the absence of that key in an existing `settings.json` means "no connections". Rollback is removing the feature flag / reverting the release: connection records and `secrets.json` are ignored by older builds, and no vault file is touched by this change.

Staging: ship the Connections UI behind a `--connections` dev flag first, then to a prerelease channel, then generally — the OAuth flow needs real accounts against a preview API and will not be fully exercised by unit tests.

---

## Supabase research — Phase 2 (not implemented by this change)

Recorded here so the account and sync work is decided rather than discovered. Each item below becomes a decision in a separate change (`add-inkju-accounts`, `add-vault-sync`).

**Why Supabase fits.** It bundles the four things Phase 2 needs — Postgres, an auth service, object storage with per-user access control, and realtime change feeds — behind one project, with row-level security enforced *in the database* rather than in application code. For a desktop app that will eventually be joined by a web app and a phone, the same RLS policies protect all three clients, including a client someone has patched.

**Auth.** Supabase's PKCE flow is the default for native apps and matches D4's loopback listener almost exactly, so `oauth.js` should be written to be reusable for it rather than hard-wired to MCP. Desktop sign-in: `signInWithOAuth({ options: { skipBrowserRedirect: true } })`, open the returned URL in the system browser, catch the redirect on loopback, `setSession({ access_token, refresh_token })`. The refresh token goes into `secrets.js` — the same store, the same `safeStorage` guarantees, the same refusal to persist in plaintext.

**Per-user sandbox space.** A private Storage bucket where the first path segment is the user's id, guarded by RLS on `storage.objects`:

```sql
create policy "own folder only"
on storage.objects for all
to authenticated
using      (bucket_id = 'vaults' and (select auth.uid()::text) = (storage.foldername(name))[1])
with check (bucket_id = 'vaults' and (select auth.uid()::text) = (storage.foldername(name))[1]);
```

Buckets deny everything until a policy says otherwise, which is the right default. Note the `(select auth.uid())` form — it lets Postgres cache the call per statement instead of per row, which matters on a vault-sized listing.

**Metadata in Postgres, bytes in Storage.** A `notes` table (`id`, `owner`, `vault_id`, `path`, `hash`, `size`, `updated_at`, `deleted_at`, `device_id`) with RLS `owner = auth.uid()`, and note bodies as Storage objects. Listing, search and conflict detection hit the table; only an actual open transfers bytes. Realtime on `notes` gives the "it appears on my other laptop" moment without polling.

**Sync model — the decision Phase 2 has to make.** Options, in increasing cost: (a) last-writer-wins on `updated_at` with a conflicted-copy file, which is exactly what iCloud does and what D8 already builds the UI for; (b) three-way merge against a common ancestor, needing a per-device base snapshot; (c) CRDT (Yjs/Automerge), which buys real concurrent editing but changes the on-disk format and rules out "it's just markdown files". **Recommendation: (a), reusing D8's conflict UI**, with the door left open to (c) for a future collaborative-editing feature. Preserving "your notes are plain markdown files you own" is worth more than seamless merge.

**Encryption — the decision that has to be made first, because it constrains everything else.** Two coherent positions:

- *Server-side only* (Supabase encrypts at rest, TLS in transit, RLS for access). Simple, and server-side search and web preview work. But Inkju — and anyone with database access — can read every note.
- *Client-side E2EE*: encrypt note bodies on the device before upload with a key derived from a passphrase, upload ciphertext, and let the server hold only metadata. Inkju cannot read user notes, which is a genuine, marketable claim for a writing app and the strongest possible answer to "is my private journal safe". The costs are real: no server-side search (search must be local, over the synced set), no server-side preview or web-app rendering without the passphrase, and password reset means data loss unless a recovery key exists.

**DECIDED (2026-08-22): E2EE for note bodies, plaintext for the minimum metadata sync requires** (path, hash, size, timestamps — accepting that paths and note titles are visible to the server), with a generated recovery key the user must save at setup. This was decided before any table was created, which was the point of raising it here: retrofitting E2EE onto a plaintext corpus means migrating every user's data, and it is the one decision in Phase 2 that cannot be revisited cheaply.

What the decision commits Phase 2 to:

- Note bodies are encrypted on the device before upload. The server stores ciphertext and cannot read a note. Neither can Inkju.
- Metadata stays plaintext: path, hash, size, timestamps, device. Paths and note titles are therefore visible to the server — that is the accepted cost of a sync engine that can order and reconcile without decrypting.
- A recovery key is generated at setup and the user must record it. There is no password reset that recovers data, and the interface has to say so plainly at the moment the key is shown, not in a support article afterwards.
- **Search over synced-but-unopened notes must be local.** The server cannot index what it cannot read, so the client keeps its own index of what it has. This constrains `add-vault-sync` and is the reason it is worth writing down now.
- The web app, if it happens, either asks for the passphrase or renders nothing. "Read my notes in a browser without my key" is not a feature this design can have.

**Billing.** Stripe, with entitlement state in Postgres written by a webhook and read through RLS. The desktop client must treat an expired entitlement as "sync stops, local files remain fully usable" — never as "the app locks". That is a product promise worth writing into the spec.

**Open questions for Phase 2.** Free-tier quota and how a vault over quota behaves; whether a vault is one Storage prefix or many; attachment and image handling (Inkju stores images beside the note today); whether the web app renders notes at all under E2EE; device revocation; and how much of the search index can live locally before sync becomes slower than useful.
