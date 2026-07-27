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

Every staged acknowledgement is schema-exact and bound back to the requested
transition id, direction, target generation, row key, size, upload state, and
SHA-256. An inline source row is released only after that exact upload receipt.
The response state is also constrained to combinations the server can emit:
only an incomplete externalization may be `uploading`, `ready` and `committed`
have every row uploaded, every row carries its authoritative SHA-256, and only
a committed response carries an exact result ETag. Staged status refresh uses
the same import wait-and-recheck gate as generation-bound reads, so a private
receipt cannot be resolved or deleted from a tentative imported publication.
Internalization hashes each downloaded private-stage row before parsing or
finalizing, so a same-size substituted body cannot make browser memory diverge
from the server's committed target. Abort is idempotent: the exact minimal
missing-stage tombstone is definitive, and a lost abort acknowledgement retries
that safe control before falling back to status resolution.

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

**Fixed 2026-07-27.** The Plugin Storage viewer now retains one page of at most
50 logical rows and never constructs a repository-wide value array. In
optimized mode, one viewer-specific request passes the import/read barrier only
long enough to flush and pin a read-only SQLite snapshot. The response is then
streamed outside that queue, so a slow viewer cannot hold PM4 mutations. The
server parses the active generation and ownership manifest once, orders keys by
the canonical plugin-record rule (array indexes numerically, then raw UTF-16
code units), selects the page, and reads value and owner bodies serially. At
most 50 value bodies and 50 owner bodies are touched; instrumentation records no
nested row parse, although one chunked logical row may still be synchronously
reassembled. Owner chips, unknown-owner counts, filtered totals, and page counts
cover physically present manifest-owned rows matching the key filter. Boot
rebuilds the transactional owner index with a read-only row iterator instead of
retaining every owner body in an `.all()` array.

Partial local export is now an authenticated, owner-scoped two-phase job rather
than one request that stays open while the archive is prepared. The browser
chooses a canonical UUID before `POST /api/backup/export/jobs`, so repeating a
create after a lost acknowledgement returns the same job and cancellation can
still address it. Identity, per-owner admission, and one global job slot are
installed before the first asynchronous operation; a different id for the same
owner is rejected while a job is active. Preparation preflights the save volume
and the configured database-spool path, which may share that volume or use
another one. It returns `202` promptly and publishes status and byte/entry
progress. Create and each status request retain
an independent 15-second availability bound, while the job as a whole may run
for longer than 15 seconds under the caller's `AbortSignal`.

Status, cancel, and the one-shot ready download remain bound to the creating
owner even if its writer lease is displaced. Cancel uses an independent bounded
cleanup request when the caller signal is already aborted. Cancellation,
failure, successful consumption, download disconnect, and the 15-minute TTL
trigger private-artifact cleanup; boot cleanup retries owned orphan directories
and preserves unrelated files. A bounded owner/id tombstone prevents a delayed
create POST from resurrecting a job after cancellation won the race. The
partial-backup dialog displays server progress and exposes a real Cancel action.
The legacy synchronous partial route is rejected so it cannot bypass this
lifecycle.

Preparation flushes pending writes and holds one SQLite snapshot while choosing
the database, optimized plugin rows, and referenced assets. External plugin
values are folded into `database.risudat` one row at a time. A selected
filesystem asset is copied from an open descriptor through a fixed 256 KiB
buffer to a job-private pin on the same save volume; size, device, inode, and
modification time are checked. SHA-256 is computed for every pin and compared
with an expected digest for content-addressed filenames. A selected KV asset
remains bound to the SQLite snapshot even if a filesystem file later shadows
it. Archive assembly reads the asset pins plus a database spool produced
row-by-row from the pinned SQLite snapshot, writes a temporary private archive,
and atomically publishes the immutable ready spool. Thus an equal-size
replacement after pinning yields the old bytes or aborts, never the replacement.
PM2 transition-stage rows and
receipts are outside the public snapshot and selected-asset set and cannot leak
into a partial archive. The selected-asset archive remains upstream compatible,
omits account data, and applies the same BR4 archive-key validation as other
folded exports.

