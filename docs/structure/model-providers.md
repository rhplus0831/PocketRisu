# model-providers

> Part of the PocketRisu structure docs — see [STRUCTURE.md](../../STRUCTURE.md) for the top-level map and subsystem index.
> Audited 2026-07-25 against `c87235b0`; no subsystem-level drift found. Line numbers are approximate and drift as code changes; verify with `rg` before relying on them.

## 1. Purpose & overview

This subsystem turns PocketRisu’s normalized `OpenAIChat[]` prompt into provider-specific HTTP, SSE, WebSocket, polling, plugin, or in-browser inference calls. It supports two parallel selection regimes: the legacy global `LLMModel` registry and a per-chat `ModelPreset` adapter path.

In the legacy regime, `LLMModel.format` selects the wire protocol while `provider`, `flags`, `parameters`, and `tokenizer` supply UI, normalization, and request-building metadata. The preset regime instead uses a frozen provider-profile snapshot with one of three adapter families: OpenAI-compatible, Anthropic Messages, or native Gemini.

## 2. Key files

### Registry and model metadata

- `src/ts/model/types.ts` — about 133 lines. Defines the numeric metadata contracts:
  - `LLMFlags` capability/compatibility constants at `src/ts/model/types.ts:3`.
  - `LLMProvider` grouping constants at `src/ts/model/types.ts:30`.
  - `LLMFormat` wire-dispatch constants at `src/ts/model/types.ts:50`.
  - `LLMTokenizer` constants at `src/ts/model/types.ts:78`.
  - `LLMModel` at `src/ts/model/types.ts:96`.
  - `ProviderNames` at `src/ts/model/types.ts:112`.
  - Shared parameter allowlists at `src/ts/model/types.ts:131`.

- `src/ts/model/modellist.ts` — about 826 lines. Aggregates every legacy model and resolves persisted IDs:
  - `LLMModels` begins at `src/ts/model/modellist.ts:43`.
  - Static defaults for `shortName`, `internalID`, and `fullName` are filled at `src/ts/model/modellist.ts:545`.
  - OpenAI Responses API and Gemini Vertex variants are synthesized at `src/ts/model/modellist.ts:551`.
  - `registerModelDynamic()` discovers Google and Anthropic models at `src/ts/model/modellist.ts:578`.
  - `getModelInfo()` resolves static, `hf:::`, `horde:::`, `xcustom:::`, and `pluginmodel:::` IDs at `src/ts/model/modellist.ts:676`.
  - `getModelList()` filters/groups models for selectors at `src/ts/model/modellist.ts:778`.

- `src/ts/model/providers/openai.ts` — about 824 lines. `OpenAIModels` is the static OpenAI model catalog (`src/ts/model/providers/openai.ts:3`).

- `src/ts/model/providers/anthropic.ts` — about 399 lines. `AnthropicModels` contains current Messages API models and legacy completion-format Claude entries (`src/ts/model/providers/anthropic.ts:3`).

- `src/ts/model/providers/google.ts` — about 394 lines. `GoogleModels` contains Gemini model IDs, modality/thinking flags, and parameter allowlists (`src/ts/model/providers/google.ts:3`).

- `src/ts/model/providers/nanogpt.ts` — 15 lines. Centralizes NanoGPT chat, Responses, Messages, subscription, catalog, balance, and provider endpoints (`src/ts/model/providers/nanogpt.ts:5`).

### Request dispatch and provider wire formats

- `src/ts/process/request/request.ts` — about 1,934 lines. Main request coordinator:
  - `RequestDataArgumentExtended` at `src/ts/process/request/request.ts:77`.
  - `requestDataResponse` union at `src/ts/process/request/request.ts:89`.
  - `requestChatData()` retry/fallback wrapper at `src/ts/process/request/request.ts:120`.
  - `reformater()` role/system normalization at `src/ts/process/request/request.ts:285`.
  - `requestChatDataMain()` selection and `LLMFormat` dispatch at `src/ts/process/request/request.ts:372`.
  - ModelPreset adapter wrappers at `src/ts/process/request/request.ts:495`.
  - Proxy-aware preset fetch wrapper at `src/ts/process/request/request.ts:542`.
  - `requestModelPreset()` at `src/ts/process/request/request.ts:679`.
  - `testModelPreset()` at `src/ts/process/request/request.ts:927`.
  - Legacy provider implementations begin with NovelAI at `src/ts/process/request/request.ts:1022`, Ooba at `src/ts/process/request/request.ts:1129`, plugins at `src/ts/process/request/request.ts:1336`, Kobold at `src/ts/process/request/request.ts:1438`, Ollama at `src/ts/process/request/request.ts:1585`, Cohere at `src/ts/process/request/request.ts:1633`, Horde at `src/ts/process/request/request.ts:1763`, and browser-local generation at `src/ts/process/request/request.ts:1868`.

