# Imported card triggers can bulk-delete chat history without the low-level-access consent

- Status: Open
- Owner: scripting and extensions
- Source: [2026-07 data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium
- Area: scripting / trust boundaries (upstream-inherited surface)
- Affected code: `src/ts/characterCards.ts:830-835` (import consent gate checks only `risuext.lowLevelAccess`), `src/ts/process/triggers.ts:1798-1809` (`v2CutChat` = unrestricted `message.slice`), `src/ts/process/scriptings.ts:167-260` (Lua `cutChat`/`removeChat`/`setFullChat` outside low-level gating), `src/lib/ChatScreens/DefaultChatScreen.svelte:368-394` (input triggers run automatically on send)
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../../../.archived-docs/findings/2026-08-revalidation/README.md)

## Risk

The only import-time consent prompt fires when a card declares
`lowLevelAccess`; `triggerscript` contents are accepted without inspection,
and bulk chat mutation (`v2CutChat`, Lua `setFullChat`, lorebook deletion) is
classified as a normal capability. A malicious or buggy shared card can wipe
the entire message array on an ordinary send, and the reactive save persists
the wipe. Chat-version pre-images usually provide recovery, but the 45-second
capture cooldown can skip it, making the loss permanent. Requires hostile or
defective third-party content, hence warning — but importing shared cards is
routine in this ecosystem.

## Required fix and coverage

Classify bulk-destructive effects (whole-array chat replacement/cuts,
lorebook deletion) as consent-requiring capabilities at import, and force a
cooldown-exempt pre-image before committing any script-driven bulk mutation.
