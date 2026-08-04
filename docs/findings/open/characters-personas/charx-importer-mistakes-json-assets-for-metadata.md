# CharX importer mistakes JSON assets for metadata

- Status: Open
- Owner: characters and personas
- Source: [2026-07 data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium
- Lens: L3, L4, D3
- Area: Area 8 — mode matrix and round trips
- Affected code: `src/ts/util.ts:121`, `src/lib/SideBars/CharConfig.svelte:505`, `src/ts/characterCards.ts:1271`, `src/ts/characterCards.ts:1347`, `src/ts/process/processzip.ts:368`, `src/ts/characterCards.ts:780`

## Risk

The allow-all setting permits a JSON file as a character asset, and V3 CharX
export preserves its extension under `assets/`. Import then discards every JSON
member other than `card.json`, a blanket rule intended for `x_meta/*.json`.

When `card.json` resolves its `embeded://assets/...json` URI, the bytes are absent
and the whole character import throws. The same failure reaches character
packages because their embedded character is CharX. A supported export path thus
produces an archive the matching importer cannot load.

## Required fix and coverage

Ignore only the known `x_meta/` namespace. Treat every path referenced by
`card.json` as an asset regardless of extension and validate metadata by path and
schema rather than suffix.

Test JSON and other non-media assets in CharX and character packages.
