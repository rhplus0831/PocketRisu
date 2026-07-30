# V3 database setters removed the custom-key fallback

- Status: Fixed 2026-07-30
- Severity: Medium
- Confidence: High
- Introduced by: d9c9817f

## Difference

main and current upstream RisuAI route unsupported top-level fields passed to
setDatabase() or setDatabaseLite() into pluginCustomStorage. PocketRisu
previously rejected them with Unsupported V3 database key; use pluginStorage.

The behavior was outside the current DatabaseSubset type, but it was an
established runtime convention inherited from V2.

## Reproduction

Call setDatabaseLite() with a plugin-specific top-level field. main/upstream
store pluginCustomStorage[field]. serve throws before mutation.

## Recommendation

Preserve the fallback under legacy compatibility mode or provide a migration
adapter and warning that names the replacement pluginStorage key. Add
differential tests against the pinned upstream implementation.

## Resolution

PocketRisu now preserves the upstream fallback while Legacy plugin
compatibility is enabled and retains the strict rejection when it is disabled.
Fallback values publish through the authoritative plugin-storage transaction in
both inline and optimized modes and are attributed to the calling plugin.

The first successful fallback for each plugin in a browser session emits a
developer-only notice through the native console handle. It does not call the
captured `console.warn`, application notification APIs, `/api/logs`, or any
other persistent logging path.
