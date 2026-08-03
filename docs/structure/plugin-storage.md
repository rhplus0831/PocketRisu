# Plugin storage

> Part of the [PocketRisu structure guide](../../STRUCTURE.md). Audited on
> 2026-08-01 against `818c3bc1`. Prefer the symbols below over volatile line numbers.

## Purpose and scope

This subsystem owns save-synced plugin values from the V3 API down to browser/server
transport, inline and optimized persistence, concurrency control, mode transitions,
inspection, backup participation, and recovery. Plugin execution, iframe isolation,
request hooks, providers, and MCP registration remain in
[Scripting and extensions](scripting-extensions.md).

Plugin storage is a shared namespace. Ownership metadata supports inspection and
maintenance, but it does not isolate one plugin from another. Plugin authors should
prefix keys and must not treat `clear()` as a per-plugin operation.

## Persisted modes

| Mode | Values and owners | Authority |
|---|---|---|
| Inline | `Database.pluginCustomStorage` and `Database.pluginStorageMeta` inside `database/database.bin` | The database object |
| Optimized | `pluginsave/<encoded>.json` and `pluginsave-meta/<encoded>.json` | Matching `Database.pluginStorageGeneration` plus `plugin-storage/manifest.json` |

Inline basic get/set preserves legacy structured-clone values. Versioned reads can
surface those legacy rows for guarded migration or removal, but optimized storage and
versioned/compound replacement values require detached, strict JSON.
`Database.autoConvertPluginStorageValues` is an independent compatibility setting, not
part of the optimization toggle. When an ordinary optimized write or externalization
cannot be represented as strict JSON, it may convert `Date`, `Map`, `Set`, `BigInt`,
`undefined`, non-finite numbers, and sparse-array holes into documented JSON-compatible
forms. It does not change inline values or relax versioned/compound replacement APIs;
functions, circular references, accessors, symbols, and custom classes still fail.

Optimized authority is not “every row under the prefix.” The manifest names the exact
value and metadata rows in the selected generation. Undeclared physical rows are
quarantined data and must not appear in live reads, exports, the viewer, or an exact
restore.

One compatibility exception exists for pre-generation optimized saves: when
`optimizePluginMemory` is true and neither a generation nor a manifest exists, the
existing physical prefix rows may be adopted. A disabled or imported database never
uses this exception to make leftover rows authoritative.

Manifest version 2 also makes its key sequence authoritative. Public V3 `keys()` and
`key(index)` preserve the legacy `Object.keys()` contract across inline and optimized
modes; `sortedKeys()` provides the separate canonical UTF-16 order. Manifest version 3
adds exact logical-key mappings for fixed-size hashed physical names when a reversible
name would exceed the archive entry-name limit. Versions 1 and 2 remain valid migration
baselines; ordinary short keys retain their existing names and do not force a manifest
upgrade.

The shared key policy limits physical archive entry names to 1,024 UTF-8 bytes, not
logical plugin keys. Well-formed keys use the established UTF-8/base64url component;
ill-formed JavaScript strings use a tagged UTF-16 code-unit encoding so lone surrogates
round-trip. If either reversible form would exceed the physical limit, a fixed SHA-256
name is used and manifest version 3 carries the exact hash-to-raw-key mapping.

## Architecture at a glance

```text
V3 plugin iframe
    │ async RPC
    ▼
apiV3/v3.svelte.ts
    ├─ basic get/set/remove
    ├─ read/CAS/outcome/update/batch
    └─ immutable generation helpers
    ▼
pluginSaveStorage.ts
    ├─ mode barrier + per-key/key-set queues
    ├─ inline publication mutex
    ├─ owner/revision/generation tracking
    └─ bulk/staged transition and boot recovery
    ▼
persistentKv.ts / NodeStorage
    ├─ dedicated manifest/mutate/batch/clear APIs
    ├─ generation-pinned reads and viewer pages
    └─ capacity, transition, and outcome protocols
    ▼
Express + SQLite
    ├─ exact manifest-owned rows
    ├─ atomic value + owner + manifest publication
    ├─ atomic mode + generation transitions
    ├─ quota and usage indexes
    └─ recovery-dirty snapshot token
```

