# Backup and recovery

> Part of the [PocketRisu structure guide](../../STRUCTURE.md). Audited on
> 2026-08-04 against `95c2ea30`. Prefer symbols and route names over line numbers.

## Purpose and recovery taxonomy

This document owns the boundaries that create, export, replace, or recover a coherent
PocketRisu state. It covers archive framing, point-in-time sources, partial export jobs,
bounded imports, save-folder replacement, automatic snapshots, corrupt-boot recovery,
per-chat pre-image history, cancellation, writer displacement, and commit-outcome
handling.

These mechanisms are intentionally different:

| Mechanism | Scope and policy |
|---|---|
| Downloaded full backup | Node self-contained archive; requires valid live DB and every referenced chat |
| Main-target downgrade export | Non-destructive migration archive for the PocketRisu `main` rollback target; folds chats and plugin storage while retaining main-readable assets and inlays |
| Upstream-target export | Migration archive; folds/filters PocketRisu state and intentionally omits inlays |
| Server-file backup | Same strict full-state cut, published atomically into the configured backup directory |
| Partial export job | Account-stripped logical database with chats/plugins folded, but only selected identity images; recovery-oriented missing-chat policy |
| Automatic snapshot | DB recovery point stored under `database/dbbackup-*`; preserves a bare missing-chat stub with warning |
| Save-folder import | Destructive replacement from a staged directory or ZIP |
| Per-chat history | Best-effort overwrite pre-images plus required structural-deletion pre-images for removed chat rows; not part of `.bin` backup archives |
| Migration safety copy | One-purpose pre-migration material retained for downgrade/emergency recovery |

Do not describe any one of these as “the backup.” Their data coverage, failure policy,
destination, and restore semantics differ.

There is no restorable settings-only archive surface. **Advanced → Export Settings for
Bug Report** creates a filtered diagnostic JSON report, not a RisuSave backup, and the
server export contract has no settings-only scope. A legacy `?mode=settings` query is not
recognized and follows the ordinary full Node export path.

## Archive formats, exports, and imports

This half covers portable archive assembly, migration exports, bounded ingress, and the
exclusive transaction that replaces the live dataset.

### Authoritative stores and archive format

The exported application graph spans:

- the stubs-only `database/database.bin` row;
- full `chats/*` rows;
- remembered MCP payload rows under `cache/mcp-tool-calls/` when referenced by exported chats;
- the selected optimized [plugin storage](plugin-storage.md) generation and manifest;
- `assets/*`, cold-storage, draft, and metadata namespaces as applicable;
- `remotes/*` source rows referenced by block-format databases, folded into the portable
  `database.risudat` rather than emitted as independent archive entries;
- safe ordinary assets under `save/assets/`;
- inlay payloads and sidecars under `save/inlays/`.

`server/node/backupEntryFormat.cjs` defines entry header framing and bounds.
`server/node/streamBackupRisuSave.cjs` rewrites seekable RisuSave sources without
materializing the full database object. `streamRisuSaveToFile()` in
`server/node/streamRisuSave.cjs` accepts an already-decoded top-level database but writes
chat bodies, plugin values, remembered MCP values, and escape envelopes to a private file
one row/page at a time. `streamJsonToMsgpack.cjs`, `jsonValidateWorker.cjs`,
`streamRisuLoad.cjs`, and `utils.cjs` own bounded compatibility validation and conversion.

Archive entry names are constrained by the shared plugin/key policy and bodies by the
framing format. The live stubs-only database is an internal representation; portability
is assembled at export boundaries by joining the external rows. The finished database is
a disk spool, not one aggregate JavaScript object or response buffer.

### Full and server-file exports

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

#### Upstream-target migration

`target=upstream` is not a lossless PocketRisu backup. It folds supported external state
and omits `inlay/`, `inlay_sidecar/`, and `inlay_meta/`; existing inlay references can
therefore become unresolved. Use the normal Node export for PocketRisu restore. Import
accepts supported unencrypted upstream `.bin` data, not encrypted risuai.xyz account
backups.

Upstream decodes only the legacy version-7/8/9 and `RISUSAVE` block headers. A plugin
key such as `__proto__` or ill-formed Unicode that requires PocketRisu's newer
escape-aware save header makes the export fail with a definitive 409 before archive
headers are published, exactly like the main target below; it is never mislabeled as
upstream-compatible.

