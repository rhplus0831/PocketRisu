# Server backend

> Part of the PocketRisu structure docs — see [STRUCTURE.md](../../STRUCTURE.md) for the top-level map and subsystem index.
> Audited 2026-08-01 against `818c3bc1`. Paths and symbols are authoritative; line-number hints are approximate and should be verified with `rg`.

## 1. Purpose & overview

The server backend turns the built Svelte SPA into a self-hosted PocketRisu instance. The production implementation is the Express executable in `server/node/server.cjs`: it serves `dist/`, authenticates and fences writers, persists the PocketRisu-internal stubs-only RisuSave database plus external chat/plugin rows, proxies model traffic, manages filesystem stores, and exposes maintenance and recovery protocols. Self-contained migration archives are assembled only at explicit export boundaries.

Persistent application data is primarily stored in SQLite through a binary-compatible key/value abstraction. `database/database.bin` contains character/settings data plus chat stubs; full bodies live in `chats/<chaId>/<chatId>` rows. Optimized plugin authority is selected by `Database.pluginStorageGeneration` and an exact `plugin-storage/manifest.json`: ordinary value/owner/manifest publications stay within that backend generation, while a mode transition atomically publishes a fresh generation with its database state and exact `pluginsave/` plus `pluginsave-meta/` rows. Every logical KV namespace can use protected content-defined chunks; namespace does not determine physical representation. Safe ordinary assets, inlays, server-created archives, private pins/stages, and per-chat pre-image history are filesystem-backed; unsafe asset names remain KV rows. Destructive imports use an exclusive barrier plus a filesystem/SQLite commit journal. See [Plugin storage](plugin-storage.md) and [Backup and recovery](backup-recovery.md) for the cross-cutting protocols.

## 2. Key files

### Node implementation

| File | Role and important symbols |
|---|---|
| `server/node/server.cjs` | Executable Express backend and route/lifecycle monolith. It composes auth/writer fencing, storage queues, chat/filesystem stores, proxy jobs, plugin publication, export/import, snapshot restore, maintenance, and update behavior. `startServer()` performs recovery/preflight/migrations before selecting HTTP/HTTPS and `HOST`/`PORT`; loading the module starts the application. |
| `server/node/db.cjs` | Opens `save/risuai.db`, applies SQLite pragmas, owns KV/delta-list primitives, pins read-only WAL snapshots, initializes chunks, and maintains derived plugin usage/owner indexes and atomic quota plans. |
| `server/node/chunkStore.cjs` | Protected content-defined storage for the live DB, automatic snapshots, chat rows, and plugin values. It owns manifest metadata/publications, logical size/SHA verification, bounded raw-row streaming, snapshot sharing/cost, and mark/sweep GC. |
| `server/node/chatRows.cjs` | Injected chat-row store and the monolith-ingestion boundary. It owns encoded chat keys, missing/duplicate-ID repair, stub semantics, referenced-row diff/sweep helpers, split/assembly, and the transactional `ingestFullDatabase()` and `ingestStreamingDatabase()` paths. Duplicate `chaId` repair happens before row keys are finalized. |
| `server/node/chatBackups.cjs` | Per-chat pre-image history. Ordinary overwrites are best-effort and enforce a 45-second per-chat cooldown; structural chat deletion forces a cooldown-exempt capture and fails closed. The store gzip-compresses loose versions, builds up to four 25-version solid bundles plus one active loose batch, enforces an exact 125-version logical cap, applies a globally age-ordered byte budget using each bundle's newest member as its age, lists versions, and restores raw bytes. Reconciliation verifies a derivative’s decompressed bytes/bounds before deleting its source and fsyncs atomic publications. |
| `server/node/importBarrier.cjs` | Abort-aware exclusive import gate. `acquire()` claims a FIFO turn before draining older mutations; abandoned waiters are removed safely, later writes are refused, and stable reads can wait with an `AbortSignal`. |
| `server/node/importJournal.cjs` | Durable bridge between SQLite import transactions and filesystem asset/inlay directory swaps. It atomically writes/fsyncs `save/import_journal.json`, fsyncs staged trees, and recovers by finalizing committed swaps or restoring pre-import directories. |
| `server/node/session-lock.cjs` | In-memory single-writer authority. `register()` records a boot without stealing; `checkWrite()` distinguishes the active writer, fresh gesture-backed takeover, fresh passive compatibility writes, and stale rejection; `peek()` provides a side-effect-free foreground status. |
| `server/node/model-jobs.cjs` | Durable upstream model relay. `createModelJobs()` stores non-secret job metadata in `save/model-jobs.db`, records exact provider response bytes in append-only journals under `save/model-jobs/`, tails running streams, supports claims, and owns 48-hour pending-send tombstones. Main jobs are recoverable; auxiliary pipeline requests are relay-only. |
| `server/node/request-logs.cjs` | Provider request history and token usage in `save/request-logs.db`. `createRequestLogs()` masks/truncates request material, rotates heavy request bodies by byte budget, retains the small usage ledger, exposes query/statistics routes, and closes independently at shutdown. |
| `server/node/pluginSaveKeys.cjs` | Canonical optimized-plugin prefixes, manifest/folded markers, and lossless physical-key policy: UTF-8/base64url, tagged ill-formed UTF-16, or manifest-v3-mapped archive-safe hashes. |
| `server/node/pluginStorageJson.cjs`, `pluginStorageLimits.cjs` | Strict JSON/key/row validation plus authoritative per-value and aggregate optimized-storage limits. |
| `server/node/dbCachedRead.cjs` | Server half of the optional segmented boot-read protocol. It validates the client's hash inventory, splits the stubs-only database into root/character/preset/module/persona MessagePack segments, and emits bytes only for cache misses while preserving the full-view ETag. |
| `server/node/listDelta.cjs` | Builds full or delta `/api/list` responses from KV modification timestamps, the deletion journal, filesystem mtimes, and the list epoch. Delta eligibility is capped at six days. |
| `server/node/assetStore.cjs` | Filesystem-backed implementation for safe `assets/*` keys, including atomic write/rename, SHA-256 filename verification, dual-source listing, migration, clear, and import staging helpers. |
| `server/node/assetGc.cjs` | Bounded recursive asset-reference discovery, persisted candidate bookkeeping, and two-pass grace planning for server-owned ordinary-asset garbage collection. |
| `server/node/streamRisuSave.cjs` | Object-based legacy encoder for already-materialized database state and automatic snapshot assembly. |
| `server/node/streamBackupRisuSave.cjs` | Seekable source-to-source transformer for point-in-time full/partial export and folded external chat/plugin rows without monolithizing state in memory. |
| `server/node/streamRisuLoad.cjs` | Bounded streaming inspector/decoder for supported RisuSave formats and snapshot/import ingestion. |
| `server/node/streamJsonToMsgpack.cjs`, `jsonValidateWorker.cjs` | Bounded JSON validation and streaming conversion used by import/restore compatibility paths. |
| `server/node/backupEntryFormat.cjs` | Archive header/framing, entry name/body bounds, byte-size planning, and preflight. |
| `server/node/importSpool.cjs` | Private bounded upload/file/ZIP ingress, central-directory/CRC validation, entry staging, cancellation, and cleanup. |
| `server/node/backupSnapshot.test.ts`, `test/compat/export-concurrent-mutation.test.ts` | Prove pinned snapshot reads survive live updates/deletes, missing referenced chats abort exports, concurrent plugin changes cannot corrupt archive framing, and completed exports re-import exactly. |
| `server/node/importBarrier.test.ts`, `server/node/importJournal.test.ts`, `test/compat/import-mutation-barrier.test.ts` | Cover hold-before-drain ordering, retryable mutation refusal, late import rollback, crash recovery for directory swaps, and list-epoch invalidation. |
| `server/node/snapshotPluginStorage.e2e.test.ts`, `test/compat/snapshot-spool.test.ts` | Cover exact optimized-plugin recovery (including folded-empty/pre-marker cases), chunk-streamed snapshot writes, save-volume spooling, orphan cleanup, and non-fatal snapshot-only failures. |
| `server/node/session-lock.test.ts`, `model-jobs.test.ts`, `request-logs.test.ts` | Cover writer registration/takeover compatibility, recoverable versus auxiliary job lifecycle and retention, journal streaming/security, pending sends, request masking/truncation/rotation, usage retention, route guards, and database closure. |
| `server/node/logs.cjs` | Separate SQLite-backed client/server diagnostic log sink in `save/logs.db`. It masks credentials, batches writes, builds the server logger, installs fatal process handlers, and records otherwise-unlogged Express errors. This is distinct from provider request history and usage in `request-logs.cjs`. |
| `server/node/utils.cjs` | Server-side implementation of RisuAI save formats, cached-read hash parsing, and patch-sync hashing. `RisuSaveType` must match the client enum; `decodeRisuSave()` accepts legacy raw, compressed, stream-compressed, and block formats; `calculateHash()`/`normalizeJSON()` must remain behaviorally aligned with the client. |
| `server/node/readme.md` | Declares this tree as PocketRisu's production backend, documents root-CWD startup, and explicitly distinguishes the incomplete Hono scaffold. |
| `server/node/ssl/Generate Certificate.sh` | Generates a local CA and server certificate into `server/node/ssl/certificate/`; see `server/node/ssl/Generate Certificate.sh:2`. |
| `server/node/ssl/Generate Certificate.bat` | Windows equivalent of the certificate-generation helper. |
| `server/node/ssl/ca.conf` | OpenSSL CA identity and extensions; CA constraints are at `server/node/ssl/ca.conf:16`. |
| `server/node/ssl/server.conf` | Localhost server certificate request. SANs are only `localhost` and `127.0.0.1` at `server/node/ssl/server.conf:16`. |