## Key files

### Browser API and coordination

- `src/ts/plugins/pluginSaveStorage.ts` is the main mode-aware implementation. It owns
  reads, mutations, manifests, revisions, transition admission, staged publication,
  boot reconciliation, and integration with database saves.
- `src/ts/plugins/apiV3/v3.svelte.ts` exposes the public async `pluginStorage` API and
  connects calls to the host implementation.
- `src/ts/plugins/apiV3/risuai.d.ts` is the public type contract.
- `src/ts/plugins/apiV3/pluginStorageUpdate.ts` coordinates guarded single-key updates.
- `src/ts/plugins/apiV3/pluginStorageGeneration.ts` implements immutable generation
  publish/load/garbage-collection helpers.
- `src/ts/plugins/apiV3/pluginDatabaseBridge.ts` makes V3 database access mode-aware;
  plugin storage publication roots do not behave like ordinary mergeable DB fields.
- `src/ts/plugins/pluginStorageMutationOutcome.ts` implements committed,
  not-committed, and unknown result handling plus confirmed removal.
- `src/ts/plugins/pluginStorageRecord.ts` and `pluginStorageMeta.ts` manage owner,
  revision, and generation sidecars.
- `src/ts/plugins/pluginStorageRecovery.ts` publishes boot/transition recovery state to
  the UI.
- `src/ts/plugins/pluginStorageViewerPage.ts` owns point-in-time viewer page models.

### Client transport and validation

- `src/ts/storage/nodeStorage.ts` owns the dedicated HTTP protocols: state, manifest,
  pinned pages, mutate, batch, clear, capacity, and staged transition operations.
- `src/ts/storage/persistentKv.ts` provides mode-aware storage helpers and structured
  mutation semantics over `AutoStorage`.
- `src/ts/storage/pluginStorageMutation.ts` and `pluginStorageBatch.ts` encode atomic
  mutation and batch requests.
- `src/ts/storage/pluginStorageTransitionBulk.ts` encodes the negotiated framed mode
  transition, including structured-clone MessagePack rows for externalization.
- `src/ts/storage/jsonValue.ts` snapshots, validates, and converts JSON values without
  losing special own keys such as `__proto__`; persistent writes fuse descriptor-only
  validation with direct UTF-8 serialization instead of building a second JSON graph.
- `src/ts/storage/pluginSaveKeyPolicy.ts`, `base64Url.ts`, and
  `unicodeWellFormed.ts` implement canonical reversible keys plus the versioned,
  fixed-size hash mapping used only for over-limit physical names.
- `src/ts/storage/pluginStorageLimits.ts` parses the authenticated server value
  capability and retains the 128 MiB fallback for older servers.
- `src/ts/storage/storageError.ts` preserves retryability, dispatch state, and unknown
  commit outcomes across the client boundary.
- `src/ts/storage/databaseSave.ts` pauses or fences ordinary database saves around an
  atomic storage publication.

### Server, UI, and shared policy

- `server/node/pluginSaveKeys.cjs` owns server key parsing and namespace constants.
- `server/node/pluginStorageJson.cjs` validates raw keys, canonical encoded names, and
  strict JSON rows, and performs server-owned compatible-value transition conversion.
- `server/node/pluginStorageViewerFacets.cjs` owns rebuildable display-size/owner facet
  validity, streaming display-size semantics, and pinned-snapshot facet queries.
- `server/node/pluginStorageLimits.cjs` owns authoritative per-value and aggregate
  limits. Defaults are 128 MiB per value and 1 GiB total optimized storage.
- `server/node/db.cjs` owns atomic quota/owner accounting and the derived
  `plugin_storage_usage` and `plugin_storage_owners` tables.
- `server/node/server.cjs` owns manifest, mutation, viewer, transition, capacity, and
  recovery routes; generic KV routes guard the reserved namespace.
- `shared/plugin-save-key-policy.json` is the shared archive/key-name contract.
- `src/lib/Setting/Pages/PluginSettings.svelte` owns compatibility, conversion,
  optimization transition, and recovery controls.
