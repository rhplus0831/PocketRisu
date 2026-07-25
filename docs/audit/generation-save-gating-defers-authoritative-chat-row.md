# Generation save gating defers the authoritative chat row

- Status: Open
- Severity: High
- Commit: `f8aac548`
- Affected code: `src/ts/globalApi.svelte.ts:503-527`, `src/ts/globalApi.svelte.ts:687-735`, `src/ts/globalApi.svelte.ts:838-867`, `src/ts/storage/nodeStorage.ts:971-989`

## Risk

While `doingChat` is true, `persistTrackedChanges()` requeues dirty chats only in browser memory and skips `/api/chat-content`. It nevertheless continues to encode and persist the stubs-only database. This breaks the required row-before-stub ordering.

For a new chat, a durable stub can be created while `chats/<chaId>/<chatId>` does not exist. For an existing chat, the durable row remains at its pre-turn state. Abrupt loss of the client-side state—a tab, browser, device, or client-process termination—before generation completes can therefore discard the user message and partial or completed response. On normal completion, the transition merely schedules another debounced save 500 ms later.

The page-hide mitigation is not durable. It starts an unawaited forced save, and the chat POST has no `keepalive`. The separate keepalive request only asks the server to flush a pending stub database; it does not transmit a missing chat row.

## Required fix and coverage

Persist at least the initial user-message/new-chat row before allowing its stub to commit. During long generations, write throttled checkpoints without capturing a pre-image for every streaming fragment, then persist the final row. Do not mark a deferred new chat as known/successful until its row is durable.

Add a test that runs a save while `doingChat` remains true and then simulates process loss/reload. Every durable stub must resolve, and the row must contain at least the pre-generation user-message checkpoint.
