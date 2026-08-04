# Non-optimized plugin save storage acknowledges before persistence

- Status: Open
- Owner: plugin storage
- Source: [2026-07 data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium
- Lens: L3, L4, D2
- Area: Area 2 — client/plugin boundary
- Affected code: `src/ts/plugins/pluginSaveStorage.ts:87`, `src/ts/plugins/pluginSaveStorage.ts:90`, `src/ts/plugins/pluginSaveStorage.ts:95`, `src/ts/plugins/pluginSaveStorage.ts:99`, `src/ts/plugins/pluginSaveStorage.ts:110`, `src/ts/plugins/apiV3/v3.svelte.ts:1325`, `src/ts/plugins/apiV3/v3.svelte.ts:1328`, `src/ts/plugins/apiV3/v3.svelte.ts:1332`, `src/ts/plugins/apiV3/v3.svelte.ts:1336`, `src/lib/Setting/Pages/PluginStorageViewer.svelte:271`, `src/lib/Setting/Pages/PluginStorageViewer.svelte:277`

## Risk

Optimized plugin storage awaits its KV write or deletion. In the default inline
mode, the same APIs mutate the reactive map and resolve before the later database
save, so they cannot report its failure. The viewer likewise announces success
as soon as the memory-only mutation completes.

A plugin may await a protective state write and then reload or make a destructive
decision, yet the old value returns after refresh. This acknowledgement occurs
before any patch or full write is attempted and therefore precedes the separate
v2 server acknowledgement window; API durability also changes with mode.

## Required fix and coverage

Give inline V3 and viewer mutations a durability-aware commit path. Do not resolve
or show success until it completes, or expose explicit staged-versus-persisted
transaction semantics.

Test identical write, remove, and clear failures in both optimization modes.
