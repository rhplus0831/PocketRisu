# scripting-extensions

> Part of the PocketRisu structure docs — see [STRUCTURE.md](../../STRUCTURE.md) for the top-level map and subsystem index.
> Audited 2026-07-25 against `2e3d4f05`. Line numbers are approximate and drift as code changes; verify with `rg` before relying on them.

## 1. Purpose & overview

PocketRisu exposes four overlapping extension mechanisms: CBS template expressions, regex/Lua/trigger scripts, JavaScript plugins, and Model Context Protocol tools. They run at different points in chat construction, request dispatch, response storage, and display rendering, with several compatibility layers inherited from RisuAI. Plugins can intercept those same pipelines, register complete model providers, add UI and TTS hooks, or publish MCP tools. Most persistent extension data lives in the main database or module records. With the optional plugin-memory optimization enabled, save-backed plugin values and ownership metadata move into individual `pluginsave/` and `pluginsave-meta/` server KV rows; permissions, MCP call history, and other persistent plugin state use additional KV namespaces.

## 2. Key files

### CBS and script execution

- `src/ts/cbs.ts` — approximately 2,489 lines.
  - Declares the dependency-injected CBS registration contract, not the parser itself.
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

- `src/ts/parser/parser.svelte.ts` — parser implementation used by this subsystem; approximately 1,994 lines.
  - `matcherMap` is the actual built-in CBS function registry (`src/ts/parser/parser.svelte.ts:1150`).
  - `initMatcher()` calls `registerCBS()` once and stores each callback under its canonical name and aliases; `doc_only` entries are deliberately skipped (`src/ts/parser/parser.svelte.ts:1152`).
  - `matcher()` normalizes names by lowercasing and removing whitespace, `_`, and `-`; it accepts either `:` or `::` argument separators (`src/ts/parser/parser.svelte.ts:1202`).
  - `blockStartMatcher()` and `blockEndMatcher()` implement conditionals, loops, pure blocks, escapes, and user-defined functions (`src/ts/parser/parser.svelte.ts:1319`, `src/ts/parser/parser.svelte.ts:1599`).
  - `risuChatParser()` is the synchronous CBS engine and public entry point (`src/ts/parser/parser.svelte.ts:1705`).
  - The parser maintains nested buffers and block stacks (`src/ts/parser/parser.svelte.ts:1737`), caps recursive function calls at 20 (`src/ts/parser/parser.svelte.ts:1758`), and supports `#func`/`call::` user functions (`src/ts/parser/parser.svelte.ts:1883`, `src/ts/parser/parser.svelte.ts:1907`).
  - `ParseMarkdown()` invokes display scripts before inlay/tool rendering and markdown sanitization (`src/ts/parser/parser.svelte.ts:903`, `src/ts/parser/parser.svelte.ts:921`).

- `src/ts/process/scripts.ts` — approximately 392 lines.
  - `ScriptMode` defines `editinput`, `editoutput`, `editprocess`, and `editdisplay` (`src/ts/process/scripts.ts:18`).
  - `processScript()` is the string-only convenience wrapper (`src/ts/process/scripts.ts:26`).
  - `exportRegex()` and `importRegex()` serialize regex-script bundles (`src/ts/process/scripts.ts:30`, `src/ts/process/scripts.ts:41`).
  - `resetScriptCache()` clears the transformation cache (`src/ts/process/scripts.ts:95`).
  - `processScriptFull()` is the main regex/script pipeline and also returns whether an emotion changed (`src/ts/process/scripts.ts:99`).
  - It runs Lua edit listeners first, display triggers only for `editdisplay`, then plugin edit handlers, then CBS, and finally regex scripts (`src/ts/process/scripts.ts:102`, `src/ts/process/scripts.ts:104`, `src/ts/process/scripts.ts:124`, `src/ts/process/scripts.ts:133`, `src/ts/process/scripts.ts:134`).
  - Regex flags are restricted to ECMAScript `dgimsuvy`, deduplicated, and default to `u` if empty (`src/ts/process/scripts.ts:166`).
  - Advanced actions include CBS-parsed input patterns, emotion changes, injection, moving matches, and repeating a prior-role match (`src/ts/process/scripts.ts:176`, `src/ts/process/scripts.ts:184`, `src/ts/process/scripts.ts:207`, `src/ts/process/scripts.ts:212`, `src/ts/process/scripts.ts:253`).
  - `<order n>` metadata is parsed and sorted descending before execution (`src/ts/process/scripts.ts:297`, `src/ts/process/scripts.ts:333`).
  - Dynamic asset fuzzy matching runs after regex replacement (`src/ts/process/scripts.ts:346`).

- `src/ts/process/scriptings.ts` — approximately 1,519 lines.
  - `runScripted()` owns the Lua/Python execution environment and its host API (`src/ts/process/scriptings.ts:52`).
  - Engines are cached by mode and serialized through a per-engine `Mutex` (`src/ts/process/scriptings.ts:78`, `src/ts/process/scriptings.ts:80`, `src/ts/process/scriptings.ts:1180`).
  - The API uses ephemeral UUID access keys checked against `ScriptingSafeIds`, `ScriptingEditDisplayIds`, and `ScriptingLowLevelIds` (`src/ts/process/scriptings.ts:22`, `src/ts/process/scriptings.ts:1029`).
  - Ordinary safe APIs cover chat variables, chat mutation, tokenization, alerts, reloads, and CBS parsing (`src/ts/process/scriptings.ts:105`, `src/ts/process/scriptings.ts:154`, `src/ts/process/scriptings.ts:212`, `src/ts/process/scriptings.ts:245`, `src/ts/process/scriptings.ts:267`).
  - Low-level APIs include similarity search, constrained HTTPS GET, image generation, main/auxiliary LLM calls, and active-lore loading (`src/ts/process/scriptings.ts:284`, `src/ts/process/scriptings.ts:294`, `src/ts/process/scriptings.ts:363`, `src/ts/process/scriptings.ts:472`, `src/ts/process/scriptings.ts:789`, `src/ts/process/scriptings.ts:832`).
  - The Lua wrapper supplies `getChat`, `getFullChat`, `LLM`, `axLLM`, `listenEdit`, `getState`, and coroutine-based `async` helpers (`src/ts/process/scriptings.ts:1211`).
  - `runLuaEditTrigger()` maps regex-style modes to Lua listener names and intentionally ignores `editprocess` (`src/ts/process/scriptings.ts:1364`).
  - `runLuaButtonTrigger()` invokes `onButtonClick` across Lua triggers (`src/ts/process/scriptings.ts:1407`).
  - `PyodideContext` runs experimental Python in a worker and proxies declared APIs (`src/ts/process/scriptings.ts:1431`).

