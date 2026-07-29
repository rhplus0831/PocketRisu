# Inline structured-clone values break plugin storage enumeration

- Status: Confirmed internal contract break
- Severity: Medium
- Confidence: High

## Difference

serve explicitly accepts structured-clone values in inline V3 storage,
including Date, Map, Set, BigInt, sparse arrays, cycles, undefined, and
non-finite numbers. setItem() and getItem() work for most of them; stored
undefined is accepted but deliberately reads back as null.

keys(), key(), and length() derive keys by cloning the whole map through
cloneJsonPluginStorageRecord() and snapshotJsonValue(), which reject those same
values. The viewer enumerates keys directly, but strict-snapshots values on the
selected page and fails when that page reaches one of them.

## Compatibility impact

One accepted value poisons every enumeration operation, including operations
that only need property names. A plugin can successfully write and read most of
these keys, then fail on length or keys; undefined has the separate null-read
caveat above. Versioned getWithRevision/readItem/updateItem paths also
strict-snapshot rich values and can reject them. Existing rich-value tests do
not cover this full API matrix.

## Recommendation

Enumerate own keys without cloning values. Snapshot only the selected value
when a viewer actually needs it, using the same structured-clone domain as
set/get. Test every accepted value across set, get, keys, key, length, and
viewer.
