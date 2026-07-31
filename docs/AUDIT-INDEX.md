# Audit findings — priority index

Indexed 2026-07-27 from the 60 findings in [`docs/audit/`](audit/). The
`Status` column uses `Open`, `Fixed`, `Deferred`, or `Intentional documented limitation`;
36 findings are currently `Open`, 22 are `Fixed`, 1 is `Deferred`, and 1 is an
`Intentional documented limitation`. Per-document severities are 15 High, 38 Medium, and 7 Low, but this
index re-ranks them by the criteria below, so a finding's tier here can differ
from its own severity label (the tier is the priority signal; the label is kept
as a cross-reference).

Ranking criteria, in order of importance:

1. **Whether the issue can cause data loss, and how extensive the loss could be.**
2. **How likely or frequently the issue is expected to occur.**
3. **For issues with no data-loss risk, how severely they harm the user experience.**

Tier definitions derived from those criteria:

| Tier | Meaning |
|---|---|
| P1 | Extensive live-data loss (whole dataset, whole database state, or bulk media) with realistic everyday triggers |
| P2 | Serious live-data loss in a bounded scope (a chat, images, plugin data, session edits) with realistic triggers |
| P3 | Live-data loss confined to narrow conditions (crash windows, small races, compatibility callers, ops tooling, unusual platforms) |
| P4 | Loss of recovery copies and safety nets only — live data survives, but a later incident becomes unrecoverable |
| P5 | Silent interchange/export fidelity loss — originals survive unless the export was the migration vehicle |
| P6 | No data-loss risk — user-experience and correctness harm |

P4 sits below P3 because these findings do not destroy primary data by
themselves; they require a second, independent incident to turn into
user-visible loss. The exception — backup incompleteness that silently loses
data even on a *successful* migration — is ranked as live-data loss (see
`recovery-copies-omit-mcp-tool-call-payloads` in P2).

Ordering **within** a tier is approximate: extent first, then likelihood.
Per `STRUCTURE.md`, treat every finding as historical evidence — verify its
resolution against current code before acting on it.

## P1 — Extensive live-data loss, realistic triggers

