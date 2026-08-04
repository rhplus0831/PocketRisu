# Chat-version import reports success before anything is persisted

- Status: Open
- Owner: backup and recovery
- Source: [2026-07 data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Low
- Area: client recovery UI
- Affected code: `src/lib/Setting/ChatBackupList.svelte:149-150` (success toast right after in-memory import), `src/ts/storage/chatStorage.ts:137-166` (`importChatBackup` appends in memory and marks dirty only)

## Risk

Importing a chat-history version appends a fresh-ID chat to the in-memory
database and immediately notifies success; durability depends on the polling
save loop. Closing or crashing the page before that save makes the "imported"
chat vanish. The original version file still exists, so this degrades
recovery UX rather than losing the underlying data — but a user acting on the
success message (e.g. deleting the version afterwards) can lose it for real.

## Required fix and coverage

Await an immediate save (chat row + stub commit) before showing success; on
failure keep a visible pending state. Test: import, kill before save, reload,
assert either the chat exists or no success was reported.
