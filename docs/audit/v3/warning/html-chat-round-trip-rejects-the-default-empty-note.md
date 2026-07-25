# HTML chat round trip rejects the default empty note

- Status: Open
- Severity: Medium
- Lens: L4, D3
- Area: Area 8 — mode matrix and round trips
- Affected code: `src/ts/characters.ts:205`, `src/ts/characters.ts:277`, `src/ts/characters.ts:470`, `src/ts/characters.ts:474`, `src/ts/storage/chatStorage.ts:20`

## Risk

HTML export serializes the complete chat, whose normal placeholder/default shape
uses `note: ''`. HTML import validates `message`, `note`, `name`, and `localLore`
by truthiness rather than nullishness and shape, unlike the JSON-v1 branch.

An ordinary chat whose note was never filled therefore exports successfully but
later imports as “no data.” The live database is not damaged, yet the recovery
copy is unusable for the default application state and gives no field-specific
diagnosis.

## Required fix and coverage

Validate array types and nullish required fields, then normalize and assign a
fresh ID. Route JSON and HTML through one shared chat import function.

Round-trip empty note/name/local-lore boundary values and malformed shapes.
