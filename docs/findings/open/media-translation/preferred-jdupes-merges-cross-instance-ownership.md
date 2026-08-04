# Preferred jdupes merges cross-instance ownership

- Status: Open
- Owner: media and translation
- Source: [2026-07 data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium
- Lens: D4
- Area: Area 7 — server file stores
- Affected code: `scripts/dedup-assets.sh:14-19`, `scripts/dedup-assets.sh:44-55`, `server/node/assetStore.cjs:125-140`
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../../../.archived-docs/findings/2026-08-revalidation/README.md)

## Risk

PocketRisu creates asset files with mode `0600`. The preferred `jdupes` command
omits `-p`, so byte-equal files with different owners, groups, or modes may be
collapsed onto the first inode. Hardlinks share ownership and permissions; the
destination cannot retain its prior metadata.

When a root cron spans per-user instances, selecting user A's inode for user B's
asset can make B unable to read or export it. Chowning the shared inode back to B
would break A instead. The fallback deliberately respects ownership, so behavior
also changes with the installed dedup executable.

Revalidation caveat: the script (unchanged since `7f853d93`) pins the flags,
not the binary, and `jdupes` is neither vendored nor version-pinned. Omitting
`-p` permits cross-owner merging under documented jdupes semantics, and with
mode-`0600` files one side loses access whichever owner survives, so the risk
holds under any merge order; the exact attribute behavior of a deployed binary
was still not runtime-verified. Optional evidence hardening: run the deployed
jdupes as root over same-filesystem byte-equal files differing in UID, GID,
and mode, then compare inode identity, ownership, and each user's readability.

## Required fix and coverage

Add `-p` and perform an explicit same-UID/GID/mode preflight for every directory.
Make same-user ownership a hard requirement and fail closed on mismatch.

Test mixed-owner/mode trees and assert no cross-principal hardlinks are created.
