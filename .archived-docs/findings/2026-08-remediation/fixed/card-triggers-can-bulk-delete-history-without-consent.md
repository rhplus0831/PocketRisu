# Imported card triggers can bulk-delete chat history without the low-level-access consent

- Status: Fixed (2026-08-06 remediation queue)
- Owner: scripting and extensions
- Source: [2026-07 data-loss audit](../../2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium (at fix time)
- Area: scripting / trust boundaries (upstream-inherited surface)
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../2026-08-revalidation/README.md)
- Resolution: this remediation commit — adds an independent
  `destructiveAccess` owner capability for characters and modules. Character-card,
  direct module, `.risum`, and CharX import paths inspect V1/V2 chat cuts, V2 lorebook
  deletion, Lua `cutChat`/`removeChat`/`setFullChat` calls, and literal destructive
  trigger commands (`/cut`, `/del`, and `/multisend clear`) and require explicit
  destructive consent. Dynamic V1/V2 command values are classified again at execution.
  Imported grants are cleared until confirmed, and accepting this
  consent does not grant unrelated `lowLevelAccess`. CharX preserves an embedded
  module's declared request before clearing it for confirmation, including dynamically
  aliased Lua that static scanning cannot see. Runtime owner and per-run grants require
  literal boolean `true` and gate all of those effects. A chat mutation marker flows
  through nested triggers and Lua, while publication sites resolve captured character
  and chat IDs and queue `script-bulk-chat` only for the durable target that still
  exists. Lua edit and button hooks run chat mutations against isolated clones and publish
  changed clones only after every awaited hook completes. Repeated hooks resolve the
  current durable row before each run, and publication rejects a stale source identity or
  pre-run state so same-ID replacements and concurrent message appends survive. Destructive publication queues
  the forced reason synchronously immediately before stable-ID replacement, while a
  disappeared target is discarded. Trigger commands operate on that captured target's snapshot rather than the
  mutable UI selection; target-aware multisend publishes before its nested send and
  refreshes the snapshot afterward. Pending destructive reasons outrank ordinary edits through the matching save
  acknowledgement. Full-row and delta saves carry that reason; the server classifies it
  as forced and required, bypassing the 45-second cooldown and rejecting the write
  definitively if the exact pre-image cannot be captured.
  `runTrigger()` keeps message, author-note, metadata, `scriptstate`, and getter-output
  mutations on its owned clone until guarded publication, so its own variable writes do
  not invalidate the guard. Stable-`chaId` field updates preserve intentional character
  and lorebook side effects without replacing a selected character's chat graph, and
  intermediate multisend child turns propagate a refreshed publication guard.
  Guard continuity spans input, manual, start, streaming/non-streaming output, V1/V2
  recursion, nested slash `/trigger`, and command pipelines. Intermediate multisend
  publication consumes the incoming guard and aborts before backup/send on a stale
  source; successful owned transitions alone refresh the guard.
  Multisend refuses a nested send while the target chat already has a generation entry,
  preventing start/output triggers from clearing their outer guard. With no pre-existing
  entry, it captures the opaque ownership token synchronously acquired by that nested
  `sendChat()` and conditionally releases only an entry still carrying that token. The
  token and abort controller follow auto-continue/resend through a one-shot explicit
  handoff; a replacement prevents recursion, and a restart rejected before registration
  cancels its handoff without leaking state to the next owner. Unrelated same-key
  replacement owners survive stop, UI, success, false, and exception settlement cleanup.
  Direct V3 plugin, hotkey preview, DevTool preview/autopilot, and PO-file multisend roots
  likewise observe the exact synchronous registration event and conclude only that token
  in `finally`, including synchronous throw/replacement paths. PO batches re-resolve their
  initially captured owner IDs for every entry, so navigation cannot redirect mutations.
  No production per-request root uses the global administrative `endAllGenerations()` reset.
- Regression coverage: `src/ts/process/scriptCapabilities.test.ts` (V1/V2/Lua import
  and literal command detection, explicit grant/rejection, low-level separation, and
  embedded CharX module declaration propagation),
  `src/ts/process/command.triggerTarget.test.ts` (V1/V2 command policy, actual-mutation
  marking, target binding across navigation/removal, multisend publication, and backup
  ordering, awaited multisend concurrency, nested trigger guard continuity, and nested
  generation ownership across rejection/success/error, direct-request roots, scoped
  continuation/resend, UI conclusion, restart-before-registration, and same-key
  replacement races),
  `src/ts/process/triggers.destructiveAccess.test.ts` (V1/V2 cut and V2 lore-deletion
  runtime gates and mutation marker, isolated input variables/getter output/author note,
  concurrent-append rejection, repeated output/manual publication, and stable owner
  binding plus manual/start/output in-place and replacement races),
  `src/ts/process/scriptings.destructiveAccess.test.ts`
  (Lua cut/remove/whole-chat replacement gates and marker, isolated delayed edit/button
  publication ordering, repeated multiline output hooks, stale same-ID replacement and
  in-place mutation rejection, disappeared targets, and non-destructive clone publication),
  `src/ts/process/chatSendTarget.test.ts` (durable-target publication and disappeared
  target), `src/ts/storage/chatStorage.test.ts` (destructive-reason priority and
  in-flight acknowledgement coalescing), `src/ts/storage/nodeStorageAvailability.test.ts` (full/delta reason
  propagation), `server/node/chatBackups.test.ts` (destructive classifier), and
  `test/compat/chat-content-row.test.ts` (delta pre-image, cooldown-exempt repeated exact
  recovery, and capture-failure abort).
- Canonical architecture: [scripting and extensions](../../../../docs/structure/scripting-extensions.md),
  coordinated with [backup and recovery](../../../../docs/structure/backup-recovery.md)

## Original risk (historical)

The only import-time consent prompt fired when a card declared
`lowLevelAccess`; `triggerscript` contents were accepted without inspection,
and bulk chat mutation (`v2CutChat`, Lua `setFullChat`, lorebook deletion) was
classified as a normal capability. V1/V2 command effects also delegated `/cut`, `/del`,
and `/multisend clear` to the mutable UI selection without a capability check. A malicious or buggy shared card could wipe
the entire message array on an ordinary send, and the reactive save persisted
the wipe. Chat-version pre-images usually provided recovery, but the 45-second
capture cooldown could skip it, making the loss permanent. This required hostile
or defective third-party content, but importing shared cards is routine.

## Original required fix and coverage (historical)

Classify bulk-destructive effects (whole-array chat replacement/cuts,
lorebook deletion) as consent-requiring capabilities at import, and force a
cooldown-exempt pre-image before committing any script-driven bulk mutation.