- `src/lib/Setting/Pages/PluginStorageViewer.svelte` owns paged inspection and
  revision-aware maintenance.

## API semantics

### Reads and guarded writes

- `getItem()` is the compatibility API. It conflates a missing key with stored JSON
  `null`; use a versioned API when that distinction matters.
- `readItem()` returns explicit `missing`, `value`, or `failed` outcomes.
- `getWithRevision()` returns a value/absence proof plus its opaque revision.
- `setFromRead()` publishes only against the state proven by `readItem()`.
- `updateItem()` runs a guarded single-key transform behind the update barrier and
  performs a final pre-publication check.
- `atomicBatch()` and `rewriteItem()` publish related keys with revision checks.
- `setItemWithOutcome()`, `removeItemWithOutcome()`, and `removeItemConfirmed()` make
  acknowledgement ambiguity visible. Confirmed removal sends one mutation and then
  performs a fresh versioned read unless the refusal was definitively not committed.

An outcome of `unknown` means the request may already have committed. Never replay it
blindly. Re-read authoritative state, or reload when a generation/transition outcome
cannot be proven.

Current optimized versioned reads use `/api/plugin-storage/state/raw`. A present row is
the exact stored byte sequence; headers carry `json-v1` plus its content type, byte
length, SHA-256 content digest, opaque row revision/generation, and selected publication
generation/manifest revision. A proven absence is `204` with the publication identity
and no row metadata. The browser verifies the header-bound length/digest and parses the
stored JSON bytes directly. A valid same-generation publication identity also refreshes
the browser's manifest-revision token and invalidates a differently stamped ownership
snapshot without eagerly refetching it. A generation-pinned raw read requires a paired,
well-formed publication identity for that generation; missing, malformed, or mismatched
headers are a malformed storage response rather than a proven absence. The retained
`/api/plugin-storage/state` JSON/base64 response carries the same publication headers and
remains available to an old client during build-upgrade recovery, but current clients do
not probe or negotiate between the two routes.

Optimized compound writes negotiate their transport through `/api/session`. Current
clients use `framed-v1` for 1 through the negotiated maximum of at most 128 operations:
bounded canonical metadata names the CAS and binds each set value by length and SHA-256,
followed by the raw JSON bytes. The server streams values to private spool files,
validates them before queue admission, and publishes large rows through the file-backed
chunk writer inside the existing atomic transaction. This lets a one-value guarded write
reach the same configured per-value limit as ordinary `setItem()` without base64
expansion. Older servers use the retained 16 MiB JSON/base64 batch fallback.

Committed optimized `mutate` and `batch` acknowledgements may echo `manifestRevision`,
the SHA-256 token of the exact committed manifest bytes. The browser retains a validated
echo only for the current database object and `pluginStorageGeneration`; later compact
batch CAS writes can use it without a manifest-state preflight. A generation-conflict
response may likewise include `currentGeneration` and `currentManifestRevision` when the
server can prove a valid live optimized publication. A same-generation echo can drive the
next bounded retry directly. Missing echoes retain compatibility with older servers: the
browser drops its token and performs the existing state GET before the next attempt.

An optimized manifest snapshot is cached together with the `manifestRevision` from which
its exact value, owner, and key-mapping ownership was built. When a compact CAS commits
against that same stamped predecessor and echoes its successor revision, the browser
applies only the successfully committed operations it can derive exactly and restamps the
snapshot. Missing echoes, generation changes, unknown outcomes, legacy full-manifest
writes, and any ambiguous key-set effect retain the conservative full invalidation path.
`keys()` remains fresh-verified on every call: it compares the stamp with the lightweight
manifest-state response and reuses ownership only on equality, otherwise fetching a new
full manifest snapshot. Thus external imports or rewrites remain observable without an
unconditional snapshot scan.

