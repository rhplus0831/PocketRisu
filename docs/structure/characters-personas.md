# Characters and personas

> Part of the PocketRisu structure docs — see [STRUCTURE.md](../../STRUCTURE.md) for the top-level map and subsystem index.
> Audited 2026-07-27 against `abee0232`. Paths and symbols are authoritative; line-number hints are approximate and should be verified with `rg`.

## 1. Purpose & overview

The characters-personas subsystem owns PocketRisu’s persistent character and user-persona models, character creation and selection, portrait/emotion/additional-asset references, and interchange with the RisuAI character-card ecosystem. It imports V2/V3 JSON and PNG cards, V3 CharX/CharX-JPEG, and legacy encrypted RCC metadata. It exports current V3 JSON/PNG/CharX plus compatibility V2 PNG; RCC is import-only. Persona PNGs and PocketRisu character-package ZIPs have separate, intentionally narrower schemas. Adjacent `.risup` preset and `.risum` module files are routed to their own subsystems.

Character metadata lives inside the main database object, while image and other binary payloads are stored separately under opaque `assets/...` keys. Consequently, card and package code translates between portable embedded bytes/URIs and local storage references.

## 2. Key files

### Core character model and operations

- `src/ts/storage/database.svelte.ts` — canonical persistent data types and database normalization.

  - `RisuPersona` defines `name`, `personaPrompt`, `icon`, optional stable `id`, `note`, `largePortrait`, and `embeddedModule` at `src/ts/storage/database.svelte.ts:949`.
  - `Database.characters`, `Database.personas`, `selectedPersona`, and the active persona working-copy fields are declared from `src/ts/storage/database.svelte.ts:959`.
  - Default persona initialization mirrors `username`, `userIcon`, and `userNote` into the first persona at `src/ts/storage/database.svelte.ts:406`.
  - `getCurrentCharacter`, `setCurrentCharacter`, `getCharacterByIndex`, and `setCharacterByIndex` access `Database.characters` at `src/ts/storage/database.svelte.ts:754`, `src/ts/storage/database.svelte.ts:763`, `src/ts/storage/database.svelte.ts:770`, and `src/ts/storage/database.svelte.ts:779`.
  - The canonical `character` interface begins at `src/ts/storage/database.svelte.ts:1536`.
  - `Chat.bindedPersona` is an optional persona ID, not an array index, at `src/ts/storage/database.svelte.ts:2034`.
  - `saveImage` is an alias of the shared content-addressed `saveAsset` helper at `src/ts/storage/database.svelte.ts:2181`.

- `src/ts/characters.ts` — character lifecycle, image management, compatibility normalization, and co-located chat import/export.

  - `createNewCharacter()` appends `createBlankChar()` and repairs character ordering at `src/ts/characters.ts:20`.
  - `getCharImage()` resolves an asset key into a browser URL/CSS declaration and honors `hideAllImages` at `src/ts/characters.ts:27`.
  - `selectCharImg()`, `dumpCharImage()`, and `changeCharImage()` manage the active portrait and alternate `ccAssets` icons at `src/ts/characters.ts:61`, `src/ts/characters.ts:107`, and `src/ts/characters.ts:124`.
  - `addCharEmotion()` and `rmCharEmotion()` mutate `[emotionName, assetKey]` tuples at `src/ts/characters.ts:137` and `src/ts/characters.ts:156`.
  - `exportChat()`, `importChat()`, and `exportAllChats()` are adjacent chat interchange functions at `src/ts/characters.ts:164`, `src/ts/characters.ts:349`, and `src/ts/characters.ts:487`.
  - `characterFormatUpdate()` fills legacy/missing fields, creates chat IDs, migrates lore and old post-history instructions, and updates `lastInteraction` at `src/ts/characters.ts:525`.
  - `updateLorebooks()` migrates legacy lore syntax to book version 2 at `src/ts/characters.ts:625`.
  - `createBlankChar()` is the authoritative new-character factory at `src/ts/characters.ts:645`.
  - `removeChar()` implements trashing versus permanent deletion at `src/ts/characters.ts:701`.
  - `addCharacter()` dispatches the add-character dialog to scratch creation, file import, package import, or Realm at `src/ts/characters.ts:726`.
  - `changeChar()` selects and normalizes a character and asynchronously hydrates a placeholder chat when necessary at `src/ts/characters.ts:760`.

### Card and Realm interchange

