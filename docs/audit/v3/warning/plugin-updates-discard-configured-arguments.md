# Plugin updates discard configured arguments

- Status: Open
- Severity: Medium
- Lens: L3, D6
- Area: Area 2 — client/plugin boundary
- Affected code: `src/ts/plugins/plugins.svelte.ts:113`, `src/ts/plugins/plugins.svelte.ts:121`, `src/ts/plugins/plugins.svelte.ts:179`, `src/ts/plugins/plugins.svelte.ts:243`, `src/ts/plugins/plugins.svelte.ts:255`, `src/ts/plugins/plugins.svelte.ts:382`, `src/ts/plugins/plugins.svelte.ts:386`, `src/ts/plugins/plugins.svelte.ts:418`, `src/ts/plugins/plugins.svelte.ts:433`, `src/lib/Setting/Pages/PluginSettings.svelte:211`, `src/lib/Setting/Pages/PluginSettings.svelte:221`

## Risk

Every import constructs a fresh argument map from directive defaults. Update and
confirmed duplicate-import paths replace the entire existing plugin record with
that new object; no path merges values from the installed record. Enablement is
also reset to the version/memory gate's default.

The ordinary update button can therefore erase API keys, endpoints, models, and
large prompts even when the updated plugin declares the same argument names.
The new plugin record is immediately queued for persistence, making the reset
authoritative rather than a transient display problem.

## Required fix and coverage

Preserve existing values for argument names still declared by the update,
initialize only new arguments, and retain enablement unless compatibility forces
a disable. Confirm before dropping removed arguments.

Test same-schema, added, removed, renamed, disabled, and compatibility-gated
updates with non-default configured values.
