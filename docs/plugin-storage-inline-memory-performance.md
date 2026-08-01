# Inline plugin-storage memory and performance findings

> Status: Investigation complete; remediation not implemented.  
> Audited on 2026-08-01 against `8a385fad`. Prefer the named symbols below over
> volatile line numbers.

## Executive summary

Disabling **Optimize plugin memory usage** does not merely add the decoded plugin
values to browser memory. It folds those values into `database/database.bin`, where
the generic database encoder, patch synchronizer, ETag calculation, server patch
cache, and optional browser resource cache all process them as one monolithic root
field.

The sampled test publication contained about 311 MiB of plugin-value payload and
produced a 329 MiB logical `database.bin`. Inline mode retains roughly four
payload-sized browser representations before normal application overhead:

1. the live decoded plugin values;
2. the encoder's cached JSON string;
3. the encoder's encoded plugin block; and
4. the patcher's independent JSON comparison baseline.

This accounts for about 1.2 GiB of plugin-specific retained payload. Browser runtime,
the rest of the database, temporary decode/encode allocations, garbage-collector
headroom, and allocator high-water behavior make approximately 2 GiB steady usage and
a 3-3.6 GiB bootstrap peak plausible.

The same design also causes linear work over the complete inline plugin map during an
otherwise small save. A save can stringify and compare the entire map in the browser,
assemble a complete fallback database buffer, hash the decoded map on the server,
encode the complete database to derive an ETag, and encode it again for delayed
persistence. The issue is therefore a performance problem as well as a memory problem.

The stored data itself did not show suspicious structural expansion. Almost all of the
sampled values were flat strings, and the logical inline database was only modestly
larger than the external plugin rows. The amplification occurs after the bytes enter
the client/server object and save pipelines.

## Scope and terminology

This report concerns save-backed plugin values described in
[the plugin-storage structure guide](structure/plugin-storage.md).

- **Optimized mode** means `Database.optimizePluginMemory === true`. Plugin values and
  owner records are authoritative in manifest-owned `pluginsave/` and
  `pluginsave-meta/` rows.
- **Inline mode** means optimization is disabled. Plugin values and owner records are
  fields of the authoritative database object and are encoded inside
  `database/database.bin`.
- **Server `dbCache`** is the decoded JavaScript object retained by
  `server/node/server.cjs` for JSON Patch synchronization. It is not a byte cache and
  is not the browser resource cache.
- **Browser resource cache** is the optional IndexedDB-backed, content-addressed cache
  implemented by `src/ts/storage/resourceCache.ts` and the `/api/db/read-cached`
  protocol.

The reported browser figures—about 500 MiB optimized, about 2 GiB inline, and a
3.6 GiB inline bootstrap peak—came from the original reproduction. This investigation
correlated them with the live test publication, code paths, server process state, and
the repository's transition memory test. It did not add browser-level allocation
instrumentation.

## Evidence from the current test publication

The live SQLite publication was inspected without logging plugin keys or values. Before
internalization, the optimized rows contained:

| Measurement | Observed value |
|---|---:|
| `pluginsave/` rows | 714 |
| Stored `pluginsave/` value bytes | 326,417,370 bytes |
| `pluginsave-meta/` rows | 695 |
| Stored metadata bytes | 115,497 bytes |
| Manifest bytes | 143,325 bytes |

After internalization, a structural scan of the logical current database found:

| Measurement | Observed value |
|---|---:|
| Logical `database.bin` | 344,881,521 bytes (328.9 MiB) |
| Plugin-value MessagePack payload | 326,238,030 bytes (311.1 MiB) |
| Plugin values | 714 |
| String-valued rows | 711 |
| Map-valued rows | 3 |
| JavaScript string code units | 326,125,028 |
| Estimated V8 string payload | approximately 312.3 MiB |

Of the 711 string rows, 685 were ASCII-only and accounted for 324,805,028 code units.
Only 26 rows required two-byte characters. Most large rows were approximately 500 KiB.

These facts rule out a giant nested reactive graph as the primary cause for this test
database. `deepTouch()` does subscribe to every reachable plugin-storage property in
inline mode, and Svelte can create per-property reactive sources, but flat string values
stop the traversal at the top-level 714 entries. Object- or array-heavy plugin values
would add more proxy and container overhead than this test case.

The on-disk increase was also ordinary: approximately 311 MiB of plugin payload became
a 329 MiB complete database. The multi-gigabyte result appears only in runtime
representations.

