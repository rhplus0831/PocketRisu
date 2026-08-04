# Best-effort path markers let updaters delete recovery directories

- Status: Open
- Owner: backup and recovery
- Source: [2026-07 data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium
- Lens: D2, D5, L4
- Area: Area 6 — server recovery
- Affected code: `server/node/server.cjs:901-938`, `server/node/server.cjs:970-983`, `server/node/server.cjs:6745-6767`, `server/node/server.cjs:7052-7072`, `server/node/server.cjs:7135-7140`, `scripts/updater.cjs:41-63`, `scripts/updater.cjs:267-288`, `scripts/updater.cjs:368-373`

## Risk

Custom in-tree server- and chat-backup roots survive updates only through marker
files under `save/`. Marker writers swallow all failures; the backup-path API
commits the new configuration and reports success even when publication fails.
The standalone updater also treats any marker read error as absence.

Both updaters preserve only hard-coded roots when the marker is absent, move
other top-level entries into update-temporary storage, and delete that tree after
success. A configured `data/backups` directory can thus be classified as debris
and permanently removed along with every recovery archive.

## Required fix and coverage

Make atomic, fsynced marker publication part of accepting an in-tree path and
roll back configuration on failure. Updaters must abort on missing or unreadable
preservation metadata when a custom path may exist.

Fault marker creation/read and assert both updater paths preserve the archives.
