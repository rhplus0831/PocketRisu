# Boot asset GC can race an asset published from another tab

- Status: Fixed
- Severity: Medium
- Area: client asset lifecycle
- Affected code: `src/ts/bootstrap.ts:627-644` (keep-set captured before the key listing; no recheck before deletion), `src/ts/globalApi.svelte.ts:205-226` (`saveAsset` publishes before the DB reference syncs)

## Risk

`cleanChunks()` captures `getUncleanables(db)` from this tab's in-memory
database, then lists server keys and deletes unreferenced ones. An asset
uploaded by another tab or device — whose database reference has not yet
reached this tab (broadcast/sync lag) — but which appears in the key listing
falls in the gap and is deleted, leaving the other tab's database pointing at
a missing file. The window is bounded (keep-set capture → key-listing
response, plus cross-tab propagation lag), which keeps this below the
plugin-asset finding in likelihood, but boot + concurrent activity on another
device is an ordinary pattern.

## Required fix and coverage

Run GC server-side against the authoritative database (or recheck references
immediately before each deletion), and exempt recently created files with a
grace period so publication can complete across stores.

## Resolution

Fixed 2026-07-29 by the server-owned asset collector described in
`boot-asset-gc-deletes-plugin-owned-assets.md`. Asset publication and cleanup
are serialized through the server storage queue. A write clears any existing
candidate, and a newly unreferenced asset is only marked on its first pass;
deletion requires a later pass after the persisted grace interval. The client
no longer captures a stale keep-set or sends per-asset removal requests.
