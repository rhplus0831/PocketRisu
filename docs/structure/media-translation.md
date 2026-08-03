# Media and translation

> Part of the PocketRisu structure docs — see [STRUCTURE.md](../../STRUCTURE.md) for the top-level map and subsystem index.
> Audited 2026-08-04 against `95c2ea30`. Paths and symbols are authoritative; line-number hints are approximate and should be verified with `rg`.

## 1. Purpose & overview

This subsystem handles language translation, speech synthesis, image generation,
notification/embedded audio, and chat-embedded media. Translation supports remote
services, an auxiliary LLM, and browser-local Bergamot models; TTS supports browser
speech plus several hosted/self-hosted providers and plugin hooks. Inlays give images,
audio, video, and model signatures stable IDs outside chat records. On Node, safe-named
ordinary assets and current inlay payloads live as files; historical hash-shaped
mismatches have explicit filesystem identity markers, unsafe asset names and ownership
metadata remain in SQLite, and inlay display metadata is published in filesystem
sidecars.

## 2. Key files

### Translation

- `src/ts/translator/translator.ts` — central translation dispatcher, HTML translator, and LLM cache.

  - `getCurrentTranslatorPreset()` selects the normalized active preset (`src/ts/translator/translator.ts:51`).
  - `translate(text, reverse)` is the normal UI entry point and consults a small in-memory forward/reverse cache (`src/ts/translator/translator.ts:55`).
  - `runTranslator(...)` preserves selected media/raw lines, establishes actual source/target languages, calls a provider, and updates the session cache (`src/ts/translator/translator.ts:73`).
  - `translateMain(...)` dispatches to LLM, DeepL, DeepLX, Bergamot, experimental Google HTML scraping, or Google Translate GTX (`src/ts/translator/translator.ts:137`).
  - `translateVox()` is the English-to-Japanese compatibility path used by VOICEVOX (`src/ts/translator/translator.ts:259`).
  - `isExpTranslator()` classifies LLM, DeepL, and DeepLX as translation modes that should not initiate uncached translation during active generation (`src/ts/translator/translator.ts:268`).
  - `translateHTML(...)` translates rendered chat output while preserving HTML structure and applying preset, module, then character `edittrans` scripts.
  - `translateLLM(...)` builds the auxiliary-model request, masks `<risu-style>` blocks,
    restores them on a successful response, and reads/writes both cache tiers under the
    unchanged input text.
  - Cache administration is exported through `clearLLMCache`, `getLLMCache`, `searchLLMCache`, `setLLMCache`, `exportLLMCacheAsJSON`, and `importLLMCacheFromJSON`.
  - DeepL, DeepLX, and experimental Google requests made through `globalFetch` are categorized as `translate` in request logs; auxiliary LLM requests use the same source label through `requestChatData()`.

- `src/ts/translator/bergamotTranslator.ts` — browser-local Firefox/Bergamot translation.

  - `CacheDB` stores downloaded model files in IndexedDB and validates entries by registry checksum (`src/ts/translator/bergamotTranslator.ts:6`, `src/ts/translator/bergamotTranslator.ts:30`).
  - `FirefoxBacking` rewrites model registry paths to Mozilla’s GitHub-hosted compressed model files (`src/ts/translator/bergamotTranslator.ts:76`, `src/ts/translator/bergamotTranslator.ts:88`).
  - `bergamotTranslate(...)` lazily constructs `LatencyOptimisedTranslator` and serializes translation tasks (`src/ts/translator/bergamotTranslator.ts:128`).
  - `clearCache()` removes downloaded models from IndexedDB (`src/ts/translator/bergamotTranslator.ts:144`).

- `src/ts/translator/presets.ts` — LLM translation preset schema, legacy normalization, and encrypted `.risutl` codec.

  - `TranslatorPreset` contains `name`, `prompt`, and `maxResponse` (`src/ts/translator/presets.ts:6`).
  - `defaultTranslatorPrompt` and the `.risutl` extension are defined at `src/ts/translator/presets.ts:25`.
  - `createTranslatorPreset()` supplies defaults (`src/ts/translator/presets.ts:90`).
  - `normalizeTranslatorPresetState()` migrates legacy prompt/token fields into a preset array and clamps the selected index (`src/ts/translator/presets.ts:104`).
  - `syncCurrentTranslatorPresetToLegacyFields()` keeps compatibility fields synchronized (`src/ts/translator/presets.ts:132`).
  - `getCurrentTranslatorPresetFromState()` safely returns the selected preset (`src/ts/translator/presets.ts:147`).
  - `encodeTranslatorPresetFile()` and `decodeTranslatorPresetFile()` use MessagePack, encryption, compression, and RPack wrapping (`src/ts/translator/presets.ts:217`, `src/ts/translator/presets.ts:234`).

- `src/ts/translator/presets.test.ts` — covers legacy-state migration, selected-preset synchronization, encrypted `.risutl` round trips, and invalid file rejection (`src/ts/translator/presets.test.ts:28`, `src/ts/translator/presets.test.ts:98`).

### TTS and notification/embedded audio