### Hono scaffold

| File | Role and important symbols |
|---|---|
| `server/hono/src/app/index.ts` | Shared Hono application. It installs CSRF middleware and exposes only `GET /`, returning `Hello Hono!`; see `server/hono/src/app/index.ts:4`. |
| `server/hono/src/node.ts` | Node adapter with static serving from `./static`; hard-coded port 3000 at `server/hono/src/node.ts:7`. |
| `server/hono/src/bun.ts` | Bun adapter and `hono/bun` static middleware at `server/hono/src/bun.ts:1`. |
| `server/hono/src/cf.ts` | Exports the shared app for Cloudflare/Vercel, without storage or static middleware; see `server/hono/src/cf.ts:1`. |
| `server/hono/src/utils/postbuild.js` | Copies the root Vite `dist/` into Hono’s `static/` and Vercel output directories. It assumes execution from the repository root at `server/hono/src/utils/postbuild.js:3`. |
| `server/hono/package.json` | Separate Hono dependencies and Bun/Cloudflare/Node/Vercel scripts at `server/hono/package.json:4`. |
| `server/hono/tsconfig.json` | Strict NodeNext/ESNext TypeScript configuration with `hono/jsx`; see `server/hono/tsconfig.json:2`. |
| `server/hono/wrangler.jsonc` | Cloudflare name and static asset directory at `server/hono/wrangler.jsonc:1`. |
| `server/hono/README.md` | Explicitly marks the Hono tree as an incomplete, non-deployable scaffold and points to the production Node backend. |

## 3. Architecture & data flow

### Startup and configuration

1. `pnpm runserver` invokes `node server/node/server.cjs` from the repository root.
2. CommonJS evaluation loads `db.cjs` and `logs.cjs`; those modules synchronously
   create/open `risuai.db` and `logs.db`. Route initialization later creates the
   independent `model-jobs.db` and `request-logs.db` stores.
3. `db.cjs` creates `save/`, opens `save/risuai.db`, enables WAL with the power-loss-durable `synchronous=FULL` default, and applies performance and lock pragmas near `server/node/db.cjs:23`. It creates the `kv`, deletion-journal, epoch, and operational migration-state tables, initializes the chunk store, then attempts legacy save-folder migration. Legacy values and their `storage_migrations` completion row commit together; `.migrated_to_sqlite` is an atomically published rollback/UI compatibility marker that startup reconciles against that state. `server.cjs` may apply only an explicit persisted or administrator-managed downgrade after this safe startup boundary.
4. `server.cjs` installs fatal logging handlers before the rest of its initialization. It
   then creates `save/`, creates/sweeps the database-assembly spool, resolves the
   independent chat-history root, migrates legacy history from the configured
   server-backup directory, reads or creates the password/JWT/instance files, loads
   persisted direct-asset sessions, initializes the server-backup directory, and registers
   middleware and routes.
5. `startServer()` resolves interrupted filesystem swaps, then read-only preflights the live database before any migration or epoch write. A valid database gets the epoch bump plus asset, inlay, chat, plugin-stage, and legacy `REMOTE` migrations. A corrupt database skips those mutations and listens in authenticated snapshot-recovery mode so the original bytes remain recoverable. The chat migration first writes `migration-backup/pre-chat-externalization-<timestamp>.bin`, then records `migration/chats-externalized`.
6. TLS is enabled only when both `server/node/ssl/certificate/server.key` and `server.crt` can be read; otherwise it starts plain HTTP.
7. Both HTTP and HTTPS servers install the proxy-job WebSocket upgrade handler before listening.
8. After listening, the server reconciles chat-version files, compressing/bundling them,
   trimming only versions beyond the per-chat logical cap, and enforcing their byte
   budget. Shutdown handlers flush debounced database writes, truncate-checkpoint WAL, and
   close the model-job and request-log databases. The durability scheduler runs verified
   one-minute checkpoints in balanced mode and five-minute checkpoints in performance
   mode, retries busy attempts, and retains five-minute truncate maintenance in durable
   mode; list-deletion records are pruned hourly.

The server reads configuration directly from `process.env`; it does not load `.env` itself:

| Variable | Meaning |
|---|---|
| `PORT` | HTTP/HTTPS port; default `6001`. |
| `HOST` | Optional bind address passed to `server.listen()`; unset preserves the historical all-interfaces bind. Use `127.0.0.1` behind a local reverse proxy. |
| `POCKETRISU_CHUNK_THRESHOLD` | Lowers the protected-chunk threshold for every logical KV namespace. The effective maximum/default is 16 MiB. |
| `POCKETRISU_BACKUP_INTERVAL_MS` | Minimum interval between automatic DB snapshots; default five minutes. |
| `POCKETRISU_ASSET_GC_GRACE_MS` | Minimum time an ordinary asset must remain unreferenced across independent server sweeps before deletion; default seven days. |
| `POCKETRISU_ASSET_GC_START_DELAY_MS` | Delay before the first server-owned asset sweep; default 30 seconds. |
| `POCKETRISU_ASSET_GC_INTERVAL_MS` | Delay between later asset sweeps; default 24 hours and clamped to at least one second. |
| `POCKETRISU_ASSET_GC_AUTO` | Set to `0` to disable automatic sweeps or `1` to force-enable them in test environments. The authenticated `/api/assets/cleanup` maintenance endpoint remains available. |
| `POCKETRISU_ALLOW_INSECURE_CONTEXT` | Allows client boot outside HTTPS or localhost only when exactly `1` or `true`; bypasses the WebCrypto integrity gate at the operator's risk. |
| `POCKETRISU_HUB_HOSTING` | Enables shared/multi-instance hub hosting when set to `TRUE`/`true` or `1`. It hides host-disk statistics from `/api/db/stats`, disables the file-based server-backup feature with `403` responses, and pins the snapshot retention byte cap to `POCKETRISU_HUB_SNAPSHOT_CAP_MB` (only the snapshot count stays adjustable). |
| `POCKETRISU_HUB_SNAPSHOT_CAP_MB` | Hub-mode snapshot byte cap in MB, applied to both the limits endpoints and trim rotation; unset or invalid falls back to 500 MB, clamped to the 10 MB–50 GB safety bounds. Ignored outside hub mode. |
| `POCKETRISU_SQLITE_DURABILITY_MODE` | Administrator-managed SQLite durability policy: `durable`, `balanced`, or `performance`. Invalid values fail safe to `durable`. Any explicit value locks the System-dashboard control; hub mode is always administrator-managed and defaults to `durable` when unset. |
| `POCKETRISU_CHAT_BACKUP_DIR` | Overrides the final chat-history directory. Absolute paths are used directly; relative paths resolve from `process.cwd()`. The default is `<savePath>/chat-backups` (normally `save/chat-backups`, or `/app/save/chat-backups` in Docker). This operator setting also applies in hub mode and is independent of the server-file-backup path/API. |
| `POCKETRISU_CHAT_BACKUP_MAX_BYTES` | Overrides the global per-chat-history budget in bytes. Default 50 MiB; clamped to 1 MiB–50 GiB. It takes precedence over the `config/chat-backup-max-bytes` KV setting. |
| `POCKETRISU_SPOOL_DIR` | Relocates database assembly/import/value/restore spools. Default `save/.spool`; it does not relocate filesystem export pins or plugin transition stages. |
| `POCKETRISU_PLUGIN_VALUE_MAX_BYTES` | Per optimized-plugin value cap; default 128 MiB. |
| `POCKETRISU_PLUGIN_STORAGE_MAX_BYTES` | Aggregate optimized-plugin cap; default 1 GiB. |
| `RISU_BACKUP_IMPORT_MAX_BYTES` | Overall archive/save-folder ingress cap; default 2 GiB. Zero or invalid values use the default. |
| `RISU_LEGACY_DATABASE_IMPORT_MAX_BYTES` | Buffered legacy database cap; default 64 MiB and capped by the overall limit. |
| `RISU_SAVE_FOLDER_IMPORT_MAX_ENTRIES` | Save-folder/ZIP entry cap; default 100,000, maximum 1,000,000. |
| `RISU_BACKUP_IMPORT_MAX_ENTRIES` | Backup archive entry cap; default 100,000, maximum 1,000,000. |
| `RISU_IMPORT_BUFFERED_ENTRY_MAX_BYTES` | Per buffered archive entry cap; default 32 MiB and capped by the overall limit. |
| `RISU_LARGE_RESTORE_MAX_BYTES` | Explicit large-restore technical byte ceiling; defaults to the largest value compatible with 2× disk-headroom arithmetic. |
| `RISU_LARGE_RESTORE_MAX_ENTRIES` | Explicit large-restore technical entry ceiling; defaults to the largest safe integer. |
| `RISU_RESTORE_MAX_DECODED_BYTES` | Maximum decoded streaming restore size; default 4 GiB. |
| `RISU_RESTORE_DISK_HEADROOM_BYTES` | Additional free-space requirement for restore spools; default 256 MiB. |
| `RISU_RESTORE_MAX_LEGACY_BYTES` | Maximum in-memory compatibility restore; default 64 MiB. |
| `POCKETRISU_REPLACEMENT_OPERATION_RETENTION_MS` | Retention for durable save-folder/snapshot replacement outcomes; default 24 hours. |
| `RISU_STREAM_INGEST_MIN_BYTES` | Minimum supported `database.risudat` size for disk-backed ingest; default 32 MiB. Set to `1` to force the path for compatibility tests. |
| `BACKUP_NDJSON_HEARTBEAT_MS` | Backup-import keepalive interval, default 5 seconds and clamped to at least 100 ms. |
| `RISU_UPDATE_CHECK` | Disables update checks when exactly `false`. |
| `RISU_UPDATE_URL` | Replaces the update worker `/check` endpoint and derives `/api/public-stats` from it. |

