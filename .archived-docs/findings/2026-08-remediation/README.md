# 2026-08 remediation-queue register

Fixes landed by working the hand-ordered
[remediation queue](../../../docs/findings/REMEDIATION-QUEUE.md) established on
2026-08-05 from the [revalidation register](../2026-08-revalidation/README.md).
One entry per closed finding; each archived report records the resolution
commit, regression coverage, and canonical architecture link.

## Fixed findings

| Finding | Resolution | Coverage |
|---|---|---|
| [Queued plugin-recovery actions are not bound to the writer epoch](fixed/queued-recovery-actions-ignore-writer-epoch.md) | `3d7e7fb6` in-queue writer revalidation + epoch-bound recovery tokens | `test/compat/plugin-storage-boot-reconcile.test.ts` (stale-epoch reject, happy path, queued-takeover race) |
| [Serve pushes and releases are not gated by the test suites](fixed/compatibility-suites-not-run-in-ci.md) | `f519771d` reusable tests.yml gate on serve pushes + releases, compat skip guard; flake hardening `ee924ac6` | The gate itself; skip guard exercised on pass/unexpected/empty reports |
| [Reroll can leave no durable copy of the discarded response](fixed/reroll-discards-the-only-copy-within-preimage-cooldown.md) | `a772b134` destructive reasons force required pre-images; consume-on-success client reasons; delete-swipe tagged | `test/compat/chat-content-row.test.ts` (cooldown-exempt capture + byte-exact recovery, failure abort), `chatBackups.test.ts`, `chatStorage.test.ts` |
| [Chat-row staging is not bound to the committed stub snapshot](fixed/chat-row-stage-is-not-bound-to-the-committed-stub-snapshot.md) | `73d5c87e` rediscovery loop + synchronous dispatch guard; orphan sweep captures required pre-images | `chatPersistStage.test.ts` (paused-row creation, non-convergence), `db-chunking.test.ts` (swept-orphan restore, capture-failure skip) |
| [Whole-chat patches can partially commit external rows](fixed/whole-chat-patches-partially-commit-rows.md) | `6e6725e2` definitive 422 rejection before any mutation; non-atomic extraction path removed | `database-write-atomicity.test.ts` (two-payload zero-commit, overwrite untouched, stub-only unaffected), `chatRows.test.ts` |
