# Boot spool sweep can unlink another instance's active file

- Status: Fixed (2026-08-06 remediation queue)
- Owner: server backend
- Source: [2026-07 data-loss audit](../../2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium (at fix time)
- Lens: D5, L3
- Area: Area 5 — server KV core and chat rows
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../2026-08-revalidation/README.md)
- Resolution: `f4432368` — the configured spool path is now a shared root,
  while every installation writes and boot-sweeps only a stable
  `.instance-<sha256(__spool_owner_id)>/` child. A private sibling claim binds
  the dedicated owner UUID to the canonical save root; a clone at another path
  atomically reseeds a copied valid owner before any child validation or cleanup.
  Missing identities and claims publish by fsynced exclusive hard link; invalid
  identities converge on a canonical-save-path-derived UUID, so no reclaimable
  singleton lock pathname exists. Identity and claim files are validated without
  following symlinks and hardened to `0600`; the real owned child is revalidated
  and hardened to `0700`. Boot atomically quarantines that child, creates the new
  runtime child, verifies the pinned old inode against the pre-rename identity,
  and sweeps only through pinned old/fresh descriptors. Survivor publication is
  create-only and retains the quarantine on conflicts. Every quarantine pathname
  is retained after descriptor close, eliminating post-close conditional deletion.
  Runtime consumers use the process-lifetime pinned
  fresh descriptor rather than the reusable pathname. Unsupported
  descriptor-relative platforms skip deletion and spooling safely. Directory
  fsync follows the repository's portable best-effort contract. Where pinned
  access is available, restart cleanup reaps recognized files and admitted-write
  stages abandoned by the same persistent installation, but it does not use file
  age and never enters peer namespaces, symlink targets, or unowned legacy root
  files. Every request revalidates the owned child, so a repaired custom root
  recovers admitted ingress and readiness-gated plugin spools in-process.
- Regression coverage: `server/node/spoolOwnership.test.ts` (no-follow owner,
  claim, and owned-child validation; inert legacy-lock replacement; static,
  pre-rename, post-pin, post-close, survivor-conflict, and runtime-path swap
  coverage; `0600`/`0700` hardening; copied-valid-owner claim/reseed;
  directory-fsync portability); `test/compat/snapshot-spool.test.ts`
  (two isolated servers with copied valid, absent, or corrupt owner identity
  files share one `POCKETRISU_SPOOL_DIR`; restarting one removes its seeded orphan while
  preserving the other's recursively discovered paused active snapshot spool;
  first-boot clone and concurrent copied-owner startup coverage; successful
  recovery-snapshot publication; outside symlink-victim survival; identity
  regeneration, same-instance boot orphan cleanup, default
  hub path, custom-spool failure and in-process admitted-ingress recovery);
  `test/compat/admitted-write-spool.test.ts` (owned-path spooling and boot
  cleanup); `server/node/snapshotPluginStorage.e2e.test.ts` and
  `server/node/importListBarrier.e2e.test.ts` (restore/import spool cleanup in
  the owned namespace).
- Canonical architecture: [server backend](../../../../docs/structure/server-backend.md)

## Original risk (historical)

Startup removed every regular file beginning `.database-risudat-` in the
configured spool directory. Generated names contained a PID and UUID, but the
sweep checked no owner, liveness, age, or lock; revalidation found it also
unlinked additional unowned spool prefixes, slightly widening the exposure.
Shared spool volumes are plausible for the multi-instance hub roadmap.

Starting instance B could unlink instance A's active snapshot spool. On POSIX
the open writer continued into an unlinked inode, but A's later pathname-based
ingest could not reopen it. Explicit operations failed loudly; automatic
snapshot creation caught the error and let the primary write succeed without
its recovery point.

## Required fix and coverage (historical)

Namespace spool roots per instance or publish a durable owner/lease and reap
only files proven abandoned. Avoid age-only policies for legitimately long
spools.

Run two instances against one spool, restart one during the other's paused
snapshot, and require the active file and recovery copy to survive.
