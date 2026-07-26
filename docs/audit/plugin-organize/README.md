# "Optimize plugin memory usage" (beta) — consolidated enabled-mode issue list

- Compiled: 2026-07-26, audit point `6795470b` (`serve`)
- Method: consolidated from an enabled-mode compatibility audit of the
  codebase and write-path audits of three real plugin workloads, with
  duplicate findings merged. Plugin identities, plugin file paths, and
  plugin-owned key names are intentionally omitted; workloads are described
  only by shape.
- Status: all listed findings are **open** at the audit point.

## Scope rule

A finding is included only if it requires the beta to be enabled. That covers:

1. steady-state behavior while `optimizePluginMemory` is true;
2. the enable and disable transitions themselves; and
3. state that only exists because the beta was enabled at some point
   (external `pluginsave/` / `pluginsave-meta/` rows, folded-snapshot markers).

Issues that reproduce with the beta off were reviewed and excluded; they are
listed with rationale in [Excluded findings](#excluded-findings).

## Master index

`Status` reflects remediation after the original audit point.

| ID | Severity | Status | Finding |
|---|---|---|---|
| [MT1](mode-transition-data-loss.md#mt1) | High | Fixed | Disabling the beta can delete external rows after a save that never durably committed |
| [MT2](mode-transition-data-loss.md#mt2) | High | Fixed | The mode flag changes outside the storage queue, so queued operations run against the wrong backend and reconciliation overwrites or resurrects values |
| [MT3](mode-transition-data-loss.md#mt3) | Medium | Fixed | Special property names survive optimized storage but are lost or misread when internalized into the inline object backend |
| [AC1](api-compatibility.md#ac1) | High | Fixed | V3 database access and mode-aware plugin storage form a split-brain store; the eligibility gate checks only API version |
| [AC2](api-compatibility.md#ac2) | Medium | Fixed | V2 lifecycle gaps: eligibility races unload completion, and invalid persisted states look enabled but never run |
| [AC3](api-compatibility.md#ac3) | High on affected runtimes | Fixed | Unguarded ES2024 key validation disables optimized storage on older WebViews; key coercion differs between modes |
| [AC4](api-compatibility.md#ac4) | Low–Medium | Fixed | Value and enumeration parity gaps: unrepresentable JSON is acknowledged, and key order is unstable |
| [SA1](startup-availability.md#sa1) | High | Fixed | V3 startup is reported complete before async initialization settles; a slow or rejected optimized read silently prevents registration |
| [SA2](startup-availability.md#sa2) | High | Open | One process-wide unbounded storage queue: a single stalled operation wedges every plugin and the mode transition |
| [SA3](startup-availability.md#sa3) | Medium | Open | A reconciliation failure on boot prevents the whole application from loading |
| [SA4](startup-availability.md#sa4) | High impact, window-dependent | Fixed | Import and retry failures abort startup or expose uncommitted state to optimized reads |
| [AA1](atomicity-acknowledgement.md#aa1) | Medium | Open | Value and owner metadata are separate commits; a rejection can follow a durable primary mutation |
| [AA2](atomicity-acknowledgement.md#aa2) | Medium | Fixed | Optimized `clear()` can partially apply |
| [AA3](atomicity-acknowledgement.md#aa3) | High | Open | No batch/transaction/CAS primitive: the one-second unload deadline can terminate a multi-row commit, leaving a torn but durable generation |
| [BR1](backup-recovery.md#br1) | Medium | Open | Optimized-only mutations never advance automatic recovery snapshots |
| [BR2](backup-recovery.md#br2) | Medium | Open | Cross-mode snapshot ownership is ambiguous: unmarked just-disabled snapshots and no storage generation |
| [BR3](backup-recovery.md#br3) | Medium | Open | Corrupt-database boot fallback ignores a marked snapshot's exact plugin-row set |
| [BR4](backup-recovery.md#br4) | Medium | Fixed | Valid long keys produce Node backups the same server refuses to import |
| [PM1](performance-memory.md#pm1) | Medium | Open | Large plugin values bypass chunking and incur multiple full-size copies while holding the global lock |
| [PM2](performance-memory.md#pm2) | Medium | Open | Mode transitions are not memory-bounded in either direction; the UI guards on entry count only |
| [PM3](performance-memory.md#pm3) | Medium | Open | Viewer, partial backup, and snapshot restore eagerly rematerialize the whole external store |
| [PM4](performance-memory.md#pm4) | Medium | Open | Write amplification: two HTTP mutations per logical write, repeated cache hashing and pruning, and ~2N-request enumeration |
| [IP1](integration-patterns.md#ip1) | High | Open | Treating a failed read as a missing key turns transient I/O errors into destructive whole-value overwrites |
| [IP2](integration-patterns.md#ip2) | High | Open | Remove-then-rewrite maintenance flows durably delete rows mid-sequence and report success |
| [IP3](integration-patterns.md#ip3) | Medium | Open | Swallowed mutation failures desynchronize plugin caches and success counters from durable server state |
| [IP4](integration-patterns.md#ip4) | Medium | Open | Reused sub-row keys with manifest-last publishing let an old manifest resolve to newer bodies; loaders do not verify generations |
| [IP5](integration-patterns.md#ip5) | Medium | Open | Uncancelled long-running plugin-side migrations without CAS overwrite newer rows after their watchdog reports a timeout |

The IP items describe plugin-side coding patterns that only become unsafe once
the beta turns local map operations into independent, fallible, durable server
commits. They are integration findings: the host cannot fix them alone, but the
listed host primitives (typed errors, CAS, batch, non-destructive invalidate)
are what would make the patterns safe.

## Intentional enabled-mode behavior (not defects)

- **V2 and V2.1 plugins do not function while the beta is enabled.** Their
  synchronous storage API reads the inline map and cannot be redirected to
  asynchronous server storage. Imports arrive disabled and enable attempts are
  blocked. This is deliberate; the lifecycle gaps around the rule are AC2.
- **Storage failure becomes observable.** Server, session, auth, and network
  errors now reject calls that were previously local object operations. The
  host cannot make plugin error handling safe on its behalf, but it should
  provide typed missing/transient/committed-unknown outcomes, bounded retries,
  and diagnostics (see SA4, IP1).

## Excluded findings

Reviewed during the audit but excluded here because they reproduce with the
beta disabled:

- **Two historical regressions** — an iframe `DataCloneError` from a
  reactive-proxy return, and startup inline writes lost before save effects
  installed: both affected builds with the beta off, and both are fixed
  (`1a7952f1`, `c49ecfde`).
- **Compound read/modify/write last-write-wins** between concurrent plugin
  tasks operating on the same logical record: the lost-update race exists in
  both storage modes; the beta only widens the window. The host-side ask
  (per-key CAS/batch) is already carried by IP1/AA3.
- **Plugin-owned retention and namespace defects** observed while auditing the
  workloads (rows that are never deleted being reapplied on load; cleanup
  routines treating a shared key-namespace prefix as plugin-owned): both
  reproduce with the beta off.
- [`nonoptimized-save-storage-acks-before-persistence.md`](../v3/warning/nonoptimized-save-storage-acks-before-persistence.md):
  non-optimized mode by definition.

## Fixed enabled-mode regressions (historical context)

These were introduced with the feature and are already fixed at the audit
point. They matter for triaging reports from older builds, not as open work.

| Behavior | Fix |
|---|---|
| Backup transport initially mishandled external plugin rows | `dd678e00` |
| Partial backups claimed to include plugins while omitting external rows | `e15ce99b` |
| Automatic snapshots omitted optimized rows entirely | `babe343c` |
| UTF-8 key conversion collapsed distinct lone-surrogate keys onto U+FFFD and overwrote values during migration | `0da9d553` |
| Folded/imported databases relied on a later browser migration, with high memory use and inconsistent recovery | `93e1dd4f` |

## Consolidated validation gaps

The passing suites at the audit point cover happy-path key transport,
single-threaded migration ordering, key validation, server ingest, and
steady-state backup folding. They do not exercise:

- a real V3 iframe plugin mixing `getDatabase()` with `pluginStorage`;
- delayed or rejected guest initialization before provider/hook registration;
- the production save loop as the reconciliation durability callback
  (pre-initialization no-op, in-flight save join, 409/500/network failure);
- operations queued during the disable-path count request, or concurrent
  operations during any mode toggle;
- delayed V2 unload callbacks racing eligibility;
- a never-resolving fetch or IndexedDB transaction under the global queue;
- a WebView without `String.prototype.isWellFormed()`;
- plugin reads and writes during a held or rolled-back import;
- value-success/owner-failure acknowledgement, and partial prefix clear;
- unload terminated at intermediate positions of a multi-row commit;
- plugin-only automatic snapshot cadence;
- marked-snapshot restore through the corrupt-database boot fallback;
- key-length boundaries for backup export/import symmetry;
- a very large individual value or aggregate store (including transition
  memory, with the resource cache on and off);
- read failure followed by a fallback-derived overwrite;
- key order parity between modes; and
- corrupt-row boot recovery.

## Recommended fix order

1. **Stop destructive disable transitions** (MT1, MT2): add an exact-snapshot
   durability outcome and make the mode change one locked transaction.
2. **Correct the compatibility claim** (AC1): make V3 database storage access
   mode-aware or block the beta for plugins using that capability.
3. **Make startup observable and portable** (SA1, SA2, SA4, AC3): guest
   ready/error handshake, bounded I/O, structured retryable errors, import
   barriers on reads, and a key-validation fallback.
4. **Make mutation outcomes atomic and unambiguous** (AA1–AA3): value+owner in
   one transaction, atomic prefix clear, batch/CAS, and an unload deadline that
   does not tear in-flight storage work.
5. **Repair recovery semantics** (BR1–BR4): plugin-mutation snapshot triggers,
   generation/ownership markers, exact-set boot-fallback restore, and
   symmetric key limits.
6. **Bind lifecycle, parity, and capacity** (AC2, AC4, MT3, SA3, PM1–PM4):
   awaited unload before eligibility, JSON/enumeration/special-key parity,
   isolated boot reconciliation failures, and bounded/streamed large-value
   paths.
7. **Publish integration guidance and primitives** (IP1–IP5): typed
   missing/failed read outcomes, per-key revisions/CAS, atomic batch, and a
   non-destructive invalidate/rewrite operation.

Until MT1–MT2, AC1, SA1–SA2, SA4, and AC3 are fixed and covered by
browser-level tests, the beta should not be described as compatible with all
V3 plugins. Operationally: create and verify a backup before changing the
setting, quiesce plugin work before disabling it, and avoid toggling the mode
repeatedly as a troubleshooting step.