- `src/ts/process/triggers.ts` — approximately 2,802 lines.
  - `triggerscript` defines event type, conditions, effects, and optional low-level access (`src/ts/process/triggers.ts:21`).
  - `triggerEffect` combines legacy V1 actions, Lua/code entries, and V2 actions (`src/ts/process/triggers.ts:31`).
  - V1 condition and action shapes occupy the beginning of the file; V2’s structured control-flow/action types begin with `triggerV2Header` (`src/ts/process/triggers.ts:177`).
  - `displayAllowList` and `requestAllowList` restrict these side-effect-sensitive modes to state inspection/mutation plus a safe calculation subset (`src/ts/process/triggers.ts:986`, `src/ts/process/triggers.ts:1024`, `src/ts/process/triggers.ts:1030`).
  - `runTrigger()` is the sole trigger interpreter (`src/ts/process/triggers.ts:1039`).
  - Trigger variables resolve local scopes first, then chat `scriptstate`, then character/template defaults (`src/ts/process/triggers.ts:1085`, `src/ts/process/triggers.ts:1157`).
  - Conditions support variable/value comparisons, chat index tests, and strict/loose/regex history existence checks (`src/ts/process/triggers.ts:1218`, `src/ts/process/triggers.ts:1277`).
  - Effects are filtered through display/request allowlists before dispatch (`src/ts/process/triggers.ts:1299`).
  - Legacy low-level actions include alerts, nested LLM calls, similarity, regex extraction, and image generation (`src/ts/process/triggers.ts:1406`).
  - Lua effects delegate to `runScripted()` and propagate modified chat/stop state (`src/ts/process/triggers.ts:1527`).
  - V2 control flow uses indentation, scoped locals, explicit end markers, and loop rewinding (`src/ts/process/triggers.ts:1586`, `src/ts/process/triggers.ts:1593`, `src/ts/process/triggers.ts:1718`).
  - The returned result carries prompt injections, chat, token cost, stop/resend flags, display/request data, and temporary state (`src/ts/process/triggers.ts:2801`).

### Plugin framework

- `src/ts/plugins/plugins.svelte.ts` — approximately 989 lines.
  - `RisuPlugin` stores source, metadata headers, arguments, API version, update URL, enablement, and IPC allowlist (`src/ts/plugins/plugins.svelte.ts:17`, `src/ts/plugins/plugins.svelte.ts:36`).
  - `importPlugin()` parses plugin headers, optionally transpiles TypeScript, applies V2.1 safety checks, and persists/reloads the plugin (`src/ts/plugins/plugins.svelte.ts:129`).
  - Supported API headers are `2.0`, `2.1`, and `3.0`; missing `//@api` defaults to 2.0 behavior (`src/ts/plugins/plugins.svelte.ts:182`, `src/ts/plugins/plugins.svelte.ts:193`).
  - `loadPlugins()` divides enabled plugins into V2/V2.1 and V3 loaders (`src/ts/plugins/plugins.svelte.ts:435`).
  - `pluginV2` is the shared registry for providers, edit handlers, before/after request replacers, and unload callbacks (`src/ts/plugins/plugins.svelte.ts:469`).
  - Plugin-list changes reload under a serialized transaction. Strict mode rolls imports back on lifecycle failure; the opt-in legacy compatibility policy downgrades teardown-only failures to warnings while keeping load and persistence failures strict.
  - `getV2PluginAPIs()` exposes model registration, script/replacer registration, limited database access, safe globals/storage/document wrappers, and asset operations (`src/ts/plugins/plugins.svelte.ts:508`).
  - `addProvider()` registers a provider callback and optional tokenizer metadata (`src/ts/plugins/plugins.svelte.ts:530`).
  - `loadV2Plugin()` unloads prior hooks and executes transformed source through `new Function`; V2.0 execution additionally requires `allowV2Plugin` (`src/ts/plugins/plugins.svelte.ts:813`, `src/ts/plugins/plugins.svelte.ts:885`, `src/ts/plugins/plugins.svelte.ts:899`).

- `src/ts/plugins/pluginSafety.ts` — approximately 174 lines.
  - `checkCodeSafety()` parses V2.1 source with Acorn, rewrites sensitive globals, and caches the transformed result by source hash/checker version (`src/ts/plugins/pluginSafety.ts:59`).
  - It rejects direct `eval`, `new Function`, `sessionStorage`, and `cookieStore` (`src/ts/plugins/pluginSafety.ts:21`).
  - Identifiers such as `window`, `globalThis`, `localStorage`, `indexedDB`, `document`, `Function`, `prototype`, and `constructor` are rewritten to safe aliases (`src/ts/plugins/pluginSafety.ts:96`).
  - The checker explicitly appends a static-analysis limitation warning, making user review part of the V2.1 import path (`src/ts/plugins/pluginSafety.ts:155`).

- `src/ts/plugins/pluginSafeClass.ts` — approximately 441 lines.
  - `SafeLocalStorage` places V2 storage in the shared `safe_plugin_` localStorage namespace (`src/ts/plugins/pluginSafeClass.ts:8`).
  - `SafeLocalPluginStorage` provides asynchronous persistent storage for V3 and records best-effort owner metadata on writes (`src/ts/plugins/pluginSafeClass.ts:50`).
  - `SafeIdbFactory` prefixes IndexedDB database names with `safe_plugin_` (`src/ts/plugins/pluginSafeClass.ts:102`).
  - `tagWhitelist` controls DOM element creation (`src/ts/plugins/pluginSafeClass.ts:126`).
  - The V2 `SafeDocument` restricts element creation, anchors, and event names, although many query operations still return underlying DOM objects (`src/ts/plugins/pluginSafeClass.ts:304`).

- `src/ts/plugins/pluginMemoryOptimization.ts` — 31 lines.
  - Encodes the compatibility gate for `optimizePluginMemory`: enabled V2/V2.1 plugins block the mode, imports of those versions are disabled while it is active, and attempts to enable them are refused. V3 plugins remain compatible because their save API is asynchronous.

- `src/ts/plugins/pluginSaveStorage.ts` — approximately 311 lines.
  - Routes save-backed plugin values to inline `Database.pluginCustomStorage` or external encoded `pluginsave/*.json` rows based on `optimizePluginMemory`.
  - Serializes V3/viewer operations and mode transitions through one promise queue. `reconcilePluginStorageMode()` externalizes rows before removing inline copies, or saves complete inline copies before deleting rows, so interrupted transitions leave duplicates rather than data loss.
  - Externalized reads opt into the verified browser resource cache; key names use reversible unpadded base64url components shared with the server backup/ingest code.
  - Before externalization mutates either backend, it validates every value/metadata destination and rejects ill-formed Unicode or an encoded collision (`src/ts/plugins/pluginSaveStorage.ts:208-224`; `src/ts/storage/persistentKv.ts:16-27`).

- `src/ts/plugins/pluginStorageMeta.ts` — approximately 164 lines.
  - Maintains sidecar ownership metadata without changing stored plugin values (`src/ts/plugins/pluginStorageMeta.ts:1`).
  - Save-local ownership follows the same inline versus `pluginsave-meta/` backend as plugin values; local and persistent-IDB plugin stores keep their established metadata paths.

