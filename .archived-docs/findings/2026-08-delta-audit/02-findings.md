# Delta audit — findings register

Built 2026-08-04/05 at `9b589e0e` from the delta audit defined in
[00-coverage-map.md](00-coverage-map.md). Review clusters: A (persistence
spine), B (encoding/cache identity/save path), C (plugin storage), D
(upstream merge/writer protocol/exports), plus the standing-surface sweep
(S) and migration-window archaeology ([01-migration-windows.md](01-migration-windows.md)).
Every finding below was independently re-verified against HEAD code by the
audit coordinator before inclusion. Severity uses the audit corpus
convention (fatal = realistic live-data loss; warning = bounded/conditional
loss or fidelity harm).

**Remediation status (2026-08-05):** DA-2 fixed `3d820335`; DA-4 fixed
`d8e68f05`; DA-3 fixed `7dd00712` (epoch fence + base-hash precondition;
legacy/headerless callers retain prior behavior by design); DA-13 fixed
`b2bd0ef2`. DA-1 closes when the branch is pushed. The warnings
(DA-5..DA-12, DA-14..DA-16) remain open and should be folded into
`WORK-INDEX.md` at the next indexing pass.

## Fatal

### DA-1. Push gap: remote tip runs the strict-storage-detaching migration (M1)
`origin/serve` = `208fc56a`; fix `9b589e0e` local-only. Marker-gated
migration means no self-repair after the fact. Full analysis in
[01-migration-windows.md](01-migration-windows.md). **Action: push.**

### DA-2. 409 rebase reverts edits made after proposal capture (B-F1)
Surface: `e2ca4ddd` + `e1e60b0d` client save/conflict path.
`triggerSave()` freezes `toSave`/`revisionProposal` before the network
await ([globalApi.svelte.ts:1133](../../../src/ts/globalApi.svelte.ts)); on
409, rebase overlays only the frozen tracked set
([databaseClone.ts:266](../../../src/ts/storage/databaseClone.ts)) onto the
server graph and installs it via `setDatabase()`. Any branch mutated
*during* the await (MCP, plugins, UI edits to another character) is
reverted in memory; its still-dirty revision then persists the reverted
bytes. Silent acknowledged-edit loss under ordinary 409s (multi-tab,
passive writes, server self-mutation). Fix direction: union the rebase
overlay with dirty revisions created after capture.

### DA-3. Server restart lets a pre-restart tab replace newer chat rows (D-F3)
Surface: merge cluster (`1b9e536f`, `eae52cbc`, `818c3bc1`) + chat full-row
fallback. The writer lock is process-local; after restart `peek()` reports
`free` ([session-lock.cjs:68,99](../../../server/node/session-lock.cjs)) and
initialized tabs never re-run the freshness handshake
([nodeStorage.ts:1655](../../../src/ts/storage/nodeStorage.ts)). A stale
tab's refused chat delta is swallowed into an unconditional full-row write
([nodeStorage.ts:6253](../../../src/ts/storage/nodeStorage.ts)); the server
row write has no base-hash precondition
([server.cjs:18663](../../../server/node/server.cjs)). A newer chat row
written by another tab before the restart is replaced. Mitigation: the
pre-image capture immediately before the row write preserves a recovery
copy (rotation-bounded). Fix direction: persistent boot epoch on the lock;
already-initialized clients observing `free`/new-epoch must reload before
writing; carry the chat base hash on the full-row fallback.

### DA-4. Streamed package import is fail-open on missing/short chat entries (D-F4)
Surface: `bcb67b3a`. `importChatsToCharacter()` returns `null` on a
missing/invalid declared chat entry
([characterPackage.ts:311-315](../../../src/ts/characterPackage.ts)) and
never compares parsed count to `manifest.chats.count`; both callers discard
the result and report success
([characterPackage.ts:749,818](../../../src/ts/characterPackage.ts)). A
migration-vehicle import can silently produce a character with fewer or
zero chats; discarding the package makes it permanent. Fix direction: fail
the import (or surface a partial-import outcome) on entry absence and count
mismatch before success is reported.

### DA-13. Plugin-storage viewer save silently retypes unchanged values (C-F1)
Surface: `e53ec7a3`/`783a4ef8` viewer + `244d7a88` lossless values. The
facet projection collapses distinct values into one display text
([pluginStorageViewerFacets.cjs:6-10](../../../server/node/pluginStorageViewerFacets.cjs):
string `"true"` → `true`, `null`/`undefined` → `''`), and `saveEdit()`
re-parses that text into a typed value
([PluginStorageViewer.svelte:380-400](../../../src/lib/Setting/Pages/PluginStorageViewer.svelte)).
Opening a stored string `"true"` and pressing Save without editing writes
boolean `true`; `null` becomes `''`; `undefined` properties are deleted.
CAS passes because the row is unchanged. Silent live corruption through a
supported UI action. Fix: typed/canonical editable representation, or make
projection-lossy values read-only in the editor.

