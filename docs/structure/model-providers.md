# Model providers

> Part of the PocketRisu structure docs — see [STRUCTURE.md](../../STRUCTURE.md) for the top-level map and subsystem index.
> Audited 2026-08-01 against `818c3bc1`. Paths and symbols are authoritative; line-number hints are approximate and should be verified with `rg`.

## 1. Purpose & overview

This subsystem turns PocketRisu’s normalized `OpenAIChat[]` prompt into provider-specific HTTP, SSE, WebSocket, polling, plugin, or in-browser inference calls. It supports two parallel selection regimes: the legacy global `LLMModel` registry and a per-chat `ModelPreset` adapter path.

In the legacy regime, `LLMModel.format` selects the wire protocol while `provider`, `flags`, `parameters`, and `tokenizer` supply UI, normalization, and request-building metadata. The preset regime instead uses a frozen provider-profile snapshot with one of three adapter families: OpenAI-compatible, Anthropic Messages, or native Gemini.

## 2. Key files

### Registry and model metadata

- `src/ts/model/types.ts` — Defines the numeric metadata contracts:
  - `LLMFlags` capability/compatibility constants at `src/ts/model/types.ts:3`.
  - `LLMProvider` grouping constants at `src/ts/model/types.ts:30`.
  - `LLMFormat` wire-dispatch constants at `src/ts/model/types.ts:50`.
  - `LLMTokenizer` constants at `src/ts/model/types.ts:78`.
  - `LLMModel` at `src/ts/model/types.ts:96`.
  - `ProviderNames` at `src/ts/model/types.ts:112`.
  - Shared parameter allowlists at `src/ts/model/types.ts:131`.

- `src/ts/model/modellist.ts` — Aggregates every legacy model and resolves persisted IDs:
  - `LLMModels` begins at `src/ts/model/modellist.ts:43`.
  - Static defaults for `shortName`, `internalID`, and `fullName` are filled at `src/ts/model/modellist.ts:545`.
  - OpenAI Responses API and Gemini Vertex variants are synthesized at `src/ts/model/modellist.ts:551`.
  - `registerModelDynamic()` discovers Google and Anthropic models at `src/ts/model/modellist.ts:578`.
  - `getModelInfo()` resolves static, `hf:::`, `horde:::`, `xcustom:::`, and `pluginmodel:::` IDs at `src/ts/model/modellist.ts:680`.
  - `getModelList()` filters/groups models for selectors at `src/ts/model/modellist.ts:782`.

- `src/ts/model/providers/openai.ts` — `OpenAIModels` is the static OpenAI model catalog (`src/ts/model/providers/openai.ts:3`).

- `src/ts/model/providers/anthropic.ts` — `AnthropicModels` contains current Messages API models and legacy completion-format Claude entries (`src/ts/model/providers/anthropic.ts:3`).

- `src/ts/model/providers/google.ts` — `GoogleModels` contains Gemini model IDs, modality/thinking flags, and parameter allowlists (`src/ts/model/providers/google.ts:3`).

- `src/ts/model/providers/nanogpt.ts` — Centralizes NanoGPT endpoint constants. The current selectable NanoGPT entry uses the chat-completions format; the additional NanoGPT format constants are not separate production catalog entries (`src/ts/model/providers/nanogpt.ts:5`).

### Request dispatch and provider wire formats

- `src/ts/process/request/request.ts` — Main request coordinator:
  - `RequestDataArgumentExtended` at `src/ts/process/request/request.ts:90`.
  - `requestDataResponse` union begins near `src/ts/process/request/request.ts:108`.
  - `requestChatData()` retry/fallback wrapper at `src/ts/process/request/request.ts:136`.
  - `reformater()` role/system normalization at `src/ts/process/request/request.ts:301`.
  - `requestChatDataMain()` selection and `LLMFormat` dispatch at `src/ts/process/request/request.ts:388`.
  - ModelPreset adapter wrappers at `src/ts/process/request/request.ts:511`.
  - Proxy-aware preset fetch wrapper at `src/ts/process/request/request.ts:558`.
  - `requestModelPreset()` at `src/ts/process/request/request.ts:705`.
  - `testModelPreset()` at `src/ts/process/request/request.ts:1049`.
  - Legacy provider implementations begin with NovelAI at `src/ts/process/request/request.ts:1152`, Ooba legacy at `src/ts/process/request/request.ts:1262`, plugins at `src/ts/process/request/request.ts:1473`, Kobold at `src/ts/process/request/request.ts:1575`, Ollama at `src/ts/process/request/request.ts:1726`, Cohere at `src/ts/process/request/request.ts:1774`, Horde at `src/ts/process/request/request.ts:1906`, and browser-local generation at `src/ts/process/request/request.ts:2011`.

- `src/ts/process/request/openAI/requests.ts` — OpenAI-compatible request family:
  - `requestOpenAI()` builds Chat Completions requests at `src/ts/process/request/openAI/requests.ts:35`.
  - `requestHTTPOpenAI()` handles JSON responses and recursive tool calls at `src/ts/process/request/openAI/requests.ts:624`.
  - `requestOpenAILegacyInstruct()` handles `/v1/completions` at `src/ts/process/request/openAI/requests.ts:856`.
  - `requestOpenAIResponseAPI()` builds `/v1/responses` input items at `src/ts/process/request/openAI/requests.ts:927`.
  - `getTranStream()` parses Chat Completions SSE at `src/ts/process/request/openAI/requests.ts:1120`.
  - `wrapToolStream()` executes streamed tool calls and resumes generation at `src/ts/process/request/openAI/requests.ts:1276`.

- `src/ts/process/request/openAI/types.ts` — Wire types for Responses API items, multimodal content, and tool calls (`src/ts/process/request/openAI/types.ts:3`).

- `src/ts/process/request/openAI/index.ts` — one-line compatibility re-export at `src/ts/process/request/openAI/index.ts:1`.

- `src/ts/process/request/anthropic.ts` — `requestClaude()` converts messages, images, cache points, reasoning, and tools to Anthropic or Bedrock form (`src/ts/process/request/anthropic.ts:71`); `requestClaudeHTTP()` handles Anthropic JSON/SSE and tool recursion (`src/ts/process/request/anthropic.ts:800`).

- `src/ts/process/request/google.ts` — `requestGoogleCloudVertex()` formats Gemini `contents`, modalities, tools, safety, thinking, and authentication (`src/ts/process/request/google.ts:57`); `requestGoogle()` handles JSON/SSE responses and recursive function calls (`src/ts/process/request/google.ts:612`).

- `src/ts/process/request/shared.ts` — Provider-neutral request parameters, custom body/header parsing, streaming collection, and parameter application.
  - `LLMParameter` and `ModelModeExtended` at `src/ts/process/request/shared.ts:3`.
  - Custom body/header parsing at `src/ts/process/request/shared.ts:33`.
  - `collectStreamingText()` at `src/ts/process/request/shared.ts:128`.
  - `applyParameters()` at `src/ts/process/request/shared.ts:148`.

### ModelPreset bridge

