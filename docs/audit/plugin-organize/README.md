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
| [SA2](startup-availability.md#sa2) | High | Fixed | One process-wide unbounded storage queue: a single stalled operation wedges every plugin and the mode transition |
| [SA3](startup-availability.md#sa3) | Medium | Fixed | A reconciliation failure on boot prevents the whole application from loading |
| [SA4](startup-availability.md#sa4) | High impact, window-dependent | Fixed | Import and retry failures abort startup or expose uncommitted state to optimized reads |
| [AA1](atomicity-acknowledgement.md#aa1) | Medium | Fixed | Value and owner metadata are separate commits; a rejection can follow a durable primary mutation |
| [AA2](atomicity-acknowledgement.md#aa2) | Medium | Fixed | Optimized `clear()` can partially apply |
| [AA3](atomicity-acknowledgement.md#aa3) | High | Fixed | No batch/transaction/CAS primitive: the one-second unload deadline can terminate a multi-row commit, leaving a torn but durable generation |
| [BR1](backup-recovery.md#br1) | Medium | Fixed | Optimized-only mutations never advance automatic recovery snapshots |
| [BR2](backup-recovery.md#br2) | Medium | Fixed | Cross-mode snapshot ownership is ambiguous: unmarked just-disabled snapshots and no storage generation |
| [BR3](backup-recovery.md#br3) | Medium | Fixed | Corrupt-database boot fallback ignores a marked snapshot's exact plugin-row set |
| [BR4](backup-recovery.md#br4) | Medium | Fixed | Valid long keys produce Node backups the same server refuses to import |
| [PM1](performance-memory.md#pm1) | Medium | Fixed | Large plugin values bypass chunking and incur multiple full-size client/server copies |
| [PM2](performance-memory.md#pm2) | Medium | Fixed | Mode transitions are not memory-bounded in either direction; the UI guards on entry count only |
| [PM3](performance-memory.md#pm3) | Medium | Fixed | Viewer, partial backup, and snapshot restore eagerly rematerialize the whole external store |
| [PM4](performance-memory.md#pm4) | Medium | Fixed | Batch writes now use compact CAS, donated bytes, server hashes, one cache transaction, and amortized pruning |
| [IP1](integration-patterns.md#ip1) | High | Fixed | Treating a failed read as a missing key turns transient I/O errors into destructive whole-value overwrites |
| [IP2](integration-patterns.md#ip2) | High | Fixed | Remove-then-rewrite maintenance flows durably delete rows mid-sequence and report success |
| [IP3](integration-patterns.md#ip3) | Medium | Fixed | Swallowed mutation failures desynchronize plugin caches and success counters from durable server state |
| [IP4](integration-patterns.md#ip4) | Medium | Fixed | Reused sub-row keys with manifest-last publishing let an old manifest resolve to newer bodies; loaders do not verify generations |
| [IP5](integration-patterns.md#ip5) | Medium | Fixed | Uncancelled long-running plugin-side migrations without CAS overwrite newer rows after their watchdog reports a timeout |

The IP items describe plugin-side coding patterns that only become unsafe once
the beta turns local map operations into independent, fallible, durable server
commits. They are integration findings: the host cannot fix existing plugin
code on its behalf. AA3 supplies bounded versioned reads and atomic batch/CAS;
IP1 now adds explicit failed-read results, guarded single-key CAS helpers, and
public migration guidance. IP2 adds the public one-SET `rewriteItem()`
primitive and confirmed-outcome guidance needed to replace destructive
REMOVE→SET maintenance. IP3 adds public structured mutation outcomes plus a
confirmed-removal workflow. IP4 adds a public immutable-generation helper and
verified load/publication/cleanup protocol. IP5 adds a cancellable,
mutex-bound one-row update primitive, public types, migration guidance, and
end-to-end race coverage. Existing third-party plugins must adopt those safe
protocols.

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

The current passing suites cover happy-path key transport, mode-aware V3
database/storage mixing, startup readiness and timeout behavior, transition
ordering, key validation and canonical enumeration, server ingest, import
barriers, atomic value/owner mutation, atomic clear and batch/CAS outcomes,
unload admission/draining, failpoint rollback, acknowledgement loss, and
old-or-new state after a real server restart. PM2 additionally covers the
production save loop and staged transition path with a 56 MiB Unicode store,
forced-GC checkpoints, PM1 chunks, and the resource cache both off and on.
PM3 covers one-page viewer loading, generation-owned partial folding, async
64 KiB raw/chunk file-cursor restore, and a folded-marker-only live ownership
proof that validates
one current row at a time before any exact-set deletion. Its 56 MiB production
restore case proves a one-row scope with forced GC, while unmarked streams read
zero ownership bodies and disconnect cancellation rolls back before deletion.
PM2 private stages remain invisible and source-invalidated by restore, and PM4
rejects the pre-restore manifest token while accepting the fresh token. Corrupt
boot also uses an import-safe metadata-only snapshot list and direct server
restore: a 64 MiB newer-invalid/older-valid pair proves that candidate bodies
never cross the browser `/api/read` boundary and that the exact older chat
survives restart. Versioned publication-integrity guards cover every
read/size/copy path, thresholds are clamped, and a 52 MiB mid-spool socket abort
proves keep-alive listener cleanup and exact restart durability after
cancellation or corrupt-chunk rejection. Its restore coverage also includes
bounded/cancellable gzip and zlib output, legacy memory and disk
headroom caps, stable pre-commit 400/413 classification, and recursive REMOTE
size-before-read metering with duplicate caching, cycle/depth rejection, strict
missing/read failures, exact requested-target publication, and save-folder
rollback. BR3 boot fallback tries an older candidate only after explicit
known-not-committed proof; unclassified, transport-ambiguous, and post-commit
failures stop conservatively.
PM4 additionally covers compact manifest CAS, exact server value hashes,
50-row snapshot reuse, canonical manifest-key validation and cancellation,
donated 128-row and four-by-2-MiB batches, one IndexedDB mutation transaction,
bounded real inventory scans, and versioned reads held across a late-failing
streamed import. PM2 staged receipts are exact and plan-bound, and downloaded
private rows are checked against their advertised SHA-256 before publication;
status refresh cannot consume a matching but tentative import publication.
Immutable-generation coverage also verifies exact repository lineage,
complete-body fallback, corruption rejection, protected garbage collection,
and every body/manifest/head publication boundary.
Cancellable migration coverage additionally verifies deadlines and stale CAS,
post-publication acknowledgement loss, teardown publication draining, and
invocation-scoped unload capabilities.
The original consolidated validation gaps are now covered, including the
production save loop, exact marked-snapshot restore, backup key boundaries,
large transition memory, corrupt-row recovery, and read-failure fallbacks.

## Original recommended fix order

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
6. **Bind lifecycle, parity, and capacity** (AC2, AC4, MT3, SA3, PM4):
   awaited unload before eligibility, JSON/enumeration/special-key parity,
   isolated boot reconciliation failures, and remaining write amplification.
7. **Publish integration guidance and primitives** (IP1–IP5): typed
   missing/failed read outcomes, per-key revisions/CAS, atomic batch, and a
   non-destructive invalidate/rewrite operation.

The former compatibility, startup, mutation, primary recovery, transition
capacity, and tooling-memory blockers MT1–MT3, AC1–AC4, SA1–SA4, AA1–AA3,
BR1–BR4, PM1–PM4, and IP1–IP5 are fixed and covered. The AA3 primitives, IP4
generation helper, and IP5 revision-safe update path make safe compound-write
protocols possible, but do not automatically rewrite existing third-party
plugin data layouts. Verify a backup before transitions and migrate legacy
integrations to the documented contracts.
