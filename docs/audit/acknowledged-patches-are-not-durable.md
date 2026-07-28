# Acknowledged database patches are not durable for up to five seconds

- Status: Deferred
- Severity: High
- Area: server persistence core
- Affected code: `server/node/server.cjs:139` (`SAVE_INTERVAL` = 5 s), `server/node/server.cjs:4475-4553` (patch applied to `dbCache`, persistence deferred, success returned), `server/node/server.cjs:753-804` (`persistDbCache` commits later), `server/node/logs.cjs:323-356` (uncaught-exception/unhandled-rejection handlers `process.exit(1)` without flushing), `src/ts/globalApi.svelte.ts:1043-1057` (client clears dirty tracking on ack)

## Risk

`/api/patch` applies the patch to the in-memory `dbCache`, schedules
`persistDbCache()` five seconds later, and returns success immediately. The
client treats the acknowledgement as durable and drops its tracked changes, so
nothing is retried after a crash.

A power loss or SIGKILL inside the window loses up to five seconds of
acknowledged metadata (character edits, presets, settings, stub-graph changes).
More importantly, the installed `uncaughtException`/`unhandledRejection`
handlers call `process.exit(1)` **without flushing pending patches** — any
server-side bug anywhere converts into loss of acknowledged writes. Graceful
SIGTERM/SIGINT shutdown does flush; crashes do not.

The sharpest sub-case: a newly created chat writes its row synchronously via
`/api/chat-content`, but the stub that makes it reachable travels in the
deferred patch. Crash before the flush leaves the row orphaned; the orphan
grace-period sweep later deletes it, so the whole chat (content included) is
eventually lost even though both writes were acknowledged.

The v1 remediation (`../../.archived-docs/v1/patch-deletes-chat-rows-before-stub-persistence.md`)
made deferred persistence safe against *deletions* but deliberately kept the
deferred timer; the ack-before-durable window itself was never addressed.

## Required fix and coverage

Either commit the patched database before acknowledging, or split the protocol
into staged/durable acknowledgements so the client retains dirty state until a
flush confirmation. Cheaper interim hardenings: flush `dbCache` in the fatal
process handlers before exit, and shrink the window after structural patches
(new/removed chats) by flushing those synchronously.

Cover with a kill-based compat test: patch (new chat stub + row), SIGKILL
before the timer, restart, and assert the chat is reachable.
