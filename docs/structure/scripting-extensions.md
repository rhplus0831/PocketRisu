# Scripting and extensions

> Part of the PocketRisu structure docs — see [STRUCTURE.md](../../STRUCTURE.md) for the top-level map and subsystem index.
> Audited 2026-08-04 against `95c2ea30`. Paths and symbols are authoritative; line-number hints are approximate and should be verified with `rg`.

## 1. Purpose & overview

PocketRisu exposes four overlapping extension mechanisms: CBS template expressions, regex/Lua/trigger scripts, JavaScript plugins, and Model Context Protocol tools. They run at different points in chat construction, request dispatch, response storage, and display rendering, with several compatibility layers inherited from RisuAI. Plugins can intercept those same pipelines, register complete model providers, add UI and TTS hooks, or publish MCP tools. Persistent extension state spans the main database, module records, and dedicated KV namespaces. Save-synced plugin-value persistence is documented separately in [Plugin storage](plugin-storage.md).

## 2. Key files

### CBS and script execution

- `src/ts/cbs.ts` — Declares the dependency-injected CBS registration contract, not the parser itself.
  - `matcherArg` carries parsing context such as character, chat index, temporary variables, display/tokenization mode, `runVar`, and CBS conditions (`src/ts/cbs.ts:51`).
  - `RegisterCallback` is the callback signature for individual CBS functions (`src/ts/cbs.ts:73`).
  - `CBSRegisterArg` lists the application services exposed to CBS implementations (`src/ts/cbs.ts:78`).
  - `defaultCBSRegisterArg` supplies placeholder implementations for isolated consumers/tests (`src/ts/cbs.ts:8`).
  - `registerCBS()` registers the built-in expression catalog through the injected `registerFunction` callback (`src/ts/cbs.ts:115`).
  - Character/user substitutions begin at `{{char}}` and `{{user}}` (`src/ts/cbs.ts:143`, `src/ts/cbs.ts:169`).
  - Temporary and persistent variable operations are registered around `tempvar`, `settempvar`, `return`, `getvar`, `addvar`, and `setvar` (`src/ts/cbs.ts:738`, `src/ts/cbs.ts:750`, `src/ts/cbs.ts:763`, `src/ts/cbs.ts:777`, `src/ts/cbs.ts:795`, `src/ts/cbs.ts:811`).
  - `randomPickImpl` centralizes random and deterministic-pick behavior and forces index zero in accurate-tokenization mode (`src/ts/cbs.ts:1989`).
  - `bkspc` and `erase` mutate the parser’s current output through `getNested`/`setNestedRoot` (`src/ts/cbs.ts:2165`, `src/ts/cbs.ts:2197`).
  - Block constructs such as `#when`, `:else`, `#puredisplay`, `#escape`, and `#each` are registered as documentation-only entries because the parser implements them specially (`src/ts/cbs.ts:2388`, `src/ts/cbs.ts:2428`, `src/ts/cbs.ts:2445`, `src/ts/cbs.ts:2452`, `src/ts/cbs.ts:2464`).

- `src/ts/parser/parser.svelte.ts` — parser implementation used by this subsystem.
  - `matcherMap` is the actual built-in CBS function registry (`src/ts/parser/parser.svelte.ts:1150`).
  - `initMatcher()` calls `registerCBS()` once and stores each callback under its canonical name and aliases; `doc_only` entries are deliberately skipped (`src/ts/parser/parser.svelte.ts:1152`).
  - `matcher()` normalizes names by lowercasing and removing whitespace, `_`, and `-`; it accepts either `:` or `::` argument separators (`src/ts/parser/parser.svelte.ts:1202`).
  - `blockStartMatcher()` and `blockEndMatcher()` implement conditionals, loops, pure blocks, escapes, and user-defined functions (`src/ts/parser/parser.svelte.ts:1319`, `src/ts/parser/parser.svelte.ts:1599`).
  - `risuChatParser()` is the synchronous CBS engine and public entry point (`src/ts/parser/parser.svelte.ts:1705`).
  - The parser maintains nested buffers and block stacks (`src/ts/parser/parser.svelte.ts:1737`), caps recursive function calls at 20 (`src/ts/parser/parser.svelte.ts:1758`), and supports `#func`/`call::` user functions (`src/ts/parser/parser.svelte.ts:1883`, `src/ts/parser/parser.svelte.ts:1907`).
  - When supplied a character, `ParseMarkdown()` invokes display scripts before
    inlay/tool rendering and markdown sanitization
    (`src/ts/parser/parser.svelte.ts:903`, `src/ts/parser/parser.svelte.ts:921`).

- `src/ts/process/scripts.ts` — `ScriptMode` defines `editinput`, `editoutput`, `editprocess`, and `editdisplay` (`src/ts/process/scripts.ts:18`).
  - `processScript()` is the string-only convenience wrapper (`src/ts/process/scripts.ts:26`).
  - `exportRegex()` and `importRegex()` serialize regex-script bundles (`src/ts/process/scripts.ts:30`, `src/ts/process/scripts.ts:41`).
  - `resetScriptCache()` clears the transformation cache (`src/ts/process/scripts.ts:95`).
  - `processScriptFull()` is the main regex/script pipeline and also returns whether an emotion changed (`src/ts/process/scripts.ts:100`).
  - It runs Lua edit listeners first, display triggers only for `editdisplay`, then plugin edit handlers, then CBS, and finally regex scripts (`src/ts/process/scripts.ts:103`, `src/ts/process/scripts.ts:105`, `src/ts/process/scripts.ts:125`, `src/ts/process/scripts.ts:138`, `src/ts/process/scripts.ts:139`).
  - Supplied regex flags are restricted to ECMAScript `dgimsuvy`, deduplicated, and default to `u` if sanitization leaves them empty; scripts without enabled custom flags use `g` (`src/ts/process/scripts.ts:161`).
  - Advanced actions include CBS-parsed input patterns, emotion changes, injection, moving matches, and repeating a prior-role match (`src/ts/process/scripts.ts:176`, `src/ts/process/scripts.ts:184`, `src/ts/process/scripts.ts:207`, `src/ts/process/scripts.ts:212`, `src/ts/process/scripts.ts:253`).
  - `<order n>` metadata is recognized only when custom flags are enabled. If any script supplies it, the combined preset/character/module list is sorted descending before execution (`src/ts/process/scripts.ts:302`, `src/ts/process/scripts.ts:338`).
  - Dynamic asset fuzzy matching runs after regex replacement (`src/ts/process/scripts.ts:351`).

- `src/ts/process/pluginEditHandlers.ts` — `applyPluginEditHandlers()` runs plugin edit
  handlers sequentially and keeps the prior value for `null`/`undefined` results. Only
  `editinput` asks it to isolate failures; other edit modes propagate a thrown handler
  error.

- `src/ts/process/scriptings.ts` — `runScripted()` owns the Lua/Python execution environment and its host API (`src/ts/process/scriptings.ts:59`).
  - Engines are cached by mode and serialized through a per-engine `Mutex` (`src/ts/process/scriptings.ts:78`, `src/ts/process/scriptings.ts:80`, `src/ts/process/scriptings.ts:1180`).
  - The API uses per-run UUID access keys checked against `ScriptingSafeIds`,
    `ScriptingEditDisplayIds`, and `ScriptingLowLevelIds`
    (`src/ts/process/scriptings.ts:22`, `src/ts/process/scriptings.ts:1041`).
  - Ordinary safe APIs cover chat variables, chat mutation, tokenization, alerts, reloads, and CBS parsing (`src/ts/process/scriptings.ts:105`, `src/ts/process/scriptings.ts:154`, `src/ts/process/scriptings.ts:212`, `src/ts/process/scriptings.ts:245`, `src/ts/process/scriptings.ts:267`).
  - Low-level APIs include similarity search, constrained HTTPS GET, image generation, main/auxiliary LLM calls, and active-lore loading (`src/ts/process/scriptings.ts:284`, `src/ts/process/scriptings.ts:294`, `src/ts/process/scriptings.ts:363`, `src/ts/process/scriptings.ts:472`, `src/ts/process/scriptings.ts:789`, `src/ts/process/scriptings.ts:832`).
  - The Lua wrapper supplies `getChat`, `getFullChat`, `LLM`, `axLLM`, `listenEdit`, `getState`, and coroutine-based `async` helpers (`src/ts/process/scriptings.ts:1211`).
  - `runLuaEditTrigger()` maps regex-style modes to Lua listener names and intentionally ignores `editprocess` (`src/ts/process/scriptings.ts:1376`).
  - `runLuaButtonTrigger()` invokes `onButtonClick` across Lua triggers (`src/ts/process/scriptings.ts:1419`).
  - `PyodideContext` runs experimental Python in a worker and proxies declared APIs (`src/ts/process/scriptings.ts:1444`).
  - Cached engines receive the current run's runtime-only `moduleId` while their mutex is
    held. Nested `LLM`/`axLLM` calls use it to resolve per-module model bindings.

