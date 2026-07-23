# client-storage

> Part of the PocketRisu structure docs — see [STRUCTURE.md](../../STRUCTURE.md) for the top-level map and subsystem index.
> Generated 2026-07-23 from codebase analysis. Line numbers are approximate and drift as code changes; verify with `rg` before relying on them.

## 1. Purpose & overview

The client-storage subsystem owns PocketRisu’s canonical `Database` model, its Svelte 5 reactive instance, save-format encoding/decoding, server-backed key/value access, and startup migrations. It splits large chat bodies from `database.bin`: the database sent to the browser contains lightweight chat stubs, while full chats are fetched and saved separately through server endpoints. A reactive save loop observes database mutations, writes changed chats first, then synchronizes the stub-only database through JSON Patch or an ETag-protected full write. The subsystem also provides composer drafts, render-only message pagination, internal snapshots, `.bin` backup import/export, and compatibility paths for older RisuAI save formats.

## 2. Key files

| File | Approx. size | Role and important symbols |
|---|---:|---|
| `src/ts/storage/database.svelte.ts` | 3,058 lines | Canonical data model, defaults, Svelte-state accessors, preset/theme helpers. `setDatabase()` fills defaults and normalizes imported data (`:37`); `setDatabaseLite()` only assigns `DBState.db` (`:739`); `getDatabase()` optionally returns a `$state.snapshot` (`:747`). Core types begin at `Database` (`:959`), `character` (`:1536`), `Chat` (`:2034`), and `Message` (`:2089`). `normalizeChat()` restores required chat fields at trust boundaries (`:2025`). |
| `src/ts/globalApi.svelte.ts` | 2,775 lines; storage pipeline mainly `:237-1119` | Creates the process-wide `forageStorage` adapter (`:31`) and implements database persistence. `requestImmediateSave()` delegates to the save loop (`:357`), `setPatchSyncBaseline()` preserves the server baseline (`:363`), and `saveDb()` installs reactive effects and runs the permanent save loop (`:367`). Also contains `LocalWriter` for framed backup streams (`:1732`) and `loadInternalBackup()` (`:2365`). |
| `src/ts/storage/nodeStorage.ts` | 759 lines | HTTP client for the Node Express storage API. `NodeStorage` starts at `:40`; ordinary KV methods are `setItem()` (`:187`), `getItem()` (`:216`), `keys()` (`:239`), and `removeItem()` (`:258`). `patchItem()` sends guarded JSON Patch updates (`:326`); backup export/import starts at `:417` and `:442`; chat-content GET/POST wrappers are at `:631` and `:641`. |
| `src/ts/storage/autoStorage.ts` | 84 lines | Thin compatibility facade that always selects `NodeStorage`. `Init()` constructs it lazily (`:27`), while `patchItem()` (`:51`), ETag accessors (`:55`), bulk operations (`:67`), backup calls (`:71`), and migration calls (`:78`) forward directly to the server adapter. |
| `src/ts/storage/risuSave.ts` | 1,241 lines | All save codecs, incremental block encoding, normalization, patch generation, and client chat guards. Legacy encoders are at `:39` and `:56`; `RisuSaveEncoder` starts at `:109`; `RisuSaveDecoder` at `:411`; format-dispatching `decodeRisuSave()` at `:598`. `normalizeJSON()` is at `:745`, `diffArrayWithIdGuard()` at `:807`, `RisuSavePatcher` at `:840`, and `findDangerousChatOps()` at `:1203`. There are no separate production `normalizeJSON`, `risuSavePatcher`, or `chatGuards` files. |
| `src/ts/storage/chatStub.ts` | 40 lines | Runtime-independent stub type and predicate. `ChatStub` contains only identity/display metadata plus `_stub: true` (`:13`); `isChatStub()` additionally requires that no `message` array exists (`:36`). |
| `src/ts/storage/chatStorage.ts` | 201 lines | Stub/placeholder conversion and lazy hydration. `stubToPlaceholder()` (`:17`), `chatToStub()` (`:40`), and `convertStubsToPlaceholders()` (`:63`) define the shape transitions. `ensureChatHydrated()` fetches and applies a full chat safely (`:133`); `ensureCurrentChatReady()` is the active-chat convenience entry point (`:195`). |
| `src/ts/chatLoadPages.ts` | 23 lines | Validates message-render limits. Defaults are 30 initially and 15 additionally (`:1-2`); normalization is at `:4`; database-facing getters are at `:17` and `:21`. Despite the names, these values count messages, not server pages. |
| `src/ts/storage/chatDraft.ts` | 153 lines | Stores per-chat unsent composer text outside `Chat`. `ChatDraft` is defined at `:17`; keys use `drafts/<chaId>/<chatId>` (`:27`). Loading is at `:91`, debounced save at `:110`, immediate flush at `:121`, removal at `:128`, and boot-time orphan sweeping at `:140`. |
| `src/ts/storage/persistentKv.ts` | 72 lines | Generic JSON-over-KV helpers using `forageStorage`, despite the historical “forage” naming. Read/write/remove/list are at `:32`, `:41`, `:46`, and `:51`; hashed and reversible encoded key builders are at `:61` and `:66`. |
| `src/ts/bootstrap.ts` | 580 lines | Orders initial storage initialization, decode, defaults, migrations, placeholder conversion, UI initialization, ID repair, and save-loop startup. The entry point is `loadData()` (`:38`); structural migrations live in `checkNewFormat()` (`:305`); `assignIds()` repairs missing or duplicate character/chat IDs (`:553`). |
| `src/ts/drive/backuplocal.ts` | 347 lines | Client UI operations for streamed server backups and compatibility imports. Normal and upstream-target exports are `SaveLocalBackup()` (`:47`) and `SaveLocalBackupForUpstream()` (`:59`). `SavePartialLocalBackup()` creates a selective client-side backup (`:81`); `LoadLocalBackup()` uploads `.bin` files to the server (`:229`); server-side backup creation is exposed by `SaveServerBackup()` (`:334`). |
| `src/ts/storage/exportAsDataset.ts` | 26 lines | Produces a JSON array containing character identity, description, each chat’s messages, and lorebook. The sole entry point is `exportAsDataset()` (`:6`). |
| `src/ts/storage/defaultPrompts.ts` | 28 lines | Supplies prompt defaults consumed by `setDatabase()`, including `defaultMainPrompt`, `defaultJailbreak`, and `defaultAutoSuggestPrompt` (`:3-7`). |
| `src/ts/interchangeability.ts` | 191 lines | Schema conversion among characters, personas, and modules. Character/module conversions are at `:6` and `:54`; character/persona conversions at `:121` and `:135`; persona/module conversions at `:146` and `:173`. This is object-schema compatibility, not the `.bin` codec. |