- `src/ts/characterCards.ts` — main card-format and RisuRealm boundary.

  - `importCharacter()` is the multi-file picker entry point at `src/ts/characterCards.ts:25`.
  - `importCharacterProcess()` dispatches JSON, PNG, CharX, and CharX-JPEG input at `src/ts/characterCards.ts:45`.
  - PNG parsing, card chunks, embedded assets, RCC decryption, and V2/V3 dispatch occupy `src/ts/characterCards.ts:116`.
  - `getRealmInfo()`, `showRealmInfoStore`, and `characterURLImport()` handle Realm deep links and other URL/PWA imports at `src/ts/characterCards.ts:341`, `src/ts/characterCards.ts:354`, and `src/ts/characterCards.ts:356`.
  - `convertOffSpecCards()` converts Tavern-style or incomplete V2-shaped cards at `src/ts/characterCards.ts:549`.
  - `exportChar()` presents the export chooser and defaults current exports to V3 at `src/ts/characterCards.ts:611`.
  - `importCharacterCardSpec()` is the internal V2/V3-to-`character` conversion choke point at `src/ts/characterCards.ts:635`.
  - `convertCharbook()` converts Character Book entries and extension directives into PocketRisu lore entries at `src/ts/characterCards.ts:951`.
  - `createBaseV2()` constructs compatibility V2 JSON at `src/ts/characterCards.ts:1060`.
  - `exportCharacterCard()` writes JSON, PNG, CharX, or CharX-JPEG at `src/ts/characterCards.ts:1157`.
  - `createBaseV3()` constructs the `CharacterCardV3` object and V3 asset list at `src/ts/characterCards.ts:1430`.
  - `hubType` describes Realm catalog records at `src/ts/characterCards.ts:1575`.
  - `getRisuHub()` queries the Realm catalog at `src/ts/characterCards.ts:1598`.
  - `downloadRisuHub()` downloads and imports a Realm card at `src/ts/characterCards.ts:1627`.
  - `getHubResources()` retrieves an individual Realm resource through `/hub-proxy` at `src/ts/characterCards.ts:1701`.
  - `isCharacterHasAssets()` detects emotion, additional, or generic card assets for export warnings at `src/ts/characterCards.ts:1709`.
  - The local V2 compatibility type begins at `src/ts/characterCards.ts:1726`.
  - `@risuai/ccardlib` supplies only TypeScript types (`CharacterCardV3` and `LorebookEntry`) here, imported at `src/ts/characterCards.ts:13`; it is not used as a runtime parser or validator. The declared dependency is `^0.4.2` at `package.json:33`.

### Character packages

- `src/ts/characterPackage.ts` — PocketRisu package ZIPs bundling a character card with optional chats, bound personas, and inlays.

  - `PackageManifest` defines `type: "risuCharacterPackage"` and `version: 1` at `src/ts/characterPackage.ts:21`.
  - `scanCharacterInlayIds()` finds `{{inlay::...}}`, `{{inlayed::...}}`, and `{{inlayeddata::...}}` references in chat message text at `src/ts/characterPackage.ts:65`.
  - `getCharacterBoundPersonas()` resolves unique `Chat.bindedPersona` IDs against `db.personas` at `src/ts/characterPackage.ts:82`.
  - `buildPersonaPng()` embeds the persona JSON in a `persona` PNG text chunk at `src/ts/characterPackage.ts:103`.
  - Package validation requires `manifest.json`, the exact manifest type, and version 1 at `src/ts/characterPackage.ts:141`.
  - Persona import and old-to-new persona ID mapping are implemented at `src/ts/characterPackage.ts:186`.
  - Chat replacement/append, chat-ID regeneration, persona-ID remapping, and folder collision handling live at `src/ts/characterPackage.ts:260`.
  - Inlay import and metadata restoration begin at `src/ts/characterPackage.ts:318`.
  - `exportCharacterPackage()` builds the outer ZIP at `src/ts/characterPackage.ts:392`.
  - `importCharacterPackage()` creates a new character from a package at `src/ts/characterPackage.ts:616`.
  - `importPackageToCharacter()` appends package chats/personas/inlays to an existing character but does not replace that character’s card fields at `src/ts/characterPackage.ts:702`.

### Persona cards

- `src/ts/persona.ts` — active-persona synchronization and standalone persona PNG interchange.

  - `selectUserImg()` stores an uploaded portrait and updates the selected persona at `src/ts/persona.ts:10`.
  - `saveUserPersona()` copies the global working fields into `db.personas[selectedPersona]` at `src/ts/persona.ts:29`.
  - `changeUserPersona()` optionally saves the old persona, then loads the selected persona into `username`, `userIcon`, `personaPrompt`, and `userNote` at `src/ts/persona.ts:37`.
  - `exportUserPersona()` emits a PNG containing a base64 JSON `persona` text chunk at `src/ts/persona.ts:56`.
  - `importUserPersona()` reads that chunk, saves the PNG as the new icon, generates a new UUID, and appends the persona at `src/ts/persona.ts:106`.

### PNG and CharX primitives

- `src/ts/pngChunk.ts` — low-level PNG `tEXt` chunk reader/writer.

  - `StreamChunkWriter` copies the base PNG while replacing existing `chara`/`ccv3` metadata and appending new text chunks at `src/ts/pngChunk.ts:6`.
  - `PngChunk.read()` performs non-streaming selected-key extraction at `src/ts/pngChunk.ts:93`.
  - `PngChunk.readGenerator()` streams text chunks and can return a PNG stripped of text metadata via `returnTrimed` at `src/ts/pngChunk.ts:131`.
  - `PngChunk.trim()` strips text chunks at `src/ts/pngChunk.ts:222`.
  - `PngChunk.write()` writes a replacement set of text chunks and recalculates CRCs at `src/ts/pngChunk.ts:246`.
  - `PngChunk.streamWriter` exposes `StreamChunkWriter` for card export at `src/ts/pngChunk.ts:323`.

