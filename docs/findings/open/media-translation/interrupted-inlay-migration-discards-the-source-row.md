# A crash during inlay migration can discard the valid KV source

- Status: Open
- Owner: media and translation
- Source: [2026-07 data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium
- Area: server file stores (inlay migration)
- Affected code: `server/node/server.cjs:1397-1443` (`migrateInlaysToFilesystem`), `server/node/server.cjs:1405-1411` (any existing file → delete KV source), `server/node/server.cjs:1281-1291` (direct-to-final-name write)

## Risk

Startup migration writes each legacy `inlay/<id>` KV payload directly to its
final filename (via the non-atomic `writeInlayFile`), then deletes the KV row.
If the process crashes mid-write, a partial or zero-length file remains under
the final name. On the next boot the migration sees `readInlayFile(id)` return
bytes, treats the destination as already migrated, and deletes the still-valid
KV payload, thumbnail, and legacy info — leaving the torn file as the only
copy. The v1 asset-migration fix (byte-equality before source deletion,
`assetStore.cjs:163-172`) established the correct pattern; the inlay migration
does not use it. Requires a crash inside the one-time migration window, hence
warning rather than fatal.

## Required fix and coverage

Publish through an atomic temp-file/rename/fsync helper and delete the KV
source only after verifying the destination bytes match the decoded legacy
payload. Fault-injection test: kill mid-migration, restart, assert the inlay
is intact from either source.