- `src/ts/plugins/apiV3/factory.ts` — approximately 654 lines.
  - `GUEST_BRIDGE_SCRIPT` constructs the iframe-side `risuai`/`Risuai` proxy and RPC protocol (`src/ts/plugins/apiV3/factory.ts:38`).
  - Callback functions, abort signals, transferable streams, and remote class instances have explicit bridge representations (`src/ts/plugins/apiV3/factory.ts:46`, `src/ts/plugins/apiV3/factory.ts:84`).
  - `SandboxHost` owns iframe lifecycle and host-side dispatch (`src/ts/plugins/apiV3/factory.ts:291`).
  - Strict teardown closes RPC immediately. Legacy compatibility adds a bounded draining state that admits only storage flushes and cleanup-oriented root/remote-instance methods before final termination.
  - Remote-required instances are stored in an instance registry and surfaced as proxy references (`src/ts/plugins/apiV3/factory.ts:361`).
  - `run()` applies an iframe sandbox allowing scripts, modals, and downloads, plus a CSP with `connect-src 'none'`, then executes the bridge and plugin source in `srcdoc` (`src/ts/plugins/apiV3/factory.ts:483`, `src/ts/plugins/apiV3/factory.ts:498`, `src/ts/plugins/apiV3/factory.ts:606`).
  - `terminate()` removes the iframe and clears remote/callback state (`src/ts/plugins/apiV3/factory.ts:645`).

- `src/ts/plugins/apiV3/v3.svelte.ts` — approximately 1,533 lines.
  - `SafeElement` exposes remotely proxied DOM operations; HTML setters use DOMPurify (`src/ts/plugins/apiV3/v3.svelte.ts:59`, `src/ts/plugins/apiV3/v3.svelte.ts:230`).
  - `SafeDocument` restricts created tags and sanitizes anchor protocols (`src/ts/plugins/apiV3/v3.svelte.ts:353`).
  - Plugin unload handling cleans callbacks, UI, and iframe instances (`src/ts/plugins/apiV3/v3.svelte.ts:481`, `src/ts/plugins/apiV3/v3.svelte.ts:514`).
  - V3 unload uses a one-second strict grace period or a five-second legacy-compatibility grace period; both paths forcibly terminate the iframe afterward.
  - Permission-backed capabilities are `fetchLogs`, `db`, `mainDom`, `replacer`, `provider`, and `sendChat`; decisions are persisted and keyed by plugin/permission plus plugin source hash (`src/ts/plugins/apiV3/v3.svelte.ts:545`, `src/ts/plugins/apiV3/v3.svelte.ts:552`, `src/ts/plugins/apiV3/v3.svelte.ts:644`).
  - `makeRisuaiAPIV3()` constructs the host API (`src/ts/plugins/apiV3/v3.svelte.ts:753`).
  - Major API groups include:
    - restricted fetch and asset APIs (`src/ts/plugins/apiV3/v3.svelte.ts:759`);
    - provider and TTS-hook registration (`src/ts/plugins/apiV3/v3.svelte.ts:794`, `src/ts/plugins/apiV3/v3.svelte.ts:822`);
    - database, character, chat, lorebook, theme, and argument access (`src/ts/plugins/apiV3/v3.svelte.ts:851`, `src/ts/plugins/apiV3/v3.svelte.ts:938`, `src/ts/plugins/apiV3/v3.svelte.ts:954`);
    - iframe/main-DOM and settings/button/chat-panel UI (`src/ts/plugins/apiV3/v3.svelte.ts:1018`, `src/ts/plugins/apiV3/v3.svelte.ts:1049`, `src/ts/plugins/apiV3/v3.svelte.ts:1056`, `src/ts/plugins/apiV3/v3.svelte.ts:1120`, `src/ts/plugins/apiV3/v3.svelte.ts:1194`);
    - request-body interceptors and MCP registration (`src/ts/plugins/apiV3/v3.svelte.ts:1093`, `src/ts/plugins/apiV3/v3.svelte.ts:1231`);
    - save/local/persistent plugin storage and ownership tracking (`src/ts/plugins/apiV3/v3.svelte.ts:1292`, `src/ts/plugins/apiV3/v3.svelte.ts:1313`);
    - direct LLM invocation, user-message sending, and mutually allowed plugin IPC (`src/ts/plugins/apiV3/v3.svelte.ts:1373`, `src/ts/plugins/apiV3/v3.svelte.ts:1394`, `src/ts/plugins/apiV3/v3.svelte.ts:1442`).
  - `loadV3Plugins()` unloads all current instances before parallel reload (`src/ts/plugins/apiV3/v3.svelte.ts:1489`).
  - `executePluginV3()` creates the hidden iframe and starts its `SandboxHost` (`src/ts/plugins/apiV3/v3.svelte.ts:1497`).

- `src/ts/plugins/apiV3/risuai.d.ts` — approximately 1,979 lines.
  - Authoritative developer-facing V3 type surface; all plugin-side API and remote-object calls return promises (`src/ts/plugins/apiV3/risuai.d.ts:1`).
  - MCP API declarations begin around `src/ts/plugins/apiV3/risuai.d.ts:98`.
  - The public `RisuaiAPI` interface begins around `src/ts/plugins/apiV3/risuai.d.ts:1177`.
  - Provider, TTS, scripts, replacers, MCP, LLM, storage, UI, and IPC declarations occupy `src/ts/plugins/apiV3/risuai.d.ts:1600` onward.

- `src/ts/plugins/apiV3/developMode.ts` — approximately 56 lines.
  - `hotReloadPluginFiles()` polls a selected JS/TS file every 500 ms and re-imports it; only V3 hot reload is accepted by `importPlugin()` (`src/ts/plugins/apiV3/developMode.ts:5`, `src/ts/plugins/apiV3/developMode.ts:32`).

- `src/ts/plugins/apiV3/transpiler.ts` — approximately 9 lines.
  - `pluginCodeTranspiler()` strips TypeScript syntax with Sucrase (`src/ts/plugins/apiV3/transpiler.ts:1`).

### MCP support

- `src/ts/process/mcp/mcp.ts` — approximately 287 lines.
  - `MCPs` is the live client registry keyed by module URL/identifier (`src/ts/process/mcp/mcp.ts:16`).
  - `initializeMCPs()` reconciles enabled module MCP URLs, additional request URLs, internal clients, plugin clients, and remote HTTP clients (`src/ts/process/mcp/mcp.ts:18`).
  - Internal identifiers are dispatched at `src/ts/process/mcp/mcp.ts:33`; plugin clients at `src/ts/process/mcp/mcp.ts:71`; remote/`stdio:` URL handling at `src/ts/process/mcp/mcp.ts:79`.
  - `getMCPTools()` aggregates tool schemas and tags each with its source URL (`src/ts/process/mcp/mcp.ts:137`).
  - `callMCPTool()` searches clients by tool name and calls the first match (`src/ts/process/mcp/mcp.ts:162`).
  - `getTools()`/`callTool()` are model-request-facing wrappers (`src/ts/process/mcp/mcp.ts:178`, `src/ts/process/mcp/mcp.ts:183`).
  - `encodeToolCall()` and `decodeToolCall()` persist model-visible `<tool_call>` history markers outside the chat text (`src/ts/process/mcp/mcp.ts:259`, `src/ts/process/mcp/mcp.ts:266`).

