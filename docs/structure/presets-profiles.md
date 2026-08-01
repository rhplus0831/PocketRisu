# Presets and profiles

> Part of the PocketRisu structure docs — see [STRUCTURE.md](../../STRUCTURE.md) for the top-level map and subsystem index.
> Audited 2026-08-01 against `818c3bc1`. Paths and symbols are authoritative; line-number hints are approximate and should be verified with `rg`.

## 1. Purpose & overview

This subsystem separates PocketRisu’s model/provider configuration from the upstream RisuAI-style prompt preset. A registry `ModelProfile` is a reusable provider/model blueprint; selecting one creates a persisted `ModelPreset` containing a frozen resolved snapshot plus the user’s credentials, parameter values, and per-model behavior toggles.

The older `botPreset` remains the prompt preset: it owns prompt text/template, sampling parameters, and compatibility fields used by RisuAI `.risup`/`.risupreset` files. Prompt construction still consumes the active `botPreset`; request dispatch can independently use a chat- or module-bound `ModelPreset`. Adapter execution, streaming, tools, transport, and recovery belong to [Model providers](model-providers.md).

The subsystem also manages official registry sync, imported custom-profile fragments, explicit profile updates, saved API keys, Google service-account tokens, and Gemini explicit context caches. Imported custom fragments and backup files are configuration data, not automatically secret-free artifacts.

## 2. Key files

### Core types and persistence

| File | Role and important symbols |
|---|---|
| `src/ts/preset/types.ts` | Central schema. `AdapterKind` defines the three implemented protocols (`types.ts:3`); `BaseProviderDefinition` holds provider-wide wire/schema defaults (`types.ts:156`); `ModelProfile` describes a registry model (`types.ts:184`); `ResolvedModelProfileSnapshot` is the frozen merged form stored on a preset (`types.ts:233`); `ModelPreset` is the user-editable runtime configuration (`types.ts:252`). `ModelBindingSet` describes per-chat main/sub/aux bindings (`types.ts:379`), `emptyModelBinding()` normalizes empty Svelte bindings (`types.ts:394`), and `ApiKeyPoolEntry` describes saved credentials (`types.ts:398`). Registry/update/cache types start at `types.ts:407`. |
| `src/ts/storage/database.svelte.ts` | Shared database definition and compatibility layer. `setDatabase()` fills prompt defaults and stable prompt-preset IDs, then invokes `applyModelPresetDefaults()` at the load boundary (`database.svelte.ts:796`). `Database` stores `botPresets`/`botPresetsId`, model-profile state, the new-chat default binding, and the global `moduleModelBindings` map. `botPreset` begins at `database.svelte.ts:1836`; `Chat.bindedBotPreset`, `useModelPreset`, `modelBinding`, and `usePromptPresetParams` begin at `database.svelte.ts:2147`. |
| `src/ts/storage/defaultPrompts.ts` | Re-exports `prebuiltPresets.OAI.mainPrompt` and `.jailbreak` as the defaults (`defaultPrompts.ts:3`), preserves exact old prompt strings for migration (`defaultPrompts.ts:5`), and defines the default response-suggestion prompt (`defaultPrompts.ts:7`). |
| `src/ts/preset/dbDefaults.ts` | Model-preset database normalization. `createEmptyRegistryCache()` returns schema version 4 (`dbDefaults.ts:16`). `applyModelPresetDefaults()` initializes preset/key/cache collections and visibility defaults, sanitizes malformed stored snapshots, and heals resolvable degenerate snapshots (`dbDefaults.ts:174`). Snapshot sanitization is at `dbDefaults.ts:32`; healing is at `dbDefaults.ts:95`. |
| `src/ts/preset/apiKeyPool.ts` | CRUD over `db.apiKeyPool`. `listApiKeys()` filters by provider and sorts by last update (`apiKeyPool.ts:17`); `getApiKey()` resolves an ID (`apiKeyPool.ts:24`); add/update/remove are at `apiKeyPool.ts:29`, `apiKeyPool.ts:44`, and `apiKeyPool.ts:55`. Every mutation replaces the pool object to trigger Svelte 5 reactivity. |

### Registry and profile lifecycle

