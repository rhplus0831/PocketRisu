# Partial backups omit optimized plugin storage

- Status: Open
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

