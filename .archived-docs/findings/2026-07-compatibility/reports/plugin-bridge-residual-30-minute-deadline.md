# The plugin bridge still imposed a global 30-minute deadline

- Status: Fixed 2026-07-31
- Severity: Medium
- Confidence: High
- Related fix: 832d69bd

## Original difference

main's V3 guest request registry did not time out RPCs. serve applies
PLUGIN_BRIDGE_REQUEST_TIMEOUT_MS, currently 30 minutes, to every root and
instance request in src/ts/plugins/apiV3/factory.ts. Initialization uses the
same finite bound.

The change from 20 seconds to 30 minutes fixes common long-running calls, but it
does not restore the unbounded main contract.

## Original compatibility impact

A legitimate runLLMModel(), sendChat(), pluginStorage.updateItem(), or other
single RPC lasting more than 30 minutes rejects in the guest. CANCEL_REQUEST
injects an AbortSignal into root methods only through ABORTABLE_ROOT_METHODS;
remote instance methods can opt in through __requestAbortMethods. runLLMModel
and sendChat are not abortable root methods, so their host-side work can
continue after the plugin sees a timeout, causing cost, duplicate retry, or
chat-lock side effects.

The bridge and pluginStorage.updateItem() also use the same 30-minute limit.
Their equal-deadline race lets the outer bridge error hide the inner structured
storage timeout and outcome.

## Implemented recommendation

Make deadlines method-specific and propagate cancellation into LLM/chat work.
If a hard maximum is required, document it as a public API contract and return
an outcome that distinguishes cancelled, timed out, and still-running host
work. Test cancellation rather than only timer expiry.

## Resolution

The V3 guest registry no longer assigns an elapsed-time deadline to root or
remote-instance requests, and sandbox initialization no longer terminates at
30 minutes. Requests remain pending until the host responds or their owning
guest lifecycle ends, restoring main's availability contract without reverting
the newer generation-unique IDs, structured errors, or stale-response guards.

Lifecycle cancellation now reaches the expensive paths that motivated the old
deadline. Guest `pagehide` cancels its pending registry, host termination aborts
all active request controllers, and `runLLMModel()` plus `sendChat()` receive
and propagate those signals into the existing model/chat request pipeline.
`pluginStorage.updateItem()` is also unbounded by default; callers may still
choose an explicit method-specific `timeoutMs`, whose coordinator preserves the
known-not-committed versus commit-outcome-unknown boundary.

Regression coverage uses an independent 30-minute boundary rather than a
production constant. It verifies late root/instance success, late structured
storage failure, slow initialization, page-disappearance cancellation,
model/chat signal injection, child-chat generation cleanup, and unbounded
default storage transforms.
