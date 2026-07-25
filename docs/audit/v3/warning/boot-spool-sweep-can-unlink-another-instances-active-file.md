# Boot spool sweep can unlink another instance's active file

- Status: Open
- Severity: Medium
- Lens: D5, L3
- Area: Area 5 — server KV core and chat rows
- Affected code: `server/node/server.cjs:872-899`, `server/node/server.cjs:2500-2504`, `server/node/server.cjs:355-390`

## Risk

Startup removes every regular file beginning `.database-risudat-` in the
configured spool directory. Generated names contain a PID and UUID, but the
sweep checks no owner, liveness, age, or lock. Shared spool volumes are plausible
for the multi-instance hub roadmap.

Starting instance B can unlink instance A's active snapshot spool. On POSIX the
open writer continues into an unlinked inode, but A's later pathname-based ingest
cannot reopen it. Explicit operations fail loudly; automatic snapshot creation
catches the error and lets the primary write succeed without its recovery point.

## Required fix and coverage

Namespace spool roots per instance or publish a durable owner/lease and reap only
files proven abandoned. Avoid age-only policies for legitimately long spools.

Run two instances against one spool, restart one during the other's paused
snapshot, and require the active file and recovery copy to survive.
