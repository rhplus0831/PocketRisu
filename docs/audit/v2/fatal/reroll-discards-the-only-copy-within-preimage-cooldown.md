# Reroll can leave no durable copy of the discarded response

- Status: Open
- Severity: High
- Area: chat pipeline / chat version backups
- Affected code: `src/lib/ChatScreens/DefaultChatScreen.svelte:453-459` (old response and swipes held only in local variables), `src/lib/ChatScreens/DefaultChatScreen.svelte:481-483` (reason tag + truncation committed before generation), `server/node/chatBackups.cjs:606-613` (cooldown skips capture regardless of reason), `src/ts/storage/chatPersistStage.ts:144-180` (first generation checkpoint persists unconditionally), `server/node/server.cjs:284-287` (5-minute snapshot cooldown)

## Risk

Reroll removes the last response (and its swipe history) from the live chat
before generation starts, keeping the only copies in local JavaScript
variables (`originalMessages`, `savedSwipes`). The generation checkpoint
machinery then durably persists the *truncated* row within moments — that part
works as designed.

The recovery layer is supposed to be the chat pre-image system:
`setChatBackupReason(..., 'reroll')` marks the next row overwrite. But
`captureChatPreImage()` applies its cooldown before anything else and returns
`skipped-cooldown` whenever any version of that chat was captured within the
window — the reason only influences the version's filename. Rerolling shortly
after the response arrived (the normal case: you reroll what you just read,
and its save captured a version moments ago) therefore skips the capture, and
the 5-minute snapshot cooldown typically suppresses the DB snapshot as well.

From that point until generation completes, closing the tab, a browser crash,
or a failed completion path leaves the truncated row as the only durable
state: the discarded response and its entire swipe history exist nowhere.
Aborting mid-generation and losing the page before the in-memory restore also
qualifies. No crash on the server is required.

## Required fix and coverage

Make destructive-operation pre-images (reroll, message delete) cooldown-exempt
— capture before the truncation is persisted and abort the destructive path if
capture fails — or generate into a pending buffer and swap the visible history
only on success.

Cover with a restart test: save a response, reroll within the cooldown, kill
the client before completion, and assert the previous response is recoverable
from chat versions.
