# Ill-formed legacy plugin keys can poison inline storage

- Status: Confirmed regression
- Severity: Medium
- Confidence: High
- Introduced by: fa2d0e98, 0da9d553, and 1b3a8233

## Difference

main accepted arbitrary JavaScript string keys, including lone UTF-16
surrogates. serve rejects ill-formed UTF-16. Inline V3 mutation and enumeration
validate the complete existing map, so one historical lone-surrogate key can
prevent writes/removals of unrelated valid keys and make keys() fail.

## Compatibility impact

Previously saved values become difficult to inspect or migrate through V3.
V3 clear works but destroys unrelated entries; while optimization is off, a V2
facade still accepts, enumerates, and can remove the malformed key. The
whole-map poisoning described here is scoped to V3 async storage and related
optimized transitions.

## Recommendation

Use a versioned, lossless physical encoding for legacy keys. Isolate an invalid
entry so it does not poison the map and expose exact diagnostic/recovery
tooling. Test lone surrogates through upgrade and V2/V3 inline operations.
