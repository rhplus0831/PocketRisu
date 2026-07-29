# Plugin storage enumeration order changed

- Status: Confirmed behavioral change
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