- `src/ts/process/mcp/mcplib.ts` — approximately 859 lines.
  - Defines MCP prompt/tool/JSON-RPC and multimodal result types (`src/ts/process/mcp/mcplib.ts:5`, `src/ts/process/mcp/mcplib.ts:16`, `src/ts/process/mcp/mcplib.ts:23`, `src/ts/process/mcp/mcplib.ts:53`).
  - `MCPToolHandler` is the handler base used by Risu-access tools (`src/ts/process/mcp/mcplib.ts:75`).
  - `MCPClient` implements remote HTTP/SSE MCP transport (`src/ts/process/mcp/mcplib.ts:80`).
  - `request()` handles JSON-RPC, sessions, bearer authentication, streamed responses, and custom transports (`src/ts/process/mcp/mcplib.ts:228`).
  - `handshake()` tries protocol `2025-03-26`, then falls back from streamed HTTP to legacy SSE `2024-11-05` on HTTP 404 (`src/ts/process/mcp/mcplib.ts:491`).
  - OAuth discovery/registration/PKCE handling begins at `src/ts/process/mcp/mcplib.ts:607`.
  - `getToolList()` paginates and caches `tools/list` (`src/ts/process/mcp/mcplib.ts:782`).
  - `callTool()` sends `tools/call` and normalizes RPC errors into text results (`src/ts/process/mcp/mcplib.ts:822`).

- `src/ts/process/mcp/internalmcp.ts` — approximately 54 lines.
  - `MCPClientLike` is the common adapter for built-in and plugin-provided tools (`src/ts/process/mcp/internalmcp.ts:8`).

- `src/ts/process/mcp/pluginmcp.ts` — approximately 57 lines.
  - `CustomPluginMCPClient` adapts V3 plugin callbacks to `MCPClientLike` (`src/ts/process/mcp/pluginmcp.ts:6`).
  - `registerMCPModule()` requires a `plugin:` identifier and stores the client in `registeredCustomPluginMCPs` (`src/ts/process/mcp/pluginmcp.ts:36`).
  - `unregisterMCPModule()` removes the registration (`src/ts/process/mcp/pluginmcp.ts:56`).

- `src/ts/process/mcp/risuaccess/client.ts` — approximately 108 lines.
  - `RisuAccessClient` combines character, chat, and module handlers and publishes detailed Risu-specific instructions (`src/ts/process/mcp/risuaccess/client.ts:7`).
  - Tools are aggregated and dispatched through the handlers at `src/ts/process/mcp/risuaccess/client.ts:76` and `src/ts/process/mcp/risuaccess/client.ts:84`.

- `src/ts/process/mcp/risuaccess/characters.ts` — approximately 992 lines.
  - `CharacterHandler` exposes character listing/info, lorebook, regex, Lua, and asset mutation tools (`src/ts/process/mcp/risuaccess/characters.ts:9`).
  - Tool schemas begin at `src/ts/process/mcp/risuaccess/characters.ts:14`; dispatch begins at `src/ts/process/mcp/risuaccess/characters.ts:335`.

- `src/ts/process/mcp/risuaccess/chats.ts` — approximately 74 lines.
  - `ChatHandler` exposes `risu-get-chat-history` (`src/ts/process/mcp/risuaccess/chats.ts:5`).

- `src/ts/process/mcp/risuaccess/modules.ts` — approximately 844 lines.
  - `ModuleHandler` exposes module info plus lorebook, regex, and Lua read/write/delete tools (`src/ts/process/mcp/risuaccess/modules.ts:14`).
  - Tool schemas begin at `src/ts/process/mcp/risuaccess/modules.ts:19`; dispatch begins at `src/ts/process/mcp/risuaccess/modules.ts:307`.

- Built-in provider clients:
  - `src/ts/process/mcp/aiaccess.ts` — approximately 83 lines; `AIAccessClient` exposes nested main/aux LLM calls through `runLLM` (`src/ts/process/mcp/aiaccess.ts:7`, `src/ts/process/mcp/aiaccess.ts:53`).
  - `src/ts/process/mcp/dice.ts` — approximately 60 lines; `DiceClient` exposes `rollDice` (`src/ts/process/mcp/dice.ts:4`).
  - `src/ts/process/mcp/graphmem.ts` — approximately 165 lines; `GraphMemClient` stores graph memory in chat variables and searches it with embeddings (`src/ts/process/mcp/graphmem.ts:12`, `src/ts/process/mcp/graphmem.ts:87`, `src/ts/process/mcp/graphmem.ts:111`).
  - `src/ts/process/mcp/googlesearchclient.ts` — approximately 266 lines; prompts for Custom Search credentials and exposes web/image search (`src/ts/process/mcp/googlesearchclient.ts:31`, `src/ts/process/mcp/googlesearchclient.ts:43`, `src/ts/process/mcp/googlesearchclient.ts:66`).
  - `src/ts/process/mcp/filesystemclient.ts` — approximately 896 lines; scopes file operations to a user-selected File System Access API directory and exposes read/write/search/copy/move/info/tree tools (`src/ts/process/mcp/filesystemclient.ts:4`, `src/ts/process/mcp/filesystemclient.ts:15`, `src/ts/process/mcp/filesystemclient.ts:39`, `src/ts/process/mcp/filesystemclient.ts:252`).

## 3. Architecture & data flow

### CBS flow

1. A caller invokes `risuChatParser(text, context)` (`src/ts/parser/parser.svelte.ts:1705`).
2. On first use, `initMatcher()` calls `registerCBS()` and fills `matcherMap` with executable built-ins and aliases (`src/ts/parser/parser.svelte.ts:1152`).
3. The character-by-character parser builds nested buffers for expressions and block bodies (`src/ts/parser/parser.svelte.ts:1737`).
4. Simple expressions go through `matcher()`, which normalizes the function name and dispatches its callback (`src/ts/parser/parser.svelte.ts:1202`).
5. Block syntax bypasses the registry and goes through `blockStartMatcher()`/`blockEndMatcher()` (`src/ts/parser/parser.svelte.ts:1831`, `src/ts/parser/parser.svelte.ts:1862`).
6. Stateful callbacks may update temporary variables or chat/global variables; `{{return}}` sets `__force_return__`, causing immediate parser return (`src/ts/parser/parser.svelte.ts:1933`).

CBS is applied repeatedly throughout prompt construction and scripting. In particular, `processScriptFull()` parses the entire incoming string before regex execution and reparses replacement output after each matching script (`src/ts/process/scripts.ts:133`, `src/ts/process/scripts.ts:249`).

### Regex and edit pipeline

The canonical order inside `processScriptFull()` is:

1. Lua edit listener (`runLuaEditTrigger`).
2. Display trigger, but only for `editdisplay`.
3. V2/V3 plugin edit handlers from the shared `pluginV2` registry.
4. CBS parsing.
5. Preset regex scripts, character regex scripts, then enabled-module regex scripts.
6. Optional dynamic-asset fuzzy correction.
7. Result caching.

The source ordering is concrete at `src/ts/process/scripts.ts:102-135`.

Pipeline call sites are:

- `editprocess`: each stored history message and the first greeting while constructing the model prompt (`src/ts/process/index.svelte.ts:772`, `src/ts/process/index.svelte.ts:801`).
- `editoutput`: every streaming update and completed response before it is stored (`src/ts/process/index.svelte.ts:1482`, `src/ts/process/index.svelte.ts:1533`).
- `editdisplay`: every rendered chat message through `ParseMarkdown()`, without intending to mutate stored content (`src/ts/parser/parser.svelte.ts:921`).
- `editinput`: `DefaultChatScreen.sendMain()` calls the `processScript()` wrapper for non-empty character-chat input immediately before appending the user message (`src/lib/ChatScreens/DefaultChatScreen.svelte:368-380`).

### Trigger flow and versions

Trigger “versions” are structural rather than a `version` field:

- V1 consists of legacy effect types such as `setvar`, `modifychat`, `systemprompt`, and `runLLM`.
- V2 is identified in the editor by a leading `v2Header`, but `runTrigger()` interprets the individual V2 effect types in the same switch as V1.
- Lua mode is identified by a leading `triggerlua` effect and delegates to `runScripted()`.
- `triggercode` remains in the type union and mode-detection logic but has no execution case in `runTrigger()`.

Runtime event points are:

- `start`: after initial prompt boilerplate is prepared but before stored history is processed (`src/ts/process/index.svelte.ts:787`).
- `output`: after response text is stored, for both streaming and non-streaming flows (`src/ts/process/index.svelte.ts:1505`, `src/ts/process/index.svelte.ts:1590`).
- `display`: from `processScriptFull()` while rendering (`src/ts/process/scripts.ts:104`).
- `request`: on every request attempt after plugin before-replacers and before provider dispatch (`src/ts/process/request/request.ts:154`, `src/ts/process/request/request.ts:164`, `src/ts/process/request/request.ts:183`).
- `manual`: from `/trigger` and recursive run-trigger effects (`src/ts/process/command.ts:220`, `src/ts/process/triggers.ts:1373`).
- `input`: `DefaultChatScreen.sendMain()` invokes the character trigger before `editinput` and before appending the user message (`src/lib/ChatScreens/DefaultChatScreen.svelte:368-380`).

Character triggers inherit the character’s `lowLevelAccess`; module triggers inherit their module’s flag (`src/ts/process/triggers.ts:1054`, `src/ts/process/triggers.ts:1062`, `src/ts/process/modules.ts:465`). Display/request modes operate on temporary state and explicit allowlists, preventing most chat, network, UI, and model side effects (`src/ts/process/triggers.ts:1171`, `src/ts/process/triggers.ts:1301`).

### Lua flow

`runScripted()` reuses one engine per mode, recreating it only when source changes (`src/ts/process/scriptings.ts:78`, `src/ts/process/scriptings.ts:84`). It injects host functions, loads the wrapped Lua source, grants a temporary access key, invokes the mode callback, then removes the key (`src/ts/process/scriptings.ts:1020`, `src/ts/process/scriptings.ts:1029`, `src/ts/process/scriptings.ts:1043`, `src/ts/process/scriptings.ts:1130`).

Lua edit listeners register through `listenEdit(type, func)` and are called through `callListenMain` (`src/ts/process/scriptings.ts:1265`, `src/ts/process/scriptings.ts:1329`). Edit-display keys receive only the reduced display-safe capability set; low-level keys are granted only when the owning character/module permits them (`src/ts/process/scriptings.ts:1030`).

### Plugin load and provider flow

1. `importPlugin()` parses metadata and persists a `RisuPlugin` record (`src/ts/plugins/plugins.svelte.ts:157`, `src/ts/plugins/plugins.svelte.ts:378`).
2. `loadPlugins()` selects enabled plugins and routes them by API version (`src/ts/plugins/plugins.svelte.ts:435`).
3. V2.1 source is AST-rewritten and executed in the page with safe aliases; V2.0 uses the same page execution mechanism without the rewrite and is disabled by default (`src/ts/plugins/plugins.svelte.ts:885`, `src/ts/plugins/plugins.svelte.ts:899`).
4. V3 source runs in a sandboxed iframe. Every `risuai.*` call crosses the RPC bridge to `makeRisuaiAPIV3()` (`src/ts/plugins/apiV3/factory.ts:231`, `src/ts/plugins/apiV3/v3.svelte.ts:1505`).
5. Plugins add providers through `addProvider()`, which stores the callback in `pluginV2.providers`. V3 additionally constructs an `LLMModel` with ID `pluginmodel:::<name>` and adds it to `customV3ProviderMetaStore` (`src/ts/plugins/apiV3/v3.svelte.ts:794`, `src/ts/plugins/apiV3/v3.svelte.ts:808`).
6. `getModelInfo()` and `getModelList()` surface those V3 model records (`src/ts/model/modellist.ts:752`, `src/ts/model/modellist.ts:778`).
7. Request dispatch recognizes `LLMFormat.Plugin`, resolves the provider name, and invokes its callback with formatted messages, model parameters, and the abort signal (`src/ts/process/request/request.ts:459`, `src/ts/process/request/request.ts:1336`).
8. Provider output may be a string or `ReadableStream<string>` and is adapted back into PocketRisu’s request result format (`src/ts/process/request/request.ts:1374`, `src/ts/process/request/request.ts:1388`).

### Optimized plugin save storage

The optional automatic-conversion setting retries ordinary optimized writes after strict validation fails. It maps Date to ISO text, Map to entry arrays, Set to arrays, BigInt to decimal text, and undefined/non-finite numbers/array holes to null. Functions, circular references, accessors, symbols, and custom classes remain errors; compound/versioned APIs and mode transitions remain strictly JSON-only.

The persisted `Database.optimizePluginMemory` flag changes only the save-backed plugin storage API. When false, values and ownership metadata remain in `pluginCustomStorage`/`pluginStorageMeta` inside the main database, and the basic V3 get/set plus database bridge retain the legacy structured-clone value behavior. When true, each value becomes `pluginsave/<base64url(key)>.json` and each owner record becomes `pluginsave-meta/<base64url(key)>.json`; external value reads may use the verified browser cache. Optimized writes accept only detached JSON values and enforce the per-value limit. An incompatible runtime write returns `PLUGIN_STORAGE_VALUE_UNSUPPORTED` and shows an actionable notification deduplicated per error kind and plugin load; enabling optimization over incompatible existing data fails before mutation with the same actionable code. Versioned, atomic, and generation helpers remain JSON-only in either mode because their revision and content hashes require canonical JSON bytes.

`reconcilePluginStorageMode()` runs at boot and after a settings toggle. Externalization first encodes and collision-checks every destination, then writes each KV row before deleting its inline copy and full-writing the stub-only database. Internalization loads all rows into the database, full-writes that durable inline copy, and only then removes the rows. Keys must be well-formed Unicode before UTF-8/base64url encoding; lone UTF-16 surrogates are rejected rather than collapsing to U+FFFD.