- `src/ts/process/request/modelPresetBinding.ts` — Per-chat classic/preset binding, context/output limits, prompt-parameter bridging, and credentials.
  - `resolveChatModelBinding()` chooses classic versus preset and resolves main/sub/aux slots at `src/ts/process/request/modelPresetBinding.ts:42`.
  - `resolvePresetMaxOutputTokens()` at `src/ts/process/request/modelPresetBinding.ts:142`.
  - `resolveChatMaxResponseTokens()` at `src/ts/process/request/modelPresetBinding.ts:196`.
  - `applyPromptPresetParams()` at `src/ts/process/request/modelPresetBinding.ts:252`.
  - `buildModelPresetCredential()` at `src/ts/process/request/modelPresetBinding.ts:293`.

- `src/ts/preset/adapter/buildRequest.ts` — Shared ModelPreset request builder.
  - `buildPreparedRequest()` resolves the endpoint, composes body/header/query layers, parses the freeform additional-parameter syntax, and applies authentication (`src/ts/preset/adapter/buildRequest.ts:15`).
  - `resolveEndpointUrl()` handles static and Vertex endpoints plus schema-driven URL overrides (`src/ts/preset/adapter/buildRequest.ts:80`).

- `src/ts/preset/cache/geminiContextCache.ts` — Gemini `cachedContents` state, decisions, body transforms, and REST client.
  - `evaluateGeminiCacheBeforeRequest()` and `decideGeminiCacheAfterResponse()` own the pure hit/miss/invalidation/create/extend policy (`src/ts/preset/cache/geminiContextCache.ts:284`, `src/ts/preset/cache/geminiContextCache.ts:341`).
  - `applyGeminiCacheToBody()` substitutes a cache resource and prompt suffix; `createGeminiCachedContentsClient()` creates, patches, and deletes resources for AI Studio or Vertex (`src/ts/preset/cache/geminiContextCache.ts:410`, `src/ts/preset/cache/geminiContextCache.ts:524`).

- `src/ts/preset/cache/geminiCacheWiring.ts` — Fail-open bridge between the Gemini adapter and cache core.
  - `beginGeminiCacheTurn()` applies the pre-request decision and exposes detached post-response lifecycle work (`src/ts/preset/cache/geminiCacheWiring.ts:57`).
  - Per-cache-key generations prevent an older asynchronous create/extend from overwriting newer state (`src/ts/preset/cache/geminiCacheWiring.ts:172`).

- `src/ts/process/request/modelPresetMessages.ts` — Converts classic history into adapter messages:
  - `expandAdapterMessages()` restores persisted tool markers at `src/ts/process/request/modelPresetMessages.ts:18`.
  - `toolResponseText()` at `src/ts/process/request/modelPresetMessages.ts:104`.
  - `toAdapterMessage()` maps roles, cache points, and optional images at `src/ts/process/request/modelPresetMessages.ts:112`.

- `src/ts/process/request/presetStreamPump.ts` — Delta accumulation, cumulative snapshot delivery, throttling, and backpressure for ModelPreset streams.
  - `StreamFlushThrottle` at `src/ts/process/request/presetStreamPump.ts:24`.
  - `pumpPresetStream()` accumulates adapter deltas and emits throttled cumulative snapshots at `src/ts/process/request/presetStreamPump.ts:109`.

- `src/ts/process/request/jobFetch.ts` — fetch-compatible durable ModelPreset transport.
  - `makeJobFetch()` creates `/api/model-jobs`, exposes journal replay/live tail as a provider-like `Response`, reattaches interrupted tails, confirms terminal status, and claims completed jobs.
  - `ModelJobBusyError` prevents a server `409` from falling back into a duplicate direct request.

- `src/ts/process/request/jobRecovery.ts` — boot/return recovery for durable jobs and interrupted sends.
  - `decodeStreamingJournalDetailed()` and `decodeJsonJournalDetailed()` reuse the live adapter parsers.
  - `recoverTerminalJob()` idempotently fills or inserts by generation ID, persists the chat row, logs usage, then claims the job.
  - `attachRunningJob()` installs a background per-chat guard and polls the server to terminal state.
  - `recoverModelJobs()` discovers work; `initModelJobRecovery()` runs it at boot, on visibility return, and when the browser comes online.

- `server/node/model-jobs.cjs` — Express-side raw response recorder and pending-send store.
  - Metadata lives in `save/model-jobs.db`; raw provider bytes are append-only journals under `save/model-jobs/`.
  - `createModelJobs()` registers authenticated `/api/model-jobs` and `/api/pending-sends` routes, enforces one running main job per chat, and rotates terminal records.

- `src/ts/requestLog.ts` — request-log/usage bridge.
  - `createRequestLogScope()` wraps a transport, tees response bodies, associates routes and authoritative adapter usage, and flushes one entry per request.
  - Query/statistics helpers read the server-backed request and usage log APIs.

- `server/node/request-logs.cjs` — persistent provider diagnostics and token-usage store.
  - `createRequestLogs()` owns the independent `save/request-logs.db`: heavy `requests` rows retain masked/truncated headers and bodies, while compact LLM `usage` rows retain model/source/token/duration statistics.
  - Request/response bodies are capped at 2 MiB, headers at 16 KiB, and ingest batches at 50 entries. `requests` rotates toward a 256 MiB body budget while always keeping at least 50 newest rows; rotation runs every 20 inserted rows and at server startup. `usage` is not rotated.
  - `registerRoutes()` provides authenticated batch ingest, filtered/cursor-paged request listing, single-entry body lookup, usage aggregation/dimensions, and storage statistics under `/api/request-logs`. Deletion additionally requires the active writer session and removes usage only when `?usage=1` is requested (`server/node/server.cjs:13560`).

### Catalog helpers and specialized formats

- `src/ts/model/openrouter.ts` — Fetches OpenRouter providers/models, derives pricing, and produces generic grid items:
  - `getOpenRouterProviders()` at `src/ts/model/openrouter.ts:33`.
  - `getOpenRouterModels()` at `src/ts/model/openrouter.ts:51`.
  - `toModelGridItem()` at `src/ts/model/openrouter.ts:108`.
  - `getFreeOpenRouterModels()` at `src/ts/model/openrouter.ts:139`.

- `src/ts/model/nanogpt.ts` — Fetches NanoGPT balance, subscription state, provider choices, and model catalogs:
  - Account endpoints at `src/ts/model/nanogpt.ts:60` and `src/ts/model/nanogpt.ts:73`.
  - Per-model provider lookup at `src/ts/model/nanogpt.ts:125`.
  - Subscription model catalog at `src/ts/model/nanogpt.ts:137`.
  - Regular/personalized catalog at `src/ts/model/nanogpt.ts:162`.
  - Grid conversion at `src/ts/model/nanogpt.ts:194`.

- `src/ts/model/modelGrid.ts` — Provider-neutral model-card and pinned-item types (`src/ts/model/modelGrid.ts:2`).

- `src/ts/model/ooba.ts` — Type-only schema for the large Oobabooga sampler surface (`src/ts/model/ooba.ts:1`).

- `src/ts/process/models/nai.ts` — `stringlizeNAIChat()` creates NovelAI’s plain-text prompt (`src/ts/process/models/nai.ts:5`); `NovelAIBadWordIds` begins at `src/ts/process/models/nai.ts:72`.