- `src/ts/process/triggers.ts` — `triggerscript` defines event type, conditions, effects, and optional low-level access (`src/ts/process/triggers.ts:21`).
  - `triggerscript.moduleId` is runtime-only ownership metadata used for per-module model
    binding; character-owned triggers leave it undefined (`src/ts/process/triggers.ts:21`).
  - `triggerEffect` combines legacy V1 actions, Lua/code entries, and V2 actions (`src/ts/process/triggers.ts:31`).
  - V1 condition and action shapes occupy the beginning of the file; V2’s structured control-flow/action types begin with `triggerV2Header` (`src/ts/process/triggers.ts:177`).
  - `displayAllowList` and `requestAllowList` restrict these side-effect-sensitive modes to state inspection/mutation plus a safe calculation subset (`src/ts/process/triggers.ts:986`, `src/ts/process/triggers.ts:1024`, `src/ts/process/triggers.ts:1030`).
  - `runTrigger()` is the sole trigger interpreter (`src/ts/process/triggers.ts:1046`).
  - Trigger variables resolve local scopes first, then chat `scriptstate`, then character/template defaults (`src/ts/process/triggers.ts:1085`, `src/ts/process/triggers.ts:1157`).
  - Conditions support variable/value comparisons, chat index tests, and strict/loose/regex history existence checks (`src/ts/process/triggers.ts:1218`, `src/ts/process/triggers.ts:1277`).
  - Effects are filtered through display/request allowlists before dispatch (`src/ts/process/triggers.ts:1299`).
  - Legacy low-level actions include alerts, nested LLM calls, similarity, regex extraction, and image generation (`src/ts/process/triggers.ts:1406`).
  - Lua effects delegate to `runScripted()` and propagate modified chat/stop state (`src/ts/process/triggers.ts:1527`).
  - V2 control flow uses indentation, scoped locals, explicit end markers, and loop rewinding (`src/ts/process/triggers.ts:1586`, `src/ts/process/triggers.ts:1593`, `src/ts/process/triggers.ts:1718`).
  - The returned result carries prompt injections, chat, token cost, stop/resend flags, display/request data, and temporary state (`src/ts/process/triggers.ts:2811`).

- `src/ts/process/modules.ts` — `getModuleTriggers()` clones active-module triggers and
  attaches their owning module's `lowLevelAccess` and `moduleId`; it does not mutate the
  cached module objects (`src/ts/process/modules.ts:465`).

- `src/ts/translator/translator.ts` — `applyEdittransRegex()` is a separate, direct regex
  path for translated text. Its compatibility order is preset, module, then character,
  not the main pipeline's preset, character, then module order
  (`src/ts/translator/translator.ts:676`).

### Plugin framework

- `src/ts/plugins/plugins.svelte.ts` — `RisuPlugin` stores source, metadata headers,
  arguments, API version, update URL, enablement, and IPC allowlist.
  - `importPlugin()` parses plugin headers, optionally transpiles TypeScript, applies V2.1
    safety checks, and persists/reloads the plugin.
  - Supported API headers are `2.0`, `2.1`, and `3.0`; missing `//@api` defaults to 2.0
    behavior.
  - `loadPlugins()` serializes teardown and reload, then divides enabled plugins into
    V2/V2.1 and V3 generations.
  - `pluginV2` is the shared registry for providers, edit handlers, before/after request
    replacers, and unload callbacks.
  - Plugin-list changes reload under a serialized transaction. Imports and enables roll back on target-plugin startup, teardown, unattributed lifecycle, or persistence failure; startup failures attributed to unchanged V3 plugins are reported without undoing a healthy target mutation. The default-on legacy compatibility policy downgrades teardown-only failures to warnings.
  - `getV2PluginAPIs()` exposes model registration, script/replacer registration, limited
    database access, safe globals/storage/document wrappers, and asset operations.
  - `addProvider()` registers a provider callback and optional tokenizer metadata.
  - `loadV2Plugin()` performs a serialized V2 teardown and generation load. V2.1 source
    and allowed V2.0 source execute through an async-IIFE `new Function()` wrapper; the
    wrapper promise is not awaited, so asynchronous top-level failures are not tracked by
    the loader. V2.0 additionally requires `allowV2Plugin`.
  - V2 teardown starts all unload callbacks within one five-second generation grace, revokes captured host facades when the grace closes, and releases the global lifecycle queue even if a callback never settles. Disable/removal records are durably committed before cleanup and reconciled again before the next generation loads.

- `src/ts/plugins/pluginSafety.ts` — `checkCodeSafety()` parses V2.1 source with Acorn, rewrites sensitive globals, and caches the transformed result by source hash/checker version (`src/ts/plugins/pluginSafety.ts:59`).
  - It rejects direct `eval`, `new Function`, `sessionStorage`, and `cookieStore` (`src/ts/plugins/pluginSafety.ts:21`).
  - Identifiers such as `window`, `globalThis`, `localStorage`, `indexedDB`, `document`, `Function`, `prototype`, and `constructor` are rewritten to safe aliases (`src/ts/plugins/pluginSafety.ts:96`).
  - The checker explicitly appends a static-analysis limitation warning, making user review part of the V2.1 import path (`src/ts/plugins/pluginSafety.ts:155`).

- `src/ts/plugins/pluginSafeClass.ts` — `SafeLocalStorage` places V2 storage in the shared
  `safe_plugin_` localStorage namespace.
  - `SafeLocalPluginStorage` provides asynchronous persistent storage for V3 and records
    best-effort owner metadata on writes.
  - `SafeIdbFactory` prefixes IndexedDB database names with `safe_plugin_`.
  - `tagWhitelist` controls DOM element creation.
  - The V2 `SafeDocument` restricts element creation, anchors, and event names, although
    many query operations still return underlying DOM objects.

- `src/ts/plugins/pluginMemoryOptimization.ts` — Encodes the compatibility gate for `optimizePluginMemory`: enabled V2/V2.1 plugins block the mode, imports of those versions are disabled while it is active, and attempts to enable them are refused. V3 plugins remain compatible because their save API is asynchronous.

- `src/lib/Setting/Pages/PluginSettings.svelte` — Provides per-plugin Grant/Revoke/Ask
  permission controls and reset actions. Durable permission state lives at
  `cache/plugin-permissions/state.json`. Storage-mode controls are covered by [Plugin
  storage](plugin-storage.md).

