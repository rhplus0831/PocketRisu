# Decoded stream-load spools bypass the configured spool and orphan sweep

- Status: Open
- Owner: server backend
- Source: [2026-07 data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium
- Lens: D5, L3, L4
- Area: Area 5 — server KV core and chat rows
- Affected code: `server/node/streamRisuLoad.cjs:970-985` and legacy decoded-temp creation near `:1090`, `:1271`, and `:1306`; `server/node/server.cjs:2256-2258` (buffer-backed boot-migration ingestion supplies `savePath`); owned-spool boot sweep prefix list near `server/node/server.cjs:3145-3152` (decoded-name families absent)
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../../../.archived-docs/findings/2026-08-revalidation/README.md)
- Evidence refreshed: 2026-08-06 during spool-ownership remediation. Snapshot restore now reads a bounded file source (`server/node/server.cjs:20925-20929`), and the loader prefers that source path over its `tempDir` fallback; it is not a second actual `savePath` decoded-temp path.

## Risk

Compressed streaming loads inflate into a seekable decoded temp file whose
cleanup lives only in the live walker's `finally`. The confirmed save-root
exposure is Buffer-backed boot-migration ingestion of an authoritative
`database.bin`: it supplies `savePath`, so the decoded file lands under `save/`,
not the configured database spool. File-backed compressed imports and snapshot
restore instead inherit the source file's path; snapshot restore's source is
the bounded file in the owned spool even though its caller also supplies a
`savePath` fallback.

The boot sweep's prefix list has never learned the stream-load naming family,
so termination orphans survive under `save/` and decoded siblings created
beside file-backed sources can remain inside the owned spool quarantine instead
of being recognized by the sweep. Repeated interrupted boot migration can
accumulate large decoded payloads and fill the authoritative save volume;
ENOSPC there is the trigger condition for other destructive findings.

## Required fix and coverage

Route decoded spools through the configured spool directory and the shared
naming, ownership, and cleanup scheme, and add the stream-load name family to
the boot sweep. Retain `finally` cleanup and add a boot-recoverable lease or
owner/age record for termination orphans.

Kill ingestion after inflation and during traversal, then assert restart
cleanup in default and custom spool configurations for the Buffer-backed boot
migration path and for decoded-name siblings of file-backed sources.