- `src/ts/process/models/modelString.ts` — `getGenerationModelString()` produces user-visible generation labels, including bound presets, OpenRouter, reverse proxy, and NanoGPT (`src/ts/process/models/modelString.ts:3`).

- `src/ts/process/models/local.ts` — three lines. `tokenizeGGUFModel()` is deliberately unsupported and always throws (`src/ts/process/models/local.ts:1`).

- `src/ts/horde/getModels.ts` — `getHordeModels()` caches the Horde worker/model status list (`src/ts/horde/getModels.ts:19`).

### In-browser inference

- `src/ts/process/transformers.ts` — Lazily loads `@huggingface/transformers`, configures browser/asset caching, and exposes text generation, summarization, embeddings, image captioning, VITS, and ONNX registration:
  - Initialization at `src/ts/process/transformers.ts:9`.
  - `runTransformers()` at `src/ts/process/transformers.ts:38`.
  - `runEmbedding()` at `src/ts/process/transformers.ts:61`.
  - `runVITS()` at `src/ts/process/transformers.ts:112`.
  - `registerOnnxModel()` at `src/ts/process/transformers.ts:150`.

- `src/ts/process/webllm.ts` — Maintains a single `@mlc-ai/web-llm` engine for memory summarization:
  - `chatCompletion()` at `src/ts/process/webllm.ts:10`.
  - `unloadEngine()` at `src/ts/process/webllm.ts:55`.

### Local-network transport helpers

- `src/ts/network/localNetwork.ts` — Recognizes localhost, `.local`, single-label Docker/LAN names, private IPv4, and local IPv6 (`src/ts/network/localNetwork.ts:74`); `isLocalNetworkUrl()` safely parses URLs at `src/ts/network/localNetwork.ts:104`.

- `src/ts/network/proxyJobWs.ts` — Defines and parses WebSocket proxy-job events, decodes base64 chunks, and normalizes timeout errors (`src/ts/network/proxyJobWs.ts:1`, `src/ts/network/proxyJobWs.ts:9`, `src/ts/network/proxyJobWs.ts:21`).

- Colocated tests cover binding/message interchange, cumulative stream pumping, Anthropic cache boundaries, durable job fallback/reattachment/recovery, request logging, local-host classification, and WebSocket proxy-event decoding. The server recorder is covered by `server/node/model-jobs.test.ts`.

## 3. Architecture & data flow

### Model identity and selection

1. UI and persisted settings use `LLMModel.id`; provider requests normally use `internalID` (`src/ts/model/types.ts:96`).
2. `provider` controls grouping/display and some settings visibility. It does not select the wire implementation.
3. `format` is the actual dispatch key used by `requestChatDataMain()` (`src/ts/process/request/request.ts:458`).
4. `parameters` is an allowlist: only listed sampling fields are copied from database settings by `applyParameters()` (`src/ts/process/request/shared.ts:148`).
5. `tokenizer` directs context estimation elsewhere in the application.
6. `flags` drive compatibility transformations and provider-specific behavior. Important examples include:
   - System-role folding: `hasFullSystemPrompt` and `hasFirstSystemPrompt` (`src/ts/process/request/request.ts:292`).
   - Same-role merging and user-first insertion (`src/ts/process/request/request.ts:313`, `src/ts/process/request/request.ts:355`).
   - OpenAI `developer` role and `max_completion_tokens` (`src/ts/process/request/openAI/requests.ts:219`, `src/ts/process/request/openAI/requests.ts:392`).
   - DeepSeek prefix/reasoning fields (`src/ts/process/request/openAI/requests.ts:149`).
   - Gemini accepted modalities, thinking, and safety settings (`src/ts/process/request/google.ts:89`, `src/ts/process/request/google.ts:322`, `src/ts/process/request/google.ts:334`).
   - Anthropic adaptive thinking (`src/ts/process/request/anthropic.ts:362`).

`getModelInfo()` first clones a static registry entry. It then recognizes arbitrary Hugging Face IDs (`hf:::`), Horde IDs (`horde:::`), database custom models (`xcustom:::`), and plugin models (`pluginmodel:::`), finally falling back to an unknown OpenAI-compatible model (`src/ts/model/modellist.ts:697`).

For classic calls, the main mode uses `db.aiModel`; every other mode initially uses `db.subModel`. When separate auxiliary models are enabled, `db.seperateModels[mode]` overrides that choice (`src/ts/process/request/request.ts:414`).

For preset calls, `resolveChatModelBinding()` runs before any classic model lookup. A global lock can force legacy or preset mode; otherwise `chat.useModelPreset` selects the regime. Main uses the binding’s main slot; sub/aux calls use sub unless `separateAux` has a resolvable task override. A supplied `moduleId` can bind a module-defined ModelPreset without routing through the classic registry (`src/ts/process/request/modelPresetBinding.ts:42`).

### Top-level request flow

1. Chat generation calls `requestChatData()` with normalized history, generation ID, streaming preference, biases, and tools.
2. `requestChatData()`:
   - Loads the per-mode classic fallback list.
   - Resolves MCP tools once.
   - Runs pre-request plugin replacers and the character `request` trigger for each retry attempt.
   - Calls `requestChatDataMain()`.
   - Applies after-request replacers, banned-character retries, blank-response fallback, overload retry behavior, and retry limits (`src/ts/process/request/request.ts:136`).
3. `requestChatDataMain()` resolves preset versus classic selection. The classic branch populates default temperature/token/streaming fields, clones history, calls `reformater()`, and dispatches by `LLMFormat`; the preset branch normalizes from preset toggles inside `requestModelPreset()` (`src/ts/process/request/request.ts:388`).
4. The switch at `src/ts/process/request/request.ts:458` routes classic requests by `LLMFormat`.
5. Every implementation returns `success`, `fail`, `streaming`, or `multiline` through `requestDataResponse`. The public streaming contract is cumulative `{key: fullTextSoFar}` snapshots, even when the provider/adapters internally emit deltas.

Each `db.fallbackModels[mode]` entry is supplied as `staticModel`, deliberately skipping per-chat preset binding and separate-model selection. Current loop ordering has an important defect: when the configured fallback list is non-empty, those classic model IDs run but the appended primary-model sentinel is skipped, so the primary preset/classic selection is never attempted. With no configured fallbacks, the primary selection runs normally. `ModelPreset.fallbackModelPresetIds` has no request-path consumer.

### OpenAI-compatible family

`requestOpenAI()` first converts images into `image_url` content and restores persisted `<tool_call>` markers into assistant/tool messages (`src/ts/process/request/openAI/requests.ts:41`, `src/ts/process/request/openAI/requests.ts:108`). It removes PocketRisu-only fields, applies DeepSeek metadata, resolves the actual wire model ID, applies the model’s parameter allowlist, and adds tool schemas (`src/ts/process/request/openAI/requests.ts:206`, `src/ts/process/request/openAI/requests.ts:444`).

Endpoint/key behavior is selected from the model ID:

- OpenAI defaults to `/v1/chat/completions`.
- OpenRouter and NanoGPT use dedicated endpoints.
- `reverse_proxy` and `xcustom:::` use database URL/key values.
- A model-level `endpoint` overrides the URL.
- A model-level `keyIdentifier` reads `db.OaiCompAPIKeys[keyIdentifier]` (`src/ts/process/request/openAI/requests.ts:492`, `src/ts/process/request/openAI/requests.ts:523`).

