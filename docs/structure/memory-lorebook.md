# Memory and lorebook

> Part of the PocketRisu structure docs — see [STRUCTURE.md](../../STRUCTURE.md) for the top-level map and subsystem index.
> Audited 2026-08-04 against `95c2ea30`. Paths and symbols are authoritative; line-number hints are approximate and should be verified with `rg`.

## 1. Purpose & overview

The memory-lorebook subsystem builds context that is not simply the recent chat transcript: key-activated lorebook entries, dynamically enabled module content, embedding-selected character background, and compressed long-term chat summaries. Lorebook matching runs while the main prompt is assembled, before history trimming or Hypa V3 compression; long-term memory then replaces older chat messages with a token-budgeted `<Past Events Summary>` system message. Module lorebooks enter the same activation path as character and chat lore, while module regexes, triggers, assets, toggles, and MCP endpoints are exposed to their respective consumers. There is no separate `supaMemory.ts`: “Supa Memory” is the UI/toggle and prompt memo name used by Hypa V3.

## 2. Key files

### Core lorebook activation

- `src/ts/process/lorebook.svelte.ts` — Owns lorebook creation, matching, recursive activation, decorators, token-budget selection, and JSON import/export.
  - `addLorebook(type)` creates a character-level entry when `type === 0`, otherwise a chat-local entry (`src/ts/process/lorebook.svelte.ts:15`).
  - `addLorebookFolder(type)` creates a UI folder marker using `mode: "folder"` and a `\uf000folder:<uuid>` key (`src/ts/process/lorebook.svelte.ts:44`).
  - `loadLoreBookV3Prompt()` is the runtime matcher and principal entry point (`src/ts/process/lorebook.svelte.ts:74`).
  - `importLoreBook(mode)` and `exportLoreBook(mode)` handle native Risu JSON and external lorebook formats (`src/ts/process/lorebook.svelte.ts:663`, `src/ts/process/lorebook.svelte.ts:742`).
  - `CCLorebook` describes several external lorebook shapes (`src/ts/process/lorebook.svelte.ts:699`).
  - `convertExternalLorebook(entries)` normalizes external keys, ordering, labels, content, constant activation, secondary keys, and selective matching (`src/ts/process/lorebook.svelte.ts:722`).

### Long-term memory and embeddings

- `src/ts/process/memory/hypamemory.ts` — First-generation embedding client, vector store, and shared persistent embedding cache.
  - `HypaModel` lists custom, OpenAI, local Transformers, and Voyage Context 3/4 backends (`src/ts/process/memory/hypamemory.ts:9`).
  - `localModels` maps UI model identifiers to Hugging Face model IDs and identifies WebGPU variants (`src/ts/process/memory/hypamemory.ts:14`).
  - `hypaVectorCache`, `getPersistedHypaVector()`, and `setPersistedHypaVector()` provide process-local and persistent vector caching (`src/ts/process/memory/hypamemory.ts:40`, `src/ts/process/memory/hypamemory.ts:43`, `src/ts/process/memory/hypamemory.ts:56`).
  - `HypaProcesser` embeds documents, loads cached vectors, and performs similarity search (`src/ts/process/memory/hypamemory.ts:69`).
  - `similarity()` is a dot product, relying on the backend to return normalized vectors (`src/ts/process/memory/hypamemory.ts:259`).
  - `contextHash()` creates the context component used by contextual-embedding cache keys (`src/ts/process/memory/hypamemory.ts:267`).

- `src/ts/process/memory/hypamemoryv2.ts` — Metadata-aware embedding processor used by the experimental Hypa V3 implementation.
  - `HypaProcessorV2Options`, `EmbeddingText`, and `EmbeddingResult` define configuration and vector records with stable IDs and arbitrary metadata (`src/ts/process/memory/hypamemoryv2.ts:10`, `src/ts/process/memory/hypamemoryv2.ts:17`, `src/ts/process/memory/hypamemoryv2.ts:23`).
  - `HypaProcessorV2` owns an ID-keyed vector map, caching, batching, rate limiting, and cosine similarity (`src/ts/process/memory/hypamemoryv2.ts:29`).
  - `addTexts()` embeds and retains source documents; `similaritySearchScoredBatch()` deduplicates query strings and returns ranked document records for each original query (`src/ts/process/memory/hypamemoryv2.ts:47`, `src/ts/process/memory/hypamemoryv2.ts:58`).
  - Contextual models group texts by metadata identity so all chunks belonging to one summary are embedded together (`src/ts/process/memory/hypamemoryv2.ts:112`).
  - Local models run sequentially with device-sensitive chunk sizes; API models run through `TaskRateLimiter` (`src/ts/process/memory/hypamemoryv2.ts:194`, `src/ts/process/memory/hypamemoryv2.ts:244`, `src/ts/process/memory/hypamemoryv2.ts:281`).
  - Unlike `HypaProcesser`, V2 computes full cosine similarity rather than a raw dot product (`src/ts/process/memory/hypamemoryv2.ts:351`).

