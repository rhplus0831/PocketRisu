# Asset filename migration is not portable across filesystems

- Status: Confirmed platform-dependent data-loss risk
- Severity: High
- Confidence: High
- Introduced by: 7f853d93

## Difference

main stored arbitrary asset keys in SQLite, where Foo.png and foo.png are
distinct. serve's safe-name predicate migrates names verbatim to the filesystem
and accepts case variants, Windows device names, and trailing dots.

## Compatibility impact

On case-insensitive volumes, case variants address one file; migration can
overwrite one payload and then delete both source rows. Names such as CON.png,
NUL, or trailing. can fail or change addressability on Windows. Generated
lowercase hashes are safe, but historical and custom identifiers are affected.

## Recommendation

Use an injective encoded filename independent of host normalization, or perform
a portable collision preflight and leave colliding source rows untouched.
Test case folding, Windows reserved names, and trailing-dot normalization on an
injected case-insensitive filesystem.
