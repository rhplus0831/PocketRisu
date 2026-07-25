# ui-layer

> Part of the PocketRisu structure docs — see [STRUCTURE.md](../../STRUCTURE.md) for the top-level map and subsystem index.
> Audited 2026-07-25 against `2e3d4f05`. Line numbers are approximate and drift as code changes; verify with `rg` before relying on them.

## 1. Purpose & overview

The UI layer is a Svelte 5 single-page application whose “routing” is almost entirely reactive-store driven rather than URL driven. `App.svelte` selects among loading, settings, mobile, desktop/sidebar, and chat layouts, while long-lived modal and toast hosts remain mounted above every screen. Most screens bind directly to the reactive `DBState.db` database proxy, so UI edits normally become persistence inputs without an intermediate form model.

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
| `src/lib/Others/` | Cross-cutting overlays and utilities: alerts, import/catalog views, chat/bookmark lists, update/loading/backup dialogs, Monaco, popup editor, and HypaV3 UI. |
| `src/lib/_dev/` | Opt-in developer diagnostics and production modal/control test panel. |
| `src/lib/utils.ts` | Shared Tailwind class merging and Svelte component utility types (`cn` at `src/lib/utils.ts:4`). |

## 2. Key files

### Mount, state, routing, and GUI infrastructure

| File | Approx. size | Role and important symbols |
|---|---:|---|
| `index.html` | 41 lines | Supplies `#app`, the pre-Svelte loading screen, global styles, manifest, and module entry (`index.html:20`, `index.html:28`, `index.html:39`). |
| `src/main.ts` | 23 lines | Imports polyfills/storage side effects, mounts `App`, starts `loadData()` and `initHotkey()`, then removes the static loader (`src/main.ts:1`, `src/main.ts:16`, `src/main.ts:20`). |
| `src/App.svelte` | 253 lines | Root screen switch and permanent overlay host. The main route precedence is loading → settings → dedicated mobile shell → desktop shell/chat (`src/App.svelte:171`); global overlays and toasters are mounted at `src/App.svelte:209` and `src/App.svelte:241`. |
| `src/ts/stores.svelte.ts` | 246 lines | Central writable/rune state. `updateSize()` drives `SizeStore` and the 1024px `DynamicGUI` breakpoint (`src/ts/stores.svelte.ts:11`); major navigation stores are declared at `src/ts/stores.svelte.ts:24` and `src/ts/stores.svelte.ts:55`; `DBState` is the global database rune at `src/ts/stores.svelte.ts:144`. |
| `src/ts/routing.ts` | 82 lines | Named settings-route facade over numeric `SettingsMenuIndex`. Exports `SettingsRoute` (`src/ts/routing.ts:16`), `SystemTab` (`src/ts/routing.ts:44`), `AccessibilityTab` (`src/ts/routing.ts:55`), and `openSettings()` (`src/ts/routing.ts:69`). |
| `src/ts/hotkey.ts` | 363 lines | Installs the global keyboard dispatcher in `initHotkey()` (`src/ts/hotkey.ts:10`), maps configured action names to store changes or DOM hooks (`src/ts/hotkey.ts:34`), exposes `quickMenu()` (`src/ts/hotkey.ts:249`) and `hotkeyMatches()` (`src/ts/hotkey.ts:278`), and installs mobile swipe navigation via `initMobileGesture()` (`src/ts/hotkey.ts:314`). |
| `src/ts/alert.ts` | 434 lines | Imperative modal/toast API. Defines `alertData` (`src/ts/alert.ts:20`), normalizes errors (`src/ts/alert.ts:58`), provides blocking helpers such as `alertConfirm()` (`src/ts/alert.ts:280`), `alertConfirmMulti()` (`src/ts/alert.ts:300`), and `alertInput()` (`src/ts/alert.ts:366`), and non-blocking `notify*` helpers (`src/ts/alert.ts:223`). |
| `src/ts/gui/colorscheme.ts` | 455 lines | Built-in theme definitions and CSS-variable application. `ColorScheme` is at `src/ts/gui/colorscheme.ts:9`; `changeColorScheme()` at `src/ts/gui/colorscheme.ts:280`; `updateColorScheme()` at `src/ts/gui/colorscheme.ts:291`; text theme, font, and custom CSS application at `src/ts/gui/colorscheme.ts:378`. |
| `src/ts/gui/guisize.ts` | 46 lines | Publishes textarea/sidebar sizing stores and writes `--sidebar-size` in `updateGuisize()` (`src/ts/gui/guisize.ts:4`, `src/ts/gui/guisize.ts:8`). |
| `src/ts/gui/animation.ts` | 5 lines | Writes the database animation duration to `--risu-animation-speed` (`src/ts/gui/animation.ts:3`). |
| `src/ts/gui/highlight.ts` | 320 lines | CSS Highlight API support for CBS/decorator syntax. Public entry points are `highlighter()` (`src/ts/gui/highlight.ts:9`), `getNewHighlightId()` (`src/ts/gui/highlight.ts:119`), and `removeHighlight()` (`src/ts/gui/highlight.ts:123`). |
| `src/ts/gui/branches.ts` | 103 lines | Builds a hashed tree of chat histories for the branch-view alert. `getChatBranches()` is at `src/ts/gui/branches.ts:69`. |
| `src/ts/gui/deepTouch.svelte.ts` | 51 lines | Traverses rune proxies to establish deep reactive dependencies without cloning; exported `deepTouch()` is at `src/ts/gui/deepTouch.svelte.ts:38`. |
| `src/ts/gui/tooltip.ts` | 37 lines | Tippy Svelte actions `tooltip()` and `tooltipRight()` (`src/ts/gui/tooltip.ts:5`, `src/ts/gui/tooltip.ts:22`). |
| `src/ts/gui/longtouch.ts` | 26 lines | Mouse-based 500ms `longpress` action (`src/ts/gui/longtouch.ts:1`). |

