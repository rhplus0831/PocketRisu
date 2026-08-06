# CharX importer mistakes JSON assets for metadata

- Status: Fixed (2026-08-07 remediation queue)
- Owner: characters and personas
- Source: [2026-07 data-loss audit](../../2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium (at fix time)
- Lens: L3, L4, D3
- Area: Area 8 — mode matrix and round trips
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the
  [revalidation register](../../2026-08-revalidation/README.md)
- Resolution: this remediation commit — the streaming CharX importer now
  reserves only `card.json`, `module.risum`, and schema-valid unreferenced
  members of the `x_meta/` namespace. All other archive members, including
  `.json` files, enter ordinary asset storage. Because exporters write
  `card.json` last, `x_meta/` candidates remain pending until the importer can
  honor every `embeded://` card asset reference regardless of extension or
  namespace. Namespace checks use normalized ZIP paths while asset mappings
  retain raw member names and any normalized-equivalent card-reference alias;
  colliding normalized member paths, plus unknown or malformed unreferenced
  `x_meta/` members, fail closed instead of being silently discarded.
- Regression coverage: `src/ts/process/processzip.test.ts` covers direct CharX
  import of referenced JSON and Lua assets, the streaming nested-CharX path
  used by character packages with JSON and text assets, a card-referenced JSON
  member under a normalized-equivalent `x_meta/` path, escaping dot-segment
  members, valid dot-prefixed exporter metadata exclusion, normalized-path
  collision rejection, and explicit rejection of malformed-schema and
  unknown-extension metadata members.
- Canonical architecture: [characters and personas](../../../../docs/structure/characters-personas.md)

## Original risk (historical)

The allow-all setting permitted a JSON file as a character asset, and V3 CharX
export preserved its extension under `assets/`. Import then discarded every
JSON member other than `card.json`, a blanket rule intended for
`x_meta/*.json`.

When `card.json` resolved its `embeded://assets/...json` URI, the bytes were
absent and the whole character import threw. The same failure reached character
packages because their embedded character is CharX. A supported export path
thus produced an archive the matching importer could not load.

## Original required fix and coverage (historical)

Ignore only the known `x_meta/` namespace. Treat every path referenced by
`card.json` as an asset regardless of extension and validate metadata by path
and schema rather than suffix.

Test JSON and other non-media assets in CharX and character packages.
