# Legacy onUnload mode exposes only a subset of the former API

- Status: Fixed 2026-07-30
- Severity: Medium
- Confidence: High
- Introduced by: 99253152
- Partially mitigated by: d7be6c8d
- Reverified: 2026-07-30 after the targeted legacy-plugin unload inventory

## Original difference

main invoked V3 unload callbacks while the complete RPC surface remained
available, then removed the iframe after a short grace period. serve enters
compatibilityDraining before callbacks and admits only
LEGACY_UNLOAD_ROOT_METHODS and LEGACY_UNLOAD_INSTANCE_METHODS from
src/ts/plugins/apiV3/factory.ts. The compatibility surface now includes
bidirectionally authorized plugin IPC plus argument-restricted DOM cleanup:
empty HTML clearing, empty `x-*` markers, and replacement with an existing
remote element. Admitted cleanup operations drain within the remaining unload
grace period, including calls the guest did not await.

Legacy compatibility is enabled by default. It originally extended the grace
period and enabled the cleanup allowlists, but did not restore the remaining
database, network, asset, and global UI finalization surface.

## Original compatibility impact

Fast cleanup calls that formerly worked now reject immediately, including
setDatabase(), setDatabaseLite(), setArgument(), setCharacter(), chat setters,
setChatPanel(null), theme restoration, nativeFetch/risuFetch, runLLMModel,
sendChat, and saveAsset. Compatibility mode does allow plugin-storage flushes,
authorized IPC, unregisterUIPart, hideContainer, destructive DOM cleanup, and
several unregister calls. The UI gap concerns broader mutations outside that
surface, such as setChatPanel(null) and theme restoration. Plugins can still
fail to flush database-backed state or finalize global UI during disable,
removal, or reload.

serve automatically removes lifecycle-owned hooks, panels, menus, MCP
registrations, observers, and similar registrations before invoking onUnload.
The remaining break concerns broader database, fetch, and global UI-state
finalization.

## Targeted plugin inventory

A six-plugin inventory on 2026-07-30 found that Flashback Memory and WygLore
Leaf already fit the bounded cleanup surface, while Risu Agents registers no
unload callback. The additional compatibility coverage restores the concrete
gaps exercised by Yumi Provider Manager 1.10.0, CPM 1.35.11, and Yumi
Translator 1.2.0: peer cancellation/unregistration, empty style cleanup,
restoring an existing native control, and clearing an existing plugin marker.

Strict mode remains capability-based: plugins must pass the signal received by
`onUnload()` to supported finalization calls. Compatibility mode additionally
recognizes historical callbacks that make the same calls without that signal.

## Implemented recommendation

Publish an explicit unload-safe capability contract and provide supported
replacements for the remaining database, remote, and global UI finalization
cases. Continue to expand compatibility mode only for bounded cleanup evidence,
while rejecting new registrations, non-empty DOM construction, arbitrary model
or chat work, and generation resurrection. Keep the inventory's unchanged-call
patterns covered by bridge-level cleanup and drain regressions.

## Resolution

`onUnload()` now supplies an explicit capability-and-cancellation signal for
bounded finalization. Passing that signal authorizes final database, argument,
character/chat, theme, chat-panel removal, network, image-read, and asset-save
calls even in strict mode. Legacy compatibility accepts the unchanged no-signal
call shape for the same finalization surface.

Database setters may not replace the `plugins` field during teardown, and
`setChatPanel()` accepts only `null` or an empty string. New registrations,
non-empty UI construction, plugin replacement, `runLLMModel()`, and `sendChat()`
remain rejected. Lifecycle-owned hooks and UI continue to be removed
automatically before the plugin's finalizer runs.

Network and asset-save requests receive the sandbox request signal combined
with the callback capability signal. Admitted finalization calls, including
fire-and-forget legacy calls, are tracked and drained inside the existing unload
deadline before the iframe is removed.

The public V3 declaration documents the finalization contract and optional
signal parameters. Regression coverage exercises both unchanged legacy calls
and strict signal-authorized calls, and verifies that plugin generation
resurrection, non-empty panels, and model work remain closed.