Non-streaming uses `globalFetch()` and parses JSON. Streaming uses `fetchNative()`, validates status and `text/event-stream`, pipes bytes through `getTranStream()`, and wraps the stream for tool execution (`src/ts/process/request/openAI/requests.ts:555`).

OpenAI-compatible SSE chunks are converted into cumulative snapshots such as `{ "0": "full text so far" }`. The parser separately accumulates reasoning and partial tool-call arguments (`src/ts/process/request/openAI/requests.ts:1131`).

The Responses API is a separate, non-streaming request builder: chat turns become typed `input_text`, `output_text`, image, and file items; it sends `max_output_tokens` to `/v1/responses`. This classic path does not attach or execute MCP tools (`src/ts/process/request/openAI/requests.ts:926`).

### Anthropic and Bedrock family

`requestClaude()` extracts the leading system prompt, forces alternating `user`/`assistant` messages, converts image data URLs to Anthropic base64 blocks, and restores persisted tool history (`src/ts/process/request/anthropic.ts:96`, `src/ts/process/request/anthropic.ts:208`, `src/ts/process/request/anthropic.ts:271`).

The body uses `modelInfo.internalID`, `messages`, `system`, `max_tokens`, and optionally `thinking`. Cache markers on user/assistant turns, and on system messages that occur after chat has begun, become Anthropic `cache_control` entries. A cache marker on the extracted leading classic system prompt is lost because that prompt becomes a plain `system` string (`src/ts/process/request/anthropic.ts:145`, `src/ts/process/request/anthropic.ts:239`).

Ordinary Anthropic calls use `x-api-key`, `anthropic-version`, optional beta headers, and JSON or SSE (`src/ts/process/request/anthropic.ts:551`). Streaming converts text, thinking, and redacted-thinking blocks into cumulative output with `<Thoughts>` wrappers (`src/ts/process/request/anthropic.ts:818`). The classic recursive tool loop is implemented only for the non-streaming response path.

When Claude batching is enabled, the requester submits `/batches`, polls status, can cancel on abort, and streams the eventual batch result back through the request contract (`src/ts/process/request/anthropic.ts:610`).

Bedrock models use `accessKeyId:secretAccessKey:region`, generate a region/global model path, add `anthropic_version`, and sign the request with AWS Signature V4 (`src/ts/process/request/anthropic.ts:392`). Bedrock streaming is explicitly disabled in this implementation (`src/ts/process/request/anthropic.ts:406`).

### Gemini AI Studio and Vertex family

`requestGoogleCloudVertex()` maps roles to Gemini’s `user`/`model` vocabulary, emits `inlineData` only for modalities allowed by model flags, and restores Gemini function-call history (`src/ts/process/request/google.ts:72`).

The body contains `contents`, `generation_config`, safety settings, optional `systemInstruction`, and function declarations (`src/ts/process/request/google.ts:342`). Parameter names are translated to Gemini camelCase; Gemini 3 converts the legacy thinking-token control into coarse `thinkingLevel` values (`src/ts/process/request/google.ts:376`).

AI Studio uses the API key in the query string. Vertex uses a service-account JWT exchange, caches the OAuth token in the database, and selects regional or global endpoints (`src/ts/process/request/google.ts:446`, `src/ts/process/request/google.ts:537`, `src/ts/process/request/google.ts:557`).

Both JSON and SSE responses preserve thought text, function calls, and thought signatures. Streamed tool calls are executed after the first stream finishes, then generation resumes with the prior signature echoed back (`src/ts/process/request/google.ts:1010`, `src/ts/process/request/google.ts:1101`).

### Other legacy formats

- NovelAI stringifies chat into one completion prompt and sends NovelAI sampler settings and token bans (`src/ts/process/request/request.ts:1152`).
- NovelList sends its dedicated NovelList request shape, while the developer-only Echo format returns the configured echo message without a provider call (`src/ts/process/request/request.ts:1423`, `src/ts/process/request/request.ts:1503`).
- Ooba legacy supports a bespoke WebSocket stream; the newer Ooba path calls `/v1/completions` (`src/ts/process/request/request.ts:1262`, `src/ts/process/request/request.ts:1401`).
- Plugins call a registered provider callback and adapt plugin streams to request chunks. The legacy `pluginProcess()` fallback is now only an error stub reporting that no provider was found (`src/ts/process/request/request.ts:1473`, `src/ts/plugins/plugins.svelte.ts:1872`).
- Kobold uses `/api/v1/generate` and renamed sampler fields (`src/ts/process/request/request.ts:1575`).
- Ollama uses the browser Ollama client and always requests a stream (`src/ts/process/request/request.ts:1726`).
- Cohere splits the final user message from `chat_history` and maps roles to `USER`, `CHATBOT`, and `SYSTEM` (`src/ts/process/request/request.ts:1774`).
- Horde submits an asynchronous job and polls its status every two seconds (`src/ts/process/request/request.ts:1906`).

### ModelPreset path

A `ModelPreset` carries a frozen profile snapshot containing adapter kind, endpoint, auth scheme, model ID, schema, defaults, capabilities, and limits. `requestModelPreset()` dispatches only three adapter kinds through `sendModelPreset()`, `streamModelPreset()`, and `previewModelPreset()` (`src/ts/process/request/request.ts:511`).

#### Configuration merge and wire ownership

`buildPreparedRequest()` composes generic ModelPreset configuration in increasing precedence:

1. `profileSnapshot.defaults`, then `bodyTemplate` at the top level; headers begin with `headerTemplate`.
2. Schema mappings, using an own `preset.userValues` value before the field default, write body paths, headers, and query parameters. Empty strings and unresolved values are skipped; `auth` and adapter-specific `custom` targets are not copied into the body.
3. `customBody` and `customHeaders`; the body override is a top-level assignment over the schema-built body.
4. `additionalParamsText`, whose legacy syntax can write nested body values, delete top-level body keys, and write/delete headers; it therefore overrides the structured custom fields.
5. Authentication, applied last: header-based schemes replace conflicting header names case-insensitively, while query authentication appends its key (`src/ts/preset/adapter/buildRequest.ts:15`, `src/ts/preset/adapter/auth.ts:5`).

Before that builder runs, an opted-in main request passes through `applyPromptPresetParams()`. It overlays only schema-declared sampling fields from the active prompt preset onto a copy of `userValues`, so those values beat the ModelPreset editor but still lose to `customBody` and `additionalParamsText`. Sub/aux requests, output-token caps, thinking settings, unsupported schema fields, and disabled classic slider sentinels are excluded (`src/ts/process/request/modelPresetBinding.ts:252`).

After the generic merge, each adapter reasserts its wire invariants: model selection, prompt messages or Gemini `contents`, system shape, streaming mode, and the caller-controlled tool surface. Model IDs resolve from `userValues`, then the schema default, then the frozen snapshot; a `customBody.model` collision cannot redirect the request. Likewise, freeform configuration cannot replace the normalized prompt or bypass the tool-off gate.

Credential resolution is:

1. `apiKeyRef` into `db.apiKeyPool`.
2. Inline string/object credential.
3. The first schema field mapped to `auth` (`src/ts/process/request/modelPresetBinding.ts:293`).

