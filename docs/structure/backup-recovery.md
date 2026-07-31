# Backup and recovery

> Part of the [PocketRisu structure guide](../../STRUCTURE.md). Audited on
> 2026-07-27 against `abee0232`. Prefer symbols and route names over line numbers.

## Purpose and recovery taxonomy

This document owns the boundaries that create, export, replace, or recover a coherent
PocketRisu state. It covers archive framing, point-in-time sources, partial export jobs,
bounded imports, save-folder replacement, automatic snapshots, corrupt-boot recovery,
cancellation, and commit-outcome handling.

These mechanisms are intentionally different:

| Mechanism | Scope and policy |
|---|---|
| Downloaded full backup | Node self-contained archive; requires valid live DB and every referenced chat |
| Upstream-target export | Migration archive; folds/filters PocketRisu state and intentionally omits inlays |
| Server-file backup | Same strict full-state cut, published atomically into the configured backup directory |
| Partial export job | Selected characters/personas/modules and referenced identity assets; recovery-oriented missing-chat policy |
| Automatic snapshot | DB recovery point stored under `database/dbbackup-*`; preserves a bare missing-chat stub with warning |
| Save-folder import | Destructive replacement from a staged directory or ZIP |
| Per-chat history | Best-effort overwrite pre-images plus required structural-deletion pre-images for one chat row; not part of `.bin` backup archives |
| Migration safety copy | One-purpose pre-migration material retained for downgrade/emergency recovery |

Do not describe any one of these as “the backup.” Their data coverage, failure policy,
destination, and restore semantics differ.

## Authoritative stores and archive format

The exported application graph spans:

- the stubs-only `database/database.bin` row;
- full `chats/*` rows;
- remembered MCP payload rows under `cache/mcp-tool-calls/` when referenced by exported chats;
- the selected optimized [plugin storage](plugin-storage.md) generation and manifest;
- `assets/*`, cold-storage, remote, draft, and metadata namespaces as applicable;
- safe ordinary assets under `save/assets/`;
- inlay payloads and sidecars under `save/inlays/`.

`server/node/backupEntryFormat.cjs` defines entry header framing and bounds.
`server/node/streamBackupRisuSave.cjs` rewrites seekable RisuSave sources without
materializing the full database object. `server/node/streamRisuSave.cjs` remains the
object-based encoder for already-materialized state. `streamJsonToMsgpack.cjs`,
`jsonValidateWorker.cjs`, `streamRisuLoad.cjs`, and `utils.cjs` own bounded compatibility
format validation and conversion.

Archive entry names are constrained by the shared plugin/key policy and bodies by the
framing format. The live stubs-only database is an internal representation; portability
is assembled at export boundaries by joining the external rows.

## Full and server-file exports

Full download and server-file export share a strict point-in-time protocol:

1. Wait for any destructive import to finish and enter the storage read queue.
2. Require a present, positive-size, structurally valid live `database/database.bin`.
   An internal snapshot is never silently substituted for a missing live DB.
3. Acquire one read-only SQLite WAL snapshot and select the matching plugin publication.
4. Copy each required filesystem entry into a private pin, checking open-file/path
   identity, size, device/inode, timestamps, and exact bytes or content hash.
5. Reserve required disk on each affected volume. Full filesystem pins are capped so
   concurrent exports cannot exhaust space.
6. Assemble and stream only from the pinned SQLite and filesystem sources.
7. Release readers, reservations, and private files in `finally`, including disconnect
   and sink-failure paths.

Missing referenced chat rows fail full and server-file exports with
`BACKUP_MISSING_CHAT_ROW`. This fail-closed policy is different from partial jobs and
automatic snapshots, which exist to retain a recovery point from already-damaged state.
Complete remembered-tool markers are also resolved against the pinned
`cache/mcp-tool-calls/` namespace. Node-only downloads, server-file archives, and
partial archives emit only referenced canonical rows and fail with
`BACKUP_MISSING_MCP_TOOL_CALL_ROW` when a marker's payload is absent. Upstream-target
exports omit this PocketRisu-only namespace.

Node-only downloads, server-file archives, and partial archives also select
composer rows under `drafts/` from the pinned SQLite view. Export selection is
limited to exact character/chat identities backed by the selected chat-row graph,
so drafts left behind by a deleted chat are not published. Upstream-target exports
omit this PocketRisu-only namespace.

Server archives publish through a private temporary file and a no-overwrite final link;
name collisions are probed rather than overwritten. Download responses remain
uncompressed at Express level so archive framing and keepalives are not buffered by
middleware.

### Upstream-target migration

