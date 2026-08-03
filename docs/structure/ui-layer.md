# UI layer

> Part of the PocketRisu structure docs — see [STRUCTURE.md](../../STRUCTURE.md) for the top-level map and subsystem index.
> Audited 2026-08-01 against `818c3bc1`. Paths and symbols are authoritative; line-number hints are approximate and should be verified with `rg`.

## 1. Purpose & overview

The UI layer is a Svelte 5 single-page application whose “routing” is almost entirely reactive-store driven rather than URL driven. `App.svelte` selects an April 1 gate, loading, settings, mobile, desktop character-grid, or desktop sidebar/chat layouts, while long-lived modal and toast hosts remain mounted above every screen. Most screens bind directly to the reactive `DBState.db` database proxy, so UI edits normally become persistence inputs without an intermediate form model.

The `src/lib/` tree combines major feature screens, desktop and mobile shells, settings pages, legacy controls, newer `bits-ui`/shadcn-style controls, and global overlays. The chat renderer is deliberately split into a screen shell, composer/controller, manually mounted message list, individual message bubble, and asynchronous parsed body.

### Directory map

| Directory | Navigation role |
|---|---|
| `src/lib/ChatScreens/` | Chat viewport, composer, paged message list, message bubbles, parsed message bodies, backgrounds, inlay/emotion display, suggestions, and partial editing. |
| `src/lib/SideBars/` | Desktop character rail, active-character chat/config panels, binding controls, quick settings, and developer tools. |
| `src/lib/SideBars/LoreBook/` | Character/global/chat lorebook tabs, sortable entry/folder lists, and individual lore entry editors. |
| `src/lib/SideBars/Scripts/` | Regex editor and V1/V2/Lua trigger editors. `TriggerV2List.svelte` is a particularly large self-contained visual editor. |
| `src/lib/Setting/` | Settings navigation, declarative setting renderer, preset/persona manager overlays, and legacy setting-specific components. |
| `src/lib/Setting/Pages/` | Top-level settings pages. Subdirectories group advanced, display, language, model, module, prompt-preset, and sound-specific editors. |
| `src/lib/Setting/Wrappers/` | Components implementing declarative setting item types such as check, slider, select, accordion, and custom content. |
| `src/lib/UI/` | Shared application widgets and feature-level UI such as the home menu, model pickers, title, popup lists, and Realm integration. |
| `src/lib/UI/GUI/` | Main control library: older inputs plus newer `Sh*` dialogs, buttons, toggles, dropdowns, toasters, settings layout primitives, schema forms, and portal helpers. |
| `src/lib/UI/NewGUI/` | A separate experimental/legacy-new button implementation; currently only one component and not the main shared-control family. |
| `src/lib/UI/Realm/` | RisuRealm catalog, cards, license display, and character detail/download popup. |
| `src/lib/Mobile/` | Dedicated mobile header/body/footer shell and mobile character list. |
| `src/lib/LiteUI/` | Lite-build-specific Realm card presentation; currently only `LiteCardIcon.svelte`. |
| `src/lib/Playground/` | Store-indexed developer/user tools for tokenizer, parser, embeddings, Jinja, MCP, image processing, subtitles, translation, CBS docs, and conversions. |
| `src/lib/Others/` | Cross-cutting overlays and utilities: alerts, import/catalog views, chat/bookmark lists, update/loading/backup dialogs, the asset viewer, Monaco, popup editor, and HypaV3 UI. |
| `src/lib/_dev/` | Opt-in developer diagnostics and production modal/control test panel. |
| `src/lib/utils.ts` | Shared Tailwind class merging and Svelte component utility types (`cn` at `src/lib/utils.ts:4`). |
| `src/styles/` and `src/styles.css` | Global tokens, layout/theme rules, node-only chat styling, and compatibility selectors consumed by Svelte components and plugins. |

## 2. Key files

### Mount, state, routing, and GUI infrastructure

