# CCv2 export drops regex lore semantics

- Status: Open
- Owner: characters and personas
- Source: [2026-07 data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium
- Lens: L2, D3
- Area: Area 8 — mode matrix and round trips
- Affected code: `src/ts/characterCards.ts:1034`, `src/ts/characterCards.ts:1060`, `src/ts/characterCards.ts:1077`, `src/ts/characterCards.ts:1192`, `src/ts/characterCards.ts:1496`

## Risk

Character-card import maps standard `use_regex` into internal `useRegex`, and V3
export writes it back. The backward-compatible/default CCv2 builder omits the
field even though its own importer accepts it.

After CCv2 PNG export and import into a fresh instance, every regex lore key
defaults to literal matching. Activation behavior changes silently and can alter
which context reaches the model, despite the semantics being representable in
the selected interchange format.

## Required fix and coverage

Serialize `use_regex: lore.useRegex ?? false` in the V2 builder and share an
exhaustive lore-entry adapter across card versions.

Add CCv2 PNG and JSON semantic round trips with true and false regex entries.