`target=upstream` is not a lossless PocketRisu backup. It folds supported external state
and omits `inlay/`, `inlay_sidecar/`, and `inlay_meta/`; existing inlay references can
therefore become unresolved. Use the normal Node export for PocketRisu restore. Import
accepts supported unencrypted upstream `.bin` data, not encrypted risuai.xyz account
backups.

## Partial export jobs

Partial export is a server job, not a browser-memory serializer:

1. The client creates a job with a client-chosen ID and selected entities.
2. The server pins one SQLite view and verified copies of selected identity assets.
3. It joins selected chat rows, folds the exact plugin publication when required, omits
   account-wide state, and records missing assets rather than inventing bytes.
4. The client polls progress and downloads the private completed archive.
5. DELETE cancels preparation or releases the finished job. Cancellation tombstones make
   repeated cleanup safe; jobs also expire by TTL.

There is one active partial job per session. A missing referenced chat row is preserved
as a bare stub with a warning. Sink construction or write failure must cancel both the
response body and browser sink so the server can release the pin.

The current endpoints are the create/status/cancel collection under
`/api/backup/export/jobs` plus `/:jobId/download`. Calling the old partial scope through
the full-export endpoint returns `PARTIAL_EXPORT_JOB_REQUIRED`.

## Bounded import and save-folder replacement

Destructive replacement acquires an abortable FIFO import turn before draining older
queued mutations. Later authoritative writes receive retryable
`503 IMPORT_IN_PROGRESS`. Stable reads/pins wait behind the same barrier and re-check
inside the storage queue.

`server/node/importSpool.cjs` owns private disk ingress:

- the complete HTTP upload is spooled before it is reread;
- ZIP end-of-directory, central/local headers, encryption, duplicates, CRCs, and entry
  bounds are validated;
- archive entries and `database.risudat` receive private stages;
- JSON and compatibility formats are validated with bounded workers/converters;
- disconnects abort waiting/staging and clean private files.

Recognized block-oriented `RISUSAVE\0` databases do not use the legacy buffered
fallback. Import scans their bounded block inventory, resolves REMOTE rows through
private file spools, converts JSON blocks into a canonical MessagePack spool, and then
uses ordinary streaming database ingestion. The configured decoded-byte ceiling,
cancellation, validation, and replacement transaction remain authoritative throughout.

Downloaded-backup restores normally retain conservative 2 GiB and 100,000-entry soft
admission limits. After the normal destructive-restore confirmations, the browser opts
into the authenticated large-restore path; trusted server-file restores do so
automatically. Large restore still performs disk-headroom admission, but uses technical
safe-integer ceilings rather than the ordinary soft limits. Its entry names and inlay
ordering state live in a private SQLite index committed in bounded batches, so archive
cardinality does not create a heap-wide `Set` or `Map`. This is one logical restore:
batches never publish a partial live database.

Compatibility clients that drive the HTTP protocol directly opt in by sending
`allowLargeRestore: true` to `/api/backup/import/prepare` and
`x-risu-large-restore: 1` on the matching archive upload. Both routes remain
authenticated and active-session-only; the upload is independently revalidated and does
not trust client-supplied entry metrics.

Raw inlays and plain cold-storage JSON use file-backed streaming stages. Every logical
KV namespace can use protected chunk ingestion, including unsafe assets, remotes,
arbitrary extension-defined rows, and streaming-validated plugin metadata. Remaining
compatibility transformations that genuinely materialize a body—such as legacy wrapped
inlay records or already-gzipped cold-storage JSON—remain subject to the buffered-entry
limit unless the user has explicitly selected large restore.

Directory and ZIP save-folder imports copy regular, non-symlink files into a stage before
entering the replacement transaction. They reject missing live databases, duplicate
entries, excessive entry counts/expanded bytes, unsupported links, and invalid names.

Composer-draft archive and save-folder rows remain in private staging until database
ingestion has assigned missing chat IDs and normalized duplicate character IDs. The
transaction first clears the prior `drafts/` namespace, then restores only entries whose
exact `drafts/<chaId>/<chatId>` key occurs in the normalized imported graph. Legacy or
upstream archives without draft entries therefore replace stale drafts without allowing
cross-dataset ID reuse to attach unrelated text.

Publication coordinates:

- the exclusive import barrier;
- one SQLite transaction;
- authoritative chat/plugin/database ingestion;
- fsynced asset/inlay staging trees;
- `save/import_journal.json` plus the SQLite marker;
- list-epoch invalidation;
- rollback or startup recovery of filesystem swaps.

The journal phase is persisted before cleanup so startup can distinguish a committed
replacement from one that must restore its old directories.

Current clients negotiate a strict NDJSON activity stream for directory and ZIP
replacement. Upload progress, server heartbeats, and phase events refresh a two-minute
browser inactivity watchdog; there is no total wall-clock deadline. Legacy clients that
do not request the stream retain the JSON response contract.