- `src/ts/process/request/openAI/requests.ts` — about 1,423 lines. OpenAI-compatible request family:
  - `requestOpenAI()` builds Chat Completions requests at `src/ts/process/request/openAI/requests.ts:35`.
  - `requestHTTPOpenAI()` handles JSON responses and recursive tool calls at `src/ts/process/request/openAI/requests.ts:629`.
  - `requestOpenAILegacyInstruct()` handles `/v1/completions` at `src/ts/process/request/openAI/requests.ts:858`.
  - `requestOpenAIResponseAPI()` builds `/v1/responses` input items at `src/ts/process/request/openAI/requests.ts:926`.
  - `getTranStream()` parses Chat Completions SSE at `src/ts/process/request/openAI/requests.ts:1116`.
  - `wrapToolStream()` executes streamed tool calls and resumes generation at `src/ts/process/request/openAI/requests.ts:1272`.

- `src/ts/process/request/openAI/types.ts` — about 88 lines. Wire types for Responses API items, multimodal content, and tool calls (`src/ts/process/request/openAI/types.ts:3`).

- `src/ts/process/request/openAI/index.ts` — one-line compatibility re-export at `src/ts/process/request/openAI/index.ts:1`.

- `src/ts/process/request/anthropic.ts` — about 1,108 lines. `requestClaude()` converts messages, images, cache points, reasoning, and tools to Anthropic or Bedrock form (`src/ts/process/request/anthropic.ts:71`); `requestClaudeHTTP()` handles Anthropic JSON/SSE and tool recursion (`src/ts/process/request/anthropic.ts:796`).

- `src/ts/process/request/google.ts` — about 1,345 lines. `requestGoogleCloudVertex()` formats Gemini `contents`, modalities, tools, safety, thinking, and authentication (`src/ts/process/request/google.ts:58`); `requestGoogle()` handles JSON/SSE responses and recursive function calls (`src/ts/process/request/google.ts:613`).

- `src/ts/process/request/shared.ts` — about 345 lines:
  - `LLMParameter` and `ModelModeExtended` at `src/ts/process/request/shared.ts:3`.
  - Custom body/header parsing at `src/ts/process/request/shared.ts:33`.
  - `collectStreamingText()` at `src/ts/process/request/shared.ts:128`.
  - `applyParameters()` at `src/ts/process/request/shared.ts:148`.

### ModelPreset bridge

- `src/ts/process/request/modelPresetBinding.ts` — about 298 lines:
  - `resolveChatModelBinding()` chooses classic versus preset and resolves main/sub/aux slots at `src/ts/process/request/modelPresetBinding.ts:42`.
  - `resolvePresetMaxOutputTokens()` at `src/ts/process/request/modelPresetBinding.ts:127`.
  - `resolveChatMaxResponseTokens()` at `src/ts/process/request/modelPresetBinding.ts:181`.
  - `applyPromptPresetParams()` at `src/ts/process/request/modelPresetBinding.ts:237`.
  - `buildModelPresetCredential()` at `src/ts/process/request/modelPresetBinding.ts:278`.

- `src/ts/process/request/modelPresetMessages.ts` — about 126 lines. Converts classic history into adapter messages:
  - `expandAdapterMessages()` restores persisted tool markers at `src/ts/process/request/modelPresetMessages.ts:18`.
  - `toolResponseText()` at `src/ts/process/request/modelPresetMessages.ts:104`.
  - `toAdapterMessage()` maps roles, cache points, and optional images at `src/ts/process/request/modelPresetMessages.ts:112`.

