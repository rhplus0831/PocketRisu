# MessagePack memory and performance audit

> Status: Investigation complete; remediation not implemented.  
> Audited on 2026-08-01 against `8a385fad`. This document assesses the validity of
> [the inline plugin-storage report](plugin-storage-inline-memory-performance.md),
> extends it with additional client and server findings, and consolidates the
> available solutions. Prefer the named symbols below over volatile line numbers.

## Executive summary

The inline plugin-storage report is valid. Every one of its eighteen technical
claims was independently re-verified against the code: thirteen are confirmed
exactly, five are confirmed with wording corrections, and none are refuted. Its
root-cause ranking and remediation direction are well supported.

The investigation then widened to how the client and server manage MessagePack
data generally. The same architectural pattern — whole-payload buffering,
copying, serialization, and hashing triggered by small or unrelated operations —
recurs well beyond inline plugin storage. Thirty additional findings were
verified: fifteen browser-side and fifteen server-side, including nine
client-side and six server-side high-severity items on hot paths (boot
decoding, chat persistence, protected chunk reads, request ingress, conflict
recovery, and backups).

The consolidated conclusion is that PocketRisu's correctness architecture —
authoritative monolithic `database.bin`, defensive re-decoding, defensive
copying, and cryptographic re-verification — is sound but consistently pays
O(total-payload) memory and CPU for O(change) operations. The solutions fall
into six tracks, ordered later in this document: avoidable-work removal,
server read/patch lifecycle, bounded ingress and streaming, background
subsystems, architectural decoupling, and validation coverage.

## Scope and method

Three independent audits were run against `8a385fad` and then arbitrated
against the source:

1. **Claim verification** — every claim of
   `plugin-storage-inline-memory-performance.md` checked individually.
2. **Client sweep** — browser-side MessagePack lifecycle: boot, decode,
   reactive state, save loop, chat rows, caches, imports/exports.
3. **Server sweep** — Node-side lifecycle: KV/chunk store, database routes,
   chat rows, plugin storage, backups, snapshots, imports/exports, concurrency.

Sampled claims from each audit were re-verified by direct code reading before
inclusion; every sampled claim matched at the cited symbol. A fourth strict
fact-check pass was then run against a draft of this document and its
corrections — scope narrowings for C1 and S1, count fixes, and contract
safeguards for the Part 4 solutions — are folded into this version. Findings
already documented in the prior report are excluded here unless the new
investigation added specifics. All results are static code-path analysis; no
browser heap instrumentation was added.

## Part 1: Validity of the inline plugin-storage report

### Verdict table

| # | Claim (abbreviated) | Verdict |
|---|---|---|
| 1 | Encoder retains plugin JSON string (`risuSaveCacheMap`) and binary block | Confirmed |
| 2 | Patcher retains independent per-root-key JSON baseline | Confirmed |
| 3 | Bootstrap baseline structured-clones the whole database first | Partially confirmed |
| 4 | Four steady retained representations, roughly 4× payload | Partially confirmed |
| 5 | Header `slice()` is a view on normal `Buffer` paths | Confirmed |
| 6 | `RisuSavePatcher.set()` stringifies every root key on every save | Confirmed |
| 7 | Full fallback buffer is assembled before every patch attempt | Confirmed |
| 8 | Small patch triggers full hash, full-encode ETag, second persist encode | Confirmed |
| 9 | `dbCache` has no size/LRU/memory-pressure eviction | Confirmed |
| 10 | `prepareLiveDatabaseRead()` always rebuilds instead of reusing `dbCache` | Confirmed |
| 11 | `/api/write` decodes twice and leaves the patch cache cold | Confirmed |
| 12 | Cache-off boot (`/api/db/read-raw-for-boot`) is the cheapest server path | Confirmed |
| 13 | Post-transition and conflict reads use full `/api/read` pipeline | Confirmed |
| 14 | Inline root segment exceeds the 32 MiB resource-cache entry limit | Confirmed |
| 15 | Transition spool is bounded, post-commit browser read is eager | Confirmed |
| 16 | `setDatabase()` keeps optimized-mode inline maps empty | Partially confirmed |
| 17 | `deepTouch()` subscribes to every reachable plugin-storage property | Partially confirmed |
| 18 | Transition perf test exists but misses the listed scenarios | Partially confirmed |