Relevant regression coverage:

- `src/ts/storage/chatStub.test.ts` verifies real-stub versus hybrid detection (`:10`).
- `src/ts/storage/chatStorage.test.ts` covers stub round trips, key-presence semantics, and hybrid self-healing (`:33`, `:109`, `:152`).
- `src/ts/storage/chatGuards.test.ts` covers path matching, internal-field rejection, `_stub` restrictions, and disallowed patch operations (`:17`, `:53`, `:81`, `:116`).
- `src/ts/storage/risuSavePatcher.test.ts` is a large patch round-trip and fast-path suite; the main round-trip section begins at `:440`.
- `src/ts/storage/normalizeJSON.test.ts` checks path-based circular-reference handling (`:11`).
- `src/ts/storage/chatDraft.test.ts` covers write ordering, orphan cleanup, and round trips (`:48`, `:78`, `:90`).
- `src/ts/chatLoadPages.test.ts` covers normalization and defaults (`:10`).

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

1. Initialize `forageStorage`, which creates `NodeStorage` (`src/ts/bootstrap.ts:45`; `src/ts/storage/autoStorage.ts:27-31`).
2. Read `database/database.bin` through `/api/read` (`src/ts/bootstrap.ts:48`; `src/ts/storage/nodeStorage.ts:216-237`).
3. If it is absent, encode and write an empty legacy save, then let `setDatabase({})` construct defaults (`src/ts/bootstrap.ts:50-59`).
4. Decode with `decodeRisuSave()`, capture an untouched patch baseline, and only then call `setDatabase()` (`:55-59`). Capturing first matters because `setDatabase()` adds client defaults that should subsequently be synchronized to the server.
5. On decode failure, try internal `database/dbbackup-*.bin` snapshots newest-first (`:60-77`).
6. Load plugins, run `checkNewFormat()`, and normalize character/module/persona data (`:111-125`, `:305-480`).
7. Convert on-wire `ChatStub` objects into runtime-safe placeholder `Chat` objects (`:127-134`).
8. Apply UI state, mark the app loaded, assign missing/duplicate IDs, then start `saveDb()` (`:136-170`).
9. Run module updates and defer stale asset/remote cleanup until five seconds after entry (`:171-175`).

