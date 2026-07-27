# Inlay replacement unlinks the only copy before publishing the new one

- Status: Open
- Severity: High
- Area: server file stores (inlays)
- Affected code: `server/node/server.cjs:1281-1309` (`writeInlayFile` deletes first, writes directly to the final name, no fsync), `server/node/server.cjs:4244-4262` (`/api/write` inlay path), `server/node/server.cjs:6818-6861` (bulk compression; per-entry failures counted as `skipped`)

## Risk

`writeInlayFile()` calls `deleteInlayRawFile()` — unlinking the current
payload — before writing the replacement directly to its final path, with no
exclusive temp file, no atomic rename, and no fsync of file or directory. The
sidecar is written the same way. Between the unlink and a completed write there
is no valid copy on disk; inlays are also absent from DB-only snapshots, so
nothing else holds the bytes.

Two realistic triggers:

- A crash or power loss during an ordinary inlay overwrite destroys the image.
- Bulk inlay compression runs this helper over every image. A write failure —
  ENOSPC is exactly the condition under which users run compression — is
  caught per-entry and counted as `skipped++`, and the endpoint still reports
  a normal `done`. The old payload is already unlinked, so each "skipped"
  failure is actually a destroyed image, reported as success.

The asset store already has the correct pattern (exclusive temp file, fsync,
atomic rename, directory fsync — `server/node/assetStore.cjs:117-160`); inlays
simply do not use it.

## Required fix and coverage

Write the replacement payload and sidecar to exclusive temporary names in the
inlay directory, fsync, atomically rename into place, fsync the directory, and
only then remove an obsolete-extension file. Make compression treat a
publication failure as an error (with the source preserved), not a skip.

Cover with fault-injection: force the post-unlink write to fail and assert the
original payload still exists; kill mid-overwrite and assert one valid version
survives restart.
