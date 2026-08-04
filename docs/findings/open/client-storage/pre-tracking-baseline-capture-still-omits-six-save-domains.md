# Pre-tracking baseline capture still omits six save domains

- Status: Deferred
- Owner: client storage
- Source: [2026-07 data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium
- Lens: L1, L3
- Area: Area 1 — client change detection and save scheduling
- Affected code: `src/ts/plugins/pluginStorageTracking.ts:5`, `src/ts/globalApi.svelte.ts:421`, `src/ts/globalApi.svelte.ts:447`, `src/ts/storage/database.svelte.ts:183`, `src/ts/bootstrap.ts:185`, `src/ts/bootstrap.ts:433`, `src/ts/bootstrap.ts:681`, `src/ts/storage/risuSave.ts:1016`

## Risk

The pre-tracking comparison is typed and implemented only for
`pluginCustomStorage` and `pluginStorageMeta`. Root settings, bot presets,
modules, plugins, characters, and chats have no persisted-baseline comparison,
while each reactive tracker suppresses its first run.

Bootstrap mutates all six domains through defaulting, format migration, URL
module import, plugin initialization, first-setup state, and ID repair. Those
changes can be absorbed as the clean baseline. Bot presets and modules are
especially sharp because unrelated root saves do not patch them without their
dedicated flags, leaving repaired IDs or imported modules memory-only.

## Required fix and coverage

Replace the plugin-specific helper with a stub-normalized, block-by-block
comparison against the persisted baseline and set every affected save flag.
Integrate chat row-durability discovery for character/chat differences.

Cover each boot mutation class and require its normalized result to survive an
idle refresh without relying on an unrelated user edit.