### Authentication and writer authority

The Node backend uses short-lived server-issued HMAC-SHA256 JWTs for ordinary API
requests and a seven-day opaque direct-session cookie for assets, flush/compress routes,
and JWT renewal through `/api/test_auth`. `/api/session` persists the cookie token,
advertises database/plugin capabilities, and registers the browser's optional
`x-session-id` with the in-memory `sessionLock`.

Registration does not steal an active writer. `checkActiveSession()` applies
`sessionLock.checkWrite()` at mutation time: the active session passes and refreshes its
write timestamp; a different session can take over only if it booted after the active
writer's last accepted write and sends recent-user-activity proof. A fresh passive write
is accepted without moving or refreshing the lock, preserving boot/keepalive
compatibility. A stale session receives HTTP 423, while clients that omit `x-session-id`
remain compatibility-exempt. `GET /api/session/lock-status` calls side-effect-free
`peek()` and never acquires authority. Lock state is in memory, so the first registration
or write after a server restart becomes active.

### On-disk layout

```text
<process.cwd()>/
├── dist/                              # Vite SPA served by Express
├── save/
│   ├── risuai.db                      # application KV + chunks + manifests
│   ├── risuai.db-wal / -shm           # SQLite WAL sidecars
│   ├── logs.db                        # bounded client/server log database
│   ├── logs.db-wal / -shm
│   ├── request-logs.db                # provider requests + long-lived usage ledger
│   ├── request-logs.db-wal / -shm
│   ├── model-jobs.db                  # recoverable model-job metadata + pending sends
│   ├── model-jobs.db-wal / -shm
│   ├── model-jobs/
│   │   └── <jobId>.journal            # exact append-only provider response bytes
│   ├── .spool/                         # DB/import/value/restore spools (default)
│   ├── .partial-export-spool/          # private full/partial filesystem pins
│   ├── .plugin-transition-staging/     # durable staged plugin mode changes
│   ├── assets/
│   │   ├── <name>                     # one file per safe-named assets/* key
│   │   └── .migrated_to_fs
│   ├── inlays/
│   │   ├── <id>.<ext>                 # image/signature payload
│   │   ├── <id>.meta.json             # type, extension, name, dimensions
│   │   └── .migrated_to_fs
│   ├── chat-backups/
│   │   └── <chaId>/<chatId>/           # encoded path components
│   │       ├── v-<ts>-<seq>-<reason>.bin.gz
│   │       ├── archive-<first>-<last>.bundle
│   │       └── archive-<first>-<last>.meta.json
│   ├── __password
│   ├── __jwt_secret
│   ├── __instance_id
│   ├── __sessions
│   ├── __authcode                     # optional proxy registration token
│   ├── __sionyw_client_data.json       # optional hub OAuth refresh data
│   ├── __backup_path                  # updater-visible backup path marker
│   ├── __chat_backup_path             # updater-visible chat-history path marker
│   ├── import_journal.json             # present only across import publication/recovery
│   └── .migrated_to_sqlite             # legacy hex-file rollback/UI compatibility marker
├── backups/
│   └── risu-backup-<timestamp>.bin     # default server-side backup destination
└── server/node/ssl/certificate/
    ├── server.key
    └── server.crt
```

`risuai.db` contains:

- `kv(key TEXT PRIMARY KEY, value BLOB, updated_at INTEGER)`, created at `server/node/db.cjs:29`.
- `deleted_keys(key TEXT PRIMARY KEY, deleted_at INTEGER)`, a seven-day deletion journal used by delta key listings.
- `sync_meta(id = 1, list_epoch TEXT)`, whose random epoch invalidates incompatible browser list caches.
- `chunks(hash TEXT PRIMARY KEY, data BLOB)`, created at `server/node/chunkStore.cjs:117-121`.
- `manifest_chunks(manifest_key, seq, hash)`, mapping logical values to ordered chunks at `server/node/chunkStore.cjs:122-128`.
- `chunk_manifest_meta`, `chunk_manifest_protection`, and
  `chunk_manifest_publications`, which bind marker rows to complete chunk counts,
  logical length, and whole-value SHA-256 before readers accept them.
- `plugin_storage_usage` and `plugin_storage_owners`, derived indexes for optimized
  storage quota and ownership accounting.
- `replacement_operations`, the transaction-bound committed/not-committed status used to
  reconcile destructive requests whose acknowledgement was lost.
- `storage_migrations`, the authoritative completion/version record for legacy save-folder
  ingestion; `.migrated_to_sqlite` is only its filesystem compatibility marker.
- Possibly orphaned historical entity tables (`characters`, `chats`, `settings`, `presets`, `modules`); new installations do not create or use them, as documented at `server/node/db.cjs:51-54`.

Important KV namespaces include:

- `database/database.bin`: canonical stubs-only database save; chat bodies are not stored inline.
- `chats/<encodeURIComponent(chaId)>/<encodeURIComponent(chatId)>`: one legacy-encoded full chat body per row, managed by `server/node/chatRows.cjs`.
- `pluginsave/<physicalName>`: one UTF-8 `JSON.stringify` value per optimized plugin save
  key. A physical name is `<base64url>.json` for a well-formed raw key,
  `utf16-v1.<base64url-code-units>.json` for an ill-formed JavaScript string, or
  `sha256-v1.<64-hex>.json` when the prefixed name would exceed the 1,024-byte archive
  limit.
- `pluginsave-meta/<physicalName>`: matching optimized plugin ownership rows using the
  same physical name.
- `plugin-storage/manifest.json`: exact generation-bound value/metadata key set; manifest
  v3 supplies the raw-key mappings required by every hashed physical component.
- `database/dbbackup-<timestamp/100>.bin`: full, assembled DB-only automatic snapshots,
  created by `createBackupAndRotate()`.
- `assets/`: binary application assets.
- `remotes/`: retained upstream `REMOTE`-block payloads.
- `coldstorage/`: gzipped upstream cold-storage JSON.
- `inlay_meta/`: inlay metadata still kept in KV.
- `drafts/<chaId>/<chatId>`: unsent per-chat composer text and timestamp, independent of
  the chat body.
- `config/`: snapshot limits, backup path, boot-reminder settings, and the optional chat-history byte budget.
- `config/plugin-storage-recovery-dirty`: durable token scheduling recovery capture after
  plugin-only atomic publications.
- `import_journal/marker`: transaction-side half of the filesystem import journal; present only while a staged asset/inlay directory publication may require startup recovery.
- `migration/disable-remote-saving`: idempotence marker for remote-block conversion.
- `migration/chats-externalized`: idempotence marker for the chat-row boot migration.
- `migration-backup/pre-chat-externalization-<timestamp>.bin`: manifest-safe copy of the pre-migration monolith for downgrade recovery.

`kvSet()` and `kvSetFromFile()` route every string key through the chunk store. Values at
or below the effective threshold remain ordinary KV rows. Larger values publish a marker
only with a protected, complete manifest; readers verify chunk hashes, sequence/count,
logical size, and whole-value SHA-256. This namespace-independent rule ensures that an
extension-defined row accepted by the generic API remains restorable from a save folder.

Chunks use deterministic FastCDC-style boundaries: minimum 4 KiB, maximum 64 KiB, approximately 16 KiB average, and SHA-256 content hashes at `server/node/chunkStore.cjs:18`. Values larger than 16 MiB are represented in `kv.value` by `CHUNK_MARKER`; reads concatenate manifest chunks through the bound store created at `server/node/chunkStore.cjs:114`.

### Main persistence flow

