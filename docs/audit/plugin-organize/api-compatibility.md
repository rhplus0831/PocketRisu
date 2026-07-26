# API and runtime compatibility

Enabled-mode divergences between the optimized backend and the inline store
that the current eligibility gate does not detect. See
[README.md](README.md) for the full index.

<a id="ac1"></a>
## AC1 — V3 database access and mode-aware `pluginStorage` form a split-brain store

**Severity:** High

### Evidence

The eligibility gate asks only whether every enabled plugin declares API V3
(`src/ts/plugins/pluginMemoryOptimization.ts:5-30`), but V3 still exposes the
upstream-compatible `getDatabase()` / `setDatabase*()` access path to
`pluginCustomStorage`, and that path is not mode-aware:

- the field is in `allowedDbKeys` (`src/ts/plugins/plugins.svelte.ts:503-527`);
- `getDatabase()` snapshots every requested allowed field
  (`src/ts/plugins/apiV3/v3.svelte.ts:860-873`);
- V3 directly exports the legacy `setDatabaseLite` and `setDatabase`
  functions (`src/ts/plugins/apiV3/v3.svelte.ts:854-855`); and
- both the public declaration and the checked-in plugin guide document the
  field (`src/ts/plugins/apiV3/risuai.d.ts:337-356`, `:1388-1421`,
  `plugins.md:708-757`).

Optimized mode deliberately leaves the inline field empty
(`src/ts/storage/database.svelte.ts:727-729`); only the `pluginStorage`
aliases read the external rows
(`src/ts/plugins/pluginSaveStorage.ts:71-138`), while the legacy setters still
write the inline field (`src/ts/plugins/plugins.svelte.ts:772-806`).

The resulting behavior is not merely a stale read:

1. a V3 plugin reads `getDatabase(["pluginCustomStorage"])` and receives `{}`;
2. it interprets its state as missing and writes defaults through
   `setDatabaseLite()`;
3. the save tracker observes the inline mutation
   (`src/ts/globalApi.svelte.ts:595-605`);
4. the server upserts those inline entries into `pluginsave/` and strips them
   from its database view (`server/node/server.cjs:2419-2442`, `:2453-2470`);
   and
5. the client patcher retains the unstripped inline field
   (`src/ts/storage/risuSave.ts:932-1007`, `:1163-1168`) while the server
   patch cache retains the stripped field
   (`server/node/server.cjs:4495-4502`).

The next patch can hash-mismatch and fall back to a full write, which
reinitializes the client patcher from its own unstripped payload
(`src/ts/globalApi.svelte.ts:1009-1031`), so the mismatch and
re-externalization can repeat. A later, newer `pluginStorage.setItem()` value
can be overwritten by the stale inline value carried by a subsequent database
write.

Replacement semantics are also incompatible: in optimized mode,
`setDatabaseLite({pluginCustomStorage: {}})` does not clear external rows and
a subset does not delete omitted rows — server preparation upserts entries and
clears the prefix only for an explicitly folded recovery object
(`server/node/server.cjs:2431-2442`).

Real plugins do read this field (one audited workload requests and scans it
for prompt/mode variables and ships a self-test for storage-mode detection),
so an all-V3 plugin can change behavior when the beta is enabled even though
the UI declares it eligible.

### Minimal reproduction

```js
await risuai.pluginStorage.setItem("cfg", { value: "real" });

const db = await risuai.getDatabase(["pluginCustomStorage"]);
// Optimized mode returns an empty compatibility map.
db.pluginCustomStorage.cfg = { value: "default" };
await risuai.setDatabaseLite(db);
```

### Required correction

- Treat direct `pluginCustomStorage` access as a V3 capability
  incompatibility, not as proof that all V3 plugins are eligible.
- When the field is explicitly requested, either materialize an on-demand
  snapshot of the authoritative rows or return an explicit
  unsupported/capability result.
- Make `setDatabase*()` mode-aware with defined replace/merge semantics; it
  must not leave optimized inline state resident in the client or silently
  upsert a stale subset.
- Add a V3 bridge test that mixes `getDatabase`, `setDatabaseLite`, and
  `pluginStorage` across save cycles.

### Resolution

