# Plugin API serialization sweep

- Source: Area 2 — client/plugin boundary

## Host API serialization

| Host API group (all properties returned by `makeRisuaiAPIV3`) | Reply form and result |
|---|---|
| `risuFetch`, `nativeFetch` | `risuFetch` returns a plain legacy result; `nativeFetch` returns a `Response`, which `serialize()` converts to a status/header record plus transferable body stream (`v3.svelte.ts:768-800`; `factory.ts:378-401`). WebKit pre-reads the body into a transferable `ArrayBuffer` (`factory.ts:559-579`). No reactive fields accompany either transferable. |
| `getChar`/`getCharacter`, `getDatabase`, `getCharacterFromIndex`, `getChatFromIndex`, `getCurrentLorebookEntries`, `getColorScheme`, `getTextTheme` | All composite database replies are snapshots before publication (`plugins.svelte.ts:542-544`; `v3.svelte.ts:860-873`, `:897-902`, `:933-938`, `:963-1021`). They cannot carry a live `$state` proxy. Maps/Dates inside a snapshot are structured-cloneable; unsupported nested values reach the no-transfer retry/error path. |
| Scalar getters (`getArg`, `getArgument`, current indices, runtime info, permission result, storage key/length, translation cache) | Strings/numbers/booleans/null/undefined or plain arrays/records. Save-backed storage values specifically pass through the JSON de-proxy helper (`v3.svelte.ts:1292-1363`). |
| Mutators/registrations (`set*`, plugin install/load, provider/TTS/script/replacer, UI/MCP, send chat, IPC, alerts/logging, unload) | Return void, boolean, or plain `{id}`/plugin arrays after host work. Top-level callback parameters are converted to callback refs. Their later invocation is subject to the callback finding. |
| `readImage`, `saveAsset` | Image reads return typed bytes; the host collector transfers their `ArrayBuffer`. Asset saves return a plain asset identifier (`plugins.svelte.ts:823-837`). |
| `runLLMModel` | Success/failure/multiline results are plain. Streaming results contain a `ReadableStream`; the host collector recursively includes it in the transfer list (`v3.svelte.ts:1385-1405`; `factory.ts:337-359`). This root reply is covered; the inverse provider-callback stream is not. |
| `getRootDocument`, `createMutationObserver`, `getLocalPluginStorage`, and `SafeElement`/`SafeDocument`/`SafeClassArray` method returns | Top-level `REMOTE_REQUIRED` instances become registry refs (`factory.ts:363-376`). Methods returning another marked wrapper are likewise safe. Methods returning browser classes such as `DOMRectList` are not explicitly serialized and fall back to structured clone/safe-clone, potentially yielding a plain object rather than the declared prototype. Mutation callback arguments bypass the registry entirely. |
| Internal initialization APIs (`_getOldKeys`, `_getPropertiesForInitialization`, `_getAliases`) | Plain string arrays/records used to populate guest caches (`v3.svelte.ts:1308-1321`, `:1364-1384`). |

Plugin-to-host root requests encode top-level functions/remote refs and direct
option-object `AbortSignal` values before `postMessage` (`factory.ts:48-83`,
`:144-157`). Transferable buffers are collected recursively; nested callbacks
and classes remain unsupported. Callback calls are the incomplete sibling path.

## Storage modes and transitions

| Operation/path | `optimizePluginMemory = false` | `optimizePluginMemory = true` | Result |
|---|---|---|---|
| V3 `getItem` | Exact null/undefined check, then JSON round-trip de-proxy (`pluginSaveStorage.ts:71-83`) | Encoded `pluginsave/` JSON read with verified cache (`:83`) | Values are clone-safe in the ordinary JSON domain. Missing and stored null are intentionally indistinguishable. Errors reject. |
| V3 `setItem` | Mutates inline map and resolves (`:87-93`) | Awaits encoded KV write (`:94-96`) | Acknowledgement/durability differs by mode. |
| V3 remove | Deletes inline property (`:99-104`) | Awaits one KV remove (`:105-107`) | Errors reject; default branch cannot report later DB-save failure. The known v2 `/api/remove` writer-lock defect is separate. |
| V3 clear | Replaces inline map (`:110-115`) | Enumerates and independently removes prefix (`:117`; `persistentKv.ts:70-73`) | Optimized clear can partially apply. |
| keys/key/length | `Object.keys` on inline map (`pluginSaveStorage.ts:121-137`) | Server list plus reversible decode (`:127`) | List failures reject; no “empty on error” catch. Ordering is backend-defined. |
| Save owner sidecar | Inline `pluginStorageMeta` (`pluginStorageMeta.ts:63-75`) | Encoded `pluginsave-meta/` write (`:66-70`) | Uses the same storage queue/backend decision. Value then owner are separate operations, so a sidecar failure can leave an untagged value but does not destroy the value. |
| Off→on externalization | N/A | Precomputes and collision-checks every value and meta destination (`pluginSaveStorage.ts:206-229`), writes each row before deleting that inline entry (`:231-250`), then full-saves DB (`:255`) | Sound for JSON-compatible values. A crash/failure leaves the unprocessed source or duplicates, not a missing key. |
| On→off internalization | Lists/reads every canonical row into inline maps (`pluginSaveStorage.ts:263-301`), full-saves DB (`:303-304`), then deletes rows (`:305-310`) | N/A | Sound against single-client interruption: a failed save deletes no rows; a later deletion failure leaves equal duplicates. |
| Failed UI toggle rollback | Restores prior flag and runs the same reconciler (`PluginSettings.svelte:82-93`) | Same | Partial forward progress is folded back through source/destination precedence. A double failure is reported and retains at least one copy under the audited single-client ordering. |

Transition operations, V3 storage operations, owner operations, and viewer
save-backend operations join `withPluginSaveStorageLock()`
(`pluginSaveStorage.ts:15-25`). Enabled V2/V2.1 plugins cannot join that queue,
so optimization is prevented while one is enabled.
