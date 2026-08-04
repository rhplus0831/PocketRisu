# Legacy hash-looking assets become unwritable

- Status: Fixed
- Severity: Medium
- Confidence: High
- Introduced by: 7f853d93
- Fixed: 2026-07-31

## Historical difference

Before this fix, main accepted arbitrary bytes at arbitrary assets/* keys while
serve interpreted a 64-lowercase-hex name plus extension as content-addressed
and rejected writes whose bytes did not hash to that name.

Startup migration deliberately imports a mismatched historical value with a
warning, but later rewrite, bulk write, and partial export paths enforce the
hash. The same asset can therefore upgrade and remain readable while becoming
impossible to rewrite or include in partial/character export. Full backup
export remains available.

## Recommendation

Record legacy non-content-addressed identity explicitly, or remap it atomically
and update all references. Seed a main asset named as 64 zeroes with nonmatching
bytes and test migration, read, rewrite, bulk write, and partial export.

## Resolution

PocketRisu now records mismatched hash-shaped files explicitly under
`save/assets/.legacy-hash-assets/`. A bounded one-time startup scan backfills
identity for files migrated by older builds; later startups prune stale markers
without treating new filesystem corruption as legacy data. Trusted backup and
save-folder imports classify mismatches while staging their atomic directory
replacement.

Single and bulk writes accept a mismatch only when that exact asset has the
persisted legacy identity. Writing bytes that match the filename clears the
identity and restores strict content-addressed enforcement. Partial exports
carry marked legacy bytes verbatim, while full-export round trips reconstruct
the identity from the imported payload. Unit and real-server coverage
now exercises discovery, restart persistence, reads, rewrites, bulk writes,
canonicalization, full-backup round trips, and partial export.
