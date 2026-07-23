# presets-profiles

> Part of the PocketRisu structure docs — see [STRUCTURE.md](../../STRUCTURE.md) for the top-level map and subsystem index.
> Generated 2026-07-23 from codebase analysis. Line numbers are approximate and drift as code changes; verify with `rg` before relying on them.

## 1. Purpose & overview

This subsystem separates PocketRisu’s model/provider configuration from the upstream RisuAI-style prompt preset. A registry `ModelProfile` is a reusable provider/model blueprint; selecting one creates a persisted `ModelPreset` containing a frozen resolved snapshot plus the user’s credentials, parameter values, and per-model behavior toggles.

The older `botPreset` remains the prompt preset: it owns prompt text/template, sampling parameters, and compatibility fields used by RisuAI `.risup`/`.risupreset` files. Prompt construction still consumes the active `botPreset`; request dispatch can independently use a chat-bound `ModelPreset` through one of three wire adapters.

The subsystem also manages official/custom profile registries, explicit profile updates, saved API keys, Google service-account tokens, and Gemini explicit context caches.

## 2. Key files

### Core types and persistence

| File | Approx. size | Role and important symbols |
|---|---:|---|
| `src/ts/preset/types.ts` | 534 lines | Central schema. `AdapterKind` defines the three implemented protocols (`types.ts:3`); `BaseProviderDefinition` holds provider-wide wire/schema defaults (`types.ts:156`); `ModelProfile` describes a registry model (`types.ts:184`); `ResolvedModelProfileSnapshot` is the frozen merged form stored on a preset (`types.ts:233`); `ModelPreset` is the user-editable runtime configuration (`types.ts:252`). `ModelBindingSet` describes per-chat main/sub/aux bindings (`types.ts:379`), `emptyModelBinding()` normalizes empty Svelte bindings (`types.ts:394`), and `ApiKeyPoolEntry` describes saved credentials (`types.ts:398`). Registry/update/cache types start at `types.ts:407`. |
| `src/ts/storage/database.svelte.ts` | 3,058 lines | Shared database definition and compatibility layer. `setDatabase()` fills prompt defaults and stable prompt-preset IDs (`database.svelte.ts:37`, `database.svelte.ts:183`), then invokes `applyModelPresetDefaults()` at the load boundary (`database.svelte.ts:734`). `Database` stores `botPresets`/`botPresetsId` at `database.svelte.ts:959` and `database.svelte.ts:1024`, and model-profile state at `database.svelte.ts:1376`. `botPreset` is defined at `database.svelte.ts:1723`; `Chat.bindedBotPreset`, `useModelPreset`, `modelBinding`, and `usePromptPresetParams` are at `database.svelte.ts:2034`. |
| `src/ts/storage/defaultPrompts.ts` | 28 lines | Re-exports `prebuiltPresets.OAI.mainPrompt` and `.jailbreak` as the defaults (`defaultPrompts.ts:3`), preserves exact old prompt strings for migration (`defaultPrompts.ts:5`), and defines the default response-suggestion prompt (`defaultPrompts.ts:7`). |
| `src/ts/preset/dbDefaults.ts` | 192 lines | Model-preset database normalization. `createEmptyRegistryCache()` returns schema version 4 (`dbDefaults.ts:16`). `applyModelPresetDefaults()` initializes preset/key/cache collections and visibility defaults, sanitizes malformed stored snapshots, and heals resolvable degenerate snapshots (`dbDefaults.ts:174`). Snapshot sanitization is at `dbDefaults.ts:32`; healing is at `dbDefaults.ts:95`. |
| `src/ts/preset/apiKeyPool.ts` | 61 lines | CRUD over `db.apiKeyPool`. `listApiKeys()` filters by provider and sorts by last update (`apiKeyPool.ts:17`); `getApiKey()` resolves an ID (`apiKeyPool.ts:24`); add/update/remove are at `apiKeyPool.ts:29`, `apiKeyPool.ts:44`, and `apiKeyPool.ts:55`. Every mutation replaces the pool object to trigger Svelte 5 reactivity. |

### Registry and profile lifecycle

