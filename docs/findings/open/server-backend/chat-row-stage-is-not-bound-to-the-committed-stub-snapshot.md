# Chat-row staging is not bound to the committed stub snapshot

- Status: Open
- Owner: server backend
- Source: [2026-07 data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: High
- Lens: D1, L2, L4
- Area: Area 4 — client/server sync protocol
- Extends: [Acknowledged database patches are not durable for up to five seconds](../client-storage/acknowledged-patches-are-not-durable.md)
- Affected code: `src/ts/storage/chatPersistStage.ts:139-143`, `src/ts/storage/chatPersistStage.ts:155-190`, `src/ts/globalApi.svelte.ts:800-827`, `src/ts/globalApi.svelte.ts:994-1041`, `src/ts/globalApi.svelte.ts:1072-1083`, `src/ts/storage/nodeStorage.ts:977-995`, `server/node/chatRows.cjs:321-342`

## Risk

The client discovers a fixed set of chat rows, awaits their POSTs, and only then
encodes the still-live database. A chat created during an earlier slow row POST
can therefore appear in the committed stub graph without having been in the row
candidate set. Reload turns it into a placeholder whose content request is 404.

The reverse direction is also non-atomic: a row may become durable before
encoding or stub publication fails. Its only recovery reference then lives in
the current page's retry queue; after client loss it is orphaned, and the server
sweep deletes it after the one-hour grace period. Synchronous patch durability
alone would not close either mismatch.

## Required fix and coverage

Bind row staging and stub publication to one immutable database revision, and
repeat discovery after awaited batches until that exact stub graph is row-backed.
Use a server-side staged transaction/commit token or durable reconciliation
record for row-success/stub-failure recovery.

Test chat creation during a paused row POST and row success followed by every
encoding, network, authorization, and client-loss failure boundary.
