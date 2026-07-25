# Concurrent server backups share one output path

- Status: Open
- Severity: Medium
- Lens: D1, D2, D3
- Area: Area 6 — server recovery
- Affected code: `server/node/server.cjs:4970-4988`, `server/node/server.cjs:5035-5114`

## Risk

Server backup names use only `Date.now()`, and each deterministic temp path is
opened with non-exclusive write mode. Two requests entering in the same
millisecond can truncate and write through the same pathname or inode despite
holding separate correct SQLite snapshots.

One request may rename the shared temp and report success after `stat()`, while
the other open descriptor continues changing the visible final archive. The
second rename can fail after the first acknowledgement, leaving the supposedly
successful backup corrupt or assembled from two points in time.

## Required fix and coverage

Use collision-resistant final names and independently random, exclusive `wx`
temp files. Atomically publish only that request's file and structurally verify
the published archive before emitting `done`.

Force same-time concurrent requests with distinct snapshots and validate both
reported archives after every writer completes.