| File | Role and important symbols |
|---|---|
| `src/ts/preset/registry/loader.ts` | Eagerly loads bundled JSON through `import.meta.glob` (`loader.ts:5`, `loader.ts:10`). `loadBundledRegistry()` memoizes the schema-v4 registry (`loader.ts:40`); `getBundledRegistryId()` returns `"bundled"` (`loader.ts:47`). |
| `src/ts/preset/registry/bundled/base-providers/*.json` | Provider-wide protocol definitions: adapter kind, common auth field, endpoint kinds, headers/body defaults, capabilities, and UI schema. For example, OpenAI selects `openai-compatible` at `base-providers/openai.json:5` and defines its auth field at `base-providers/openai.json:16`. |
| `src/ts/preset/registry/bundled/profiles/**/*.json` | Concrete provider/model profiles. Each supplies model ID, endpoint/auth, model-specific fields, limits, status, timestamps, and capabilities. `profiles/openai/gpt-55.json:2` defines the profile identity, `:19` the model ID, `:20` its update timestamp, and `:32` its extension schema. |
| `src/ts/preset/registry/snapshot.ts` | Converts a base provider plus profile into a request-ready frozen snapshot. `resolveSnapshot()` merges schemas, UI schemas, defaults, headers, capabilities, and limits (`snapshot.ts:36`). Missing-profile/base-provider errors are at `snapshot.ts:12` and `snapshot.ts:24`. Profile fields override same-key base fields (`snapshot.ts:100`, `snapshot.ts:118`). |
| `src/ts/preset/registry/remote.ts` | Fetches the official or custom-hosted registry. `syncRemoteRegistry()` uses `index.json` as a content-hash gate and atomically replaces the official cache entry (`remote.ts:158`); it preserves the custom registry at `remote.ts:224`. `getOfficialRegistry()` chooses the populated remote cache or bundled fallback (`remote.ts:247`). `getPresetUpdateStatus()` performs timestamp-based source lookup (`remote.ts:258`). |
| `src/ts/preset/registry/visibility.ts` | Display-only filtering for current/outdated/deprecated profiles through `isProfileVisible()` (`visibility.ts:13`). |
| `src/ts/preset/registry/notice.ts` | Builds the “new/updated models” banner. `buildSeenMap()` snapshots profile timestamps (`notice.ts:31`); `computeRegistryNotice()` compares them while respecting visibility (`notice.ts:40`). |
| `src/ts/preset/registry/i18n.ts` | Locale selection and registry-string fallback. `localizeDisplayName()`, `localizeDescription()`, and `localizeGroupLabel()` are at `i18n.ts:21`, `i18n.ts:28`, and `i18n.ts:35`. |
| `src/ts/preset/registry/index.ts` | Public registry barrel: bundled loading, snapshot resolution, remote sync, update status, and visibility. |
| `src/ts/preset/customProfiles.ts` | Custom-profile import/export and production update helpers. Custom objects live under registry ID `"custom"` with `custom::` IDs (`customProfiles.ts:25`). `ProfileFragment` is the self-contained profile-plus-base-provider file shape (`customProfiles.ts:32`); build/validate/import are at `customProfiles.ts:52`, `customProfiles.ts:80`, and `customProfiles.ts:130`. Timestamp update status is at `customProfiles.ts:179`; production value migration is at `customProfiles.ts:200`; snapshot-to-fragment export and deletion are at `customProfiles.ts:223` and `customProfiles.ts:265`. |
| `src/ts/preset/profileUpdate.ts` | A more detailed, version-oriented snapshot migration API. `getProfileUpdateAvailability()` classifies source/current/downgrade/missing states (`profileUpdate.ts:34`); `diffProfileSnapshot()` produces structural schema/UI/wire diffs (`profileUpdate.ts:95`); `applyProfileSnapshotUpdate()` keeps compatible values and moves removed/type-changed values into `orphanValues` (`profileUpdate.ts:118`). This module is covered by tests but currently has no non-test production importer. |

### Binding helpers

| File | Role and important symbols |
|---|---|
| `src/ts/process/request/modelPresetBinding.ts` | `resolveChatModelBinding()` selects a per-module override or the chat's classic/ModelPreset regime and main/sub/aux slot (`modelPresetBinding.ts:42`). The same module resolves ModelPreset output-token limits, copies supported prompt-preset sampling values, and applies credential precedence. |
| `src/ts/process/moduleModelBinding.ts` | `listModelCallingModules()` identifies installed low-level-access modules whose trigger/code effects can issue direct model requests, which supplies the global module-binding settings rows (`moduleModelBinding.ts:31`). |