## Warning

### DA-14. Sparse-array holes densified in mode transition and folded snapshots (C-F2)
Reviewer-rated fatal; registered as warning because the trigger is narrow
(plugins relying on `i in arr` hole semantics). The transition transport
Packr densifies holes before publication — the compat test *asserts* the
loss as expected
([plugin-storage-bulk-transition.test.ts:119-131](../../../test/compat/plugin-storage-bulk-transition.test.ts))
— and folded RisuSave transcoding maps both `["u"]` and `["h"]` tags to
MessagePack `undefined`
([streamJsonToMsgpack.cjs:600-607](../../../server/node/streamJsonToMsgpack.cjs)),
so recovery copies lose hole identity even for correctly-encoded rows.
Fix: explicit occupancy transport (tags/bitmap) pre-Packr; versioned
hole/undefined distinction in folded publication.

### DA-15. Recovery offers `use-inline` repairs its action path cannot serialize (C-F3)
Inspection serializes with the lossless fallback, the resolving
transaction calls strict-only `serializePluginStorageRow`
([server.cjs:~6950](../../../server/node/server.cjs)); a lossless inline
copy offered as `canUseInline` throws, rolls back
(`PLUGIN_STORAGE_RECOVERY_ROLLED_BACK`), and the bad external row stays
authoritative. Recovery-availability defect, no direct loss. Fix: use
`serializeOptimizedPluginStorageRow` in the action path + a lossless
recovery-action test.

### DA-16. Queued recovery actions are not re-bound to the writer epoch (C-F4)
Destructive recovery resolution checks the session at the route, but the
queued FIFO callback mutates storage without rechecking ownership, and the
recovery HMAC binds no session/writer epoch
([server.cjs:12682-12722, 6607-6623](../../../server/node/server.cjs)). A
takeover between admission and execution can interleave a stale-boot
session's writes with the recovery publication. Fix: bind queued
destructive requests to a writer epoch and revalidate inside the callback
(423 on mismatch).

### DA-5. Live model-job claim precedes chat-row durability (D-F1)
Fast server-side completions claim the job and delete the pending-send
tombstone before the debounced chat save commits
([jobFetch.ts:263](../../../src/ts/process/request/jobFetch.ts),
[index.svelte.ts:2114](../../../src/ts/process/index.svelte.ts)); tab loss
in the window strands the reply beyond both recovery paths. Extends the
known merge follow-up. Fix: claim/delete behind a committed-save barrier.

### DA-6. Terminal job recovery can overwrite a newer generation via stale index (D-F2)
`jobRecovery` captures a message index, awaits the journal, then replaces
by index without re-checking generation/chat identity
([jobRecovery.ts:411,422,450](../../../src/ts/process/request/jobRecovery.ts));
a reroll completing during the await is overwritten with old journal text
and durably saved. Classic ID-addressing-across-awaits. Fix: re-resolve by
generation identity after every await; per-chat guard for terminal recovery.

### DA-7. Sidecar DBs reintroduce NORMAL-WAL rollback; shutdown does not drain (D-F5)
`model-jobs.db` / `request-logs.db` hard-code `synchronous=NORMAL`
([model-jobs.cjs:146](../../../server/node/model-jobs.cjs),
[request-logs.cjs:229](../../../server/node/request-logs.cjs)) — the
durability class the primary DB fix removed — and SIGTERM closes the store
without draining active jobs
([model-jobs.cjs:756](../../../server/node/model-jobs.cjs),
[server.cjs:21462](../../../server/node/server.cjs)), so a complete journal
can be recovered as an error. Fix: FULL profile + journal fsync before
terminal status; bounded drain on shutdown.

### DA-8. Post-snapshot streaming tokens can stay unsaved past the checkpoint interval (B-F2)
The active-chat tracker's timer re-arm re-touches without re-queuing
persistence
([activeChatDirtyTracker.svelte.ts:112-116](../../../src/ts/storage/activeChatDirtyTracker.svelte.ts));
a mutation landing in the dropped-subscription window becomes the new
baseline. Stalled generation + crash loses the coalesced tail. Fix: re-arm
during a live generation requeues a checkpoint.

### DA-9. Draft-save failures are swallowed with no retry or signal (S)
By design ([chatDraft.ts:68](../../../src/ts/storage/chatDraft.ts)): a
failed draft write is silently dropped; leaving the page then loses the
draft. The old index-failure→invisible-drafts issue is fixed; the sweep is
safe. Closes the v3-critic unaudited-surface item with one bounded finding.
Fix direction: bounded retry + composer indicator on persistent failure.