| File | Approx. size | Role and important symbols |
|---|---:|---|
| `src/ts/preset/registry/loader.ts` | 49 lines | Eagerly loads bundled JSON through `import.meta.glob` (`loader.ts:5`, `loader.ts:10`). `loadBundledRegistry()` memoizes the schema-v4 registry (`loader.ts:40`); `getBundledRegistryId()` returns `"bundled"` (`loader.ts:47`). |
| `src/ts/preset/registry/bundled/base-providers/*.json` | 18 files, about 144 KiB | Provider-wide protocol definitions: adapter kind, common auth field, endpoint kinds, headers/body defaults, capabilities, and UI schema. For example, OpenAI selects `openai-compatible` at `base-providers/openai.json:5` and defines its auth field at `base-providers/openai.json:16`. |
| `src/ts/preset/registry/bundled/profiles/**/*.json` | 149 files, about 832 KiB | Concrete provider/model profiles. Each supplies model ID, endpoint/auth, model-specific fields, limits, status, timestamps, and capabilities. `profiles/openai/gpt-55.json:2` defines the profile identity, `:19` the model ID, `:20` its update timestamp, and `:32` its extension schema. |
| `src/ts/preset/registry/snapshot.ts` | 138 lines | Converts a base provider plus profile into a request-ready frozen snapshot. `resolveSnapshot()` merges schemas, UI schemas, defaults, headers, capabilities, and limits (`snapshot.ts:36`). Missing-profile/base-provider errors are at `snapshot.ts:12` and `snapshot.ts:24`. Profile fields override same-key base fields (`snapshot.ts:100`, `snapshot.ts:118`). |
| `src/ts/preset/registry/remote.ts` | 266 lines | Fetches the official or custom-hosted registry. `syncRemoteRegistry()` uses `index.json` as a content-hash gate and atomically replaces the official cache entry (`remote.ts:158`); it preserves the custom registry at `remote.ts:224`. `getOfficialRegistry()` chooses the populated remote cache or bundled fallback (`remote.ts:247`). `getPresetUpdateStatus()` performs timestamp-based source lookup (`remote.ts:258`). |
| `src/ts/preset/registry/visibility.ts` | 26 lines | Display-only filtering for current/outdated/deprecated profiles through `isProfileVisible()` (`visibility.ts:13`). |
| `src/ts/preset/registry/notice.ts` | 80 lines | Builds the “new/updated models” banner. `buildSeenMap()` snapshots profile timestamps (`notice.ts:31`); `computeRegistryNotice()` compares them while respecting visibility (`notice.ts:40`). |
| `src/ts/preset/registry/i18n.ts` | 40 lines | Locale selection and registry-string fallback. `localizeDisplayName()`, `localizeDescription()`, and `localizeGroupLabel()` are at `i18n.ts:21`, `i18n.ts:28`, and `i18n.ts:35`. |
| `src/ts/preset/registry/index.ts` | 13 lines | Public registry barrel: bundled loading, snapshot resolution, remote sync, update status, and visibility. |
| `src/ts/preset/customProfiles.ts` | 276 lines | Custom-profile import/export and production update helpers. Custom objects live under registry ID `"custom"` with `custom::` IDs (`customProfiles.ts:25`). `ProfileFragment` is the self-contained profile-plus-base-provider file shape (`customProfiles.ts:32`); build/validate/import are at `customProfiles.ts:52`, `customProfiles.ts:80`, and `customProfiles.ts:130`. Timestamp update status is at `customProfiles.ts:179`; production value migration is at `customProfiles.ts:200`; snapshot-to-fragment export and deletion are at `customProfiles.ts:223` and `customProfiles.ts:265`. |
| `src/ts/preset/profileUpdate.ts` | 375 lines | A more detailed, version-oriented snapshot migration API. `getProfileUpdateAvailability()` classifies source/current/downgrade/missing states (`profileUpdate.ts:34`); `diffProfileSnapshot()` produces structural schema/UI/wire diffs (`profileUpdate.ts:95`); `applyProfileSnapshotUpdate()` keeps compatible values and moves removed/type-changed values into `orphanValues` (`profileUpdate.ts:118`). This module is covered by tests but currently has no non-test production importer. |

### Adapter layer

| File | Approx. size | Role and important symbols |
|---|---:|---|
| `src/ts/preset/adapter/types.ts` | 188 lines | Adapter-neutral request/response contracts. `AdapterCredential` and `AdapterRequestContext` are at `adapter/types.ts:4` and `adapter/types.ts:9`; chat messages and tool/reasoning/image metadata begin at `adapter/types.ts:58`; `AdapterChatResponse` is at `adapter/types.ts:139`; `AdapterChatOptions`, including Gemini cache context, is at `adapter/types.ts:174`. |
| `src/ts/preset/adapter/index.ts` | 45 lines | Public adapter barrel. It exports preparation/auth/error helpers and all three send/stream/preview implementations (`adapter/index.ts:21`). |
| `src/ts/preset/adapter/buildRequest.ts` | 267 lines | Shared request builder. `buildPreparedRequest()` resolves endpoint, merges body/header layers, maps schema fields, parses legacy additional-parameter syntax, and applies auth (`buildRequest.ts:15`). Vertex endpoint resolution begins at `buildRequest.ts:80`; dot-path writes and additional parameters are implemented at `buildRequest.ts:197` and `buildRequest.ts:222`. |
| `src/ts/preset/adapter/openaiCompatible.ts` | 389 lines | OpenAI Chat Completions-compatible wire. Non-streaming, streaming, and preview entries are `sendChatRequest()` (`openaiCompatible.ts:49`), `streamChatRequest()` (`openaiCompatible.ts:84`), and `previewChatRequest()` (`openaiCompatible.ts:138`). It owns final `messages`, `model`, `stream`, and tool fields (`openaiCompatible.ts:146`). |
| `src/ts/preset/adapter/anthropicMessages.ts` | 411 lines | Anthropic Messages wire. Send/stream/preview entries are at `anthropicMessages.ts:53`, `anthropicMessages.ts:88`, and `anthropicMessages.ts:143`. `prepareAnthropicBody()` extracts system messages, shapes tool/thinking blocks, and supplies a 4,096-token fallback for old snapshots (`anthropicMessages.ts:151`). |
| `src/ts/preset/adapter/googleGemini.ts` | 566 lines | Native Gemini wire and cache integration. Send/stream/preview entries are at `googleGemini.ts:78`, `googleGemini.ts:127`, and `googleGemini.ts:193`. `prepareGeminiBody()` builds `contents`, `systemInstruction`, tools, the model URL suffix, and cache boundary (`googleGemini.ts:201`). Cache rejection retries uncached at `googleGemini.ts:95` and `googleGemini.ts:143`. |
| `src/ts/preset/adapter/auth.ts` | 79 lines | Applies `none`, bearer, API-key header, Google-key header, query-key, and service-account bearer auth (`auth.ts:5`). Auth replacement is case-insensitive so custom headers cannot retain a conflicting credential (`auth.ts:59`). |
| `src/ts/preset/adapter/resolveCredential.ts` | 97 lines | Async credential preparation. `resolveAdapterCredential()` exchanges service-account JSON for an access token (`resolveCredential.ts:26`); `prepareAdapterRequest()` is the safe entry that resolves credentials before calling the synchronous shared builder (`resolveCredential.ts:74`). |
| `src/ts/preset/adapter/wireInvariants.ts` | 47 lines | `resolveWireModelId()` resolves model selection from user value, schema default, or snapshot, and prevents `customBody.model` from redirecting the wire (`wireInvariants.ts:13`). |
| `src/ts/preset/adapter/error.ts` | 157 lines | Typed adapter errors and network/HTTP normalization. `ModelPresetAdapterError` is at `error.ts:10`; retry/fallback policy at `error.ts:40` and `error.ts:56`; fetch and HTTP normalization at `error.ts:68` and `error.ts:127`. |
| `src/ts/preset/adapter/sse.ts` | 108 lines | Streaming parser. `parseSseStream()` incrementally drains response bodies (`sse.ts:3`); `parseSseEventBlock()` parses a complete event (`sse.ts:25`). |
| `src/ts/preset/adapter/toolLoop.ts` | 112 lines | Adapter-neutral multi-step function-call loop. `runToolLoop()` repeatedly sends, executes calls, appends assistant/tool turns, and stops at a configured limit (`toolLoop.ts:42`). |
| `src/ts/preset/adapter/vertexEndpoint.ts` | 126 lines | Vertex OpenAI/Gemini URL construction and project/location validation (`vertexEndpoint.ts:23`, `vertexEndpoint.ts:35`). `resolveVertexProject()` can recover `project_id` from service-account JSON (`vertexEndpoint.ts:71`). |
| `src/ts/preset/adapter/googleServiceAccount/serviceAccount.ts` | 94 lines | Parses and validates service-account JSON (`serviceAccount.ts:32`). It restricts `token_uri` to Google’s OAuth endpoint to prevent signed-JWT exfiltration/SSRF (`serviceAccount.ts:21`). |
| `src/ts/preset/adapter/googleServiceAccount/token.ts` | 137 lines | Calls the authenticated Node endpoint for OAuth exchange. `exchangeServiceAccountForAccessToken()` posts raw service-account JSON to `/api/model-preset/google-service-account/token` (`token.ts:15`, `token.ts:40`). |
| `src/ts/preset/adapter/googleServiceAccount/cache.ts` | 172 lines | In-memory access-token cache. `createServiceAccountTokenCache()` deduplicates refreshes by token URI, email, and scope and refreshes with 60 seconds of skew (`cache.ts:39`). The default singleton is exposed at `cache.ts:134`. |

