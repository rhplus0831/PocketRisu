# Decoded stream-load spools bypass the configured spool and orphan sweep

- Status: Open
- Owner: server backend
- Source: [2026-07 data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium
- Lens: D5, L3, L4
- Area: Area 5 — server KV core and chat rows
- Affected code: `server/node/streamRisuLoad.cjs:494-519`, `server/node/streamRisuLoad.cjs:532-540`, `server/node/streamRisuLoad.cjs:701-703`, `server/node/server.cjs:562-566`, `server/node/server.cjs:872-899`

## Risk

Compressed streaming loads inflate into a seekable `.decoded-<uuid>.tmp` file.
For Buffer-backed server ingestion, that file is placed under `save/`, not the
configured `databaseSpoolDir`. Cleanup is only in the live walker's `finally`.

Process or host termination leaves a potentially much larger decompressed file,
while startup scans only the configured spool directory and only names beginning
`.database-risudat-`. Repeated failures can fill the authoritative save volume
even when an operator deliberately relocated temporary expansion elsewhere.

## Required fix and coverage

Route decoded spools through the configured spool directory and shared naming,
ownership, and cleanup scheme. Retain `finally` cleanup and add a boot-recoverable
lease or owner/age record for termination orphans.

Kill ingestion after inflation and during traversal, then assert restart cleanup
in default and custom spool configurations.
