# A V2 unload callback could wedge every plugin lifecycle operation

- Status: Fixed 2026-07-30
- Severity: High
- Confidence: High
- Introduced by: 2268a66a

## Original difference

main already awaited every V2/V2.1 unload callback without timeout, so a hanging
callback was not newly introduced. serve retains that wait while holding the
new global plugin lifecycle lease and serializes plugin-list durability behind
the lifecycle transaction.

## Original compatibility impact

A callback that returns a never-settling Promise now blocks unrelated disable,
remove, import, enable, reload, and storage-mode changes behind the same lease.
The explicit lifecycle transaction save is not reached until teardown/reload
finishes. Ordinary reactive autosave or page-hide flushing can independently
commit the plugin-list mutation while unload remains hung, so reboot persistence
is nondeterministic. Compatibility mode can downgrade a rejection, but it
cannot handle a Promise that never settles.

## Original reproduction

Register a V2 onUnload callback that awaits a never-resolving Promise, then
disable the plugin. The setting remains behind the lifecycle wait and a second
plugin operation queues forever.

## Implemented recommendation

Apply a bounded unload grace period, detach generation-scoped host facades after
the grace, and durably commit disable/removal before waiting for third-party
cleanup. Add hanging, rejecting, and late-resolving unload tests.

## Resolution

V2/V2.1 teardown now starts every registered callback and gives the retiring
generation one aggregate five-second grace period. Completion, rejection, and
timeout are all observed; after the grace the generation-scoped API facade is
revoked, runtime registries are cleared again, and the global lifecycle lease
is released. A callback that settles late therefore cannot use a captured
storage, database, registration, asset, network, or other V2 host facade to
mutate the new generation.

Disable and removal now require an exact committed database save before any
third-party cleanup runs. A failed pre-cleanup save restores the in-memory
plugin list without touching the running generation. Successful cleanup is
followed by another exact save for legitimate final writes, while the requested
disable/removal is reapplied after teardown so a callback cannot re-enable or
reinsert its retiring record. A later cleanup-save failure reports the partial
finalization but does not roll back the already durable user action.

Regression coverage verifies save-before-unload ordering, rejecting callbacks,
a never-settling callback alongside independent cleanup, release of queued
lifecycle work after the deadline, retained-facade revocation after a late
resolution, pre-cleanup save rollback, and cleanup-time list reconciliation.
