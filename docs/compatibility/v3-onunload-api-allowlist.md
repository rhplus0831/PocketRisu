# Legacy onUnload mode exposes only a subset of the former API

- Status: Confirmed intentional compatibility gap
- Severity: Medium
- Confidence: High
- Introduced by: 99253152
- Partially mitigated by: d7be6c8d
- Reverified: 2026-07-30 after the targeted legacy-plugin unload inventory

## Difference

main invoked V3 unload callbacks while the complete RPC surface remained
available, then removed the iframe after a short grace period. serve enters
compatibilityDraining before callbacks and admits only
LEGACY_UNLOAD_ROOT_METHODS and LEGACY_UNLOAD_INSTANCE_METHODS from
src/ts/plugins/apiV3/factory.ts. The compatibility surface now includes
bidirectionally authorized plugin IPC plus argument-restricted DOM cleanup:
empty HTML clearing, empty `x-*` markers, and replacement with an existing
remote element. Admitted cleanup operations drain within the remaining unload
grace period, including calls the guest did not await.

Legacy compatibility is enabled by default. It extends the grace period and
enables the cleanup allowlists, but does not restore the prior API surface.
Settings explicitly disclose that cleanup access is limited.

## Compatibility impact

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

Strict mode intentionally remains narrower. These legacy callbacks do not
propagate the unload signal required for strict storage authority, so disabling
legacy compatibility can still reject their guest-originated cleanup calls.

## Recommendation

Publish an explicit unload-safe capability contract and provide supported
replacements for the remaining database, remote, and global UI finalization
cases. Continue to expand compatibility mode only for bounded cleanup evidence,
while rejecting new registrations, non-empty DOM construction, arbitrary model
or chat work, and generation resurrection. Keep the inventory's unchanged-call
patterns covered by bridge-level cleanup and drain regressions.
