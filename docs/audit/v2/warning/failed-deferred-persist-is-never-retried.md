# A failed deferred persist is never retried and the cache is silently reverted

- Status: Open
- Severity: Medium
- Area: server persistence core
- Affected code: `server/node/server.cjs:4526-4533` (persist failure recorded, timer removed, no retry), `server/node/server.cjs:394-404` (`flushPendingDb` flushes only while a timer exists), `server/node/server.cjs:3961-3984` + `server/node/server.cjs:609-614` (a later `/api/read` reloads the old durable state over the dirty cache), `server/node/server.cjs:225-257` (`persistWarning` surfaces only on a *later* patch)

## Risk

When the five-second deferred persist fails (transient I/O error, disk-full
moment), the error is recorded and the timer marker deleted; nothing retries.
The dirty `dbCache` still holds acknowledged state, but `flushPendingDb()`
checks only for a live timer, so graceful shutdown skips it, and the next
boot-time read replaces the cache with the old durable SQLite value —
acknowledged patches quietly revert without any crash. The client sees the
`persistWarning` only if it happens to patch again. This compounds
`../fatal/acknowledged-patches-are-not-durable.md`: there, loss needs a
crash; here, one failed transaction plus an ordinary restart suffices.

## Required fix and coverage

Track dirty cache state independently of timers, retry with bounded backoff,
flush dirty entries on read and shutdown, and surface an immediate
unsaved-state signal to clients. Fault-injection test: fail one persist,
restart gracefully, assert the acknowledged patch survives.
