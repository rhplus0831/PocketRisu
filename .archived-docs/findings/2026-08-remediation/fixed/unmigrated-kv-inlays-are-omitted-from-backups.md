# Inlays still served from KV fallback are omitted from backups and cleared on restore

- Status: Fixed (2026-08-06 remediation queue)
- Owner: backup and recovery
- Source: [2026-07 data-loss audit](../../2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium
- Area: server recovery (backup completeness)
- Affected code: `migrateInlaysToFilesystem()`,
  `planFullBackupFilesystemEntries()`, and `pinFullBackupState()` in
  `server/node/server.cjs`
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the
  [revalidation register](../../2026-08-revalidation/README.md)
- Resolution: this remediation commit — full downloads, server-file backups,
  and main-target rollback exports now plan one component-wise union across the
  pinned SQLite view and the current filesystem inventory. The one resolved
  filesystem payload and a matching readable sidecar win for each safe ID;
  `inlay/<id>` and `inlay_info/<id>` snapshot rows fill only missing payload or
  info components, so stale KV shadows are not duplicated. An unsafe legacy ID
  cannot be represented by the existing safe archive grammar, so lossless
  exports reject it with `BACKUP_UNSAFE_LEGACY_INLAY` instead of silently
  publishing an incomplete archive. Upstream-target and partial exports retain
  their intentional inlay omission. Startup migration now examines legacy rows
  even when an older marker exists, finalizes missing sidecars before removing
  filesystem-shadowed rows, and publishes the marker only when no `inlay/` rows
  remain. Failed and unsafe rows therefore remain retriable, and legacy rows
  imported by save-folder replacement after marker publication are immediately
  backup-visible and migrate on the next restart.
- Regression coverage: `test/compat/inlay-kv-backup-fallback.test.ts` covers
  full-download, server-file, and main-target fallback inclusion; byte-exact KV
  payload/info capture; filesystem precedence without stale duplication;
  restore and metadata preservation; a filesystem source appearing after the
  pinned cut; post-marker save-folder imports; failed-row marker removal and
  later retry; explicit unsafe-ID rejection; and continued upstream/partial
  omission.
- Canonical architecture: [full and server-file exports](../../../../docs/structure/backup-recovery.md#full-and-server-file-exports)
  and [media inlay conventions](../../../../docs/structure/media-translation.md#5-conventions--gotchas)

## Original risk (historical)

If an inlay failed or was skipped during the one-time filesystem migration
(unsafe ID or transient error), the marker was still written, so it was never
retried. The inlay lived permanently in its KV fallback row, which the server
continued to serve. Backups enumerated only filesystem inlays, so the fallback
payload and its `inlay_info/` row were silently absent from every archive, and
restoring an archive cleared the legacy prefixes and deleted the live copy.

## Original required fix and coverage (historical)

Do not write the migration marker while readable legacy rows remain (or retry
them per boot), and make backup enumeration take the union of filesystem and KV
inlays, including the KV payload whenever no verified filesystem equivalent
exists.
