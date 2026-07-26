# Atomicity and acknowledgement

Enabled-mode ambiguity between what a plugin is told and what durably
committed. Inline mode performs local map mutations coalesced behind the
database save debounce, so these failure shapes do not exist there. See
[README.md](README.md) for the full index.

<a id="aa1"></a>
## AA1 — Value and owner metadata are separate commits

**Severity:** Medium

### Evidence

Ownership metadata is explicitly described as best-effort
(`src/ts/plugins/pluginStorageMeta.ts:1-8`), but the V3 facade makes it part
of every primary operation: `setItem` awaits the value write then the owner
write, `removeItem` awaits value deletion then owner deletion, and `clear`
awaits value clear then owner clear
(`src/ts/plugins/apiV3/v3.svelte.ts:1328-1339`). In optimized mode these are
separate, independently fallible server requests
(`src/ts/plugins/pluginStorageMeta.ts:60-115`).

If the primary operation succeeds and the metadata operation fails, the plugin
receives a rejection even though its value already changed durably; remove has
the mirror ambiguity (the value can be gone before owner deletion rejects).
Observed downstream consequences in the audited workloads:

- a plugin retries a row that is already authoritative, or aborts the
  remainder of a multi-key initialization under the false assumption that
  nothing committed;
- a manifest/index sequence stops after its body row committed, widening
  orphan and torn-generation windows (see AA3); and
- plugin-local caches are invalidated only on full success, so the server can
  hold a new value while the plugin cache holds the old one — or the server
  row is deleted while the cache retains a ghost.
- plugins that read-verify after writing add a third fallible optimized
  request; a transient verification failure again reports failure after
  commit.

### Required correction

- Make value plus owner one server-side transaction, or make owner writes
  genuinely best-effort and unable to reject the primary API call.
- If atomicity is unavailable, return a structured result such as
  `primary: committed, owner: failed`; do not use an undifferentiated
  rejection.
- Fault-inject owner-write, owner-remove, and verification-read failures after
  a successful primary mutation.

### Resolution

**Fixed 2026-07-26.** Save-backed V3 set/remove now use one authenticated
`POST /api/plugin-storage/mutate` operation. The server accepts one canonical
value key, derives the owner key itself, and runs the primary plus owner
mutation in one synchronous SQLite transaction inside
`queueStorageMutation()`. Empty owners remove stale metadata; remove always
cleans the matching owner orphan. Callers cannot target an unrelated row.

The response contract distinguishes a schema-valid known commit, an explicit
known rollback/refusal, and an unknown outcome after transport or malformed
acknowledgement. A committed set must return the exact SHA-256 of the detached
request bytes; wrong, missing, extra, or contradictory acknowledgements are
unknown and cannot publish resource-cache state. A post-commit verification
failure remains a known commit. Response loss after set or remove returns
unknown while the durable database contains the complete new state; cache
publication/invalidation waits for a verified commit.

An exact `503 IMPORT_IN_PROGRESS` refusal is the sole retryable mutation
acknowledgement. It is retried within the same total-operation timeout and
abort signal; malformed or unknown outcomes are never replayed. Exhaustion
preserves status, code, retry delay, retryability, operation, and commit state
on `PluginStorageMutationError`, including across the V3 iframe bridge.

Inline mode snapshots and validates value+owner maps before synchronously
publishing both, so it also cannot expose a partially updated pair. Regression
coverage fault-injects primary, owner, pre-commit, verification, and
post-commit/pre-response boundaries for set and remove, plus import refusal,
owner cleanup, malformed responses, and cache coherence. Independent
verification passed 128 focused tests, 9 atomicity compatibility tests, all
server and compatibility suites, `pnpm check`, and a production build.

<a id="aa2"></a>
## AA2 — Optimized `clear()` can partially apply

**Severity:** Medium

### Evidence

