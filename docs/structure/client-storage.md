# Client storage

> Part of the PocketRisu structure docs — see [STRUCTURE.md](../../STRUCTURE.md) for the top-level map and subsystem index.
> Audited 2026-07-27 against `abee0232`. Paths and symbols are authoritative; line-number hints are approximate and should be verified with `rg`.

## 1. Purpose & overview

The client-storage subsystem owns PocketRisu’s canonical `Database` model, its Svelte 5 reactive instance, save-format encoding/decoding, server-backed storage access, and startup migrations. It splits large chat bodies from `database.bin`: the database transported to the browser contains lightweight chat stubs, while full chats are fetched and saved separately through server endpoints. A staged reactive save loop observes database mutations, establishes durable chat rows before their stubs can commit, checkpoints active generations, then synchronizes the stub-only database through JSON Patch or an ETag-protected full write. An opt-in IndexedDB resource cache reuses SHA-256-verified database segments, chats, and optimized plugin values without becoming authoritative. The subsystem also owns composer draft sessions, explicit save outcomes, writer displacement, boot recovery orchestration, and client transport for [backup/recovery](backup-recovery.md) and [plugin storage](plugin-storage.md).

## 2. Key files

| File | Role and important symbols |
|---|---|
| `src/ts/storage/database.svelte.ts` | Canonical data model, defaults, Svelte-state accessors, preset/theme helpers. `setDatabase()` fills defaults and normalizes imported data; `setDatabaseLite()` only assigns `DBState.db`; `getDatabase()` can return a `$state.snapshot`. The model now includes `optimizePluginMemory` and its inline/external ownership metadata. |
| `src/ts/globalApi.svelte.ts` | Creates the process-wide `forageStorage` adapter and implements database persistence. `requestImmediateSave()` returns an explicit save outcome; `markCharacterDirty()` and `markChatDirty()` bridge arbitrary-target mutations; and `saveDb()` installs reactive effects and the permanent save loop. It delegates save coordination to `databaseSave.ts` and row-before-stub/checkpoint decisions to `chatPersistStage.ts`. |
| `src/ts/storage/dirtyTargetBridge.ts`, `dirtyTargetDiff.ts` | Buffer explicit character/chat targets until the save loop is ready and compute compatibility-safe targets for V3 character-array replacements and package chat imports. The diff separates character/stub metadata from full chat rows and never promotes runtime placeholders to authoritative row data. |
| `src/ts/storage/nodeStorage.ts` | HTTP client for the Node server. Besides auth, KV, patching, chat rows, cached boot reads, and key-list deltas, it owns bounded request/outcome handling, snapshot restore, backup jobs/replacements, and the generation-pinned plugin manifest/mutation/batch/transition protocols. |
| `src/ts/storage/autoStorage.ts` | Compatibility facade that lazily selects `NodeStorage` and forwards the expanded chat, backup, snapshot, and plugin-storage protocols. Some read paths initialize defensively; ordinary writes still assume bootstrap completed initialization. |
| `src/ts/storage/risuSave.ts` | All save codecs, incremental block encoding, normalization, patch generation, and client chat guards. Legacy encoders are at `:39` and `:56`; `RisuSaveEncoder` starts at `:109`; `RisuSaveDecoder` at `:411`; format-dispatching `decodeRisuSave()` at `:598`. `normalizeJSON()` is at `:745`, `diffArrayWithIdGuard()` at `:807`, `RisuSavePatcher` at `:840`, and `findDangerousChatOps()` at `:1203`. There are no separate production `normalizeJSON`, `risuSavePatcher`, or `chatGuards` files. |
| `src/ts/storage/chatStub.ts` | Runtime-independent stub type and predicate. `ChatStub` contains only identity/display metadata plus `_stub: true` (`:13`); `isChatStub()` additionally requires that no `message` array exists (`:36`). |
| `src/ts/storage/chatStorage.ts` | Stub/placeholder conversion, lazy hydration, chat-backup reason tags, and version import. `setChatBackupReason()` records one-shot reasons (`:102`); `saveChatToServer()` consumes them (`:129`); `importChatBackup()` clones a recovered version under a fresh chat ID and explicitly dirties its target character (`:157`); `ensureChatHydrated()` begins at `:184`. |
| `src/ts/storage/chatPersistStage.ts` | Testable row-persistence stage used by `saveDb()`. It discovers changed/new chats, requires authoritative row writes before stub commit, checkpoints a generating chat at most once per 20 seconds, requeues it for the final post-generation save, and updates the known-chat baseline only after a committed stub database. `prepareChatPersistStage()` starts at `:136`. |
| `src/ts/chatLoadPages.ts` | Validates message-render limits. Defaults are 30 initially and 15 additionally (`:1-2`); normalization is at `:4`; database-facing getters are at `:17` and `:21`. Despite the names, these values count messages, not server pages. |
| `src/ts/storage/chatDraft.ts` | Stores per-chat unsent composer text outside `Chat`. `ChatDraftSession` distinguishes loading, ready, error, and closed states so a temporary empty composer cannot delete an unread draft after a failed or in-flight load. |
| `src/ts/storage/persistentKv.ts` | JSON/KV primitives plus structured plugin mutation, version, batch, generation, and commit-outcome helpers. Reads can opt into verified resource caching; hashed and reversible key builders remain common plugin/MCP primitives. |
| `src/ts/storage/resourceCache.ts` | Disposable SHA-256-addressed IndexedDB cache for wire bytes and manifests. It owns enable/support checks, strict entry/manifest validation, verified reads, batched hashing, retention planning, write serialization, stats, pruning, and clearing. Limits include 64 MiB total, 32 MiB per value, 512 ordinary manifests, and 32,768 entries. |
| `src/ts/storage/dbCachedRead.ts` | Client half of the segmented boot protocol. It decodes the raw MessagePack envelope, rejects unexpected shapes/unadvertised hits, re-hashes resident entries, assembles root plus array groups, and returns manifest updates with the server ETag. `rawMsgpack.ts` provides the record-free MessagePack decoder. |
| `src/ts/bootstrap.ts` | Orders the secure-context gate, storage initialization, cached/raw boot read, decode/defaults, server-side snapshot recovery, optimized-plugin boot reconciliation, migrations, placeholder conversion, UI initialization, ID repair, and save-loop startup. |
| `src/ts/storage/databaseSave.ts` | `DatabaseSaveCoordinator`, save pause/fencing, exact `DatabaseSaveOutcome`, and `requireCommittedDatabaseSave()` for callers that need durability. |
| `src/ts/storage/databaseClone.ts` | Database-aware clone/merge helpers that preserve special own keys and avoid unsafe proxy cloning during conflicts and backup preparation. |
| `src/ts/storage/bootSnapshotRecovery.ts` | Walks metadata-only snapshot candidates and asks the server to validate/publish them atomically. |
| `src/ts/storage/backupReplacementUi.ts`, `snapshotRestoreUi.ts`, `storageError.ts` | Destructive replacement UX, committed/not-committed/unknown classification, no-replay policy, and hard-reload reconciliation. |
| `src/ts/drive/backuplocal.ts` | Client UI for streamed full/upstream/server exports, cancellable server-side partial export jobs, and bounded backup replacement. Detailed semantics live in [Backup and recovery](backup-recovery.md). |
| `src/ts/storage/exportAsDataset.ts` | Produces a JSON array containing character identity, description, each chat’s messages, and lorebook. The sole entry point is `exportAsDataset()` (`:6`). |
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
- `src/ts/drive/backuplocal.test.ts` verifies server-owned partial export, cancellation, missing-asset reporting, sink cleanup, and destructive replacement outcomes.
- `src/ts/chatLoadPages.test.ts` covers normalization and defaults (`:10`).
- `src/ts/storage/resourceCache.test.ts` covers hashing, validation, cache limits, retention, corruption rejection, and multi-entry database manifests.
- `src/ts/storage/persistentKv.test.ts` verifies that cached JSON reads use the hash-aware adapter without changing ordinary reads.
- `test/compat/db-cached-read.test.ts` exercises the segmented boot protocol against the real server, including warm-cache transfer reduction and corruption fallback.