`checkNewFormat()` also purges unsupported group entries (`:339-342`), advances `formatversion` through version 5 (`:408-462`), removes expired trash (`:472-479`), and starts a best-effort sweep of draft keys whose chats no longer exist (`:483-493`).

### Client-to-server save loop

`saveDb()` creates a long-lived save coordinator (`src/ts/globalApi.svelte.ts:367`):

1. A `toSaveType` tracker separates root, character, chat, bot-preset, module, plugin, and plugin-storage changes (`:408-416`; type at `src/ts/storage/risuSave.ts:70`).
2. Svelte effects `deepTouch` the relevant state branches. Initial effect runs are suppressed so loading itself is not treated as an edit (`src/ts/globalApi.svelte.ts:465-605`).
3. Root collections are tracked separately for efficient patching. Character tracking deliberately excludes full `chats`; it observes character fields plus chat ordering/stub metadata (`:510-605`).
4. A second effect deeply observes only the active chat. Switching chat establishes a baseline, and hydration activity is ignored (`:607-640`).
5. Normal edits set `changed` after a 500 ms debounce (`:477-491`). The permanent loop polls every 200 ms, serializes through `saveInFlight`, and retries failures with bounded backoff (`:1049-1117`).
6. `requestImmediateSave()` bypasses the edit debounce by setting `changed`, waiting one Svelte tick, and calling the same serialized trigger (`:1093-1099`).
7. `visibilitychange` and `pagehide` invoke an immediate, non-broadcast save and a keepalive `/api/db/flush` request (`:453-463`, `:493-508`).

Before database metadata is written, `persistTrackedChanges()` saves each changed or newly discovered full chat through `/api/chat-content` (`:801-820`). Only after all chat writes succeed does it call `RisuSaveEncoder.set()`, whose character blocks replace every chat with `chatToStub()` (`:822-829`; `src/ts/storage/risuSave.ts:219-235`).

When `supportsPatchSync` is enabled (`src/ts/platform.ts:18`):

- `RisuSavePatcher.set()` generates an RFC 6902 patch and an expected hash against the captured stub-only baseline (`src/ts/globalApi.svelte.ts:834-842`; `src/ts/storage/risuSave.ts:927`).
- `findDangerousChatOps()` rejects field-level operations outside the stub metadata allowlist before they leave the browser (`src/ts/globalApi.svelte.ts:842-855`).
- `/api/patch` applies the patch to the server’s stripped cache; the response updates the cached ETag and may surface deferred persistence warnings (`:995-1011`).
- Any patch rejection or conflict falls through to a full `database.bin` write using the last ETag (`:1014-1029`).
- An ETag conflict fetches the latest server database, overlays tracked local state, reinstalls it with `setDatabase()`, rebuilds encoder/patcher baselines, and retries (`:712-777`).
- A successful full write is decoded again to reinitialize the patcher from exactly what was transmitted (`:1031-1036`).

The server acknowledges a patch before SQLite persistence: it debounces the merged disk write by five seconds (`server/node/server.cjs:56`, `:3690-3725`). Reads flush pending work first (`:3274-3279`), and the client’s page-hide `/api/db/flush` provides another best-effort durability boundary.

### Lazy chat storage and hydration

The server persists a full database but returns a stripped copy to the browser. `/api/read` decodes the stored database, fills its in-memory chat store, replaces chats with stubs, and returns the stripped legacy-encoded database plus an ETag (`server/node/server.cjs:3292-3316`).

A stub contains only `id`, `name`, optional `lastDate`, `folderId`, `modules`, and `_stub: true` (`src/ts/storage/chatStub.ts:13-20`). At boot, `convertStubsToPlaceholders()` changes it into a type-compatible `Chat` with empty `message`, `note`, and `localLore`, plus `_placeholder: true` (`src/ts/storage/chatStorage.ts:17-30`, `:63-71`). Runtime code therefore normally sees `Chat`, never `ChatStub`.

