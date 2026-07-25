# Patch processing deletes chat rows before the new stub database is durable

- Status: Open
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

