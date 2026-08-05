# Acknowledged database patches are not durable for up to five seconds

- Status: Open
- Owner: client storage
- Source: [2026-07 data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: High
- Area: server persistence core
- Affected code: `server/node/server.cjs:139` (`SAVE_INTERVAL` = 5 s), `server/node/server.cjs:4475-4553` (patch applied to `dbCache`, persistence deferred, success returned), `server/node/server.cjs:753-804` (`persistDbCache` commits later), `server/node/logs.cjs:323-356` (uncaught-exception/unhandled-rejection handlers `process.exit(1)` without flushing), `src/ts/globalApi.svelte.ts:1043-1057` (client clears dirty tracking on ack)
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../../../.archived-docs/findings/2026-08-revalidation/README.md)
- Decision: 2026-08-05 — reopened from Deferred; implement via the staged/durable-ack protocol (see below)

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

The v1 remediation (`../../../../.archived-docs/v1/patch-deletes-chat-rows-before-stub-persistence.md`)
made deferred persistence safe against *deletions* but deliberately kept the
deferred timer; the ack-before-durable window itself was never addressed.

## Required fix and coverage

Decided 2026-08-05: implement the staged/durable-ack protocol. `/api/patch`
keeps its five-second server-side coalescing, but its acknowledgement means
"staged" only; the client retains its dirty tracking until a durable flush
confirmation instead of dropping it when the ack arrives. Existing
infrastructure to build on: `POST /api/db/flush` already returns an explicit
`durable: true/false` verdict behind a tracked WAL checkpoint, and callers
already have the committed-save outcome contract
(`requestImmediateSave().status === 'committed'`).

The commit-before-ack alternative was rejected for performance: patches arrive
roughly every 0.7–2 s during active use, so committing each one would lose the
coalescing window's write batching and stall the event loop with a synchronous
full-blob SQLite transaction per save.

The interim hardenings remain compatible with this design and can land as
cheap defense-in-depth: flush `dbCache` in the fatal process handlers before
exit, and flush structural patches (new/removed chats) synchronously so the
orphan sweep can never collect a just-created chat.

Cover with a client protocol test (dirty tracking survives a staged ack that
never receives a flush confirmation and is replayed) plus the kill-based
compat test: patch (new chat stub + row), SIGKILL before the timer, restart,
and assert the chat is reachable.
