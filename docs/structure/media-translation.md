# Media and translation

> Part of the PocketRisu structure docs — see [STRUCTURE.md](../../STRUCTURE.md) for the top-level map and subsystem index.
> Audited 2026-07-27 against `abee0232`. Paths and symbols are authoritative; line-number hints are approximate and should be verified with `rg`.

## 1. Purpose & overview

This subsystem handles language translation, speech synthesis, image generation, notification audio, and chat-embedded media. Translation supports remote services, an auxiliary LLM, and browser-local Bergamot models; TTS supports browser speech plus several hosted/self-hosted providers and plugin hooks. Inlays give images, audio, video, and model signatures stable IDs outside chat records. On Node, safe content-addressed ordinary assets and current inlay payloads live as files; unsafe/legacy asset names and ownership metadata remain in SQLite, while inlay display metadata is mirrored in filesystem sidecars.

## 2. Key files

### Translation

- `src/ts/translator/translator.ts` — central translation dispatcher, HTML translator, and LLM cache.

  - `getCurrentTranslatorPreset()` selects the normalized active preset (`src/ts/translator/translator.ts:51`).
  - `translate(text, reverse)` is the normal UI entry point and consults a small in-memory forward/reverse cache (`src/ts/translator/translator.ts:55`).
  - `runTranslator(...)` preserves selected media/raw lines, establishes actual source/target languages, calls a provider, and updates the session cache (`src/ts/translator/translator.ts:73`).
  - `translateMain(...)` dispatches to LLM, DeepL, DeepLX, Bergamot, experimental Google HTML scraping, or Google Translate GTX (`src/ts/translator/translator.ts:137`).
  - `translateVox()` is the English-to-Japanese compatibility path used by VOICEVOX (`src/ts/translator/translator.ts:259`).
  - `isExpTranslator()` classifies LLM, DeepL, and DeepLX as translation modes that should not initiate uncached translation during active generation (`src/ts/translator/translator.ts:268`).
  - `translateHTML(...)` translates rendered chat output while preserving HTML structure and applying `edittrans` scripts (`src/ts/translator/translator.ts:273`).
  - `translateLLM(...)` builds the auxiliary-model request, masks `<risu-style>` blocks, restores them, and populates the cache (`src/ts/translator/translator.ts:520`).
  - Cache administration is exported through `clearLLMCache`, `getLLMCache`, `searchLLMCache`, `setLLMCache`, `exportLLMCacheAsJSON`, and `importLLMCacheFromJSON` (`src/ts/translator/translator.ts:600`, `src/ts/translator/translator.ts:605`, `src/ts/translator/translator.ts:609`, `src/ts/translator/translator.ts:631`, `src/ts/translator/translator.ts:636`, `src/ts/translator/translator.ts:651`).

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

### TTS and notification audio

- `src/ts/process/tts.ts` — TTS preprocessing, provider requests, audio decoding, and playback.

  - `sayTTS(character, text)` is the synthesis entry point (`src/ts/process/tts.ts:80`).
  - Provider modes are `webspeech`, `elevenlab`, `VOICEVOX`, `openai`, `novelai`, `huggingface`, `vits`, `gptsovits`, and `fishspeech` (`src/ts/process/tts.ts:113`).
  - `playAudio(...)` runs postprocessors and plays decoded bytes through `AudioContext` (`src/ts/process/tts.ts:68`).
  - `stopTTS()` stops the last `AudioBufferSourceNode` and cancels browser speech synthesis (`src/ts/process/tts.ts:429`).
  - Voice discovery helpers are `getWebSpeechTTSVoices`, `getElevenTTSVoices`, `getVOICEVOXVoices`, and `getNovelAIVoices` (`src/ts/process/tts.ts:439`, `src/ts/process/tts.ts:445`, `src/ts/process/tts.ts:459`, `src/ts/process/tts.ts:473`).
  - `FixNAITTS()` supplies missing NovelAI TTS defaults on legacy characters (`src/ts/process/tts.ts:490`).

