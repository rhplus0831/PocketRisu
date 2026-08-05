# Acknowledged database patches are not durable for up to five seconds

- Status: Fixed (2026-08-05 remediation queue)
- Owner: client storage
- Source: [2026-07 data-loss audit](../../2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: High (at fix time)
- Resolution: `e526398e` — the staged/durable-ack protocol decided on
  2026-08-05, in three coordinated parts:
  - Server, structural commit-before-ack: `/api/patch` diffs the referenced
    chat-row key sets of the pre-patch cache and the patched snapshot; a
    patch that adds or removes chat rows persists inside the request via
    `persistDbCache()` before acknowledging and reports `durable: true`. The
    stub that makes a new chat row reachable is therefore durable before the
    acknowledgement, so a crash can no longer orphan a just-created chat into
    the grace-period sweep. Metadata-only patches keep the five-second
    coalescing timer and report `durable: false` (staged). A failed
    structural persist still acknowledges with `durable: false` plus the
    existing `persistWarning` surface.
  - Server, fatal-handler flush: `installProcessHandlers()` accepts
    `onFatalExit`; both `uncaughtException` and `unhandledRejection` now run
    a guarded synchronous emergency persist (`runEmergencyDbFlush()` in the
    new `server/node/dbCachePersistence.cjs`, extracted from
    `persistDbCacheGeneration()`) before `process.exit(1)`. Guards skip when
    an import is in progress, a SQLite transaction is owned, no pending work
    exists, the cache is empty/revision-stale/non-normalized, or the
    stub-flag-loss/duplicate-chat-id graph guards reject; the emergency path
    never deletes chat rows (pre-image capture is async), retaining them for
    the sweep instead.
  - Client, staged-ack retention: `PatchItemResult` carries `durable`; a
    staged ack no longer commits the dirty-revision ledger. The new
    `src/ts/storage/stagedAckTracker.ts` holds each staged proposal with
    commit/replay callbacks and confirms durability through
    `NodeStorage.flushDatabase()` (`POST /api/db/flush`) on an ETag
    watermark, debounced 6.5 s past the server's coalescing window with
    exponential retry. Durable full writes and `durable: true` patch acks
    confirm the whole buffer; transport failures retain it; repeated
    durable-but-unknown ETags, patch conflicts (before the rebase union),
    and writer displacement replay it into dirty tracking. The dirty-state
    probe counts staged entries, and `requestImmediateSave()` sets
    `requireDurable`, so `status === 'committed'` again proves durability
    while the pagehide path stays best-effort.
- Regression coverage: `test/compat/staged-patch-durability.test.ts` (the
  kill-based case from the report: new chat row + stub patch acknowledged
  `durable: true`, SIGKILL before the timer, restart, chat reachable; and the
  staged case: metadata patch `durable: false` is lost on SIGKILL but
  survives once `/api/db/flush` reports `durable: true`);
  `server/node/dbCachePersistence.test.ts` (emergency flush writes pending
  canonical bytes in one synchronous transaction, retains chat rows, and
  honors every skip guard in order);
  `src/ts/storage/stagedAckTracker.test.ts` (staged acks are held, the
  required "dirty tracking survives a staged ack without confirmation and is
  replayed" case, ETag watermark, backoff, displacement stop, `confirmNow`
  coalescing); `test/compat/database-write-atomicity.test.ts` (structural
  removal commits row deletion before acknowledgement; structural persist
  failure still acknowledges with `durable: false` and a `persistWarning`).
- Canonical architecture: [client storage](../../../../docs/structure/client-storage.md),
  [server backend](../../../../docs/structure/server-backend.md)

## Original risk (historical)

`/api/patch` applied the patch to the in-memory `dbCache`, scheduled
`persistDbCache()` five seconds later (re-armed by every subsequent patch),
and returned success immediately. The client treated the acknowledgement as
durable and dropped its tracked changes, so nothing was retried after a
crash.

A power loss or SIGKILL inside the window lost up to five seconds of
acknowledged metadata (character edits, presets, settings, stub-graph
changes) — unboundedly more during continuous editing. The installed
`uncaughtException`/`unhandledRejection` handlers called `process.exit(1)`
without flushing pending patches, converting any server-side bug into loss
of acknowledged writes. The sharpest sub-case: a newly created chat wrote
its row synchronously via `/api/chat-content`, but the stub that made it
reachable traveled in the deferred patch; a crash before the flush left the
row orphaned for the grace-period sweep.

The v1 remediation
(`../../v1/patch-deletes-chat-rows-before-stub-persistence.md`) made
deferred persistence safe against deletions but deliberately kept the
deferred timer; the ack-before-durable window itself was never addressed
until this fix. The commit-before-ack-for-everything alternative was
rejected for performance: patches arrive roughly every 0.7–2 s during active
use, so committing each one would lose the coalescing window's write
batching and stall the event loop with a synchronous full-blob SQLite
transaction per save.