## 3. Architecture & data flow

### Canonical runtime state

`DBState.db` is the actual Svelte 5 `$state` object, declared outside this directory in `src/ts/stores.svelte.ts:144`. `setDatabaseLite()` assigns a supplied object directly to that state (`src/ts/storage/database.svelte.ts:739`), while `setDatabase()` first mutates the object to supply hundreds of backward-compatible defaults and then calls the lite setter (`:37`, `:731-736`).

Most application code calls `getDatabase()` and mutates the returned live proxy directly. Code needing a non-reactive copy uses `getDatabase({ snapshot: true })`, which invokes `$state.snapshot` (`:747-751`). Current character/chat access is index-based through `selectedCharID` and `character.chatPage`; see `getCurrentCharacter()` (`:754`) and `getCurrentChat()` (`:786`).

`setDatabase()` handles additive/default migrations such as:

- Missing root arrays, prompts, API settings, UI settings, personas, presets, and modules (`:37-183`, `:377-429`).
- Stable UUIDs on bot presets while retaining the physical `botPresetsId` index required for upstream backup compatibility (`:188-200`, `:1025-1030`).
- Legacy provider-shape conversion (`:504-529`).
- Chat-render count validation (`:731-732`).
- Language activation and model-preset defaults before installing the state (`:734-736`).

Structural/versioned migrations that need broader context live separately in `bootstrap.checkNewFormat()`, not in `setDatabase()`.

### Startup load order

`loadData()` performs the following sequence:

1. Reject remote plain-HTTP boot unless `POCKETRISU_ALLOW_INSECURE_CONTEXT` was injected by the server, because WebCrypto is required for content-addressed integrity (`src/ts/bootstrap.ts:126`).
2. Initialize `forageStorage`, which creates `NodeStorage`, then call `readDatabaseForBoot()`. When the resource cache is enabled this attempts a segmented root/characters/botPresets/modules/personas read. Cache disablement or any verification/protocol failure falls back to `/api/db/read-raw-for-boot`, not ordinary normalized `/api/read`, so corrupt authoritative bytes can enter recovery without being hidden by server decoding.
3. If the authoritative read reports no database, encode and write an empty legacy save, then let `setDatabase({})` construct defaults (`:146-157`).
4. Decode full bytes or accept the already decoded/verified segmented result, capture an untouched patch baseline, and only then call `setDatabase()` (`:151-157`). Capturing first matters because `setDatabase()` adds client defaults that should subsequently be synchronized to the server.
5. On decode failure, request metadata-only snapshot candidates and submit them newest-first to the server's bounded atomic restore route. The wait has no total wall-clock deadline: strict NDJSON activity refreshes a two-minute inactivity watchdog, and a lost response is reconciled through the durable operation-status route. Try an older candidate only after a definitive not-committed result; a committed or unknown result stops fallback. Folded snapshot/chat/plugin bodies never enter browser memory.
6. Reconcile optimized plugin storage before plugin loading through `reconcilePluginStorageModeForBoot()`. It isolates bad rows and surfaces recovery/copy-only diagnostics rather than treating an unavailable source as empty. Publication and mode-switch semantics are owned by [Plugin storage](plugin-storage.md).
7. Load plugins, run `checkNewFormat()`, and normalize character/module/persona data (`:216-230`, `:433-608`).
8. Convert on-wire `ChatStub` objects into runtime-safe placeholder `Chat` objects (`:232-239`).
9. Apply UI state, optionally offer the one-time resource-cache enable prompt, run the backup reminder, mark the app loaded, assign IDs, then start `saveDb()` (`:241-279`). Module updates follow and stale remote-cache cleanup is deferred five seconds. Ordinary asset garbage collection is server-owned and never runs from the client boot path.

`checkNewFormat()` also purges unsupported group entries (`:339-342`), advances `formatversion` through version 5 (`:408-462`), removes expired trash (`:472-479`), and starts a best-effort sweep of draft keys whose chats no longer exist (`:483-493`).

### Client-to-server save loop

`saveDb()` creates a long-lived save coordinator (`src/ts/globalApi.svelte.ts:377`):

1. A `toSaveType` tracker separates root, character, chat, bot-preset, module, plugin, and plugin-storage changes (`:408-416`; type at `src/ts/storage/risuSave.ts:70`).
2. Svelte effects `deepTouch` the relevant state branches. Initial effect runs are suppressed so loading itself is not treated as an edit (`src/ts/globalApi.svelte.ts:465-605`).
   Before those effects install, `capturePreTrackingPluginStorageChanges()` compares the untouched server baseline with state changed during plugin startup so early plugin writes are not lost.
3. Root collections are tracked separately for efficient patching. Character tracking deliberately excludes full `chats`; it observes character fields plus chat ordering/stub metadata (`:510-605`).
4. A second effect deeply observes only the active chat. Switching chat establishes a baseline, and hydration activity is ignored (`:607-640`).
5. Normal edits set `changed` after a 500 ms debounce (`:477-503`). The permanent loop polls every 200 ms, serializes through `saveInFlight`, and retries failures with bounded backoff (`:1030-1110`).
6. `requestImmediateSave()` queues behind older in-flight work and returns a `DatabaseSaveOutcome`. Callers that need durability must inspect `committed` or use `requireCommittedDatabaseSave()`; merely awaiting the promise is not a durability proof. `DatabaseSaveCoordinator` can pause saves during staged publication or fence them until reload after an unresolved outcome.
7. On a `doingChat` false→true transition, the per-generation checkpoint tracker is cleared. A save during generation always writes the first dirty row, then suppresses rewrites until 20 seconds have elapsed; candidates stay requeued so true→false schedules an unconditional final-row save (`src/ts/storage/chatPersistStage.ts:136-204`; `src/ts/globalApi.svelte.ts:505-513`). The server’s 45-second pre-image cooldown prevents a history version for every checkpoint.
8. `visibilitychange` and `pagehide` invoke an immediate, non-broadcast save with `forceChatPersist`, then a keepalive `/api/db/flush` request. The server reports flush success only after a complete SQLite `FULL` checkpoint; the browser-side page-hide attempt remains best-effort because navigation can end the keepalive request before its result is observed (`:516-532`).

Before database metadata is written, `persistTrackedChanges()` calls `prepareChatPersistStage()`, which saves each eligible changed or newly discovered full chat through `/api/chat-content` and rejects if any row write fails (`:769-804`). Only after the row stage succeeds does it call `RisuSaveEncoder.set()`, whose character blocks replace every chat with `chatToStub()` (`:806-813`; `src/ts/storage/risuSave.ts:219-235`). The stage’s `completeStubCommit()` promotes newly discovered chat IDs into the known baseline only after patch/full-write commit; no-op, conflict, and retry paths retain the dirty proof instead of creating a phantom known stub.

When `supportsPatchSync` is enabled (`src/ts/platform.ts:18`):

