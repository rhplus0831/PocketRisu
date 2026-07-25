# Persistent JSON acknowledges values it cannot represent faithfully

- Status: Open
- Severity: Medium
- Lens: L2, L3, L4
- Area: Area 3 — client serialization and caches
- Affected code: `src/ts/storage/persistentKv.ts:41-57`, `src/ts/plugins/pluginSaveStorage.ts:71-96`, `src/ts/plugins/pluginSaveStorage.ts:206-235`, `src/ts/storage/risuSave.ts:167-170`, `src/ts/storage/risuSave.ts:286-293`

## Risk

`writePersistentJson()` sends `JSON.stringify(value)` directly to
`TextEncoder.encode()` without verifying that it returned a string or preserved
the input shape. Top-level undefined/functions become a successful zero-byte row
that later fails `JSON.parse('')`; Maps and Sets become `{}`, nested unsupported
properties disappear, and non-finite numbers become null.

The V3 ingress accepts arbitrary structured-cloneable values. In optimized mode,
off-to-on reconciliation can persist the lossy row and then delete the inline
source. One poisoned row also aborts enumeration of all external plugin values,
breaking backup folding and later reconciliation rather than acting as a miss.

## Required fix and coverage

Serialize once, require a defined string, and validate a documented JSON-value
tree before writing or deleting any source. Apply identical normalization in
inline and optimized modes.

Cover undefined, functions, Map/Set, non-finite numbers, BigInt, cycles, and
poisoned-row enumeration.