### Gemini context cache

| File | Approx. size | Role and important symbols |
|---|---:|---|
| `src/ts/preset/cache/geminiContextCache.ts` | 593 lines | Core state, pure decisions, body transforms, and REST client for Gemini `cachedContents`. Cache configuration is at `geminiContextCache.ts:37`; transient entries are keyed by chat/task/preset at `geminiContextCache.ts:71` and `geminiContextCache.ts:82`. Pre/post decisions are `evaluateGeminiCacheBeforeRequest()` (`geminiContextCache.ts:284`) and `decideGeminiCacheAfterResponse()` (`geminiContextCache.ts:341`). Body application and REST client creation are at `geminiContextCache.ts:410` and `geminiContextCache.ts:524`. |
| `src/ts/preset/cache/geminiCacheWiring.ts` | 286 lines | Impure bridge used by the Gemini adapter. `beginGeminiCacheTurn()` loads state, evaluates it, optionally substitutes a cached body, and returns a non-blocking completion hook (`geminiCacheWiring.ts:57`). Per-key generations prevent stale asynchronous cache creation from overwriting newer state (`geminiCacheWiring.ts:172`). |

### UI touchpoints

| File | Approx. size | Role |
|---|---:|---|
| `src/lib/Setting/modelProfileBrowser.svelte` | 392 lines | Official/custom profile modal. It scopes registries by tab (`modelProfileBrowser.svelte:48`), creates a preset from a resolved snapshot (`modelProfileBrowser.svelte:156`), replaces a preset profile with value migration (`modelProfileBrowser.svelte:187`), and imports/exports `.profile.json` fragments (`modelProfileBrowser.svelte:234`, `modelProfileBrowser.svelte:245`). |
| `src/lib/Setting/modelpreset.svelte` | 253 lines | Compact model-preset selection/list modal. It supports reorder, duplicate, delete, and callback-based chat binding (`modelpreset.svelte:30`, `modelpreset.svelte:53`, `modelpreset.svelte:66`, `modelpreset.svelte:125`). Editing now routes to the full settings page (`modelpreset.svelte:88`). |
| `src/lib/Setting/Pages/Model/ModelPresetSettings.svelte` | 523 lines | Current full editor. It syncs the remote registry on mount (`ModelPresetSettings.svelte:47`), renders schema-driven fields, abilities/cache controls, test requests, key-pool manager, and update indicators. Preset creation opens the profile browser at `ModelPresetSettings.svelte:147`. |
| `src/lib/Setting/Pages/Model/ModelPresetBasicInfo.svelte` | 171 lines | Current profile/source panel. Timestamp-based lookup is at `ModelPresetBasicInfo.svelte:49`; one-click update re-resolves and migrates values at `ModelPresetBasicInfo.svelte:79`; export emits a profile fragment at `ModelPresetBasicInfo.svelte:105`. |
| `src/lib/Setting/Pages/Model/CredentialField.svelte` | 145 lines | Chooses direct credentials or a single saved `apiKeyRef`. Direct mode clears any pooled reference (`CredentialField.svelte:42`); saving a direct key adds it to the pool and binds the preset (`CredentialField.svelte:68`). |

