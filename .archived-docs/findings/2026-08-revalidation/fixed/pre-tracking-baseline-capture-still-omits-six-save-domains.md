# Pre-tracking baseline capture still omits six save domains

- Status: Fixed (2026-08-05 revalidation)
- Owner: client storage
- Source: [2026-07 data-loss audit](../../2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium (at fix time; formerly Deferred)
- Resolution: `e2ca4ddd` — the startup equality preflight in
  `src/ts/globalApi.svelte.ts` diffs the live graph against the server-read
  baseline across all six domains before trusting a clean skip, and the
  pre-watermark chat-row capture in `src/ts/storage/chatPersistStage.ts`
  covers startup-created chats.
- Regression coverage: `src/ts/storage/chatPersistStage.test.ts`
  (startup-created, repaired-ID, and replaced-chat cases);
  `test/e2e/scenarios/boot.spec.ts` (two fresh-context cold boots require zero
  second-boot patch bytes); the client suite's dual-run `verifyDirtyRevisions`
  mode re-checks equality behind every trusted-clean skip. Known gap: no
  single all-six-domain boot-mutation matrix asserts each domain survives an
  idle refresh.
- Canonical architecture: [client storage](../../../../docs/structure/client-storage.md)
- Lens: L1, L3
- Area: Area 1 — client change detection and save scheduling

## Original risk (historical)

The pre-tracking comparison is typed and implemented only for
`pluginCustomStorage` and `pluginStorageMeta`. Root settings, bot presets,
modules, plugins, characters, and chats have no persisted-baseline comparison,
while each reactive tracker suppresses its first run.

Bootstrap mutates all six domains through defaulting, format migration, URL
module import, plugin initialization, first-setup state, and ID repair. Those
changes can be absorbed as the clean baseline. Bot presets and modules are
especially sharp because unrelated root saves do not patch them without their
dedicated flags, leaving repaired IDs or imported modules memory-only.

## Original required fix (historical)

Replace the plugin-specific helper with a stub-normalized, block-by-block
comparison against the persisted baseline and set every affected save flag.
Integrate chat row-durability discovery for character/chat differences.

Cover each boot mutation class and require its normalized result to survive an
idle refresh without relying on an unrelated user edit.