Every streamed page is point-in-time and self-verifying. Its metadata carries
the exact generation, manifest revision, database revision, page, global
facets, and counts. NDJSON records have exact schemas; blank records, duplicate
or noncanonical keys, invalid metrics, byte-size/type mismatches, and extra
fields are rejected. Each entry has a content hash covering key, owner, display
text, UTF-8 size, type, and value/owner revision. The page token uses injective
canonical JSON framing (including embedded U+0000 in filters) and binds the
snapshot metadata, filters, global facets, unknown count, selected ordered keys,
and selected entry content hashes. A selected body, owner, filter, ordering, or
revision change therefore cannot reuse that page's token; off-page bodies are
outside the token by design.

Each UI load owns an `AbortController`. Page, backend, key-filter, or
owner-filter changes synchronously abort the superseded request, and coordinator
disposal aborts its remaining lease. Identity checks reject late bodies even if
a transport resolves after observing abort. Cancellation is checked during body
reads, before and after every post-EOF content hash, around page-token hashing, after
the final progress callback, and before publication. On the server, request
abort or response close stops before the next row, releases backpressure
listeners, rolls back the read transaction, and closes the snapshot. An abort
while waiting behind an import exits before a snapshot is created.

Save-backed viewer edits and single deletes carry the exact row revision from
the pinned page; filtered deletion sends one atomic batch of at most 50 expected
revisions. A conflict does not mutate, and an unknown commit outcome is never
retried. Both cases show a distinct error and perform a read-only authoritative
reload. Explicit unfiltered clear-all retains its dedicated whole-publication
primitive; device-local backends retain their existing operations.

Snapshot restore now queries only publication metadata up front, then spools a
raw row through SQLite `substr()` pages or a chunked row through completed
point queries of at most 64 KiB. It never keeps a `better-sqlite3` iterator open
across an `await`, yields and checks the socket-derived `AbortSignal` before and
after every part, and ingests through the resulting file cursor instead of
beginning with `kvGet()` / `Buffer.concat()`. Cursor-unsupported compatibility
formats use a separately capped full-memory fallback. Normal-path cancellation,
rollback, failure, and success unlink incomplete restore/export spools, while
startup cleanup retries leftovers. Request, response, and keep-alive socket
abort listeners are detached in the route `finally` block.

Chunk publications now carry expected count, logical length, and logical
SHA-256 metadata plus a durable per-key publication guard. A transactional,
versioned one-time migration verifies legacy dense sequences, row presence,
sizes, and canonical chunk hashes before enabling protection. Afterwards,
missing metadata, a missing tail, reordered/substituted/altered chunks, or even
deletion of both manifest tables is corruption rather than a downgrade to the
13-byte raw marker. Body-producing live/pinned reads and restore spooling verify
the logical hash. Size/list, snapshot cost/copy, and chunk-status paths enforce
the guard, dense structure, and aggregate length but do not independently hash
every same-size body; a failed copy leaves its destination unchanged. A corrupt
legacy publication is protected per key without preventing valid siblings or
the global migration version from publishing. A legitimate
unguarded raw value equal to the marker remains byte-compatible. The chunk
threshold environment override is finite, positive, and lower-only, capped at
the 16 MiB safe default; invalid/high overrides cannot create new oversized raw
rows, while legacy raw rows are still read in bounded pages.

Corrupt-database bootstrap uses the same bounded path. It obtains only a strict,
newest-first metadata list from the import-safe `/api/db/snapshots` read, then
submits each canonical key directly to the authoritative restore transaction.
It never enumerates the generic KV namespace, trims recovery points, downloads a
candidate through `/api/read`, or decodes a folded candidate in browser memory.
Only after a definitive commit does it perform one ordinary full read and decode
of the stripped live database. Snapshot discovery retains an unreadable
candidate with `size: null`, so direct restore can classify it definitively and
continue to an older key. List, restore, and delete share canonical
no-leading-zero and safe-timestamp key validation, while the client also rejects
any extended or non-200 restore acknowledgement as commit-unknown.

The BR3 live-ownership boundary is also bounded. The streaming loader first
decodes the folded marker, then invokes a deferred proof before emitting any
target plugin row. That proof parses and canonicalizes the manifest separately,
rejects duplicate declarations, and validates each declared current row in a
narrow scope without cloning its Buffer or retaining a second parsed snapshot.
It yields and checks cancellation between rows; only after every row validates
does the existing import-barrier-protected SQLite transaction delete the prior
owned set. Consequently a same-key target cannot manufacture proof for a
missing or malformed old row, and unmarked imports do not read any live
ownership body.