### Tests

The subsystem has extensive unit and integration coverage:

- Core lifecycle: `apiKeyPool.test.ts` (81 lines; suite at `:18`), `customProfiles.test.ts` (218 lines; fragment/update suites at `:61`, `:177`), `dbDefaults.test.ts` (300 lines; suite at `:4`), `profileUpdate.test.ts` (704 lines; availability/diff/apply suites at `:146`, `:350`, `:467`), and `profileUpdate.integration.test.ts` (294 lines; end-to-end migration at `:146`).
- Registry: `loader.test.ts` (209 lines; `:177`), `snapshot.test.ts` (325 lines; `:6`), `snapshotNullSafety.test.ts` (43 lines; `:7`), `remote.test.ts` (361 lines; sync at `:56`), `notice.test.ts` (69 lines; `:23`), and `visibility.test.ts` (30 lines; `:4`).
- Shared adapter contracts: `buildRequest.test.ts` (892 lines; `:51`), `auth.test.ts` (142 lines; `:17`), `error.test.ts` (250 lines; `:11`), `resolveCredential.test.ts` (206 lines; `:63`), `wireInvariants.test.ts` (176 lines; `:43`), `sse.test.ts` (105 lines; `:25`), `toolLoop.test.ts` (211 lines; `:30`), and `vertexEndpoint.test.ts` (70 lines; `:5`).
- Provider adapters: `openaiCompatible.test.ts` (838 lines; send/stream/tools/vision at `:115`, `:285`, `:574`, `:751`), `anthropicMessages.test.ts` (684 lines; `:122`, `:481`, `:649`), and `googleGemini.test.ts` (1,170 lines; `:140`, `:508`, `:727`).
- Vertex/service-account integration: `openaiCompatibleVertex.test.ts` (154 lines; `:54`), `vertexIntegration.test.ts` (196 lines; `:55`, `:105`), and the service-account parser/token/cache tests (110/234/284 lines; suites at `serviceAccount.test.ts:19`, `token.test.ts:51`, `cache.test.ts:41`).
- Gemini cache: `geminiContextCache.test.ts` (954 lines), covering configuration (`:92`), key/prefix decisions (`:119`, `:152`), body transforms (`:434`), state (`:590`), REST calls (`:698`), and stale-write races (`:841`).

## 3. Architecture & data flow

### Profile versus preset concepts

PocketRisu uses three similarly named but distinct concepts:

1. A `ModelProfile` is registry metadata: provider base ID, endpoint/auth shape, default model, editable schema, UI schema, capabilities, limits, status, and source timestamps (`types.ts:184`).
2. A `ModelPreset` is a user-owned installation of a profile: it freezes a `ResolvedModelProfileSnapshot`, stores user values and credentials, and adds behavior such as streaming, tool use, vision/system-role toggles, context budget, caching, and ordering (`types.ts:252`).
3. A `botPreset` is the upstream-compatible prompt preset. It stores prompt text/template, sampling values, legacy model/provider fields, regex/tools, and other global chat-bot settings (`database.svelte.ts:1723`).

A “custom profile” is therefore not an upstream RisuAI preset and not a `customModels[]` entry. It is a shareable, key-free profile blueprint stored in `modelProfileRegistryCache.registries.custom`; it must still be instantiated as a `ModelPreset` before a chat can use it.

### Registry-to-preset flow

```text
bundled JSON or remote catalog
        │
        ▼
RegistryCache entry
  BaseProviderDefinition + ModelProfile
        │ resolveSnapshot()
        ▼
ResolvedModelProfileSnapshot
        │ profile browser + seeded schema defaults
        ▼
db.modelPresets[] ModelPreset
        │ chat.modelBinding slot
        ▼
request adapter dispatch
```

- `loader.ts:17` builds the bundled registry from JSON modules.
- `remote.ts:158` optionally updates the persisted official entry using a content hash. Failures leave the previous cache/bundle untouched.
- `modelProfileBrowser.svelte:156` resolves the selected profile.
- `snapshot.ts:36` combines common provider fields and profile overrides. The base provider typically supplies credentials/common capability defaults; the profile supplies the concrete endpoint/model and model-specific fields.
- `modelProfileBrowser.svelte:137` seeds `userValues` from merged schema-field defaults. Snapshot-level `defaults` remain a separate body-default layer.
- The resulting preset is appended to `db.modelPresets` at `modelProfileBrowser.svelte:178`.
- Chat binding stores only preset IDs; the persisted snapshot means future registry changes do not silently alter existing requests.

### Custom-profile flow

- Export builds a schema-version-1 fragment containing one profile and its base provider (`customProfiles.ts:31`, `customProfiles.ts:52`).
- Import validates the untrusted JSON (`customProfiles.ts:80`), namespaces both IDs with `custom::`, fills missing type-only versions/timestamps, and writes the pair into the custom registry (`customProfiles.ts:130`).
- The official and custom registries remain separate browser tabs (`modelProfileBrowser.svelte:48`).
- Removing a custom profile also removes an unreferenced base provider (`customProfiles.ts:265`). Existing `ModelPreset`s continue working from their frozen snapshots, but their source becomes “missing.”

### Production profile-update flow

