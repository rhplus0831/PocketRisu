# Legacy snapshot restore overwrites the live database before full decode

- Status: Open
- Severity: High
- Lens: D5, D6
- Area: Area 6 — server recovery
- Extends: [Small-database imports validate the payload after the destructive commit](../../v2/fatal/import-validates-small-database-after-destructive-commit.md)
- Affected code: `server/node/server.cjs:6613-6676`, `server/node/streamRisuLoad.cjs:62-118`, `server/node/server.cjs:509-544`

## Risk

Snapshot restore inspects only the magic header and two format bytes. For every
snapshot below the streaming threshold, or in a non-streamed format, it copies
the snapshot over `database/database.bin` before the first full decompression,
decode, normalization, plugin externalization, or chat-row ingestion.

A valid-header but corrupt recovery copy therefore replaces a still-decodable
live database and only then fails. The request reports failure, but later boot
and reads see the corrupt snapshot with no rollback path. This is the same
destructive-commit-before-validation defect shape as v2's fatal small-import
finding, so severity parity requires fatal classification here as well.

A recent automatic snapshot may permit partial recovery, but it is not an
adequate mitigation: edits since that snapshot are lost, and the damage occurs
precisely while the user is attempting recovery.

## Required fix and coverage

Fully decode and validate non-streaming snapshots before changing any
authoritative key, then commit the prepared blob, plugin rows, and chat rows in
one transaction while retaining the former live value on every failure.

Test a valid-header/truncated small snapshot and require byte-for-byte
preservation of the pre-restore live key and rows.