#### PocketRisu main-target downgrade

`target=main` is the supported non-destructive path for rolling a `serve` installation
back to the audited PocketRisu `main` storage contract. It uses the same pinned full-state
cut as an ordinary full export, requires every referenced chat row, folds chat bodies and
the selected optimized plugin publication into `database.risudat`, and emits the legacy
version-7 database header accepted by `main`. Ordinary assets, cold storage, inlay
payloads, inlay sidecars, and inlay metadata remain archive entries because `main`
understands those names.

The target omits `drafts/` and `cache/mcp-tool-calls/`: the rollback import contract has
no archive-entry readers for composer drafts or remembered MCP payloads. It also omits
external plugin rows and their manifest after folding them inline. A plugin key such as
`__proto__` or ill-formed Unicode that requires PocketRisu's newer escape-aware save
header makes the export fail before archive headers are published; it is never mislabeled
as main-compatible.

The UI exposes this operation under **Data Migration → Export for PocketRisu Main
Rollback** and warns about the two omitted namespaces. Restore the result into a fresh
`main` data directory and retain both the original `serve` directory and a normal full
PocketRisu backup until verification completes. Directly booting `main` against the
row-backed `serve` directory remains unsupported.

### Partial export jobs

Partial export is a server job, not a browser-memory serializer:

1. The client creates a job with a client-chosen ID; there is no per-entity selector in
   the current protocol.
2. The server pins one SQLite view and verified copies of the selected identity images.
3. It removes `account`, joins all referenced chat rows, folds the exact plugin
   publication, selects referenced drafts and remembered MCP rows, and records missing
   identity images rather than inventing bytes.
4. The client polls progress and downloads the private completed archive.
5. DELETE cancels preparation or releases the finished job. Cancellation tombstones make
   repeated cleanup safe; jobs also expire by TTL.

The ordinary asset subset is limited to `.png` character/group portraits, the user icon,
persona icons, custom background, folder images, and prompt-preset images referenced by
the database. Inlays, cold-storage payloads, emotion/additional images, module assets,
and other ordinary assets are not included. Partial export is therefore a smaller
recovery/migration artifact, not a strict full backup even though its logical database
still contains every character and chat.

There is one active partial job per session. A missing referenced chat row is preserved
as a bare stub with a warning; a missing selected image is counted and skipped. Sink
construction or write failure must cancel both the response body and browser sink so the
server can release the pin.

The current endpoints are the create/status/cancel collection under
`/api/backup/export/jobs` plus `/:jobId/download`. Calling the old partial scope through
the full-export endpoint returns `PARTIAL_EXPORT_JOB_REQUIRED`.

Character-package and dataset export streams are separate interchange surfaces; see
[Characters and personas](characters-personas.md) and [Client storage](client-storage.md).

### Bounded import and save-folder replacement

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
Replacement clears the old `remotes/` and `coldstorage/` namespaces before publishing the
imported dataset, so save-folder imports cannot retain orphaned rows from the prior user.
Archive import accepts both `coldstorage/<uuid>[.json]` and the upstream
`coldstorage_<uuid>.json` spelling and normalizes them to the runtime key.

Both archive import and save-folder replacement flush pending database work and invoke
the cooldown-aware `createBackupAndRotate()` before clearing live state. Snapshot failure
or an active cooldown remains non-fatal, so this pre-replacement recovery point is a
best-effort safety layer rather than the replacement transaction's commit proof.

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
- a paired, fsynced `save/import_journal.json` and transaction-side
  `import_journal/marker`, written before filesystem renames; after SQLite commit the
  journal's `committed` phase is persisted before cleanup, and startup uses the pair to
  finalize the committed swap or restore the old directories;
- list-epoch invalidation;
- rollback or startup recovery of filesystem swaps.

Current clients negotiate a strict NDJSON activity stream for directory and ZIP
replacement. Upload progress, server heartbeats, and phase events refresh a two-minute
browser inactivity watchdog; there is no total wall-clock deadline. Legacy clients that
do not request the stream retain the JSON response contract.

## Recovery services

This half covers server-maintained recovery points, corrupt-boot replacement, chat-row
pre-images, and the plugin-specific safeguards used when live state is damaged.

