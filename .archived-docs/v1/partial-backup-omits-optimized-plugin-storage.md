# Partial backups omit optimized plugin storage

- Status: Fixed
- Severity: High
- Commit: `e2bc8e5b`
- Affected code: `src/ts/plugins/pluginSaveStorage.ts:173-211`, `src/ts/drive/backuplocal.ts:190-210`, `server/node/server.cjs:2519-2523`

## Risk

When plugin memory optimization is enabled, the in-memory `pluginCustomStorage` map is intentionally empty and the values live under `pluginsave/` and `pluginsave-meta/`. `SavePartialLocalBackup()` clones that empty database, rehydrates only chat placeholders, and writes `database.risudat` without enumerating or folding the external plugin rows.

The archive succeeds and both confirmation dialogs say that the database, including plugins, is included (`src/lang/en.ts:1654-1655`). On restore, the backup importer clears the existing plugin prefixes before ingesting the archive. Because the partial archive carries neither inline values nor per-row entries, the restore permanently removes the plugin save data it was expected to recover.

Regular server/local exports use different paths and are not affected by this specific omission.

## Required fix and coverage

Before encoding the partial backup, enumerate and parse the external value and metadata rows and overlay them into the cloned database. Alternatively, make the partial-backup action unavailable in optimized mode with an explicit explanation; silently producing an incomplete archive is unsafe.

Add an end-to-end regression that externalizes at least one plugin value and ownership record, creates a partial archive, imports it into an empty instance, and verifies the values and keys exactly.

## Resolution

`SavePartialLocalBackup` now folds the externalized rows into the cloned database before encoding. A new locked helper, `readExternalizedPluginStorage()` in `../../src/ts/plugins/pluginSaveStorage.ts`, enumerates `pluginsave/` and `pluginsave-meta/` under the plugin storage lock and decodes every row using the same cached-value/uncached-meta read modes as the internalize path. When `optimizePluginMemory` is on, the partial backup overlays those rows into the clone's `pluginCustomStorage` and `pluginStorageMeta` with inline-wins semantics (matching the reconcile rule for duplicates left by a crashed mode switch) and keeps the `optimizePluginMemory` flag set.

The resulting archive carries the same folded shape upstream exports already produce, so no server change was needed: on restore, the import paths re-externalize the inline values into fresh `pluginsave/` rows (`externalizePluginStorageIfNeeded` for buffered ingest, `onPluginStorageEntry` for streaming ingest) after clearing the stale prefixes.

Regression coverage is split across the two halves of the round trip. The client fold is covered by unit tests for the helper in `../../src/ts/plugins/pluginSaveStorage.test.ts` (both prefixes, non-ASCII keys, cached vs. uncached reads, malformed listed keys skipped) and by `../../src/ts/drive/backuplocal.test.ts`, which runs `SavePartialLocalBackup` against mocked persistent storage and asserts the encoded clone contains the exact folded values and ownership records, inline duplicates win, the optimization flag survives, the live database is untouched, and non-optimized mode performs no persistent reads. The server half — importing a folded optimized `database.risudat`, recreating the external rows byte-exactly, and clearing stale rows — was already covered by the pre-existing compat test "legacy optimized backups externalize folded plugin storage and clear stale rows" in `../../test/compat/plugin-backup-entries.test.ts`.