#### Initial database load

- `bootstrap.loadData()` rejects insecure non-local browser contexts unless the server injected the explicit bypass, initializes `AutoStorage`, then calls `readDatabaseForBoot()` at `src/ts/bootstrap.ts:126`.
- `AutoStorage` always selects `NodeStorage` at `src/ts/storage/autoStorage.ts:35`.
- `/api/session` advertises `database.rawBootRead` and `database.atomicCreate`. Current clients use the raw boot endpoint when the first capability is present; an older server with no capability response falls back to authenticated `GET /api/read` and confirms an empty response against an uncached `GET /api/list` before classifying the database as missing.
- With the browser resource cache disabled, a capable server uses
  `GET /api/db/read-raw-for-boot`. With it enabled, the client verifies resident IndexedDB
  segments, advertises up to 8,192 hashes grouped as
  root/characters/botPresets/modules/personas, and calls `POST /api/db/read-cached`. The raw
  route waits for the import barrier, returns verbatim bytes plus their raw MD5 for
  recovery, uses HTTP 204 only for explicit absence, and never uses a route-ambiguous 404.
- The cached-read endpoint flushes pending writes, prepares the same normalized stubs-only
  view and canonical legacy-view MD5 as `/api/read`, MessagePack-encodes each group member
  separately, and returns `{hash}` for advertised hits or `{bytes}` for misses. Any
  malformed envelope, missing/corrupt local entry, unadvertised hit, or ETag disagreement
  makes a capable client retry the raw boot read. Unlike the ordinary and raw database
  routes, this route currently does not call `importBarrier.waitUntilIdle()` before
  reading, so it does not itself fence a concurrently open destructive-import transaction.
- Fresh initialization calls `POST /api/db/create-if-absent`, not generic replacement. The
  route ignores client-provided database bytes, runs behind the writer-session check and
  serialized storage mutation queue, and creates the canonical legacy-encoded `{}` in a
  SQLite transaction only if the live key is absent. It returns 201 plus the committed
  ETag to the winner and a definitive 409 without mutation to losing concurrent creators;
  a losing bootstrap rereads the winner's database.
- `/api/read` flushes pending saves, decodes and normalizes the stubs-only live row, caches it, and sends the legacy-encoded stripped database plus `x-db-etag`. If a full chat payload or folded optimized plugin storage leaked into the live row, it defensively routes that object through `ingestDatabase()` first.
- `POST /api/plugin-storage/reconcile-boot` derives the selected row's raw MD5 and, when
  needed, its canonical normalized legacy-view MD5 inside one queued storage operation.
  Cache-off and segmented boots may therefore present different but equivalent tokens;
  either is accepted only for that row, and `dbEtag` retains the accepted token domain.
  A truly stale token returns `PLUGIN_STORAGE_BOOT_CONFLICT`. If reconciliation removes
  recovered inline copies, it returns the changed database ETag so bootstrap rereads the
  paired row and token.
- Monolith-shaped inputs from boot migration, backup/snapshot restore, save-folder import, or defensive route recovery pass through `ingestDatabase()`. Supported raw or gzip/zlib MessagePack inputs above `RISU_STREAM_INGEST_MIN_BYTES` route to `ingestStreamingDatabase()`: the walker retains byte offsets for the root and character fields, decodes one chat at a time, and writes chat rows plus the stripped DB in one transaction without constructing or persisting the full monolith. Missing-ID assignment, duplicate handling, orphan-folder normalization, stub projection, cold-storage restoration, stale-row sweeping, and optimized plugin splitting share the same semantics as `ingestFullDatabase()`. Legacy block saves, bare deflate/JSON fallbacks, and unsupported compressed payloads retain the in-memory decoder.
- The HTML root injects `globalThis.__NODE__` and `globalThis.__PATCH_SYNC__`;
  `src/ts/platform.ts` turns those into frontend feature flags.

#### Patch save and full-write fallback

- `persistTrackedChanges()` first stages changed full chats individually, then encodes `database.bin` with chat stubs at `src/ts/globalApi.svelte.ts:769-813`.
- When patch sync is enabled, it calls `NodeStorage.patchItem()` through `forageStorage` at `src/ts/globalApi.svelte.ts:980`.
- `/api/patch` loads or reuses the stripped `dbCache`, checks the client’s compositional hash, validates chat paths, applies RFC 6902 operations to a clone, externalizes any whole-chat payload operations, records old-minus-new chat rows for deferred deletion, updates the stripped-view ETag, and schedules persistence after five seconds. Manifest/external-row patches and database patches touching plugin mode, generation, folded markers, or optimized value/owner maps are rejected with `PLUGIN_STORAGE_PUBLICATION_GUARD`. The original inline behavior is retained only when the server proves that the live authoritative mode is inline; those database patches may update `pluginCustomStorage` and `pluginStorageMeta` through the ordinary delayed path.
- The timer calls `persistDbCache()`, which commits the stubs-only database and queued chat-row deletions in one synchronous SQLite transaction. A failed stub write therefore cannot leave its former chat rows already deleted.
- Patch hash mismatches return `DATABASE_PATCH_CONFLICT`; the frontend keeps the response ETag provisional, reads and installs the matching authoritative database, and retries a patch from that baseline. Non-conflict rejections such as the chat guard may fall back to an ETag-guarded `NodeStorage.setItem()`/`/api/write`, while patch-enabled clients refuse unversioned full writes (`src/ts/globalApi.svelte.ts:965-1025`).
- `/api/write` checks the stripped-view ETag, validates malformed/duplicate chat identities, splits any payload-bearing chats, preserves the selected plugin publication, and commits external chat rows, `database.bin`, and targeted chat deletion in one SQLite transaction. Plugin mode/generation changes use the specialized CAS/batch/transition protocols.
- Ordinary request-time mutations run through the promise-based
  `queueStorageOperation()` FIFO, wrapped by `queueStorageMutation()`. An import claims the
  barrier first and then drains that FIFO: mutations already queued ahead of the drain
  commit before the import's `BEGIN`, while later mutations see the hold and are refused
  with `503 IMPORT_IN_PROGRESS` plus `Retry-After` instead of joining (and then being
  rolled back with) the import transaction. Outside the import owner's already-exclusive
  transaction, KV/chat-row/asset writes must use `queueStorageMutation()`, never
  `queueStorageOperation()` directly.

#### Hash-aware resource and key-list reads

- When the opt-in browser resource cache is enabled, ordinary non-database KV reads and chat-row reads advertise locally resident SHA-256 values in `x-cached-hashes`. `/api/read` and the chat endpoint return `204` plus `x-content-hash` on a match; otherwise they return authoritative bytes. The browser re-hashes cached bytes before decoding and retries without the cache header on any inconsistency.
- `/api/write` and the chat POST return the authoritative content hash so successful client writes can seed the disposable cache without downloading the same bytes again.
- `GET /api/list` waits for the import barrier to become idle, then supports full and delta responses. `NodeStorage.keys()` caches each prefix's key set, timestamp, and server epoch in a small separate IndexedDB database; a valid delta merges `added`/`deleted`, while missing, stale (older than six days), future-dated, or epoch-mismatched state receives a full list.
- SQLite `updated_at`, the `deleted_keys` journal, filesystem asset/inlay mtimes, and
  `sync_meta.list_epoch` are the protocol sources. A valid server boot rotates the epoch;
  destructive replacement commit and rollback paths rotate it around publication as
  applicable. Corrupt-boot recovery performs no preflight mutation. A missing or
  mismatched epoch forces a full response, and deletion records are retained for seven
  days and cleaned at boot plus hourly.

#### Externalized chat content

- `createChatRowStore()` is constructed once against the real SQLite-backed KV functions.
  Runtime chat bodies are never retained in a server-wide in-memory map.
- `GET /api/chat-content/:chaId/:chatIndex` resolves the `x-chat-id` row directly when
  supplied, otherwise falls back through the stripped database's index and rejects an ID
  mismatch with 409. It publishes `x-content-hash`, supports verified `204` cache hits,
  and returns raw row bytes unless cold-storage rehydration was needed; that restored chat
  is cached back only when no import owns the mutation barrier.
- `POST /api/chat-content/:chaId/:chatIndex` validates binary or JSON input and writes the
  row synchronously inside `queueStorageMutation()`. Immediately before overwrite it asks
  `chatBackups.cjs` to capture the exact old raw row, optionally tagged by
  `x-chat-backup-reason`; capture is best-effort and never blocks the authoritative save.
  The route requires `x-chat-id`, rejects bare stubs, heals hybrid `_stub` payloads,
  returns the stored row hash, and schedules the coalesced automatic snapshot only after
  acknowledging the row. It never joins the five-second database debounce. During active
  generation the client row stage writes the first eligible dirty save, throttles later
  checkpoints to 20 seconds, and always queues a final idle save.
- Frontend placeholders are hydrated through `fetchChatFromServer()` and
  `ensureChatHydrated()` in `src/ts/storage/chatStorage.ts`.