- `src/ts/process/processzip.ts` — streaming CharX ZIP writer/importer.

  - `processZip()` is an unrelated image-generation helper that extracts the first image from a ZIP at `src/ts/process/processzip.ts:19`.
  - `CharXWriter` incrementally writes ZIP members, sanitizes filenames, and supports JPEG-prefixed output at `src/ts/process/processzip.ts:46`.
  - `CharXImporter` streams a ZIP, extracts `card.json` and optional `module.risum`, and saves remaining members as assets with concurrency limited to ten at `src/ts/process/processzip.ts:160`.
  - `CharXImporter.parse()` accepts `Uint8Array`, `File`, or `ReadableStream` at `src/ts/process/processzip.ts:235`.
  - `CharXImporter.done()` must be awaited to observe all queued asset saves and errors at `src/ts/process/processzip.ts:271`.
  - File dispatch treats `card.json` and `module.risum` specially, ignores other JSON, and treats everything else as an asset at `src/ts/process/processzip.ts:362`.
  - `CharXSkippableChecker()` probes the hub for a double-hashed archive signal at `src/ts/process/processzip.ts:442`; it currently has no callers.

### RPack, `.risum`, and `.risup`

- `src/ts/rpack/rpack_js.js` — fixed byte-substitution compatibility codec.

  - `initRPack()` loads the 512-byte map at `src/ts/rpack/rpack_js.js:9`.
  - `encodeRPack()` uses the first 256 map bytes at `src/ts/rpack/rpack_js.js:18`.
  - `decodeRPack()` uses the inverse 256-byte map at `src/ts/rpack/rpack_js.js:26`.

- `src/ts/rpack/rpack_map.bin` — 512 bytes; encode and decode substitution tables.

- `src/ts/rpack/README` — identifies RPack as compatibility obfuscation rather than encryption.

- `src/ts/process/modules.ts` — adjacent module subsystem, significant here because CharX embeds `module.risum`.

  - `RisuModule` is defined at `src/ts/process/modules.ts:19`.
  - Current standalone module export converts a module to a V3 CharX at `src/ts/process/modules.ts:37`.
  - `exportModuleLegacy()` writes legacy `.risum` framing and RPack-obfuscated records at `src/ts/process/modules.ts:61`.
  - `readModule()` validates magic byte `111`, version `0`, decodes the module JSON, and imports framed assets at `src/ts/process/modules.ts:125`.
  - Standalone `.risum`/CharX module import begins at `src/ts/process/modules.ts:256`.

- `src/ts/storage/database.svelte.ts` also owns adjacent preset serialization:

  - `downloadPreset()` writes `.risup` as RPack-obfuscated, compressed MsgPack containing encrypted preset MsgPack at `src/ts/storage/database.svelte.ts:2846`.
  - `importPreset()` accepts legacy `.risupreset` and current `.risup`; only `.risup` receives RPack decoding at `src/ts/storage/database.svelte.ts:2895`.

### Realm UI

- `src/lib/UI/Realm/RealmMain.svelte` — catalog search, sorting, pagination, card selection, and manual URL/ID import. Its query wrapper calls `getRisuHub()` at `src/lib/UI/Realm/RealmMain.svelte:21`; URL/ID import calls `downloadRisuHub()` at `src/lib/UI/Realm/RealmMain.svelte:196`.

- `src/lib/UI/Realm/RealmPopUp.svelte` — detail modal, fork navigation, download, sharing, reporting, and owner-only removal. Download is triggered at `src/lib/UI/Realm/RealmPopUp.svelte:123`.

- `src/lib/UI/Realm/RealmHubIcon.svelte` — catalog tile with image hiding and asset/lore indicators. Remote thumbnails use `/hub-proxy/resource/...` at `src/lib/UI/Realm/RealmHubIcon.svelte:25`.

- `src/lib/UI/Realm/RealmLicense.svelte` — maps known licenses to Creative Commons links at `src/lib/UI/Realm/RealmLicense.svelte:13`.

### Binary storage support

- `src/ts/globalApi.svelte.ts` — supporting storage boundary.

  - `forageStorage` is an `AutoStorage` facade at `src/ts/globalApi.svelte.ts:31`.
  - `getFileSrc()` uses `/api/asset/<hex-key>` in Node mode at `src/ts/globalApi.svelte.ts:113`.
  - `readImage()` reads an opaque asset key at `src/ts/globalApi.svelte.ts:191`.
  - `saveAsset()` hashes bytes and stores them under `assets/<hash>.<extension>` at `src/ts/globalApi.svelte.ts:203`.
  - Ordinary-asset cleanup is server-owned. `collectDatabaseAssetReferences()` scans the complete stripped database plus the active optimized plugin publication, so character/persona/module fields do not require a parallel client allowlist.

- `server/node/db.cjs` stores unsafe asset keys as BLOBs in `save/risuai.db`; safe-named legacy hash mismatches remain filesystem-backed with explicit identity markers. Database creation and the `kv` table are at `server/node/db.cjs:9-14` and `server/node/db.cjs:29`.