The authenticated session advertises a generic per-value ceiling plus separate framed
batch and transition capabilities. Ordinary writes preflight the generic ceiling;
compound writes use the negotiated operation, metadata, value, and payload bounds;
transitions use their negotiated entry, metadata, row, and payload bounds. Servers
without the generic capability retain the historical 128 MiB client fallback, while
missing framed capabilities select the buffered-batch or staged-transition compatibility
paths. The server remains authoritative for every publication. A legacy optimized row
already over a newly configured limit may be repaired only by a strict size decrease;
new or growing over-limit values remain rejected.

### Immutable generations

`pluginStorage.generations` is a plugin-authored repository layer over ordinary storage
keys; its generation references are distinct from the optimized backend publication
selected by `Database.pluginStorageGeneration`. `publish()` hashes prepared body rows,
writes immutable bodies and a per-generation manifest, and advances a mutable head in
one `atomicBatch()`. Existing generation keys are never reused.

`load()` verifies the repository, head, manifest, body identifiers, hashes, and counts.
It falls back once to the verified previous generation only for detected corruption;
transport, authentication, and lineage failures remain hard errors. `garbageCollect()`
requires the retired generation to be in the verified lineage, refuses the current and
immediately previous generations, removes its bodies and manifest, and CAS-checks that
the head stayed unchanged.

## Concurrency and atomic publication

- A writer-preferring shared/exclusive barrier admits ordinary disjoint operations
  concurrently while preventing starvation of transitions.
- Per-key and key-set queues serialize overlapping mutations. Inline publication also
  uses a map-level mutex because the database stores one object graph.
- Plugin lifecycle work and storage-mode work share coordination so enable/disable,
  unload cleanup, and mode transitions cannot publish incompatible state concurrently.
- Ordinary server mutations enter the storage queue and publish values, owner records,
  the revised exact manifest, quota state, and recovery-dirty token in one SQLite
  transaction after checking the selected generation. They do not replace
  `Database.pluginStorageGeneration`; mode transitions publish a fresh backend
  generation together with the database mode and destination rows.
- Compact batches always keep the manifest CAS at the server commit boundary. A cached
  revision changes only how the client learns the expected token. Unknown commit outcomes,
  acknowledgement omissions, database replacement, and generation changes invalidate the
  client token; conflict retries remain bounded and fall back to the authoritative
  manifest-state read when no same-generation echo is available.
- Ownership-delta publication uses the same local key-set generation comparison as
  ownership reads. A concurrent mutation, a snapshot without a matching predecessor
  stamp, or a database/generation change prevents restamping and falls back to
  invalidation; a client-derived mapping is added only for a key in its committed write.
- Generic `/api/write` and `/api/remove` paths must not mutate manifest-owned rows, and
  JSON Patch must not change optimized rows or publication controls. To preserve the
  original inline save behavior, database patches may update `pluginCustomStorage` and
  `pluginStorageMeta` only after the server proves that `optimizePluginMemory` and
  `pluginStorageFolded` are not true and no manifest is present. A retained generation
  alone does not block inline patches. Those accepted patches retain the ordinary delayed
  database-patch durability window; this is publication-state authorization, not an owner
  check.

Owner records contain plugin identity, update time, opaque revision, and generation.
Their generation groups one logical mutation and is not the backend publication
selector. Revisions are concurrency tokens, not sortable timestamps. Owners are
inspection metadata rather than an authorization boundary; mutation routes authenticate
and require the active writer session but do not compare the caller to an owner record.

## Mode transitions

Production settings negotiate a bulk server protocol. On current servers,
externalization sends one framed request containing transition metadata and the complete
inline plugin snapshot as structured-clone MessagePack rows. Internalization sends no
row bodies; the server reads the selected optimized publication itself. The server owns
validation and, when `Database.autoConvertPluginStorageValues` is enabled, compatible
rich-value conversion while writing an unpublished private stage. The client does not
JSON-validate individual externalization values first. Servers that do not advertise
the bulk capability retain the earlier staged row protocol.

The legacy non-bulk `POST /api/plugin-storage/transition` protocol is retired. Its route
remains registered only to reject residual callers before body parsing with the structured
`426 CLIENT_UPGRADE_REQUIRED` response; it never performs a transition.

