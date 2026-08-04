# Asset filename mapping is not portable across filesystems

- Status: Open
- Severity: High
- Owner: media and translation
- Source reports: [data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/reports/asset-filenames-collide-on-case-insensitive-filesystems.md), [compatibility investigation](../../../../.archived-docs/findings/2026-07-compatibility/reports/asset-filename-migration-not-portable.md)
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../../../.archived-docs/findings/2026-08-revalidation/README.md)

## Risk

The asset safe-name grammar preserves arbitrary case and host-sensitive names
when moving legacy SQLite keys to filesystem paths. Distinct logical keys such
as `Foo.png` and `foo.png` can collapse on case-insensitive volumes; Windows
device names and trailing-dot normalization introduce additional aliases or
unwritable destinations. No injective encoding, case-fold preflight, or
reserved-name rejection exists in the store, the startup migration, or import
staging (`ca9b37f9` only added spool-based publication and did not touch the
grammar).

The two paths now differ in exposure. The startup SQLite migration can still
overwrite a host-equivalent destination and then delete both source rows.
Archive and save-folder restores, however, stage through create-only (`wx`)
destinations and swap the live directory only after success, so a case-fold
collision generally aborts the restore instead of silently overwriting live
assets — a failed restore, not data loss.

Generated lowercase content hashes are safe. The affected surface is historical
or custom asset identifiers and cross-platform import/restore; Windows and
macOS deployments are supported targets.

## Required fix and coverage

Use an injective encoded filename independent of host normalization, or perform
a portable collision preflight and leave every colliding source row untouched.
Cover case folding, Windows reserved names, trailing dots, and round trips
between case-sensitive and case-insensitive stores.