- `src/ts/plugins/apiV3/factory.ts` — `GUEST_BRIDGE_SCRIPT` constructs the iframe-side
  `risuai`/`Risuai` proxy and RPC protocol.
  - Callback functions, abort signals, transferable streams, and remote class instances
    have explicit bridge representations.
  - `createV3BridgeRequestRegistry()` assigns generation-unique request IDs. Ordinary RPC
    requests have no blanket deadline or concurrency cap; they remain pending until the
    host responds or guest lifecycle cancellation calls `cancelAll()`.
  - `SandboxHost` owns iframe lifecycle and host-side dispatch.
  - Strict teardown blocks ordinary RPC but treats the signal passed to `onUnload` as a bounded capability for storage plus database/state, global UI removal/restoration, network, and asset finalization. Legacy compatibility also accepts the unchanged no-signal shape for that finalization surface during its five-second drain. Plugin replacement, new registrations, non-empty UI construction, model work, and chat sends remain closed.
  - Remote-required instances are stored in an instance registry and surfaced as proxy references.
  - `run()` applies an iframe sandbox allowing scripts, modals, and downloads, plus a CSP
    with `connect-src 'none'`, then executes the bridge and plugin source in `srcdoc`. The
    CSP blocks iframe-originated fetch/XHR/WebSocket connections; it does not make every
    resource type or download inert.
  - V3 startup has separate readiness and lifetime phases: `readiness` resolves after the bridge launches the plugin body, while `run()` follows the complete top-level promise. This prevents long-lived service work from retaining bootstrap or the lifecycle queue; late failures are observed and cleaned up in the background.
  - `terminate()` removes the iframe and clears remote, callback, request, and stream state.

- `src/ts/plugins/apiV3/v3.svelte.ts` — `SafeElement` exposes remotely proxied DOM
  operations; HTML setters use DOMPurify. `SafeDocument` restricts created tags and
  sanitizes anchor protocols.
  - `unloadV3PluginInstance()` removes the instance and globally reachable registrations
    before invoking the separately captured unload callbacks.
  - V3 unload uses a one-second strict grace period or a five-second legacy-compatibility
    grace period. Storage mutations admitted through the unload capability drain after
    that callback grace, then both paths forcibly terminate the iframe.
  - Permission-backed capabilities are `fetchLogs`, `db`, `mainDom`, `replacer`,
    `provider`, and `sendChat`. Explicit decisions use collision-free JSON
    `[pluginName, permission]` keys; source-hash grants and periodic reconfirm timestamps
    are additional caches, not part of the decision key.
  - `resetPluginPermission()` clears the plugin's exact and legacy decision keys, current
    reconfirm timestamps, and cache entries for its currently installed source hash.
  - `makeRisuaiAPIV3()` constructs the host API.
  - Major API groups include:
    - restricted fetch and asset APIs;
    - provider and TTS-hook registration;
    - database, character, chat, lorebook, theme, and argument access;
    - iframe/main-DOM and settings/button/chat-panel UI;
    - request-body interceptors and MCP registration;
    - save/local/persistent plugin storage and ownership tracking;
    - direct LLM invocation, user-message sending, and mutually allowed plugin IPC.
  - `loadV3Plugins()` unloads all current instances before parallel readiness handshakes.
  - `executePluginV3()` creates the hidden iframe, waits for the readiness/body-start
    handshake without a time deadline, then observes its top-level lifetime independently;
    a late rejection removes the failed instance under the serialized lifecycle lock.

- `src/ts/plugins/apiV3/risuai.d.ts` — Authoritative developer-facing V3 type surface.
  Primary APIs and remotely proxied operations are promise-based; retained compatibility
  aliases include a few synchronous-looking declarations.
  - MCP declarations begin near the top of the file, `PluginStorage` defines the complete
    save-storage surface, and `RisuaiPluginAPI` assembles provider, TTS, scripts,
    replacers, MCP, LLM, storage, UI, and IPC declarations.
  - Save-storage helpers are grouped by purpose: `generations.publish()`, `load()`, and
    `garbageCollect()` manage immutable multi-row publications; `readItem()` and
    `setFromRead()` preserve explicit read outcomes, while `atomicBatch()`,
    `rewriteItem()`, and `updateItem()` provide compound, replacement, and guarded
    transform mutations; `setItemWithOutcome()`, `removeItemWithOutcome()`, and
    `removeItemConfirmed()` expose acknowledgement ambiguity and authoritative-removal
    confirmation. See [plugin storage](plugin-storage.md) for their storage semantics.

- `src/ts/plugins/apiV3/developMode.ts` — `hotReloadPluginFiles()` polls a selected JS/TS file every 500 ms and re-imports it; only V3 hot reload is accepted by `importPlugin()` (`src/ts/plugins/apiV3/developMode.ts:5`, `src/ts/plugins/apiV3/developMode.ts:32`).

- `src/ts/plugins/apiV3/transpiler.ts` — `pluginCodeTranspiler()` strips TypeScript syntax with Sucrase (`src/ts/plugins/apiV3/transpiler.ts:1`).

### MCP support

- `src/ts/process/mcp/mcp.ts` — `MCPs` is the live client registry keyed by module URL/identifier (`src/ts/process/mcp/mcp.ts:16`).
  - `initializeMCPs()` reconciles active-module MCP URLs, additional request URLs,
    internal clients, plugin clients, and remote HTTP clients
    (`src/ts/process/mcp/mcp.ts:18`).
  - Internal identifiers are dispatched at `src/ts/process/mcp/mcp.ts:33`; plugin clients at `src/ts/process/mcp/mcp.ts:71`; remote/`stdio:` URL handling at `src/ts/process/mcp/mcp.ts:79`.
  - `getMCPTools()` aggregates tool schemas and tags each with its source URL (`src/ts/process/mcp/mcp.ts:137`).
  - `callMCPTool()` searches clients by tool name and calls the first match (`src/ts/process/mcp/mcp.ts:162`).
  - `getTools()`/`callTool()` are model-request-facing wrappers (`src/ts/process/mcp/mcp.ts:178`, `src/ts/process/mcp/mcp.ts:183`).
  - `encodeToolCall()` persists the full call/response outside chat and returns a compact
    `<tool_call>` marker for the message; `decodeToolCall()` resolves that marker
    (`src/ts/process/mcp/mcp.ts:259`, `src/ts/process/mcp/mcp.ts:266`).

- `src/ts/process/mcp/mcplib.ts` — Defines MCP prompt/tool/JSON-RPC and multimodal result types (`src/ts/process/mcp/mcplib.ts:5`, `src/ts/process/mcp/mcplib.ts:16`, `src/ts/process/mcp/mcplib.ts:23`, `src/ts/process/mcp/mcplib.ts:53`).
  - `MCPToolHandler` is the handler base used by Risu-access tools (`src/ts/process/mcp/mcplib.ts:75`).
  - `MCPClient` implements remote HTTP/SSE MCP transport (`src/ts/process/mcp/mcplib.ts:80`).
  - `request()` handles JSON-RPC, sessions, bearer authentication, streamed responses, and custom transports (`src/ts/process/mcp/mcplib.ts:228`).
  - `handshake()` tries protocol `2025-03-26`, then falls back from streamed HTTP to legacy SSE `2024-11-05` on HTTP 404 (`src/ts/process/mcp/mcplib.ts:491`).
  - OAuth discovery/registration/PKCE handling begins at `src/ts/process/mcp/mcplib.ts:607`.
  - `getToolList()` paginates `tools/list` and reuses a non-empty result for the client
    lifetime (`src/ts/process/mcp/mcplib.ts:782`).
  - `callTool()` sends `tools/call` and normalizes RPC errors into text results (`src/ts/process/mcp/mcplib.ts:822`).

- `src/ts/process/mcp/internalmcp.ts` — `MCPClientLike` is the common adapter for built-in and plugin-provided tools (`src/ts/process/mcp/internalmcp.ts:8`).

- `src/ts/process/mcp/pluginmcp.ts` — `CustomPluginMCPClient` adapts V3 plugin callbacks to `MCPClientLike` (`src/ts/process/mcp/pluginmcp.ts:6`).
  - `registerMCPModule()` requires a `plugin:` identifier and stores the client in `registeredCustomPluginMCPs` (`src/ts/process/mcp/pluginmcp.ts:36`).
  - `unregisterMCPModule()` removes the registration (`src/ts/process/mcp/pluginmcp.ts:56`).

