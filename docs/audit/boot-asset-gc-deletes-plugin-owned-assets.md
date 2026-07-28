# Automatic boot GC deletes assets owned by plugins

- Status: Fixed
- Severity: High
- Area: client asset lifecycle
- Affected code: `src/ts/bootstrap.ts:281-283` (cleanChunks auto-runs 5 s after boot), `src/ts/bootstrap.ts:627-644` (deletes every `assets/` key not in the keep-set), `src/ts/globalApi.svelte.ts:1450-1549` (`getUncleanables` enumerates only core DB fields), `src/ts/globalApi.svelte.ts:205-226` (`saveAsset`), `src/ts/plugins/apiV3/v3.svelte.ts:858` (exposed to V3 plugins)

## Risk

`cleanChunks()` runs automatically five seconds after every boot and deletes
every stored `assets/` key whose basename is not returned by
`getUncleanables()`. That keep-set covers backgrounds, user/persona icons,
sounds, character images/emotions/additional assets/vits/ccAssets, module
assets and icons, and character-order images — and nothing else.

`saveAsset()` is a supported plugin API (V2 and V3). A plugin that stores an
asset and persists the returned `assets/<hash>.<ext>` path in its plugin
storage (inline or optimized) holds a reference the GC cannot see. On the next
boot the asset's bytes are deleted from the server while the plugin's stored
path remains, permanently dangling. There is no trash, and assets are not part
of DB-only snapshots, so the only recovery is an earlier full backup.

The same blind spot applies to any other reference surface added outside
`getUncleanables()` — the function must be updated in lockstep with every new
asset-referencing field, and nothing enforces that.

## Required fix and coverage

Track asset ownership explicitly (a lease/registry recorded at `saveAsset()`
time) or include plugin storage — both inline `plugins[].storage` and
optimized `pluginsave/` rows — in the keep-set scan before deleting. A
server-side grace period for recently-created assets would additionally bound
every keep-set omission.

Cover with a test: plugin saves an asset, path persisted in plugin storage,
boot GC runs, asset must survive.

## Resolution

Fixed 2026-07-29. Browser boot no longer lists and removes ordinary assets.
The Node server now performs one serialized reachability pass over the complete
stripped database and, when optimized plugin memory is active, only the value
rows authorized by the matching generation manifest. Values are decoded and
released one row at a time. Any database, manifest, ownership, row-validation,
or traversal-limit failure aborts before candidate state or asset bytes change.

Unreferenced assets enter a persisted candidate table on the first pass and are
eligible for deletion only after the seven-day default grace interval and a
later independent pass. Rewriting an asset clears its candidate. The same
reachability implementation now drives storage-dashboard orphan calculations.

Unit coverage verifies nested/embedded paths and two-pass planning. Real-server
compatibility coverage proves inline and optimized plugin-only assets survive
repeated zero-grace sweeps, true orphans require two passes, and an invalid
active optimized row fails closed without deleting an already-marked asset.