- `server/node/server.cjs` serves asset keys through the authenticated direct-asset endpoint at `server/node/server.cjs:3747` and proxies `/hub-proxy/*` to `https://sv.risuai.xyz` at `server/node/server.cjs:3436-3546`.

## 3. Architecture & data flow

### Persistent models

A character is an element of `Database.characters`; its durable identity is `chaId`, while most UI code addresses it by current array index. Important field groups are:

- Identity and UI: `name`, `chaId`, `nickname`, `tags`, `creator`, `characterVersion`, `source`, timestamps, `trashTime`, and `lastInteraction`.
- Prompt/card content: `desc`, `personality`, `scenario`, `firstMessage`, `alternateGreetings`, `exampleMessage`, `creatorNotes`, `systemPrompt`, `replaceGlobalNote`, `depth_prompt`, and `defaultVariables`.
- Conversation state: `chats`, `chatFolders`, `chatPage`, and `firstMsgIndex`.
- Lore and scripting: `globalLore`, `loreSettings`, `loreExt`, `customscript`, `triggerscript`, module bindings, and low-level-access flags.
- Media: `image`, `emotionImages`, `additionalAssets`, `ccAssets`, `vits`, `viewScreen`, `newGenData`, and portrait/display flags.
- Compatibility extensions: `additionalData`, misspelled `extentions`, and Risu-specific UI/generation fields.

The full schema is intentionally wider than the Character Card specifications (`src/ts/storage/database.svelte.ts:1536`). V2/V3 export maps portable fields into standard card fields and preserves PocketRisu-specific values under `data.extensions.risuai`.

A persona exists twice while selected:

1. `db.personas[db.selectedPersona]` is the saved record.
2. `db.username`, `db.userIcon`, `db.personaPrompt`, and `db.userNote` are the active working copy.

`saveUserPersona()` synchronizes working copy to record; `changeUserPersona()` synchronizes in the opposite direction. At chat runtime, `checkPersonaBinded()` resolves `Chat.bindedPersona` by UUID and overrides the global active persona for name, icon, prompt, and portrait mode (`src/ts/util.ts:65`).

### Character creation and selection

1. `addCharacter()` receives a dialog result.
2. Scratch creation calls `createNewCharacter()` → `createBlankChar()` → `checkCharOrder()`.
3. File import calls `importCharacter()` → `importCharacterProcess()`.
4. Package import calls `importCharacterPackage()`.
5. Realm selection opens `OpenRealmStore` instead of immediately creating a character.
6. After creation/import, `changeChar()` calls `characterFormatUpdate()`, updates `selectedCharID`, and hydrates the selected chat if it is a server placeholder.

`characterFormatUpdate()` is the main legacy-normalization path. It guarantees a chat, `chaId`, card-era fields, scripts, lore migration, chat IDs, and local lore, but it is normally invoked on selection rather than eagerly over every character at database load.

### Asset storage and references

`saveAsset(bytes, customId?, fileName?)` chooses a content hash when no custom ID is supplied and writes the bytes to an `assets/<hash>.<extension>` KV key. Character fields retain only that string:

- `image`: one asset key.
- `emotionImages`: `[emotionName, assetKey][]`.
- `additionalAssets`: `[displayName, assetKey, extension][]`.
- `ccAssets`: `{type, uri: assetKey, name, ext}[]`.
- Persona `icon`: one asset key.
- VITS files: a name-to-asset-key mapping.

In the self-hosted Node build, `NodeStorage.setItem()` sends the key and bytes to `/api/write` (`src/ts/storage/nodeStorage.ts:298`). Safe content-addressed `assets/*` keys are stored as immutable files under `save/assets/`; unsafe names retain the SQLite BLOB fallback. Rendering passes the key to `getFileSrc()`, which returns an authenticated `/api/asset/<hex-key>` URL rather than loading a base64 URL into JavaScript.

Changing a portrait with `selectCharImg()` first moves the previous `image` into `ccAssets` through `dumpCharImage()`. `changeCharImage()` performs the inverse swap, so alternate V3 icons are not discarded.

### Card import flows

#### JSON

1. `importCharacterProcess()` parses any filename ending in `json`.
2. It first calls `importCharacterCardSpec()` for exact `chara_card_v2` or `chara_card_v3`.
3. If that rejects the object, Tavern-style keys such as `char_name`/`char_persona` or `name`/`description` are converted with `convertOffSpecCards()`.
4. JSON carries assets only when V3 asset URIs are inline `data:` URIs; there is no surrounding binary container.

#### PNG Character Card V2/V3

1. The importer pre-scans PNG `tEXt` chunks to count `chara-ext-asset_*` entries.
2. A second streaming pass extracts:

   - `chara`: base64 card JSON, traditionally V2.
   - `ccv3`: base64 V3 JSON, preferred when both exist.
   - `chara-ext-asset_:N`: base64 asset payloads.
   - An `AppendableBuffer` containing the image with text chunks removed.