- `src/ts/process/mcp/risuaccess/client.ts` — `RisuAccessClient` combines character, chat, and module handlers and publishes detailed Risu-specific instructions (`src/ts/process/mcp/risuaccess/client.ts:7`).
  - Tools are aggregated and dispatched through the handlers at `src/ts/process/mcp/risuaccess/client.ts:76` and `src/ts/process/mcp/risuaccess/client.ts:84`.

- `src/ts/process/mcp/risuaccess/characters.ts` — `CharacterHandler` exposes character listing/info, lorebook, regex, Lua, and asset mutation tools (`src/ts/process/mcp/risuaccess/characters.ts:9`).
  - Tool schemas begin at `src/ts/process/mcp/risuaccess/characters.ts:14`; dispatch begins at `src/ts/process/mcp/risuaccess/characters.ts:335`.
  - Successful mutations call `markCharacterDirty()` for the targeted character so
    externalized character records are included in the next persistence flush.

- `src/ts/process/mcp/risuaccess/chats.ts` — `ChatHandler` exposes `risu-get-chat-history` (`src/ts/process/mcp/risuaccess/chats.ts:5`).

- `src/ts/process/mcp/risuaccess/modules.ts` — `ModuleHandler` exposes module info plus lorebook, regex, and Lua read/write/delete tools (`src/ts/process/mcp/risuaccess/modules.ts:14`).
  - Tool schemas begin at `src/ts/process/mcp/risuaccess/modules.ts:19`; dispatch begins at `src/ts/process/mcp/risuaccess/modules.ts:307`.

- Built-in provider clients:
  - `src/ts/process/mcp/aiaccess.ts` — `AIAccessClient` exposes nested main/aux LLM calls through `runLLM` (`src/ts/process/mcp/aiaccess.ts:7`, `src/ts/process/mcp/aiaccess.ts:53`).
  - `src/ts/process/mcp/dice.ts` — `DiceClient` exposes `rollDice` (`src/ts/process/mcp/dice.ts:4`).
  - `src/ts/process/mcp/graphmem.ts` — `GraphMemClient` stores graph memory in chat variables and searches it with embeddings (`src/ts/process/mcp/graphmem.ts:12`, `src/ts/process/mcp/graphmem.ts:87`, `src/ts/process/mcp/graphmem.ts:111`).
  - `src/ts/process/mcp/googlesearchclient.ts` — prompts for Custom Search credentials and exposes web/image search (`src/ts/process/mcp/googlesearchclient.ts:31`, `src/ts/process/mcp/googlesearchclient.ts:43`, `src/ts/process/mcp/googlesearchclient.ts:66`).
  - `src/ts/process/mcp/filesystemclient.ts` — scopes file operations to a user-selected File System Access API directory and exposes read/write/search/copy/move/info/tree tools (`src/ts/process/mcp/filesystemclient.ts:4`, `src/ts/process/mcp/filesystemclient.ts:15`, `src/ts/process/mcp/filesystemclient.ts:39`, `src/ts/process/mcp/filesystemclient.ts:252`).

## 3. Architecture & data flow

### CBS flow

1. A caller invokes `risuChatParser(text, context)` (`src/ts/parser/parser.svelte.ts:1705`).
2. On first use, `initMatcher()` calls `registerCBS()` and fills `matcherMap` with executable built-ins and aliases (`src/ts/parser/parser.svelte.ts:1152`).
3. The character-by-character parser builds nested buffers for expressions and block bodies (`src/ts/parser/parser.svelte.ts:1737`).
4. Simple expressions go through `matcher()`, which normalizes the function name and dispatches its callback (`src/ts/parser/parser.svelte.ts:1202`).
5. Block syntax bypasses the registry and goes through `blockStartMatcher()`/`blockEndMatcher()` (`src/ts/parser/parser.svelte.ts:1831`, `src/ts/parser/parser.svelte.ts:1862`).
6. Stateful callbacks may update temporary variables or chat/global variables; `{{return}}` sets `__force_return__`, causing immediate parser return (`src/ts/parser/parser.svelte.ts:1933`).

CBS is applied repeatedly throughout prompt construction and scripting. In particular,
`processScriptFull()` parses the entire incoming string before its cache lookup and regex
execution. Ordinary replacement and move actions reparse their transformed result;
emotion, injection, and repeat-back actions do not uniformly do so
(`src/ts/process/scripts.ts:138`, `src/ts/process/scripts.ts:184`).

### Regex and edit pipeline

The canonical order inside `processScriptFull()` is:

1. Lua edit listener (`runLuaEditTrigger`).
2. Display trigger, but only for `editdisplay`.
3. V2/V3 plugin edit handlers from the shared `pluginV2` registry.
4. CBS parsing.
5. Build the preset, character, then active-module regex list and check the transformation
   cache.
6. On a miss, run the regex list, optionally globally reordered by `<order n>`.
7. Optional dynamic-asset fuzzy correction.
8. Result caching.

The hook and cache ordering is concrete in `processScriptFull()` at
`src/ts/process/scripts.ts:103-149`; regex execution and final cache publication follow
in the same function.

Pipeline call sites are:

- `editprocess`: the first greeting through `processScript()`, then each stored history
  message through `processScriptFull()` while constructing the model prompt
  (`src/ts/process/index.svelte.ts:850-885`). The Hypa preview always applies CBS and
  optionally applies this mode through `processMessageForPreview()`
  (`src/lib/Others/HypaV3Modal/utils.ts:104`).
- `editoutput`: cumulative streaming text at a cadence selected by
  `streamingDisplayOptimizationMode`: every provider snapshot in `off`, coalesced flushes
  in `balanced`, or one final full pass in `strong`. Non-streaming success/multiline
  messages are processed individually, with an additional combined-content pass for a
  continuation (`src/ts/process/index.svelte.ts:1548-1681`,
  `src/ts/process/index.svelte.ts:1718-1731`).
- `editdisplay`: rendered chat messages through `ParseMarkdown()` when a character is
  available, before inlay/tool rendering and markdown sanitization
  (`src/ts/parser/parser.svelte.ts:914-943`). This is a rendering path, but historical
  actions such as `@@inject` can still mutate chat state.
- `editinput`: `applyChatInputToTarget()` runs it for non-empty character-chat input after
  publishing any input-trigger chat changes and immediately before appending the user
  message (`src/ts/process/chatSendTarget.ts:124-168`). Empty input and non-character
  targets bypass this hook.
- `edittrans`: translation uses its own direct regex loop rather than
  `processScriptFull()` (`src/ts/translator/translator.ts:676`). When
  `reprocessDisplayScript` is enabled, translated display fragments separately pass
  through `processScriptFull(..., 'editdisplay')`
  (`src/ts/translator/translator.ts:407-417`).

### Trigger flow and versions

Trigger “versions” are structural rather than a `version` field:

- V1 consists of legacy effect types such as `setvar`, `modifychat`, `systemprompt`, and `runLLM`.
- V2 is identified in the editor by a leading `v2Header`, but `runTrigger()` interprets the individual V2 effect types in the same switch as V1.
- Lua mode is identified by a leading `triggerlua` effect and delegates to `runScripted()`.
- `triggercode` remains in the type union and mode-detection logic but has no execution case in `runTrigger()`.

Runtime event points are:

- `start`: after the processed first greeting is added to the prompt but before stored
  history is processed (`src/ts/process/index.svelte.ts:850-883`). Its returned chat is
  published and the history list rebuilt before prompt construction continues.
- `output`: after edited response text is stored, for both streaming and non-streaming
  flows (`src/ts/process/index.svelte.ts:1698`, `src/ts/process/index.svelte.ts:1785`).
  Streaming runs it before inlay expansion; non-streaming applies inlays before the
  trigger.
- `display`: from `processScriptFull()` while rendering (`src/ts/process/scripts.ts:105`).
- `request`: on every request attempt after plugin before-replacers and before provider
  dispatch (`src/ts/process/request/request.ts:164-201`). Tool resolution—from explicit
  `arg.tools` or MCP discovery—occurs once before the retry/fallback loops.
