# Backup exports can capture torn inlays when a concurrent replacement has equal lengths

- Status: Open
- Severity: Low
- Area: server recovery (export consistency)
- Affected code: `server/node/server.cjs:4788-4807`, `server/node/server.cjs:5061-5075` (size-only revalidation while streaming), `server/node/server.cjs:1281-1291` (inlay payload and sidecar are separate mutable writes)

## Risk

Exports pin a KV snapshot but read filesystem inlays outside the storage
queue, revalidating only that each file still has its planned length. Inlay
IDs are stable (not content-addressed), so a concurrent `/api/write` that
replaces payload and sidecar between the two reads produces an archive mixing
old payload with new metadata — undetected when lengths happen to match. The
v1 fix (`../../../../.archived-docs/v1/concurrent-plugin-write-can-corrupt-export.md`) added
the exact-size check; equal-length replacements remain a hole. Requires a
concurrent write with matching sizes during an export, hence Low.

## Required fix and coverage

Stage inlay files under the storage queue into an immutable spool before
streaming, or record a hash/generation before the read and recheck it after
both payload and sidecar are read.