| File | Role and important symbols |
|---|---|
| `index.html` | Supplies `#app`, the pre-Svelte loading screen, global styles, manifest, and module entry (`index.html:20`, `index.html:28`, `index.html:39`). |
| `src/main.ts` | Imports polyfills/storage side effects, mounts `App`, starts `loadData()` and `initHotkey()`, then removes the static loader (`src/main.ts:1`, `src/main.ts:16`, `src/main.ts:20`). |
| `src/App.svelte` | Root screen switch and permanent overlay host. Precedence is April 1 gate → loading → settings → dedicated mobile shell → desktop grid or sidebar/chat; global overlays, persistence/loading feedback, the boot-backup prompt, asset viewer, and response-status toasters remain mounted afterward. |
| `src/ts/stores.svelte.ts` | Central writable/rune state. `updateSize()` drives `SizeStore` and the 1024px `DynamicGUI` breakpoint (`src/ts/stores.svelte.ts:11`); major navigation stores are declared at `src/ts/stores.svelte.ts:24` and `src/ts/stores.svelte.ts:55`; `DBState` is the global database rune at `src/ts/stores.svelte.ts:144`. |
| `src/ts/routing.ts` | Named settings-route facade over numeric `SettingsMenuIndex`. Exports `SettingsRoute` (`src/ts/routing.ts:16`), `SystemTab` (`src/ts/routing.ts:44`), `AccessibilityTab` (`src/ts/routing.ts:55`), and `openSettings()` (`src/ts/routing.ts:69`). |
| `src/ts/hotkey.ts` | Installs the global keyboard dispatcher in `initHotkey()` (`src/ts/hotkey.ts:14`), maps configured actions to store changes or stable DOM hooks, exposes `quickMenu()` and `hotkeyMatches()`, and installs mobile swipe navigation through `initMobileGesture()`. Model selection and request-log actions open their current overlays/settings routes; prompt-preview cleanup always releases generation state. |
| `src/ts/alert.ts` | Imperative modal/toast API. Defines `alertData`, normalizes errors, provides blocking helpers such as `alertConfirm()`, `alertConfirmMulti()`, and `alertInput()`, and exposes non-blocking `notify*` helpers. `alertConfirmMulti(prompt, actions, detail?)` renders the optional multiline detail below its title and returns an action index or `-1`. |
| `src/ts/gui/colorscheme.ts` | Built-in theme definitions and CSS-variable application. `ColorScheme` is at `src/ts/gui/colorscheme.ts:9`; `changeColorScheme()` at `src/ts/gui/colorscheme.ts:280`; `updateColorScheme()` at `src/ts/gui/colorscheme.ts:291`; text theme, font, and custom CSS application at `src/ts/gui/colorscheme.ts:378`. |
| `src/ts/gui/guisize.ts` | Publishes textarea/sidebar sizing stores and writes `--sidebar-size` in `updateGuisize()` (`src/ts/gui/guisize.ts:4`, `src/ts/gui/guisize.ts:8`). |
| `src/ts/gui/animation.ts` | Writes the database animation duration to `--risu-animation-speed` (`src/ts/gui/animation.ts:3`). |
| `src/ts/gui/highlight.ts` | CSS Highlight API support for CBS/decorator syntax. Public entry points are `highlighter()` (`src/ts/gui/highlight.ts:9`), `getNewHighlightId()` (`src/ts/gui/highlight.ts:119`), and `removeHighlight()` (`src/ts/gui/highlight.ts:123`). |
| `src/ts/gui/branches.ts` | Builds a hashed tree of chat histories for the branch-view alert. `getChatBranches()` is at `src/ts/gui/branches.ts:69`. |
| `src/ts/gui/deepTouch.svelte.ts` | Traverses rune proxies to establish deep reactive dependencies without cloning; exported `deepTouch()` is at `src/ts/gui/deepTouch.svelte.ts:38`. |
| `src/ts/gui/tooltip.ts` | Tippy Svelte actions `tooltip()` and `tooltipRight()` (`src/ts/gui/tooltip.ts:5`, `src/ts/gui/tooltip.ts:22`). |
| `src/ts/gui/longtouch.ts` | Mouse-based 500ms `longpress` action (`src/ts/gui/longtouch.ts:1`). |
| `src/ts/viewportHeight.ts` | `installDynamicViewportHeight()` follows `visualViewport.height` during mobile browser-chrome animation while deliberately ignoring keyboard and pinch-zoom resizes. |
| `src/ts/storage/writerTakeover.ts` | Single-writer loss UI. `enterWriterTakeoverFlow()` offers reload or a permanently frozen read-only projection; `checkWriterTakeoverOnReturn()` performs the foreground stale-writer check. |
| `src/ts/assetViewer.svelte.ts` | Rune-backed asset-viewer state and `openAssetViewer()`/`closeAssetViewer()` helpers for character and module image assets. |

### Chat and desktop navigation

| File | Role and important symbols |
|---|---|
| `src/lib/ChatScreens/ChatScreen.svelte` | Theme/layout adapter around the main chat screen. It selects waifu, waifu-mobile, or normal layouts and always delegates conversation UI to `DefaultChatScreen` (`src/lib/ChatScreens/ChatScreen.svelte:42`, `src/lib/ChatScreens/ChatScreen.svelte:57`, `src/lib/ChatScreens/ChatScreen.svelte:75`). |
| `src/lib/ChatScreens/DefaultChatScreen.svelte` | Main conversation controller: home/playground fallback, composer/drafts, captured-target hydration in `ensureChatTargetReady()`, per-chat generation/abort state, interrupted-send resumption, rerolls/swipes, paging, plugin panels, and initial greeting. `sendMain()` and `sendChatMain()` own the UI edges of a send. |
| `src/lib/ChatScreens/Chats.svelte` | Performance-oriented message-list renderer. `updateChatBody()` manually `mount()`s and hash-reconciles `Chat` components. During optimized streaming it keeps the active message mounted and calls `Chat.updateStreamingDisplay()` instead of remounting on every response snapshot. |
| `src/lib/ChatScreens/Chat.svelte` | One message bubble/card, including edit/delete/bookmark/reroll/translation/TTS/branch controls and multiple visual themes. Message deletion is handled by `rm()` (`src/lib/ChatScreens/Chat.svelte:87`), display preprocessing by `displaya()` (`src/lib/ChatScreens/Chat.svelte:173`), and body delegation occurs at `src/lib/ChatScreens/Chat.svelte:422`. |
| `src/lib/ChatScreens/ChatBody.svelte` | Asynchronously converts a message to display HTML via CBS/markdown parsing, translation, module assets, and inlay resolution. Strong streaming optimization temporarily emits escaped raw text; ordinary/balanced rendering goes through `markParsing()` and `{@html}`. |
| `src/lib/ChatScreens/PartialEditController.svelte` | Block/drag-based partial editing overlay attached from each message body when enabled (`src/lib/ChatScreens/Chat.svelte:437`). |
| `src/lib/SideBars/Sidebar.svelte` | Desktop character rail and secondary panel. It builds ordered character/folder rows (`src/lib/SideBars/Sidebar.svelte:102`), handles selection and drag reordering, exposes hamburger/plugin actions (`src/lib/SideBars/Sidebar.svelte:603`), and selects recent chats, quick settings, developer tools, character config, or chat list at `src/lib/SideBars/Sidebar.svelte:1049`. |
| `src/lib/SideBars/CharConfig.svelte` | Active-character editor. Desktop tab buttons are at `src/lib/SideBars/CharConfig.svelte:227`; lorebook is rendered at `src/lib/SideBars/CharConfig.svelte:583`; regex and trigger script panels at `src/lib/SideBars/CharConfig.svelte:588`. |
| `src/lib/SideBars/SideChatList.svelte` | Active character’s chat/session list and chat-management actions; mounted by desktop Sidebar at `src/lib/SideBars/Sidebar.svelte:1097` and `src/lib/SideBars/Sidebar.svelte:1124`, and by mobile at `src/lib/Mobile/MobileBody.svelte:39`. |
| `src/lib/SideBars/LoreBook/LoreBookSetting.svelte` | Chooses character-global, chat-local, or settings lore views and provides add/import/export/folder actions (`src/lib/SideBars/LoreBook/LoreBookSetting.svelte:13`, `src/lib/SideBars/LoreBook/LoreBookSetting.svelte:112`). |
| `src/lib/SideBars/LoreBook/LoreBookList.svelte` | Sortable lore entry/folder list. Its data source varies by global mode/submenu (`src/lib/SideBars/LoreBook/LoreBookList.svelte:44`), and SortableJS setup begins at `src/lib/SideBars/LoreBook/LoreBookList.svelte:113`. |
| `src/lib/SideBars/Scripts/TriggerList.svelte` | Format switch for deprecated V1, V2, and Lua triggers (`src/lib/SideBars/Scripts/TriggerList.svelte:18`, `src/lib/SideBars/Scripts/TriggerList.svelte:23`); V1 is lazy-loaded at `src/lib/SideBars/Scripts/TriggerList.svelte:20`. |
| `src/lib/SideBars/Scripts/TriggerV2List.svelte` | Full V2 trigger program editor and the largest UI component in this subsystem. Changes here have unusually broad script-format compatibility risk. |

