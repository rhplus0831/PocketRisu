# Legacy storage getters conflate valid values with missing entries

- Status: Fixed
- Severity: Medium
- Lens: L4
- Area: Area 2 — client/plugin boundary
- Affected code: `src/ts/plugins/plugins.svelte.ts:2047`, `src/ts/plugins/plugins.svelte.ts:2075`, `src/ts/plugins/pluginSafeClass.ts:33`, `src/ts/plugins/pluginSafeClass.ts:55`, `src/ts/plugins/apiV3/v3.svelte.ts:2177`, `src/ts/plugins/apiV3/v3.svelte.ts:2185`

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

## Resolution

Fixed 2026-07-31. The V2 save-backed facade uses exact own-presence reads and
nullish indexed-key fallback, while the shared V2/V3 `SafeLocalStorage.key()`
now tests exact array-index presence instead of value truthiness. V3 exports
the local-storage methods through bound wrappers so `key()` retains its class
receiver. Focused
regressions cover false, zero, empty string, stored null, missing entries, and
empty-string indexed keys through the synchronous V2 surface, shared local
wrapper, and generated V3 guest bridge.