- `RisuSavePatcher.set()` generates an RFC 6902 patch and an expected hash against the captured stub-only baseline (`src/ts/globalApi.svelte.ts:834-842`; `src/ts/storage/risuSave.ts:927`).
- `findDangerousChatOps()` rejects field-level operations outside the stub metadata allowlist before they leave the browser (`src/ts/globalApi.svelte.ts:842-855`).
- `/api/patch` applies the patch to the server’s stripped cache; the response updates the cached ETag and may surface deferred persistence warnings (`:980-996`).
- A patch-hash conflict never promotes the rejected response's ETag. The client reads the authoritative database and ETag as one provisional candidate, overlays tracked local state, reinstalls runtime placeholders with `setDatabase()`, rebuilds the encoder from the merge and the patcher from the authoritative baseline, publishes the ETag last, and retries without promoting the row stage as a committed stub save (`:692-767`, `:965-990`).
- Non-conflict patch rejections such as the chat guard may fall through to an ETag-guarded full `database.bin` write. Patch-enabled clients refuse an unversioned full write, and an ETag conflict enters the same provisional rebase path (`:990-1025`).
- A successful full write is decoded again to reinitialize the patcher from exactly what was transmitted (`:1015-1020`).
- If an import owns the server mutation barrier, `/api/write` returns `503 IMPORT_IN_PROGRESS`; `NodeStorage.setItem()` fails the attempt and the save coordinator requeues the tracked changes for a later cycle (`src/ts/storage/nodeStorage.ts:298-327`).

The server acknowledges a patch before SQLite persistence: it debounces the stubs-only database write by five seconds. Chat-body POSTs are write-through. At the debounce boundary, the server commits the new stubs-only row and any now-unreferenced chat-row deletions in one SQLite transaction; a full `/api/write` likewise commits payload rows, plugin rows, `database.bin`, and targeted chat deletions atomically. Reads flush pending work first. `POST /api/db/flush` drains that pending work and returns success only after SQLite reports a complete `FULL` checkpoint, including when the operator selected a `NORMAL`-synchronous mode; page-hide transport is still best-effort because the browser does not await the keepalive response (`server/node/server.cjs`).

### Lazy chat storage and hydration

#### Chat storage externalization

The server persists `database/database.bin` as the same stubs-only shape sent to the browser, while each full body is a separate `chats/<chaId>/<chatId>` SQLite KV row. `/api/read` therefore decodes and caches the small stripped row directly; monolith imports, snapshots, and backups are split or assembled only at explicit boundaries (`server/node/server.cjs:3945`; `server/node/chatRows.cjs:347`).

A stub contains only `id`, `name`, optional `lastDate`, `folderId`, `modules`, and `_stub: true` (`src/ts/storage/chatStub.ts:13-20`). At boot, `convertStubsToPlaceholders()` changes it into a type-compatible `Chat` with empty `message`, `note`, and `localLore`, plus `_placeholder: true` (`src/ts/storage/chatStorage.ts:17-30`, `:63-71`). Runtime code therefore normally sees `Chat`, never `ChatStub`.

Opening a placeholder invokes this flow:

1. `changeChatTo()` detects `_placeholder` and shows a cancellable loading overlay (`src/ts/globalApi.svelte.ts:2720-2750`).
2. `ensureChatHydrated()` deduplicates concurrent requests by `chaId/chatId` (`src/ts/storage/chatStorage.ts:184-201`).
3. `NodeStorage.fetchChatContent()` calls `/api/chat-content/<chaId>/<index>` with `x-chat-id`. With the optional resource cache enabled it also advertises verified resident hashes; a matching server `204` reuses locally re-hashed bytes, while any cache anomaly retries an unconditional read. Returned bytes are decoded and passed through `normalizeChat()` (`src/ts/storage/nodeStorage.ts:924`).
4. After the fetch, hydration re-finds the chat by ID so an index shift cannot write into the wrong slot (`src/ts/storage/chatStorage.ts:210-220`).
5. It yields one animation frame, replaces the placeholder, waits one Svelte tick, and clears hydration suppression (`:221-230`).

The server also verifies `x-chat-id` if it falls back to index lookup, returning 409 on an index mismatch (`server/node/server.cjs:12530`). Saving a chat captures an eligible pre-image, writes its row synchronously, returns its content hash for cache seeding, and schedules the coalesced automatic snapshot only after acknowledgement; it does not wait for or schedule the database debounce (`server/node/server.cjs:12589`).

### Verified browser resource cache

The cache is an opt-in performance layer, separate from server-backed `forageStorage`. `resourceCache.ts` stores immutable wire bytes by SHA-256 plus per-resource manifests in IndexedDB; only its enable flag and one-time announcement live in `localStorage`. Disabling it increments an epoch, waits for queued writes, closes the connection, and deletes the database.

Three protocols consume it:

- Boot splits the stubs-only database into `root`, individual `characters`, `botPresets`, `modules`, and `personas`. The client advertises up to 8,192 verified hashes, reconstructs a MessagePack envelope from hits/misses, validates exact shape and ETag, then persists the new manifests.
- Chat and optimized `pluginsave/*` reads advertise recent verified hashes and accept a `204` only when `x-content-hash` names an advertised, locally present, re-hashed entry.
- Successful plugin/chat writes compare the server-returned hash with the bytes just sent before seeding the cache.

Retention is deliberately bounded and best-effort. IndexedDB/quota/WebCrypto errors become misses; database cache manifests may hold thousands of ordered hashes, while ordinary resource manifests retain only recent versions. Settings → Advanced toggles the feature, and the System dashboard reports/clears it.

