# Default imports can reject backups produced by the same server

- Status: Confirmed self-round-trip regression
- Severity: High
- Confidence: High
- Introduced by: f1931989

## Difference

main's default backup import was unbounded; zero disabled the optional cap.
serve defaults to 2 GiB total and 100,000 entries. Missing, zero, empty, or
invalid RISU_BACKUP_IMPORT_MAX_BYTES values fall back to 2 GiB rather than
meaning unlimited.

The exporter checks individual entry framing but does not enforce the
importer's aggregate byte, entry-count, or per-category defaults. Raw inlays,
cold-storage entries, and unsafe/legacy asset keys are materialized by the
importer under a 32 MiB buffered-entry limit, but the exporter does not impose
that category limit. A serve installation can therefore export an archive that
a fresh default serve installation refuses.

## Compatibility impact

Large asset, inlay, chat, or plugin stores can pass export and only discover
during disaster recovery that the archive is over 2 GiB or 100,000 entries. A
single 32 MiB+1 raw inlay or cold-storage row can fail even below both aggregate
limits. Operators who intentionally used zero for unlimited also receive the
new cap.

## Recommendation

Guarantee that every default export is accepted by the default importer, or
preflight/split with an explicit warning and restore instructions. Export
preflight must match total, count, and per-category admission unless the
importer streams those raw categories. Preserve a documented unlimited sentinel
if safe. Test aggregate 2 GiB+1 and 100,001-entry plans without allocating their
full payloads, plus a 32 MiB+1 inlay/cold row round trip.
