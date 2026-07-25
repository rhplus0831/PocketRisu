# The chat-version cap collapses from 125 to 100

- Status: Open
- Severity: Medium
- Lens: D5
- Area: Area 6 — server recovery
- Affected code: `server/node/chatBackups.cjs:25-27`, `server/node/chatBackups.cjs:784-798`, `server/node/chatBackups.cjs:863-879`, `server/node/chatBackups.test.ts:752-783`

## Risk

Versions bundle in groups of 25 while the per-chat bundle limit is four. At the
125th version, reconciliation creates a fifth bundle and immediately deletes the
entire oldest bundle, leaving 100. Between rotations the actual maximum is 124,
not the intended 125.

The existing regression test explicitly expects 125 captures to retain only 100,
so it codifies the premature loss. A user below the byte cap loses the oldest 20%
of the advertised recovery depth at once, before exceeding the version limit.

## Required fix and coverage

Enforce the version count directly. Retain five 25-version bundles or an
equivalent loose batch through capture 125, then evict only what exceeds the cap.

Require exactly 125 restorable versions at the boundary and only the single
oldest version to disappear after capture 126.