The production UI uses timestamps, not `profileUpdate.ts`’s version classifier:

1. Creation/replacement records `sourceProfile.registryId`, profile/base versions, fetch time, and the profile’s `updatedAt` (`modelProfileBrowser.svelte:166`).
2. `getPresetUpdateStatus()` finds the current profile in the matching official/custom registry (`remote.ts:258`).
3. `getProfileUpdateStatus()` reports `updatable` only if both timestamps exist and the registry timestamp is newer (`customProfiles.ts:179`).
4. Applying an update re-runs `resolveSnapshot()`, retains values whose keys exist in the new schema, seeds defaults for newly introduced fields, and drops removed keys (`customProfiles.ts:200`, `ModelPresetBasicInfo.svelte:82`).
5. The UI confirms before applying, then replaces the snapshot and restamps all source metadata (`ModelPresetBasicInfo.svelte:91`).

Replacing a preset with an unrelated profile uses the same migration policy at `modelProfileBrowser.svelte:187`.

`profileUpdate.ts` implements a parallel, richer version-based path: it computes detailed diffs and preserves removed/type-changed values in `orphanValues`. No production component currently imports it, so changing only that module will not change the live update button.

### Database load and repair

`setDatabase()` calls `applyModelPresetDefaults()` before installing state (`database.svelte.ts:734`).

That normalization:

- ensures `modelPresets` is an array and the API-key pool/cache have valid container shapes;
- defaults profile visibility to `currentOnly`;
- removes null elements from stored snapshot schema/UI arrays (`dbDefaults.ts:32`);
- detects snapshots missing auth, endpoint, fields, or an auth-mapped credential field (`dbDefaults.ts:74`);
- re-resolves broken snapshots against the persisted official cache and then the bundled registry (`dbDefaults.ts:95`);
- migrates compatible user values and moves lost values into `orphanValues` (`dbDefaults.ts:130`).

This load-boundary mutation is intentional and persists on the next database save.

### Prompt-preset flow

`botPresetsId` remains the physical active-preset index for upstream backup compatibility (`database.svelte.ts:1024`). New code can address prompt presets by stable `botPreset.id` through helpers at `database.svelte.ts:2339`.

- `changeToPreset()` saves the current prompt preset and installs the selected one into global database fields (`database.svelte.ts:2516`).
- `setPreset()` copies prompt text, prompt template, sampling parameters, and legacy settings into the global database (`database.svelte.ts:2531`).
- A chat’s `bindedBotPreset` stores a stable ID, but `PromptBind.svelte` resolves it to the current array index and calls `changeToPreset()` so legacy prompt code can continue reading `db.botPresetsId` (`PromptBind.svelte:17`, `PromptBind.svelte:29`).
- Reorder/delete code should preserve the active stable ID through `withStableActivePreset()` (`database.svelte.ts:2394`).

### Prompt construction versus model dispatch

Prompt and model presets meet only at a few explicit points:

- Prompt construction uses the global values installed from the active `botPreset`: `db.promptTemplate` is cloned at `process/index.svelte.ts:298`; without a template, `db.mainPrompt` is used at `process/index.svelte.ts:346`.
- Before building the prompt, a bound main `ModelPreset` changes the input budget and output-token reservation using `preset.maxContext`, profile limits, and preset output fields (`process/index.svelte.ts:257`).
- `requestChatDataMain()` is the dispatch choke point. It resolves the current chat/mode before any legacy model selection (`process/request/request.ts:372`, `process/request/request.ts:380`).
- If the chat resolves to a `ModelPreset`, the optional `usePromptPresetParams` bridge injects only supported sampling fields from the active prompt preset into a copy of `userValues` (`modelPresetBinding.ts:237`). Prompt content is not changed here.
- Classic chats fall through to `db.aiModel`/`db.subModel`; preset chats call `requestModelPreset()` (`request.ts:384`).

### Model binding resolution

`resolveChatModelBinding()` at `modelPresetBinding.ts:42` decides between classic, preset, and blocked states.

- `nodeOnlyModelModeLock` can force all chats to classic or preset mode.
- Otherwise, `chat.useModelPreset` controls the regime.
- Main requests use `modelBinding.main`; submodel requests use `.sub`.
- Aux tasks use their dedicated slot only when `separateAux` is enabled and the slot resolves; otherwise they fall back to sub.
- Missing and dangling main/sub IDs block rather than silently choosing a different model.
- New chats snapshot `db.defaultModelBinding` through `newChatModelDefaults()` (`database.svelte.ts:808`); existing chats do not follow later default changes.

### Request-building and dispatch flow

```text
formatted OpenAIChat[] prompt
        │ requestChatDataMain()
        ▼
resolveChatModelBinding()
        │
        ├─ classic → legacy request path
        │
        └─ ModelPreset
             │ buildModelPresetCredential()
             │ capability gates + reformater()
             │ toAdapterMessage()/tool-history expansion
             ▼
        requestModelPreset()
             │
             ├─ preview
             ├─ tool loop
             ├─ stream
             └─ non-stream send
                    │
                    ▼
        provider adapter
             │ prepareAdapterRequest()
             │ buildPreparedRequest()
             │ provider wire invariants
             ▼
        fetchNative-backed proxied fetch
```

`requestModelPreset()` begins at `request.ts:679`:

