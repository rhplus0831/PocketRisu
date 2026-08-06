# Client storage

> Part of the PocketRisu structure docs — see [STRUCTURE.md](../../STRUCTURE.md) for the top-level map and subsystem index.
> Audited 2026-08-04 against `95c2ea30`. Paths and symbols are authoritative; line-number hints are approximate and should be verified with `rg`.

## 1. Purpose & overview

The client-storage subsystem owns PocketRisu’s canonical `Database` model, its Svelte 5 reactive instance, save-format encoding/decoding, server-backed storage access, and startup migrations. It splits large chat bodies from `database.bin`: the database transported to the browser contains lightweight chat stubs, while full chats are fetched and saved separately through server endpoints. A staged reactive save loop observes database mutations, establishes durable chat rows before their stubs can commit, checkpoints active generations, then synchronizes the stub-only database through JSON Patch or an ETag-protected full write. An opt-in IndexedDB resource cache reuses SHA-256-verified database segments, chats, and optimized plugin values without becoming authoritative. The subsystem also owns composer draft sessions, explicit save outcomes, writer displacement, boot recovery orchestration, and client transport for [backup/recovery](backup-recovery.md) and [plugin storage](plugin-storage.md).

## 2. Key files

| File | Role and important symbols |
|---|---|
| `src/ts/storage/database.svelte.ts` | Canonical data model, defaults, Svelte-state accessors, preset/theme helpers. `setDatabase()` fills defaults and normalizes imported data; `setDatabaseLite()` only assigns `DBState.db`; `getDatabase()` can return a whole-graph `$state.snapshot`. Narrow serialization accessors are `getDatabaseFieldsSnapshot()`, `getCharacterSnapshot()`, metadata-only `getCharacterInterchangeSnapshot()`, and ID-aware `getCharacterChatSnapshot()`. The model also includes `optimizePluginMemory` and its inline/external ownership metadata. |
| `src/ts/globalApi.svelte.ts` | Creates the process-wide `forageStorage` adapter and implements database persistence. `requestImmediateSave()` returns an explicit save outcome; `markCharacterDirty()` and `markChatDirty()` bridge arbitrary-target mutations; and `saveDb()` installs reactive effects, writer-displacement checks, and the permanent save loop. It delegates save coordination to `databaseSave.ts` and row-before-stub/checkpoint decisions to `chatPersistStage.ts`. |
| `src/ts/storage/dirtyTargetBridge.ts`, `dirtyTargetDiff.ts` | Buffer explicit character/chat targets until the save loop is ready and compute compatibility-safe targets for V3 character-array replacements. The diff separates character/stub metadata from full chat rows and never promotes runtime placeholders to authoritative row data; streamed package import now writes its rows directly instead of using that diff. |
| `src/ts/storage/nodeStorage.ts` | HTTP client for the Node server. Besides auth, KV, patching, chat rows, cached boot reads, and key-list deltas, it owns bounded request/outcome handling, snapshot restore, backup jobs/replacements, and plugin-storage administration. `getPluginStorageRecoveryManagementInspection()`, `downloadPluginStorageRecoveryRow()`, and `resolvePluginStorageRecoveryIssue()` provide inspection, integrity-verified download, and no-replay resolution with unknown-outcome classification. `getPluginStorageManifestSnapshot()`, `getPluginStorageManifestState()`, and `getPluginStorageViewerPage()` expose generation-pinned snapshot/revision state and authenticated paging; manifest diagnostics can carry an `x-risu-diag` token. Detailed storage semantics live in [Plugin storage](plugin-storage.md). |
| `src/ts/storage/autoStorage.ts` | Compatibility facade that lazily selects `NodeStorage` and forwards the expanded chat, backup, snapshot, and plugin-storage protocols. Some read paths initialize defensively; ordinary writes still assume bootstrap completed initialization. |
| `src/ts/storage/risuSave.ts`, `legacyRisuSaveCodec.ts`, `strictRisuSaveCodec.ts` | Split RisuSave codec boundary. `legacyRisuSaveCodec.ts` owns JSON normalization and historical MessagePack/compression encoders; `strictRisuSaveCodec.ts` owns strict `RISUSAVE\0` block decoding and integrity/type checks. `risuSave.ts` imports those modules and re-exports selected public codec surfaces while retaining incremental block encoding, permissive recovery decoding, transactional patch proposals, and chat guards. `RisuSavePatcher.set()` prepares structurally shared state that commits only after acknowledgement; `RisuSaveEncoder.takeNormalizedBaseline()` transfers the exact full-write graph without decoding the assembled bytes. |
| `src/ts/storage/payloadCodecClient.ts`, `payloadCodecService.ts`, `payloadCodec.worker.ts` | Worker-capable payload boundary. `encodeChatRowPayload()` snapshots and encodes a chat row; `prepareChatRowCheckpoint()` snapshots the acknowledged/current rows and prepares exact bytes, digest, and an eligible operation-log delta; `decodeAuthoritativeRisuSaveWithCodecWorker()` offloads strict decoding for non-REMOTE block-format databases. `PayloadCodecService` serializes operations through an on-demand module worker, uses the same operations inline when workers are unsupported, and disables a failed worker for the service lifetime before falling back. |
| `src/ts/storage/chatStub.ts` | Runtime-independent stub type and predicate. `ChatStub` contains only identity/display metadata plus `_stub: true` (`:13`); `isChatStub()` additionally requires that no `message` array exists (`:36`). |
| `src/ts/storage/chatStorage.ts` | Stub/placeholder conversion, lazy hydration, chat-backup reason tags, and version import. `setChatBackupReason()` records one-shot reasons; `saveChatToServer()` consumes them; `importChatBackup()` clones a recovered version under a fresh chat ID and explicitly dirties its target; and `ensureChatHydrated()` owns the hydration state machine. |
| `src/ts/storage/chatPersistStage.ts` | Testable row-persistence stage used by `saveDb()`. `prepareChatPersistStage()` discovers changed/new chats, requires authoritative row writes before stub commit, checkpoints a generating chat at most once per 20 seconds, requeues it for the final post-generation save, and updates the known-chat baseline only after a committed stub database. |
| `src/ts/storage/activeChatDirtyTracker.svelte.ts` | Batches the active chat's deep reactive subscription without weakening mutation coverage. The first nested mutation queues the live chat and drops the expensive nested dependencies; a revision timer re-arms them once per ordinary save window or generation checkpoint interval. Selection and hydration remain explicit clean-baseline cases. |
| `src/ts/storage/databaseDirtyRevisions.ts`, `databaseDirtyRevisionTracker.svelte.ts` | Own acknowledgement-scoped dirty revisions and state-layer observation for root keys, every character's database/stub projection, modules, presets, plugins, and plugin-storage metadata. Independent deep-proxy effects avoid waking untouched branches; discarded/failed saves retain revisions, while commits clear only the exact acknowledged revision. |
| `src/ts/storage/stagedAckTracker.ts` | Holds each staged (`durable: false`) patch acknowledgement's ledger proposal and tracked targets behind commit/replay callbacks until a durable confirmation. Confirmation is an ETag watermark from `flushDatabase()`, debounced 6.5 s past the server's coalescing window with exponential retry; durable full writes or `durable: true` patch acks confirm the whole buffer, while conflicts, displacement, or repeated unknown-ETag verdicts replay entries into dirty tracking. |
| `src/ts/storage/saveRetryScheduler.ts` | Save-failure retry pacing for the permanent loop. The first four consecutive failures keep the quick linear backoff (500 ms steps capped at 3 s); the fifth alerts once per outage streak and arms a 10 s slow-retry deadline that the loop's idle watchdog consumes one-shot, so queued dirty state keeps retrying instead of idling until the next edit. Also owns the conflict-path backoff formula and the browser `online`-event expedite. |
| `src/ts/chatLoadPages.ts` | Validates message-render limits. Defaults are 30 initially and 15 additionally (`:1-2`); normalization is at `:4`; database-facing getters are at `:17` and `:21`. Despite the names, these values count messages, not server pages. |
| `src/ts/storage/chatDraft.ts` | Stores per-chat unsent composer text outside `Chat`. `ChatDraftSession` distinguishes loading, ready, error, and closed states so a temporary empty composer cannot delete an unread draft after a failed or in-flight load. |
| `src/ts/storage/persistentKv.ts` | JSON/KV primitives plus structured plugin mutation, version, batch, generation, and commit-outcome helpers. Reads can opt into verified resource caching; hashed and reversible key builders remain common plugin/MCP primitives. |
| `src/ts/storage/pluginSaveKeyPolicy.ts` | Canonical optimized-plugin physical-key policy shared with the server: UTF-8/base64url for well-formed keys, tagged UTF-16 code units for ill-formed JavaScript strings, and manifest-mapped hashes for archive-overlimit names. |
| `src/ts/storage/resourceCache.ts` | Disposable SHA-256-addressed IndexedDB cache for wire bytes and manifests. It owns enable/support checks, strict entry/manifest validation, verified reads, batched hashing, retention planning, write serialization, stats, pruning, and clearing. Limits include 64 MiB total, 32 MiB per value, 512 manifests, and 32,768 entries. |
| `src/ts/storage/dbCachedRead.ts` | Client half of the segmented boot protocol. It decodes the raw MessagePack envelope, rejects unexpected shapes/unadvertised hits, re-hashes resident entries, assembles root plus array groups, and returns manifest updates with the server ETag. `rawMsgpack.ts` provides the record-free MessagePack decoder. |
| `src/ts/storage/boundedMsgpack.ts` | Shared client MessagePack arena policy. Production encoders preserve their distinct wire profiles, but replace msgpackr's module-global target after it grows beyond 32 MiB or after an encode fails, preventing one-off payloads from remaining resident for the tab lifetime. |
| `src/ts/bootstrap.ts` | Orders the secure-context gate, storage initialization, cached/raw boot read, decode/defaults, server-side snapshot recovery, optimized-plugin boot reconciliation, migrations, placeholder conversion, UI initialization, ID repair, and save-loop startup. |
| `src/ts/storage/databaseSave.ts` | `DatabaseSaveCoordinator`, save pause/fencing, exact `DatabaseSaveOutcome`, and `requireCommittedDatabaseSave()` for callers that need durability. |
| `src/ts/storage/writerTakeover.ts` | Process-global writer-loss latch, foreground `checkWriterTakeoverOnReturn()`, explicit read-only-versus-reload choice, and DOM interaction freeze. It never replays or journals the displaced page's dirty state. |
| `src/ts/storage/clientBuild.ts`, `clientBuildHandshake.ts` | Client build stamp/header and upgrade handshake. Session and mutation requests advertise the client build; `handleClientUpgradeRequired()` reloads a clean page once behind a session guard, while dirty or indeterminate pages enter the existing frozen writer-recovery flow instead of risking local edits. |
| `src/ts/storage/databaseClone.ts` | Database-aware clone/merge helpers that preserve special own keys. Conflict recovery mutates the freshly decoded authoritative graph and clones only dirty local branches; the previous whole-graph merge remains exported only as a differential test oracle. |
| `src/ts/storage/conflictRebaseBudget.ts` | Structural graph-lifecycle budget for conflict recovery. The asserted client bound is three live database graphs, down from the audited approximately-six-graph path. |
| `src/ts/storage/bootSnapshotRecovery.ts` | Walks metadata-only snapshot candidates and asks the server to validate/publish them atomically. |
| `src/ts/storage/backupReplacementUi.ts`, `snapshotRestoreUi.ts`, `storageError.ts` | Destructive replacement UX, committed/not-committed/unknown classification, no-replay policy, and hard-reload reconciliation. |
| `src/ts/drive/backuplocal.ts` | Client UI for streamed normal, upstream-target, main-target rollback, and server-file exports; cancellable server-side partial export jobs; and bounded backup replacement. Detailed semantics live in [Backup and recovery](backup-recovery.md). |
| `src/ts/storage/exportAsDataset.ts` | `streamDatasetRows()` resolves characters through metadata-only interchange snapshots and streams their chat messages through the bounded chat reader; `encodeDatasetBlobParts()` consumes `encodePrettyJsonArray()` without constructing one aggregate JSON string, and `exportAsDataset()` downloads the resulting JSON-array parts. |
| `src/ts/storage/defaultPrompts.ts` | Supplies prompt defaults consumed by `setDatabase()`, including `defaultMainPrompt`, `defaultJailbreak`, and `defaultAutoSuggestPrompt` (`:3-7`). |
| `src/ts/interchangeability.ts` | Schema conversion among characters, personas, and modules. Character/module conversions are at `:6` and `:54`; character/persona conversions at `:121` and `:135`; persona/module conversions at `:146` and `:173`. This is object-schema compatibility, not the `.bin` codec. |