- `src/ts/process/memory/contextualEmbedding.ts` — Adapter layer for context-dependent embedding APIs.
  - `ContextualEmbeddingProvider` requires grouped document embedding, query embedding, and a context-aware cache suffix (`src/ts/process/memory/contextualEmbedding.ts:5`).
  - `isContextModel()` and `getContextProvider()` recognize `voyageContext3` and `voyageContext4` (`src/ts/process/memory/contextualEmbedding.ts:12`, `src/ts/process/memory/contextualEmbedding.ts:16`).
  - `VoyageContextProvider` calls Voyage’s contextualized-embeddings endpoint with `voyage-context-3` or `voyage-context-4` using `db.voyageApiKey` (`src/ts/process/memory/contextualEmbedding.ts:25`, `src/ts/process/memory/contextualEmbedding.ts:39`).
  - Document groups are batched at no more than 1,000 groups or 16,000 total chunks per request (`src/ts/process/memory/contextualEmbedding.ts:27`, `src/ts/process/memory/contextualEmbedding.ts:108`).
  - Context hashes are included only when a group contains more than one text (`src/ts/process/memory/contextualEmbedding.ts:101`).

- `src/ts/process/memory/taskRateLimiter.ts` — Queue used for embedding and experimental summarization requests.
  - `TaskRateLimiterOptions`, `BatchResult`, and `TaskResult` define limits and non-throwing task results (`src/ts/process/memory/taskRateLimiter.ts:1`, `src/ts/process/memory/taskRateLimiter.ts:7`, `src/ts/process/memory/taskRateLimiter.ts:14`).
  - `TaskRateLimiter` defaults to 20 tasks/minute, five concurrent tasks, and fail-fast cancellation (`src/ts/process/memory/taskRateLimiter.ts:20`, `src/ts/process/memory/taskRateLimiter.ts:31`).
  - `executeTask()`, `executeBatch()`, and `cancelPendingTasks()` manage the queue (`src/ts/process/memory/taskRateLimiter.ts:44`, `src/ts/process/memory/taskRateLimiter.ts:65`, `src/ts/process/memory/taskRateLimiter.ts:82`).
  - `TaskCanceledError` distinguishes canceled work from the request that caused the batch failure (`src/ts/process/memory/taskRateLimiter.ts:181`).

- `src/ts/process/memory/hypav3.ts` — Long-term history compression, summary retrieval, summarization-model dispatch, presets, and serialization.
  - `HypaV3Preset` and `HypaV3Settings` define summarization, token allocation, retrieval ratios, batching, and experimental-mode settings (`src/ts/process/memory/hypav3.ts:25`, `src/ts/process/memory/hypav3.ts:30`).
  - `SerializableHypaV3Data` and `SerializableSummary` are the persisted, array-based equivalents of runtime summary data that uses `Set<string>` chat memos (`src/ts/process/memory/hypav3.ts:74`, `src/ts/process/memory/hypav3.ts:86`).
  - `hypaMemoryV3()` selects the legacy or experimental implementation and unloads a local WebLLM summarization engine afterward (`src/ts/process/memory/hypav3.ts:119`).
  - `hypaMemoryV3MainExp()` batches summarization requests and uses `HypaProcessorV2` for similarity retrieval (`src/ts/process/memory/hypav3.ts:177`).
  - `hypaMemoryV3Main()` is the default sequential implementation and uses the internal `HypaProcesserEx` adapter (`src/ts/process/memory/hypav3.ts:957`, `src/ts/process/memory/hypav3.ts:1939`).
  - `summarize()` formats summary input, calls the configured auxiliary API model or a local WebLLM model, removes thought blocks, and rejects empty output (`src/ts/process/memory/hypav3.ts:1684`).
  - `getCurrentHypaV3Preset()` and `createHypaV3Preset()` select and normalize preset settings (`src/ts/process/memory/hypav3.ts:1791`, `src/ts/process/memory/hypav3.ts:1802`).

- `src/lib/Others/HypaV3Modal.svelte` — Inspect, search, categorize, mark, edit, and manually re-summarize persisted summaries. Search is limited to summaries visible under the active important/category filters and is invalidated when those filters change, so navigation never targets an unmounted result (`src/lib/Others/HypaV3Modal.svelte:101`, `src/lib/Others/HypaV3Modal.svelte:177`).

- `src/ts/process/embedding/addinfo.ts` — Retrieval-augments a character description from `character.additionalText`.
  - `additionalInformations(char, chats)` splits additional text into blank-line-separated passages, embeds them, queries with the first four stored chat messages, and returns the top three passages (`src/ts/process/embedding/addinfo.ts:5`).
  - This directory contains no other embedding backend; actual backend selection lives under `process/memory/` and `process/transformers.ts`.

### Module aggregation

