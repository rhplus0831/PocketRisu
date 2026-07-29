# Legacy onUnload mode exposes only a subset of the former API

- Status: Confirmed intentional compatibility gap
- Severity: Medium
- Confidence: High
- Introduced by: 99253152
- Partially mitigated by: d7be6c8d

## Difference

main invoked V3 unload callbacks while the complete RPC surface remained
available, then removed the iframe after a short grace period. serve enters
compatibilityDraining before callbacks and admits only
LEGACY_UNLOAD_ROOT_METHODS and LEGACY_UNLOAD_INSTANCE_METHODS from
src/ts/plugins/apiV3/factory.ts.

Legacy compatibility is enabled by default. It extends the grace period and
enables the cleanup allowlists, but does not restore the prior API surface.
Settings explicitly disclose that cleanup access is limited.

## Compatibility impact

Fast cleanup calls that formerly worked now reject immediately, including
setDatabase(), setDatabaseLite(), setArgument(), setCharacter(), chat setters,
setChatPanel(null), theme restoration, plugin IPC, nativeFetch/risuFetch,
runLLMModel, sendChat, and saveAsset. Compatibility mode does allow
unregisterUIPart, hideContainer, DOM removal, and several unregister calls; the
UI gap concerns mutations outside that list, such as setChatPanel(null) and
theme restoration. Plugins can fail to flush state or notify a peer during
disable, removal, or reload.

serve automatically removes lifecycle-owned hooks, panels, menus, MCP
registrations, observers, and similar registrations before invoking onUnload.
The remaining break concerns broader database, fetch, IPC, and global UI-state
finalization.

## Recommendation

Publish an explicit unload-safe capability contract and provide supported
replacements for remote, database, IPC, and UI cleanup. For compatibility mode,
allow bounded authenticated cleanup mutations while continuing to reject new
registrations and generation resurrection. Test an inventory of former APIs.