### Automatic snapshots

Automatic snapshots assemble a self-contained database recovery row under
`database/dbbackup-*`. They are triggered by eligible committed mutations and rotated by
count and exclusive chunk cost.

- Snapshot assembly uses the installation-owned child of the configured shared DB-spool
  root (`POCKETRISU_SPOOL_DIR` or `save/.spool`) and streams the final file through
  chunk-aware storage. Peer owner namespaces are never swept by this installation.
- The short queued capture phase flushes any pending debounced database persist, opens
  one read-only WAL snapshot, and records a global source token. The token combines the
  database row/chunk revisions and verified logical size, every chat row mutation token
  and chunk-inventory revision, the plugin publication and viewer-facet revisions,
  aggregate plugin quota bytes, and the exact recovery-dirty token. The plugin
  publication clock covers both the selected database generation and exact manifest.
- Assembly then leaves the mutation queue and reads database, chat, selected plugin, and
  remembered MCP rows only through that pinned snapshot. Chat rows with operation logs
  materialize from the pinned base, pinned ordered entries, and pinned logical metadata;
  a snapshot never publishes a base-only or torn view. Large log-free rows are copied and
  other rows are transcoded in bounded pages/work. Publication re-enters the queue,
  recaptures the complete token, and commits/rotates only on equality; every log append
  and compaction advances the same chat `row_token`, so a racing checkpoint discards the
  private spool and retries or reschedules.
- Snapshot failure is non-fatal to the primary save. The cooldown advances only after
  the snapshot row commits.
- Primary database and chat writes acknowledge their committed mutation before scheduling
  the coalesced snapshot, so full assembly is outside the response-critical path.
- Explicit/read-triggered pending-state flushes schedule this same pinned protocol; they
  do not assemble a second snapshot directly from live rows.
- A foreground `/api/db/flush` drains pending database work and then requests a `FULL`
  WAL checkpoint. Because an assembling snapshot can hold an older pinned reader, each
  synchronous checkpoint attempt temporarily disables SQLite's five-second busy wait and
  the server retries asynchronously every 25 ms for at most three seconds. If it is still
  busy, the route preserves its retryable `503` response with `durable: false` and an
  `unknown` outcome; background durability checkpoints instead reschedule a busy attempt
  after ten seconds.
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

### Corrupt-boot recovery and snapshot restore

The server preflights the live database before startup migrations or list-epoch writes.
If validation fails, it listens in authenticated recovery mode without rewriting the
corrupt database/plugin publication.

Browser bootstrap then:

1. uses the segmented cached database read when it can prove the result, otherwise reads
   decode-free live bytes from `/api/db/read-raw-for-boot` (also the normal cache-disabled
   path);
2. requests metadata-only snapshot candidates;
3. submits candidates newest-first to the server's atomic restore route;
4. tries an older candidate only after a definitive not-committed result;
5. stops on committed or unknown outcome and reloads/reconciles the authoritative state;
6. reads back the new stubs-only live database after confirmed publication.

Snapshot bodies, folded plugin rows, and external chats never enter browser memory.
Restore first spools the selected logical snapshot through the chunk-aware reader.
Canonical formats are cursor-ingested at any supported size; compatibility-only formats
use a bounded legacy decoder.

Plugin-storage quarantine warnings therefore lead users to the restore-point UI first.
When no suitable point exists, the secondary affected-data manager can download an exact
corrupt optimized row, explicitly select a still-valid inline copy, or delete an
unrecoverable row. Those row-level actions are not snapshot restores: they revalidate an
opaque live-publication proof and mutate only the selected row plus its owner, manifest,
quota, and recovery-dirty state. The inline source is kept until the normal boot
reconciliation validates the repaired publication.

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

### Per-chat pre-image history

