# Direct flush callers bypass automatic-snapshot serialization

- Status: Open
- Owner: backup and recovery
- Source: [2026-07 data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium
- Lens: D1, D3
- Area: Area 6 — server recovery
- Affected code: `server/node/server.cjs:355-402`, `server/node/server.cjs:2490-2531`, `server/node/server.cjs:4703-4724`, `server/node/server.cjs:4970-4988`, `server/node/server.cjs:7142-7150`, `server/node/server.cjs:7343-7349`

## Risk

Normal persistence and explicit exports serialize through the storage-operation
queue, and exports use a pinned KV snapshot. Graceful signal handling and the
post-self-update restart callback instead call `flushPendingDb()` directly.
Its automatic snapshot reads live KV across asynchronous file writes.

The server can admit a concurrent chat, patch, or plugin mutation while the
snapshot is assembling. A referenced chat row can disappear after the stub graph
is written, yet automatic snapshot logic preserves the bare stub and publishes a
mixed recovery point. Plugin rows can similarly come from different instants.

## Required fix and coverage

Stop admission and drain/run shutdown flush through `queueStorageOperation()`,
or give every automatic snapshot a pinned `createKvSnapshot()` reader.

Pause assembly during signal and self-update flows, mutate a referenced row, and
require a complete pre- or post-mutation snapshot, never a bare-stub success.
