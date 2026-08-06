# Preferred jdupes merges cross-instance ownership

- Status: Fixed (2026-08-06 remediation queue)
- Owner: media and translation
- Source: [2026-07 data-loss audit](../../2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium (at fix time)
- Lens: D4
- Area: Area 7 — server file stores
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the
  [revalidation register](../../2026-08-revalidation/README.md)
- Resolution: this remediation commit — controlled asset dedup now performs a
  complete metadata preflight while holding every target's asset-maintenance
  lock. All target directories and all candidate files must share one UID and
  GID; directories must share one permission/special-bit mode, and candidate
  files must share one permission/special-bit mode. Candidate ownership must
  also equal the containing target directory's ownership. Any missing or mixed
  metadata fails with `ASSET_DEDUP_METADATA_MISMATCH` before interrupted-temp
  recovery, hashing, hardlink creation, or destination replacement. Mode
  comparison uses `stat.mode & 0o7777`, covering rwx and setuid/setgid/sticky
  bits while excluding file-type bits, which are validated separately and
  necessarily differ between directories and regular files. Publication
  revalidates the expected directory, source, destination, and hardlink-temp
  metadata alongside pinned inode/content checks immediately before the atomic
  rename, with no callback or asynchronous boundary in between.
- Regression coverage: `server/node/assetDedup.test.ts` covers mismatched target
  directory and candidate UID/GID through faithful injected stat metadata,
  real mixed directory and candidate modes, mode validation for a unique
  non-duplicate candidate, zero recovery/link/rename/unlink mutation on
  preflight refusal, unchanged destination inodes, temp cleanup, and UID/GID/mode
  races at the hardlink publication boundary. Existing coverage retains
  same-filesystem validation, maintenance locking, deterministic byte ordering,
  content/inode revalidation, atomic link-to-temp/rename, crash recovery, and
  runtime write detachment.
- Canonical architecture: [media and translation](../../../../docs/structure/media-translation.md)
  and [server backend](../../../../docs/structure/server-backend.md)

## Original risk (historical)

PocketRisu creates asset files with mode `0600`. The controlled dedup worker
did not enforce a same-UID, same-GID, and same-mode eligibility policy, so
byte-equal files with different owners, groups, or modes could be collapsed
onto the first inode. Hardlinks share ownership and permissions; the destination
could not retain its prior metadata.

When a root cron spanned per-user instances, selecting user A's inode for user
B's asset could make B unable to read or export it. Chowning the shared inode
back to B would break A instead. The repository-owned worker's link-to-temp plus
rename made publication crash-safe but did not make cross-principal inode
sharing safe.

## Original required fix and coverage (historical)

Perform an explicit same-UID/GID/mode preflight for every directory and
candidate. Make same-user ownership a hard requirement and fail closed on
mismatch. Test mixed-owner/mode trees and assert no cross-principal hardlinks
are created.