`createChatBackupStore()` in `server/node/chatBackups.cjs` manages a filesystem history
separate from RisuSave archives and database snapshots. Immediately before
`POST /api/chat-content/:chaId/:chatIndex` replaces or extends an existing row, it
atomically publishes the exact prior materialized bytes under `<root>/<chaId>/<chatId>/`.
Log-free capture streams the protected base; logged capture replays the bounded log and
publishes byte-for-byte what a full-row write of that logical content would have captured,
then fsyncs and renames it atomically. Ordinary captures are best-effort and
have a 45-second per-chat cooldown. The cooldown applies only to non-negative elapsed
wall-clock time; a backward clock adjustment permits one capture, which establishes the
new in-process cooldown baseline while version filenames retain wall-clock timestamps.
Explicit edit, delete-message, and reroll actions
attach a sanitized reason for display; small cold-storage placeholder rows are skipped
using the rebuildable per-row derivative, with a bounded legacy decode fallback when that
metadata is absent.

Removing a chat reference is stricter. `captureChatDeletionPreImages()` forces a fresh
`delete-chat` pre-image without the cooldown, and failure blocks the database publication
that would delete the authoritative row. A missing row is the only no-capture success.

Reconciliation runs after a debounce and at startup:

- each loose version is streamed into one atomically published, self-describing `.frame`:
  fixed magic, a bounded JSON header with codec/raw size/SHA-256/content type/version
  metadata, and one independently decompressible gzip member;
- each chat keeps the exact 125-version default count cap and also has a 256 MiB default
  retained uncompressed-byte cap. Both delete oldest versions first, while the newest
  recovery point remains protected if it alone exceeds the uncompressed cap;
- the whole tree has a 50 MiB default budget, configurable with
  `config/chat-backup-max-bytes`; `POCKETRISU_CHAT_BACKUP_MAX_BYTES` takes precedence,
  and the effective value is clamped from 1 MiB through 50 GiB;
- the per-chat uncompressed cap is configurable with
  `config/chat-backup-max-uncompressed-bytes`;
  `POCKETRISU_CHAT_BACKUP_MAX_UNCOMPRESSED_BYTES` takes precedence, with the same 1 MiB
  through 50 GiB clamp;
- global eviction compares individual recovery points across chats by age and protects
  the newest version of each chat, so the tree can remain above the compressed-disk
  budget when only protected versions remain.

Frame compression and decompression use asynchronous zlib streams. Creation never
concatenates versions, reads inflate only the requested current frame, and reconciliation
holds at most one bounded legacy entry or stream chunk uncompressed. Existing solid v1
bundles remain listable/readable; reconciliation migrates them in one streaming pass,
publishes every extracted source durably, and only then withdraws the old metadata and
bundle. An interrupted migration therefore retains either the legacy source or exact
loose/frame replacements.

The frame is intentionally row-oriented rather than history-container-specific. Its
media type, codec, raw length/hash, and version identity are inside the frame,
so a future per-row `chats/` full-backup entry can use the same frame body. Full-backup
archive output/import remains unchanged today. The live chat operation table follows the
same extension principle: every entry carries an explicit operation format and patch media
type plus base/result commitments. A future per-row archive can add ordered operation
frames without changing logical readers; today's deferred per-row `chats/` archive entries
remain deferred, so exports materialize base+log into `database.risudat`.

The default root is `save/chat-backups`; `POCKETRISU_CHAT_BACKUP_DIR` may relocate it.
Startup reads the complete validated `save/__chat_backup_path` history before publishing
the current marker set, then merges every prior root and the legacy
`<server-backup-root>/chat-backups` tree beneath every validated, marker-retained server
backup root into the active root. Byte-identical files are deduplicated. A divergent
same-path or same-version claim, including a complete legacy bundle group, is copied into
the active root's reserved physical `%2Eroot-history/<source-id>/` namespace. Every copy
first stages and fsyncs a private, federated copy there, then publishes an independent
ordinary-destination copy create-only. Root migration never unlinks historical source
members: a compare-then-unlink sequence cannot be atomic against a peer replacing the
source path. Protected recovery history is permanent at the decoded-content level.
Normalization compacts ordinary active-root loose, gzip, and bundle representations only
after every decoded entry is durable. Historical and protected/conflict roots are
non-destructive inputs: normalization may derive and validate frames for them, but never
withdraws their source loose, gzip, bundle, or metadata files. Retained source and derived
representations are semantically deduplicated at the API boundary. Active reconciliation,
retention, stale-temp cleanup, and empty-directory pruning exclude the entire reserved
namespace. Frame publication removes only a temporary file that it created exclusively.
Federation hides protected history while the ordinary destination has identical decoded
content, and naturally exposes it as conflict history if that destination is replaced
later. Newly created directory hierarchy is also fsynced. Interrupted copies,
destination-creation or replacement races, unavailable historical roots, fsync failures,
and cross-device copies retain a readable source or recovery copy and are retried on a
later startup.