Server ingestion and backup assembly understand the same split. Node-only portable/server archives carry byte-preserving per-row entries, while upstream-target and selective client exports fold rows into ordinary database maps. Automatic server snapshots also fold the rows, including a deliberately empty key set, and stamp `pluginStorageFolded: true`; restore uses that marker to atomically replace the external prefixes instead of retaining newer plugin state. Pre-marker snapshots preserve existing external rows because they cannot prove what the historical key set was.

V2/V2.1 plugins cannot participate because their save-storage facade is synchronous. The UI refuses this optimization while any legacy plugin is enabled, disables an imported legacy plugin when the mode is active, and prevents later enablement. V3 storage remains asynchronous and uses the serialized `pluginSaveStorage` path.

V3 mutation failures retain `committed`, `not-committed`, and `unknown`
outcomes across the iframe bridge. `setItemWithOutcome()` and
`removeItemWithOutcome()` expose those results directly, while
`removeItemConfirmed()` performs a fresh versioned read and reports success
only after it observes absence. Ambiguous mutations are never replayed. Plugin
caches, dirty flags, cleanup counters, and reset UI should follow the confirmed
outcome workflow in [Safe V3 plugin-storage mutations](../plugin-storage-mutation-outcomes.md).

### MCP-to-model flow

1. Every `requestChatData()` call resolves tools from `arg.tools` or `getTools()` before retries begin (`src/ts/process/request/request.ts:120`, `src/ts/process/request/request.ts:123`).
2. `getTools()` calls `getMCPTools()`, which initializes enabled module MCPs and aggregates their JSON schemas (`src/ts/process/mcp/mcp.ts:137`, `src/ts/process/mcp/mcp.ts:178`).
3. Enabled module MCP URLs come from `getModuleMcps()` (`src/ts/process/modules.ts:510`). Internal, plugin, and remote clients all satisfy the same `getToolList()`/`callTool()` interface.
4. Classic OpenAI-compatible, Anthropic, and Gemini request paths put those schemas into their provider-specific tool format. When the model emits a tool call, they invoke `callTool()` and recursively request the model with a tool-result message (`src/ts/process/request/openAI/requests.ts:706`, `src/ts/process/request/anthropic.ts:986`, `src/ts/process/request/google.ts:868`).
5. ModelPreset adapters expose tools only when the preset opts into tool use, the adapter supports tools, and the profile explicitly declares the `tools` capability (`src/ts/process/request/request.ts:694`, `src/ts/process/request/request.ts:707`).
6. ModelPreset tool calls run through `runModelPresetToolLoop()` and `executeModelPresetTool()` (`src/ts/process/request/request.ts:952`, `src/ts/process/request/request.ts:998`).
7. When `rememberToolUsage` is enabled, the call and response are persisted and the assistant message receives a compact `<tool_call>id…name</tool_call>` marker (`src/ts/process/mcp/mcp.ts:259`). Later requests decode the marker back into structured tool history; display rendering replaces it with a tool-used badge (`src/ts/process/mcp/mcp.ts:266`, `src/ts/parser/parser.svelte.ts:898`).

## 4. Entry points & dependencies

### Called by other subsystems

- Prompt construction calls CBS, `editprocess`, and start triggers from `src/ts/process/index.svelte.ts:772-801`.
- Response handling calls `editoutput` and output triggers from `src/ts/process/index.svelte.ts:1482-1505` and `src/ts/process/index.svelte.ts:1533-1590`.
- Markdown rendering calls the display script stack from `src/ts/parser/parser.svelte.ts:903-943`.
- Request dispatch calls plugin replacers, request triggers, MCP discovery, and provider plugins from `src/ts/process/request/request.ts:120-187`.
- Slash commands call manual triggers from `src/ts/process/command.ts:220`.
- The translator reuses `processScriptFull()` for translated output at `src/ts/translator/translator.ts:408`.
- Plugin initialization is ultimately driven by database/application startup through `loadPlugins()` (`src/ts/plugins/plugins.svelte.ts:435`).
- Model selection reads plugin model metadata through `src/ts/model/modellist.ts:752`.
- Tokenization reads plugin tokenizer configuration through `src/ts/tokenizer.ts:73` and `src/ts/tokenizer.ts:142`.

### Calls into other subsystems

- CBS reads characters, personas, lorebooks, model metadata, global/chat variables, and module state.
- Regex scripting reads preset/character/module scripts, controls emotion stores, and calls the embedding subsystem for dynamic asset matching.
- Triggers mutate chat/database state and call commands, alerts, tokenization, embeddings, image generation, inlay storage, and model requests.
- Lua scripts call the same model, lorebook, tokenizer, image, file/inlay, and UI services through guarded host functions.
- Plugins depend on database persistence, menus/stores, themes, request dispatch, TTS hooks, assets, and MCP registration.
- Remote MCP uses `fetchNative`, OAuth browser flow, alert input, and persistent authentication records.
- Risu-access MCP writes character/module/database data directly through its handlers.
- Filesystem MCP depends on browser File System Access APIs and the PDF-to-image helper.

## 5. Conventions & gotchas

- CBS registration is dependency-injected. Adding a callback only to `cbs.ts` is sufficient for the main parser because `initMatcher()` wires it, but special block syntax must be implemented in `blockStartMatcher()`/`blockEndMatcher()`, not as an ordinary callback.

- CBS names are compatibility-normalized: case, spaces, underscores, and hyphens are ignored (`src/ts/parser/parser.svelte.ts:1222`). Avoid adding names whose normalized forms collide.

- `doc_only` CBS entries intentionally do not enter `matcherMap` (`src/ts/parser/parser.svelte.ts:1163`). They document syntax handled elsewhere, especially assets and block constructs.

- CBS is synchronous. Registration callbacks cannot return promises, even when their data sources are otherwise asynchronous.

- Stateful CBS operations honor contextual flags. Variable writes generally require `runVar`; display/tokenization contexts may suppress randomness or side effects. Preserve these guards when extending built-ins.

- The parser silently catches ordinary matcher callback exceptions and leaves unknown expressions untouched (`src/ts/parser/parser.svelte.ts:1209`, `src/ts/parser/parser.svelte.ts:1926`). A malformed new callback may fail invisibly.

- Regex-script ordering is preset, then character, then module unless `<order n>` causes a global descending sort (`src/ts/process/scripts.ts:134`, `src/ts/process/scripts.ts:333`).

- Regex-script caching keys include data, mode, scripts, chat ID, flags, and CBS-expanded input, but not every mutable dependency a CBS function might read (`src/ts/process/scripts.ts:71`). Scripts that depend on changing external state can receive stale cached output unless cache invalidation is considered.

- Cache lookup uses `if(cached)`, so an intentionally empty cached result is treated as a miss (`src/ts/process/scripts.ts:136`).

- `@@inject` updates the stored message with the pre-replacement data and removes the matching text from the returned string (`src/ts/process/scripts.ts:207`). This is historical behavior, not conventional regex replacement.

- `editoutput` runs on every streaming chunk (`src/ts/process/index.svelte.ts:1482`). Handlers must be deterministic and cheap; side effects can fire repeatedly during one generation.