- `src/ts/process/request/presetStreamPump.ts` — about 177 lines:
  - `StreamFlushThrottle` at `src/ts/process/request/presetStreamPump.ts:24`.
  - `pumpPresetStream()` accumulates adapter deltas and emits throttled cumulative snapshots at `src/ts/process/request/presetStreamPump.ts:109`.

### Catalog helpers and specialized formats

- `src/ts/model/openrouter.ts` — about 146 lines. Fetches OpenRouter providers/models, derives pricing, and produces generic grid items:
  - `getOpenRouterProviders()` at `src/ts/model/openrouter.ts:33`.
  - `getOpenRouterModels()` at `src/ts/model/openrouter.ts:51`.
  - `toModelGridItem()` at `src/ts/model/openrouter.ts:108`.
  - `getFreeOpenRouterModels()` at `src/ts/model/openrouter.ts:139`.

- `src/ts/model/nanogpt.ts` — about 225 lines. Fetches NanoGPT balance, subscription state, provider choices, and model catalogs:
  - Account endpoints at `src/ts/model/nanogpt.ts:60` and `src/ts/model/nanogpt.ts:73`.
  - Per-model provider lookup at `src/ts/model/nanogpt.ts:125`.
  - Subscription model catalog at `src/ts/model/nanogpt.ts:137`.
  - Regular/personalized catalog at `src/ts/model/nanogpt.ts:162`.
  - Grid conversion at `src/ts/model/nanogpt.ts:194`.

- `src/ts/model/modelGrid.ts` — 19 lines. Provider-neutral model-card and pinned-item types (`src/ts/model/modelGrid.ts:2`).

- `src/ts/model/ooba.ts` — about 47 lines. Type-only schema for the large Oobabooga sampler surface (`src/ts/model/ooba.ts:1`).

- `src/ts/process/models/nai.ts` — about 389 lines. `stringlizeNAIChat()` creates NovelAI’s plain-text prompt (`src/ts/process/models/nai.ts:5`); `NovelAIBadWordIds` begins at `src/ts/process/models/nai.ts:72`.

- `src/ts/process/models/modelString.ts` — about 27 lines. `getGenerationModelString()` produces user-visible generation labels, including bound presets, OpenRouter, reverse proxy, and NanoGPT (`src/ts/process/models/modelString.ts:3`).

- `src/ts/process/models/local.ts` — three lines. `tokenizeGGUFModel()` is deliberately unsupported and always throws (`src/ts/process/models/local.ts:1`).

- `src/ts/horde/getModels.ts` — about 43 lines. `getHordeModels()` caches the Horde worker/model status list (`src/ts/horde/getModels.ts:19`).

### In-browser inference

- `src/ts/process/transformers.ts` — about 196 lines. Lazily loads `@huggingface/transformers`, configures browser/asset caching, and exposes text generation, summarization, embeddings, image captioning, VITS, and ONNX registration:
  - Initialization at `src/ts/process/transformers.ts:9`.
  - `runTransformers()` at `src/ts/process/transformers.ts:38`.
  - `runEmbedding()` at `src/ts/process/transformers.ts:61`.
  - `runVITS()` at `src/ts/process/transformers.ts:112`.
  - `registerOnnxModel()` at `src/ts/process/transformers.ts:150`.

- `src/ts/process/webllm.ts` — about 61 lines. Maintains a single `@mlc-ai/web-llm` engine for memory summarization:
  - `chatCompletion()` at `src/ts/process/webllm.ts:10`.
  - `unloadEngine()` at `src/ts/process/webllm.ts:55`.

### Local-network transport helpers

- `src/ts/network/localNetwork.ts` — about 112 lines. Recognizes localhost, `.local`, single-label Docker/LAN names, private IPv4, and local IPv6 (`src/ts/network/localNetwork.ts:74`); `isLocalNetworkUrl()` safely parses URLs at `src/ts/network/localNetwork.ts:104`.

- `src/ts/network/proxyJobWs.ts` — about 31 lines. Defines and parses WebSocket proxy-job events, decodes base64 chunks, and normalizes timeout errors (`src/ts/network/proxyJobWs.ts:1`, `src/ts/network/proxyJobWs.ts:9`, `src/ts/network/proxyJobWs.ts:21`).