- `src/ts/process/modules.ts` — Defines module packages, import/export, runtime scope resolution, and projection of active module content.
  - `RisuModule` can contain lorebooks, regexes, CommonJS text, triggers, assets, toggles, MCP metadata, display flags, and a namespace (`src/ts/process/modules.ts:19`).
  - `exportModule()` emits the modern character-card-based `.module`/CHARX representation; `exportModuleLegacy()` emits the legacy binary `.risum` format (`src/ts/process/modules.ts:37`, `src/ts/process/modules.ts:61`).
  - `readModule()` decodes legacy RPack metadata and assets, retries failed asset saves, and assigns a new module UUID (`src/ts/process/modules.ts:125`).
  - `importModule()` accepts CHARX, `.risum`, native module JSON, native lorebooks, external lorebooks, and regex packs (`src/ts/process/modules.ts:256`).
  - `getModules()` resolves the active module set from global, chat, character, persona, and integration references (`src/ts/process/modules.ts:404`).
  - `getModuleLorebooks()`, `getModuleAssets()`, `getModuleTriggers()`, `getModuleRegexScripts()`, `getModuleToggles()`, and `getModuleMcps()` flatten active module fields for consumers (`src/ts/process/modules.ts:436`, `src/ts/process/modules.ts:450`, `src/ts/process/modules.ts:465`, `src/ts/process/modules.ts:486`, `src/ts/process/modules.ts:500`, `src/ts/process/modules.ts:514`). `getModuleTriggers()` copies each trigger and annotates it with the containing module's `lowLevelAccess` and `moduleId`; it does not mutate the stored module.
  - `applyModule()` permanently copies a selected module’s lorebooks, regexes, and triggers into the current character (`src/ts/process/modules.ts:516`).
  - `moduleUpdate()` updates module-driven icon/background state and requests a GUI reload when active IDs change; `refreshModules()` invalidates the resolver cache (`src/ts/process/modules.ts:554`, `src/ts/process/modules.ts:587`).

### Important integration and storage files

- `src/ts/process/index.svelte.ts` — Main prompt pipeline; calls additional-text retrieval, lorebook matching, and Hypa V3 (`src/ts/process/index.svelte.ts:458`, `src/ts/process/index.svelte.ts:480`, `src/ts/process/index.svelte.ts:1040`).
- `src/ts/storage/database.svelte.ts` — Defines `loreBook`, `character.globalLore`, `Chat.localLore`, module references, memory settings, and `Chat.hypaV3Data` (`src/ts/storage/database.svelte.ts:1626`, `src/ts/storage/database.svelte.ts:1649`, `src/ts/storage/database.svelte.ts:2147`).
- `src/ts/process/transformers.ts` — Runs browser-local embedding models with mean pooling and normalization (`src/ts/process/transformers.ts:61`).
- `src/ts/storage/persistentKv.ts` — Stores hashed vector-cache JSON through `forageStorage`; reads/writes begin at `src/ts/storage/persistentKv.ts:41` and `:55`, and hashed-key construction is at `:75`.

## 3. Architecture & data flow

### Main prompt flow

1. Prompt construction first creates normal system material and the character description. `additionalInformations()` may append embedding-selected passages from `character.additionalText` to that description (`src/ts/process/index.svelte.ts:458`).

2. `loadLoreBookV3Prompt()` reads the selected character and current chat, then clones and concatenates:
   - `character.globalLore`,
   - `currentChat.localLore`,
   - `getModuleLorebooks()`.

   This combined ordering is explicit at `src/ts/process/lorebook.svelte.ts:74`.

3. Lore matching returns active entries with a resolved role, position, depth, ordering, token count, source label, and optional injection operation (`src/ts/process/lorebook.svelte.ts:232`). Token admission counts the side-effect-free CBS-evaluated content rather than raw `{{...}}` source (`src/ts/process/lorebook.svelte.ts:565`).

4. The prompt builder distributes those entries:
   - no position: `unformated.lorebook` (`src/ts/process/index.svelte.ts:453`);
   - `before_desc`, `after_desc`, `personality`, or `scenario`: description section (`src/ts/process/index.svelte.ts:465`);
   - depth zero: post-everything material (`src/ts/process/index.svelte.ts:505`);
   - positive `depth` or `reverse_depth`: inserted into chat history after history construction (`src/ts/process/index.svelte.ts:941`, `src/ts/process/index.svelte.ts:1025`);
   - `pt_*`: substituted through nested `{{position::<name>}}` placeholders (`src/ts/process/index.svelte.ts:424`);
   - non-lore injections: applied to matching prompt-template locations by `positionParser()` (`src/ts/process/index.svelte.ts:520`, `src/ts/process/index.svelte.ts:543`).

5. After chat messages and depth lore have been tokenized, Hypa V3 runs if the chat-level override or character default `supaMemory` is true and the global `db.hypaV3` flag is enabled (`src/ts/process/index.svelte.ts:1035`).

6. Hypa V3 returns a shortened chat array and serialized state. The caller writes the state back to the current chat’s `hypaV3Data`, including partial state returned with recoverable errors (`src/ts/process/index.svelte.ts:1040`).

7. A generated memory message has `memo: "supaMemory"`. Without a prompt template it remains among chats and is wrapped in `<Previous Conversation>`; with a template memory card it is extracted into the template’s memory slot (`src/ts/process/index.svelte.ts:1006`, `src/ts/process/index.svelte.ts:1270`).

### Lorebook matching

- Global matcher defaults come from per-character `loreSettings` and fall back to database-wide depth/token settings (`src/ts/process/lorebook.svelte.ts:83`). The relevant schema is at `src/ts/storage/database.svelte.ts:1693`.

- Normal key search scans the last `scanDepth` stored messages. It does not scan the character greeting because that is not in `Chat.message`, although activation timing treats chat length as `message.length + 1` (`src/ts/process/lorebook.svelte.ts:86`, `src/ts/process/lorebook.svelte.ts:107`).