### Settings, mobile, shared UI, and overlays

| File | Role and important symbols |
|---|---|
| `src/lib/Setting/Settings.svelte` | Settings navigation and page switch. Menu entries mutate numeric `SettingsMenuIndex`; page rendering is the main branch near the bottom; mobile/narrow back behavior returns to the menu. The former built-in Remote Access settings page/route has been removed; remote setup is documented externally. |
| `src/lib/Setting/SettingsSearch.svelte` | Modal settings search. It builds the same live model-aware `SettingContext` as `SettingRenderer`, calls `searchSettings()`, and navigates to the first result on Enter. |
| `src/ts/setting/searchIndex.ts` and `searchManifestData.ts` | Search index and navigation map. Declarative `SettingItem[]` sources are indexed at item level; hardcoded pages/subtabs use manifest entries. `navigateToSearchResult()` opens the route, switches a registered submenu store, and retries scrolling to the item anchor. |
| `src/lib/Setting/SettingRenderer.svelte` | Renders declarative `SettingItem[]`, builds model-aware `SettingContext`, evaluates conditions, and dispatches through `settingRegistry` (`src/lib/Setting/SettingRenderer.svelte:22`, `src/lib/Setting/SettingRenderer.svelte:29`, `src/lib/Setting/SettingRenderer.svelte:37`). |
| `src/lib/Setting/Pages/DisplaySettings.svelte` | Representative declarative settings page: theme, size/speed, and grouped “other” tabs are built from setting-data arrays (`src/lib/Setting/Pages/DisplaySettings.svelte:27`, `src/lib/Setting/Pages/DisplaySettings.svelte:36`). |
| `src/lib/Setting/Pages/BotSettings.svelte` | Main model/parameter/custom-model settings page, mixing direct controls with declarative parameter items. Its page tabs begin at `src/lib/Setting/Pages/BotSettings.svelte:116`. |
| `src/lib/Setting/Pages/Model/ModelPresetSettings.svelte` | Model preset list/editor, profile registry synchronization, credentials, schema-driven fields, capabilities, request testing, and the Modules tab for per-module model-preset binding. |
| `src/lib/Setting/Pages/Model/ModuleModelBindingList.svelte` | Lists every installed module and edits `moduleModelBindings`; dangling preset IDs remain visible, while rows become non-interactive when module bindings are disabled. |
| `src/lib/Setting/Pages/SystemSettings.svelte` | Six-tab System shell driven by `SystemSubmenuIndex`: Dashboard, Backups, Logs, Request Logs, Usage, and Plugin Storage. The ordinary client/server event log remains inline in this component. |
| `src/lib/Setting/Pages/SystemDashboard.svelte` | Storage viewer/dashboard: server/database/filesystem breakdowns, browser resource-cache status, SQLite durability and maintenance, per-character/module measurement, and backup summaries. |
| `src/lib/Setting/Pages/SystemBackup.svelte` | Unified backup screen for server backups, automatic snapshots and retention limits, per-chat recovery copies, and local backup download/restore. It also owns backup-path, disk-space, and boot-reminder controls when not hub-hosted. |
| `src/lib/Setting/Pages/RequestLogs.svelte` | Paged request-log viewer with category/source/result filters, loaded-page search, lazy body/detail fetch, retention usage, and capture toggles. It replaces the former alert-based request viewer. |
| `src/lib/Setting/Pages/UsageStats.svelte` | LLM request/token summaries over 7/30/90-day or all-time windows, with source filters and daily/model/source breakdowns. |
| `src/lib/Setting/Pages/PluginStorageViewer.svelte` | Paged flat-key viewer for save, localStorage, and IndexedDB plugin backends. Save-backend edits/deletes are revision-guarded; stale or outcome-unknown mutations reload authoritative state. |
| `src/lib/Setting/Pages/PluginSettings.svelte` | Plugin lifecycle/permission editor plus plugin-storage controls. Mode transitions use cancellable progress UI; boot reconciliation failures expose retry and redacted diagnostic-copy actions. Value auto-conversion is independent of the storage-mode toggle. |
| `src/lib/Setting/ChatBackupList.svelte` | Expands server-captured chat histories, resolves live/deleted character and chat labels, fetches a selected version, chooses a target character, and imports it as a new chat through the storage subsystem. |
| `src/lib/Setting/Pages/Advanced/ResourceCacheSettings.svelte` | Toggles the opt-in verified IndexedDB resource cache and shows current entry/byte usage when supported. |
| `src/lib/UI/GUI/SettingPage.svelte` | Standard page title/body wrapper (`src/lib/UI/GUI/SettingPage.svelte:13`). |
| `src/lib/UI/GUI/SettingTabs.svelte` | Bindable numeric tab row used by settings pages (`src/lib/UI/GUI/SettingTabs.svelte:7`, `src/lib/UI/GUI/SettingTabs.svelte:16`). |
| `src/lib/UI/GUI/ShDialog.svelte` | Main `bits-ui` dialog wrapper, with explicit size and z-index tiers (`src/lib/UI/GUI/ShDialog.svelte:4`, `src/lib/UI/GUI/ShDialog.svelte:40`, `src/lib/UI/GUI/ShDialog.svelte:64`). |
| `src/lib/UI/MainMenu.svelte` | Desktop no-character home screen, including version/build identity, update/state information, recent Realm cards, related links, and Realm navigation. Non-empty `__APP_BRANCH__` produces a custom-build badge whose tooltip includes `__APP_COMMIT__`; Vite gets these from `APP_BRANCH`/`APP_COMMIT` or local Git. |
| `src/lib/UI/Realm/RealmMain.svelte` | Searchable/paged Realm catalog. `getHub()` is at `src/lib/UI/Realm/RealmMain.svelte:21`; mobile/desktop filter layouts diverge at `src/lib/UI/Realm/RealmMain.svelte:76`. |
| `src/lib/Others/AssetViewer.svelte` | Full-screen searchable image-asset grid. Zoom mode is a horizontal scroll-snap track with swipe/arrow/keyboard navigation and mounts only the current and adjacent images. |
| `src/lib/Others/BootBackupPrompt.svelte` | Global boot-time backup reminder. It shows size/free-space estimates, prevents proceeding when space is insufficient, and resolves bootstrap's `bootBackupPromptStore` decision. |
| `src/lib/Mobile/MobileBody.svelte` | Mobile screen switch: active-chat side panels, chat screen, Realm, characters, or settings (`src/lib/Mobile/MobileBody.svelte:17`, `src/lib/Mobile/MobileBody.svelte:37`). |
| `src/lib/Mobile/MobileHeader.svelte` | Contextual back/menu/search header; settings back resets `SettingsMenuIndex` to `SettingsRoute.None` (`src/lib/Mobile/MobileHeader.svelte:11`, `src/lib/Mobile/MobileHeader.svelte:32`). |
| `src/lib/Mobile/MobileFooter.svelte` | Bottom navigation for Realm/characters/settings plus character-config sub-tabs (`src/lib/Mobile/MobileFooter.svelte:8`, `src/lib/Mobile/MobileFooter.svelte:33`). |
| `src/lib/Playground/PlaygroundMenu.svelte` | Numeric `PlaygroundStore` menu and tool dispatcher; special chat creation is in `playgroundChat()` (`src/lib/Playground/PlaygroundMenu.svelte:26`), tool routing at `src/lib/Playground/PlaygroundMenu.svelte:153`. |
| `src/lib/Others/AlertComp.svelte` | Singleton consumer for `alertStore`, special legacy overlays, modern `Sh*` alerts, generation details, branch view, exports, and toggle presets. Store reset logic is near the top; modern dialog branches begin with error/normal/Markdown alerts. |
| `src/lib/_dev/DevPanel.svelte` | Opt-in end-to-end test surface for alerts, notifications, update UI, and shared controls. It is gated by `localStorage['risu-dev-panel']='1'` in Settings (`src/lib/Setting/Settings.svelte:32`) and can disable itself at `src/lib/_dev/DevPanel.svelte:52`. |

