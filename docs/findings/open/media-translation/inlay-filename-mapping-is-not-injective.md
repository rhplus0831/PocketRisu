# Inlay filename mapping is not injective

- Status: Open
- Owner: media and translation
- Source: [2026-07 data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium
- Lens: D4, D6
- Area: Area 7 — server file stores
- Affected code: `server/node/server.cjs:1111-1145`, `server/node/server.cjs:1198-1213`, `server/node/server.cjs:1257-1278`, `server/node/server.cjs:1305-1323`, `server/node/server.cjs:4074-4084`

## Risk

Inlay IDs may contain dots, while payloads map to `<id>.<ext>` and sidecars to
`<id>.meta.json`. Payload ID `x.meta` with extension `json` therefore aliases the
sidecar for ID `x`. When a sidecar is missing, resolution also takes the first
`startsWith(`${id}.`)` entry rather than requiring an exact parsed ID.

Writing explorer metadata or deleting `inlay_info/x` can overwrite or unlink the
unrelated `x.meta` JSON payload. A prefix fallback for `x` can likewise select
`x.y.png` or even a sidecar and destructive helpers unlink that ambiguous result.

## Required fix and coverage

Encode IDs injectively or restrict them to a canonical UUID grammar and reserve
the sidecar suffix. Reject collisions before writes; parse candidates and require
exact ID equality for lookup and deletion.

Test dotted IDs, reserved suffixes, missing sidecars, and deletion aliases.