Relevant regression coverage:

- `src/ts/storage/chatStub.test.ts` verifies real-stub versus hybrid detection (`:10`).
- `src/ts/storage/chatStorage.test.ts` covers stub round trips, key-presence semantics, and hybrid self-healing (`:33`, `:109`, `:152`).
- `src/ts/storage/chatGuards.test.ts` covers path matching, internal-field rejection, `_stub` restrictions, and disallowed patch operations (`:17`, `:53`, `:81`, `:116`).
- `src/ts/storage/risuSavePatcher.test.ts` is a large patch round-trip and fast-path suite; the main round-trip section begins at `:440`.
- `src/ts/storage/normalizeJSON.test.ts` checks path-based circular-reference handling (`:11`).
- `src/ts/storage/chatDraft.test.ts` covers write ordering, orphan cleanup, and round trips (`:48`, `:78`, `:90`).
- `src/ts/storage/chatPersistStage.test.ts` covers row-before-stub ordering, failed-row rejection, generation throttling, forced/final saves, durable known-chat promotion, and placeholder handling.
- `src/ts/storage/stagedAckTracker.test.ts` covers staged-ack retention without a flush confirmation (the replay protocol case), the ETag watermark, retry backoff, displacement stop, and `confirmNow` coalescing; `test/compat/staged-patch-durability.test.ts` covers the server-side structural commit-before-ack under SIGKILL and the staged/flush semantics.
- `src/ts/storage/saveRetryScheduler.test.ts` covers the quick-delay progression, alert-once-per-streak, one-shot deadline wake and re-arm, success reset, online-expedite semantics, the conflict backoff cap, and the five-failure outage recovery protocol.
- `src/ts/storage/activeChatDirtyTracker.svelte.test.ts` covers bounded re-walk frequency on a 1,000-message chat, new graph nodes, selection, same-ID replacement, hydration suppression, generation cadence, forced re-arm, and cleanup.
- `src/ts/drive/backuplocal.test.ts` verifies server-owned partial export, cancellation, missing-asset reporting, sink cleanup, and destructive replacement outcomes.
- `src/ts/chatLoadPages.test.ts` covers normalization and defaults (`:10`).
- `src/ts/storage/resourceCache.test.ts` covers hashing, timeout helpers, cache limits, retention planning, prune thresholds, unsupported IndexedDB, and large database manifests.
- `src/ts/storage/persistentKv.test.ts` verifies that cached JSON reads use the hash-aware adapter without changing ordinary reads.
- `src/ts/storage/writerTakeover.test.ts`, `server/node/session-lock.test.ts`, and `test/compat/writer-session-lock.test.ts` cover the explicit takeover choice, foreground deferral during active chat work, fresh gesture-backed takeover, passive fresh writes, stale rejection, and compatibility clients without a session ID.
- `test/compat/db-cached-read.test.ts` exercises the server half of segmented boot, including ETag parity, all-miss/all-hit projection, generic KV `204` selection, and malformed or oversized inventories.
- `test/compat/boot-database-negotiation.test.ts` covers atomic first creation and concurrent boot convergence; `test/compat/plugin-storage-boot-reconcile.test.ts` covers equivalent raw/canonical boot ETags and genuine stale conflicts.

