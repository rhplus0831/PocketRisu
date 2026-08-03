# Chat pipeline

> Part of the PocketRisu structure docs — see [STRUCTURE.md](../../STRUCTURE.md) for the top-level map and subsystem index.
> Audited 2026-08-04 against `95c2ea30`. Paths and symbols are authoritative; line-number hints are approximate and should be verified with `rg`.

## 1. Purpose & overview

The chat pipeline owns the browser-side path from composing a message through prompt construction, context budgeting, model dispatch, streamed rendering, response post-processing, and mutation of the active chat. Its central orchestrator is `sendChat()` in `src/ts/process/index.svelte.ts`; provider-specific request construction begins only after its handoff to `requestChatData()`.

The subsystem also contains prompt-card types and preset conversion, legacy text serializers, example-dialogue parsing, slash commands, attachment/inlay storage, tokenizer selection, and automatic reply suggestions. Lorebook, memory, trigger, regex/Lua script, translation, model-request, and persistence subsystems hook into this flow but are implemented elsewhere.

## 2. Key files

- `src/ts/process/index.svelte.ts` — the main send/generation state machine.
  - Defines the provider-neutral `OpenAIChat` and `MultiModal` request-message shapes at `src/ts/process/index.svelte.ts:31` and `src/ts/process/index.svelte.ts:43`.
  - Re-exports the compatibility stores `doingChat` and `chatProcessStage` from `generationState.ts` at `src/ts/process/index.svelte.ts:61`.
  - Exposes preview/debug state plus `lastActualInputTokens` at `src/ts/process/index.svelte.ts:63`. The developer sidebar displays this most recent final-prompt count alongside broader character/chat estimates.
  - `sendChat()` begins at `src/ts/process/index.svelte.ts:68`.
  - `systemizeChat()` converts user/assistant history into system messages for compatible prompt templates at `src/ts/process/index.svelte.ts:2123`.

- `src/ts/process/generationState.ts` — authoritative per-chat generation lifecycle.
  - `generationStates` maps real `Chat.id` values to live or background generations at `src/ts/process/generationState.ts:27`.
  - `chatGenKey()`, `startGeneration()`, and `endGeneration()` implement the per-chat guard and keep legacy global stores synchronized.
  - `registerAbort()` and `abortGeneration()` connect the current chat's Stop action to either a live request or a reattached server job.

- `src/ts/process/request/pendingSends.ts` — resumable-send tombstones for the server-side request path.
  - `registerPendingSend()` and `clearPendingSend()` bracket a send without storing pipeline state.
  - `claimPendingSend()` atomically consumes a tombstone before an interrupted send is re-run.
  - `resumableSends` carries discovery results to `DefaultChatScreen.svelte`.

- `src/ts/process/request/request.ts` — provider-neutral request boundary, retry/fallback policy, ModelPreset dispatch, plugin replacers, and request-trigger execution.

- `src/lib/ChatScreens/DefaultChatScreen.svelte` — primary UI entry point.
  - `send()` and `sendContinue()` select ordinary versus continuation generation at `src/lib/ChatScreens/DefaultChatScreen.svelte:354`.
  - `sendMain()` processes commands, attachments, input triggers, and `editinput` scripts before inserting the user message at `src/lib/ChatScreens/DefaultChatScreen.svelte:358`.
  - `reroll()` removes the previous generated turn, regenerates it, and records swipe alternatives at `src/lib/ChatScreens/DefaultChatScreen.svelte:492`.
  - `sendChatMain()` registers the current chat's `AbortController`, calls `sendChat()`, and concludes that chat's generation/tombstone at `src/lib/ChatScreens/DefaultChatScreen.svelte:587`.
  - `resumeInterruptedSend()` atomically claims an aged pending-send tombstone and re-runs only a still-user-tailed chat at `src/lib/ChatScreens/DefaultChatScreen.svelte:640`.
  - `abortChat()` stops only the selected chat's live or background generation at `src/lib/ChatScreens/DefaultChatScreen.svelte:679`.
  - The composer dispatches Enter and send-button actions around `src/lib/ChatScreens/DefaultChatScreen.svelte:1128` and `src/lib/ChatScreens/DefaultChatScreen.svelte:1200`.
  - File attachment results are inserted into the composer around `src/lib/ChatScreens/DefaultChatScreen.svelte:1063`.

- `src/lib/ChatScreens/Suggestion.svelte` — automatic user-reply suggestions.
  - Subscribes to `doingChat` and starts suggestion generation when the main generation becomes idle at `src/lib/ChatScreens/Suggestion.svelte:42`.
  - Builds a small prompt from the last ten messages at `src/lib/ChatScreens/Suggestion.svelte:49`.
  - Calls `requestChatData(..., 'submodel')` directly at `src/lib/ChatScreens/Suggestion.svelte:84`.
  - Persists parsed `- item` lines to `Chat.suggestMessages` at `src/lib/ChatScreens/Suggestion.svelte:89`.
  - Selecting a suggestion writes it into the main composer and optionally sends it at `src/lib/ChatScreens/Suggestion.svelte:157`.

- `src/ts/process/prompt.ts` — prompt-card types, token estimates, and external preset conversion.
  - `PromptItem`, its card variants, and `PromptSettings` are defined at `src/ts/process/prompt.ts:7`.
  - `tokenizePreset()` estimates static prompt-template cost at `src/ts/process/prompt.ts:64`.
  - `detectPromptJSONType()` recognizes SillyTavern chat/context/instruct and parameter JSON at `src/ts/process/prompt.ts:89`.
  - `stChatConvert()` maps SillyTavern prompt ordering into PocketRisu prompt cards at `src/ts/process/prompt.ts:142`.
  - `OobaParams` lists transferable text-generation-webui parameters at `src/ts/process/prompt.ts:241`.
  - `promptConvertion()` creates and installs a PocketRisu bot preset from uploaded JSON files at `src/ts/process/prompt.ts:277`.

