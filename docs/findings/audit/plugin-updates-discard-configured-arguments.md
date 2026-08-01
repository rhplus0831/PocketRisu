# Plugin updates discard configured arguments

- Status: Fixed 2026-07-31
- Severity: Medium
- Lens: L3, D6
- Area: Area 2 — client/plugin boundary
- Affected code: `src/ts/plugins/plugins.svelte.ts`, `src/ts/plugins/pluginSaveStorage.test.ts`, `src/lang/en.ts`

## Resolution

Plugin replacement now re-reads the installed record under the serialized
lifecycle lock and carries forward each stored value whose argument name is
still declared by the replacement. Newly declared arguments retain their
parsed empty-string or zero defaults. The prior enabled state is preserved for
compatible updates and confirmed duplicate imports; the optimized-memory gate
can still force a legacy V2/V2.1 replacement off.

When a replacement removes declared arguments, the lifecycle lock is released
before prompting with argument names only. Declining leaves the installed
record untouched and schedules no save. Accepting re-enters the lifecycle lock
and re-checks the live schema before mutation, so a concurrent replacement
cannot add an unconfirmed removal. Existing reload, committed-save, and
rollback behavior remains in place.

Coverage exercises the ordinary remote update path, unchanged and added
schemas, declined and accepted removals, renamed arguments, confirmed duplicate
imports, disabled plugins, and compatibility-gated legacy updates with
non-default configured values.

## Risk (historical)

Every import constructs a fresh argument map from directive defaults. Update and
confirmed duplicate-import paths replace the entire existing plugin record with
that new object; no path merges values from the installed record. Enablement is
also reset to the version/memory gate's default.

The ordinary update button can therefore erase API keys, endpoints, models, and
large prompts even when the updated plugin declares the same argument names.
The new plugin record is immediately queued for persistence, making the reset
authoritative rather than a transient display problem.

## Required fix and coverage (completed)

Preserve existing values for argument names still declared by the update,
initialize only new arguments, and retain enablement unless compatibility forces
a disable. Confirm before dropping removed arguments.

Test same-schema, added, removed, renamed, disabled, and compatibility-gated
updates with non-default configured values.