`NodeStorage.keys()` uses a separate `risu-list-cache` IndexedDB store. Each prefix remembers its full key set, server timestamp, and list epoch. `/api/list` may return `added`/`deleted` deltas; the client merges additions with precedence, persists the new snapshot asynchronously, and accepts a full response whenever the server cannot prove the delta window. The server waits for an active import to finish before listing and changes the epoch on boot and on every import commit/rollback, so a transactional replacement cannot publish a cacheable intermediate key set.

### Message rendering pagination

Chat pagination does not fetch partial chat bodies. Once a chat is hydrated, its entire `message` array is in memory; `loadPages` only limits mounted Svelte message components.

`DefaultChatScreen` initializes the render count from `getInitialChatLoadPages()` (`src/lib/ChatScreens/DefaultChatScreen.svelte:68`) and adds `getAdditionalChatLoadPages()` when the user scrolls near the oldest mounted message (`:1189-1201`). `Chats.svelte` renders backward from the latest message to `messages.length - loadPages` (`src/lib/ChatScreens/Chats.svelte:63-98`). The defaults are 30 and 15 messages, and invalid, non-finite, or sub-one settings fall back to a positive integer (`src/ts/chatLoadPages.ts:1-15`).

### Composer drafts

Drafts deliberately do not modify `Chat`, so typing does not re-upload a chat body. `DefaultChatScreen` loads a draft on chat entry, flushes the prior draft on switch/unmount, schedules writes while typing, and flushes again on page hide (`src/lib/ChatScreens/DefaultChatScreen.svelte:84-150`).

`chatDraft.ts` keeps one in-memory prefix index to avoid a read for chats with no draft (`:31-46`). All writes and removals share one promise chain, preventing a late save from resurrecting a draft after send/removal (`:48-79`). Typing is debounced by 800 ms (`:24-25`, `:110-117`), while blur/switch/unmount paths enqueue immediately (`:120-131`).

### Backup and destructive recovery

- Full, upstream-target, and server-file exports stream from server-owned point-in-time sources. Full/server exports require a valid live database and every referenced chat.
- `SavePartialLocalBackup()` creates, polls, downloads, and deletes a cancellable server export job. The server pins selected state and identity assets, folds plugin/chat rows, reports missing assets, and can preserve an already-missing chat as a bare stub. Browser placeholders are not hydrated for this flow.
- `LoadLocalBackup()`, server-backup restore, save-folder replacement, and snapshot restore distinguish committed, not-committed, and unknown outcomes. Save-folder and snapshot waits are activity-based and reconcile lost acknowledgements against transaction-bound operation status. Ambiguous destructive requests are never replayed; the UI warns and reloads to reconcile authoritative state.
- `target=upstream` is a lossy migration export: it omits inlay payload, sidecar, and metadata namespaces. Use the normal Node export for PocketRisu recovery.
- Per-chat pre-image import remains separate: it decodes one history version, assigns a fresh chat ID, and saves it as a new chat instead of overwriting current row identity.

See [Backup and recovery](backup-recovery.md) for archive, pinning, import, snapshot, limit, cancellation, and outcome contracts.

## 4. Entry points & dependencies

### Main callers into this subsystem

| Caller | Edge |
|---|---|
| `src/ts/bootstrap.ts:38-170` | Initializes storage, reads/decodes the database, installs defaults, converts stubs, and starts persistence. |
| Most files under `src/ts/` and `src/lib/` | Import `getDatabase()`, `getCurrentCharacter()`, or the `Database`/`character`/`Chat` types. The returned database is usually mutated in place. |
| `src/lib/ChatScreens/DefaultChatScreen.svelte:153-161` | Blocks chat operations until the active placeholder is hydrated. |
| `src/ts/globalApi.svelte.ts:2720-2752` | Hydrates a newly selected chat and restores per-chat toggle values. |
| `src/ts/characters.ts:164-180`, `:487-503` | Hydrates chats before single-chat or all-chat export. |
| `src/lib/ChatScreens/DefaultChatScreen.svelte:84-150` | Loads, debounces, flushes, and removes composer drafts. |
| `src/lib/Setting/Pages/SystemBackup.svelte:23-28` | Exposes normal local/server backup operations. |
| `src/lib/Setting/ChatBackupList.svelte` | Lists server-side per-chat histories and imports a selected pre-image as a new chat into any current character. |
| `src/lib/Setting/Pages/Advanced/ResourceCacheSettings.svelte` and `SystemDashboard.svelte` | Enable/disable the disposable browser cache, display its usage, and clear it. |
| `src/lib/Setting/Pages/MigrationSettings.svelte:9-16`, `:38-54` | Exposes upstream-target backup, upstream backup import, partial backup, save-folder migration, and dataset export. |
| `src/ts/plugins/plugins.svelte.ts:421-425` | Uses `setDatabaseLite()` and then explicitly requests an immediate save after plugin import. |
| Character-card, persona, module, script, and command subsystems | Mutate the shared database or call `setDatabase()`/`setDatabaseLite()` after bulk imports and conversions. |

### Calls out of this subsystem