3. Embedded asset bytes are saved locally and mapped from `N` to an asset key.
4. Card URIs such as `__asset:N` are resolved through that map.
5. Legacy `rcc||rccv1||...` metadata is hash-checked and decrypted, prompting for a password when required.
6. Non-V2/V3 metadata falls back to Tavern conversion.
7. `importCharacterCardSpec()` maps the card into a fresh local `character` with a new `chaId` and empty initial chat.

#### CharX

1. `.charx`, `.jpg`, and `.jpeg` filenames are routed to `CharXImporter`.
2. The ZIP is expected to contain `card.json`, optional `module.risum`, and arbitrary asset members.
3. Asset members are saved concurrently and indexed by their archive path.
4. If `module.risum` exists, `readModule()` restores Risu regex scripts, trigger scripts, and the internal lorebook into the card import.
5. `importCharacterCardSpec()` resolves V3 `embeded://path` URIs through the importer’s path-to-local-key map.
6. Normal character import appends the result to `db.characters`; `returnCharacter: true` returns the unsaved converted character and is supported only for V3 CharX.

CharX-JPEG is a JPEG byte stream followed by the ZIP written by `CharXWriter.writeJpeg()`. It is selected by the `.jpg`/`.jpeg` dispatch and relies on ZIP readers tolerating the leading image data.

#### `.risup` and `.risum`

These are not character-card formats:

- `.risup` is a bot-preset format and is routed to `importPreset()`.
- `.risum` is the legacy module format and is routed to `readModule()`.
- `characterURLImport()` routes these extensions for URL, PWA-share, and launch-queue imports at `src/ts/characterCards.ts:492`.
- Global drag-and-drop performs the same separation at `src/App.svelte:49`.
- A `.risum` is nevertheless embedded inside every exported V3 CharX as `module.risum`, allowing Risu-specific lore/scripts to round-trip while `card.json` remains ecosystem-readable.

### Card export flows

`exportChar()` snapshots and clones the selected character, supplies `/none.webp` when the portrait is absent, and asks the user for V3 CharX, CharX-JPEG, PNG, JSON, or compatibility V2 PNG.

For V3:

1. `createBaseV3()` creates standard V3 card fields and a normalized asset list.
2. `additionalAssets` become `type: "x-risu-asset"`.
3. `emotionImages` become `type: "emotion"`.
4. Generic `ccAssets` retain their V3 type/name/extension.
5. The primary portrait is represented by `type: "icon"`, `name: "main"`, and `uri: "ccdefault:"`.
6. PNG export embeds compressed assets as `chara-ext-asset_:N` text chunks and rewrites URIs to `__asset:N`.
7. JSON export rewrites local assets to `data:application/octet-stream;base64,...`.
8. CharX export chooses archive paths under `assets/<semantic-type>/<media-class>/`, rewrites URIs to `embeded://...`, and writes optional PNG metadata under `x_meta/`.
9. CharX additionally writes `module.risum` and removes scripts from the card’s `risuai` extension before writing `card.json`.
10. PNG V3 writes base64 card JSON under `ccv3`.

For V2, `createBaseV2()` emits standard V2 fields plus `extensions.risuai` and writes base64 card JSON under `chara`. V2 is explicitly a compatibility path; current export does not populate its commented-out emotion or additional-asset arrays.

The low-level exporter can also write a V2 card object as ordinary JSON; base64 wrapping applies to PNG `chara` metadata, not to standalone JSON files. The normal export chooser exposes V2 PNG rather than a separate V2 JSON option.

### Character-package flow

Export:

1. Clone the character and hydrate every placeholder chat. A missing chat aborts export to prevent silent data loss.
2. Resolve personas referenced by `Chat.bindedPersona`.
3. Scan hydrated message text for inlay IDs.
4. Create an outer ZIP and optional inner V3 CharX.
5. Write `chats/chats.json` as `risuAllChats` version 2.
6. Write each persona as `persona/<name>.png`.
7. Write inlay payloads plus `inlays/meta.json`.
8. Write `manifest.json` last.

New-character import:

1. Fully unzip the package and validate the manifest.
2. Import the inner CharX, or create a blank character for an empty package.
3. Import personas and build an old-ID-to-new-ID map.
4. Replace the new character’s chats, remapping persona IDs and regenerating chat IDs.
5. Restore inlays and commit ordering.

Existing-character import ignores the packaged character card itself and appends only personas, chats/folders, and inlays.

### Realm flow

1. `RealmMain.svelte` calls `getRisuHub()`, which appends `__shared` to the search and fetches `/hub-proxy/realm/...`.
2. Catalog items open `RealmPopUp.svelte`.
3. `downloadRisuHub()` requires the shared Terms-of-Service confirmation unless forced.
4. It downloads from `https://realm.risuai.net/api/v1/download/dynamic/<id>?cors=true`.
5. PNG/ZIP/CharX responses enter `importCharacterProcess()`.
6. Legacy JSON responses enter `importCharacterCardSpec()` and fetch image/resources through `getHubResources()`.
7. Character ordering is repaired, and `goCharacterOnImport` or `forceRedirect` selects the imported character.
8. Startup deep links use `?realm=<id>`; `characterURLImport()` removes the parameter and fills `showRealmInfoStore`.

