# Non-canonical hex path headers split the patch cache

- Status: Open
- Severity: Low
- Area: server persistence core
- Affected code: `server/node/server.cjs:220` (canonical lowercase cache key), `server/node/server.cjs:1028`, `server/node/server.cjs:1722-1724` (case-insensitive hex accepted, not canonicalized), `server/node/server.cjs:4410-4423`, `server/node/server.cjs:4493-4543` (`dbCache`/`saveTimers` keyed by the raw header; persistence keyed by the decoded key)

## Risk

`dbCache` and `saveTimers` are keyed by the raw `file-path` hex header while
persistence targets the decoded key. Upper- and lowercase spellings of the
same key therefore maintain independent caches and timers over one SQLite
row: interleaved patches through both spellings each validate against their
own baseline and the later flush overwrites the earlier acknowledged edit.
The official client always sends lowercase, so this requires an alternate or
future compatibility caller — but the flush/invalidation paths also only know
the canonical spelling (`server/node/server.cjs:394-414`), so a mixed-case
caller additionally dodges `flushPendingDb`.

## Required fix and coverage

Canonicalize (or reject) non-lowercase hex at validation, and key every
cache/timer by the decoded logical key.
