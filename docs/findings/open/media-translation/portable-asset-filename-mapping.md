# Asset filename mapping is not portable across filesystems

- Status: Open
- Severity: High
- Owner: media and translation
- Source reports: [data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/reports/asset-filenames-collide-on-case-insensitive-filesystems.md), [compatibility investigation](../../../../.archived-docs/findings/2026-07-compatibility/reports/asset-filename-migration-not-portable.md)

## Risk

The asset safe-name grammar preserves arbitrary case and host-sensitive names
when moving legacy SQLite keys to filesystem paths. Distinct logical keys such
as `Foo.png` and `foo.png` can collapse on case-insensitive volumes; Windows
device names and trailing-dot normalization introduce additional aliases or
unwritable destinations. Migration can overwrite one payload and then delete
both source rows.

Generated lowercase content hashes are safe. The affected surface is historical
or custom asset identifiers and cross-platform import/restore.

## Required fix and coverage

Use an injective encoded filename independent of host normalization, or perform
a portable collision preflight and leave every colliding source row untouched.
Cover case folding, Windows reserved names, trailing dots, and round trips
between case-sensitive and case-insensitive stores.