- `src/ts/tokenizer.ts` — model-aware encoding and chat-message budgeting.
  - `encodeWithTokenizer()` explicitly selects a tokenizer implementation at `src/ts/tokenizer.ts:46`.
  - `encode()` selects based on the active model, custom tokenizer, or plugin provider and maintains an LRU result cache at `src/ts/tokenizer.ts:73`.
  - `tokenizeAccurate()` expands prompt placeholders before counting them at `src/ts/tokenizer.ts:359`.
  - `ChatTokenizer` accounts for message framing, optional names, multimodals, and optionally thoughts at `src/ts/tokenizer.ts:369`.
  - `tokenizeNum()` returns token IDs for logit-bias construction at `src/ts/tokenizer.ts:446`.
  - `strongBan()` creates and persistently caches expanded token bans at `src/ts/tokenizer.ts:467`.
  - `getCharToken()` and `getChatToken()` provide UI/statistics estimates at `src/ts/tokenizer.ts:527` and `src/ts/tokenizer.ts:559`.
  - `tikParsers` and `tokenizersByType` are keyed promise caches, so concurrent counts for different tokenizer families do not replace or free one another's active parser (`src/ts/tokenizer.ts:186`). Failed loads are evicted for retry.

- `src/ts/process/exampleMessages.ts` — character-card example dialogue parser.
  - `exampleMessage()` parses `<START>`, `{{user}}:`, `{{char}}:`, `<user>:`, and `<bot>:` records into `OpenAIChat[]` at `src/ts/process/exampleMessages.ts:5`.

- `src/ts/process/stringlize.ts` — legacy/instruct text serialization and response trimming.
  - `stringlizeChat()` is a simple named transcript serializer at `src/ts/process/stringlize.ts:5`.
  - `stringlizeChatOba()` applies text-generation-webui prefixes and separators at `src/ts/process/stringlize.ts:38`.
  - `getStopStrings()` creates common user-turn stop sequences at `src/ts/process/stringlize.ts:100`.
  - `unstringlizeChat()` truncates generated text at the first detected speaker/system marker at `src/ts/process/stringlize.ts:132`.
  - `stringlizeAINChat()` and `unstringlizeAIN()` implement Japanese quote-oriented AIN formatting at `src/ts/process/stringlize.ts:208` and `src/ts/process/stringlize.ts:288`.

- `src/ts/process/command.ts` — slash-command preprocessing.
  - `processMultiCommand()` splits unquoted `|` pipelines and passes each result to the next command at `src/ts/process/command.ts:11`.
  - `processCommand()` implements STScript-compatible commands, chat mutation, manual triggers, and `/multisend` at `src/ts/process/command.ts:42`.
  - `commandParser()` resolves positional arguments, `key=value` arguments, `{{pipe}}`, and `{{slot}}` at `src/ts/process/command.ts:297`.

- `src/ts/process/infunctions.ts` — expression evaluator used by the chat parser.
  - `calcString()` resolves parentheses and evaluates arithmetic, comparison, boolean, chat-variable (`$name`), and global-variable (`@name`) expressions at `src/ts/process/infunctions.ts:143`.

- `src/ts/process/files/multisend.ts` — composer-side file ingestion.
  - `postChatFile()` opens the file picker or consumes supplied bytes, dispatching by extension at `src/ts/process/files/multisend.ts:194`.
  - Images, audio, and video are stored as inlay assets at `src/ts/process/files/multisend.ts:270`.
  - Text files are similarity-searched and embedded in a base64 `{{file::...}}` placeholder at `src/ts/process/files/multisend.ts:299`.
  - PO-file translation repeatedly invokes `sendChat()` through `sendPofile()` at `src/ts/process/files/multisend.ts:15`.

- `src/ts/process/files/inlays.ts` — durable multimodal asset storage and lookup.
  - `InlayAsset` and explorer-facing types are defined at `src/ts/process/files/inlays.ts:16`.
  - Assets use `NodeStorage` keys under `inlay/`, lightweight info under `inlay_info/`, and a device-sized memory LRU at `src/ts/process/files/inlays.ts:76`.
  - `postInlayAsset()` classifies and stores image/audio/video bytes at `src/ts/process/files/inlays.ts:412`.
  - `writeInlayImage()` downsizes images to at most 1,048,576 pixels and stores PNG or WebP according to settings at `src/ts/process/files/inlays.ts:438`.
  - `getInlayAsset()` returns a base64 data URI for request/display use at `src/ts/process/files/inlays.ts:490`.
  - `setInlayAsset()` updates the body, explorer info, and metadata stores sequentially at `src/ts/process/files/inlays.ts:600`; callers must tolerate or repair a partial multi-record write.
  - `scanInlayReferences()` counts placeholder references across chat messages at `src/ts/process/files/inlays.ts:670`.
  - `supportsInlayImage()` checks the active model’s image-input flag at `src/ts/process/files/inlays.ts:697`.

- `src/ts/process/files/inlayMeta.ts` — inlay ownership/timestamp metadata.
  - `InlayAssetMeta` is defined at `src/ts/process/files/inlayMeta.ts:6`.
  - Batch and single-item metadata APIs begin at `src/ts/process/files/inlayMeta.ts:86`.
  - `buildInlayMeta()` associates a new asset with the active character and chat while preserving original creation/ownership fields on overwrite at `src/ts/process/files/inlayMeta.ts:106`.

- `src/ts/process/files/tests/inlays.test.ts` — storage, conversion, resizing, explorer, and round-trip coverage.
  - Core storage tests start at `src/ts/process/files/tests/inlays.test.ts:141`.
  - Image-resize and pixel-limit tests start at `src/ts/process/files/tests/inlays.test.ts:497`.
  - Set/get and set/remove round-trip tests start at `src/ts/process/files/tests/inlays.test.ts:610`.

- `src/ts/process/inlayScreen.ts` — generated response commands for emotion and image modes.
  - `runInlayScreen()` converts `<Emotion>` commands or asynchronously turns `<ImgGen>` commands into stored inlay images at `src/ts/process/inlayScreen.ts:7`.
  - `updateInlayScreen()` supplies the corresponding model instructions at `src/ts/process/inlayScreen.ts:52`.

- `src/ts/process/dynamicutils/pdf.ts` — generic PDF rendering/text extraction.
  - `convertPdfToImages()` renders each page to a data URI at `src/ts/process/dynamicutils/pdf.ts:6`.
  - `extractPdfText()` returns individual PDF text items at `src/ts/process/dynamicutils/pdf.ts:45`.

