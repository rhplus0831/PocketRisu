# Non-selected character and chat writes have no save scheduler

- Status: Open
- Severity: High
- Lens: L1
- Area: Area 1 — client change detection and save scheduling
- Affected code: `src/ts/globalApi.svelte.ts:367`, `src/ts/globalApi.svelte.ts:611`, `src/ts/globalApi.svelte.ts:648`, `src/ts/storage/chatStorage.ts:157`, `src/ts/process/mcp/risuaccess/utils.ts:4`, `src/ts/process/mcp/risuaccess/characters.ts:497`, `src/ts/plugins/apiV3/v3.svelte.ts:972`

## Risk

The reactive effects deeply observe only the selected character and its active
chat. The selected-character stub projection also omits persisted
`ChatStub.modules`. Arbitrary-index V3 setters and Risu-access MCP mutations can
change any character or chat without calling the sole explicit dirty bridge;
there is no equivalent bridge for an existing inactive chat row.

Those writes can return success while no save is scheduled. On the home screen,
even an array-slot wake-up drains with no dirty flag. An idle refresh then
reverts a non-selected character edit, while inactive chat bodies and module
metadata can remain unsaved unless an unrelated later save incidentally rescues
them. Conflict rebase overlays only explicitly tracked character IDs.

## Required fix and coverage

Provide explicit `markCharacterDirty(chaId)` and
`markChatDirty(chaId, chatId)` bridges and require every arbitrary-target API,
MCP action, and background mutation to use them. Include `modules` in the stub
dependency projection.

Test every persisted domain on non-selected characters and inactive chats,
including `selectedCharID === -1`, and assert a row/block write before reload.
