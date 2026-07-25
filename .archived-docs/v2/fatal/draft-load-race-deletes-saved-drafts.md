# A draft read failure or a quick chat switch deletes the saved draft

- Status: Fixed
- Severity: High
- Area: client drafts
- Affected code: `src/lib/ChatScreens/DefaultChatScreen.svelte:99-142` (composer draft session lifecycle), `src/ts/storage/chatDraft.ts:43-196` (load outcomes, persistence queue, and session safety)

## Risk

Opening a chat clears both composer inputs, then loads the draft
asynchronously. Two paths turn that temporary empty state into an
authoritative delete of the stored draft:

1. **Read failure**: `loadChatDraft()` catches any fetch/decode error and
   returns `null` — indistinguishable from "no draft". The UI ends its loading
   state with empty inputs, the reactive save effect fires on the
   `draftLoading` transition, and 800 ms later `persistSave` routes the empty
   draft to `persistRemove()`, which deletes the existing key. One transient
   server error while opening a chat erases its draft.

2. **Quick chat switch** (no failure needed): switching chats before the load
   resolves runs the effect cleanup, which flushes the *cleared* inputs for
   the chat being left — `persistRemove()` again. Browsing through chats
   fast enough to outpace one network round-trip deletes their drafts.

Drafts are the only copy of unsent user-typed text, exist specifically to
survive navigation, and are excluded from every backup, so the loss is
permanent and silent.

## Required fix and coverage

Distinguish `found` / `absent` / `error` in `loadChatDraft` and never persist
an empty composer after an error. On unmount-during-load, cancel without
writing (or merge with the loaded value) instead of flushing the cleared UI
state.

Cover with tests: (a) failed read must not remove the server draft; (b)
mount→unmount before load resolution must leave the draft intact.

## Resolution

`loadChatDraft()` now returns distinct `found`, `absent`, and `error` results.
A failed prefix-list request also leaves the index uninitialized so later
operations retry instead of treating the failure as proof that no drafts exist.

`ChatDraftSession` now owns each mounted composer's load and persistence state.
An empty composer is authoritative only after a successful `found` or `absent`
load. While loading or after an error, non-empty text the user typed may still be
saved, but temporary empty inputs cannot schedule or flush a removal. Closing the
session invalidates a late load result without writing those cleared inputs.

Regression tests cover both a failed read and closing a session before its
blocked read resolves; each verifies that the saved server draft remains intact.
