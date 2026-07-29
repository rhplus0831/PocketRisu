# Save-folder and snapshot restores gained a fixed 10-minute deadline

- Status: Confirmed regression
- Severity: Medium
- Confidence: High

## Difference

main's save-folder import path had no total wall-clock deadline. serve assigns
SAVE_FOLDER_IMPORT_TIMEOUT_MS and INTERNAL_SNAPSHOT_RESTORE_TIMEOUT_MS to a
fixed 10 minutes in src/ts/storage/nodeStorage.ts.

For ZIP restore, one budget covers upload, inspection/extraction, assembly, and
acknowledgement. Directory scanning occurs before its execution deadline; the
deadline then covers validation, assembly, and acknowledgement. Snapshot
restore has a separate ten-minute authentication/restore/acknowledgement budget
and no upload or ZIP phase.

## Compatibility impact

A legal 2 GiB ZIP restore needs more than roughly 3.4 MiB/s before accounting
for server work. Slow disks, remote links, many entries, or queued validation
can exceed the relevant limit. The import routes are designed to observe
disconnect and roll back pre-commit work, but a timeout racing publication
still leaves the client unable to distinguish rollback from a completed commit.

## Recommendation

Use progress/idle timeouts and a configurable overall policy scaled to declared
bytes/entries. Expose a job status endpoint so reconnecting clients can resolve
the outcome. Test slow but progressing directory, ZIP, and snapshot restores.
