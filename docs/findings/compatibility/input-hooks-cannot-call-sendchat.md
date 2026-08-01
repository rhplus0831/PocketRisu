# Input hooks can no longer call the V3 sendChat API

- Status: Fixed 2026-07-30
- Severity: Medium
- Confidence: High
- Introduced by: 3328bc79

## Original difference

main ran V3 editinput handlers before marking chat generation active, allowing
a sequential nested send before the outer send. serve sets doingChat before
those handlers to bind generation to the origin chat and intentionally prevent
reentrancy. V3 sendChat() rejects whenever doingChat is true.

## Original compatibility impact

After sendChat permission is granted, an input hook that starts a preliminary,
delegated, or synthetic turn throws A chat is already in progress on every
invocation. Permission denial returns false before this check. The script
pipeline does not isolate the rejection, so it can abort the user's outer send
as well. The public API does not document the new hook-context restriction.

## Implemented recommendation

Separate the origin/navigation transaction lock from the generation-in-progress
state, or add a supported deferred-send API. If nested sends must remain
forbidden, document the migration and isolate the hook error. Add an
integration test in which an input handler calls sendChat().

## Resolution

The composer now owns a separate target-bound send transaction while input
triggers and `editinput` handlers run. `doingChat` represents actual model
generation again, so an awaited V3 input handler can run a sequential child
turn without releasing the UI/navigation guard. Both the child and outer turn
resolve the transaction's durable character/chat IDs.

Child-turn authority is scoped to the V3 plugin whose input callback is
currently awaited. Unrelated API calls remain blocked during the transaction,
and calls made during active model generation still reject to prevent recursive
provider/output sends. A rejected input handler is isolated so later handlers
and the user's outer send continue from the last valid transformed input.

Regression coverage exercises child-before-outer ordering, trigger-result
publication, durable target binding, unrelated-call rejection, active-generation
rejection, transaction cleanup, and input-handler error isolation in
`src/ts/plugins/apiV3/pluginChatSend.test.ts`,
`src/ts/process/chatSendState.test.ts`,
`src/ts/process/chatSendTarget.test.ts`, and
`src/ts/process/pluginEditHandlers.test.ts`.
