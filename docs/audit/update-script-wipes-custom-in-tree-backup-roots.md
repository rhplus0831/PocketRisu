# update.sh deletes custom in-tree backup directories the server permits

- Status: Open
- Severity: Medium
- Area: deployment scripts
- Affected code: `update.sh:86` (deletion sweep spares only `save`, `backups`, `.installed-version`), `server/node/server.cjs:907` (`MANAGED_BACKUP_PATH_ROOTS` denylist omits arbitrary dirs like `data`), `server/node/server.cjs:911-930` (`save/__backup_path` marker written for the portable updater only)

## Risk

The backup-path API accepts any in-tree directory outside the managed roots
(e.g. `data/backups`) and records it in the `save/__backup_path` marker so the
*portable* updater preserves it. The root `update.sh` never reads that marker:
its replacement step deletes every top-level entry except the literal `save`,
`backups`, and `.installed-version`, erasing all recovery archives under a
custom root. `save/` (and the marker) survive, so the server silently recreates
an empty configured directory afterwards.

## Required fix and coverage

Make `update.sh` honor `save/__backup_path` (and `save/__chat_backup_path`)
before the sweep, or refuse in-tree custom recovery paths for source
deployments. A scripted test: configure `data/backups`, run the update
replacement step, assert the archives survive.
