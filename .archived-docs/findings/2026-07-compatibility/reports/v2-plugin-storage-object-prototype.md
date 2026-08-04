# V2 pluginCustomStorage no longer behaves like an ordinary object

- Status: Fixed 2026-07-30
- Severity: Medium
- Confidence: High
- Introduced by: d72af87c and ac5d0f47

## Original difference

main and upstream expose the ordinary pluginCustomStorage object. serve exposes
a Proxy backed by Object.create(null); its getPrototypeOf trap returns null and
unrecognized inherited properties return undefined. Nested guarded arrays and
objects also report null prototypes.

## Original compatibility impact

Common legacy code changes behavior:

- storage.hasOwnProperty(name) throws.
- storage instanceof Object becomes false.
- String(storage) can throw.
- Object.getPrototypeOf(storage) becomes null.
- Nested arrays can fail instanceof Array checks.

The persisted representation remains an ordinary object, so this is a facade
behavior change rather than a format requirement.

## Implemented recommendation

Preserve ordinary prototype observations while retaining safe traps for keys
such as __proto__ and constructor. Add differential tests for inherited
helpers, String conversion, instanceof, prototypes, and shadowing special keys.

## Resolution

The V2/V2.1 `pluginCustomStorage` facade now reports `Object.prototype` and
falls back to ordinary inherited object behavior when a name is not present in
storage. Guarded nested values report their actual prototypes, restoring
`instanceof` checks for ordinary objects and arrays.

The facade retains its null-prototype internal target, own-property lookup, and
validated write traps. Stored keys such as `__proto__`, `constructor`, and
`hasOwnProperty` therefore remain inert own data and safely shadow inherited
members without changing the facade's prototype. Regression coverage verifies
inherited helpers, string conversion, root and nested prototype observations,
`instanceof`, and special-key shadowing and deletion. Direct Svelte snapshots
of the facade now match ordinary-object snapshot behavior; JSON serialization
and authoritative storage paths continue to preserve own special keys through
their dedicated safe-record handling.
