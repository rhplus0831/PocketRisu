# V3 database setters removed the custom-key fallback

- Status: Confirmed runtime compatibility break
- Severity: Medium
- Confidence: High
- Introduced by: d9c9817f

## Difference

main and current upstream RisuAI route unsupported top-level fields passed to
setDatabase() or setDatabaseLite() into pluginCustomStorage. serve's
pluginDatabaseBridge.prepareMutation() rejects them with Unsupported V3
database key; use pluginStorage.

The behavior was outside the current DatabaseSubset type, but it was an
established runtime convention inherited from V2.

## Reproduction

Call setDatabaseLite() with a plugin-specific top-level field. main/upstream
store pluginCustomStorage[field]. serve throws before mutation.

## Recommendation

Preserve the fallback under legacy compatibility mode or provide a migration
adapter and warning that names the replacement pluginStorage key. Add
differential tests against the pinned upstream implementation.