## Current behavior by mode

### Optimized mode

`getPluginSaveStorageItem()` and related APIs read generation-bound rows through the
persistent storage transport. Writes update the selected row, owner record, manifest,
quota state, and recovery token atomically. `setDatabase()` keeps the inline
compatibility maps empty, so generic database save machinery sees an effectively empty
plugin-storage block.

Relevant implementation:

- `src/ts/plugins/pluginSaveStorage.ts`: `getPluginSaveStorageItem()`,
  `setPluginSaveStorageItem()`, and `commitOptimizedStorageMutation()`.
- `src/ts/storage/database.svelte.ts`: `setDatabase()` documents that optimized mode
  retains only the empty compatibility map.
- `src/ts/storage/risuSave.ts`: `RisuSaveEncoder.init()` retains the format-compatible
  plugin block, but it is small when the reconciler has cleared the inline map.

The approximately 500 MiB optimized measurement is therefore primarily base
application, browser, and ordinary database state. The 300+ MiB plugin publication
remains in SQLite/server rows and is materialized only for requested values or explicit
whole-storage operations.

### Inline mode

An optimized-to-inline transition is assembled server-side by
`streamRisuSaveToFile()`. The server reads staged row sources and writes the destination
MessagePack database spool without first building one complete JavaScript plugin map.
The transition assembly itself is intentionally bounded.

After the atomic commit, however, `applyBulkPluginStorageTransition()` calls
`readCommittedInlinePluginStorage()`. That function performs an authoritative
`database.bin` read, decodes the complete database, clones the plugin records, and
installs them into live Svelte database state. The external plugin rows are deleted by
the committed server transition, so `database.bin` is now the sole authority.

From that point forward, plugin storage participates in generic whole-database:

- bootstrap baseline cloning;
- RisuSave encoding;
- JSON Patch change detection;
- client and server hashing;
- ETag generation;
- full-write fallback;
- server patch persistence; and
- browser resource-cache root segmentation.

The bounded transition writer therefore prevents one class of server aggregation but
does not prevent the much larger amplification after publication becomes inline.

## Browser retained representations

### Live decoded values

MessagePack decoding materializes every inline plugin value as a JavaScript value.
For the current test data, this is approximately 312 MiB of mostly one-byte V8 string
payload plus the database and map containers.

`setDatabase()` copies the plugin record container but reuses primitive string values.
`deepTouch()` reads those top-level properties for reactivity. Neither operation is the
dominant payload copy for this flat-string fixture.

### Bootstrap patch baseline

`bootstrap.ts` calls `setPatchSyncBaseline(decoded)` before installing the decoded
database. `cloneDatabaseState()` first applies `safeStructuredClone()` to the entire
database, then replaces the two plugin records with its special descriptor-preserving
clone.

For primitive strings, the final repaired plugin record can share the original string
values. The generic structured clone can nevertheless create a payload-sized transient
copy before that first plugin-map clone becomes unreachable. Object-heavy values would
remain deeply cloned in the repaired record.

The baseline later becomes `RisuSavePatcher.lastSyncedDb`; the temporary bootstrap
reference is cleared after patcher initialization.

### Encoder JSON and binary block

`RisuSaveEncoder.init()` calls `JSON.stringify(data.pluginCustomStorage)`. Its
`encodeRawBlock()` then:

1. converts the complete JSON string through `TextEncoder`;
2. allocates the final block buffer;
3. copies the encoded bytes into that block; and
4. stores the original JSON string in the module-global `risuSaveCacheMap`.

After initialization, the approximately 311 MiB JSON string and approximately 311 MiB
encoded block remain reachable. During initialization, the `TextEncoder` result adds a
similar temporary allocation.

The relevant symbols are `RisuSaveEncoder.init()`, `encodeRawBlock()`, and
`risuSaveCacheMap` in `src/ts/storage/risuSave.ts`.

### Patcher JSON baseline

`RisuSavePatcher.init()` normalizes the database and stores a JSON serialization for
every non-array root key in `lastRootKeyJsons`. `pluginCustomStorage` is one such root
key, so this creates and retains a second approximately 311 MiB JSON string independent
of the encoder's cache.

The normalized object graph itself can share primitive strings with its input; the
retained JSON string is the material payload duplication for this fixture.

### Retained-size accounting

