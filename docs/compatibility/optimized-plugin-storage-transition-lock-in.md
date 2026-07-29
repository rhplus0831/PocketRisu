# Optimized plugin storage can exceed its reverse-transition limits

- Status: Confirmed capacity lock-in
- Severity: Medium
- Confidence: High

## Difference

By default, optimized storage accepts 128 MiB per value and 1 GiB total value
rows; both server limits are environment-configurable. Turning optimization off
stages rows with a 32 MiB per-row limit and a 64 MiB aggregate internalization
limit. Current real-server tests admit and stage exactly 64 MiB before aborting
the test transition, while 65 MiB is rejected at transition begin.

main had only inline storage, so no state could become valid yet unable to
return to that representation.

## Compatibility impact

An existing main-compatible inline row over 32 MiB cannot enable optimization.
After enabling, a user can legally store one value over 32 MiB or several
values over 64 MiB, then find that the UI toggle cannot be turned off. V2/V2.1
plugins remain disabled while optimized mode is active. Both transition
failures occur before publication, so this is migration blockage/lock-in rather
than immediate data loss.

## Recommendation

Make internalization stream safely up to the accepted quota, constrain
optimized writes to a reversible ceiling, or clearly warn before crossing a
threshold that prevents disabling optimization until storage is reduced. Test
both directions at every advertised limit.
