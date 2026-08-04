# Bulk write commits a partial filesystem prefix

- Status: Open
- Severity: Medium
- Lens: D1
- Area: Area 7 — server file stores
- Affected code: `server/node/server.cjs:4654-4675`, `server/node/server.cjs:4677-4699`, `server/node/server.cjs:1460-1479`, `server/node/assetStore.cjs:117-160`, `src/ts/storage/nodeStorage.ts:659-674`

## Risk

The bulk endpoint validates all entries before mutation, then processes groups
of 50 in separate SQLite transactions. Filesystem assets are durably renamed
inside those transactions, but SQLite rollback cannot undo a rename and there is
no file pre-image or journal. The client further splits requests into groups of
20 and reports only generic failure.

ENOSPC or another error after entry k leaves earlier files irreversibly replaced,
later files old, and same-transaction metadata potentially rolled back. External
callers cannot determine the committed prefix. No current production caller
limits likelihood, but the exposed endpoint contract remains non-atomic.

## Required fix and coverage

Either document per-entry/idempotent semantics and return durable status for each
entry, or stage files with a recoverable batch journal and pre-images. Do not
expose a success/failure-only client abstraction over independently committed
requests. Fault every batch and rename boundary.