### Corrections that matter for remediation planning

- **Optimized-map emptiness is not enforced by `setDatabase()`.** The function
  unconditionally copies whatever `pluginCustomStorage`/`pluginStorageMeta`
  records it is given (`copyDatabasePluginStorageRecord()` in
  `../../src/ts/plugins/pluginStorageRecord.ts`). The empty-map invariant is
  actually established by transition commit
  (`applyBulkPluginStorageTransition()`) and boot reconciliation in
  `../../src/ts/plugins/pluginSaveStorage.ts`. Remediation that relies on the
  invariant must guard those paths, not `setDatabase()`.
- **The "approximately 4×" multiplier is a workload model, not a guarantee.**
  It holds for the sampled flat-string fixture. UTF-8 versus UTF-16
  representation, escaping, engine string sharing, and data shape change the
  ratio, and object-heavy values additionally retain normalized containers in
  `RisuSavePatcher.lastSyncedDb` — the four-item list is not exhaustive for
  every shape.
- **The bootstrap structured-clone copy is a possible peak, not a guaranteed
  allocation.** Engines may share immutable string backing during
  `safeStructuredClone()`; the order of operations in `bootstrap.ts` is as
  described.
- **"Descriptor-preserving" plugin cloning is imprecise.**
  `cloneDatabasePluginStorageRecord()` preserves special own keys (such as
  `__proto__`) and recursively clones values, but recreates every property as
  an ordinary writable/enumerable/configurable data property; arbitrary
  descriptor flags and accessors are not preserved.
- **`deepTouch()` does not touch literally every property.** It traverses
  array indices and own enumerable string-keyed properties of plain objects,
  delegating non-plain objects to `$state.snapshot()`; symbols, non-enumerable
  properties, and inherited properties are excluded. For JSON-like persisted
  data the data-shape-dependent overhead conclusion stands.
- **The performance-test gap claim is slightly too broad.** The transition
  test's pre-externalization baseline does include initialized encoder/patcher
  state in aggregate; what it does not do is isolate or assert the
  post-internalization retained-representation multiplier. The other listed
  coverage gaps are real.
- Minor: the `saveDb()` full-assembly and patch orchestration described by the
  report lives in `../../src/ts/globalApi.svelte.ts` (`persistTrackedChanges`), not
  `../../src/ts/storage/databaseSave.ts`, which holds the coordinator/pause fencing.

The report's measurements, root-cause ranking, and recommended remediation
remain trustworthy with these corrections applied.

## Part 2: Additional client findings

Findings are new relative to the prior report. Severity reflects user-visible
impact at realistic sizes (databases 50–500 MiB, chats 1–50 MiB).

| # | Severity | Finding |
|---|---|---|
| C1 | High | Strict RisuSave decoding stages every block string and parses each twice |
| C2 | High | Active-chat dirty tracking re-walks the entire chat every reactive flush |
| C3 | High | Generation checkpoints re-encode and upload the complete chat row |
| C4 | High | Resource-cache boot stages all cache misses before the aggregate limit applies |
| C5 | High | ETag conflict recovery holds several complete database graphs concurrently |
| C6 | High | Optimized per-value reads/writes create several payload-sized forms |
| C7 | High | Narrow consumers snapshot the entire reactive database |
| C8 | High | Character package and dataset paths materialize complete chat collections |
| C9 | High | Unrelated saves stringify every character twice before detecting no change |
| C10 | Medium | msgpackr retains its largest encode target up to 1 GiB |
| C11 | Medium | Patcher baselines commit before acknowledgement; full writes re-decode their own output |
| C12 | Medium | `risuSaveCacheMap` retains deleted blocks indefinitely and can mask incomplete saves |
| C13 | Medium | Inline-to-optimized transition buffers the whole publication in the browser |
| C14 | Medium | Large character diffs can exceed V8's spread-argument limit |
| C15 | Low | Raw msgpackr configuration cliffs: map16 sizing, no records, binary subarray aliasing |

