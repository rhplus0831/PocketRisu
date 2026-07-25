# V3 plugin database setters bypass the `db` permission

- Status: Open
- Severity: Medium
- Area: plugin API / trust boundaries
- Affected code: `src/ts/plugins/apiV3/v3.svelte.ts:854-855` (`setDatabaseLite`/`setDatabase` exposed raw), `src/ts/plugins/apiV3/v3.svelte.ts:860-864` (`getDatabase` *is* permission-gated), `src/ts/plugins/plugins.svelte.ts:503-527` (allowed keys include `characters`, `modules`, `personas`)

## Risk

The V3 permission model gates database *reads* behind
`getPluginPermission(name, 'db', ...)`, but the write-side `setDatabaseLite`
and `setDatabase` are re-exported as raw legacy functions with no check —
directly beside the gated reader. An enabled plugin can replace whole
collections (e.g. `characters: []`) during startup or any automatic hook,
without ever prompting; the save loop persists the replacement and the server
transactionally deletes chat rows no longer referenced by the shrunk graph.
The user may have explicitly denied the `db` permission and still lose data.
Requires a malicious or buggy installed plugin, hence warning.

## Required fix and coverage

Apply the `db` permission to both setters, and require separate destructive
consent (or a forced pre-image/snapshot) for collection-shrinking writes.
Test: a plugin without granted `db` permission calls `setDatabaseLite` and
must be rejected.