- `src/ts/process/ttsHooks.ts` — global pre/post synthesis plugin-hook registries.

  - Hook context/result interfaces distinguish text preprocessing from binary-audio postprocessing (`src/ts/process/ttsHooks.ts:3`, `src/ts/process/ttsHooks.ts:14`).
  - Registration and unregistration APIs begin at `src/ts/process/ttsHooks.ts:32`.
  - `getTTSPreprocessors()` and `getTTSPostprocessors()` return defensive array copies (`src/ts/process/ttsHooks.ts:50`, `src/ts/process/ttsHooks.ts:57`).
  - `runHookPipeline(...)` chains field replacements, stops on `skip`, and isolates thrown or timed-out hooks (`src/ts/process/ttsHooks.ts:61`).
  - `src/ts/process/ttsHooks.test.ts` and covers chaining, skipping, errors, timeouts, undefined fields, and synchronous hooks (`src/ts/process/ttsHooks.test.ts:16`).

- `src/ts/notificationSound.ts` — message/translation completion sounds and picker previews.

  - `bundledSounds` maps stable preset IDs to Vite-built audio URLs (`src/ts/notificationSound.ts:27`).
  - `resolveSoundUrl()` resolves either a bundled ID or an uploaded `assets/...` path (`src/ts/notificationSound.ts:49`).
  - `playNotificationSound()` is fire-and-forget and suppresses autoplay/missing-file failures (`src/ts/notificationSound.ts:66`).
  - `playSoundPreview()` maintains a single preview channel (`src/ts/notificationSound.ts:80`).

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
  - `setInlayAsset()` writes payload, explorer info, and ownership/time metadata sequentially (`src/ts/process/files/inlays.ts:600`).
  - `removeInlayAsset()` and `removeInlayAssets()` use one guarded server mutation that preserves IDs referenced by stored or loaded-unsaved chats (`src/ts/process/files/inlays.ts:619`).
  - `scanInlayReferences()` scans authoritative server chat rows and merges token references from loaded chats so placeholders and unsaved edits are both covered (`src/ts/process/files/inlays.ts:716`).
  - `supportsInlayImage()` checks the current model’s `hasImageInput` flag (`src/ts/process/files/inlays.ts:697`).
  - `src/ts/process/files/tests/inlays.test.ts` and exercises storage round trips, explorer metadata, uploads, resizing, and deletion (`src/ts/process/files/tests/inlays.test.ts:141`, `src/ts/process/files/tests/inlays.test.ts:407`, `src/ts/process/files/tests/inlays.test.ts:497`).

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
  - `generateAIImage()` supports Stable Diffusion WebUI, NovelAI, DALL-E 3, Stability AI, ComfyUI, fal, Google Imagen, OpenAI-compatible APIs, and WaveSpeed (`src/ts/process/stableDiff.ts:63`).
  - In inlay mode, provider branches generally return a data URI or remote image URL; normal view-screen mode generally updates `CharEmotion` (`src/ts/process/stableDiff.ts:92`, `src/ts/process/stableDiff.ts:358`, `src/ts/process/stableDiff.ts:567`).

- `src/ts/3d/threeload.ts` — explicitly marked legacy/not currently used and only re-exports dynamically imported Three.js/MMD classes (`src/ts/3d/threeload.ts:1`, `src/ts/3d/threeload.ts:4`).

### Rendering and server storage edges

- `src/ts/parser/parser.svelte.ts` — inlay rendering occupies `src/ts/parser/parser.svelte.ts:666-868`.

  - `parseInlayAssets()` replaces tokens with cached elements or lazy placeholders (`src/ts/parser/parser.svelte.ts:692`).
  - `resolveInlayPlaceholders()` uses an `IntersectionObserver` with a 200-pixel root margin (`src/ts/parser/parser.svelte.ts:847`).
  - Missing type data can be fetched in batches; direct media URLs are `/api/asset/<hex key>` (`src/ts/parser/parser.svelte.ts:746`).

- `src/ts/storage/nodeStorage.ts` — authenticated client for server storage.

  - `setItem`, `getItem`, `keys`, and `removeItem` use `/api/write`, `/api/read`, `/api/list`, and `/api/remove` (`src/ts/storage/nodeStorage.ts:298`, `:348`, `:470`, `:518`).
  - `getItems()` and `setItems()` use the bulk asset endpoints (`src/ts/storage/nodeStorage.ts:626`, `:659`).
  - `/api/session` establishes the cookie required for direct `<img>`, `<audio>`, and `<video>` URLs (`src/ts/storage/nodeStorage.ts:185`).

