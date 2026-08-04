# Optimized plugin storage can exceed its reverse-transition limits

- Status: Fixed 2026-07-30
- Severity: Medium
- Confidence: High

## Difference

Before the fix, optimized storage accepted 128 MiB per value and 1 GiB total
value rows by default; both server limits were environment-configurable. Turning
optimization off staged rows with a 32 MiB per-row limit and a 64 MiB aggregate
internalization limit. The original real-server test admitted and staged exactly
64 MiB before aborting the test transition, while 65 MiB was rejected at
transition begin.

main had only inline storage, so no state could become valid yet unable to
return to that representation.

## Compatibility impact

An existing main-compatible inline row over 32 MiB could not enable optimization.
After enabling, a user could legally store one value over 32 MiB or several
values over 64 MiB, then find that the UI toggle could not be turned off. V2/V2.1
plugins remained disabled while optimized mode was active. Both transition
failures occurred before publication, so this was migration blockage/lock-in
rather than immediate data loss.

## Resolution

The reverse transition now accepts the server's configured optimized-value
ceiling and no longer rejects the publication at 64 MiB aggregate. SQLite and
chunked values are copied into the private transition stage in bounded pages,
stage downloads are streamed, and final RisuSave assembly converts each staged
JSON file directly to MessagePack without reading the complete row into a
server buffer. The existing entry-count and disk-headroom preflights remain,
and optimized publication quotas are still enforced atomically.

Inline mode necessarily retains the completed plugin map in browser memory.
The settings flow therefore asks for explicit confirmation when the exact
preflight exceeds the former 32 MiB single-row or 64 MiB aggregate thresholds.
Cancelling occurs before stage creation or publication, and the optimized copy
remains authoritative until the final commit.

Real-server coverage now fully internalizes a 40 MiB row in a 65 MiB optimized
publication, and the opt-in extreme memory test exercises the reverse direction
instead of stopping after externalization.