- User and assistant messages are labeled for logs, while actual non-regex matching uses lowercased `msg.data`. Comment CBS forms are removed before matching (`src/ts/process/lorebook.svelte.ts:120`, `src/ts/process/lorebook.svelte.ts:173`).

- Partial-word matching removes ASCII spaces from both message and key and then uses substring matching. Full-word matching splits only on literal spaces and checks exact tokens (`src/ts/process/lorebook.svelte.ts:184`).

- Regex lore intends to accept `/pattern/flags`, but the current parser is defective: it retains the leading slash in the compiled pattern, does not execute an empty-flags form, and reuses `arg.keys[0]` while iterating multiple keys. Treat regex lore results as compatibility-bug behavior until this path is fixed (`src/ts/process/lorebook.svelte.ts:144`).

- The primary comma-separated key list forms one positive query. Selective secondary keys and every `additional_keys` decorator form additional positive queries, so they are AND requirements; exclusions are negative requirements (`src/ts/process/lorebook.svelte.ts:521`, `src/ts/process/lorebook.svelte.ts:533`).

- When recursion is enabled, activated lore content is appended to `recursivePrompt`; unmatched entries are scanned again and can activate from that content (`src/ts/process/lorebook.svelte.ts:586`). `no_recursive_search` prevents an individual entry from seeing recursive lore but does not disable that entry from activating further entries.

- An activated local `mode: "child"` entry can force its earlier character-level parent with the same `id`: it copies the parent label/content and becomes always active when the parent was not already activated (`src/ts/process/lorebook.svelte.ts:284`). The UI creates these child entries for “always active in this chat” (`src/lib/SideBars/LoreBook/LoreBookData.svelte:65`).

- Candidates are sorted by `priority` descending and greedily admitted under the lore token budget. They are then sorted by insertion order and returned in ascending effective order after the final reverse (`src/ts/process/lorebook.svelte.ts:603`, `src/ts/process/lorebook.svelte.ts:617`, `src/ts/process/lorebook.svelte.ts:656`).

### Decorator syntax and behavior

Lore content uses leading `@@name arguments` lines. The `CCardLib.decorator.parse()` call removes recognized leading decorators and returns the remaining content (`src/ts/process/lorebook.svelte.ts:299`); imported character-card fields are converted into forms such as `@@additional_keys value` and `@@activate_only_after 3` (`src/ts/characterCards.ts:1015`, `src/ts/characterCards.ts:1022`). Arguments are comma-separated by the dependency parser. `@@@fallback` lines run when the preceding decorator handler returned `false`; decorators must appear before the first ordinary content line.

Supported behavior in the matcher includes:

- Placement and role:
  - `@@end`
  - `@@depth N`
  - `@@reverse_depth N`
  - `@@role system|user|assistant`
  - `@@position pt_name|after_desc|before_desc|personality|scenario`
  - `@@scan_depth N`

  See `src/ts/process/lorebook.svelte.ts:300`, `src/ts/process/lorebook.svelte.ts:346`, `src/ts/process/lorebook.svelte.ts:362`, and `src/ts/process/lorebook.svelte.ts:369`.

- Activation constraints:
  - `@@activate_only_after N`
  - `@@activate_only_every N`
  - `@@is_greeting N`
  - `@@probability N`
  - `@@activate`
  - `@@dont_activate`

  See `src/ts/process/lorebook.svelte.ts:306`, `src/ts/process/lorebook.svelte.ts:316`, `src/ts/process/lorebook.svelte.ts:373`, and `src/ts/process/lorebook.svelte.ts:472`.

- Persistent match state:
  - `@@keep_activate_after_match`
  - `@@dont_activate_after_match`

  These store internal chat variables keyed by lore ID or a hash of its content (`src/ts/process/lorebook.svelte.ts:326`, `src/ts/process/lorebook.svelte.ts:578`).

- Query modifiers:
  - `@@additional_keys ...`
  - `@@exclude_keys ...`
  - `@@exclude_keys_all ...`
  - `@@match_full_word`
  - `@@match_partial_word`

  See `src/ts/process/lorebook.svelte.ts:438` and `src/ts/process/lorebook.svelte.ts:460`.

- Recursion:
  - `@@recursive`
  - `@@unrecursive`
  - `@@no_recursive_search`

  See `src/ts/process/lorebook.svelte.ts:497`.

- Injection:
  - `@@inject_lore <source comment>` targets another active lore entry.
  - `@@inject_at <prompt location>` targets a prompt-template location.
  - `@@inject_prepend`
  - `@@inject_replace <needle>`
  - default operation is append.

  See `src/ts/process/lorebook.svelte.ts:390` and `src/ts/process/lorebook.svelte.ts:401`.

- Budget/UI controls:
  - `@@priority N`
  - `@@ignore_on_max_context`
  - `@@disable_ui_prompt post_history_instructions|system_prompt`

  See `src/ts/process/lorebook.svelte.ts:434`, `src/ts/process/lorebook.svelte.ts:480`, and `src/ts/process/lorebook.svelte.ts:493`.

- `instruct_depth`, `reverse_instruct_depth`, `instruct_scan_depth`, and `is_user_icon` are deliberately unimplemented and return `false` to permit fallback syntax (`src/ts/process/lorebook.svelte.ts:356`, `src/ts/process/lorebook.svelte.ts:468`).

