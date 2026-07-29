# loadPlugins() no longer means reload completion

- Status: Confirmed regression
- Severity: Medium
- Confidence: High
- Introduced by: 2268a66a

## Difference

main exposed the actual loadPlugins promise to V2 and V3 callers. serve exposes
requestDeferredPluginApiReload() from src/ts/plugins/plugins.svelte.ts. It
coalesces and schedules deferred demand outside teardown, then immediately
returns a resolved Promise. During teardown it resolves without scheduling and
relies on the active reload's post-unload plugin-list read.

Reload failures are retried internally and then logged/notified; they are not
propagated to the caller. The public declaration still describes a Promise
that reloads all plugins.

## Compatibility impact

main did not await completion of a V3 plugin's top-level body, but it did await
teardown and host/reload-generation setup. On serve, after await
Risuai.loadPlugins(), even the deferred reload may not have started and unload
callbacks may not have run. try/catch cannot observe lifecycle failure.
Existing synchronization patterns therefore race even though they type-check.

## Recommendation

Split fire-and-forget requestReload() from waitForReload(), or return a shared
drain result when called outside a lifecycle phase. Keep acknowledgement-only
semantics only where awaiting the queued generation would deadlock. Test
readiness and error propagation.
