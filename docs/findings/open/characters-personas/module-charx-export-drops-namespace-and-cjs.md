# Module CharX export drops `namespace` and `cjs`

- Status: Open
- Owner: characters and personas
- Source: [2026-07 data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Low
- Area: import/export round-trips
- Affected code: `src/ts/interchangeability.ts:6-53` (`convertModuleToCharacter` omits `namespace`/`cjs`), `src/ts/interchangeability.ts:55-68` (reverse conversion cannot restore them), `src/ts/process/modules.ts:37-55` (the normal Share action uses this path), `src/ts/process/modules.ts:380-386` (runtime resolution matches on namespace)
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../../../.archived-docs/findings/2026-08-revalidation/README.md)

## Risk

The module Share button exports via module→character CharX conversion, which
carries neither `namespace` nor `cjs`. Re-importing yields a module that no
longer matches namespace-based activation or references, and any CJS payload
is gone. Import reports success, so the loss is silent. The legacy `.risum`
encoder is lossless but is not what the UI uses.

## Required fix and coverage

Carry module-only fields in a namespaced CharX extension (or embed the
lossless `.risum` payload) and extend the interchangeability round-trip tests
to every `RisuModule` field — the existing tests never populate `namespace`
or `cjs`.