- Tests are colocated in `modelPresetBinding.test.ts` (282 lines), `modelPresetMessages.test.ts` (164), `presetStreamPump.test.ts` (304), `shared.test.ts` (46), `localNetwork.test.ts` (55), and `proxyJobWs.test.ts` (37). They cover binding invariants, token caps, history interchange, cumulative streams, throttling/backpressure, local-host classification, and proxy event decoding.

## 3. Architecture & data flow

### Model identity and selection

1. UI and persisted settings use `LLMModel.id`; provider requests normally use `internalID` (`src/ts/model/types.ts:96`).
2. `provider` controls grouping/display and some settings visibility. It does not select the wire implementation.
3. `format` is the actual dispatch key used by `requestChatDataMain()` (`src/ts/process/request/request.ts:438`).
4. `parameters` is an allowlist: only listed sampling fields are copied from database settings by `applyParameters()` (`src/ts/process/request/shared.ts:148`).
5. `tokenizer` directs context estimation elsewhere in the application.
6. `flags` drive compatibility transformations and provider-specific behavior. Important examples include:
   - System-role folding: `hasFullSystemPrompt` and `hasFirstSystemPrompt` (`src/ts/process/request/request.ts:292`).
   - Same-role merging and user-first insertion (`src/ts/process/request/request.ts:313`, `src/ts/process/request/request.ts:355`).
   - OpenAI `developer` role and `max_completion_tokens` (`src/ts/process/request/openAI/requests.ts:219`, `src/ts/process/request/openAI/requests.ts:392`).
   - DeepSeek prefix/reasoning fields (`src/ts/process/request/openAI/requests.ts:149`).
   - Gemini accepted modalities, thinking, and safety settings (`src/ts/process/request/google.ts:89`, `src/ts/process/request/google.ts:322`, `src/ts/process/request/google.ts:334`).
   - Anthropic adaptive thinking (`src/ts/process/request/anthropic.ts:362`).

`getModelInfo()` first clones a static registry entry. It then recognizes arbitrary Hugging Face IDs (`hf:::`), Horde IDs (`horde:::`), database custom models (`xcustom:::`), and plugin models (`pluginmodel:::`), finally falling back to an unknown OpenAI-compatible model (`src/ts/model/modellist.ts:693`).

For classic calls, the main mode uses `db.aiModel`; every other mode initially uses `db.subModel`. When separate auxiliary models are enabled, `db.seperateModels[mode]` overrides that choice (`src/ts/process/request/request.ts:398`).

For preset calls, `resolveChatModelBinding()` runs before any classic model lookup. A global lock can force legacy or preset mode; otherwise `chat.useModelPreset` selects the regime. Main uses the binding’s main slot; sub/aux calls use sub unless `separateAux` has a resolvable task override (`src/ts/process/request/modelPresetBinding.ts:42`).

### Top-level request flow

1. Chat generation calls `requestChatData()` with normalized history, generation ID, streaming preference, biases, and tools.
2. `requestChatData()`:
   - Loads the per-mode classic fallback list.
   - Resolves MCP tools once.
   - Runs pre-request plugin replacers and the character `request` trigger.
   - Calls `requestChatDataMain()`.
   - Applies after-request replacers, banned-character retries, blank-response fallback, overload retry behavior, and retry limits (`src/ts/process/request/request.ts:120`).
3. `requestChatDataMain()` resolves preset versus classic selection, populates default temperature/token/streaming fields, clones history, and calls `reformater()` (`src/ts/process/request/request.ts:372`).
4. The switch at `src/ts/process/request/request.ts:442` routes by `LLMFormat`.
5. Every implementation returns `success`, `fail`, `streaming`, or `multiline` through `requestDataResponse` (`src/ts/process/request/request.ts:89`).

A fallback retry supplies `staticModel`, which deliberately skips per-chat preset binding and separate-model selection. Therefore a failing preset can eventually fall back to classic model IDs from `db.fallbackModels`, but not to `ModelPreset.fallbackModelPresetIds`.

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

