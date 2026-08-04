# Save-folder and snapshot restores gained a fixed 10-minute deadline

- Status: Fixed 2026-07-30
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

## Resolution

The client no longer applies a total wall-clock deadline. Save-folder and snapshot
replacements opt into a strict NDJSON activity stream and use a two-minute inactivity
watchdog that is refreshed by upload progress, server heartbeats, phase events, and
terminal events. A progressing operation can therefore run for longer than ten minutes,
while a silent or disconnected operation still stops waiting after a finite interval.

Every replacement carries a UUID and has a durable status row outside the logical KV
database being replaced. The server writes `committed` and the exact result in the same
SQLite transaction that publishes the replacement. A client that loses the terminal
response polls the authenticated status endpoint and can distinguish a committed restore
from one that did not commit without replaying the destructive request. Stale `running`
rows become `not-committed` after a server restart, and retained outcomes are pruned after
the configured retention interval.

Legacy callers that do not negotiate the stream keep the existing JSON response. Tests
cover directory and ZIP work that remains active beyond eleven minutes, strict streamed
outcomes, lost acknowledgements, idle disconnects, and committed snapshot reconciliation
across server restart.
