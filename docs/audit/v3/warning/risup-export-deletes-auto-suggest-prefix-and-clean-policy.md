# RISUP export deletes the auto-suggest prefix and clean policy

- Status: Open
- Severity: Medium
- Lens: L1, L2, D3
- Area: Area 8 — mode matrix and round trips
- Affected code: `src/ts/storage/database.svelte.ts:1762`, `src/ts/storage/database.svelte.ts:2420`, `src/ts/storage/database.svelte.ts:2455`, `src/ts/storage/database.svelte.ts:2503`, `src/ts/storage/database.svelte.ts:2566`, `src/ts/storage/database.svelte.ts:2853`

## Risk

Bot presets declare and apply `autoSuggestPrompt`, `autoSuggestPrefix`, and
`autoSuggestClean`, but `saveCurrentPreset()` writes only the prompt and replaces
the live preset with that reduced object. `.risup` download calls this mutating
function before encoding.

Exporting a configured preset therefore deletes the prefix and clean policy from
the primary in-memory preset and omits them from the archive. Later switching or
importing reuses destination values rather than the exported policy, so both the
source and recovery copy lose semantics during the export action itself.

## Required fix and coverage

Use one exhaustive schema across save, apply, export, and import. Include both
fields and make download operate on a non-mutating snapshot.

Compare every `botPreset` field before export, after export, and after import.
