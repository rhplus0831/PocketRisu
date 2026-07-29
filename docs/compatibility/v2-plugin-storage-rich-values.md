# V2 storage rejects values accepted by main

- Status: Fixed 2026-07-30
- Severity: Medium
- Confidence: High
- Introduced by: d72af87c

## Original difference

main and upstream assign V2/V2.1 pluginStorage and pluginCustomStorage values
directly. RisuSave's msgpack path can preserve values such as Date, binary data,
and non-finite numbers. serve clones all writes and pluginStorage.getItem()
through cloneLegacyStorageJson() in src/ts/plugins/plugins.svelte.ts; database
facade and flattened reads instead return guarded proxies.

That validator rejects Date, Uint8Array, Map, Set, BigInt, non-finite numbers,
custom instances, cycles, accessors, symbols, and non-enumerable data.
Non-empty frozen containers with own non-configurable/non-enumerable entries
fail, while empty frozen containers can pass. Sparse-array holes are silently
converted to null rather than preserved. The migration guide still declares
value: any.

## Original compatibility impact

Existing Date, binary, and non-finite values can survive RisuSave meaningfully
and then fail when a V2 plugin reads them. Other historical runtime values have
narrower persistence behavior: Map/Set/custom instances can change
representation, BigInt can narrow to Number, and cycles fail encoding. New
in-memory writes that worked on main can still throw during startup and prevent
provider or hook registration. The restriction applies even when optimized
storage is disabled; V3 inline storage deliberately accepts a broader
structured-clone domain.

## Implemented recommendation

Preserve the established inline/msgpack-compatible value domain. Validate or
convert only when the user attempts externalization, and let transition
preflight fail without mutation. Add persisted upgrade fixtures for Date and
binary values, plus separate runtime tests documenting the exact Map/Set,
BigInt, non-finite, custom-instance, sparse-array, and cyclic behavior.

## Resolution

V2/V2.1 storage now takes a descriptor-safe structured-clone-style snapshot at
each synchronous read and write boundary. It preserves Date, binary views,
Map, Set, BigInt, non-finite numbers, sparse arrays, and circular data while
detaching caller aliases. Custom instances become ordinary data objects, as
they do across structured-clone/msgpack persistence boundaries. Enumerable
accessors remain rejected without invocation so plugin-controlled getters
cannot mutate storage outside the serialized transition barrier.

Whole `pluginCustomStorage` replacements remain validated as storage records,
and optimized storage remains JSON-only. Its existing transition preflight
rejects an incompatible rich value before changing the routing mode or live
inline data.

Regression coverage verifies runtime writes and detached reads across the rich
inline domain, frozen-container acceptance, accessor/prototype-hook safety, and
a real RisuSave encode/decode upgrade fixture containing Date, binary, NaN, and
Infinity values.
