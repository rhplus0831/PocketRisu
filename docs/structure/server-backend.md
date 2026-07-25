# server-backend

> Part of the PocketRisu structure docs — see [STRUCTURE.md](../../STRUCTURE.md) for the top-level map and subsystem index.
> Audited 2026-07-25 against `c87235b0`. Line numbers are approximate and drift as code changes; verify with `rg` before relying on them.

## 1. Purpose & overview

The server backend turns the built Svelte SPA into a self-hosted, single-user PocketRisu instance. The production implementation is the Express executable in `server/node/server.cjs`: it serves `dist/`, authenticates clients, persists RisuAI-compatible save data and assets, lazily hydrates chats, proxies model traffic, manages backups and storage maintenance, and checks for updates.

Persistent application data is primarily stored in SQLite through a binary-compatible key/value abstraction. `database/database.bin` contains character/settings data plus chat stubs; full chat bodies live in individual `chats/<chaId>/<chatId>` rows, and optimized plugin save data lives in `pluginsave/` plus `pluginsave-meta/` JSON rows. Large chat rows and full database snapshots are deduplicated through content-defined chunking. Assets (`save/assets/`, one immutable file per safe-named `assets/*` key, written temp-file+rename so cross-instance hardlink dedup is safe), inlays, server-created backup files, and per-chat pre-image history are stored separately on the filesystem; unsafe-named assets remain KV rows (dual-source reads via `server/node/assetStore.cjs`). `server/hono/` is only an early multi-runtime scaffold; it does not implement the Node backend’s APIs, authentication, or storage.

## 2. Key files

### Node implementation

| File | Approx. size | Role and important symbols |
|---|---:|---|
| `server/node/server.cjs` | 6,795 lines | Executable Express backend. Imports the storage, logging, serialization, patching, WebSocket, image, and process-management layers at `server/node/server.cjs:1`. HTTP routes begin at `server/node/server.cjs:2741`, error middleware follows them, and `startServer()` selects HTTP/HTTPS and `HOST`/`PORT` at `server/node/server.cjs:6698`. It exports nothing; loading it starts the application through the IIFE at `server/node/server.cjs:6749`. |
| `server/node/db.cjs` | 300 lines | Opens `save/risuai.db`, applies SQLite pragmas, creates the `kv`, deletion-journal, and list-epoch tables, initializes the chunk store, and migrates legacy hex-named save files. Core KV functions begin at `server/node/db.cjs:145`; delta-list helpers and deletion cleanup are at `server/node/db.cjs:210`; maintenance helpers begin at `server/node/db.cjs:250`. |
| `server/node/chunkStore.cjs` | 230 lines | Byte-oriented, content-defined chunk storage for large SQLite values. `isChunkableKey()` limits automatic chunking to the live DB, snapshots, and chat rows at `server/node/chunkStore.cjs:50`; `createChunkStore()` creates `chunks` and `manifest_chunks` at `server/node/chunkStore.cjs:60`. Exclusive snapshot cost and mark/sweep GC are at `server/node/chunkStore.cjs:169` and `server/node/chunkStore.cjs:200`; exports are at `server/node/chunkStore.cjs:230`. |
| `server/node/chatRows.cjs` | 486 lines | Injected chat-row store and the monolith-ingestion boundary. It owns encoded chat keys, shared missing/duplicate-ID and stub semantics, referenced-row diff/sweep helpers, split/assembly, and the transactional `ingestFullDatabase()` and `ingestStreamingDatabase()` paths. |
| `server/node/chatBackups.cjs` | 808 lines | Best-effort per-chat pre-image history. It captures the row about to be overwritten, enforces a 45-second per-chat cooldown, gzip-compresses loose versions, builds 25-version solid bundles, keeps four bundles per chat, applies a global byte budget, lists versions, and restores raw version bytes. |
| `server/node/dbCachedRead.cjs` | 151 lines | Server half of the optional segmented boot-read protocol. It validates the client's hash inventory, splits the stubs-only database into root/character/preset/module/persona MessagePack segments, and emits bytes only for cache misses while preserving the full-view ETag. |
| `server/node/listDelta.cjs` | 84 lines | Builds full or delta `/api/list` responses from KV modification timestamps, the deletion journal, filesystem mtimes, and the list epoch. Delta eligibility is capped at six days. |
| `server/node/assetStore.cjs` | 315 lines | Filesystem-backed implementation for safe `assets/*` keys, including atomic write/rename, SHA-256 filename verification, dual-source listing, migration, clear, and import staging helpers. |
| `server/node/streamRisuSave.cjs` | 217 lines | Disk-backed legacy save encoder used by backup assembly. It writes the magic header and standard MessagePack map/array headers directly, encodes ordinary values independently with record mode disabled, and hydrates at most one external chat or plugin JSON row at a time. Explicit `undefined` properties remain map entries, matching `encodeRisuSaveLegacy()` after decode. |
| `server/node/streamRisuLoad.cjs` | 711 lines | Streaming legacy save decoder used by import and restore. It recognizes raw MessagePack plus gzip/zlib MessagePack under the compressed/stream headers, streams compressed payloads to a temporary decoded spool, records seekable byte spans, and decodes at most one chat or optimized plugin value at a time. Its MessagePack skipper covers every standard scalar, string, binary, collection, and extension marker, including timestamp extensions. |
| `server/node/chatRows.test.ts` | 560 lines | In-memory SQLite coverage for chat keys, row wire format, stub overlay semantics, split/assembly, duplicate IDs, targeted and grace-window orphan cleanup, and ingest atomicity. Orphan deletion tests begin at `server/node/chatRows.test.ts:389`; ingest tests begin at `server/node/chatRows.test.ts:460`. |
| `server/node/chunkStore.test.ts` | 435 lines | Vitest coverage for deterministic chunking, reassembly, deduplication, snapshot sharing, exclusive snapshot cost, orphan collection, and stale-manifest repair. The bound store suite begins at `server/node/chunkStore.test.ts:95`, snapshot suite at `server/node/chunkStore.test.ts:210`, and GC suite at `server/node/chunkStore.test.ts:304`. |
| `server/node/logs.cjs` | 391 lines | Separate SQLite-backed client/server log sink in `save/logs.db`. It creates the schema at `server/node/logs.cjs:24`, masks credentials at `server/node/logs.cjs:62`, batches writes with `addLogBatch()` at `server/node/logs.cjs:129`, builds the server logger at `server/node/logs.cjs:215`, queries logs at `server/node/logs.cjs:279`, installs fatal process handlers at `server/node/logs.cjs:319`, and records otherwise-unlogged Express errors at `server/node/logs.cjs:361`. Exports are at `server/node/logs.cjs:381`. |
| `server/node/utils.cjs` | 623 lines | Server-side implementation of RisuAI save formats, cached-read hash parsing, and patch-sync hashing. `RisuSaveType` must match the client enum; `decodeRisuSave()` accepts legacy raw, compressed, stream-compressed, and block formats; `calculateHash()`/`normalizeJSON()` must remain behaviorally aligned with the client. |
| `server/node/readme.md` | 9 lines | Declares this tree as PocketRisu's production backend, documents root-CWD startup, and explicitly distinguishes the incomplete Hono scaffold. |
| `server/node/ssl/Generate Certificate.sh` | 8 lines | Generates a local CA and server certificate into `server/node/ssl/certificate/`; see `server/node/ssl/Generate Certificate.sh:2`. |
| `server/node/ssl/Generate Certificate.bat` | 4 lines | Windows equivalent of the certificate-generation helper. |
| `server/node/ssl/ca.conf` | 19 lines | OpenSSL CA identity and extensions; CA constraints are at `server/node/ssl/ca.conf:16`. |
| `server/node/ssl/server.conf` | 23 lines | Localhost server certificate request. SANs are only `localhost` and `127.0.0.1` at `server/node/ssl/server.conf:16`. |

