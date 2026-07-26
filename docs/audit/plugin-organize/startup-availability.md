# Startup and availability

Enabled-mode failures that stall or abort plugin startup, or take the whole
application down. See [README.md](README.md) for the full index.

<a id="sa1"></a>
## SA1 — V3 startup is reported complete before async initialization settles

**Severity:** High

### Evidence

`executePluginV3()` creates the iframe, calls `host.run()`, and immediately
logs the plugin as loaded (`src/ts/plugins/apiV3/v3.svelte.ts:1501-1526`).
`host.run()` injects the plugin body into a nested async IIFE but neither
awaits it nor reports its resolution/rejection to the host
(`src/ts/plugins/apiV3/factory.ts:619-640`), so `loadV3Plugins()` waiting for
`executePluginV3()` does not wait for plugin code.

The loader gap itself is mode-independent, but it was invisible while storage
was a local object operation behind the bridge. With the beta enabled, a
common startup sequence such as
`await pluginStorage.getItem(...); registerProvider(...)` includes auth,
network, server, optional cache, and bridge work. If the read is slow,
registration occurs after the host has proceeded; if it rejects, the remainder
never runs, the rejection has no host readiness/error channel, and the plugin
remains listed as loaded. This is a direct explanation for plugins whose
registrations depend on persisted configuration appearing "powered on" while
registering no UI, provider, or hooks.

### Required correction

- Await a plugin-ready/error handshake; do not log "loaded" before the guest
  reports completion.
- Surface initialization failures in the UI.

<a id="sa2"></a>
## SA2 — One stalled operation wedges every plugin and the mode transition

**Severity:** High

### Evidence

`storageOperationQueue` is one process-wide promise chain for all keys,
plugins, viewer operations, backups, and transitions
(`src/ts/plugins/pluginSaveStorage.ts:15-25`). Optimized callbacks hold it
across authenticated server and optional IndexedDB cache I/O:

- neither `NodeStorage.authFetch()` nor the iframe request registry has a
  timeout or `AbortSignal` (`src/ts/storage/nodeStorage.ts:273-296`,
  `src/ts/plugins/apiV3/factory.ts:40-47`, `:144-157`); and
- with the resource cache enabled, an acknowledged server write also awaits
  cache hashing/persistence before releasing the lock
  (`src/ts/storage/nodeStorage.ts:298-346`,
  `src/ts/storage/resourceCache.ts:437-467`).

One stalled fetch, auth prompt, large row, or IndexedDB transaction therefore
leaves every unrelated plugin storage call pending — including the built-in
storage viewer and mode reconciliation. Inline callbacks release the queue
without network I/O and do not have this failure mode. Combined with SA1, the
application cannot distinguish a ready plugin from one waiting forever behind
another plugin's request. Plugins that intentionally serialize only per-key
find their independent-key design defeated by the host-global mutex.

Enumeration amplifies the problem: every `key(index)` and `length()` call
lists the whole prefix (`src/ts/plugins/pluginSaveStorage.ts:121-138`), so a
conventional `for (i < await length(); i++) await key(i)` loop becomes ~`2N`
full server-list requests instead of local `Object.keys()` work.

### Required correction

- Use per-key queues for ordinary operations and a separate exclusive
  transition barrier.
- Add bounded fetch/cache timeouts, abort support, and a typed "commit outcome
  unknown" result.
- Do not await best-effort cache seeding while holding the authoritative
  storage lock.
- Fetch a key snapshot once for enumeration, or expose an iterator/page API.
- Test a never-resolving write while a different plugin reads another key and
  while the user requests a mode transition.

<a id="sa3"></a>
## SA3 — Reconciliation failure aborts application boot

**Severity:** Medium

### Evidence

Boot awaits reconciliation on the critical path, before plugin loading
(`src/ts/bootstrap.ts:178-183`, `:216-219`), with no local recovery boundary:
an error reaches the outer boot catch (`src/ts/bootstrap.ts:293-295`).
Internalization lists and parses every external row before its save
(`src/ts/plugins/pluginSaveStorage.ts:263-304`,
`src/ts/storage/persistentKv.ts:41-52`). A corrupt or zero-length JSON row, a
transient list/read failure, or a failed boot migration can therefore prevent
the main application — and all plugins — from loading. This is most reachable
after an interrupted mode change leaves duplicates, or when an older build has
already written a malformed row.

### Required correction

- Validate rows when written and during server ingest.
- Isolate failures per row and provide a visible recovery flow that retains
  both copies; do not leave the application permanently behind the loading
  path.
- Record the offending encoded key without exposing its value.

<a id="sa4"></a>
## SA4 — Import and retry failures abort startup or expose uncommitted state

**Severity:** High impact, window-dependent

### Evidence

The server rejects storage mutations during import with a useful retry
contract: HTTP 503, `Retry-After`, `code: "IMPORT_IN_PROGRESS"`, and
`retryable: true` (`server/node/server.cjs:196-206`). `NodeStorage`, however,
turns this into a thrown string and performs no retry for plugin writes; its
other read/list/remove failures are also strings
(`src/ts/storage/nodeStorage.ts:320-327`, `:348-367`, `:470-531`). The iframe
host serializes `err.message || "Host execution error"`, so a thrown string
loses its status, code, retry timing, and even its original message
(`src/ts/plugins/apiV3/factory.ts:583-610`). Combined with SA1, a single
startup storage call during an import can abort all later registration while
the UI still reports the plugin loaded.

Reads have a separate consistency gap: `/api/list` waits for the import
barrier (`server/node/server.cjs:4107-4134`), but `/api/read` calls `kvGet()`
without doing so (`:3953-4017`). Import holds one raw transaction across
asynchronous work and clears the plugin prefixes before streaming replacement
entries (`server/node/importBarrier.cjs:4-19`,
`server/node/server.cjs:2802-2821`). Because the server uses the same SQLite
connection, a concurrent direct read can observe the transaction's cleared or
partially repopulated state; a plugin can initialize defaults from that
transient view even if the import later commits a different value or rolls
back.

### Required correction

- Preserve structured storage errors across `NodeStorage` and the iframe
  bridge.
- Apply a bounded retry policy for explicitly retryable, idempotent plugin
  operations; expose a distinct failure when the commit outcome is unknown.
- Put `/api/read` behind the same import barrier as `/api/list`, or serve
  reads from an isolated committed-snapshot connection.
- Test read, write, remove, and plugin startup while an import is held and
  while that import rolls back.
