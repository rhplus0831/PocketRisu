# Plugin permissions cannot be reset to Ask in normal UI

- Status: Fixed 2026-07-30
- Severity: Medium
- Confidence: High

## Original difference

main exposed resetPluginPermission(plugin.name) from the ordinary settings
surface. serve's permission editor displays Ask as a state but its edit actions
accept only grant or revoke. The production reset function still exists; the
per-plugin resetPluginPermission() currently has no callers. The hidden
developer panel calls the separate resetAllPluginPermissions().

## Original compatibility impact

After granting or denying a permission, an ordinary user cannot restore the
prompt-on-next-use behavior. This is especially significant because database
writes gained permission checks and persisted denial can silently suppress
mutations.

## Implemented recommendation

Add a Reset to Ask action using the production permission state, and test the
rendered settings component rather than a duplicated queue model.

## Resolution

The normal per-plugin permission editor now exposes **Reset all to Ask**. After
confirmation, it calls the existing `resetPluginPermission(plugin.name)` path,
updates every displayed permission to Ask only after persistence succeeds, and
blocks overlapping grant, revoke, or reset mutations. The action uses localized
confirmation and completion messages.

Rendered-component coverage opens the permission editor from Settings, starts
from a persisted denial, invokes the reset action, verifies the production reset
call, and confirms that the visible state returns to Ask.