The Node server forwards `/hub-proxy/*` to `https://sv.risuai.xyz` while streaming response bodies (`server/node/server.cjs:3436-3546`).

## 4. Entry points & dependencies

### Calls into this subsystem

- Desktop sidebar creation and selection call `addCharacter()` and `changeChar()` from `src/lib/SideBars/Sidebar.svelte:912` and `src/lib/SideBars/Sidebar.svelte:697`.
- Mobile character UI calls the same operations from `src/lib/Mobile/MobileCharacters.svelte:38`.
- Character editing, asset management, export, package export/import, and removal are wired in `src/lib/SideBars/CharConfig.svelte:308` and `src/lib/SideBars/CharConfig.svelte:644`.
- Persona management is wired in `src/lib/Setting/Pages/PersonaSettings.svelte:73`.
- The add-character modal produces the dispatch strings consumed by `addCharacter()` at `src/lib/Others/AlertComp.svelte:390`.
- The card export format chooser is implemented at `src/lib/Others/AlertComp.svelte:471`.
- Application drag-and-drop routes `.risup`, `.risum`, and card files at `src/App.svelte:49`.
- Startup invokes `characterURLImport()` after loading an initialized database at `src/ts/bootstrap.ts:80`.
- Realm UI calls `getRisuHub()`, `getRealmInfo()`, and `downloadRisuHub()`.
- Module import calls `importCharacterProcess({returnCharacter: true})` to convert V3 CharX into a module at `src/ts/process/modules.ts:263`.
- Character-package export/import calls `exportCharacterCard()` and `importCharacterProcess()` at `src/ts/characterPackage.ts:488` and `src/ts/characterPackage.ts:667`.

### Calls out of this subsystem

- Reactive data: `getDatabase()`, `setDatabase()`, `setDatabaseLite()`, character accessors, `selectedCharID`, and Realm/mobile stores.
- Binary persistence: `saveAsset()`, `readImage()`, `loadAsset()`, `getFileSrc()`, `LocalWriter`, and `VirtualWriter`.
- Archive/codec libraries: `fflate`, Node/browser `Buffer`, PNG CRC32, MsgPack, and RPack.
- Card types: `@risuai/ccardlib`.
- Identity: `uuid` V4 for characters, chats, personas, folders, modules, and VITS models.
- Lore/script compatibility: `readModule()`, `exportModuleLegacy()`, and internal lore conversion.
- Inlays: `getInlayAsset()`, `setInlayAsset()`, batch info, and metadata functions.
- Cold chat storage: `ensureChatHydrated()` and `fetchChatFromServer()`.
- Remote services: `/hub-proxy`, `realm.risuai.net`, Chub’s download API, service-worker share endpoints, and URL hash imports.
- Prompt/render consumers obtain persona overrides through `getUserName()`, `getUserIcon()`, and `getPersonaPrompt()` at `src/ts/util.ts:81`, `src/ts/util.ts:90`, and `src/ts/util.ts:99`.

## 5. Conventions & gotchas

