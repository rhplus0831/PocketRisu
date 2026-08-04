# HTML chat round trip rejects the default empty note

- Status: Fixed (2026-08-05 revalidation)
- Owner: backup and recovery
- Source: [2026-07 data-loss audit](../../2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium (at fix time)
- Resolution: `b399bd31` — shared chat import normalization in
  `src/ts/chatImport.ts` validates by shape (`typeof chat.note === 'string'`,
  array checks) instead of truthiness, so the default empty note round-trips;
  JSON and HTML now route through one import function
  (`parseChatHtmlExport` → `prepareChatForImport`).
- Regression coverage: `src/ts/chatImport.test.ts` — HTML chat import extracts
  the lossless payload with a fresh local identity, including exact
  empty-field cases.
- Canonical architecture: [backup and recovery](../../../../docs/structure/backup-recovery.md)
- Lens: L4, D3
- Area: Area 8 — mode matrix and round trips

## Original risk (historical)

HTML export serializes the complete chat, whose normal placeholder/default shape
uses `note: ''`. HTML import validates `message`, `note`, `name`, and `localLore`
by truthiness rather than nullishness and shape, unlike the JSON-v1 branch.

An ordinary chat whose note was never filled therefore exports successfully but
later imports as “no data.” The live database is not damaged, yet the recovery
copy is unusable for the default application state and gives no field-specific
diagnosis.

## Original required fix (historical)

Validate array types and nullish required fields, then normalize and assign a
fresh ID. Route JSON and HTML through one shared chat import function.

Round-trip empty note/name/local-lore boundary values and malformed shapes.
