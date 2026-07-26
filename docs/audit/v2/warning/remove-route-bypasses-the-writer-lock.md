# /api/remove bypasses the single-writer session check

- Status: Open
- Severity: Medium
- Area: server persistence core
- Affected code: `server/node/server.cjs:4058-4096` (`/api/remove` checks auth only), `server/node/server.cjs:1690-1697` (`checkActiveSession` exists), `server/node/server.cjs:4200-4205` (`/api/write` enforces it)

## Risk

Writes from a displaced tab are fenced with 423, but deletions are not:
`/api/remove` (inlays, assets, arbitrary KV keys including `pluginsave/` and
`drafts/`) never calls `checkActiveSession`. A stale tab therefore keeps
deleting successfully after losing the writer lease — it also never receives
the 423 that would tell it it has been displaced — so it can remove values a newer
session wrote (plugin storage updated on another device, drafts, gallery
deletions based on a stale view). The single-writer model's protection is
one-sided.

## Required fix and coverage

Apply `checkActiveSession` to `/api/remove` and every other destructive
route. For value stores where stale deletion matters (plugin keys), consider
a conditional delete (expected content hash). Test: displaced session's
remove must return 423.