- `manual`: from `/trigger` and recursive run-trigger effects
  (`src/ts/process/command.ts:228`, `src/ts/process/triggers.ts:1383`).
- `input`: `applyChatInputToTarget()` invokes the character trigger before `editinput`.
  It publishes the returned chat to the durable send target before awaiting the edit hook
  and eventually appending the user message (`src/ts/process/chatSendTarget.ts:124-168`).

Outside display mode, `runTrigger()` owns one isolated chat clone for the whole trigger
run. Message edits, author-note changes, `scriptstate` setters, and getter `outputVar`
writes stay on that clone until the caller performs one guarded publication; they do not
write through to the durable row while the trigger awaits. An intentional intermediate
multisend publication refreshes the returned source guard after its child turn so final
publication can distinguish that owned transition from external interference. Character
description and lorebook side effects remain immediate compatibility actions, but resolve
their owner by stable `chaId` and update only the affected owner field instead of replacing
the selected character or its chat graph (`src/ts/process/triggers.ts`,
`src/ts/process/command.ts`).

The source guard is continuous across the entire trigger call graph. Input, manual,
start, and both streaming and non-streaming output callers capture it before execution
and publish with the returned guard (or that initial guard when no owned transition
replaced it). V1/V2 recursive triggers and slash `/trigger` pass it into nested runs.
Command pipelines receive the incoming guard; every intermediate multisend publication
consumes it, and only a successful owned child turn refreshes it. A stale intermediate
publication aborts the pipeline before the nested send or backup-reason callback. Display
and request triggers do not use this durable guard because their allowed results remain
temporary display/request state and are never published as a chat row
(`src/ts/process/index.svelte.ts`, `src/lib/ChatScreens/Chat.svelte`,
`src/lib/ChatScreens/DefaultChatScreen.svelte`, `src/ts/process/command.ts`).

Trigger-targeted and ordinary multisend commands also respect per-chat generation
ownership. A pre-existing generation rejects the nested send before message mutation,
chat publication, or backup-reason queuing. Otherwise `sendChat()` registers its
generation synchronously; the command captures that entry's opaque ownership token and
conditionally releases only the entry still carrying that token in `finally`. Auto-
continue/resend atomically exchanges the matching entry for a one-shot handoff carrying
that token and its abort controller directly into the recursive call, even though the
request generation ID changes. A replacement-owner mismatch prevents recursion, and a
restart rejected before registration cancels the handoff instead of leaving ambient
ownership or an abort controller for an unrelated later send.
False/early rejection that acquired nothing performs no cleanup, and an entry installed
by another owner after the nested send ended is preserved, so a start/output trigger
cannot remove its outer send's guard or a same-key replacement
(`src/ts/process/command.ts`, `src/ts/process/generationState.ts`).

Direct request roots outside the main chat UI wrapper use the same exact-owner rule.
V3 plugin child sends, hotkey prompt preview, DevTool preview and autopilot, and every PO
file multisend iteration install a synchronous registration observer around their
`sendChat()` call, capture the exact emitted token even if it is ended/replaced before the
call returns, and conditionally conclude it in `finally`. This
preserves other chats and same-key replacements on success, false, formatting errors, or
request exceptions (including synchronous throws), and prevents the final batch iteration
from leaking its entry. A PO batch also captures its initial character/chat IDs and
re-resolves that durable owner before every iteration and after each send; navigation or
downloads cannot redirect later entries into the newly selected character, and a missing
or placeholder owner aborts the batch without mutating another row.
`endAllGenerations()` is reserved for intentional global administrative reset; no
production per-request root uses it (`src/ts/process/generationState.ts`,
`src/ts/plugins/apiV3/pluginChatSend.ts`, `src/ts/hotkey.ts`,
`src/lib/SideBars/DevTool.svelte`, `src/ts/process/files/multisend.ts`).

Character triggers inherit the character’s separate `lowLevelAccess` and
`destructiveAccess` capabilities; cloned module triggers carry their owning module's
flags and runtime-only `moduleId` (`src/ts/process/triggers.ts`,
`src/ts/process/modules.ts`). Card, module, and CharX imports inspect V1/V2 cuts, V2 lore
deletion, Lua `cutChat`/`removeChat`/`setFullChat` APIs, and literal trigger-command
pipelines containing `/cut`, `/del`, or `/multisend clear`; these require explicit
destructive consent. Dynamically computed V1/V2 commands are reclassified and gated at
execution. Trigger commands execute against the chat snapshot and durable character/chat
IDs captured at trigger start, never the mutable UI selection. CharX also preserves an embedded module's declared request before
clearing it for that consent decision, covering dynamically aliased Lua calls that a
static scan cannot identify. Capability grants are recognized only when the owner value
is the literal boolean `true`. That consent does not grant model, network, UI, or other
low-level APIs. Display/request modes operate on temporary state and
explicit allowlists, preventing most chat, network, UI, and model side effects
(`src/ts/process/triggers.ts:1178`, `src/ts/process/triggers.ts:1308`).

### Lua flow

`runScripted()` reuses one engine per mode, recreating it only when source changes
(`src/ts/process/scriptings.ts:78`, `src/ts/process/scriptings.ts:91`). It injects host
functions, loads the wrapped Lua source, grants per-run safe, low-level, and destructive
access keys, and invokes the mode callback. Safe, low-level, and destructive keys are
removed after normal completion; edit-display keys
are currently not removed from `ScriptingEditDisplayIds`
(`src/ts/process/scriptings.ts:1041-1143`).

Lua edit listeners register through `listenEdit(type, func)` and are called through `callListenMain` (`src/ts/process/scriptings.ts:1265`, `src/ts/process/scriptings.ts:1329`). Edit-display keys receive only the reduced display-safe capability set; low-level keys are granted only when the owning character/module permits them (`src/ts/process/scriptings.ts:1030`).

Lua edit and button hooks execute chat-mutating host APIs against an isolated working
clone rather than the durable chat object. After every awaited hook completes, a changed
clone is published once to the character/chat IDs captured before execution. Repeated
hooks resolve the current durable row for those IDs before each run. Publication also
requires that the captured source object and its pre-run state are still current, so a
same-ID replacement or in-place concurrent edit makes the hook result stale instead of
overwriting newer messages; a missing target or unchanged clone is discarded. For destructive changes, the forced
`script-bulk-chat` backup reason is queued synchronously immediately before that durable
replacement, so the reactive save path cannot persist the replacement before its
required pre-image reason exists (`src/ts/process/scriptings.ts`,
`src/ts/process/chatSendTarget.ts`).

Regular module trigger LLM actions, Lua effects, and Lua button callbacks propagate their
runtime-only `moduleId`, so nested model calls can honor `Database.moduleModelBindings`.
Lua edit listeners are different: `runLuaEditTrigger()` forces low-level access off and
does not currently pass module ownership into `runScripted()`
(`src/ts/process/scriptings.ts:1376`).

### Plugin load and provider flow

1. `importPlugin()` parses metadata and persists a `RisuPlugin` record in
   `src/ts/plugins/plugins.svelte.ts`.
2. `loadPlugins()` tears down the old V2 and V3 generations, selects enabled plugins,
   and routes them by API version under the lifecycle lock.
3. V2.1 source is AST-rewritten and executed in the page with safe aliases; V2.0 uses
   the same page execution mechanism without the rewrite and is disabled by default.
4. V3 source runs in a sandboxed iframe. API operations cross the `SandboxHost` RPC
   bridge to `makeRisuaiAPIV3()`.
5. Plugins add providers through `addProvider()`, which stores the callback in
   `pluginV2.providers`. V3 additionally constructs an `LLMModel` with ID
   `pluginmodel:::<name>` and adds it to `customV3ProviderMetaStore`.