### Chat and desktop navigation

| File | Approx. size | Role and important symbols |
|---|---:|---|
| `src/lib/ChatScreens/ChatScreen.svelte` | 104 lines | Theme/layout adapter around the main chat screen. It selects waifu, waifu-mobile, or normal layouts and always delegates conversation UI to `DefaultChatScreen` (`src/lib/ChatScreens/ChatScreen.svelte:42`, `src/lib/ChatScreens/ChatScreen.svelte:57`, `src/lib/ChatScreens/ChatScreen.svelte:75`). |
| `src/lib/ChatScreens/DefaultChatScreen.svelte` | 1,393 lines | Main conversation controller: home/playground fallback, composer, draft persistence, sending, rerolls/swipes, paging, scroll navigation, plugin chat panels, and initial greeting. `ensureActiveChatReady()` is at `src/lib/ChatScreens/DefaultChatScreen.svelte:154`; `sendMain()` at `src/lib/ChatScreens/DefaultChatScreen.svelte:328`; `sendChatMain()` at `src/lib/ChatScreens/DefaultChatScreen.svelte:544`. |
| `src/lib/ChatScreens/Chats.svelte` | 232 lines | Performance-oriented message-list renderer. It manually `mount()`s `Chat` components and reconciles them by a computed hash in `updateChatBody()` (`src/lib/ChatScreens/Chats.svelte:63`, `src/lib/ChatScreens/Chats.svelte:112`); exports `scrollToLatestMessage` at `src/lib/ChatScreens/Chats.svelte:196`. |
| `src/lib/ChatScreens/Chat.svelte` | 1,266 lines | One message bubble/card, including edit/delete/bookmark/reroll/translation/TTS/branch controls and multiple visual themes. Message deletion is handled by `rm()` (`src/lib/ChatScreens/Chat.svelte:87`), display preprocessing by `displaya()` (`src/lib/ChatScreens/Chat.svelte:173`), and body delegation occurs at `src/lib/ChatScreens/Chat.svelte:422`. |
| `src/lib/ChatScreens/ChatBody.svelte` | 261 lines | Asynchronously converts a message to display HTML via CBS/markdown parsing, translation, module assets, and inlay resolution. `markParsing()` begins at `src/lib/ChatScreens/ChatBody.svelte:61`; final HTML is emitted at `src/lib/ChatScreens/ChatBody.svelte:257`. |
| `src/lib/ChatScreens/PartialEditController.svelte` | 1,181 lines | Block/drag-based partial editing overlay attached from each message body when enabled (`src/lib/ChatScreens/Chat.svelte:437`). |
| `src/lib/SideBars/Sidebar.svelte` | 1,291 lines | Desktop character rail and secondary panel. It builds ordered character/folder rows (`src/lib/SideBars/Sidebar.svelte:102`), handles selection and drag reordering, exposes hamburger/plugin actions (`src/lib/SideBars/Sidebar.svelte:603`), and selects recent chats, quick settings, developer tools, character config, or chat list at `src/lib/SideBars/Sidebar.svelte:1049`. |
| `src/lib/SideBars/CharConfig.svelte` | 1,201 lines | Active-character editor. Desktop tab buttons are at `src/lib/SideBars/CharConfig.svelte:227`; lorebook is rendered at `src/lib/SideBars/CharConfig.svelte:583`; regex and trigger script panels at `src/lib/SideBars/CharConfig.svelte:588`. |
| `src/lib/SideBars/SideChatList.svelte` | 506 lines | Active character’s chat/session list and chat-management actions; mounted by desktop Sidebar at `src/lib/SideBars/Sidebar.svelte:1097` and `src/lib/SideBars/Sidebar.svelte:1124`, and by mobile at `src/lib/Mobile/MobileBody.svelte:39`. |
| `src/lib/SideBars/LoreBook/LoreBookSetting.svelte` | 155 lines | Chooses character-global, chat-local, or settings lore views and provides add/import/export/folder actions (`src/lib/SideBars/LoreBook/LoreBookSetting.svelte:13`, `src/lib/SideBars/LoreBook/LoreBookSetting.svelte:112`). |
| `src/lib/SideBars/LoreBook/LoreBookList.svelte` | 516 lines | Sortable lore entry/folder list. Its data source varies by global mode/submenu (`src/lib/SideBars/LoreBook/LoreBookList.svelte:44`), and SortableJS setup begins at `src/lib/SideBars/LoreBook/LoreBookList.svelte:113`. |
| `src/lib/SideBars/Scripts/TriggerList.svelte` | 99 lines | Format switch for deprecated V1, V2, and Lua triggers (`src/lib/SideBars/Scripts/TriggerList.svelte:18`, `src/lib/SideBars/Scripts/TriggerList.svelte:23`); V1 is lazy-loaded at `src/lib/SideBars/Scripts/TriggerList.svelte:20`. |
| `src/lib/SideBars/Scripts/TriggerV2List.svelte` | 4,113 lines | Full V2 trigger program editor and the largest UI component in this subsystem. Changes here have unusually broad script-format compatibility risk. |

