# Changing the chat-backup root hides all existing version history

- Status: Fixed (2026-08-06 remediation queue)
- Owner: backup and recovery
- Source: [2026-07 data-loss audit](../../2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium (at fix time)
- Lens: L3, D3, D5
- Area: Area 8 — mode matrix and round trips
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../2026-08-revalidation/README.md)
- Resolution: this remediation commit — startup now uses the complete validated
  `__chat_backup_path` history and every legacy `chat-backups` tree below the
  complete validated `__backup_path` history as migration and read input. New
  captures always target the configured active root. Startup durably merges
  every available prior root into that active root and never overwrites a
  divergent destination. Same-path or same-version conflicts, including complete
  legacy bundle groups, first stage a complete, fsynced private copy in an
  active-root `%2Eroot-history/<source-id>/` namespace. Ordinary destinations
  publish an independent create-only copy from that recovery copy. Migration
  never unlinks a historical source member, because no compare-then-unlink
  protocol can be atomic against arbitrary filesystem peers replacing that path.
  Protected decoded history remains permanent. Startup normalization may compact
  ordinary active-root loose, gzip, or bundle representations after every decoded
  entry is durable, but treats historical and protected/conflict roots as
  non-destructive inputs: it may derive validated frames without withdrawing
  source loose, gzip, bundle, or metadata files. Active reconciliation, retention,
  cleanup, and pruning exclude the entire reserved namespace, and frame
  publication cleans up only operation-owned temporary files. Federation hides
  protected history while decoded content is
  identical and exposes it as conflict history after any later direct-destination
  replacement. Newly created directory hierarchy is also fsynced.
  Authenticated list/read operations federate the active root, any still-mounted
  historical roots, and those conflict namespaces. Startup validates loose,
  gzip, framed, and legacy-bundle representations, non-destructively derives
  frames for non-active roots, binds decoded frame hashes to unchanged
  before/after physical fingerprints, collapses exact
  decoded duplicates, and gives divergent same-ID content stable, content-derived
  public aliases with safe integer sequences. A historical source replaced at the
  former normalization-withdrawal boundary remains readable and retryable. Migration is
  idempotent and retryable across interruption, pre-publication and
  post-verification destination races, file/directory-fsync failure, normalization
  failure, temporary root unavailability, and cross-device copies; bundle bytes
  and metadata publish as one copy group, and retained source roots remain read
  inputs on later startups. Reconciliation, version
  retention, and the global byte budget mutate only the active root's normal
  history tree, so they cannot delete the only copy stranded in a historical
  root or conflict namespace; preservation can therefore leave the tree over
  budget when only protected copies remain. Newly migrated content can initially
  approach three physical copies (source, ordinary destination, and protected
  recovery), with additional retained content and derived frames carried across
  later root moves; only ordinary active representations compact destructively.
  That storage cost is the deliberate no-global-lock safety tradeoff.
  Existing multi-root updater markers remain conservative and continue preserving
  every configured historical root.
- Regression coverage: `server/node/chatBackups.test.ts` covers A→B→default
  merges, active-root capture placement, decoded exact deduplication, divergent
  same-ID frame/loose/gzip/bundle history, restart/reorder/offline-stable aliases,
  bundle-group preservation, independent create-only publication, retained-source
  replacement/retry, and post-migration in-place destination writes for files and
  valid bundles, non-destructive protected frame derivation, loose/bundle
  normalization-boundary peer replacement and stable restart readability,
  reserved-subtree reconciliation exclusion, peer-owned temp collisions,
  ctime-only and decode-to-cache frame replacement races, destination-file and
  new-parent fsync failures,
  normalization-failure readability, interrupted migration and retry,
  symlink-identity avoidance, and retention isolation for a sole historical copy;
  `test/compat/backup-roundtrip.test.ts` performs authenticated list/body reads
  across real A→B and B→default server restarts, verifies the retained marker set,
  and recovers a legacy chat tree when an older server-backup root returns after
  an unavailable restart and a later server-root change.
- Canonical architecture: [backup and recovery](../../../../docs/structure/backup-recovery.md#per-chat-pre-image-history) and [backup roots, updater, Docker, and hub hosting](../../../../docs/structure/backup-recovery.md#backup-roots-updater-docker-and-hub-hosting)

## Original risk (historical)

The environment selected exactly one chat-backup root. Although later marker
hardening retained prior root identities for updater preservation, runtime list
and read operations resolved exclusively under the new root and startup migrated
only one hard-coded legacy location.

Changing the override from volume A to B made every version on A disappear from
the UI while new history began on B. The files initially survived, but an
operator could detach or clean A after believing migration had occurred,
deleting the only pre-image recovery copies.

## Original required fix and coverage (historical)

Read and validate the previous marker before overwriting it, then merge or
migrate history with conflict handling. If migration cannot be automatic, keep
both roots readable and require explicit operator action.

Test A-to-B, B-to-default, conflicts, interruption, and restart visibility.
