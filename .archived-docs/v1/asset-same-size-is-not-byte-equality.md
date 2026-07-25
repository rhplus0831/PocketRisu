# Same-size asset files are treated as byte-identical

- Status: Fixed
- Severity: High
- Commit: `7f853d93`
- Affected code: `server/node/assetStore.cjs:163-167`, `server/node/assetStore.cjs:274-300`, `server/node/server.cjs:1319-1350`

## Risk

`writeAssetFileIfSizeDiffers()` returns without writing when the destination length equals the incoming length. Startup migration then unconditionally deletes the SQLite row. Equal length does not establish equal content, so a stale or corrupt destination can replace the only known-good copy.

This is not merely hypothetical behavior. `server/node/assetStore.test.ts:293-319` creates an existing file containing `disk` and a same-length SQLite value containing `same`; the test expects migration to retain `disk` and delete the row.

Hash-named asset uploads have the same repair failure. The incoming bytes are checked against the filename, but the existing file is not hashed. A valid re-upload with the same length therefore cannot repair a corrupt file, and the API reports success.

## Failure sequence

1. `save/assets/<name>` already exists with stale or corrupt bytes.
2. SQLite still contains the correct `assets/<name>` value of the same length.
3. Startup migration skips the file write based only on length.
4. Migration deletes the SQLite value.
5. Reads prefer the stale filesystem file, which is now the only application-visible copy.

## Required fix and coverage

Compare bytes or a cryptographic digest before treating the destination as identical. For hash-named assets, verify the existing file against the claimed digest; for legacy names, compare the destination to the incoming bytes. Delete the SQLite row only after equality is proven or a replacement has completed durably.

Add regressions for a same-length/different-content migration and for repairing a same-length corrupt hash-named destination through both single and bulk writes.

## Resolution

`writeAssetFileIfSizeDiffers()` was renamed to `writeAssetFileIfChanged()` and now treats the length match only as a fast path: when lengths are equal it reads the destination and byte-compares it against the incoming value, rewriting unless the bytes are proven identical. The extra file read happens only in the size-equal case.

This closes both call paths at once:

- Startup migration (`migrateAssetRowsToFilesystem`) still deletes the SQLite row unconditionally after the write call, which is now safe — the call either proved the destination byte-identical or durably replaced it (fsync, atomic rename, directory fsync).
- The single (`/api/write`) and bulk (`/api/assets/bulk-write`) upload endpoints both delegate to `writeAssetValue({ skipIfUnchanged })`, so a valid re-upload of a hash-named asset now repairs a same-length corrupt destination instead of skipping it.

Regression coverage in `../../server/node/assetStore.test.ts`: a same-length/different-content row must overwrite the stale file during migration before its row is deleted; a same-length corrupt hash-named destination must be repaired by `writeAssetFileIfChanged()` (the shared path behind both upload endpoints, which have no HTTP-level harness); byte-identical writes are still skipped, preserving mtime and existing hardlinks.