- Metadata fields retained in stubs are exactly `id`, `name`, `_stub`, `lastDate`,
  `folderId`, and `modules`; keep `STUB_METADATA_FIELDS`, shared `chatRows.cjs`
  stub/overlay semantics, and the matching client projection synchronized.

#### Assets and inlays

- Ordinary assets are filesystem files in `save/assets/` when the key's basename is a safe filename (`server/node/assetStore.cjs`); unsafe names stay as raw `assets/*` KV rows. Reads/lists/stats/backups merge both sources. Writes are fsynced temp-file + rename (never in place — files may be hardlinked across instances by `scripts/dedup-assets.sh`). A same-size destination is skipped only after byte comparison, so migration and a valid re-upload repair equal-length corruption. Uploads whose name matches `assets/<64-hex>.<ext>` are SHA-256-verified on `/api/write` and `/api/assets/bulk-write`. Historical mismatches accepted by main are explicitly marked under `save/assets/.legacy-hash-assets/`; only marked keys may retain mismatched bytes, and writing canonical bytes clears the exemption. Backup/save-folder imports classify mismatches during staging, while a bounded one-time scan (`.legacy_hash_identity_v1`) backfills files migrated by older builds. The original safe-row migration marker remains `save/assets/.migrated_to_fs`.
- Inlays are migrated from legacy `inlay/*` KV JSON to `save/inlays/<id>.<ext>` plus a
  sidecar by `migrateInlaysToFilesystem()`.
- `writeInlayFile()` stages and fsyncs both payload and sidecar, atomically renames and
  directory-syncs the payload first, then publishes the sidecar as the extension-change
  commit point. Only afterward may it remove the old-extension payload. A pre-commit
  failure rolls back the newly exposed extension while the old sidecar remains
  authoritative; startup `reconcileInterruptedInlayPublications()` removes recognized
  temporary files before migration resumes.
- Legacy key/value APIs synthesize the old JSON payload through
  `readInlayAssetPayload()`.
- `POST /api/inlays/delete-unreferenced` accepts at most 1,000 safe IDs (and at most
  1,000 client-protected IDs), then rescans every authoritative physical chat row inside
  the storage queue. It removes filesystem and legacy KV representations only for IDs
  that are neither referenced nor client-protected; generic single-inlay removal applies
  the same guard.
- `GET /api/asset/:hexKey` serves assets with a cookie-authenticated direct URL, MIME
  detection, immutable caching, and `updated_at` or filesystem-mtime ETags.
- Inlay thumbnails are generated on demand with `wasm-vips`; bulk WebP conversion is
  exposed through the `/api/inlays/compress` SSE route.
- `getFileSrc()` switches Node deployments to direct asset URLs at `src/ts/globalApi.svelte.ts:113`.

#### Backup and migration flow

- Full and server-file exports require a valid live database and every referenced chat.
  They bind one read-only WAL snapshot to verified private filesystem copies before any
  archive is published. Missing chats fail closed.
- Partial export is a cancellable server job with selected assets and a recovery-oriented
  missing-chat policy. It is not assembled from browser memory.
- Imports and save-folder replacements spool bounded ingress and entries to disk, hold the
  abortable import barrier, validate compatibility formats under finite limits, and pair
  the SQLite transaction with fsynced filesystem swaps through the durable journal.
- Automatic snapshots use the configured database spool, fold the selected plugin
  generation, preserve already-missing chats as bare stubs, and publish non-fatally into
  chunk-aware KV storage. Snapshot restore is bounded by decoded-size and disk-headroom
  limits, cancellable before commit, and atomic; its client wait is activity-based rather
  than a fixed total deadline.
- Destructive routes distinguish committed, not-committed, and unknown outcomes. An
  interrupted save-folder/snapshot response first consults the durable replacement status;
  any still-unknown result is reconciled by reload/readback and never replayed automatically.
- Per-chat pre-image history is a separate filesystem recovery mechanism and is not
  embedded in portable/server archives.

The framing, point-in-time cut, partial-job, import, snapshot, limits, cancellation, and
outcome contracts are canonical in [Backup and recovery](backup-recovery.md).

### Durable model requests and recovery

`createModelJobs()` is a recorder/relay for model-preset requests, not a second model
parser. It sends the upstream request, streams the provider bytes unchanged, and appends
the same bytes to `save/model-jobs/<jobId>.journal`. The SQLite row stores chat/generation,
adapter, status, timing, byte count, and only the target origin plus path. The schema has a
nullable `model` column, but `registerRoutes()` does not pass `req.body.model` to
`createJob()`, so route-created jobs do not populate it. Target query strings, request
headers, request bodies, and credentials remain in memory. Main jobs participate in chat
recovery and the per-chat running-job guard; auxiliary pipeline jobs use the reconnectable
relay but never appear in recovery lists.

Active and unclaimed-main listings let `jobRecovery.ts` install a background per-chat
guard for running jobs and poll their status with a 3-to-15-second backoff. It reads and
decodes the journal only after the job becomes terminal; recovery does not reattach a live
stream or render partial bytes. A process restart marks formerly running jobs failed
because their upstream connection and memory-only credentials cannot be resumed. Recovery
saves the resulting external chat row before recording provider request usage and
claiming the job; a row failure leaves it unclaimed. Claimed and auxiliary terminal jobs
expire after seven days. Unclaimed main jobs are protected from age expiry but still
share the 50-terminal-record cap. Pending-send rows are atomic, per-chat one-shot recovery
markers and expire after 48 hours.

`createRequestLogs()` stores masked provider request/response diagnostics separately from
`logs.db`. The `requests` table rotates toward a 256 MiB body budget while retaining at
least 50 recent rows; request/response bodies are capped at 2 MiB, headers at 16 KiB, and
ingest batches at 50. The compact LLM `usage` table is not rotated, so token statistics
survive deletion of heavy request bodies. Clearing request history is writer-guarded;
callers may explicitly include usage deletion.

### HTTP API route catalog