- `buildModelPresetCredential()` resolves credentials (`modelPresetBinding.ts:278`).
- Tools require per-preset opt-in, explicit profile capability, and an implemented adapter (`request.ts:694`).
- Images require implemented vision wire plus either profile capability or the per-preset opt-in (`request.ts:714`).
- Gemini caching is admitted only for main, non-tool, non-preview Google-native requests with explicit cache capability (`request.ts:722`).
- Model-ability toggles are converted to `LLMFlags`, and `reformater()` runs on a clone (`request.ts:756`).
- Formatted prompt messages are converted to adapter-neutral messages, optionally expanding persisted tool-call history (`request.ts:789`).
- Dispatch selects provider-specific send/stream/preview functions at `request.ts:495`, `request.ts:508`, and `request.ts:521`.
- The supplied fetch implementation wraps `fetchNative`, preserving proxy/CORS/local-network routing, timeouts, aborts, and request logging (`request.ts:534`).

### Shared request merge order

`buildPreparedRequest()` applies configuration in this order (`buildRequest.ts:15`):

1. `profileSnapshot.defaults`;
2. `profileSnapshot.bodyTemplate`;
3. effective schema values from `preset.userValues` or field defaults;
4. `customBody` and `customHeaders`;
5. `additionalParamsText`;
6. auth injection.

Provider adapters then overwrite wire invariants such as messages/contents, model ID, stream mode, and tool declarations. Thus custom body fields can override ordinary provider parameters but cannot redirect the model, replace the prompt, or bypass the tool-off gate.

### API key pool and “rotation”

Each preset has one optional `apiKeyRef`, not a list or round-robin pool. Credential resolution order is:

1. the referenced `db.apiKeyPool` entry;
2. `inlineCredential`;
3. the first non-empty schema field mapped to `auth`.

This is implemented at `modelPresetBinding.ts:275`. A dangling or empty pool entry falls through to later sources.

There is no automatic key rotation, retry-across-keys, or provider quota balancing. Updating an existing pool entry effectively rotates that credential immediately for every preset referencing its stable ID. For Gemini context caching, the credential is fingerprinted (`geminiContextCache.ts:247`); a changed key produces a cache miss rather than reusing a cache owned by the old credential (`geminiContextCache.ts:284`). Vertex OAuth refreshes also change the fingerprint and rebuild the cache (`geminiCacheWiring.ts:98`).

`ModelPreset.fallbackModelPresetIds` exists in the type (`types.ts:335`) but has no production consumer. It does not currently provide retry or rotation behavior.

### Cache layers

Three unrelated caches should not be conflated:

- `modelProfileRegistryCache` is persisted database state containing official and custom profile catalogs.
- The service-account token cache is an in-memory singleton keyed by account/scope (`googleServiceAccount/cache.ts:39`).
- Gemini context-cache state is transient and mirrored to `localStorage` under `nodeOnlyGeminiCacheState`, never stored in the database (`geminiContextCache.ts:1`, `geminiContextCache.ts:20`).

Gemini cache identity is `chat ID + task + preset ID`; entries also record model, prefix hash, boundary, expiry, and credential fingerprint. Prefix mismatches invalidate the remote cache, three consecutive dynamic-prefix invalidations disable caching for the session, and detached create/extend/delete failures never fail the chat.

### `.risup`, `.risupreset`, and profile export formats

The Risu formats apply to `botPreset`, not `ModelPreset`.

`downloadPreset()` at `database.svelte.ts:2846`:

- first snapshots the active global prompt/model fields through `saveCurrentPreset()`;
- clones the selected `botPreset`;
- blanks API keys, proxy keys, forced URLs, and WebUI URLs (`database.svelte.ts:2851`);
- for the binary path, MessagePack-encodes the preset, encrypts it with the `"risupreset"` context, wraps it in `{presetVersion: 2, type: "preset"}`, compresses it, then RPack-encodes it (`database.svelte.ts:2861`);
- despite the API argument being named `"risupreset"`, the current exporter writes a `.risup` filename (`database.svelte.ts:2873`).

`importPreset()` accepts JSON, legacy `.risupreset`, and `.risup` (`database.svelte.ts:2895`):

- `.risup` is first unwrapped with `decodeRPack`; `.risupreset` is treated as the older raw compressed envelope (`database.svelte.ts:2906`);
- binary envelopes with preset versions 0 or 2 and type `"preset"` are decrypted and merged onto `presetTemplate` (`database.svelte.ts:2911`);
- JSON also merges onto `presetTemplate`;
- NovelAI parameter files and SillyTavern prompt layouts have separate conversion branches (`database.svelte.ts:2922`, `database.svelte.ts:2947`);
- every imported ordinary preset receives a fresh stable ID before being appended (`database.svelte.ts:3052`).

Model profiles instead use plain `.profile.json` fragments (`modelProfileBrowser.svelte:241`, `ModelPresetBasicInfo.svelte:105`). There is no dedicated standalone `ModelPreset` import/export format; model presets persist as part of the PocketRisu database/backup.

## 4. Entry points & dependencies

### Called from other subsystems

- Database hydration calls `applyModelPresetDefaults()` from `setDatabase()` (`database.svelte.ts:734`).
- Full model settings calls `syncRemoteRegistry()`, update-notice helpers, and `testModelPreset()` (`ModelPresetSettings.svelte:47`, `ModelPresetSettings.svelte:158`).
- The profile browser calls registry resolution and custom fragment functions (`modelProfileBrowser.svelte:8`).
- The model preset editor’s schema renderer consumes `profileSnapshot.schema`, `uiSchema`, and `userValues`.
- Chat creation calls `newChatModelDefaults()` to snapshot the default model regime (`database.svelte.ts:808`).
- Model-binding UI reads/writes `chat.modelBinding`; prompt-binding UI reads/writes `chat.bindedBotPreset`.
- Prompt construction reads preset context/output limits at `process/index.svelte.ts:267`.
- Request dispatch calls `resolveChatModelBinding()`, `applyPromptPresetParams()`, and `buildModelPresetCredential()` (`request.ts:382`, `request.ts:680`).
- The prompt-preset UI uses `downloadPreset()` and `importPreset()`; URL/PWA imports also route those extensions through `characterCards.ts:492`.