### Hono scaffold

| File | Approx. size | Role |
|---|---:|---|
| `server/hono/src/app/index.ts` | 11 lines | Shared Hono application. It installs CSRF middleware and exposes only `GET /`, returning `Hello Hono!`; see `server/hono/src/app/index.ts:4`. |
| `server/hono/src/node.ts` | 11 lines | Node adapter with static serving from `./static`; hard-coded port 3000 at `server/hono/src/node.ts:7`. |
| `server/hono/src/bun.ts` | 4 lines | Bun adapter and `hono/bun` static middleware at `server/hono/src/bun.ts:1`. |
| `server/hono/src/cf.ts` | 4 lines | Exports the shared app for Cloudflare/Vercel, without storage or static middleware; see `server/hono/src/cf.ts:1`. |
| `server/hono/src/utils/postbuild.js` | 5 lines | Copies the root Vite `dist/` into Hono’s `static/` and Vercel output directories. It assumes execution from the repository root at `server/hono/src/utils/postbuild.js:3`. |
| `server/hono/package.json` | 24 lines | Separate Hono dependencies and Bun/Cloudflare/Node/Vercel scripts at `server/hono/package.json:4`. |
| `server/hono/tsconfig.json` | 16 lines | Strict NodeNext/ESNext TypeScript configuration with `hono/jsx`; see `server/hono/tsconfig.json:2`. |
| `server/hono/wrangler.jsonc` | 7 lines | Cloudflare name and static asset directory at `server/hono/wrangler.jsonc:1`. |
| `server/hono/README.md` | 8 lines | Explicitly marks the Hono tree as an incomplete, non-deployable scaffold and points to the production Node backend. |

## 3. Architecture & data flow

### Startup and configuration

1. `pnpm run runserver` invokes `node server/node/server.cjs` through `package.json:19`.
2. CommonJS evaluation first loads `db.cjs` and `logs.cjs` at `server/node/server.cjs:26`. Those modules synchronously create/open their SQLite files before route registration.
3. `db.cjs` creates `save/`, opens `save/risuai.db`, enables WAL, and applies performance and lock pragmas at `server/node/db.cjs:8`. It creates the `kv` table at `server/node/db.cjs:28`, initializes the chunk store at `server/node/db.cjs:94`, then attempts legacy save-folder migration at `server/node/db.cjs:100`.
4. `server.cjs` installs fatal logging handlers before the rest of its initialization at `server/node/server.cjs:39`. It then creates `save/`, resolves the independent chat-history root, migrates legacy history from the configured server-backup directory, reads or creates the password/JWT/instance files, loads persisted direct-asset sessions, initializes the server-backup directory, and registers middleware and routes.
5. `startServer()` migrates assets and inlays, externalizes monolithic chats, defensively re-externalizes folded optimized plugin storage even when the chat marker already exists, and converts any RisuSave `REMOTE` blocks before listening. The chat migration first copies the old blob to `migration-backup/pre-chat-externalization-<timestamp>.bin`, then records `migration/chats-externalized`; the wrapper is at `server/node/server.cjs:512`.
6. TLS is enabled only when both `server/node/ssl/certificate/server.key` and `server.crt` can be read; otherwise it starts plain HTTP.
7. Both HTTP and HTTPS servers install the proxy-job WebSocket upgrade handler before listening.
8. After listening, the server reconciles chat-version files, compressing/bundling/rotating them and enforcing their byte budget. Shutdown handlers flush debounced database writes and truncate-checkpoint WAL; background jobs checkpoint WAL every five minutes and prune old list-deletion records hourly.

The server reads configuration directly from `process.env`; it does not load `.env` itself:

| Variable | Meaning |
|---|---|
| `PORT` | HTTP/HTTPS port; default `6001` inside `startServer()` at `server/node/server.cjs:6709`. |
| `HOST` | Optional bind address passed to `server.listen()`; unset preserves the historical all-interfaces bind. Use `127.0.0.1` behind a local reverse proxy. |
| `POCKETRISU_CHUNK_THRESHOLD` | Overrides the default 16 MiB chunking threshold at `server/node/db.cjs:106`. |
| `POCKETRISU_BACKUP_INTERVAL_MS` | Minimum interval between automatic DB snapshots; default five minutes. |
| `POCKETRISU_ALLOW_INSECURE_CONTEXT` | Allows client boot outside HTTPS or localhost only when exactly `1` or `true`; bypasses the WebCrypto integrity gate at the operator's risk. |
| `POCKETRISU_HUB_HOSTING` | Enables shared/multi-instance hub hosting when set to `TRUE`/`true` or `1`. It hides host-disk statistics from `/api/db/stats`, disables the file-based server-backup feature with `403` responses, and pins the snapshot retention byte cap to `POCKETRISU_HUB_SNAPSHOT_CAP_MB` (only the snapshot count stays adjustable). |
| `POCKETRISU_HUB_SNAPSHOT_CAP_MB` | Hub-mode snapshot byte cap in MB, applied to both the limits endpoints and trim rotation; unset or invalid falls back to 500 MB, clamped to the 10 MB–50 GB safety bounds. Ignored outside hub mode. |
| `POCKETRISU_CHAT_BACKUP_DIR` | Overrides the final chat-history directory. Absolute paths are used directly; relative paths resolve from `process.cwd()`. The default is `<savePath>/chat-backups` (normally `save/chat-backups`, or `/app/save/chat-backups` in Docker). This operator setting also applies in hub mode and is independent of the server-file-backup path/API. |
| `POCKETRISU_CHAT_BACKUP_MAX_BYTES` | Overrides the global per-chat-history budget in bytes. Default 50 MiB; clamped to 1 MiB–50 GiB. It takes precedence over the `config/chat-backup-max-bytes` KV setting. |
| `RISU_BACKUP_IMPORT_MAX_BYTES` | Maximum streamed backup/ZIP import size; `0` means unlimited. |
| `RISU_STREAM_INGEST_MIN_BYTES` | Minimum supported `database.risudat` size for disk-backed ingest; default 32 MiB. Set to `1` to force the path for compatibility tests. |
| `BACKUP_NDJSON_HEARTBEAT_MS` | Backup-import keepalive interval, default 5 seconds and clamped to at least 100 ms at `server/node/server.cjs:871`. |
| `RISU_UPDATE_CHECK` | Disables update checks when exactly `false` at `server/node/server.cjs:974`. |
| `RISU_UPDATE_URL` | Replaces the update worker `/check` endpoint and derives `/api/public-stats` from it at `server/node/server.cjs:975`. |

### On-disk layout

