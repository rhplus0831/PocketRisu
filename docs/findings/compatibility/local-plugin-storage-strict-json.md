# Local plugin storage rejects JSON.stringify-compatible values

- Status: Fixed 2026-07-30
- Severity: Medium
- Confidence: High
- Introduced by: 9d1cd91d

## Original difference

main's SafeLocalPluginStorage passed values through JSON.stringify. serve calls
snapshotJsonValue() before persistence. It rejects Date, custom toJSON objects,
sparse arrays, NaN/Infinity, Map, Set, accessors, and other values that
JSON.stringify previously accepted or coerced. Plain Map and Set instances were
typically converted to empty objects; enumerable custom own properties can be
serialized. Circular data failed on main too and is not part of the regression.

The public API still says any JSON-serializable value; Date and custom toJSON
objects satisfy that ordinary meaning.

## Original compatibility impact

A plugin that previously persisted a Date as ISO text or relied on normal JSON
coercion now throws. serve also publishes its cache only after durable write,
where main exposed the new cached value while the write was pending, changing
concurrent read behavior.

## Implemented recommendation

Either retain JSON.stringify semantics or narrow and version the public type
and migration guide. Add main/serve differential cases for Date, toJSON,
sparse arrays, non-finite numbers, Map, and Set.

## Resolution

`SafeLocalPluginStorage.setItem()` now applies the legacy `JSON.stringify` and
parse normalization before handing a detached plain JSON tree to the strict
persistence layer. V3 guest instances perform the same normalization before
the iframe `postMessage` boundary, so custom `toJSON` methods and accessors run
in the plugin realm instead of being lost or rejected by structured cloning.

Dates, custom `toJSON` results, sparse arrays, non-finite numbers, Map, Set,
undefined object fields, and enumerable custom properties now match their
historical JSON representations. Circular data and BigInt continue to reject
as they do under `JSON.stringify`. The safer acknowledgement behavior remains:
the cache publishes the normalized value only after the durable write succeeds.

Regression coverage exercises the direct storage class and the generated V3
guest bridge, including one-call `toJSON` behavior and the exact normalized
value received by persistence.
