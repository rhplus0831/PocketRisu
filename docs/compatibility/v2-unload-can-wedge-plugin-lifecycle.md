# A V2 unload callback can wedge every plugin lifecycle operation

- Status: Confirmed amplification of a pre-existing hang
- Severity: High
- Confidence: High
- Introduced by: 2268a66a

## Difference

main already awaited every V2/V2.1 unload callback without timeout, so a hanging
callback was not newly introduced. serve retains that wait while holding the
new global plugin lifecycle lease and serializes plugin-list durability behind
the lifecycle transaction.

## Compatibility impact

A callback that returns a never-settling Promise now blocks unrelated disable,
remove, import, enable, reload, and storage-mode changes behind the same lease.
The explicit lifecycle transaction save is not reached until teardown/reload
finishes. Ordinary reactive autosave or page-hide flushing can independently
commit the plugin-list mutation while unload remains hung, so reboot persistence
is nondeterministic. Compatibility mode can downgrade a rejection, but it
cannot handle a Promise that never settles.

## Reproduction

Register a V2 onUnload callback that awaits a never-resolving Promise, then
disable the plugin. The setting remains behind the lifecycle wait and a second
plugin operation queues forever.

## Recommendation

Apply a bounded unload grace period, detach generation-scoped host facades after
the grace, and durably commit disable/removal before waiting for third-party
cleanup. Add hanging, rejecting, and late-resolving unload tests.