- `src/ts/process/tts.ts` — TTS preprocessing, provider requests, audio decoding, and playback.

  - `sayTTS(character, text)` is the synthesis entry point (`src/ts/process/tts.ts:80`).
  - Provider modes are `webspeech`, `elevenlab`, `VOICEVOX`, `openai`, `novelai`, `huggingface`, `vits`, `gptsovits`, and `fishspeech` (`src/ts/process/tts.ts:113`).
  - `playAudio(...)` runs postprocessors and plays decoded bytes through `AudioContext` (`src/ts/process/tts.ts:68`).
  - `stopTTS()` stops the last `AudioBufferSourceNode` and cancels browser speech synthesis (`src/ts/process/tts.ts:439`).
  - Voice discovery helpers are `getWebSpeechTTSVoices`, `getElevenTTSVoices`,
    `getVOICEVOXVoices`, and `getNovelAIVoices`.
  - `FixNAITTS()` supplies missing NovelAI TTS defaults on legacy characters (`src/ts/process/tts.ts:490`).

- `src/ts/process/ttsHooks.ts` — global pre/post synthesis plugin-hook registries.

  - Hook context/result interfaces distinguish text preprocessing from binary-audio postprocessing (`src/ts/process/ttsHooks.ts:3`, `src/ts/process/ttsHooks.ts:14`).
  - Registration and unregistration APIs begin at `src/ts/process/ttsHooks.ts:32`.
  - `getTTSPreprocessors()` and `getTTSPostprocessors()` return defensive array copies (`src/ts/process/ttsHooks.ts:50`, `src/ts/process/ttsHooks.ts:57`).
  - `runHookPipeline(...)` chains field replacements, stops on `skip`, and isolates thrown or timed-out hooks (`src/ts/process/ttsHooks.ts:61`).
  - `src/ts/process/ttsHooks.test.ts` covers chaining, skipping, errors, timeouts,
    undefined fields, and synchronous hooks.

- `src/ts/notificationSound.ts` — message/translation completion sounds and picker previews.

  - `bundledSounds` maps stable preset IDs to Vite-built audio URLs (`src/ts/notificationSound.ts:27`).
  - `resolveSoundUrl()` resolves either a bundled ID or an uploaded `assets/...` path (`src/ts/notificationSound.ts:49`).
  - `playNotificationSound()` is fire-and-forget and suppresses autoplay/missing-file failures (`src/ts/notificationSound.ts:66`).
  - `playSoundPreview()` maintains a single preview channel (`src/ts/notificationSound.ts:80`).

- `src/lib/Setting/Pages/NotificationSoundSettings.svelte` and
  `src/lib/Setting/Pages/Sound/` — notification sound controls and picker.

  - Message completion and uncached LLM-translation completion have independent enable,
    sound, and volume fields.
  - `SoundPickerModal` offers bundled IDs and `.mp3`, `.wav`, `.ogg`, or `.m4a`
    uploads. Uploads use `saveAsset()` and append `customSounds` metadata; removing a
    picker row removes only that metadata and leaves ordinary asset GC to reclaim bytes.

- `src/ts/parser/parser.svelte.ts` and `src/ts/observer.svelte.ts` — ordinary character
  asset audio/BGM rendering.

  - `assetRegex` includes `audio` and `bgm`; audio emits an autoplaying, looping control,
    while BGM emits a hidden `risu-ctrl="bgm___auto___..."` marker.
  - The DOM observer owns one global BGM `Audio` element at default volume 0.5, ignores
    later BGM markers while it exists, and clears it only after `ended`.

### Media utilities

The actual contents of `src/ts/media/` are:

```text
src/ts/media/
├── index.ts
├── imageType.ts
├── tests/imageType.test.ts
└── compressImage/
    ├── index.ts
    ├── compressImage.ts
    ├── lossyCompression.ts
    └── tests/compressImage.test.ts
```

- `src/ts/media/index.ts` — barrel export for `compressImage` and `getImageType`.
- `src/ts/media/imageType.ts` — `ImageType` covers JPEG, PNG, GIF, BMP, AVIF, WEBP, and Unknown (`src/ts/media/imageType.ts:1`).
  - `getImageType()` detects formats from magic bytes (`src/ts/media/imageType.ts:3`).

- `src/ts/media/compressImage/compressImage.ts` — `compressImage()` obeys `DBState.db.imageCompression`, leaves WebP/AVIF/unknown bytes untouched, and recompresses other recognized formats (`src/ts/media/compressImage/compressImage.ts:5`).

- `src/ts/media/compressImage/lossyCompression.ts` — `doLossyCompression()` limits either dimension to 3000 pixels, draws through a canvas, and emits WebP quality 0.75 with JPEG fallback (`src/ts/media/compressImage/lossyCompression.ts:1`).

- `src/ts/media/tests/imageType.test.ts` and `src/ts/media/compressImage/tests/compressImage.test.ts` cover detected signatures and compression routing (`src/ts/media/tests/imageType.test.ts:4`, `src/ts/media/compressImage/tests/compressImage.test.ts:26`).

There are no dedicated audio or video modules under `src/ts/media/`; upload classification, storage, and rendering for those formats live in the inlay pipeline.

### Inlays and generated images

