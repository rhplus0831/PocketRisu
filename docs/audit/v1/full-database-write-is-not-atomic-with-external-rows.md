# Full database writes are not atomic with external row writes

- Status: Fixed
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

## Resolution

The `/api/write` database branch now prepares every representation before any mutation. `chatRowStore.splitFullDb` produces the stripped stub graph and the chat payload list without writing, each chat row is pre-encoded to its exact row buffer, `preparePluginStorageExternalization` collects plugin rows and returns a plugin-stripped copy without touching KV, and the stripped `database.bin` buffer is encoded up front. All KV mutations — plugin rows, chat rows, `database.bin`, and removed-row deletion — then commit inside one synchronous `better-sqlite3` transaction; the nested store transactions (chunked writes, removed-row deletion) operate as savepoints. Any failure rolls the entire transaction back, so the request returns HTTP 500 with every prior byte intact.

`db.cjs` gained a test-only failure hook, `POCKETRISU_TEST_FAILPOINT`, parsed once at startup and inert when unset: `key:<exact-key>` fails a `kvSet` of that key, `prefix:<prefix>:<n>` fails the nth write under a prefix.

`../../../test/compat/database-write-atomicity.test.ts` boots a real seeded server and covers the demanded scenarios: a failure injected on the final `database.bin` write after multiple chat and plugin rows were prepared, and a failure injected midway through the chat-row writes. Both assert HTTP 500 and byte-identical `database.bin`, `chats/`, `pluginsave/`, and `pluginsave-meta/` rows via direct read-only SQLite inspection, plus a happy-path test asserting the committed stripped database, rows, and ETag. All four failure assertions fail against the pre-fix code.

The chat pre-image feature still applies only to `/api/chat-content`. With the write now atomic, a failed full write can no longer overwrite rows behind a 500; overwrites by a *successful* full write remain unversioned, which is a separate, lower-severity gap.

