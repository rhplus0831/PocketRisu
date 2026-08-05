# Remediation queue

Hand-maintained execution order for the findings catalog. Work items one at a
time, top to bottom; the details, evidence, and fix boundaries live in each
linked report. Unlike [`WORK-INDEX.md`](WORK-INDEX.md) (generated status
catalog — never hand-edit), this file is edited by hand: when an item lands,
move its line to **Completed** with the resolution commit and follow the
[catalog lifecycle](README.md) (archive the report, run `pnpm check:docs`).

Ordering: two leverage picks first, then severity (High → Medium → Warning →
Low → Informational), with same-subsystem items adjacent so fixes can share
regression harnesses. Sequence set 2026-08-05 from the
[revalidation register](../../.archived-docs/findings/2026-08-revalidation/README.md);
re-rank freely as priorities change.

## Pending

1. [Wall-clock rollback disables chat pre-image capture](open/backup-recovery/wall-clock-rollback-disables-chat-preimage-capture.md) — Medium
2. [Best-effort path markers let updaters delete recovery directories](open/backup-recovery/best-effort-path-markers-let-updaters-delete-recovery-directories.md) — Medium
3. [Changing the chat-backup root hides all existing version history](open/backup-recovery/changing-chat-backup-root-hides-all-existing-version-history.md) — Medium
4. [Chat-version backups do not keep referenced inlays live](open/backup-recovery/chat-version-backups-do-not-keep-referenced-inlays-live.md) — Medium
5. [Inlays still served from KV fallback are omitted from backups and cleared on restore](open/backup-recovery/unmigrated-kv-inlays-are-omitted-from-backups.md) — Medium
6. [Runtime asset writes can replace a case-colliding asset on case-insensitive volumes](open/media-translation/runtime-asset-writes-can-case-fold-clobber.md) — Medium — residual carved out of the fixed migration/import portability finding; same assets surface as the next three items.
7. [External dedup can strand or overwrite a live asset](open/media-translation/external-dedup-can-strand-or-overwrite-a-live-asset.md) — Medium
8. [Inlay filename mapping is not injective](open/media-translation/inlay-filename-mapping-is-not-injective.md) — Medium
9. [Preferred jdupes merges cross-instance ownership](open/media-translation/preferred-jdupes-merges-cross-instance-ownership.md) — Medium — same dedup surface as the previous two items.
10. [Imported card triggers can bulk-delete chat history without the low-level-access consent](open/scripting-extensions/card-triggers-can-bulk-delete-history-without-consent.md) — Medium
11. [CCv2 export drops regex lore semantics](open/characters-personas/ccv2-export-drops-regex-lore-semantics.md) — Medium
12. [CharX importer mistakes JSON assets for metadata](open/characters-personas/charx-importer-mistakes-json-assets-for-metadata.md) — Medium
13. [Live model-job claim precedes chat-row durability](open/chat-pipeline/model-job-claim-precedes-chat-durability.md) — Warning
14. [Terminal job recovery can overwrite a newer generation by stale index](open/chat-pipeline/terminal-job-recovery-uses-stale-message-index.md) — Warning — same job-recovery surface as the previous item.
15. [Streaming checkpoint re-arm can absorb unsaved tokens](open/chat-pipeline/streaming-checkpoint-rearm-can-absorb-unsaved-tokens.md) — Warning
16. [Draft-save failures have no retry or user signal](open/client-storage/draft-save-failures-have-no-retry-or-signal.md) — Warning
17. [Build-mismatch reload can discard an undurable composer draft](open/client-storage/build-mismatch-reload-can-discard-composer-draft.md) — Warning — same draft-durability surface as the previous item; also covers the widened writer-epoch reload trigger.
18. [Sidecar databases use NORMAL WAL without a shutdown drain](open/server-backend/sidecar-databases-use-normal-wal-without-shutdown-drain.md) — Warning
19. [Plugin recovery offers an inline repair it cannot serialize](open/plugin-storage/recovery-use-inline-cannot-serialize-lossless-values.md) — Warning
20. [Sparse-array holes are densified in plugin-storage transitions and snapshots](open/plugin-storage/sparse-array-holes-densified.md) — Warning
21. [Lua local-lore upserts are discarded in non-display trigger modes](open/scripting-extensions/lua-local-lore-upsert-is-discarded.md) — Warning
22. [Gemini cross-turn signature persistence is disconnected](open/model-providers/gemini-streaming-signature-save-is-fire-and-forget.md) — Warning — product decision first: wire the dormant gate or remove it.
23. [Chat-version import reports success before anything is persisted](open/backup-recovery/chat-version-import-acknowledges-before-save.md) — Low
24. [Server backups are acknowledged before the directory entry is durable](open/backup-recovery/server-backup-published-without-fsync.md) — Low
25. [Upstream-compatible backup drops live inlays but keeps their chat references](open/backup-recovery/upstream-compatible-backup-drops-live-inlays-but-keeps-their-chat-references.md) — Low
26. [A crash during inlay migration can discard inlay metadata](open/media-translation/interrupted-inlay-migration-discards-the-source-row.md) — Low
27. [Character package remaps chat IDs without remapping inlay metadata](open/characters-personas/character-package-remaps-chat-ids-without-remapping-inlay-metadata.md) — Low
28. [Module CharX export drops `namespace` and `cjs`](open/characters-personas/module-charx-export-drops-namespace-and-cjs.md) — Low
29. [Persona exports silently drop advanced persona data](open/characters-personas/persona-exports-drop-advanced-fields.md) — Low
30. [The full-write ETag does not cover chat rows](open/server-backend/full-write-etag-does-not-cover-chat-rows.md) — Low
31. [V2 storage assignments now always detach caller aliases](open/plugin-storage/v2-plugin-storage-live-aliases.md) — Low
32. [Callback bridge skips deep stream transfer and remote-class serialization](open/scripting-extensions/callback-bridge-skips-stream-transfer-and-remote-class-serialization.md) — Low
33. [Real upstream backup tests silently skip without a local fixture](open/operations-coverage/real-upstream-backup-fixture-skipped.md) — Informational

