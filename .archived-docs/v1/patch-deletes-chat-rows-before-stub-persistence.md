# Patch processing deletes chat rows before the new stub database is durable

- Status: Fixed
- Severity: High
- Commit: `9cb0086d`
- Affected code: `server/node/server.cjs:4097-4167`, `server/node/chatRows.cjs:240-249`

## Risk

A structural `/api/patch` applies the new stub graph in memory and immediately calls `deleteRemovedChatRows()`. That deletion commits synchronously. The updated `database.bin` remains only in `dbCache`, is scheduled for persistence by a five-second timer, and the API returns success first.

A process crash or later `kvSet` failure therefore leaves the old durable database pointing to a row that has already been deleted. A replacement operation may also leave the new row orphaned, so neither the old nor new chat is reachable from the durable stub graph.

The chat pre-image feature does not protect this path. It captures only immediately before `/api/chat-content` overwrites a row (`server/node/server.cjs:5110-5120`); `deleteRemovedChatRows()` bypasses it.

## Required fix and coverage

Do not delete removed rows while the new graph is only cached. Persist the encoded stub database and its row deletions in one outer SQLite transaction. A less aggressive alternative is to leave removed rows as orphans and let the existing grace-period sweep remove them after the new graph is known durable.

Add fault-injection coverage that applies a structural patch, forces stub persistence to fail, restarts, and verifies that every stub in the old durable database still resolves to its original row. Add a kill-before-timer variant.

## Resolution

`/api/patch` no longer deletes removed chat rows at patch time. Removed keys are recorded in a pending-deletion set (`trackPendingChatRowDeletions`); a later patch that re-adds a chat drops its key from the set. `persistDbCache` now commits the encoded stub database, any plugin-row externalization, and the pending deletions in one synchronous `better-sqlite3` transaction, filtering the pending set against the rows the persisted graph still references so a referenced row can never be deleted. The set is cleared only after the transaction commits, and every cache-invalidation path (full write, backup import, save-folder import, snapshot restore, patch failure) also clears it, leaving at worst orphan rows for the existing grace-period sweep.

A crash or persist failure before the timer fires therefore leaves the old durable database resolving every stub to its original row: rows written by replacement patches may be orphaned, but no referenced row is deleted before the new graph is durable.

`../../test/compat/database-write-atomicity.test.ts` covers this with a structural remove patch against a real seeded server: before any flush, the removed chat's row and `database.bin` are byte-identical on disk (inspected through a separate read-only SQLite connection — the same state a restart or kill-before-timer would boot from); a flush with an injected `database.bin` write failure returns 500 and leaves both unchanged; a successful flush removes the stub and deletes the row together. The failure assertions fail against the pre-fix code.