## 3. Architecture & data flow

### Canonical runtime state

`DBState.db` is the actual Svelte 5 `$state` object, declared outside this directory in
`src/ts/stores.svelte.ts`. `setDatabaseLite()` assigns a supplied object directly to that
state, while `setDatabase()` first mutates the object to supply hundreds of
backward-compatible defaults and then calls the lite setter.

Most application code calls `getDatabase()` and mutates the returned live proxy directly.
Code needing a non-reactive copy uses `getDatabase({ snapshot: true })`, which invokes
`$state.snapshot`. Current character/chat access is index-based through `selectedCharID`
and `character.chatPage`; see `getCurrentCharacter()` and `getCurrentChat()`.

Whole-database snapshots deliberately remain available, but bulk serializers should use
the narrow accessors when they do not need every reactive root. `getDatabaseFieldsSnapshot()`
snapshots only named non-character, non-plugin-storage roots; `getCharacterSnapshot()`
detaches one character; and `getCharacterInterchangeSnapshot()` snapshots character
metadata while retaining only index/ID/name references for its chats. Interchange code
then calls `getCharacterChatSnapshot()` one row at a time; it resolves by durable chat ID
when present and uses the captured index only for an id-less reference, so a reorder cannot
silently select an unrelated identified row. These APIs
avoid traversing unrelated roots and, for interchange, unrelated chat bodies.

`setDatabase()` handles additive/default migrations such as:

- Missing root arrays, prompts, API settings, UI settings, personas, presets, and modules.
- Stable UUIDs on bot presets while retaining the physical `botPresetsId` index required
  for upstream backup compatibility.
- Legacy provider-shape conversion.
- Chat-render count validation.
- Language activation and model-preset defaults before installing the state.

Structural/versioned migrations that need broader context live separately in `bootstrap.checkNewFormat()`, not in `setDatabase()`.

### Startup load order

`loadData()` performs the following sequence:

1. Reject remote plain-HTTP boot unless `POCKETRISU_ALLOW_INSECURE_CONTEXT` was injected
   by the server, because WebCrypto is required for content-addressed integrity.
2. Initialize `forageStorage`, which creates `NodeStorage`, and POST `/api/session` with
   the per-tab session ID and client build stamp. The response negotiates database and
   plugin-storage capabilities and advertises the server build. A mismatched clean page
   reloads once; a page with dirty or indeterminate local state enters writer recovery.
   Then call `readDatabaseForBoot()`. A server advertising
   `database.rawBootRead` uses the segmented root/characters/botPresets/modules/personas
   read when the resource cache is enabled and the advisory raw database size is at least
   128 KiB (or unknown); smaller databases bypass IndexedDB inventory verification and use
   `/api/db/read-raw-for-boot`. The raw route is also used when the cache is disabled, so
   corrupt authoritative bytes can enter recovery without being hidden by server decoding.
   The segmented route returns the canonical normalized
   legacy-view ETag used by `/api/read`; the raw route returns MD5 over the verbatim row
   bytes. A server without the capability uses legacy `/api/read`; an empty legacy
   response is accepted as missing only when an uncached `/api/list` also proves that
   `database/database.bin` is absent. An advertised raw route must use explicit HTTP 204
   for absence; 404 and zero-byte 200 responses fail closed.
3. If the authoritative read reports no database, encode an empty legacy save and call
   `createDatabaseIfAbsent()`. Current servers linearize the create-only transaction
   through `/api/db/create-if-absent`; if another writer wins, bootstrap rereads and
   installs that writer's authoritative database. Legacy servers receive a final
   read/list proof before the compatibility `/api/write`. Only the winning creator applies
   fresh-install UI defaults.
4. Decode full bytes or accept the already decoded/verified segmented result, capture an
   untouched patch baseline, and only then call `setDatabase()`. Strict block-format
   databases without REMOTE blocks decode through `PayloadCodecService`; other formats
   and unavailable or failed workers use the same authoritative decoder inline. Capturing first matters
   because `setDatabase()` adds client defaults that should subsequently be synchronized
   to the server.
5. On decode failure, request metadata-only snapshot candidates and submit them newest-first to the server's bounded atomic restore route. The wait has no total wall-clock deadline: strict NDJSON activity refreshes a two-minute inactivity watchdog, and a lost response is reconciled through the durable operation-status route. Try an older candidate only after a definitive not-committed result; a committed or unknown result stops fallback. Folded snapshot/chat/plugin bodies never enter browser memory.
6. Reconcile plugin storage before plugin loading. Current servers handle optimized mode
   through an ETag-fenced server endpoint that scans row bodies one at a time and returns
   only counts plus encoded-key diagnostics; optimized plugin values therefore do not
   cross the boot-reconciliation boundary into browser memory. The endpoint derives both
   the raw-row MD5 and, when different, the canonical normalized legacy-view MD5 inside
   its queued snapshot. It accepts either token only for that selected database and keeps
   the accepted token domain when no cleanup is required. A genuinely stale token returns
   409. If the server removes recovered inline copies, bootstrap rereads the paired
   authoritative database/ETag before continuing. Older servers and inline mode retain
   the client compatibility path. Publication and mode-switch semantics are owned by
   [Plugin storage](plugin-storage.md).
7. Load plugins, run `checkNewFormat()`, and normalize character/module/persona data.
8. Convert on-wire `ChatStub` objects into runtime-safe placeholder `Chat` objects.
9. Apply UI state, optionally offer the one-time resource-cache enable prompt, run the
   backup reminder, mark the app loaded, assign IDs, then start `saveDb()`. Module updates
   follow and stale remote-cache cleanup is deferred five seconds. Finally
   `initModelJobRecovery()` installs visible/online recovery triggers and starts the first
   pass; it runs only after the save loop exists so a recovered chat can be made durable.
   Ordinary asset garbage collection is server-owned and never runs from the client boot
   path.

`checkNewFormat()` also purges unsupported group entries, advances `formatversion` through
version 5, removes expired trash, and starts a best-effort sweep of draft keys whose chats
no longer exist.

### Client-to-server save loop

`saveDb()` creates a long-lived save coordinator.

#### Dirty tracking and scheduling