| Retained browser representation | Approximate plugin payload |
|---|---:|
| Live decoded values | 312 MiB |
| Encoder JSON cache | 311 MiB |
| Encoder binary block | 311 MiB |
| Patcher root-key JSON baseline | 311 MiB |
| Total before general runtime overhead | approximately 1.2 GiB |

This estimate deliberately does not count the bootstrap structured clone as permanently
retained for the current flat-string fixture. It also excludes maps, Svelte state,
ordinary database data, browser internals, networking, garbage-collector capacity, and
memory pages that remain reserved after temporary objects become collectible.

### Correction concerning header slicing

The decoders remove legacy headers with `data.slice(header.length)`. A plain
`Uint8Array.prototype.slice()` copies its bytes, but the current server and normal
browser boot paths pass a Node `Buffer` or the browser `buffer` polyfill's `Buffer`.
Both implement `slice()` as a `subarray()` view. The normal path therefore does not
necessarily add a second complete raw-input allocation at this line.

Callers that provide a plain `Uint8Array` can still take the copying behavior. More
importantly, fetch response bytes, decoded values, structured-clone intermediates,
encoder staging, encoder output, and resource-cache copies remain independently
allocated. Removing the assumed header copy reduces one peak estimate but does not
change the root cause or the observed measurements.

## Server `dbCache`

### Purpose

`dbCache` is declared in `server/node/server.cjs` as an object keyed by the hex-encoded
storage path. For `database/database.bin`, it retains the decoded stubs-only database
used by `/api/patch`.

The cache allows JSON Patch operations to be applied to a JavaScript graph and debounced
before persistence. `dbDerivedValueMemo` associates derived hashes and ETags with the
current cache generation. `replaceDbCacheValue()` and `deleteDbCacheValue()` advance
that generation so stale derived values are not reused.

There is no size-based admission policy, LRU, or memory-pressure eviction. The decoded
database normally remains until a full write, transition, import, integrity failure, or
server restart invalidates it.

### Population and persistence

The first `/api/patch` after a cold start or invalidation calls
`loadStrippedDatabase()` and installs the result in `dbCache`. The patch is applied with
`applyPatchAtomic()`, and a five-second timer eventually calls `persistDbCache()`.

`persistDbCache()` validates chat-stub integrity, externalizes plugin storage only when
the selected publication calls for it, encodes the complete stripped object with
`encodeRisuSaveLegacy()`, and writes it to SQLite. In inline mode, the complete plugin
map remains in both the cached graph and encoded database.

### Ordinary reads do not reuse it

`prepareLiveDatabaseRead()` does not first consult an existing `dbCache` entry. It:

1. calls `loadStrippedDatabase(raw, source)`;
2. replaces the cache with the newly decoded object;
3. calls `prepareDatabaseReadPayload()`; and
4. returns a freshly encoded full blob and ETag.

During a repeated authoritative read, the old cache remains reachable while the new raw
database is decoded and normalized. The peak can include:

- the old decoded inline map;
- the raw database bytes;
- the newly decoded inline map;
- the normalized object containers;
- MessagePack encoder working memory; and
- the newly encoded response blob.

This explains why the server can reach multi-gigabyte RSS independently of the browser.
During the live transition investigation, one server sample showed 2,309,376 KiB RSS,
including 1,999,284 KiB anonymous RSS. That is a point observation rather than a
controlled benchmark, but it is consistent with the code path above.

The reason for rereading authoritative bytes may be to observe out-of-process database
changes and rerun defensive normalization/externalization. That correctness goal does
not require unconditional decode if the SQLite row identity or generation can prove the
cached graph still corresponds to the selected bytes.

### Hash and ETag work after patches

Before accepting a patch, the server calls `getDbCacheHash()`. On a cache generation
without a memoized hash, `calculateHash()` recursively visits the whole decoded graph
and loops over every character in every string. A 311 MiB inline string map makes this
an O(plugin-storage-size) operation.

After applying the patch, `replaceDbCacheValue()` advances the cache generation. The
server then calls `getDbCacheEtag()` before acknowledging the patch.
`computeDatabaseEtagFromObject()`:

1. MessagePack-encodes the complete database;
2. allocates and fills the RisuSave header result;
3. converts that result to a `Buffer`; and
4. hashes the complete buffer.

Only the small ETag string is memoized; the complete encoded blob is not retained for
the delayed persist. `persistDbCache()` therefore encodes the complete database again
when its timer fires.

### Full writes decode more than once