## Automatic snapshots

Automatic snapshots assemble a self-contained database recovery row under
`database/dbbackup-*`. They are triggered by eligible committed mutations and rotated by
count and exclusive chunk cost.

- Snapshot assembly uses the configured DB spool (`POCKETRISU_SPOOL_DIR` or
  `save/.spool`) and streams the final file through chunk-aware storage.
- Snapshot failure is non-fatal to the primary save. The cooldown advances only after
  the snapshot row commits.
- Primary database and chat writes acknowledge their committed mutation before scheduling
  the coalesced snapshot, so full assembly is outside the response-critical path.
- Optimized plugin data is folded with `pluginStorageFolded` and the selected
  generation/manifest proof.
- Referenced remembered MCP calls are folded into a versioned private map. Restore
  replaces the dedicated cache prefix atomically and removes the private envelope before
  publishing the live database.
- A plugin-only atomic mutation writes `config/plugin-storage-recovery-dirty` in the same
  transaction and schedules a coalesced snapshot. Publication compare-clears only the
  token it captured, so a newer mutation remains pending.
- Missing referenced chats are preserved as bare stubs with warnings.

Snapshots do not contain the filesystem per-chat pre-image tree. Their displayed logical
size and retention's exclusive physical chunk cost are different measures.

## Corrupt-boot recovery and snapshot restore

The server preflights the live database before startup migrations or list-epoch writes.
If validation fails, it listens in authenticated recovery mode without rewriting the
corrupt database/plugin publication.

Browser bootstrap then:

1. receives raw live bytes from `/api/db/read-raw-for-boot` when the cache path cannot
   produce a decodable database;
2. requests metadata-only snapshot candidates;
3. submits candidates newest-first to the server's atomic restore route;
4. tries an older candidate only after a definitive not-committed result;
5. stops on committed or unknown outcome and reloads/reconciles the authoritative state;
6. reads back the new stubs-only live database after confirmed publication.

Snapshot bodies, folded plugin rows, and external chats never enter browser memory.
Restore first spools the selected logical snapshot through the chunk-aware reader.
Canonical formats are cursor-ingested at any supported size; compatibility-only formats
use a bounded legacy decoder.

The restore transaction replaces the live stub graph, external chat rows, migration
markers, and the provably owned plugin publication together. Cancellation while queued or
before commit removes/rolls back the operation. Snapshot restore uses the same strict
activity stream and inactivity watchdog as save-folder replacement.

Every streamed save-folder or snapshot replacement carries a client-generated UUID. Its
status is stored in SQLite's `replacement_operations` table, outside the logical KV data
being replaced. The server records `committed` and the exact result inside the same
transaction as publication; a response lost after commit is therefore reconciled through
`GET /api/replacement-operations/:operationId` without replaying the request. Pre-commit
failures become `not-committed`; `running` rows left by process exit are classified as
`not-committed` on restart because publication and the committed marker share a
transaction. An unavailable or contradictory status remains unknown and stops fallback.

Client ownership lives in:

- `src/ts/storage/bootSnapshotRecovery.ts`
- `src/ts/storage/snapshotRestoreUi.ts`
- `src/ts/storage/backupReplacementUi.ts`
- `src/ts/storage/storageError.ts`
- `src/ts/drive/backuplocal.ts`
- `src/ts/storage/nodeStorage.ts`

## Plugin recovery contract

`Database.pluginStorageGeneration`, `plugin-storage/manifest.json`, and the exact owned
value/metadata rows form one plugin publication. Export, snapshot, and restore must use
the matching set, not enumerate the raw prefixes.

`pluginStorageFolded` signals that a snapshot contains a self-contained folded
publication. Exact restore may clear/replace only a proven prior ownership set. Unmarked
historical snapshots retain external rows because destructive inference could erase the
only surviving copy. Foreign or quarantined physical rows are not current data and are
not silently adopted.

See [Plugin storage](plugin-storage.md) for mutation, CAS, generation, and transition
semantics.

## Cancellation and outcome rules

| Result | Client action |
|---|---|
| Confirmed committed | Hard reload after a replacement; attach new authoritative state after ordinary mutations |
| Committed but response handling failed | Warn and hard reload; do not repeat the replacement |
| Definitely not committed | Remain on current state; retry only when explicitly safe and requested |
| Commit outcome unknown | Never replay automatically; warn and reload/re-read to reconcile |

Backup import streams use a strict NDJSON terminal event. Missing or malformed terminal
events, truncation, status-zero completion, and transport loss after dispatch become
`COMMIT_OUTCOME_UNKNOWN`. Save-folder and snapshot replacement use strict NDJSON events,
one destructive dispatch, and durable status reconciliation before reporting an unknown
outcome. Authentication retry is not allowed once doing so could duplicate a committed
replacement.

