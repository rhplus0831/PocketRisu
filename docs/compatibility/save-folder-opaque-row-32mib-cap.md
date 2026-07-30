# Buffered backup/save-folder imports reject large opaque rows

- Status: Partially fixed 2026-07-30; non-chunkable save-folder rows remain
- Severity: Medium
- Confidence: High
- Introduced by: f1931989

## Difference

serve streams safe filesystem assets, supported streamable database formats,
chat rows, and eligible plugin-value rows, but falls back to
importBoundedOpaqueRow() for other valid namespaces. That path defaults to 32
MiB per entry. main did not have this per-entry limit.

The concrete historical `remotes/<id>.local.bin` case and unsafe asset rows now use
chunked file ingestion, and confirmed downloaded-backup restores have a separate
large-restore admission path. Arbitrary non-chunkable save-folder namespaces and plugin
metadata still fall back to the bounded helper.

## Compatibility impact

A valid save folder or ZIP containing a remaining non-chunkable row of 32 MiB+1 is
rejected even when total bytes and entry count are below their configured limits. The
error already reports row, configured limit, and actual size.

## Recommendation

Define a file-backed representation for arbitrary opaque namespaces or reject them at
the write boundary before they can become accepted live state. Until then, document the
existing `RISU_IMPORT_BUFFERED_ENTRY_MAX_BYTES` mitigation. Remote and unsafe-asset
fixtures above 32 MiB now cover the chunked ZIP/directory path.
