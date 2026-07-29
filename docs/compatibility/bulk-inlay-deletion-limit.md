# Bulk inlay deletion does not chunk the new 1,000-item limit

- Status: Confirmed scale compatibility regression
- Severity: Medium
- Confidence: Medium
- Introduced by: dad24f6f

## Difference

main removed inlay and metadata rows individually. serve routes gallery and
playground selections through removeInlayAssets(), which sends the complete
selection in one /api/inlays/delete-unreferenced request. The server rejects
more than MAX_INLAY_DELETE_BATCH = 1,000; the client does not chunk.

## Compatibility impact

A user with more than 1,000 unreferenced inlays can select them all in the UI,
but the entire delete returns INVALID_INLAY_DELETE_REQUEST and removes nothing.
The UI-created request is outside the server contract even though each item is
valid.

## Recommendation

Chunk candidates into bounded requests while preserving reference protection
and aggregating committed outcomes, or make the server stream a larger job.
Test 1,000 and 1,001 selected IDs from both UI callers.
