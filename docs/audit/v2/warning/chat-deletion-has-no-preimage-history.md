# Deleting a young chat leaves no recovery copy

- Status: Open
- Severity: Medium
- Area: server persistence core / chat version backups
- Affected code: `server/node/chatBackups.cjs:583-587` (`skipped-no-row` for first-time rows), `server/node/server.cjs:741-747`, `server/node/server.cjs:782-791` (pending structural deletions executed as direct `kvDel` without the pre-image hook), `server/node/server.cjs:284-287` (snapshot cooldown)

## Risk

Pre-images are captured only when `/api/chat-content` *overwrites* an
existing row. A chat created and saved once has no pre-image (there was no
prior row), and if the 5-minute snapshot cooldown suppressed a snapshot since
its stub landed, no recovery copy references it. Deleting that chat — the
classic accidental deletion the chat-version feature exists to undo — removes
the row through the pending-deletion path, which never calls the pre-image
hook. The deletion is atomic and consistent (v1 fix) but unrecoverable.

## Required fix and coverage

Capture a forced, cooldown-exempt pre-image of every row in
`pendingChatRowDeletions` before the deleting transaction commits, aborting
the deletion if capture fails. Test: create chat → save once → delete →
assert a chat-version file exists.
