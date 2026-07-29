# An unrelated plugin failure can roll back a healthy installation

- Status: Confirmed regression
- Severity: High
- Confidence: High
- Introduced by: strict lifecycle transaction series

## Difference

serve reloads every enabled plugin after an import or enable operation.
loadPluginsUnlocked() aggregates lifecycle failures, including a V3 generation
whose startup rejects. Ordinary V2 top-level throws are not propagated through
this path. commitPluginListMutation() uses rollbackOnReloadFailure for plugin
imports and enables, so it rolls back the target mutation when the V3 failure
already existed elsewhere.

main did not propagate V3 top-level initialization failures through a
transaction that could undo an unrelated plugin-list change.

## Compatibility impact

One already-enabled V3 plugin with a startup rejection can remain in the
database yet prevent every unrelated healthy plugin from being installed or
enabled. Retrying cannot succeed until the old plugin is found and disabled.
The transaction-level error does not establish that the newly imported plugin
was at fault. A separate startup notification names the plugin whose V3 startup
failed, but it is not connected to the rollback decision.

## Recommendation

Return structured per-plugin lifecycle outcomes. Roll back only when the target
plugin fails or when a system invariant cannot be established; quarantine or
report unchanged failures separately. Add an integration test with one
pre-existing V3 startup-rejecting plugin and one newly imported healthy plugin.
