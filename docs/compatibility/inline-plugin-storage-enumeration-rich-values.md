# Inline structured-clone values break plugin storage enumeration

- Status: Fixed 2026-07-30
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

## Resolution

Inline enumeration now validates only the storage record and its own property
descriptors; it no longer reads or JSON-snapshots values merely to return key
names. `keys()`, `sortedKeys()`, `key()`, and `length()` therefore remain usable
when any inline row contains a structured-clone value outside strict JSON.

Selected inline viewer rows and versioned migration reads use the same detached
structured-clone domain as basic `getItem()`. JSON values retain their existing
revision algorithm, while legacy rich values receive a separate opaque revision
derived from structured-clone MessagePack. This lets the viewer load, guardedly
delete, or replace a rich row and lets `readItem()`/`getWithRevision()` expose it
for migration. Compound and versioned replacement values remain strict JSON, so
plugins can migrate rich rows into the optimized backend without expanding its
persisted value domain.

Regression coverage exercises undefined, Date, Map, Set, non-finite numbers,
BigInt, sparse arrays, and cycles across set/get, ordered and sorted enumeration,
indexed key/length access, versioned reads, viewer pages, guarded replacement,
and revision-bound removal.