- Svelte 5 `$state`, `$effect`, `$state.snapshot`, and `tick` provide reactivity and hydration suppression.
- `src/ts/stores.svelte.ts` owns `DBState`, `selectedCharID`, loading state, and selection state.
- `src/ts/gui/deepTouch.svelte.ts` forces nested reactive reads for save dirty tracking.
- `msgpackr` supplies legacy MessagePack encoding; `fflate` and browser compression streams supply compressed variants (`src/ts/storage/risuSave.ts:1-14`, `:26-67`).
- `fast-json-patch` is loaded lazily by `RisuSavePatcher.set()` (`src/ts/storage/risuSave.ts:927-930`).
- `NodeStorage` calls Express endpoints for auth, KV, cached database reads, full/delta key lists, patching, chat bodies, chat history, backups, assets, and save-folder migration.
- `server/node/server.cjs` owns SQLite persistence, ETags, session locking, chat-row routing, backup framing, and the server-side copies of chat guards; `server/node/chatRows.cjs` owns split/assembly and row semantics.
- Browser WebCrypto and IndexedDB back `resourceCache.ts`; `server/node/dbCachedRead.cjs` is its database-segmentation counterpart, while server `x-content-hash`/`x-cached-hashes` handling covers KV/chat entries.
- `streamSaver` is used for large streamed downloads (`src/ts/drive/backuplocal.ts:20-23`; `src/ts/globalApi.svelte.ts:1742-1745`).

## 5. Conventions & gotchas

- `setDatabase()` is the compatibility/defaulting boundary; `setDatabaseLite()` is a raw state replacement. New imported or decoded databases generally need the former. Use the latter only when defaults were already applied or object identity/update timing requires it.

- `getDatabase()` returns the live Svelte proxy by default. Mutating it is the normal application convention and is what the save effects observe. Use `{ snapshot: true }` when serializing or exposing data that must not remain reactive (`src/ts/storage/database.svelte.ts:747-751`).

- `Database.characters` is typed as `character[]` and `character.chats` as `Chat[]`, even though decoded wire data temporarily contains `ChatStub`. Boot must perform stub-to-placeholder conversion before ordinary runtime consumers execute.

- `_stub` is a persisted/wire marker; `_placeholder` is runtime-only. Never persist a placeholder as if it were a real chat, and never use `_placeholder` for server row lookup or assembly.

- A real stub requires both `_stub === true` and the absence of a `message` array (`src/ts/storage/chatStub.ts:22-39`). Legacy hybrid objects with `_stub: true` and full chat fields must be treated as full chats so their messages are not discarded.

- `convertStubsToPlaceholders()` self-heals hybrids by removing `_stub` and retaining the payload (`src/ts/storage/chatStorage.ts:57-70`). Changing this behavior can turn historical corruption into actual message loss.

- `chatToStub()` and `stubToPlaceholder()` preserve whether `lastDate`, `folderId`, and `modules` keys exist, even when their value is `null` or `undefined` (`src/ts/storage/chatStorage.ts:12-15`, `:27-29`, `:36-49`). Server snapshot/backup assembly uses the same `in` semantics so “explicitly cleared” differs from “not supplied” (`server/node/chatRows.cjs:218-231`).

- Keep the stub metadata allowlist synchronized across `chatToStub()`, client `STUB_METADATA_FIELDS`, and server `STUB_METADATA_FIELDS` (`src/ts/storage/risuSave.ts:1177-1181`; `server/node/server.cjs:636-640`).

- `_stub` may only be added or replaced with literal `true`; removing it or writing a falsy value is a data-loss vector. `move`, `copy`, and `test` operations touching chat-internal paths are rejected (`src/ts/storage/risuSave.ts:1182-1237`).

- Chat protection is layered: the client refuses dangerous patch operations, the patch endpoint returns 409 for anything the client missed, and both debounced and full-write disk boundaries refuse metadata-only chats that have neither `_stub` nor `message` (`src/ts/globalApi.svelte.ts:834-855`, `:1005-1011`; `server/node/server.cjs:708-772`, `:4276-4295`).

- Hydration must be suppressed from dirty tracking. `hydrationInFlight` covers the network phase and `hydrationJustApplied` covers the Svelte tick after replacement (`src/ts/storage/chatStorage.ts:113-120`, `:201-240`).

- Hydration is keyed by stable `chaId/chatId`, not only array index. Preserve chat IDs across reorder/import operations; both client and server use the ID to prevent applying data to a shifted index.

- Full chat content is saved before its database stub/metadata. A row failure blocks the stub commit, and a new chat becomes “known” only after row durability proof plus a committed stub database (`src/ts/storage/chatPersistStage.ts:49-96`, `:131-204`; `src/ts/globalApi.svelte.ts:792-813`).

- Generation chat persistence is throttled, not disabled. The first save in a generation writes the dirty row, later saves write only after the 20-second checkpoint interval, every candidate remains dirty for the final idle-transition save, and page-hide forces a row write. The server’s independent 45-second pre-image cooldown limits recovery-history churn.

- Optimized plugin keys must be well-formed Unicode before reversible UTF-8/base64url encoding. Current optimized authority is generation/manifest-bound, and production mode changes use a private staged server transition with one atomic finalize—not independent row writes or the old direct reconcile loop. See [Plugin storage](plugin-storage.md).

