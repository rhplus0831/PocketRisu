# Filesystem imports can diverge from the SQLite transaction after a crash

- Status: Fixed
- Severity: High
- Commit: `7f853d93`
- Affected code: `server/node/assetStore.cjs:25-76`, `server/node/server.cjs:2504-2715`, `server/node/server.cjs:5210-5267`

## Risk

Backup and save-folder imports replace asset and inlay directories with filesystem renames before committing the corresponding SQLite transaction. The returned swap object can roll back an exception in the running process, but there is no durable phase journal or startup recovery for process termination.

If the process dies after the directory rename and before `COMMIT`, SQLite restores the old logical database while the live filesystem directory contains the imported files. The old files remain only in `assets_import_backup` or `inlays_import_backup`; the application does not restore them on boot. The next import preparation deletes those backup directories at `server/node/server.cjs:1434-1435` and `server/node/server.cjs:2320-2322`, making the loss permanent.

## Failure sequence

1. Import opens a SQLite transaction and stages new filesystem data.
2. The live directory is renamed to the backup name, and staging becomes live.
3. The process or host stops before the SQLite commit.
4. SQLite rolls back, but the filesystem renames remain.
5. Restart serves a database/filesystem combination that never existed as one committed state.
6. A later import removes the only copy of the old directory.

The asset migration marker in the newly installed directory can also prevent startup migration from reconstructing the old logical state.

## Required fix and coverage

Use a durable import journal with explicit prepared, swapped, and committed phases. Fsync staged files and relevant parent directories, then have startup either restore the backup directory or finish the committed swap before serving requests. Do not delete a previous backup until recovery state proves it is obsolete.

Add kill-at-each-phase tests for both assets and inlays, including restart and a subsequent import.

## Resolution

Imports now write a durable journal (`../../server/node/importJournal.cjs`) before touching the live directories. The journal is written atomically (temp file, fsync, rename, parent-directory fsync) and records an import id, a phase (`swapped` or `committed`), and every directory triple (live, backup, staging) with whether the live directory existed. Before the swap, both import paths fsync the staged directory trees, then set a marker row (`import_journal/marker` holding the import id) inside the still-open SQLite transaction. Because the marker commits or rolls back atomically with the logical writes, its presence after a restart is the authoritative signal for whether the transaction survived.

The commit sequence is now: fsync staging, set marker, write `swapped` journal, rename directories, `COMMIT`, restore `synchronous = NORMAL` (backup import runs the transaction at `OFF`), `wal_checkpoint(TRUNCATE)` to make the commit power-loss durable, rewrite the journal as `committed`, delete the backup directories, delete the marker, clear the journal. The `committed` rewrite lands before the marker deletion so a crash between those steps cannot make a later recovery misread finalized directories as an uncommitted swap. Journal writes fsync the save directory, which also persists the sibling directory renames.

Startup (`startServer`, before the filesystem migrations) and every import preparation site run `recoverPendingImportSwap`: if a journal exists, recovery finalizes when the phase is `committed` or the marker matches the journal id, and otherwise restores — imported live directories are removed, backups are renamed back into place, and every partial-rename state (backup present with live missing, live-to-backup rename never run, original live directory never existed) is handled per directory. Recovery is idempotent under a crash mid-recovery, and backup directories are only deleted by import preparation after recovery has resolved the pending journal. In-process failures keep the existing rollback closures and clear the journal only when the rollback fully succeeded, leaving boot recovery to repair anything else.

`../../server/node/importJournal.test.ts` covers kill-at-each-phase states for both the asset and inlay pairs: staging-only leftovers, corrupt or truncated journals, full and partial swaps with the marker absent, marker-present and `committed` finalization, and backup deletion by a subsequent import after restore. Live boot testing against fabricated mid-swap and committed-phase states verified both recovery directions end to end.

