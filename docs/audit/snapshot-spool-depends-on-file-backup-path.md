# SQLite snapshots depend on the file-backup path for temporary space

- Status: Open
- Severity: Medium
- Commits: `f410c8a6`, aggravated by `41ab5bb5`
- Affected code: `server/node/server.cjs:281-300`, `server/node/server.cjs:2230-2263`, `server/node/server.cjs:780-785`, `server/node/server.cjs:3970-3978`

## Risk

Automatic database snapshots end in SQLite under `database/dbbackup-*`, but their assembled database is first spooled under `backupsDir`. An unavailable, full, or read-only file-backup destination therefore disables SQLite snapshots even when the live `save/` volume and SQLite database are healthy.

The write path commits `database/database.bin` before awaiting snapshot creation. A spool failure can consequently return HTTP 500 after the live write is durable and without creating a recovery copy. `lastBackupTime` is advanced before spooling succeeds, which suppresses another snapshot attempt for the configured interval.

Hub mode explicitly skips normal `backupsDir` creation while leaving SQLite snapshots enabled. On an immutable application root with a writable `save/`, this was reproduced as a durable live database row, a 500 response opening `backups/.database-risudat-*.tmp`, and zero snapshot rows. Startup chat-backup reconciliation may create the directory on a writable root, but it does not solve read-only, unavailable, or full destinations.

## Required fix and coverage

Use a guaranteed-writable temporary location on the save volume or an operator-configurable OS spool for automatic snapshots and portable exports. Keep it independent of the optional server-file-backup destination. Advance `lastBackupTime` only after the snapshot row commits, and treat snapshot failure separately from the already successful live write response.

Test with a healthy writable save volume and an absent, read-only, full, and disconnected backup destination. Live writes should have truthful responses and automatic snapshots should either succeed through the independent spool or immediately retry after recovery.

