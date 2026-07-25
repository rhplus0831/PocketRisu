# Small-database imports validate the payload after the destructive commit

- Status: Open
- Severity: High
- Area: server recovery (backup import, save-folder import)
- Affected code: `server/node/server.cjs:2794-2829` (destructive clear), `server/node/server.cjs:2942-2946` (raw store without decode), `server/node/server.cjs:2993-3003` (commit + finalize), `server/node/server.cjs:3064-3073` (post-commit ingest), `server/node/server.cjs:5661-5690`, `server/node/server.cjs:5764-5767` (same ordering in save-folder import), `server/node/streamRisuLoad.cjs:21`, `server/node/streamRisuLoad.cjs:114-118` (32 MiB streaming threshold), `server/node/utils.cjs:407-448` (decoder throws after all fallbacks)

## Risk

Backup and save-folder imports decode `database.risudat` inside the replacement
transaction only when the streaming path is selected, which requires a supported
format **and** a size at or above the 32 MiB threshold. Any smaller (or exotic
format) database is stored raw via `kvSet(DB_BLOB_KEY, ...)` without decoding.
The transaction then deletes current chat rows, plugin rows, assets, inlays,
cold storage, and drafts, swaps the asset/inlay directories, commits, and
finalizes the old directories away. Only after that point does
`ingestDatabase()` decode the imported bytes.

A correctly framed archive containing a corrupt or truncated small database
(truncated download, disk error on the source machine, foreign tool output)
therefore passes every pre-commit check, destroys the current data, and only
then fails decoding — with no rollback path remaining. `database.bin` is left
holding undecodable bytes and the client cannot boot from it.

The pre-import `createBackupAndRotate()` (`server/node/server.cjs:2784-2785`,
`5649-5650`) is not an adequate guard: it is DB-only (assets and inlays are
never captured), cooldown-gated (a snapshot less than 5 minutes old suppresses
a fresh capture), and its errors are swallowed. After the import commits, the
old asset and inlay trees are unrecoverable; chats and plugin rows are
recoverable only up to snapshot staleness.

## Required fix and coverage

Decode and fully validate every non-streaming database before the first
destructive mutation (a spool decode outside the transaction is fine), then
ingest the already-validated object inside the replacement transaction, mirroring
the streaming path. Do not finalize the displaced asset/inlay directories until
post-import ingestion has completed successfully.

Add compat coverage that imports a well-framed backup whose small
`database.risudat` is truncated msgpack and asserts the server still serves the
pre-import database, chat rows, assets, and inlays afterward.