| Family | Routes and purpose | Primary frontend callers |
|---|---|---|
| SPA/static | `GET /` injects Node/cache/security flags and returns `dist/index.html`; `/assets` and other `dist` files are static. | Browser navigation and Vite-built imports. |
| General proxy | `GET/POST/PUT/PATCH/DELETE /proxy` and `/proxy2` relay authenticated arbitrary upstream HTTP; `GET/POST /hub-proxy/*` relays RisuAI Hub traffic under the hosting policy described below. | `fetchWithProxy()`/`fetchViaProxy2()` in `src/ts/globalApi.svelte.ts`; hub base in `src/ts/characterCards.ts`. |
| Local streaming proxy | `POST /proxy-stream-jobs` creates a local/private-network-only job; `DELETE /proxy-stream-jobs/:jobId` aborts it; WebSocket `/proxy-stream-jobs/:jobId/ws` transports headers and base64 chunks. | `fetchViaProxyJobWs()` in `src/ts/globalApi.svelte.ts`. |
| Authentication/session | `GET /api/test_auth`, `POST /api/login`, `POST /api/token/refresh`, `POST /api/session`, side-effect-free `GET /api/session/lock-status`, `POST /api/set_password`, and `POST /api/crypto`. `/api/session` also advertises database and plugin-storage capabilities. | `NodeStorage` auth/capability lifecycle and foreground writer checks. |
| Provider credentials | `POST /api/model-preset/google-service-account/token` signs a Google service-account JWT server-side and exchanges it only at Google's documented OAuth endpoint. | `src/ts/preset/adapter/googleServiceAccount/token.ts`. |
| Durable model requests | `POST /api/model-jobs`; filtered active/unclaimed `GET /api/model-jobs`; `GET /api/model-jobs/:id` and `.../stream`; claim and delete routes; plus create/list/delete/atomic-claim routes under `/api/pending-sends`. | Model-preset job transport and `src/ts/process/request/jobRecovery.ts`. |
| Key/value storage | `GET /api/read`, raw recovery `GET /api/db/read-raw-for-boot`, segmented `POST /api/db/read-cached`, create-only `POST /api/db/create-if-absent`, `GET /api/remove`, full/delta `GET /api/list`, `POST /api/write`, `POST /api/patch`, and cookie-authenticated `POST /api/db/flush`. | `NodeStorage`, bootstrap, and the save loop. |
| Plugin storage | Boot reconcile, state, viewer-page, manifest, mutate, batch, clear, capacity/size, direct `/api/plugin-storage/transition`, consolidated `/api/plugin-storage/transition/bulk`, and staged begin/upload/row/status/finalize/abort routes. Generic KV routes guard the reserved publication roots. | `NodeStorage`, `persistentKv.ts`, `pluginSaveStorage.ts`, bootstrap, and Plugin Settings/Viewer. |
| Asset serving/bulk | `GET /api/asset/:hexKey`, `POST /api/assets/bulk-read`, `POST /api/assets/bulk-write`, and maintenance `POST /api/assets/cleanup`. | Direct URLs from `src/ts/globalApi.svelte.ts`; bulk methods and System dashboard. |
| Diagnostic logs | `POST /api/logs` ingests client batches, `GET /api/logs` filters/paginates, and writer-guarded `DELETE /api/logs` clears. | Batch uploader in `src/ts/log.ts`; settings queries in `SystemSettings.svelte`. |
| Provider request logs | `POST/GET /api/request-logs`, `GET /api/request-logs/usage`, `/stats`, and `/:id`, plus writer-guarded `DELETE /api/request-logs` with optional usage deletion. | `src/ts/requestLog.ts` and request-log/statistics settings UI. |
| Portable backup | Strict full/upstream/main `GET /api/backup/export`, bounded import preparation/streaming, and cancellable partial-export job create/status/delete/download routes under `/api/backup/export/jobs`. | `NodeStorage` and `backuplocal.ts`; see [Backup and recovery](backup-recovery.md). |
| Server backup | `POST /api/backup/server/save`, `GET .../list`, `POST .../restore`, `DELETE .../:filename`, and `GET .../download/:filename`. | `NodeStorage` server-backup methods. |
| Chat-version recovery | `GET /api/chat-backups`, `GET /api/chat-backups/:chaId/:chatId`, and `GET /api/chat-backups/:chaId/:chatId/:versionId` list histories and return one raw pre-image. | `NodeStorage` chat-backup methods and `src/lib/Setting/ChatBackupList.svelte`. |
| Backup settings | `GET/PUT /api/backup/boot-reminder` and `GET/PUT /api/backup/server/path`. | `SystemBackup.svelte`; boot prompt in `src/ts/bootstrap.ts`. |
| Lazy chats | `GET/POST /api/chat-content/:chaId/:chatIndex` reads/writes individual chat rows, negotiates cached hashes, and captures eligible pre-images before overwrite. | `NodeStorage.fetchChatContent()` and `saveChatContent()`. |
| Save-folder migration | `POST /api/migrate/save-folder/scan`, `/execute`, `/upload`, `/cleanup/scan`, and `/cleanup/execute`. | `NodeStorage` migration methods. |
| Storage dashboard | `GET /api/db/stats`, `/api/db/stats/characters`, `/api/db/stats/modules`, and `/api/db/durability`; `PUT /api/db/durability`; `POST /api/db/optimize`; `POST /api/db/wal-checkpoint`. Durability defaults to `FULL`; explicit flush always verifies a `FULL` checkpoint. | `SystemDashboard.svelte`. |
| DB snapshots and replacement status | `GET/PUT /api/db/snapshots/limits`, metadata-only `GET`, `DELETE`, bounded atomic/cancellable `POST /api/db/snapshots/restore`, and authenticated `GET /api/replacement-operations/:operationId` reconciliation. | Bootstrap recovery, save-folder restore, `SystemBackup.svelte`, and `snapshotRestoreUi.ts`. |
| Inlay maintenance | `GET /api/inlays/references`, `POST /api/inlays/delete-unreferenced`, and cookie-authenticated SSE `POST /api/inlays/compress`. | Inlay cleanup and `InlayCompressButton.svelte`. |
| Public/update | Unauthenticated `GET /api/public-stats` and `GET /api/update-check`; authenticated `POST /api/self-update`. | `src/ts/publicStats.ts` and `src/ts/update.ts`. |

## 4. Entry points & dependencies

### Inbound entry points

- Production/self-hosted startup is `pnpm run runserver` → `server/node/server.cjs`, declared at `package.json:19`.
- Portable launchers and Termux scripts also execute the same file; `server.cjs` assumes `process.cwd()` is the PocketRisu application root.
- The frontend storage entry is the singleton `forageStorage = new AutoStorage()` at `src/ts/globalApi.svelte.ts:31`. `AutoStorage` constructs `NodeStorage`, which owns the HTTP contract.
- Direct settings-page fetches bypass `NodeStorage.authFetch()` for storage dashboards, snapshots, log viewing, update UI, and some backup preferences; their route references are listed above.
- The Hono entry points are runtime-specific exports or executables: `server/hono/src/bun.ts:1`, `server/hono/src/cf.ts:1`, and `server/hono/src/node.ts:1`.

### Outbound dependencies

- `better-sqlite3` supplies the synchronous application, diagnostic-log, request-log, and
  model-job databases.
- `msgpackr` and `fflate` implement RisuAI save compatibility in `server/node/utils.cjs:1`.
- `fast-json-patch` applies client patches at `server/node/server.cjs:73`.
- Express, `compression`, `express-rate-limit`, and `node-html-parser` provide HTTP routing, response compression, login throttling, and root-page flag injection.
- `ws` supplies the proxy-job WebSocket server at `server/node/server.cjs:24`.
- `wasm-vips` generates thumbnails and compresses inlays at `server/node/server.cjs:25`.
- Native `fetch` calls arbitrary authenticated proxy targets, `https://sv.risuai.xyz` for Hub traffic, Google OAuth, the configured PocketRisu update worker, and GitHub release assets.
- `child_process.spawn()` runs restart helpers; `execSync()` invokes platform archive tools during self-update.
- `server/hono/` depends only on Hono and `@hono/node-server`, declared at `server/hono/package.json:11`; it does not reuse the Node database, serialization, or route code.

## 5. Conventions & gotchas

### Process, configuration, and authentication

- Working directory is part of the contract. Storage, `dist/`, backups, package version,
  TLS certificates, binaries, and update paths are all based on `process.cwd()`, not
  `__dirname`. Starting from another directory creates/reads the wrong data tree.

- The server does not parse `.env`. Variables must already be in the process environment. Vite loads `.env` for dev/build. The in-app portable updater and `scripts/updater.cjs` preserve it, while the source `update.sh` and overwrite install path do not.

- Runtime requirements are slightly inconsistent. Root `package.json` declares Node
  `>=22.12.0`, while the server warns for any major version below 24.

- Authentication is NodeOnly-specific. PocketRisu replaced upstream's browser-side ECDSA
  flow with server-issued HMAC-SHA256 JWTs because remote HTTP is not a browser secure
  context; see `createServerJwt()` and the matching client warning in `nodeStorage.ts`.
  JWT lifetime is five minutes, while direct-asset session cookies last seven days.

- The password file contains whatever `/api/set_password` receives. The official client
  first hashes user input through unauthenticated `/api/crypto` and stores that digest as
  the password. Changing either side independently breaks login compatibility.

- Most authenticated routes return HTTP 400 for missing/expired/invalid JWTs, not consistently 401. `NodeStorage.shouldRetryAuth()` explicitly understands these response bodies at `src/ts/storage/nodeStorage.ts:257`.

- The direct-session cookie is a reauthentication credential. `/api/session` persists opaque tokens in `save/__sessions`, advertises optional protocol capabilities, and the cookie authorizes direct assets, flush/compress routes, and `/api/test_auth`, which can mint a fresh JWT. It is `HttpOnly`, `SameSite=Strict`, seven-day state, and intentionally not `Secure` for HTTP compatibility. Empty, non-JSON, missing, or capability-free session responses remain the legacy-server signal for client feature selection.

- JWT refresh has no maximum age beyond signature validity. `/api/token/refresh` disables expiration checking. Rotating `save/__jwt_secret` is the revocation boundary for a stolen signed token.

- Unset `HOST` binds all interfaces, and `/api/set_password` is intentionally unauthenticated while no password exists. Initial setup is therefore first-client-wins; bind `127.0.0.1` behind a reverse-access layer or set the password immediately on a trusted network.

- `GET /api/remove` is intentionally a mutating GET. This odd API is mirrored by `NodeStorage.removeItem()`; changing its verb requires a coordinated frontend compatibility change.

### Chats and database persistence

- Patch sync and chat lazy loading are inseparable. The patch baseline and live
  `database.bin` are stubs-only, while full messages live in chat rows. Any new stub
  metadata field must be added to shared `chatToStub()`/merge semantics, the server
  `STUB_METADATA_FIELDS` allowlist, and the client conversion.

- Key presence is semantically meaningful for stub metadata. Explicit `null`/`undefined` means “the user cleared this value”; it must overwrite the full chat. Do not replace the `in` checks in `mergeChatStubWithFullChat()` with nullish checks (`server/node/chatRows.cjs:218`).

- There are multiple chat-corruption guards. Field-level patch operations outside the stub
  allowlist are rejected through `findChatInternalFieldOps()`; debounced stripped writes
  and full `/api/write` requests both reject metadata-only chats through
  `findStubFlagLossChats()`. Removing one reopens the silent message-loss path.

- Chat rows must go through `chatRows.cjs`. Key components are URI-encoded, large rows may have chunk manifests, and the row wire format must match `/api/chat-content`. Use `readChatRow()`, `writeChatRow()`/`writeChatRowRaw()`, and `deleteChatRow()` instead of hand-built keys or direct SQL (`server/node/chatRows.cjs:16`, `server/node/chatRows.cjs:246-266`).

