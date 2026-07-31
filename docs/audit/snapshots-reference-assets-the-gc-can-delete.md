# DB-only snapshots do not preserve assets

- Status: Intentional documented limitation
- Severity: Medium
- Area: recovery consistency (snapshots vs. assets)
- Relevant code: `createBackupAndRotate()` and `spoolSelfContainedBackupDatabase()` create logical database snapshots; `runServerAssetCleanup()` scans the current live database; `/api/db/snapshots/restore` restores logical database state without an asset generation.

## Documented limitation

Automatic snapshots are deliberately DB-only. The Backups UI labels them
“Snapshot (DB only)” and explicitly states that character assets and inlay
images are not included. Full server and local backups are the asset-complete
recovery mechanisms.

Consequently, ordinary asset cleanup may delete an asset that is no longer
referenced by the current database even when an older retained snapshot still
contains its path. Restoring that snapshot can produce a dangling reference.
This is within the disclosed snapshot scope rather than an open data-loss
defect; the live state before restore is unaffected.

## Rationale

The DB-only label and explicit asset/inlay exclusion predate the audit finding,
the server implementation uses the same DB-only terminology, and original
RisuAI likewise keeps automatic database snapshots separate from full backups
that enumerate assets. Preserving snapshot-only asset references would be an
optional product enhancement, not a correctness requirement of the documented
feature.
