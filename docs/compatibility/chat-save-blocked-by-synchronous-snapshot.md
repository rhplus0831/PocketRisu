# Chat saves wait for a full recovery snapshot before acknowledgement

- Status: Confirmed regression
- Severity: High
- Confidence: High
- Introduced by: 9cb0086d

## Difference

serve's POST /api/chat-content writes the authoritative row, reads it back,
then awaits createBackupAndRotate() before sending success. lastBackupTime
starts null, so the first snapshot-eligible chat save after restart attempts a
full snapshot unless an earlier operation or pending recovery snapshot has
already established the time. A missing database also makes snapshot creation
return without assembly.

main acknowledged its monolithic path without this synchronous full-snapshot
barrier. serve's current full-database write route already responds first and
schedules snapshot work afterward.

## Compatibility impact

The request holds the serialized mutation queue. Combined with the client
15-second deadline, a large snapshot can make the UI report failure after the
chat row was durably committed. The tracked save stage retries from current
state rather than replaying proven-stale bytes, but acknowledgement remains
ambiguous and can cause unnecessary retry/history work. See
authoritative-storage-15-second-deadline.md.

## Recommendation

Publish the chat acknowledgement after row durability and schedule snapshot
creation outside the response-critical section, as the full-write path does.
Use the recovery snapshot test gate to prove the row can be committed while
the response remains blocked, then require the client-visible outcome to stay
unambiguous.
