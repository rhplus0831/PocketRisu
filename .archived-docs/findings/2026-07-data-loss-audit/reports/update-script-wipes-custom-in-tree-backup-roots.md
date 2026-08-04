# update.sh deletes custom in-tree backup directories the server permits

- Status: Fixed
- Severity: Medium
- Area: deployment scripts
- Formerly affected code: historical replacement sweep in `update.sh`; fixed by
  marker-aware keep-list construction and covered by
  `server/node/updateScript.test.ts`

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

## Resolution

Fixed 2026-07-31. The source updater now reads and path-normalizes both recovery
markers before deleting old application files. It preserves the exact top-level
directory containing each custom in-tree server-backup or chat-history root,
ignores paths outside the installation, and refuses app-root or managed-code
targets before the deletion sweep begins.

`server/node/updateScript.test.ts` performs complete updates against temporary
installations using a local release archive. It verifies that `save/`, default
backups, custom server archives, and custom chat versions survive while stale
application files are replaced, including a custom root with shell-pattern
characters. A second case proves a managed-root marker aborts without deleting
the old installation.
