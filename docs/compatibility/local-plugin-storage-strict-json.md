# Local plugin storage rejects JSON.stringify-compatible values

- Status: Confirmed regression
- Severity: Medium
- Confidence: High
- Introduced by: 9d1cd91d

## Difference

main's SafeLocalPluginStorage passed values through JSON.stringify. serve calls
snapshotJsonValue() before persistence. It rejects Date, custom toJSON objects,
sparse arrays, NaN/Infinity, Map, Set, accessors, and other values that
JSON.stringify previously accepted or coerced. Plain Map and Set instances were
typically converted to empty objects; enumerable custom own properties can be
serialized. Circular data failed on main too and is not part of the regression.

The public API still says any JSON-serializable value; Date and custom toJSON
objects satisfy that ordinary meaning.

## Compatibility impact

A plugin that previously persisted a Date as ISO text or relied on normal JSON
coercion now throws. serve also publishes its cache only after durable write,
where main exposed the new cached value while the write was pending, changing
concurrent read behavior.

## Recommendation

Either retain JSON.stringify semantics or narrow and version the public type
and migration guide. Add main/serve differential cases for Date, toJSON,
sparse arrays, non-finite numbers, Map, and Set.