### Credential and transient cache state

| File | Role and important symbols |
|---|---|
| `src/ts/preset/adapter/googleServiceAccount/serviceAccount.ts` | Parses and validates service-account JSON (`serviceAccount.ts:32`). It restricts `token_uri` to Google’s OAuth endpoint to prevent signed-JWT exfiltration/SSRF (`serviceAccount.ts:21`). |
| `src/ts/preset/adapter/googleServiceAccount/cache.ts` | In-memory access-token cache. `createServiceAccountTokenCache()` deduplicates refreshes by token URI, email, and scope and refreshes with 60 seconds of skew (`cache.ts:39`). The default singleton is exposed at `cache.ts:134`. |
| `src/ts/preset/cache/geminiContextCache.ts` | Owns `ModelPreset.promptCaching` defaults and transient cache-reference state. `resolveGeminiCacheConfig()` normalizes configuration (`geminiContextCache.ts:53`); `buildGeminiCacheKey()` keys entries by chat, task, and preset (`geminiContextCache.ts:82`); entry reads/writes mirror the in-memory map to `localStorage` rather than the database (`geminiContextCache.ts:90`, `geminiContextCache.ts:136`). Provider-side cache-body construction and REST lifecycle belong with adapter execution in [Model providers](model-providers.md). |

### UI touchpoints

| File | Role and important symbols |
|---|---|
| `src/lib/Setting/modelProfileBrowser.svelte` | Official/custom profile modal. It scopes registries by tab (`modelProfileBrowser.svelte:48`), creates a preset from a resolved snapshot (`modelProfileBrowser.svelte:156`), replaces a preset profile with value migration (`modelProfileBrowser.svelte:187`), and imports/exports `.profile.json` fragments (`modelProfileBrowser.svelte:234`, `modelProfileBrowser.svelte:245`). |
| `src/lib/Setting/modelpreset.svelte` | Compact model-preset selection/list modal. It supports reorder, duplicate, delete, and callback-based chat binding (`modelpreset.svelte:30`, `modelpreset.svelte:53`, `modelpreset.svelte:66`, `modelpreset.svelte:125`). Editing now routes to the full settings page (`modelpreset.svelte:88`). |
| `src/lib/Setting/Pages/Model/ModelPresetSettings.svelte` | Current full editor. It syncs the remote registry on mount, renders schema-driven fields, abilities/cache controls, test requests, key-pool manager, update indicators, and the global module-binding tab. Preset creation opens the profile browser. |
| `src/lib/Setting/Pages/Model/ModelPresetBasicInfo.svelte` | Current profile/source panel. Timestamp-based lookup is at `ModelPresetBasicInfo.svelte:49`; one-click update re-resolves and migrates values at `ModelPresetBasicInfo.svelte:79`; export emits a profile fragment at `ModelPresetBasicInfo.svelte:105`. |
| `src/lib/Setting/Pages/Model/CredentialField.svelte` | Chooses direct credentials or a single saved `apiKeyRef`. Direct mode clears any pooled reference (`CredentialField.svelte:42`); saving a direct key adds it to the pool and binds the preset (`CredentialField.svelte:68`). |
| `src/lib/Setting/Pages/Model/ModuleModelBindingList.svelte` | Lists globally installed model-calling modules, stores `moduleId -> ModelPreset.id` selections outside the portable module object, and visibly preserves dangling selections rather than deleting them. |

### Tests

The subsystem has extensive unit and integration coverage:

- Core lifecycle: `apiKeyPool.test.ts`, `customProfiles.test.ts`, `dbDefaults.test.ts`, `profileUpdate.test.ts`, and `profileUpdate.integration.test.ts`.
- Registry: `loader.test.ts`, `snapshot.test.ts`, `snapshotNullSafety.test.ts`, `remote.test.ts`, `notice.test.ts`, and `visibility.test.ts`.
- Credentials and cache state have dedicated service-account parser/token-cache and Gemini context-cache suites.
- Provider adapter, streaming, tool-loop, transport, and recovery coverage is indexed in [Model providers](model-providers.md).

## 3. Architecture & data flow

### Profile versus preset concepts

PocketRisu uses three similarly named but distinct concepts:

1. A `ModelProfile` is registry metadata: provider base ID, endpoint/auth shape, default model, editable schema, UI schema, capabilities, limits, status, and source timestamps (`types.ts:184`).
2. A `ModelPreset` is a user-owned installation of a profile: it freezes a `ResolvedModelProfileSnapshot`, stores user values and credentials, and adds behavior such as streaming, tool use, vision/system-role toggles, context budget, caching, and ordering (`types.ts:252`).
3. A `botPreset` is the upstream-compatible prompt preset. It stores prompt text/template, sampling values, legacy model/provider fields, regex/tools, and other global chat-bot settings (`database.svelte.ts:1723`).

A “custom profile” is therefore not an upstream RisuAI preset, a `customModels[]` entry, or the separately configured custom remote registry. It is an imported profile/base-provider fragment stored in `modelProfileRegistryCache.registries.custom`; it must still be instantiated as a `ModelPreset` before a chat can use it.

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
        │ chat/module binding stores preset ID
        ▼
model-provider request subsystem
```

- `loader.ts:17` builds the bundled registry from JSON modules.
- `remote.ts:158` optionally updates the persisted official entry using a content hash. Failures leave the previous cache/bundle untouched.
- `modelProfileBrowser.svelte:156` resolves the selected profile.
- `snapshot.ts:36` combines common provider fields and profile overrides. Schema/UI entries replace same-key base entries; body defaults, headers, and limits shallow-merge. Profile capabilities replace the base capability set when present, rather than forming a union.
- `modelProfileBrowser.svelte:137` seeds `userValues` from merged schema-field defaults. Snapshot-level `defaults` remain a separate body-default layer.
- The resulting preset is appended to `db.modelPresets` at `modelProfileBrowser.svelte:178`.
- Chat binding stores only preset IDs; the persisted snapshot means future registry changes do not silently alter existing requests.

### Custom-profile flow

- Export builds a schema-version-1 fragment containing one profile and its base provider (`customProfiles.ts:31`, `customProfiles.ts:52`).
- Import performs shallow structural validation of the untrusted JSON (`customProfiles.ts:80`), namespaces both IDs with `custom::`, fills missing type-only versions/timestamps, and writes the pair into the custom registry (`customProfiles.ts:130`). Nested schema, endpoint, header, and default contents remain user-controlled configuration.
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

`setDatabase()` calls `applyModelPresetDefaults()` before installing state (`database.svelte.ts:796`).

That normalization:

- ensures `modelPresets` is an array and the API-key pool/cache have valid container shapes;
- defaults profile visibility to `currentOnly`;
- removes null elements from stored snapshot schema/UI arrays (`dbDefaults.ts:32`);
- detects snapshots missing auth, endpoint, fields, or an auth-mapped credential field (`dbDefaults.ts:74`);
- re-resolves broken snapshots against the persisted official cache and then the bundled registry (`dbDefaults.ts:95`);
- migrates compatible user values and moves lost values into `orphanValues` (`dbDefaults.ts:130`).

This load-boundary mutation is intentional and persists on the next database save.

### Prompt-preset flow

`botPresetsId` remains the physical active-preset index for upstream backup compatibility (`database.svelte.ts:1092`). New code can address prompt presets by stable `botPreset.id` through helpers beginning at `database.svelte.ts:2452`.

- `changeToPreset()` saves the current prompt preset and installs the selected one into global database fields (`database.svelte.ts:2636`).
- `setPreset()` copies prompt text, prompt template, sampling parameters, and legacy settings into the global database (`database.svelte.ts:2651`).
- A chat’s `bindedBotPreset` stores a stable ID, but `PromptBind.svelte` resolves it to the current array index and calls `changeToPreset()` so legacy prompt code can continue reading `db.botPresetsId` (`PromptBind.svelte:17`, `PromptBind.svelte:29`). This synchronization is driven by the side-chat binding UI, not by an unconditional request-time resolver.
- Reorder/delete code should preserve the active stable ID through `withStableActivePreset()` (`database.svelte.ts:2508`).

### Prompt and model-preset boundary

Prompt and model presets meet only at a few explicit points:

- Prompt construction uses the global values installed from the active `botPreset`: `db.promptTemplate` is cloned at `process/index.svelte.ts:298`; without a template, `db.mainPrompt` is used at `process/index.svelte.ts:346`.
- Before building the prompt, a bound main `ModelPreset` changes the input budget and output-token reservation using `preset.maxContext`, profile limits, and preset output fields (`process/index.svelte.ts:257`).
- If the chat resolves to a `ModelPreset`, the optional `usePromptPresetParams` bridge injects only supported sampling fields from the active prompt preset into a copy of `userValues` (`modelPresetBinding.ts:252`). Prompt content is not changed here.

After binding and optional parameter bridging, [Model providers](model-providers.md) owns classic-versus-ModelPreset dispatch, adapter request construction, capability gates, streaming, tools, fallback behavior, transport, recovery, and provider wire formats.

### Model binding resolution

`resolveChatModelBinding()` at `modelPresetBinding.ts:42` decides between classic, preset, and blocked states.

- An enabled, resolvable `moduleModelBindings[moduleId]` wins before the global regime lock and before chat slots. A missing or dangling module binding falls through to normal chat resolution instead of blocking.
- `nodeOnlyModelModeLock` can force all chats to classic or preset mode.
- Otherwise, `chat.useModelPreset` controls the regime.
- Main requests use `modelBinding.main`; submodel requests use `.sub`.
- Aux tasks use their dedicated slot only when `separateAux` is enabled and the slot resolves; otherwise they fall back to sub.
- Under a global preset lock, a pre-existing chat with no binding bundle may use `db.defaultModelBinding`; without that lock there is no live default fallback. Missing and dangling main/sub IDs in the selected bundle block rather than silently choosing a different model.
- New chats snapshot `db.defaultModelBinding` through `newChatModelDefaults()` (`database.svelte.ts:870`); existing chats do not follow later default changes.

The per-module override applies only when a request carries the originating `moduleId`. Active module triggers are copied and annotated with that ID, and low-level script engines retain it while issuing direct `LLMMain`/`simpleLLM`/`axLLMMain` or `runLLM`/`v2RunLLM` requests. A trigger's `sendAIprompt` flag starts the ordinary user-visible chat reply and intentionally keeps the chat's own binding. Bindings live in the database rather than `RisuModule`, so sharing a `.risum` never leaks environment-local preset IDs.

### API key pool and “rotation”

Each preset has one optional `apiKeyRef`, not a list or round-robin pool. Credential resolution order is:

1. the referenced `db.apiKeyPool` entry;
2. `inlineCredential`;
3. the first non-empty schema field mapped to `auth`.

This is implemented by `buildModelPresetCredential()` at `modelPresetBinding.ts:293`. A dangling or empty pool entry falls through to later sources.

There is no automatic key rotation, retry-across-keys, or provider quota balancing. Updating an existing pool entry effectively rotates that credential immediately for every preset referencing its stable ID. For Gemini context caching, the configured credential is fingerprinted (`geminiContextCache.ts:249`); a changed API key or service-account JSON produces a cache miss rather than reusing a cache owned by the old credential. A routine Vertex OAuth access-token refresh does not change this fingerprint because the cache identity uses the raw configured service-account credential.

`ModelPreset.fallbackModelPresetIds` exists in persisted configuration (`types.ts:335`) but has no production consumer. It does not currently provide retry or rotation behavior; runtime fallback behavior is documented in [Model providers](model-providers.md).

### Cache layers

Three unrelated caches should not be conflated:

- `modelProfileRegistryCache` is persisted database state containing official and custom profile catalogs.
- The service-account token cache is an in-memory singleton keyed by account/scope (`googleServiceAccount/cache.ts:39`).
- Gemini context-cache state is transient and mirrored to `localStorage` under `nodeOnlyGeminiCacheState`, never stored in the database (`geminiContextCache.ts:1`, `geminiContextCache.ts:20`).

`ModelPreset.promptCaching` is optional and defaults off. Runtime eligibility additionally requires a Google-native profile with explicit cache capability and a main, non-tool, non-preview request (`request.ts:807`). Cache identity is `chat ID + task + preset ID`; each transient entry also records model, prefix hash, boundary, expiry, and credential fingerprint (`geminiContextCache.ts:70`, `geminiContextCache.ts:82`). Provider-side boundary application, remote `cachedContents` lifecycle, retry behavior, and transport belong with adapter execution in [Model providers](model-providers.md) and are not repeated here.

### `.risup`, `.risupreset`, and profile export formats

The Risu formats apply to `botPreset`, not `ModelPreset`.

`downloadPreset()` at `database.svelte.ts:2966`:

- for the active preset, builds a non-mutating snapshot of the live global
  prompt/model fields through the same pure builder used by
  `saveCurrentPreset()`;
- for an inactive preset, clones the selected stored `botPreset` directly;
- preserves the live `autoSuggestPrompt`, `autoSuggestPrefix`, and `autoSuggestClean` fields and the stored preset image in that active snapshot (`createCurrentBotPresetSnapshot()` at `database.svelte.ts:2520`);
- blanks API keys, proxy keys, forced URLs, and WebUI URLs (`database.svelte.ts:2973`);
- for the binary path, MessagePack-encodes the preset, encrypts it with the `"risupreset"` context, wraps it in `{presetVersion: 2, type: "preset"}`, compresses it, then RPack-encodes it;
- despite the API argument being named `"risupreset"`, the current exporter writes a `.risup` filename.

The active snapshot builder is an allowlist, not an arbitrary-property clone. It omits inactive compatibility fields such as `forceReplaceUrl2` and legacy per-preset model-binding fields, and deliberately emits `seperateModelsForAxModels: false`/`seperateModels: null` because separated auxiliary model configuration is database-global. Inactive export preserves its stored fields until the known-secret redaction step.

`importPreset()` accepts JSON, legacy `.risupreset`, and `.risup` (`database.svelte.ts:3017`):

- `.risup` is first unwrapped with `decodeRPack`; `.risupreset` is treated as the older raw compressed envelope (`database.svelte.ts:3028`);
- binary envelopes with preset versions 0 or 2 and type `"preset"` are decrypted and merged onto `presetTemplate` (`database.svelte.ts:3035`);
- JSON also merges onto `presetTemplate`;
- NovelAI parameter files and SillyTavern prompt layouts have separate conversion branches (`database.svelte.ts:3047`, `database.svelte.ts:3072`);
- every imported ordinary preset receives a fresh stable ID before being appended (`database.svelte.ts:3179`).

Ordinary imports merge onto `presetTemplate`, then `normalizePromptTemplate()` deep-clones the template and repairs invalid or legacy roles for plain, jailbreak, chain-of-thought, typed, and cache items. Prompt-preset interchange is therefore compatibility-normalized rather than byte-for-byte preservation (`database.svelte.ts:3206`).

Model profiles instead use plain `.profile.json` fragments (`modelProfileBrowser.svelte:241`, `ModelPresetBasicInfo.svelte:105`). Fragment export normally omits a preset's direct credentials, but the flexible profile/base-provider fields are not scrubbed recursively; inspect hand-edited or imported fragments before sharing. There is no dedicated standalone `ModelPreset` import/export format; model presets and direct credentials persist as part of the PocketRisu database/backup.

## 4. Entry points & dependencies

### Called from other subsystems

- Database hydration calls `applyModelPresetDefaults()` from `setDatabase()` (`database.svelte.ts:796`).
- Full model settings calls `syncRemoteRegistry()`, update-notice helpers, and `testModelPreset()` (`ModelPresetSettings.svelte:47`, `ModelPresetSettings.svelte:158`).
- The profile browser calls registry resolution and custom fragment functions (`modelProfileBrowser.svelte:8`).
- The model preset editor’s schema renderer consumes `profileSnapshot.schema`, `uiSchema`, and `userValues`.
- Chat creation calls `newChatModelDefaults()` to snapshot the default model regime (`database.svelte.ts:870`).
- Model-binding UI reads/writes `chat.modelBinding`; prompt-binding UI reads/writes `chat.bindedBotPreset`.
- Module-binding UI reads/writes the global `db.moduleModelBindings` map. Module trigger LLM actions, Lua effects, and button callbacks pass their source `moduleId` into request binding resolution; Lua edit listeners do not propagate module ownership.
- Prompt construction reads preset context/output limits at `process/index.svelte.ts:267`.
- The provider subsystem consumes `resolveChatModelBinding()`, `applyPromptPresetParams()`, and `buildModelPresetCredential()`; its execution flow is documented in [Model providers](model-providers.md).
- The prompt-preset UI uses `downloadPreset()` and `importPreset()`; URL/PWA imports also route those extensions through `characterCards.ts:492`.

### Calls out to other subsystems

- Registry sync uses `fetchNative()` and reactive `DBState` (`remote.ts:16`).
- API-key CRUD uses `getDatabase()` and UUID generation (`apiKeyPool.ts:1`).
- Service-account exchange depends on the Node server endpoint and the session `risu-auth` token (`googleServiceAccount/token.ts:35`).
- Gemini cache-reference state depends on browser `localStorage`; provider-side `cachedContents` calls belong to [Model providers](model-providers.md).
- UI imports alerts, file selection/download helpers, Svelte stores, and schema-driven controls.
- Default prompt text comes from `src/ts/process/templates/templates.ts`.

## 5. Conventions & gotchas

- A profile is a blueprint; a preset is a frozen installation. Do not read the live registry during normal request dispatch or registry updates would silently alter existing chats.
- `ModelPreset.profileSnapshot` must be self-contained enough to render a form and build a request. Missing auth, endpoint, schema, UI fields, or an auth-mapped credential field is considered degenerate (`dbDefaults.ts:74`).
- `sourceProfile` is provenance and update metadata, not the runtime source of truth. Requests use `profileSnapshot`.
- Production update badges compare `updatedAt`, not `version`. Missing timestamps intentionally mean “unknown/no badge” (`customProfiles.ts:179`).
- The richer `profileUpdate.ts` API is not wired into production UI. Its `orphanValues` behavior differs from the live `migrateUserValues()` path, which drops obsolete values after confirmation.
- Profile replacement preserves same-key values without checking field type (`customProfiles.ts:200`). The unused `applyProfileSnapshotUpdate()` does perform type-change checks.
- Custom profile/base-provider IDs must remain under `custom::`; otherwise official imports could collide with bundled identities.
- Preset credentials normally live in `ModelPreset.userValues`, `inlineCredential`, or `apiKeyRef`; the key-pool UI's provider label is organizational, not a runtime compatibility gate. Credential resolution can still fall through from a missing/empty referenced key to direct values.
- `resolveSnapshot()` merges by field key. A profile schema/UI entry replaces the corresponding base entry rather than shallow-merging individual attributes (`snapshot.ts:100`, `snapshot.ts:118`).
- `capabilities` use profile-or-base fallback, not union semantics. Limits and default body/header maps have their own shallow-merge rules.
- Official remote sync is all-or-nothing. A single malformed profile/base relationship rejects the catalog (`remote.ts:75`).
- A custom registry base URL must be HTTPS. Enabling a blank/non-HTTPS URL fails loudly instead of falling back to the official registry (`remote.ts:60`).
- Registry mutations that must update UI should assign new outer objects. Remote sync and API-key CRUD already do this; in-place nested mutation can be missed by Svelte.
- `botPresetsId` is intentionally index-based for RisuAI backup compatibility. New binding code should use stable preset IDs and `withStableActivePreset()` around reorder/delete.
- Switching a prompt preset copies its values into global DB fields. Directly mutating a non-active `botPreset` does not automatically update those globals.
- Since v6, `setPreset()` deliberately does not replace separated auxiliary model configuration when changing prompt presets (`database.svelte.ts:2731`).
- A chat-bound prompt preset currently works by synchronizing the global active prompt preset on chat entry. It is not an isolated per-request prompt snapshot.
- That synchronization depends on `PromptBind` being mounted in the side-chat UI. Code paths that change chats without mounting that surface should not assume `bindedBotPreset` has already updated the global prompt preset.
- Model presets do not normally influence prompt text. In this subsystem they affect token budgeting and optional prompt-preset sampling overrides; their execution behavior belongs to [Model providers](model-providers.md).
- Per-module bindings are explicit global overrides and are off by default. They are stored outside `RisuModule`, valid bindings win even for a classic-regime chat, and dangling IDs remain stored but fall through to the chat's ordinary binding.
- `usePromptPresetParams` is main-request-only and schema-gated. It never injects output limits or thinking configuration (`modelPresetBinding.ts:205`).
- Prompt-preset temperature/frequency/presence values use the classic hundredths scale; model preset fields use provider wire values. The bridge converts the former at `modelPresetBinding.ts:231`.
- `customBody`, custom headers, additional parameters, ability toggles, and capability declarations are persisted preset configuration. Their merge precedence, wire invariants, and runtime gates belong to [Model providers](model-providers.md) and are not repeated here.
- There is no automatic API-key rotation. “Pool” means saved named credentials selectable by ID.
- Deleting a key does not clear presets that reference it. The UI exposes a dangling-reference state, and runtime credential resolution may fall through to inline/direct values.
- Updating one key entry changes every preset referencing that ID. This also invalidates Gemini cache reuse through credential fingerprinting.
- `fallbackModelPresetIds` and the model-preset migration-report types are currently persisted/type-level scaffolding without runtime retry/migration logic.
- `tokenizerOverride` and profile `recommendedTokenizer` are exposed in settings but do not currently select the chat tokenizer. Persisted ordering/pinning and migration-source metadata also include scaffolding with no request-path effect; verify a consumer before relying on any such field.
- Gemini cache state belongs in `localStorage`, not the database or export files.
- Google service-account JSON is validated before exchange, and access tokens are cached only in memory. Refresh work is shared across callers; cancelling one caller does not cancel the shared refresh (`googleServiceAccount/cache.ts:61`).
- The current binary exporter produces `.risup`, while `.risupreset` remains an accepted legacy input. Do not infer encoding solely from the internal function argument name.
- `.risup`/`.risupreset` export scrubs known legacy credential fields, not arbitrary nested secrets. `.profile.json` export omits the preset credential object but does not recursively prove every flexible configuration field secret-free. Full backups contain model presets and key-pool/direct credentials unless the target format explicitly strips them.
- Tests exercise malformed/null registry data heavily; preserving null-tolerant resolution and load sanitization is a compatibility requirement.

## 6. Navigation hints

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
- To change per-module model selection, inspect the override at `src/ts/process/request/modelPresetBinding.ts:50`, attribution in `src/ts/process/modules.ts`/`src/ts/process/scriptings.ts`, candidate filtering in `src/ts/process/moduleModelBinding.ts`, and `ModuleModelBindingList.svelte`.
- To change how prompt-preset parameters override a model preset, inspect `applyPromptPresetParams()` at `src/ts/process/request/modelPresetBinding.ts:252`.
- To change prompt text/template defaults, inspect `src/ts/storage/defaultPrompts.ts:3` and the upstream-compatible `presetTemplate` at `src/ts/storage/database.svelte.ts:2230`.
- To add a field to the upstream-compatible prompt preset, update `botPreset` at `src/ts/storage/database.svelte.ts:1836`, `presetTemplate`, `createCurrentBotPresetSnapshot()` at `:2520`, and `setPreset()` at `:2651`.
- To change active prompt-preset compatibility behavior, inspect the stable-ID helpers at `src/ts/storage/database.svelte.ts:2461`.
- To change `.risup`/`.risupreset` live-field capture, encoding, redaction, or import compatibility, inspect `createCurrentBotPresetSnapshot()`, `downloadPreset()`, `importPreset()`, and `normalizePromptTemplate()` in `src/ts/storage/database.svelte.ts`.
- To change saved-key selection priority, inspect `src/ts/process/request/modelPresetBinding.ts:293`.
- To implement real API-key rotation, add explicit pool/list state and retry policy; current CRUD at `src/ts/preset/apiKeyPool.ts:17` and credential resolution at `src/ts/process/request/modelPresetBinding.ts:293` select only one key.
- To change service-account validation or refresh behavior, inspect `src/ts/preset/adapter/googleServiceAccount/serviceAccount.ts:32` and `cache.ts:39`.
- To change Gemini cache configuration or transient state persistence, inspect `resolveGeminiCacheConfig()`, `buildGeminiCacheKey()`, and the entry accessors in `src/ts/preset/cache/geminiContextCache.ts:53`.
- For adapter protocols, request construction, wire invariants, streaming, tools, Gemini cache application, transport, or recovery, use the navigation map in [Model providers](model-providers.md).

## 7. Related structure docs

- [Model providers](model-providers.md) covers classic and ModelPreset dispatch, adapters, request construction, streaming, tools, fallback behavior, transport, recovery, and provider wire formats.
- [Chat pipeline](chat-pipeline.md) covers prompt assembly, memory/lore/template processing, and token trimming.
- [Server backend](server-backend.md) covers the authenticated Google service-account token exchange endpoint.
- [Backup and recovery](backup-recovery.md) covers secret-bearing full backups and lossy upstream-target exports.
