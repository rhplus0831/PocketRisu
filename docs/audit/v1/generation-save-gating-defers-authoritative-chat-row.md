# Generation save gating defers the authoritative chat row

- Status: Fixed
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

## Resolution

Saves during generation no longer skip `/api/chat-content` wholesale. The chat-row persistence stage was extracted from the `persistTrackedChanges` closure into `../../../src/ts/storage/chatPersistStage.ts` and now writes throttled checkpoints while `doingChat` is true: the first save of a generation always writes each dirty chat's row (this is the pre-generation user-message checkpoint, and it covers never-persisted new chats), and subsequent saves rewrite a row once `CHECKPOINT_INTERVAL_MS` (20 s) has elapsed since that chat's last checkpoint. The per-generation checkpoint tracker is cleared on the `doingChat` false→true transition. The server's existing 45 s per-chat pre-image cooldown (`chatBackups.cjs`) means these checkpoints do not create a version backup per streaming fragment, while the first checkpoint of a turn still captures the pre-turn state as the version pre-image. No server changes were needed.

Row-before-stub ordering is now structural: `prepareChatPersistStage()` performs all row writes and rejects on any failure before the caller may encode or commit the stubs-only database.bin, and every dirty chat is still requeued during generation so the `doingChat` true→false transition persists the final row. Normal and forced (`forceChatPersist`) saves write all rows unconditionally and refresh checkpoint timestamps.

`updateKnownChatsAfterSuccessfulSave` no longer marks a chat known just because it appears in the character's chat list: a chat id enters the known set only if it was already known (and still exists) or the row stage supplied explicit durability proof for it — a successful row write in this save, or a checkpoint recorded earlier in the same generation — and only after the stub commit actually succeeded (`completeStubCommit({ committed: true })`; noop/retry/conflict paths leave the known set untouched). A deferred new chat can therefore no longer become a durable phantom stub.

Regression coverage in `../../../src/ts/storage/chatPersistStage.test.ts`: a save with `doingChat` true followed by simulated process loss/reload must leave every committed stub resolvable against the row store with the pre-generation user message present; a failing row write must prevent the stub commit; generation checkpoints throttle within the interval but forced saves pass through; the post-generation save writes the final response and marks the new chat known only after a committed stub write; pre-existing placeholders are skipped without losing their known-row proof.