- `src/ts/process/templates/chatTemplate.ts` — model-native Jinja chat templates.
  - `chatTemplates` contains Llama, ChatML, Gemma, Mistral, Vicuna, and Alpaca templates at `src/ts/process/templates/chatTemplate.ts:6`.
  - `templateEffect` declares templates that reject system roles or require strict alternation at `src/ts/process/templates/chatTemplate.ts:17`.
  - `applyChatTemplate()` normalizes roles and renders the chosen Hugging Face Jinja template at `src/ts/process/templates/chatTemplate.ts:27`.

- `src/ts/process/templates/jsonSchema.ts` — structured-output schema conversion.
  - `convertInterfaceToSchema()` converts a restricted TypeScript-interface syntax or parses raw JSON Schema at `src/ts/process/templates/jsonSchema.ts:5`.
  - Provider wrappers are built by `getOpenAIJSONSchema()` and `getGeneralJSONSchema()` at `src/ts/process/templates/jsonSchema.ts:124`.
  - `extractJSON()` trims JSON output and extracts a configured dotted field at `src/ts/process/templates/jsonSchema.ts:153`.

- `src/ts/process/templates/templateCheck.ts` — prompt-card validation.
  - `templateCheck()` warns about missing/duplicate main prompts, notes, descriptions, lorebooks, and disconnected chat ranges at `src/ts/process/templates/templateCheck.ts:3`.

- `src/ts/process/templates/templates.ts` — built-in bot presets.
  - `prebuiltPresets` begins with the NovelAI preset at `src/ts/process/templates/templates.ts:5`, the legacy OAI defaults at `src/ts/process/templates/templates.ts:156`, and the current `OAI2` preset at `src/ts/process/templates/templates.ts:223`.
  - `prebuiltNAIpresets` contains default NovelAI sampler settings at `src/ts/process/templates/templates.ts:416`.

## 3. Architecture & data flow

### Normal UI send

1. The composer invokes `send()` from Enter or the send button, which delegates to `sendMain(false)` (`src/lib/ChatScreens/DefaultChatScreen.svelte:351-358`).

2. `sendMain()` refuses while the global `chatOperationActive` view sees any live generation or input transaction, then captures a stable character/chat target and hydrates it before mutation (`src/lib/ChatScreens/DefaultChatScreen.svelte:358`). The standard composer therefore remains single-live-send even though the lower generation guard is keyed per chat.

3. Inputs beginning with `/` are routed through `processMultiCommand()` before any user message is added (`src/lib/ChatScreens/DefaultChatScreen.svelte:381`).

4. Pending attachment IDs are appended as `{{inlayed::id}}` placeholders (`src/lib/ChatScreens/DefaultChatScreen.svelte:394`).

5. For a character chat, the UI acquires a target-bound send transaction, the `input` trigger runs first, followed by `processScript(..., 'editinput')`; the processed user message is then pushed into `Chat.message`. The transaction survives asynchronous input handlers and authorizes only its exact target/token, so a V3 handler can await a sequential child turn without allowing an unrelated caller to borrow the send (`src/lib/ChatScreens/DefaultChatScreen.svelte`, `src/ts/process/chatSendState.ts`).

6. `sendChatMain()` derives the target's `chatGenKey()`, registers an `AbortController`, and calls `sendChat(-1, {signal, continue, target, transaction})` (`src/lib/ChatScreens/DefaultChatScreen.svelte:587`).

7. `sendChat()` validates the transaction and target before side effects, rejects only when that chat is already in `generationStates`, mints a generation UUID, and calls `startGeneration()` under the real `Chat.id` (`src/ts/process/index.svelte.ts:184-219`). It then optionally selects from `presetChain`, resolves the stable target, rejects placeholders, and ensures every stored message has a UUID `chatId`.

8. When server-side ModelPreset requests are enabled, `sendChat()` also registers a pending-send tombstone before prompt work. The UI wrapper always calls `endGeneration()` and `clearPendingSend()` after success, failure, or abort (`src/lib/ChatScreens/DefaultChatScreen.svelte:607-618`). `doingChat` remains a compatibility view meaning “any live generation”; background recovery entries deliberately do not set it.

### Prompt assembly

`sendChat()` first selects context/output budgets. Classic chats use `db.maxContext` and `db.maxResponse`; a bound ModelPreset instead uses its own `maxContext`, clamps it to the profile’s known context window, and reserves its resolved output limit (`src/ts/process/index.svelte.ts:309-331`).

Prompt material is accumulated into ten named buckets at `src/ts/process/index.svelte.ts:338`:

| Bucket | Principal source/hook |
|---|---|
| `main` | Legacy `mainPrompt` or character `systemPrompt`, when no prompt-card template is active (`src/ts/process/index.svelte.ts:399`) |
| `jailbreak` | Global jailbreak when enabled and no prompt-card template is active (`src/ts/process/index.svelte.ts:429`) |
| `globalNote` | Legacy global note material kept distinct from per-chat author notes when no prompt-card template is active |
| `description` | Character description, embedding `additionalInformations()`, personality, and scenario (`src/ts/process/index.svelte.ts:456`) |
| `personaPrompt` | Active persona prompt (`src/ts/process/index.svelte.ts:557`) |
| `authorNote` | Per-chat note or default author note (`src/ts/process/index.svelte.ts:438`) |
| `lorebook` | Normal active lore entries from `loadLoreBookV3Prompt()` (`src/ts/process/index.svelte.ts:480`, `src/ts/process/index.svelte.ts:522`) |
| `postEverything` | Chain-of-thought instruction, inlay-screen instruction, and depth-zero lore (`src/ts/process/index.svelte.ts:450`, `src/ts/process/index.svelte.ts:565`, `src/ts/process/index.svelte.ts:580`) |
| `chats` / `lastChat` | Example dialogue, greeting, and processed stored history (`src/ts/process/index.svelte.ts:813`, `src/ts/process/index.svelte.ts:845`, `src/ts/process/index.svelte.ts:883`) |

