# Optimized plugin storage adds an undocumented key-length limit

- Status: Confirmed regression
- Severity: Low
- Confidence: High
- Introduced by: 9f276c43

## Difference

main's inline object storage accepted arbitrary-length property names. serve's
optimized backend limits encoded archive row names to 1,024 UTF-8 bytes. An
owned ASCII key is effectively limited to 752 bytes because its metadata path
is longer.

An ordinary 753-byte key can remain valid in inline V3 storage, then cause
externalization to reject before publication. A plugin already in optimized
mode receives RangeError from setItem(). The public pluginStorage declaration
does not state the limit.

## Compatibility impact

Users can be unable to enable optimization for a main-compatible inline store,
while plugins that derive long keys fail only after the mode changes. The
failure is safe and pre-commit, but the migration path and limit are obscure.

## Recommendation

Document a plugin-facing key limit, add migration diagnostics that name the
offending key, or use a lossless fixed-size physical key encoding. Test the
752/753-byte owned-key boundary through normal writes and both transition
directions.