- `server/node/server.cjs` — relevant storage code is distributed through the server.

  - Current inlays are stored under `save/inlays` (`server/node/server.cjs:1024`).
  - Safe ID/extension validation and filesystem path construction start at `server/node/server.cjs:1111`.
  - Raw inlay read/write and sidecar helpers are at `server/node/server.cjs:1182`, `:1242`, and `:1281`.
  - `/api/session` issues the direct-asset cookie (`server/node/server.cjs:3666`).
  - `/api/asset/:hexKey` serves assets and inlays with MIME, ETag, and immutable caching (`server/node/server.cjs:3747`).
  - `/api/inlays/references` scans authoritative chat rows; `/api/inlays/delete-unreferenced` revalidates under the storage queue before deleting. The compatibility `/api/remove` path applies the same reference guard to inlays (`server/node/server.cjs:7922`).
  - `/api/read`, `/api/remove`, `/api/list`, and `/api/write` special-case inlay payloads and sidecars (`server/node/server.cjs:7680`, `:7963`, `:8051`, `:10620`).
  - `/api/assets/bulk-read` and `/api/assets/bulk-write` support batched metadata/KV access (`server/node/server.cjs:4573`, `:4645`).
  - `/api/inlays/compress` recompresses eligible filesystem images to WebP and streams progress as SSE (`server/node/server.cjs:6777`).

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
   - applies module and character `edittrans` regex scripts after translation (`src/ts/translator/translator.ts:667`).

4. LLM translation builds a ChatML prompt from the selected preset, replaces `{{slot}}`, `{{slot::from}}`, `{{slot::content}}`, and `{{slot::tnote}}`, then calls `requestChatData(..., "translate")` without streaming (`src/ts/translator/translator.ts:555`, `src/ts/translator/translator.ts:575`).
5. The LLM cache has two tiers:

   - an in-memory `Map<string,string>` (`src/ts/translator/translator.ts:28`);
   - persistent `cache/llm-translate/<hash>.json` entries containing the original key and value (`src/ts/translator/translator.ts:31`).

6. Persistent cache operations use `forageStorage`, which is backed by `NodeStorage` in PocketRisu and therefore by server storage (`src/ts/storage/persistentKv.ts:41-68`, `src/ts/storage/autoStorage.ts:27`).
7. `regenerate=true` bypasses reads but writes the new result back to both tiers (`src/ts/translator/translator.ts:520`, `src/ts/translator/translator.ts:594`).
8. A translation-complete notification is played only when an LLM request was actually made rather than served from cache (`src/ts/translator/translator.ts:305`).

### TTS flow

1. Speech is initiated manually by a message’s TTS button (`src/lib/ChatScreens/Chat.svelte:738`), automatically after generated output when `ttsAutoSpeech` is enabled (`src/ts/process/index.svelte.ts:1520`, `src/ts/process/index.svelte.ts:1582`), or through the `/speak` command (`src/ts/process/command.ts:93`).
2. `sayTTS()` resolves the current character if necessary, removes asterisks, optionally retains only quoted text, and runs preprocessor hooks (`src/ts/process/tts.ts:80`, `src/ts/process/tts.ts:91`, `src/ts/process/tts.ts:94`, `src/ts/process/tts.ts:104`).
3. Provider-specific code synthesizes speech. VOICEVOX translates to Japanese first; Hugging Face can translate to the model language first (`src/ts/process/tts.ts:151`, `src/ts/process/tts.ts:250`).
4. Byte-producing providers normally pass through `runPostprocessorPipeline()`, which clones the current audio buffer for each hook, supports replacement audio/MIME, and stops on `skip` (`src/ts/process/tts.ts:31`).
5. The final bytes are decoded into an `AudioBuffer` and played. Web Speech and VITS use their own playback paths and therefore do not pass binary audio through postprocessors.
6. Plugin API v3 registers hooks and automatically unregisters them when the plugin unloads (`src/ts/plugins/apiV3/v3.svelte.ts:822`).

### Inlay asset lifecycle

1. Creation can originate from:

   - composer uploads through `postChatFile()` and `postInlayAsset()` (`src/ts/process/files/multisend.ts:194`, `src/ts/process/files/multisend.ts:289`);
   - model `<ImgGen>` output through `runInlayScreen()` (`src/ts/process/inlayScreen.ts:15`);
   - scripting/triggers through `generateAIImage()` plus `writeInlayImage()` (`src/ts/process/scriptings.ts:363`);
   - multimodal provider responses and signatures (`src/ts/process/request/google.ts:760`).