Compressed and compatibility snapshots are bounded at the decode boundary as
well. Canonical gzip/zlib/stream inputs expand through a backpressured Node
pipeline with an output-meter transform whose chunks are at most 64 KiB. The
meter polls both `AbortSignal` and the request disconnect state, enforces a
finite decoded-byte ceiling plus reserved disk headroom when filesystem capacity
is available, and unlinks decoded or compressed-block spools on normal-path
success, failure, and cancellation with startup retry for leftovers. The
defaults are a 4 GiB decoded ceiling, 256 MiB disk reserve, and a separate
64 MiB serialized-source/cumulative-decoded-payload cap for formats that the
cursor cannot safely walk; this is not a resident-memory ceiling. Known
decoded-size, legacy-memory, and disk-headroom failures return a definitive
pre-commit 413. Corrupt compressed
data and structural cursor failures return a definitive pre-commit
`RISU_SAVE_INVALID` 400 instead of a retryable 500.

Block-format REMOTE resolution is finite and fail-closed. The restore adapter
queries each row's logical `kvSize()` before `kvGet()` may concatenate it,
meters the complete recursive graph cumulatively, caches duplicate references
so they are neither read nor counted twice, and rejects cycles or nesting past
32 levels. Duplicate pointers may still materialize the decoded target more
than once. A referenced missing/disappearing row is invalid input; size/read
exceptions propagate to the transaction boundary. Resolver-present decode can
therefore never commit a database with a silently omitted character. Direct
legacy decode without a resolver retains its historical skip behavior. The
legacy restore path also bypasses live-database REMOTE migration after decoding,
so it publishes the requested snapshot object rather than substituting the
current live monolith.

Settings restore no longer bypasses the storage adapter with an unbounded raw
`fetch()`. Settings and corrupt-boot fallback share
`AutoStorage.restoreInternalSnapshot()` and the same authoritative
`NodeStorage` implementation. It accepts only the exact
canonical `database/dbbackup-<digits>.bin` key form with no leading zero except
`0`, where both the suffix and suffix × 100 timestamp are nonnegative safe
integers. Each attempt sends one non-retried POST with the
active writer-session header, and allows a finite, abortable ten-minute window
for large file-cursor ingestion rather than the ordinary 15-second storage I/O
bound. The server applies the same exact-key check and the client accepts only
the exact echoed `{ ok, key, commitOutcome, commitOutcomeUnknown }` committed
schema.

A committed acknowledgement reloads into the new authoritative publication. A
definitive rollback or active-session `423` leaves the current page in place;
`423` is classified from response headers before reading its optional body, so
a stalled, truncated, aborted, or timed-out diagnostic body cannot become an
ambiguous mutation. The body is cancelled best-effort without changing that
outcome. Transport loss, timeout after dispatch, malformed/truncated or
proxy-generated `2xx`, and a mismatched echo remain commit-outcome unknown.
They are never replayed automatically: Settings presents a distinct warning
and hard-reloads only to reconcile server state, while boot recovery stops
without selecting an older snapshot.

Production server viewer tests load a real 10,000-key publication and assert one
50-value page, one manifest parse, serial row parsing, exact global owner facets,
canonical mixed numeric/composed/decomposed/BMP/astral ordering, and distinct
tokens for formerly colliding U+0000 filter tuples. A 10,000-key same-membership
mutation race proves a page is entirely pre- or post-publication while the PM4
mutation completes without waiting for the viewer. A paused real HTTP response
reaches backpressure, disconnects, reads fewer than 50 rows, releases its
snapshot, and permits the next mutation. Another real import race proves a
disconnected viewer stops while the import still owns the barrier. Client tests
exercise fragmented UTF-8, strict negative NDJSON/token cases, aborts during
body and post-EOF hashing, and a mounted UI filter change whose obsolete late
response cannot commit. UI mutation tests and a real server route prove stale
same-key edit/delete revisions do not mutate bytes, while a fresh revision
commits.

