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
request (`src/ts/storage/persistentKv.ts:55-58`). SA2 moved ordinary work to
per-key queues and detached bounded cache seeding after the authoritative
acknowledgement, so an unrelated key is no longer held behind this work.
PM1 remains open: `NodeStorage.setItem()` still makes a defensive full-byte
copy and begins a full hash, and detached `storeBytes()` makes another
copy/hash before optional IndexedDB persistence
(`src/ts/storage/nodeStorage.ts:298-346`,
`src/ts/storage/resourceCache.ts:437-467`). Server buffering and the absence
of value/aggregate limits are unchanged.

### Required correction

- Define and enforce per-value and aggregate limits with actionable errors.
- Make plugin value rows chunk-capable (keeping live and snapshot size
  enumeration chunk-aware), and use a bounded/streaming request path for
  genuinely large rows instead of the 2 GB buffered generic endpoint.
- Avoid redundant full-value cache copies/hashes while preserving detached,
  bounded best-effort seeding.
- Test large vectors, media, many record bodies, and resource-cache
  enabled/disabled combinations.

### Resolution

**Fixed 2026-07-26.** Optimized plugin values now have an exact serialized
UTF-8 capacity contract. The browser measures the JSON byte length before
dispatch and rejects values above the 128 MiB default per-value cap with a
structured, non-retryable storage error. The authoritative server enforces the
same per-value default plus a 1 GiB aggregate default (both server defaults are
configurable), reports the limit and actual byte count in structured 413
responses, and permits an already-over-limit repository to shrink without
allowing further growth. A persistent logical-byte counter is updated in the
same SQLite transaction as every write, replacement, copy, deletion, and
prefix clear, and is rebuilt from live rows on boot so rollback, older data,
and interrupted maintenance cannot leave quota accounting stale.

`pluginsave/` is now a chunk-capable namespace. Large live values use the same
content-defined chunk store and deduplication as other large server rows, while
reads, copies, prefix deletion, portable export, live enumeration, and pinned
snapshot enumeration operate on logical values and byte sizes rather than the
chunk marker. Import mutations participate in the enclosing SQLite transaction,
so a failed import rolls back both rows and aggregate usage. Concurrent writes
are admitted under the server mutation queue and re-evaluate the counter in
their transaction, preventing two individually valid requests from jointly
exceeding the aggregate cap.

Single-row owned mutations of at least 1 MiB keep the canonical atomic
`/api/plugin-storage/mutate` protocol but opt into parser-free streaming. The
server requires an exact `Content-Length`, bounds and hashes bytes
incrementally while spooling to a temporary file, and holds the authoritative
mutation queue only for the file-to-chunk SQLite commit; every exit removes
the spool file. Older clients remain supported through `/api/write`, but
`pluginsave/` bodies on that route use the per-value parser cap instead of the
generic 2 GiB octet-stream limit.

The client snapshots, stringifies, measures, and encodes ordinary writes,
owned writes, and exact V3 database replacements before entering SA2's
shared/key or exclusive barrier. The fresh prepared buffer is reused for the
request. The client still computes one request-bound SHA-256 digest so it can
verify the acknowledgement; the server computes its streamed digest
incrementally. After acknowledgement, the server-provided digest and the same
immutable buffer are donated to detached best-effort cache seeding, so the
cache performs no second full-value copy or hash; disabled and
over-cache-limit values are skipped before either cost. Cache reads continue
to verify stored bytes independently.

Legacy save-folder migration also routes new chunk-capable rows through the
chunk store, but first checks whether the key already exists in SQLite. Thus a
stale hex file cannot overwrite the authoritative database when the migration
marker is absent. Regression coverage exercises exact 8,192/8,193-byte Unicode
boundaries, aggregate replacement and concurrent admission, large vector and
media values, twenty record bodies, logical live/snapshot sizes, legacy
writes, transaction rollback, manifest cleanup, migration-authority restart
conflicts, and resource-cache enabled/disabled behavior.

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

At the audit point, one V3 save-backed `setItem()` became two separately
awaited host mutations (value then owner), and sharded records multiplied that
cost across every logical row. AA1 now coalesces each value+owner pair into one
server transaction, and AA3 offers a bounded multi-key batch. Existing plugins
that continue issuing independent `setItem()` calls still multiply request,
hashing, and cache work across every logical row. Measured against the audited
workloads before plugin adoption:

- one read-touch that also rewrites an index can become six serialized writes
  (value plus owner for three logical records);
- persisting one sharded record can multiply into dozens of sequential
  mutations, awaited on critical before/after-request paths.

With the verified resource cache enabled, each value write also copies and
hashes the payload. Cache seeding is now detached after the authoritative
commit, so it no longer delays acknowledgement or holds the key-scoped queue,
but `storeBytes()` still copies/hashes the complete value and prunes by reading
manifest and entry keys for each seed
(`src/ts/storage/nodeStorage.ts:298-345`,
`src/ts/storage/resourceCache.ts:441-467`, `:726-754`). The remaining cost is
CPU, allocation, IndexedDB write amplification, and repeated cache scans.

### Required correction

- Migrate compound plugin writes to the AA3 batch API; value+owner coalescing
  is complete.
- Reuse one defensive byte copy/hash through acknowledgement and detached
  seeding, and amortize cache pruning across writes.