- **C1.** For block-format (RISUSAVE) inputs, `RisuSaveDecoder.decode()` in
  `../../src/ts/storage/risuSave.ts` retains every block as a decoded `content`
  string, and strict mode validates each known JSON block with a `JSON.parse`
  whose result is discarded before the type switch parses blocks it consumes
  a second time (CONFIG/LOADOUTS are validated once and ignored). Which paths
  hit this is format-dependent: cache-off boot takes it when the stored row is
  block-format, while ordinary `/api/read` responses — including conflict
  recovery — are re-encoded server-side with `encodeRisuSaveLegacy()` and
  decode directly via `Unpackr` instead. Where it applies, input bytes, all
  block strings, a transient validation graph, and the final graph overlap on
  the main thread with parse work done twice.
- **C2.** The active-chat `$effect` in `../../src/ts/globalApi.svelte.ts` calls
  `deepTouch(activeChat)`; each affected flush re-traverses every message and
  nested property of the hydrated chat. Streaming or editing a long chat pays
  O(total chat graph) main-thread work per flush and grows with history.
- **C3.** `prepareChatPersistStage()` checkpoints roughly every 20 seconds
  during generation, and `saveChatContent()` in `../../src/ts/storage/nodeStorage.ts`
  runs `encodeRisuSaveLegacy(chat)` — full MessagePack encode plus a
  header-prefixed copy — and uploads the whole row each time. With the
  resource cache enabled the same bytes are copied and hashed up to twice
  more, subject to acknowledgement/hash matching and the 32 MiB entry limit.
- **C4.** The cache-enabled boot path (`readDatabaseForBoot()` with
  `../../src/ts/storage/dbCachedRead.ts`) copies and hashes every miss segment,
  retains all miss bytes, and copies eligible entries again in
  `prepareManifestUpdates()`; only the 32 MiB per-entry limit gates admission
  before the IndexedDB write, while the 64 MiB aggregate budget is enforced by
  pruning afterwards. Many sub-32 MiB misses can far exceed the intended
  budget at peak, and the database is not returned until persistence completes.
- **C5.** `rebaseTrackedLocalChangesOnLatestServerDb()` decodes the latest
  server database, clones it, clones the local graph
  (`mergeTrackedDatabaseOnConflict()` in `../../src/ts/storage/databaseClone.ts`),
  and initializes replacement encoder and patcher instances while the old
  instances remain referenced. A conflict on a large database can hold on the
  order of six payload-sized graphs at once.
- **C6.** Versioned optimized reads return the value as base64 inside JSON and
  re-encode it to validate canonicality
  (`getPluginStorageStateAuthoritative()` in `nodeStorage.ts`); writes chain
  `safeStructuredClone` → JSON snapshot → protected snapshot → string →
  UTF-8 bytes (`pluginSaveStorage.ts`, `jsonValue.ts`, `persistentKv.ts`).
  A 128 MiB value can overlap roughly four to five payload-sized forms.
- **C7.** `getDatabase({snapshot:true})` snapshots all of `DBState.db`;
  `getCurrentCharacter({snapshot:true})`, plugin V2 `getChar`,
  character/persona export, and the settings bug-report export all take
  whole-database snapshots (sometimes cloning again) for narrow reads. The
  bug-report path does not exclude `pluginCustomStorage`.
- **C8.** `exportCharacterPackage()` hydrates and retains every chat, clones
  the hydrated character again, builds the nested `.charx` fully in memory
  (`VirtualWriter` buffer-getter copy included), and pretty-prints all chats
  into one JSON string; import `unzip`s the whole archive into a dictionary.
  `exportAsDataset()` repeats character metadata per chat and pretty-prints
  everything at once.
- **C9.** Independently of the known full-assembly issue, both
  `RisuSaveEncoder.set()` and `RisuSavePatcher.set()` `JSON.stringify` every
  character (stub-replaced) on every save to feed their equality caches, so an
  unrelated one-field save performs two complete character serialization scans
  on the main thread. The encoder also rebuilds and re-encodes the root block
  unconditionally.
- **C10.** msgpackr's module-global encode target is only released above
  1 GiB; after one large encode, module-level `Packr` instances in
  `risuSave.ts`/`rawMsgpack.ts` can retain a payload-sized backing buffer for
  the tab's lifetime.
- **C11.** `patcher.set()` mutates `lastSyncedDb`, hashes, and JSON baselines
  before the network call; a transport failure leaves the baseline ahead of
  the server and provokes an avoidable conflict/rebase. After a successful
  full write the client decodes the bytes it just encoded to re-init the
  patcher instead of reusing the object it already had.
