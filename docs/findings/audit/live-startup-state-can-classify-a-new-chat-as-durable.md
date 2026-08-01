# Live startup state can classify a new chat as durable

- Status: Fixed 2026-07-31
- Severity: High
- Lens: L1, D2
- Area: Area 1 — client change detection and save scheduling
- Affected code: `src/ts/globalApi.svelte.ts:384`, `src/ts/globalApi.svelte.ts:447`, `src/ts/plugins/plugins.svelte.ts:691`, `src/ts/plugins/plugins.svelte.ts:920`, `src/ts/storage/chatPersistStage.ts:30`, `src/ts/storage/risuSave.ts:175`

## Resolution

`saveDb()` now builds its durable-known chat-ID map from the untouched
server-read baseline, not the startup-mutated live database. After the initial
reactive effects establish their clean state, a pre-tracking reconciliation
compares every live full chat with that persisted baseline and explicitly queues
new, reidentified, or replaced chats for authoritative row persistence.

Those chats continue through the existing two-phase row-before-stub stage. A
chat is promoted into the known set only after its row write succeeds and the
stub database commits; failed or uncommitted attempts retain no false durability
proof. Persisted placeholders remain excluded because they have no authoritative
body to rewrite.

Coverage exercises synchronous startup chat creation followed by an unrelated
root save, bootstrap-style ID repair, same-ID full-chat replacement,
row-before-stub ordering, post-commit promotion, reload row resolvability, and
the ordinary-placeholder no-op path.

## Risk (historical)

`saveDb()` seeds its durable-known chat IDs from the already-mutated live
database rather than the persisted server-read baseline. Synchronous V2/V2.1
startup code runs before that snapshot and can add or replace a full chat, but
the pre-tracking comparison checks only plugin storage.

The row stage later skips that chat as already known while the database encoder
still converts it to a stub. A later save can therefore commit the new stub
without ever creating its authoritative chat row. Refresh then hydrates a 404
placeholder and loses the startup-created messages. Bootstrap chat-ID repair is
an organic non-plugin trigger of the same classification hole.

## Required fix and coverage (completed)

Seed known chat IDs from the persisted baseline. Reconcile every pre-tracking
new/full chat against that baseline, enqueue its row, and promote it to known
only after the existing row-before-stub completion proof succeeds.

Cover synchronous plugin chat creation and bootstrap ID repair, followed by an
unrelated save and reload, and require every durable stub to resolve to a row.
