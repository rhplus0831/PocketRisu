# Deleting a young chat leaves no recovery copy

- Status: Fixed 2026-07-31
- Severity: Medium
- Area: server persistence core / chat version backups
- Affected code: `server/node/chatBackups.cjs` (`captureChatPreImage()`), `server/node/chatRows.cjs` (`removedChatRowKeys()`), `server/node/server.cjs` (`captureChatDeletionPreImages()` and structural database publication)

## Resolution

Fixed 2026-07-31. Structural chat-row deletion now resolves every removed row
key back to its character/chat identity and captures a `delete-chat` pre-image
before entering the deleting SQLite transaction. Deletion capture is forced
through the ordinary 45-second cooldown and cold-storage-stub filter. It is
also required: read or filesystem publication failure rejects the database
persist, leaving both `database.bin` and the authoritative chat row unchanged.

The protection covers debounced patch persistence, cache-backed full-write
fallback, and plugin-storage transitions that unexpectedly remove a chat
identity. Ordinary chat overwrites retain their prior best-effort behavior, so
a history-volume failure does not block normal message saves. Destructive
imports and the orphan grace sweep remain separate replacement/maintenance
operations rather than user chat-deletion flows.

`server/node/chatBackups.test.ts` covers forced cooldown/cold-storage capture
and required error propagation. `test/compat/database-write-atomicity.test.ts`
covers the exact create row -> publish first stub -> delete sequence, byte-exact
history recovery, full-write fallback, and fail-closed rollback.

## Risk (historical)

Pre-images are captured only when `/api/chat-content` *overwrites* an
existing row. A chat created and saved once has no pre-image (there was no
prior row), and if the 5-minute snapshot cooldown suppressed a snapshot since
its stub landed, no recovery copy references it. Deleting that chat — the
classic accidental deletion the chat-version feature exists to undo — removes
the row through the pending-deletion path, which never calls the pre-image
hook. The deletion is atomic and consistent (v1 fix) but unrecoverable.

## Required fix and coverage (completed)

Capture a forced, cooldown-exempt pre-image of every row in
`pendingChatRowDeletions` before the deleting transaction commits, aborting
the deletion if capture fails. Test: create chat → save once → delete →
assert a chat-version file exists.