- **C12.** `encodeRawBlock()` ignores its `cache` flag and always stores the
  full source JSON in module-global `risuSaveCacheMap`; character deletion
  cleans `blocks`/`characterJsons` but not this map, and the decoder can
  resurrect stale cached blocks — even during strict authoritative decoding.
- **C13.** `preparePluginStorageBulkTransition()` encodes and retains every
  row before creating one Blob; the browser holds the live inline graph plus
  the complete encoded publication (negotiated cap up to 1 GiB) during the
  inline-to-optimized transition — the mirror image of the bounded server-side
  optimized-to-inline path.
- **C14.** The character path performs `patch.push(...charPatch)` despite the
  in-file warning that spreading a large operation array as arguments can
  exceed the engine-dependent argument limit (the source notes roughly 125k);
  a broad lorebook shift can abort persistence.
- **C15.** `useRecords:false` without `variableMapSize` always emits map16
  headers and throws above 65,535 keys only after encoding; `copyBuffers`
  unset means decoded binary subarrays can pin their entire source buffer.

## Part 3: Additional server findings

| # | Severity | Finding |
|---|---|---|
| S1 | High | Protected chunk reads retain all chunks, re-verify cryptographically, then concat a second full value |
| S2 | High | Large bodies buffer before auth/queue admission; chunking and hashing run synchronously |
| S3 | High | Chat GET/POST repeatedly materialize, decode, copy, and re-read full rows |
| S4 | High | Chat-backup bundles synchronously materialize up to 25 full versions |
| S5 | High | The "streamed" single-row plugin mutation re-reads and fully parses its spool |
| S6 | High | Recovery snapshots/partial backups fall back to row-monolithic assembly with inconsistent locking |
| S7 | Medium | `/api/db/read-cached` encodes and hashes every segment even on a complete cache hit |
| S8 | Medium | Compatibility decoders and the legacy plugin transition remain monolithic |
| S9 | Medium | A one-row plugin mutation rebuilds and verifies the complete manifest |
| S10 | Medium | Plugin viewer cache misses scan and parse the entire publication |
| S11 | Medium | Noncanonical hex paths create duplicate `dbCache` identities and stale persist timers |
| S12 | Medium | Logical-size queries rescan every protected manifest with N+1 SQL |
| S13 | Low | `/api/list` delta still scans all KV/filesystem entries |
| S14 | Low | Plugin session-read state and generation memos have no lifetime bound |
| S15 | Low | Staged transition downloads read each large file twice |

- **S1.** `chunkStore.getValue()` (`../../server/node/chunkStore.cjs`) loads every
  chunk into a retained array, recomputes each chunk's SHA-256 plus the
  logical SHA-256 on every read, and returns `Buffer.concat(parts)` — roughly
  2× payload plus full crypto per ordinary `kvGet()` of a protected chunked
  value (values above the 16 MiB chunking threshold). Database, chat, plugin,
  and viewer callers that use monolithic `kvGet()` inherit this; paths that
  already use `writeValueToFile()`/`kvWriteToFile()` spooling (most exports
  and backups) are exempt. Two concurrent boot readers double the cost, with
  no single-flight or publish-time digest reuse.
- **S2.** The generic octet-stream parser (up to 2 GiB for unlisted routes)
  buffers whole request bodies before route-level `checkAuth()` and before the
  storage queue admits the mutation, so queued writers accumulate payload-sized
  Buffers. Once admitted, `putValue()` runs content-defined chunking, thousands
  of SHA-256 calls, SQLite inserts, and a second full-value hash synchronously
  on the event loop.
- **S3.** `GET /api/chat-content` decodes the full row via `readChatRow()`
  (to inspect cold-storage state), then re-reads the raw row for the response;
  POST decodes for validation, copies the prior row for pre-image backup,
  defensively copies the new row in `writeChatRowRaw()`, then re-reads the
  committed row solely to hash it for the acknowledgement.
- **S4.** Chat version backups are solid gzip bundles of up to 25 raw
  versions: `createBundle()` gunzips every selected version, concats, and
  `gzipSync`s on the event loop; retention rewrites and single-version reads
  decompress whole bundles; reconciliation can cache every uncompressed bundle
  for a chat simultaneously — the default 50 MiB configured disk budget
  (raisable to 50 GiB) bounds compressed disk, not uncompressed working
  memory.