The path synthesizes classic role-normalization flags from preset toggles, optionally restores tool history, gates tools and images by adapter capabilities, and selects a proxy-aware or durable-job fetch implementation (`src/ts/process/request/request.ts:705`). Durable server jobs are opt-in (`nodeOnlyServerSideRequests`) and are bypassed for tool-bearing and preview requests, which always use the direct/proxied transport. A preset-bound module request is resolved through the same path.

Tool requests are forced non-streaming and run through an eight-step loop. A `toolExecuted` result bypasses outer success retries so side-effecting tools cannot be replayed (`src/ts/process/request/request.ts:213`, `src/ts/process/request/request.ts:1077`).

Streaming adapters yield deltas. `pumpPresetStream()` accumulates response and reasoning text, throttles renderer updates to 50 ms, respects backpressure, and guarantees a final cumulative flush (`STREAM_FLUSH_INTERVAL_MS` in `src/ts/process/request/request.ts`; `pumpPresetStream()` in `src/ts/process/request/presetStreamPump.ts`). Decoupled streaming drains the same wire stream and returns one final string.

#### Anthropic prompt-cache breakpoints

`toAdapterMessage()` preserves `OpenAIChat.cachePoint`; when a persisted tool marker expands to several adapter messages, `expandAdapterMessages()` moves the boundary to the last expanded message. The Anthropic adapter supports at most four breakpoints:

- A flagged system prefix is sent as a content block with `cache_control` and consumes one breakpoint.
- The remaining budget keeps the latest flagged chat turns, because they represent the deepest reusable prefixes.
- The marker is placed on the selected turn's last content block; selected tool-result blocks are annotated while consecutive results are collected into the required user turn.
- The default control is `{type: 'ephemeral'}`. With `claude1HourCaching`, the adapter adds `ttl: '1h'` and supplies the legacy beta header only when the profile did not already set one.

Preview and tool-loop requests pass the same TTL/cache-boundary options as ordinary sends. This behavior is specific to the ModelPreset Anthropic adapter; the classic requester neither preserves a leading system marker nor caps user-selected markers to Anthropic's four-breakpoint limit.

#### Gemini `cachedContents` boundaries and lifecycle

Gemini explicit context caching participates only when `promptCaching.enabled` is set on a native `google-gemini` ModelPreset whose snapshot explicitly advertises `cache`. The request must be a main, non-preview, tool-free call with a real chat ID and either AI Studio API-key or Vertex service-account authentication. A separate proxy-aware fetch carries cache housekeeping so it never becomes a durable model job or a chat request-log entry (`src/ts/process/request/request.ts:807`).

The adapter maps `OpenAIChat.cachePoint` onto Gemini's emitted `contents`, after consecutive tool results have been collapsed into their wire turn. Gemini accepts one continuous cached prefix, so the last/deepest marked content wins. If only hoisted system messages are marked, the boundary is zero: the cache owns `systemInstruction` but no chat contents. Without a surviving boundary, caching is bypassed (`toGeminiContents()` in `src/ts/preset/adapter/googleGemini.ts`).

Transient references are keyed by chat, task, and preset and mirrored to `localStorage`, not the database. Before a request, the cache layer validates expiry, model, configured-credential fingerprint, stored boundary, and a hash of `systemInstruction` plus the stored contents prefix. A valid hit adds `cachedContent`, sends only contents after the stored boundary, and removes fields already owned by the cache. A hit whose suffix would be empty is sent uncached because Gemini requires non-empty `contents` (`evaluateGeminiCacheBeforeRequest()` and `applyGeminiCacheToBody()` in `src/ts/preset/cache/geminiContextCache.ts`).

An eligible miss sends the full request first. After a successful JSON response or completed stream, reported prompt usage drives detached lifecycle work: by default a prompt below 4,096 tokens is ignored; otherwise the system instruction and contents through the current boundary are created with a 600-second TTL. With the default extension option enabled, a hit patches its TTL when less than half remains; it replaces the resource only when the boundary advances and observed prompt growth reaches the default 4,096-token threshold. The old resource is deleted only after its replacement is registered, and a per-key generation guard prevents stale asynchronous work from resurrecting or overwriting newer state (`decideGeminiCacheAfterResponse()` in `src/ts/preset/cache/geminiContextCache.ts`; `runPostResponse()` in `src/ts/preset/cache/geminiCacheWiring.ts`).

Prefix changes delete the local and remote entry; three consecutive prefix mismatches disable caching for that chat/preset session. If Gemini rejects an applied cache with 403 or 404, the adapter removes it and retries that chat call once without `cachedContent`. A 403 while creating a cache also disables the session; other create/patch/delete failures only skip cache work. AI Studio and Vertex derive different collection/model resource shapes from the prepared chat URL, and Vertex TTL patches add `updateMask=ttl` (`createGeminiCachedContentsClient()` in `src/ts/preset/cache/geminiContextCache.ts`).

#### Durable server-side generation

`nodeOnlyServerSideRequests` defaults to true. For a non-preview ModelPreset request with no active tools, `requestModelPreset()` replaces the ordinary fetch with `makeJobFetch()`:

1. The client posts the fully prepared upstream URL, headers, and string body to `/api/model-jobs`. Main calls use the real `Chat.id` and generation UUID; ModelPreset auxiliary calls use their own UUID and `kind: 'aux'`.
2. The Express server performs the provider request, appends the raw bytes to a journal, and continues consuming upstream after the browser disconnects. It stores only non-sensitive metadata in `save/model-jobs.db`; provider headers and bodies remain memory-only.
3. The client reads `/api/model-jobs/:id/stream`, which replays from byte zero and then live-tails the same journal. The adapter therefore receives a normal provider-like `Response` for both streaming and JSON calls; the server never parses the provider format.
4. A broken tail reattaches with exponential backoff. Each new stream replays from zero, so `makeJobFetch()` skips already-delivered bytes. It gives up after five attempts per cycle or three cycles with no progress.
5. EOF is accepted only after `/api/model-jobs/:id` reports `done`. Completed and live-observed failed jobs are claimed; abort deletes the job and stops the upstream request.

Only main jobs participate in the server's one-running-job-per-chat guard and recovery lists. Auxiliary jobs use the reconnectable transport while their browser pipeline is alive but are never decoded into chat messages. Tool loops remain browser-bound because replaying a side-effecting tool turn would be unsafe; previews also bypass jobs. Network failure or a non-409 job-creation rejection falls back to `makeProxiedFetch()`, supporting older servers. A `409` surfaces as `ModelJobBusyError`, and after a job exists no direct fallback is allowed because it would duplicate generation.

The server marks jobs left running across a server restart as failed because their in-memory credentials and upstream sockets cannot be restored. Terminal rows/journals are rotated by age and count while unclaimed main responses receive retention preference. Pending-send tombstones live in the same SQLite database but contain no prompt or response data; they cover browser-pipeline death before a recoverable main job exists.

#### Recovery after browser loss