### Settings, mobile, shared UI, and overlays

| File | Approx. size | Role and important symbols |
|---|---:|---|
| `src/lib/Setting/Settings.svelte` | 310 lines | Settings navigation and page switch. Menu entries mutate numeric `SettingsMenuIndex`; page rendering is the main branch near the bottom; mobile/narrow back behavior returns to the menu. The former built-in Remote Access settings page/route has been removed; remote setup is documented externally. |
| `src/lib/Setting/SettingRenderer.svelte` | 65 lines | Renders declarative `SettingItem[]`, builds model-aware `SettingContext`, evaluates conditions, and dispatches through `settingRegistry` (`src/lib/Setting/SettingRenderer.svelte:22`, `src/lib/Setting/SettingRenderer.svelte:29`, `src/lib/Setting/SettingRenderer.svelte:37`). |
| `src/lib/Setting/Pages/DisplaySettings.svelte` | 56 lines | Representative declarative settings page: theme, size/speed, and grouped “other” tabs are built from setting-data arrays (`src/lib/Setting/Pages/DisplaySettings.svelte:27`, `src/lib/Setting/Pages/DisplaySettings.svelte:36`). |
| `src/lib/Setting/Pages/BotSettings.svelte` | 547 lines | Main model/parameter/custom-model settings page, mixing direct controls with declarative parameter items. Its page tabs begin at `src/lib/Setting/Pages/BotSettings.svelte:116`. |
| `src/lib/Setting/Pages/Model/ModelPresetSettings.svelte` | 523 lines | Model preset list/editor, profile registry synchronization, credentials, schema-driven fields, capabilities, and request testing (`src/lib/Setting/Pages/Model/ModelPresetSettings.svelte:29`, `src/lib/Setting/Pages/Model/ModelPresetSettings.svelte:47`, `src/lib/Setting/Pages/Model/ModelPresetSettings.svelte:106`). |
| `src/lib/Setting/Pages/SystemSettings.svelte` | 618 lines | Dashboard, backup, logs, and plugin-storage tabs. Its cross-page tab state comes from `SystemSubmenuIndex` (`src/lib/Setting/Pages/SystemSettings.svelte:11`); the dashboard includes browser resource-cache stats/clear controls, and Backups mounts both server/portable controls and the per-chat recovery browser. |
| `src/lib/Setting/ChatBackupList.svelte` | 277 lines | Expands server-captured chat histories, resolves live/deleted character and chat labels, fetches a selected version, chooses a target character, and imports it as a new chat through the storage subsystem. |
| `src/lib/Setting/Pages/Advanced/ResourceCacheSettings.svelte` | 59 lines | Toggles the opt-in verified IndexedDB resource cache and shows current entry/byte usage when supported. |
| `src/lib/UI/GUI/SettingPage.svelte` | 16 lines | Standard page title/body wrapper (`src/lib/UI/GUI/SettingPage.svelte:13`). |
| `src/lib/UI/GUI/SettingTabs.svelte` | 43 lines | Bindable numeric tab row used by settings pages (`src/lib/UI/GUI/SettingTabs.svelte:7`, `src/lib/UI/GUI/SettingTabs.svelte:16`). |
| `src/lib/UI/GUI/ShDialog.svelte` | 133 lines | Main `bits-ui` dialog wrapper, with explicit size and z-index tiers (`src/lib/UI/GUI/ShDialog.svelte:4`, `src/lib/UI/GUI/ShDialog.svelte:40`, `src/lib/UI/GUI/ShDialog.svelte:64`). |
| `src/lib/UI/MainMenu.svelte` | 197 lines | Desktop no-character home screen, including version/build identity, update/state information, recent Realm cards, related links, and Realm navigation. Non-empty `__APP_BRANCH__` produces a custom-build badge whose tooltip includes `__APP_COMMIT__`; Vite gets these from `APP_BRANCH`/`APP_COMMIT` or local Git. |
| `src/lib/UI/Realm/RealmMain.svelte` | 213 lines | Searchable/paged Realm catalog. `getHub()` is at `src/lib/UI/Realm/RealmMain.svelte:21`; mobile/desktop filter layouts diverge at `src/lib/UI/Realm/RealmMain.svelte:76`. |
| `src/lib/Mobile/MobileBody.svelte` | 55 lines | Mobile screen switch: active-chat side panels, chat screen, Realm, characters, or settings (`src/lib/Mobile/MobileBody.svelte:17`, `src/lib/Mobile/MobileBody.svelte:37`). |
| `src/lib/Mobile/MobileHeader.svelte` | 46 lines | Contextual back/menu/search header; settings back resets `SettingsMenuIndex` to `SettingsRoute.None` (`src/lib/Mobile/MobileHeader.svelte:11`, `src/lib/Mobile/MobileHeader.svelte:32`). |
| `src/lib/Mobile/MobileFooter.svelte` | 71 lines | Bottom navigation for Realm/characters/settings plus character-config sub-tabs (`src/lib/Mobile/MobileFooter.svelte:8`, `src/lib/Mobile/MobileFooter.svelte:33`). |
| `src/lib/Playground/PlaygroundMenu.svelte` | 197 lines | Numeric `PlaygroundStore` menu and tool dispatcher; special chat creation is in `playgroundChat()` (`src/lib/Playground/PlaygroundMenu.svelte:26`), tool routing at `src/lib/Playground/PlaygroundMenu.svelte:153`. |
| `src/lib/Others/AlertComp.svelte` | 1,330 lines | Singleton consumer for `alertStore`, special legacy overlays, new `ShDialog` alerts, generation/request logs, branch view, exports, and toggle presets. Store reset logic is at `src/lib/Others/AlertComp.svelte:123`; modern dialog rendering begins at `src/lib/Others/AlertComp.svelte:781`. |
| `src/lib/_dev/DevPanel.svelte` | 829 lines | Opt-in end-to-end test surface for alerts, notifications, update UI, and shared controls. It is gated by `localStorage['risu-dev-panel']='1'` in Settings (`src/lib/Setting/Settings.svelte:32`) and can disable itself at `src/lib/_dev/DevPanel.svelte:52`. |

