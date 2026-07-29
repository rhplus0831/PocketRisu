# Input hooks can no longer call the V3 sendChat API

- Status: Confirmed behavioral break
- Severity: Medium
- Confidence: High
- Introduced by: 3328bc79

## Difference

main ran V3 editinput handlers before marking chat generation active, allowing
a sequential nested send before the outer send. serve sets doingChat before
those handlers to bind generation to the origin chat and intentionally prevent
reentrancy. V3 sendChat() rejects whenever doingChat is true.

## Compatibility impact

After sendChat permission is granted, an input hook that starts a preliminary,
delegated, or synthetic turn throws A chat is already in progress on every
invocation. Permission denial returns false before this check. The script
pipeline does not isolate the rejection, so it can abort the user's outer send
as well. The public API does not document the new hook-context restriction.

## Recommendation

Separate the origin/navigation transaction lock from the generation-in-progress
state, or add a supported deferred-send API. If nested sends must remain
forbidden, document the migration and isolate the hook error. Add an
integration test in which an input handler calls sendChat().
