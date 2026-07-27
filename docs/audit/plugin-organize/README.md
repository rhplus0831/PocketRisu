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

## Consolidated validation evidence and scope

The composed implementation is fixed and verified. Composition testing found
and repaired issues that were not visible in the source branches: strict restore
acknowledgements, fallback across unreadable/corrupt candidates, legacy chunk
upgrade recovery, strict block/REMOTE decoding, viewer revision-CAS mutations,
bounded owner-index rebuilding, abandoned import-barrier reads, partial-export
create/DELETE, import-wait, and TTL races, client stream cleanup, and the real
E1+E2 export path. Verification was repeated after each repair.

| PM3 item | Effective commits | Representative production-path gate |
|---|---|---|
| R1 corrupt boot | `44c73095`, `e8a58ad5` | unreadable/corrupt newest snapshot, valid older snapshot, exact older chat after restart, no candidate `/api/read` |
| R2 ownership proof | `973177aa` | exactly eight 7 MiB current rows, one logical row scope, unmarked zero-body proof, disconnect rollback |
| R3 restore spool/integrity | `0e5b7875`, `e8a58ad5` | asynchronous parts of at most 64 KiB, corrupt legacy publication does not brick startup, 52 MiB mid-spool abort |
| R4 bounded compatibility decode | `c246028b`, `e8a58ad5` | gzip/zlib limits and cancellation; malformed inline and REMOTE-resolved character blocks roll back |
| R5 shared restore API | `89aff392`, `68621c86`, `e8a58ad5` | HTTP 200 plus exact four-field echoed-key acknowledgement; explicit rollback fallback; unknown outcome is never retried |
| V1 point-in-time viewer | `fc51fe5a`, `68621c86` | real 10,000-row publication, 50-row page, stale edit/delete CAS rejection, backpressure and import-wait abort |
| E1 partial-export lifecycle | `892d6eed`, `5b8db647`, `9f4e96e3`, `76fb1cbf` | lost-create cancellation tombstone, held-import cancellation with pre-release spool cleanup and replacement admission, stalled-download TTL cleanup, sink-setup cancellation, immutable asset/database pins |
| E2 legacy special-key export | `a60e175e`, `9f4e96e3` | real export/decode/import with 3 MiB own `__proto__` value, 2 MiB metadata, reserved-field collision, and selected asset |
| R6 bounded import ingress | `f1931989` | finite archive/ZIP/expanded/legacy/entry/row limits; private paged disk staging; ZIP integrity checks; disconnect-safe barrier acquisition; exact NDJSON errors and heartbeats; 52 MiB, exact/+1, rollback/restart, and orphan-cleanup gates |
| R6 terminal-loss follow-up | `86d2a0b7`, `77eac26a` | strict heartbeat/progress/done/error schemas; malformed, missing, status-zero, or post-dispatch transport loss becomes non-retryable commit-unknown; exact committed-with-error and unknown outcomes warn then reload; one request with no replay |

The viewer bound is one page of at most 50 logical rows. A chunked logical row
may still be synchronously reassembled, page tokens bind the selected page (not
every off-page body), and server cancellation is observed between rows and
during backpressure. Tests cover load supersession, coordinator disposal,
body/post-EOF hashing aborts, and an abandoned request waiting behind an import.
Save-backed UI edit, single delete, and filtered delete use exact row revisions;
the filtered operation is one atomic page-sized batch. Explicit unfiltered
clear-all retains its dedicated whole-publication primitive.

Restore spooling reads raw/chunk publications in sequential parts of at most
64 KiB. Body-producing reads and restore spooling verify content hashes; size,
list, status, cost, and copy paths enforce the publication guard and structural
length metadata but do not independently hash every same-size body. Formats
without a safe cursor use a finite full-memory compatibility path. The 64 MiB
legacy setting is a serialized-source/cumulative-decoded-payload cap, not a
resident-heap ceiling, and the final committed stripped database is read and
decoded through the ordinary full database path.

Partial export reserves one global job slot, not a byte allocation. Capacity is
preflighted when filesystem capacity is available, and the configured database
spool may share the save volume or use another volume. TTL, disconnect, normal
completion, failure, cancellation, and startup orphan recovery remove private
artifacts; cleanup is best-effort with startup retry. E2 instrumentation proves
at most one escape-row read is active and that the spool advances before the
next escape read; it is not an RSS/heap ceiling.

R6 extends the bounded PM3 boundary to backup archive and save-folder ingress.
Its 64 KiB page instrumentation, finite byte/entry limits, and private-spool
cleanup prove bounded reads and staging behavior, not a global resident-heap
ceiling. Supplemental client verification for `86d2a0b7` and `77eac26a`
passed 51 focused backup-terminal/UI-policy tests and the full client suite
(1,543 passed, 3 skipped), plus type checking, production build, and complete
EN/KO help-key audits. The committed-error cases prove that both destructive UI
callers warn then hard-reload an explicitly committed replacement without
replay; the unknown cases prove conservative client classification, not that a
lost network acknowledgement reveals whether the server committed. Details
and final verification counts are recorded in
[Performance and memory](performance-memory.md#pm3-r6-bounded-import-ingress),
with the restore transport contract cross-referenced from
[Backup, snapshot, and recovery](backup-recovery.md#pm3-r6-import-recovery-follow-up).

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
