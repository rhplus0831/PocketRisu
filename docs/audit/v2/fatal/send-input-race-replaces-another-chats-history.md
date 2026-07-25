# Sending a message can replace another chat's history after an async trigger gap

- Status: Open
- Severity: High
- Area: chat pipeline (send flow)
- Affected code: `src/lib/ChatScreens/DefaultChatScreen.svelte:328-337` (captures character index and chat object), `src/lib/ChatScreens/DefaultChatScreen.svelte:368-380` (awaits input triggers and `editinput` scripts), `src/lib/ChatScreens/DefaultChatScreen.svelte:394` (assigns through the character's **current** `chatPage`), `src/ts/process/triggers.ts:2356-2360` (`v2Wait` = arbitrary `await sleep`), `src/ts/globalApi.svelte.ts:2712-2732` (`changeChatTo` has no generation guard)

## Risk

`sendMain()` captures the selected character index and the active chat's
message array, then awaits `runTrigger(char, 'input', ...)` and
`processScript(..., 'editinput')`. `$doingChat` is not yet set during these
awaits (it is set inside `sendChatMain()`), and `changeChatTo()` switches
`char.chatPage` with no guard, so the user can select another chat while the
trigger runs. Cards can make the window arbitrarily long (`v2Wait`,
LLM/translation hooks in `editinput`), but even the no-trigger window is
nonzero.

When the awaits resolve, line 394 assigns the captured (and now extended)
message array through the character's **current** `chatPage`:

```
DBState.db.characters[selectedChar].chats[...chatPage].message = cha
```

If the selection moved from chat A to chat B, B's entire history is replaced
with A's messages, and the reactive save loop persists the replacement as B's
authoritative row. The server-side pre-image may be skipped by the 45-second
cooldown, in which case B's history is unrecoverable.

## Required fix and coverage

Capture `chaId` and `chatId` before the first await and resolve the target
chat by ID for every subsequent mutation, aborting if it is gone (the pattern
hydration already uses in `chatStorage.ts:193-230`). Optionally set the
interaction lock before running input hooks as defense in depth.

Cover with a test that delays an input trigger, switches `chatPage` during the
delay, and asserts the second chat's messages are untouched.
