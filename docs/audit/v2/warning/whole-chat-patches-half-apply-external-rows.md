# Payload-bearing whole-chat patches can half-apply external rows

- Status: Open
- Severity: Low
- Area: server persistence core (compatibility path)
- Affected code: `server/node/server.cjs:656-658` (whole-chat ops allowed through the guard), `server/node/server.cjs:4475-4493` (plugin/chat externalization runs before the cache commit), `server/node/server.cjs:2447-2466` (plugin externalization commits its own transaction), `server/node/chatRows.cjs:162-199`, `server/node/chatRows.cjs:256-262` (sequential independent row writes)

## Risk

A single `/api/patch` carrying several whole-chat replacements (a
compatibility shape; the official client sends stubs and separate row
writes) externalizes plugin storage and chat payloads as independent
transactions before the stub cache is assigned. A failure partway returns
500, but earlier rows are already committed: the durable stub graph now
resolves to a mixture of old and new rows, and the overwritten old rows were
not captured as pre-images (only `/api/chat-content` captures). The v1 outer
transaction covers `/api/write`, not this path.

## Required fix and coverage

Reject payload-bearing whole-chat patch operations (require
`/api/chat-content`), or stage all external rows and commit them with the
stub database in one synchronous transaction, mirroring the full-write fix.
