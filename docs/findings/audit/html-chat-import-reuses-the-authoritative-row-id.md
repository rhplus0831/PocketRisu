# HTML chat import reuses the authoritative row ID

- Status: Fixed 2026-07-31
- Severity: High
- Lens: L3, L4, D1
- Area: Area 8 — mode matrix and round trips
- Affected code: `src/ts/chatImport.ts`, `src/ts/characters.ts`, `src/ts/storage/chatStorage.ts`, `src/ts/storage/chatPersistStage.ts`, `server/node/chatRows.cjs`, `server/node/server.cjs`

## Resolution

HTML and JSON chat imports now share `prepareChatForImport()`, which clones the
transported payload, removes cold-storage markers, restores the required full
chat fields, and always assigns a fresh local ID. HTML payload encoding/parsing
is isolated in a testable interchange helper, so importing an export back into
its source character creates a distinct authoritative row identity.

The client persistence stage now rejects duplicate chat IDs within a character
before writing any chat row or committing database stubs. Direct server patch,
full-write, plugin-transition, and debounced-persist boundaries independently
reject duplicate IDs, including duplicate cold stubs that cannot be safely
renamed without copying their authoritative row. Boot ID repair likewise leaves
duplicate cold IDs visible for the integrity guard instead of creating a
dangling new row reference.

Coverage exercises HTML payload export/import with a fresh ID, editing the
imported chat, row-before-stub save, reload of both independent messages,
client rejection for duplicate full chats and cold stubs, server duplicate
detection, and atomic rejection of direct full writes and patches.

## Risk (historical)

HTML export embeds the complete chat with its existing ID. Unlike both JSON
import branches, HTML import inserts that object unchanged. External chat rows
are uniquely keyed by character and chat ID, while the client candidate stage
deduplicates that pair and saves the first matching chat slot.

Importing an HTML chat into its source character thus creates two visible chats
sharing one authoritative row. Edits to the imported slot can be applied through
the first slot or never selected for persistence. After save and reload, the
second chat resolves to the first row and the user's new work silently vanishes.

## Required fix and coverage (completed)

Assign a fresh chat ID in the HTML branch before insertion, using the shared JSON
import normalization path. Also reject or remap duplicate chat IDs within one
character even when the inputs are already stubs.

Add an HTML export/import/edit/save/reload test in the same character and assert
distinct IDs, rows, and independently preserved messages.
