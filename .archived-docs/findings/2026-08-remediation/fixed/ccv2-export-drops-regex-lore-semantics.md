# CCv2 export drops regex lore semantics

- Status: Fixed (2026-08-07 remediation queue)
- Owner: characters and personas
- Source: [2026-07 data-loss audit](../../2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium (at fix time)
- Lens: L2, D3
- Area: Area 8 — mode matrix and round trips
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the
  [revalidation register](../../2026-08-revalidation/README.md)
- Resolution: this remediation commit — CCv2 and CCv3 now share one exhaustive
  lore-entry export adapter. The adapter explicitly serializes
  `use_regex: lore.useRegex ?? false` along with the existing key, selection,
  insertion, extension, case-sensitivity, mode, and folder fields, so CCv2 no
  longer changes regex lore into literal lore while CCv3 retains its existing
  semantics. Lore activation and matching behavior are unchanged.
- Regression coverage: `src/ts/characterCards.loreRoundTrip.test.ts` exercises
  the public CCv2 JSON and PNG export/import paths with a valid `/regex/flags`
  entry carrying `true` and a literal entry carrying `false`, checks both the
  exported interchange fields and the re-imported internal fields, verifies the
  PNG path preserves a valid trimmed source image, and protects CCv3 output on
  the shared adapter.
- Canonical architecture: [characters and personas](../../../../docs/structure/characters-personas.md),
  coordinated with [memory and lorebook](../../../../docs/structure/memory-lorebook.md)

## Original risk (historical)

Character-card import mapped standard `use_regex` into internal `useRegex`, and
CCv3 export wrote it back. The backward-compatible/default CCv2 builder omitted
the field even though its own importer accepted it.

After CCv2 PNG export and import into a fresh instance, every regex lore key
defaulted to literal matching. Activation behavior changed silently and could
alter which context reached the model, despite the semantics being
representable in the selected interchange format.

## Original required fix and coverage (historical)

Serialize `use_regex: lore.useRegex ?? false` in the V2 builder and share an
exhaustive lore-entry adapter across card versions.

Add CCv2 PNG and JSON semantic round trips with true and false regex entries.