## 3. Architecture & data flow

### Root mount and screen selection

1. `index.html` creates the DOM mount and static loader, then imports `src/main.ts` (`index.html:20`, `index.html:29`, `index.html:39`).
2. `main.ts` runs `preLoadCheck()`, mounts `App`, starts asynchronous data bootstrapping, installs hotkeys, and removes the static loader (`src/main.ts:16`).
3. `App.svelte` remains mounted before database loading completes. `$loadedStore` gates the usable UI and displays `LoadingStatusState.text` until bootstrap finishes (`src/App.svelte:171`).
4. After loading, `settingsOpen` has first routing priority. Otherwise `MobileGUI` selects the dedicated mobile shell. Desktop mode renders a `Sidebar` plus `ChatScreen`, with `DynamicGUI` deciding whether the sidebar is inline or an overlay (`src/App.svelte:183`, `src/App.svelte:185`, `src/App.svelte:195`).
5. Modal hosts, preset selectors, loading/update/backup overlays, popup editor, and toasters remain outside that screen branch, so they survive screen transitions (`src/App.svelte:209`).

There is no general URL router in this subsystem. Character selection, home/playground selection, settings, Realm, mobile tabs, sidebar visibility, and modal visibility are all encoded in stores such as `selectedCharID`, `PlaygroundStore`, `settingsOpen`, `SettingsMenuIndex`, `OpenRealmStore`, `MobileGUIStack`, and `MobileSideBar` (`src/ts/stores.svelte.ts:28`, `src/ts/stores.svelte.ts:35`, `src/ts/stores.svelte.ts:56`, `src/ts/stores.svelte.ts:58`, `src/ts/stores.svelte.ts:82`, `src/ts/stores.svelte.ts:84`).

### Chat rendering and send flow

1. `ChatScreen` selects the outer visual theme and supplies backgrounds/emotion/inlay areas, then mounts `DefaultChatScreen` (`src/lib/ChatScreens/ChatScreen.svelte:42`).
2. With no selected character, `DefaultChatScreen` renders `MainMenu` or lazy-loads `PlaygroundMenu`; with a character, it derives the current chat directly from `DBState.db` (`src/lib/ChatScreens/DefaultChatScreen.svelte:78`, `src/lib/ChatScreens/DefaultChatScreen.svelte:881`).
3. Composer drafts are keyed by character/chat IDs and loaded, debounced, flushed on chat changes, and checkpointed on page hide (`src/lib/ChatScreens/DefaultChatScreen.svelte:84`, `src/lib/ChatScreens/DefaultChatScreen.svelte:98`, `src/lib/ChatScreens/DefaultChatScreen.svelte:129`, `src/lib/ChatScreens/DefaultChatScreen.svelte:140`).
4. `sendMain()` hydrates placeholder chats through `ensureCurrentChatReady`, processes slash commands, attachments, input triggers, and scripts, appends the user message to `DBState.db`, clears the draft, and calls `sendChatMain()` (`src/lib/ChatScreens/DefaultChatScreen.svelte:328`).
5. `sendChatMain()` invokes the processing subsystem’s `sendChat()` with an abort signal and optional continuation flag (`src/lib/ChatScreens/DefaultChatScreen.svelte:544`).
6. The scroll viewport incrementally expands `loadPages` when its reversed scroll approaches older content (`src/lib/ChatScreens/DefaultChatScreen.svelte:1189`). It renders normal messages through `Chats` and the initial greeting through a direct `Chat` component (`src/lib/ChatScreens/DefaultChatScreen.svelte:1239`, `src/lib/ChatScreens/DefaultChatScreen.svelte:1254`).
7. `Chats.updateChatBody()` iterates the selected message window in reverse, hashes rendering-relevant fields, and manually mounts or removes individual `Chat` instances (`src/lib/ChatScreens/Chats.svelte:63`).
8. `Chat` owns bubble structure and actions, runs `risuChatParser()` for display substitutions, then delegates final asynchronous markup to `ChatBody` (`src/lib/ChatScreens/Chat.svelte:173`, `src/lib/ChatScreens/Chat.svelte:369`).
9. `ChatBody.markParsing()` applies `ParseMarkdown`, optional translation/cache behavior, asset resolution, and metadata before emitting HTML (`src/lib/ChatScreens/ChatBody.svelte:61`, `src/lib/ChatScreens/ChatBody.svelte:244`).

