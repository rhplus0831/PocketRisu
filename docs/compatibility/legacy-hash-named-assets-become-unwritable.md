# Legacy hash-looking assets become unwritable

- Status: Confirmed regression
- Severity: Medium
- Confidence: High
- Introduced by: 7f853d93

## Difference

main accepted arbitrary bytes at arbitrary assets/* keys. serve interprets a
64-lowercase-hex name plus extension as content-addressed and rejects writes
whose bytes do not hash to that name.

Startup migration deliberately imports a mismatched historical value with a
warning, but later rewrite, bulk write, and partial export paths enforce the
hash. The same asset can therefore upgrade and remain readable while becoming
impossible to rewrite or include in partial/character export. Full backup
export remains available.

## Recommendation

Record legacy non-content-addressed identity explicitly, or remap it atomically
and update all references. Seed a main asset named as 64 zeroes with nonmatching
bytes and test migration, read, rewrite, bulk write, and partial export.
