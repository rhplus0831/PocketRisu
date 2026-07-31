# Inlay replacement unlinks the only copy before publishing the new one

- Status: Fixed
- Severity: High
- Area: server file stores (inlays)
- Affected code: historical `writeInlayFile` delete-first publication and bulk-compression skip handling in `server/node/server.cjs`; fixed in the atomic inlay publication helpers and `/api/inlays/compress`

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

## Resolution

Fixed 2026-07-31. Inlay payloads and sidecars are now written to exclusive
temporary files and fsynced before any reader-visible path changes. The payload
is atomically renamed first while the prior sidecar and prior-extension payload
remain authoritative; the atomic sidecar rename is the extension-changing
commit point. The directory is fsynced after publication, and the exact prior
payload is removed only after that commit. Same-extension replacement uses the
atomic payload rename, so readers see either the complete old bytes or the
complete new bytes. Sidecar-only writes use the same staged, fsynced rename
pattern, temporary files are excluded from inlay enumeration, and startup
removes temporary files left by an interrupted process.

Bulk compression now distinguishes publication failures from ordinary
non-beneficial or unconvertible images. A publication failure terminates the
stream with `INLAY_PUBLICATION_FAILED` instead of incrementing `skipped` and
reporting `done`; an extension-changing failure before the sidecar commit rolls
back the unpublished destination while retaining the original source.

`test/compat/inlay-publication-atomicity.test.ts` covers an injected staged-write
failure, compression failure reporting with byte-exact source preservation, and
a real `SIGKILL` after payload publication but before the sidecar commit followed
by restart. Existing inlay-reference and pinned full-export race coverage also
passes with the new protocol.