- **S5.** The streamed single-row mutation spools the request to disk
  correctly, then calls `validatePluginStorageRow(key, readFileSync(path))`,
  materializing the file, a UTF-16 string, the parsed graph, and a snapshot —
  before the storage queue — while the batch path already has a bounded
  streaming validator (`validateJsonSource()`).
- **S6.** `createBackupAndRotate()` does a full protected `kvGet` of the
  database even when `dbCache` supplies the object;
  `spoolSelfContainedBackupDatabase()` fully materializes each chat/plugin
  row (`encodeStandalone()` builds whole-row Buffers ahead of the 64 KiB
  writer). Queued snapshots block all mutations for the whole assembly, while
  read-triggered `flushPendingDb()` snapshots run outside the queue against
  live rows.
- **S7.** `/api/db/read-cached` runs `encodeDatabaseSegments()` — encode plus
  SHA-256 for every segment — before consulting the client's cache inventory;
  a fully warm client still costs the server complete segment serialization.
- **S8.** Legacy `compressed`/`plugin-compressed` saves use synchronous
  `decompressSync`; "stream"-format helpers collect entire outputs via
  `Response.arrayBuffer()`; RisuSave block decompression concats retained
  parts; and the legacy (non-bulk) plugin transition endpoint decodes,
  copies, and re-encodes multiple whole databases under the 2 GiB parser.
- **S9.** One plugin-key mutation copies all manifest key arrays into Sets,
  merges mappings over all keys, revalidates the rebuilt manifest, JSON-
  stringifies it entirely, and re-reads it (and, for buffered mutations, the
  full value row) after commit — O(manifest) work for O(1) change.
- **S10.** The viewer page route reassembles and decodes `database.bin` from
  its pinned snapshot per request, and on a total-size cache miss reads and
  JSON-parses every authoritative value (up to the whole publication) to
  return 50 rows, parsing page rows twice, holding the SQLite snapshot open
  until the response completes.
- **S11.** `/api/patch` keys `dbCache`, memos, and persist timers by the raw
  client-sent hex header while SQLite uses the decoded key; `isHex()` accepts
  upper-case, so a noncanonical encoding creates an alias cache entry whose
  timer survives canonical invalidation and can persist stale data.
- **S12.** Protected metadata already stores `logical_size`/`logical_sha256`,
  yet `sizeValue()`/`listValuesWithSizes()` re-derive sizes with per-value
  `COUNT`/`SUM` over chunk manifests, and snapshot accounting repeats
  anti-join scans per snapshot — hot-path cost proportional to total chunk
  count.
- **S13.** The `kv` table has no `updated_at` index, so list deltas scan all
  keys; filesystem inlay deltas stat every entry.
- **S14.** `pluginStorageReadStateBySession` grows per arbitrary session ID
  with no TTL/bound (unlike the 50-entry session lock), and
  `createGenerationMemo()` retains historical keys.
- **S15.** Staged transition row downloads hash the file in one full read,
  then stream it again for the response.

### Areas verified clean

Negative results that bound remediation scope: full/partial/server exports
(pinned SQLite views, spooled rows, streaming archive output with
backpressure); supported imports and snapshot restores (64 KiB paged
expansion with byte/disk limits); backup/save-folder ingress (paged, CRC- and
count-limited, SQLite-backed indexing); `writeValueToFile()` chunk-at-a-time
spooling; streamed plugin batch/transition uploads; `streamJsonToMsgpack.cjs`
bounded conversion; temp-file cleanup on error paths; module-global job
registries other than S14; server msgpackr configuration; browser-side
backup downloads, chat hydration dedup, and draft persistence. No large-value
base64/hex payload transport exists outside finding C6.

## Part 4: Available solutions

The tracks below consolidate the prior report's phases with remediations for
the new findings. Findings addressed are noted in parentheses.

### Track 1 — Remove avoidable client work (no format or protocol changes)

1. **Defer full-save assembly to the fallback.** Keep `encoder.set()`
   maintaining blocks but call `encoder.encode()` only after the patch path
   has actually selected a full write (prior report Phase 1).