Captures and reconciliation always target only the active root. Authenticated list and
body reads federate the active tree, conflict namespaces, and every retained historical
root that is currently mounted. Divergent entries that originally shared one version
ID receive content-derived, safe-integer aliases that remain stable across root ordering,
restart, temporary root unavailability, representation changes, and in-place writes that
preserve size and mtime. Startup validates loose, gzip, framed, and
legacy-bundle representations, and binds each decoded frame hash to an unchanged
before/after physical-file fingerprint before caching it. It non-destructively
derives frames for non-active roots before exact decoded duplicates appear once at the API
boundary. A source replaced while normalization is finalizing remains in place; the next
bounded pass or startup exposes it as stable conflict history.
Retention and the global budget do not mutate historical or conflict trees, preventing a
root copy from evicting its only surviving recovery point. As with the protected
newest version of each chat, the tree may remain above budget when only protected normal
or conflict history remains. Copy-only migration initially creates independent ordinary
and protected copies while leaving the source mounted, so newly migrated content can
approach three physical copies, plus retained content from earlier root changes and
non-destructively derived frames. Ordinary active representations may be compacted to
frames, while historical and protected source representations remain. This storage cost
is the deliberate tradeoff for race-safe recovery without a filesystem-wide lock.
Authenticated
list/version/body routes live under `/api/chat-backups`. **System → Backups** can browse
deleted identities and import a selected pre-image as a new chat with a fresh ID; it
never overwrites the source or current chat.

Retained pre-images are also authoritative reachability roots for inlay deletion.
`scanChatBackupVersions()` visits each independently restorable loose, gzip, frame, or
legacy-bundle version across the same active, historical, and protected conflict roots
used by list/restore. The inlay scanner decodes and releases one version at a time and
counts message and swipe tokens together with live chat rows. Both gallery
classification and queued deletion use this combined proof; a retained candidate that
cannot be read or decoded, an unreadable or empty physical chat directory, recognized
malformed frame/bundle metadata, inventory-to-read disappearance, or an explicitly
retained history root that is unavailable fails the operation closed before any selected
inlay is removed. Destructive discovery also treats every discovered protected conflict
namespace as required: a non-`ENOENT` failure while enumerating its reserved container,
or disappearance of a discovered namespace before inventory, aborts the proof. Public
list/restore discovery remains permissive around damaged entries; destructive
reachability alone uses strict root discovery and inventory. Loaded unsaved chats remain
an additional browser-provided keep-set.

### Plugin recovery contract

[Plugin storage](plugin-storage.md) is canonical for persisted modes, generation/manifest
authority, atomic publication, transitions, and the folded-versus-explicit restore
boundary. Backup and import code consumes that contract with these consequences:

- Normal full exports carry the exact manifest-selected value and owner rows. Partial and
  automatic recovery artifacts fold the selected publication into their self-contained
  database payload.
- Exact restore may clear or replace only a proven prior ownership set. Unmarked historical
  snapshots retain external rows, while foreign, quarantined, or undeclared physical rows
  are never adopted as current data.
- Archive and save-folder imports stage an explicit manifest opaquely while validating the
  accompanying value and metadata bodies. It becomes authoritative only when its
  generation matches the imported database and every declared row exists. Folded database
  ingestion instead externalizes the inline set, removes the folded marker and inline
  maps, and constructs a fresh exact manifest from the rows actually published.

The server-side generation fence used by boot recovery and ordinary plugin requests also
keeps its session memory bounded. `createBoundedSessionState()` records the mode and
generation established by each browser's latest authoritative database read or
publication in a 50-entry, access-refreshed LRU; eviction drops the old session pin, while
live publication checks remain authoritative until a later database read repins that
session. On the retained staged-transition compatibility path, a row download first
revalidates stage ownership and its stored hash proof, then `openStageRowDownload()` opens
one read-only descriptor, checks regular-file type and exact size, and returns the
response stream and close handle from that same descriptor. Validation and delivery
therefore cannot reopen different path contents.

