# Filesystem imports can diverge from the SQLite transaction after a crash

- Status: Open
- Severity: High
- Commit: `7f853d93`
- Affected code: `server/node/assetStore.cjs:25-76`, `server/node/server.cjs:2504-2715`, `server/node/server.cjs:5210-5267`

## Risk

Backup and save-folder imports replace asset and inlay directories with filesystem renames before committing the corresponding SQLite transaction. The returned swap object can roll back an exception in the running process, but there is no durable phase journal or startup recovery for process termination.

If the process dies after the directory rename and before `COMMIT`, SQLite restores the old logical database while the live filesystem directory contains the imported files. The old files remain only in `assets_import_backup` or `inlays_import_backup`; the application does not restore them on boot. The next import preparation deletes those backup directories at `server/node/server.cjs:1288-1294` and `server/node/server.cjs:2378-2384`, making the loss permanent.

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