- `editdisplay` runs during re-render and must be treated as repeatable. Its trigger path is restricted and uses temporary variables, but plugin edit handlers have no equivalent automatic purity enforcement.

- Lua edit listeners do not run for `editprocess` (`src/ts/process/scriptings.ts:1375`). Regex and plugin handlers still do.

- A Lua trigger whose first effect is `triggerlua` bypasses the ordinary event-type filter and is offered the current mode callback (`src/ts/process/triggers.ts:1206`). The Lua code decides which mode-named function exists.

- Character low-level access is all-or-nothing for its triggers. Module trigger access follows `module.lowLevelAccess`; do not trust an arbitrary trigger’s stored `lowLevelAccess` independently of its owner.

- Display and request trigger effects are allowlisted by effect type (`src/ts/process/triggers.ts:1301`). New V2 effects will silently do nothing in those modes unless explicitly added to the correct allowlist.

- Manual trigger recursion is capped at 10 only when low-level access is absent (`src/ts/process/triggers.ts:1374`, `src/ts/process/triggers.ts:1772`).

- V2 local variables are indentation-scoped and cleared at `v2EndIndent` (`src/ts/process/triggers.ts:1138`, `src/ts/process/triggers.ts:1753`). Moving effects without preserving indent metadata changes semantics.

- `triggercode` is still accepted by types/UI detection but is not dispatched by `runTrigger()`. Treat it as compatibility residue unless implementing an explicit execution path.

- V2.0 plugins execute in the page’s JavaScript realm and are unsafe by design; they are deprecated and gated by `allowV2Plugin` (`src/ts/plugins/plugins.svelte.ts:903`).

- V2.1 safety is AST rewriting plus wrappers, not a secure process boundary. The checker itself warns that static analysis may miss unsafe behavior (`src/ts/plugins/pluginSafety.ts:155`).

- V3 is the actual iframe isolation boundary. Its CSP denies iframe-originated network connections, so plugin network access must cross `nativeFetch`/`risuFetch` RPC (`src/ts/plugins/apiV3/factory.ts:295`).

- V3’s `nativeFetch` blocks several Risu domains, but sensitive authorization headers currently produce only warnings rather than rejection (`src/ts/plugins/apiV3/v3.svelte.ts:776`).

- V3 main-DOM access returns remote `SafeElement` wrappers and requires `mainDom` permission (`src/ts/plugins/apiV3/v3.svelte.ts:1049`). All plugin-side wrapper calls are asynchronous even where host methods are synchronous.

- V3 provider registration asks for periodically reconfirmed `provider` permission, but the callback currently ignores the returned boolean and still invokes the provider (`src/ts/plugins/apiV3/v3.svelte.ts:798`). Do not assume a denied provider prompt blocks execution without fixing this path.

- Provider IDs are global names. V3 models become `pluginmodel:::<provider-name>` (`src/ts/plugins/apiV3/v3.svelte.ts:809`); duplicate names overwrite the callback map and can leave duplicate model metadata.

- `customV3ProviderMetaStore` is an array and is not cleared by `loadV3Plugins()` in the shown code. Reloading providers can accumulate stale/duplicate model entries even though plugin iframe instances are unloaded.

- Direct V3 `runLLMModel()` blocks plugin-backed models by default to avoid provider loops; callers must explicitly set `allowPlugins: true` (`src/ts/plugins/apiV3/v3.svelte.ts:1373`, `src/ts/plugins/apiV3/v3.svelte.ts:1391`).

- V3 `sendChat()` is permission-gated and explicitly refuses execution when the selected main model itself is plugin-backed (`src/ts/plugins/apiV3/v3.svelte.ts:1394`, `src/ts/plugins/apiV3/v3.svelte.ts:1408`).

- Plugin IPC requires both sender and receiver to name each other in `//@allowed-ipc` (`src/ts/plugins/apiV3/v3.svelte.ts:1455`, `src/ts/plugins/apiV3/v3.svelte.ts:1460`).

- Plugin storage namespaces are shared, not intrinsically isolated per plugin. Ownership records are best-effort sidecars for new writes and cannot reconstruct legacy ownership (`src/ts/plugins/pluginStorageMeta.ts:1`).

- `optimizePluginMemory` changes a compatibility boundary, not just performance. Enabled V2/V2.1 plugins must keep it off because their synchronous storage proxy still points at inline `pluginCustomStorage`; V3 callers use asynchronous helpers and can use external rows.

- Plugin-storage mode transitions intentionally prefer duplicates over loss. Externalize row-first then save the empty inline maps; internalize and save the complete maps before deleting rows. Server-side defensive re-externalization follows the same row-first ordering.

- `pluginsave/` and `pluginsave-meta/` key encoding is shared with the server: reversible unpadded base64url plus `.json`. Changing it requires coordinated client, server ingest/backup, viewer, and compatibility-test updates.

- Reversible plugin key encoding accepts only well-formed Unicode. Keep client `makeEncodedStorageKey()` and server `encodePluginSaveStorageKey()`/canonical decoding aligned; validate a whole transition before the first mutation so a rejected key cannot leave a half-externalized map.

- `pluginStorageFolded` is a recovery marker, not application/plugin data. Snapshot restore strips it after atomically clear-and-repopulate of `pluginsave/` and `pluginsave-meta/`; an unmarked historical snapshot must not clear those rows.

- V3 plugins can register MCP callbacks, but an identifier must begin with `plugin:` and the corresponding URL must still be present in an enabled module before `initializeMCPs()` activates it (`src/ts/process/mcp/pluginmcp.ts:45`, `src/ts/process/mcp/mcp.ts:20`).

- MCP tool names are not namespaced at model level. `callMCPTool()` scans `MCPs` and executes the first matching name (`src/ts/process/mcp/mcp.ts:164`). Avoid duplicate names across enabled servers.

- `initializeMCPs()` removes clients not present in the currently enabled module URL set (`src/ts/process/mcp/mcp.ts:129`). A registered plugin client alone is not enough to remain active.

- Remote MCP supports HTTP URLs generally, while the import UI permits plain HTTP only for localhost/127 addresses (`src/ts/process/mcp/mcp.ts:202`). Programmatically supplied module records receive the broader runtime URL validation at `src/ts/process/mcp/mcp.ts:111`.

- Remote MCP tool/prompt lists are cached for the client lifetime (`src/ts/process/mcp/mcplib.ts:787`). Dynamic server schema changes require client destruction/reinitialization.

- The internal filesystem client grants every exposed read/write/delete operation beneath one user-selected directory; the model is not prompted separately for each mutation (`src/ts/process/mcp/filesystemclient.ts:23`, `src/ts/process/mcp/filesystemclient.ts:252`).

- `internal:risuai` includes mutation tools for characters and modules. Enabling it gives the model application-editing capabilities, not merely read-only context.

- Classic tool providers frequently retain only text results. Anthropic preserves image results (`src/ts/process/request/anthropic.ts:1015`), while OpenAI and Gemini paths filter tool results to text (`src/ts/process/request/openAI/requests.ts:737`, `src/ts/process/request/google.ts:875`).

