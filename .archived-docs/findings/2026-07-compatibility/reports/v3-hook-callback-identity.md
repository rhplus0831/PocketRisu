# V3 hook removal no longer preserves callback identity

- Status: Fixed 2026-07-30
- Severity: Medium
- Confidence: High
- Introduced by: 99253152

## Difference

The iframe bridge preserves guest function identity through stable callback
IDs and a callback wrapper cache. main passed that stable host callback to both
add and remove operations.

serve creates a fresh guardPluginCallback wrapper on every
addRisuScriptHandler() and addRisuReplacer(), but removeRisuScriptHandler() and
removeRisuReplacer() still receive the original bridge callback. The backing
registries in src/ts/plugins/plugins.svelte.ts are identity-based Sets.

## Compatibility impact

Removal silently deletes nothing. Adding the same callback twice creates two
guard wrappers instead of deduplicating, so script handlers and response
replacers can run twice. Self-removing and one-shot handlers remain active until
generation teardown. Lifecycle cleanup captures and removes every guard, so
they do not leak across reloads.

## Reproduction

Add the same afterRequest replacer twice, then remove it using the original
function. main leaves the Set empty. serve leaves two wrappers and transforms
the next response twice.

## Resolution

`makeRisuaiAPIV3()` now maintains lifecycle- and mode-scoped mappings from each
original bridge callback to one guarded callback. Script-handler and replacer
add/remove operations resolve through those mappings, restoring `Set`
deduplication and identity-based removal while keeping input-hook send scope
separate from the other script modes.

The V3 guest bridge regression test registers the same callback twice, verifies
that each registry executes it once, removes display and input modes
independently, and confirms explicit replacer removal. The full client suite and
Svelte/TypeScript diagnostics passed after the change.
