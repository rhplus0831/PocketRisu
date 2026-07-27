# Mode-transition data loss

Findings that occur while enabling or disabling the beta. All require the
feature to be (or have been) on. See [README.md](README.md) for the full
index.

<a id="mt1"></a>
## MT1 — Disabling the beta can delete external rows after a save that never durably committed

**Severity:** High

### Evidence

The optimized-to-inline transition reads every external value and owner into
`DBState.db`, awaits its persistence callback, then unconditionally deletes
every listed `pluginsave/` and `pluginsave-meta/` row
(`src/ts/plugins/pluginSaveStorage.ts:263-310`). The production callback is
`requestImmediateSave({ forceFullWrite: true })`
(`src/ts/plugins/pluginSaveStorage.ts:177-180`), which is not a durability
barrier:

- before `saveDb()` finishes installing its implementation it is a silent
  no-op (`src/ts/globalApi.svelte.ts:255-257`); bootstrap exposes the loaded UI
  and starts `saveDb()` without awaiting it (`src/ts/bootstrap.ts:273-279`);
- if a save is already in flight, `triggerSave()` joins that older save and
  discards the new `forceFullWrite` request — a follow-up save is chained only
  for `forceChatPersist` (`src/ts/globalApi.svelte.ts:1046-1052`);
- a full-write ETag conflict rebases and returns `retry` rather than durably
  committing this attempt (`src/ts/globalApi.svelte.ts:1017-1023`);
- persistence exceptions are caught, requeued, and not rethrown
  (`src/ts/globalApi.svelte.ts:1059-1089`); and
- `requestImmediateSaveImpl()` resolves `void` with no `saved`/`retry`/`noop`
  outcome (`src/ts/globalApi.svelte.ts:1092-1098`).

The reconciler therefore treats a no-op, unrelated save, conflict, or failed
write as a durable inline commit and starts deleting the durable external
rows, while the only durable `database.bin` may still have
`optimizePluginMemory: true` and an empty inline store. The settings UI then
reports that optimization was disabled
(`src/lib/Setting/Pages/PluginSettings.svelte:60-81`).

For a write-heavy workload the deleted set can include configuration and
credential vaults, per-record indexes and payloads, sharded record bodies, and
every owner sidecar. The values survive only in browser RAM pending a later
background retry; closing or refreshing in that window boots the prior
optimized database — whose inline map is empty — after its external rows are
gone. A repeatable database-write rejection can let the deletion finish while
every retry fails.

The unit test for a failed internalizing save injects a callback that rejects
and asserts no rows are removed
(`src/ts/plugins/pluginSaveStorage.test.ts:453-475`). It does not model the
production save layer swallowing/retrying failures or joining an older save;
the contrary conclusion in
[`../v3/appendix/plugin-api-serialization-sweep.md`](../v3/appendix/plugin-api-serialization-sweep.md)
holds only for that injected dependency.

### Required correction

- Introduce a save primitive that returns only after the exact normalized
  database snapshot has been acknowledged as durable, with a
  `committed | retry | failed | displaced` outcome.
- A force request arriving during another save must queue a second force save,
  not inherit the older promise.
- Delete external rows only after `committed` for the intended snapshot;
  prefer one server-side transaction for the whole mode change.
- Deterministic tests: pre-initialization no-op, in-flight ordinary save,
  409, 500, network failure, writer displacement, and close-before-retry. In
  every non-commit case all external rows must remain.

### Resolution

**Fixed 2026-07-26 in `75b0f28f`.** Database saves now return an explicit
`committed | retry | failed | displaced` outcome, and a durability-sensitive
force request queues its own save after any older in-flight save instead of
inheriting that save's promise. Cleanup accepts only `committed`; the direct
reconciler persists the complete inline database before deleting external
rows, and a failed persistence attempt leaves every external value and owner
row intact.

The later staged-transition protocol strengthens that boundary in production:
it first durably saves and binds the source database, keeps migrated rows in a
private stage, and publishes the target database, mode, generation, manifest,
and row ownership together at finalize. A definitive failure restores or
aborts without publishing the target, while an unresolved finalize latches
plugin operations and database saves until reload rather than risking a second
publication from ambiguous state.

Regression coverage in `src/ts/storage/databaseSave.test.ts` verifies the
queued force-save and every non-commit outcome. Coverage in
`src/ts/plugins/pluginSaveStorage.test.ts` verifies save-before-delete, row
preservation after a rejected internalizing save, refresh after successful
cleanup, staged identity/content rejection, rollback, and the unresolved
finalize latch.

<a id="mt2"></a>
## MT2 — The mode flag changes outside the storage queue

**Severity:** High

### Evidence

Every storage operation chooses its backend inside its queued callback by
reading the live `db.optimizePluginMemory` flag
(`src/ts/plugins/pluginSaveStorage.ts:71-138`). The disable UI, however:

1. enqueues and awaits an external-row count
   (`src/ts/plugins/pluginSaveStorage.ts:140-147`), which holds the queue
   while two server lists are pending;
2. changes the mode flag outside the queue; and
3. only then enqueues reconciliation
   (`src/lib/Setting/Pages/PluginSettings.svelte:44-71`).

With a backlog of two or more operations queued behind the count
(`storageOperationQueue`, `src/ts/plugins/pluginSaveStorage.ts:15-25`):

1. external row `K` contains `old`; the inline map is empty;
2. the count resolves; the first queued operation starts against the external
   backend and awaits I/O;
3. the UI continuation flips the flag to `false` and appends reconciliation
   behind the remaining queued operations;
4. a queued `setItem(K, new)` sees `false` and writes `new` inline (a queued
   `removeItem(K)` deletes nothing); and
