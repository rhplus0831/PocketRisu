# Global chat budget evicts newer bundles before older loose versions

- Status: Open
- Severity: Medium
- Lens: D5
- Area: Area 6 — server recovery
- Affected code: `server/node/chatBackups.cjs:893-949`, `server/node/chatBackups.test.ts:785-831`

## Risk

Global byte enforcement builds separate bundle and loose-version lists, sorts
each, and processes every bundle before any loose file. The lists are never
merged by age, so a newer 25-version bundle can be removed before one much older
loose version in another chat.

A small budget overage that one old loose file could satisfy instead destroys 25
newer recovery points. Per-chat newest protection prevents complete history loss
but does not make eviction globally oldest-first. Current coverage deletes both
candidates and never checks the harmful intermediate choice.

## Required fix and coverage

Build one globally ordered set of evictable units with an explicit bundle age
policy. If granularity matters, weigh versions preserved against bytes reclaimed
instead of unconditionally preferring bundles.

Test a cross-chat overage resolved by one older loose file and require the newer
bundle to remain.