- Chat deletion is layered and atomic with its stub graph. Patches collect old-minus-new row keys, force a `delete-chat` pre-image for every still-present row, and delete them only in the same transaction that persists the new `database.bin`; capture failure aborts publication. Cache-warm full writes and plugin-storage transitions use the same pre-delete guard. `/api/db/optimize` additionally sweeps unreferenced `chats/` rows but preserves rows updated within the last hour so a chat POST arriving before its stub is not lost.

- Duplicate character IDs are a row-key collision, not harmless metadata. Ingest repairs
  duplicate `chaId` values before externalizing rows and copies any referenced pre-existing
  stub rows into the new namespace; direct full writes reject duplicates at the boundary.

- Imports own the write connection exclusively. Every destructive import (backup import, file-server restore, save-folder execute/upload, snapshot restore) holds `importBarrier` across its whole window, and the barrier claims its hold before draining the storage queue. The server has one writable `better-sqlite3` connection, so any statement issued while an import's raw transaction is open silently joins it — and would be discarded by its `ROLLBACK`. Never `acquire()` the barrier from inside a queued storage operation (the drain would deadlock), and never mutate the database outside `queueStorageMutation()`. Coverage: `server/node/importBarrier.test.ts` and `test/compat/import-mutation-barrier.test.ts`.

- Replacement outcome rows are deliberately outside KV so importing a new logical database cannot erase them. Register before dispatch, write `committed` in the same SQLite transaction as replacement publication, and expose only the authenticated status route. Startup may classify a leftover `running` row as `not-committed` precisely because a committed publication cannot exist without its transactional status update.

- Chat backups are pre-images, not post-save snapshots. For ordinary overwrites, `captureChatPreImage()` stays immediately before the chat-row write inside the shared storage queue; failures are logged and swallowed so recovery history cannot make a message save fail. Structural deletion is different: `captureChatDeletionPreImages()` holds the same queue, forces capture before the deleting transaction, and propagates failures so the row and stub graph remain authoritative. The newest version for each chat is protected during global budget eviction, but the ordinary 45-second cooldown means not every intermediate streaming/edit state is retained.

- Chat backup archives are filesystem-internal. IDs are path-component encoded and version IDs/reasons are strictly sanitized. A derivative is authoritative only after decompression, bounds, and byte-equality validation; reconciliation regenerates an invalid gzip/bundle and fsyncs atomic publication before deleting a source. Use `chatBackups.cjs` rather than reading or rewriting this tree ad hoc.

- Downgrading after chat externalization is unsupported. Older servers interpret the live
  stubs-only blob as the whole database. Recovery for a downgrade is the boot-created
  `migration-backup/pre-chat-externalization-*` copy or another full pre-migration
  snapshot; see `migrateChatsToRowsIfNeeded()`.

- Optimized plugin publication is generation/manifest-bound. Ordinary `mutate` and
  `batch` operations pin the live backend generation and atomically publish their
  value/owner rows, the revised exact manifest, quota state, and recovery-dirty token;
  they do not replace `Database.pluginStorageGeneration`. Mode transitions instead
  require a fresh backend generation and atomically publish the database mode/generation,
  inline maps or external rows, exact manifest, quota state, and recovery token. Generic
  KV routes and JSON Patch cannot mutate those optimized roots or controls. A database
  patch may update only the inline value/owner maps after an authoritative inline-mode
  check. See [Plugin storage](plugin-storage.md).

- `pluginStorageFolded` changes restore semantics. It proves a self-contained folded snapshot only with the selected generation/manifest contract. Exact restore replaces a proven owned set; unmarked historical snapshots retain external rows, and foreign/quarantined physical rows are not silently adopted.

### Plugin, cache, and protocol contracts

- Patch persistence is debounced. `/api/patch` acknowledges after mutating memory, then
  `persistDbCache()` writes five seconds later. Failures cannot be returned on the
  triggering request, so `recordPersistFailure()` surfaces them on the next patch
  response. Reads, backups, maintenance, shutdown, and the browser keepalive route
  explicitly flush pending data.

- Ordinary and segmented database ETags describe the canonical normalized legacy-encoded
  stripped client view. The raw boot route instead hashes the verbatim live row so corrupt
  or noncanonical bytes remain recoverable. `reconcileOptimizedPluginStorageForBoot()`
  derives and accepts either equivalent token inside one queued authoritative snapshot;
  full writes and patches must otherwise preserve the active token domain or clients will
  report false concurrent-modification conflicts.

- The browser resource cache is never authoritative. A cached database segment may be referenced only if the client advertised its hash, still has its bytes, and re-verifies SHA-256 before decoding. The assembled envelope ETag must match the response header. KV/chat `204` responses likewise require a locally advertised and re-hashed entry; every failure falls back to an unconditional server read.

- Delta lists depend on both timestamps and an epoch. `kvSet()` clears a matching
  tombstone after the live write, and client merge gives additions precedence if a crash
  exposes both records. Prefix deletes must journal keys before removal. Keep seven-day
  tombstones longer than the six-day delta window. `/api/list` stays behind
  `importBarrier.waitUntilIdle()`. Valid boot and destructive replacement commit/rollback
  paths rotate the epoch; corrupt-boot recovery deliberately performs no preflight
  mutation, and any epoch mismatch falls back to a full list.

- The compositional patch hash must remain byte-for-byte algorithmically aligned with the frontend. Property iteration order and normalization behavior in `calculateHash()`/`normalizeJSON()` are observable protocol details, not general-purpose utilities.

- RisuSave constants and defaults are duplicated across server and client. `RisuSaveType` and `presetTemplate` explicitly require synchronization at `server/node/utils.cjs:12` and `server/node/utils.cjs:57`.

- Legacy `REMOTE` data is migrated, not merely ignored.
  `migrateRemoteBlocksIfNeeded()` makes a dedicated safety backup, resolves
  `remotes/<name>.local.bin`, writes an inline legacy save, and keeps the old remote rows
  so pre-migration snapshots remain restorable.

- Cold-storage formats are another upstream compatibility boundary. Canonical runtime rows are gzipped `coldstorage/<uuid>`, while backup entries are plain JSON named `coldstorage/<uuid>.json`. Failed character restores become safe blank characters with a recovery breadcrumb.

### Files and protected chunks

- Inlay payloads no longer live in SQLite. Storage stats and backups must explicitly
  include `save/inlays`; `sumInlayFsBytes()` exists because KV prefix totals underreport
  them.

- Asset payloads mostly no longer live in SQLite either. Safe-named `assets/*` values are files in `save/assets/`; only unsafe names remain KV rows. Never write an asset file in place — always temp-file + rename (`writeAssetFile()`), or an externally hardlinked copy in another instance would be corrupted. Anything enumerating or deleting assets must use the merged dual-source helpers (`listAssetEntriesWithSizes()`, `readAssetValue()`, `deleteAssetValue()`, `clearAllAssets()`), not `kvListWithSizes('assets/')` alone. Backup import stages asset files in `save/assets_import_staging/` and swaps atomically with rollback.

- Chunk-aware deletion matters. `kvDel()` must go through `chunkStore.dropValue()` so manifests stop pinning chunks. Direct SQL deletion of a chunked logical key leaves stale metadata until GC repairs it.

- A marker row alone is not proof of a chunked value. Protected publication metadata binds the complete sequence, chunk hashes, logical byte length, and whole-value SHA-256. Readers reject incomplete or corrupt publications with `KV_CHUNK_CORRUPT` instead of concatenating partial data.

- Chat dashboard totals are chunk-aware. The `chats/` prefix total sums `kvSize()` for each
  logical row; `LENGTH(kv.value)` would report only the 13-byte marker for a chunked chat.
  The stats response also separates chat KV-row and referenced-chunk bytes so the
  dashboard can allocate physical storage without double-counting the shared chunk table.

- Chunk GC is deliberately off the save hot path. Replaced chunks become orphans and are
  reclaimed during `/api/db/optimize`.

- Snapshot “size” has two meanings. Rotation limits use exclusive physical chunk cost:
  chunks referenced by that manifest and no other manifest (`snapshotCostExclusive()`).
  The list endpoint reports logical reassembled DB size. Do not substitute
  `LENGTH(kv.value)`, which is only the marker for chunked values.

- Snapshot assembly is independent of file backups. Temporary `database.risudat` files
  belong in `save/.spool` or `POCKETRISU_SPOOL_DIR`, never under the optional server-backup
  path. Automatic snapshots stream the finished file through `kvSetFromFile()` and contain
  their own failures; advance `lastBackupTime` only after the snapshot row commits so a
  spool failure retries on the next write.

- Automatic snapshot timestamps use 100 ms units. Creation divides `Date.now()` by 100;
  listing multiplies the parsed value by 100.

### Backup and import boundaries

- Backup readers need one point in time. Full/server exports combine a pinned WAL view with private verified filesystem copies and disk reservations before emitting headers. Do not enumerate live SQLite or reread live filesystem paths during output; see [Backup and recovery](backup-recovery.md).

- Backup stream responses must remain uncompressed and incrementally flushed.
  `shouldCompress()` excludes proxy, download, SSE, and NDJSON cases. Re-enabling gzip can
  buffer heartbeats and reintroduce reverse-proxy timeouts.

