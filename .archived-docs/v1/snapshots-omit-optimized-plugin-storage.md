# Automatic snapshots do not version optimized plugin storage

- Status: Fixed
- Severity: High
- Commit: `e2bc8e5b` (made explicit by the spool path in `f410c8a6`)
- Affected code: `../../server/node/server.cjs` (`createBackupAndRotate`, `spoolSelfContainedBackupDatabase`, `/api/db/snapshots/restore`), `../../server/node/streamRisuLoad.cjs`, `../../server/node/streamRisuSave.cjs`

## Risk

Automatic `database/dbbackup-*` snapshots assemble chats but call `spoolSelfContainedBackupDatabase()` with its default `foldPluginStorage = false`. A snapshot contains the optimized database's empty inline plugin maps and no snapshot-associated copy of `pluginsave/` or `pluginsave-meta/`.

Restoring such a snapshot restores the database and chats but does not restore plugin state from that time. Existing external rows remain at their newer values, and rows deleted since the snapshot remain absent. A snapshot advertised as a full assembled DB-only recovery point therefore cannot recover historical plugin data.

## Failure sequence

1. An optimized plugin key contains value `V1`.
2. An automatic database snapshot is created.
3. The key is changed to `V2`, deleted, or replaced by other keys.
4. The snapshot is restored.
5. The logical database returns to the snapshot time, but plugin storage remains at the post-snapshot state.

## Fix

- **Creation** — `createBackupAndRotate` now folds external plugin rows into every automatic snapshot (`foldPluginStorage: true`) and stamps the assembled database with a `pluginStorageFolded: true` top-level marker when the source database is optimized. The marker is present even when zero plugin rows exist, so a folded-empty snapshot is distinguishable from a pre-fix stub snapshot. The fold streams rows one at a time through the disk spool, and the spool file is persisted with `kvSetFromFile` (chunk-streaming write in `db.cjs`/`chunkStore.cjs`), so large plugin stores are never materialized as one Buffer.
- **Restore** — both ingest paths act on the marker and atomically clear-and-repopulate the plugin prefixes:
  - Streaming: `walkRisuSave` detects the marker, invokes `onPluginStorageFolded` (wired to `kvDelPrefix` on both prefixes) before emitting entries, all inside the transaction owned by `ingestStreamingDatabase`. The marker is always stripped from the walk remainder so it never persists into the live `database.bin`.
  - Legacy: `externalizePluginStorageIfNeeded` treats a marked database as externalizable (even with empty maps), clears both prefixes inside its write transaction before re-writing the rows, and drops the marker. Because `hasExternalizablePluginStorage` recognizes the marker, a crash mid-restore is completed by the defensive boot externalization.
- **Backward compatibility** — snapshots created before the fix carry no marker. Restoring one keeps the previous behavior (plugin rows left untouched) deliberately: an unmarked stub snapshot has no plugin data to repopulate from, so clearing would destroy the only surviving copy.

## Regression coverage

- `../../server/node/snapshotPluginStorage.e2e.test.ts` — end-to-end against the real server: the audit scenario (`V1` → snapshot → `V2`/delete/add → restore → exact snapshot-time key set and values) on both the legacy and streaming restore paths, folded-empty snapshot restore clearing later rows, and pre-fix stub snapshot restore leaving current rows untouched.
- `../../server/node/chunkStore.test.ts` (E1–E3) — `putValueFromFile` stores byte- and manifest-identical representations to `putValue` across window boundaries, threshold-sized values, and overwrites.