1. A `toSaveType` tracker separates root, character, chat, bot-preset, module, plugin, and plugin-storage changes. A parallel monotonic revision ledger keeps per-root-key, per-character, and per-module identities plus collection revisions until acknowledgement.
2. Independent Svelte effects `deepTouch` each relevant state branch. Initial effect runs establish trusted clean coverage without treating loading as an edit; an observation failure marks that branch untrusted so codecs retain their JSON-equality fallback.
   Before those effects install, `capturePreTrackingPluginStorageChanges()` compares the untouched server baseline with state changed during plugin startup so early plugin writes are not lost.
3. Root keys and collections are tracked separately for efficient patching. Every character is observed independently; character tracking deliberately excludes full `chats` and observes character fields plus chat ordering/stub metadata. Plugin guest inputs are cloned before entering the state proxy so a retained caller-owned raw alias cannot bypass revisions.
4. A second tracker deeply observes only the active chat. The first mutation queues the live row, then nested subscriptions are dropped and re-armed once per 500 ms ordinary save window or, when that chat is generating, the 20-second checkpoint interval. Mutations inside the gap are already included in the queued live object. Switching chat establishes a baseline, hydration activity is ignored, and generation completion/page hide force an immediate re-arm.
5. Normal edits set `changed` after a 500 ms debounce. The permanent loop polls every 200 ms, serializes through `DatabaseSaveCoordinator`, and retries failures with bounded backoff: `SaveRetryScheduler` gives the first four consecutive failures quick capped delays, then alerts once per outage streak and switches to a 10-second slow cadence. The loop's idle branch wakes one-shot when the armed deadline passes and dirty state (tracked targets or ledger revisions) remains, a browser `online` event expedites that wake, and both wake paths are suppressed for a displaced writer so stale state is never auto-replayed.
6. `markCharacterDirty()` and `markChatDirty()` provide synchronous targets for off-screen,
   arbitrary, or pre-tracker mutations. `DirtyTargetBridge` buffers calls made before
   `saveDb()` activates its sink. Ordinary imports that mutate observed live-proxy branches
   enter the same schedule reactively. Package import writes each streamed chat row directly
   and marks the character so its placeholder/stub block enters this loop; chat-history
   import appends a full live chat and marks both its character and row. Explicit marks use
   the normal asynchronous debounce and are not durability acknowledgements.
7. `triggerSave()` snapshots both explicit targets and the dirty-revision ledger. When
   neither contains work and no full write is forced, it returns a committed no-op before
   row staging or codec serialization. Once revision trust is established, the encoder
   and patcher also skip equality/encoding work for clean trusted branches; startup and
   conflict rebase each require one equality-backed acknowledged save before that shortcut.
8. `requestImmediateSave()` queues behind older in-flight work and returns a
   `DatabaseSaveOutcome`. Callers that need durability must require
   `outcome.status === 'committed'` or use `requireCommittedDatabaseSave()`; merely
   awaiting the promise is not a durability proof. `requestImmediateSave()` sets
   `requireDurable`, so a staged patch acknowledgement (and any earlier staged
   backlog) is confirmed through an immediate `flushDatabase()` before `committed`
   is returned; a failed confirmation replays the staged state and returns `retry`.
   The coordinator can pause saves during
   staged publication. `blockDatabaseSavesUntilReload()` is the explicit fence used when
   a specialized atomic transition has an unresolved outcome; the ordinary database save
   loop requeues failed or ambiguous attempts rather than installing that fence itself.

#### Row-before-stub persistence

Before database metadata is written, `persistTrackedChanges()` calls
`prepareChatPersistStage()`. It saves every eligible changed or newly discovered full chat
through `/api/chat-content`; one failed row write rejects the stage. Only after all rows
succeed does `RisuSaveEncoder.set()` project each chat to `chatToStub()`. The stage's
`completeStubCommit()` promotes newly discovered chat IDs into the known baseline only
after the patch/full-write outcome is committed. No-op, conflict, and retry paths retain
the dirty proof rather than creating a phantom known stub.

`NodeStorage.saveChatContent()` calls `prepareChatRowCheckpoint()` before the request. The
client snapshots the live current row and its last acknowledged baseline synchronously,
then `PayloadCodecService` legacy-encodes and hashes the current row and, when safe,
prepares a JSON Patch operation-log delta. The on-demand `payloadCodec.worker.ts` performs
that work off the main thread; unavailable, failed, or unsupported worker execution falls
back to the identical inline operation. The acknowledged snapshot advances only after the
server returns the exact expected materialized digest.

Only whole-message replacements and appends are delta-eligible, and replay against the
acknowledged base must reproduce byte-identical MessagePack; any non-message change or
object-key-order difference selects a full-row write. An eligible smaller payload uses
`application/vnd.pocketrisu.chat-delta+json` with version, base/result hashes, result size,
and patch. A definitive `CHAT_DELTA_*` refusal, missing success hash, or mismatched success
hash retries the already-prepared byte-identical full row. A transport or commit-ambiguous
result is never replayed. Full and delta paths share the same dirty-stage, final-generation,
cache-seeding, snapshot-scheduling, and row-before-stub lifecycles.

On a `doingChat` false→true transition, the per-generation checkpoint tracker is cleared.
The first eligible save during generation writes the dirty row; later writes are limited
to one per 20 seconds. Candidates stay requeued, so true→false schedules an unconditional
final-row save. The server's independent 45-second pre-image cooldown prevents a history
version for every checkpoint.

#### Patch and full-write synchronization

When `supportsPatchSync` is enabled (`src/ts/platform.ts:18`):

- `RisuSavePatcher.set()` generates an RFC 6902 patch and expected compositional hash against the captured stub-only baseline as an uncommitted proposal. The save loop calls `commit()` only after a successful server acknowledgement and `discard()` on rejection or transport failure.
- `findDangerousChatOps()` rejects field-level operations outside the stub metadata allowlist before they leave the browser.
- `/api/patch` applies the patch to the server's stripped cache; its response updates the cached ETag, reports whether the acknowledgement is durable or staged, and may surface a deferred persistence warning.
- A patch-hash conflict never promotes the rejected response's ETag. The client reads the
  authoritative database and ETag as one provisional candidate, retires the old codec
  generation, initializes a patch baseline from that authoritative graph, overlays dirty
  local branches into the decoded graph in place, and leaves clean authoritative branches
  untouched. It then reinstalls runtime placeholders with `setDatabase()`, rebuilds the
  encoder, publishes the ETag last, and retries without marking the row stage's stub save
  committed. Dirty branches are the conservative union of the existing reactive/explicit
  tracker and changes proven by the patch baseline diff.
- Non-conflict patch rejections such as the chat guard may fall through to an ETag-guarded
  full `database.bin` write. Patch-enabled clients refuse an unversioned full write, and
  an ETag conflict enters the same provisional rebase path.
- A successful full write transfers the encoder's exact normalized wire graph into the patcher; the client does not decode the bytes it just encoded.
- If an import owns the server mutation barrier, `/api/write` returns `503 IMPORT_IN_PROGRESS`; `NodeStorage.setItem()` fails the attempt and the coordinator requeues its tracked changes.

#### Flush and commit boundary