`initModelJobRecovery()` runs discovery at boot, when the page becomes visible, and on `online`. Unclaimed terminal main jobs are decoded with the same OpenAI-compatible, Anthropic, or Gemini JSON/SSE parsers used by live adapters. Recovery matches `generationInfo.generationId` or message `chatId`, fills a shorter partial message or inserts a new one, explicitly saves the chat row, records provider usage, and only then claims the job. This ordering makes retries idempotent and avoids losing a response when persistence fails.

A still-running main job creates a `background` entry in the per-chat generation map and is polled with a 3-to-15-second backoff, up to a 65-minute deadline. It blocks a duplicate send for that chat without setting the legacy global `doingChat`; Stop deletes the server job. Recovery saves raw adapter-decoded text and deliberately does not replay live-pipeline scripts, triggers, TTS, translation, inlay handling, or auto-continue.

#### Request logging and usage

Request logging defaults on. Tagged classic calls are recorded by `globalFetch()` or a scoped `fetchNative()` wrapper; untagged asset/polling/plugin traffic is intentionally excluded. ModelPreset requests create one scope around whichever transport is selected. Scoped logs record direct, `/proxy2`, WebSocket-proxy, or `job` route, request/response metadata, and text bodies while stripping inline base64 media. Streaming responses are teed so logging does not consume the provider branch. Recovered jobs synthesize the same category of log entry after their chat row is durable.

Adapters attach authoritative usage when providers report it:

- OpenAI-compatible parses prompt/completion totals plus cached and reasoning detail fields. Streaming usage requires the opt-in `requestLogStreamUsage`, which adds `stream_options: {include_usage: true}`; it is disabled by default because strict compatible servers may reject the field.
- Anthropic merges input/cache usage from `message_start` with output usage from `message_delta`; cache reads and writes are folded into prompt tokens, with reads also exposed as cached tokens.
- Gemini reads `usageMetadata`, including cached-content token counts.

The ModelPreset request-status display counts live text with fixed local tiktoken via `encodeWithTokenizer(..., 'tik')`, avoiding model-selected network tokenizers, and replaces the approximate completion count with provider usage when available.

### Browser/proxy transport and WebSocket proxy jobs

Classic requests and ModelPreset requests that bypass durable jobs use two transport functions outside this directory:

- JSON-style `globalFetch()` chooses direct browser fetch only for local known hosts, `db.usePlainFetch`, or `plainFetchForce`; otherwise it uses a userscript fetch when available or `/proxy2` (`src/ts/globalApi.svelte.ts:1248-1256`).
- Stream-capable `fetchNative()` attempts direct fetch, then falls back to `/proxy2` on a CORS/network exception (`src/ts/globalApi.svelte.ts:1992`, `:2094`).

Explicit local-network routing changes the behavior:

1. `getLocalNetworkRequestOptions()` enables it only for recognized local URLs and classic OpenAI-compatible calls when local-network mode is enabled or forced (`src/ts/process/request/openAI/requests.ts:16`).
2. A streaming classic OpenAI request has the `openai_streaming` interceptor, so `fetchNative()` first creates `/proxy-stream-jobs` and opens the job WebSocket (`src/ts/globalApi.svelte.ts`).
3. WebSocket `upstream_headers` resolves a synthetic `Response`; `chunk` events enqueue decoded bytes; abort/cancel deletes the server job (`src/ts/globalApi.svelte.ts:2231`).
4. Job setup failure falls back to `/proxy2`.
5. Non-streaming local requests always use `/proxy2`.

`/proxy-stream-jobs` is an ephemeral local-network relay, not the durable ModelPreset system above. ModelPreset requests that bypass `/api/model-jobs` mark local URLs for server routing, but `makeProxiedFetch()` does not pass the `openai_streaming` interceptor. They therefore use `/proxy2`, not the WebSocket proxy-job path (`src/ts/process/request/request.ts:558`).

## 4. Entry points & dependencies

### Incoming edges

- Main chat generation calls `requestChatData()` at `src/ts/process/index.svelte.ts:1489` and consumes cumulative stream snapshots in the streaming branch beginning near `src/ts/process/index.svelte.ts:1529`.
- Stable Diffusion prompt generation, scripting, triggers, MCP AI access, translation, memory, suggestions, and playground tools also call `requestChatData()`.
- Boot starts dynamic Google/Anthropic discovery at `src/ts/bootstrap.ts:390`.
- Boot calls `initModelJobRecovery()` at `src/ts/bootstrap.ts:405`; later visibility and online events repeat the idempotent discovery pass.
- Model selectors call `getModelList()` and `getModelInfo()` at `src/lib/UI/ModelList.svelte:45`.
- Horde’s dynamic list is rendered at `src/lib/UI/ModelList.svelte:154`.
- Bot settings fetch NanoGPT and OpenRouter catalogs at `src/lib/Setting/Pages/BotSettings.svelte:256` and `src/lib/Setting/Pages/BotSettings.svelte:281`.
- Tokenization and multimodal support query `getModelInfo()` to select tokenizer and feature behavior.

### Outgoing edges

- Database state supplies selected model IDs, API keys, sampling controls, custom formats, fallbacks, and ModelPresets.
- Prompt templates and stringlizers flatten chat for completion-only providers.
- MCP provides tool definitions, invocation, and persistent `<tool_call>` encoding.
- Inlay storage persists Gemini-generated images/audio and thought signatures.
- Plugins can transform prompts/results or provide complete model implementations.
- `globalFetch()`/`fetchNative()` provide logging, interception, timeout, direct-fetch, and proxy behavior.
- `makeJobFetch()` and `server/node/model-jobs.cjs` provide durable ModelPreset transport, while `jobRecovery.ts` hydrates/saves recovered chats and publishes recovered usage.
- `src/ts/requestLog.ts` and the server request-log API retain request bodies, response bodies, routes, and token usage when logging is enabled.
- The preset path calls `src/ts/preset/adapter/`, whose concrete send entry points are OpenAI-compatible (`src/ts/preset/adapter/openaiCompatible.ts:49`), Anthropic (`src/ts/preset/adapter/anthropicMessages.ts:64`), and Gemini (`src/ts/preset/adapter/googleGemini.ts:81`).
- Browser-local code depends on `@huggingface/transformers`, `@mlc-ai/web-llm`, Cache Storage, IndexedDB-backed assets, WebGPU/WASM, and Web Audio.

## 5. Conventions & gotchas

- `id` is PocketRisu’s persisted identity; `internalID` is normally the provider’s wire model. Do not replace a stable `id` just because a provider renamed the wire model.

- `LLMProvider` and `LLMFormat` are separate axes. OpenRouter, custom APIs, and DeepInfra can all use OpenAI-compatible format without being OpenAI providers.

- The numeric values of `LLMFlags`, `LLMFormat`, and `LLMTokenizer` are persisted in custom-model/database structures (`src/ts/storage/database.svelte.ts:1365`). Append new constants with new numbers; never renumber existing values.

- Flags are not uniformly enforced capability checks. `hasStreaming`, for example, controls settings visibility (`src/lib/Setting/Pages/BotSettings.svelte:311`) but the dispatcher does not centrally reject streaming for an unflagged model. Several historical flags have little or no active runtime consumption.

- `db.enableCustomFlags` replaces, rather than merges with, the selected static model’s entire flag array (`src/ts/model/modellist.ts:695`).

