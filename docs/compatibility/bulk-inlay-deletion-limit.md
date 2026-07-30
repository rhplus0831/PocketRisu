# Bulk inlay deletion did not chunk the new 1,000-item limit

- Status: Fixed 2026-07-30
- Severity: Medium
- Confidence: High
- Introduced by: dad24f6f

## Original difference

main removed inlay and metadata rows individually. serve routes gallery and
playground selections through removeInlayAssets(), which sends the complete
selection in one /api/inlays/delete-unreferenced request. The server rejects
more than MAX_INLAY_DELETE_BATCH = 1,000; the client does not chunk.

## Original compatibility impact

A user with more than 1,000 unreferenced inlays can select them all in the UI,
but the entire delete returns INVALID_INLAY_DELETE_REQUEST and removes nothing.
The UI-created request is outside the server contract even though each item is
valid.

## Implemented recommendation

Chunk candidates into bounded requests while preserving reference protection
and aggregating committed outcomes, or make the server stream a larger job.
Test 1,000 and 1,001 selected IDs from both UI callers.

## Resolution

`removeInlayAssets()` now divides the deduplicated selection into requests of at
most 1,000 IDs, refreshes the loaded-chat keep-set for every guarded server
mutation, and aggregates the committed `removedIds` and `referencedIds` in
selection order. Both gallery and playground deletion use this shared helper.

Client regression coverage verifies that exactly 1,000 IDs use one request and
that 1,001 IDs use 1,000- and 1-item requests while preserving and aggregating
both authoritative and loaded-unsaved chat references.