Fixed. V3 database access now materializes `pluginCustomStorage` from the
authoritative backend under the shared storage queue and returns a detached
snapshot in either mode. `setDatabase()` and `setDatabaseLite()` merge only
the ordinary database roots that are present, while an explicitly supplied
`pluginCustomStorage` is an exact replacement (`{}` clears it and omission
preserves it). Optimized replacements update external rows, remove omitted
values and orphan owner metadata, and scrub the inline value and metadata
maps so stale state cannot be re-externalized.

The real V3 bridge now applies each `pluginStorage` value and ownership change
in one ordered operation. Both the guest bridge and host validate database
setter inputs before reading values, including special property names and
late prototype additions, so accessors and unsupported descriptors cannot
cross the iframe boundary unnoticed. Regression coverage exercises the real
V3 factory, exact replacements racing `setItem`/`removeItem`/`clear`, inline
and optimized modes, save patch cycles, production server hash convergence,
full-set plugin installation filtering, and special-key cleanup.

<a id="ac2"></a>
## AC2 — V2 lifecycle and invalid-state handling are incomplete

**Severity:** Medium

V2/V2.1 incompatibility itself is intentional: those APIs are synchronous and
cannot use the async external backend. Imports arrive disabled, enable
attempts are blocked, and the runtime filters them
(`src/ts/plugins/pluginMemoryOptimization.ts:5-30`,
`src/ts/plugins/plugins.svelte.ts:382-399`, `:451-466`). Two lifecycle gaps
surround that rule.

### AC2a — eligibility can race unload completion

The setting becomes eligible as soon as `plugin.enabled` is false
(`src/lib/Setting/Pages/PluginSettings.svelte:38-45`). The power button starts
`loadPlugins()` without awaiting it (`:231-244`), while V2 unload callbacks
are awaited before registries are cleared
(`src/ts/plugins/plugins.svelte.ts:842-854`). A delayed unload callback or
timer can still use the synchronous inline storage API
(`src/ts/plugins/plugins.svelte.ts:735-770`). If the beta is enabled during
that interval, reconciliation snapshots the inline entries once
(`src/ts/plugins/pluginSaveStorage.ts:206-209`); a late V2 write remains
inline after optimized mode is active and is invisible to mode-aware V3 reads
until a later defensive save or restart changes its location.

### AC2b — reachable invalid states look enabled but do not run

A restore, manual database edit, or V3 `setDatabase*()` call can create
`optimizePluginMemory: true` plus an enabled V2/V2.1 record. Boot reconciles
storage before loading plugins (`src/ts/bootstrap.ts:178-183`, `:216-219`);
the loader filters the legacy plugin but deliberately leaves
`enabled: true`, logging only to the console
(`src/ts/plugins/plugins.svelte.ts:451-459`), and the settings UI disables the
optimization checkbox while that enabled record exists
(`src/lib/Setting/Pages/PluginSettings.svelte:107-120`). The user sees a
powered-on plugin that never runs; recovery requires powering the plugin off,
disabling optimization, and powering it on again.

### Required correction

- Await a shared plugin-lifecycle barrier before checking eligibility or
  beginning a storage transition.
- Resolve invalid persisted combinations at boot with a visible choice or a
  safe, explicit policy; do not silently retain `enabled: true` for code that
  was skipped.

### Resolution

**Fixed 2026-07-26.** Plugin load, unload, import, enable, removal, and storage
mode transitions now share one lifecycle queue. A transition drains every
earlier V2 unload callback before its final eligibility check and keeps later
plugin generations behind the mode reconciliation. V2 registries are detached
before callbacks run and cleared again afterward, including when a callback
rejects. Plugin-requested reloads are deferred and coalesced so an unload
callback can request one without re-entering or deadlocking its own teardown.

An optimized database that contains enabled V2/V2.1 records now applies an
explicit fail-closed policy: those records are visibly powered off, the user
is warned, and boot/manual/V3 database-list paths require a durable database
save. Plugin import, power, and removal mutations likewise require an exact
forced save. Failed or displaced commits roll back against the current live
plugin list by stable name and original position, so a V3 teardown callback
that replaces the list cannot leave enabled records, duplicates, provider
state, or hot-reload markers behind. Safe disable/removal mutations are still
committed before unload errors are surfaced.