Opening a placeholder invokes this flow:

1. `changeChatTo()` detects `_placeholder` and shows a cancellable loading overlay (`src/ts/globalApi.svelte.ts:2720-2750`).
2. `ensureChatHydrated()` deduplicates concurrent requests by `chaId/chatId` (`src/ts/storage/chatStorage.ts:133-150`).
3. `NodeStorage.fetchChatContent()` calls `/api/chat-content/<chaId>/<index>` with `x-chat-id`, decodes the response, and runs `normalizeChat()` (`src/ts/storage/nodeStorage.ts:631-639`).
4. After the fetch, hydration re-finds the chat by ID so an index shift cannot write into the wrong slot (`src/ts/storage/chatStorage.ts:159-168`).
5. It yields one animation frame, replaces the placeholder, waits one Svelte tick, and clears hydration suppression (`:170-185`).

The server also verifies `x-chat-id` if it falls back to index lookup, returning 409 on an index mismatch (`server/node/server.cjs:4514-4528`). Saving a chat updates the server’s `fullChatStore` and schedules the same five-second merged persist (`:4540-4578`).

### Message rendering pagination

Chat pagination does not fetch partial chat bodies. Once a chat is hydrated, its entire `message` array is in memory; `loadPages` only limits mounted Svelte message components.

`DefaultChatScreen` initializes the render count from `getInitialChatLoadPages()` (`src/lib/ChatScreens/DefaultChatScreen.svelte:68`) and adds `getAdditionalChatLoadPages()` when the user scrolls near the oldest mounted message (`:1189-1201`). `Chats.svelte` renders backward from the latest message to `messages.length - loadPages` (`src/lib/ChatScreens/Chats.svelte:63-98`). The defaults are 30 and 15 messages, and invalid, non-finite, or sub-one settings fall back to a positive integer (`src/ts/chatLoadPages.ts:1-15`).

### Composer drafts

Drafts deliberately do not modify `Chat`, so typing does not re-upload a chat body. `DefaultChatScreen` loads a draft on chat entry, flushes the prior draft on switch/unmount, schedules writes while typing, and flushes again on page hide (`src/lib/ChatScreens/DefaultChatScreen.svelte:84-150`).

`chatDraft.ts` keeps one in-memory prefix index to avoid a read for chats with no draft (`:31-46`). All writes and removals share one promise chain, preventing a late save from resurrecting a draft after send/removal (`:48-79`). Typing is debounced by 800 ms (`:24-25`, `:110-117`), while blur/switch/unmount paths enqueue immediately (`:120-131`).

### Backup flows

- `SaveLocalBackup()` requests `/api/backup/export` and streams the response to disk without buffering the entire backup (`src/ts/drive/backuplocal.ts:15-51`).
- `SaveLocalBackupForUpstream()` adds `target=upstream` (`:59-63`; `src/ts/storage/nodeStorage.ts:417-423`).
- The server flushes pending database changes before export and frames assets plus full `database.risudat` entries (`server/node/server.cjs:3844-3855`, `:3928-3954`).
- The upstream target omits NodeOnly `inlay/`, `inlay_sidecar/`, and `inlay_meta/` namespaces because upstream import treats slash-containing names as asset paths and fails (`server/node/server.cjs:3847-3855`).
- `LoadLocalBackup()` uploads a selected `.bin` to `/api/backup/import`, reports upload/server progress, then reloads the app (`src/ts/drive/backuplocal.ts:229-257`; `src/ts/storage/nodeStorage.ts:442-515`).
- `SavePartialLocalBackup()` selects only identity assets, hydrates every placeholder, aborts if any full chat is missing, and writes compressed full database data as `database.risudat` (`src/ts/drive/backuplocal.ts:104-210`).
- `LocalWriter.writeBackup()` uses the legacy backup framing of 32-bit name length, basename, 32-bit data length, and data (`src/ts/globalApi.svelte.ts:1754-1762`).
- Server-side backups are initiated through `SaveServerBackup()` and do not route database contents through browser memory (`src/ts/drive/backuplocal.ts:334-346`).

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
| `src/lib/Setting/Pages/MigrationSettings.svelte:9-16`, `:38-54` | Exposes upstream-target backup, upstream backup import, partial backup, save-folder migration, and dataset export. |
| `src/ts/plugins/plugins.svelte.ts:421-425` | Uses `setDatabaseLite()` and then explicitly requests an immediate save after plugin import. |
| Character-card, persona, module, script, and command subsystems | Mutate the shared database or call `setDatabase()`/`setDatabaseLite()` after bulk imports and conversions. |

