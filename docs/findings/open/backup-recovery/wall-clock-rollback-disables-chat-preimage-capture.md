# Wall-clock rollback disables chat pre-image capture

- Status: Open
- Owner: backup and recovery
- Source: [2026-07 data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium
- Lens: L4
- Area: Area 6 — server recovery
- Affected code: `server/node/chatBackups.cjs:540-568`, `server/node/chatBackups.cjs:583-625`, `server/node/chatBackups.test.ts:441-492`

## Risk

Cooldown state is seeded from the largest wall-clock timestamp on disk. Capture
skips whenever `currentTime - newest < cooldownMs`; a negative delta also passes
that test. A future-dated filename therefore suppresses all capture until real
time catches up, and the state persists across restarts.

After a bad RTC or large NTP correction, normal chat saves continue overwriting
the authoritative row while the UI retains only an old future-dated recovery
point. The history can remain frozen for hours, days, or years without an error.

## Required fix and coverage

Apply cooldown only when `0 <= delta < cooldownMs`. Treat negative delta as a
clock discontinuity that permits capture and resets the baseline; use a monotonic
clock for in-process cooldown where practical.

Test capture, restart, backward adjustment, and subsequent recovery history.
