# Reroll can leave no durable copy of the discarded response

- Status: Fixed (2026-08-05 remediation queue)
- Owner: chat pipeline
- Source: [2026-07 data-loss audit](../../2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: High (at fix time)
- Resolution: `a772b134` — backup reasons `reroll`, `delete-message`, and
  `delete-swipe` (sanitized) classify as destructive row overwrites; all three
  chat write paths capture their pre-image with `force: true, required: true`
  (the wiring whole-chat deletion already used), and a capture failure rejects
  the write 500 `CHAT_PREIMAGE_CAPTURE_FAILED` with a definitive not-committed
  envelope before anything mutates. The client consumes the pending backup
  reason only after a successful save (object identity protects a newer
  in-flight reason), so save-loop retries keep the destructive marker, and
  swipe deletion — previously unprotected — tags `delete-swipe`. Ordinary
  saves keep the cooldown and swallowed capture errors unchanged.
- Regression coverage: `test/compat/chat-content-row.test.ts` (back-to-back
  destructive captures within the cooldown with byte-exact recovery of the
  discarded rows; retained ordinary-save cooldown; capture-failure abort vs
  ordinary passthrough), `server/node/chatBackups.test.ts` (sanitized
  destructive classifier), `src/ts/storage/chatStorage.test.ts`
  (retry-retention and in-flight reason semantics).
- Canonical architecture: [chat pipeline](../../../../docs/structure/chat-pipeline.md)

## Original risk (historical)

Reroll removes the last response (and its swipe history) from the live chat
before generation starts, keeping the only copies in local JavaScript
variables (`originalMessages`, `savedSwipes`). The generation checkpoint
machinery then durably persists the *truncated* row within moments.
`setChatBackupReason(..., 'reroll')` marks the next row overwrite, but
`captureChatPreImage()` applied its cooldown before anything else and returned
`skipped-cooldown` whenever any version of that chat was captured within the
window — and rerolling shortly after the response arrived is the normal case.
From that point until generation completed, closing the tab, a browser crash,
or a failed completion path left the truncated row as the only durable state:
the discarded response and its entire swipe history existed nowhere.

## Original required fix (historical)

Make destructive-operation pre-images (reroll, message delete) cooldown-exempt
— capture before the truncation is persisted and abort the destructive path if
capture fails — or generate into a pending buffer and swap the visible history
only on success.
