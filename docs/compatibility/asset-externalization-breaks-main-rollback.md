# Asset externalization makes a direct rollback lose asset access

- Status: Confirmed downgrade incompatibility
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