Thus, the chat log is coordinated by `DefaultChatScreen`, physically populated by `Chats`, and each visible message bubble is `Chat`; `ChatBody` supplies the parsed contents inside that bubble.

### Settings organization

`Settings.svelte` is both menu and router. Each menu button assigns a numeric `SettingsMenuIndex`, and a parallel `if/else` chain mounts the corresponding page (`src/lib/Setting/Settings.svelte:52`, `src/lib/Setting/Settings.svelte:249`). `src/ts/routing.ts` adds stable names and `openSettings()` for external callers, but explicitly treats `Settings.svelte` as the source of truth (`src/ts/routing.ts:3`, `src/ts/routing.ts:9`).

Settings pages use two styles:

- Large or specialized pages directly compose controls and feature components, as in `BotSettings`, `OtherBotSettings`, `ModelPresetSettings`, and `SystemSettings`.
- Repetitive pages define `SettingItem[]` in `src/ts/setting/*SettingsData*` and pass them to `SettingRenderer`. It evaluates conditions, looks up a wrapper by item type, and renders it (`src/lib/Setting/SettingRenderer.svelte:38`). The wrapper mapping is centralized in `src/ts/setting/settingRegistry.ts:19`, while custom item implementations are registered through `src/ts/setting/customComponents.ts`.

Page-local subtabs generally use `SettingTabs` and numeric local state. System and Accessibility are exceptions: their subtab indices are global stores so other features can deep-link into them (`src/ts/stores.svelte.ts:71`, `src/ts/stores.svelte.ts:75`).

### Desktop, responsive overlay, and mobile layouts

There are two separate responsive concepts:

- `DynamicGUI` is recalculated on every resize at `window.innerWidth <= 1024` and changes the desktop sidebar from inline to overlay (`src/ts/stores.svelte.ts:11`, `src/App.svelte:195`).
- `MobileGUI` selects the entirely different header/body/footer shell. Bootstrap sets it only when `betaMobileGUI` is enabled at width `<= 800`, or for the Lite build (`src/ts/bootstrap.ts:152`).

Within mobile mode, `MobileGUIStack` chooses Realm, characters, or settings when no character is selected. An active character normally shows `ChatScreen`; `MobileSideBar` replaces it with chat list, character config, or developer tools (`src/lib/Mobile/MobileBody.svelte:37`). The footer supplies the top-level and character-config tabs (`src/lib/Mobile/MobileFooter.svelte:8`, `src/lib/Mobile/MobileFooter.svelte:33`).

### Theme and sizing flow

Bootstrap calls `updateColorScheme()`, `updateTextThemeAndCSS()`, `updateAnimationSpeed()`, and `updateGuisize()` after the database is normalized (`src/ts/bootstrap.ts:136`). These functions translate database settings into root CSS variables:

- Palette colors and dark/light classification: `src/ts/gui/colorscheme.ts:305`.
- Markdown/text emphasis colors, font family, and custom CSS: `src/ts/gui/colorscheme.ts:378`.
- Sidebar width: `src/ts/gui/guisize.ts:17`.
- Animation duration: `src/ts/gui/animation.ts:3`.

Display-setting data attaches these updater functions as `onChange` callbacks, so changing a stored setting alone is not always sufficient; imperative CSS synchronization may also be required. `ColorSchemeTypeStore` is consumed by message prose styling (`src/lib/ChatScreens/Chat.svelte:410`).

### Alerts, dialogs, and toasts

Blocking helpers write a discriminated `alertData` object to the singleton `alertStore`, then asynchronous helpers poll `waitAlert()` until the renderer changes its type to `none` (`src/ts/alert.ts:122`). The selected value is returned through the same object’s `msg` field, as demonstrated by `alertSelect()` and `alertConfirm()` (`src/ts/alert.ts:166`, `src/ts/alert.ts:280`).

`AlertComp` is permanently mounted by `App`. It contains older special-purpose full-screen branches plus newer `ShDialog`, `ShAlertDialog`, and `ShLoadingDialog` branches (`src/lib/Others/AlertComp.svelte:206`, `src/lib/Others/AlertComp.svelte:781`). Non-blocking `notify*` calls use `svelte-sonner`; errors, warnings, and informational notifications also feed the logging subsystem (`src/ts/alert.ts:197`).

