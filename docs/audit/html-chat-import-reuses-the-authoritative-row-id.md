# HTML chat import reuses the authoritative row ID

- Status: Open
- Severity: High
- Lens: L3, L4, D1
- Area: Area 8 — mode matrix and round trips
- Affected code: `src/ts/characters.ts:277`, `src/ts/characters.ts:470`, `src/ts/characters.ts:474`, `src/ts/storage/chatPersistStage.ts:21`, `src/ts/storage/chatPersistStage.ts:155`, `server/node/chatRows.cjs:16`

## Risk

HTML export embeds the complete chat with its existing ID. Unlike both JSON
import branches, HTML import inserts that object unchanged. External chat rows
are uniquely keyed by character and chat ID, while the client candidate stage
deduplicates that pair and saves the first matching chat slot.

Importing an HTML chat into its source character thus creates two visible chats
sharing one authoritative row. Edits to the imported slot can be applied through
the first slot or never selected for persistence. After save and reload, the
second chat resolves to the first row and the user's new work silently vanishes.

## Required fix and coverage

Assign a fresh chat ID in the HTML branch before insertion, using the shared JSON
import normalization path. Also reject or remap duplicate chat IDs within one
character even when the inputs are already stubs.

Add an HTML export/import/edit/save/reload test in the same character and assert
distinct IDs, rows, and independently preserved messages.