2. **Introduce explicit dirty revisions for root keys and characters.** Gate
   both `RisuSaveEncoder.set()` and `RisuSavePatcher.set()` serialization on
   per-entry revision counters, so unchanged plugin maps and characters are
   never stringified (prior report Phase 1; C9). Caution: database and
   character state are mutated through many direct reactive paths, not one
   choke point — a missed writer would silently skip a real change. Either
   implement revision tracking at the proxy/state layer or retain the
   JSON-equality comparison as a correctness fallback until every mutation
   path is instrumented and tested; this item is medium-risk, not a trivial
   work-removal.
3. **Parse strict-decode blocks once.** Merge validation and consumption into
   a single `JSON.parse` per block, process blocks as scanned instead of
   retaining every content string, and gate the whole-database `console.log`
   calls (C1; prior report Phase 1).
4. **Scope and bound `risuSaveCacheMap`.** Honor the `cache` flag, evict
   entries with their blocks, scope the cache to the encoder generation, and
   forbid strict decoding from consulting stale entries (C12).
5. **Snapshot narrowly.** Provide per-character/per-field snapshot helpers for
   `getCurrentCharacter()`, plugin `getChar`, persona/character export, and
   build the settings report from an allowlist that excludes plugin storage
   (C7).
6. **Fix mechanical hazards.** Replace `patch.push(...ops)` with loop appends
   plus an operation/byte budget that falls back to one character-level
   `replace` (C14); enable `variableMapSize` where standard maps are required
   and use `copyBuffers` selectively where decoded binaries outlive large
   sources (C15).
7. **Rein in reactive re-walks.** Replace the recursive `deepTouch(activeChat)`
   subscription with explicit chat revision signals at mutation boundaries, or
   batch streaming updates so the walk runs per persistence interval rather
   than per flush (C2).

### Track 2 — Server read/patch lifecycle

1. **Make `dbCache` reuse generation-aware.** Associate the decoded graph with
   a SQLite row revision/updated-at token and reuse it in
   `prepareLiveDatabaseRead()` and `/api/patch` when the token matches,
   decoding only on genuine external change (prior report Phase 2).
2. **Stop the full-write double decode.** Pass the already-validated stripped
   object (or just the two publication fields) to
   `rememberSessionPluginStorageState()`, and install the validated object
   into `dbCache` so the next patch starts warm (prior report Phase 1).
3. **Change ETag derivation.** Today's ETags are meaningful byte digests with
   distinct domains — MD5 of the canonical normalized legacy encoding for
   ordinary/cached reads, MD5 of the verbatim row for raw boot — and full-write
   `If-Match`, patch conflict detection, and boot reconciliation depend on
   them. An incremental digest cannot transparently replace them. Two viable
   shapes: (a) keep the canonical ETag but produce the encoding once per
   generation and share it between ETag derivation and delayed persistence;
   or (b) introduce a distinct version/concurrency token, migrating every
   client path (patch, full write, cached read, raw-boot reconciliation) in a
   coordinated protocol change (prior report Phase 2).
4. **Canonicalize storage-key identity.** Decode and re-encode every hex path
   to lower-case canonical form before touching caches, memos, or timers.
   Continue accepting case variants on the wire — `isHex()` currently admits
   them, so outright rejection would be a client-visible compatibility change
   reserved for a negotiated deprecation (S11).
5. **Memoize segments per generation.** Key encoded segment bytes and hashes
   by the database generation, consult the client inventory before encoding,
   and invalidate only mutated segments — a warm `read-cached` hit should cost
   near zero (S7; prior report finding 4). Oversized segments (the inline
   root) should select raw-boot or an explicit non-cacheable transfer without
   envelope copies (prior report Phase 1).
6. **Return chat rows without re-materialization.** Serve `GET
   /api/chat-content` from one raw read (cold-state markers moved to separate
   metadata), let the writer consume owned Buffers and return the stored
   digest instead of re-reading committed rows, and stream pre-image backups
   from the protected store (S3).

### Track 3 — Bounded ingress and streaming reads

1. **Admit before buffering.** Perform side-effect-free admission — auth
   check, writer-session eligibility, and route-specific `Content-Length`
   limits — before large body parsing, replace the generic 2 GiB ceiling with
   realistic per-route limits, and add a global in-flight byte budget
   alongside the request queue (S2). The admission check must not perform the
   authoritative writer-lock transition: `checkWrite()` can refresh or
   transfer the lock, so the mutating check stays at accepted-mutation time
   and a stale-but-authenticated writer must still be rejected before its
   body is buffered where possible.