- Tool-call persistence stores full responses in the persistent KV layer and leaves only an opaque marker in chat text (`src/ts/process/mcp/mcp.ts:256`). Deleting that cache makes historical markers undecodable.

- ModelPreset tool execution explicitly prevents outer retry loops from rerunning side-effecting tools by setting `toolExecuted` (`src/ts/process/request/request.ts:189`). Preserve this invariant when changing retry behavior.

## 6. Navigation hints

- To add or change an ordinary `{{function}}`, edit its registration in `src/ts/cbs.ts:115` and verify normalization/dispatch in `src/ts/parser/parser.svelte.ts:1202`.

- To add CBS block syntax such as a new `{{#block}}…{{/block}}`, edit `blockStartMatcher()` and `blockEndMatcher()` at `src/ts/parser/parser.svelte.ts:1319` and `src/ts/parser/parser.svelte.ts:1599`; add a `doc_only` entry near `src/ts/cbs.ts:2366`.

- To change CBS nesting, user-defined functions, or recursion behavior, start at `src/ts/parser/parser.svelte.ts:1705`.

- To alter the order of Lua, trigger, plugin, CBS, and regex transforms, edit `processScriptFull()` at `src/ts/process/scripts.ts:99`.

- To add a regex metadata action such as `<move_top>`, edit metadata parsing at `src/ts/process/scripts.ts:297` and execution at `src/ts/process/scripts.ts:145`.

- To change where regex modes run in the chat lifecycle, inspect `src/ts/process/index.svelte.ts:772`, `src/ts/process/index.svelte.ts:801`, `src/ts/process/index.svelte.ts:1482`, and `src/ts/parser/parser.svelte.ts:921`.

- To change input-trigger or `editinput` ordering, inspect `sendMain()` at `src/lib/ChatScreens/DefaultChatScreen.svelte:328-400` and the `processScript()` wrapper at `src/ts/process/scripts.ts:26`.

- To add a Lua host API, declare it inside the engine-creation branch of `runScripted()` beginning at `src/ts/process/scriptings.ts:84`, then add a Lua wrapper if structured JSON/await behavior is needed near `src/ts/process/scriptings.ts:1211`.

- To change Lua low-level access, audit key creation/removal at `src/ts/process/scriptings.ts:1029` and every host API’s `ScriptingLowLevelIds` guard.

- To add a V2 trigger action, define its type near the existing V2 types, add it to `triggerEffectV2` at `src/ts/process/triggers.ts:33`, and implement its switch case after `src/ts/process/triggers.ts:1544`.

- To allow a trigger effect during display or request transformation, update `displayAllowList` or `requestAllowList` at `src/ts/process/triggers.ts:1024`.

- To change trigger pipeline timing, inspect callers at `src/ts/process/index.svelte.ts:787`, `src/ts/process/index.svelte.ts:1505`, `src/ts/process/request/request.ts:164`, and `src/ts/process/scripts.ts:109`.

- To add a V3 public API method, add a function to `makeRisuaiAPIV3()` at `src/ts/plugins/apiV3/v3.svelte.ts:753` and its promise-based declaration in `src/ts/plugins/apiV3/risuai.d.ts:1177`.

- To add a nested V3 API object or constant, follow `_getAliases()` and `_getPropertiesForInitialization()` at `src/ts/plugins/apiV3/v3.svelte.ts:1303` and `src/ts/plugins/apiV3/v3.svelte.ts:1352`.

- To change plugin permissions, update the permission union/list at `src/ts/plugins/apiV3/v3.svelte.ts:545`, dialog resolution at `src/ts/plugins/apiV3/v3.svelte.ts:671`, and reset logic at `src/ts/plugins/apiV3/v3.svelte.ts:589`.

- To tighten V3 iframe isolation or RPC serialization, inspect `SandboxHost.run()` at `src/ts/plugins/apiV3/factory.ts:483` and guest serialization at `src/ts/plugins/apiV3/factory.ts:46`.

- To change V2.1 static safety rules, edit `SAFETY_BLACKLIST` and identifier rewriting at `src/ts/plugins/pluginSafety.ts:21` and `src/ts/plugins/pluginSafety.ts:96`; bump `checkerVersion` at `src/ts/plugins/pluginSafety.ts:55`.

- To add a plugin-supplied model, follow `addProvider()` at `src/ts/plugins/apiV3/v3.svelte.ts:794`, model discovery at `src/ts/model/modellist.ts:752`, and dispatch at `src/ts/process/request/request.ts:1336`.

- To add a plugin edit hook, use the registry API at `src/ts/plugins/plugins.svelte.ts:537`; execution is at `src/ts/process/scripts.ts:124`.

- To change optimized plugin storage, update `pluginSaveStorage.ts`, `pluginStorageMeta.ts`, `pluginMemoryOptimization.ts`, `persistentKv.ts`, the settings/viewer UI, boot reconciliation, partial-backup folding, and the server `pluginSaveKeys.cjs` plus `pluginsave/` ingest/backup/snapshot helpers together.

- To add a plugin request-body or response replacer, inspect registration at `src/ts/plugins/plugins.svelte.ts:553` and execution at `src/ts/process/request/request.ts:154` and `src/ts/process/request/request.ts:220`.

- To add a built-in MCP client, subclass `MCPClientLike` at `src/ts/process/mcp/internalmcp.ts:8`, then add its `internal:` case in `initializeMCPs()` at `src/ts/process/mcp/mcp.ts:33`.

- To change remote MCP transport, handshake, OAuth, or schema caching, inspect `src/ts/process/mcp/mcplib.ts:228`, `src/ts/process/mcp/mcplib.ts:491`, `src/ts/process/mcp/mcplib.ts:607`, and `src/ts/process/mcp/mcplib.ts:782`.

- To add a Risu-access MCP tool, add its schema and handler to the appropriate class under `src/ts/process/mcp/risuaccess/`, then ensure the handler remains in `RisuAccessClient.handlers` at `src/ts/process/mcp/risuaccess/client.ts:73`.

- To change which tools are exposed to models, begin at `src/ts/process/request/request.ts:123` and `src/ts/process/mcp/mcp.ts:137`.

- To change tool execution or remembered history, inspect `src/ts/process/mcp/mcp.ts:162`, `src/ts/process/mcp/mcp.ts:259`, and the provider-specific recursive tool loops.

- To change ModelPreset tool gating, edit `requestModelPreset()` at `src/ts/process/request/request.ts:694`; to change execution limits or retry safety, edit `runModelPresetToolLoop()` at `src/ts/process/request/request.ts:952`.

## Out of scope, noticed

- Trigger editors and version-switching UI live under `src/lib/SideBars/Scripts/`, especially `TriggerList.svelte` and `TriggerV2List.svelte`.
- Module enablement and aggregation live in `src/ts/process/modules.ts`.
- Provider-specific tool wire formats live in `src/ts/process/request/openAI/requests.ts`, `anthropic.ts`, `google.ts`, and the ModelPreset adapter layer.
- Plugin settings, storage viewer, menus, and permission dialogs are implemented in Svelte UI files outside `src/ts/plugins/`.
