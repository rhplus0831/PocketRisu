# SQLite snapshots depend on the file-backup path for temporary space

- Status: Fixed
- Severity: Medium
- Commits: `f410c8a6`, aggravated by `41ab5bb5`
- Affected code: `server/node/server.cjs:281-300`, `server/node/server.cjs:2230-2263`, `server/node/server.cjs:780-785`, `server/node/server.cjs:3970-3978`

## Risk

Automatic database snapshots end in SQLite under `database/dbbackup-*`, but their assembled database is first spooled under `backupsDir`. An unavailable, full, or read-only file-backup destination therefore disables SQLite snapshots even when the live `../../save` volume and SQLite database are healthy.

The write path commits `database/database.bin` before awaiting snapshot creation. A spool failure can consequently return HTTP 500 after the live write is durable and without creating a recovery copy. `lastBackupTime` is advanced before spooling succeeds, which suppresses another snapshot attempt for the configured interval.

Hub mode explicitly skips normal `backupsDir` creation while leaving SQLite snapshots enabled. On an immutable application root with a writable `../../save`, this was reproduced as a durable live database row, a 500 response opening `backups/.database-risudat-*.tmp`, and zero snapshot rows. Startup chat-backup reconciliation may create the directory on a writable root, but it does not solve read-only, unavailable, or full destinations.

## Required fix and coverage

Use a guaranteed-writable temporary location on the save volume or an operator-configurable OS spool for automatic snapshots and portable exports. Keep it independent of the optional server-file-backup destination. Advance `lastBackupTime` only after the snapshot row commits, and treat snapshot failure separately from the already successful live write response.

Test with a healthy writable save volume and an absent, read-only, full, and disconnected backup destination. Live writes should have truthful responses and automatic snapshots should either succeed through the independent spool or immediately retry after recovery.

## Resolution

Database assembly now spools to a dedicated directory on the save volume — `save/.spool` by default, relocatable via `POCKETRISU_SPOOL_DIR` — independent of the optional server-file-backup destination. The directory is created at startup in both normal and hub mode (a creation failure is logged and non-fatal), and orphaned `.database-risudat-*` spool files left by crashed runs are swept at boot. Automatic snapshots, portable exports, and server-file saves all assemble through this spool; final `risu-backup-*.bin` artifacts still land in `backupsDir`, and hub-mode gating of the file-backup endpoints is unchanged.

`createBackupAndRotate` now contains its own failures: a snapshot-only error is logged with the spool path and cause but never propagates, so a database write whose live row already committed responds with success, and flush and import paths are likewise unaffected. `lastBackupTime` advances only after the snapshot row commits, so a failed attempt retries on the next write instead of being suppressed for the configured interval; an in-flight guard replaces the early timestamp because backup-import paths run under the import barrier rather than the storage-operation queue. Export and server-save requests still fail when their own spooling fails.

Regression coverage in `../../test/compat/snapshot-spool.test.ts` boots a hub-mode server with no `../../backups` directory: a planted orphan spool file is swept at boot, a database write succeeds and produces a `database/dbbackup-*` snapshot, and `../../backups` is never created. A second server with `POCKETRISU_SPOOL_DIR` pointed at an unwritable path still returns success for a database write with zero snapshot rows while `/api/backup/export` fails as its own request; after the spool path becomes writable, the next write creates a snapshot immediately despite a one-hour backup interval, proving the failed attempt did not consume the cooldown.

