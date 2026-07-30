# loadPlugins() no longer means reload completion

- Status: Fixed 2026-07-30
- Severity: Medium
- Confidence: High
- Introduced by: 2268a66a

## Original difference

main exposed the actual loadPlugins promise to V2 and V3 callers. serve exposes
requestDeferredPluginApiReload() from src/ts/plugins/plugins.svelte.ts. It
coalesces and schedules deferred demand outside teardown, then immediately
returns a resolved Promise. During teardown it resolves without scheduling and
relies on the active reload's post-unload plugin-list read.

Reload failures are retried internally and then logged/notified; they are not
propagated to the caller. The public declaration still describes a Promise
that reloads all plugins.

## Original compatibility impact

main did not await completion of a V3 plugin's top-level body, but it did await
teardown and host/reload-generation setup. On serve, after await
Risuai.loadPlugins(), even the deferred reload may not have started and unload
callbacks may not have run. try/catch cannot observe lifecycle failure.
Existing synchronization patterns therefore race even though they type-check.

## Implemented recommendation

Split fire-and-forget requestReload() from waitForReload(), or return a shared
drain result when called outside a lifecycle phase. Keep acknowledgement-only
semantics only where awaiting the queued generation would deadlock. Test
readiness and error propagation.

## Resolution

The plugin-facing `loadPlugins()` now returns the shared deferred drain promise
when invoked outside active lifecycle work. The promise settles only after the
serialized teardown/load generation completes, coalesced callers observe the
same promise, and a lifecycle failure is propagated after the bounded retry.

Calls made from teardown or loading callbacks remain acknowledgement-only.
Teardown already re-reads the live plugin list before loading, while a loading
callback retains demand for a follow-up generation; waiting for either queued
generation from inside the active callback would deadlock its lifecycle lock.

Regression coverage verifies outside-call completion and coalescing, failure
propagation, and deadlock-free calls from both teardown and loading callbacks.
