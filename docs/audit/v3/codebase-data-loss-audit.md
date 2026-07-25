# Codebase data-loss audit (v3)

- Audit point: `1a7952f1` (branch `serve`, clean tree)
- Prior audits: [v1](../../../.archived-docs/v1/serve-branch-data-loss-audit.md) — 16 findings, all fixed at
  `2e3d4f05` · [v2](../v2/codebase-data-loss-audit.md) — 36 findings, open/deferred
- Current status: **41 new findings** — 6 fatal, 35 warning

## Why v3 exists

Two client bugs shipped after v2 (`c49ecfde`, `1a7952f1`): plugin-storage writes made
during startup were absorbed into the save loop's clean baseline, and inline plugin
reads leaked Svelte `$state` proxies across the V3 iframe's structured-clone boundary.
Both lived in the non-optimized (default) branch of a dual-mode feature. v2's
durability-shaped lens could not have caught either, so v3 swept the whole persistence
surface again under four new lenses, alongside v2's six:

- **L1 dirty-tracking gaps** — writes outside the change trackers' observation window
- **L2 serialization boundaries** — reactive state meeting structured clone / msgpack /
  JSON / postMessage
- **L3 dual-mode divergence** — both states and both transition directions of every flag
- **L4 protective-lockout amplification** — error handling that converts transient
  failure into apparent permanent loss

(Carried over: D1 non-atomic multi-store commits, D2 ack-before-durable, D3 unverified
derivatives, D4 size/shape-only equality, D5 crash windows in swaps, D6
validate-after-destruction.)

## Scope and method

Eight areas swept in parallel by dedicated agents, each with an explicit seam contract
and the v2 index as an exclusion list; every reported finding was re-verified against
the code before documentation (severity adjusted where v2 parity demanded it), followed
by a cross-report completeness critique. v2's open findings are NOT re-listed here;
several v3 findings explicitly extend v2 findings and link them with `Extends:` lines.

1. Client change detection & save scheduling
2. Client↔plugin boundary
3. Client serialization & caches
4. Client↔server sync protocol
5. Server KV core & chat rows
6. Server recovery (backups, snapshots, restore, migration)
7. Server file stores (assets, inlays, GC, dedup)
8. Mode matrix & round-trips (cross-cutting)

Severity: **fatal** = plausible under realistic conditions (ordinary actions, one crash
at the wrong moment, a second tab/device) and loses primary data or renders a recovery
copy silently unusable. **warning** = rarer timing, unusual inputs, or multiple
failures; or degrades recovery depth.

## Fatal findings

| Area | Finding | Lens |
|---|---|---|
| save loop | [Startup-created chats are classified as already durable and commit as row-less stubs](fatal/live-startup-state-can-classify-a-new-chat-as-durable.md) | L1/D2 |
| save loop | [Writes to non-selected characters and non-active chats schedule no save at all](fatal/non-selected-character-and-chat-writes-have-no-save-scheduler.md) | L1 |
| sync | [The chat-row stage is not bound to the stub snapshot it commits](fatal/chat-row-stage-is-not-bound-to-the-committed-stub-snapshot.md) | D1/L2/L4 |
| server core | [WAL + synchronous=NORMAL acknowledges writes before power-loss durability](fatal/sqlite-normal-wal-acknowledges-before-power-loss-durability.md) | D2 |
| recovery | [Legacy/small snapshot restore overwrites the live database before the first full decode](fatal/legacy-snapshot-restore-overwrites-live-db-before-full-decode.md) | D5/D6 |
| round-trips | [HTML chat import reuses the authoritative row ID](fatal/html-chat-import-reuses-the-authoritative-row-id.md) | L3/L4/D1 |

## Warning findings

