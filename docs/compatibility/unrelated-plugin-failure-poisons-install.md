# An unrelated plugin failure can roll back a healthy installation

- Status: Fixed 2026-07-30
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

## Resolution

V3 generation loading now returns structured outcomes attributed by plugin
name. Plugin import and enable transactions roll back for a target-plugin
startup failure, teardown or unattributed lifecycle failure, or a persistence
failure. A startup failure attributed to an unchanged V3 plugin remains
reported by that plugin's existing startup notification but no longer rolls
back a healthy target mutation.

Regression coverage verifies a pre-existing rejecting V3 plugin alongside a
healthy import and enable, preserves target-failure rollback, and exercises
per-plugin attribution through the real V3 sandbox startup path.