## 3. Architecture & data flow

### Root mount and screen selection

1. `index.html` creates the DOM mount and static loader, then imports `src/main.ts` (`index.html:20`, `index.html:29`, `index.html:39`).
2. `main.ts` runs `preLoadCheck()`, mounts `App`, starts asynchronous data bootstrapping, installs hotkeys, and removes the static loader (`src/main.ts:16`).
3. `App.svelte` remains mounted before database loading completes. On April 1 its local novelty gate precedes the loader; otherwise `$loadedStore` gates usable UI and displays `LoadingStatusState.text` until bootstrap finishes.
4. After loading, `settingsOpen` has first routing priority. Otherwise `MobileGUI` selects the dedicated mobile shell. Desktop mode can show `GridChars`; the normal branch renders a `Sidebar` plus `ChatScreen`, with `DynamicGUI` deciding whether the sidebar is inline or an overlay.
5. Modal hosts, preset selectors, save/loading/update/backup overlays, plugin alerts, the asset viewer, popup editor, and response/toast hosts remain outside that screen branch, so they survive screen transitions.

There is no general URL router in this subsystem. Character selection, home/playground selection, settings, Realm, mobile tabs, sidebar visibility, and modal visibility are all encoded in stores such as `selectedCharID`, `PlaygroundStore`, `settingsOpen`, `SettingsMenuIndex`, `OpenRealmStore`, `MobileGUIStack`, and `MobileSideBar` (`src/ts/stores.svelte.ts:28`, `src/ts/stores.svelte.ts:35`, `src/ts/stores.svelte.ts:56`, `src/ts/stores.svelte.ts:58`, `src/ts/stores.svelte.ts:82`, `src/ts/stores.svelte.ts:84`).

### Chat rendering and send flow

1. `ChatScreen` selects the outer visual theme and supplies backgrounds/emotion/inlay areas, then mounts `DefaultChatScreen` (`src/lib/ChatScreens/ChatScreen.svelte:42`).
2. With no selected character, `DefaultChatScreen` renders `MainMenu` or lazy-loads `PlaygroundMenu`; with a character, it derives the current chat directly from `DBState.db` (`src/lib/ChatScreens/DefaultChatScreen.svelte:78`, `src/lib/ChatScreens/DefaultChatScreen.svelte:881`).
3. Composer drafts are keyed by character/chat IDs and loaded, debounced, flushed on chat changes, and checkpointed on page hide (`src/lib/ChatScreens/DefaultChatScreen.svelte:84`, `src/lib/ChatScreens/DefaultChatScreen.svelte:98`, `src/lib/ChatScreens/DefaultChatScreen.svelte:129`, `src/lib/ChatScreens/DefaultChatScreen.svelte:140`).
4. `sendMain()` captures a stable character/chat target, hydrates it through `ensureChatTargetReady()`, processes slash commands, attachments, input hooks, and scripts, appends the user message, clears the draft, and calls `sendChatMain()` (`src/lib/ChatScreens/DefaultChatScreen.svelte:358`).
5. `sendChatMain()` rejects a duplicate per-chat generation, registers its abort controller, invokes `sendChat()`, and always releases generation/pending-send state. A writer-loss event aborts the local controller.
6. Discovery can mark an interrupted request resumable. Opening that chat revalidates its user-message tail and atomically claims the pending send before rerunning it; the current draft is left untouched (`resumeInterruptedSend()` in `DefaultChatScreen`).
7. The reversed scroll viewport expands `loadPages` near older content, contains vertical overscroll, and renders normal messages through `Chats` while the initial greeting uses a direct `Chat`.
8. `Chats.updateChatBody()` hashes rendering-relevant fields and manually mounts or removes `Chat` instances. For the active optimized streaming message, the text is excluded from the hash and pushed through `updateStreamingDisplay()` instead.
9. `Chat` owns bubble structure/actions and display substitutions, then delegates to
   `ChatBody`. Strong optimization shows escaped, whitespace-preserving raw stream text
   while no translation view is active; balanced/off modes use `markParsing()` for
   Markdown, translation/cache behavior, assets, inlays, and metadata.