The toggle-preset chooser intentionally uses `togglePresetsOpenStore`, not the singleton alert store, so a nested confirmation/input can layer over it (`src/ts/alert.ts:412`). Dialog tiering (`base`, `alert`, `top`) provides the matching z-index contract (`src/lib/UI/GUI/ShDialog.svelte:4`).

## 4. Entry points & dependencies

### Calls into the UI layer

- `src/main.ts` mounts the entire UI through `App` (`src/main.ts:17`).
- Character and import logic changes `selectedCharID`, `OpenRealmStore`, or settings routes; `App`, `Sidebar`, and `DefaultChatScreen` react to those stores.
- `src/ts/characterCards.ts`, preset managers, model bindings, migration UI, and module UI call `openSettings()` to deep-link into settings.
- The processing, storage, plugin, update, and bootstrap subsystems call exported `alert*`, `notify*`, theme, sizing, and overlay stores.
- Plugin API V3 populates `additionalSettingsMenu`, `additionalHamburgerMenu`, `additionalChatMenu`, `additionalFloatingActionButtons`, and `chatPanelStore`, declared at `src/ts/stores.svelte.ts:189`. Their UI consumers are Settings (`src/lib/Setting/Settings.svelte:222`), Sidebar (`src/lib/SideBars/Sidebar.svelte:644`), and DefaultChatScreen (`src/lib/ChatScreens/DefaultChatScreen.svelte:932`, `src/lib/ChatScreens/DefaultChatScreen.svelte:1212`).

### Calls out of the UI layer

- Chat UI calls storage hydration/draft APIs, `sendChat()`, scripts, triggers, commands, translation, TTS, inlay files, notification sound, and character helpers.
- Settings bind to `DBState.db` and call model registries, provider discovery, backup/log APIs, plugin APIs, and declarative setting definitions.
- Realm UI calls `getRisuHub()`/`downloadRisuHub()` and character import APIs.
- Sidebar and lore/script editors call character ordering, asset storage, SortableJS, lorebook import/export, regex import/export, and module application.
- Shared UI libraries include `@lucide/svelte`, `bits-ui`, `svelte-sonner`, `tippy.js`, `sortablejs`, `highlight.js`, `clsx`, and `tailwind-merge`.
- Parsed message and plugin panel HTML is emitted with `{@html}` after upstream parsing or plugin construction (`src/lib/ChatScreens/ChatBody.svelte:257`, `src/lib/ChatScreens/DefaultChatScreen.svelte:1216`).

## 5. Conventions & gotchas

