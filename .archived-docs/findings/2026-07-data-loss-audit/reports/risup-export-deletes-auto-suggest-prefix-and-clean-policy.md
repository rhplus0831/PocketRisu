# RISUP export deletes the auto-suggest prefix and clean policy

- Status: Fixed 2026-07-31
- Severity: Medium
- Lens: L1, L2, D3
- Area: Area 8 — mode matrix and round trips
- Affected code: `src/ts/storage/database.svelte.ts` (`createCurrentBotPresetSnapshot()`, `saveCurrentPreset()`, `setPreset()`, and `downloadPreset()`), `src/ts/storage/botPresetId.test.ts`

## Resolution

Preset saving and active-preset export now share one pure snapshot builder that
includes `autoSuggestPrompt`, `autoSuggestPrefix`, and `autoSuggestClean`.
`saveCurrentPreset()` publishes that snapshot when a preset really must be
saved, while `downloadPreset()` exports the snapshot without writing it back
into the live preset array. Exporting an inactive preset clones that preset
directly and likewise leaves the active preset untouched.

Coverage verifies that active export captures unsaved live settings without
mutating the stored preset, inactive export does not rewrite the active preset,
and every exported field survives a binary `.risup` import round trip except
for the intentionally regenerated stable ID.

## Risk (historical)

Bot presets declare and apply `autoSuggestPrompt`, `autoSuggestPrefix`, and
`autoSuggestClean`, but `saveCurrentPreset()` writes only the prompt and replaces
the live preset with that reduced object. `.risup` download calls this mutating
function before encoding.

Exporting a configured preset therefore deletes the prefix and clean policy from
the primary in-memory preset and omits them from the archive. Later switching or
importing reuses destination values rather than the exported policy, so both the
source and recovery copy lose semantics during the export action itself.

## Required fix and coverage (completed)

Use one exhaustive schema across save, apply, export, and import. Include both
fields and make download operate on a non-mutating snapshot.

Compare every `botPreset` field before export, after export, and after import.