```text
<process.cwd()>/
├── dist/                              # Vite SPA served by Express
├── save/
│   ├── risuai.db                      # application KV + chunks + manifests
│   ├── risuai.db-wal / -shm           # SQLite WAL sidecars
│   ├── logs.db                        # bounded client/server log database
│   ├── logs.db-wal / -shm
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
│   └── .migrated_to_sqlite             # legacy hex-file migration marker
├── backups/
│   └── risu-backup-<timestamp>.bin     # default server-side backup destination
└── server/node/ssl/certificate/
    ├── server.key
    └── server.crt
```

`risuai.db` contains:

- `kv(key TEXT PRIMARY KEY, value BLOB, updated_at INTEGER)`, created at `server/node/db.cjs:28`.
- `deleted_keys(key TEXT PRIMARY KEY, deleted_at INTEGER)`, a seven-day deletion journal used by delta key listings.
- `sync_meta(id = 1, list_epoch TEXT)`, whose random epoch invalidates incompatible browser list caches.
- `chunks(hash TEXT PRIMARY KEY, data BLOB)`, created at `server/node/chunkStore.cjs:56`.
- `manifest_chunks(manifest_key, seq, hash)`, mapping logical values to ordered chunks at `server/node/chunkStore.cjs:61`.
- Possibly orphaned historical entity tables (`characters`, `chats`, `settings`, `presets`, `modules`); new installations do not create or use them, as documented at `server/node/db.cjs:37`.

Important KV namespaces include:

- `database/database.bin`: canonical stubs-only database save; chat bodies are not stored inline.
- `chats/<encodeURIComponent(chaId)>/<encodeURIComponent(chatId)>`: one legacy-encoded full chat body per row, managed by `server/node/chatRows.cjs`.
- `pluginsave/<base64url(rawKey)>.json`: one UTF-8 `JSON.stringify` value per optimized plugin save key.
- `pluginsave-meta/<base64url(rawKey)>.json`: matching optimized plugin ownership metadata rows.
- `database/dbbackup-<timestamp/100>.bin`: full, assembled DB-only automatic snapshots, created by `createBackupAndRotate()` at `server/node/server.cjs:231`.
- `assets/`: binary application assets.
- `remotes/`: retained upstream `REMOTE`-block payloads.
- `coldstorage/`: gzipped upstream cold-storage JSON.
- `inlay_meta/`: inlay metadata still kept in KV.
- `drafts/`: device/session draft state.
- `config/`: snapshot limits, backup path, boot-reminder settings, and the optional chat-history byte budget.
- `migration/disable-remote-saving`: idempotence marker for remote-block conversion.
- `migration/chats-externalized`: idempotence marker for the chat-row boot migration.
- `migration-backup/pre-chat-externalization-<timestamp>.bin`: manifest-safe copy of the pre-migration monolith for downgrade recovery.

`kvSet()` routes `database/database.bin`, `database/dbbackup-*`, and `chats/*` through the chunk store (`isChunkableKey()` at `server/node/chunkStore.cjs:50`). Values at or below the threshold remain ordinary KV rows; only large values receive manifests.

Chunks use deterministic FastCDC-style boundaries: minimum 4 KiB, maximum 64 KiB, approximately 16 KiB average, and SHA-256 content hashes at `server/node/chunkStore.cjs:17`. Values larger than 16 MiB are represented in `kv.value` by `CHUNK_MARKER`; reads concatenate manifest chunks through the bound store created at `server/node/chunkStore.cjs:60`.

### Main persistence flow

#### Initial database load

- `bootstrap.loadData()` rejects insecure non-local browser contexts unless the server injected the explicit bypass, initializes `AutoStorage`, then calls `readDatabaseForBoot()` at `src/ts/bootstrap.ts:126`.
- `AutoStorage` always selects `NodeStorage` at `src/ts/storage/autoStorage.ts:35`.
- With the browser resource cache disabled, `readDatabaseForBoot()` uses the universal `GET /api/read` path. With it enabled, the client verifies resident IndexedDB segments, advertises up to 8,192 hashes grouped as root/characters/botPresets/modules/personas, and calls `POST /api/db/read-cached` (`src/ts/storage/nodeStorage.ts:412`).
- The cached-read endpoint flushes pending writes, prepares the same stubs-only view and ETag as `/api/read`, MessagePack-encodes each group member separately, and returns `{hash}` for advertised hits or `{bytes}` for misses. Any malformed envelope, missing/corrupt local entry, unadvertised hit, or ETag disagreement makes the client retry the ordinary full read.
- `/api/read` flushes pending saves, decodes and normalizes the stubs-only live row, caches it, and sends the legacy-encoded stripped database plus `x-db-etag`. If a full chat payload or folded optimized plugin storage leaked into the live row, it defensively routes that object through `ingestDatabase()` first.
- Monolith-shaped inputs from boot migration, backup/snapshot restore, save-folder import, or defensive route recovery pass through `ingestDatabase()`. Supported raw or gzip/zlib MessagePack inputs above `RISU_STREAM_INGEST_MIN_BYTES` route to `ingestStreamingDatabase()`: the walker retains byte offsets for the root and character fields, decodes one chat at a time, and writes chat rows plus the stripped DB in one transaction without constructing or persisting the full monolith. Missing-ID assignment, duplicate handling, orphan-folder normalization, stub projection, cold-storage restoration, stale-row sweeping, and optimized plugin splitting share the same semantics as `ingestFullDatabase()`. Legacy block saves, bare deflate/JSON fallbacks, and unsupported compressed payloads retain the in-memory decoder.
- The HTML root injects `globalThis.__NODE__` and `globalThis.__PATCH_SYNC__` at `server/node/server.cjs:2474`; `src/ts/platform.ts:17` turns those into frontend feature flags.

#### Patch save and full-write fallback

- `persistTrackedChanges()` first saves changed full chats individually, then encodes `database.bin` with chat stubs at `src/ts/globalApi.svelte.ts:779`.
- When patch sync is enabled, it calls `NodeStorage.patchItem()` through `forageStorage` at `src/ts/globalApi.svelte.ts:996`.
- `/api/patch` loads or reuses the stripped `dbCache`, checks the client’s compositional hash, validates chat paths, applies RFC 6902 operations to a clone, externalizes any whole-chat payload operations, deletes rows for removed stubs, updates the stripped-view ETag, and schedules persistence after five seconds at `server/node/server.cjs:3683`.
- The timer calls `persistDbCache()`, which defensively re-externalizes any folded optimized plugin data before encoding and writing the stripped cache.
- Patch conflicts or chat-guard rejections cause the frontend to fall back to `NodeStorage.setItem()` and `/api/write` at `src/ts/globalApi.svelte.ts:1014`.
- `/api/write` checks the stripped-view ETag, validates the incoming object, externalizes folded optimized plugin data and any payload-bearing chats, writes one combined stripped row, and performs targeted chat-row cleanup when the prior stripped cache is available. A normal already-stripped write preserves the client bytes verbatim.
- Storage mutations run through the promise-based `queueStorageOperation()` serialization point at `server/node/server.cjs:102`.

#### Hash-aware resource and key-list reads

