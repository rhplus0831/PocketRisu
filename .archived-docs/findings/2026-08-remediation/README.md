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