The `/api/write` database path decodes the incoming full database for validation,
chat-row splitting, and possible plugin externalization. After committing, it
invalidates `dbCache` and decodes the persisted bytes again solely to call
`rememberSessionPluginStorageState()`. That function only records the optimization
boolean and plugin-storage generation.

Because this second decoded object is not installed into `dbCache`, a later patch can
perform another complete decode. The already decoded `strippedDb`, or just the two
publication fields, could satisfy the session-state requirement.

## Decode and read paths

### Cache-off cold boot

When browser resource caching is disabled, `NodeStorage.readDatabaseForBoot()` uses
`/api/db/read-raw-for-boot`. That endpoint intentionally returns `database.bin` without
server decoding, normalization, publication changes, or `dbCache` population.

The browser still must:

1. receive the approximately 329 MiB response;
2. MessagePack-decode all plugin values;
3. install bootstrap and live state;
4. initialize the encoder; and
5. initialize the patcher.

This is the least expensive current server boot path but still triggers the browser
representations described above.

### Post-transition and conflict reads

`readCommittedInlinePluginStorage()` uses `forageStorage.readDatabaseCandidate()`.
`NodeStorage.readDatabaseCandidate()` calls ordinary `/api/read`, not the raw boot
route. The server therefore decodes, normalizes, caches, and re-encodes the complete
inline database, after which the client receives and decodes it again.

Conflict recovery uses the same authoritative candidate abstraction. An inline
conflict can consequently repeat the complete server and browser decode pipeline.

### Resource-cache boot

When browser resource caching is enabled, boot calls `/api/db/read-cached`. The server
still calls `prepareLiveDatabaseRead()`, including complete decode and legacy re-encode
for its ETag. It then separately divides the decoded database into the groups `root`,
`characters`, `botPresets`, `modules`, and `personas`.

`pluginCustomStorage` is not an array group, so it is included in the single `root`
segment. For the test publication, that makes `root` larger than 300 MiB. The server:

1. MessagePack-encodes the giant root segment;
2. hashes it;
3. embeds its bytes in a MessagePack response envelope; and
4. sends that envelope.

On the client, `decodeAndAssembleCachedDbRead()` decodes the envelope,
`readBytes()` explicitly copies an uncached segment's bytes, hashes them, and decodes
the segment into the database object.

The resource-cache maximum individual value is 32 MiB, while the root segment is more
than 300 MiB. The segment cannot be retained as an IndexedDB cache entry, so this path's
most expensive segment cannot become a useful cache hit on later boots.

### Streaming support does not make inline state lazy

`server/node/streamRisuLoad.cjs` contains bounded format inspection and streaming
walkers capable of visiting plugin entries one at a time. Those paths are effective
when externalizing plugin storage because the destination remains row-oriented.

Inline mode, by definition today, requires one complete `pluginCustomStorage` map in
the returned database object. Once that object is requested, `msgpackr` decodes the
monolithic MessagePack map eagerly. Streaming transition assembly cannot make the final
browser or server object lazy.

The architectural question is therefore not merely how to optimize MessagePack decode.
It is whether disabling memory optimization should also force plugin persistence back
into the monolithic database format.

## Per-save performance amplification

### Client patch preparation

`RisuSavePatcher.set()` loops over all current root keys. For each key it first executes
`JSON.stringify(curRoot[key])`, regardless of the `toSave` dirty flags. It compares that
new string against `lastRootKeyJsons` as a cheap pre-check.

For ordinary small root edits in inline mode, this means the unchanged 311 MiB plugin
map is still:

- completely serialized;
- compared against another 311 MiB string; and
- left as a large temporary allocation.

The patcher's cached structural hash avoids one client-side deep hash in the unchanged
case, but the JSON serialization and comparison remain O(plugin-storage-size).

### Unconditional full fallback assembly

Before attempting `/api/patch`, `saveDb()` calls `encoder.set()` and then immediately
calls `encoder.encode()`. The latter allocates one buffer large enough for every stored
block and copies all blocks into it. The inline plugin block dominates that output.

If the patch succeeds, the approximately 329 MiB assembled full-save buffer is not sent.
Moving full assembly into the actual full-write fallback would avoid this allocation
and copy on successful patch saves.

### Server validation, acknowledgement, and persistence

For a small successful patch, the server can perform:

1. a complete decoded-graph hash for expected-hash validation;
2. patch application;
3. complete database encoding and MD5 hashing for the new ETag; and
4. another complete encoding when the five-second persist timer fires.