6. `getModelInfo()` and `getModelList()` in `src/ts/model/modellist.ts` surface those V3
   model records.
7. Request dispatch in `src/ts/process/request/request.ts` recognizes
   `LLMFormat.Plugin`, resolves the provider name, and invokes its callback with formatted
   messages, model parameters, and the abort signal.
8. Provider output may be a string or `ReadableStream<string>` and is adapted back into
   PocketRisu's request result format.

### Plugin storage compatibility boundary

V2/V2.1 plugins have a synchronous save-storage facade and therefore require inline
storage. `pluginMemoryOptimization.ts` blocks those plugins while
`Database.optimizePluginMemory` is enabled. V3 storage is asynchronous and works with
either backend; it exposes basic, versioned, guarded, batch, outcome, and immutable-
generation helpers through the iframe bridge.

`Database.autoConvertPluginStorageValues` is independent of the optimization toggle. It
allows documented compatible-value conversion for ordinary optimized writes and mode
externalization, but it neither makes V2/V2.1 compatible with optimized storage nor
relaxes strict versioned/compound writes. Plugin reloads and storage-mode transitions
share the lifecycle lock, so teardown/startup cannot race a backend publication change.

Current clients prepare mode transitions as consolidated binary bodies and send them to
`POST /api/plugin-storage/transition/bulk` with the internal
`application/x-pocketrisu-plugin-storage-transition` content type. The legacy non-bulk
`POST /api/plugin-storage/transition` route is retired and responds with structured HTTP
426 upgrade-required instead of performing a transition. This transport is host/server
plumbing and does not change the public V3 plugin API.

See [plugin storage](plugin-storage.md) for persistence authority, conversion details,
generation/batch rules, transition framing and fallback, recovery, backups, viewer
semantics, and safe mutation-outcome handling.

### MCP-to-model flow

1. Every `requestChatData()` call resolves tools from `arg.tools` or `getTools()` before retries begin (`src/ts/process/request/request.ts:136-139`).
2. `getTools()` calls `getMCPTools()`, which initializes active-module MCPs and aggregates their JSON schemas (`src/ts/process/mcp/mcp.ts:137`, `src/ts/process/mcp/mcp.ts:178`).
3. Active-module MCP URLs come from `getModuleMcps()` (`src/ts/process/modules.ts:514`). Internal, plugin, and remote clients all satisfy the same `getToolList()`/`callTool()` interface.
4. Classic OpenAI-compatible, Anthropic, and Gemini request paths put those schemas into their provider-specific tool format. When the model emits a tool call, they invoke `callTool()` and recursively request the model with a tool-result message (`src/ts/process/request/openAI/requests.ts:706`, `src/ts/process/request/anthropic.ts:986`, `src/ts/process/request/google.ts:868`).
5. ModelPreset adapters expose tools only when the preset opts into tool use, the adapter supports tools, and the profile explicitly declares the `tools` capability (`src/ts/process/request/request.ts:735-754`).
6. ModelPreset tool calls run through `runModelPresetToolLoop()` and `executeModelPresetTool()` with a maximum of eight non-streaming tool rounds (`src/ts/process/request/request.ts:1077`, `src/ts/process/request/request.ts:1128`).
7. When `rememberToolUsage` is enabled, the call and response are persisted and the assistant message receives a compact `<tool_call>id…name</tool_call>` marker (`src/ts/process/mcp/mcp.ts:259`). Later requests decode the marker back into structured tool history; display rendering replaces it with a tool-used badge (`src/ts/process/mcp/mcp.ts:266`, `src/ts/parser/parser.svelte.ts:898`).

The ModelPreset tool path is deliberately browser-side and non-streaming. Tool-bearing
requests and body previews do not use the server-side model-job route; only tool-free,
non-preview ModelPreset requests are eligible (`src/ts/process/request/request.ts:752-837`).

## 4. Entry points & dependencies

### Called by other subsystems

- Prompt construction calls CBS, `editprocess`, and start triggers from
  `src/ts/process/index.svelte.ts:850-885`.
- Response handling calls `editoutput` and output triggers from
  `src/ts/process/index.svelte.ts:1548-1698` and
  `src/ts/process/index.svelte.ts:1718-1785`.
- Markdown rendering calls the display script stack from `src/ts/parser/parser.svelte.ts:903-943`.
- Request dispatch calls plugin replacers, request triggers, MCP discovery, and provider plugins from `src/ts/process/request/request.ts:136-230`.
- Slash commands call manual triggers from `src/ts/process/command.ts:228`.
- The translator applies its direct `edittrans` regex path after translation and, when
  configured, reprocesses translated display fragments through `editdisplay` in
  `src/ts/translator/translator.ts`.
- Plugin initialization is ultimately driven by database/application startup through
  `loadPlugins()` in `src/ts/plugins/plugins.svelte.ts`.
- Model selection reads plugin model metadata through `src/ts/model/modellist.ts:752`.
- Tokenization reads plugin tokenizer configuration through `src/ts/tokenizer.ts:73` and `src/ts/tokenizer.ts:142`.

### Calls into other subsystems

- CBS reads characters, personas, lorebooks, model metadata, global/chat variables, and module state.
- Regex scripting reads preset/character/module scripts, controls emotion stores, and calls the embedding subsystem for dynamic asset matching.
- Triggers mutate chat/database state and call commands, alerts, tokenization, embeddings, image generation, inlay storage, and model requests.
- Lua scripts call the same model, lorebook, tokenizer, image, file/inlay, and UI services through guarded host functions.
- Plugins depend on database persistence, menus/stores, themes, request dispatch, TTS hooks, assets, and MCP registration.
- Remote MCP uses `fetchNative`, OAuth browser flow, alert input, and persistent authentication records.
- Risu-access MCP writes character/module/database data directly through its handlers;
  character mutations call `markCharacterDirty()` so externalized character persistence
  observes them.
- Filesystem MCP depends on browser File System Access APIs and the PDF-to-image helper.

## 5. Conventions & gotchas

- CBS registration is dependency-injected. Adding a callback only to `cbs.ts` is sufficient for the main parser because `initMatcher()` wires it, but special block syntax must be implemented in `blockStartMatcher()`/`blockEndMatcher()`, not as an ordinary callback.

- CBS names are compatibility-normalized: case, spaces, underscores, and hyphens are ignored (`src/ts/parser/parser.svelte.ts:1222`). Avoid adding names whose normalized forms collide.

- `doc_only` CBS entries intentionally do not enter `matcherMap` (`src/ts/parser/parser.svelte.ts:1163`). They document syntax handled elsewhere, especially assets and block constructs.

- CBS is synchronous. Registration callbacks cannot return promises, even when their data sources are otherwise asynchronous.

- Stateful CBS operations honor contextual flags. Variable writes generally require `runVar`; display/tokenization contexts may suppress randomness or side effects. Preserve these guards when extending built-ins.

- The parser silently catches ordinary matcher callback exceptions and leaves unknown expressions untouched (`src/ts/parser/parser.svelte.ts:1209`, `src/ts/parser/parser.svelte.ts:1926`). A malformed new callback may fail invisibly.

- Regex-script ordering is preset, then character, then all active modules unless an
  enabled custom flag supplies `<order n>`, which causes a global descending sort
  (`src/ts/process/scripts.ts:139`, `src/ts/process/scripts.ts:338`). Active modules can
  come from global, chat, character, persona-embedded, or integration configuration.

- Regex-script cache lookup happens after Lua/display-trigger/plugin hooks and CBS but
  before regex execution and dynamic-asset matching. Keys include that transformed data,
  mode, matching scripts' input/output/flag state, numeric `chatID`, and CBS-expanded
  patterns, but omit character identity, hook dependencies, dynamic-asset state, and
  other mutable data a CBS callback may read (`src/ts/process/scripts.ts:72`). A cache hit
  also reports `emoChanged: false`.

- Cache lookup uses `if(cached)`, so an intentionally empty cached result is treated as a miss (`src/ts/process/scripts.ts:142`).