2. New assets normally receive UUIDs. Images are canvas-normalized; audio/video retain Blob bytes and their recognized extension (`src/ts/process/files/inlays.ts:423`, `src/ts/process/files/inlays.ts:430`, `src/ts/process/files/inlays.ts:465`).
3. `setInlayAsset()` writes:

   - serialized payload under `inlay/<id>`;
   - display/type data under `inlay_info/<id>`;
   - timestamps and optional character/chat ownership under `inlay_meta/<id>`.

4. On `/api/write`, the Node server decodes an `inlay/<id>` data URI and writes `save/inlays/<id>.<ext>` plus `<id>.meta.json`; `inlay_meta` remains a SQLite KV record (`server/node/server.cjs:4244-4267`).
5. Chats store only tokens. Composer attachments become `{{inlayed::<id>}}` before the user message is appended (`src/lib/ChatScreens/DefaultChatScreen.svelte:349`). Generated inline images normally use `{{inlay::<id>}}` (`src/ts/process/inlayScreen.ts:29`).
6. When preparing model input, user-message inlays become multimodal parts if supported. Images fall back to image captioning for non-vision models. At most one audio/video item is added, and only while the multimodal list is still empty; assistant-side handling retains only `inlayeddata` tokens as model input (`src/ts/process/index.svelte.ts:819`, `src/ts/process/index.svelte.ts:841`).
7. Rendering calls `parseInlayAssets()`, producing placeholders when type/URL data is not already cached. `ChatBody` invokes `resolveInlayPlaceholders()` after the Svelte HTML block is mounted (`src/lib/ChatScreens/ChatBody.svelte:244`, `src/lib/ChatScreens/ChatBody.svelte:252`).
8. Near-viewport placeholders are resolved in batches of 20, classified from `inlay_info` unless image-priority mode is enabled, and replaced with `<img>`, `<video>`, or `<audio>` pointing to `/api/asset/<hex("inlay/<id>")>` (`src/ts/parser/parser.svelte.ts:739`, `src/ts/parser/parser.svelte.ts:746`, `src/ts/parser/parser.svelte.ts:768`).
9. The server authenticates direct tags through the `risu-session` cookie and streams the raw file with its detected MIME type (`server/node/server.cjs:1647`, `:3747`).

### Image generation and view screens

1. Non-inlay `imggen` view mode gathers the most recent user/character exchange and calls `stableDiff()` after response processing (`src/ts/process/index.svelte.ts:1883`).
2. `stableDiff()` uses the character’s `newGenData.instructions` to ask the auxiliary model for a provider-ready prompt (`src/ts/process/stableDiff.ts:20`).
3. `generateAIImage()` dispatches using database provider configuration. Normal mode generally writes the image into `CharEmotion`; inlay mode returns image data to its caller for durable inlay storage.
4. Inlay view mode instead expects the model to emit `<ImgGen="...">`, directly applies `newGenData.prompt`/`negative`, displays `[Generating...]`, and asynchronously replaces it with a stored inlay token (`src/ts/process/inlayScreen.ts:12`).

## 4. Entry points & dependencies

### Calls into this subsystem

- Chat rendering and translation controls: `src/lib/ChatScreens/ChatBody.svelte:61` and `src/lib/ChatScreens/Chat.svelte:758`.
- Composer input translation: `src/lib/ChatScreens/DefaultChatScreen.svelte:685`.
- Suggested reply translation: `src/lib/ChatScreens/Suggestion.svelte:100`.
- Character-field translation during character operations: `src/ts/characters.ts:187`.
- Translation cache editing from a message: `src/lib/ChatScreens/Chat.svelte:150`.
- Plugin cache lookups: `src/ts/plugins/apiV3/v3.svelte.ts:1350`.
- Automatic TTS and inlay command processing: `src/ts/process/index.svelte.ts:1512`, `src/ts/process/index.svelte.ts:1520`.
- File upload: `src/ts/process/files/multisend.ts:194`.
- Script and trigger image generation: `src/ts/process/scriptings.ts:363`, `src/ts/process/triggers.ts:1514`.
- Inlay gallery/explorer: `src/lib/Setting/Pages/InlayImageGallery.svelte:17`.
- Character TTS/view-screen configuration: `src/lib/SideBars/CharConfig.svelte:391`, `src/lib/SideBars/CharConfig.svelte:700`.