The `role2` field on persona, description, author-note, and memory cards can override the materialized prompt role. For description cards, only the base character-description block is overridden; positioned before/after-description lore keeps its own lore role (`applyPromptBlockRole()` and `getDescriptionPrompts()`).

Supa/Hypa memory handling is conditional on the template. When a memory card is present, memory-tagged messages are removed from ordinary history and materialized at that card. Without a memory card, they remain in history wrapped in `<Previous Conversation>` rather than disappearing (`src/ts/process/index.svelte.ts:1082-1106`, `src/ts/process/index.svelte.ts:1350`).

Lorebook-specific injection points are handled without implementing lore selection here:

- `{{position::name}}` recursively expands matching positioned lore, with a maximum depth of five (`src/ts/process/index.svelte.ts:424`).
- Before/after-description, personality, and scenario entries are placed into the description bucket (`src/ts/process/index.svelte.ts:465`).
- Depth-zero lore enters `postEverything`; deeper and reverse-depth lore is spliced into history later (`src/ts/process/index.svelte.ts:505`, `src/ts/process/index.svelte.ts:941`, `src/ts/process/index.svelte.ts:1025`).
- Lore injection operations can append, prepend, or replace text in named prompt-card locations (`src/ts/process/index.svelte.ts:520`, `src/ts/process/index.svelte.ts:543`).
- Lore cutoff cost is calculated from the CBS-evaluated entry text, so conditionals and global-variable reads count what will actually reach the context. The cutoff evaluation leaves `runVar` false and therefore does not perform variable-setting side effects (`loadLoreBookV3Prompt()` in `src/ts/process/lorebook.svelte.ts`).

History processing has additional hook points:

- `runCurrentChatFunction()` evaluates chat-parser variables directly into stored message data before assembly (`src/ts/process/index.svelte.ts:107`).
- The `start` trigger may mutate the chat, add token cost, or stop generation (`src/ts/process/index.svelte.ts:787`).
- Each history message passes through `risuChatParser()` and `processScriptFull(..., 'editprocess')` (`src/ts/process/index.svelte.ts:799`).
- Historical `<Thoughts>` blocks are removed from visible content and carried in `OpenAIChat.thoughts` according to `maxThoughtTagDepth` (`src/ts/process/index.svelte.ts:886`).
- `{{asset_prompt::name}}` injects character/module assets as image multimodals (`src/ts/process/index.svelte.ts:895`).

### Attachment conversion

For user messages, all `{{inlay...::id}}` placeholders are collected; for character messages, only `{{inlayeddata::id}}` is forwarded to the model (`src/ts/process/index.svelte.ts:819`).

Each asset is resolved with `getInlayAsset()` (`src/ts/process/index.svelte.ts:843`):

- Vision-capable models receive image base64 plus dimensions.
- Non-vision models receive an image-caption string from `runImageEmbedding()`.
- Audio and video become multimodals only when no earlier multimodal has been added.
- Signature assets are always forwarded as signature multimodals.
- The original placeholder is removed from request text after extraction.

Text-file placeholders take a different route: `{{file::filename::base64}}` is decoded into UTF-8 by the general chat parser outside display mode (`src/ts/cbs.ts:956`).

### Token budgeting and memory

`ChatTokenizer` is initialized with a per-message framing estimate—five tokens for GPT-family IDs, otherwise three—and an output-token reservation (`src/ts/process/index.svelte.ts:320`).

Output reservation is tracked separately from the final input-token count. Budgeting happens in two passes:

1. Static prompt buckets, examples, greeting, and each converted history message are counted while `currentTokens` already includes reserved output and a 50-token safety margin (`src/ts/process/index.svelte.ts:618`, `src/ts/process/index.svelte.ts:658`, `src/ts/process/index.svelte.ts:813`, `src/ts/process/index.svelte.ts:1018`).

2. After final prompt-card ordering and Lua request edits, all final messages are re-tokenized as `inputTokens`; entries marked `removable` are blanked in final prompt order until the input fits (`src/ts/process/index.svelte.ts:1422-1446`).

The pre-trim total from that second pass is stored in `lastActualInputTokens` and shown as “Current Chat (Actual)” in `DevTool.svelte`. It is more representative than `getChatToken()` because it counts the constructed request, but it is captured before overflow correction removes `removable` messages and is still tokenizer-derived rather than provider-reported billing usage.

If HypaV3 is enabled for the character/chat, `hypaMemoryV3()` receives the prepared history, current token count, context limit, and tokenizer and returns replacement chats plus updated memory (`src/ts/process/index.svelte.ts:1033`). Otherwise, oldest prepared history items are removed until the early budget fits (`src/ts/process/index.svelte.ts:1064`).

The final estimated output allowance is clamped to `maxContextTokens - inputTokens`, and generation metadata is constructed at `src/ts/process/index.svelte.ts:1449`.

### Prompt-card ordering

If `db.promptTemplate` exists, `sendChat()` walks its cards in order and materializes persona, description, note, lorebook, plain, ChatML, ranged-chat, memory, cache, and post-everything cards (`src/ts/process/index.svelte.ts:1108`). Chat ranges support absolute indices, negative indices, and the `-1000` all-history sentinel (`src/ts/process/index.svelte.ts:1224`).

Without prompt cards, the legacy `db.formatingOrder` determines bucket order and `postEverything` is appended (`src/ts/process/index.svelte.ts:1058`, `src/ts/process/index.svelte.ts:1303`).

Additional final transformations are:

- Adjacent system messages may be merged by `pushPrompts()` (`src/ts/process/index.svelte.ts:1072`).
- Chat cards can be converted to system messages with `systemizeChat()` (`src/ts/process/index.svelte.ts:1248`).
- Explicit or automatic cache points set `OpenAIChat.cachePoint` on earlier messages (`src/ts/process/index.svelte.ts:1254`, `src/ts/process/index.svelte.ts:1285`).
- Character `depth_prompt` is inserted relative to the prompt tail (`src/ts/process/index.svelte.ts:1324`).
- Lua `editRequest` is the last in-subsystem prompt mutation before token rechecking (`src/ts/process/index.svelte.ts:1333`).

### Request boundary and streaming

The provider boundary is:

```text
sendChat()
  -> requestChatData({ formated, biases, streaming, continue, ... }, 'model', signal)
```