- `resetScriptCache()` clears the main transformation cache but not the separate
  `bestMatchCache` used by dynamic-asset fuzzy correction.

- With a nonnegative `chatID`, `@@inject` writes the pre-replacement data to that message
  index in the currently selected character/chat—not necessarily the `char` argument—and
  removes the matching text from the returned string
  (`src/ts/process/scripts.ts:212`). This is historical behavior, not conventional regex
  replacement.

- Each regex script is isolated in a `try`/`catch`; an invalid pattern or replacement
  logs an error and execution continues with later scripts.

- Streaming `editoutput` cadence follows `streamingDisplayOptimizationMode`: `off` runs
  every cumulative provider snapshot, `balanced` coalesces the latest snapshot into
  roughly 125 ms plus animation-frame flushes, and `strong` defers the full hook stack to
  the final snapshot (`src/ts/process/index.svelte.ts:1548-1681`). Hooks still need to be
  deterministic and repeat-safe because `off` and `balanced` may invoke them repeatedly.

- Plugin edit handlers are sequential. `null`/`undefined` preserves the previous value.
  A failing `editinput` handler is isolated, reports an error, and lets the send continue
  with the last valid input; failures in the other edit modes propagate through
  `applyPluginEditHandlers()`.

- `editdisplay` runs during re-render and must be treated as repeatable. Its trigger path is restricted and uses temporary variables, but plugin edit handlers have no equivalent automatic purity enforcement.

- Lua edit listeners do not run for `editprocess` (`src/ts/process/scriptings.ts:1375`). Regex and plugin handlers still do.

- Edit-display access IDs receive the reduced display capability set, but
  `runScripted()` currently omits the corresponding `ScriptingEditDisplayIds.delete()`.
  Do not treat those IDs as lifecycle-revoked until that path is fixed.

- A Lua trigger whose first effect is `triggerlua` bypasses the ordinary event-type filter and is offered the current mode callback (`src/ts/process/triggers.ts:1206`). The Lua code decides which mode-named function exists.

- Character low-level and destructive access are independent owner capabilities. Module
  trigger access follows `module.lowLevelAccess` and `module.destructiveAccess`; do not
  trust arbitrary stored per-trigger flags independently of their owner. V1/V2 cuts, V2
  lore deletion, Lua whole-chat/removal APIs, and destructive trigger-command variants
  must retain the destructive runtime gate. Command pipelines use `|`; `|||` remains the
  multisend field delimiter and must not be split as a pipeline boundary.

- Display and request trigger effects are allowlisted by effect type (`src/ts/process/triggers.ts:1301`). New V2 effects will silently do nothing in those modes unless explicitly added to the correct allowlist.

- Manual trigger recursion is capped at 10 only when low-level access is absent (`src/ts/process/triggers.ts:1374`, `src/ts/process/triggers.ts:1772`).

- V2 local variables are indentation-scoped and cleared at `v2EndIndent` (`src/ts/process/triggers.ts:1138`, `src/ts/process/triggers.ts:1753`). Moving effects without preserving indent metadata changes semantics.

- `triggercode` is still accepted by types/UI detection but is not dispatched by `runTrigger()`. Treat it as compatibility residue unless implementing an explicit execution path.

- V2.0 plugins execute in the page’s JavaScript realm and are unsafe by design; they are
  deprecated and gated by `allowV2Plugin`.

- V2.1 safety is AST rewriting plus wrappers, not a secure process boundary. The checker itself warns that static analysis may miss unsafe behavior (`src/ts/plugins/pluginSafety.ts:155`).

- V3 is the actual iframe isolation boundary. Its CSP denies fetch/XHR/WebSocket
  connections, so ordinary plugin network requests must cross `nativeFetch`/`risuFetch`
  RPC. Images, fonts, media, and sandbox-authorized downloads have separate browser
  controls and are not covered by `connect-src` alone.

- Ordinary V3 bridge requests have no implicit timeout or concurrency limit. They remain
  pending until the host responds or lifecycle teardown cancels them. API-specific
  cancellation or timeout options, such as `pluginStorage.updateItem()`'s options, are
  separate from the bridge; unload grace periods are not general RPC deadlines.

- V3 readiness is likewise not time-bounded. `executePluginV3()` waits for bridge/body
  start and observes the longer top-level lifetime separately; explicit teardown is what
  terminates a plugin that never reaches readiness.

- V3’s `nativeFetch` blocks several Risu domains, but sensitive authorization headers
  currently produce only warnings rather than rejection.

- V3 main-DOM access returns remote `SafeElement` wrappers and requires `mainDom`
  permission. Plugin-side wrapper calls are asynchronous even where host methods are
  synchronous.

- Explicit V3 permission decisions are keyed by the JSON pair of plugin name and
  permission. A revoked decision remains blocking until the user grants or resets it;
  periodically reconfirmed grants expire after three days. The per-plugin reset also
  clears legacy decision keys, reconfirm timestamps, and source-hash cache entries for
  the currently installed script.

- V3 provider registration asks for periodically reconfirmed `provider` permission, but
  `addProvider()` currently ignores the returned boolean and still invokes the provider.
  Do not assume a denied provider prompt blocks execution without fixing this path.

- Provider IDs are global names. V3 models become `pluginmodel:::<provider-name>`;
  duplicate names overwrite the callback map and can leave duplicate model metadata.

- Direct V3 `runLLMModel()` blocks plugin-backed models by default to avoid provider
  loops; callers must explicitly set `allowPlugins: true`.

- V3 `sendChat()` is permission-gated and explicitly refuses execution when the selected main model itself is plugin-backed. An awaited `input` script handler may run a sequential child turn against the outer send's durable target; unrelated calls during that outer transaction and calls during actual model generation remain blocked (`src/ts/plugins/apiV3/pluginChatSend.ts`, `src/ts/plugins/apiV3/v3.svelte.ts`).

- Plugin IPC requires both sender and receiver to name each other in `//@allowed-ipc`.

- `optimizePluginMemory` changes a compatibility boundary, not just performance. Enabled V2/V2.1 plugins must keep it off because their synchronous storage proxy still points at inline `pluginCustomStorage`; V3 callers use asynchronous helpers and can use external rows.

- V3 plugins can register MCP callbacks, but an identifier must begin with `plugin:` and
  the corresponding URL must still be present in an active module before
  `initializeMCPs()` activates it (`src/ts/process/mcp/pluginmcp.ts:45`,
  `src/ts/process/mcp/mcp.ts:20`).

- MCP tool names are not namespaced at model level. `callMCPTool()` scans `MCPs` and executes the first matching name (`src/ts/process/mcp/mcp.ts:164`). Avoid duplicate names across enabled servers.

- `initializeMCPs()` removes clients not present in the current active-module plus
  per-call additional URL set (`src/ts/process/mcp/mcp.ts:129`). A registered plugin
  client alone is not enough to remain active.

- Remote MCP supports HTTP URLs generally, while the import UI permits plain HTTP only for localhost/127 addresses (`src/ts/process/mcp/mcp.ts:202`). Programmatically supplied module records receive the broader runtime URL validation at `src/ts/process/mcp/mcp.ts:111`.

- Non-empty remote MCP tool/prompt lists are cached for the client lifetime
  (`src/ts/process/mcp/mcplib.ts:787`). Dynamic changes to a non-empty schema require
  client destruction/reinitialization; an empty list is fetched again on the next call.

- The internal filesystem client grants every exposed read/write/delete operation beneath one user-selected directory; the model is not prompted separately for each mutation (`src/ts/process/mcp/filesystemclient.ts:23`, `src/ts/process/mcp/filesystemclient.ts:252`).

- `internal:risuai` includes mutation tools for characters and modules. Enabling it gives the model application-editing capabilities, not merely read-only context.

