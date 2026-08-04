# Non-canonical hex path headers split the patch cache

- Status: Fixed (2026-08-05 revalidation)
- Owner: server backend
- Source: [2026-07 data-loss audit](../../2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Low (at fix time)
- Resolution: `e23b744c` — canonicalize server storage key identity: every
  `file-path` consumer routes through `decodeAndCanonicalizeHexPath` before
  cache or timer access, so mixed-case spellings share one cache, timer, and
  flush identity.
- Regression coverage: `test/compat/database-write-atomicity.test.ts`
  (real-server cases at the canonicalization boundary, added by the fix
  commit).
- Canonical architecture: [server backend](../../../../docs/structure/server-backend.md)
- Area: server persistence core

## Original risk (historical)

`dbCache` and `saveTimers` are keyed by the raw `file-path` hex header while
persistence targets the decoded key. Upper- and lowercase spellings of the
same key therefore maintain independent caches and timers over one SQLite
row: interleaved patches through both spellings each validate against their
own baseline and the later flush overwrites the earlier acknowledged edit.
The official client always sends lowercase, so this requires an alternate or
future compatibility caller — but the flush/invalidation paths also only know
the canonical spelling, so a mixed-case caller additionally dodges
`flushPendingDb`.

## Original required fix (historical)

Canonicalize (or reject) non-lowercase hex at validation, and key every
cache/timer by the decoded logical key.
