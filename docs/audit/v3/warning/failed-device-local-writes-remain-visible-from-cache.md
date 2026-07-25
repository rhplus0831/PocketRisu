# Failed device-local writes remain visible from cache

- Status: Open
- Severity: Medium
- Lens: L4, D2
- Area: Area 2 — client/plugin boundary
- Affected code: `src/ts/plugins/pluginSafeClass.ts:60`, `src/ts/plugins/pluginSafeClass.ts:62`, `src/ts/plugins/pluginSafeClass.ts:71`, `src/ts/plugins/pluginSafeClass.ts:73`, `src/ts/plugins/pluginSafeClass.ts:74`, `src/ts/storage/persistentKv.ts:55`, `src/ts/storage/persistentKv.ts:57`, `src/lib/Setting/Pages/PluginStorageViewer.svelte:144`, `src/lib/Setting/Pages/PluginStorageViewer.svelte:153`, `src/lib/Setting/Pages/PluginStorageViewer.svelte:278`

## Risk

`SafeLocalPluginStorage.setItem()` updates its process-wide cache before key
encoding, JSON serialization, or the awaited persistent write. A failure does
not restore the prior cache entry, and `getItem()` returns the cached value before
consulting the authoritative backend.

After a server rejection, cyclic/BigInt value, or ill-formed key, the setter can
report failure while verification reads show the new value. Refresh clears the
cache and resurrects the old persisted state, defeating failure handling and
making invalid surrogate keys appear to work within the session.

## Required fix and coverage

Validate and serialize first, publishing to cache only after persistence succeeds,
or restore the exact previous entry on every failure.

Cover network rejection, JSON failure, invalid Unicode, overwrite, and new-key
cases through both plugin and viewer paths.