- Backup-reason tags are one-shot. `saveChatToServer()` consumes the pending reason before the network call, so a failed write will not automatically reuse it on retry. Reasons are descriptive recovery metadata, not durability controls.

- Importing a chat backup must allocate a new chat ID. Restoring in place would collide with current row identity and could cause the pre-image mechanism to capture/overwrite the wrong logical history. Non-selected targets must go through `markCharacterDirty()` and full chat bodies through `markChatDirty()`.

- Render pagination is not storage pagination. Increasing `chatLoadInitialPages` or `chatLoadAdditionalPages` changes DOM/component load only; it does not reduce the hydrated chat payload.

- `exportAsDataset()` does not hydrate placeholders before reading `chat.message` (`src/ts/storage/exportAsDataset.ts:10-18`). On the normal lazy-loaded runtime database, unopened chats therefore export as empty message arrays. Any correctness fix should explicitly hydrate or reject missing chat content; the server-side partial-export job is not a browser-hydration example.

- Partial export is a cancellable server job and does not serialize browser memory. Keep its selected-asset, missing-row, cancellation, and point-in-time behavior in sync with [Backup and recovery](backup-recovery.md).

- Ordinary patch persistence legacy-encodes the stubs-only cache. A normal full write with no embedded chat payloads preserves the client bytes verbatim; only payload extraction forces a stripped re-encode.

- `decodeRisuSave()` supports raw, fflate-compressed, gzip-stream, RISUSAVE block-stream, headerless MessagePack, old `\0\0RISU` data, compressed JSON, and compressed MessagePack fallbacks (`src/ts/storage/risuSave.ts:598-641`, `:644-690`). Removing fallback paths can strand upstream or historical backups.

- NodeOnly disables creation of remote character blocks (`src/ts/storage/risuSave.ts:17-18`) but retains decoder support (`:540-566`). The server also has a one-time migration for old upstream `remotes/<chaId>.local.bin` saves (`server/node/server.cjs:455-468`).

- `normalizeJSON()` is part of the client/server patch protocol. It maps non-finite numbers and circular references to `null`, dates to ISO strings, regex/errors to `{}`, and omits unsupported object properties (`src/ts/storage/risuSave.ts:745-789`). Changing it requires matching server hashing/normalization behavior and patch-protocol tests.

- `calculateHash()` is likewise protocol-level and must stay byte-for-byte behaviorally compatible with the server implementation (`src/ts/storage/risuSave.ts:704-743`).

- Arrays with stable IDs use whole-array replacement on add/delete/reorder or invalid/duplicate IDs, avoiding enormous index-shift diffs (`src/ts/storage/risuSave.ts:791-837`). Callers must iterate returned operations instead of spreading a potentially huge list.

- The save loop assumes `forageStorage.Init()` ran during bootstrap. `getItemCached()`, `readDatabaseForBoot()`, and `keys()` now initialize defensively, but core `setItem()`, `getItem()`, `removeItem()`, and `patchItem()` still forward through `realStorage` directly.

- `forageStorage` is no longer browser localForage in this fork; it fronts authenticated server HTTP and SQLite. Drafts and `persistentKv` values therefore synchronize across clients using the same server account.

- The resource cache and list cache are exceptions to that naming rule: both are browser-local IndexedDB performance caches. Clearing them loses no authoritative application data, and code must tolerate unsupported/blocked IndexedDB, quota failures, stale manifests, corrupted bytes, and cache eviction.

- Database segment identity is raw MessagePack SHA-256, while the full database concurrency ETag is MD5 over the legacy-encoded stubs-only view. Do not substitute one for the other or derive ETags from the segmented envelope.

- Draft write/remove queues isolate persistence failures so they cannot block chat interaction. Reads are different: `loadChatDraft()` returns explicit found/absent/error state, and `ChatDraftSession` prevents a failed or pending load from turning temporary empty UI into a destructive remove.

- The save coordinator uses both `BroadcastChannel('risu-db')` for same-browser tabs and the server’s `x-session-id` lock for other devices (`src/ts/globalApi.svelte.ts:380-416`; `src/ts/storage/nodeStorage.ts:154-198`). A 423 response permanently fences the stale page, aborts its active chat request, and offers an explicit choice between a frozen read-only recovery view and discarding local state to reload/take write access. The server lock remains last-caller-wins; this UI does not flush or durably journal the displaced page's dirty state (`src/ts/storage/writerTakeover.ts`).

- Patch conflict rebasing treats `plugins` and `pluginCustomStorage` as tracked branches instead of generic root fields; when their flags are dirty it explicitly overlays the local copies alongside bot presets, modules, and tracked characters (`src/ts/globalApi.svelte.ts:692-765`). Preserve those explicit branches when changing the merge.

- The physical `botPresetsId` index remains part of upstream RisuAI compatibility even though new code prefers stable preset UUID helpers (`src/ts/storage/database.svelte.ts:1025-1030`, `:2341-2402`).

- `interchangeability.ts` encodes character-only fields into specially marked lore entries such as `@@indicator phi`, `character_desc`, and `character_first_message` (`:26-48`, `:73-115`). Its deep clones prevent conversion from mutating the source module/character (`:15-16`, `:69-70`).