| Area | Finding |
|---|---|
| save loop | [Pre-tracking baseline capture still omits six save domains](warning/pre-tracking-baseline-capture-still-omits-six-save-domains.md) |
| plugin boundary | [The callback bridge skips stream transfer and remote-class serialization](warning/callback-bridge-skips-stream-transfer-and-remote-class-serialization.md) |
| plugin boundary | [Non-optimized save storage acknowledges before persistence](warning/nonoptimized-save-storage-acks-before-persistence.md) |
| plugin boundary | [Optimized clear() can partially destroy a store](warning/optimized-clear-can-partially-destroy-a-store.md) |
| plugin boundary | [Legacy storage getters conflate valid falsey values with missing](warning/legacy-storage-getters-conflate-valid-values-with-missing.md) |
| plugin boundary | [Failed device-local writes remain visible from cache](warning/failed-device-local-writes-remain-visible-from-cache.md) |
| plugin boundary | [Plugin updates discard configured arguments](warning/plugin-updates-discard-configured-arguments.md) |
| plugin boundary | [Viewer JSON-looking strings change type on save](warning/viewer-json-looking-strings-change-type-on-save.md) |
| plugin boundary | [Viewer read-modify-write is stale and unconditional](warning/viewer-read-modify-write-is-stale-and-unconditional.md) |
| sync | [Rebase promotes the ETag before authoritative state is installed](warning/rebase-promotes-etag-before-authoritative-state-is-installed.md) |
| serialization | [Partial backup clones live Svelte proxies and always fails](warning/partial-backup-clones-live-svelte-proxies.md) |
| serialization | [Persistent JSON acknowledges unrepresentable values](warning/persistent-json-acknowledges-unrepresentable-values.md) |
| server core | [The legacy KV migration marker can outlive the WAL commit](warning/legacy-kv-migration-marker-can-outlive-the-wal-commit.md) |
| server core | [Decoded stream-load spools bypass the configured spool and orphan sweep](warning/decoded-stream-load-spools-bypass-configured-spool-and-orphan-sweep.md) |
| server core | [The boot spool sweep can unlink another instance's active file](warning/boot-spool-sweep-can-unlink-another-instances-active-file.md) |
| recovery | [The chat-version cap collapses from 125 to 100](warning/chat-version-cap-collapses-from-125-to-100.md) |
| recovery | [Global chat budget evicts newer bundles before older loose versions](warning/global-chat-budget-evicts-newer-bundles-before-older-loose-versions.md) |
| recovery | [A wall-clock rollback disables chat pre-image capture](warning/wall-clock-rollback-disables-chat-preimage-capture.md) |
| recovery | [Concurrent server backups share one output path](warning/concurrent-server-backups-share-one-output-path.md) |
| recovery | [Direct flush callers bypass automatic snapshot serialization](warning/direct-flush-callers-bypass-automatic-snapshot-serialization.md) |
| recovery | [Best-effort path markers let updaters delete recovery directories](warning/best-effort-path-markers-let-updaters-delete-recovery-directories.md) |
| file stores | [External dedup can strand or overwrite a live asset](warning/external-dedup-can-strand-or-overwrite-a-live-asset.md) |
| file stores | [The preferred jdupes invocation merges cross-instance ownership](warning/preferred-jdupes-merges-cross-instance-ownership.md) |
| file stores | [Bulk write commits a partial filesystem prefix](warning/bulk-write-commits-a-partial-filesystem-prefix.md) |
| file stores | [Asset filenames collide on case-insensitive filesystems](warning/asset-filenames-collide-on-case-insensitive-filesystems.md) |
| file stores | [The inlay filename mapping is not injective](warning/inlay-filename-mapping-is-not-injective.md) |
| file stores | [Chat-version backups do not keep referenced inlays live](warning/chat-version-backups-do-not-keep-referenced-inlays-live.md) |
| round-trips | [HTML chat round-trip rejects the default empty note](warning/html-chat-round-trip-rejects-the-default-empty-note.md) |
| round-trips | [Disabled-mode snapshots retain newer external plugin rows on restore](warning/disabled-mode-snapshots-retain-newer-external-plugin-rows-on-restore.md) |
| round-trips | [The upstream-compatible backup drops live inlays but keeps their chat references](warning/upstream-compatible-backup-drops-live-inlays-but-keeps-their-chat-references.md) |
| round-trips | [CCv2 export drops regex-lore semantics](warning/ccv2-export-drops-regex-lore-semantics.md) |
| round-trips | [.risup export deletes the auto-suggest prefix and clean policy](warning/risup-export-deletes-auto-suggest-prefix-and-clean-policy.md) |
| round-trips | [Character packages remap chat IDs without remapping inlay metadata](warning/character-package-remaps-chat-ids-without-remapping-inlay-metadata.md) |
| round-trips | [The CharX importer mistakes JSON assets for metadata](warning/charx-importer-mistakes-json-assets-for-metadata.md) |
| round-trips | [Changing the chat-backup root hides all existing version history](warning/changing-chat-backup-root-hides-all-existing-version-history.md) |

## Recurring patterns (fix themes)

- **Dirty state must be computed against the persisted baseline, not live memory.**
  Both save-loop fatals and the six-domain warning share one root: the tracker's first
  observation (or a live-graph seed) is treated as durable truth. One generic
  baseline-diff at tracker installation, plus explicit `markCharacterDirty`/
  `markChatDirty` bridges required on every arbitrary-target mutation surface
  (MCP, V3 setters, viewers), closes the family.
- **Bind multi-step commits to one immutable snapshot.** The chat-row stage, partial
  backup, and concurrent server backups all read live state across awaits.
- **Commit ≠ durable.** `synchronous=NORMAL` needs either FULL, a durable-commit
  contract on acknowledged routes, or an honest label; the migration marker and
  backup-ack paths inherit the same rule.
- **Recovery copies need self-describing ownership markers.** The disabled-mode
  snapshot marker, updater path markers, and chat-backup root transitions all lose
  data because context lives outside the artifact.
- **Never conflate failure or falsiness with emptiness** (L4): legacy `|| null`
  getters, cache-published failed writes, callback hangs, zero-byte JSON rows.
- **Identity is a commit-level invariant.** Duplicate chat IDs (HTML import),
  non-injective inlay filenames, and case-folded asset paths must be rejected or
  remapped at the boundary, not assumed unique.

## Residual risk and coverage gaps (critic pass)

Unaudited surfaces the eight-area partition missed — candidates for a targeted
follow-up sweep:

- **Composer-draft persistence** (`src/ts/storage/chatDraft.ts`): its own prefix
  index, deliberately swallowed write/read errors, an index-failure→empty-set
  fallback, debounced queue with page-hide flush, and a boot deletion sweep. No v3
  area applied L1/L4 here (the open v2 draft-race finding covers only one path).
- **Client-side inlay/asset composition** (`src/ts/process/files/inlays.ts`,
  `inlayMeta.ts`, asset helpers in `globalApi.svelte.ts`): one logical inlay is three
  sequential writes with independently swallowed failures, and reads conflate every
  error with `null`. Area 7 audited the server store, Area 3 the caches; nobody
  audited this composition.
- **Dormant `loadInternalBackup()`** (`globalApi.svelte.ts:2371`): replaces live
  memory from a snapshot key and reports success without a durable commit. No
  production caller at HEAD (orphaned lang strings remain) — a hazard if rewired.

Deliberate exclusion, confirmed still relevant: v3 did not re-sweep v2's
application-logic destructive operations (chat flows, triggers, Lua). The critic
verified the new lenses apply there in ways v2's could not: trigger effects write
`scriptstate`/notes through the *current* selection after async gaps (L1, compare the
non-selected-writes fatal), the Lua/JS (and dormant Python) branches lack serialization
parity guarantees (L2/L3), and trigger JSON helpers persist `''`/`{}`/`null` fallbacks
on parse failure into durable chat state (L4).

Settled during critique: async URL imports have no ordering barrier against tracker
installation (statically settled; folds into the pre-tracking family); the duplicated
`normalizeJSON()` drift (client cycle-guard vs server unguarded recursion) is not
currently wire-reachable as silent hash divergence but violates the lockstep rule;
hub mode leaves portable export/import ungated by design. Unsettled: V3 plugin startup
vs tracker readiness needs a real-browser ordering test; upstream `.bin` → Pocket
compatibility is unproven because `test/fixtures/upstream/upstream-backup.bin` is
absent and the whole compat suite silently skips.

Where an area report's "examined and sound" note conflicts with another area's
finding, the finding supersedes it (three cases: chat-stage completion rules vs the
unbound-snapshot fatal; optimize-transition value equality vs unrepresentable-JSON
ingress; the spool-dir mode-matrix row vs both spool findings — the appendix row
carries a correction note).

The duplicated uncleanables sets have also drifted (server copy omits notification
sounds, module icons, embedded-persona assets; currently stats-only, destructive if
ever reused for cleanup).

## Appendix

- [Boot mutation inventory](appendix/boot-mutation-inventory.md) (Area 1)
- [Plugin host-API serialization sweep](appendix/plugin-api-serialization-sweep.md) (Area 2)
- [Persistence mode matrix](appendix/mode-matrix.md) (Area 8, with critic correction)
- [Test-coverage gap map](appendix/test-coverage-gaps.md) (Area 8)
