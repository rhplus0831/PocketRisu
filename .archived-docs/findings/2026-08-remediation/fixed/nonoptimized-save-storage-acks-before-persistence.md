# Non-optimized plugin save storage acknowledges before persistence

- Status: Fixed (2026-08-05 remediation queue)
- Owner: plugin storage
- Source: [2026-07 data-loss audit](../../2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium (at fix time)
- Resolution: `67f9eb96` — inline mutations now share the optimized-mode
  durability contract:
  - Every inline V3 publication boundary — `setPluginSaveStorageItem`,
    `setOwnedPluginSaveStorageItem`, both removes,
    `atomicBatchOwnedPluginSaveStorage` (which also carries `setFromRead`,
    `updateItem`, `rewriteItem`, and the viewer's Save File edits/deletes),
    and both clears — awaits `confirmInlinePluginStorageDurability()` after
    the detached in-memory publication and resolves, or reports `committed`,
    only when a `requireDurable` `requestImmediateSave()` returns
    `committed`.
  - Concurrent inline publications coalesce into one shared durability
    ticket. The ticket stays joinable only until its `requestImmediateSave()`
    call is issued, so a joined save is always requested after every joined
    publication; single-threaded ordering makes the invariant checkable.
  - A non-committed save outcome throws `StorageError`
    `PLUGIN_STORAGE_INLINE_DURABILITY` with `commitOutcomeUnknown: true` and
    never rolls back the published memory state — the ordinary save loop
    keeps retrying it, so outcome APIs classify the failure as the honest
    `unknown` rather than a false `committed` or a false `not-committed`.
  - The caller-facing abort race is fenced after publication
    (`awaitWithAbortUntilPublication()` plus a per-operation
    `requireDurability()` mark), so a late cancellation cannot replace the
    durability result once memory has been mutated; optimized-mode paths keep
    their previous abort semantics.
  - Bounded exceptions: no-op inline removes and clears skip the flush, and
    writes made before `saveDb()` installs the save loop resolve staged
    (`isImmediateDatabaseSaveReady()` in `globalApi.svelte.ts`) because
    `capturePreTrackingPluginStorageChanges()` carries boot-window writes
    into the first ordinary save and `loadPlugins()` precedes `saveDb()`, so
    waiting would deadlock plugin load. V2/V2.1 synchronous writes remain
    outside the gate by design.
- Regression coverage: `src/ts/plugins/pluginSaveStorage.test.ts` "inline
  plugin storage durability" (ack gated on the pending save; failed/retry/
  displaced outcomes reject with `commitOutcomeUnknown` while the publication
  stays readable; absent-key remove and no-op clears never flush; committed
  batch gates while a revision conflict does not; guarded set-from-read
  surfaces the unknown write; outcome APIs map flush failure to `unknown` and
  success to `committed`; same-turn disjoint sets coalesce into one save;
  boot-window set/remove/batch/outcome writes resolve staged without a flush;
  optimized-mode set/remove/outcome/failure paths never touch
  `requestImmediateSave`).
- Canonical architecture: [plugin storage](../../../../docs/structure/plugin-storage.md)

## Original risk (historical)

Optimized plugin storage awaits its transactional server publication. In the
default inline mode, the same APIs mutated the reactive map and resolved as
soon as the in-memory publication completed; the actual database write was
scheduled later by the ordinary reactive save loop.

The module had been rebuilt since the original report (per-key queues, an
inline publish mutex, revision hashing) and the surface had broadened:
guarded batches, the outcome APIs, and viewer CAS rewrites could all report a
committed result — `setItemWithOutcome` literally returned outcome
`'committed'` — for a memory-only inline publication. That terminology
collided with the repository's committed-save contract, under which
"committed" is supposed to prove durability. A page unload or a later save
failure inside the window silently reverted an acknowledged plugin write, and
the viewer's inline save success had the same gap. API durability changed
with the storage mode.