The call occurs at `src/ts/process/index.svelte.ts:1489`; `requestChatData()` is defined at `src/ts/process/request/request.ts:136`. It returns `success`, `fail`, `streaming`, or `multiline` through the `requestDataResponse` union.

Inside the request subsystem, but before provider dispatch:

- Plugin `replacerbeforeRequest` hooks can replace the formatted prompt (`src/ts/process/request/request.ts:166`).
- The `request` trigger can replace the serialized prompt array (`src/ts/process/request/request.ts:175`).
- ModelPreset versus classic dispatch is selected in `requestChatDataMain()` (`src/ts/process/request/request.ts:388`).

For streaming responses, `sendChat()`:

1. Appends an empty character message stamped with the generation UUID, or targets the existing last message for continuation (`src/ts/process/index.svelte.ts:1529`).
2. Sets `Chat.isStreaming`, records the active display-optimization mode, and attaches an abort listener that cancels the reader (`src/ts/process/index.svelte.ts:1549`).
3. Treats each stream value as a cumulative response snapshot. In `off` mode every snapshot immediately runs `processScriptFull(..., 'editoutput')`; `balanced` coalesces display and edit-output work to roughly 125 ms plus an animation frame; `strong` coalesces raw display updates and defers edit-output processing until the final snapshot (`src/ts/process/index.svelte.ts:1548-1673`).
4. Flushes any pending snapshot, applies deferred edit-output work, then always clears `isStreaming`/the active mode and cancels the reader in `finally` (`src/ts/process/index.svelte.ts:1675-1700`).

For non-streaming and multiline responses, the same `editoutput` script stage is applied; the first result is stored or merged into the continued message (`src/ts/process/index.svelte.ts:1524`).

### Post-processing and persistence

After the response body is stored:

- `runCurrentChatFunction()` expands chat variables across stored messages again (`src/ts/process/index.svelte.ts:1696`, `src/ts/process/index.svelte.ts:1782`).
- The `output` trigger may mutate the chat or request an entire resend (`src/ts/process/index.svelte.ts:1698`, `src/ts/process/index.svelte.ts:1785`).
- `runInlayScreen()` rewrites emotion/image commands and may asynchronously replace a generating marker with an inlay placeholder (`src/ts/process/index.svelte.ts:1705`, `src/ts/process/index.svelte.ts:1736`).
- Optional TTS runs after the stored response is updated (`src/ts/process/index.svelte.ts:1714`, `src/ts/process/index.svelte.ts:1778`).
- Auto-continue recursively calls `sendChat(..., {continue: true})` based on minimum output tokens or missing terminal punctuation (`src/ts/process/index.svelte.ts:1794-1814`).
- Optional IGP and emotion-selection follow-up requests occur after the main message is stored (`src/ts/process/index.svelte.ts:1817`, `src/ts/process/index.svelte.ts:2015`).
- Stage timing metadata is finalized on the last message near the end of `sendChat()` (`src/ts/process/index.svelte.ts:2105`).

There is no explicit database write in `sendChat()`. Once the pipeline mutates the active
hydrated chat, a bounded tracker queues that row; it does not deep-walk the whole
`DBState` graph on every reactive flush. The tracker re-establishes active-chat
subscriptions on the ordinary roughly 500 ms save cadence, or roughly every 20 seconds
for a live generation. The first eligible generation save writes a checkpoint, later
checkpoints are limited to that 20-second cadence, and the live→idle transition schedules
the final response save (`watchActiveChatDirty()` in
`src/ts/storage/activeChatDirtyTracker.svelte.ts`, `prepareChatPersistStage()` in
`src/ts/storage/chatPersistStage.ts`). See [client storage](client-storage.md) for the
canonical save-loop scheduling and durability rules.

When a prior chat row has an exact acknowledged baseline, a checkpoint may send a
smaller validated patch containing whole-message replacements/appends. The server can
append it to the versioned `pocketrisu-chat-operation-v1` log and acknowledges the
materialized row hash/size plus log operation/byte counts; it schedules asynchronous
compaction at the default threshold of 64 operations or 1 MiB. An ineligible or
definitively refused delta falls back to the already prepared full-row write. See
[client storage](client-storage.md) and [server backend](server-backend.md) for the
protocol, fallback, and compaction contracts.

Output translation is not part of persisted response post-processing. `ChatBody.svelte` translates parsed or pre-parsed text only for display at `src/lib/ChatScreens/ChatBody.svelte:104`. Composer translation similarly updates `messageInput` before send through `updateInputTransateMessage()` at `src/lib/ChatScreens/DefaultChatScreen.svelte:685`.

### Interrupted-send and job recovery

Server-side ModelPreset generation has two complementary recovery records. A model job means the provider request actually started; `jobRecovery.ts` owns decoding and slotting its journal into the originating chat. A pending-send tombstone spans the wider browser pipeline and contains no prompt or response state. If an aged tombstone has no matching generation message or model job and the chat still ends on a user turn, discovery marks it resumable (`evaluatePendingSend()` in `src/ts/process/request/jobRecovery.ts`).

Opening that chat consumes the local flag, revalidates the tail and selection, then calls `claimPendingSend()` before re-running `sendChat()` once. The server-side claim is the at-most-once boundary across tabs and devices; a typed composer draft is left untouched. A running recovered job instead installs a `background` `generationStates` entry, blocking only that chat without setting global `doingChat`. Provider journal and recovery details are documented in [Model providers](model-providers.md).

### Regenerate and continue

- Empty-input resend: when the last message is already a user message, the composer adds no duplicate user message and labels send as reroll/resend (`src/lib/ChatScreens/DefaultChatScreen.svelte:427`).
- Explicit reroll: `reroll()` removes prior character output while preserving trailing comments/disabled messages, calls generation again, restores on failure, and stores old/new texts in `Message.swipes` (`src/lib/ChatScreens/DefaultChatScreen.svelte:448`).
- Continue: the menu calls `sendContinue()`. `sendChat()` adds a `[Continue the last response]` system instruction only for selected classic Claude/GPT/OpenRouter/reverse-proxy IDs (`src/ts/process/index.svelte.ts:1149`), passes `continue` into the request boundary, and merges every provider regime's output into the previous character message (`src/ts/process/index.svelte.ts:1533`, `src/ts/process/index.svelte.ts:1745`).
- Automatic continuation uses the same path recursively and accumulates `usedContinueTokens` (`src/ts/process/index.svelte.ts:1610`).

