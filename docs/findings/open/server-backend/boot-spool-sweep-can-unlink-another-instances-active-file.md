# Boot spool sweep can unlink another instance's active file

- Status: Open
- Owner: server backend
- Source: [2026-07 data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium
- Lens: D5, L3
- Area: Area 5 — server KV core and chat rows
- Affected code: `server/node/server.cjs:872-899`, `server/node/server.cjs:2500-2504`, `server/node/server.cjs:355-390`
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../../../.archived-docs/findings/2026-08-revalidation/README.md)

## Risk

Startup removes every regular file beginning `.database-risudat-` in the
configured spool directory. Generated names contain a PID and UUID, but the
sweep checks no owner, liveness, age, or lock; revalidation found it now also
unlinks additional unowned spool prefixes, slightly widening the exposure.
Shared spool volumes are plausible for the multi-instance hub roadmap.

Starting instance B can unlink instance A's active snapshot spool. On POSIX the
open writer continues into an unlinked inode, but A's later pathname-based ingest
cannot reopen it. Explicit operations fail loudly; automatic snapshot creation
catches the error and lets the primary write succeed without its recovery point.

## Required fix and coverage

Namespace spool roots per instance or publish a durable owner/lease and reap only
files proven abandoned. Avoid age-only policies for legitimately long spools.

Run two instances against one spool, restart one during the other's paused
snapshot, and require the active file and recovery copy to survive.
