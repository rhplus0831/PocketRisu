# RISUSAVE block databases over 64 MiB are rejected

- Status: Confirmed upgrade/import regression
- Severity: Medium
- Confidence: High
- Introduced by: f1931989

## Difference

An imported/copied block-format database.bin or retained main/upstream save
folder can preserve the RISUSAVE block form. Ordinary main Node UI writes
decode and re-encode it, so they do not normally create this backup case. The
retained paths did not apply a 64 MiB fallback limit during restore. serve's
stream inspector applies DEFAULT_LEGACY_DATABASE_IMPORT_MAX_BYTES = 64 MiB.

## Compatibility impact

An archive containing a copied block database.risudat, or a main/upstream save
folder whose retained database/database.bin is 64 MiB+1, can be well below the
2 GiB total cap yet fail with LEGACY_DATABASE_IMPORT_LIMIT. Normal upstream
backup export re-encodes database.risudat with legacy header 8.

## Recommendation

Teach the streaming loader to handle the recognized block format, or document
the RISU_LEGACY_DATABASE_IMPORT_MAX_BYTES workaround prominently. Add a valid
64 MiB+1 block-format fixture and compare main, serve, and upstream import
behavior.
