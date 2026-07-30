# Buffered backup/save-folder imports rejected large opaque rows

- Status: Fixed 2026-07-30
- Severity: Medium
- Confidence: High
- Introduced by: f1931989

## Difference

serve streamed safe filesystem assets, supported streamable database formats,
chat rows, and eligible plugin-value rows, but fell back to
importBoundedOpaqueRow() for other valid namespaces. That path defaulted to 32
MiB per entry. main did not have this per-entry limit.

The concrete historical `remotes/<id>.local.bin` case and unsafe asset rows were first
moved to chunked file ingestion, while arbitrary namespaces and plugin metadata still
fell back to the bounded helper.

## Compatibility impact

A valid save folder or ZIP containing a remaining non-chunkable row of 32 MiB+1 was
rejected even when total bytes and entry count were below their configured limits.

## Resolution

Chunk storage is now a physical representation available to every string KV key rather
than an allowlisted namespace feature. Small values remain direct SQLite rows, while
large generic and extension-defined rows use the same protected manifests as databases,
chats, plugin values, assets, cold storage, and remotes. Save-folder and backup imports
publish staged opaque rows with `kvSetFromFile()` and retain the overall byte, entry,
disk-headroom, cancellation, and atomic replacement limits.

Plugin metadata is syntax-validated page-by-page and written from its staged file. A
bounded scanner derives its best-effort top-level plugin owner during validation and
again from logical chunk ranges during startup index reconciliation; neither operation
materializes the metadata body. ZIP and directory coverage restores generic and plugin
metadata rows at 32 MiB+1, verifies exact logical bytes and physical chunk publication,
and confirms metadata ownership after restart.
