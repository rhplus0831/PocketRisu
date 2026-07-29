# Chat saves wait for a full recovery snapshot before acknowledgement

- Status: Fixed 2026-07-30
- Severity: High
- Confidence: High
- Introduced by: 9cb0086d

## Original difference

serve's POST /api/chat-content wrote the authoritative row, read it back, then
awaited createBackupAndRotate() before sending success. lastBackupTime started
null, so the first snapshot-eligible chat save after restart attempted a full
snapshot unless an earlier operation or pending recovery snapshot had already
established the time. A missing database also made snapshot creation return
without assembly.

main acknowledged its monolithic path without this synchronous full-snapshot
barrier. serve's current full-database write route already responds first and
schedules snapshot work afterward.

## Original compatibility impact

The request held the serialized mutation queue. Combined with the client
15-second deadline, a large snapshot could make the UI report failure after the
chat row was durably committed. The tracked save stage retried from current
state rather than replaying proven-stale bytes, but acknowledgement remained
ambiguous and could cause unnecessary retry/history work. See
authoritative-storage-15-second-deadline.md.

## Implemented recommendation

Publish the chat acknowledgement after row durability and schedule snapshot
creation outside the response-critical section, as the full-write path does.
Use the recovery snapshot test gate to hold publication after the row commits,
then require the client-visible acknowledgement to complete while snapshot
work remains blocked.

## Resolution

The chat-content route now sends its success acknowledgement immediately after
the authoritative row has been written and verified, then schedules the
coalesced automatic snapshot outside the response-critical mutation. Snapshot
assembly remains serialized through the storage queue, but it can no longer
delay or make the completed chat-row write ambiguous to the browser.

Compatibility coverage holds snapshot publication after assembly and verifies
that the chat save has already returned a successful response with its stored
content hash. It then releases publication and confirms the snapshot completes.
