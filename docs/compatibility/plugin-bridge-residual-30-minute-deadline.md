# The plugin bridge still imposes a global 30-minute deadline

- Status: Confirmed residual incompatibility
- Severity: Medium
- Confidence: High
- Related fix: 832d69bd

## Difference

main's V3 guest request registry did not time out RPCs. serve applies
PLUGIN_BRIDGE_REQUEST_TIMEOUT_MS, currently 30 minutes, to every root and
instance request in src/ts/plugins/apiV3/factory.ts. Initialization uses the
same finite bound.

The change from 20 seconds to 30 minutes fixes common long-running calls, but it
does not restore the unbounded main contract.

## Compatibility impact

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

## Recommendation

Make deadlines method-specific and propagate cancellation into LLM/chat work.
If a hard maximum is required, document it as a public API contract and return
an outcome that distinguishes cancelled, timed out, and still-running host
work. Test cancellation rather than only timer expiry.
