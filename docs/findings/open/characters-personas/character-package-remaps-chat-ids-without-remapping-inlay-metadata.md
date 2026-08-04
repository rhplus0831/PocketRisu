# Character package remaps chat IDs without remapping inlay metadata

- Status: Open
- Owner: characters and personas
- Source: [2026-07 data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium
- Lens: L3, D1, D3
- Area: Area 8 — mode matrix and round trips
- Affected code: `src/ts/characterPackage.ts:277`, `src/ts/characterPackage.ts:367`, `src/ts/characterPackage.ts:379`, `src/ts/characterPackage.ts:580`, `src/lib/Setting/Pages/InlayImageGallery.svelte:119`, `src/lib/Setting/Pages/InlayImageGallery.svelte:139`

## Risk

Packages record each inlay's `chatId`. Import gives every packaged chat a fresh
ID, but inlay import copies the old `meta.chatId` unchanged while replacing only
`charId`. Gallery ownership and orphan classification require exact IDs.

The imported chat and media bytes remain visible, yet their metadata points to
nonexistent old chats. The gallery reports them as orphaned or only by raw ID,
and filtering/navigation by the imported chat fails, making valid media more
likely to be deleted as unowned.

## Required fix and coverage

Build an old-to-new chat ID map alongside the persona map and rewrite every
inlay metadata reference. Define collision behavior for inlay IDs instead of
silently skipping packaged bytes.

Round-trip packages with multiple chats, shared media, and ID collisions.