- When the opt-in browser resource cache is enabled, ordinary non-database KV reads and chat-row reads advertise locally resident SHA-256 values in `x-cached-hashes`. `/api/read` and the chat endpoint return `204` plus `x-content-hash` on a match; otherwise they return authoritative bytes. The browser re-hashes cached bytes before decoding and retries without the cache header on any inconsistency.
- `/api/write` and the chat POST return the authoritative content hash so successful client writes can seed the disposable cache without downloading the same bytes again.
- `GET /api/list` supports full and delta responses. `NodeStorage.keys()` caches each prefix's key set, timestamp, and server epoch in a small separate IndexedDB database; a valid delta merges `added`/`deleted`, while missing, stale (older than six days), future-dated, or epoch-mismatched state receives a full list.
- SQLite `updated_at`, the `deleted_keys` journal, filesystem asset/inlay mtimes, and `sync_meta.list_epoch` are the protocol sources. Deletion records are retained for seven days and cleaned at boot plus hourly.

#### Externalized chat content

- `createChatRowStore()` is constructed once against the real SQLite-backed KV functions at `server/node/server.cjs:80`. Runtime chat bodies are never retained in a server-wide in-memory map.
- `GET /api/chat-content/:chaId/:chatIndex` reads `chats/<chaId>/<chatId>` directly, with stripped-DB index fallback and mismatch detection at `server/node/server.cjs:5022`. It publishes `x-content-hash`, supports verified `204` cache hits, and returns raw row bytes unless cold-storage rehydration was needed, in which case the restored chat is written back once.
- `POST /api/chat-content/:chaId/:chatIndex` validates the body and writes the row synchronously inside `queueStorageOperation()` at `server/node/server.cjs:5076`. Immediately before overwrite it asks `chatBackups.cjs` to capture the exact old raw row, optionally tagged by `x-chat-backup-reason`; capture is best-effort and never blocks the authoritative save. The route rejects bare stubs, heals hybrid `_stub` payloads, returns the stored row hash, and does not involve the five-second DB timer.
- Frontend placeholders are hydrated through `fetchChatFromServer()` and `ensureChatHydrated()` at `src/ts/storage/chatStorage.ts:124` and `src/ts/storage/chatStorage.ts:184`.
- Metadata fields retained in stubs are exactly `id`, `name`, `_stub`, `lastDate`, `folderId`, and `modules`; the server allowlist is at `server/node/server.cjs:535`, shared stub/overlay semantics are in `server/node/chatRows.cjs:33`, and the matching client projection is at `src/ts/storage/chatStorage.ts:40`.

#### Assets and inlays

- Ordinary assets are filesystem files in `save/assets/` when the key's basename is a safe filename (`server/node/assetStore.cjs`); unsafe names stay as raw `assets/*` KV rows. Reads/lists/stats/backups merge both sources. Writes are temp-file + rename (never in place — files may be hardlinked across instances by `scripts/dedup-assets.sh`). Uploads whose name matches `assets/<64-hex>.<ext>` are SHA-256-verified against their content on `/api/write` and `/api/assets/bulk-write` (400 on mismatch; identical re-uploads are skipped to preserve hardlinks); backup/legacy imports log mismatches but import verbatim. A one-time startup migration (`migrateAssetsToFilesystem()`) moves safe-named KV assets to files, marker `save/assets/.migrated_to_fs`.
- Inlays are migrated from legacy `inlay/*` KV JSON to `save/inlays/<id>.<ext>` plus a sidecar by `migrateInlaysToFilesystem()` at `server/node/server.cjs:1302`.
- Legacy key/value APIs synthesize the old JSON payload when reading inlays through `readInlayAssetPayload()` at `server/node/server.cjs:1282`.
- `GET /api/asset/:hexKey` serves assets with a cookie-authenticated direct URL, MIME detection, immutable caching, and `updated_at` or filesystem-mtime ETags at `server/node/server.cjs:3083`.
- Inlay thumbnails are generated on demand with `wasm-vips` at `server/node/server.cjs:3069`; bulk WebP conversion is exposed as SSE at `server/node/server.cjs:5572`.
- `getFileSrc()` switches Node deployments to direct asset URLs at `src/ts/globalApi.svelte.ts:113`.

#### Backup and migration flow

- The binary backup framing is `[nameLength:u32LE][UTF-8 name][dataLength:u32LE][data]`, encoded by `encodeBackupEntry()` and consumed by the state machine in `importBackupFromSource()`.
- Portable and server backups never contain `chats/` entries. `buildSelfContainedBackupDatabase()` now returns a temporary `{ filePath, size }` spool instead of a monolithic Buffer. `streamRisuSaveToFile()` writes the legacy magic header plus standard MessagePack incrementally, merging each stub with one decoded chat row and releasing it before the next. Node-only exports keep `pluginsave/` and `pluginsave-meta/` values as byte-preserving per-row archive entries; `?target=upstream` overlays those rows into hand-written MessagePack maps one parsed value at a time.
- `/api/backup/export` flushes pending data, uses the spool size for `content-length` and the `database.risudat` entry header, then streams the file bytes into the response. `?target=upstream` deliberately omits all Node-only slashed namespaces (plugin rows and inlays), because upstream treats them as asset paths. The spool is unlinked after success, encoding/response errors, or client disconnect.
- `/api/backup/import` parses archive headers incrementally and writes `database.risudat` directly to a unique `.tmp` spool instead of adding it to the pending Buffer chunks. Once every archive entry is present, supported large saves are walked and ingested inside the already-open import transaction; only the stripped `database.bin`, chat rows, plugin rows, and markers commit. The spool is unlinked on success, parse/decode failure, rollback, and disconnect. Small or exotic formats are read from the spool and retain the historical in-memory post-commit ingest. An `encryption.risudat` header aborts immediately with guidance to re-export an unencrypted risuai.xyz account backup.
- Server-side backups use the same format but write `risu-backup-<timestamp>.bin` under the configured backup directory. Save spools the assembled database first so progress has its true byte count, streams its entry header and file bytes into the archive `.tmp`, then atomically renames the completed archive; both temporary files are cleaned on failure or disconnect. Save/list/restore/delete/download begin at `server/node/server.cjs:4224`.
- Legacy save folders consist of files whose filenames are hex-encoded logical KV keys. Successful directory and ZIP imports externalize chat payloads and folded optimized plugin storage through the same ingest boundary; directory imports walk the database file directly, while ZIP imports walk its already off-heap Buffer. Supported large inputs skip the monolithic live-KV write.
- Automatic snapshots use the same row-at-a-time disk spool, then read only the completed encoded file into a Buffer required by `kvSet()` and store it under `database/dbbackup-*` at `server/node/server.cjs:231`. This retains the final encoded-buffer allocation but removes the simultaneous full chat object tree. Rotation recomputes exclusive chunk footprints after each deletion (`server/node/server.cjs:192`).
- Snapshot restore walks a supported large snapshot Buffer directly and atomically replaces the live stripped DB plus chat rows without first copying the monolith into the live key. Small and exotic snapshots retain the copy-then-legacy-ingest path. Server-backup restore uses the same disk-spooled archive importer as upload restore.
- Chat version history is a separate recovery mechanism and is not embedded in portable/server `.bin` archives. Each eligible chat overwrite captures the pre-image under `<savePath>/chat-backups/<chaId>/<chatId>` by default, or the final directory selected by `POCKETRISU_CHAT_BACKUP_DIR`, at most once per 45 seconds. Startup migrates files from the legacy `<backupsDir>/chat-backups` tree before reconciliation, using per-file renames with a copy-and-unlink fallback across filesystems; conflicting destination bytes leave the legacy source untouched. Reconciliation gzip-compresses loose versions, combines each 25 into a solid gzip bundle with a metadata sidecar, retains four bundles per chat, and evicts oldest non-latest items to satisfy the global budget. The settings UI lists versions even for deleted characters/chats and imports one as a new chat ID through the normal client save pipeline.