### Suggestions

`Suggestion.svelte` is adjacent to, but does not reuse, the main prompt builder. When `doingChat` transitions to false, it takes at most ten recent messages, constructs a two-message suggestion prompt or a local-model transcript, and calls the submodel directly (`src/lib/ChatScreens/Suggestion.svelte:42`).

Only response lines beginning with `-` become suggestions (`src/lib/ChatScreens/Suggestion.svelte:89`). Suggestions are stored on the active `Chat`, may be translated for display, and are cleared whenever a main generation begins.

### Group and multi-character status

PocketRisu currently does not support active group-chat records. Boot explicitly removes database entries whose `type` is `group` through `purgeUnsupportedGroupChats()` (`src/ts/storage/database.svelte.ts:1814`, invoked at `src/ts/bootstrap.ts:587`), and `requestChatData()` is always called with `isGroupChat: false` (`src/ts/process/index.svelte.ts:1494`).

Legacy multi-speaker history compatibility remains: character messages may carry a `saying` character ID, and prompt construction resolves that ID to the corresponding character name (`src/ts/process/index.svelte.ts:805`). This should not be mistaken for working group generation.

## 4. Entry points & dependencies

### Inbound callers

- Main composer: `sendChatMain()` at `src/lib/ChatScreens/DefaultChatScreen.svelte:587`.
- Autopilot/dev tool: indexed `sendChat(i)` calls at `src/lib/SideBars/DevTool.svelte:213`.
- Prompt/body preview: `src/lib/SideBars/DevTool.svelte:29` and hotkey preview at `src/ts/hotkey.ts:129`.
- Slash-command `/multisend`: `src/ts/process/command.ts:158`.
- PO translation: `src/ts/process/files/multisend.ts:47`.
- Plugin API v3: wrapper around `sendChat()` at `src/ts/plugins/apiV3/v3.svelte.ts:1404`.
- Suggestions bypass `sendChat()` and enter directly at `requestChatData()` (`src/lib/ChatScreens/Suggestion.svelte:84`).

### Outbound subsystem edges

- Storage/state: `DBState`, selected character, `Chat`, `Message`, preset binding, and normalization.
- Parser: `risuChatParser()`, ChatML parsing, placeholder/file expansion.
- Lorebook: `loadLoreBookV3Prompt()` at `src/ts/process/index.svelte.ts:480`.
- Memory/embedding: `additionalInformations()` at `src/ts/process/index.svelte.ts:458`; `hypaMemoryV3()` at `src/ts/process/index.svelte.ts:1033`.
- Scripts/plugins: `processScriptFull()`, Lua edit hooks, module assets/regex scripts.
- Triggers: `input`, `start`, `request`, `output`, `display`, and manual trigger stages.
- Request/providers: `requestChatData()` at `src/ts/process/request/request.ts:136`.
- Model metadata: `getModelInfo()`, `LLMFlags`, ModelPreset bindings and limits.
- Media: inlay storage, image captioning, image generation, emotion selection, and TTS.
- Translation: composer-side input translation and display-only output translation.
- Persistence: reactive save tracking in `src/ts/globalApi.svelte.ts`, ultimately backed by the self-hosted Node storage API.

## 5. Conventions & gotchas

- `generationStates`, not `doingChat`, is the authoritative concurrency guard. `sendChat()` calls `startGeneration()` for the target chat, while the standard UI calls `endGeneration()` in `finally`. Recursive auto-continue and resend temporarily end/restart the same key while retaining its pending abort controller.

- The composer-side send transaction and per-chat generation entry are separate contracts. The transaction spans input triggers, `editinput` handlers, child turns, and the outer generation; `generationStates` covers model work and background job recovery. A `sendChat()` call made while a transaction is active must carry its exact internal transaction token, which prevents unrelated API callers from borrowing the outer send's target.

- `doingChat` means “at least one live generation exists,” not “the selected chat is generating.” `DefaultChatScreen.svelte` uses `generationStates.has(currentChatGenKey())` for selected-chat UI state. Background job entries hold the per-chat guard but intentionally do not flip `doingChat`.

- `chatOperationActive` still derives from global `doingChat` plus the input transaction, so normal composer sends and navigation are blocked while any live generation exists. The per-chat map permits targeted API/script lifecycles and background recovery without confusing one chat's guard with another's; it does not by itself make the standard UI multi-send.

- `abortChat()` is local to `DefaultChatScreen.svelte`. It first calls `abortGeneration()` for the selected chat, whose controller can represent either a live request or a reattached job, then falls back to the screen-local controller.

- `requestTokenParts` is exported at `src/ts/process/index.svelte.ts:58` but has no current consumers. Do not assume it reflects actual token accounting.

- `lastActualInputTokens` is module-global debug state from the most recent send/preview. It is set before final overflow trimming, is not keyed by character/chat/generation, and is not authoritative provider usage despite the UI's “Actual” label.

- `chatProcessIndex` mostly relaxes the concurrent-send guard and suppresses random `presetChain` selection for scripted/dev sequences; ordinary UI calls use `-1`.

- Preview modes return early after setting `previewFormated` or `previewBody`. Their callers are responsible for concluding the corresponding generation entry; previews do not create pending-send tombstones.

- Prompt-card assembly exists in `index.svelte.ts`, not `prompt.ts`. `prompt.ts` defines card data, estimates static cost, and converts foreign presets.

- Prompt templates are cloned and automatically receive a `postEverything` card if absent (`src/ts/process/index.svelte.ts:298`). A utility bot may replace the entire template unless `promptSettings.utilOverride` is active (`src/ts/process/index.svelte.ts:315`).

- `PromptSettings.assistantPrefill` is declared at `src/ts/process/prompt.ts:10` but is not read by `sendChat()`. SillyTavern assistant prefill is instead converted into an explicit post-everything assistant card at `src/ts/process/prompt.ts:226`.

