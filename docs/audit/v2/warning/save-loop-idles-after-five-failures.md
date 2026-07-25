# The save loop stops retrying after five consecutive failures

- Status: Open
- Severity: Medium
- Area: client save loop
- Affected code: `src/ts/globalApi.svelte.ts:1058-1069` (fifth failure alerts and resets the counter without setting `changed`), `src/ts/globalApi.svelte.ts:1093-1110` (permanent loop idles while `changed` is false)

## Risk

Each failed save requeues the tracked changes, and attempts one through four
schedule another cycle. The fifth failure shows an error and resets
`savetrys` — but does not set `changed`, so the loop goes idle with dirty
data still queued. Nothing (no online/offline listener, no slow retry)
restarts it; only a *new* edit does. A user who sees the error, waits for the
network to return, and closes the tab loses the queued changes despite the
server being reachable again.

## Required fix and coverage

Keep retrying at a slower capped interval (or set `changed = true` on an
`online` event and on a timer while the tracker is non-empty). Test: fail five
saves, restore connectivity, assert the queued state persists without further
user input.