### Calls out to other subsystems

- Registry sync uses `fetchNative()` and reactive `DBState` (`remote.ts:16`).
- API-key CRUD uses `getDatabase()` and UUID generation (`apiKeyPool.ts:1`).
- Adapter request dispatch uses the classic prompt formatter, MCP tool execution, streaming pump, request-status channel, tokenizer, and `fetchNative`.
- Service-account exchange depends on the Node server endpoint and the session `risu-auth` token (`googleServiceAccount/token.ts:35`).
- Gemini caching depends on browser `localStorage` and provider `cachedContents` REST endpoints.
- UI imports alerts, file selection/download helpers, Svelte stores, and schema-driven controls.
- Default prompt text comes from `src/ts/process/templates/templates`.

## 5. Conventions & gotchas

- A profile is a blueprint; a preset is a frozen installation. Do not read the live registry during normal request dispatch or registry updates would silently alter existing chats.
- `ModelPreset.profileSnapshot` must be self-contained enough to render a form and build a request. Missing auth, endpoint, schema, UI fields, or an auth-mapped credential field is considered degenerate (`dbDefaults.ts:74`).
- `sourceProfile` is provenance and update metadata, not the runtime source of truth. Requests use `profileSnapshot`.
- Production update badges compare `updatedAt`, not `version`. Missing timestamps intentionally mean “unknown/no badge” (`customProfiles.ts:179`).
- The richer `profileUpdate.ts` API is not wired into production UI. Its `orphanValues` behavior differs from the live `migrateUserValues()` path, which drops obsolete values after confirmation.
- Profile replacement preserves same-key values without checking field type (`customProfiles.ts:200`). The unused `applyProfileSnapshotUpdate()` does perform type-change checks.
- Custom profile/base-provider IDs must remain under `custom::`; otherwise official imports could collide with bundled identities.
- Custom profile fragments intentionally contain no API keys. Credentials live on `ModelPreset.userValues`, `inlineCredential`, or `apiKeyRef`.
- `resolveSnapshot()` merges by field key. A profile schema/UI entry replaces the corresponding base entry rather than shallow-merging individual attributes (`snapshot.ts:100`, `snapshot.ts:118`).
- Official remote sync is all-or-nothing. A single malformed profile/base relationship rejects the catalog (`remote.ts:75`).
- A custom registry base URL must be HTTPS. Enabling a blank/non-HTTPS URL fails loudly instead of falling back to the official registry (`remote.ts:60`).
- Registry mutations that must update UI should assign new outer objects. Remote sync and API-key CRUD already do this; in-place nested mutation can be missed by Svelte.
- `botPresetsId` is intentionally index-based for RisuAI backup compatibility. New binding code should use stable preset IDs and `withStableActivePreset()` around reorder/delete.
- Switching a prompt preset copies its values into global DB fields. Directly mutating a non-active `botPreset` does not automatically update those globals.
- Since v6, `setPreset()` deliberately does not replace separated auxiliary model configuration when changing prompt presets (`database.svelte.ts:2611`).
- A chat-bound prompt preset currently works by synchronizing the global active prompt preset on chat entry. It is not an isolated per-request prompt snapshot.
- Model presets do not normally influence prompt text. They affect token budgeting, optional prompt-preset sampling overrides, message normalization, and wire dispatch.
- `usePromptPresetParams` is main-request-only and schema-gated. It never injects output limits or thinking configuration (`modelPresetBinding.ts:205`).
- Prompt-preset temperature/frequency/presence values use the classic hundredths scale; model preset fields use provider wire values. The bridge converts the former at `modelPresetBinding.ts:231`.
- `customBody`, custom headers, and additional parameters are power-user layers, but adapter-owned model/messages/stream/tools always win.
- An empty schema text/combobox value is treated as unset by `buildPreparedRequest()` (`buildRequest.ts:30`). An explicitly present invalid `modelId`, however, is a hard configuration error (`wireInvariants.ts:21`).
- Auth is applied last and removes case-insensitive conflicting header names. Additional parameters cannot hijack the effective authorization header.
- Tool use defaults off even when the profile supports tools. Tool requests force the non-streaming multi-step loop.
- Capability-less profiles are treated leniently for streaming but strictly for tools/cache. Tools and caching require explicit capability declarations.
- System folding is allowed only on `openai-compatible`; Anthropic and Gemini hoist system messages natively.
- `reformater()` mutates its input, so the preset request path clones the prompt first (`request.ts:776`).
- There is no automatic API-key rotation. “Pool” means saved named credentials selectable by ID.
- Deleting a key does not clear presets that reference it. The UI exposes a dangling-reference state, and runtime credential resolution may fall through to inline/direct values.
- Updating one key entry changes every preset referencing that ID. This also invalidates Gemini cache reuse through credential fingerprinting.
- `fallbackModelPresetIds` and the model-preset migration-report types are currently persisted/type-level scaffolding without runtime retry/migration logic.
- Gemini context caches require a native `message.cachePoint`; enabling caching alone does not create a boundary.
- Gemini cache state belongs in `localStorage`, not the database or export files.
- Google service-account preparation must go through `prepareAdapterRequest()`. Calling `buildPreparedRequest()` directly with raw service-account JSON could treat the JSON as a bearer token.
- Service-account token refresh is shared across callers and is not cancelled when one request aborts; only that caller’s wait is cancelled (`googleServiceAccount/cache.ts:61`).
- The current binary exporter produces `.risup`, while `.risupreset` remains an accepted legacy input. Do not infer encoding solely from the internal function argument name.
- `.risup`/`.risupreset` export scrubs known legacy credentials, but `.profile.json` is the only profile-sharing format and should remain key-free by construction.
- Tests exercise malformed/null registry data heavily; preserving null-tolerant resolution and load sanitization is a compatibility requirement.

