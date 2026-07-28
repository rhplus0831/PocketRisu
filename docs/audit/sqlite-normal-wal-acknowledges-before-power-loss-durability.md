# SQLite NORMAL WAL acknowledges writes before power-loss durability

- Status: Fixed
- Severity: High
- Lens: D2
- Area: Area 5 — server KV core and chat rows
- Extends: [Acknowledged database patches are not durable for up to five seconds](acknowledged-patches-are-not-durable.md)
- Affected code: `server/node/db.cjs:16-18`, `server/node/server.cjs:4324-4361`, `server/node/server.cjs:4369-4378`, `server/node/server.cjs:5566-5577`, `server/node/server.cjs:7386-7392`

## Risk

The authoritative SQLite connection uses WAL with `synchronous=NORMAL`. In this
mode, commits commonly reach the WAL without syncing it to stable storage; a
host crash or power loss can roll back committed transactions before a later
checkpoint. The write, chat, plugin-KV, and `/api/db/flush` response paths do not
checkpoint before reporting success.

This is below and broader than v2's in-memory patch debounce window. It affects
state that already committed to SQLite, including synchronous full writes and
chat rows that v2 otherwise treated as durable. A homeserver power loss before
the next checkpoint can therefore erase acknowledged messages or plugin data.

## Required fix and coverage

Use `synchronous=FULL` for the authoritative database or provide a durable-commit
mode that every durable acknowledgement and `/api/db/flush` awaits. If NORMAL
remains an operator option, clearly label its power-loss tradeoff.

Add host-crash/power-loss durability coverage for full writes, chat rows,
plugin KV, and explicit flush, not merely application-process termination.

## Resolution (2026-07-28)

The authoritative connection now opens with WAL plus `synchronous=FULL`, so
missing, invalid, and legacy configuration fails safe. Self-hosted operators may
explicitly choose `balanced` (`NORMAL` plus a verified one-minute `FULL`
checkpoint) or `performance` (`NORMAL` plus a five-minute checkpoint) from the
System dashboard; both choices show a concrete power-loss warning. Hub operators
can lock the same policy through `POCKETRISU_SQLITE_DURABILITY_MODE`, and hub
tenants cannot override it.

`POST /api/db/flush` now runs a `FULL` checkpoint and reports success only when
SQLite reports a complete, non-busy result. Scheduled checkpoints are serialized
with storage mutations, inspect the SQLite busy result, and retry after incomplete
attempts. Destructive import paths restore the selected synchronous mode rather
than hard-coding `NORMAL`.

Coverage in `test/compat/sqlite-durability.test.ts` verifies the `FULL` default,
the explicit durable-flush boundary, persistence across restart, mode restoration
after a real backup import, and hub administrator enforcement. The existing
database/chat/plugin atomicity suites continue to exercise the commit paths now
running under the durable default.