- Svelte 5 runes and classic Svelte stores coexist. Use direct rune access for `DBState`/`$state` objects, but `$store` syntax or `.set()`/`.update()` for `writable` stores. `stores.svelte.ts` must retain its `.svelte.ts` form because it contains runes.
- `DBState.db` is the canonical live data model, not a disposable UI copy (`src/ts/stores.svelte.ts:144`). Most inputs bind directly into it; replacing or cloning subobjects casually can interfere with references and persistence tracking.
- Persistence effects depend on deep reactive reads. `deepTouch()` is deliberately used instead of `$state.snapshot()` to avoid cloning large characters/modules (`src/ts/gui/deepTouch.svelte.ts:1`). Adding non-plain objects to persisted data can force the slower snapshot fallback.
- General navigation is not represented in the browser URL. Adding a screen normally requires a store value and a render branch, not a route configuration.
- Settings route numbers are a compatibility surface. Adding or reordering a page requires synchronized edits in the menu, render switch, and `SettingsRoute`; the comments explicitly warn against magic numbers (`src/ts/routing.ts:3`). Existing gaps are meaningful: route 5 renders Files without a visible menu button, sound uses index 7 but currently lacks a `SettingsRoute` constant, and the removed Remote Access page left index 21 unused.
- Narrow settings use `SettingsMenuIndex === -1` as the menu/list state. Closing a page under 700px returns to that state rather than closing settings (`src/lib/Setting/Settings.svelte:299`).
- `DynamicGUI` and `MobileGUI` are not synonyms. The former changes sidebar presentation at 1024px on resize; the latter is a boot-selected alternate application shell.
- `Settings.svelte` also uses direct `window.innerWidth` thresholds of 700 and 900 (`src/lib/Setting/Settings.svelte:39`, `src/lib/Setting/Settings.svelte:46`). These are separate from both global responsive stores.
- The message list is not a normal `{#each}`. `Chats.svelte` manually mounts `Chat` and only remounts when its rendering hash changes (`src/lib/ChatScreens/Chats.svelte:103`). If a newly relevant message field is added, include it in the hash or bump `ReloadChatPointer`.
- Both the chat viewport and message list use reversed flex ordering (`src/lib/ChatScreens/DefaultChatScreen.svelte:1189`, `src/lib/ChatScreens/Chats.svelte:232`). Scroll calculations that look inverted are usually intentional.
- Placeholder chats must be hydrated before mutation. `DefaultChatScreen.ensureActiveChatReady()` is the established guard (`src/lib/ChatScreens/DefaultChatScreen.svelte:154`).
- The composer contains the non-Tailwind class `plugin-compat-items-stretch`; plugins use it as a DOM anchor, so it must not be renamed during visual cleanup (`src/lib/ChatScreens/DefaultChatScreen.svelte:900`).
- Global hotkeys deliberately depend on stable CSS hooks such as `.button-icon-reroll`, `.button-icon-edit`, `.text-input-area`, and `.button-icon-send` (`src/ts/hotkey.ts:34`). Renaming those classes silently breaks configured hotkeys.
- Escape handling checks both the legacy alert singleton and open ARIA dialogs to avoid closing a settings drawer behind a modal (`src/ts/hotkey.ts:179`).
- Only one ordinary `alertStore` modal can exist at once. Starting another blocking alert overwrites the first. Use a separate store plus dialog tiering when nested modal interaction is required, following toggle presets.
- `doingAlert()` intentionally treats `wait` as non-blocking for some global interaction checks (`src/ts/alert.ts:193`).
- Notify calls clear only transitional wait/progress alerts, not input/confirm dialogs (`src/ts/alert.ts:202`). This preserves active user decisions.
- `ShDialog` defaults to ignoring Escape but allowing outside click (`src/lib/UI/GUI/ShDialog.svelte:40`). Callers must explicitly choose close behavior; do not assume browser-dialog defaults.
- Legacy controls (`Button.svelte`, `TextInput.svelte`, etc.) and newer `Sh*` controls coexist. Follow the component family already used by the surrounding page; dialogs and newer settings work generally favor `Sh*`.
- Dialog stacking tiers are contractual: base `z-40`, ordinary alerts `z-50`, exceptional top overlays `z-[60]` (`src/lib/UI/GUI/ShDialog.svelte:64`).
- `ColorScheme.primary` was added after older export formats. Import/update paths intentionally backfill it (`src/ts/gui/colorscheme.ts:315`, `src/ts/gui/colorscheme.ts:361`).
- Lite mode forces the built-in lite palette and standard text theme regardless of stored choices (`src/ts/gui/colorscheme.ts:301`, `src/ts/gui/colorscheme.ts:384`).
- Safe mode suppresses user custom CSS by setting `CustomCSSStore` to an empty string (`src/ts/gui/colorscheme.ts:450`). `CustomCSSStore` injects a `#customcss` style node into the document (`src/ts/stores.svelte.ts:109`).
- Theme value `''` means PocketRisu’s NodeOnly Standard chat layout. Legacy database theme `"custom"` is normalized to `''`, while `"customHTML"` remains a distinct custom bubble renderer (`src/ts/storage/database.svelte.ts:28`, `src/lib/ChatScreens/Chat.svelte:1094`, `src/lib/ChatScreens/Chat.svelte:1203`).
- Custom chat GUI HTML is not mounted as arbitrary Svelte. `Chat.renderGuiHtmlPart()` recursively maps a fixed set of tags and special `RISUTEXTBOX`, `RISUICON`, `RISUBUTTONS`, and `RISUGENINFO` placeholders (`src/lib/ChatScreens/Chat.svelte:950`, `src/lib/ChatScreens/Chat.svelte:1059`).
- Lorebook and regex lists let SortableJS mutate the DOM, then reconstruct data/recreate the Sortable instance to return authority to Svelte (`src/lib/SideBars/LoreBook/LoreBookList.svelte:113`, `src/lib/SideBars/Scripts/RegexList.svelte:19`). Directly simplifying this can desynchronize DOM and database order.
- Trigger-format switching is destructive and confirmation-protected. V1/V2/Lua identification depends on sentinel effect types in the first trigger entry (`src/lib/SideBars/Scripts/TriggerList.svelte:18`).
- The Dev Panel is compiled into production but hidden unless a local-storage flag was present at Settings mount time; changing the flag requires reload (`src/lib/Setting/Settings.svelte:32`).

- The home-screen build badge is compile-time metadata, not runtime Git detection. `vite.config.ts` prefers builder-supplied `APP_BRANCH`/`APP_COMMIT`, falls back to `git rev-parse`, and hides the badge when no branch is available. Keep `src/vite-env.d.ts` declarations synchronized with new constants.

## 6. Navigation hints