- The static registry’s module-initialization pass automatically creates:
  - Responses API twins for `provider === OpenAI && format === OpenAICompatible`.
  - Vertex Gemini twins for static `GoogleCloud` entries.

  This occurs before `registerModelDynamic()`, so dynamically discovered Google models do not receive Vertex twins (`src/ts/model/modellist.ts:551`).

- Avoid duplicate `id` values. `getModelInfo()` uses the first matching entry, making later duplicates unreachable even when their `internalID` differs. The static OpenAI catalog currently contains two `gpt-5` entries, so the dated wire variant behind the second entry cannot be selected by that ID.

- Dynamically discovered Google records retain the API's `models/...` prefix in `internalID`, while the classic requester prepends `models/` again. A dynamically added model can therefore produce a `models/models/...` URL. The discovery path also assigns vision/audio/video/thinking flags uniformly instead of deriving advertised capabilities.

- Calling ungrouped `getModelList()` pushes plugin models into the shared `LLMModels` array (`src/ts/model/modellist.ts:819`). Repeated ungrouped calls can duplicate plugin entries; do not assume the registry array is immutable.

- `reformater()` mutates message objects while merging roles. Both classic and preset paths clone before calling it; preserve that protection during retries (`requestChatDataMain()` and `requestModelPreset()` in `src/ts/process/request/request.ts`).

- Streaming consumers assume each chunk contains the full accumulated text, not a token delta. `collectStreamingText()` explicitly keeps only the last snapshot (`src/ts/process/request/shared.ts:128`).

- Classic OpenAI-compatible streaming defensively accepts either delta fragments or cumulative fragments through `appendStreamingFragment()`. ModelPreset adapters have an explicit delta contract and `pumpPresetStream()` owns accumulation; do not move accumulation into both layers.

- The classic Ooba WebSocket path enqueues a cumulative raw string rather than the required object, and classic Ollama enqueues each individual chunk rather than accumulated text (`requestOobaLegacy()` and `requestOllama()` in `src/ts/process/request/request.ts`). These are exceptions to the normal stream contract and can produce incorrect final-state behavior in consumers that replace the message with each chunk.

- The classic Anthropic SSE loop rewinds its event index and restores `prevText` before each enqueue. It therefore publishes one parsed event behind and can omit the final text event when the stream ends without a separate thinking close. The ModelPreset Anthropic parser/pump does not share this loop.

- Classic OpenAI, Anthropic, and Gemini implement tool loops independently. ModelPreset uses the shared adapter `runToolLoop`. Changes to tool behavior often need implementation and tests in both regimes.

- A completed ModelPreset tool call must retain `toolExecuted`; otherwise banned-character, blank-response, or plugin-replacer retries can execute the tool twice (`src/ts/process/request/request.ts:213`).

- `ModelPreset.fallbackModelPresetIds` is declared but has no request-path consumer. Runtime fallback reads only legacy `db.fallbackModels`; when that list is non-empty, the current loop skips the primary model entirely because it skips the appended empty sentinel after the first iteration (`requestChatData()` in `src/ts/process/request/request.ts`).

- Additional parameters support nested body paths, typed `json::` values, `header::Name`, and deletion with `{{none}}` (`src/ts/process/request/shared.ts:65`). An `anthropic-beta` supplied this way suppresses automatic beta construction (`src/ts/process/request/anthropic.ts:386`).

- `previewBody` includes prepared authorization headers for classic and preset requests. Treat previews and fetch logs as secret-bearing data.

- The `globalFetch()` JSON log path calls `recordRequestLog()` with already-stringified bodies and bypasses the scoped logger's inline-media redaction. A non-streaming classic multimodal request can therefore persist base64 payloads in request logs.

- Classic Responses API preview returns before `db.modelTools` appends `web_search_preview`, so a preview can omit a built-in search tool that the real request sends. This path does not attach or execute MCP tools.

- Classic Anthropic does not preserve a cache point on the leading extracted system string and does not enforce the provider's four-breakpoint maximum. The ModelPreset Anthropic adapter handles both cases.

- `nodeOnlyServerSideRequests` affects only ModelPreset adapter calls. Classic providers continue to use their existing `globalFetch()`/`fetchNative()` paths, including the unrelated `/proxy-stream-jobs` WebSocket relay for local OpenAI-compatible streaming.

- Once `/api/model-jobs` creation succeeds, a connection failure must reattach or leave the main job for discovery; falling back to a new direct provider request would duplicate generation. Creation-time `409` has the same no-fallback rule.

- Model-job journals contain raw provider bytes, not post-processed chat text. Recovery intentionally cannot reproduce edit-output scripts and other live side effects, and server-side code must not begin interpreting provider SSE/JSON.

- Tiktoken and web-tokenizer loaders use keyed promise caches (`tikParsers`, `tokenizersByType`). A single mutable parser slot races concurrent auxiliary/main counts for different models and can free a WASM parser still in use; failed cached loads must remain evictable for retry.

- Classic key precedence is provider-specific:
  - OpenAI family: `arg.key`, then provider/database key, then model `keyIdentifier` override.
  - Anthropic: `arg.key || reverse-proxy/Anthropic key`.
  - Gemini: `arg.key || db.google.accessToken`; Vertex uses cached service-account OAuth.
  - Bedrock expects a colon-delimited access key, secret, and region.

- Catalog helpers for OpenRouter, NanoGPT, and Horde use browser `fetch()` directly and return empty results on errors. They do not share request logging or `/proxy2` behavior.

- The provider named `WebLLM` in the legacy model registry does not call `src/ts/process/webllm.ts`. `requestWebLLM()` actually runs the Hugging Face Transformers text-generation pipeline (`src/ts/process/request/request.ts:2011`). The MLC WebLLM engine is used by Hypa memory summarization.

- Transformers “local” inference still downloads model artifacts. The default model path is `https://sv.risuai.xyz/transformers/`, with Cache Storage or PocketRisu asset IDs supplying cached/custom files (`src/ts/process/transformers.ts:13`).

- Horde cancellation covers only the initial submission. Status polling does not pass the abort signal and has no abort check (`requestHorde()` in `src/ts/process/request/request.ts`).

- Local-network classification intentionally treats any single-label hostname as local for Docker/LAN deployments (`src/ts/network/localNetwork.ts:88`). The WebSocket job server independently revalidates the target before connecting.

- The proxy-job relay and durable model-job APIs exist in the Node Express server. No corresponding `/proxy2`, `/proxy-stream-jobs`, `/api/model-jobs`, or `/api/pending-sends` routes were found under `server/hono/`.

## 6. Navigation hints

- To add an OpenAI model, add an `LLMModel` entry to `OpenAIModels` (`src/ts/model/providers/openai.ts:3`). Set a unique stable `id`, the provider’s wire `internalID`, `OpenAICompatible` format, correct flags, parameter allowlist, and tokenizer.

- To add an Anthropic model, add it to `AnthropicModels` (`src/ts/model/providers/anthropic.ts:3`). Both `Anthropic` and the historically named `AnthropicLegacy` currently dispatch through the Messages requester; choose the existing catalog convention and verify flags rather than assuming `AnthropicLegacy` selects a completion endpoint.

- To add a Gemini model, add it to `GoogleModels` (`src/ts/model/providers/google.ts:3`). Its static AI Studio entry automatically receives a Vertex twin at `src/ts/model/modellist.ts:564`.