The Responses API is a separate request builder: chat turns become typed `input_text`, `output_text`, image, and file items; it sends `max_output_tokens` to `/v1/responses` (`src/ts/process/request/openAI/requests.ts:926`).

### Anthropic and Bedrock family

`requestClaude()` extracts the leading system prompt, forces alternating `user`/`assistant` messages, converts image data URLs to Anthropic base64 blocks, and restores persisted tool history (`src/ts/process/request/anthropic.ts:96`, `src/ts/process/request/anthropic.ts:208`, `src/ts/process/request/anthropic.ts:271`).

The body uses `modelInfo.internalID`, `messages`, `system`, `max_tokens`, and optionally `thinking`. Prompt-cache markers become Anthropic `cache_control` entries (`src/ts/process/request/anthropic.ts:145`, `src/ts/process/request/anthropic.ts:350`).

Ordinary Anthropic calls use `x-api-key`, `anthropic-version`, optional beta headers, and JSON or SSE (`src/ts/process/request/anthropic.ts:551`). Streaming converts text, thinking, and redacted-thinking blocks into cumulative output with `<Thoughts>` wrappers (`src/ts/process/request/anthropic.ts:818`).

Bedrock models use `accessKeyId:secretAccessKey:region`, generate a region/global model path, add `anthropic_version`, and sign the request with AWS Signature V4 (`src/ts/process/request/anthropic.ts:392`). Bedrock streaming is explicitly disabled in this implementation (`src/ts/process/request/anthropic.ts:406`).

### Gemini AI Studio and Vertex family

`requestGoogleCloudVertex()` maps roles to Gemini’s `user`/`model` vocabulary, emits `inlineData` only for modalities allowed by model flags, and restores Gemini function-call history (`src/ts/process/request/google.ts:72`).

The body contains `contents`, `generation_config`, safety settings, optional `systemInstruction`, and function declarations (`src/ts/process/request/google.ts:342`). Parameter names are translated to Gemini camelCase; Gemini 3 converts the legacy thinking-token control into coarse `thinkingLevel` values (`src/ts/process/request/google.ts:376`).

AI Studio uses the API key in the query string. Vertex uses a service-account JWT exchange, caches the OAuth token in the database, and selects regional or global endpoints (`src/ts/process/request/google.ts:446`, `src/ts/process/request/google.ts:537`, `src/ts/process/request/google.ts:557`).

Both JSON and SSE responses preserve thought text, function calls, and thought signatures. Streamed tool calls are executed after the first stream finishes, then generation resumes with the prior signature echoed back (`src/ts/process/request/google.ts:1010`, `src/ts/process/request/google.ts:1101`).

### Other legacy formats

- NovelAI stringifies chat into one completion prompt and sends NovelAI sampler settings and token bans (`src/ts/process/request/request.ts:1022`).
- Ooba legacy supports a bespoke WebSocket stream; the newer Ooba path calls `/v1/completions` (`src/ts/process/request/request.ts:1129`, `src/ts/process/request/request.ts:1266`).
- Plugins call either a v2 provider function or the legacy plugin processor and adapt plugin streams to request chunks (`src/ts/process/request/request.ts:1336`).
- Kobold uses `/api/v1/generate` and renamed sampler fields (`src/ts/process/request/request.ts:1438`).
- Ollama uses the browser Ollama client and always requests a stream (`src/ts/process/request/request.ts:1585`).
- Cohere splits the final user message from `chat_history` and maps roles to `USER`, `CHATBOT`, and `SYSTEM` (`src/ts/process/request/request.ts:1633`).
- Horde submits an asynchronous job and polls its status every two seconds (`src/ts/process/request/request.ts:1763`).

### ModelPreset path

A `ModelPreset` carries a frozen profile snapshot containing adapter kind, endpoint, auth scheme, model ID, schema, defaults, capabilities, and limits. `requestModelPreset()` dispatches only three adapter kinds through `sendModelPreset()`, `streamModelPreset()`, and `previewModelPreset()` (`src/ts/process/request/request.ts:495`).

Credential resolution is:

1. `apiKeyRef` into `db.apiKeyPool`.
2. Inline string/object credential.
3. The first schema field mapped to `auth` (`src/ts/process/request/modelPresetBinding.ts:278`).