2. **Spool large ingress.** Stream database/chat write bodies to disk and
   validate outside the mutation queue, but keep publication inside
   `queueStorageMutation()` and one transaction: database ETag checks, plugin
   publication guards, chat externalization/pre-images, and import fencing
   must be rechecked at commit time against the spooled bytes; a spool can
   never publish directly. Compute the logical digest during the chunking
   pass rather than as a second sweep, and move CDC/hash work off the event
   loop (S2).
3. **Stream protected reads.** Add a verified async-iterator/stream read to
   the chunk store; where a contiguous Buffer is unavoidable, preallocate
   `logical_size` and copy chunks in place. Keep reads fail-closed: verify
   fully on the first authoritative read or cache fill, then memoize the
   verified result against an immutable publication/SQLite revision so warm
   re-reads of unchanged rows skip re-verification. Periodic scrubs
   supplement, never replace, that first verification. Add single-flight for
   concurrent identical reads (S1).
4. **Reuse the streaming JSON validator.** Make the single-row streamed plugin
   mutation validate via `validateJsonSource()` like the batch path instead of
   `readFileSync` plus `JSON.parse` (S5).
5. **Serve sizes from verified metadata.** Answer `kvSize()`/inventory queries
   from stored `logical_size` only behind a revision-bound
   publication/inventory consistency check with an authoritative fallback —
   the current queries also prove publication and chunk-set consistency, which
   raw metadata alone cannot. Use one aggregate query for listings, and add an
   `(updated_at, key)` index plus a filesystem change journal for list deltas
   (S12, S13).

### Track 4 — Background and bulk subsystems

1. **Restructure chat-backup bundles.** Store independently compressed frames
   per version with an offset index (or per-version entries), cap bundles by
   uncompressed bytes as well as count, stream creation to disk, decompress
   only the requested frame, and move compression/reconciliation off the
   event loop (S4). This also intersects the deferred per-row `chats/` backup
   format work.
2. **Assemble snapshots from pinned sources outside the mutation queue.**
   Under the queue, flush pending database state, open a pinned SQLite
   snapshot, and capture a global source token covering the database row,
   chat rows, the selected plugin generation and exact manifest, quota/owner
   state, and the recovery-dirty token — one database generation alone is not
   a sufficient consistency proof. Assemble source-to-source outside the
   queue reading only through that pinned snapshot, then re-enter the queue
   to publish only if the token still matches; replace the existence-check
   `kvGet` of the whole database with a metadata query (S6).
3. **Normalize the plugin manifest.** The exact manifest is currently live
   publication authority (membership, order, and hashed-key mappings), so
   moving it into SQLite tables is a publication-format migration touching
   boot, read, viewer, backup, restore, and transition contracts together —
   not an internal representation swap. The bounded alternative is to retain
   the exact manifest as the atomic artifact but cache one parsed manifest
   per revision and drop post-commit full-value re-reads (S9).
4. **Maintain viewer facets incrementally.** Track per-row display size and
   owner facets transactionally, single-flight total-size backfills, reuse
   page values from the backfill pass, and cap concurrent viewer snapshots
   (S10).
5. **Bound legacy compatibility paths.** Replace the legacy (non-bulk) plugin
   transition endpoint with a bounded adapter that delegates to the same
   fresh-generation, exact-manifest atomic transition — capability
   negotiation deliberately keeps this path for older clients, so outright
   retirement needs a negotiated deprecation. Give compatibility
   decompression conservative limits, and route large compressed inputs
   through the disk-backed streaming pipeline (S8). Bound `pluginStorageReadStateBySession`
   and give the generation memo real deletion (S14). Hash staged transition
   files once at upload and stream downloads from one descriptor (S15).

### Track 5 — Architectural decoupling (the durable fixes)

1. **Separate browser residency from persistence layout** (prior report
   Phase 3). Concretely this is a new negotiated persistence mode, not a
   tweak of the existing two: inline mode's authority is the database object
   and it admits legacy structured-clone values, while optimized rows are
   strict JSON governed by generation plus exact manifest. Keeping rows
   external while the compatibility map is eagerly resident therefore needs a
   rich-value row codec, a mutation bridge so compatibility-map writes
   publish their rows, and an atomic publication of mode, fresh generation,
   exact manifest/rows, owners, quota, database marker, and recovery token —
   with boot, patch, backup, restore, and transition protocols migrated
   together. Done right, it removes the inline map from encoder, patcher,
   ETag, patch, resource-cache, and `dbCache` paths. The
   chunked-inline-block alternative is less disruptive to the format but
   leaks special-casing into every consumer.
