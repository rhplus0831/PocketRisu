# Server backups are acknowledged before reaching stable storage

- Status: Open
- Severity: Low
- Area: server recovery (backup durability)
- Affected code: `server/node/server.cjs:5049-5107` (stream → `end` → `rename` → `done`, no fsync of file or directory)

## Risk

The server-backup writer streams to a `.tmp` file, renames it, stats it, and
emits `done` without fsyncing the file or `backupsDir`. The rename protects
in-process readers, not power-loss durability: a host power cut shortly after
the acknowledgement can leave the archive absent, truncated, or zero-length.
Live data is unaffected — only the just-created recovery copy is at risk —
but users make backups precisely before risky operations.

## Required fix and coverage

fsync the temp file after streaming, rename, then fsync the backup directory
before emitting `done` (the pattern `assetStore.cjs:117-160` already uses).