The path synthesizes classic role-normalization flags from preset toggles, optionally restores tool history, gates tools and images by adapter capabilities, and uses a proxy-aware fetch implementation (`src/ts/process/request/request.ts:694`, `src/ts/process/request/request.ts:770`).

Tool requests are forced non-streaming and run through an eight-step loop. A `toolExecuted` result bypasses outer success retries so side-effecting tools cannot be replayed (`src/ts/process/request/request.ts:189`, `src/ts/process/request/request.ts:817`).

Streaming adapters yield deltas. `pumpPresetStream()` accumulates response and reasoning text, throttles renderer updates to 50 ms, respects backpressure, and guarantees a final cumulative flush (`src/ts/process/request/request.ts:646`, `src/ts/process/request/presetStreamPump.ts:109`). Decoupled streaming drains the same wire stream and returns one final string (`src/ts/process/request/request.ts:870`).

### Direct fetch, `/proxy2`, and WebSocket jobs

Two transport functions outside this directory are central:

- JSON-style `globalFetch()` chooses direct browser fetch only for local known hosts, `db.usePlainFetch`, or `plainFetchForce`; otherwise it uses a userscript fetch when available or `/proxy2` (`src/ts/globalApi.svelte.ts:1256`).
- Stream-capable `fetchNative()` attempts direct fetch, then falls back to `/proxy2` on a CORS/network exception (`src/ts/globalApi.svelte.ts:2000`, `src/ts/globalApi.svelte.ts:2102`).

Explicit local-network routing changes the behavior:

1. `getLocalNetworkRequestOptions()` enables it only for recognized local URLs and classic OpenAI-compatible calls when local-network mode is enabled or forced (`src/ts/process/request/openAI/requests.ts:16`).
2. A streaming classic OpenAI request has the `openai_streaming` interceptor, so `fetchNative()` first creates `/proxy-stream-jobs` and opens the job WebSocket (`src/ts/globalApi.svelte.ts:2076`, `src/ts/globalApi.svelte.ts:2156`).
3. WebSocket `upstream_headers` resolves a synthetic `Response`; `chunk` events enqueue decoded bytes; abort/cancel deletes the server job (`src/ts/globalApi.svelte.ts:2231`).
4. Job setup failure falls back to `/proxy2`.
5. Non-streaming local requests always use `/proxy2`.

ModelPreset requests mark local URLs for server routing, but `makeProxiedFetch()` does not pass the `openai_streaming` interceptor. They therefore use `/proxy2`, not the WebSocket job path (`src/ts/process/request/request.ts:542`).

## 4. Entry points & dependencies

### Incoming edges

- Main chat generation calls `requestChatData()` at `src/ts/process/index.svelte.ts:1394` and consumes cumulative stream snapshots at `src/ts/process/index.svelte.ts:1431`.
- Stable Diffusion prompt generation, scripting, triggers, MCP AI access, translation, memory, suggestions, and playground tools also call `requestChatData()`.
- Boot starts dynamic Google/Anthropic discovery at `src/ts/bootstrap.ts:169`.
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
- The preset path calls `src/ts/preset/adapter/`, whose concrete entry points are OpenAI-compatible (`src/ts/preset/adapter/openaiCompatible.ts:49`), Anthropic (`src/ts/preset/adapter/anthropicMessages.ts:53`), and Gemini (`src/ts/preset/adapter/googleGemini.ts:78`).
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

- Avoid duplicate `id` values. `getModelInfo()` uses the first matching entry (`src/ts/model/modellist.ts:693`), making later duplicates unreachable even when their `internalID` differs.

- Calling ungrouped `getModelList()` pushes plugin models into the shared `LLMModels` array (`src/ts/model/modellist.ts:819`). Repeated ungrouped calls can duplicate plugin entries; do not assume the registry array is immutable.

- `reformater()` mutates message objects while merging roles. Both classic and preset paths clone before calling it; preserve that protection during retries (`src/ts/process/request/request.ts:414`, `src/ts/process/request/request.ts:780`).

- Streaming consumers assume each chunk contains the full accumulated text, not a token delta. `collectStreamingText()` explicitly keeps only the last snapshot (`src/ts/process/request/shared.ts:123`).