- `chaId` is the durable character identity; array indices and `selectedCharID` are UI-local and can change after deletion/reordering.
- Persona bindings must store `RisuPersona.id`, not a persona array index. IDs remain optional in the type for legacy saves, so code establishing a binding should create one first.
- Keep the active persona working copy and `db.personas[selectedPersona]` synchronized. Directly editing one side can be overwritten on the next `changeUserPersona()`.
- `characterFormatUpdate()` is selection-time normalization. Code that consumes an arbitrary unselected legacy character cannot assume it has already run.
- `characterFormatUpdate()` assumes core arrays such as `chats` and `globalLore` exist; importers and factories must construct them.
- New chats should include `newChatModelDefaults()` so model-mode preferences are snapshotted at chat birth.
- Character Card imports always generate a fresh local `chaId`; card IDs are not used as database identities.
- Standard character cards do not carry chats or personas. Use a character-package ZIP when those must travel together.
- Character-card and package formats are not interchangeable snapshots of the local character object. Each conversion has an explicit field/asset allowlist; inspect `src/ts/interchangeability.ts` and the target builder before promising a lossless round trip.
- The misspelled `extentions` field is persisted compatibility data and must not be casually renamed. Card export copies unknown extension keys back into `data.extensions`.
- There are duplicated creator/version representations: UI edits and export use `additionalData.creator` and `additionalData.character_version`, while imports also fill top-level `creator` and `characterVersion`.
- `post_history_instructions` maps to `replaceGlobalNote` in current card import/export. The older `postHistoryInstructions` property is migrated into the current chat note by `characterFormatUpdate()` and then cleared.
- `virtualscript` is intentionally blanked during import/export because of the recorded security concern at `src/ts/characterCards.ts:914`.
- Importing a card with `extensions.risuai.lowLevelAccess` requires explicit confirmation at `src/ts/characterCards.ts:830`.
- `@risuai/ccardlib` is compile-time typing only. Runtime validation is limited to local checks of `spec` and expected fields.
- Card filename dispatch uses case-sensitive `endsWith()` checks inside `importCharacterProcess()`. A direct caller should normalize names or uppercase extensions may fail.
- Plain `.jpg`/`.jpeg` input is treated as CharX-JPEG, not as a portrait-only card.
- V3 asset import accepts `__asset:`, `embeded://`, `ccdefault:`, and bounded `data:` URIs. Other URI schemes are skipped.
- V3 inline `data:` assets compare the base64 text length to 50 MiB, so the decoded-byte ceiling is lower than 50 MiB (`src/ts/characterCards.ts:787`).
- The intended 5 MiB PNG `chara`/`ccv3` guard checks the previous accumulator length before assignment and therefore does not currently bound the incoming chunk. Do not rely on it as an effective import limit (`src/ts/characterCards.ts:177`).
- `ccv3` takes precedence when a PNG contains both V2 `chara` and V3 `ccv3`.
- `exportCharacterCard()` sets `char.image = ""` after reading it at `src/ts/characterCards.ts:1173`. Normal UI callers pass a clone, but a new direct caller must not assume its argument remains unchanged.
- `exportCharacterCard()` declares a `password` option, but current export code never uses it. Password-protected RCC is import-only compatibility.
- Current V2 export leaves emotion and additional-asset properties commented out in `createBaseV2()`. Use V3 CharX for lossless asset export.
- The export UI warns against non-CharX formats when assets exist at `src/lib/Others/AlertComp.svelte:504`; JSON/PNG can embed assets but are less suitable for large collections.
- CharX keeps selected scripts/lore in `module.risum`, but it is not a lossless copy of every PocketRisu character/module field. Do not remove that member without accepting further loss of Risu-specific fidelity.
- CharX archive paths are referenced verbatim by `embeded://...`; writer path generation and importer asset keys must remain synchronized.
- `CharXImporter.done()` is mandatory. Reading `assets` immediately after `parse()` can race pending saves.
- The documented pre-size guard in `CharXImporter.#handleFile()` uses `file.originalSize ?? 0 < MAX_ASSET_SIZE_BYTES` at `src/ts/process/processzip.ts:342`. Because of operator precedence, a defined nonzero size is treated as truthy rather than actually compared; the later buffered-size check remains the effective 50 MiB exclusion.
- `PngChunk.write()` strips all existing PNG text chunks before writing the supplied set. `StreamChunkWriter` is more selective and preserves non-card text metadata.
- RPack is reversible substitution obfuscation, not encryption or compression. `.risup` adds separate compression and encrypted preset payload framing.
- Legacy `.risupreset` and current `.risup` are not byte-identical: `.risup` is RPack-decoded before decompression, while `.risupreset` is not.
- Legacy `.risum` framing is positional: magic `111`, version `0`, little-endian main-record length, then repeated asset marker/length/data records terminated by byte `0`.
- `getRisuHub()` accepts remote `additionalHTML`, and `RealmMain.svelte` renders it through `{@html ...}` at `src/lib/UI/Realm/RealmMain.svelte:144`. Treat the hub response as a trusted HTML source.
- Realm catalog/resource/report/remove traffic uses `/hub-proxy`, but the dynamic card download calls `realm.risuai.net` directly.
- `lightningRealmImport` only affects embedded PNG asset handling and only when legacy account sync is enabled. CharX import does not use that optimization.
- Package import fully materializes the outer ZIP with `fflate.unzip`; unlike CharX import, it is not streaming and can consume substantial memory.
- Package export hydrates every chat before scanning personas/inlays. Do not scan placeholder chats and assume their message arrays are complete.
- Importing a package into an existing character intentionally ignores the package’s inner CharX and only appends associated data.
- Package chat import regenerates chat IDs. Append mode also remaps colliding folder IDs.
- Inlay IDs are not regenerated. Existing local IDs are skipped, so a collision reuses the local inlay even if the package contains different bytes.
- Package persona duplicate detection includes the original persona ID and original icon storage string at `src/ts/characterPackage.ts:229`; cross-install duplicates therefore rarely qualify as exact duplicates.
- Package persona import does not currently copy the manifest’s `largePortrait` value into newly appended personas, despite exporting it.
- Standalone persona PNG interchange preserves only name, prompt, note, and the PNG used as icon. Stable IDs, large portraits, embedded modules, and other advanced persona state do not round-trip.
- Package chat IDs are regenerated and bound persona IDs are remapped, but chat IDs recorded inside imported inlay ownership metadata are not remapped to the new chat IDs.
- If new-character package import fails after adding personas or inlays, rollback explicitly removes only the newly created character at `src/ts/characterPackage.ts:690`; associated writes may remain.
- License restrictions are enforced by the character-config UI, not by `exportCharacterPackage()` itself. Restricted licenses disable ordinary card export and force `includeCharacter: false` at `src/lib/SideBars/CharConfig.svelte:630`.
- Asset paths stored anywhere in the stripped database are discovered by the server's bounded recursive reachability scan. New external asset-reference stores must be joined into `collectDatabaseAssetReferences()` and covered by fail-closed cleanup tests.

## 6. Navigation hints