Thus, the chat log is coordinated by `DefaultChatScreen`, physically populated by `Chats`, and each visible message bubble is `Chat`; `ChatBody` supplies the parsed contents inside that bubble.

### Settings organization

`Settings.svelte` is both menu and router. Each menu button assigns a numeric `SettingsMenuIndex`, and a parallel `if/else` chain mounts the corresponding page (`src/lib/Setting/Settings.svelte:52`, `src/lib/Setting/Settings.svelte:249`). `src/ts/routing.ts` adds stable names and `openSettings()` for external callers, but explicitly treats `Settings.svelte` as the source of truth (`src/ts/routing.ts:3`, `src/ts/routing.ts:9`).

Settings pages use two styles:

- Large or specialized pages directly compose controls and feature components, as in `BotSettings`, `OtherBotSettings`, `ModelPresetSettings`, and `SystemSettings`.
- Repetitive pages define `SettingItem[]` in `src/ts/setting/*SettingsData*` and pass them to `SettingRenderer`. It evaluates conditions, looks up a wrapper by item type, and renders it (`src/lib/Setting/SettingRenderer.svelte:38`). The wrapper mapping is centralized in `src/ts/setting/settingRegistry.ts:19`, while custom item implementations are registered through `src/ts/setting/customComponents.ts`.

Tabbed pages generally use `SettingTabs`. Search/deep-linkable tab state is global:
`SystemSubmenuIndex`, `AccessibilitySubmenuIndex`, `DisplaySubmenuIndex`,
`BotSubmenuIndex`, `PromptPresetSubmenuIndex`, `OtherBotsSubmenuIndex`,
`InlayGallerySubmenuIndex`, and `ModelPresetListTabIndex` live together in
`src/ts/stores.svelte.ts`. Other editor-internal subtabs can remain page-local.

The sidebar search trigger opens `SettingsSearch`, which rebuilds a small live index for
each query. `searchIndex.ts` combines registered declarative arrays with
`searchManifestData.ts`, excludes currently hidden conditional items, also matches English
labels/help for non-English UIs, and caps the result list. Selection opens the named route,
sets the relevant submenu store, then retries scrolling to the `data-setting-id` anchor.

### System operations and recovery surfaces

`SystemSettings` owns six store-backed subtabs. `SystemDashboard` is the storage viewer and
maintenance surface; `SystemBackup` is the single home for server backups, snapshots,
chat-recovery copies, and local backups. `RequestLogs` pages through metadata and fetches
large bodies only when expanded, while `UsageStats` aggregates LLM token data. The Plugin
Storage viewer switches among save/local/IDB backends and treats conflicts or unknown
mutation outcomes as reread conditions.

The dashboard gives externalized optimized-plugin values, owner metadata, and their
publication manifest a dedicated Plugin data slice. Its byte reconciliation keeps KV-row
markers separate from chunk bodies; only genuinely unrecognized KV rows remain in Other
data.

Plugin storage mode and value conversion are configured in `PluginSettings`, not in the
viewer. A mode transition waits for plugin lifecycle idle, exposes cancel/progress state,
and handles large inline transitions explicitly. If boot reconciliation leaves diagnostic
issues, the page offers retry and a redacted diagnostic copy rather than displaying raw
plugin keys or values.

### Desktop, responsive overlay, and mobile layouts

There are two separate responsive concepts:

- `DynamicGUI` is recalculated on every resize at `window.innerWidth <= 1024` and changes
  the desktop sidebar from inline to overlay (`updateSize()` and the `DynamicGUI` branch
  in `App.svelte`).
- `MobileGUI` selects the entirely different header/body/footer shell. `loadData()` sets
  it only when `betaMobileGUI` is enabled at width `<= 800`, or for the Lite build.

Within mobile mode, `MobileGUIStack` chooses Realm, characters, or settings when no character is selected. An active character normally shows `ChatScreen`; `MobileSideBar` replaces it with chat list, character config, or developer tools (`src/lib/Mobile/MobileBody.svelte:37`). The footer supplies the top-level and character-config tabs (`src/lib/Mobile/MobileFooter.svelte:8`, `src/lib/Mobile/MobileFooter.svelte:33`).

Mobile browser sizing is independent of both routing concepts. `styles.css` defaults
`--risu-height-size` to `100dvh` where supported, and
`installDynamicViewportHeight()` follows intermediate `visualViewport` resize steps when
no explicit height mode is selected. It ignores editable-focus keyboard resizes and
pinch-zoom. The chat scroller contains overscroll and hides its scrollbar on coarse
pointers; NodeOnly Standard also matches the body backdrop during browser-chrome motion.

### Theme and sizing flow

Bootstrap calls `updateColorScheme()`, `updateTextThemeAndCSS()`, `updateAnimationSpeed()`, `updateHeightMode()`, and `updateGuisize()` after the database is normalized. These functions translate database settings into root CSS variables:

- Palette colors and dark/light classification: `src/ts/gui/colorscheme.ts:305`.
- Markdown/text emphasis colors, font family, and custom CSS: `src/ts/gui/colorscheme.ts:378`.
- Sidebar width: `src/ts/gui/guisize.ts:17`.
- Animation duration: `src/ts/gui/animation.ts:3`.
- Root height: `updateHeightMode()` in `src/ts/bootstrap.ts`, with the dynamic-viewport helper used only for normal/unset mode.

Display-setting data attaches these updater functions as `onChange` callbacks, so changing a stored setting alone is not always sufficient; imperative CSS synchronization may also be required. `ColorSchemeTypeStore` is consumed by message prose styling in `Chat.svelte`.