## 6. Navigation hints

- To add a new adapter protocol, update `AdapterKind` and capability allowlists in `src/ts/preset/types.ts:3`, then add dispatch branches in `src/ts/process/request/request.ts:495`.
- To add a new provider, create a base-provider JSON matching `BaseProviderDefinition` (`src/ts/preset/types.ts:156`) and place it under `src/ts/preset/registry/bundled/base-providers/`.
- To add or revise a model profile, edit its JSON under `src/ts/preset/registry/bundled/profiles/`; profile identity/timestamp/model fields follow `src/ts/preset/types.ts:184`.
- To change base/profile merge semantics, start at `src/ts/preset/registry/snapshot.ts:36`.
- To change remote registry validation or adoption, start at `src/ts/preset/registry/remote.ts:75` and `src/ts/preset/registry/remote.ts:158`.
- To change which profiles appear in the browser, inspect `src/ts/preset/registry/visibility.ts:13` and `src/lib/Setting/modelProfileBrowser.svelte:74`.
- To change profile creation defaults, inspect `seedDefaults()` and `createPresetFrom()` at `src/lib/Setting/modelProfileBrowser.svelte:137` and `:156`.
- To change custom-profile file validation or namespace rules, inspect `src/ts/preset/customProfiles.ts:80` and `:130`.
- To change the live profile-update behavior, modify `src/ts/preset/customProfiles.ts:179`, `:200`, and `src/lib/Setting/Pages/Model/ModelPresetBasicInfo.svelte:79`; changing only `profileUpdate.ts` will not affect the current UI.
- To adopt the richer orphan-preserving update path, inspect `src/ts/preset/profileUpdate.ts:118` and wire it explicitly into the UI.
- To change load-time repair of corrupted presets, inspect `src/ts/preset/dbDefaults.ts:32`, `:74`, and `:95`.
- To add a field to persisted model presets, update `ModelPreset` at `src/ts/preset/types.ts:252`, its editor, and any relevant capability/request gates.
- To change per-chat model selection, inspect `src/ts/process/request/modelPresetBinding.ts:42` and `src/lib/SideBars/ModelBind.svelte`.
- To change how prompt-preset parameters override a model preset, inspect `src/ts/process/request/modelPresetBinding.ts:191`.
- To change prompt text/template defaults, inspect `src/ts/storage/defaultPrompts.ts:3` and the upstream-compatible `presetTemplate` at `src/ts/storage/database.svelte.ts:2230`.
- To add a field to the upstream-compatible prompt preset, update `botPreset` at `src/ts/storage/database.svelte.ts:1723`, `presetTemplate` at `:2230`, `saveCurrentPreset()` at `:2406`, and `setPreset()` at `:2531`.
- To change active prompt-preset compatibility behavior, inspect the stable-ID helpers at `src/ts/storage/database.svelte.ts:2339`.
- To change `.risup`/`.risupreset` encoding, redaction, or import compatibility, inspect `src/ts/storage/database.svelte.ts:2846` and `:2895`.
- To change saved-key selection priority, inspect `src/ts/process/request/modelPresetBinding.ts:264`.
- To implement real API-key rotation, add explicit pool/list state and retry policy; current CRUD at `src/ts/preset/apiKeyPool.ts:17` and credential resolution at `src/ts/process/request/modelPresetBinding.ts:278` select only one key.
- To change generic request merge precedence, inspect `src/ts/preset/adapter/buildRequest.ts:15`.
- To protect another wire field from power-user overrides, enforce it after `buildPreparedRequest()` as the existing adapters do at `openaiCompatible.ts:146`, `anthropicMessages.ts:151`, and `googleGemini.ts:201`.
- To change streaming parsing, inspect `src/ts/preset/adapter/sse.ts:3` plus the target provider’s stream parser.
- To change service-account validation or refresh behavior, inspect `src/ts/preset/adapter/googleServiceAccount/serviceAccount.ts:32` and `cache.ts:39`.
- To change Gemini cache eligibility, inspect `src/ts/process/request/request.ts:722`; for decision/state behavior use `src/ts/preset/cache/geminiContextCache.ts:284` and `:341`.
- To change Gemini cached-body wiring or stale-write handling, inspect `src/ts/preset/cache/geminiCacheWiring.ts:57` and `:172`.

## Out of scope, noticed

- `src/ts/process/request/` owns the broader classic-versus-preset request pipeline, streaming presentation, tool execution, and request-status reporting.
- `src/ts/process/index.svelte.ts` owns full prompt assembly, memory/lore/template processing, and token trimming.
- `server/node/server.cjs:3161` implements the authenticated Node-side Google service-account JWT signing and OAuth exchange endpoint.
- `src/ts/process/prompt.ts` contains SillyTavern/parameter-preset conversion logic beyond the `.risup` compatibility entry points documented above.