### HTTP API route catalog

| Family | Routes and purpose | Primary frontend callers |
|---|---|---|
| SPA/static | `GET /` injects Node/cache/security flags and returns `dist/index.html`; `/assets` and other `dist` files are static. Static middleware: `server/node/server.cjs:715`; root: `server/node/server.cjs:2741`. | Browser navigation and Vite-built imports. |
| General proxy | `GET/POST/PUT/PATCH/DELETE /proxy` and `/proxy2` relay authenticated arbitrary upstream HTTP; `GET/POST /hub-proxy/*` relays RisuAI Hub traffic. Routes begin at `server/node/server.cjs:3187`. | `fetchWithProxy()`/`fetchViaProxy2()` in `src/ts/globalApi.svelte.ts`; hub base in `src/ts/characterCards.ts`. |
| Local streaming proxy | `POST /proxy-stream-jobs` creates a local/private-network-only job; `DELETE /proxy-stream-jobs/:jobId` aborts it; WebSocket `/proxy-stream-jobs/:jobId/ws` transports headers and base64 chunks. HTTP routes: `server/node/server.cjs:3202`; upgrade handler: `server/node/server.cjs:1870`. | `fetchViaProxyJobWs()` at `src/ts/globalApi.svelte.ts:2210`. |
| Authentication/session | `GET /api/test_auth`, `POST /api/login`, `POST /api/token/refresh`, `POST /api/session`, `POST /api/set_password`, and `POST /api/crypto`. Routes begin at `server/node/server.cjs:3278`. | `NodeStorage` auth lifecycle beginning at `src/ts/storage/nodeStorage.ts:151`; password hashing at `src/ts/storage/nodeStorage.ts:1093`. |
| Provider credentials | `POST /api/model-preset/google-service-account/token` signs a Google service-account JWT server-side and exchanges it only at Google’s documented OAuth endpoint. Route: `server/node/server.cjs:3506`. | `src/ts/preset/adapter/googleServiceAccount/token.ts:15`. |
| Key/value storage | `GET /api/read`, segmented `POST /api/db/read-cached`, `GET /api/remove`, full/delta `GET /api/list`, `POST /api/write`, `POST /api/patch`, and cookie-authenticated `POST /api/db/flush`. Core read routes begin at `server/node/server.cjs:3598`. | `NodeStorage` methods beginning at `src/ts/storage/nodeStorage.ts:298`; boot read at `:412`; keepalive flush in `src/ts/globalApi.svelte.ts`. |
| Asset serving/bulk | `GET /api/asset/:hexKey`, `POST /api/assets/bulk-read`, and `POST /api/assets/bulk-write`. Routes: `server/node/server.cjs:3400` and `server/node/server.cjs:4180`. | Direct URLs from `src/ts/globalApi.svelte.ts`; bulk methods in `src/ts/storage/nodeStorage.ts`. |
| Logs | `POST /api/logs` ingests client batches, `GET /api/logs` filters/paginates, and `DELETE /api/logs` clears. Routes begin at `server/node/server.cjs:3782`. | Batch uploader in `src/ts/log.ts`; settings queries in `SystemSettings.svelte`. |
| Portable backup | `GET /api/backup/export`, `POST /api/backup/import/prepare`, and streamed `POST /api/backup/import`. Routes begin at `server/node/server.cjs:4303`. | `NodeStorage.exportBackup()`, `prepareImport()`, and `importBackup()`. |
| Server backup | `POST /api/backup/server/save`, `GET .../list`, `POST .../restore`, `DELETE .../:filename`, and `GET .../download/:filename`. Routes begin at `server/node/server.cjs:4546`. | `NodeStorage` server-backup methods. |
| Chat-version recovery | `GET /api/chat-backups`, `GET /api/chat-backups/:chaId/:chatId`, and `GET /api/chat-backups/:chaId/:chatId/:versionId` list histories and return one raw pre-image. Routes begin at `server/node/server.cjs:4853`. | `NodeStorage` chat-backup methods and `src/lib/Setting/ChatBackupList.svelte`. |
| Backup settings | `GET/PUT /api/backup/boot-reminder` and `GET/PUT /api/backup/server/path`. Routes begin at `server/node/server.cjs:6117`. | `SystemBackup.svelte`; boot prompt in `src/ts/bootstrap.ts`. |
| Lazy chats | `GET/POST /api/chat-content/:chaId/:chatIndex` reads/writes individual chat rows, negotiates cached hashes, and captures eligible pre-images before overwrite. Routes: `server/node/server.cjs:5022` and `server/node/server.cjs:5076`. | `NodeStorage.fetchChatContent()` and `saveChatContent()` at `src/ts/storage/nodeStorage.ts:918`. |
| Save-folder migration | `POST /api/migrate/save-folder/scan`, `/execute`, `/upload`, `/cleanup/scan`, and `/cleanup/execute`. Routes begin at `server/node/server.cjs:5310`. | `NodeStorage` migration methods. |
| Storage dashboard | `GET /api/db/stats`, `/characters`, and `/modules`; `POST /api/db/optimize`; `POST /api/db/wal-checkpoint`. Routes begin at `server/node/server.cjs:5562`; optimize and chat-row sweep begin at `server/node/server.cjs:5885`. | `SystemDashboard.svelte`. |
| DB snapshots | `GET/PUT /api/db/snapshots/limits`, `GET/DELETE /api/db/snapshots`, and `POST /api/db/snapshots/restore`. Routes begin at `server/node/server.cjs:5971`. | `SystemBackup.svelte`. |
| Inlay maintenance | Cookie-authenticated `POST /api/inlays/compress`, streamed as SSE. Route: `server/node/server.cjs:6203`. | `src/lib/Setting/Pages/Advanced/InlayCompressButton.svelte`. |
| Public/update | Unauthenticated `GET /api/public-stats` and `GET /api/update-check`; authenticated `POST /api/self-update`. Routes begin at `server/node/server.cjs:6276`. | `src/ts/publicStats.ts` and `src/ts/update.ts`. |

## 4. Entry points & dependencies

### Inbound entry points

- Production/self-hosted startup is `pnpm run runserver` → `server/node/server.cjs`, declared at `package.json:19`.
- Portable launchers and Termux scripts also execute the same file; `server.cjs` assumes `process.cwd()` is the PocketRisu application root.
- The frontend storage entry is the singleton `forageStorage = new AutoStorage()` at `src/ts/globalApi.svelte.ts:31`. `AutoStorage` constructs `NodeStorage`, which owns the HTTP contract.
- Direct settings-page fetches bypass `NodeStorage.authFetch()` for storage dashboards, snapshots, log viewing, update UI, and some backup preferences; their route references are listed above.
- The Hono entry points are runtime-specific exports or executables: `server/hono/src/bun.ts:1`, `server/hono/src/cf.ts:1`, and `server/hono/src/node.ts:1`.