- To change the root screen precedence, edit the branch beginning at `src/App.svelte:171`.
- To add a permanent app-wide overlay or toaster, mount it with the other hosts at `src/App.svelte:209`.
- To add a new global screen state, declare it near the navigation stores in `src/ts/stores.svelte.ts:24` and consume it in `App.svelte` or the relevant shell.
- To change desktop sidebar overlay behavior or breakpoint, start with `updateSize()` at `src/ts/stores.svelte.ts:11` and the desktop branch at `src/App.svelte:195`.
- To change when the dedicated mobile shell is selected, edit bootstrap’s condition at `src/ts/bootstrap.ts:152`.
- To add a mobile top-level destination, update `MobileBody`’s switch at `src/lib/Mobile/MobileBody.svelte:47` and the matching footer button at `src/lib/Mobile/MobileFooter.svelte:8`.
- To add a mobile active-character side panel, extend the `MobileSideBar` branches at `src/lib/Mobile/MobileBody.svelte:17` and its header/footer controls at `src/lib/Mobile/MobileHeader.svelte:11`.
- To change the chat outer theme/background/inlay layout, look at `src/lib/ChatScreens/ChatScreen.svelte:42`.
- To change the composer, send flow, paging, plugin chat panels, or chat/home switch, start in `src/lib/ChatScreens/DefaultChatScreen.svelte:321`, `src/lib/ChatScreens/DefaultChatScreen.svelte:894`, and `src/lib/ChatScreens/DefaultChatScreen.svelte:1189`.
- To change which messages are mounted or force rerender behavior, inspect the hash and props in `src/lib/ChatScreens/Chats.svelte:97`.
- To change message bubble chrome or action buttons, edit `src/lib/ChatScreens/Chat.svelte:369` and the theme branches beginning at `src/lib/ChatScreens/Chat.svelte:1094`.
- To change markdown/CBS/translation rendering inside a bubble, start at `src/lib/ChatScreens/ChatBody.svelte:61`.
- To add a new desktop sidebar/hamburger action, extend the menu around `src/lib/SideBars/Sidebar.svelte:603`; plugin-provided entries use `additionalHamburgerMenu`.
- To add a character-config sidebar tab, add the desktop button around `src/lib/SideBars/CharConfig.svelte:227`, its render branch around `src/lib/SideBars/CharConfig.svelte:258`, and the mobile footer button around `src/lib/Mobile/MobileFooter.svelte:33`.
- To change lorebook tabs or import/export actions, use `src/lib/SideBars/LoreBook/LoreBookSetting.svelte:13`; for ordering/data-source behavior, use `src/lib/SideBars/LoreBook/LoreBookList.svelte:44`.
- To change regex rows, start with `src/lib/SideBars/Scripts/RegexList.svelte:19` and `RegexData.svelte`; to change trigger format selection, use `src/lib/SideBars/Scripts/TriggerList.svelte:23`.
- To add a new top-level settings page, create it under `src/lib/Setting/Pages/`, import it in `src/lib/Setting/Settings.svelte:4`, add its menu button, add its render branch at `src/lib/Setting/Settings.svelte:249`, and add the same numeric ID to `src/ts/routing.ts:16`.
- To add an option to an existing declarative settings page, change the corresponding `src/ts/setting/*SettingsData*` array and confirm the item type exists in `src/ts/setting/settingRegistry.ts:19`.
- To add a new declarative setting control type, define the type, add a wrapper under `src/lib/Setting/Wrappers/`, and register it at `src/ts/setting/settingRegistry.ts:19`.
- To add specialized declarative content without a new generic type, follow the custom-component registration imports in `src/ts/setting/customComponents.ts:18`.
- To change palette tokens or add a built-in palette, edit `src/ts/gui/colorscheme.ts:9` and the palette table beginning at `src/ts/gui/colorscheme.ts:123`; application to CSS variables is at `src/ts/gui/colorscheme.ts:291`.
- To change text emphasis colors, font selection, or safe-mode custom CSS, edit `src/ts/gui/colorscheme.ts:378`.
- To change sidebar width choices, edit `src/ts/gui/guisize.ts:8` together with width classes at `src/lib/SideBars/Sidebar.svelte:1005`.
- To add a new blocking modal type, extend `alertData` at `src/ts/alert.ts:20`, add an imperative helper, and add the matching `AlertComp` branch near `src/lib/Others/AlertComp.svelte:781`.
- To add non-blocking feedback, use or extend the `notify*` family at `src/ts/alert.ts:223` and leave rendering to the root `Toaster`.
- To change global keyboard actions, edit the action switch at `src/ts/hotkey.ts:34` and the configured hotkey definitions in the hotkey/data subsystem.
- To change the home screen, edit `src/lib/UI/MainMenu.svelte:23`; to change the full Realm catalog, edit `src/lib/UI/Realm/RealmMain.svelte:21`.
- To change custom-build identity, update `vite.config.ts` defines, `src/vite-env.d.ts`, and the badge in `MainMenu.svelte` together; hosted archive builds must pass `APP_BRANCH`/`APP_COMMIT` because `.git` may be absent.
- To add a Playground tool, allocate a `PlaygroundStore` value in the menu buttons and matching render branch in `src/lib/Playground/PlaygroundMenu.svelte:53`.

### Out of scope, noticed

- `src/ts/storage/database.svelte.ts` defines and normalizes the database model used by nearly every UI component.
- `src/ts/globalApi.svelte.ts` owns persistence tracking, general application APIs, and several chat/navigation operations consumed by the UI.
- `src/ts/process/`, `src/ts/parser/`, `src/ts/model/`, `src/ts/preset/`, and `src/ts/plugins/` supply generation, message parsing, model registry, preset, and extension behavior.
- `src/styles.css`, `src/styles/nodeonly-standard.css`, and Tailwind configuration define the utility/token mapping consumed throughout the component tree.
