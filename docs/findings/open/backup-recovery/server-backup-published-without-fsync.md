# Server backups are acknowledged before the directory entry is durable

- Status: Open
- Owner: backup and recovery
- Source: [2026-07 data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Low
- Area: server recovery (backup durability)
- Affected code: `server/node/server.cjs` server-backup writer (stream with `flush: true` → no-overwrite `fs.link` publication → tmp unlink → `done`, no directory fsync of `backupsDir`)
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../../../.archived-docs/findings/2026-08-revalidation/README.md)

## Risk

The writer is stronger than originally reported: `f3efd3b1` added
`flush: true`, so file bytes are fsynced before the name is published, and a
no-overwrite hard link replaced rename publication. Truncated or zero-length
archives are effectively excluded.

The residual gap is directory-entry durability only. Neither the `fs.link`
publication nor the temp unlink is followed by an fsync of `backupsDir`, so a
host power cut shortly after the `done` acknowledgement can leave the archive
absent — and the next boot's temp sweep then deletes the orphaned bytes
instead of recovering them. Live data is unaffected; only the just-created
recovery copy is at risk, but users make backups precisely before risky
operations.

## Required fix and coverage

fsync `backupsDir` after publication and before emitting `done` (the pattern
`assetStore.cjs:117-160` already uses), and consider letting the boot sweep
adopt a complete orphaned temp instead of deleting it.