### Outbound dependencies

- `better-sqlite3` supplies synchronous application and log databases (`server/node/db.cjs:3`, `server/node/logs.cjs:3`).
- `msgpackr` and `fflate` implement RisuAI save compatibility in `server/node/utils.cjs:1`.
- `fast-json-patch` applies client patches at `server/node/server.cjs:33`.
- Express, `compression`, `express-rate-limit`, and `node-html-parser` provide HTTP routing, response compression, login throttling, and root-page flag injection.
- `ws` supplies the proxy-job WebSocket server at `server/node/server.cjs:14`.
- `wasm-vips` generates thumbnails and compresses inlays at `server/node/server.cjs:15`.
- Native `fetch` calls arbitrary authenticated proxy targets, `https://sv.risuai.xyz` for Hub traffic, Google OAuth, the configured PocketRisu update worker, and GitHub release assets.
- `child_process.spawn()` runs restart helpers; `execSync()` invokes platform archive tools during self-update.
- `server/hono/` depends only on Hono and `@hono/node-server`, declared at `server/hono/package.json:11`; it does not reuse the Node database, serialization, or route code.

## 5. Conventions & gotchas

- **Working directory is part of the contract.** Storage, `dist/`, backups, package version, TLS certificates, binaries, and update paths are all based on `process.cwd()`, not `__dirname`; examples include `server/node/db.cjs:8`, `server/node/server.cjs:760`, and `server/node/server.cjs:773`. Starting from another directory creates/reads the wrong data tree.

- **The server does not parse `.env`.** Variables must already be in the process environment. The updater preserves `.env`, but `server.cjs` contains no dotenv or `--env-file` handling.

- **Runtime requirements are slightly inconsistent.** Root `package.json` declares Node `>=22.12.0` at `package.json:6`, while the server warns for any major version below 24 at `server/node/server.cjs:93`.

- **Authentication is NodeOnly-specific.** PocketRisu replaced upstream’s browser-side ECDSA flow with server-issued HMAC-SHA256 JWTs because remote HTTP is not a browser secure context; see `createServerJwt()` at `server/node/server.cjs:1504` and the matching client warning at `src/ts/storage/nodeStorage.ts:1`. JWT lifetime is five minutes, while direct-asset session cookies last seven days.

- **The password file contains whatever `/api/set_password` receives.** The official client first hashes the user input through unauthenticated `/api/crypto` and stores that digest as the password (`src/ts/storage/nodeStorage.ts:1093`, `server/node/server.cjs:3489`). Changing either side independently breaks login compatibility.

- **Most authenticated routes return HTTP 400 for missing/expired/invalid JWTs, not consistently 401.** `NodeStorage.shouldRetryAuth()` explicitly understands these response bodies at `src/ts/storage/nodeStorage.ts:257`.

- **Direct asset URLs cannot send `risu-auth`.** `/api/session` therefore persists opaque cookie tokens in `save/__sessions`, and `/api/asset`, `/api/db/flush`, and `/api/inlays/compress` use `sessionAuthMiddleware()` at `server/node/server.cjs:1418`.

- **The writer lock is compatibility-optional.** The last `/api/session` caller supplying `x-session-id` becomes the active writer, but `checkActiveSession()` allows requests with no `x-session-id` at `server/node/server.cjs:1461`. New mutation callers should send the header if they should participate in cross-device exclusion.

- **`GET /api/remove` is intentionally a mutating GET.** This odd API is mirrored by `NodeStorage.removeItem()` at `src/ts/storage/nodeStorage.ts:512`; changing its verb requires a coordinated frontend compatibility change.

- **Patch sync and chat lazy loading are inseparable.** The patch baseline and live `database.bin` are stubs-only, while full messages live in chat rows. Any new stub metadata field must be added to shared `chatToStub()`/merge semantics, the server allowlist, and the client conversion (`server/node/chatRows.cjs:33`, `server/node/chatRows.cjs:150`, `server/node/server.cjs:535`, `src/ts/storage/chatStorage.ts:40`).

- **Key presence is semantically meaningful for stub metadata.** Explicit `null`/`undefined` means “the user cleared this value”; it must overwrite the full chat. Do not replace the `in` checks in `mergeChatStubWithFullChat()` with nullish checks (`server/node/chatRows.cjs:150`).

- **There are multiple chat-corruption guards.** Field-level patch operations outside the stub allowlist are rejected through `findChatInternalFieldOps()` at `server/node/server.cjs:565`; debounced stripped writes and full `/api/write` requests both reject metadata-only chats through `findStubFlagLossChats()`. Removing one reopens the v1.4.x silent message-loss path.

- **Chat rows must go through `chatRows.cjs`.** Key components are URI-encoded, large rows may have chunk manifests, and the row wire format must match `/api/chat-content`. Use `readChatRow()`, `writeChatRow()`/`writeChatRowRaw()`, and `deleteChatRow()` instead of hand-built keys or direct SQL (`server/node/chatRows.cjs:15`, `server/node/chatRows.cjs:166`).

- **Chat deletion is layered.** Patch operations and cache-warm full writes call `deleteRemovedChatRows()` for exact old-minus-new stub removal (`server/node/chatRows.cjs:240`). `/api/db/optimize` additionally sweeps every unreferenced `chats/` row, but preserves rows updated within the last hour so a chat POST that arrives before its stub is not lost (`server/node/chatRows.cjs:252`, `server/node/server.cjs:5885`). Snapshot restore is safe because snapshots contain full assembled monoliths and recreate their rows through ingest.

- **Chat backups are pre-images, not post-save snapshots.** `captureChatPreImage()` must stay immediately before the chat-row write inside the shared storage queue. Capture failures are logged and swallowed so recovery history cannot make the primary save fail. The newest version for each chat is protected during global budget eviction, but the 45-second cooldown means not every intermediate streaming/edit state is retained.

- **Chat backup archives are filesystem-internal.** IDs are path-component encoded, version IDs and reasons are strictly sanitized, and `.bundle` offsets are trusted only through a matching metadata sidecar. Use `chatBackups.cjs` rather than reading or rewriting this tree ad hoc.

- **Downgrading after chat externalization is unsupported.** Older servers interpret the live stubs-only blob as the whole database. Recovery for a downgrade is the boot-created `migration-backup/pre-chat-externalization-*` copy or another full pre-migration snapshot; boot migration and safety copy are at `server/node/server.cjs:389`.

- **Optimized folded plugin storage is split with rows first.** `externalizePluginStorageIfNeeded()` uses unpadded canonical base64url keys and exact UTF-8 `JSON.stringify(value)` bytes. It writes or overwrites all rows before callers persist the `{ pluginCustomStorage: {} }` stub and deleted `pluginStorageMeta`; preserve that ordering so a crash leaves a recoverable inline copy. A falsy `optimizePluginMemory` is legitimate inline mode and must not be split.

- **Patch persistence is debounced.** `/api/patch` acknowledges after mutating memory, then writes five seconds later (`server/node/server.cjs:4008`). Failures cannot be returned on the triggering request, so `recordPersistFailure()` surfaces them on the next patch response. Reads, backups, maintenance, shutdown, and the browser keepalive route explicitly flush pending data.

