# Serve branch data-loss audit

- Original audit point: `1c0f5257`
- Remediation audit point: `2e3d4f05`
- Current status: All 16 substantiated findings fixed

## Scope

This audit covers the persistence, recovery, and communication changes called out in commits `7f853d93` through `41ab5bb5`, plus the three cache commits `b4ddaf2b`, `0263ce63`, and `d2ef38c6`. The code reviewed is the `serve` branch at `1c0f5257`, relative to `origin/main` at `63832a13`.

## Result

Sixteen data-loss or recovery-integrity risks were substantiated:

The table below records the original findings. Their individual documents now include
the implemented resolution and regression coverage; all were rechecked as fixed at
`2e3d4f05`. The remaining note on long-running streamed import transactions is an
operational/WAL-growth tradeoff, not an acknowledged-write loss after the exclusive
import barrier.

| Commit(s) | Finding | Class |
|---|---|---|
| `7f853d93` | [Same-size asset files are treated as byte-identical](asset-same-size-is-not-byte-equality.md) | Direct loss |
| `7f853d93` | [A process crash can split filesystem imports from the SQLite transaction](import-directory-swap-has-a-crash-window.md) | Direct loss |
| `e2bc8e5b` | [Partial backups omit optimized plugin storage](partial-backup-omits-optimized-plugin-storage.md) | Broken recovery copy |
| `e2bc8e5b` | [Automatic snapshots do not version optimized plugin storage](snapshots-omit-optimized-plugin-storage.md) | Broken recovery copy |
| `e2bc8e5b` | [Plugin-key encoding collides on unpaired UTF-16 surrogates](plugin-key-encoding-has-surrogate-collisions.md) | Direct loss |
| `c3e22dc3`, `9cb0086d` | [Duplicate character IDs collapse distinct chat rows](duplicate-character-ids-collapse-chat-rows.md) | Direct loss |
| `9cb0086d` | [Patch processing deletes chat rows before the new stub database is durable](patch-deletes-chat-rows-before-stub-persistence.md) | Direct loss |
| `9cb0086d`, `f410c8a6` | [Backup assembly silently accepts a missing referenced chat row](backup-assembly-is-not-a-consistent-snapshot.md) | Broken recovery copy |
| `9cb0086d`, `93e1dd4f` | [Full database writes are not atomic with external row writes](full-database-write-is-not-atomic-with-external-rows.md) | Direct loss |
| `f8aac548` | [Generation save gating defers the authoritative chat row](generation-save-gating-defers-authoritative-chat-row.md) | Direct loss |
| `f8aac548` | [Chat-backup reconciliation deletes sources without verifying derivatives](chat-backup-reconcile-trusts-unverified-derivatives.md) | Broken recovery copy |
| `dd678e00` | [A concurrent plugin-row resize can corrupt a streamed export](concurrent-plugin-write-can-corrupt-export.md) | Broken recovery copy |
| `f410c8a6`, `41ab5bb5` | [SQLite snapshots depend on the file-backup path for temporary space](snapshot-spool-depends-on-file-backup-path.md) | Recovery unavailable |
| `8f0d6e07` | [A streamed import can roll back a concurrently acknowledged write](streamed-import-can-roll-back-acknowledged-writes.md) | Direct loss |
| `6792dc7f` | [List deltas can publish state that the import later rolls back](list-delta-can-cache-rolled-back-state.md) | Cleanup/recovery risk |
| `f8aac548`, `41ab5bb5` | [Chat history is stored outside the default persistent Docker volume](chat-history-is-outside-the-persistent-volume.md) | Recovery unavailable |

## Reviewed without a substantiated loss finding

- `41e60278`: chunk replacement, manifest copying, and deletion are transactional. GC removes stale manifests first and then deletes only unreferenced chunks. Exclusive-footprint accounting can retain too much data, but it does not over-delete recovery copies.
- `93e1dd4f`: re-externalization itself writes all plugin rows transactionally before removing inline fields from the object. Its `/api/write` use inherits the separate atomicity gap documented above.
- `f410c8a6`: the MessagePack writer uses an exclusive temporary file, awaits stream completion, removes failed spools, and publishes server backup files only by final rename. The findings concern its capture boundary and spool location, not byte equivalence of the writer.
- `41ab5bb5`: disabling file backups and pinning the snapshot cap are explicit policy. Snapshot trimming retains the newest snapshot. The findings concern enabled recovery features that still depend on the disabled path.
- `b4ddaf2b`: conditional chat reads bind cache hits to the server's exact bytes with SHA-256; the client rehashes them and falls back on any failure.
- `0263ce63`: cached database segments are individually verified; missing or malformed segments fall back to a full authoritative read.
- `d2ef38c6`: conditional KV hits and write-seeded entries are exact-byte hash verified. The persistent enumeration failure is in `6792dc7f`, not the value cache.
