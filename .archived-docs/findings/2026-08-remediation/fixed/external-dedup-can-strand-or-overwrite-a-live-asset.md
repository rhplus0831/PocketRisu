# External dedup can strand or overwrite a live asset

- Status: Fixed (2026-08-06 remediation queue)
- Owner: media and translation
- Source: [2026-07 data-loss audit](../../2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium (at fix time)
- Resolution: this remediation commit — external dedup now runs through the
  PocketRisu-owned Node worker instead of delegating pathname replacement to
  `jdupes` or `hardlink`. Every live asset store and destructive asset-directory
  swap participates in the stable `save/__asset_maintenance.lock` contract.
  Dedup canonicalizes and byte-sorts every target lock before acquisition, holds the
  complete set across comparison and publication, recovers valid dead same-host
  owners, and fails closed for live, foreign-host, or malformed ownership.
  Ancestor symlinks canonicalize to one identity for runtime, journal recovery,
  and dedup, while a symlinked `assets` leaf, blank operand, existing
  non-directory, or non-`assets` target is rejected before mutation. A missing
  operand is ignored only when its lexical basename is `assets`, preserving the
  documented unmatched-glob invocation without accepting other invalid paths.
  Owner metadata is completed and fsynced in a unique private staging inode,
  then atomically hard-linked to the live owner name, so pre-identity faults
  cannot expose an empty owner. Publication cleanup requires the exact created
  inode plus a complete owner record whose token matches the attempt; corrupted
  in-place metadata and copied-token replacement inodes are never unlinked.
  Same-host/PID-labelled staging names are reconciled only after their creator
  is inactive, so pre-identity faults and child termination do not accumulate
  while live staging remains untouched. Stale recovery atomically publishes one
  complete per-owner intent to elect a remover, binds removal to the observed
  owner token and inode, and never removes owner state during intent reconcile.
  Settlement and
  multi-target cleanup always attempt every same-owner release without masking
  the primary failure.
  Runtime file admission, portable-name/case-collision validation, legacy-marker
  changes, payload publication, and shadow-row cleanup share one lock scope for
  ordinary and spooled writes. Imports retain the lock from their first
  asset-directory rename through successful journal finalization or rollback;
  an in-process recovery failure retains the live token and fails runtime writes
  and external dedup closed until restart recovery. Startup journal recovery
  takes the same lock and preserves its primary recovery error if release fails.
  Duplicate publication creates a private hidden hardlink, revalidates the
  source, destination, and temp inode/content immediately before an atomic
  rename, fsyncs the destination directory, and removes or recovers interrupted
  tool temp names. Runtime writes remain fsynced temp-file plus rename, so a
  later write detaches only its instance's pathname from the shared inode.
- Regression coverage: `server/node/assetMaintenanceLock.test.ts` (true
  simultaneous-process exclusion, canonical ancestor-symlink identity,
  symlink-leaf rejection, token-owned/idempotent release, stale-token refusal,
  owner-stage/pre-fstat/real-fstat/fsync/directory-fsync/post-link-lstat faults,
  copied-token replacement-inode and in-place-corruption refusal, inactive-stage
  cleanup/live-stage preservation, true concurrent stale-remover election,
  recovery-plus-release dual faults, valid same-host
  dead-owner recovery, foreign-host fail-closed behavior, stable sibling
  topology), `server/node/assetStore.test.ts` (import finalize/rollback success
  and retryable failure retention, transient release failure, and both
  import-first/write-first case-collision orderings for ordinary and spooled
  publication),
  `server/node/assetDedup.test.ts` (hidden server/tool temp exclusion and
  recovery, shipping entry-point resolution, blank/non-assets/non-directory/
  symlink mixed-list no-mutation validation, Unicode target/candidate byte order
  with canonical-alias collapse, multi-target release failure, byte comparison plus inode
  publication, retry-safe write and import swap races, import lifecycle
  retention/rollback, post-validation replacement race, runtime hardlink
  detachment, and SIGKILL injection after lock acquisition/temp recovery and at
  every dedup pathname-publication phase through directory fsync), plus
  `test/compat/import-ingress-memory.test.ts` (before-restart runtime-write and
  external-dedup behavior after pre-COMMIT rollback and post-COMMIT cleanup
  faults, plus retained exclusion after live pending-journal recovery failure and
  service restoration after startup recovery).
- Canonical architecture: [media and translation](../../../../docs/structure/media-translation.md),
  [server backend](../../../../docs/structure/server-backend.md),
  [backup and recovery](../../../../docs/structure/backup-recovery.md)

## Original risk (historical)

The dedup script claimed live-server safety but delegated pathname replacement
to uncoordinated external tools. Preferred `jdupes -L` could rename the
destination away before linking its replacement, so a crash could leave the
canonical path absent. Both tool branches could compare one inode and replace a
newer inode after a runtime write or whole-directory import swap. The fallback
also admitted PocketRisu publication temporaries.

## Original required fix (historical)

Require a maintenance lock shared with all instances and imports, or stop every
server. Publish link-to-temp via atomic rename with immediate inode/content
revalidation; exclude all server/tool temp names and recover interrupted names.
Crash-inject each publication step and race dedup against writes and import swaps.