### Alerts, dialogs, and toasts

Blocking helpers write a discriminated `alertData` object to the singleton `alertStore`, then asynchronous helpers poll `waitAlert()` until the renderer changes its type to `none` (`src/ts/alert.ts:122`). The selected value is returned through the same object’s `msg` field, as demonstrated by `alertSelect()` and `alertConfirm()` (`src/ts/alert.ts:166`, `src/ts/alert.ts:280`).

`AlertComp` is permanently mounted by `App`. It contains older special-purpose full-screen branches plus newer `ShDialog`, `ShAlertDialog`, and `ShLoadingDialog` branches (`src/lib/Others/AlertComp.svelte:206`, `src/lib/Others/AlertComp.svelte:781`). Non-blocking `notify*` calls use `svelte-sonner`; errors, warnings, and informational notifications also feed the logging subsystem (`src/ts/alert.ts:197`).

`alertConfirmMulti()` keeps its prompt short as the dialog title, accepts typed action
descriptors, preserves optional multiline detail in the description, and supplies its own
Cancel action. Escape, outside close, or Cancel resolves to `-1`; an action resolves to its
zero-based index.

The toggle-preset chooser intentionally uses `togglePresetsOpenStore`, not the singleton alert store, so a nested confirmation/input can layer over it (`src/ts/alert.ts:412`). Dialog tiering (`base`, `alert`, `top`) provides the matching z-index contract (`src/lib/UI/GUI/ShDialog.svelte:4`).

### Writer-takeover recovery UI

A mutation-time 423 or a stale foreground writer check enters
`enterWriterTakeoverFlow()`. The dialog offers reload or staying on the current in-memory
projection. Staying does not reclaim authority: `enterFrozenOfflineState()` makes text
controls read-only, disables contenteditable, captures mutation-oriented pointer/keyboard
events, observes later DOM additions, and installs a persistent reload banner. Safe
selection/copy/find and navigation keys remain available. The latch is permanent until a
full reload so stale state is never replayed over the new writer.

## 4. Entry points & dependencies

### Calls into the UI layer

- `src/main.ts` mounts the entire UI through `App` (`src/main.ts:17`).
- Character and import logic changes `selectedCharID`, `OpenRealmStore`, or settings routes; `App`, `Sidebar`, and `DefaultChatScreen` react to those stores.
- `src/ts/characterCards.ts`, preset managers, model bindings, migration UI, and module UI call `openSettings()` to deep-link into settings.
- The processing, storage, plugin, update, and bootstrap subsystems call exported `alert*`, `notify*`, theme, sizing, and overlay stores.
- Storage fencing calls `enterWriterTakeoverFlow()` and foreground checks call
  `checkWriterTakeoverOnReturn()`; asset-management UI calls `openAssetViewer()`.
- Plugin API V3 populates `additionalSettingsMenu`, `additionalHamburgerMenu`,
  `additionalChatMenu`, `additionalFloatingActionButtons`, and `chatPanelStore` in
  `stores.svelte.ts`. Their UI consumers are `Settings`, `Sidebar`, and
  `DefaultChatScreen`.

### Calls out of the UI layer

- Chat UI calls storage hydration/draft APIs, `sendChat()`, scripts, triggers, commands, translation, TTS, inlay files, notification sound, and character helpers.
- Settings bind to `DBState.db` and call model registries, provider discovery,
  backup/log/usage APIs, plugin APIs, storage-maintenance endpoints, declarative setting
  definitions, and the settings search index.
- Realm UI calls `getRisuHub()`/`downloadRisuHub()` and character import APIs.
- Sidebar and lore/script editors call character ordering, asset storage, SortableJS, lorebook import/export, regex import/export, and module application.
- Shared UI libraries include `@lucide/svelte`, `bits-ui`, `svelte-sonner`, `tippy.js`, `sortablejs`, `highlight.js`, `clsx`, and `tailwind-merge`.
- Parsed message and plugin panel HTML is emitted with `{@html}` after upstream parsing
  or plugin construction in `ChatBody` and `DefaultChatScreen`.

## 5. Conventions & gotchas

- Svelte 5 runes and classic Svelte stores coexist. Use direct rune access for `DBState`/`$state` objects, but `$store` syntax or `.set()`/`.update()` for `writable` stores. `stores.svelte.ts` must retain its `.svelte.ts` form because it contains runes.
- `DBState.db` is the canonical live data model, not a disposable UI copy (`src/ts/stores.svelte.ts:144`). Most inputs bind directly into it; replacing or cloning subobjects casually can interfere with references and persistence tracking.
- Persistence effects depend on deep reactive reads. `deepTouch()` is deliberately used instead of `$state.snapshot()` to avoid cloning large characters/modules (`src/ts/gui/deepTouch.svelte.ts:1`). Adding non-plain objects to persisted data can force the slower snapshot fallback.
- General navigation is not represented in the browser URL. Adding a screen normally requires a store value and a render branch, not a route configuration.
- Settings route numbers are an internal cross-file coordination surface, not persisted
  user data. Adding or reordering a page requires synchronized menu/render/deep-link
  changes in `Settings.svelte` and `routing.ts`, plus a search-manifest entry when the
  page or its controls should be discoverable. Existing gaps can reflect hidden or
  removed pages rather than a stable external protocol.
- Narrow settings use `SettingsMenuIndex === -1` as the menu/list state. Closing a page under 700px returns to that state rather than closing settings (`src/lib/Setting/Settings.svelte:299`).
- `DynamicGUI` and `MobileGUI` are not synonyms. The former changes sidebar presentation at 1024px on resize; the latter is a boot-selected alternate application shell.
- `Settings.svelte` also uses direct `window.innerWidth` thresholds of 700 and 900 (`src/lib/Setting/Settings.svelte:39`, `src/lib/Setting/Settings.svelte:46`). These are separate from both global responsive stores.
- The message list is not a normal `{#each}`. `Chats.svelte` manually mounts `Chat` and
  normally remounts only when its rendering hash changes. If a newly relevant message
  field is added, include it in the hash or bump `ReloadChatPointer`; preserve the active
  streaming-message exception that updates text through `updateStreamingDisplay()`.
