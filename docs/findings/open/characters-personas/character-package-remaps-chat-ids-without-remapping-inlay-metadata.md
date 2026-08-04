# Character package remaps chat IDs without remapping inlay metadata

- Status: Open
- Owner: characters and personas
- Source: [2026-07 data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Low
- Lens: L3, D1, D3
- Area: Area 8 — mode matrix and round trips
- Affected code: `src/ts/characterPackage.ts:411-480` (`importInlays`), `src/lib/Setting/Pages/InlayImageGallery.svelte:275` (reference-guarded deletion result handling), metadata-based orphan filters and chat-filter navigation in the gallery
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../../../.archived-docs/findings/2026-08-revalidation/README.md)

## Risk

Packages record each inlay's `chatId`. Import gives every packaged chat a fresh
ID (the streamed importer from `bcb67b3a`/`d8e68f05` kept the shape), but inlay
import still copies the old `meta.chatId` unchanged while replacing only
`charId`, and no old-to-new chat ID map exists. Colliding inlay IDs are still
silently skipped, so an append import can also point metadata at a pre-existing
chat that happens to share the old ID.

Since the original report, `dad24f6f` added authoritative reference-guarded
deletion: the server scans chat messages (`/api/inlays/references`,
`/api/inlays/delete-unreferenced`) and refuses to delete an inlay a chat still
references, and the gallery surfaces that refusal. The former escalation —
valid imported media deleted as unowned — is therefore closed. What remains is
fidelity loss: ownership classification, the orphan-chat and orphan-character
filters, and chat-filter navigation use exact metadata IDs, so imported media
shows as orphaned or raw-ID-owned and cannot be navigated by its imported chat.

## Required fix and coverage

Build an old-to-new chat ID map alongside the persona map and rewrite every
inlay metadata reference. Define collision behavior for inlay IDs instead of
silently skipping packaged bytes.

Round-trip packages with multiple chats, shared media, and ID collisions, and
assert gallery classification and navigation for the imported chats.