The marked legacy escape needed for an own external `__proto__` key is streamed
under the same bound. Export planning retains only each validated row source
descriptor and its insertion index, removes that reserved key from the ordinary
map stream, and defers reading it until the final escape sidecar. The writer
encodes the sidecar's fixed MessagePack array shape directly, then reads,
JSON-stringifies, writes, and releases one value or metadata escape row before
fetching the next. It never builds the former aggregate parsed/stringified
envelope. Numeric-key ordering, duplicate-key last-write semantics, exact own
special keys, and a user value colliding with the reserved sidecar field are
preserved; malformed, accessor-backed, non-string, and ill-formed-Unicode row
descriptors fail before publication.

Coverage uses deterministic bounds rather than raw-heap timing: the real
10,000-key viewer asserts a 50-value page, while the generic helper separately
asserts one active asynchronous read on a 40-row page. Partial folding exercises
1,000 rows plus a 4 MiB body with one parsed row in flight and upstream
archive/import round trips. Real-server export tests cover prompt creation with
an injected preparation delay exceeding 15 seconds, idempotent duplicate creates,
same-owner admission, writer-session displacement, cancellation, restart orphan
cleanup, a 16 MiB download disconnect, equal-size asset
replacement, account omission, and PM2 private-stage exclusion. Client tests
cover progress, UI cancellation, a stalled status request, a lost create
acknowledgement, sink-setup cancellation, and preservation of the ordinary
pre-header bound for non-job downloads. A real short-TTL stalled download proves
socket termination, admission release, and private-spool cleanup. Chunk restore
asserts more than 300 sequential parts of at most 64 KiB, exact bytes,
folded-snapshot recovery, and cancellation/error
cleanup. A combined real-server test pauses after the exact prior ownership set
has been fully proven but before deletion, disconnects the client, and verifies
transaction rollback, spool cleanup, and old-state durability after restart.
Another production-path case restores exactly eight 7 MiB current rows (56 MiB):
instrumentation records one active row, and forced-GC retained heap remains
below two row bodies rather than scaling with the aggregate. A fail-on-first-
ownership-read guard proves unmarked streamed restore reads zero bodies, while
a malformed final row—including when the target supplies the same key—preserves
the old publication byte-exactly. Composition coverage confirms that PM2 private
stage files are ignored and their old source cannot finalize after restore, and
that PM4 rejects a stale pre-restore manifest revision but commits with the
fresh revision. A real NodeStorage recovery test supplies two 64 MiB chunked
candidates (newer invalid, older valid), rejects any candidate `/api/read`,
observes server-side fallback, hashes the exact recovered chat after restart,
and requires empty restore spools. A separate 52 MiB real-server test observes
a partial spool, closes the client socket before `BEGIN`, and verifies cleanup,
no publication, exact old-state preservation, and restart durability.
Corrupt-middle and manifest/metadata-deletion cases (with the durable guard
retained) independently return definitive non-committed failures. A separate
30-restore single-socket keep-alive run has stable listener counts and no
`MaxListenersExceededWarning`. Additional fixtures cover actual gzip, zlib,
raw-deflate, old-prefix,
headerless MessagePack, compressed block, and REMOTE files; expansion bombs and
exact size/headroom boundaries; real decompression cancellation; recursive
REMOTE success, oversize-before-read, duplicate caching, cycle/depth rejection,
resolver size/read failures, and missing rows. Full-route cases prove exact
rollback, stable 400/413/500 not-committed classification, spool cleanup, and
restart preservation. Restore-specific client/UI tests cover a valid response
after 15 seconds,
finite timeout abort, one-request transport loss, definitive rollback, exact
schema and key echo, malformed/truncated proxy responses, and no unsafe retry.
Real-server coverage proves displaced-session `423`, exact-key rejection,
response loss after commit, and PM2 staged-source invalidation; the committed
`NodeStorage` path separately asserts PM4 database-cache invalidation.
Stalled-body regressions advance both an external abort and the full restore
timeout while requiring `423` to remain non-committed with no UI reload.
A production export/decode/import case with a 3 MiB own `__proto__` value and
2 MiB metadata proves ordinary rows are emitted first, at most one escape-row
read is active, the spool advances before the second is read, and exact marked
decode/re-import preserve the reserved-field collision and selected pinned
asset. Separate cancellation and row-failure cases remove the incomplete spool;
malicious descriptors are rejected without leaving one.

<a id="pm3-r6-bounded-import-ingress"></a>
### R6 — Bounded backup and save-folder import ingress