- Both the chat viewport and message list use reversed flex ordering (`src/lib/ChatScreens/DefaultChatScreen.svelte:1189`, `src/lib/ChatScreens/Chats.svelte:232`). Scroll calculations that look inverted are usually intentional.
- Placeholder chats must be hydrated before mutation. Capture a `ChatSendTarget` and use
  `DefaultChatScreen.ensureChatTargetReady()` so a selection change cannot redirect a
  send into a different chat.
- Save/loading indicators are not cosmetic: writer displacement, uncertain save outcomes, boot snapshot recovery, partial backup jobs, and plugin-storage reconciliation all have dedicated UI states. Preserve the distinction between retryable work, an unknown outcome requiring reread, and lost writer authority.
- The writer-takeover “stay” path is intentionally irreversible without reload. Do not
  add a retry-write action to the frozen projection or let later DOM additions escape its
  read-only guards.
- The composer contains the non-Tailwind class `plugin-compat-items-stretch`; plugins use it as a DOM anchor, so it must not be renamed during visual cleanup (`src/lib/ChatScreens/DefaultChatScreen.svelte:900`).
- Global hotkeys deliberately depend on stable CSS hooks such as `.button-icon-reroll`, `.button-icon-edit`, `.text-input-area`, and `.button-icon-send` (`src/ts/hotkey.ts:34`). Renaming those classes silently breaks configured hotkeys.
- Escape handling checks both the legacy alert singleton and open ARIA dialogs to avoid closing a settings drawer behind a modal (`src/ts/hotkey.ts:179`).
- Character-cycling hotkeys have boundary semantics: previous stops at the first entry,
  while next from no selection chooses the first. Prompt preview must clear its
  non-closable wait and generation state even when request construction throws.
- App-level file drop ignores `RISU_APP_INTERNAL_DRAG_TYPE` and
  `RISU_SIDEBAR_DRAG_TYPE`. New internal reorder gestures need a typed marker so they do
  not fall through to character/file import.
- Only one ordinary `alertStore` modal can exist at once. Starting another blocking alert overwrites the first. Use a separate store plus dialog tiering when nested modal interaction is required, following toggle presets.
- `doingAlert()` intentionally treats `wait` as non-blocking for some global interaction checks (`src/ts/alert.ts:193`).
- Notify calls clear only transitional wait/progress alerts, not input/confirm dialogs (`src/ts/alert.ts:202`). This preserves active user decisions.
- `ShDialog` defaults to ignoring Escape but allowing outside click (`src/lib/UI/GUI/ShDialog.svelte:40`). Callers must explicitly choose close behavior; do not assume browser-dialog defaults.
- `alertConfirmMulti()`'s third argument is body/detail text, not another action. It is
  rendered with preserved whitespace; all non-action closes resolve to `-1`.
- Legacy controls (`Button.svelte`, `TextInput.svelte`, etc.) and newer `Sh*` controls coexist. Follow the component family already used by the surrounding page; dialogs and newer settings work generally favor `Sh*`.
- Dialog stacking tiers are contractual: base `z-40`, ordinary alerts `z-50`, exceptional top overlays `z-[60]` (`src/lib/UI/GUI/ShDialog.svelte:64`).
- `ColorScheme.primary` was added after older export formats. Import/update paths intentionally backfill it (`src/ts/gui/colorscheme.ts:315`, `src/ts/gui/colorscheme.ts:361`).
- Lite mode forces the built-in lite palette and standard text theme regardless of stored choices (`src/ts/gui/colorscheme.ts:301`, `src/ts/gui/colorscheme.ts:384`).
- Safe mode suppresses user custom CSS by setting `CustomCSSStore` to an empty string (`src/ts/gui/colorscheme.ts:450`). `CustomCSSStore` injects a `#customcss` style node into the document (`src/ts/stores.svelte.ts:109`).
- Theme value `''` means PocketRisu’s NodeOnly Standard chat layout. Legacy database theme `"custom"` is normalized to `''`, while `"customHTML"` remains a distinct custom bubble renderer (`src/ts/storage/database.svelte.ts:28`, `src/lib/ChatScreens/Chat.svelte:1094`, `src/lib/ChatScreens/Chat.svelte:1203`).
- Explicit height modes override dynamic viewport tracking. The helper deliberately
  rejects virtual-keyboard and zoom resizes; changing those guards can make the whole app
  jump while editing or pinching.
- Custom chat GUI HTML is not mounted as arbitrary Svelte. `Chat.renderGuiHtmlPart()` recursively maps a fixed set of tags and special `RISUTEXTBOX`, `RISUICON`, `RISUBUTTONS`, and `RISUGENINFO` placeholders (`src/lib/ChatScreens/Chat.svelte:950`, `src/lib/ChatScreens/Chat.svelte:1059`).
- Lorebook and regex lists let SortableJS mutate the DOM, then reconstruct data/recreate the Sortable instance to return authority to Svelte (`src/lib/SideBars/LoreBook/LoreBookList.svelte:113`, `src/lib/SideBars/Scripts/RegexList.svelte:19`). Directly simplifying this can desynchronize DOM and database order.
- Trigger-format switching is destructive and confirmation-protected. V1/V2/Lua identification depends on sentinel effect types in the first trigger entry (`src/lib/SideBars/Scripts/TriggerList.svelte:18`).
- The Dev Panel is compiled into production but hidden unless a local-storage flag was present at Settings mount time; changing the flag requires reload (`src/lib/Setting/Settings.svelte:32`).
- The home-screen build badge is compile-time metadata, not runtime Git detection. `vite.config.ts` prefers builder-supplied `APP_BRANCH`/`APP_COMMIT`, falls back to `git rev-parse`, and hides the badge when no branch is available. Keep `src/vite-env.d.ts` declarations synchronized with new constants.

## 6. Navigation hints

- To change root screen precedence, edit the loaded-state branch in `src/App.svelte`; to
  add a permanent app-wide overlay or toaster, mount it with the hosts after that branch.