## Cancellation and outcome rules

| Result | Client action |
|---|---|
| Confirmed committed | Hard reload after a replacement; attach new authoritative state after ordinary mutations |
| Committed but response handling failed | Warn and hard reload; do not repeat the replacement |
| Definitely not committed | Remain on current state; retry only when explicitly safe and requested |
| Commit outcome unknown | Never replay automatically; warn and reload/re-read to reconcile |

Destructive replacements also require the current writer session. A mutation-time 423 or
a stale foreground check enters `enterWriterTakeoverFlow()` instead of replaying or
silently reloading: the page is permanently fenced and the user chooses a frozen
read-only view or an explicit reload that discards the stale in-memory state. Foreground
checks defer while a chat operation is active and re-check after the asynchronous status
read. This writer-displacement choice is separate from replacement commit-outcome
reconciliation.

Backup import streams use a strict NDJSON terminal event. Missing or malformed terminal
events, truncation, status-zero completion, and transport loss after dispatch become
`COMMIT_OUTCOME_UNKNOWN`. Save-folder and snapshot replacement use strict NDJSON events,
one destructive dispatch, and durable status reconciliation before reporting an unknown
outcome. Authentication retry is not allowed once doing so could duplicate a committed
replacement.

## Spools, limits, and operator configuration

### Private working roots

Important private roots:

- `save/.spool/` or `POCKETRISU_SPOOL_DIR`: configured shared spool root;
- `.instance-<sha256(__spool_owner_id)>.claim` below that root: a private durable
  binding between the owner UUID and the canonical save root. A copied save tree at a
  different path must reseed its copied UUID before it can claim or sweep a namespace;
- `.instance-<sha256(__spool_owner_id)>/` below that root: this installation's admitted
  database/chat/KV request bodies and private validation stages, database assembly,
  import-entry/database, plugin-value, and snapshot-restore spools. Startup and runtime
  recovery create/revalidate this real private-mode child without following symlinks.
  Startup completes the claim before touching the child, atomically quarantines the old
  child, verifies that the pinned quarantine is the exact pre-rename source, and sweeps
  recognized artifacts only through pinned old/fresh directory identities. Unrelated
  regular files publish create-only into the fresh child while the old links and all
  conflicts remain quarantined. Quarantine pathnames are retained unconditionally after
  descriptor close; runtime writers and readers use the process-lifetime pinned fresh identity,
  never the reusable child pathname.
  Platforms without a validated descriptor-relative directory alias retain the quarantine
  instead of risking pathname-redirection during deletion;
- `save/.partial-export-spool/`: private full/partial filesystem pins;
- `save/.plugin-transition-staging/`: durable plugin mode-transition stages;
- asset/inlay import staging and rollback directories beside their final stores.

`streamBackupRisuSaveToFile()` and `streamRisuSaveToFile()` create database outputs in
the owned database-spool child. Full and partial exports keep verified filesystem pins and completed
partial archives under the partial-export spool. These roots have separate disk-headroom
checks because an operator may place them on different volumes.

Decoded stream loads now use shared canonical and legacy name families under the
configured, installation-owned spool child. Production decode boundaries require its
pinned directory and fail closed when it is unavailable; they never fall back to `save/`
or the OS temporary directory. Normal paths retain `finally` cleanup, while boot cleanup
recognizes every decoded family and reaps termination orphans only inside the persistent
owner namespace. See the [fixed decoded-spool finding](../../.archived-docs/findings/2026-08-remediation/fixed/decoded-stream-load-spools-bypass-configured-spool-and-orphan-sweep.md).

Admitted-write files use create-only randomized `.admitted-ingress-*` names and private
`.admitted-write-stage-*` directories. Normal response/failure cleanup removes both;
startup removes only stale entries with those exact prefixes. Request bytes continue to
occupy the process-wide admission reservation until response finish/close even if their
disk file has already been unlinked.

### Finite restore and retention limits

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
| `POCKETRISU_CHAT_BACKUP_MAX_BYTES` | 50 MiB; clamped to 1 MiB–50 GiB |
| `POCKETRISU_CHAT_BACKUP_MAX_UNCOMPRESSED_BYTES` | 256 MiB per chat; clamped to 1 MiB–50 GiB |