A patch acknowledgement is staged or durable, reported by the response's `durable`
field. Structural patches — any change to the referenced chat-row key set — are
persisted by the server inside the request and acknowledged `durable: true`, so a
new chat's stub is never less durable than its write-through row. Metadata-only
patches are acknowledged `durable: false` while the server debounces the
stubs-only database write by five seconds; the client keeps their ledger
proposals and tracked targets in `stagedAckTracker.ts` (the patcher baseline
still advances, and the dirty-state probe counts staged entries) until a durable
confirmation arrives — a `durable: true` flush whose ETag matches a staged entry,
a durable patch, or a full write. Failed or displaced confirmations replay the
staged state into dirty tracking instead of dropping it; after a server rollback
the conflict rebase's baseline diff re-proves the same changes. Chat-body POSTs
are write-through. At the debounce
boundary, the server commits the new stubs-only row and any now-unreferenced chat-row
deletions in one SQLite transaction; a full `/api/write` likewise commits payload rows,
plugin rows, `database.bin`, and targeted chat deletions atomically. Reads flush pending
work first. `POST /api/db/flush` drains that pending work and returns success only after
SQLite reports a complete `FULL` checkpoint, including when the operator selected a
`NORMAL`-synchronous mode; the fatal-exception handlers additionally run a guarded
synchronous emergency persist before exiting. Page-hide transport is still
best-effort because the browser
does not await the keepalive response.

`visibilitychange` and `pagehide` request an immediate, non-broadcast save with
`forceChatPersist`, then send a keepalive `/api/db/flush`. The browser can disappear
before observing either acknowledgement, so this remains a best-effort final attempt.

### Writer authority and displacement

Before a same-browser database publication, `saveDb()` broadcasts its local ID through
`BroadcastChannel('risu-db')`; another tab that receives it enters the same displacement
flow. Across browsers/devices, `NodeStorage` keeps one `x-session-id` in `sessionStorage`,
adds the client build to session/mutation requests, and marks recent pointer/keyboard
activity on writes. Registration itself does not claim authority; a mutation-time HTTP
423 tells the client that this page has been displaced. The server's freshness,
gesture-backed acquisition, compatibility-client, and lock-transition rules are canonical
in [Server backend](server-backend.md).

A build mismatch follows the same preservation boundary. `clientBuildHandshake.ts`
automatically reloads a clean page at most once for the advertised server build. If the
dirty-state probe reports queued/in-flight save work or active chat work—or the probe
cannot prove cleanliness—the handshake dispatches `risu-session-deactivated` with a
server-upgrade reason and preserves the page through writer recovery.

The client also polls side-effect-free `GET /api/session/lock-status` after focus or
visibility return, at most once every five seconds. `checkWriterTakeoverOnReturn()` defers
while a chat operation is active. A stale status or mutation-time 423 enters the
process-global writer-loss latch, aborts the active chat request, and presents the explicit
choice implemented by `writerTakeover.ts`: keep the displaced DOM as a frozen read-only
recovery view, or discard local state and reload to regain access. Neither choice flushes,
journals, nor replays unsaved state from the displaced page.

### Chat rows and lazy hydration

The server persists `database/database.bin` as the same stubs-only shape sent to the
browser, while each full body is a separate `chats/<encodeURIComponent(chaId)>/<encodeURIComponent(chatId)>`
SQLite KV row. `/api/read` therefore decodes and caches the small stripped row directly;
monolith imports, snapshots, and backups are split or assembled only at explicit
boundaries in `server/node/chat/chatRows.cjs`.

A stub contains only `id`, `name`, optional `lastDate`, `folderId`, `modules`, and `_stub: true` (`src/ts/storage/chatStub.ts:13-20`). At boot, `convertStubsToPlaceholders()` changes it into a type-compatible `Chat` with empty `message`, `note`, and `localLore`, plus `_placeholder: true` (`src/ts/storage/chatStorage.ts:17-30`, `:63-71`). Runtime code therefore normally sees `Chat`, never `ChatStub`.

Opening a placeholder invokes this flow:

1. `changeChatTo()` detects `_placeholder` and shows a cancellable loading overlay.
2. `ensureChatHydrated()` deduplicates concurrent requests by `chaId/chatId`.
3. `NodeStorage.fetchChatContent()` calls `/api/chat-content/<chaId>/<index>` with `x-chat-id`. With the optional resource cache enabled it also advertises verified resident hashes; a matching server `204` reuses locally re-hashed bytes, while any cache anomaly retries an unconditional read. Returned bytes are decoded and passed through `normalizeChat()`.
4. After the fetch, hydration re-finds the chat by ID so an index shift cannot write into the wrong slot.
5. It yields one animation frame, replaces the placeholder, waits one Svelte tick, and clears hydration suppression.

The server also verifies `x-chat-id` if it falls back to index lookup, returning 409 on an
index mismatch. `NodeStorage` accepts a hydrated GET graph only after verifying its bytes
against `x-content-hash`. Chat write encoding, operation-log deltas, digest acknowledgement,
and full-row fallback are part of the canonical save loop above.

#### Recovered model-job publication

`initModelJobRecovery()` discovers unclaimed terminal jobs and still-running main requests
from the server at boot and whenever the page becomes visible or comes online. A running
job installs a background per-chat guard and status entry, then polls its status with a
3-to-15-second backoff until terminal; recovery does not reattach its live journal stream
or render partial bytes. Only then is the completed journal decoded, located by stable
chat/generation identity, and filled or inserted idempotently through the live proxied
database. Before a recoverable job is claimed, `persistRecoveredChat()` writes the full
chat row directly with `saveChatToServer()`; a failed row write leaves the job unclaimed
for the next pass. Only after that durable row publication does recovery write the request
log/usage record and claim the job, preventing a retry from double-counting provider use.
If the target chat was deleted, recovery has nothing to publish and claims the job.

### Verified browser resource cache

The cache is an opt-in performance layer, separate from server-backed `forageStorage`. `resourceCache.ts` stores immutable wire bytes by SHA-256 plus per-resource manifests in IndexedDB; only its enable flag and one-time announcement live in `localStorage`. Disabling it increments an epoch, waits for queued writes, closes the connection, and deletes the database.

Three protocols consume it:

- Boot splits the stubs-only database into `root`, individual `characters`, `botPresets`, `modules`, and `personas`. The client advertises up to 8,192 verified hashes, reconstructs a MessagePack envelope from hits/misses, and validates exact shape and ETag. Verified resident bytes and admitted misses share the 64 MiB/32,768-entry boot staging budget; a miss beyond the remaining aggregate or 32 MiB per-value limit is decoded without cache hashing or retention. Once validation succeeds, boot returns the database while donated miss buffers persist in the background and are released after their IndexedDB `put`.
- Chat and optimized `pluginsave/*` reads advertise recent verified hashes and accept a `204` only when `x-content-hash` names an advertised, locally present, re-hashed entry.
- Successful plugin/chat writes compare the server-returned hash with the exact logical
  bytes prepared by the codec worker before seeding the cache; delta uploads seed those
  same materialized bytes even though only the patch crossed the network.

Retention is deliberately bounded and best-effort: 512 manifests, four ordinary hashes
per manifest, up to 8,192 hashes in a database manifest, 32,768 entries, 64 MiB total, and
32 MiB per value. IndexedDB/quota/WebCrypto errors become misses; verified reads re-hash
bytes before use. Settings → Advanced toggles the feature, and the System dashboard
reports/clears it. Most cache operations use the two-second settlement helper, but the
five initial boot-manifest reads do not; a permanently stalled IndexedDB request can
therefore delay the raw-read fallback. Manifest `sizes` are schema/cap and retention
metadata: verified snapshots re-hash resident bytes but do not compare their actual byte
length with that field. Prefix invalidation removes manifests first; unreferenced immutable
entries are reclaimed by later prune/clear work.