- **ETags describe the stripped client view.** This now matches the stubs-only live row, but not assembled snapshots or portable backups. Full writes and patches must preserve that convention or clients will report false concurrent-modification conflicts; see `/api/read` at `server/node/server.cjs:3598` and `/api/write` at `server/node/server.cjs:3849`.

- **The browser resource cache is never authoritative.** A cached database segment may be referenced only if the client advertised its hash, still has its bytes, and re-verifies SHA-256 before decoding. The assembled envelope ETag must match the response header. KV/chat `204` responses likewise require a locally advertised and re-hashed entry; every failure falls back to an unconditional server read.

- **Delta lists depend on both timestamps and an epoch.** `kvSet()` clears a matching tombstone after the live write, and client merge gives additions precedence if a crash exposes both records. Prefix deletes must journal keys before removal. Keep the seven-day tombstone retention longer than the six-day delta eligibility window, and bump the list epoch when a migration invalidates history.

- **The compositional patch hash must remain byte-for-byte algorithmically aligned with the frontend.** Property iteration order and normalization behavior in `calculateHash()`/`normalizeJSON()` are observable protocol details, not general-purpose utilities.

- **RisuSave constants and defaults are duplicated across server and client.** `RisuSaveType` and `presetTemplate` explicitly require synchronization at `server/node/utils.cjs:12` and `server/node/utils.cjs:57`.

- **Legacy `REMOTE` data is migrated, not merely ignored.** `migrateRemoteBlocksIfNeeded()` makes a dedicated safety backup, resolves `remotes/<name>.local.bin`, writes an inline legacy save, and keeps the old remote rows so pre-migration snapshots remain restorable (`server/node/server.cjs:303`).

- **Cold-storage formats are another upstream compatibility boundary.** Canonical runtime rows are gzipped `coldstorage/<uuid>`, while backup entries are plain JSON named `coldstorage/<uuid>.json`; normalization is at `server/node/server.cjs:1973`. Failed character restores are converted to safe blank characters but retain a recovery breadcrumb at `server/node/server.cjs:4401`.

- **Inlay payloads no longer live in SQLite.** Storage stats and backups must explicitly include `save/inlays`; `sumInlayFsBytes()` exists because KV prefix totals underreport them at `server/node/server.cjs:4943`.

- **Asset payloads mostly no longer live in SQLite either.** Safe-named `assets/*` values are files in `save/assets/`; only unsafe names remain KV rows. Never write an asset file in place — always temp-file + rename (`writeAssetFile()`), or an externally hardlinked copy in another instance would be corrupted. Anything enumerating or deleting assets must use the merged dual-source helpers (`listAssetEntriesWithSizes()`, `readAssetValue()`, `deleteAssetValue()`, `clearAllAssets()`), not `kvListWithSizes('assets/')` alone. Backup import stages asset files in `save/assets_import_staging/` and swaps atomically with rollback.

- **Chunk-aware deletion matters.** `kvDel()` must go through `chunkStore.dropValue()` so snapshot manifests stop pinning chunks (`server/node/db.cjs:162`). Direct SQL deletion of a chunked logical key leaves a stale manifest until GC repairs it.

- **Chat dashboard totals are chunk-aware.** The `chats/` prefix total sums `kvSize()` for each logical row; `LENGTH(kv.value)` would report only the 13-byte marker for a chunked chat. The stats response also separates chat KV-row and referenced-chunk bytes so the dashboard can allocate physical storage without double-counting the shared chunk table (`server/node/server.cjs:5562`).

- **Chunk GC is deliberately off the save hot path.** Replaced chunks become orphans and are reclaimed during `/api/db/optimize`; see `server/node/server.cjs:5885`.

- **Snapshot “size” has two meanings.** Rotation limits use exclusive physical chunk cost: chunks referenced by that manifest and no other manifest (`snapshotCostExclusive()` at `server/node/chunkStore.cjs:169`). The list endpoint reports logical reassembled DB size at `server/node/server.cjs:5582`. Do not substitute `LENGTH(kv.value)`, which is only the marker for chunked values.

- **Automatic snapshot timestamps use 100 ms units.** Creation divides `Date.now()` by 100 at `server/node/server.cjs:238`; listing multiplies the parsed value by 100 near `server/node/server.cjs:5572`.

- **Backup stream responses must remain uncompressed and incrementally flushed.** `shouldCompress()` excludes proxy, download, SSE, and NDJSON cases at `server/node/server.cjs:677`. Re-enabling gzip can buffer heartbeats and reintroduce reverse-proxy timeouts.

- **Backup imports are destructive replacement operations.** The streamed import removes current asset, inlay, cold-storage, draft, remote, and chat data before inserting new content, then ingests the database spool before commit when the format and threshold allow it. Preserve its pre-import snapshot, unique temp spool, unlink-on-all-paths cleanup, SQLite transaction, atomic filesystem swaps, and legacy fallback behavior.

- **`/proxy` and proxy jobs have different trust models.** Authenticated `/proxy` and `/proxy2` accept general HTTP(S) targets, while job/WebSocket streaming validates local/private hosts through `sanitizeTargetUrl()` at `server/node/server.cjs:1619`. Do not reuse the unrestricted proxy path for the local-network feature.

- **`/hub-proxy/*` is not universally guarded by `checkAuth()`.** It checks PocketRisu auth only for the special `X-Node-Server-Auth` flow at `server/node/server.cjs:2801`; changes to its target/header behavior need a deliberate compatibility and security review.

- **Tailscale has no backend implementation.** It is an external reverse-access recommendation using `tailscale serve --bg http://localhost:6001`, documented in `docs/en/remote.md`.

- **Self-update is portable-only and mutates the installation tree.** Deployment type is inferred near `server/node/server.cjs:855`, and only a `.portable` deployment can call the replacement flow at `server/node/server.cjs:6307`. The keep sets, rollback staging, Windows locked-binary handling, and restart logic are data-safety behavior.

- **Logs are a separate bounded database.** Rows are rotated to approximately 5,000, descriptions are truncated, and common JWT/API-key patterns are masked before persistence (`server/node/logs.cjs:8`, `server/node/logs.cjs:62`). Keep the server `BACKGROUND_SOURCES` list synchronized with the frontend logs settings as noted at `server/node/logs.cjs:55`.

- **Fatal logging intentionally terminates the process.** `uncaughtException` and `unhandledRejection` synchronously persist a record and call `process.exit(1)` at `server/node/logs.cjs:319`.

- **The SSL helper is local-development oriented.** Its certificate SANs cover only localhost, and the shell helper sets private keys to mode `0644` at `server/node/ssl/Generate Certificate.sh:7`; do not treat it as a hardened public-deployment certificate setup.

- **The Hono tree is not feature-compatible.** It has only `GET /`, CSRF, and optional static serving. Moreover, `server/hono/package.json:5` references missing `src/index.ts`, and `server/hono/wrangler.jsonc:3` references missing `src/index.js`. Treat it as scaffold code rather than an alternate PocketRisu backend.

## 6. Navigation hints

- To add or change an HTTP route, start at the route block in `server/node/server.cjs:2741`; keep error middleware after all routes at `server/node/server.cjs:6663`.