Ordinary entry-count values are capped at one million. Large-restore ceilings are
separate recovery controls; disk-backed metadata keeps memory bounded, but raising or
overriding byte limits still increases disk, CPU, and recovery time.

### Backup roots, updater, Docker, and hub hosting

Server-file archives default to `<app>/backups`. **System → Backups** reads and updates
`config/server-backup-path` through `/api/backup/server/path`; the server normalizes the
path, rejects the app root and managed code directories, creates/probes the destination,
and leaves existing archives at the previous path. Chat history defaults to
`save/chat-backups` and can instead use `POCKETRISU_CHAT_BACKUP_DIR`; a relative value is
resolved from the application working directory. A root change is an automatic merge:
new captures use only the new root, while marker-retained prior roots remain read
fallbacks whenever they are mounted. Startup non-destructively copies their history into
independent ordinary and protected storage under the new root. Chat-root creation/capture
is best-effort and has no equivalent path-management route or managed-root validation.

The server records both resolved roots in `save/__backup_path` and
`save/__chat_backup_path`. Each publication writes and fsyncs a private same-directory
temporary file, atomically renames it, and fsyncs the parent directory where the platform
supports directory handles. A failed publication restores the previous regular marker;
if restoration also fails, it invalidates the marker so updaters refuse replacement.
Startup first atomically publishes `save/__recovery_path_startup_quarantine`, a bounded,
strictly versioned transaction record containing the complete target history recovered
from any prior quarantine, both still-valid markers, and the current authoritative roots.
Every updater rejects replacement while that pathname exists, including when its content
is corrupt. Startup then publishes both markers before using their configured recovery
roots and removes the quarantine only after both publications are durable. A first- or
second-marker failure leaves the record for the next clean startup to recover; corrupt or
uncertain quarantine publication retains the token-owned filesystem lock for explicit
operator recovery rather than discarding historical custom roots. Markers
accept the legacy single absolute path and use a versioned path set once multiple roots
or identities must be retained. The set persists prior configured roots because path
changes deliberately leave their archives in place, and it retains distinct lexical and
canonical identities when symlink aliases differ. Publication retains an authoritative
lexical identity when an offline drive, UNC share, or permission boundary temporarily
prevents canonical resolution; startup may then fall back to its default live root.
Destructive updater consumption remains strict and refuses an inaccessible or ambiguous
identity rather than trusting the lexical fallback.

The complete server-backup path admission—including validation/probing, a durable
`old + new` transition marker, the `config/server-backup-path` commit, the live-root
switch, and retained preservation set—is serialized with self-update admission. The
same operation also holds a durable filesystem exclusion shared with second server
processes, `scripts/updater.cjs`, `update.sh`, and the complete in-process self-update
replacement phase. Startup holds one acquisition while publishing both server- and
chat-root marker sets, before creating, falling back to, sweeping, or otherwise using
either recovery root. Thus no external updater can take a preservation snapshot while a
path transition is admitted, and no server can publish/select a new in-tree root between
an updater snapshot and destructive enumeration. A crash-stale or incomplete lock is
never guessed safe from age or PID liveness: startup, path changes, and updaters stop
fail-closed and identify the exact lock directory. After verifying no server/update
operation is active, an operator must remove only `save/__recovery_path_state.lock` and
retry. A crash before
the KV commit restarts on the old root, while a crash after it restarts on the new root;
the marker set preserves both roots in either case and continues protecting archives at
the old root after success. KV failure restores the prior marker set. Self-update captures
its preservation set under the same lock, keeps that
snapshot through replacement, and refuses later path changes until update completion.

`update.sh`, `scripts/updater.cjs`, and the in-process `/api/self-update` replacement all
require the startup quarantine to be absent and treat both markers as mandatory
preservation metadata. Before destructive replacement
they reject missing, unreadable, non-regular, malformed, app-root, and managed-code-root
markers. Classification checks lexical paths and canonical deepest-existing-prefix
identities, including symlink aliases and Windows case folding. Every safe in-tree
identity in a transition preserves its top-level entry with filesystem casing intact,
and updater enumeration performs platform-aware keep comparisons; the default `save`/`backups`
roots remain in the normal keep set, while a genuinely outside-tree identity needs no
updater exception. The source updater backs up `save/` but never recursively replaces or
merges the live tree; release-provided `save/` content is discarded, so the active lock
and database remain continuously present even if the updater is killed. Windows portable
and in-process updates atomically publish a token handoff under `.update-tmp`; the batch
post-step retains that exact logical ownership through bundled-Node copy and version
finalization, then the packaged dependency-free finalizer verifies the token and releases
the lock exactly once. A killed or broken post-step leaves the lock fail-closed.