`NodeStorage.keys()` uses a separate `risu-list-cache` IndexedDB store. Each prefix
remembers its full key set, server timestamp, and list epoch. `/api/list` may return
`added`/`deleted` deltas; the client merges additions with precedence, persists the new
snapshot asynchronously, and accepts a full response whenever the server cannot prove the
delta window. The server waits for an active import to finish before listing. Valid
startup and database-replacement commit/rollback paths rotate the epoch; any unmatched or
missing epoch forces a full response, so a transactional replacement cannot publish a
cacheable intermediate key set.

### Message rendering pagination

Chat pagination does not fetch partial chat bodies. Once a chat is hydrated, its entire `message` array is in memory; `loadPages` only limits mounted Svelte message components.

`DefaultChatScreen` initializes the render count from `getInitialChatLoadPages()` (`src/lib/ChatScreens/DefaultChatScreen.svelte:68`) and adds `getAdditionalChatLoadPages()` when the user scrolls near the oldest mounted message (`:1189-1201`). `Chats.svelte` renders backward from the latest message to `messages.length - loadPages` (`src/lib/ChatScreens/Chats.svelte:63-98`). The defaults are 30 and 15 messages, and invalid, non-finite, or sub-one settings fall back to a positive integer (`src/ts/chatLoadPages.ts:1-15`).

### Composer drafts

Drafts deliberately do not modify `Chat`, so typing does not re-upload a chat body.
Each `drafts/<chaId>/<chatId>` row is JSON `{m, t}` for message text and timestamp.
`DefaultChatScreen` loads a draft on chat entry, flushes the prior draft on switch/unmount,
schedules writes while typing, removes an empty draft, and flushes again on page hide.

`chatDraft.ts` keeps one in-memory prefix index to avoid a read for chats with no draft.
All writes and removals share one `writeChain`, preventing a late save from resurrecting a
draft after send/removal. `maybeSaved` covers an acknowledgement lost after the server may
have committed. Typing is debounced by 800 ms, while blur/switch/unmount paths enqueue
immediately. `ChatDraftSession` keeps loading/ready/error/closed state so a temporary empty
composer cannot delete a draft whose read is pending or failed.

### Backup and destructive recovery

- Full, upstream-target, main-target, and server-file exports stream from server-owned point-in-time sources. Every full-state target requires a valid live database and every referenced chat.
- Normal Node full/server exports and partial jobs carry only composer drafts whose exact character/chat identity exists in the pinned graph. Upstream-target exports omit drafts, and destructive imports restore draft rows only after imported IDs are normalized.
- `SavePartialLocalBackup()` creates, polls, downloads, and deletes a cancellable server export job. The server pins selected state and identity assets, folds plugin/chat rows, reports missing assets, and can preserve an already-missing chat as a bare stub. Browser placeholders are not hydrated for this flow.
- `LoadLocalBackup()`, server-backup restore, save-folder replacement, and snapshot restore distinguish committed, not-committed, and unknown outcomes. Save-folder and snapshot waits are activity-based and reconcile lost acknowledgements against transaction-bound operation status. Ambiguous destructive requests are never replayed; the UI warns and reloads to reconcile authoritative state.
- `target=upstream` is a lossy migration export: it omits composer drafts plus inlay payload, sidecar, and metadata namespaces. Use the normal Node export for PocketRisu recovery.
- `target=main` is the non-destructive downgrade export for the audited PocketRisu main branch. It folds chat and optimized plugin rows, retains main-readable assets/inlays, omits unsupported draft and remembered-MCP rows, and rejects newer escape-aware plugin save headers before download.
- Per-chat pre-image import remains separate: it decodes one history version, assigns a fresh chat ID, and saves it as a new chat instead of overwriting current row identity.
- Dataset export remains browser-side rather than a server point-in-time job.
  `streamDatasetRows()` uses metadata-only character snapshots plus the two-row-lookahead
  `streamCharacterChats()` reader, so cold chats are fetched and emitted one at a time
  instead of becoming empty arrays. `encodePrettyJsonArray()` avoids one aggregate JSON
  string, although the resulting immutable `Blob` parts remain retained until download.

See [Backup and recovery](backup-recovery.md) for archive, pinning, import, snapshot, limit, cancellation, and outcome contracts.

## 4. Entry points & dependencies

### Main callers into this subsystem

| Caller | Edge |
|---|---|
| `src/ts/bootstrap.ts` | Initializes storage, reads/decodes the database, installs defaults, converts stubs, and starts persistence/recovery. |
| Most files under `src/ts/` and `src/lib/` | Import `getDatabase()`, `getCurrentCharacter()`, or the `Database`/`character`/`Chat` types. The returned database is usually mutated in place. |
| `src/lib/ChatScreens/DefaultChatScreen.svelte` | Blocks chat operations until hydration, owns takeover freeze integration, and loads/debounces/flushes/removes composer drafts. |
| `src/ts/globalApi.svelte.ts` | Hydrates a newly selected chat, restores per-chat toggle values, and persists tracked state. |
| `src/ts/characters.ts` | Hydrates chats before single-chat or all-chat export. |
| `src/lib/Setting/Pages/SystemBackup.svelte` | Exposes normal local/server backup operations. |
| `src/lib/Setting/ChatBackupList.svelte` | Lists server-side per-chat histories and imports a selected pre-image as a new chat into any current character. |
| `src/lib/Setting/Pages/Advanced/ResourceCacheSettings.svelte` and `SystemDashboard.svelte` | Enable/disable the disposable browser cache, display its usage, and clear it. |
| `src/lib/Setting/Pages/PluginSettings.svelte` and `PluginStorageViewer.svelte` | Consume bounded recovery inspection/download/resolution and manifest/viewer reads from `NodeStorage`; [Plugin storage](plugin-storage.md) owns their domain semantics. |
| `src/ts/process/request/jobRecovery.ts` | Polls running model jobs to terminal and publishes completed, unclaimed results into chat rows after boot/visibility/online recovery. |
| `src/lib/Setting/Pages/MigrationSettings.svelte` | Exposes main-target rollback export, upstream-target export/import, partial backup, save-folder migration, and dataset export. |
| `src/ts/plugins/plugins.svelte.ts` | Uses `setDatabaseLite()` and then explicitly requests an immediate save after plugin import. |
| Character-card, persona, module, script, and command subsystems | Mutate the shared database or call `setDatabase()`/`setDatabaseLite()` after bulk imports and conversions. |

### Calls out of this subsystem

- Svelte 5 `$state`, `$effect`, `$state.snapshot`, and `tick` provide reactivity and hydration suppression.
- `src/ts/stores.svelte.ts` owns `DBState`, `selectedCharID`, loading state, and selection state.
- `src/ts/gui/deepTouch.svelte.ts` forces nested reactive reads for save dirty tracking.
- `msgpackr` supplies legacy MessagePack encoding; every production client encoder uses `boundedMsgpack.ts` to cap its reusable module-global arena at 32 MiB without changing its codec options. `fflate` and browser compression streams supply compressed variants.
- `fast-json-patch` is loaded lazily by `RisuSavePatcher.set()`.
- `NodeStorage` calls Express endpoints for auth/session/build negotiation, KV, cached database reads, full/delta key lists, patching, chat bodies, chat history, backups, assets, save-folder migration, and plugin-storage recovery/manifest/viewer administration.
- `jobRecovery.ts` calls the durable `/api/model-jobs` discovery, journal, and claim routes; request logging is published only after its chat-row save succeeds.
- `server/node/server.cjs` owns SQLite persistence, ETags, session locking, chat-row routing, backup framing, and the server-side copies of chat guards; `server/node/chat/chatRows.cjs` owns split/assembly and row semantics.
- Browser WebCrypto and IndexedDB back `resourceCache.ts`; `server/node/db/dbCachedRead.cjs` is its database-segmentation counterpart, while server `x-content-hash`/`x-cached-hashes` handling covers KV/chat entries.
- `streamSaver` is used for large streamed downloads in `backuplocal.ts` and
  `globalApi.svelte.ts`.