- `src/ts/process/files/inlays.ts` — inlay asset model, upload classification, serialization, LRU caching, explorer data, reference scanning, and deletion.

  - `InlayAsset` supports `image`, `video`, `audio`, and `signature` types (`src/ts/process/files/inlays.ts:16`).
  - Asset bytes use `inlay/<id>`; display/type information uses `inlay_info/<id>` (`src/ts/process/files/inlays.ts:76`).
  - The memory LRU limit varies from 48 MiB to 256 MiB based on `navigator.deviceMemory`, defaulting to 192 MiB (`src/ts/process/files/inlays.ts:103`).
  - `NodeInlayStorage` serializes Blob payloads to data URIs before passing them to `NodeStorage` (`src/ts/process/files/inlays.ts:167`, `src/ts/process/files/inlays.ts:174`).
  - `postInlayAsset()` classifies uploaded image/audio/video extensions (`src/ts/process/files/inlays.ts:412`).
  - `writeInlayImage()` resizes images to at most 1,048,576 pixels and stores PNG or WebP according to `inlayImageLossless` (`src/ts/process/files/inlays.ts:438`).
  - `saveInlayedSignature()` stores structured model signature data under the same ID system (`src/ts/process/files/inlays.ts:479`).
  - `getInlayAsset()` returns a base64 data URI; `getInlayAssetBlob()` returns a Blob (`src/ts/process/files/inlays.ts:490`, `src/ts/process/files/inlays.ts:507`).
  - `setInlayAsset()` writes payload, explorer info, and ownership/time metadata in that
    order. These are three logical writes, not one client transaction.
  - `removeInlayAsset()` delegates to `removeInlayAssets()`. Bulk deletion deduplicates
    IDs and submits at most `INLAY_DELETE_BATCH_SIZE` (1,000) per guarded server
    mutation, refreshing the loaded/unsaved-chat keep-set for every batch.
  - `scanInlayReferences()` scans authoritative server chat rows and merges token references from loaded chats so placeholders and unsaved edits are both covered (`src/ts/process/files/inlays.ts:716`).
  - `supportsInlayImage()` checks the current model’s `hasImageInput` flag (`src/ts/process/files/inlays.ts:697`).
  - `src/ts/process/files/tests/inlays.test.ts` exercises storage round trips, explorer
    metadata, uploads, resizing, and deletion.

- `src/ts/process/files/inlayMeta.ts` — creation/update metadata stored under `inlay_meta/<id>`.

  - `InlayAssetMeta` records timestamps plus optional character/chat ownership (`src/ts/process/files/inlayMeta.ts:6`).
  - `setInlayMeta`, `getInlayMeta`, and batch/list helpers wrap `NodeStorage` (`src/ts/process/files/inlayMeta.ts:86`, `src/ts/process/files/inlayMeta.ts:98`).
  - `buildInlayMeta()` captures the currently selected character and chat while preserving existing ownership and creation time (`src/ts/process/files/inlayMeta.ts:106`).

- `src/ts/util/inlayTokens.ts` — shared compatibility regex matching `inlay`, `inlayed`, and `inlayeddata` tokens (`src/ts/util/inlayTokens.ts:3`).

- `src/ts/process/inlayScreen.ts` — converts model-emitted view-screen commands into emotion or generated-image inlays.

  - `runInlayScreen()` converts `<Emotion="...">` or processes `<ImgGen="...">`/`{{ImgGen="..."}}` (`src/ts/process/inlayScreen.ts:7`).
  - In image mode it calls `generateAIImage(..., "inlay")`, persists the result through `writeInlayImage()`, and substitutes `{{inlay::<id>}}` (`src/ts/process/inlayScreen.ts:15`).
  - `updateInlayScreen()` supplies compatibility prompts/instructions for emotion and image-generation view modes (`src/ts/process/inlayScreen.ts:52`).

- `src/ts/process/stableDiff.ts` — provider-specific image-generation requests.

  - `stableDiff()` first asks the auxiliary model to turn chat context into an image prompt, then calls `generateAIImage()` (`src/ts/process/stableDiff.ts:11`).
  - `generateAIImage()` supports Stable Diffusion WebUI, NovelAI, DALL-E 3, Stability AI,
    ComfyUI, fal, Google Imagen, OpenAI-compatible APIs, and WaveSpeed.
  - In inlay mode, provider branches generally return a data URI or remote image URL; normal view-screen mode generally updates `CharEmotion` (`src/ts/process/stableDiff.ts:92`, `src/ts/process/stableDiff.ts:358`, `src/ts/process/stableDiff.ts:567`).
  - ComfyUI polling distinguishes execution errors/interruption from a successful history
    item with no `SaveImage` output. Major provider submission requests made through
    `globalFetch` use request-log category/source `image`; Comfy history/view polling is
    intentionally native fetch traffic.

- `src/ts/3d/threeload.ts` — explicitly marked legacy/not currently used and only re-exports dynamically imported Three.js/MMD classes (`src/ts/3d/threeload.ts:1`, `src/ts/3d/threeload.ts:4`).

### Rendering and server storage edges

- `src/ts/parser/parser.svelte.ts` — inlay rendering occupies `src/ts/parser/parser.svelte.ts:666-868`.

  - `parseInlayAssets()` replaces tokens with cached elements or lazy placeholders (`src/ts/parser/parser.svelte.ts:692`).
  - `resolveInlayPlaceholders()` uses an `IntersectionObserver` with a 200-pixel root margin (`src/ts/parser/parser.svelte.ts:847`).
  - Missing type data can be fetched in batches; direct media URLs are `/api/asset/<hex key>` (`src/ts/parser/parser.svelte.ts:746`).

