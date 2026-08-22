## Why

`add-cloud-mcp-connect` gave Inkju a connection model, a credential vault and a consent model, and proved them against a real MCP server. What it deliberately did not give anyone is an Inkju account. Cross-device access — "my markdown is on every device I own" — is the thing people would pay for, and it needs a place to keep an identity and some space.

Supabase is the evaluated choice, for the reasons recorded in `add-cloud-mcp-connect/design.md`: Postgres, an auth service, object storage with per-user access control and realtime change feeds behind one project, with row-level security enforced *in the database* rather than in application code. When a web app and a phone join the desktop, the same policies protect all three — including a client someone has patched.

## What Changes

- **Sign in to Inkju.** Supabase auth over PKCE, reusing `oauth.js`'s loopback listener rather than a second implementation of the same flow. The refresh token goes into the existing `secrets.js`, with the same `safeStorage` guarantees and the same refusal to persist in plaintext.
- **Per-user sandbox space.** A private Storage bucket keyed on the user's id, guarded by RLS on `storage.objects` so the first path segment must equal `auth.uid()`. Buckets deny everything until a policy says otherwise, which is the right default.
- **A metadata table.** `notes` — id, owner, vault, path, hash, size, updated_at, deleted_at, device — under RLS `owner = auth.uid()`. Listing and conflict detection hit the table; only an actual open transfers bytes.
- **Client-side E2EE for note bodies.** Decided in Phase 1 (2026-08-22) and not open for cheap revision — it is not retrofittable, which is why it was settled before a table existed. Note bodies are encrypted on the device before upload; the server, and Inkju, hold ciphertext and cannot read a note. Metadata stays plaintext (path, hash, size, timestamps, device), so paths and titles are visible to the server — the accepted cost of reconciling without decrypting. A recovery key is generated at setup and the user must record it: there is no password reset that recovers data, and the interface says so at the moment the key is shown.
- **Entitlements.** Stripe, with entitlement state in Postgres written by a webhook and read through RLS.
- **An expired entitlement stops sync and never locks the app.** Local files stay fully usable, always. That is a product promise and it belongs in the spec, not in a support article.

## Capabilities

### New Capabilities
- `inkju-account`: sign in, sign out, session refresh, device identity, and what happens to local work when no one is signed in.
- `user-storage`: the per-user bucket and its RLS policies; quota, over-quota behaviour, and how a vault maps onto storage paths.
- `note-encryption`: what is encrypted, what is not, key derivation, the recovery key, what the server can and cannot read, and what happens when the key is lost.
- `entitlements`: plans, the Stripe webhook, entitlement state, and the guarantee that lapsing never locks local files.

### Modified Capabilities

`connection-security` — credential storage grows to hold a Supabase refresh token and, under E2EE, a wrapped content key. The existing guarantees do not change; the set of things they cover does.

## Impact

Depends on `add-cloud-mcp-connect` being merged. Reuses `secrets.js` unchanged, and `oauth.js`'s loopback listener. First runtime dependency on a hosted service, and the first time Inkju holds anything belonging to a user outside their own machine — which is why `note-encryption` is specified before `user-storage`.

**Not in this change** — the sync engine itself (`add-vault-sync`), the web app, and sharing between users.
