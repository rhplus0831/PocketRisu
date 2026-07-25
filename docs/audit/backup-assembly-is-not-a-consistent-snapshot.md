# Backup assembly is not a consistent snapshot of chat rows

- Status: Open
- Severity: High
- Commits: `9cb0086d`, retained by `f410c8a6`
- Affected code: `server/node/server.cjs:4303-4319`, `server/node/server.cjs:4545-4558`, `server/node/streamRisuSave.cjs:152-161`, `server/node/chatRows.cjs:164-166`

## Risk

Portable and server backup endpoints flush the pending stub database and then asynchronously spool its referenced chat rows one at a time. They do not hold `queueStorageOperation` for the capture. A concurrent structural patch can delete a row after the stub graph has been captured but before the spooler reads that row.

Missing rows do not abort assembly. `mergeChatStubWithFullChat(stub, null)` returns the bare stub, so the backup completes successfully with no chat messages for that reference. Import clears existing chat rows and cannot reconstruct the missing payload from the archive.

This is a point-in-time consistency defect, not merely a backup that is slightly newer or older: the emitted graph can reference a payload absent from every representation in the archive.

## Required fix and coverage

Hold the storage-operation barrier from stub capture through completion of every row read, or snapshot the stub and all referenced row bytes in one SQLite read transaction before streaming. Treat a missing referenced row as an integrity error and abort or retry; never serialize a bare `_stub` as a self-contained backup.

Add a deterministic test that pauses the spooler between stub capture and a row read, concurrently removes that row, and requires either a complete pre-delete backup or a complete post-delete backup. A successful archive containing a bare referenced stub must fail the test.