**Fixed 2026-07-27 in `f1931989`.** Backup uploads, server-backup restores,
save-folder ZIP uploads, and direct save-folder adoption now enter through one
finite ingress policy. The default archive, ZIP, and expanded-data ceiling is
2 GiB; zero, fractional, non-finite, unsafe, or out-of-range overrides fall
back to that finite default rather than disabling the limit. The default ZIP
and directory entry ceiling is 100,000. Cursor-unsupported legacy databases
have a separate 64 MiB compatibility ceiling. Row-local materialization is
capped at 32 MiB, while supported databases, database backups, chats, valid
plugin-value rows, and safe filesystem assets remain file-backed. Plugin JSON
is validated incrementally, including arbitrarily long valid numeric lexemes
and exact exponent/mantissa cancellation, without retaining the complete
token.

Network bodies and archive entries are staged in private mode-`0600` files
inside mode-`0700` directories. Reads, writes, copies, ZIP central-directory
inspection, extraction, JSON validation, and database cursor ingestion use
pages no larger than 64 KiB. Preflight and post-spool checks require twice the
source or expanded byte count to be available on the relevant staging volume.
The disk gate is exact at the configured boundary, but filesystem capacity can
change after preflight and cleanup remains best-effort with startup retry.
These are finite I/O and staging guarantees; they are not a hard RSS or heap
ceiling for the complete Node process.

ZIP inventory is completed before publication. ZIP64 sentinels, excessive or
duplicate decoded entries, unsupported compression, traditional/strong/masked
encryption flags in either central or local headers, inconsistent flags,
names, CRCs, or sizes, malformed zero-byte deflate streams, expansion beyond
the declared size, CRC mismatch, and bytes trailing the raw-deflate end marker
are rejected. Store and raw-deflate are the only admitted methods. Extraction
proves exact compressed-range consumption and removes the complete tentative
stage on cancellation or failure.

Every import installs disconnect tracking before waiting for the mutation
barrier. The tracker seeds already-aborted or prematurely destroyed requests
without misclassifying a normally completed JSON body, and barrier acquisition
accepts the resulting `AbortSignal`. An abandoned queued turn is removed;
cancellation during the FIFO mutation drain waits for that drain to finish
before releasing the hold, so a later transaction cannot overtake an older
write. Acquisition, `importInProgress`, route spools, heartbeat timers, streams,
listeners, and barrier release share an outer `try`/`finally` on all four
routes. A drain rejection clears the slot and admits the next import.

Archive upload and server restore both send an immediate NDJSON heartbeat and
periodic heartbeats through decode, fsync, directory swap, commit, and cleanup.
Late terminal failures use one exact event containing `type`, `message`,
`code`, `retryable`, `commitOutcome`, `commitOutcomeUnknown`, and `status`.
Both browser parsers retain those fields in `StorageError`, including a final
line without a newline and a UTF-8 code point split across response chunks.
Rollback restores SQLite and swapped asset/inlay directories together;
normal failure, socket abort, success, and restart cleanup remove upload,
entry, database, and save-folder stages. Startup sweeps owned orphan stages.

Production-path coverage imports a supported database and a non-database asset
larger than 52 MiB through archive and save-folder routes, retains a plugin
value larger than the 32 MiB buffered-row cap through file-backed ZIP and
directory paths, and exercises exact/+1 archive, ZIP, expanded-byte, entry,
buffered-row, legacy, and two-times-disk-headroom boundaries. Real socket tests
disconnect while barrier acquisition drains, force acquisition rejection on
all four routes, hold restore through multiple heartbeats, compare exact late
errors from upload and restore, and verify save-folder failure after the asset
swap rolls database and files back before and after restart. Five independent
fix/verification cycles closed numeric, ZIP, lifecycle, response-contract, and
cleanup edge cases. The final runs passed 1,515 browser tests (3 skipped), 233
compatibility tests (5 skipped), and 269 server tests, with `svelte-check`
reporting zero errors and four pre-existing warnings.

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

### Resolution

**Fixed 2026-07-27.** Compound V3 writes use AA3's bounded `atomicBatch()`
path. A generation-bound batch now reads one compact manifest-revision token
and sends one batch request; it no longer lists both storage prefixes, reads
the full manifest separately, or echoes every repository key in the request.
The version-2 envelope is therefore O(batch rows), not O(repository rows),
while the server compares the token inside the same serialized writer queue
as the commit. Full-manifest version-1 requests remain accepted for older
callers.

