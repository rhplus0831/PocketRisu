# Asset filename mapping is not portable across filesystems

- Status: Fixed (2026-08-05 remediation queue)
- Owner: media and translation
- Source reports: [data-loss audit](../../2026-07-data-loss-audit/reports/asset-filenames-collide-on-case-insensitive-filesystems.md), [compatibility investigation](../../2026-07-compatibility/reports/asset-filename-migration-not-portable.md)
- Severity: High (at fix time)
- Resolution: `f3e8aa11` — asset names now have a host-independent portable
  identity: `portableAssetNameKey()` (ASCII case fold plus trailing-dot
  stripping) and `isPortableAssetName()` (safe grammar minus Windows device
  basenames and trailing dots) in `server/node/assetStore.cjs`. The startup
  migration preflights every candidate row against that identity and leaves
  each non-portable name and every member of a colliding group — row against
  row and row against an existing on-disk file — untouched in SQLite, with
  per-key operator warnings and new `skippedNonPortable`/`skippedCollision`
  counters. KV-resident rows were verified first-class on every surface:
  `readAssetValue()` fallback on all read routes, `kv-source` entries in
  full/server/upstream exports, the pinned-snapshot branch in partial exports,
  and merged dual-source GC. Backup and save-folder imports route non-portable
  names to SQLite and demote an already-staged file to SQLite when a
  case-colliding entry arrives (the whole group becomes KV-resident so no
  case-folding host can shadow a row), turning the former `EEXIST` restore
  abort into a lossless cross-filesystem round trip. The dead rename-replacing
  `writeImportedAsset` helper was removed. Generated lowercase content hashes
  were never affected. The runtime write path was deliberately left out of
  scope and is tracked as the follow-up finding
  [runtime asset writes can replace a case-colliding asset](../../../../docs/findings/open/media-translation/runtime-asset-writes-can-case-fold-clobber.md).
- Regression coverage: `server/node/assetStore.test.ts` (portable-name
  predicates incl. reserved basenames and trailing dots; preflight matrix —
  row/row and row/file collisions, exact-name idempotent re-run, non-portable
  and unsafe skips; migration on a simulated case-folding filesystem loses
  neither payload and still migrates unique mixed-case names),
  `test/compat/backup-roundtrip.test.ts` (seeded startup migration retains
  colliding/reserved/trailing-dot rows byte-exact in SQLite and serves every
  key; backup import demotes a staged case-collision, retains reserved names,
  and reads all entries back byte-exact).
- Canonical architecture: [media and translation](../../../../docs/structure/media-translation.md),
  [server backend](../../../../docs/structure/server-backend.md)

## Original risk (historical)

The asset safe-name grammar preserves arbitrary case and host-sensitive names
when moving legacy SQLite keys to filesystem paths. Distinct logical keys such
as `Foo.png` and `foo.png` can collapse on case-insensitive volumes; Windows
device names and trailing-dot normalization introduce additional aliases or
unwritable destinations. No injective encoding, case-fold preflight, or
reserved-name rejection exists in the store, the startup migration, or import
staging.

The two paths differed in exposure. The startup SQLite migration could still
overwrite a host-equivalent destination and then delete both source rows.
Archive and save-folder restores staged through create-only (`wx`)
destinations and swapped the live directory only after success, so a case-fold
collision generally aborted the restore instead of silently overwriting live
assets — a failed restore, not data loss.

Generated lowercase content hashes are safe. The affected surface is
historical or custom asset identifiers and cross-platform import/restore;
Windows and macOS deployments are supported targets.

## Original required fix (historical)

Use an injective encoded filename independent of host normalization, or
perform a portable collision preflight and leave every colliding source row
untouched. Cover case folding, Windows reserved names, trailing dots, and
round trips between case-sensitive and case-insensitive stores.
