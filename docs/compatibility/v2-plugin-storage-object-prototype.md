# V2 pluginCustomStorage no longer behaves like an ordinary object

- Status: Confirmed regression
- Severity: Medium
- Confidence: High
- Introduced by: d72af87c and ac5d0f47

## Difference

main and upstream expose the ordinary pluginCustomStorage object. serve exposes
a Proxy backed by Object.create(null); its getPrototypeOf trap returns null and
unrecognized inherited properties return undefined. Nested guarded arrays and
objects also report null prototypes.

## Compatibility impact

Common legacy code changes behavior:

- storage.hasOwnProperty(name) throws.
- storage instanceof Object becomes false.
- String(storage) can throw.
- Object.getPrototypeOf(storage) becomes null.
- Nested arrays can fail instanceof Array checks.

The persisted representation remains an ordinary object, so this is a facade
behavior change rather than a format requirement.

## Recommendation

Preserve ordinary prototype observations while retaining safe traps for keys
such as __proto__ and constructor. Add differential tests for inherited
helpers, String conversion, instanceof, prototypes, and shadowing special keys.