### Calls out of this subsystem

- Svelte 5 `$state`, `$effect`, `$state.snapshot`, and `tick` provide reactivity and hydration suppression.
- `src/ts/stores.svelte.ts` owns `DBState`, `selectedCharID`, loading state, and selection state.
- `src/ts/gui/deepTouch.svelte.ts` forces nested reactive reads for save dirty tracking.
- `msgpackr` supplies legacy MessagePack encoding; `fflate` and browser compression streams supply compressed variants (`src/ts/storage/risuSave.ts:1-14`, `:26-67`).
- `fast-json-patch` is loaded lazily by `RisuSavePatcher.set()` (`src/ts/storage/risuSave.ts:927-930`).
- `NodeStorage` calls Express endpoints for auth, KV, patching, chat bodies, backups, assets, and save-folder migration.
- `server/node/server.cjs` owns SQLite persistence, ETags, session locking, full-chat merging, backup framing, and the server-side copies of chat guards.
- `streamSaver` is used for large streamed downloads (`src/ts/drive/backuplocal.ts:20-23`; `src/ts/globalApi.svelte.ts:1742-1745`).

## 5. Conventions & gotchas

- `setDatabase()` is the compatibility/defaulting boundary; `setDatabaseLite()` is a raw state replacement. New imported or decoded databases generally need the former. Use the latter only when defaults were already applied or object identity/update timing requires it.

- `getDatabase()` returns the live Svelte proxy by default. Mutating it is the normal application convention and is what the save effects observe. Use `{ snapshot: true }` when serializing or exposing data that must not remain reactive (`src/ts/storage/database.svelte.ts:747-751`).

- `Database.characters` is typed as `character[]` and `character.chats` as `Chat[]`, even though decoded wire data temporarily contains `ChatStub`. Boot must perform stub-to-placeholder conversion before ordinary runtime consumers execute.

- `_stub` is a persisted/wire marker; `_placeholder` is runtime-only. Never persist a placeholder as if it were a real chat, and never use `_placeholder` as the server merge signal.

- A real stub requires both `_stub === true` and the absence of a `message` array (`src/ts/storage/chatStub.ts:22-39`). Legacy hybrid objects with `_stub: true` and full chat fields must be treated as full chats so their messages are not discarded.

- `convertStubsToPlaceholders()` self-heals hybrids by removing `_stub` and retaining the payload (`src/ts/storage/chatStorage.ts:57-70`). Changing this behavior can turn historical corruption into actual message loss.

- `chatToStub()` and `stubToPlaceholder()` preserve whether `lastDate`, `folderId`, and `modules` keys exist, even when their value is `null` or `undefined` (`src/ts/storage/chatStorage.ts:12-15`, `:27-29`, `:36-49`). Server merging uses `in` semantics so “explicitly cleared” differs from “not supplied” (`server/node/server.cjs:425-431`).

- Keep the stub metadata allowlist synchronized across `chatToStub()`, client `STUB_METADATA_FIELDS`, and server `STUB_METADATA_FIELDS` (`src/ts/storage/risuSave.ts:1172-1176`; `server/node/server.cjs:567-571`).

- `_stub` may only be added or replaced with literal `true`; removing it or writing a falsy value is a data-loss vector. `move`, `copy`, and `test` operations touching chat-internal paths are rejected (`src/ts/storage/risuSave.ts:1182-1237`).

- Chat protection is layered: the client refuses dangerous patch operations, the patch endpoint returns 409 for anything the client missed, and the server disk boundary refuses metadata-only chats that have neither `_stub` nor `message` (`src/ts/globalApi.svelte.ts:834-855`, `:1005-1011`; `server/node/server.cjs:3629-3659`, `:682-699`).

- Hydration must be suppressed from dirty tracking. `hydrationInFlight` covers the network phase and `hydrationJustApplied` covers the Svelte tick after replacement (`src/ts/storage/chatStorage.ts:97-104`, `:150-185`).

