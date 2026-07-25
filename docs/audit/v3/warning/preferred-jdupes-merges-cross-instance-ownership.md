# Preferred jdupes merges cross-instance ownership

- Status: Open
- Severity: Medium
- Lens: D4
- Area: Area 7 — server file stores
- Affected code: `scripts/dedup-assets.sh:14-19`, `scripts/dedup-assets.sh:44-55`, `server/node/assetStore.cjs:125-140`

## Risk

PocketRisu creates asset files with mode `0600`. The preferred `jdupes` command
omits `-p`, so byte-equal files with different owners, groups, or modes may be
collapsed onto the first inode. Hardlinks share ownership and permissions; the
destination cannot retain its prior metadata.

When a root cron spans per-user instances, selecting user A's inode for user B's
asset can make B unable to read or export it. Chowning the shared inode back to B
would break A instead. The fallback deliberately respects ownership, so behavior
also changes with the installed dedup executable.

## Required fix and coverage

Add `-p` and perform an explicit same-UID/GID/mode preflight for every directory.
Make same-user ownership a hard requirement and fail closed on mismatch.

Test mixed-owner/mode trees and assert no cross-principal hardlinks are created.
