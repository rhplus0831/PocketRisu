# Bulk filesystem writes can commit a partial prefix

- Status: Fixed (2026-08-06 remediation queue)
- Owner: server backend
- Source reports: [data-loss audit](../../2026-07-data-loss-audit/reports/bulk-write-commits-a-partial-filesystem-prefix.md), [compatibility investigation](../../2026-07-compatibility/reports/bulk-asset-write-partially-commits-files.md)
- Severity: Medium (at fix time)
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../2026-08-revalidation/README.md)
- Resolution: `64042a36` — `/api/assets/bulk-write` now validates the
  complete request before mutation, commits each accepted item as an
  idempotent unit, and returns ordered `committed`, `not-committed`, or
  `unknown` outcomes. Server-side reconciliation rereads the authoritative
  filesystem/KV value after publication or commit-boundary failures and also
  verifies the required legacy-hash marker invariant. Duplicate keys,
  malformed reserved plugin rows, and stale legacy-hash exemptions are
  rejected definitively before any entry is written. The client strictly
  validates acknowledgements, preserves global outcomes across bounded
  20-entry/90 MiB chunks, and surfaces ambiguous transport outcomes without
  replaying them as known failures.
- Regression coverage: `test/compat/bulk-asset-write-outcomes.test.ts`
  (publication/commit/metadata/reconciliation faults, restart durability,
  duplicate and reserved-row preflight, mixed filesystem/KV routing,
  queue-time legacy-exemption race, selective retry);
  `src/ts/storage/nodeStorageAvailability.test.ts` (strict acknowledgement
  parsing, body loss, bounded chunking, global outcome mapping);
  `test/compat/backup-roundtrip.test.ts` (normal bulk success, whole-request
  hash validation, protected plugin-row rejection).
- Canonical architecture: [server backend](../../../../docs/structure/server-backend.md),
  [media and translation](../../../../docs/structure/media-translation.md)

## Risk

The bulk endpoint validates entries before mutation but publishes filesystem
assets through renames that a surrounding SQLite rollback cannot undo. ENOSPC
or an injected failure after entry k leaves an earlier prefix durably replaced,
later files old, and related metadata potentially rolled back. Client-side
request chunking exposes only a generic failure, so callers cannot determine
the committed prefix.

No current production caller uses the endpoint, but its public contract remains
non-atomic.

## Required fix and coverage (historical)

Either stage files behind a recoverable batch journal with pre-images, or
document per-entry/idempotent semantics and return durable outcomes per item.
Fault every rename and metadata boundary in a multi-item test.
