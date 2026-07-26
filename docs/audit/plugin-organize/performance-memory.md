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

### Resolution

**Fixed 2026-07-27.** Manual mode changes now use a durable staged v2 protocol
instead of sending an aggregate transition envelope. The protocol is
`begin` → per-row upload/read → `finalize`, with exact `status` and idempotent
`abort` operations for retry, cancellation, restart, and lost-ack recovery.
Private row files and receipts are fsynced before acknowledgement, are never
listed as live storage, and are swept on abort, failed construction, displaced
session, or restart. A committed SQLite transaction whose response is lost is
recovered as committed from the durable publication; unpublished stages are
removed.

Externalization first durably saves the source-mode database. The server then
derives the authoritative value and owner-metadata inventory from that exact
ETag-bound database: canonical storage key, exact serialized UTF-8 size, and
SHA-256 for every row. The client's declaration must be the same complete set;
omissions, extras, duplicates, namespace/key substitutions, size changes, and
same-size content substitutions are rejected. Each upload is hash-bound to its
authoritative row, and finalize re-derives the complete source inventory and
rechecks the database ETag plus every staged file's size and hash before
publication.

The browser retains only row descriptors, serializes and uploads one live
inline value at a time, and removes that row from the live map only after its
stage acknowledgement. This progressive deletion is intentionally an
in-memory reference release, not a partial publication: the mode flag remains
in the source mode, lifecycle and storage-exclusive barriers prevent plugin
operations from observing the temporary map, the server stage remains private,
and all database saves are paused. A definitive failure restores acknowledged
rows one at a time from the private stage before aborting and releasing those
guards. Finalize atomically publishes the exact rows, ownership manifest,
generation, target database, PM1 quota usage, and recovery-dirty state.

Internalization begins from the exact generation-bound ownership manifest.
The server stages each owned row independently and stream-spools the target
database while preserving live chat stubs. The client reads one staged row at
a time and builds one final inline map, but continues routing through the old
external generation until committed finalize. Finalize atomically installs the
spooled database and deletes only the manifest-owned external rows; quarantined
physical rows are untouched. The client assigns the completed map only after
that acknowledgement, so neither direction uses the former aggregate v1 wire
format or exposes a half-switched mode.

Transition plans enforce exact UTF-8 bounds before moving data: 32 MiB per
row, 64 MiB total for the one-map internalization path, and 100,000 rows. The
server repeats those checks, applies the final-state PM1 quota plan inside the
publication transaction, and requires disk headroom for the database spool,
stage files, SQLite/WAL work, and rollback safety. The settings UI reports
entry and byte progress, exposes cancellation, and surfaces actionable row,
aggregate, disk, and quota errors. Cache validators now come from manifest
metadata; a server-selected cached body is loaded and verified once instead of
loading and re-hashing every retained historical body before the request.

Finalize ambiguity is fail-closed. Only an exact, validated status response
may resolve it as committed or definitively not committed. If finalize and its
status lookup time out, lose the network, return an unavailable/session status,
or return malformed, mismatched, or unknown state, the client preserves
`commitOutcomeUnknown` with both errors and permanently blocks V2 storage,
holds the V3/storage barrier, and rejects every later database save until the
page reloads. It does not restore inline rows when the server may already have
committed.

The reproducible `pnpm test:performance` gate runs cache-off and cache-on in
fresh processes with exposed GC, the real production save loop and public mode
transition, a real Node server/SQLite database, PM1 multi-chunk rows, and no
transition dependency injection. Each run moves eight distinct exact 7 MiB
Unicode JSON rows (56 MiB total). Forced-GC progress checkpoints prove that
external live keys disappear one acknowledgement at a time and that more than
four rows' worth of heap becomes collectible; internalization retains only the
bounded final map plus row-local transient buffers. Verified runs measured
external heap release from roughly 203 MiB to 159 MiB, about 59 MiB peak
ArrayBuffer growth, and about 109 MiB peak RSS growth, with approximately
21 MiB transient ArrayBuffer growth during internalization. The cache-on run
also proves a real hash-validator/204 selection, while cache-off sends no cache
validators. Boundary and recovery suites cover 64/65 MiB, 100,000/100,001
rows, exact/one-byte-short disk headroom, PM1 row and aggregate quota rollback,
disconnect and restart cleanup, acknowledgement loss, stage invisibility, and
full-chat-row plus live-stub preservation in both directions.

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

### Resolution

Fixed. The Plugin Storage viewer now retains one 50-value page, reads values
serially, and stores only their display serialization; changing pages,
cancellation, or errors discard the prior page. Partial local export now pins a
server-side SQLite snapshot and folds external values into the streamed
`database.risudat` spool one row at a time. Its selected-asset archive remains
upstream compatible, omits account data, and applies the same BR4 archive-key
validation as other folded exports.

Snapshot restore now spools a chunked value directly from its manifest to a
temporary file one chunk at a time, then ingests through the file cursor instead
of beginning with `kvGet()` / `Buffer.concat()`. Disconnect cancellation rolls
back streaming ingest, and cancellation, failure, success, and startup cleanup
remove incomplete restore/export spools.

Coverage uses deterministic bounds rather than raw-heap timing: a 10,000-key
viewer asserts a 50-value page and one in-flight read; partial folding exercises
1,000 rows plus a 4 MiB body with one parsed row in flight and archive/import
round trips; chunk restore asserts one chunk in flight, a 64 KiB maximum chunk,
hundreds of chunks, exact bytes, folded-snapshot recovery, and cancellation/error
cleanup. A combined real-server test pauses after the exact prior ownership set
is tentatively deleted, disconnects the client, and verifies transaction
rollback, spool cleanup, and old-state durability after restart. The full
client, server, compatibility, check, and production-build validation sets pass.

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