## 6. Navigation hints

- To add or change a persisted root setting, update the `Database` interface and its defaulting in `setDatabase()` (`src/ts/storage/database.svelte.ts:37`, `:959`).

- To add a required chat field, update `Chat`, `normalizeChat()`, chat creation sites, and hydration tests (`src/ts/storage/database.svelte.ts:2025-2072`).

- To change the stub metadata schema, update `chatStub.ts`, both conversion functions, both client/server allowlists, and row-assembly semantics (`src/ts/storage/chatStub.ts:13`; `src/ts/storage/chatStorage.ts:20-53`; `src/ts/storage/risuSave.ts:1181`; `server/node/server.cjs:640`; `server/node/chatRows.cjs:218`).

- To change when edits save, inspect the reactive effects and 500 ms debounce in `saveDb()` (`src/ts/globalApi.svelte.ts:465-640`).

- To change generation checkpoint timing, durable-known-chat promotion, or row failure behavior, start in `src/ts/storage/chatPersistStage.ts`; its production integration is `src/ts/globalApi.svelte.ts:769-804`.

- To add an explicit durability point after a bulk operation, inspect the `DatabaseSaveOutcome` from `requestImmediateSave()` or use `requireCommittedDatabaseSave()`. Awaiting without checking the outcome is insufficient.

- To change patch/full-write conflict behavior, inspect `rebaseTrackedLocalChangesOnLatestServerDb()` and `persistTrackedChanges()` (`src/ts/globalApi.svelte.ts:692`, `:769`).

- To change structural array diffing for modules or presets, start at `diffArrayWithIdGuard()` and its regression suite (`src/ts/storage/risuSave.ts:807`; `src/ts/storage/risuSavePatcher.test.ts:29`).

- To diagnose unexpected chat-field patches, start at `findDangerousChatOps()` and enable the guarded diagnostic path around the patch call (`src/ts/storage/risuSave.ts:1203`; `src/ts/globalApi.svelte.ts:842-993`).

- To change lazy chat loading, inspect `ensureChatHydrated()` and the NodeStorage chat endpoints (`src/ts/storage/chatStorage.ts:184`; `src/ts/storage/nodeStorage.ts:924`).

- To change database boot caching, update `NodeStorage.readDatabaseForBoot()`, `src/ts/storage/dbCachedRead.ts`, `src/ts/storage/rawMsgpack.ts`, `server/node/dbCachedRead.cjs`, and `/api/db/read-cached` as one protocol.

- To change chat/plugin cache limits, verification, retention, or UI, start in `src/ts/storage/resourceCache.ts` and its tests; coordinate hash headers and response hashes with the server routes.

- To change delta key listing, update `NodeStorage.keys()`, its `risu-list-cache` schema, `server/node/listDelta.cjs`, and the deletion-journal/epoch helpers in `server/node/db.cjs`.

- To change chat-version import semantics, inspect `transformChatBackupForImport()`/`importChatBackup()` in `chatStorage.ts`, `markCharacterDirty()` in `globalApi.svelte.ts`, and `ChatBackupList.svelte`.

- To change chat-selection loading UX, inspect `changeChatTo()` (`src/ts/globalApi.svelte.ts:2720-2755`).

- To change how many messages render initially or on upward scroll, edit `src/ts/chatLoadPages.ts:1-22` and the consumer at `src/lib/ChatScreens/DefaultChatScreen.svelte:1189-1201`.

- To change draft timing or ordering, inspect `DEBOUNCE_MS`, the serialized `writeChain`, and flush paths (`src/ts/storage/chatDraft.ts:24-25`, `:54-79`, `:109-131`).

- To add a new standalone JSON KV namespace, use the helpers in `src/ts/storage/persistentKv.ts:37-86`; choose hashed keys when the raw key must not appear in the storage path and encoded keys when reversibility is required. Encoded keys reject ill-formed Unicode.

- To modify normal, upstream-target, server-file, or partial export, start with [Backup and recovery](backup-recovery.md), `backuplocal.ts`, `NodeStorage.exportBackup()`, and the matching server route/job protocol.

- To change destructive replacement outcomes or reload behavior, update `storageError.ts`, `backupReplacementUi.ts`, `snapshotRestoreUi.ts`, `NodeStorage`, and the exact server acknowledgement schemas together.

- To add a startup schema migration, decide whether it is an idempotent field default for `setDatabase()` or a versioned/structural migration for `checkNewFormat()` (`src/ts/storage/database.svelte.ts:37`; `src/ts/bootstrap.ts:305`).

- To change character/persona/module conversion compatibility, inspect the marker transformations in `src/ts/interchangeability.ts:6-191`.

## 7. Related structure docs

- [Server backend](server-backend.md) owns SQLite KV routing, ETags, server guards,
  debounced persistence, chat rows, and filesystem stores.
- [Backup and recovery](backup-recovery.md) owns archive, import, snapshot, and destructive
  replacement semantics.
- [Plugin storage](plugin-storage.md) owns versioned plugin publications and transitions.
- [UI layer](ui-layer.md) owns hydration/draft UX and render-only pagination.
- [Characters and personas](characters-personas.md) owns object interchange and
  card/package-specific storage consumers.