- The classic Ooba WebSocket path enqueues a raw string, and classic Ollama enqueues each individual chunk rather than accumulated text (`src/ts/process/request/request.ts:1205`, `src/ts/process/request/request.ts:1616`). These are exceptions to the normal stream contract and can produce incorrect final-state behavior in consumers that replace the message with each chunk.

- Classic OpenAI, Anthropic, and Gemini implement tool loops independently. ModelPreset uses the shared adapter `runToolLoop`. Changes to tool behavior often need implementation and tests in both regimes.

- A completed ModelPreset tool call must retain `toolExecuted`; otherwise banned-character, blank-response, or plugin-replacer retries can execute the tool twice (`src/ts/process/request/request.ts:189`).

- `ModelPreset.fallbackModelPresetIds` is declared but has no request-path consumer. Runtime fallback currently reads only legacy `db.fallbackModels` (`src/ts/process/request/request.ts:122`).

- Additional parameters support nested body paths, typed `json::` values, `header::Name`, and deletion with `{{none}}` (`src/ts/process/request/shared.ts:65`). An `anthropic-beta` supplied this way suppresses automatic beta construction (`src/ts/process/request/anthropic.ts:386`).

- `previewBody` includes prepared authorization headers for classic and preset requests. Treat previews and fetch logs as secret-bearing data.

- Classic key precedence is provider-specific:
  - OpenAI family: `arg.key`, then provider/database key, then model `keyIdentifier` override.
  - Anthropic: `arg.key || reverse-proxy/Anthropic key`.
  - Gemini: `arg.key || db.google.accessToken`; Vertex uses cached service-account OAuth.
  - Bedrock expects a colon-delimited access key, secret, and region.

- Catalog helpers for OpenRouter, NanoGPT, and Horde use browser `fetch()` directly and return empty results on errors. They do not share request logging or `/proxy2` behavior.

- The provider named `WebLLM` in the legacy model registry does not call `src/ts/process/webllm.ts`. `requestWebLLM()` actually runs the Hugging Face Transformers text-generation pipeline (`src/ts/process/request/request.ts:1886`). The MLC WebLLM engine is used by Hypa memory summarization.

- Transformers “local” inference still downloads model artifacts. The default model path is `https://sv.risuai.xyz/transformers/`, with Cache Storage or PocketRisu asset IDs supplying cached/custom files (`src/ts/process/transformers.ts:13`).

- Horde cancellation covers only the initial submission. Status polling does not pass the abort signal and has no abort check (`src/ts/process/request/request.ts:1838`).

- Local-network classification intentionally treats any single-label hostname as local for Docker/LAN deployments (`src/ts/network/localNetwork.ts:88`). The WebSocket job server independently revalidates the target before connecting.

- The proxy-job relay exists in the Node Express server. No corresponding `proxy2` or `proxy-stream-jobs` route was found under `server/hono/`.

## 6. Navigation hints

- To add an OpenAI model, add an `LLMModel` entry to `OpenAIModels` (`src/ts/model/providers/openai.ts:3`). Set a unique stable `id`, the provider’s wire `internalID`, `OpenAICompatible` format, correct flags, parameter allowlist, and tokenizer.

- To add an Anthropic model, add it to `AnthropicModels` (`src/ts/model/providers/anthropic.ts:3`). Current Messages models need `Anthropic` format; only obsolete completion models should use `AnthropicLegacy`.

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
  3. Add the new dispatch case at `src/ts/process/request/request.ts:442`.
  4. Add model metadata and any required key/database settings.
  5. Use `globalFetch()` for JSON and `fetchNative()` for streaming.
  6. Emit cumulative `{ "0": fullText }` stream snapshots.

- To support another static Anthropic- or Gemini-compatible host, note that their classic requesters do not consume `modelInfo.endpoint` or `keyIdentifier`. Use `xcustom:::`/reverse-proxy configuration, add explicit requester support, or define a ModelPreset profile instead.

- To add an ad hoc model using an existing classic format, inspect the `xcustom:::` resolution at `src/ts/model/modellist.ts:733` and dispatch setup at `src/ts/process/request/request.ts:432`.