Prepared set buffers are explicitly donated through the batch transport. The
client makes no per-row stability copy, hashes only the one freshly encoded
request envelope, and validates the request-bound acknowledgement. During the
transaction, the server computes each raw value hash once and returns it with
the committed revision. The client uses those hashes and the same donated
buffers to publish all committed sets/removes in one best-effort cache call,
one write queue slot, and one IndexedDB transaction. It neither copies nor
rehashes each value for seeding; cache reads still independently verify bytes
before use, so a bad cache entry remains only a disposable miss. Conflict,
malformed, unknown-outcome, and cache-disabled paths publish nothing.

Measured explicit client/cache work now has the following bounds. “Copies”
counts the former full-value cache defensive copies and excludes unavoidable
wire encoding and IndexedDB's internal structured clone; “prunes” counts full
manifest/entry inventory scans.

| Workload | Before: requests / client SHA-256 / copies / prunes | After |
|---|---:|---:|
| 3-row atomic batch, cache enabled | 4 / 4 / 6 / 3 | 2 / 1 / 0 / 1 |
| 128-row atomic batch, cache enabled | 4 / 129 / 256 / 128 | 2 / 1 / 0 / 1 |
| 4 × 2 MiB atomic batch, cache enabled | 4 / 5 / 8 / 4 | 2 / 1 / 0 / 1 |
| Any atomic batch, cache disabled | 4 / 1 / 0 / 0 | 2 / 1 / 0 / 0 |

Ordinary generation-bound unowned sets and value-only removes also fall from
three ownership reads plus one mutation to one atomic mutation request. The
set path preserves the existing sidecar. The value-only remove path likewise
preserves the owner bytes and metadata-manifest membership, matching inline
mode; the distinct owned remove still deletes both rows. Both remove forms
invalidate the value cache only after a schema-valid committed
acknowledgement.

Independent plugin calls remain independent authoritative requests and retain
their one request-bound digest, but they no longer force a global cache prune
per row. Cache work accumulates bounded debt and prunes after 32 mutations,
8 MiB of added bytes, or one 50 ms burst window. Thus eight same-tick writes
cause one deferred scan, 128 independent writes cause four threshold scans,
and a single 128-row or 8 MiB batch causes at most one scan.

Generation-bound enumeration now receives the exact manifest plus its
physically present owned value/meta rows in one server snapshot. A `keys()`
refresh uses one request instead of two prefix lists plus a manifest read;
repeated `key()` and `length` calls reuse that local snapshot with zero
requests until a mutation or mode transition invalidates it. Foreign physical
rows remain quarantined, and manifest-owned missing rows remain absent.

The same generation snapshot feeds a viewer's 50-key page, owner lookup, and
serial value reads, avoiding one repository-sized manifest request per value.
Owner rows are fetched concurrently under shared transition admission, so a
stalled viewer row does not block an unrelated atomic batch. Snapshot transport
validation rejects padded base64 aliases, malformed suffixes, and invalid UTF-8,
and cancellation propagates to the manifest request.

Versioned manifest/state/value reads now cross the streamed-import boundary
through a wait-and-recheck queue gate. They either complete ahead of the
import's raw transaction or wait for its commit/rollback; they cannot observe
tentative imported rows on the shared SQLite connection. This includes the
ordinary `/api/read` transport when it is bound to a plugin-storage generation.

Server-side supporting work avoids rebuilding full-value revision buffers,
uses linear set comparisons for manifests and membership, computes committed
revisions from already-held value/owner bytes, and reuses the flushed database
publication cache instead of decoding `database.bin` for every operation.

Regression coverage includes strict compact-envelope and acknowledgement
schemas, identity checks for every one of 128 donated rows, a four-by-2-MiB
donation workload, cache enabled/disabled publication, and real fake-IndexedDB
proof of one mutation-group transaction plus the 8-to-1 and 128-to-4 inventory
scan bounds. It also covers one-request 50-row viewer reuse, cancellation,
ordinary one-request set/remove paths, stale compact CAS rejection,
foreign/missing-row quarantine, exact returned value hashes, transaction and
failpoint behavior, streamed-import read isolation, and real-server
value-only-remove owner/manifest parity.
