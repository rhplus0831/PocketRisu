# Bulk asset writes can commit a filesystem prefix on failure

- Status: Confirmed within-batch filesystem atomicity regression
- Severity: Medium
- Confidence: High

## Difference

main already committed server chunks of 50 independently, and the client split
requests into groups of 20. Within each server transaction, however, asset data
lived in SQLite and rolled back together. serve writes filesystem assets via
temporary file and rename while a SQLite transaction is open. Rolling back
SQLite cannot undo already-renamed files in that same chunk.

## Compatibility impact

ENOSPC or an injected error after entry k returns a batch failure with the
earlier file prefix durably replaced, later files old, and related metadata
potentially rolled back. The client further splits batches and exposes only
generic success/failure, so external callers cannot determine the committed
prefix.

## Recommendation

Stage files behind a recoverable batch journal with pre-images, or document
per-entry/idempotent semantics and return durable outcomes per item. Fault
every rename and metadata boundary in a multi-item test.