### Hypa V3 compression and retrieval

Both Hypa V3 implementations follow the same high-level algorithm:

1. Deserialize `room.hypaV3Data`; summary chat memo arrays become `Set`s (`src/ts/process/memory/hypav3.ts:201`, `src/ts/process/memory/hypav3.ts:1623`).

2. Unless `preserveOrphanedMemory` is enabled, discard summaries whose source message memos are no longer all present in the current chat array (`src/ts/process/memory/hypav3.ts:208`, `src/ts/process/memory/hypav3.ts:1649`).

3. Find the newest already summarized message and exclude all summarized history from the live token count (`src/ts/process/memory/hypav3.ts:213`).

4. Reserve `maxContextTokens * memoryTokensRatio` for recalled summaries. If history remains too large, consume oldest unsummarized messages in batches of at most `maxChatsPerSummary`, preserving at least `queryChatCount` recent messages (`src/ts/process/memory/hypav3.ts:235`, `src/ts/process/memory/hypav3.ts:254`).

5. Skip examples, `NewChat` markers, blank messages, and optionally user messages when constructing summary input (`src/ts/process/memory/hypav3.ts:295`).

6. Summarize through the configured auxiliary API model or local WebLLM model (`src/ts/process/memory/hypav3.ts:1711`, `src/ts/process/memory/hypav3.ts:1761`).

7. Fill the memory budget in this order:
   - all marked-important summaries that fit;
   - recent summaries using `recentMemoryRatio`;
   - embedding-ranked summaries using `similarMemoryRatio`;
   - randomly selected remaining summaries using the leftover ratio.

   The experimental implementation’s selection begins at `src/ts/process/memory/hypav3.ts:503`; semantic retrieval begins at `src/ts/process/memory/hypav3.ts:589`; random selection begins at `src/ts/process/memory/hypav3.ts:808`.

8. Sort selected summaries chronologically, wrap them in `<Past Events Summary>`, prepend that system message, and retain only unsummarized recent chats (`src/ts/process/memory/hypav3.ts:873`, `src/ts/process/memory/hypav3.ts:930`).

The two implementations differ in execution details:

- Default/legacy `hypaMemoryV3Main()` summarizes batches sequentially and uses `HypaProcesserEx`. It can summarize recent messages again as an extra semantic query when `enableSimilarityCorrection` is enabled (`src/ts/process/memory/hypav3.ts:1144`, `src/ts/process/memory/hypav3.ts:1374`).

- Experimental `hypaMemoryV3MainExp()` collects all required batches first, summarizes them through a configurable `TaskRateLimiter`, and uses `HypaProcessorV2` for batched, metadata-aware similarity retrieval (`src/ts/process/memory/hypav3.ts:382`, `src/ts/process/memory/hypav3.ts:630`).

### Hypa V3 inspection and repair

The modal edits the selected chat's serialized `hypaV3Data` directly. Manual single or bulk re-summarization calls exported `summarize(..., true)`, which selects `reSummarizationPrompt`; automatic compression continues to use the ordinary summarization prompt. Search operates only over currently rendered summaries, resets when important/category filters change, and guards missing textarea/memo refs before scrolling. Summary edits remain chat-owned state and persist through the normal chat-row save path.

### Embedding backend flow

- Local models call `runEmbedding()`, which loads a Transformers feature-extraction pipeline, mean-pools, and normalizes vectors. `GPU` model IDs select WebGPU; others use WASM (`src/ts/process/memory/hypamemory.ts:115`, `src/ts/process/transformers.ts:61`).

- `custom` calls an OpenAI-compatible `/embeddings` endpoint and optionally sends the configured bearer key and model (`src/ts/process/memory/hypamemory.ts:121`).

- `ada`, `openai3small`, and `openai3large` call the OpenAI embeddings API using `supaMemoryKey` unless an instance-specific key is set (`src/ts/process/memory/hypamemory.ts:142`).

- `voyageContext3` and `voyageContext4` use grouped contextual document embeddings and separate query embeddings (`src/ts/process/memory/hypamemory.ts:104`, `src/ts/process/memory/contextualEmbedding.ts:51`).

- Remote custom, OpenAI, and Voyage embedding calls go through `globalFetch()` with request-log category `embedding` and source `memory`; local Transformers embeddings do not create remote request-log entries.

- Vector cache entries live both in the module-level `hypaVectorCache` map and `forageStorage` under hashed `cache/hypa-vector/` keys. In PocketRisu, `forageStorage` resolves through `NodeStorage`, so this persistent tier is server-backed rather than browser-only (`src/ts/process/memory/hypamemory.ts:40`, `src/ts/storage/autoStorage.ts:26`). Hypa V3 summary text itself is persisted per chat in `Chat.hypaV3Data` (`src/ts/storage/database.svelte.ts:2167`).

### Module scoping and content projection

`getModules()` merges module references from several scopes (`src/ts/process/modules.ts:404`):

