# Chat-version backups do not keep referenced inlays live

- Status: Open
- Severity: Medium
- Lens: D3
- Area: Area 7 — server file stores
- Extends: [The inlay gallery's orphan scan classifies referenced inlays as deletable](../../v2/fatal/inlay-orphan-scan-classifies-referenced-inlays-as-deletable.md)
- Affected code: `src/ts/process/files/inlays.ts:664-695`, `src/lib/Setting/Pages/InlayImageGallery.svelte:77-87`, `src/lib/Setting/Pages/InlayImageGallery.svelte:134-148`, `src/lib/Setting/Pages/InlayImageGallery.svelte:241-258`, `src/lib/Setting/ChatBackupList.svelte:133-150`, `server/node/server.cjs:5320-5336`

## Risk

Chat-version files and bundles are independently listed and restorable, but the
gallery's orphan classifiers scan only the current live chat index and in-memory
messages. Neither includes references that survive only in retained version
history, and deletion has no server-side recheck against those versions.

After a live chat is deleted, an inlay referenced by its pre-image appears safe
under “Orphan Chat.” Deleting it succeeds; later importing that supported backup
version restores the chat text with a permanently dangling inlay token. This
extends v2 with a distinct reference source even when live chats are hydrated.

## Required fix and coverage

Build reachability server-side over live rows and every retained loose, gzip, and
bundle version. Revalidate selected IDs under the storage queue before deletion
and prefer a trash/grace generation.

Test delete-live-chat, classify, restore-version, and media rendering end to end.