## 5. Conventions & gotchas

- `setDatabase()` is the compatibility/defaulting boundary; `setDatabaseLite()` is a raw state replacement. New imported or decoded databases generally need the former. Use the latter only when defaults were already applied or object identity/update timing requires it.

- `getDatabase()` returns the live Svelte proxy by default. Mutating it is the normal
  application convention and is what the save effects observe. Use `{ snapshot: true }`
  when serializing or exposing data that must not remain reactive.

- `Database.characters` is typed as `character[]` and `character.chats` as `Chat[]`, even though decoded wire data temporarily contains `ChatStub`. Boot must perform stub-to-placeholder conversion before ordinary runtime consumers execute.

- `_stub` is a persisted/wire marker; `_placeholder` is runtime-only. Never persist a placeholder as if it were a real chat, and never use `_placeholder` for server row lookup or assembly.

- A real stub requires both `_stub === true` and the absence of a `message` array (`src/ts/storage/chatStub.ts:22-39`). Legacy hybrid objects with `_stub: true` and full chat fields must be treated as full chats so their messages are not discarded.

- `convertStubsToPlaceholders()` self-heals hybrids by removing `_stub` and retaining the payload (`src/ts/storage/chatStorage.ts:57-70`). Changing this behavior can turn historical corruption into actual message loss.

- `chatToStub()` and `stubToPlaceholder()` preserve whether `lastDate`, `folderId`, and `modules` keys exist, even when their value is `null` or `undefined` (`src/ts/storage/chatStorage.ts:12-15`, `:27-29`, `:36-49`). Server snapshot/backup assembly uses the same `in` semantics so “explicitly cleared” differs from “not supplied” (`server/node/chat/chatRows.cjs:218-231`).

- Keep the stub metadata allowlist synchronized across `chatToStub()`, client
  `STUB_METADATA_FIELDS`, and server `STUB_METADATA_FIELDS`.

- `_stub` may only be added or replaced with literal `true`; removing it or writing a falsy value is a data-loss vector. `move`, `copy`, and `test` operations touching chat-internal paths are rejected (`src/ts/storage/risuSave.ts:1182-1237`).

- Chat protection is layered: the client refuses dangerous patch operations, the patch
  endpoint returns 409 for anything the client missed, and both debounced and full-write
  disk boundaries refuse metadata-only chats that have neither `_stub` nor `message`.

- Hydration must be suppressed from dirty tracking. `hydrationInFlight` covers the network phase and `hydrationJustApplied` covers the Svelte tick after replacement (`src/ts/storage/chatStorage.ts:113-120`, `:201-240`).

- Hydration is keyed by stable `chaId/chatId`, not only array index. Preserve chat IDs across reorder/import operations; both client and server use the ID to prevent applying data to a shifted index.

- Full chat content is saved before its database stub/metadata. A row failure blocks the
  stub commit, and a new chat becomes “known” only after row durability proof plus a
  committed stub database.

- `DatabaseSaveOutcome` is a tagged union (`committed`, `retry`, `failed`, or `displaced`),
  not a boolean. Specialized atomic transitions may use `blockDatabaseSavesUntilReload()`
  after an unknown outcome. Ordinary database-save transport failures retain/requeue dirty
  state for retry and do not automatically establish that no prior request committed.

- Generation chat persistence is throttled, not disabled. The first save in a generation
  writes a full base when no acknowledged base exists; later eligible 20-second checkpoints
  append deltas, every candidate remains dirty for the final idle-transition save, and
  page-hide forces a row write. Refusal fallback does not clear dirty state early. The
  server’s independent 45-second pre-image cooldown limits recovery-history churn.

- Optimized plugin keys, publications, recovery resolution, and viewer snapshots use
  dedicated protocols rather than generic KV assumptions. Coordinate those changes with
  [Plugin storage](plugin-storage.md).

- Backup-reason tags are one-shot. `saveChatToServer()` consumes the pending reason before the network call, so a failed write will not automatically reuse it on retry. Reasons are descriptive recovery metadata, not durability controls.

- Importing a chat backup must allocate a new chat ID. Restoring in place would collide with current row identity and could cause the pre-image mechanism to capture/overwrite the wrong logical history. Non-selected targets must go through `markCharacterDirty()` and full chat bodies through `markChatDirty()`.

- Render pagination is not storage pagination. Increasing `chatLoadInitialPages` or `chatLoadAdditionalPages` changes DOM/component load only; it does not reduce the hydrated chat payload.

- Dataset export now resolves placeholder rows through the bounded interchange chat
  reader and aborts on a missing row. It is still a browser-side serialization rather than
  the server-owned, point-in-time partial-export protocol described in
  [Backup and recovery](backup-recovery.md).

- Partial export is a cancellable server job and does not serialize browser memory. Keep its selected-asset, missing-row, cancellation, and point-in-time behavior in sync with [Backup and recovery](backup-recovery.md).

- Ordinary patch persistence legacy-encodes the stubs-only cache. A normal full write with no embedded chat payloads preserves the client bytes verbatim; only payload extraction forces a stripped re-encode.

- `decodeRisuSave()` in `risuSave.ts` supports raw, fflate-compressed, gzip-stream,
  RISUSAVE block-stream, headerless MessagePack, old `\0\0RISU` data, compressed JSON,
  and compressed MessagePack fallbacks. Removing fallback paths can strand upstream or
  historical backups.

- NodeOnly disables creation of remote character blocks but retains decoder support. The
  server also has a one-time `migrateRemoteBlocksIfNeeded()` migration for old upstream
  `remotes/<chaId>.local.bin` saves.

- `normalizeJSON()` in `legacyRisuSaveCodec.ts` is part of the client/server patch
  protocol. It maps non-finite numbers and circular references to `null`, dates to ISO
  strings, regex/errors to `{}`, and omits unsupported object properties. Changing it
  requires matching server hashing/normalization behavior and patch-protocol tests.

- `calculateHash()` is likewise protocol-level and must stay byte-for-byte behaviorally compatible with the server implementation.

- Arrays with stable IDs use whole-array replacement on add/delete/reorder or invalid/duplicate IDs, avoiding enormous index-shift diffs. Callers must iterate returned operations instead of spreading a potentially huge list.

- The save loop assumes `forageStorage.Init()` ran during bootstrap. `getItemCached()`, `readDatabaseForBoot()`, and `keys()` now initialize defensively, but core `setItem()`, `getItem()`, `removeItem()`, and `patchItem()` still forward through `realStorage` directly.

- `forageStorage` is no longer browser localForage in this fork; it fronts authenticated server HTTP and SQLite. Drafts and `persistentKv` values therefore synchronize across clients using the same server account.

