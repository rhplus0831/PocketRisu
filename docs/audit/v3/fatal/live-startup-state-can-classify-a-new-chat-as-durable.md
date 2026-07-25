# Live startup state can classify a new chat as durable

- Status: Open
- Severity: High
- Lens: L1, D2
- Area: Area 1 — client change detection and save scheduling
- Affected code: `src/ts/globalApi.svelte.ts:384`, `src/ts/globalApi.svelte.ts:447`, `src/ts/plugins/plugins.svelte.ts:691`, `src/ts/plugins/plugins.svelte.ts:920`, `src/ts/storage/chatPersistStage.ts:30`, `src/ts/storage/risuSave.ts:175`

## Risk

`saveDb()` seeds its durable-known chat IDs from the already-mutated live
database rather than the persisted server-read baseline. Synchronous V2/V2.1
startup code runs before that snapshot and can add or replace a full chat, but
the pre-tracking comparison checks only plugin storage.

The row stage later skips that chat as already known while the database encoder
still converts it to a stub. A later save can therefore commit the new stub
without ever creating its authoritative chat row. Refresh then hydrates a 404
placeholder and loses the startup-created messages. Bootstrap chat-ID repair is
an organic non-plugin trigger of the same classification hole.

## Required fix and coverage

Seed known chat IDs from the persisted baseline. Reconcile every pre-tracking
new/full chat against that baseline, enqueue its row, and promote it to known
only after the existing row-before-stub completion proof succeeds.

Cover synchronous plugin chat creation and bootstrap ID repair, followed by an
unrelated save and reload, and require every durable stub to resolve to a row.
