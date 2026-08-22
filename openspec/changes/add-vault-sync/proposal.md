## Why

With accounts and per-user space in place (`add-inkju-accounts`), the remaining piece is the one people actually notice: a vault that is the same on every device. Phase 1 built the conflict interface this needs — keep mine, take theirs, save a copy — and proved it against a real remote store. This change puts a sync engine behind it.

## What Changes

- **A sync engine for a vault.** Local changes go up, remote changes come down, driven by the `notes` metadata table and Supabase realtime rather than polling.
- **Last-writer-wins with a conflicted copy**, reusing the conflict interface from `add-cloud-mcp-connect` rather than inventing a second one. This is what iCloud does, and the Phase 1 research recommends it over three-way merge or CRDT: preserving "your notes are plain markdown files you own" is worth more than a seamless merge. CRDT stays open as a future collaborative-editing feature, not as a sync mechanism.
- **Sync is per vault and opt-in.** A vault is synced because the user turned it on for that vault.
- **Offline is the normal case, not an error.** Every operation works offline against local files and reconciles later.
- **Deletions are tombstones**, never a silent removal on another device.
- **Attachments and images**, which Inkju stores beside the note today, sync with the note that references them.

## Capabilities

### New Capabilities
- `vault-sync`: turning sync on for a vault, what is uploaded and downloaded, ordering, and what happens on first sync of a vault that already has notes on both sides.
- `sync-conflicts`: detection, the conflicted-copy file, and the guarantee that no edit is ever lost without the user choosing to lose it.
- `sync-offline`: behaviour with no connection, reconciliation on reconnect, and what the interface shows meanwhile.
- `device-management`: listing a user's devices and revoking one.

### Modified Capabilities

`cloud-file-access` — the conflict interface built in Phase 1 gains a second caller. The behaviour it specifies does not change.

## Impact

Depends on `add-inkju-accounts`. Its encryption decision is settled — client-side E2EE for note bodies — and it constrains everything here: the server sorts and lists but never reads, so **search over synced-but-unopened notes must be local**, and the client has to keep its own index of what it holds. Touches the vault watcher, the search index and the file layer. The risk this change has to be designed against is straightforward and severe — a sync engine that loses someone's writing is worse than no sync engine.

**Not in this change** — sharing between users, collaborative editing, and the web app.