- Global/application scope: `db.enabledModules` (`src/ts/process/modules.ts:409`).
- Per-chat scope: `currentChat.modules` (`src/ts/process/modules.ts:410`).
- Per-character scope: `character.modules` (`src/ts/process/modules.ts:413`).
- Persona embedded-module ID: appended when a bound persona has an embedded module (`src/ts/process/modules.ts:416`).
- Global integration string: comma-separated IDs or namespaces from `db.moduleIntergration` (`src/ts/process/modules.ts:419`).

Resolution filters `db.modules` by ID or namespace and deduplicates by module ID (`src/ts/process/modules.ts:380`). Active module ordering follows `db.modules` order, not the order of scope references.

Each projection is consumed independently:

- lorebooks join the normal lore activation pool (`src/ts/process/lorebook.svelte.ts:80`);
- regexes join preset and character scripts (`src/ts/process/scripts.ts:134`);
- triggers join character triggers (`src/ts/process/triggers.ts:1062`);
- assets are exposed to parser/chat rendering;
- toggles are appended to custom prompt-toggle syntax;
- MCP URLs are consumed by the MCP subsystem.

`applyModule()` is different from enabling a scoped module: it clones and permanently copies only lorebook, regex, and trigger content into the character (`src/ts/process/modules.ts:516`).

## 4. Entry points & dependencies

### Incoming calls

- Main prompt construction calls:
  - `additionalInformations()` at `src/ts/process/index.svelte.ts:458`;
  - `loadLoreBookV3Prompt()` at `src/ts/process/index.svelte.ts:480`;
  - `hypaMemoryV3()` at `src/ts/process/index.svelte.ts:1040`.

- Low-level scripting can request the fully matched lorebook list through `loadLoreBooksMain` (`src/ts/process/scriptings.ts:789`).

- The `test_lorebook` command runs the matcher and displays/returns its active list and match log (`src/ts/process/command.ts:214`).

- Developer tooling calls `loadLoreBookV3Prompt()` to inspect current activation (`src/lib/SideBars/DevTool.svelte:272`).

- The Hypa V3 modal calls exported `summarize(..., true)` for manual re-summarization and confines search navigation to summaries visible under its active filters (`src/lib/Others/HypaV3Modal.svelte:243`).

- Module getters are called by prompt parsing, regex processing, triggers, scripts, UI asset rendering, prompt toggles, and MCP initialization.

### Outgoing dependencies

- Lorebooks depend on:
  - Svelte/DB selection state;
  - chat variables for persistent activation;
  - `CCardLib.decorator.parse()` for syntax;
  - tokenizer accounting;
  - module aggregation;
  - CBS parsing later in the prompt pipeline.

- Hypa V3 depends on:
  - prompt `OpenAIChat` memo IDs;
  - the selected tokenizer;
  - auxiliary request routing via `requestChatData(..., "memory")`;
  - WebLLM for local summarization;
  - embedding processors and persistent vector storage;
  - `resolveChatMaxResponseTokens()` to undo the caller’s output-token reservation.

- Embeddings depend on:
  - browser Transformers for local models;
  - `globalFetch` for OpenAI-compatible and Voyage APIs;
  - database credentials/settings;
  - `forageStorage`, which is backed by `NodeStorage` in PocketRisu's self-hosted runtime.

- Modules depend on:
  - character-card conversion for modern export/import;
  - RPack for legacy archives;
  - asset storage and image compression;
  - current character/chat/persona selection.

## 5. Conventions & gotchas

- “Global lore” is overloaded:
  - `character.globalLore` is character-scoped lore and is read by the matcher.
  - `db.loreBook` is the application’s global lorebook-preset collection (`src/ts/storage/database.svelte.ts:978`), but `loadLoreBookV3Prompt()` does not read it directly.
  - Module lore is dynamically appended after character and chat lore.

- The global-lore UI helper path appears inconsistent. `LoreBookSetting.svelte` passes `-1`/`"sglobal"` (`src/lib/SideBars/LoreBook/LoreBookSetting.svelte:115`), but:
  - `addLorebook(-1)` and `addLorebookFolder(-1)` take the chat-local branch;
  - import/export `"sglobal"` computes chat page `-1` and then accesses `chats[-1].localLore`.

  Treat this as a likely existing bug before modifying global lore import/export.

- `alwaysActive` bypasses key search, but it does not bypass activation decorators already setting `activated = false`, such as timing, greeting, or probability conditions (`src/ts/process/lorebook.svelte.ts:517`).

- Recursive matching operates on decorator-stripped but otherwise unparsed lore content. CBS expansion happens later in the main prompt builder.

- `additional_keys` is not an OR extension to the primary key list. It creates another required positive query, making activation stricter (`src/ts/process/lorebook.svelte.ts:438`, `src/ts/process/lorebook.svelte.ts:533`).

- `exclude_keys_all` uses the matcher’s `all` mode. Its flag is not reset per scanned message, so current behavior can be stricter than “all keys somewhere in the scan window” (`src/ts/process/lorebook.svelte.ts:181`).

- Full-word matching is space-token based and does not strip punctuation. Partial matching strips only ordinary spaces, not all whitespace (`src/ts/process/lorebook.svelte.ts:186`).

- Regex lore parsing currently mishandles its slash-delimited syntax: the compiled pattern keeps the opening slash, an empty flag suffix skips execution, and multiple keys can compile the first key repeatedly. Invalid expressions also return no match rather than surfacing an error (`src/ts/process/lorebook.svelte.ts:144`).