1. The client validates record shape and transport limits, then sends one framed bulk request.
2. The server validates keys and values, applies the independently configured compatible-
   value conversion, checks row counts, negotiated limits, source identity, and disk
   headroom, and writes a private stage under `save/.plugin-transition-staging/`.
3. Ordinary database saves pause while the request and final database object are prepared.
4. The server publishes the fresh generation, exact manifest, rows, mode, quota state, and
   recovery token atomically.
5. A lost acknowledgement is reconciled from the stage receipt and live publication.
   If the outcome remains unknowable, saves are fenced and the UI requires reload.

After database validation on Node startup, stage reconciliation resolves a stage only
when the live mode, generation, and manifest prove its publication. Healthy boots remove
unpublished stages; corrupt recovery boots preserve them rather than guessing.

Externalization therefore uses one migration request instead of one upload request per row.
Internalization is also one migration request; after commit the client performs one
authoritative `database.bin` refresh rather than reading every optimized row separately.
During externalization, each MessagePack row is copied into immutable Blob storage before
the next row is encoded. The final request Blob references those per-row Blobs, bounding
live encoder-array retention to one row while preserving the single-request atomic server
publication.

The framed transition transport admits up to 100,000 rows, 64 MiB of metadata, a payload
ceiling of the larger configured per-value or aggregate limit, and per-row staging up to
the larger of 32 MiB or the configured per-value limit. Final publication quotas remain
authoritative. During internalization, the server copies SQLite/chunk data and converts
staged JSON to MessagePack in bounded pages. Inline mode itself still retains the finished
plugin map in browser memory, so Settings asks for confirmation when the exact preflight
is larger than 64 MiB total or contains a row larger than 32 MiB.

`transitionPluginStorageMode()` is the production entry point. Optimized-mode startup
uses the ETag-fenced `/api/plugin-storage/reconcile-boot` endpoint: the server validates
manifest-owned rows one at a time, copies recoverable inline leftovers, and atomically
clears those inline copies only after validation succeeds. The response contains counts
and encoded-key-only diagnostics, never plugin values. The queued fence rederives both
the raw boot-row ETag and the canonical legacy-encoded database-view ETag from the same
selected bytes, accepts only the representation supplied by the preceding boot read, and
preserves that accepted token for later ordinary saves. Older servers and inline mode use
the retained client `reconcilePluginStorageModeForBoot()` compatibility path.
`reconcilePluginStorageMode()` is dependency-injected test support and rejects ordinary
production use.

## Boot recovery and inspection

Boot reconciliation isolates corrupt or unavailable rows, records encoded-key-only
diagnostics, and prefers a recoverable copy/quarantine over destructive guessing. A
suspect source is not allowed to become an empty authoritative publication. In optimized
mode, external row bodies stay on the server during this scan; the browser receives only
the committed result envelope and rereads `database.bin` if inline recovery copies were
removed. Inline mode still materializes the complete map in browser memory by design.

The viewer exposes three backends. In optimized mode, the Save File tab obtains a
generation-pinned deterministic server page; in inline mode, it synchronously detaches
only the selected in-memory page before yielding. In both cases key/owner filters, owner
facets, and value reads come from one point-in-time publication, and edits/deletes are
revision-bound so a concurrent change surfaces as a conflict. Local Storage
(`safe_plugin_*` strings) and IndexedDB (`SafeLocalPluginStorage` JSON) are device-local
and have no server publication token. All three retain at most 50 value bodies per page;
value search intentionally scans only the resident page.

Optimized display sizes live in `plugin_storage_viewer_value_facets`; normalized owners
remain in `plugin_storage_owners`. Both are operational, rebuildable metadata rather than
publication authority. Low-level plugin KV writes maintain them in the enclosing SQLite
transaction. A trigger-backed source/index revision detects missing, stale, direct-SQL,
or unverifiable derivative state. The viewer still intersects physical rows with the
exact selected manifest, and any facet mismatch falls back to one authoritative value
and owner scan whose compare-published rebuild cannot replace a newer publication.

Cold authoritative facet scans are single-flight per pinned publication proof and retain
the requested page values for page assembly instead of parsing them twice. At most two
viewer snapshot leases are active; excess requests wait abortably. A snapshot is closed
after the page response has been assembled and before NDJSON backpressure or a slow
client can retain its WAL view.

