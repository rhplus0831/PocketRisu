# Best-effort path markers let updaters delete recovery directories

- Status: Fixed (2026-08-06 remediation queue)
- Owner: backup and recovery
- Source: [2026-07 data-loss audit](../../2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium (at fix time)
- Lens: D2, D5, L4
- Area: Area 6 — server recovery
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../2026-08-revalidation/README.md)
- Resolution: this remediation commit — recovery-root markers now publish
  through private same-directory temporary files with file fsync, atomic rename,
  and platform-aware parent-directory fsync. A post-rename failure restores the
  prior regular marker or invalidates it to keep updaters fail-closed. Server
  startup first publishes a bounded atomic/fsynced quarantine transaction containing
  prior quarantine history, both valid marker histories, and current authoritative
  roots; every updater refuses while it exists. Startup publishes both markers before
  using the configured roots and clears the transaction only after both are durable.
  First/second marker failure is therefore recoverable on a clean restart without
  dropping older custom roots, while corruption or uncertain quarantine publication
  retains the token-owned lock for explicit recovery. The complete
  `/api/backup/server/path` transition and self-update admission share one async
  queue plus a token-owned filesystem lock used by every server/updater process;
  startup publishes both recovery markers under one acquisition before root use,
  path admission durably publishes an old/new path set before KV commit,
  switches live state only afterward, and retains the set so archives left at
  prior roots remain protected. Both roots therefore survive a crash on either
  side of KV commit, KV failure restores the prior set, concurrent PUTs cannot
  overwrite one another's rollback, and an
  admitted self-update retains its locked preservation snapshot. Crash-stale or
  incomplete locks stop fail-closed for explicit operator recovery rather than
  being age/PID-stolen. Markers include distinct lexical and canonical identities
  for symlink aliases; startup retains lexical identities when offline/inaccessible
  history cannot be canonicalized, while updater consumption stays strict. The standalone
  portable updater, source updater, and in-process self-updater require an absent
  startup quarantine and both
  regular, normalized markers and refuse destructive replacement when either is
  missing, unreadable, malformed, or unsafe. Default and genuinely outside-tree
  roots retain their established behavior; every safe in-tree identity is kept with
  filesystem casing and compared platform-appropriately during enumeration. The source
  updater never replaces live `save/`, and Windows standalone/server parents durably
  hand their token to the batch finalizer so exclusion spans bin/version work and is
  released exactly once afterward.
- Regression coverage: `server/node/recoveryPathMarkers.test.ts` covers durable
  publication, multi-root transitions, post-rename rollback, rollback
  invalidation, directory-fsync error policy, safe in-tree preservation,
  quarantine round-trip/clear/corruption refusal,
  canonical symlink identities, case-preserving Windows folding, filesystem-lock
  ownership/handoff/stale-lock refusal, outside-tree acceptance,
  and missing/non-regular/empty/relative/symlink/managed-root refusal;
  `server/node/portableUpdaterRecovery.test.ts` executes the standalone updater's
  early fail-closed marker/lock preflight and a successful mixed-case transition-set
  replacement;
  `server/node/updateScript.test.ts` exercises `update.sh` single/transition-root
  preservation, mixed-case destructive preservation, exact save-window survival/SIGKILL
  behavior, and cross-process exclusion plus
  missing, unreadable, malformed, symlink-alias, and managed-root refusal before
  deletion; `test/compat/backup-roundtrip.test.ts` faults marker
  publication and KV commit, crashes on both sides of KV commit, pauses concurrent
  PUT/self-update admissions, validates canonical alias publication, one-admission
  first/second-marker startup failure, real updater refusal, clean-startup history
  recovery, successful portable/source replacement preserving an older custom root,
  quarantine-publication lock retention, corrupted-quarantine refusal, startup fallback with
  retained inaccessible history, a live standalone-updater/PUT overlap, and Windows
  post-step handoff while mixed-case recovery archives remain intact.
- Canonical architecture: [backup and recovery](../../../../docs/structure/backup-recovery.md#backup-roots-updater-docker-and-hub-hosting) and [server backend](../../../../docs/structure/server-backend.md)

## Original risk (historical)

Custom in-tree server- and chat-backup roots survived updates only through marker
files under `save/`. Marker writers swallowed all failures; the backup-path API
committed the new configuration and reported success even when publication failed.
The standalone updater also treated any marker read error as absence.

Both updaters preserved only hard-coded roots when the marker was absent, moved
other top-level entries into update-temporary storage, and deleted that tree after
success. A configured `data/backups` directory could thus be classified as debris
and permanently removed along with every recovery archive.

## Original required fix and coverage (historical)

Make atomic, fsynced marker publication part of accepting an in-tree path and
roll back configuration on failure. Updaters must abort on missing or unreadable
preservation metadata when a custom path may exist.

Fault marker creation/read and assert both updater paths preserve the archives.
