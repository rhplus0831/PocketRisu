# The storage viewer's read-modify-write is stale and unconditional

- Status: Open
- Severity: Medium
- Lens: L3, D6
- Area: Area 2 — client/plugin boundary
- Affected code: `src/ts/plugins/pluginSaveStorage.ts:15`, `src/ts/plugins/pluginSaveStorage.ts:22`, `src/lib/Setting/Pages/PluginStorageViewer.svelte:171`, `src/lib/Setting/Pages/PluginStorageViewer.svelte:185`, `src/lib/Setting/Pages/PluginStorageViewer.svelte:205`, `src/lib/Setting/Pages/PluginStorageViewer.svelte:231`, `src/lib/Setting/Pages/PluginStorageViewer.svelte:252`, `src/lib/Setting/Pages/PluginStorageViewer.svelte:271`, `src/lib/Setting/Pages/PluginStorageViewer.svelte:285`, `src/lib/Setting/Pages/PluginStorageViewer.svelte:289`

## Risk

The viewer snapshots keys and values, then retains an entry throughout an
unbounded human edit or confirmation interval. Save and delete are unconditional;
no current value, hash, or version is compared. The storage queue serializes
individual calls but does not hold a transaction across the human interaction.

If an enabled plugin updates the value after the viewer loads, saving the stale
copy erases newer fields, counters, or tokens. A stale delete can remove a
replacement value, and a keys-to-get race can display a deleted entry as empty
and later resurrect it.

## Required fix and coverage

Capture a canonical version/hash and re-read under the storage lock immediately
before mutation. Refuse or present a three-way conflict on mismatch, or pause the
owning plugin for the complete edit transaction.

Test concurrent plugin set/delete against viewer edit and confirmation delays.