- `tokenizePreset()` does not count `cot` or `chatML` cards, and intentionally does not count dynamic chat/cache cards (`src/ts/process/prompt.ts:64`). Settings-page template estimates can therefore under-report static content.

- The early token pass reserves `maxResponseTokens + 50`; the final pass counts only actual input and records a clamped `outputTokens` estimate. That clamped value is not passed as `maxTokens` in the main `requestChatData()` call (`src/ts/process/index.svelte.ts:1449`, `src/ts/process/index.svelte.ts:1489`), so provider enforcement remains a request-layer concern.

- During final overflow correction, the first `removable` entry in final prompt order is blanked repeatedly (`src/ts/process/index.svelte.ts:1432`). This commonly approximates oldest-first history removal but is controlled by the materialized prompt order. Prompt/system material that alone exceeds the context produces an error.

- Final overflow correction subtracts the entire token cost of a removable multimodal message and blanks only its text. The subsequent filter retains the entry because it still has multimodals, so the adjusted `inputTokens` can undercount the request that is actually sent.

- `ChatTokenizer.tokenizeChat()` counts `thoughts` only when explicitly called with `{countThoughts: true}` (`src/ts/tokenizer.ts:378`). The main pipeline uses the default, so extracted historical thought blocks are excluded from its budget.

- Multimodal token cost is an approximation. Low-quality vision is fixed at 87 tokens; higher quality uses dimension-based tile estimation (`src/ts/tokenizer.ts:405`).

- `ChatTokenizer` framing and `encode()` selection still derive from the global classic `db.aiModel`. Resolving a per-chat ModelPreset changes context/output limits but does not select that preset's tokenizer or GPT-family framing heuristic.

- Attachment capability checks use `DBState.db.aiModel` (`src/ts/process/index.svelte.ts:842`, `src/ts/process/files/inlays.ts:697`), not the resolved per-chat ModelPreset model. A bound preset whose capabilities differ from the global classic model can be misclassified.

- For character-authored history, only `inlayeddata` reaches the model; `inlay` and `inlayed` are display-only. User-authored placeholders are all collected as request attachments (`src/ts/process/index.svelte.ts:819`).

- Audio/video insertion is gated by `multimodal.length === 0` (`src/ts/process/index.svelte.ts:861`). A preceding image or signature can prevent an audio/video item from being added.

- `writeInlayImage()` always re-encodes uploaded images and caps total pixels; it does not preserve the original image bytes or extension (`src/ts/process/files/inlays.ts:438`).

- Inlay bodies, explorer summaries, and ownership metadata are separate NodeStorage records. `setInlayAsset()` and `removeInlayAsset()` update them sequentially rather than as one transaction, so new mutation and duplication paths must define partial-failure recovery (`src/ts/process/files/inlays.ts:600`). Deep chat/package duplication can otherwise leave ownership metadata associated with the source chat.

- The regular file picker omits PDF and XML even though dispatch cases exist (`src/ts/process/files/multisend.ts:198`, `src/ts/process/files/multisend.ts:247`). Drag/direct-byte callers can still reach those cases.

- `multisend.ts` has its own PDF text path using `BufferToText()` and does not use `dynamicutils/pdf.ts`. The latter expects a real `ArrayBuffer` and is currently used by the MCP filesystem client.

- `dynamicutils/pdf.ts` loads CMaps from jsDelivr (`src/ts/process/dynamicutils/pdf.ts:15`), so PDF handling may be incomplete in a fully offline deployment.

- `exampleMessage()` compares lowercased input against the original `char.name` (`src/ts/process/exampleMessages.ts:34`); mixed-case literal character names may fail to parse unless `{{char}}:` or `<bot>:` is used.

- Example-message role lines use `split(':', 2)` (`src/ts/process/exampleMessages.ts:38`), which discards text after a second colon. Preserve this compatibility quirk deliberately or fix it with tests.

- `stringlizeChat()` and `stringlizeChatOba()` have no current runtime callers. Active legacy request paths use response unstringlizing and the AIN serializer.

- `stringlizeAINChat()` contains unary `+` before the non-continued suffix at `src/ts/process/stringlize.ts:233`, which can append `NaN`; treat changes here as a bug fix requiring request-path tests.

- `unstringlizeChat()` trims at any detected system, user, character, or named-speaker marker. Adding names to formatted prompts can therefore change where legacy text completions are cut off.

- In streaming display mode `off`, `processScriptFull()` is run against every cumulative snapshot. `balanced` coalesces these calls; `strong` runs it only for the final snapshot. Hooks must tolerate repeated cumulative input unless the application requires `strong` mode.

- Streaming and non-streaming responses do not pass through every post-processing hook in identical order. Review both branches when moving output triggers, inlay processing, TTS, or persistence checkpoints.

- Preview modes avoid storing a generated assistant response, but they still enter prompt construction and its hooks; treat them as diagnostic execution, not a universally read-only operation.

- Generation persistence is checkpointed independently of the provider stream. Do not
  restore a blanket `doingChat` save skip; the row-before-stub and final-idle-save
  contracts are canonical in [client storage](client-storage.md).

- Server pending-send tombstones are enabled only with `nodeOnlyServerSideRequests === true`, are fire-and-forget, and contain no pipeline state. They are a best-effort way to re-run a send that died before a recoverable main job existed, not a substitute for model-job journals.

- Job recovery writes raw adapter-decoded output. It deliberately does not replay `editoutput`, output triggers, inlay processing, translation, TTS, or auto-continue because those live hooks can have side effects.

- Losing writer authority during generation aborts persistence and must surface as a
  displaced-writer outcome. The client reaction and server lock protocol are documented
  in [client storage](client-storage.md) and [server backend](server-backend.md); the
  pipeline must not continue mutating in expectation of a later overwrite.

- Aborting a stream clears `isStreaming` but does not remove the already-created partial character message (streaming `finally` near `src/ts/process/index.svelte.ts:1675`). A normal aborted send can leave partial output in history.

- The `multiline` response path processes all alternatives but stores only the first; the local `mrerolls` array is never applied to message swipes (non-streaming branch near `src/ts/process/index.svelte.ts:1730`). UI reroll/swipes are a separate mechanism.

