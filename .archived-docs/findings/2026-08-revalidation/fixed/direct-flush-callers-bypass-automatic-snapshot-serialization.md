# Direct flush callers bypass automatic-snapshot serialization

- Status: Fixed (2026-08-05 revalidation)
- Owner: backup and recovery
- Source: [2026-07 data-loss audit](../../2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium (at fix time)
- Resolution: `3e758f9a` — snapshots assemble from pinned sources outside the
  mutation queue (pinned WAL capture with source-token-gated publication), and
  the shutdown/self-update flush paths now queue through the storage-operation
  serialization instead of reading live KV mid-write.
- Regression coverage: `test/compat/snapshot-spool.test.ts` — snapshot spool
  isolation, chat-save acknowledgement ordering, and a delta append racing
  pinned assembly invalidating the older lock.
- Canonical architecture: [backup and recovery](../../../../docs/structure/backup-recovery.md)
- Lens: D1, D3
- Area: Area 6 — server recovery

## Original risk (historical)

Normal persistence and explicit exports serialize through the storage-operation
queue, and exports use a pinned KV snapshot. Graceful signal handling and the
post-self-update restart callback instead call `flushPendingDb()` directly.
Its automatic snapshot reads live KV across asynchronous file writes.

The server can admit a concurrent chat, patch, or plugin mutation while the
snapshot is assembling. A referenced chat row can disappear after the stub graph
is written, yet automatic snapshot logic preserves the bare stub and publishes a
mixed recovery point. Plugin rows can similarly come from different instants.

## Original required fix (historical)

Stop admission and drain/run shutdown flush through `queueStorageOperation()`,
or give every automatic snapshot a pinned `createKvSnapshot()` reader.

Pause assembly during signal and self-update flows, mutate a referenced row, and
require a complete pre- or post-mutation snapshot, never a bare-stub success.