## Backup and restore boundary

- Normal Node full exports include the exact manifest-owned optimized publication.
- Upstream-target exports and partial/automatic snapshots fold that publication into a
  self-contained database representation as required by the target format.
- Backup import validates value and owner rows as JSON but copies an explicit manifest
  entry opaquely. Later generation/manifest authority checks reject or quarantine an
  inconsistent imported publication; folded streaming imports build a fresh exact
  manifest from the rows they ingest.
- `pluginStorageFolded` is a recovery marker. Exact-set restore also depends on the
  selected generation/manifest proof; unmarked historical snapshots must not clear
  unrelated external rows.
- Plugin-only mutations write a durable recovery-dirty token and schedule an automatic
  recovery snapshot. Snapshot publication compare-clears only the token it captured.
- Private transition stages, quarantine rows, and undeclared physical prefix rows are not
  live plugin data and must not leak into exports.

See [Backup and recovery](backup-recovery.md) for export/import/snapshot behavior.

## Change map

- Public V3 method or type: update `apiV3/v3.svelte.ts`, `apiV3/risuai.d.ts`, the host
  implementation, bridge serialization, and API tests together.
- Key encoding or allowed names: update `shared/plugin-save-key-policy.json`, client and
  server codecs/validators, backup framing, and compatibility tests together.
- Value or aggregate limits: update server authority, client preflight mirror, UI copy,
  staging/import bounds, and capacity tests.
- Single/batch mutation semantics: start in `pluginSaveStorage.ts`,
  `pluginStorageMutation.ts`, `pluginStorageBatch.ts`, server route transaction code, and
  the atomicity suites under `test/compat/`.
- Compatible-value conversion: update `Database.autoConvertPluginStorageValues`,
  `prepareOptimizedPluginStorageValue()`, `jsonValue.ts`, the server
  `convertCompatiblePluginStorageJson()`, Settings copy, and conversion tests together;
  keep it independent of mode selection.
- Mode switching: start at `transitionPluginStorageMode()`,
  `applyBulkPluginStorageTransition()`, `pluginStorageTransitionBulk.ts`, the bulk/staged
  server routes, `databaseSave.ts`, `PluginSettings.svelte`, and transition tests.
- Viewer behavior: update the pinned server page protocol, `pluginStorageViewerPage.ts`,
  `PluginStorageViewer.svelte`, and viewer integration tests.
- Backup/restore participation: coordinate this subsystem with
  [Backup and recovery](backup-recovery.md) and `snapshotPluginStorage.e2e.test.ts`.

## Verification

Representative suites include:

- `src/ts/plugins/pluginSaveStorage.test.ts`
- `src/ts/plugins/apiV3/pluginStorageGeneration.test.ts`
- `src/ts/plugins/apiV3/pluginStorageUpdate.test.ts`
- `src/ts/storage/pluginStorageBatch.test.ts`
- `server/node/pluginSaveKeys.test.ts`
- `server/node/pluginStorageJson.test.ts`
- `test/compat/plugin-storage-mutation-atomicity.test.ts`
- `test/compat/plugin-storage-batch-atomicity.test.ts`
- `test/compat/plugin-storage-bulk-transition.test.ts`
- `test/compat/plugin-storage-boot-reconcile.test.ts`
- `test/compat/plugin-storage-staged-transition-boundaries.test.ts`
- `test/compat/plugin-storage-viewer-page.test.ts`
- `server/node/snapshotPluginStorage.e2e.test.ts`

Run the client, server, and compat suites; no one command aggregates them.

## Related developer documentation

- [Plugin development guide](../../plugins.md)
- [V2-to-V3 migration guide](../../src/ts/plugins/migrationGuide.md)
- [Safe compound plugin-storage updates](../../docs-human/en/plugin-storage.md)
- [Mutation outcome handling](../plugin-storage-mutation-outcomes.md)
- [Scripting and extensions](scripting-extensions.md)
- [Client storage](client-storage.md)
- [Server backend](server-backend.md)