### Calls out from this subsystem

- Translation and prompt generation use `requestChatData()` from the request subsystem (`src/ts/translator/translator.ts:575`, `src/ts/process/stableDiff.ts:34`).
- Remote services use `globalFetch`, native `fetch`, or `fetchNative`.
- Bergamot depends on `@browsermt/bergamot-translator`, IndexedDB, Mozilla model registries, and `fflate`.
- TTS depends on Web Speech, Web Audio, provider APIs, `runVITS`, uploaded GPT-SoVITS reference assets, and optional translation.
- Inlays depend on database/model metadata, `NodeStorage`, browser Blob/canvas APIs, and the parser/model-request pipelines.
- Server image compression and thumbnails depend on `wasm-vips` (`server/node/server.cjs:25`, `:3734`, `:6777`).
- Uploaded notification sounds use the ordinary `assets/<hash>.<ext>` path created by `saveAsset()` (`src/ts/globalApi.svelte.ts:203`).
- The Hono alternative does not implement these storage routes; it currently only exposes a CSRF-protected hello route (`server/hono/src/app/index.ts:4`, `server/hono/src/app/index.ts:8`).

## 5. Conventions & gotchas

- `runTranslator` does not use conventional source/target parameter semantics. It computes request languages as `from = reverse ? from : target` and `to = reverse ? target : from` (`src/ts/translator/translator.ts:73`). Audit existing callers before changing this legacy convention.
- The simple translation cache and LLM cache are keyed by text, not by provider, source language, target language, preset, translator note, or character. Changing any of those can reuse stale translations until cache clear or regeneration.
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
- Inlay tokens are a RisuAI compatibility contract:

  - `{{inlay::<id>}}` is an inline/generated reference.
  - `{{inlayed::<id>}}` is an attached reference and gets a `.risu-inlay-image` wrapper.
  - `{{inlayeddata::<id>}}` carries assistant-side multimodal/signature data.

- Chat messages store IDs, never embedded bytes. Gallery deletion therefore revalidates against authoritative chat rows under the storage queue and preserves references from loaded, unsaved chats as an additional keep-set.
- `scanInlayReferences()` is server-aware and fail-closed in both gallery surfaces: no assets are classified as message-orphans until the authoritative scan succeeds.
- Signature inlays are not rendered as visible media. They preserve provider/model metadata so a later request can replay the signature alongside the corresponding assistant content.
- Image inlays are always re-encoded. Lossless mode stores PNG; default mode stores WebP quality 0.85. Original filenames/extensions are informational and do not dictate the encoded image format.
- `postChatFile()` accepts `mpeg` and `avi`, while `postInlayAsset()` recognizes video only as `webm`, `mp4`, or `mkv` (`src/ts/process/files/multisend.ts:284`, `src/ts/process/files/inlays.ts:72`). Those accepted picker formats can consequently be discarded.
- Upload extension matching is lowercase and case-sensitive; callers should normalize extensions before expanding format support.
- `compressImage()` can route GIF through canvas recompression, which collapses animated input to a rasterized frame.
- Current inlay payloads are filesystem files, despite the client-facing `NodeStorage` KV abstraction. Explorer info is mirrored in sidecars; ownership/time metadata remains in SQLite.
- Safe `assets/<content-hash>.<ext>` values are also filesystem-backed. Unsafe or legacy names retain the SQLite fallback, so code must use the storage helpers instead of assuming one physical backend for every asset key.
- The server still reads and migrates legacy SQLite `inlay/<id>` JSON records (`server/node/server.cjs:1352-1433`). Preserve this fallback when changing storage format.
- Direct asset URLs use one-year `immutable` caching (`server/node/server.cjs:3755-3762`). Reusing and overwriting an explicit inlay ID can leave a browser with a stale cached URL; new content normally needs a new ID.
- Inlay IDs are validated against separators and traversal components before filesystem access (`server/node/server.cjs:1111-1139`).
- `/api/asset/:hexKey` requires the session cookie, not the normal `risu-auth` request header. Initialization of `/api/session` is part of asset rendering, not merely login housekeeping.
- `src/ts/3d/threeload.ts` is legacy and has no current consumers. Do not treat it as the live 3D rendering entry point.
- Most image providers follow the inlay-vs-`CharEmotion` return contract, but branches are not perfectly uniform; verify a provider branch before relying on its return value.