- `src/ts/storage/nodeStorage.ts` — authenticated client for server storage.

  - `setItem`, `getItem`, `keys`, and `removeItem` use `/api/write`, `/api/read`,
    `/api/list`, and `/api/remove`; `getItems()` and `setItems()` use the bulk asset
    endpoints.
  - `NodeStorage.initSession()` establishes the cookie required for direct `<img>`,
    `<audio>`, and `<video>` URLs.

- `server/node/server.cjs` — relevant storage code is distributed through the server.

  - Current inlays are stored under `save/inlays`; safe ID/extension validation and path
    construction are centralized in `isSafeInlayId()`, `normalizeInlayExt()`, and the
    `getInlay*Path()` helpers.
  - `writeInlayFile()` durably stages both payload and sidecar, publishes payload first,
    then commits an extension-changing replacement by renaming the sidecar. It removes
    the old extension only after that commit and cleans temporary files on failure.
  - `reconcileInterruptedInlayPublications()` removes abandoned publication temporaries
    during the filesystem migration/bootstrap path.
  - `/api/session` issues the direct-asset cookie; `/api/asset/:hexKey` serves assets and
    inlays with MIME, ETag, and one-year immutable caching.
  - `/api/inlays/references` scans authoritative chat rows;
    `/api/inlays/delete-unreferenced` requires the active writer, accepts no more than
    `MAX_INLAY_DELETE_BATCH`, and revalidates within the storage queue. The compatibility
    `/api/remove` path applies the same reference guard to inlays.
  - `/api/read`, `/api/remove`, `/api/list`, and `/api/write` special-case physical inlay
    payloads and sidecars. `/api/assets/bulk-read` and `/api/assets/bulk-write` support
    batched metadata/KV access; `/api/inlays/compress` streams WebP recompression progress.

- `server/node/db.cjs` — SQLite KV implementation.

  - It opens `save/risuai.db` with `better-sqlite3` (`server/node/db.cjs:3`, `:13-16`).
  - The `kv` table stores key, BLOB value, and update timestamp (`server/node/db.cjs:29-36`).
  - Generic unsafe/legacy assets, `inlay_meta`, translation cache entries, and other ordinary storage keys use direct KV rows. Large live database, automatic-snapshot, and chat-row values use the chunk store (`server/node/db.cjs:103-109`; `server/node/chunkStore.cjs:51-55`).

## 3. Architecture & data flow

### Auto-translate input

1. Language settings bind target language, provider, credentials, and translation behavior into the database (`src/ts/setting/languageSettingsData.svelte.ts:90`, `src/ts/setting/languageSettingsData.svelte.ts:116`, `src/ts/setting/languageSettingsData.svelte.ts:216`).
2. The composer maintains both `messageInput` and `messageInputTranslate` (`src/lib/ChatScreens/DefaultChatScreen.svelte:65`).
3. With `useAutoTranslateInput` enabled, edits call `updateInputTransateMessage()` (`src/lib/ChatScreens/DefaultChatScreen.svelte:685`).
4. For Google/Bergamot, either textarea can immediately update the other through `translate()`. For LLM/DeepL/DeepLX, only reverse translation from the translated-language box is initiated, after a 1.5-second debounce (`src/lib/ChatScreens/DefaultChatScreen.svelte:689`).
5. Sending always stores `messageInput`, after `editinput` scripting; the translated-language buffer is UI-only and is then cleared (`src/lib/ChatScreens/DefaultChatScreen.svelte:375`, `src/lib/ChatScreens/DefaultChatScreen.svelte:391`).

### Output translation and caching

1. `ChatBody.markParsing()` initializes the message’s translated state from `autoTranslate`; `autoTranslateCachedOnly` first checks the exact LLM cache key appropriate to the chosen formatting mode (`src/lib/ChatScreens/ChatBody.svelte:61`, `src/lib/ChatScreens/ChatBody.svelte:74`).
2. Depending on `translateBeforeHTMLFormatting` and `legacyTranslation`, it either translates raw text before Markdown, translates preprocessed Markdown followed by `postTranslationParse`, or uses the legacy rendered-HTML path (`src/lib/ChatScreens/ChatBody.svelte:111`).
3. `translateHTML()`:

   - refuses uncached experimental translation while `doingChat` is true (`src/ts/translator/translator.ts:293`);
   - sends an entire value to the auxiliary LLM when configured (`src/ts/translator/translator.ts:302`);
   - lets Bergamot handle HTML directly when `htmlTranslation` is enabled (`src/ts/translator/translator.ts:313`);
   - otherwise walks DOM text nodes, skips `script`, `style`, and `translate="no"`, and limits concurrent work (`src/ts/translator/translator.ts:381`, `src/ts/translator/translator.ts:432`);
   - batches DeepLX text with `■` separators at about 5,000 characters, falling back to per-chunk translation if separators are not preserved (`src/ts/translator/translator.ts:337`);
   - applies preset, module, then character `edittrans` regex scripts after translation
     (`applyEdittransRegex()`).

4. LLM translation builds a ChatML prompt from the selected preset, replaces `{{slot}}`,
   `{{slot::from}}`, `{{slot::content}}`, and `{{slot::tnote}}`, then calls
   `requestChatData(..., "translate")` without streaming.