Regression coverage holds delayed and rejecting unload callbacks, requests
reloads from plugin callbacks, queues mode transitions and V3 list
replacements, injects every non-committed save outcome, and verifies live
runtime plus durable rollback snapshots. Independent verification passed 73
focused tests, the full client suite (1,022 passed, 3 skipped), `pnpm check`,
and a production build; the fixer also passed all server and compatibility
suites.

<a id="ac3"></a>
## AC3 — Unguarded ES2024 key validation breaks older browser runtimes

**Severity:** High on affected runtimes

### Evidence

The client key encoder calls `value.isWellFormed()` directly
(`src/ts/storage/persistentKv.ts:16-27`) with no feature test or polyfill. The
build target is `baseline-widely-available` (`vite.config.ts:66-68`), but
transpilation targets do not synthesize missing built-in prototype methods. An
older Chromium/WebKit WebView therefore throws
`TypeError: value.isWellFormed is not a function` for every optimized
`getItem`, `setItem`, or `removeItem` call. Inline mode performs no such call.
The server copy uses the same method (`server/node/pluginSaveKeys.cjs:20-31`),
but the declared Node requirement is new enough (`package.json:6-8`); the
client has no equivalent runtime requirement or startup capability check.

There is also a runtime-contract mismatch: the public type requires a string
key, but an untyped plugin passing a number is coerced to a property key by
the inline object branch while throwing at `.isWellFormed()` in optimized mode
(`src/ts/plugins/pluginSaveStorage.ts:71-106`). Such input is outside the
declared API, but the setting should not silently change coercion behavior.

### Required correction

- Implement well-formed UTF-16 validation without assuming the prototype
  method, or ship a tested polyfill before storage initialization.
- Add a client startup capability test and an automated legacy-WebView target
  test.
- Either coerce keys to strings consistently at the public boundary or reject
  non-strings with the same explicit error in both modes.

### Resolution

**Fixed 2026-07-26.** Client storage now feature-tests
`String.prototype.isWellFormed` when the validation module initializes and
uses a portable UTF-16 scanner when that ES2024 method is unavailable. Both
paths reject lone surrogates before UTF-8/base64url encoding while preserving
valid astral pairs and literal replacement characters.

The mode-independent plugin-storage boundary now coerces runtime keys to
strings and validates them before either the inline or optimized backend is
selected. Untyped V3 callers therefore receive the same set/get/remove and
enumeration behavior in both modes instead of succeeding inline and throwing
only after optimization is enabled.

Regression coverage simulates a legacy WebView by removing the native method
before module initialization, exercises malformed and valid UTF-16 input, and
uses the real V3 bridge to verify numeric-key parity in both modes.
Independent verification passed 51 focused tests, the full client suite
(1,005 passed, 3 skipped), `pnpm check`, and a production build.

<a id="ac4"></a>
## AC4 — Value and enumeration parity gaps

**Severity:** Low–Medium

### JSON acknowledgement

`writePersistentJson()` passes `JSON.stringify(value)` directly to
`TextEncoder` without validating that the result is defined or faithful
(`src/ts/storage/persistentKv.ts:55-58`). Top-level `undefined`/functions can
produce an acknowledged empty row; `Map`/`Set` become `{}`; nested unsupported
fields vanish; non-finite numbers become `null`; cycles/`BigInt` throw. The
public contract says JSON-serializable values, so many of these inputs are
plugin errors, but the host must not acknowledge an unrepresentable value and
then fail later during read, backup, or mode transition. See
[`../v3/warning/persistent-json-acknowledges-unrepresentable-values.md`](../v3/warning/persistent-json-acknowledges-unrepresentable-values.md).

### Key ordering

Inline `keys()` uses ECMAScript `Object.keys()` order
(`src/ts/plugins/plugins.svelte.ts:755-769`). Optimized `keys()` preserves
server list order (`src/ts/plugins/pluginSaveStorage.ts:34-41`, `:121-134`),
while the SQLite queries have no `ORDER BY` (`server/node/db.cjs:136-139`,
`:244-249`) and list-delta merging removes modified keys then appends them
(`src/ts/storage/nodeStorage.ts:494-506`). A plugin relying on stable
`key(index)` order can skip or revisit entries after a write.

### Required correction

- Validate JSON representability before acknowledging a write.
- Define and implement a stable enumeration order shared by both modes, or
  document the instability and provide a snapshot/iterator API (see PM4).