- Classic tool providers frequently retain only text results. Anthropic preserves image results (`src/ts/process/request/anthropic.ts:1015`), while OpenAI and Gemini paths filter tool results to text (`src/ts/process/request/openAI/requests.ts:737`, `src/ts/process/request/google.ts:875`).

- Tool-call persistence stores full responses in the persistent KV layer and leaves only an opaque marker in chat text (`src/ts/process/mcp/mcp.ts:256`). Deleting that cache makes historical markers undecodable.

- ModelPreset tool execution explicitly prevents outer retry loops from rerunning side-effecting tools by setting `toolExecuted` (`src/ts/process/request/request.ts:213`). Preserve this invariant when changing retry behavior.

- ModelPreset tools bypass server-side model jobs and streaming. Moving that path onto
  jobs would require a design for browser-owned MCP callbacks, tool side effects, and the
  `toolExecuted` replay guard.

## 6. Navigation hints

- To add or change an ordinary `{{function}}`, edit its registration in `src/ts/cbs.ts:115` and verify normalization/dispatch in `src/ts/parser/parser.svelte.ts:1202`.

- To add CBS block syntax such as a new `{{#block}}…{{/block}}`, edit `blockStartMatcher()` and `blockEndMatcher()` at `src/ts/parser/parser.svelte.ts:1319` and `src/ts/parser/parser.svelte.ts:1599`; add a `doc_only` entry near `src/ts/cbs.ts:2366`.

- To change CBS nesting, user-defined functions, or recursion behavior, start at `src/ts/parser/parser.svelte.ts:1705`.

- To alter the order of Lua, trigger, plugin, CBS, and regex transforms, edit `processScriptFull()` at `src/ts/process/scripts.ts:100`.

- To add a regex metadata action such as `<move_top>`, edit metadata parsing near
  `src/ts/process/scripts.ts:302` and execution in `executeScript()`.

- To change where regex modes run in the chat lifecycle, inspect prompt and response
  callers in `src/ts/process/index.svelte.ts`, `ParseMarkdown()` in
  `src/ts/parser/parser.svelte.ts`, `applyChatInputToTarget()` in
  `src/ts/process/chatSendTarget.ts`, and translation in
  `src/ts/translator/translator.ts`.

- To change input-trigger or `editinput` ordering, inspect `sendMain()` in
  `src/lib/ChatScreens/DefaultChatScreen.svelte` and `applyChatInputToTarget()` in
  `src/ts/process/chatSendTarget.ts`; the latter owns the durable-target publication and
  append order.

- To add a Lua host API, declare it inside the engine-creation branch of `runScripted()`,
  then add a Lua wrapper if structured JSON/await behavior is needed in
  `luaCodeWrapper()` at `src/ts/process/scriptings.ts:1223`.

- To change Lua low-level access, audit key creation/removal at
  `src/ts/process/scriptings.ts:1041-1143` and every host API’s
  `ScriptingLowLevelIds` guard.

- To change destructive script access, coordinate import scanning/consent in
  `scriptCapabilities.ts`, owner propagation in characters/modules, runtime guards in
  `triggers.ts` and `scriptings.ts`, and the publication-bound `script-bulk-chat` backup
  reason.

- To add a V2 trigger action, define its type near the existing V2 types, add it to
  `triggerEffectV2`, and implement its case in `runTrigger()`'s effect switch.

- To allow a trigger effect during display or request transformation, update
  `displayAllowList` or `requestAllowList` at `src/ts/process/triggers.ts:1031`.

- To change trigger pipeline timing, inspect the start/output callers in
  `src/ts/process/index.svelte.ts`, request dispatch in
  `src/ts/process/request/request.ts`, input dispatch in
  `src/ts/process/chatSendTarget.ts`, and display dispatch in
  `processScriptFull()`.

- To add a V3 public API method, update `makeRisuaiAPIV3()` in
  `src/ts/plugins/apiV3/v3.svelte.ts`, its declaration in the `RisuaiPluginAPI` surface in
  `src/ts/plugins/apiV3/risuai.d.ts`, and bridge serialization when the method introduces
  a new value shape.

- To add a nested V3 API object or constant, follow `_getAliases()` and
  `_getPropertiesForInitialization()` in `src/ts/plugins/apiV3/v3.svelte.ts`.

- To change plugin permissions, update `PluginPermissionDesc`, `pluginPermissionDescs`,
  `getPluginPermission()`, and `resetPluginPermission()` in
  `src/ts/plugins/apiV3/v3.svelte.ts`, plus the editor in
  `src/lib/Setting/Pages/PluginSettings.svelte`.

- To tighten V3 iframe isolation or RPC serialization, inspect `GUEST_BRIDGE_SCRIPT`,
  `createV3BridgeRequestRegistry()`, and `SandboxHost.run()` in
  `src/ts/plugins/apiV3/factory.ts`.

- To change plugin teardown, coordinate `teardownV2Plugins()` and
  `V2_PLUGIN_UNLOAD_GRACE_MS` in `plugins.svelte.ts` with `V3PluginLifecycleScope`,
  `unloadV3PluginInstance()`, and the strict/legacy grace constants in `v3.svelte.ts`.

- To change V2.1 static safety rules, edit `SAFETY_BLACKLIST` and identifier rewriting at `src/ts/plugins/pluginSafety.ts:21` and `src/ts/plugins/pluginSafety.ts:96`; bump `checkerVersion` at `src/ts/plugins/pluginSafety.ts:55`.

- To add a plugin-supplied model, follow `addProvider()` in
  `src/ts/plugins/apiV3/v3.svelte.ts`, model discovery in
  `src/ts/model/modellist.ts`, and `LLMFormat.Plugin` dispatch in
  `src/ts/process/request/request.ts`.

- To add a plugin edit hook, update the `addRisuScriptHandler` registry API in
  `src/ts/plugins/plugins.svelte.ts`; execution is in `processScriptFull()`.

- To change optimized plugin storage, start with the coordinated ownership and test map in [Plugin storage](plugin-storage.md).

- To add a plugin request-body or response replacer, inspect `addRisuReplacer()` in
  `src/ts/plugins/plugins.svelte.ts` and the before/after replacer calls in
  `src/ts/process/request/request.ts`.

- To add a built-in MCP client, subclass `MCPClientLike` at `src/ts/process/mcp/internalmcp.ts:8`, then add its `internal:` case in `initializeMCPs()` at `src/ts/process/mcp/mcp.ts:33`.

- To change remote MCP transport, handshake, OAuth, or schema caching, inspect `src/ts/process/mcp/mcplib.ts:228`, `src/ts/process/mcp/mcplib.ts:491`, `src/ts/process/mcp/mcplib.ts:607`, and `src/ts/process/mcp/mcplib.ts:782`.

- To add a Risu-access MCP tool, add its schema and handler to the appropriate class under `src/ts/process/mcp/risuaccess/`, then ensure the handler remains in `RisuAccessClient.handlers` at `src/ts/process/mcp/risuaccess/client.ts:73`.

- To change which tools are exposed to models, begin at
  `src/ts/process/request/request.ts:139` and `src/ts/process/mcp/mcp.ts:137`.

- To change tool execution or remembered history, inspect `src/ts/process/mcp/mcp.ts:162`, `src/ts/process/mcp/mcp.ts:259`, and the provider-specific recursive tool loops.

- To change ModelPreset tool gating, edit `requestModelPreset()` at
  `src/ts/process/request/request.ts:705`; to change execution limits or retry safety,
  edit `runModelPresetToolLoop()` at `src/ts/process/request/request.ts:1077` and the
  `toolExecuted` guard in `requestChatData()`.

## 7. Related structure docs

- [Chat pipeline](chat-pipeline.md) covers the request and response call sites for scripts and hooks.
- [Model providers](model-providers.md) covers provider-specific tool wire formats and plugin-model dispatch.
- [Plugin storage](plugin-storage.md) covers generation publication, mutations, transitions, recovery, and backups.
- [UI layer](ui-layer.md) covers trigger editors, plugin settings, the storage viewer, and permission dialogs.
