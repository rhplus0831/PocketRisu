# Decoded stream-load spools bypass the configured spool and orphan sweep

- Status: Fixed (2026-08-06 remediation queue)
- Owner: server backend
- Source: [2026-07 data-loss audit](../../2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium (at fix time)
- Lens: D5, L3, L4
- Area: Area 5 — server KV core and chat rows
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../2026-08-revalidation/README.md)
- Resolution: `98b3e2a7` — canonical and legacy decoded loads now create
  private `0600` files under the caller-supplied spool using three shared name
  families recognized by boot cleanup. Every production decoder boundary
  requires the configured, installation-owned, descriptor-pinned spool instead
  of inheriting a file source's directory or falling back to `save/` or the OS
  temporary directory. The established persistent owner UUID, canonical-save-root
  claim, quarantine sweep, and process-lifetime pinned directory provide the
  boot-recoverable ownership record without an unsafe age-only policy. Live
  paths retain failure and `finally` cleanup; successful streamed plugin uploads
  are also removed before their committed acknowledgement, with `finally` kept
  as the error-path fallback.
- Regression coverage: `server/node/streamRisuLoadTopLevel.test.ts` (file-backed
  decode routes into an explicit spool, uses the shared stream family and
  `0600`, and cleans after traversal rejection);
  `test/compat/snapshot-spool.test.ts` (SIGKILL after inflation in the default
  spool and during traversal in a custom spool, restart cleanup for canonical
  and both legacy families, no decoded save-root artifact, and fail-closed
  compressed manifest decoding when a custom spool is unavailable);
  `test/compat/stream-risu-load.test.ts` (bounded success, inflation, abort,
  corrupt-input, and legacy-block cleanup paths);
  `test/compat/plugin-storage-mutation-atomicity.test.ts` (streamed upload
  cleanup before acknowledgement, including custom-spool repair).
- Canonical architecture: [server backend](../../../../docs/structure/server-backend.md)

## Original risk (historical)

Compressed streaming loads inflated into a seekable decoded temp file whose
cleanup lived only in the live walker's `finally`. The confirmed save-root
exposure was Buffer-backed boot-migration ingestion of an authoritative
`database.bin`: it supplied `savePath`, so the decoded file landed under
`save/`, not the configured database spool. File-backed compressed imports and
snapshot restore instead inherited the source file's path.

The boot sweep did not recognize the stream-load naming family, so termination
orphans survived under `save/` and decoded siblings created beside file-backed
sources could remain inside the owned spool quarantine. Repeated interrupted
boot migration could accumulate large decoded payloads and fill the
authoritative save volume; ENOSPC there is the trigger condition for other
destructive findings.

## Required fix and coverage (historical)

Route decoded spools through the configured spool directory and the shared
naming, ownership, and cleanup scheme, and add the stream-load name family to
the boot sweep. Retain `finally` cleanup and add a boot-recoverable lease or
owner/age record for termination orphans.

Kill ingestion after inflation and during traversal, then assert restart
cleanup in default and custom spool configurations for the Buffer-backed boot
migration path and for decoded-name siblings of file-backed sources.
