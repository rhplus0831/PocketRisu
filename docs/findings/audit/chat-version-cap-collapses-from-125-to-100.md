# The chat-version cap collapses from 125 to 100

- Status: Fixed 2026-07-31
- Severity: Medium
- Lens: D5
- Area: Area 6 — server recovery
- Affected code: `server/node/chatBackups.cjs` (`bundleLooseVersions()`, `enforceChatVersionLimit()`), `server/node/chatBackups.test.ts` (chat-backup reconciliation coverage)

## Resolution

Fixed 2026-07-31. Per-chat retention now enforces a logical version limit
directly. The default remains four solid 25-version bundles plus one active
25-version loose batch, for exactly 125 versions. Bundling stops when all four
solid-bundle slots are occupied rather than creating and immediately deleting
a fifth bundle.

When capture 126 exceeds the logical cap, reconciliation removes only the
oldest version. If that version belongs to a solid bundle, every retained entry
is first published durably as a loose gzip. Only then is the old bundle
withdrawn and rebuilt without the removed version, preserving recovery data
across interrupted reconciliation.

Coverage requires all 125 boundary versions to remain byte-exactly readable,
then requires capture 126 to remove only version 1. A smaller configurable
scenario exercises partial-bundle rewriting, complete retirement of the
trimmed bundle, slot reuse, and idempotent reconciliation. An injected metadata
withdrawal failure requires every version to remain readable before a later
reconciliation successfully enforces the cap.

## Risk (historical)

Versions bundle in groups of 25 while the per-chat bundle limit is four. At the
125th version, reconciliation creates a fifth bundle and immediately deletes the
entire oldest bundle, leaving 100. Between rotations the actual maximum is 124,
not the intended 125.

The previous regression test explicitly expected 125 captures to retain only
100, so it codified the premature loss. A user below the byte cap lost the
oldest 20% of the advertised recovery depth at once, before exceeding the
version limit.

## Required fix and coverage (completed)

Enforce the version count directly. Retain five 25-version bundles or an
equivalent loose batch through capture 125, then evict only what exceeds the cap.

Require exactly 125 restorable versions at the boundary and only the single
oldest version to disappear after capture 126.
