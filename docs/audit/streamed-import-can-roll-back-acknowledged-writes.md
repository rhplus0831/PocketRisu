# A streamed import can roll back concurrently acknowledged writes

- Status: Fixed
- Severity: High
- Commit: `8f0d6e07`
- Affected code: `server/node/server.cjs:5209-5263`, `server/node/chatRows.cjs:351-442`, storage queue at `server/node/server.cjs:129-134`

## Risk

Save-folder import opens a transaction and then awaits streamed database walking. Because the same `better-sqlite3` connection already has an open transaction, `ingestStreamingDatabase()` joins it rather than owning a nested transaction. The import does not hold `queueStorageOperation` while it yields for decompression and disk reads.

An ordinary `/api/write` can run during that await on the same connection. Its statements unknowingly become part of the import transaction, but the endpoint can return HTTP 200 before the import commits. If the walker later fails, import rolls back both its own work and the acknowledged concurrent write.

This was reproduced with a large gzip carrying a corrupt final checksum: a concurrent plugin write returned 200 and a hash, the import later failed and rolled back, and the acknowledged plugin key was absent. The streamed backup-import path has the same general barrier problem; it already held long asynchronous work inside its transaction, while `8f0d6e07` adds the interleavable streamed-ingest path to save-folder import.

## Required fix and coverage

Hold one mutation barrier for the complete import transaction, including filesystem publication, and make every write/list operation wait or return a clear retryable status. Prefer walking and validating into staging before opening a short commit transaction. Do not allow an endpoint to acknowledge a mutation that joined another request's transaction.

Add a late-failing streamed-import test with a concurrent write. That write must either wait and commit after rollback or be rejected before mutation; it must never return success and disappear.

## Resolution

`importBarrier` (`server/node/importBarrier.cjs`) is now the single mutation barrier for the whole import window, not just for `/api/list`. Two changes make it exclusive rather than advisory:

- `acquire()` claims the hold **before** draining, then awaits a no-op enqueued on the same serial storage queue that mutations use. Because that queue is FIFO, mutations split cleanly in two: anything already queued ahead of the drain runs to completion and commits before the import reaches `BEGIN`, and anything arriving afterwards observes `isHeld()`. There is no window in which a mutation can be admitted and then swept into the import transaction.
- Mutations now go through `queueStorageMutation()`, which performs the `isHeld()` check *inside* the queued callback. Checking from request scope would not work: handlers await auth and body parsing first, so an import could claim the barrier between the check and the write.

A refused mutation returns `503` with `Retry-After: 5` and `{ code: 'IMPORT_IN_PROGRESS', retryable: true }`. That is the honest answer rather than a multi-minute stall: the refused write targets pre-import state that the import is replacing wholesale, and the client is told to reissue it. `NodeStorage.setItem()` raises a distinct retryable error on `503` instead of a generic write failure.

Endpoint coverage widened well past the reported `/api/write`. `/api/remove`, `/api/assets/bulk-write`, `PUT /api/db/snapshots/limits`, `DELETE /api/db/snapshots`, `PUT /api/backup/boot-reminder` and `PUT /api/backup/server/path` mutated the database outside the storage queue entirely, so the barrier's drain could not see them; they now run inside `queueStorageMutation()`. `/api/write`, `/api/patch` (and its debounced persist), `/api/db/flush`, `POST /api/chat-content`, `/api/db/optimize` and `/api/db/wal-checkpoint` moved from `queueStorageOperation()` to `queueStorageMutation()`. The debounced patch save treats refusal as superseded rather than as a persist failure, because the import drops `dbCache` and replaces the key anyway.

Three consequences beyond the reported one are closed by the same gate. A concurrent `database.bin` write called `createBackupAndRotate()` inside the import's transaction, which would spool a snapshot from a half-cleared database. `VACUUM` in `/api/db/optimize` cannot legally run inside another request's transaction, and `/api/db/wal-checkpoint` cannot truncate past it. `/api/inlays/compress` is refused up front, since it rewrites inlay files an import is about to replace; `GET /api/chat-content` skips its cold-storage rehydration write-back while the barrier is held, as that write is only a cache fill.

`/api/db/snapshots/restore` acquired the barrier from inside `queueStorageOperation()`. That would deadlock against the new drain, so the acquire is hoisted above the queue call.

Regression coverage: `test/compat/import-mutation-barrier.test.ts` drives real servers with a late-failing streamed import — a magic-header gzip whose trailing CRC32 byte is flipped, so `zlib` only rejects it after the entire payload has inflated. The backup-import cases trickle the upload through a `ReadableStream` body, which holds that path's transaction open deterministically (it opens `BEGIN` before consuming the request), and assert that a racing plugin write is refused with the documented `503` shape, that `/api/remove` and `POST /api/chat-content` share the gate, that the pre-import value survives the rollback intact, and that the advised retry then succeeds. The save-folder case exercises the streamed-ingest path added by `8f0d6e07`: it writes a distinct plugin key every 25 ms for the whole import and, after the rollback, requires every key that received a 200 to still hold its exact bytes. Against the unfixed server the backup case returns 200 for a write whose value is gone, and the save-folder case loses 23 acknowledged plugin keys. `server/node/importBarrier.test.ts` adds unit coverage for `isHeld()` lifetime, drain-before-acquire ordering, and hold release on drain failure.

Not done: the audit also suggested walking and validating into staging before opening a short commit transaction. Both import paths still hold their transaction across streamed work; the barrier makes that safe for concurrent mutations, but the long-transaction shape (and the WAL growth it implies) remains.