| Finding | Status | Doc sev. | What could be lost | Trigger / likelihood |
|---|---|---|---|---|
| [install.sh can delete the only data copy](audit/install-script-can-delete-the-only-data-copy.md) | Fixed | High | The entire dataset — database, chats, assets, inlays, and all backups — held as the only copy under an unconditional `rm -rf` EXIT trap | Any failure during an overwrite install (ENOSPC on tmpfs is realistic); the prompt promises data is preserved, so users don't copy first |
| [Patch conflict promotes ETag, enables stale full write](audit/patch-conflict-etag-promotion-enables-stale-full-write.md) | Fixed | High | Whole server database replaced by a stale client image; chat rows created since the client's baseline deleted in the same transaction | Ordinary multi-tab/multi-device use, or any restore/import while another tab is open — every patch-hash 409 escalates to a force-push |
| [SQLite NORMAL WAL acks before power-loss durability](audit/sqlite-normal-wal-acknowledges-before-power-loss-durability.md) | Fixed | High | All transactions committed since the last WAL checkpoint, including chat rows and full writes already treated as durable | Host crash or power loss — a routine event for the homeserver audience |
| [Acknowledged patches are not durable](audit/acknowledged-patches-are-not-durable.md) | Deferred | High | Up to 5 s of acknowledged metadata; sharpest case: a whole new chat (row orphaned, later swept) | Any server crash; fatal handlers exit **without flushing**, so any server-side bug converts to loss of acknowledged writes |
| [Inlay orphan scan classifies referenced inlays as deletable](audit/inlay-orphan-scan-classifies-referenced-inlays-as-deletable.md) | Fixed | High | Bulk permanent deletion of chat-referenced images (no trash; inlays absent from DB-only snapshots) | The feature invites it: after boot nearly every chat inlay counts as orphaned until its chat is opened; confirming the orphan filter deletes referenced media |
| [Boot asset GC deletes plugin-owned assets](audit/boot-asset-gc-deletes-plugin-owned-assets.md) | Fixed | High | Every asset stored via the supported plugin `saveAsset` API, permanently; only recovery is an earlier full backup | Automatic, 5 s after **every** boot, for any plugin persisting asset paths in its storage |
| [Send-input race replaces another chat's history](audit/send-input-race-replaces-another-chats-history.md) | Fixed | High | One chat's entire message history overwritten by another's; pre-image may be cooldown-skipped, making it unrecoverable | Switching chats while input triggers/`editinput` scripts run on send; cards can stretch the window arbitrarily |
| [Reroll failure restores into the current chat](audit/reroll-failure-restores-into-the-current-chat.md) | Fixed | High | The currently selected chat's entire history overwritten with the rerolled chat's; the rerolled chat stays truncated | Switching chats during generation, then abort or failure — chat switching is unguarded during generation |

## P2 — Serious bounded live-data loss, realistic triggers

| Finding | Status | Doc sev. | What could be lost | Trigger / likelihood |
|---|---|---|---|---|
| [Chat-row stage not bound to committed stub snapshot](audit/chat-row-stage-is-not-bound-to-the-committed-stub-snapshot.md) | Open | High | A whole chat: stub committed without its row (404 placeholder), or a durable row orphaned and swept after the grace period | Chat created during a slow row POST; client loss after a partial commit |
| [Live startup state can classify a new chat as durable](audit/live-startup-state-can-classify-a-new-chat-as-durable.md) | Fixed | High | A whole chat created at startup commits as a stub with no row; refresh loses its messages | Synchronous V2/V2.1 plugin startup writes; bootstrap chat-ID repair is an organic non-plugin trigger |
| [HTML chat import reuses the authoritative row ID](audit/html-chat-import-reuses-the-authoritative-row-id.md) | Fixed | High | New work in the imported duplicate chat silently vanishes after save and reload (two chats share one row) | Importing an exported HTML chat back into its source character |
| [Recovery copies omit MCP tool-call payloads](audit/recovery-copies-omit-mcp-tool-call-payloads.md) | Fixed | High | Every remembered tool call's arguments and responses, permanently, once the original database is gone; request history silently degrades | Any portable-backup migration to a fresh instance for MCP users — the primary purpose of portable backups; masked on same-instance restores |
| [Inlay replacement unlinks before publish](audit/inlay-replacement-unlinks-before-publish.md) | Fixed | High | Each affected image destroyed (old payload unlinked before the new one is written); bulk compression converts ENOSPC into mass loss reported as success | Crash/power loss during an inlay overwrite; running compression on a nearly full disk — exactly when users run it |
| [Reroll discards the only copy within pre-image cooldown](audit/reroll-discards-the-only-copy-within-preimage-cooldown.md) | Open | High | The discarded response and its entire swipe history | Normal reroll timing (recent save already consumed the capture cooldown) plus tab close, crash, or failed completion before generation ends |
| [Card triggers can bulk-delete history without consent](audit/card-triggers-can-bulk-delete-history-without-consent.md) | Open | Medium | The entire message array, wiped and persisted; cooldown can skip the pre-image, making it permanent | Requires a malicious or buggy imported card — but importing shared cards is routine and no consent gate covers bulk chat mutation |
| [Chat deletion has no pre-image history](audit/chat-deletion-has-no-preimage-history.md) | Fixed | Medium | A young chat (created, saved once, deleted) leaves no recovery copy anywhere | Accidental deletion of a recently created chat — the exact case the chat-version feature exists to undo |
| [Non-selected character and chat writes have no save scheduler](audit/non-selected-character-and-chat-writes-have-no-save-scheduler.md) | Fixed | High | Acknowledged edits to non-selected characters and inactive chats silently reverted on refresh | V3 arbitrary-index setters, Risu-access MCP mutations, background writes; no dirty bridge exists for these targets |
| [Plugin updates discard configured arguments](audit/plugin-updates-discard-configured-arguments.md) | Fixed | Medium | API keys, endpoints, models, large prompts, and enablement — reset and immediately persisted | The ordinary plugin Update button; every update |
| [Partial block decode becomes authoritative](audit/partial-block-decode-becomes-authoritative.md) | Open | Medium | Blocks still intact on disk are permanently discarded once the partial decode is cached and re-encoded | Requires one corrupted block first; the response then amplifies corruption instead of failing over to recovery copies |
| [Rebase promotes ETag before authoritative state installs](audit/rebase-promotes-etag-before-authoritative-state-is-installed.md) | Fixed | Medium | Another client's characters and stubs replaced, their rows deleted, via a stale forced write | Mid-rebase failure (fetch/decode/install), then a forced full write; plugin-memory reconciliation is a production caller of forced writes |
| [Save loop idles after five failures](audit/save-loop-idles-after-five-failures.md) | Open | Medium | All queued unsaved edits if the tab closes after the loop goes idle | Five consecutive save failures (a network outage) with no new edit afterwards; nothing restarts the loop on reconnect |
| [Pre-tracking baseline capture omits six save domains](audit/pre-tracking-baseline-capture-still-omits-six-save-domains.md) | Open | Medium | Boot-time mutations (ID repairs, migrations, URL module imports) absorbed as the clean baseline and left memory-only | Every boot that mutates an untracked domain; bot presets and modules are sharpest because unrelated saves don't rescue them |
| [Non-optimized plugin save storage acks before persistence](audit/nonoptimized-save-storage-acks-before-persistence.md) | Open | Medium | Plugin state writes acknowledged, then reverted after refresh | Default inline mode resolves before any save is attempted; page loss inside the window |

## P3 — Live-data loss under narrow conditions

| Finding | Status | Doc sev. | What could be lost | Trigger / likelihood |
|---|---|---|---|---|
| [Backups omit drafts and imports delete them](audit/backups-omit-drafts-and-imports-delete-them.md) | Fixed | Medium | Every unsent composer draft | Every backup restore/import cleared the `drafts/` prefix; no backup path included it |
| [RISUP export deletes auto-suggest prefix and clean policy](audit/risup-export-deletes-auto-suggest-prefix-and-clean-policy.md) | Fixed | Medium | Two configured preset fields, deleted from the **live** in-memory preset and omitted from the archive | Deterministic on every `.risup` export — the export path mutates the live preset |
| [Unmigrated KV inlays omitted from backups](audit/unmigrated-kv-inlays-are-omitted-from-backups.md) | Open | Medium | KV-fallback inlays absent from every archive; a restore then deletes the live copy | Requires a skipped/failed entry in the one-time migration; the loss lands on any later restore |
| [Interrupted inlay migration discards the source row](audit/interrupted-inlay-migration-discards-the-source-row.md) | Open | Medium | One inlay: the valid KV source deleted in favor of a torn file | Crash inside the one-time migration window, then next-boot resume |
| [Legacy KV migration marker can outlive the WAL commit](audit/legacy-kv-migration-marker-can-outlive-the-wal-commit.md) | Open | Medium | Whole database hidden (empty DB served); hex sources survive on disk for manual recovery | Power loss during the legacy hex-to-SQLite migration |
| [Boot asset GC races concurrent publication](audit/boot-asset-gc-races-concurrent-publication.md) | Fixed | Medium | Single assets uploaded from another tab/device, deleted mid-publication | Boot plus concurrent activity on another device; bounded window |
| [External dedup can strand or overwrite a live asset](audit/external-dedup-can-strand-or-overwrite-a-live-asset.md) | Open | Medium | Canonical asset path left absent after a crash; a race can replace a live inode | Running `scripts/dedup-assets.sh` against live servers (it claims to be safe); directly relevant to the multi-instance hardlink-dedup plan |
| [Preferred jdupes merges cross-instance ownership](audit/preferred-jdupes-merges-cross-instance-ownership.md) | Open | Medium | Assets unreadable/unexportable for one instance after ownership collapses onto another's inode | Root cron dedup across per-user instances |
| [Boot spool sweep can unlink another instance's active file](audit/boot-spool-sweep-can-unlink-another-instances-active-file.md) | Open | Medium | Another instance's active snapshot spool; automatic snapshots silently lose their recovery point | Shared spool volumes in multi-instance deployments |
| [Asset filenames collide on case-insensitive filesystems](audit/asset-filenames-collide-on-case-insensitive-filesystems.md) | Open | Medium | One of two case-distinct assets silently replaced | Restore/import on default macOS/Windows volumes with case-colliding names |
| [Inlay filename mapping is not injective](audit/inlay-filename-mapping-is-not-injective.md) | Open | Medium | An unrelated payload overwritten or unlinked via `<id>.meta.json` aliasing or prefix fallback | Requires dotted inlay IDs; destructive helpers act on ambiguous matches |
| [Bulk write commits a partial filesystem prefix](audit/bulk-write-commits-a-partial-filesystem-prefix.md) | Open | Medium | Earlier files irreversibly replaced on mid-batch failure; the committed prefix is unknowable to callers | No current production caller; the exposed endpoint contract remains non-atomic |
| [Character package remaps chat IDs without remapping inlay metadata](audit/character-package-remaps-chat-ids-without-remapping-inlay-metadata.md) | Open | Medium | Imported media misclassified as orphaned, making gallery deletion (see P1 orphan scan) more likely | Every character-package import that carries inlays |
| [Legacy storage getters conflate valid values with missing](audit/legacy-storage-getters-conflate-valid-values-with-missing.md) | Fixed | Medium | A legacy plugin resets its configuration after reading stored `''`/`0`/`false` as absent | Any V2 plugin persisting falsey sentinels |
| [Full-write ETag does not cover chat rows](audit/full-write-etag-does-not-cover-chat-rows.md) | Open | Low | A newer chat row overwritten with no pre-image captured | Headerless legacy/external compatibility callers only; current clients unaffected |
| [Whole-chat patches half-apply external rows](audit/whole-chat-patches-half-apply-external-rows.md) | Open | Low | Mixed old/new rows after a failed multi-chat patch; overwritten rows lack pre-images | Compatibility-shaped payload-bearing patches only |
| [Non-canonical hex path splits the patch cache](audit/noncanonical-hex-path-splits-the-patch-cache.md) | Open | Low | An acknowledged edit overwritten by the parallel-cased cache's later flush | Mixed-case hex from a non-official caller only |
| [Decoded stream-load spools bypass configured spool and orphan sweep](audit/decoded-stream-load-spools-bypass-configured-spool-and-orphan-sweep.md) | Open | Medium | No direct loss — orphaned decompression spools can fill the save volume, and ENOSPC is the trigger condition for other destructive findings (e.g. inlay compression) | Killed/failed compressed imports, repeatedly |

## P4 — Loss of recovery copies and safety nets

Live data is unaffected by these; they destroy or silently disable the layers
that make P1–P3 incidents recoverable.

| Finding | Status | Doc sev. | What could be lost | Trigger / likelihood |
|---|---|---|---|---|
| [Docker server backups are ephemeral](audit/docker-server-backups-are-ephemeral.md) | Fixed | Medium | Every server-side `.bin` backup | Every image update or container recreation with the shipped Compose file — discovered exactly when a backup is needed |
| [update.sh wipes custom in-tree backup roots](audit/update-script-wipes-custom-in-tree-backup-roots.md) | Fixed | Medium | All recovery archives under a custom in-tree root (e.g. `data/backups`) | Every `update.sh` run once such a path is configured; the server permits the configuration |
| [Best-effort path markers let updaters delete recovery directories](audit/best-effort-path-markers-let-updaters-delete-recovery-directories.md) | Open | Medium | All archives under a custom root, classified as update debris | Marker write/read failure (swallowed silently) plus an updater run |
| [Wall-clock rollback disables chat pre-image capture](audit/wall-clock-rollback-disables-chat-preimage-capture.md) | Open | Medium | Pre-image capture silently off — possibly for years — while authoritative overwrites continue | A bad RTC or large backward NTP correction; the state persists across restarts |
| [Changing the chat-backup root hides all existing version history](audit/changing-chat-backup-root-hides-all-existing-version-history.md) | Open | Medium | All prior version history invisible; an operator may then clean the old volume, deleting the only pre-images | Changing the chat-backup root override |
| [Chat-version backups do not keep referenced inlays live](audit/chat-version-backups-do-not-keep-referenced-inlays-live.md) | Open | Medium | Inlay bytes referenced only by retained versions deleted; restoring the version yields dangling media | Delete a live chat, clean apparent orphans, later restore the version |
| [Direct flush callers bypass automatic-snapshot serialization](audit/direct-flush-callers-bypass-automatic-snapshot-serialization.md) | Open | Medium | A mixed/bare-stub recovery point published as a valid snapshot | Graceful shutdown or self-update restart racing concurrent mutations |
| [Global chat budget evicts newer bundles before older loose versions](audit/global-chat-budget-evicts-newer-bundles-before-older-loose-versions.md) | Fixed | Medium | 25 newer recovery points destroyed where one older loose file would have sufficed | A global byte-cap overage across chats |
| [Chat-version cap collapses from 125 to 100](audit/chat-version-cap-collapses-from-125-to-100.md) | Open | Medium | The oldest 20% of the advertised recovery depth, dropped at once | Reaching the 125th version; the current regression test codifies the loss |
| [Server backup published without fsync](audit/server-backup-published-without-fsync.md) | Open | Low | The just-created backup archive absent, truncated, or empty | Host power loss shortly after the backup's `done` acknowledgement |
| [Chat-version import acknowledges before save](audit/chat-version-import-acknowledges-before-save.md) | Open | Low | The "imported" chat vanishes; real loss only if the user deletes the version file trusting the success toast | Page close/crash before the polling save commits |

## P5 — Silent interchange and export fidelity loss

Originals survive; the loss becomes permanent when the export was the
migration vehicle or the source is later deleted.

| Finding | Status | Doc sev. | What could be lost | Trigger / likelihood |
|---|---|---|---|---|
| [CharX importer mistakes JSON assets for metadata](audit/charx-importer-mistakes-json-assets-for-metadata.md) | Open | Medium | The whole character import fails — a supported export its own importer cannot load (also breaks character packages) | Any character with a JSON asset exported to CharX |
| [Upstream-compatible backup drops live inlays but keeps chat references](audit/upstream-compatible-backup-drops-live-inlays-but-keeps-their-chat-references.md) | Open | Medium | All inlay media, sidecars, and metadata absent from upstream-target archives; chats keep dangling tokens; no warning shown | Every upstream-compatible export containing inlays |
| [HTML chat round trip rejects the default empty note](audit/html-chat-round-trip-rejects-the-default-empty-note.md) | Open | Medium | The recovery copy of an ordinary chat (empty note) imports as "no data" | Every HTML export of a chat with default empty fields |
| [CCv2 export drops regex lore semantics](audit/ccv2-export-drops-regex-lore-semantics.md) | Open | Medium | Regex lore keys silently degrade to literal matching, changing what context reaches the model | Every CCv2 export containing regex lore entries |
| [Persona exports drop advanced fields](audit/persona-exports-drop-advanced-fields.md) | Open | Low | `largePortrait` and the entire `embeddedModule` (lore, regex, triggers, assets); permanent when used for migration | Every persona export and character-package path |
| [Module CharX export drops namespace and cjs](audit/module-charx-export-drops-namespace-and-cjs.md) | Open | Low | Module `namespace` and `cjs` payload; namespace-based activation silently breaks after re-import | The module Share button — the default export path |

## P6 — No data-loss risk: UX and correctness harm

Nearly every open finding in this audit set touches persistence, so this tier
is small.

| Finding | Status | Doc sev. | UX harm | Trigger / likelihood |
|---|---|---|---|---|
| [Callback bridge skips stream transfer and remote-class serialization](audit/callback-bridge-skips-stream-transfer-and-remote-class-serialization.md) | Open | Medium | Host promise hangs forever with no error; already-produced (paid) model output stranded; mutation observers receive stripped, non-functional objects | V3 plugin callbacks returning nested streams or remote-class wrappers |

## Intentional documented limitations

| Finding | Status | Original doc sev. | Documented limitation | User-facing contract |
|---|---|---|---|---|
| [DB-only snapshots do not preserve assets](audit/snapshots-reference-assets-the-gc-can-delete.md) | Intentional documented limitation | Medium | Restoring an older database snapshot can leave dangling references when an excluded asset is no longer present. | The Backups UI labels these snapshots “DB only,” explicitly excludes character assets and inlays, and directs asset-complete recovery to full backups. |

## Cross-cutting amplifiers

Several defect families recur across tiers; fixing the shared mechanism
de-fangs multiple findings at once.

- **Reason-blind pre-image cooldown.** Ordinary in-row mutations still skip
  capture inside the cooldown regardless of destructive intent, which can make
  the remaining reroll and card-trigger findings permanent. Structural chat
  deletion is now separate: it forces a cooldown-exempt pre-image and aborts
  database publication if capture fails. The send-input and reroll-target races
  were fixed by binding their operations to durable character/chat IDs.
- **DB-only snapshots.** Automatic snapshots intentionally do not include assets
  or inlays, matching the explicit user-facing scope. Referenced MCP tool-call
  payloads are folded into the database snapshot; asset-complete recovery uses
  full backups. Version-history inlay ownership remains a separate open gap.
- **ETag as authorization (fixed 2026-07-28).** The patch-conflict promotion
  (P1) and the rebase promotion (P2) were the same defect class: adopting a
  server ETag before the matching authoritative state was installed, then using
  it to authorize a stale full write. Conflict ETags are now provisional until
  the authoritative body and retry baselines install successfully.
- **Ack-before-durable.** The authoritative SQLite default and explicit flush
  boundary are now durable; deliberately selected balanced/performance modes
  expose a labeled bounded power-loss window. Inline plugin storage,
  chat-version import, and server-backup publication still report success
  before their respective durability boundaries; the caller can then discard
  its only copy.
- **Server-owned asset reachability (partially fixed 2026-07-29).** Boot asset
  GC and its publication race now use an authoritative, plugin-aware server
  scan plus a persisted grace interval. Retained snapshot references are outside
  the documented DB-only contract; version-history inlay references remain a
  separate open ownership gap.
- **Deployment sweeps with incomplete preservation lists.** `install.sh`,
  `update.sh`, the best-effort path markers, and the Docker layout all decide
  what survives an update from a hard-coded list that can miss the user's real
  data or recovery roots.
