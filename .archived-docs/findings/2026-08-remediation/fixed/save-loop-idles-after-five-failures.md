# The save loop stops retrying after five consecutive failures

- Status: Fixed (2026-08-05 remediation queue)
- Owner: client storage
- Source: [2026-07 data-loss audit](../../2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium (at fix time)
- Resolution: `5e329fb6` — retry pacing extracted into
  `src/ts/storage/saveRetryScheduler.ts` and wired into `saveDb()`:
  - Failures one through four keep the existing quick linear backoff
    (500 ms per attempt, capped at 3 s) inside the save coordinator, with
    `changed` re-armed after each sleep.
  - The fifth consecutive failure enters slow mode instead of idling: the
    blocking `alertError` fires once per outage streak, and every further
    failure arms a `SLOW_SAVE_RETRY_INTERVAL_MS` (10 s) retry deadline. A
    one-shot watchdog in the permanent loop's idle branch re-arms
    `changed` when the deadline passes, gated on remaining dirty state
    (tracked targets or dirty ledger revisions — a save triggered by
    dirty revisions alone can fail with an empty tracker) and on
    `!gotChannel`, so a displaced writer never auto-replays stale state.
  - A `window` `online` listener expedites an armed slow deadline
    immediately when connectivity returns instead of waiting out the
    interval.
  - A successful save resets the streak and the alert flag, so a later
    outage alerts again; the conflict-path backoff keeps its capped
    `500 ms × (attempts + 1)` formula through `conflictBackoffMs()`.
- Regression coverage: `src/ts/storage/saveRetryScheduler.test.ts` — the
  quick delay progression, alert-once-per-streak, one-shot deadline wake
  and re-arm, success reset, online-expedite semantics, the conflict
  backoff cap, and the finding's end-to-end scenario (five failures,
  deadline wake, failed slow retry re-arming, recovery without further
  user input).
- Canonical architecture: [client storage](../../../../docs/structure/client-storage.md)

## Original risk (historical)

Each failed save requeued the tracked changes, and attempts one through
four scheduled another cycle. The fifth failure showed an error and reset
`savetrys` — but did not set `changed`, so the loop went idle with dirty
data still queued. Nothing (no online/offline listener, no slow retry)
restarted it; only a *new* edit did. A user who saw the error, waited for
the network to return, and closed the tab lost the queued changes despite
the server being reachable again.