- `matchLog` records individual query matches immediately, even if another positive query or a later exclusion prevents the lore entry from activating. It is diagnostic evidence, not an active-entry list.

- `disable_ui_prompt` records a value in `disabledUIPrompts`, but that array is neither returned nor consumed in this function, so the decorator is currently inert (`src/ts/process/lorebook.svelte.ts:249`, `src/ts/process/lorebook.svelte.ts:480`, `src/ts/process/lorebook.svelte.ts:656`).

- The `keepActivateAfterMatch` and `dontActivateAfterMatch` booleans are declared outside the per-entry loop and are not reset for each lore item (`src/ts/process/lorebook.svelte.ts:251`). Once set during a scan, subsequent activated entries may also write internal persistence variables.

- Lore token budgeting applies side-effect-free CBS parsing before tokenization, matching the later output path for ordinary variables and conditions. The returned prompt retains its decorator-stripped source for later parsing, and lore-to-lore injection still occurs after budgeting, so injection can make the actual prompt larger than the admitted count (`src/ts/process/lorebook.svelte.ts:565`, `src/ts/process/lorebook.svelte.ts:635`).

- `@@inject_lore` targets the active entry’s `source`, which is its `comment` or fallback `lorebook N`. Changing comments can break injections (`src/ts/process/lorebook.svelte.ts:573`, `src/ts/process/lorebook.svelte.ts:634`).

- `loreBook.extentions.risu_case_sensitive` exists in the schema, but the matcher lowercases normal searches and does not consult it (`src/ts/storage/database.svelte.ts:1522`, `src/ts/process/lorebook.svelte.ts:173`).

- Legacy `activationPercent` is migrated into an `@@probability` decorator when characters are normalized (`src/ts/characters.ts:625`). The runtime matcher does not directly read `activationPercent`.

- External lorebook conversion is intentionally lossy: it does not preserve every external extension, case sensitivity, prefix/suffix, or context configuration field (`src/ts/process/lorebook.svelte.ts:722`).

- `additionalInformations()` always runs when `character.additionalText` is nonempty and queries with `chats.message.slice(0, 4)`, i.e. the first four stored messages rather than the most recent four (`src/ts/process/embedding/addinfo.ts:9`, `src/ts/process/embedding/addinfo.ts:14`).

- Hypa V3 enablement has three layers:
  - global algorithm flag `db.hypaV3`;
  - per-chat `Chat.supaMemory`, falling back to character `character.supaMemory`;
  - preset `alwaysToggleOn`, which writes `true` into the selected chat when character selection changes (`src/ts/process/index.svelte.ts:1035`, `src/ts/stores.svelte.ts:236`).

  `memoryAlgorithmType` is maintained by settings UI but is not what the prompt pipeline checks (`src/lib/Setting/Pages/OtherBotSettings.svelte:981`).

- Summary ownership is per chat, not per character or global. Copying or branching a chat without handling `hypaV3Data` also copies or loses its long-term-memory state.

- Summary linkage depends on stable `OpenAIChat.memo` values. The main pipeline uses message chat IDs as memos (`src/ts/process/index.svelte.ts:924`); orphan cleanup removes summaries when any recorded memo disappears.

- `reSummarizationPrompt` is used only when callers explicitly invoke `summarize(..., true)`, such as the modal. Automatic compression does not re-summarize existing summaries.

- `processRegexScript` is a Hypa preset field, but core compression does not apply it. It controls modal display/reroll processing outside this subsystem.

- Experimental Hypa V3 does not apply the legacy `enableSimilarityCorrection` path. That extra summarized-query correction exists only in `hypaMemoryV3Main()` (`src/ts/process/memory/hypav3.ts:1374`).

- The legacy and experimental Hypa implementations are not merely performance variants: they differ in similarity calculation, batching/rate limiting, metadata grouping, and correction behavior. Validate both modes when changing recall semantics.

- The first-generation `similarity()` is a dot product. Local Transformers embeddings are normalized, but custom/API backend correctness assumes their returned vectors are comparably normalized (`src/ts/process/memory/hypamemory.ts:259`, `src/ts/process/transformers.ts:82`). V2 avoids this assumption by calculating cosine similarity.

- Persistent cache keys include content, selected model, custom model name, and contextual hashes where applicable. They do not generally include the custom endpoint URL or API key, so changing servers without changing the configured model name can reuse old vectors (`src/ts/process/memory/hypamemoryv2.ts:365`).

- Module scope is additive; there is no per-chat override that disables a globally enabled module. The chat-module UI prevents selecting a module already enabled globally (`src/lib/Setting/Pages/Module/ModuleChatMenu.svelte:63`).

- `getModuleByIds()` resolves only objects in `db.modules` (`src/ts/process/modules.ts:380`). Although `getModules()` appends a persona embedded-module ID, the embedded object itself is not directly added to the resolver input; verify this path before relying on persona-only embedded modules.

- Modern module export produces `<name>.module.charx` through the character-card writer. Conversion is lossy for module-only data such as MCP metadata, namespace, CommonJS, toggles, and display settings; use legacy `.risum` when those fields must round-trip.