## Completed

- [Decoded stream-load spools bypass the configured spool and orphan sweep](../../.archived-docs/findings/2026-08-remediation/fixed/decoded-stream-load-spools-bypass-configured-spool-and-orphan-sweep.md) — fixed by `98b3e2a7` (2026-08-06)
- [Boot spool sweep can unlink another instance's active file](../../.archived-docs/findings/2026-08-remediation/fixed/boot-spool-sweep-can-unlink-another-instances-active-file.md) — fixed by `f4432368` (2026-08-06)
- [Bulk filesystem writes can commit a partial prefix](../../.archived-docs/findings/2026-08-remediation/fixed/bulk-filesystem-writes-partially-commit.md) — fixed by `64042a36` (2026-08-06)
- [Non-optimized plugin save storage acknowledges before persistence](../../.archived-docs/findings/2026-08-remediation/fixed/nonoptimized-save-storage-acks-before-persistence.md) — fixed by `67f9eb96` (2026-08-06)
- [The save loop stops retrying after five consecutive failures](../../.archived-docs/findings/2026-08-remediation/fixed/save-loop-idles-after-five-failures.md) — fixed by `5e329fb6` (2026-08-05)
- [Acknowledged database patches are not durable for up to five seconds](../../.archived-docs/findings/2026-08-remediation/fixed/acknowledged-patches-are-not-durable.md) — fixed by `e526398e` (2026-08-05)
- [Queued plugin-recovery actions are not bound to the writer epoch](../../.archived-docs/findings/2026-08-remediation/fixed/queued-recovery-actions-ignore-writer-epoch.md) — fixed by `3d7e7fb6` (2026-08-05)
- [Serve pushes and releases are not gated by the test suites](../../.archived-docs/findings/2026-08-remediation/fixed/compatibility-suites-not-run-in-ci.md) — fixed by `f519771d` + `ee924ac6` (2026-08-05)
- [Reroll can leave no durable copy of the discarded response](../../.archived-docs/findings/2026-08-remediation/fixed/reroll-discards-the-only-copy-within-preimage-cooldown.md) — fixed by `a772b134` (2026-08-05)
- [Chat-row staging is not bound to the committed stub snapshot](../../.archived-docs/findings/2026-08-remediation/fixed/chat-row-stage-is-not-bound-to-the-committed-stub-snapshot.md) — fixed by `73d5c87e` (2026-08-05)
- [Whole-chat patches can partially commit external rows](../../.archived-docs/findings/2026-08-remediation/fixed/whole-chat-patches-partially-commit-rows.md) — fixed by `6e6725e2` (2026-08-05)
- [Asset filename mapping is not portable across filesystems](../../.archived-docs/findings/2026-08-remediation/fixed/portable-asset-filename-mapping.md) — fixed by `f3e8aa11` (2026-08-05); runtime-write residual re-filed as the pending [runtime asset case-fold clobber](open/media-translation/runtime-asset-writes-can-case-fold-clobber.md) item
- [Upstream-target export can emit a PocketRisu-only magic version byte](../../.archived-docs/findings/2026-08-remediation/fixed/upstream-export-plugin-proto-header.md) — fixed by `3da789b4` (2026-08-05)

Closed by the 2026-08-05 revalidation (predates this queue):

- [Pre-tracking baseline capture omitted six save domains](../../.archived-docs/findings/2026-08-revalidation/fixed/pre-tracking-baseline-capture-still-omits-six-save-domains.md) — fixed by `e2ca4ddd`
- [Direct flush callers bypassed automatic-snapshot serialization](../../.archived-docs/findings/2026-08-revalidation/fixed/direct-flush-callers-bypass-automatic-snapshot-serialization.md) — fixed by `3e758f9a`
- [HTML chat round trip rejected the default empty note](../../.archived-docs/findings/2026-08-revalidation/fixed/html-chat-round-trip-rejects-the-default-empty-note.md) — fixed by `b399bd31`
- [Non-canonical hex path headers split the patch cache](../../.archived-docs/findings/2026-08-revalidation/fixed/noncanonical-hex-path-splits-the-patch-cache.md) — fixed by `e23b744c`
