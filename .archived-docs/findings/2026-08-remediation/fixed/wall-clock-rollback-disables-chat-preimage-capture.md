# Wall-clock rollback disables chat pre-image capture

- Status: Fixed (2026-08-06 remediation queue)
- Owner: backup and recovery
- Source: [2026-07 data-loss audit](../../2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium (at fix time)
- Lens: L4
- Area: Area 6 — server recovery
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../2026-08-revalidation/README.md)
- Resolution: `c537c131` — ordinary chat pre-image capture now applies its
  cooldown only when the elapsed wall-clock time is non-negative and below the
  configured interval. A negative delta permits a recovery capture, and a
  successful publication replaces the in-process baseline with the current
  wall-clock timestamp. Forced and required capture behavior, best-effort
  ordinary capture, atomic publication, row-size validation, retention, and
  recovery formats are unchanged.
- Regression coverage: `server/node/chatBackups.test.ts` exercises a backward
  adjustment in an existing store and a restart seeded by a future-dated disk
  version. It proves byte-exact old and new recovery points, immediate and
  cooldown-minus-one skips from the reset baseline, and capture at the exact
  expiry boundary. Existing coverage retains forced deletion, ordinary restart,
  publication, retention, and recovery-format contracts.
- Canonical architecture: [backup and recovery](../../../../docs/structure/backup-recovery.md)

## Original risk (historical)

Cooldown state was seeded from the largest wall-clock timestamp on disk. Capture
skipped whenever `currentTime - newest < cooldownMs`; a negative delta also passed
that test. A future-dated filename therefore suppressed all capture until real
time caught up, and the state persisted across restarts.

After a bad RTC or large NTP correction, normal chat saves continued overwriting
the authoritative row while the UI retained only an old future-dated recovery
point. The history could remain frozen for hours, days, or years without an error.

## Original required fix and coverage (historical)

Apply cooldown only when `0 <= delta < cooldownMs`. Treat negative delta as a
clock discontinuity that permits capture and resets the baseline; use a monotonic
clock for in-process cooldown where practical.

Test capture, restart, backward adjustment, and subsequent recovery history.