- The resource cache and list cache are exceptions to that naming rule: both are browser-local IndexedDB performance caches. Clearing them loses no authoritative application data, and code must tolerate unsupported/blocked IndexedDB, quota failures, stale manifests, corrupted bytes, and cache eviction.

- Database segment identity is raw MessagePack SHA-256. The cached and ordinary database
  routes use MD5 over the canonical normalized legacy-encoded stubs-only view, while the
  raw boot route uses MD5 over the verbatim `database.bin` row. Boot plugin reconciliation
  accepts either token only when both are derived from the same queued authoritative row.
  Do not substitute segment hashes for concurrency ETags or derive ETags from the segmented
  envelope.

- Draft write/remove queues isolate persistence failures so they cannot block chat interaction. Reads are different: `loadChatDraft()` returns explicit found/absent/error state, and `ChatDraftSession` prevents a failed or pending load from turning temporary empty UI into a destructive remove.

- Conflict rebase may overlay dirty inline plugin branches, but optimized publication
  selectors remain authoritative protocol state. Preserve the boundary documented in
  [Plugin storage](plugin-storage.md).

- The physical `botPresetsId` index remains part of upstream RisuAI compatibility even though new code prefers stable preset UUID helpers (`src/ts/storage/database.svelte.ts:1025-1030`, `:2341-2402`).

- `interchangeability.ts` encodes character-only fields into specially marked lore entries such as `@@indicator phi`, `character_desc`, and `character_first_message` (`:26-48`, `:73-115`). Its deep clones prevent conversion from mutating the source module/character (`:15-16`, `:69-70`).

## 6. Navigation hints

- To add or change a persisted root setting, update the `Database` interface and its
  defaulting in `setDatabase()`.

- To add a required chat field, update `Chat`, `normalizeChat()`, chat creation sites, and
  hydration tests.

- To change the stub metadata schema, update `chatStub.ts`, both conversion functions,
  both client/server allowlists, and `chatRows.cjs` assembly semantics.

- To change when edits save, inspect the reactive effects and 500 ms debounce in
  `saveDb()`.

- To change generation checkpoint timing, durable-known-chat promotion, or row failure
  behavior, start in `chatPersistStage.ts`; its production integration is
  `persistTrackedChanges()`.

- To add an explicit durability point after a bulk operation, inspect
  `DatabaseSaveOutcome.status` from `requestImmediateSave()` or use
  `requireCommittedDatabaseSave()`. Awaiting without checking the outcome is insufficient.

- To change patch/full-write conflict behavior, inspect
  `rebaseTrackedLocalChangesOnLatestServerDb()` and `persistTrackedChanges()`.

- To change staged-acknowledgement retention, durable confirmation timing, or
  replay policy, start at `stagedAckTracker.ts` and its `triggerSave()`
  integration; the server's structural/staged split lives in `/api/patch` and
  `server/node/db/dbCachePersistence.cjs`.

- To change structural array diffing for modules or presets, start at
  `diffArrayWithIdGuard()` and `risuSavePatcher.test.ts`.

- To diagnose unexpected chat-field patches, start at `findDangerousChatOps()` and enable
  the guarded diagnostic path around the patch call.

- To change lazy chat loading, inspect `ensureChatHydrated()` and
  `NodeStorage.fetchChatContent()`.

- To change chat-row worker encoding, checkpoint delta preparation, or strict-save worker
  decode, inspect `payloadCodecClient.ts`, `payloadCodecService.ts`,
  `payloadCodecOperations.ts`, and `payloadCodec.worker.ts` together.

- To change writer takeover, inspect `server/node/runtime/session-lock.cjs`, `NodeStorage`'s session
  headers, `checkWriterTakeoverOnReturn()`, and `writerTakeover.ts` together; registration,
  passive compatibility writes, and gesture-backed acquisition are distinct cases.

- To change build-upgrade behavior, inspect `clientBuild.ts`,
  `clientBuildHandshake.ts`, the save-loop dirty-state probe, and `NodeStorage` session/XHR
  headers together.

- To change crash recovery for model requests, inspect
  `src/ts/process/request/jobRecovery.ts`, `server/node/runtime/model-jobs.cjs`, and
  `server/node/runtime/request-logs.cjs`; preserve chat-row publication before logging/claiming.

- To change database boot caching, update `NodeStorage.readDatabaseForBoot()`, `src/ts/storage/dbCachedRead.ts`, `src/ts/storage/rawMsgpack.ts`, `server/node/db/dbCachedRead.cjs`, and `/api/db/read-cached` as one protocol.

- To change chat/plugin cache limits, verification, retention, or UI, start in `src/ts/storage/resourceCache.ts` and its tests; coordinate hash headers and response hashes with the server routes.

- To change plugin-storage recovery management, manifest revision/snapshot reads, or viewer
  paging, start with [Plugin storage](plugin-storage.md) and then update the corresponding
  `NodeStorage`/`AutoStorage` methods and Settings consumers.

- To change delta key listing, update `NodeStorage.keys()`, its `risu-list-cache` schema, `server/node/db/listDelta.cjs`, and the deletion-journal/epoch helpers in `server/node/db/db.cjs`.

- To change chat-version import semantics, inspect `transformChatBackupForImport()`/`importChatBackup()` in `chatStorage.ts`, `markCharacterDirty()` in `globalApi.svelte.ts`, and `ChatBackupList.svelte`.

- To change chat-selection loading UX, inspect `changeChatTo()`.

- To change how many messages render initially or on upward scroll, edit
  `src/ts/chatLoadPages.ts` and its `DefaultChatScreen.svelte` consumer.

- To change draft timing or ordering, inspect `DEBOUNCE_MS`, the serialized `writeChain`,
  and flush paths in `chatDraft.ts`.

- To add a new standalone JSON KV namespace, use the helpers in `persistentKv.ts`; choose
  hashed keys when the raw key must not appear in the storage path and encoded keys when
  reversibility is required. Those generic encoded keys reject ill-formed Unicode;
  optimized plugin save rows instead use `pluginSaveKeyPolicy.ts`'s tagged/mapped forms.

- To modify normal, upstream-target, main-target rollback, server-file, or partial export,
  start with [Backup and recovery](backup-recovery.md), `backuplocal.ts`,
  `NodeStorage.exportBackup()`, and the matching server route/job protocol.

- To change destructive replacement outcomes or reload behavior, update `storageError.ts`, `backupReplacementUi.ts`, `snapshotRestoreUi.ts`, `NodeStorage`, and the exact server acknowledgement schemas together.

- To add a startup schema migration, decide whether it is an idempotent field default for
  `setDatabase()` or a versioned/structural migration for `checkNewFormat()`.

- To change character/persona/module conversion compatibility, inspect the marker
  transformations in `src/ts/interchangeability.ts`.

## 7. Related structure docs

- [Server backend](server-backend.md) owns SQLite KV routing, ETags, server guards,
  debounced persistence, chat rows, and filesystem stores.
- [Backup and recovery](backup-recovery.md) owns archive, import, snapshot, and destructive
  replacement semantics.
- [Plugin storage](plugin-storage.md) owns versioned plugin publications and transitions.
- [Model providers](model-providers.md) owns durable request creation, journal decoding,
  provider adapters, and usage extraction; this document owns recovered chat publication.
- [UI layer](ui-layer.md) owns hydration/draft UX and render-only pagination.
- [Characters and personas](characters-personas.md) owns object interchange and
  card/package-specific storage consumers.
