# Plugin permissions cannot be reset to Ask in normal UI

- Status: Confirmed UI compatibility regression
- Severity: Medium
- Confidence: High

## Difference

main exposed resetPluginPermission(plugin.name) from the ordinary settings
surface. serve's permission editor displays Ask as a state but its edit actions
accept only grant or revoke. The production reset function still exists; the
per-plugin resetPluginPermission() currently has no callers. The hidden
developer panel calls the separate resetAllPluginPermissions().

## Compatibility impact

After granting or denying a permission, an ordinary user cannot restore the
prompt-on-next-use behavior. This is especially significant because database
writes gained permission checks and persisted denial can silently suppress
mutations.

## Recommendation

Add a Reset to Ask action using the production permission state, and test the
rendered settings component rather than a duplicated queue model.