- Backup imports are destructive replacement operations. Ingress and each archive/ZIP/save-folder entry are privately spooled under finite byte/count/headroom limits. Preserve cancellation, pre-import recovery, barrier, cleanup, SQLite transaction, filesystem journal, and exact committed/not-committed/unknown outcome classification.

- Filesystem swaps are part of the import commit protocol. Staging trees are fsynced before publication. The journal and KV marker precede directory renames; after SQLite commit, phase `committed` persists before backup-directory/marker cleanup. Startup recovery uses both records to finalize or roll back the swap.

### Proxy, deployment, and observability

- `/proxy` and proxy jobs have different trust models. Authenticated `/proxy` and `/proxy2`
  accept general HTTP(S) targets, while job/WebSocket streaming validates local/private
  hosts through `sanitizeTargetUrl()`. Do not reuse the unrestricted proxy path for the
  local-network feature.

- Hosted proxy policy lives in `server/node/proxyTarget.cjs`. With
  `POCKETRISU_HUB_HOSTING` enabled, general proxy requests use a DNS-pinning undici
  dispatcher that rejects non-public resolutions and blocked literal redirect targets on
  every connection; local proxy-stream job creation/WebSocket upgrades are disabled.
  Standalone general proxy requests keep global `fetch` and local-network access.

- `/hub-proxy/*` is not universally guarded by `checkAuth()`: PocketRisu authentication
  is checked only for the special `X-Node-Server-Auth` conversion flow. Nevertheless,
  `resolveHubProxyTarget()` restricts both the default route and an `x-risu-node-path`
  override to the configured HTTPS Hub origin. Header/target changes remain a deliberate
  compatibility and security boundary.

- Tailscale has no backend implementation. It is an external reverse-access recommendation using `tailscale serve --bg http://localhost:6001`, documented in `../../docs-human/en/remote.md`.

- Self-update is portable-only and mutates the installation tree. Only a `.portable`
  deployment can enter the replacement flow. The keep sets, rollback staging, Windows
  locked-binary handling, and restart logic are data-safety behavior.

- Logs are a separate bounded database. Rows are rotated to approximately 5,000, descriptions are truncated, and common JWT/API-key patterns are masked before persistence (`server/node/logs.cjs:8`, `server/node/logs.cjs:62`). Keep the server `BACKGROUND_SOURCES` list synchronized with the frontend logs settings as noted at `server/node/logs.cjs:55`.

- Fatal logging intentionally terminates the process. `uncaughtException` and `unhandledRejection` synchronously persist a record and call `process.exit(1)` at `server/node/logs.cjs:319`.

- The SSL helper is local-development oriented. Its certificate SANs cover only localhost, and the shell helper sets private keys to mode `0644` at `server/node/ssl/Generate Certificate.sh:7`; do not treat it as a hardened public-deployment certificate setup.

- The Hono tree is not feature-compatible. It has only `GET /`, CSRF, and optional static serving. Moreover, `server/hono/package.json:5` references missing `src/index.ts`, and `server/hono/wrangler.jsonc:3` references missing `src/index.js`. Treat it as scaffold code rather than an alternate PocketRisu backend.

## 6. Navigation hints

- To add or change an HTTP route, start in the route block in `server/node/server.cjs` and
  keep `expressErrorMiddleware` after all routes.

- To change request-size limits, static caching, compression, or streaming behavior,
  inspect the Express middleware and `shouldCompress()`.

- To change startup, bind/TLS selection, WebSockets, or shutdown, inspect `startServer()`
  and the final startup IIFE. New environment variables should follow existing direct
  `process.env` reads and document launcher behavior.

- To change authentication or direct-asset sessions, update `createServerJwt()`,
  `checkAuth()`, `sessionAuthMiddleware`, `/api/session`, and `NodeStorage` together.

- To change writer authority, update `server/node/session-lock.cjs`,
  `checkActiveSession()`, `/api/session/lock-status`, and the client session/activity
  headers together.

- To change generic KV behavior, pinned WAL readers, list epochs, or SQLite tuning, start
  in `server/node/db.cjs`. Large-blob thresholds, FastCDC boundaries, protected
  publication, snapshot sharing, and GC live in `server/node/chunkStore.cjs`.

- To change boot/read/write synchronization, inspect `/api/read`,
  `/api/db/read-cached`, `/api/db/read-raw-for-boot`,
  `/api/db/create-if-absent`, `/api/plugin-storage/reconcile-boot`,
  `server/node/dbCachedRead.cjs`, and `NodeStorage.readDatabaseForBoot()` together.

- To change verified browser-cache negotiation, update `parseCachedHashesHeader()` and
  `sha256Hex()` in `server/node/utils.cjs`, the hash-aware database/KV/chat routes, and
  `src/ts/storage/resourceCache.ts` together.

- To change key-list deltas, update `server/node/listDelta.cjs`, deletion/epoch helpers in
  `server/node/db.cjs`, `/api/list`, replacement epoch bumps, and `NodeStorage.keys()`.

- To change patch sync, inspect `findChatInternalFieldOps()`, `persistDbCache()`,
  `/api/patch`, and the matching `RisuSavePatcher`/normalization code.

- To add chat-level metadata, update `chatToStub()`/`mergeChatStubWithFullChat()` in
  `chatRows.cjs`, both `STUB_METADATA_FIELDS` allowlists, and the client conversions.
  Chat-row identity, ingestion, assembly, and orphan cleanup also start in
  `server/node/chatRows.cjs`.

- To change chat hydration or row persistence, inspect `/api/chat-content`,
  `NodeStorage.fetchChatContent()`/`saveChatContent()`, `chatPersistStage.ts`, and
  `ensureChatHydrated()`. Per-chat pre-image formats and retention live in
  `server/node/chatBackups.cjs`.

- To change recoverable provider requests, inspect `server/node/model-jobs.cjs`,
  `src/ts/process/request/jobRecovery.ts`, and the model-preset transport together.
  Preserve the external chat-row save before request logging and claim.

- To change provider diagnostics or token accounting, inspect
  `server/node/request-logs.cjs` and `src/ts/requestLog.ts`. Diagnostic application logs
  remain separately owned by `server/node/logs.cjs`.

- To change RisuAI format compatibility or monolith ingestion, inspect
  `server/node/utils.cjs`, `server/node/streamRisuLoad.cjs`, `ingestDatabase()`,
  `ingestFullDatabase()`, and `ingestStreamingDatabase()`; compare client codecs before
  changing constants.

- To change boot migrations, start at `migrateChatsToRowsIfNeeded()`,
  `migrateRemoteBlocksIfNeeded()`, `externalizePluginStorageIfNeeded()`, and
  `migrateInlaysToFilesystem()` as appropriate.

- To change asset storage or cleanup, inspect `server/node/assetStore.cjs`,
  `server/node/assetGc.cjs`, `collectDatabaseAssetReferences()`, and
  `runServerAssetCleanup()`. Statistics and deletion deliberately share the same
  plugin-aware reachability scan.

- To change backup framing/import, inspect `server/node/backupEntryFormat.cjs`,
  `importBackupFromSource()`, `server/node/importSpool.cjs`,
  `server/node/importBarrier.cjs`, and `server/node/importJournal.cjs`.

- To change snapshot creation, plugin folding, spooling, retention, or cost, inspect
  `createBackupAndRotate()`, `snapshotFootprint()`, `server/node/pluginSaveKeys.cjs`, and
  the snapshot routes.

- To change proxy target policy, inspect `server/node/proxyTarget.cjs`,
  `sanitizeTargetUrl()`, general proxy handlers, model jobs, and proxy-stream WebSockets;
  each transport has a different target policy.

- To change update checks or portable replacement, inspect `fetchLatestRelease()`, the
  public/update routes, `src/ts/update.ts`, and `scripts/updater.cjs` together.

- To make Hono functional, begin with `server/hono/src/app/index.ts`, but plan explicit
  replacements for authentication, SQLite/chunk storage, backup streaming, WebSockets,
  and runtime-specific filesystem/process features.

## 7. Related structure docs

- [Client storage](client-storage.md) owns `NodeStorage`, save scheduling, browser cache,
  chat hydration, and writer-takeover UX.
- [Backup and recovery](backup-recovery.md) owns export/import/snapshot taxonomy,
  point-in-time cuts, limits, cancellation, and destructive outcomes.
- [Plugin storage](plugin-storage.md) owns generation/manifest mutation and transition
  semantics across the browser/server boundary.
- [Model providers](model-providers.md) owns durable request selection, provider journal
  decoding, and client request-log production; this document owns their server stores and
  routes.
- [Media and translation](media-translation.md) owns the client inlay lifecycle; this
  document owns its filesystem/auth route boundary.
- [Characters and personas](characters-personas.md) owns card/package interchange and
  character-specific asset references.
- `scripts/updater.cjs` is the standalone portable update path parallel to the in-server
  `/api/self-update`; `docs/*/remote.md` documents external Tailscale setup.
