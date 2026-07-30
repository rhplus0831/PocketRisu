# Plugin storage enumeration order changed

- Status: Fixed 2026-07-30
- Severity: Low
- Confidence: High
- Introduced by: 9d1cd91d

## Difference

main's V3 risuai.pluginStorage.key()/keys() used Object.keys(): array-index keys
sort numerically and other strings retain insertion order. serve's V3
orderPluginStorageKeys() path sorts array indices numerically and every other
key lexicographically by UTF-16 code units. V2 synchronous enumeration remains
insertion-ordered and is not affected.

Inserting z and then a returns [z, a] on main and [a, z] on serve. The new
declaration documents the sorted order, but the existing methods and names were
not versioned.

## Compatibility impact

Plugins using key(index), append-like keys, persisted cursors, priority by
creation order, or first/last entry conventions can process records in a
different order after upgrade.

## Recommendation

Retain legacy ordering for existing methods with persisted order metadata, or
introduce a separately named sorted enumeration API. Add migration guidance
that tells plugins never to infer age from the new order.

## Resolution

V3 `key()` and `keys()` again use the legacy `Object.keys()` contract: array-index
names numerically, followed by other strings in insertion order. Optimized storage
manifest version 2 makes that sequence authoritative across mutations, mode
transitions, backups, and restores; version-1 manifests remain valid migration
baselines and upgrade on their next publication. Plugins that require the former
canonical UTF-16 order can call the separately named `sortedKeys()` method.

Historical insertion order that an earlier PocketRisu build already sorted cannot be
reconstructed. Its current version-1 manifest or inline object order becomes the
migration baseline, after which updates retain position and delete/reinsert moves a
non-index key to the end.