- To change request-size limits, static caching, compression, or streaming behavior, inspect middleware beginning at `server/node/server.cjs:677`.

- To change server startup, port, bind host, HTTP/HTTPS selection, WebSocket setup, or shutdown behavior, inspect `startServer()` at `server/node/server.cjs:6698` and the IIFE at `server/node/server.cjs:6749`.

- To add an environment variable, follow the existing direct `process.env` reads near the top-level configuration and `startServer()`, and document how the launcher supplies it.

- To change authentication or token lifetime, update `createServerJwt()` and `checkAuth()` at `server/node/server.cjs:1504` and `server/node/server.cjs:2760`, plus `NodeStorage` beginning at `src/ts/storage/nodeStorage.ts:151`.

- To change direct asset authorization, inspect session persistence at `server/node/server.cjs:1388`, session issuance at `server/node/server.cjs:3319`, and asset serving at `server/node/server.cjs:3400`.

- To change generic KV behavior or SQLite tuning, inspect `server/node/db.cjs:9` and its exported operations at `server/node/db.cjs:288`.

- To change large-blob thresholds, chunk boundaries, snapshot sharing, or GC, inspect `server/node/chunkStore.cjs:17`, `server/node/chunkStore.cjs:50`, and tests beginning at `server/node/chunkStore.test.ts:95`.

- To change database read/write synchronization, inspect `/api/read` and `/api/db/read-cached` at `server/node/server.cjs:3598`, `server/node/dbCachedRead.cjs`, `/api/write`, and `NodeStorage.readDatabaseForBoot()` at `src/ts/storage/nodeStorage.ts:412`.

- To change verified browser-cache negotiation, update `parseCachedHashesHeader()`/`sha256Hex()` in `server/node/utils.cjs`, the hash-aware `/api/read` and chat branches, and `src/ts/storage/resourceCache.ts` together.

- To change key-list delta semantics, update `server/node/listDelta.cjs`, the deletion/epoch helpers in `server/node/db.cjs`, `/api/list`, and `NodeStorage.keys()` together.

- To change patch sync, inspect `findChatInternalFieldOps()` at `server/node/server.cjs:565`, `persistDbCache()` at `server/node/server.cjs:639`, and `/api/patch` at `server/node/server.cjs:4008`.

- To add chat-level metadata, update `chatToStub()` and merge semantics at `server/node/chatRows.cjs:33` and `server/node/chatRows.cjs:150`, the server allowlist at `server/node/server.cjs:535`, and the client equivalent at `src/ts/storage/chatStorage.ts:40`.

- To change chat-row keys, encoding, assembly, or orphan cleanup, start in `server/node/chatRows.cjs:15`; tests begin at `server/node/chatRows.test.ts:133`.

- To change chat hydration or persistence, inspect the chat endpoints at `server/node/server.cjs:5022`, the client adapter at `src/ts/storage/nodeStorage.ts:918`, and runtime hydration at `src/ts/storage/chatStorage.ts:124`.

- To change per-chat history capture, retention, bundle format, or budget, start in `server/node/chatBackups.cjs:1`, the capture call at `server/node/server.cjs:5110`, the three `/api/chat-backups` routes at `server/node/server.cjs:4853`, and the client import UI in `src/lib/Setting/ChatBackupList.svelte`.

- To change RisuAI save-format compatibility, inspect format detection/decoding at `server/node/utils.cjs:154`, `server/node/utils.cjs:204`, and `server/node/utils.cjs:369`; compare coordinated client behavior before changing constants.

- To change monolith ingestion, optimized plugin re-externalization, or boot chat migration, inspect `ingestDatabase()`, `server/node/streamRisuLoad.cjs`, `server/node/chatRows.cjs`'s `ingestFullDatabase()` and `ingestStreamingDatabase()`, `externalizePluginStorageIfNeeded()`, and `migrateChatsToRowsIfNeeded()`.

- To change legacy remote-block migration, inspect `migrateRemoteBlocksIfNeeded()` at `server/node/server.cjs:359`.

- To change cold-storage recovery, inspect the canonical key/encoding helpers at `server/node/server.cjs:2032` and character/chat restoration at `server/node/server.cjs:4904`.

- To change asset storage, inspect `server/node/assetStore.cjs` plus `/api/read` and `/api/write` prefix special cases at `server/node/server.cjs:3598` and `server/node/server.cjs:3849`.

- To change inlay filesystem layout or migration, inspect path validation around `server/node/server.cjs:899`, file helpers around `server/node/server.cjs:907`, and `migrateInlaysToFilesystem()` at `server/node/server.cjs:1169`.

- To change backup framing or compatibility, inspect `encodeBackupEntry()` at `server/node/server.cjs:1950` and assembled database spooling at `server/node/server.cjs:2230`.

- To change streamed backup import, inspect `importBackupFromSource()` at `server/node/server.cjs:2359` and `/api/backup/import` at `server/node/server.cjs:4449`.

- To change server-side backup files or their directory, inspect initialization near `server/node/server.cjs:780`, route handling at `server/node/server.cjs:4546`, and path configuration at `server/node/server.cjs:6148`.

- To change snapshot creation, retention, or cost accounting, inspect `createBackupAndRotate()` at `server/node/server.cjs:281`, `snapshotFootprint()` at `server/node/db.cjs:275`, and snapshot routes at `server/node/server.cjs:5971`.

- To change storage-dashboard calculations or orphan cleanup, inspect `buildUncleanableSet()` at `server/node/server.cjs:5480`, `/api/db/stats` at `server/node/server.cjs:5562`, and `/api/db/optimize` at `server/node/server.cjs:5885`; keep asset reachability synchronized with `getUncleanables()` at `src/ts/globalApi.svelte.ts:1512`.

- To change logging retention, filtering, or masking, inspect `server/node/logs.cjs:8`, `server/node/logs.cjs:62`, and `server/node/logs.cjs:257`.

- To change local-network model streaming, inspect URL validation at `server/node/server.cjs:1619`, job execution at `server/node/server.cjs:1818`, WebSockets at `server/node/server.cjs:1870`, and the frontend transport at `src/ts/globalApi.svelte.ts:2210`.

- To change update checks, inspect `fetchLatestRelease()` at `server/node/server.cjs:1359` and `src/ts/update.ts:35`.

- To change portable self-update or restart behavior, inspect the endpoint at `server/node/server.cjs:6307`; coordinate with the standalone updater rather than editing one implementation in isolation.

- To make Hono functional, begin with the shared app at `server/hono/src/app/index.ts:4`, but plan explicit replacements for authentication, SQLite/chunk storage, backup streaming, WebSockets, and runtime-specific filesystem/process features.

## Out of scope, noticed

- `src/ts/storage/nodeStorage.ts` and `src/ts/storage/autoStorage.ts` are the frontend-side protocol adapters and should be documented with the frontend storage subsystem.
- `src/ts/globalApi.svelte.ts` and `src/ts/storage/chatStorage.ts` own save scheduling, proxy selection, and chat hydration on the client.
- `scripts/updater.cjs` contains a standalone portable update path parallel to the in-server `/api/self-update` implementation.
- `docs/*/remote.md` documents external Tailscale setup; no Tailscale process management exists under `server/`.
