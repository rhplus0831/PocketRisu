# Decoded stream-load spools bypass the configured spool and orphan sweep

- Status: Open
- Owner: server backend
- Source: [2026-07 data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium
- Lens: D5, L3, L4
- Area: Area 5 — server KV core and chat rows
- Affected code: `server/node/streamRisuLoad.cjs` decoded-temp creation, `server/node/server.cjs:2170` (boot/import ingest with `savePath`), `server/node/server.cjs:20519` (snapshot restore with `savePath`), boot sweep prefix list (`.database-risudat-` only)
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../../../.archived-docs/findings/2026-08-revalidation/README.md)

## Risk

Compressed streaming loads inflate into a seekable decoded temp file whose
cleanup lives only in the live walker's `finally`. The surviving exposure is
Buffer-backed ingestion: the two `savePath` callers — boot/import ingestion of
an authoritative `database.bin` and snapshot restore — place the decoded file
under `save/`, not the configured `databaseSpoolDir`. File-backed compressed
imports are covered incidentally, because their decoded temps inherit the
source's swept spool prefix.

The boot sweep's prefix list has never learned the stream-load naming family,
so termination orphans survive both under `save/` and — for legacy-decode
temps — even inside the configured spool directory. Repeated interrupted boot
or migration ingestion can accumulate large decoded payloads and fill the
authoritative save volume; ENOSPC there is the trigger condition for other
destructive findings.

## Required fix and coverage

Route decoded spools through the configured spool directory and the shared
naming, ownership, and cleanup scheme, and add the stream-load name family to
the boot sweep. Retain `finally` cleanup and add a boot-recoverable lease or
owner/age record for termination orphans.

Kill ingestion after inflation and during traversal, then assert restart
cleanup in default and custom spool configurations, for both file-backed and
Buffer-backed sources.
