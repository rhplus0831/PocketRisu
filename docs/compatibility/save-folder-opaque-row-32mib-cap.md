# Buffered backup/save-folder imports reject large opaque rows

- Status: Confirmed import regression
- Severity: Medium
- Confidence: High
- Introduced by: f1931989

## Difference

serve streams safe filesystem assets, supported streamable database formats,
chat rows, and eligible plugin-value rows, but falls back to
importBoundedOpaqueRow() for other valid namespaces. That path defaults to 32
MiB per entry. main did not have this per-entry limit.

One concrete historical namespace is remotes/<id>.local.bin, used by split
remote-character saves. The same bounded helper affects ordinary backup import,
not only save folders.

## Compatibility impact

A valid backup, save folder, or ZIP containing a remote row of 32 MiB+1 is
rejected even when total bytes and entry count are below their configured
limits. The error already reports row, configured limit, and actual size.

## Recommendation

Stream known legacy namespaces or spool opaque rows to the save volume instead
of buffering them. Until then, document the existing
RISU_IMPORT_BUFFERED_ENTRY_MAX_BYTES mitigation. Add a valid database plus a 32
MiB+1 remotes row fixture to ordinary backup and save-folder tests.