- Hydration is keyed by stable `chaId/chatId`, not only array index. Preserve chat IDs across reorder/import operations; both client and server use the ID to prevent applying data to a shifted index.

- Full chat content is saved before its database stub/metadata. Reversing that order could leave a new stub pointing to chat content that was never accepted by the server (`src/ts/globalApi.svelte.ts:801-829`).

- Render pagination is not storage pagination. Increasing `chatLoadInitialPages` or `chatLoadAdditionalPages` changes DOM/component load only; it does not reduce the hydrated chat payload.

- `exportAsDataset()` does not hydrate placeholders before reading `chat.message` (`src/ts/storage/exportAsDataset.ts:10-18`). On the normal lazy-loaded runtime database, unopened chats therefore export as empty message arrays. Any correctness fix should follow the hydrate-or-abort pattern used by `exportAllChats()` and partial backup.

- Client partial backup must hydrate all placeholders because it serializes browser memory. Normal server backup/export does not need client hydration because the server’s persistent database contains full chats.

- Ordinary server persistence re-encodes a full legacy MessagePack database even when the browser submits a RISUSAVE block stream. Do not assume the client’s stub-only encoder representation is the final on-disk representation.

- `decodeRisuSave()` supports raw, fflate-compressed, gzip-stream, RISUSAVE block-stream, headerless MessagePack, old `\0\0RISU` data, compressed JSON, and compressed MessagePack fallbacks (`src/ts/storage/risuSave.ts:598-641`, `:644-690`). Removing fallback paths can strand upstream or historical backups.

- NodeOnly disables creation of remote character blocks (`src/ts/storage/risuSave.ts:17-18`) but retains decoder support (`:540-566`). The server also has a one-time migration for old upstream `remotes/<chaId>.local.bin` saves (`server/node/server.cjs:455-468`).

- `normalizeJSON()` is part of the client/server patch protocol. It maps non-finite numbers and circular references to `null`, dates to ISO strings, regex/errors to `{}`, and omits unsupported object properties (`src/ts/storage/risuSave.ts:745-789`). Changing it requires matching server hashing/normalization behavior and patch-protocol tests.

- `calculateHash()` is likewise protocol-level and must stay byte-for-byte behaviorally compatible with the server implementation (`src/ts/storage/risuSave.ts:704-743`).

- Arrays with stable IDs use whole-array replacement on add/delete/reorder or invalid/duplicate IDs, avoiding enormous index-shift diffs (`src/ts/storage/risuSave.ts:791-837`). Callers must iterate returned operations instead of spreading a potentially huge list.

- The save loop assumes `forageStorage.Init()` ran during bootstrap. Several `AutoStorage` methods, including `setItem()`, `getItem()`, and `patchItem()`, forward without calling `Init()` themselves (`src/ts/storage/autoStorage.ts:8-21`, `:51-52`).

- `forageStorage` is no longer browser localForage in this fork; it fronts authenticated server HTTP and SQLite. Drafts and `persistentKv` values therefore synchronize across clients using the same server account.

- Draft operations intentionally swallow failures so draft persistence cannot block chat interaction (`src/ts/storage/chatDraft.ts:54-60`). Do not reuse that error policy for database or chat-body writes.

- The save coordinator uses both `BroadcastChannel('risu-db')` for same-browser tabs and the server’s `x-session-id` lock for other devices (`src/ts/globalApi.svelte.ts:380-406`; `src/ts/storage/nodeStorage.ts:43-45`, `:162-175`). A 423 response deactivates the page and prompts reload.

- Patch conflict rebasing currently restores local root fields, bot presets, modules, and tracked characters, but excludes `plugins` and `pluginCustomStorage` from the root copy without explicitly restoring their local versions (`src/ts/globalApi.svelte.ts:720-762`). Treat this existing asymmetry carefully when modifying conflict resolution.

- The physical `botPresetsId` index remains part of upstream RisuAI compatibility even though new code prefers stable preset UUID helpers (`src/ts/storage/database.svelte.ts:1025-1030`, `:2341-2402`).

- `interchangeability.ts` encodes character-only fields into specially marked lore entries such as `@@indicator phi`, `character_desc`, and `character_first_message` (`:26-48`, `:73-115`). Its deep clones prevent conversion from mutating the source module/character (`:15-16`, `:69-70`).

