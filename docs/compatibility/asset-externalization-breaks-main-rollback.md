# Asset externalization makes a direct rollback lose asset access

- Status: Fixed 2026-07-31 with a dedicated main-target downgrade export
- Severity: High
- Confidence: High
- Introduced by: 7f853d93

## Difference

serve migrates safe assets/* rows from SQLite into save/assets files, then
deletes the source KV rows. main knows only the SQLite-backed asset
representation.

## Compatibility impact

After merely booting serve, rolling code back to main makes migrated images and
media invisible to /api/read, /api/list, and asset reads. A raw copy of
save/risuai.db no longer contains the migrated assets that main previously
expected in SQLite. Unlike chat externalization, the asset migration has no
equivalent downgrade archive or surfaced warning.

## Recommendation

Provide a fold-back command or retain a versioned compatibility layer until
the user confirms the upgrade. Make backup documentation explicit about the
filesystem store. Test main seed -> serve migration -> main rollback with asset
byte equality.

## Resolution

`GET /api/backup/export?target=main` now provides the explicit, non-destructive
fold-back path before a downgrade. It takes the same pinned full-state cut as a normal
Node export, reads ordinary assets through the merged filesystem/SQLite inventory, and
emits each asset under the archive name understood by `main`. The live `serve` data
directory remains unchanged.

The Data Migration page exposes the operation as **Export for PocketRisu Main
Rollback** and warns the user to restore the archive into a fresh `main` data directory
rather than booting `main` directly against the externalized `serve` directory. The
rollback export compatibility coverage verifies that filesystem-backed asset entries
retain their exact bytes, while startup-migration coverage separately verifies that the
legacy SQLite row is removed only after the filesystem copy is byte-identical and
durable.

A raw data-directory rollback remains unsupported. The main-target export is the
mandatory compatibility boundary for preserving externalized assets during downgrade.