## 6. Navigation hints

- To add or change a translation provider, start at `translateMain()` (`src/ts/translator/translator.ts:137`) and expose its settings in `src/ts/setting/languageSettingsData.svelte.ts:116`.
- To change input-language direction or debounce behavior, inspect `src/lib/ChatScreens/DefaultChatScreen.svelte:685`.
- To change when messages auto-translate, inspect `src/lib/ChatScreens/ChatBody.svelte:61`.
- To change Markdown-before/after-translation behavior, inspect `src/lib/ChatScreens/ChatBody.svelte:111` and `translateHTML()` (`src/ts/translator/translator.ts:273`).
- To alter the LLM translation prompt/request, inspect `src/ts/translator/translator.ts:520` and `src/ts/translator/presets.ts:25`.
- To change cache keying or persistence, inspect `src/ts/translator/translator.ts:28` and `src/ts/storage/persistentKv.ts:41-77`.
- To change translator preset migration or file format, inspect `src/ts/translator/presets.ts:104` and `src/ts/translator/presets.ts:171`.
- To add a TTS provider, add a mode under `src/ts/process/tts.ts:113` and its character settings under `src/lib/SideBars/CharConfig.svelte:700`.
- To change TTS text normalization, inspect `src/ts/process/tts.ts:91`.
- To change plugin hook semantics, inspect `src/ts/process/ttsHooks.ts:61` and the audio-specific pipeline at `src/ts/process/tts.ts:31`.
- To change automatic TTS timing, inspect `src/ts/process/index.svelte.ts:1520` and `src/ts/process/index.svelte.ts:1582`.
- To add an inlay-supported file extension, update the arrays at `src/ts/process/files/inlays.ts:64` and the picker at `src/ts/process/files/multisend.ts:198`.
- To change inlay image size/quality, inspect `writeInlayImage()` (`src/ts/process/files/inlays.ts:438`).
- To change inlay storage records or metadata, inspect `setInlayAsset()` (`src/ts/process/files/inlays.ts:600`) and `buildInlayMeta()` (`src/ts/process/files/inlayMeta.ts:106`).
- To change token syntax, update the shared regex at `src/ts/util/inlayTokens.ts:3` and audit parser/model-request regexes at `src/ts/parser/parser.svelte.ts:693` and `src/ts/process/index.svelte.ts:821`.
- To change lazy media rendering, inspect `src/ts/parser/parser.svelte.ts:692` and `src/ts/parser/parser.svelte.ts:735`.
- To change how uploaded inlays become chat references, inspect `src/lib/ChatScreens/DefaultChatScreen.svelte:349`.
- To change which inlays are sent to models, inspect `src/ts/process/index.svelte.ts:819`.
- To change server-side inlay layout, inspect `server/node/server.cjs:1111`, `:1182`, `:1281`, and the `/api/write` branch at `:4244`.
- To change direct asset authentication or caching, inspect `server/node/server.cjs:1647`, `:3666`, and `:3747`.
- To change bulk gallery metadata loading, inspect `src/ts/process/files/inlays.ts:572` and `server/node/server.cjs:4573`.
- To change server-side batch inlay compression, inspect `server/node/server.cjs:6777`.
- To add or alter an image-generation provider, inspect `generateAIImage()` (`src/ts/process/stableDiff.ts:63`).
- To change model-emitted `<ImgGen>` behavior, inspect `src/ts/process/inlayScreen.ts:5` and `src/ts/process/inlayScreen.ts:15`.
- To change completion sounds or add bundled presets, inspect `src/ts/notificationSound.ts:27` and `src/ts/notificationSound.ts:49`.

## 7. Related structure docs

- [Chat pipeline](chat-pipeline.md) covers attachment extraction, model input, and response-side inlay handling.
- [Characters and personas](characters-personas.md) covers inlays included in character packages.
- [Client storage](client-storage.md) and [server backend](server-backend.md) cover the logical storage API and physical asset/inlay backends.
- [UI layer](ui-layer.md) covers the inlay gallery and specialist playground surfaces.
- `src/lib/UI/3DLoader.svelte` is also marked legacy/not currently used and directly imports Three.js instead of using `src/ts/3d/threeload.ts`.
