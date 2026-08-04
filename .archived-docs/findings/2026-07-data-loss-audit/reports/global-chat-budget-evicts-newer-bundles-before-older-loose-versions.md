# Global chat budget evicts newer bundles before older loose versions

- Status: Fixed 2026-07-31
- Severity: Medium
- Lens: D5
- Area: Area 6 — server recovery
- Affected code: `server/node/chatBackups.cjs` (`enforceGlobalBudget()`), `server/node/chatBackups.test.ts` (chat-backup reconciliation coverage)

## Resolution

Fixed 2026-07-31. Global byte enforcement now builds one ordered collection of
evictable units across every chat instead of processing bundles and loose files
in separate phases. A solid bundle remains indivisible and is aged by its
newest member; equal-age units prefer the one that discards fewer recovery
versions. Any unit containing its chat's newest version remains protected.

Coverage creates a newer three-version bundle in one chat and an older loose
version in another, then sets the byte cap so deleting exactly that loose file
resolves the overage. It requires the server to remove one item and retain every
version in the newer bundle.

## Risk (historical)

Previous global byte enforcement built separate bundle and loose-version lists, sorted
each, and processed every bundle before any loose file. The lists were never
merged by age, so a newer 25-version bundle can be removed before one much older
loose version in another chat.

A small budget overage that one old loose file could satisfy instead destroys 25
newer recovery points. Per-chat newest protection prevents complete history loss
but does not make eviction globally oldest-first. Prior coverage deleted both
candidates and never checks the harmful intermediate choice.

## Required fix and coverage (completed)

Build one globally ordered set of evictable units with an explicit bundle age
policy. If granularity matters, weigh versions preserved against bytes reclaimed
instead of unconditionally preferring bundles.

Test a cross-chat overage resolved by one older loose file and require the newer
bundle to remain.
