# Snapshot restores can reference assets the boot GC already deleted

- Status: Open
- Severity: Medium
- Area: recovery consistency (snapshots vs. assets)
- Affected code: `server/node/server.cjs:355-380` (snapshots capture only the logical database), `src/ts/bootstrap.ts:627-644` (GC keeps only current-database references), `server/node/server.cjs:6613-6664` (restore replaces DB state without an asset generation)

## Risk

Automatic snapshots are DB-only. The client's boot GC deletes any asset not
referenced by the *current* database, including assets referenced only by
retained snapshots (e.g. a character portrait replaced since). Restoring such
a snapshot then yields dangling asset references: the recovery copy is
retained but silently incomplete. Portable/server backups do include assets
and are unaffected.

## Required fix and coverage

Record an asset manifest per snapshot and have GC keep the union of
references across retained snapshots, or package referenced asset bytes into
snapshots. Test: reference asset A, snapshot, replace with B, run GC, restore
the snapshot, assert A still resolves.