- Auto-continue counts the raw main result plus previous continuation tokens, not necessarily the final regex/inlay-processed stored text (`src/ts/process/index.svelte.ts:1796`).

- The local-model suggestion branch uses `DBState.db.autoSuggestPrompt` directly rather than the previously computed default fallback (`src/lib/ChatScreens/Suggestion.svelte:68`). An empty configured prompt can therefore produce an empty local-model system instruction.

- Suggestion reroll deliberately toggles `doingChat` true then false to retrigger its subscription (`src/lib/ChatScreens/Suggestion.svelte:145`).

- Group-chat fields and historical `saying` IDs remain for RisuAI compatibility, but new code must not expose group-chat creation without restoring the entire unsupported path: boot currently deletes such records.

- Mutating `DBState` is normally sufficient for persistence, but only the active hydrated
  chat receives the bounded deep tracker used for chat-row dirtiness. Avoid bypassing the
  active-chat setters/state model during asynchronous generation.

## 6. Navigation hints

- To change the main generation sequence or stage timing, start at `sendChat()` (`src/ts/process/index.svelte.ts:68`).

- To change what happens before a user message is inserted, inspect `sendMain()` (`src/lib/ChatScreens/DefaultChatScreen.svelte:358`).

- To change send-key behavior, edit `shouldSendOnEnter()` (`src/lib/ChatScreens/DefaultChatScreen.svelte:63`) and the composer handlers around `src/lib/ChatScreens/DefaultChatScreen.svelte:1128`.

- To add a new prompt-card type, update the unions in `src/ts/process/prompt.ts:7`, both token and materialization switches in `src/ts/process/index.svelte.ts:581` and `src/ts/process/index.svelte.ts:1111`, template validation, and prompt-settings UI.

- To change legacy no-template ordering, inspect `formatingOrder` handling at `src/ts/process/index.svelte.ts:1058` and built-in defaults at `src/ts/process/templates/templates.ts:156`.

- To change lore placement without changing lore activation, edit the position/depth insertion points at `src/ts/process/index.svelte.ts:424`, `src/ts/process/index.svelte.ts:505`, and `src/ts/process/index.svelte.ts:1025`.

- To change memory’s insertion contract, inspect `hypaMemoryV3()` handoff at `src/ts/process/index.svelte.ts:1033`, the `supaMemoryCardUsed` split at `src/ts/process/index.svelte.ts:1082`, and the prompt-template memory card at `src/ts/process/index.svelte.ts:1350`.

- To add or reorder script/trigger hooks, inspect input at `src/lib/ChatScreens/DefaultChatScreen.svelte:368`, start at `src/ts/process/index.svelte.ts:787`, edit-process at `src/ts/process/index.svelte.ts:799`, edit-request at `src/ts/process/index.svelte.ts:1333`, and edit-output at `src/ts/process/index.svelte.ts:1482`.

- To alter final provider-neutral payload fields, edit the `requestChatData()` call at `src/ts/process/index.svelte.ts:1489`.

- To change provider routing or retries, cross into the request subsystem at `src/ts/process/request/request.ts:136`; do not add provider-specific logic to `sendChat()`.

- To change streamed UI updates, display coalescing, or abort behavior, inspect the streaming branch at `src/ts/process/index.svelte.ts:1529`, `generationState.ts`, and the UI controller at `src/lib/ChatScreens/DefaultChatScreen.svelte:587`.

- To change continuation instruction/merging, inspect `src/ts/process/index.svelte.ts:1149`, `src/ts/process/index.svelte.ts:1533`, and `src/ts/process/index.svelte.ts:1745`.

- To change reroll/swipe semantics, inspect `src/lib/ChatScreens/DefaultChatScreen.svelte:492`.

- To change automatic continuation thresholds, inspect `src/ts/process/index.svelte.ts:1796`.

- To add a slash command, extend `processCommand()` at `src/ts/process/command.ts:42` and update its help block at `src/ts/process/command.ts:232`.

- To change example-dialogue syntax, edit `exampleMessage()` at `src/ts/process/exampleMessages.ts:5` and add tests for names and embedded colons.

- To change tokenizer selection, inspect `encode()` at `src/ts/tokenizer.ts:73`; to change per-message overhead, inspect `ChatTokenizer` at `src/ts/tokenizer.ts:369`.

- To change vision token estimates, edit `tokenizeMultiModal()` at `src/ts/tokenizer.ts:405`.

- To add an attachment type, update extension dispatch in `src/ts/process/files/multisend.ts:194`, `InlayAsset` at `src/ts/process/files/inlays.ts:16`, storage serialization, request extraction at `src/ts/process/index.svelte.ts:841`, and rendering in the parser.

- To change image compression or maximum dimensions, edit `writeInlayImage()` at `src/ts/process/files/inlays.ts:438` and its tests at `src/ts/process/files/tests/inlays.test.ts:497`.

- To change structured-output schema behavior, inspect `src/ts/process/templates/jsonSchema.ts:5` and its request-layer callers.

- To add a model-native Jinja template, update `chatTemplates` and any required `templateEffect` in `src/ts/process/templates/chatTemplate.ts:6`.

- To change auto-suggestion prompting or parsing, inspect `src/lib/ChatScreens/Suggestion.svelte:42` and `src/lib/ChatScreens/Suggestion.svelte:84`.

- To change output translation, use the display pipeline at `src/lib/ChatScreens/ChatBody.svelte:104`; translated output is not stored by `sendChat()`.

- To change when generated messages reach SQLite-backed persistence, inspect
  `src/ts/storage/activeChatDirtyTracker.svelte.ts`, its wiring in
  `src/ts/globalApi.svelte.ts`, and row staging in
  `src/ts/storage/chatPersistStage.ts`, not the model pipeline.

## 7. Related structure docs

- [Model providers](model-providers.md) covers selection, retries, adapters, tools, and provider wire formats beyond `requestChatData()`.
- [Memory and lorebook](memory-lorebook.md) and [scripting and extensions](scripting-extensions.md) cover the principal prompt hooks.
- [Media and translation](media-translation.md) covers inlays, translation, and display parsing.
- [Client storage](client-storage.md) and [server backend](server-backend.md) cover chat hydration, save outcomes, writer fencing, and SQLite persistence.
