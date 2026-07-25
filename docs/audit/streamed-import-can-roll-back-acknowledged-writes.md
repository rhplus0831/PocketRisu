# A streamed import can roll back concurrently acknowledged writes

- Status: Open
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

