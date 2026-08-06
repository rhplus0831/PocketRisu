# Preferred jdupes merges cross-instance ownership

- Status: Open
- Owner: media and translation
- Source: [2026-07 data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium
- Lens: D4
- Area: Area 7 — server file stores
- Affected code: `server/node/assetDedup.cjs`, `scripts/dedup-assets.sh`, `server/node/assetStore.cjs`
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../../../.archived-docs/findings/2026-08-revalidation/README.md)

## Risk

PocketRisu creates asset files with mode `0600`. The controlled dedup worker
does not yet enforce a same-UID, same-GID, and same-mode eligibility policy, so
byte-equal files with different owners, groups, or modes may be collapsed onto
the first inode. Hardlinks share ownership and permissions; the destination
cannot retain its prior metadata.

When a root cron spans per-user instances, selecting user A's inode for user B's
asset can make B unable to read or export it. Chowning the shared inode back to B
would break A instead.

The external-dedup atomicity remediation replaced `jdupes` with a repository-owned
worker but intentionally left this distinct ownership policy unresolved. Its
link-to-temp plus rename makes publication crash-safe; it does not make
cross-principal inode sharing safe.

## Required fix and coverage

Perform an explicit same-UID/GID/mode preflight for every directory and candidate.
Make same-user ownership a hard requirement and fail closed on mismatch.

Test mixed-owner/mode trees and assert no cross-principal hardlinks are created.