- To add a model to an existing provider without changing its protocol, do not touch the dispatcher. Add metadata to the relevant provider array and verify `format`, flags, parameter support, and `internalID`.

- To add a simple OpenAI-compatible provider, prefer an `LLMModel` with:
  - `format: LLMFormat.OpenAICompatible`
  - `endpoint` for its chat-completions URL
  - `keyIdentifier` for `db.OaiCompAPIKeys`

  The URL/key hooks are consumed at `src/ts/process/request/openAI/requests.ts:496` and `src/ts/process/request/openAI/requests.ts:528`.

- Do not mark a third-party OpenAI-compatible service as `LLMProvider.OpenAI` merely for protocol compatibility; that provider value also causes automatic Responses API variants (`src/ts/model/modellist.ts:551`).

- To add a new wire protocol in the classic regime:
  1. Append an `LLMFormat` numeric constant (`src/ts/model/types.ts:50`).
  2. Add a request builder returning `requestDataResponse`.
  3. Add the new dispatch case in `requestChatDataMain()` (`src/ts/process/request/request.ts:458`).
  4. Add model metadata and any required key/database settings.
  5. Use `globalFetch()` for JSON and `fetchNative()` for streaming.
  6. Emit cumulative `{ "0": fullText }` stream snapshots.

- To support another static Anthropic- or Gemini-compatible host, note that their classic requesters do not consume `modelInfo.endpoint` or `keyIdentifier`. Use `xcustom:::`/reverse-proxy configuration, add explicit requester support, or define a ModelPreset profile instead.

- To add an ad hoc model using an existing classic format, inspect the `xcustom:::` resolution at `src/ts/model/modellist.ts:733` and dispatch setup at `src/ts/process/request/request.ts:432`.

- To change classic role/system normalization, edit `reformater()` (`src/ts/process/request/request.ts:301`) and check both classic metadata flags and the preset-toggle-to-flag mapping inside `requestModelPreset()`.

- To change shared sampler mapping or disabled-value behavior, edit `applyParameters()` (`src/ts/process/request/shared.ts:148`).

- To change custom body/header override syntax, edit `getAdditionalParameters()` and `applyAdditionalParameters()` (`src/ts/process/request/shared.ts:33`, `src/ts/process/request/shared.ts:65`).

- To change OpenAI-compatible request bodies, inspect model selection at `src/ts/process/request/openAI/requests.ts:206`, body construction at `src/ts/process/request/openAI/requests.ts:344`, and endpoint/key resolution at `src/ts/process/request/openAI/requests.ts:492`.

- To change OpenAI streaming or streamed tool handling, inspect `getTranStream()` and `wrapToolStream()` (`src/ts/process/request/openAI/requests.ts:1120`, `src/ts/process/request/openAI/requests.ts:1276`).

- To change classic Anthropic prompt caching, thinking, or Bedrock signing, inspect `src/ts/process/request/anthropic.ts`. ModelPreset cache conversion is separate in `src/ts/preset/adapter/anthropicMessages.ts`.

- To change Gemini thinking, modalities, safety, or Vertex authentication, inspect `src/ts/process/request/google.ts:89`, `src/ts/process/request/google.ts:299`, `src/ts/process/request/google.ts:376`, and `src/ts/process/request/google.ts:446`.

- To add a model/provider in the ModelPreset regime using an existing protocol, add a registry base-provider/profile pair using one of the adapter kinds declared at `src/ts/preset/types.ts:3`. No `LLMModels` entry is required.

- To add a fourth ModelPreset wire family, extend `AdapterKind`, implement send/stream/preview functions, add cases to all three wrappers at `src/ts/process/request/request.ts:511`, and add the matching recovery journal parser.

- To change per-chat preset selection, start at `resolveChatModelBinding()` (`src/ts/process/request/modelPresetBinding.ts:42`).

- To change generic ModelPreset merge precedence, edit `buildPreparedRequest()` (`src/ts/preset/adapter/buildRequest.ts:15`) and then verify each adapter's post-merge wire invariants.

- To change ModelPreset key precedence, edit `buildModelPresetCredential()` (`src/ts/process/request/modelPresetBinding.ts:293`).

- To change classic/preset tool-history interoperability or image extraction, edit `expandAdapterMessages()` and `toAdapterMessage()` (`src/ts/process/request/modelPresetMessages.ts:18`, `src/ts/process/request/modelPresetMessages.ts:112`).

- To tune preset streaming render frequency or backpressure behavior, inspect `STREAM_FLUSH_INTERVAL_MS` (`src/ts/process/request/request.ts:689`) and `pumpPresetStream()` (`src/ts/process/request/presetStreamPump.ts:109`).

- To change ModelPreset server routing or stream reattachment, inspect `makeJobFetch()` in `src/ts/process/request/jobFetch.ts`; to change recording, guards, retention, or route behavior, inspect `createModelJobs()` in `server/node/model-jobs.cjs`.

- To change recovery decoding or chat slot-in, inspect `decodeStreamingJournalDetailed()`, `recoverTerminalJob()`, and `attachRunningJob()` in `src/ts/process/request/jobRecovery.ts`. Keep recovery parsers aligned with live adapter parsers.

- To change request/usage logging, start at `createRequestLogScope()` in `src/ts/requestLog.ts` and the adapter `parseUsage` helpers. Streaming OpenAI usage opt-in is set in `prepareOpenAiBody()`.

- To change Anthropic ModelPreset cache breakpoints, inspect `toAdapterMessage()`/`expandAdapterMessages()` and `toAnthropicWireMessages()` in `src/ts/preset/adapter/anthropicMessages.ts`.

- To change Gemini ModelPreset cache boundaries or lifecycle, inspect `toGeminiContents()` in `src/ts/preset/adapter/googleGemini.ts`, `evaluateGeminiCacheBeforeRequest()`/`decideGeminiCacheAfterResponse()` in `src/ts/preset/cache/geminiContextCache.ts`, and `beginGeminiCacheTurn()` in `src/ts/preset/cache/geminiCacheWiring.ts`.

- To change LAN detection, edit `isLocalNetworkHost()` (`src/ts/network/localNetwork.ts:74`) and keep the Node server’s independent validation aligned.

- To change WebSocket job event parsing or timeout messages, edit `src/ts/network/proxyJobWs.ts:1`; to change client job lifecycle, inspect `src/ts/globalApi.svelte.ts:2148`.

- To change browser-local chat generation, inspect `requestWebLLM()` (`src/ts/process/request/request.ts:2011`) and `runTransformers()` (`src/ts/process/transformers.ts:38`), not the MLC helper.

## 7. Related structure docs

- [Presets and profiles](presets-profiles.md) covers ModelPreset configuration, profile snapshots, chat/module bindings, credentials, and persistence.
- [Chat pipeline](chat-pipeline.md) covers the provider-neutral prompt and streaming consumer.
- [Server backend](server-backend.md) covers `/proxy2`, streaming jobs, authentication, and SSRF restrictions.
- [Scripting and extensions](scripting-extensions.md) covers plugin providers and MCP tool registration.
- [UI layer](ui-layer.md) covers provider/model selection and settings surfaces.