5. The LLM cache has two tiers:

   - an in-memory `Map<string,string>` (`src/ts/translator/translator.ts:28`);
   - persistent `cache/llm-translate/<hash>.json` entries containing the original key and value (`src/ts/translator/translator.ts:31`).

6. Persistent cache operations use `forageStorage`, which is backed by `NodeStorage` in PocketRisu and therefore by server storage (`src/ts/storage/persistentKv.ts:41-68`, `src/ts/storage/autoStorage.ts:27`).
7. The original, unmasked input is captured as `cacheKey` before `<risu-style>` content
   becomes request placeholders. Reads and both writes therefore use the exact same key;
   restored style contents appear only in the cached result.
8. `regenerate=true` bypasses reads but writes the new result back to both tiers.
9. A translation-complete notification is played only when an LLM request was actually
   made rather than served from cache.

### TTS flow

1. Speech is initiated manually by a message’s TTS button, automatically after generated
   output when `ttsAutoSpeech` is enabled, or through the `/speak` command.
2. `sayTTS()` resolves the current character if necessary, removes asterisks, optionally retains only quoted text, and runs preprocessor hooks (`src/ts/process/tts.ts:80`, `src/ts/process/tts.ts:91`, `src/ts/process/tts.ts:94`, `src/ts/process/tts.ts:104`).
3. Provider-specific code synthesizes speech. VOICEVOX translates to Japanese first; Hugging Face can translate to the model language first (`src/ts/process/tts.ts:151`, `src/ts/process/tts.ts:250`).
4. Byte-producing providers normally pass through `runPostprocessorPipeline()`, which clones the current audio buffer for each hook, supports replacement audio/MIME, and stops on `skip` (`src/ts/process/tts.ts:31`).
5. The final bytes are decoded into an `AudioBuffer` and played. Web Speech and VITS use their own playback paths and therefore do not pass binary audio through postprocessors.
6. GPT-SoVITS with non-default volume still runs byte postprocessors first, then applies
   its `GainNode`; the ordinary-volume path delegates directly to `playAudio()`.
7. Plugin API v3's `addTTSPreprocessor()` and `addTTSPostprocessor()` register lifecycle
   cleanup that unregisters their hooks when the plugin unloads.

OpenAI, NovelAI, GPT-SoVITS, and Fish Speech calls made with `globalFetch` are tagged
`tts` for request logs. ElevenLabs, VOICEVOX, Hugging Face, and the VITS bridge retain
their direct/provider-specific request paths, so the category does not cover every TTS
network call.

### Notification and ordinary asset audio

1. `NotificationSoundSettings` binds message and translation completion to separate
   database fields. Bundled IDs resolve directly; custom `assets/...` values resolve
   through `getFileSrc()`.
2. `sendChatMain()` plays the message completion sound after the send concludes on this
   client—success, failure, or abort—when enabled. Each completion creates its own
   `Audio`, so separate notifications can overlap; picker previews use one replaceable
   channel.
3. `translateHTML()` plays the translation completion sound only on the uncached LLM
   branch. Bergamot, DOM-chunk translation, and cache hits do not emit it.
4. Ordinary `{{audio::...}}` assets render as autoplaying/looping controls.
   `{{bgm::...}}` renders a hidden marker consumed by the global DOM observer. Because
   BGM state is global and cleared only by `ended`, removing the originating markup does
   not stop it and a looping track blocks later BGM markers.
5. `App.svelte` implements `keepSessionAlive === "sound"` by starting a nearly silent,
   looping bundled audio file on the first root click. It has no in-app stop path;
   `"pip"` remains an empty branch even though it is present in the stored type.

### Inlay asset lifecycle

1. Creation can originate from:

   - composer uploads through `postChatFile()` and `postInlayAsset()` (`src/ts/process/files/multisend.ts:194`, `src/ts/process/files/multisend.ts:289`);
   - model `<ImgGen>` output through `runInlayScreen()` (`src/ts/process/inlayScreen.ts:15`);
   - scripting/triggers through `generateAIImage()` plus `writeInlayImage()` (`src/ts/process/scriptings.ts:363`);
   - multimodal provider responses and signatures (`src/ts/process/request/google.ts:760`).

2. New assets normally receive UUIDs. Images are canvas-normalized; audio/video retain Blob bytes and their recognized extension (`src/ts/process/files/inlays.ts:423`, `src/ts/process/files/inlays.ts:430`, `src/ts/process/files/inlays.ts:465`).
3. `setInlayAsset()` performs three ordered logical writes:

   - serialized payload under `inlay/<id>`;
   - display/type data under `inlay_info/<id>`;
   - timestamps and optional character/chat ownership under `inlay_meta/<id>`.

4. On `/api/write`, the Node server decodes the serialized `inlay/<id>` payload. Its
   physical publication stages and fsyncs `save/inlays/<id>.<ext>` plus
   `<id>.meta.json`, renames the payload, then renames the sidecar. For an extension
   change the sidecar rename is the reader-visible commit point; the previous payload is
   removed only afterward. A pre-commit failure rolls back a newly published
   different-extension payload and leaves the old sidecar-selected source readable.
5. The physical sidecar contains extension, name, type, and dimensions. Logical
   `inlay_info/<id>` reads/writes map to it with a legacy KV fallback. The separate
   `inlay_meta/<id>` SQLite KV row contains timestamps and optional character/chat
   ownership and is not part of physical payload publication.
