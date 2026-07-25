# Legacy storage getters conflate valid values with missing entries

- Status: Open
- Severity: Medium
- Lens: L4
- Area: Area 2 — client/plugin boundary
- Affected code: `src/ts/plugins/plugins.svelte.ts:735`, `src/ts/plugins/plugins.svelte.ts:739`, `src/ts/plugins/plugins.svelte.ts:741`, `src/ts/plugins/plugins.svelte.ts:755`, `src/ts/plugins/plugins.svelte.ts:759`, `src/ts/plugins/pluginSafeClass.ts:30`, `src/ts/plugins/apiV3/v3.svelte.ts:1343`, `src/ts/plugins/apiV3/v3.svelte.ts:1356`

## Risk

The V2/V2.1 `getItem()` uses `value || null`, turning stored empty strings,
zero, and false into a missing result. Its `key(index)` and the V3-exported
`SafeLocalStorage.key()` similarly turn a valid empty-string key into `null`.

A legacy plugin can interpret a persisted falsey sentinel as absent, reset its
configuration, or lock itself against later saves. An empty key is counted and
listed but cannot be retrieved through the indexed API. These are successful
reads of existing data, not explicit storage errors.

## Required fix and coverage

Use nullish/exact presence checks and explicit index bounds rather than
truthiness. Keep the V2 and V3 facades behaviorally aligned.

Add parity tests for false, zero, empty string, null, missing values, and the
empty-string key.