## Limits, spools, and operator configuration

Important private roots:

- `save/.spool/` or `POCKETRISU_SPOOL_DIR`: database assembly, import-entry/database,
  plugin-value, and snapshot-restore spools;
- `save/.partial-export-spool/`: private full/partial filesystem pins;
- `save/.plugin-transition-staging/`: durable plugin mode-transition stages;
- asset/inlay import staging and rollback directories beside their final stores.

Important finite limits include:

| Variable | Default |
|---|---:|
| `RISU_BACKUP_IMPORT_MAX_BYTES` | 2 GiB; zero/invalid falls back to default |
| `RISU_LEGACY_DATABASE_IMPORT_MAX_BYTES` | 64 MiB; applies to remaining non-streamable compatibility formats, not recognized block RISUSAVE databases |
| `RISU_IMPORT_BUFFERED_ENTRY_MAX_BYTES` | 32 MiB |
| `RISU_BACKUP_IMPORT_MAX_ENTRIES` | 100,000 |
| `RISU_SAVE_FOLDER_IMPORT_MAX_ENTRIES` | 100,000 |
| `RISU_LARGE_RESTORE_MAX_BYTES` | Largest safe value compatible with 2× disk-headroom arithmetic |
| `RISU_LARGE_RESTORE_MAX_ENTRIES` | Largest safe integer |
| `RISU_RESTORE_MAX_DECODED_BYTES` | 4 GiB |
| `RISU_RESTORE_DISK_HEADROOM_BYTES` | 256 MiB |
| `RISU_RESTORE_MAX_LEGACY_BYTES` | 64 MiB |

Ordinary entry-count values are capped at one million. Large-restore ceilings are
separate recovery controls; disk-backed metadata keeps memory bounded, but raising or
overriding byte limits still increases disk, CPU, and recovery time.

Docker Compose persists `/app/save` only. Default chat history under
`/app/save/chat-backups` survives container replacement, but default server archives
under `/app/backups` do not unless that path is mounted or reconfigured under the save
volume.

## Change map

- Full/server point-in-time export: start at `pinFullBackupState()`,
  `streamBackupRisuSave.cjs`, filesystem pin/copy helpers, disk reservations, and full
  export regression suites.
- Partial jobs: update preparation/writer code, the `/api/backup/export/jobs` route
  family, `NodeStorage.exportBackup()`, and `backuplocal.ts` together.
- Archive framing: coordinate `backupEntryFormat.cjs`, shared key policy, import parser,
  and framing/round-trip tests.
- Ingress and ZIP/save-folder handling: start in `importSpool.cjs`,
  `importBackupFromSource()`, `streamRisuLoad.cjs`, and import-barrier/journal code.
- Boot recovery: coordinate server preflight/raw read/snapshot restore with
  `bootSnapshotRecovery.ts`, `NodeStorage`, and bootstrap ordering.
- Snapshot retention/chunk cost: update `createBackupAndRotate()`, `db.cjs`,
  `chunkStore.cjs`, snapshot routes, and settings bounds.
- Plugin folding/exact restore: coordinate with [Plugin storage](plugin-storage.md) and
  `snapshotPluginStorage.e2e.test.ts`.
- Destructive result UX: update `storageError.ts`, `backupReplacementUi.ts`,
  `snapshotRestoreUi.ts`, route acknowledgement schemas, and UI tests together.

## Verification

Representative guarantees live in:

- `test/compat/full-export-database-source.test.ts`
- `test/compat/full-export-boundaries.test.ts`
- `test/compat/full-export-import-race.test.ts`
- `test/compat/full-export-corruption.test.ts`
- `test/compat/import-ingress-memory.test.ts`
- `test/compat/export-concurrent-mutation.test.ts`
- `server/node/snapshotPluginStorage.e2e.test.ts`
- `src/ts/storage/nodeStorage.bootRecovery.test.ts`
- `src/ts/storage/nodeStorageAvailability.test.ts`
- `src/ts/storage/backupReplacementUi.test.ts`
- `src/ts/storage/snapshotRestoreUi.test.ts`
- `src/ts/drive/backuplocal.test.ts`

Run client, server, and compat suites because no single command aggregates them.

## Related structure docs

- [Server backend](server-backend.md) owns SQLite, chunks, routes, import queues, and
  filesystem primitives.
- [Client storage](client-storage.md) owns bootstrap, NodeStorage, save coordination, and
  browser cache behavior.
- [Plugin storage](plugin-storage.md) owns versioned plugin mutation and transition
  semantics.
- [Characters and personas](characters-personas.md) owns card/package-specific exports.