5. reconciliation reads external `old`, unconditionally assigns it over the
   inline key (`src/ts/plugins/pluginSaveStorage.ts:281-301`), persists the
   database, and deletes the external row.

The new value is lost, or the removed value is resurrected. A queued
`getItem()` in the pre-migration window can also return `null`, causing a
plugin to initialize defaults. Concurrent operations are realistic: debounced
input/change/blur saves, background persistence, parallel plugin tasks, and
the fact that a value and its owner sidecar are separate queue entries all
create backlogs. The enable direction has the same structural defect whenever
an old-mode backlog exists, though the disable path is the realistic
reproduction.

### Required correction

Expose one `transitionPluginStorageMode(target)` operation that acquires the
storage barrier before changing the flag: drain old-mode operations, set the
flag inside the lock, migrate and durably persist, then release new-mode
operations. Counting/progress must occur inside the same transition or use a
read-only preflight that cannot alter ordering. Add a deterministic test that
holds the count's list I/O, queues two SETs (and separately two removes),
releases the count, and asserts the newest operation survives the toggle.

### Resolution

**Fixed 2026-07-26.** `transitionPluginStorageMode(target)` now acquires the
shared storage queue before changing the live mode, performs progress counting,
migration, and the exact-snapshot durable save while holding that barrier, and
keeps later V3/viewer work blocked until either the transition or its rollback
finishes. The settings UI no longer changes the flag or reconciles storage as
separate operations.

Because V2/V2.1 storage is synchronous and cannot join the async queue, the
transition also acquires a shared legacy guard before it starts draining queued
work. Legacy enable, import, load, retained storage/database APIs, and both V2
execution paths enforce that guard. Values entering the legacy storage surface
are validated as JSON and snapshotted from own data descriptors, so neither
caller-retained aliases, getters, inherited `toJSON`, Proxy `get` traps,
inherited setters, nor prototype mutation can bypass the transition barrier.

Regression coverage in `src/ts/plugins/pluginSaveStorage.test.ts` holds list,
read, persistence, and serialized-write boundaries while exercising queued
SET/remove operations, rollback, actual retained V2 APIs, caller-owned aliases,
unsafe descriptors/prototypes, and the V2.0 execution boundary. The independent
verification pass completed with 35 focused tests, the full client suite (975
passed, 3 skipped), `pnpm check` with no errors, and a production build.

<a id="mt3"></a>
## MT3 — Special property names are lost or misread by the inline object backend

**Severity:** Medium

### Evidence

The optimized backend can store any well-formed string as an encoded row name.
The inline backend uses ordinary `{}` objects with raw bracket lookup and
assignment (`src/ts/plugins/pluginSaveStorage.ts:71-92`, `:121-127`,
`:278-295`), which inherit `Object.prototype` and give `__proto__` special
setter behavior.

An optimized value stored under `__proto__` is therefore lost when the feature
is disabled:

1. internalization executes `db.pluginCustomStorage[key] = value`;
2. for `__proto__` this changes or ignores the object's prototype instead of
   creating an enumerable own property;
3. the database encoder persists an empty map; and
4. reconciliation deletes the external row
   (`src/ts/plugins/pluginSaveStorage.ts:303-310`).

`readExternalizedPluginStorage()` builds its `values`/`meta` maps the same way
(`src/ts/plugins/pluginSaveStorage.ts:44-68`), so a partial backup can omit
the key. Missing inline lookups for `constructor`, `toString`, or
`hasOwnProperty` can return an inherited function instead of `null`, after
which the JSON de-proxy round trip can throw. The behavior changes solely with
the optimization mode. Conventionally prefixed plugin keys do not exercise
this boundary, but the public V3 contract accepts arbitrary string keys, so it
remains a host defect.

### Required correction

- Represent plugin maps with null-prototype objects or a real `Map` at
  internal boundaries; create own properties explicitly when producing a
  serializable record.
- Use an own-property presence test for reads.
- Round-trip `__proto__`, `constructor`, `prototype`, `toString`, and an empty
  key through set/get/list, both mode transitions, and partial backup.

### Resolution

**Fixed 2026-07-26.** Plugin-storage boundary records now use null prototypes,
while records stored in Svelte state use ordinary prototypes plus explicit own
data-property creation so they remain deeply reactive. Reads test own presence;
value and owner maps, mode transitions, viewer/backup assembly, database-load
normalization, V2 compatibility APIs, and partial-backup merging all use the
shared safe-record helpers. A retained V2 database-storage handle is a live
facade over the current map, so first-time special keys remain enumerable,
serializable, reactive, and valid after map replacement or a mode transition.

Database-aware cloning preserves both plugin maps across initial save
baselines and ETag-conflict rebases. Changes involving an own `__proto__` use a
whole-map JSON Patch replacement rather than a forbidden nested path. Because
`msgpackr` deliberately renames `__proto__` in ordinary maps, exact legacy
backups use dedicated marked raw/compressed/stream headers (10/11/12) and a
schema-validated, collision-preserving envelope. Standard saves retain the
upstream headers byte-for-byte, and only marked formats authorize restoration;
the protocol is mirrored by client, server, and streaming codecs.

Regression coverage round-trips `__proto__`, `__proto_`, `constructor`,
`prototype`, `toString`, `hasOwnProperty`, and the empty key through V2/V3
reads, writes, enumeration, metadata, both transitions, real partial-backup
encoding, client/server decoding, streaming import/export, Svelte snapshots,
reactive nested updates, conflict rebasing, and JSON Patch add/update/removal.
Independent verification passed 113 focused tests, 990 client tests (3
skipped), 138 server tests, 95 compatibility tests (5 skipped), `pnpm check`,
and a production build.