`clearPersistentPrefix()` lists all keys and launches independent deletes
through unbounded `Promise.all` (`src/ts/storage/persistentKv.ts:65-73`). If
one delete fails, the successful deletes remain durable, the call rejects, and
owner cleanup is never started. Inline clear is a single map replacement, so
failure/atomicity behavior changes with the setting. See also
[`../v3/warning/optimized-clear-can-partially-destroy-a-store.md`](../v3/warning/optimized-clear-can-partially-destroy-a-store.md).
Even plugins that never call `clear()` are exposed through bulk cleanup in the
built-in storage viewer.

### Required correction

- Add an atomic prefix-clear/batch-delete endpoint or a generation tombstone.
- Test failure at each mutation boundary and assert an unambiguous reported
  outcome.

### Resolution

**Fixed 2026-07-26.** Optimized full clear now uses a fixed authenticated
`POST /api/plugin-storage/clear` operation. The caller cannot supply a prefix;
the server deletes exactly `pluginsave/` and `pluginsave-meta/` inside one
`queueStorageMutation()` entry and one SQLite transaction. Pre-transaction and
mid-transaction failures preserve the complete old value+owner set, while a
committed response represents an empty set.

The client uses the shared structured storage-error contract to distinguish a
committed acknowledgement, explicitly not-committed failure, and an unknown
outcome after response loss or a malformed acknowledgement. It never
automatically replays an unknown mutation; a caller that still intends to
clear the current namespace may retry it. Import-time 503 refusal is explicitly
not committed and can be retried after the barrier opens. V3 `clear()` and the built-in viewer's
unfiltered full clear use this same primitive; inline mode publishes one fresh
empty value map. The former unbounded per-row `Promise.all` deletion path is no
longer reachable for plugin-storage clear.

Regression coverage fault-injects pre-transaction failure, transaction
rollback, response loss, retry, import refusal, concurrent writes, cache
invalidation, and V3/viewer callers. Independent verification passed 116
focused client/compatibility tests, all server and compatibility suites,
`pnpm check`, and a production build.

<a id="aa3"></a>
## AA3 — No batch/CAS primitive; unload can publish a torn but durable generation

**Severity:** High

### Evidence

There is no transaction, batch, or compare-and-swap operation for plugin
storage: each primary row reaches the generic `/api/write` branch and commits
independently with `kvSet()` (`server/node/server.cjs:4350-4356`), and the
server checks `x-if-match` only for `database/database.bin`
(`server/node/server.cjs:4241-4251`). Every logical V3 write is additionally
two mutations (value plus owner sidecar,
`src/ts/plugins/apiV3/v3.svelte.ts:1328-1331`).

PocketRisu waits for V3 unload callbacks for at most one second and then
terminates the sandbox (`src/ts/plugins/apiV3/v3.svelte.ts:523-551`). A plugin
that flushes a sharded record on unload — one audited workload persists up to
32 hash-partitioned rows plus metadata/manifest rows, i.e. ~36 logical writes
and ~72 sequential backend mutations — cannot reliably finish inside that
deadline, especially over a non-local connection or with resource-cache
hashing enabled. Reloading, disabling, or updating the plugin can terminate it
after an arbitrary durable prefix of the new generation.

Inline mode has no formal multi-key transaction either, but its row mutations
are normally coalesced behind the 500 ms database save debounce
(`src/ts/globalApi.svelte.ts:500-514`), so mid-sequence states are not
individually durable. Optimized mode makes every row immediately
authoritative, which also means automatic snapshots and pinned exports
triggered between a plugin's related writes (for example by a nearby chat
save, `server/node/server.cjs:5541-5589`) can capture a compound midpoint such
as an old index referencing new bodies. A value-success/owner-failure (AA1)
can create the same partial prefix even without termination.

The plugin-side halves of this problem — loaders that accept mixed
generations, and reused sub-row keys — are IP4.

### Required correction

- Provide an atomic plugin-storage batch operation, or version rows under a
  new generation and atomically publish one manifest pointer.
- Add per-key revisions/CAS for `pluginsave/` writes.
- Do not terminate an unload callback while acknowledged storage work remains;
  use a cancellable/extendable deadline and report an incomplete flush.
- Test unload after each logical write position of a sharded commit and after
  primary-success/owner-failure; on restart, only a complete old or complete
  new generation may load.
