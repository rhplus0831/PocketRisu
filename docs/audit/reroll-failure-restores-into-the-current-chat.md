# Reroll completion targets the currently selected chat, not the rerolled one

- Status: Fixed
- Severity: High
- Area: chat pipeline (reroll)
- Affected code: `src/lib/ChatScreens/DefaultChatScreen.svelte:448-483` (truncates chat A, captures `originalMessages` locally, awaits generation), `src/lib/ChatScreens/DefaultChatScreen.svelte:485-503` (re-reads the **current** selection for restore/comments/swipes), `src/ts/globalApi.svelte.ts:2712-2732` (`changeChatTo` unguarded during generation)

## Risk

`reroll()` truncates the selected chat A synchronously, then awaits
`sendChatMain()` — a window as long as the model request. Chat switching is
not blocked during generation (`sendChat()` internally captures its own
indices precisely because the selection can move). When the await returns, the
completion code re-reads `DBState.db.characters[$selectedCharID]` and its
current `chatPage`:

- On failure or user abort, it assigns A's `originalMessages` to whatever chat
  is selected **now**. "Reroll → switch to chat B → abort" replaces B's entire
  history with A's, and A stays truncated.
- On success, trailing comments and the swipe merge are applied to the current
  chat, corrupting B and leaving A without its restoration.

The reactive save loop then persists the wrong-target write as B's
authoritative row. The pre-image reason tag set at reroll time
(`setChatBackupReason`) labels A, not B, and B's own pre-image may be skipped
by the capture cooldown.

## Required fix and coverage

Capture the rerolled `chaId`/`chatId` and resolve the chat by ID for the
truncation, the failure restoration, the trailing-comment re-append, and the
swipe update; abort each step if the chat no longer exists. Never address
reroll completion through the live selection.

Cover with a test that switches chats during a mocked failing generation and
asserts (a) the second chat is untouched and (b) the rerolled chat gets its
original messages back.

## Resolution

Fixed 2026-07-29. `reroll()` now captures the initiating `chaId` and `chatId`
before truncation, mutates the resolved target chat, and passes the same durable
target into `sendChat()`. After generation completes, failure restoration,
trailing-comment reattachment, and swipe publication resolve that target again
instead of reading the live character/chat selection. If the target no longer
exists, settlement stops without mutating another chat.

`chatSendTarget.test.ts` changes `chatPage` before both failed and successful
reroll settlement. The regressions verify that the originating chat is restored
or finalized and the newly selected chat remains untouched.
