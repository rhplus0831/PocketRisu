# Bulk filesystem writes can commit a partial prefix

- Status: Open
- Severity: Medium
- Owner: server backend
- Source reports: [data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/reports/bulk-write-commits-a-partial-filesystem-prefix.md), [compatibility investigation](../../../../.archived-docs/findings/2026-07-compatibility/reports/bulk-asset-write-partially-commits-files.md)

## Risk

The bulk endpoint validates entries before mutation but publishes filesystem
assets through renames that a surrounding SQLite rollback cannot undo. ENOSPC
or an injected failure after entry k leaves an earlier prefix durably replaced,
later files old, and related metadata potentially rolled back. Client-side
request chunking exposes only a generic failure, so callers cannot determine
the committed prefix.

No current production caller uses the endpoint, but its public contract remains
non-atomic.

## Required fix and coverage

Either stage files behind a recoverable batch journal with pre-images, or
document per-entry/idempotent semantics and return durable outcomes per item.
Fault every rename and metadata boundary in a multi-item test.