Thus a change of a few bytes can produce well over a gigabyte of sequential memory
traffic across browser and server. The patch request itself remains small; most of the
work is local preparation and bookkeeping.

The expected effects include:

- longer bootstrap and first-save latency;
- UI pauses while JSON serialization and buffer assembly run on the browser main
  thread;
- delayed patch acknowledgements while the server hashes and encodes;
- elevated CPU usage during autosaves;
- major garbage collections caused by payload-sized temporaries;
- allocator high-water RSS that remains high after objects become collectible; and
- worse conflict/reload latency because authoritative reads repeat the pipeline.

Optimized mode avoids the size-dependent portion because the inline maps and encoded
plugin block are empty.

## Existing performance tests

The targeted transition test was run in both resource-cache configurations:

```sh
POCKETRISU_PERF_RESOURCE_CACHE=off pnpm exec node --expose-gc \
  ./node_modules/vitest/vitest.mjs run --disableConsoleIntercept \
  --config vitest.config.performance.ts \
  test/performance/plugin-storage-transition-memory.test.ts

POCKETRISU_PERF_RESOURCE_CACHE=on pnpm exec node --expose-gc \
  ./node_modules/vitest/vitest.mjs run --disableConsoleIntercept \
  --config vitest.config.performance.ts \
  test/performance/plugin-storage-transition-memory.test.ts
```

Both runs passed. With eight 7 MiB rows, or 56 MiB of logical plugin data, the observed
post-internalization results were:

| Configuration | Final RSS | Final ArrayBuffers |
|---|---:|---:|
| Resource cache off | 616,222,720 bytes (587.7 MiB) | 195,749,159 bytes (186.7 MiB) |
| Resource cache on | 635,555,840 bytes (606.1 MiB) | 203,089,191 bytes (193.7 MiB) |

The test's opt-in extreme profile uses sixteen 28 MiB rows, or 448 MiB total. Its source
comments explicitly target approximately 2 GiB RSS, with a default minimum expectation
of 1.5 GiB. The runner requires at least 6 GiB of memory and 8 GiB of free disk for that
profile.

This coverage proves the bulk transition remains inside its generous bounds, but it
does not treat the size multiplier itself as a failure. It also does not measure:

- a real browser cold bootstrap with a large inline database;
- retained browser state after encoder and patcher initialization;
- latency or bytes processed for an unrelated one-field save;
- first-patch server cache construction;
- repeated authoritative reads while a large `dbCache` already exists;
- full-write double decoding; or
- a resource-cache root segment larger than its 32 MiB entry limit.

Relevant files are
`test/performance/plugin-storage-transition-memory.test.ts` and
`scripts/run-performance-extreme-tests.mjs`.

## Root-cause ranking

### 1. Generic save machinery retains multiple whole-map forms

This is the main steady browser-memory cause. Encoder JSON, encoder binary, patcher JSON,
and live values are independently retained even when plugin storage is unchanged.

### 2. Unrelated saves perform O(plugin-size) work

The patcher serializes the whole plugin root, the encoder assembles a full fallback,
and the server performs full hash/ETag/persist operations. This is the main ongoing
performance cause after bootstrap.

### 3. Server reads rebuild rather than reuse `dbCache`

Ordinary and cached reads decode authoritative bytes even when a decoded cache exists.
Keeping the old cache live until replacement raises the peak further.

### 4. Browser resource-cache grouping is incompatible with large inline plugin maps

The complete map is one `root` segment, substantially exceeding the maximum cacheable
value, while still paying segment and envelope encoding/copying costs.

### 5. Full writes repeat decoding for small publication metadata

The committed bytes are decoded again for two session-state fields, discarded, and may
be decoded yet again for the next patch.

### 6. Reactive graph overhead is data-shape dependent

It is not dominant for the current mostly-string fixture. It can become significant for
plugins storing deeply nested arrays and objects because inline mode exposes the full
graph to Svelte reactivity and `deepTouch()`.

## Recommended remediation

### Phase 1: remove avoidable work without changing persistence semantics

1. **Defer complete encoder assembly.** Let `encoder.set()` maintain changed blocks, but
   call `encoder.encode()` only after the patch path has selected a full-write fallback.
2. **Do not stringify unchanged plugin storage.** Give plugin storage an explicit dirty
   revision or use `toSave.pluginCustomStorage`; retain defensive detection at the
   mutation boundary rather than serializing hundreds of MiB for every root save.
