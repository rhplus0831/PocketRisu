# Non-selected character and chat writes have no save scheduler

- Status: Fixed 2026-07-31
- Severity: High
- Lens: L1
- Area: Area 1 — client change detection and save scheduling
- Affected code: `src/ts/globalApi.svelte.ts`, `src/ts/storage/dirtyTargetBridge.ts`, `src/ts/storage/dirtyTargetDiff.ts`, `src/ts/storage/chatStorage.ts`, `src/ts/characterPackage.ts`, `src/ts/process/mcp/risuaccess/characters.ts`, `src/ts/plugins/apiV3/v3.svelte.ts`

## Resolution

The save loop now exposes explicit character and chat dirty bridges backed by a
startup-safe target buffer. Calls made before reactive tracking is ready drain
into the first ordinary save; later calls synchronously enqueue the durable
character ID or `(chaId, chatId)` row identity and wake the existing save loop.

V3 index setters and whole-database character replacements use a pure before/
after target diff. Character fields and chat stub metadata schedule character
blocks, while new or changed full chats schedule their authoritative rows.
Removed and replaced identities are retained as dirty targets, but runtime
placeholders are never treated as row data. Public index semantics, input
normalization, permissions, invalid-index behavior, and promise timing remain
unchanged. Every successful Risu-access character mutation, background chat
backup import, and new/existing character-package chat publication now uses the
same explicit bridges. The selected-character stub projection also observes
`ChatStub.modules`.

Coverage exercises bridge calls before and after save-loop activation, a row
write with no selected-character dependency, non-selected V3 character writes,
inactive full-chat writes, placeholder safety, chat stub fields including
`modules`, whole-database replacement, identity/reorder changes, every MCP
character mutation domain, denial/error compatibility, and backup/package
imported-chat row intent.

## Risk (historical)

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

## Required fix and coverage (completed)

Provide explicit `markCharacterDirty(chaId)` and
`markChatDirty(chaId, chatId)` bridges and require every arbitrary-target API,
MCP action, and background mutation to use them. Include `modules` in the stub
dependency projection.

Test every persisted domain on non-selected characters and inactive chats,
including `selectedCharID === -1`, and assert a row/block write before reload.
