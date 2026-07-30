# RISUSAVE block databases over 64 MiB are rejected

- Status: Fixed 2026-07-30
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

## Resolution

Recognized `RISUSAVE\0` block databases now use the existing bounded block scanner and
disk-backed JSON-to-MessagePack converter during both backup-archive and save-folder
replacement. The converted file enters the ordinary streaming database ingestion path,
so large characters, chats, and plugin values retain the same externalization and atomic
publication rules as canonical saves.

REMOTE blocks resolve from rows already staged by the enclosing replacement transaction.
Those rows are copied to private bounded spools rather than materialized in memory, and
the converter preserves cancellation, the configured decoded-byte ceiling, strict JSON
validation, cleanup, and the existing `RISU_SAVE_INVALID` response contract. The 64 MiB
legacy materialization cap remains in force for formats that still lack a streaming path.

Compatibility coverage imports an exact 64 MiB + 1 block database through both a backup
archive and a retained save folder while setting the legacy fallback cap to 128 bytes.
The existing REMOTE migration suite verifies successful resolution, missing-row rollback,
and preservation of the prior publication.