Docker Compose persists `/app/save` and `/app/backups` in separate explicitly named
volumes. Default chat history under `/app/save/chat-backups` and default server archives
under `/app/backups` therefore survive container replacement. Operators who configure a
different server-backup or chat-history path must mount that path themselves; changing
application configuration does not create a Docker persistence boundary.

When `POCKETRISU_HUB_HOSTING` is `true` or `1`, file-based server backup save/list,
restore, download, delete, path, and reminder mutation routes are disabled and the
Backups screen hides that section. Host disk and estimated archive statistics are also
redacted. Downloaded full/partial exports, internal snapshots, and per-chat history remain
available; hub snapshot bytes use the server-pinned `POCKETRISU_HUB_SNAPSHOT_CAP_MB`
limit while clients may still change the snapshot count.

## Change map

- Full/server point-in-time export: start at `pinFullBackupState()`,
  `streamBackupRisuSave.cjs`, `streamRisuSaveToFile()`, filesystem pin/copy helpers, disk
  reservations, and full export regression suites.
- Partial jobs: update preparation/writer code, the `/api/backup/export/jobs` route
  family, `partialBackupAssetKeys()`, `NodeStorage.exportBackup()`, and `backuplocal.ts`
  together.
- Archive framing: coordinate `backupEntryFormat.cjs`, shared key policy, import parser,
  and framing/round-trip tests.
- Ingress and ZIP/save-folder handling: start in `importSpool.cjs`,
  `importBackupFromSource()`, `streamRisuLoad.cjs`, and import-barrier/journal code.
- Boot recovery: coordinate server preflight/raw read/snapshot restore with
  `bootSnapshotRecovery.ts`, `NodeStorage`, and bootstrap ordering.
- Snapshot retention/chunk cost: update `createBackupAndRotate()`, `db.cjs`,
  `chunkStore.cjs`, snapshot routes, and settings bounds.
- Chat pre-images: coordinate `chatBackups.cjs`, overwrite/deletion capture sites,
  `/api/chat-backups`, `ChatBackupList.svelte`, global eviction, and Docker/updater roots.
- Plugin folding/exact restore: coordinate with [Plugin storage](plugin-storage.md) and
  `snapshotPluginStorage.e2e.test.ts`.
- Destructive result UX: update `storageError.ts`, `backupReplacementUi.ts`,
  `snapshotRestoreUi.ts`, `writerTakeover.ts`, route acknowledgement schemas, and UI
  tests together.
- Server-backup deployment: coordinate the path routes and markers in `server.cjs`,
  `update.sh`, `docker-compose.yml`, hub-hosting guards, and their contract tests.

## Verification

Representative guarantees live in:

- `test/compat/full-export-database-source.test.ts`
- `test/compat/full-export-boundaries.test.ts`
- `test/compat/full-export-import-race.test.ts`
- `test/compat/full-export-corruption.test.ts`
- `test/compat/import-ingress-memory.test.ts`
- `test/compat/export-concurrent-mutation.test.ts`
- `test/compat/stream-risu-save.test.ts`
- `test/compat/hub-hosting.test.ts`
- `test/compat/docker-deployment-contract.test.ts`
- `test/compat/plugin-storage-boot-reconcile.test.ts`
- `server/node/chatBackups.test.ts`
- `server/node/importJournal.test.ts`
- `server/node/updateScript.test.ts`
- `server/node/windowsRecoveryLockFinalizer.test.ts`
- `server/node/snapshotPluginStorage.e2e.test.ts`
- `src/ts/storage/nodeStorage.bootRecovery.test.ts`
- `src/ts/storage/nodeStorageAvailability.test.ts`
- `src/ts/storage/backupReplacementUi.test.ts`
- `src/ts/storage/snapshotRestoreUi.test.ts`
- `src/ts/storage/writerTakeover.test.ts`
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
