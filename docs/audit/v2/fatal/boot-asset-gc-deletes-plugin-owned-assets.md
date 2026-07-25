# Automatic boot GC deletes assets owned by plugins

- Status: Open
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