### DA-10. Lua `upsertLocalLoreBook` edits are discarded in non-display trigger modes (S)
The API mutates the cloned `char` ([scriptings.ts:766](../../../src/ts/process/scriptings.ts));
non-display trigger execution clones `char` and `chat` separately
([triggers.ts:1058,1075](../../../src/ts/process/triggers.ts)) and writes
back only specific fields (scriptstate, globalLore, …) — never
`chats[].localLore`. The upsert silently no-ops in exactly the modes
scripts use it; it works in display mode, making it intermittent. Fix:
write back through the live graph or add localLore to the writeback set.

### DA-12. Build-mismatch reload can discard an undurable composer draft (A-F1)
The 426 handshake's dirty probe checks database dirtiness only
([globalApi.svelte.ts:548-554](../../../src/ts/globalApi.svelte.ts)) — no
composer text, draft timer, or draft write queue — then auto-reloads
([clientBuildHandshake.ts:82-110](../../../src/ts/storage/clientBuildHandshake.ts)).
After a server deploy, text typed since the last durable draft write is
lost (the page-hide flush enqueues another old-build write that would 426).
Compounds DA-9. Fix: include pending/in-flight/failed draft persistence and
nonempty composer state in the shared dirty probe.

### DA-11. Gemini streaming thought-signature saves are fire-and-forget (S)
Streaming paths append `{{inlayeddata::<id>}}` before the signature save
settles ([google.ts:1053,1075](../../../src/ts/process/request/google.ts));
the non-streaming path awaits. A failed save leaves a dangling token —
generation-metadata fidelity loss on later turns. Fix: await before
appending, as at [google.ts:757](../../../src/ts/process/request/google.ts).

## Notes / hygiene (no loss path)

- `loadInternalBackup()` confirmed dormant — no reachable caller at HEAD;
  if ever invoked it replaces the live DB without barrier/pre-image.
  Delete it. Closes the v3-critic item.
- Asset-read failures during send are converted to null and the token is
  stripped from the outgoing prompt (stored data unaffected) — silent
  request-quality degradation, listed for awareness.
- Historical migration windows (M2/M3) and never-deployable windows (M4):
  see [01-migration-windows.md](01-migration-windows.md).
- Python worker protocol naming mismatch (`python` vs `pythonResult`)
  spotted in passing — functional, not data-loss; needs separate triage.

## Checked-and-clean highlights (verified guards, per reviewers)

- Patch ETag and delayed persistence share retained canonical bytes, bound
  to cache identity + generation + SQLite revision (server.cjs:544, 2636);
  SQLite triggers bump the revision on every mutation path
  (databaseRevision.cjs:23); segment memo reuse revalidates identity
  (dbCachedRead.cjs:127).
- Codec worker and sync fallback share one operation implementation with
  byte/hash parity coverage (payloadCodecOperations.ts:34).
- Send/reroll/continue resolve durable chaId/chatId targets; background
  jobs do not flip global doingChat (chatSendTarget.ts, generationState.ts).
- Main rollback export fails closed on missing rows and validates the
  folded version-7 DB before headers (server.cjs:7680–8153).
- Cached boot staging remains non-authoritative with raw fallback
  (nodeStorage.ts:4498); recovery-cache publication is generation-scoped
  (risuSave.ts:115).
- Pinned snapshots: token-equality republication inside the queue forces
  retry over mixed-generation publication (server.cjs:1636-1765); assembly
  materializes rows and op-logs from the same pinned connection.
- Frame migration: write→sync→rename→re-verify before source removal;
  legacy bundles removed only after full durable publication
  (chatBackups.cjs:997-1220); eviction protects the newest version.
- Ingress spool: exclusive creation, exact length checks, handle sync;
  ENOSPC/short-write are definite not-committed; ack only after the
  authoritative transaction (admittedIngressSpool.cjs:97-186).
- Chat delta log: append + metadata in one transaction, replay verifies
  hash/size/count, compaction is row-token CAS (chatRows.cjs:571-915);
  the client byte-proves patch replay before submission.
- Row reads retry on token change mid-read; hydration applies bytes only
  to the unchanged placeholder (chatRows.cjs:934-950, chatStorage.ts:236).
- Mode migration is crash-atomic at HEAD: generations, manifest, row
  hashes, database bytes, and deletions revalidated and committed together
  (server.cjs:15180-15347); ambiguous client outcomes latch a reload.
- Streamed single-row mutations verify length/digest/complete-JSON in
  private spools before queueing; publication is transactional
  (server.cjs:13560-13910); binary reads validate publication + codec +
  digest client-side.
- Manifest-revision acks are emitted only after the row/owner/manifest
  transaction; client caches are generation-bound and stamp-revalidated
  (pluginSaveStorage.ts:345-1484).
- Recovery (apart from DA-15/16) preserves publication lockstep; only a
  missing-generation or matching-manifest publication is mutable —
  quarantined rows are not silently adopted (server.cjs:6607-7010).
- Viewer facets and usage categorization are pure derivatives with
  revision gates and scan fallback; they never supply write payloads
  (DA-13 is the separate editable text projection).