- To change classic role/system normalization, edit `reformater()` (`src/ts/process/request/request.ts:285`) and check both classic metadata flags and the preset-toggle-to-flag mapping (`src/ts/process/request/request.ts:770`).

- To change shared sampler mapping or disabled-value behavior, edit `applyParameters()` (`src/ts/process/request/shared.ts:148`).

- To change custom body/header override syntax, edit `getAdditionalParameters()` and `applyAdditionalParameters()` (`src/ts/process/request/shared.ts:33`, `src/ts/process/request/shared.ts:65`).

- To change OpenAI-compatible request bodies, inspect model selection at `src/ts/process/request/openAI/requests.ts:206`, body construction at `src/ts/process/request/openAI/requests.ts:344`, and endpoint/key resolution at `src/ts/process/request/openAI/requests.ts:492`.

- To change OpenAI streaming or streamed tool handling, inspect `getTranStream()` and `wrapToolStream()` (`src/ts/process/request/openAI/requests.ts:1116`, `src/ts/process/request/openAI/requests.ts:1272`).

- To change Anthropic prompt caching, thinking, or Bedrock signing, inspect `src/ts/process/request/anthropic.ts:145`, `src/ts/process/request/anthropic.ts:362`, and `src/ts/process/request/anthropic.ts:392`.

- To change Gemini thinking, modalities, safety, or Vertex authentication, inspect `src/ts/process/request/google.ts:89`, `src/ts/process/request/google.ts:299`, `src/ts/process/request/google.ts:376`, and `src/ts/process/request/google.ts:446`.

- To add a model/provider in the ModelPreset regime using an existing protocol, add a registry base-provider/profile pair using one of the adapter kinds declared at `src/ts/preset/types.ts:3`. No `LLMModels` entry is required.

- To add a fourth ModelPreset wire family, extend `AdapterKind`, implement send/stream/preview functions, and add cases to all three wrappers at `src/ts/process/request/request.ts:495`.

- To change per-chat preset selection, start at `resolveChatModelBinding()` (`src/ts/process/request/modelPresetBinding.ts:42`).

- To change ModelPreset key precedence, edit `buildModelPresetCredential()` (`src/ts/process/request/modelPresetBinding.ts:278`).

- To change classic/preset tool-history interoperability or image extraction, edit `expandAdapterMessages()` and `toAdapterMessage()` (`src/ts/process/request/modelPresetMessages.ts:18`, `src/ts/process/request/modelPresetMessages.ts:112`).

- To tune preset streaming render frequency or backpressure behavior, inspect `STREAM_FLUSH_INTERVAL_MS` (`src/ts/process/request/request.ts:652`) and `pumpPresetStream()` (`src/ts/process/request/presetStreamPump.ts:109`).

- To change LAN detection, edit `isLocalNetworkHost()` (`src/ts/network/localNetwork.ts:74`) and keep the Node server’s independent validation aligned.

- To change WebSocket job event parsing or timeout messages, edit `src/ts/network/proxyJobWs.ts:1`; to change client job lifecycle, inspect `src/ts/globalApi.svelte.ts:2156`.

- To change browser-local chat generation, inspect `requestWebLLM()` (`src/ts/process/request/request.ts:1868`) and `runTransformers()` (`src/ts/process/transformers.ts:38`), not the MLC helper.

## Out of scope, noticed

- `src/ts/preset/adapter/` owns the actual ModelPreset provider request builders, SSE parsers, credential resolution, errors, and shared tool loop.
- `src/ts/preset/registry/` and bundled registry JSON files own preset-provider/profile discovery and snapshots.
- `src/ts/globalApi.svelte.ts` owns fetch logging, interceptors, `/proxy2`, timeouts, and proxy-job client orchestration.
- `server/node/server.cjs` owns `/proxy2`, `/proxy-stream-jobs`, WebSocket upgrades, authentication, SSRF restrictions, and upstream streaming.
- `src/ts/storage/database.svelte.ts` owns persisted API keys, model choices, custom model definitions, fallback lists, and ModelPreset state.
- `src/lib/Setting/Pages/BotSettings.svelte`, `src/lib/UI/ModelList.svelte`, and ModelPreset settings components own provider/model selection UI.
