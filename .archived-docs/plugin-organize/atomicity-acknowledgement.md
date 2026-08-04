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
failure/atomicity behavior changes with the setting. The original v3 source
report was `optimized-clear-can-partially-destroy-a-store.md`; it was
consolidated and is no longer retained as a standalone document.
Even plugins that never call `clear()` are exposed through bulk cleanup in the
built-in storage viewer.

### Required correction

- Add an atomic prefix-clear/batch-delete endpoint or a generation tombstone.
- Test failure at each mutation boundary and assert an unambiguous reported
  outcome.

### Resolution

**Fixed 2026-07-26.** Optimized V3 clear and the storage viewer's unfiltered
save clear now share `clearOwnedPluginSaveStorage()`. It resolves the BR2 exact
ownership manifest and submits one manifest-CAS
`commitOptimizedStorageMutation()` through `/api/plugin-storage/mutate`. The
server deletes only the active manifest-owned `pluginsave/` and
`pluginsave-meta/` rows, publishes an empty next manifest for the selected
generation, and marks the BR1 recovery obligation inside the same SQLite
transaction. Physical rows quarantined outside that manifest remain untouched.
Pre-transaction, row, or manifest-publication failures preserve the complete
old authoritative value+owner set; a committed response represents an empty
authoritative set.

The lower-level fixed-namespace `/api/plugin-storage/clear` endpoint remains
available, but it is no longer the V3 or viewer primitive.

The client uses the shared structured storage-error contract to distinguish a
committed acknowledgement, explicitly not-committed failure, and an unknown
outcome after response loss or a malformed acknowledgement. It never
automatically replays an unknown mutation; a caller that still intends to
clear the current namespace may retry it. Import-time 503 refusal is explicitly
not committed and can be retried after the barrier opens. Inline mode publishes
one fresh empty value+owner map. The former unbounded per-row `Promise.all`
deletion path is no longer reachable for V3 or unfiltered viewer save-storage
clear.

Regression coverage exercises exact manifest-owned deletion, quarantined-row
preservation, stale manifest CAS, transaction rollback, response loss, import
refusal, concurrent writes, cache invalidation, and V3/viewer callers.

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

### Resolution

**Fixed 2026-07-27.** V3 save storage now exposes bounded
`pluginStorage.getWithRevision(key)` and
`pluginStorage.atomicBatch(operations, unloadSignal?)` primitives in both
storage modes. A batch accepts 1–128 distinct, well-formed keys and at most an
exact 16 MiB encoded request. Each operation is a JSON `set` or `remove` and
may carry an expected opaque revision (including `null` for a required-missing
row). JSON values, keys, revisions, operation descriptors, and the complete
request are validated and detached before queue admission.

Optimized batches enter the import-aware mutation queue once. The request hash
now covers the BR2-selected database generation and its exact expected
ownership manifest as well as the ordered operations. The server rejects a
stale generation/manifest before checking row CAS or writing anything, and
versioned state reads are pinned to the same generation. Rows outside the
selected manifest are quarantined as absent even if stale physical bytes still
exist.

Every row CAS check, value mutation, derived owner-sidecar mutation, next exact
manifest publication, and BR1 recovery-dirty token update runs in one
synchronous SQLite transaction. No write occurs before all expected revisions
match. One canonical UUIDv4 generation identifies the AA3 transaction; every
set receives a new UUIDv4 owner incarnation, and its opaque SHA-256 revision
binds the exact value bytes to that incarnation. Rewriting identical bytes
therefore produces a new revision. Historical or malformed owner rows use a
deterministic raw-row fallback and are never trusted as modern incarnations.
Results preserve input key order and distinguish stored JSON `null` from a
missing row.

The deferred recovery snapshot is scheduled immediately at the known-commit
boundary, before verification or deliberate acknowledgement loss. Automatic
snapshots and pinned exports therefore observe either the prior exact manifest
or the complete committed batch, while restore continues to copy value rows
with byte-exact owner sidecars instead of fabricating ownership.

The wire contract has exact, request-bound schemas. A committed acknowledgement
must bind the request hash, canonical generation, ordered operation-specific
revisions (`set` has a revision; `remove` has `null`), and verification state.
Conflict acknowledgements must be a nonempty ordered subset of only the
request's CAS-bearing keys, cannot echo the supplied expected revision, and
carry canonical current state. Extra, duplicate, reordered, malformed, or
contradictory data makes the outcome unknown. Transport loss and malformed
success never trigger replay or cache publication. Only an exact known
`503 IMPORT_IN_PROGRESS` refusal is retried within the original timeout and
abort signal; retry exhaustion remains known-not-committed. Disposable cache
updates start only after an exact committed acknowledgement.

Client scheduling acquires a sorted set of per-key queues under the fair
shared/exclusive mode-transition barrier, preventing overlapping-batch
deadlocks without blocking unrelated optimized keys. Inline V3 publishers use
a whole-map publish mutex. Because V2/V2.1 writers must remain synchronous,
every legacy root, nested, clear, remove, lite-replacement, and full-replacement
path also advances a shared inline content version. A V3 batch that observes a
version change while hashing discards its stale clone, re-snapshots, rechecks
CAS, and only then publishes the detached value and owner maps in one
no-`await` critical section. Thus neither async V3 writers nor synchronous
legacy writers can be erased by stale whole-map publication.

The iframe guest performs descriptor-only validation and deep detachment of
atomic-batch arguments before `postMessage`. Accessors and `toJSON` are never
invoked; symbol/non-enumerable properties, sparse or subclassed arrays, class
instances, cycles, non-JSON values, duplicate/non-string keys, and malformed
Unicode are rejected before a host request exists. Host validation repeats the
key, JSON-value, revision, duplicate, archive-boundary, operation-count, and
encoded-size checks after the structured-clone boundary.

Unload storage admission is capability-scoped to the captured unload callback
and its signal. Once termination begins, forged, expired, or uncaptured
signals cannot open storage access; newly admitted storage is limited to the
bounded atomic batch and the IP5 bounded `updateItem()` helper. Mutations
accepted before the deadline—including pre-existing work when no unload
callback exists—remain tracked through their authoritative acknowledgement
before iframe removal. Expiry aborts further callback preparation without
cancelling admitted storage; a callback that still cannot finish after the
drain reports the typed `PLUGIN_UNLOAD_INCOMPLETE` outcome rather than silently
tearing work.

Regression coverage injects failure before the transaction; after every value,
owner, remove, and logical operation; after manifest publication; before
commit; during verification; and after commit before acknowledgement. It
covers exact BR2 manifest CAS and pinned ownership reads, BR1 dirty-token
publication/scheduling, exact 0/1/128/129-operation and
16 MiB boundaries, same-value rewrites, legacy/malformed rows, strict response
schemas, import retry success/exhaustion/cancellation, overlapping and disjoint
batch fairness, cancellation, transitions, every synchronous legacy race, and
forged/expired unload capabilities. Compatibility coverage actually restarts
the server against the same SQLite save directory and observes only the
complete old generation after rollback or the complete new generation after
commit.

These primitives do not by themselves rewrite unsafe plugin protocols. They
provide the host foundation still needed for IP1/IP4 guidance—distinguish
missing from failure, atomically publish a complete generation, and reject
stale writers with CAS—and are composed by the now-fixed IP5 cancellable
one-row update helper.