6. Chats store only tokens. Composer attachments become `{{inlayed::<id>}}` before the
   user message is appended. Generated inline images normally use `{{inlay::<id>}}`.
7. When preparing model input, user-message inlays become multimodal parts if supported.
   Images fall back to captioning for non-vision models. At most one audio/video item is
   added, and only while the multimodal list is still empty; assistant-side handling
   retains only `inlayeddata` tokens as model input.
8. Rendering calls `parseInlayAssets()`, producing placeholders when type/URL data is not
   cached. `ChatBody` invokes `resolveInlayPlaceholders()` after its HTML block mounts.
9. Near-viewport placeholders are resolved in batches of 20, classified from
   `inlay_info` unless image-priority mode is enabled, and replaced with direct media tags
   pointing to `/api/asset/<hex("inlay/<id>")>`. The server authenticates these through
   the `risu-session` cookie and streams the raw payload with detected MIME type.
10. `removeInlayAssets()` deduplicates requests and loops over 1,000-ID batches. Before
    every batch it refreshes loaded/unsaved chat references; the active-writer server
    mutation rescans all authoritative chat rows, deletes only unreferenced payload,
    sidecar, legacy thumbnail/info, and ownership records, and reports removed/referenced
    IDs. Results accumulate across successful batches and the explorer cache is invalidated
    in `finally`; a later-batch failure does not undo earlier committed batches.

### Image generation and view screens

1. Non-inlay `imggen` view mode gathers the most recent user/character exchange and calls
   `stableDiff()` after response processing.
2. `stableDiff()` uses the character’s `newGenData.instructions` to ask the auxiliary model for a provider-ready prompt (`src/ts/process/stableDiff.ts:20`).
3. `generateAIImage()` dispatches using database provider configuration. Normal mode generally writes the image into `CharEmotion`; inlay mode returns image data to its caller for durable inlay storage.
4. Inlay view mode instead expects the model to emit `<ImgGen="...">`, directly applies `newGenData.prompt`/`negative`, displays `[Generating...]`, and asynchronously replaces it with a stored inlay token (`src/ts/process/inlayScreen.ts:12`).
5. ComfyUI history entries can represent failed workflows. `generateAIImage()` surfaces
   `execution_error`/`execution_interrupted`, and separately rejects successful histories
   with no `SaveImage` output instead of dereferencing a missing image.

## 4. Entry points & dependencies

### Calls into this subsystem

- Chat rendering and translation controls: `ChatBody.markParsing()` and the translation
  action in `src/lib/ChatScreens/Chat.svelte`.
- Composer input translation: `updateInputTransateMessage()` in
  `src/lib/ChatScreens/DefaultChatScreen.svelte`.
- Suggested reply translation: `src/lib/ChatScreens/Suggestion.svelte`.
- Optional chat HTML-export translation: `exportChat()` in `src/ts/characters.ts`.
- Translation cache editing from a message: the translation editor in
  `src/lib/ChatScreens/Chat.svelte`.
- Plugin cache lookups: `getLLMCache()`/`searchLLMCache()` calls in
  `src/ts/plugins/apiV3/v3.svelte.ts`.
- Automatic TTS and inlay command processing: the response-finalization branches in
  `src/ts/process/index.svelte.ts`.
- File upload: `src/ts/process/files/multisend.ts:194`.
- Script and trigger image generation: `generateAIImage()` calls in
  `src/ts/process/scriptings.ts` and `src/ts/process/triggers.ts`.
- Inlay gallery/explorer: `src/lib/Setting/Pages/InlayImageGallery.svelte:17`.
- Notification sound configuration: `NotificationSoundSettings.svelte`, `SoundSetting`,
  and `SoundPickerModal`.
- Ordinary audio/BGM tokens: `parseAdditionalAssets()` and the global DOM observer in
  `src/ts/observer.svelte.ts`.
- Character TTS/view-screen configuration: the view-screen and TTS branches in
  `src/lib/SideBars/CharConfig.svelte`.

### Calls out from this subsystem

- Translation and prompt generation use `requestChatData()` from the request subsystem;
  direct translation, image, and some TTS calls opt into its request-log categories
  through `globalFetch` metadata.
- Remote services use `globalFetch`, native `fetch`, or `fetchNative`.
- Bergamot depends on `@browsermt/bergamot-translator`, IndexedDB, Mozilla model registries, and `fflate`.
- TTS depends on Web Speech, Web Audio, provider APIs, `runVITS`, uploaded GPT-SoVITS reference assets, and optional translation.
- Inlays depend on database/model metadata, `NodeStorage`, browser Blob/canvas APIs, and the parser/model-request pipelines.
- Server image compression and thumbnails depend on `wasm-vips`.
- Uploaded notification sounds use the ordinary `assets/<hash>.<ext>` path created by `saveAsset()` (`src/ts/globalApi.svelte.ts:203`).
- Ordinary assets are garbage-collected by the Node server, not the browser. The collector scans the live database and active optimized plugin rows, marks an unreferenced candidate durably, and deletes it only on a later sweep after the configured grace interval.
- The Hono alternative does not implement these storage routes; it currently only exposes a CSRF-protected hello route (`server/hono/src/app/index.ts:4`, `server/hono/src/app/index.ts:8`).

## 5. Conventions & gotchas