## 6. Navigation hints

- To add or change a persisted root setting, update the `Database` interface and its defaulting in `setDatabase()` (`src/ts/storage/database.svelte.ts:37`, `:959`).

- To add a required chat field, update `Chat`, `normalizeChat()`, chat creation sites, and hydration tests (`src/ts/storage/database.svelte.ts:2025-2072`).

- To change the stub metadata schema, update `chatStub.ts`, both conversion functions, both client/server allowlists, and merge semantics (`src/ts/storage/chatStub.ts:13`; `src/ts/storage/chatStorage.ts:17-50`; `src/ts/storage/risuSave.ts:1172`; `server/node/server.cjs:408`, `:567`).

- To change when edits save, inspect the reactive effects and 500 ms debounce in `saveDb()` (`src/ts/globalApi.svelte.ts:465-640`).

- To add an explicit durability point after a bulk operation, call or extend `requestImmediateSave()` (`src/ts/globalApi.svelte.ts:357`, `:1093-1099`).

- To change patch/full-write conflict behavior, inspect `rebaseTrackedLocalChangesOnLatestServerDb()` and `persistTrackedChanges()` (`src/ts/globalApi.svelte.ts:712`, `:779`).

- To change patch normalization or hashing, modify `normalizeJSON()`, `calculateHash()`, and the matching server implementations together (`src/ts/storage/risuSave.ts:704-789`).

- To change structural array diffing for modules or presets, start at `diffArrayWithIdGuard()` and its regression suite (`src/ts/storage/risuSave.ts:807`; `src/ts/storage/risuSavePatcher.test.ts:29`).

- To diagnose unexpected chat-field patches, start at `findDangerousChatOps()` and enable the guarded diagnostic path around the patch call (`src/ts/storage/risuSave.ts:1203`; `src/ts/globalApi.svelte.ts:842-993`).

- To change lazy chat loading, inspect `ensureChatHydrated()` and the NodeStorage chat endpoints (`src/ts/storage/chatStorage.ts:133`; `src/ts/storage/nodeStorage.ts:631-652`).

- To change chat-selection loading UX, inspect `changeChatTo()` (`src/ts/globalApi.svelte.ts:2720-2755`).

- To change how many messages render initially or on upward scroll, edit `src/ts/chatLoadPages.ts:1-22` and the consumer at `src/lib/ChatScreens/DefaultChatScreen.svelte:1189-1201`.

- To change draft timing or ordering, inspect `DEBOUNCE_MS`, the serialized `writeChain`, and flush paths (`src/ts/storage/chatDraft.ts:24-25`, `:54-79`, `:109-131`).

- To add a new standalone JSON KV namespace, use the helpers in `src/ts/storage/persistentKv.ts:32-70`; choose hashed keys when the raw key must not appear in the storage path and encoded keys when reversibility is required.

- To modify normal or upstream-compatible `.bin` export, start at `SaveLocalBackup()`/`SaveLocalBackupForUpstream()` and the server export route (`src/ts/drive/backuplocal.ts:47-69`; `server/node/server.cjs:3844`).

- To modify selective client-side backup contents, edit asset collection and the hydrate-or-abort loop in `SavePartialLocalBackup()` (`src/ts/drive/backuplocal.ts:104-206`).

- To add a startup schema migration, decide whether it is an idempotent field default for `setDatabase()` or a versioned/structural migration for `checkNewFormat()` (`src/ts/storage/database.svelte.ts:37`; `src/ts/bootstrap.ts:305`).

- To change character/persona/module conversion compatibility, inspect the marker transformations in `src/ts/interchangeability.ts:6-191`.

## Out of scope, noticed

- `server/node/server.cjs` is the authoritative counterpart for SQLite KV storage, full-chat merging, ETags, server-side guards, debounced persistence, and backup framing.
- `src/ts/stores.svelte.ts` owns the actual `$state` container and selection/loading stores.
- `src/lib/ChatScreens/DefaultChatScreen.svelte` and `Chats.svelte` own chat hydration UX, drafts, and render pagination.
- `src/ts/characters.ts`, `characterCards.ts`, `persona.ts`, and `process/modules.ts` are major model consumers/import-export subsystems that must respect storage hydration and ID invariants.