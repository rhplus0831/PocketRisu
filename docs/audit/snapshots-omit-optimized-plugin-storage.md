# Automatic snapshots do not version optimized plugin storage

- Status: Open
- Severity: High
- Commit: `e2bc8e5b` (made explicit by the spool path in `f410c8a6`)
- Affected code: `server/node/server.cjs:281-300`, `server/node/server.cjs:2230-2263`, `server/node/server.cjs:6067-6112`

## Risk

Automatic `database/dbbackup-*` snapshots assemble chats but call `spoolSelfContainedBackupDatabase()` with its default `foldPluginStorage = false`. A snapshot contains the optimized database's empty inline plugin maps and no snapshot-associated copy of `pluginsave/` or `pluginsave-meta/`.

Restoring such a snapshot restores the database and chats but does not restore plugin state from that time. Existing external rows remain at their newer values, and rows deleted since the snapshot remain absent. A snapshot advertised as a full assembled DB-only recovery point therefore cannot recover historical plugin data.

## Failure sequence

1. An optimized plugin key contains value `V1`.
2. An automatic database snapshot is created.
3. The key is changed to `V2`, deleted, or replaced by other keys.
4. The snapshot is restored.
5. The logical database returns to the snapshot time, but plugin storage remains at the post-snapshot state.

## Required fix and coverage

Either fold plugin values and metadata into every automatic snapshot, or version their external rows as part of the same snapshot object. Restore must atomically clear and repopulate plugin prefixes so post-snapshot keys do not leak into the recovered state. The streaming ingest path can re-externalize folded values after restore.

Add a regression that snapshots `V1`, changes it to `V2`, deletes one old key, adds one new key, restores, and requires the exact snapshot-time key set and values.

