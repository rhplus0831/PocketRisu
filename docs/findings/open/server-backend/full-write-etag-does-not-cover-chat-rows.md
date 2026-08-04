# The full-write ETag does not cover externalized chat rows

- Status: Open
- Owner: server backend
- Source: [2026-07 data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Low
- Area: server persistence core (compatibility path)
- Affected code: `server/node/dbCachedRead.cjs:66-72`, `server/node/server.cjs:154-156` (ETag = stub database only), `server/node/server.cjs:5524-5577` (`/api/chat-content` never changes `dbEtag`), `server/node/server.cjs:4311-4335` (compat full write commits payload chat rows without pre-image capture), `server/node/server.cjs:1690-1694` (headerless clients bypass the writer lock)
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../../../.archived-docs/findings/2026-08-revalidation/README.md)

## Risk

The database ETag hashes only the stub graph, so chat-row updates through
`/api/chat-content` leave it unchanged. A compatibility client (no session
header, full-payload writes — upstream-style callers the server deliberately
still accepts) holding a stale chat body can pass the `If-Match` check and
overwrite a newer row; this path also captures no pre-image, and the snapshot
cooldown can leave no other copy. Current PocketRisu clients send stubs plus
separate row writes and are not exposed; the risk is confined to
legacy/external callers.

## Required fix and coverage

Capture a pre-image for every row the compatibility branch overwrites, and
either fold referenced row versions into the concurrency token or require
per-row hashes when a full write carries chat payloads.