- `runTranslator` does not use conventional source/target parameter semantics. It computes request languages as `from = reverse ? from : target` and `to = reverse ? target : from` (`src/ts/translator/translator.ts:73`). Audit existing callers before changing this legacy convention.
- The simple translation cache and LLM cache are keyed by text, not by provider, source language, target language, preset, translator note, or character. Changing any of those can reuse stale translations until cache clear or regeneration.
- LLM lookup and publication must retain the raw input as one immutable cache key.
  `<risu-style>` masking mutates only the request text; keying a write by that temporary
  form creates permanent misses and unreachable persistent entries.
- `translateHTML()` deliberately avoids starting uncached LLM/DeepL/DeepLX work while a chat request is active (`src/ts/translator/translator.ts:293`).
- LLM cache writes are fire-and-forget in normal translation (`src/ts/translator/translator.ts:595`); memory is updated before persistent storage finishes.
- `runTranslator()` protects separate lines beginning with `{{img`, `{{raw`, `{{video`, or `{{audio`, but not the subsystem’s `{{inlay...}}` tokens (`src/ts/translator/translator.ts:87`). Translation-order changes can therefore affect inlay compatibility.
- Chat HTML export has its own optional translation pass in `exportChat()`; it is an export feature, not character-card translation (`src/ts/characters.ts:164`).
- DeepLX is the only HTML translator using the special 5,000-character `■` batching path (`src/ts/translator/translator.ts:516`).
- Translation errors frequently return the original text rather than throwing. Image-generation failures use a mixture of `false` and empty strings; callers check both.
- Translator preset legacy fields are still authoritative compatibility surfaces. New code should update presets through normalization/synchronization rather than removing `translatorPrompt` or `translatorMaxResponse`.
- TTS preprocessors run after asterisk removal and quote-only filtering, so hooks never see the pristine message.
- `runHookPipeline()` supports a timeout argument, but `sayTTS()` does not pass one. A plugin preprocessor that never settles can stall TTS indefinitely.
- Postprocessor hooks receive a fresh `ArrayBuffer.slice()` because plugin iframe transfer can detach buffers (`src/ts/process/tts.ts:42`).
- Web Speech and VITS bypass byte postprocessing. Any feature requiring universal audio-byte manipulation must account for those paths.
- `stopTTS()` tracks only the most recently assigned buffer source, although it cancels all browser speech synthesis.
- OpenAI TTS supports configurable response format in the request but currently labels playback as `audio/mpeg` (`src/ts/process/tts.ts:188`, `src/ts/process/tts.ts:210`).
- Notification preview playback is single-channel, but completion playback is not.
  `playNotificationSound()` intentionally creates independent `Audio` instances.
- The translation completion sound is specifically an uncached LLM signal, not a general
  “translation finished” hook. Message completion likewise follows local send conclusion,
  not only a successful model result.
- Ordinary BGM playback has no DOM-removal teardown and does not catch `play()` rejection.
  A looping BGM never reaches `ended`, so it retains the global channel indefinitely.
- Inlay tokens are a RisuAI compatibility contract:

  - `{{inlay::<id>}}` is an inline/generated reference.
  - `{{inlayed::<id>}}` is an attached reference and gets a `.risu-inlay-image` wrapper.
  - `{{inlayeddata::<id>}}` carries assistant-side multimodal/signature data.

- Chat messages store IDs, never embedded bytes. Every gallery deletion batch therefore
  revalidates authoritative chat rows under the storage queue and preserves references
  from loaded, unsaved chats as an additional keep-set.
- Bulk inlay deletion is chunked, not globally atomic. Successful earlier batches remain
  deleted if a later request fails; callers receive only a result after all batches finish.
- `scanInlayReferences()` is server-aware and fail-closed in both gallery surfaces: no assets are classified as message-orphans until the authoritative scan succeeds.
- Signature inlays are not rendered as visible media. They preserve provider/model metadata so a later request can replay the signature alongside the corresponding assistant content.
- Image inlays are always re-encoded. Lossless mode stores PNG; default mode stores WebP quality 0.85. Original filenames/extensions are informational and do not dictate the encoded image format.
- `postChatFile()` accepts `mpeg` and `avi`, while `postInlayAsset()` recognizes video only as `webm`, `mp4`, or `mkv` (`src/ts/process/files/multisend.ts:284`, `src/ts/process/files/inlays.ts:72`). Those accepted picker formats can consequently be discarded.
- Upload extension matching is lowercase and case-sensitive; callers should normalize extensions before expanding format support.
- `compressImage()` can route GIF through canvas recompression, which collapses animated input to a rasterized frame.
- Current inlay payloads are filesystem files despite the client-facing `NodeStorage` KV
  abstraction. Explorer info maps to sidecars; ownership/time metadata remains in SQLite.
- Atomic-publication guarantees apply only to the server's physical payload/sidecar
  protocol. The subsequent client writes to `inlay_info/<id>` and
  `inlay_meta/<id>` are separate; a successful payload response does not make all three
  logical writes transactional.
- For extension-changing replacement, the sidecar is the commit pointer. Do not delete
  the old payload before its rename, and keep startup cleanup for abandoned
  `.inlay-publish-*` files. Same-extension payload replacement relies on atomic rename.
