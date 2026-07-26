# Performance and memory

Enabled-mode capacity and amplification issues — several of them defeat the
beta's own goal of reducing resident memory. See [README.md](README.md) for
the full index.

<a id="pm1"></a>
## PM1 — Large plugin values bypass chunking and multiply copies

**Severity:** Medium

### Evidence

Server chunking applies only to `database/database.bin`, backups, and chat
rows (`server/node/chunkStore.cjs:44-56`); a `pluginsave/` value goes through
the raw SQLite BLOB path regardless of size (`server/node/db.cjs:186-196`),
and the ordinary octet-stream parser buffers up to 2 GB
(`server/node/server.cjs:855-865`). This forfeits the large-value guard and
deduplication a comparably sized inline `database.bin` would receive, and
creates WAL, CPU, and peak-memory amplification for whole-value update
patterns (large embedding/vector sets, media stored as plugin values, many
snapshot-record bodies).

On the client, the complete value is `JSON.stringify()`-encoded before the
request (`src/ts/storage/persistentKv.ts:55-58`). With resource caching
enabled, `NodeStorage.setItem()` copies and hashes the full byte array, and
`storeBytes()` copies it again before optional IndexedDB persistence
(`src/ts/storage/nodeStorage.ts:298-346`,
`src/ts/storage/resourceCache.ts:437-467`). The global queue (SA2) remains
held throughout.

### Required correction

- Define and enforce per-value and aggregate limits with actionable errors.
- Make plugin value rows chunk-capable (keeping live and snapshot size
  enumeration chunk-aware), and use a bounded/streaming request path for
  genuinely large rows instead of the 2 GB buffered generic endpoint.
- Avoid redundant cache copies/hashes while the plugin-wide lock is held.
- Test large vectors, media, many record bodies, and resource-cache
  enabled/disabled combinations.

<a id="pm2"></a>
## PM2 — Mode transitions are not memory-bounded in either direction

**Severity:** Medium

### Evidence

**Enabling** takes `Object.entries()` snapshots of every inline value and
owner, then creates prepared-entry arrays that retain those payload references
through the final database save
(`src/ts/plugins/pluginSaveStorage.ts:206-255`); deleting each reactive-map
entry does not make its payload collectible while the arrays remain live, and
each row incurs a fresh `JSON.stringify()` plus UTF-8 allocation
(`src/ts/storage/persistentKv.ts:55-58`). Migration therefore does not lower
the source-store footprint progressively and adds at least one full-row
transient copy at the exact moment the user is trying to escape a large
resident store.

**Disabling** reads every external value into the reactive database, performs
one monolithic database encode/save, and only then deletes external rows
(`src/ts/plugins/pluginSaveStorage.ts:263-310`). There is no byte cap or
streaming path, and the UI displays only entry count with no byte guard
(`src/lib/Setting/Pages/PluginSettings.svelte:52-60`). A store with one very
large value or many moderately large rows can freeze the tab, exhaust memory,
or fail the transition — the workload the beta exists to serve. Plugin-side
size guards measured in JavaScript string length understate UTF-8 wire size
for non-ASCII data, so tens-of-MB stores are a realistic input.

With the optional resource cache enabled, the optimized read path also loads
and re-hashes up to four retained historical versions of a row before asking
the server which hash is current, then discards the loaded bytes and re-loads
the selected version (`src/ts/storage/resourceCache.ts:356-407`,
`src/ts/storage/nodeStorage.ts:372-415`).

### Required correction

- Externalize from an iterator that drops its last payload reference after
  each acknowledged row; do not retain full-store entry/prepared arrays.
- Estimate actual UTF-8 bytes before a transition; show bytes (not only entry
  count) and warn or refuse when a safe memory bound cannot be maintained.
- Make internalization incremental or stream into the database serializer,
  with cancellation and disk-space/memory preflight.
- Avoid loading every historical cache body merely to send hash validators;
  reuse one verified byte/hash allocation through the write path.
- Add heap/peak-allocation tests with multi-MiB rows, a 50–100 MiB store,
  non-ASCII strings, and the resource cache both on and off.

<a id="pm3"></a>
## PM3 — Recovery and tooling paths rematerialize the whole store

**Severity:** Medium

### Evidence

Three built-in paths reconstruct the external repository eagerly:

- the Plugin Storage viewer lists every key and owner, reads every value
  serially, and retains both the parsed value and a stringified copy per
  entry (`src/lib/Setting/Pages/PluginStorageViewer.svelte:171-221`) —
  opening it can approach two full browser copies of the repository plus
  per-entry overhead;
- partial local backup accumulates every external value and owner in JS
  objects, spreads them into a cloned full database, and monolithically
  encodes it (`src/ts/plugins/pluginSaveStorage.ts:44-68`,
  `src/ts/drive/backuplocal.ts:191-223`); and
- snapshot restore starts by calling `kvGet()` for the complete folded
  snapshot, and a chunked snapshot is reassembled with `Buffer.concat()`
  before the later streaming inspection can help
  (`server/node/server.cjs:6630-6658`,
  `server/node/chunkStore.cjs:238-249`) — a large folded snapshot can OOM the
  server on the recovery path.

High-cardinality, orphan-heavy repositories are realistic: audited workloads
append per-record payload and body rows without ever deleting superseded keys,
and V3 owner tracking adds a metadata row per key. Node-only portable/server
export already demonstrates the safer shape — it pins a SQLite snapshot and
preserves plugin rows as independent archive entries
(`server/node/server.cjs:2544-2589`, `:4719-4772`, `:4993-5045`).

### Required correction

- Page/lazily load viewer values and do not retain both parsed and serialized
  bodies for the complete repository.
- Move selective backup folding to a server-side streaming path, or stream map
  entries without an intermediate monolith.
- Feed chunked snapshots to restore through a chunk/file cursor instead of
  `kvGet()` reassembly.
- Add high-cardinality and large-body tests with bounded peak-memory
  assertions.

<a id="pm4"></a>
## PM4 — Write amplification and cache overhead

**Severity:** Medium

### Evidence

One V3 save-backed `setItem()` is two separately awaited host mutations —
value, then owner sidecar (`src/ts/plugins/apiV3/v3.svelte.ts:1328-1331`) —
and in optimized mode each becomes its own `/api/write` and SQLite mutation
(`src/ts/plugins/pluginSaveStorage.ts:87-96`,
`src/ts/plugins/pluginStorageMeta.ts:60-75`,
`server/node/server.cjs:4209-4370`), all serialized through the shared global
queue (SA2). Measured against audited workloads:

- one read-touch that also rewrites an index can become six serialized writes
  (value plus owner for three logical records);
- persisting one sharded record can multiply into dozens of sequential
  mutations, awaited on critical before/after-request paths; and
- a conventional `length()`/`key(i)` enumeration loop performs ~`2N` full
  server-list requests (`src/ts/plugins/pluginSaveStorage.ts:121-138`).

With the verified resource cache enabled, each value write also copies and
hashes the payload and awaits `storeBytes()`
(`src/ts/storage/nodeStorage.ts:298-345`), and that helper prunes by reading
all manifest keys, manifests, and entry keys after every write
(`src/ts/storage/resourceCache.ts:441-467`, `:726-754`) — repeated global
cache scans before the main request is dispatched or its response released.

### Required correction

- Coalesce value+owner writes and add batch APIs.
- Use key-scoped queues plus an exclusive transition barrier, bounded I/O,
  and amortized cache pruning.
- Provide an iterator/page API for enumeration (see SA2).