- To add a new global screen state, declare it near the navigation stores in `src/ts/stores.svelte.ts:24` and consume it in `App.svelte` or the relevant shell.
- To change desktop sidebar overlay behavior or breakpoint, start with `updateSize()` in
  `stores.svelte.ts` and the `DynamicGUI` branch in `App.svelte`.
- To change when the dedicated mobile shell is selected, edit the `MobileGUI` condition
  in `loadData()`.
- To add a mobile top-level destination, update `MobileBody`’s switch at `src/lib/Mobile/MobileBody.svelte:47` and the matching footer button at `src/lib/Mobile/MobileFooter.svelte:8`.
- To add a mobile active-character side panel, extend the `MobileSideBar` branches at `src/lib/Mobile/MobileBody.svelte:17` and its header/footer controls at `src/lib/Mobile/MobileHeader.svelte:11`.
- To change the chat outer theme/background/inlay layout, look at `src/lib/ChatScreens/ChatScreen.svelte:42`.
- To change the composer, captured send target, interrupted-send resumption, paging,
  plugin panels, or chat/home switch, start with `sendMain()`, `sendChatMain()`, and
  `resumeInterruptedSend()` in `DefaultChatScreen.svelte`.
- To change which messages are mounted or the streaming fast path, inspect
  `Chats.updateChatBody()`, its render hash, and `Chat.updateStreamingDisplay()`.
- To change message bubble chrome or action buttons, edit `Chat.svelte` and its theme
  branches. To change Markdown/CBS/translation rendering inside a bubble, start with
  `ChatBody.markParsing()`.
- To add a new desktop sidebar/hamburger action, extend the menu around `src/lib/SideBars/Sidebar.svelte:603`; plugin-provided entries use `additionalHamburgerMenu`.
- To add a character-config sidebar tab, add the desktop button around `src/lib/SideBars/CharConfig.svelte:227`, its render branch around `src/lib/SideBars/CharConfig.svelte:258`, and the mobile footer button around `src/lib/Mobile/MobileFooter.svelte:33`.
- To change lorebook tabs or import/export actions, use `src/lib/SideBars/LoreBook/LoreBookSetting.svelte:13`; for ordering/data-source behavior, use `src/lib/SideBars/LoreBook/LoreBookList.svelte:44`.
- To change regex rows, start with `src/lib/SideBars/Scripts/RegexList.svelte:19` and `RegexData.svelte`; to change trigger format selection, use `src/lib/SideBars/Scripts/TriggerList.svelte:23`.
- To add a new top-level settings page, create it under `src/lib/Setting/Pages/`, add its
  menu and render branch in `Settings.svelte`, add the same numeric ID to
  `SettingsRoute`, and register searchable items in `searchIndex.ts` or
  `searchManifestData.ts`.
- To add or deep-link a settings subtab, add its global store to the submenu registry in
  `searchIndex.ts`; `navigateToSearchResult()` must be able to select it before scrolling.
- To change System's operational surfaces, start with `SystemSettings.svelte`, then the
  focused `SystemDashboard`, `SystemBackup`, `RequestLogs`, `UsageStats`, or
  `PluginStorageViewer` component.
- To add an option to an existing declarative settings page, change the corresponding `src/ts/setting/*SettingsData*` array and confirm the item type exists in `src/ts/setting/settingRegistry.ts:19`.
- To add a new declarative setting control type, define the type, add a wrapper under `src/lib/Setting/Wrappers/`, and register it at `src/ts/setting/settingRegistry.ts:19`.
- To add specialized declarative content without a new generic type, follow the custom-component registration imports in `src/ts/setting/customComponents.ts:18`.
- To change palette tokens or add a built-in palette, edit `src/ts/gui/colorscheme.ts:9` and the palette table beginning at `src/ts/gui/colorscheme.ts:123`; application to CSS variables is at `src/ts/gui/colorscheme.ts:291`.
- To change text emphasis colors, font selection, or safe-mode custom CSS, edit `src/ts/gui/colorscheme.ts:378`.
- To change sidebar width choices, edit `src/ts/gui/guisize.ts:8` together with width classes at `src/lib/SideBars/Sidebar.svelte:1005`.
- To change mobile browser-height behavior, edit `installDynamicViewportHeight()` and
  `updateHeightMode()` together with `--risu-height-size` in `styles.css`.
- To add a new blocking modal type, extend `alertData`, add an imperative helper in
  `alert.ts`, and add the matching `AlertComp` branch.
- To add non-blocking feedback, use or extend the `notify*` family at `src/ts/alert.ts:223` and leave rendering to the root `Toaster`.
- To change global keyboard actions, edit the action switch inside `initHotkey()` and the
  configured hotkey definitions in the hotkey/data subsystem.
- To change writer-takeover choice or frozen-page behavior, edit
  `src/ts/storage/writerTakeover.ts`; keep the reload banner and mutation guards aligned.
- To change the full-screen character/module asset browser, edit
  `src/lib/Others/AssetViewer.svelte` and its state facade in
  `src/ts/assetViewer.svelte.ts`.
- To change the home screen, edit `src/lib/UI/MainMenu.svelte:23`; to change the full Realm catalog, edit `src/lib/UI/Realm/RealmMain.svelte:21`.
- To change custom-build identity, update `vite.config.ts` defines, `src/vite-env.d.ts`, and the badge in `MainMenu.svelte` together; hosted archive builds must pass `APP_BRANCH`/`APP_COMMIT` because `.git` may be absent.
- To add a Playground tool, allocate a `PlaygroundStore` value in the menu buttons and matching render branch in `src/lib/Playground/PlaygroundMenu.svelte:53`.

## 7. Related structure docs

- [Client storage](client-storage.md) covers reactive persistence, chat hydration, save outcomes, and writer fencing.
- [Chat pipeline](chat-pipeline.md) covers generation and message parsing behind the chat UI.
- [Presets and profiles](presets-profiles.md) and [model providers](model-providers.md) cover model settings behavior.
- [Scripting and extensions](scripting-extensions.md) and [plugin storage](plugin-storage.md) cover extension UI and storage-viewer semantics.
- `src/styles.css`, `src/styles/nodeonly-standard.css`, `src/styles/`, and Tailwind configuration define the utility/token mapping consumed throughout the component tree.
