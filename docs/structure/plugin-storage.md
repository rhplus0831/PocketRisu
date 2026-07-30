# Plugin storage

> Part of the [PocketRisu structure guide](../../STRUCTURE.md). Audited on
> 2026-07-27 against `abee0232`. Prefer the symbols below over volatile line numbers.

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
versioned/compound replacement values require detached, strict JSON. Optional automatic
conversion can normalize legacy values before a mode change; conversion is a visible
compatibility operation, not merely an implementation detail.

Optimized authority is not “every row under the prefix.” The manifest names the exact
value and metadata rows in the selected generation. Undeclared physical rows are
quarantined data and must not appear in live reads, exports, the viewer, or an exact
restore.

Manifest version 2 also makes its key sequence authoritative. Public V3 `keys()` and
`key(index)` preserve the legacy `Object.keys()` contract across inline and optimized
modes; `sortedKeys()` provides the separate canonical UTF-16 order. Version-1 manifests
are accepted as migration baselines and upgrade on the next optimized publication.

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
    └─ staged transition and boot recovery
    ▼
persistentKv.ts / NodeStorage
    ├─ dedicated manifest/mutate/batch/clear APIs
    ├─ generation-pinned reads and viewer pages
    └─ capacity, transition, and outcome protocols
    ▼
Express + SQLite
    ├─ exact manifest-owned rows
    ├─ atomic value + owner + generation publication
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
- `src/ts/storage/jsonValue.ts` snapshots, validates, and converts JSON values without
  losing special own keys such as `__proto__`.
- `src/ts/storage/pluginSaveKeyPolicy.ts`, `base64Url.ts`, and
  `unicodeWellFormed.ts` implement canonical reversible keys.
- `src/ts/storage/pluginStorageLimits.ts` parses the authenticated server value
  capability and retains the 128 MiB fallback for older servers.
- `src/ts/storage/storageError.ts` preserves retryability, dispatch state, and unknown
  commit outcomes across the client boundary.
- `src/ts/storage/databaseSave.ts` pauses or fences ordinary database saves around an
  atomic storage publication.

### Server, UI, and shared policy

- `server/node/pluginSaveKeys.cjs` owns server key parsing and namespace constants.
- `server/node/pluginStorageJson.cjs` validates raw keys, canonical encoded names, and
  strict JSON rows.
- `server/node/pluginStorageLimits.cjs` owns authoritative per-value and aggregate
  limits. Defaults are 128 MiB per value and 1 GiB total optimized storage.
- `server/node/db.cjs` owns atomic quota/owner accounting and the derived
  `plugin_storage_usage` and `plugin_storage_owners` tables.
- `server/node/server.cjs` owns manifest, mutation, viewer, transition, capacity, and
  recovery routes; generic KV routes guard the reserved namespace.
- `shared/plugin-save-key-policy.json` is the shared archive/key-name contract.
- `src/lib/Setting/Pages/PluginSettings.svelte` owns compatibility, conversion,
  optimization transition, recovery, and per-plugin permission controls.
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

Optimized compound writes negotiate their transport through `/api/session`. Current
clients use `framed-v1`: bounded canonical metadata names the CAS and binds each set
value by length and SHA-256, followed by the raw JSON bytes. The server streams values
to private spool files, validates them before queue admission, and publishes large rows
through the file-backed chunk writer inside the existing atomic transaction. This lets
a one-value guarded write reach the same configured per-value limit as ordinary
`setItem()` without base64 expansion. Older servers use the retained 16 MiB JSON/base64
batch fallback.

The same authenticated session advertises the generic configured per-value ceiling.
Client transport preflights use that value before dispatching ordinary, compound, or
transition row bodies. Servers without the capability retain the historical 128 MiB
client fallback, while the server remains authoritative for every publication.

### Immutable generations

Generation helpers publish a prepared immutable key set and one manifest pointer. They
are the preferred model for multi-row indexes, shards, or caches whose readers must not
observe a partial prefix. Garbage collection may remove generations only after they are
no longer selected or pinned.

## Concurrency and atomic publication

- A writer-preferring shared/exclusive barrier admits ordinary disjoint operations
  concurrently while preventing starvation of transitions.
- Per-key and key-set queues serialize overlapping mutations. Inline publication also
  uses a map-level mutex because the database stores one object graph.
- Plugin lifecycle work and storage-mode work share coordination so enable/disable,
  unload cleanup, and mode transitions cannot publish incompatible state concurrently.
- Server mutations enter the storage queue and publish values, owner records, the exact
  manifest, the selected generation, quota state, and recovery-dirty token in one SQLite
  transaction.
- Generic `/api/write`, `/api/remove`, and JSON Patch paths must not mutate manifest-owned
  rows or the database publication roots.

Owner records contain plugin identity, update time, opaque revision, and generation.
Revisions are concurrency tokens, not sortable timestamps.

## Mode transitions

Production settings use a staged server protocol, not the older direct row-first loop:

1. Preflight validates every key/value, row counts, configured limits, and disk headroom.
2. The server creates a private stage under `save/.plugin-transition-staging/`.
3. The client/server stream rows into or out of the stage without publishing them live.
4. Ordinary database saves pause while the final database object is prepared.
5. Finalize publishes the fresh generation, exact manifest, rows, mode, quota state, and
   recovery token atomically.
6. A lost acknowledgement is reconciled from the stage receipt and live publication.
   If the outcome remains unknowable, saves are fenced and the UI requires reload.

Reverse transitions accept rows up to the configured optimized-value ceiling and do not
impose a smaller aggregate transport cap. The server copies SQLite/chunk data and converts
staged JSON to MessagePack in bounded pages. Inline mode itself still retains the finished
plugin map in browser memory, so Settings asks for confirmation when the exact preflight is
larger than 64 MiB total or contains a row larger than 32 MiB.

`transitionPluginStorageMode()` is the production entry point.
`reconcilePluginStorageModeForBoot()` is the bounded boot-recovery path.
`reconcilePluginStorageMode()` is dependency-injected test support and rejects ordinary
production use.

## Boot recovery and inspection

Boot reconciliation isolates corrupt or unavailable rows, records encoded-key-only
diagnostics, and prefers a recoverable copy/quarantine over destructive guessing. A
suspect source is not allowed to become an empty authoritative publication.

The viewer obtains a generation-pinned, deterministic server snapshot. Paging, filters,
owner facets, and value reads belong to the same publication. Edits and deletes are
revision-bound; a concurrent change surfaces as a conflict instead of being overwritten.

## Backup and restore boundary

- Normal Node full exports include the exact manifest-owned optimized publication.
- Upstream-target exports and partial/automatic snapshots fold that publication into a
  self-contained database representation as required by the target format.
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
- Mode switching: start at `transitionPluginStorageMode()`, the staged server routes,
  `databaseSave.ts`, `PluginSettings.svelte`, and transition-boundary tests.
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
- `test/compat/plugin-storage-mutation-atomicity.test.ts`
- `test/compat/plugin-storage-batch-atomicity.test.ts`
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
