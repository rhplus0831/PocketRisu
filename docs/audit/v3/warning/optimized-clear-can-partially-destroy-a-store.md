# Optimized clear can partially destroy a plugin store

- Status: Open
- Severity: Medium
- Lens: L3, D1
- Area: Area 2 — client/plugin boundary
- Affected code: `src/ts/storage/persistentKv.ts:70`, `src/ts/storage/persistentKv.ts:72`, `src/ts/plugins/pluginSaveStorage.ts:110`, `src/ts/plugins/pluginSaveStorage.ts:117`, `src/ts/plugins/apiV3/v3.svelte.ts:1336`, `src/ts/plugins/apiV3/v3.svelte.ts:1338`

## Risk

Optimized `pluginStorage.clear()` lists the prefix and removes each key through
independent requests in `Promise.all`. If one request fails after others commit,
the call rejects but the successful deletions remain durable. Owner metadata is
cleared only afterward, so a value-prefix failure also preserves stale sidecars.

A plugin clearing an interdependent schema before rebuilding it can receive an
error and abort while an arbitrary subset of its old values is already gone.
The default inline implementation is a single map replacement, making the
partial-application behavior mode-dependent.

## Required fix and coverage

Provide an atomic prefix-clear/batch-delete operation or publish a generation
tombstone atomically. At minimum, return exact deleted and remaining sets so the
caller can deterministically repair the store.

Fault-inject failures at every deletion position and verify value/meta parity.