2. **Evolve chat persistence toward deltas.** Appendable or chunked chat rows
   (or delta uploads) would turn the 20-second full-row checkpoint and full-row
   POST cycle into O(new messages) work (C3, S3), and would compose with
   per-frame chat backups (Track 4.1).
3. **Bound conflict recovery.** Rebase by merging only the tracked dirty
   branches into a single authoritative working graph rather than cloning
   both full databases — preserving every branch the current merge handles
   (roots, characters, chats, bot presets, modules, plugins,
   `pluginCustomStorage`/`pluginStorageMeta`) and continuing to exclude
   optimized publication controls, which reconcile through their CAS
   publication protocol, from generic graph merging. Retire old
   encoder/patcher state before building replacements; make patcher baselines
   commit only on server acknowledgement, with the encoder exposing its
   normalized baseline so full writes need not re-decode their own output
   (C5, C11).
4. **Move heavy codec work off the main/event loop.** Worker-based encode,
   decode, and hash for payload-sized operations on the client; worker or
   cooperative pipelines for CDC/compression on the server (C1, C3, S2, S4).
   Cap or work around msgpackr's 1 GiB target retention with disposable
   workers or a patched threshold (C10).
5. **Prefer binary, streaming plugin-value transport.** Versioned reads
   returning raw bytes with metadata in headers instead of base64-in-JSON,
   fused validate-and-serialize on writes, and streamed/spooled rows for the
   inline-to-optimized transition (C6, C13).

### Track 6 — Validation coverage

The prior report's four proposed tests remain correct (cold inline bootstrap,
unrelated-save work bounds, server cache lifecycle, oversized resource-cache
root). The new findings motivate five more, again budgeted relative to payload
size `S` against an empty-baseline measurement:

1. **Protected chunk read peak:** a 500 MiB chunked `kvGet` should approach
   one output allocation, not retained-parts-plus-concat, and a warm re-read
   of a row whose publication revision is unchanged since a fully verified
   read should skip cryptographic re-verification (first reads stay
   fail-closed).
2. **Concurrent ingress:** N simultaneous large writes should be bounded by
   the admission budget, not N payload-sized Buffers.
3. **Chat checkpoint cost:** a streaming generation should upload O(delta),
   not O(chat), per checkpoint once Track 5.2 lands.
4. **Warm `read-cached` acknowledgement:** a fully cached client boot should
   not trigger per-segment encode/hash on the server.
5. **Conflict rebase peak:** an ETag conflict on a large database should hold
   a bounded number of graphs, asserted against the current several-graph
   worst case.

## Suggested sequencing

1. **Quick wins, low risk:** Track 1 items 1, 3, and 4 and Track 2 items 2
   and 4 — pure work-removal with no format changes. These remove the worst
   per-save and per-boot waste; note they do not eliminate steady browser
   retention by themselves, since the live graph, encoder blocks, and
   patcher normalized graph remain. Track 1 item 2 (dirty revisions) follows
   once its correctness fallback is in place.
2. **Read/patch lifecycle:** remaining Track 2, then Track 3 items 3–5 —
   requires care around cache coherency but no client-visible protocol change
   except the ETag rework, which needs coordinated rollout.
3. **Ingress hardening:** Track 3 items 1–2 — also reduces
   denial-of-service exposure for externally reachable instances.
4. **Subsystems:** Track 4 in impact order (snapshots, chat backups, manifest,
   viewer).
5. **Architecture:** Track 5, led by residency/persistence decoupling, which
   the prior report correctly identifies as the durable fix for the inline
   mode, followed by chat-delta persistence.

## Relationship to prior documents

This audit extends and supersedes the scope of
[plugin-storage-inline-memory-performance.md](plugin-storage-inline-memory-performance.md)
without replacing it: that report remains the detailed reference for the
inline plugin-storage pipeline, with the corrections in Part 1 applied.
Historical risk reports now indexed under `../../docs/findings/WORK-INDEX.md` are unrelated point-in-time
data-loss audits.