- Lore `mode` has special runtime handling only for `child`; other values primarily serve UI/compatibility organization and should not be assumed to create additional matcher modes.

- Module trigger projection returns copied triggers with the containing module's `lowLevelAccess` and `moduleId`. The `moduleId` lets direct module-originated LLM calls resolve a per-module ModelPreset, while stored/exported trigger objects remain unchanged (`src/ts/process/modules.ts:465`).

- `getModules()` caches on the joined reference IDs. Use `refreshModules()` when replacing module collections or changing resolution metadata such as namespace (`src/ts/process/modules.ts:402`, `src/ts/process/modules.ts:587`).

## 6. Navigation hints

- To change which lore sources participate in matching, start at the concatenation in `src/ts/process/lorebook.svelte.ts:74`.

- To change key, regex, selective, exclusion, or recursive matching, inspect `searchMatch()` and query evaluation at `src/ts/process/lorebook.svelte.ts:99` and `src/ts/process/lorebook.svelte.ts:517`.

- To add or modify a lore decorator, update the `CCardLib.decorator.parse()` switch at `src/ts/process/lorebook.svelte.ts:299`; also update editor highlighting in `src/ts/gui/highlight.ts:169` and relevant character-card conversion in `src/ts/characterCards.ts:995`.

- To change lore priority or token-budget behavior, inspect CBS-aware counting at `src/ts/process/lorebook.svelte.ts:565` and candidate admission at `src/ts/process/lorebook.svelte.ts:608`.

- To change lore prompt positions, edit both decorator validation at `src/ts/process/lorebook.svelte.ts:383` and prompt placement in `src/ts/process/index.svelte.ts:424`, `src/ts/process/index.svelte.ts:453`, and `src/ts/process/index.svelte.ts:941`.

- To change lore-to-lore or prompt-location injection, inspect `src/ts/process/lorebook.svelte.ts:390`, `src/ts/process/lorebook.svelte.ts:622`, and `src/ts/process/index.svelte.ts:520`.

- To change per-chat “always active” child lore behavior, inspect `src/lib/SideBars/LoreBook/LoreBookData.svelte:65` and `src/ts/process/lorebook.svelte.ts:284`.

- To add an embedding model identifier, update `HypaModel` and `localModels` in `src/ts/process/memory/hypamemory.ts:9`; add nonstandard provider routing in `HypaProcesser.getEmbeds()` at `src/ts/process/memory/hypamemory.ts:104` and V2’s `getAPIEmbeds()` at `src/ts/process/memory/hypamemoryv2.ts:422`.

- To add another contextual embedding provider, implement `ContextualEmbeddingProvider` and extend `isContextModel()`/`getContextProvider()` at `src/ts/process/memory/contextualEmbedding.ts:5`.

- To change embedding cache identity or persistence, inspect `src/ts/process/memory/hypamemory.ts:43`, `src/ts/process/memory/hypamemoryv2.ts:365`, and `src/ts/storage/persistentKv.ts:41-77`.

- To change when history gets summarized, modify token reservation and batch selection in `src/ts/process/memory/hypav3.ts:235` for experimental mode and `src/ts/process/memory/hypav3.ts:1015` for default mode.

- To change summary prompting or model routing, inspect `summarize()` at `src/ts/process/memory/hypav3.ts:1684`.

- To change Hypa V3 modal search/filter coupling or manual repair behavior, inspect `src/lib/Others/HypaV3Modal.svelte` and keep edits on the selected chat's `hypaV3Data`.

- To change important/recent/similar/random recall allocation, inspect selection beginning at `src/ts/process/memory/hypav3.ts:503` and the preset defaults at `src/ts/process/memory/hypav3.ts:1802`.

- To change semantic summary ranking, inspect experimental aggregation at `src/ts/process/memory/hypav3.ts:678` and legacy aggregation at `src/ts/process/memory/hypav3.ts:1366`.

- To change long-term-memory persistence format, update the types at `src/ts/process/memory/hypav3.ts:54` and serializers at `src/ts/process/memory/hypav3.ts:1623`, together with `Chat.hypaV3Data` at `src/ts/storage/database.svelte.ts:2167`.

- To change how memory appears in prompt templates, inspect memory extraction at `src/ts/process/index.svelte.ts:997` and template insertion at `src/ts/process/index.svelte.ts:1270`.

- To change module scope or precedence, inspect `getModules()` and `getModuleByIds()` at `src/ts/process/modules.ts:380` and `src/ts/process/modules.ts:404`.

- To add a new module-bundled content type, extend `RisuModule` at `src/ts/process/modules.ts:19`, provide a projection near `src/ts/process/modules.ts:436`, and wire its consumer explicitly.

- To change permanent module application, inspect `applyModule()` at `src/ts/process/modules.ts:516`; it currently excludes assets, toggles, MCP metadata, CommonJS, and display settings.

## 7. Related structure docs

- [Chat pipeline](chat-pipeline.md) covers prompt insertion and token budgeting around lore and memory.
- [Scripting and extensions](scripting-extensions.md) covers module regex, trigger, and MCP consumers.
- [Characters and personas](characters-personas.md) covers character-card conversion and interchangeability.
- [UI layer](ui-layer.md) covers the Hypa V3 modal and lorebook editing surfaces.
