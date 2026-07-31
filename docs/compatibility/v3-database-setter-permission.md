# V3 database writes can silently succeed after permission denial

- Status: Fixed 2026-07-31
- Severity: Medium
- Confidence: High
- Introduced by: d9c9817f

## Difference

main's setDatabase() and setDatabaseLite() bypassed the db permission required
for reads. serve intentionally closes that security gap by requesting periodic
db permission in src/ts/plugins/apiV3/v3.svelte.ts.

If permission is denied, both methods return normally without changing state.
The persisted denial can keep later calls blocked until
resetPluginPermission() clears the saved decision. Their declared return type
remains Promise<void>.

## Compatibility impact

Write-only plugins now prompt even if they never read the database. More
importantly, await resolves after a denied write, so plugins can report success,
discard a retry buffer, or continue from state that was never committed.

## Recommendation

Keep the permission boundary but reject with a stable permission-denied error
or return an explicit mutation result. Test ask, grant, persisted denial, and a
plugin that only writes.

## Resolution

PocketRisu retains the database permission boundary and now rejects both
setDatabase() and setDatabaseLite() with `PluginPermissionError` and the stable
`PLUGIN_PERMISSION_DENIED` code when the user denies access. The V3 iframe
bridge preserves the error name and code, while successful calls retain their
existing `Promise<void>` contract.

Coverage exercises ask, grant, persisted denial, and write-only use for both
setters, plus the real guest RPC path to verify that sandboxed plugins receive
the stable error and that denied calls do not mutate database state.