- Safe-named `assets/*` values are filesystem-backed. Historical `assets/<content-hash>.<ext>` mismatches are tracked by private legacy-identity markers, while unsafe names retain the SQLite fallback, so code must use the storage helpers instead of assuming one physical backend for every asset key.
- The server still reads and migrates legacy SQLite `inlay/<id>` JSON records in
  `migrateInlaysToFilesystem()`. Preserve this fallback when changing storage format.
- Direct asset URLs use one-year `immutable` caching. Reusing and overwriting an explicit
  inlay ID can leave a browser with a stale cached URL; new content normally needs a new
  ID.
- `isSafeInlayId()` rejects separators, NULs, and traversal components before filesystem
  access.
- `/api/asset/:hexKey` requires the session cookie, not the normal `risu-auth` request header. Initialization of `/api/session` is part of asset rendering, not merely login housekeeping.
- `src/ts/3d/threeload.ts` is legacy and has no current consumers. Do not treat it as the live 3D rendering entry point.
- Most image providers follow the inlay-vs-`CharEmotion` return contract, but branches are not perfectly uniform; verify a provider branch before relying on its return value.

## 6. Navigation hints

- To add or change a translation provider, start at `translateMain()` (`src/ts/translator/translator.ts:137`) and expose its settings in `src/ts/setting/languageSettingsData.svelte.ts:116`.
- To change input-language direction or debounce behavior, inspect
  `updateInputTransateMessage()` in `DefaultChatScreen.svelte`.
- To change when messages auto-translate or Markdown-before/after-translation behavior,
  inspect `ChatBody.markParsing()` and `translateHTML()`.
- To alter the LLM translation prompt/request, inspect `translateLLM()` and
  `defaultTranslatorPrompt` in `src/ts/translator/presets.ts`.
- To change cache keying or persistence, inspect `translateLLM()`, the
  `getPersistentLLMCache()`/`setPersistentLLMCache()` helpers, and
  `src/ts/storage/persistentKv.ts`.
- To change translator preset migration or file format, inspect `src/ts/translator/presets.ts:104` and `src/ts/translator/presets.ts:171`.
- To add a TTS provider, add a mode under `src/ts/process/tts.ts:113` and its character settings under `src/lib/SideBars/CharConfig.svelte:700`.
- To change TTS text normalization, inspect `src/ts/process/tts.ts:91`.
- To change plugin hook semantics, inspect `src/ts/process/ttsHooks.ts:61` and the audio-specific pipeline at `src/ts/process/tts.ts:31`.
- To change automatic TTS timing, inspect the `ttsAutoSpeech` branches in
  `src/ts/process/index.svelte.ts`.
- To add an inlay-supported file extension, update `inlayImageExts`, `inlayAudioExts`,
  and `inlayVideoExts` together with the upload picker in `multisend.ts`.
- To change inlay image size/quality, inspect `writeInlayImage()` (`src/ts/process/files/inlays.ts:438`).
- To change inlay logical records or ownership metadata, inspect `setInlayAsset()` and
  `buildInlayMeta()`.
- To change token syntax, update the shared regex in `src/ts/util/inlayTokens.ts` and audit
  the parser and model-input token regexes in `parser.svelte.ts` and
  `process/index.svelte.ts`.
- To change lazy media rendering, inspect `parseInlayAssets()` and
  `resolveInlayPlaceholders()`.
- To change how uploads become chat references, inspect `postChatFile()` and the
  `{{inlayed::...}}` append in `DefaultChatScreen.svelte`; model-input conversion lives
  in the inlay-token branch of `src/ts/process/index.svelte.ts`.
- To change physical inlay publication, inspect `writeInlayFile()`,
  `writeInlaySidecar()`, `reconcileInterruptedInlayPublications()`, and the `inlay/`
  branch of `/api/write` together.
- To change deletion chunking or reference safety, inspect `INLAY_DELETE_BATCH_SIZE`,
  `removeInlayAssets()`, `MAX_INLAY_DELETE_BATCH`, and
  `/api/inlays/delete-unreferenced`.
- To change direct asset authentication or caching, inspect `/api/session`,
  `/api/asset/:hexKey`, and `NodeStorage.initSession()`.
- To change bulk gallery metadata loading, inspect `listInlayExplorerItems()` and the
  server bulk-asset endpoints.
- To change server-side batch inlay compression, inspect `/api/inlays/compress`.
- To add or alter an image-generation provider, inspect `generateAIImage()` (`src/ts/process/stableDiff.ts:63`).
- To change model-emitted `<ImgGen>` behavior, inspect `src/ts/process/inlayScreen.ts:5` and `src/ts/process/inlayScreen.ts:15`.
- To change completion sounds or bundled presets, inspect `notificationSound.ts` and the
  `NotificationSoundSettings.svelte`/`Sound/` components; ordinary BGM semantics live in
  `parseAdditionalAssets()` and `src/ts/observer.svelte.ts`.

## 7. Related structure docs

- [Chat pipeline](chat-pipeline.md) covers attachment extraction, model input, and response-side inlay handling.
- [Characters and personas](characters-personas.md) covers inlays included in character packages.
- [Client storage](client-storage.md) and [server backend](server-backend.md) cover the logical storage API and physical asset/inlay backends.
- [UI layer](ui-layer.md) covers the inlay gallery and specialist playground surfaces.
- `src/lib/UI/3DLoader.svelte` is also marked legacy/not currently used and directly imports Three.js instead of using `src/ts/3d/threeload.ts`.
