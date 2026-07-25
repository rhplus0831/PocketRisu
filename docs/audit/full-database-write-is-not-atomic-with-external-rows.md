# Full database writes are not atomic with external row writes

- Status: Open
- Severity: High
- Commits: `9cb0086d`, extended to plugin rows by `93e1dd4f`
- Affected code: `server/node/server.cjs:3917-3959`, `server/node/server.cjs:2180-2211`, `server/node/chatRows.cjs:236-238`

## Risk

The compatibility `/api/write` path accepts a complete database containing chat payloads and folded optimized plugin data. It writes plugin rows, then writes extracted chat rows, then encodes and writes `database/database.bin`. There is no outer transaction spanning those representations.

If a later row write, encoding step, or final database write fails, earlier external rows stay committed. Existing same-ID chat rows can already have been overwritten, so the old durable stub graph now resolves to a partial mixture of new payloads even though the request returns HTTP 500. Folded plugin values have the same gap after `93e1dd4f`: the old optimized database remains live but resolves through newly committed external rows.

The chat pre-image feature is bypassed because this path calls row externalization directly rather than `/api/chat-content`.

## Required fix and coverage

Prepare and validate all decoded objects and encoded buffers before mutation where possible. Then wrap plugin externalization, chat-row writes, the database write, removed-row deletion, and marker changes in one outer SQLite transaction. The nested `better-sqlite3` transactions can safely operate as savepoints.

Inject a failure on the final `database.bin` write after multiple chat and plugin rows have been prepared. Assert that the response fails and every old database, chat-row, and plugin-row byte remains unchanged. Also inject a failure midway through multiple chat writes.

