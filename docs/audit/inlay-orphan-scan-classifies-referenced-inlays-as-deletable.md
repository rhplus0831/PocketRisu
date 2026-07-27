# The inlay gallery's orphan scan classifies referenced inlays as deletable

- Status: Open
- Severity: High
- Area: client file management (inlay gallery)
- Affected code: `src/ts/process/files/inlays.ts:670-695` (`scanInlayReferences` reads only in-memory `chat.message`), `src/ts/storage/chatStorage.ts:20-29` (placeholders have `message: []`), `src/lib/Setting/Pages/InlayImageGallery.svelte:86` (orphan-message filter treats refCount 0 as orphan), `src/lib/Setting/Pages/InlayImageGallery.svelte:241-258` (delete flow), `server/node/server.cjs:4072-4081` (`/api/remove` deletes payload, sidecar, and KV rows without a reference check)

## Risk

At boot every chat stub becomes a placeholder whose `message` array is empty;
messages hydrate only when a chat is opened. `scanInlayReferences()` counts
`{{inlay::...}}` references by iterating those in-memory arrays synchronously —
it never hydrates placeholders — so immediately after boot virtually every
chat-message inlay counts zero references.

The gallery's "orphan message" filter shows exactly those zero-reference items
as safe to clean up. A user who selects the apparent orphans and confirms the
generic deletion prompt permanently deletes images that their chats still
reference: the server removes the filesystem payload, sidecar, thumbnail, and
KV fallback with no server-side reference validation, and inlays are absent
from DB-only snapshots. Later hydration restores the `{{inlay::id}}` markers,
which now render as missing images.

This is not misuse: the feature's entire purpose is finding unreferenced
images, and the UI's classification is wrong for any chat not opened this
session.

## Required fix and coverage

Hydrate (or better, scan server-side over the authoritative chat rows) before
offering message-orphan deletion, and re-validate the selected IDs against
chat rows under the storage queue immediately before deleting. Consider a
trash/grace period for gallery deletions.

Cover with a test that seeds a chat row referencing an inlay, boots a client
without opening the chat, runs the orphan scan, and asserts the inlay is not
classified as deletable.