3. **Reuse the already decoded full-write object.** Pass the committed optimization mode
   and generation directly to `rememberSessionPluginStorageState()` and, where safe,
   retain the validated stripped object for the next patch.
4. **Bypass unusable resource-cache segments.** If a segment exceeds
   `RESOURCE_CACHE_MAX_VALUE_BYTES`, use raw boot or an explicitly non-cacheable transfer
   without the extra content-addressed envelope copy.
5. **Remove or gate whole-database console logging.** `bootstrap.ts` and the block decoder
   log decoded database objects. Developer-tools retention can distort measurements and
   keep diagnostic references alive longer than intended.

### Phase 2: remove full serialization from patch acknowledgements and reads

1. **Change ETag derivation.** Use a mutation generation or a canonical incremental
   digest that can be updated from patch operations, rather than re-encoding the whole
   database synchronously after every patch. This requires a coordinated protocol
   change because ETags currently describe canonical encoded bytes.
2. **Make `dbCache` reuse generation-aware.** Associate it with a SQLite row revision,
   content hash, or updated-at token. Reuse the decoded graph when that cheap token still
   matches; decode only when the underlying row changed outside the process.
3. **Avoid normalize-and-re-encode for validated inline reads.** A dedicated committed
   transition response or raw authoritative read can return already validated published
   bytes while separately conveying the publication metadata required by the session.
4. **Retain or generate the encoded persistence result once.** Where correctness permits,
   reuse the same canonical encoding for ETag calculation and durable persistence rather
   than encoding independently.

### Phase 3: separate client residency from persistence layout

The durable fix is to stop using one toggle for two different concerns:

- whether all plugin values are resident in browser memory; and
- whether plugin values are physically embedded in `database.bin`.

Plugin rows could remain independently persisted in both modes. Optimized mode would
load values on demand; disabled mode would eagerly load all selected rows into the
browser compatibility map. Backups and exports could assemble an inline-compatible view
as a streaming operation when required.

That design would preserve the user-visible meaning of disabling memory optimization
while preventing the resident values from entering generic database encoding, patching,
ETag, and cache-root paths. It would reduce steady inline browser cost toward one live
payload copy instead of four and would keep the server patch cache independent of plugin
publication size.

An alternative is a chunked plugin-storage block inside `database.bin`, with per-key or
per-chunk dirty tracking and lazy encoding. It is less disruptive to the physical format
but still requires special handling throughout patch, ETag, resource-cache, backup, and
restore code.

## Suggested validation coverage

Add four distinct tests rather than extending only the transition test:

1. **Cold browser bootstrap:** load a 300-448 MiB inline publication and record response
   bytes, JS heap, ArrayBuffers, process RSS, major-GC count, and time to interactive.
2. **Unrelated save:** change a one-byte root setting with a large unchanged inline map.
   Assert that successful patch preparation does not stringify or assemble the plugin
   payload and that the patch acknowledgement does not fully encode it.
3. **Server cache lifecycle:** measure first patch, second patch, repeated ordinary read,
   invalidation, and rebuild. Separate steady cache size from per-operation peak.
4. **Resource-cache oversize root:** prove that an uncacheable root selects a bounded
   fallback and does not add envelope/segment copies without producing a future hit.

Candidate budgets should be expressed relative to payload size `S` and a measured empty
publication baseline rather than as absolute RSS alone. For example:

- steady browser overhead attributable to inline plugin storage should approach one
  decoded `S`, not four retained `S` representations;
- a successful unrelated patch should allocate sublinear or fixed additional memory,
  not another `S`-sized string and database buffer;
- server cache construction may require one decoded `S`, but a cache hit should not
  decode another `S`; and
- cold-boot peak should explicitly bound simultaneous raw, decoded, and initialization
  representations.

Run browser measurements with and without developer tools, force a settled-GC checkpoint
where supported, and report both JS heap/ArrayBuffers and process RSS. RSS alone includes
allocator reservation and native memory; heap alone omits large external buffers.

## Conclusion

The observed memory and performance behavior follows from current architecture rather
than corrupt or unexpectedly expanded plugin data. Optimized mode keeps the large
publication outside the generic database graph. Inline mode makes that publication a
monolithic root field and then retains, scans, hashes, and encodes it through systems
designed for much smaller configuration data.

The fastest meaningful improvements are to stop serializing unchanged plugin storage,
defer full-save assembly until fallback, and eliminate repeated server decoding. The
strongest long-term solution is to decouple eager browser residency from physical
inline persistence.
