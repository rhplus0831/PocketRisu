# Boot mutation inventory

- Source: Area 1 — client change detection and save scheduling

This inventory records database mutations that can occur before reactive save
trackers have established their baselines.

| Before tracker installation | DB mutation | Current coverage |
|---|---|---|
| Initial decode followed by `setDatabase()` (`bootstrap.ts:151-157`; fallback `:164-170`) | Hundreds of root defaults/normalizations; bot-preset creation/IDs; plugin/plugin-storage defaults; model-preset snapshot sanitation/healing (`database.svelte.ts:37-738`) | Persisted baseline is captured before the call, but c49ecfde compares only plugin storage/meta. All other first effect runs absorb the live result. |
| Boot plugin-storage reconciliation (`bootstrap.ts:178-183`) | Externalization removes inline maps/meta; internalization restores them | Sound for scheduling: it uses a dedicated awaited full write and refreshes `patchSyncBaseline` (`bootstrap.ts:45-63`). A no-op reconciliation mutates nothing. |
| URL/PWA import kickoff (`bootstrap.ts:185-187`) | Non-low-level `#import_module` pushes synchronously before its first `await` (`characterCards.ts:412-427`); fetch/confirmation-backed character/module/preset paths resume asynchronously | Synchronous module path is uncovered. Async paths normally resume after tracker setup, but the loader is not awaited, so they have no explicit installation barrier. |
| Fresh-database customization (`bootstrap.ts:189-214`) | Applies theme preset and browser language | Uncovered root drift; an untouched fresh install can reload from the originally written `{}` and lose these first-boot choices. |
| `loadPlugins()` (`bootstrap.ts:216-219`) | Synchronous V2/V2.1 initialization can change any allowed root/characters/modules/plugins value; V3 `host.run()` is launched but not awaited (`plugins/apiV3/v3.svelte.ts:1501-1526`) | Only inline plugin storage/meta changes are compared. Other V2 startup writes are absorbed; V3 has no explicit tracker-ready barrier, although iframe execution normally occurs later. |
| `checkNewFormat()` (`bootstrap.ts:230`, `:433-621`) | Character default/shape repair, unsupported-group removal, module lore normalization/reset, persona IDs, format v2-v5 migrations, prompt replacement, expired-trash removal, `setDatabase()` rerun, and `checkCharOrder()` | Uncovered outside plugin storage. Draft orphan sweeping at `:611-621` changes separate KV rows, not `DBState.db`. |
| Stub conversion (`bootstrap.ts:232-239`) | Replaces wire stubs with runtime placeholders; removes `_stub` from legacy hybrids | Sound for ordinary stubs: `chatToStub()` reconstructs the same persisted representation, and hydration suppression deliberately prevents write-back. |
| UI-state startup (`bootstrap.ts:241-275`) | Sets `didFirstSetup = true`; display update helpers only read DB | `didFirstSetup` is uncovered root drift. Resource-cache announcement is browser-local and backup prompting does not mutate DB. |
| ID repair (`bootstrap.ts:276`, `:681-707`) | Assigns missing/duplicate character and chat IDs | Uncovered character/chat drift; durable-known chat IDs are then incorrectly seeded from this live result rather than the persisted baseline. |
| Calls after `saveDb()` is launched (`bootstrap.ts:277-285`) | `registerModelDynamic()` changes only the process model registry; `moduleUpdate()` changes Svelte/UI stores; cleanup/update/stats do not mutate DB synchronously | No additional pre-tracking `DBState.db` mutation found. `saveDb()` reaches async encoder initialization before installing effects, so future additions here still need an explicit tracker-ready barrier. |
| Draft restore | `DefaultChatScreen` loads drafts into component-local `messageInput` fields (`DefaultChatScreen.svelte:98-138`) | No `DBState.db` mutation. Drafts use their own KV scheduling. |
| Account/backend sync | `AutoStorage` always chooses `NodeStorage`; `checkAccountSync()` returns `false` (`autoStorage.ts:31-39`) | No account backend switch or boot-time DB replacement exists in this fork. |