- To add or change a persistent character field, start at `src/ts/storage/database.svelte.ts:1536`, then update the blank factory at `src/ts/characters.ts:645` and legacy normalization at `src/ts/characters.ts:525`.
- To change standard V3 import mapping, edit `src/ts/characterCards.ts:753` and the final local-character construction at `src/ts/characterCards.ts:866`.
- To change standard V3 export mapping, edit `src/ts/characterCards.ts:1430`.
- To preserve a PocketRisu-only field across cards, update both `extensions.risuai` export at `src/ts/characterCards.ts:1530` and import at `src/ts/characterCards.ts:909`.
- To change V2 compatibility behavior, inspect `src/ts/characterCards.ts:662`, `src/ts/characterCards.ts:1060`, and `src/ts/characterCards.ts:1192`.
- To change PNG card metadata keys or embedded-asset chunks, inspect `src/ts/characterCards.ts:147`, `src/ts/characterCards.ts:162`, and `src/ts/characterCards.ts:1261`.
- To change PNG chunk parsing or CRC behavior, edit `src/ts/pngChunk.ts:93` and `src/ts/pngChunk.ts:131`.
- To add a portable V3 asset type, update local import classification at `src/ts/characterCards.ts:801`, V3 construction at `src/ts/characterCards.ts:1430`, and CharX path classification at `src/ts/characterCards.ts:1271`.
- To change the character portrait/alternate-icon swap behavior, inspect `src/ts/characters.ts:61`, `src/ts/characters.ts:107`, and `src/ts/characters.ts:124`.
- To change emotion upload behavior, inspect `src/ts/characters.ts:137` and its UI at `src/lib/SideBars/CharConfig.svelte:399`.
- To change additional-asset upload and tuple semantics, inspect `src/lib/SideBars/CharConfig.svelte:485` and `src/ts/characterCards.ts:1440`.
- To change how asset binaries are named or stored, edit `src/ts/globalApi.svelte.ts:203`, `server/node/assetStore.cjs`, and the canonical reference matching in `server/node/assetGc.cjs`.
- To change CharX members or streaming behavior, inspect `src/ts/process/processzip.ts:46`, `src/ts/process/processzip.ts:160`, and V3 archive writing at `src/ts/characterCards.ts:1389`.
- To change the Risu-specific module embedded in CharX, inspect `src/ts/characterCards.ts:1389` and `src/ts/process/modules.ts:61`.
- To change `.risum` compatibility framing, edit `src/ts/process/modules.ts:61` and its inverse at `src/ts/process/modules.ts:125`.
- To change `.risup` compatibility, inspect `src/ts/storage/database.svelte.ts:2846`, `src/ts/storage/database.svelte.ts:2895`, and `src/ts/rpack/rpack_js.js:9`.
- To add a new importable extension, update file dispatch at `src/ts/characterCards.ts:45`, URL/PWA routing at `src/ts/characterCards.ts:492`, and global drag-and-drop at `src/App.svelte:49`.
- To change persona selection synchronization, inspect `src/ts/persona.ts:29` and `src/ts/persona.ts:37`.
- To change standalone persona-card fields, update the `PersonaCard` shape at `src/ts/persona.ts:50` and both PNG paths at `src/ts/persona.ts:56` and `src/ts/persona.ts:106`.
- To change chat-bound persona behavior, inspect `src/ts/util.ts:65` and package persona remapping at `src/ts/characterPackage.ts:260`.
- To change package contents or versioning, start with `PackageManifest` at `src/ts/characterPackage.ts:21`, export at `src/ts/characterPackage.ts:392`, and validation at `src/ts/characterPackage.ts:141`.
- To change package import into a new character, inspect `src/ts/characterPackage.ts:616`.
- To change append-to-existing semantics, inspect `src/ts/characterPackage.ts:286` and `src/ts/characterPackage.ts:702`.
- To change which inlays are packaged, inspect the reference regex at `src/ts/characterPackage.ts:63` and inlay export at `src/ts/characterPackage.ts:546`.
- To change Realm catalog queries, edit `src/ts/characterCards.ts:1598` and `src/lib/UI/Realm/RealmMain.svelte:21`.
- To change Realm download/import behavior, edit `src/ts/characterCards.ts:1627`.
- To change Realm deep-link handling, inspect `src/ts/characterCards.ts:341`, `src/ts/characterCards.ts:356`, and startup invocation at `src/ts/bootstrap.ts:80`.
- To change Realm proxying, inspect `server/node/server.cjs:3436-3546`.
- To change export-format warnings or choices, inspect `src/lib/Others/AlertComp.svelte:471`.
- To change character-package license gating, inspect `src/lib/SideBars/CharConfig.svelte:630`.

## 7. Related structure docs

- `src/ts/interchangeability.ts` is the character ↔ module ↔ persona conversion map, including lore indicators used to preserve selected fields.
- [Media and translation](media-translation.md) covers inlay persistence and ownership metadata.
- [Client storage](client-storage.md) covers placeholder/cold-chat hydration used by package export.
- [Chat pipeline](chat-pipeline.md) covers chat behavior; chat JSON/JSONL/TXT/HTML interchange remains co-located in `src/ts/characters.ts`.
- [Memory and lorebook](memory-lorebook.md) covers live module projection and lore execution.
