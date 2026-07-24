# server-backend

> Part of the PocketRisu structure docs — see [STRUCTURE.md](../../STRUCTURE.md) for the top-level map and subsystem index.
> Generated 2026-07-23 from codebase analysis. Line numbers are approximate and drift as code changes; verify with `rg` before relying on them.

## 1. Purpose & overview

The server backend turns the built Svelte SPA into a self-hosted, single-user PocketRisu instance. The production implementation is the Express executable in `server/node/server.cjs`: it serves `dist/`, authenticates clients, persists RisuAI-compatible save data and assets, lazily hydrates chats, proxies model traffic, manages backups and storage maintenance, checks for updates, and controls Cloudflare Quick Tunnels.

Persistent application data is primarily stored in SQLite through a binary-compatible key/value abstraction. `database/database.bin` contains character/settings data plus chat stubs; full chat bodies live in individual `chats/<chaId>/<chatId>` rows, and optimized plugin save data lives in `pluginsave/` plus `pluginsave-meta/` JSON rows. Large chat rows and full database snapshots are deduplicated through content-defined chunking. Assets (`save/assets/`, one immutable file per safe-named `assets/*` key, written temp-file+rename so cross-instance hardlink dedup is safe), inlays, and server-created backup files are stored separately on the filesystem; unsafe-named assets remain KV rows (dual-source reads via `server/node/assetStore.cjs`). `server/hono/` is only an early multi-runtime scaffold; it does not implement the Node backend’s APIs, authentication, or storage.

## 2. Key files

### Node implementation

| File | Approx. size | Role and important symbols |
|---|---:|---|
| `server/node/server.cjs` | 6,415 lines | Executable Express backend. Imports the storage, logging, serialization, patching, WebSocket, image, and process-management layers at `server/node/server.cjs:1`. Registers middleware at `server/node/server.cjs:584`, HTTP routes from `server/node/server.cjs:2474`, error middleware at `server/node/server.cjs:6307`, and starts HTTP/HTTPS through `startServer()` at `server/node/server.cjs:6343`. It exports nothing; loading it starts the application through the IIFE at `server/node/server.cjs:6387`. |
| `server/node/db.cjs` | 212 lines | Opens `save/risuai.db`, applies SQLite pragmas, creates the `kv` table, initializes the chunk store, and migrates legacy hex-named save files. Key functions are `migrateFromSaveDir()` at `server/node/db.cjs:46`, `kvGet()` at `server/node/db.cjs:109`, `kvSet()` at `server/node/db.cjs:114`, `kvDel()` at `server/node/db.cjs:122`, `kvCopyValue()` at `server/node/db.cjs:140`, `checkpointWal()` at `server/node/db.cjs:164`, and `gcChunks()` at `server/node/db.cjs:171`. Public CommonJS exports are collected at `server/node/db.cjs:202`. |
| `server/node/chunkStore.cjs` | 230 lines | Byte-oriented, content-defined chunk storage for large SQLite values. `isChunkableKey()` limits automatic chunking to the live DB, snapshots, and chat rows at `server/node/chunkStore.cjs:50`; `createChunkStore()` creates `chunks` and `manifest_chunks` at `server/node/chunkStore.cjs:60`. Exclusive snapshot cost and mark/sweep GC are at `server/node/chunkStore.cjs:169` and `server/node/chunkStore.cjs:200`; exports are at `server/node/chunkStore.cjs:230`. |
| `server/node/chatRows.cjs` | 373 lines | Injected chat-row store and the monolith-ingestion boundary. It owns encoded chat keys and stub semantics at `server/node/chatRows.cjs:15`, referenced-row diff/sweep helpers at `server/node/chatRows.cjs:225`, split/assembly at `server/node/chatRows.cjs:134` and `server/node/chatRows.cjs:263`, and transactional `ingestFullDatabase()` at `server/node/chatRows.cjs:289`. |
| `server/node/streamRisuSave.cjs` | 217 lines | Disk-backed legacy save encoder used by backup assembly. It writes the magic header and standard MessagePack map/array headers directly, encodes ordinary values independently with record mode disabled, and hydrates at most one external chat or plugin JSON row at a time. Explicit `undefined` properties remain map entries, matching `encodeRisuSaveLegacy()` after decode. |
| `server/node/chatRows.test.ts` | 560 lines | In-memory SQLite coverage for chat keys, row wire format, stub overlay semantics, split/assembly, duplicate IDs, targeted and grace-window orphan cleanup, and ingest atomicity. Orphan deletion tests begin at `server/node/chatRows.test.ts:389`; ingest tests begin at `server/node/chatRows.test.ts:460`. |
| `server/node/chunkStore.test.ts` | 435 lines | Vitest coverage for deterministic chunking, reassembly, deduplication, snapshot sharing, exclusive snapshot cost, orphan collection, and stale-manifest repair. The bound store suite begins at `server/node/chunkStore.test.ts:95`, snapshot suite at `server/node/chunkStore.test.ts:210`, and GC suite at `server/node/chunkStore.test.ts:304`. |
| `server/node/logs.cjs` | 391 lines | Separate SQLite-backed client/server log sink in `save/logs.db`. It creates the schema at `server/node/logs.cjs:24`, masks credentials at `server/node/logs.cjs:62`, batches writes with `addLogBatch()` at `server/node/logs.cjs:129`, builds the server logger at `server/node/logs.cjs:215`, queries logs at `server/node/logs.cjs:279`, installs fatal process handlers at `server/node/logs.cjs:319`, and records otherwise-unlogged Express errors at `server/node/logs.cjs:361`. Exports are at `server/node/logs.cjs:381`. |
| `server/node/utils.cjs` | 590 lines | Server-side implementation of RisuAI save formats and patch-sync hashing. `RisuSaveType` must match the client enum at `server/node/utils.cjs:12`; `RisuSaveDecoder` handles block-format saves at `server/node/utils.cjs:204`; `decodeRisuSave()` accepts legacy raw, compressed, stream-compressed, and block formats at `server/node/utils.cjs:369`; `hasRemoteBlocks()` scans block saves at `server/node/utils.cjs:428`; `encodeRisuSaveLegacy()` writes the msgpack-compatible format at `server/node/utils.cjs:456`; `calculateHash()` and `normalizeJSON()` support client/server patch parity at `server/node/utils.cjs:487` and `server/node/utils.cjs:532`. Exports are at `server/node/utils.cjs:570`. |
| `server/node/readme.md` | 4 lines | Short description of the Node server and an old warning that Hono may replace it; see `server/node/readme.md:1`. The implementation state currently contradicts that warning: Node is the complete backend. |
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
| `server/hono/README.md` | 4 lines | Explicitly marks the Hono server as under development and recommends Node at `server/hono/README.md:3`. |

## 3. Architecture & data flow

### Startup and configuration

1. `pnpm run runserver` invokes `node server/node/server.cjs` through `package.json:19`.
2. CommonJS evaluation first loads `db.cjs` and `logs.cjs` at `server/node/server.cjs:26`. Those modules synchronously create/open their SQLite files before route registration.
3. `db.cjs` creates `save/`, opens `save/risuai.db`, enables WAL, and applies performance and lock pragmas at `server/node/db.cjs:8`. It creates the `kv` table at `server/node/db.cjs:28`, initializes the chunk store at `server/node/db.cjs:94`, then attempts legacy save-folder migration at `server/node/db.cjs:100`.
4. `server.cjs` installs fatal logging handlers before the rest of its initialization at `server/node/server.cjs:39`. It then creates `save/`, reads or creates the password/JWT/instance files, loads persisted direct-asset sessions, initializes the backup directory, and registers middleware and routes.
5. `startServer()` migrates assets and inlays, externalizes monolithic chats, defensively re-externalizes folded optimized plugin storage even when the chat marker already exists, and converts any RisuSave `REMOTE` blocks before listening. The chat migration first copies the old blob to `migration-backup/pre-chat-externalization-<timestamp>.bin`, then records `migration/chats-externalized`; the wrapper is at `server/node/server.cjs:401`.
6. TLS is enabled only when both `server/node/ssl/certificate/server.key` and `server.crt` can be read; otherwise it starts plain HTTP.
7. Both HTTP and HTTPS servers install the proxy-job WebSocket upgrade handler before listening.
8. Shutdown handlers flush debounced database writes, stop the tunnel, and truncate-checkpoint WAL. A background checkpoint runs every five minutes.

The server reads configuration directly from `process.env`; it does not load `.env` itself:

| Variable | Meaning |
|---|---|
| `PORT` | HTTP/HTTPS port; default `6001` inside `startServer()` at `server/node/server.cjs:6349`. |
| `POCKETRISU_CHUNK_THRESHOLD` | Overrides the default 16 MiB chunking threshold at `server/node/db.cjs:95`. |
| `POCKETRISU_BACKUP_INTERVAL_MS` | Minimum interval between automatic DB snapshots; default five minutes at `server/node/server.cjs:161`. |
| `POCKETRISU_ALLOW_INSECURE_CONTEXT` | Allows client boot outside HTTPS or localhost only when exactly `1` or `true`; bypasses the WebCrypto integrity gate at the operator's risk. |
| `RISU_BACKUP_IMPORT_MAX_BYTES` | Maximum streamed backup/ZIP import size; `0` means unlimited at `server/node/server.cjs:863`. |
| `BACKUP_NDJSON_HEARTBEAT_MS` | Backup-import keepalive interval, default 5 seconds and clamped to at least 100 ms at `server/node/server.cjs:871`. |
| `RISU_TUNNEL_DISABLED` | Disables Quick Tunnel when exactly `true` at `server/node/server.cjs:879`. |
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
│   ├── __password
│   ├── __jwt_secret
│   ├── __instance_id
│   ├── __sessions
│   ├── __authcode                     # optional proxy registration token
│   ├── __sionyw_client_data.json       # optional hub OAuth refresh data
│   ├── __backup_path                  # updater-visible backup path marker
│   └── .migrated_to_sqlite             # legacy hex-file migration marker
├── backups/
│   └── risu-backup-<timestamp>.bin     # default server-side backup destination
└── server/node/ssl/certificate/
    ├── server.key
    └── server.crt
```

`risuai.db` contains:

- `kv(key TEXT PRIMARY KEY, value BLOB, updated_at INTEGER)`, created at `server/node/db.cjs:28`.
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
- `config/`: snapshot limits, backup path, and boot-reminder settings.
- `migration/disable-remote-saving`: idempotence marker for remote-block conversion.
- `migration/chats-externalized`: idempotence marker for the chat-row boot migration.
- `migration-backup/pre-chat-externalization-<timestamp>.bin`: manifest-safe copy of the pre-migration monolith for downgrade recovery.

`kvSet()` routes `database/database.bin`, `database/dbbackup-*`, and `chats/*` through the chunk store (`isChunkableKey()` at `server/node/chunkStore.cjs:50`). Values at or below the threshold remain ordinary KV rows; only large values receive manifests.

Chunks use deterministic FastCDC-style boundaries: minimum 4 KiB, maximum 64 KiB, approximately 16 KiB average, and SHA-256 content hashes at `server/node/chunkStore.cjs:17`. Values larger than 16 MiB are represented in `kv.value` by `CHUNK_MARKER`; reads concatenate manifest chunks through the bound store created at `server/node/chunkStore.cjs:60`.

### Main persistence flow

#### Initial database load

- `bootstrap.loadData()` initializes `AutoStorage`, then requests `database/database.bin` at `src/ts/bootstrap.ts:38`.
- `AutoStorage` always selects `NodeStorage` at `src/ts/storage/autoStorage.ts:27`.
- `NodeStorage.getItem()` hex-encodes the logical key into the `file-path` header and calls `GET /api/read` at `src/ts/storage/nodeStorage.ts:216`.
- `/api/read` flushes pending saves, decodes and normalizes the stubs-only live row, caches it, and sends the legacy-encoded stripped database plus `x-db-etag`. If a full chat payload or folded optimized plugin storage leaked into the live row, it defensively routes that object through `ingestDatabase()` first.
- Monolith-shaped inputs from boot migration, backup/snapshot restore, save-folder import, or defensive route recovery pass through `ingestDatabase()`. For `optimizePluginMemory === true`, `externalizePluginStorageIfNeeded()` first writes every folded value and metadata entry as a JSON KV row, then replaces the inline map with `{}` and removes `pluginStorageMeta`; chat ingestion subsequently normalizes and splits the same object before writing the combined stripped DB. Rows precede the monolith rewrite, so interruption leaves duplicates and a retry overwrites rows from the inline copy.
- The HTML root injects `globalThis.__NODE__` and `globalThis.__PATCH_SYNC__` at `server/node/server.cjs:2474`; `src/ts/platform.ts:17` turns those into frontend feature flags.

#### Patch save and full-write fallback

- `persistTrackedChanges()` first saves changed full chats individually, then encodes `database.bin` with chat stubs at `src/ts/globalApi.svelte.ts:779`.
- When patch sync is enabled, it calls `NodeStorage.patchItem()` through `forageStorage` at `src/ts/globalApi.svelte.ts:996`.
- `/api/patch` loads or reuses the stripped `dbCache`, checks the client’s compositional hash, validates chat paths, applies RFC 6902 operations to a clone, externalizes any whole-chat payload operations, deletes rows for removed stubs, updates the stripped-view ETag, and schedules persistence after five seconds at `server/node/server.cjs:3683`.
- The timer calls `persistDbCache()`, which defensively re-externalizes any folded optimized plugin data before encoding and writing the stripped cache.
- Patch conflicts or chat-guard rejections cause the frontend to fall back to `NodeStorage.setItem()` and `/api/write` at `src/ts/globalApi.svelte.ts:1014`.
- `/api/write` checks the stripped-view ETag, validates the incoming object, externalizes folded optimized plugin data and any payload-bearing chats, writes one combined stripped row, and performs targeted chat-row cleanup when the prior stripped cache is available. A normal already-stripped write preserves the client bytes verbatim.
- Storage mutations run through the promise-based `queueStorageOperation()` serialization point at `server/node/server.cjs:102`.

#### Externalized chat content

- `createChatRowStore()` is constructed once against the real SQLite-backed KV functions at `server/node/server.cjs:80`. Runtime chat bodies are never retained in a server-wide in-memory map.
- `GET /api/chat-content/:chaId/:chatIndex` reads `chats/<chaId>/<chatId>` directly, with stripped-DB index fallback and mismatch detection at `server/node/server.cjs:4628`. Raw row bytes are returned unchanged unless cold-storage rehydration was needed, in which case the restored chat is written back once.
- `POST /api/chat-content/:chaId/:chatIndex` validates the body and writes the row synchronously inside `queueStorageOperation()` at `server/node/server.cjs:4676`. It rejects bare stubs, heals hybrid `_stub` payloads, and does not involve the five-second DB timer.
- Frontend placeholders are hydrated through `fetchChatFromServer()` and `ensureChatHydrated()` at `src/ts/storage/chatStorage.ts:108` and `src/ts/storage/chatStorage.ts:133`.
- Metadata fields retained in stubs are exactly `id`, `name`, `_stub`, `lastDate`, `folderId`, and `modules`; the server allowlist is at `server/node/server.cjs:412`, shared stub/overlay semantics are in `server/node/chatRows.cjs:33`, and the matching client projection is at `src/ts/storage/chatStorage.ts:40`.

#### Assets and inlays

- Ordinary assets are filesystem files in `save/assets/` when the key's basename is a safe filename (`server/node/assetStore.cjs`); unsafe names stay as raw `assets/*` KV rows. Reads/lists/stats/backups merge both sources. Writes are temp-file + rename (never in place — files may be hardlinked across instances by `scripts/dedup-assets.sh`). Uploads whose name matches `assets/<64-hex>.<ext>` are SHA-256-verified against their content on `/api/write` and `/api/assets/bulk-write` (400 on mismatch; identical re-uploads are skipped to preserve hardlinks); backup/legacy imports log mismatches but import verbatim. A one-time startup migration (`migrateAssetsToFilesystem()`) moves safe-named KV assets to files, marker `save/assets/.migrated_to_fs`.
- Inlays are migrated from legacy `inlay/*` KV JSON to `save/inlays/<id>.<ext>` plus a sidecar by `migrateInlaysToFilesystem()` at `server/node/server.cjs:1302`.
- Legacy key/value APIs synthesize the old JSON payload when reading inlays through `readInlayAssetPayload()` at `server/node/server.cjs:1282`.
- `GET /api/asset/:hexKey` serves assets with a cookie-authenticated direct URL, MIME detection, immutable caching, and `updated_at` or filesystem-mtime ETags at `server/node/server.cjs:3083`.
- Inlay thumbnails are generated on demand with `wasm-vips` at `server/node/server.cjs:3069`; bulk WebP conversion is exposed as SSE at `server/node/server.cjs:5572`.
- `getFileSrc()` switches Node deployments to direct asset URLs at `src/ts/globalApi.svelte.ts:113`.

#### Backup and migration flow

- The binary backup framing is `[nameLength:u32LE][UTF-8 name][dataLength:u32LE][data]`, encoded by `encodeBackupEntry()` at `server/node/server.cjs:1893` and parsed incrementally by `parseBackupChunk()` at `server/node/server.cjs:2145`.
- Portable and server backups never contain `chats/` entries. `buildSelfContainedBackupDatabase()` now returns a temporary `{ filePath, size }` spool instead of a monolithic Buffer. `streamRisuSaveToFile()` writes the legacy magic header plus standard MessagePack incrementally, merging each stub with one decoded chat row and releasing it before the next. Node-only exports keep `pluginsave/` and `pluginsave-meta/` values as byte-preserving per-row archive entries; `?target=upstream` overlays those rows into hand-written MessagePack maps one parsed value at a time.
- `/api/backup/export` flushes pending data, uses the spool size for `content-length` and the `database.risudat` entry header, then streams the file bytes into the response. `?target=upstream` deliberately omits all Node-only slashed namespaces (plugin rows and inlays), because upstream treats them as asset paths. The spool is unlinked after success, encoding/response errors, or client disconnect.
- `/api/backup/import` streams directly from the request, stages filesystem data, replaces current namespaces, and passes the imported `database.risudat` through `ingestDatabase()` after commit. Legacy and `?target=upstream` monoliths are therefore re-split into plugin JSON rows when optimized mode is set; inline mode remains folded.
- Server-side backups use the same format but write `risu-backup-<timestamp>.bin` under the configured backup directory. Save spools the assembled database first so progress has its true byte count, streams its entry header and file bytes into the archive `.tmp`, then atomically renames the completed archive; both temporary files are cleaned on failure or disconnect. Save/list/restore/delete/download begin at `server/node/server.cjs:4224`.
- Legacy save folders consist of files whose filenames are hex-encoded logical KV keys. Successful directory and ZIP imports externalize chat payloads and folded optimized plugin storage through the same ingest boundary.
- Automatic snapshots use the same row-at-a-time disk spool, then read only the completed encoded file into a Buffer required by `kvSet()` and store it under `database/dbbackup-*` at `server/node/server.cjs:231`. This retains the final encoded-buffer allocation but removes the simultaneous full chat object tree. Rotation recomputes exclusive chunk footprints after each deletion (`server/node/server.cjs:192`).
- Snapshot restore copies the full snapshot into the live key, clears the remote-block marker, and immediately re-ingests it into stubs plus chat rows at `server/node/server.cjs:5618`.

### HTTP API route catalog

| Family | Routes and purpose | Primary frontend callers |
|---|---|---|
| SPA/static | `GET /` injects Node flags and returns `dist/index.html`; `/assets` and other `dist` files are static. Registration: `server/node/server.cjs:756`, root: `server/node/server.cjs:2425`. | Browser navigation and Vite-built imports. |
| General proxy | `GET/POST/PUT/PATCH/DELETE /proxy` and `/proxy2` relay authenticated arbitrary upstream HTTP; `GET/POST /hub-proxy/*` relays RisuAI Hub traffic. Routes: `server/node/server.cjs:2871`. | `fetchWithProxy()` and `fetchViaProxy2()` at `src/ts/globalApi.svelte.ts:1391` and `src/ts/globalApi.svelte.ts:2124`; hub base at `src/ts/characterCards.ts:23`. |
| Local streaming proxy | `POST /proxy-stream-jobs` creates a local/private-network-only job; `DELETE /proxy-stream-jobs/:jobId` aborts it; WebSocket `/proxy-stream-jobs/:jobId/ws` transports headers and base64 chunks. HTTP routes: `server/node/server.cjs:2886`; upgrade handler: `server/node/server.cjs:1859`. | `fetchViaProxyJobWs()` at `src/ts/globalApi.svelte.ts:2156`. |
| Authentication/session | `GET /api/test_auth`, `POST /api/login`, `POST /api/token/refresh`, `POST /api/session`, `POST /api/set_password`, and `POST /api/crypto`. Routes begin at `server/node/server.cjs:2962`. | `NodeStorage` auth lifecycle at `src/ts/storage/nodeStorage.ts:54`; password hashing at `src/ts/storage/nodeStorage.ts:745`. |
| Provider credentials | `POST /api/model-preset/google-service-account/token` signs a Google service-account JWT server-side and exchanges it only at Google’s documented OAuth endpoint. Route: `server/node/server.cjs:3168`. | `src/ts/preset/adapter/googleServiceAccount/token.ts:15`. |
| Key/value storage | `GET /api/read`, `GET /api/remove`, `GET /api/list`, `POST /api/write`, `POST /api/patch`, and cookie-authenticated `POST /api/db/flush`. Core routes: `server/node/server.cjs:3331`, `server/node/server.cjs:3527`, and `server/node/server.cjs:3683`. | `NodeStorage` methods at `src/ts/storage/nodeStorage.ts:187`; keepalive flush at `src/ts/globalApi.svelte.ts:453`. |
| Asset serving/bulk | `GET /api/asset/:hexKey`, `POST /api/assets/bulk-read`, and `POST /api/assets/bulk-write`. Routes: `server/node/server.cjs:3083` and `server/node/server.cjs:3754`. | Direct URLs from `src/ts/globalApi.svelte.ts:113`; bulk methods at `src/ts/storage/nodeStorage.ts:365`. |
| Logs | `POST /api/logs` ingests client batches, `GET /api/logs` filters/paginates, and `DELETE /api/logs` clears. Routes: `server/node/server.cjs:3380`. | Batch uploader at `src/ts/log.ts:107`; settings queries at `src/lib/Setting/Pages/SystemSettings.svelte:184`. |
| Portable backup | `GET /api/backup/export`, `POST /api/backup/import/prepare`, and streamed `POST /api/backup/import`. Routes begin at `server/node/server.cjs:3844`. | `NodeStorage.exportBackup()`, `prepareImport()`, and `importBackup()` at `src/ts/storage/nodeStorage.ts:417`. |
| Server backup | `POST /api/backup/server/save`, `GET .../list`, `POST .../restore`, `DELETE .../:filename`, and `GET .../download/:filename`. Routes begin at `server/node/server.cjs:4091`. | `NodeStorage` server-backup methods at `src/ts/storage/nodeStorage.ts:520`. |
| Backup settings | `GET/PUT /api/backup/boot-reminder` and `GET/PUT /api/backup/server/path`. Routes begin at `server/node/server.cjs:5500`. | `SystemBackup.svelte` at `src/lib/Setting/Pages/SystemBackup.svelte:220`; boot prompt at `src/ts/bootstrap.ts:214`. |
| Lazy chats | `GET/POST /api/chat-content/:chaId/:chatIndex` reads and writes individual chat rows. Routes: `server/node/server.cjs:4628` and `server/node/server.cjs:4676`. | `NodeStorage.fetchChatContent()` and `saveChatContent()` at `src/ts/storage/nodeStorage.ts:631`. |
| Save-folder migration | `POST /api/migrate/save-folder/scan`, `/execute`, `/upload`, `/cleanup/scan`, and `/cleanup/execute`. Routes begin at `server/node/server.cjs:4876`. | `NodeStorage` migration methods at `src/ts/storage/nodeStorage.ts:654`. |
| Storage dashboard | `GET /api/db/stats`, `/characters`, and `/modules`; `POST /api/db/optimize`; `POST /api/db/wal-checkpoint`. Routes begin at `server/node/server.cjs:5129`; optimize and chat-row sweep begin at `server/node/server.cjs:5443`. | `SystemDashboard.svelte` at `src/lib/Setting/Pages/SystemDashboard.svelte:119`. |
| DB snapshots | `GET/PUT /api/db/snapshots/limits`, `GET/DELETE /api/db/snapshots`, and `POST /api/db/snapshots/restore`. Routes begin at `server/node/server.cjs:5529`. | `SystemBackup.svelte` at `src/lib/Setting/Pages/SystemBackup.svelte:100`. |
| Inlay maintenance | Cookie-authenticated `POST /api/inlays/compress`, streamed as SSE. Route: `server/node/server.cjs:5572`. | `src/lib/Setting/Pages/Advanced/InlayCompressButton.svelte:23`. |
| Public/update | Unauthenticated `GET /api/public-stats` and `GET /api/update-check`; authenticated `POST /api/self-update`. Routes begin at `server/node/server.cjs:5645`. | `src/ts/publicStats.ts:12` and `src/ts/update.ts:35`. |
| Quick Tunnel | Authenticated `GET /api/tunnel/status`, `POST /api/tunnel/start`, and `POST /api/tunnel/stop`. Routes begin at `server/node/server.cjs:6034`. | `RemoteAccessSettings.svelte` at `src/lib/Setting/Pages/RemoteAccessSettings.svelte:26`. |

## 4. Entry points & dependencies

### Inbound entry points

- Production/self-hosted startup is `pnpm run runserver` → `server/node/server.cjs`, declared at `package.json:19`.
- Portable launchers and Termux scripts also execute the same file; `server.cjs` assumes `process.cwd()` is the PocketRisu application root.
- The frontend storage entry is the singleton `forageStorage = new AutoStorage()` at `src/ts/globalApi.svelte.ts:31`. `AutoStorage` constructs `NodeStorage`, which owns the HTTP contract.
- Direct settings-page fetches bypass `NodeStorage.authFetch()` for storage dashboards, snapshots, log viewing, tunnel controls, update UI, and some backup preferences; their route references are listed above.
- The Hono entry points are runtime-specific exports or executables: `server/hono/src/bun.ts:1`, `server/hono/src/cf.ts:1`, and `server/hono/src/node.ts:1`.

### Outbound dependencies

- `better-sqlite3` supplies synchronous application and log databases (`server/node/db.cjs:3`, `server/node/logs.cjs:3`).
- `msgpackr` and `fflate` implement RisuAI save compatibility in `server/node/utils.cjs:1`.
- `fast-json-patch` applies client patches at `server/node/server.cjs:33`.
- Express, `compression`, `express-rate-limit`, and `node-html-parser` provide HTTP routing, response compression, login throttling, and root-page flag injection.
- `ws` supplies the proxy-job WebSocket server at `server/node/server.cjs:14`.
- `wasm-vips` generates thumbnails and compresses inlays at `server/node/server.cjs:15`.
- Native `fetch` calls arbitrary authenticated proxy targets, `https://sv.risuai.xyz` for Hub traffic, Google OAuth, the configured PocketRisu update worker, GitHub release assets, and Cloudflare’s `cloudflared` release downloads.
- `child_process.spawn()` runs `cloudflared` and restart helpers; `execSync()` invokes platform archive tools during tunnel download and self-update.
- `server/hono/` depends only on Hono and `@hono/node-server`, declared at `server/hono/package.json:11`; it does not reuse the Node database, serialization, or route code.

## 5. Conventions & gotchas

- **Working directory is part of the contract.** Storage, `dist/`, backups, package version, TLS certificates, binaries, and update paths are all based on `process.cwd()`, not `__dirname`; examples include `server/node/db.cjs:8`, `server/node/server.cjs:760`, and `server/node/server.cjs:773`. Starting from another directory creates/reads the wrong data tree.

- **The server does not parse `.env`.** Variables must already be in the process environment. The updater preserves `.env`, but `server.cjs` contains no dotenv or `--env-file` handling.

- **Runtime requirements are slightly inconsistent.** Root `package.json` declares Node `>=22.12.0` at `package.json:6`, while the server warns for any major version below 24 at `server/node/server.cjs:42`.

- **Authentication is NodeOnly-specific.** PocketRisu replaced upstream’s browser-side ECDSA flow with server-issued HMAC-SHA256 JWTs because remote HTTP is not a browser secure context; see `server/node/server.cjs:834` and the matching client warning at `src/ts/storage/nodeStorage.ts:1`. JWT lifetime is five minutes (`server/node/server.cjs:1493`), while direct-asset session cookies last seven days (`server/node/server.cjs:3003`).

- **The password file contains whatever `/api/set_password` receives.** The official client first hashes the user input through unauthenticated `/api/crypto` and stores that digest as the password (`src/ts/storage/nodeStorage.ts:283`, `server/node/server.cjs:3151`). Changing either side independently breaks login compatibility.

- **Most authenticated routes return HTTP 400 for missing/expired/invalid JWTs, not consistently 401.** `NodeStorage.shouldRetryAuth()` explicitly understands these response bodies at `src/ts/storage/nodeStorage.ts:145`.

- **Direct asset URLs cannot send `risu-auth`.** `/api/session` therefore persists opaque cookie tokens in `save/__sessions`, and `/api/asset`, `/api/db/flush`, and `/api/inlays/compress` use `sessionAuthMiddleware()` at `server/node/server.cjs:1407`.

- **The writer lock is compatibility-optional.** The last `/api/session` caller supplying `x-session-id` becomes the active writer, but `checkActiveSession()` allows requests with no `x-session-id` at `server/node/server.cjs:1450`. New mutation callers should send the header if they should participate in cross-device exclusion.

- **`GET /api/remove` is intentionally a mutating GET.** This odd API is mirrored by `NodeStorage.removeItem()` at `src/ts/storage/nodeStorage.ts:258`; changing its verb requires a coordinated frontend compatibility change.

- **Patch sync and chat lazy loading are inseparable.** The patch baseline and live `database.bin` are stubs-only, while full messages live in chat rows. Any new stub metadata field must be added to shared `chatToStub()`/merge semantics, the server allowlist, and the client conversion (`server/node/chatRows.cjs:33`, `server/node/chatRows.cjs:150`, `server/node/server.cjs:412`, `src/ts/storage/chatStorage.ts:40`).

- **Key presence is semantically meaningful for stub metadata.** Explicit `null`/`undefined` means “the user cleared this value”; it must overwrite the full chat. Do not replace the `in` checks in `mergeChatStubWithFullChat()` with nullish checks (`server/node/chatRows.cjs:150`).

- **There are multiple chat-corruption guards.** Field-level patch operations outside the stub allowlist are rejected through `findChatInternalFieldOps()` at `server/node/server.cjs:442`; debounced stripped writes and full `/api/write` requests both reject metadata-only chats through `findStubFlagLossChats()` at `server/node/server.cjs:489`. Removing one reopens the v1.4.x silent message-loss path.

- **Chat rows must go through `chatRows.cjs`.** Key components are URI-encoded, large rows may have chunk manifests, and the row wire format must match `/api/chat-content`. Use `readChatRow()`, `writeChatRow()`/`writeChatRowRaw()`, and `deleteChatRow()` instead of hand-built keys or direct SQL (`server/node/chatRows.cjs:15`, `server/node/chatRows.cjs:166`).

- **Chat deletion is layered.** Patch operations and cache-warm full writes call `deleteRemovedChatRows()` for exact old-minus-new stub removal (`server/node/chatRows.cjs:225`). `/api/db/optimize` additionally sweeps every unreferenced `chats/` row, but preserves rows updated within the last hour so a chat POST that arrives before its stub is not lost (`server/node/chatRows.cjs:237`, `server/node/server.cjs:5443`). Snapshot restore is safe because snapshots contain full assembled monoliths and recreate their rows through ingest.

- **Downgrading after chat externalization is unsupported.** Older servers interpret the live stubs-only blob as the whole database. Recovery for a downgrade is the boot-created `migration-backup/pre-chat-externalization-*` copy or another full pre-migration snapshot; boot migration and safety copy are at `server/node/server.cjs:389`.

- **Optimized folded plugin storage is split with rows first.** `externalizePluginStorageIfNeeded()` uses unpadded canonical base64url keys and exact UTF-8 `JSON.stringify(value)` bytes. It writes or overwrites all rows before callers persist the `{ pluginCustomStorage: {} }` stub and deleted `pluginStorageMeta`; preserve that ordering so a crash leaves a recoverable inline copy. A falsy `optimizePluginMemory` is legitimate inline mode and must not be split.

- **Patch persistence is debounced.** `/api/patch` acknowledges after mutating memory, then writes five seconds later (`server/node/server.cjs:3792`). Failures cannot be returned on the triggering request, so `recordPersistFailure()` surfaces them on the next patch response (`server/node/server.cjs:119`). Reads, backups, maintenance, shutdown, and the browser keepalive route explicitly flush pending data.

- **ETags describe the stripped client view.** This now matches the stubs-only live row, but not assembled snapshots or portable backups. Full writes and patches must preserve that convention or clients will report false concurrent-modification conflicts; see `/api/read` at `server/node/server.cjs:3331` and `/api/write` at `server/node/server.cjs:3527`.

- **The compositional patch hash must remain byte-for-byte algorithmically aligned with the frontend.** Property iteration order and normalization behavior in `calculateHash()`/`normalizeJSON()` are observable protocol details, not general-purpose utilities.

- **RisuSave constants and defaults are duplicated across server and client.** `RisuSaveType` and `presetTemplate` explicitly require synchronization at `server/node/utils.cjs:12` and `server/node/utils.cjs:57`.

- **Legacy `REMOTE` data is migrated, not merely ignored.** `migrateRemoteBlocksIfNeeded()` makes a dedicated safety backup, resolves `remotes/<name>.local.bin`, writes an inline legacy save, and keeps the old remote rows so pre-migration snapshots remain restorable (`server/node/server.cjs:303`).

- **Cold-storage formats are another upstream compatibility boundary.** Canonical runtime rows are gzipped `coldstorage/<uuid>`, while backup entries are plain JSON named `coldstorage/<uuid>.json`; normalization is at `server/node/server.cjs:1973`. Failed character restores are converted to safe blank characters but retain a recovery breadcrumb at `server/node/server.cjs:4401`.

- **Inlay payloads no longer live in SQLite.** Storage stats and backups must explicitly include `save/inlays`; `sumInlayFsBytes()` exists because KV prefix totals underreport them at `server/node/server.cjs:4943`.

- **Asset payloads mostly no longer live in SQLite either.** Safe-named `assets/*` values are files in `save/assets/`; only unsafe names remain KV rows. Never write an asset file in place — always temp-file + rename (`writeAssetFile()`), or an externally hardlinked copy in another instance would be corrupted. Anything enumerating or deleting assets must use the merged dual-source helpers (`listAssetEntriesWithSizes()`, `readAssetValue()`, `deleteAssetValue()`, `clearAllAssets()`), not `kvListWithSizes('assets/')` alone. Backup import stages asset files in `save/assets_import_staging/` and swaps atomically with rollback.

- **Chunk-aware deletion matters.** `kvDel()` must go through `chunkStore.dropValue()` so snapshot manifests stop pinning chunks (`server/node/db.cjs:122`). Direct SQL deletion of a chunked logical key leaves a stale manifest until GC repairs it.

- **Chat dashboard totals are chunk-aware.** The `chats/` prefix total sums `kvSize()` for each logical row; `LENGTH(kv.value)` would report only the 13-byte marker for a chunked chat. The stats response also separates chat KV-row and referenced-chunk bytes so the dashboard can allocate physical storage without double-counting the shared chunk table (`server/node/server.cjs:5129`).

- **Chunk GC is deliberately off the save hot path.** Replaced chunks become orphans and are reclaimed during `/api/db/optimize`; see `server/node/server.cjs:5443`.

- **Snapshot “size” has two meanings.** Rotation limits use exclusive physical chunk cost: chunks referenced by that manifest and no other manifest (`snapshotCostExclusive()` at `server/node/chunkStore.cjs:169`). The list endpoint reports logical reassembled DB size at `server/node/server.cjs:5582`. Do not substitute `LENGTH(kv.value)`, which is only the marker for chunked values.

- **Automatic snapshot timestamps use 100 ms units.** Creation divides `Date.now()` by 100 at `server/node/server.cjs:238`; listing multiplies the parsed value by 100 near `server/node/server.cjs:5572`.

- **Backup stream responses must remain uncompressed and incrementally flushed.** `shouldCompress()` excludes proxy, download, SSE, and NDJSON cases at `server/node/server.cjs:722`. Re-enabling gzip can buffer heartbeats and reintroduce reverse-proxy timeouts.

- **Backup imports are destructive replacement operations.** The streamed import removes current asset, inlay, cold-storage, draft, remote, and chat data before inserting new content, then ingests the imported monolith at `server/node/server.cjs:2172`. Preserve its pre-import snapshot, staging directory, transaction, atomic filesystem swaps, and post-import ingest behavior.

- **`/proxy` and proxy jobs have different trust models.** Authenticated `/proxy` and `/proxy2` accept general HTTP(S) targets, while job/WebSocket streaming validates local/private hosts through `sanitizeTargetUrl()` at `server/node/server.cjs:1608`. Do not reuse the unrestricted proxy path for the local-network feature.

- **`/hub-proxy/*` is not universally guarded by `checkAuth()`.** It checks PocketRisu auth only for the special `X-Node-Server-Auth` flow at `server/node/server.cjs:2801`; changes to its target/header behavior need a deliberate compatibility and security review.

- **Quick Tunnel is ephemeral process state.** `cloudflared` is found in `bin/` or `PATH`, otherwise downloaded from GitHub at `server/node/server.cjs:897`. The URL is parsed from stderr and lost when the server or subprocess exits (`server/node/server.cjs:6080`).

- **Tailscale has no backend implementation.** It is an external reverse-access recommendation using `tailscale serve --bg http://localhost:6001`, documented at `docs/en/remote.md:25`. Only Cloudflare Quick Tunnel has API/UI integration.

- **Self-update is portable-only and mutates the installation tree.** Deployment type is inferred at `server/node/server.cjs:990`, and only a `.portable` deployment can call the replacement flow at `server/node/server.cjs:5676`. The keep sets, rollback staging, Windows locked-binary handling, and restart logic are data-safety behavior.

- **Logs are a separate bounded database.** Rows are rotated to approximately 5,000, descriptions are truncated, and common JWT/API-key patterns are masked before persistence (`server/node/logs.cjs:8`, `server/node/logs.cjs:62`). Keep the server `BACKGROUND_SOURCES` list synchronized with the frontend logs settings as noted at `server/node/logs.cjs:55`.

- **Fatal logging intentionally terminates the process.** `uncaughtException` and `unhandledRejection` synchronously persist a record and call `process.exit(1)` at `server/node/logs.cjs:319`.

- **The SSL helper is local-development oriented.** Its certificate SANs cover only localhost, and the shell helper sets private keys to mode `0644` at `server/node/ssl/Generate Certificate.sh:7`; do not treat it as a hardened public-deployment certificate setup.

- **The Hono tree is not feature-compatible.** It has only `GET /`, CSRF, and optional static serving. Moreover, `server/hono/package.json:5` references missing `src/index.ts`, and `server/hono/wrangler.jsonc:3` references missing `src/index.js`. Treat it as scaffold code rather than an alternate PocketRisu backend.

## 6. Navigation hints

- To add or change an HTTP route, start at the route block in `server/node/server.cjs:2474`; keep error middleware after all routes at `server/node/server.cjs:6307`.

- To change request-size limits, static caching, compression, or streaming behavior, inspect middleware at `server/node/server.cjs:722`.

- To change server startup, port, HTTP/HTTPS selection, WebSocket setup, or shutdown behavior, inspect `startServer()` at `server/node/server.cjs:6343` and the IIFE at `server/node/server.cjs:6387`.

- To add an environment variable, follow the existing direct `process.env` reads around `server/node/server.cjs:863`, and document how the launcher supplies it.

- To change authentication or token lifetime, update `createServerJwt()` and `checkAuth()` at `server/node/server.cjs:1493` and `server/node/server.cjs:2444`, plus `NodeStorage` at `src/ts/storage/nodeStorage.ts:54`.

- To change direct asset authorization, inspect session persistence at `server/node/server.cjs:1373`, session issuance at `server/node/server.cjs:3003`, and asset serving at `server/node/server.cjs:3083`.

- To change generic KV behavior or SQLite tuning, inspect `server/node/db.cjs:8` and its exported operations at `server/node/db.cjs:202`.

- To change large-blob thresholds, chunk boundaries, snapshot sharing, or GC, inspect `server/node/chunkStore.cjs:17`, `server/node/chunkStore.cjs:50`, and tests beginning at `server/node/chunkStore.test.ts:95`.

- To change database read/write synchronization, inspect `/api/read` at `server/node/server.cjs:3331`, `/api/write` at `server/node/server.cjs:3527`, and `NodeStorage` at `src/ts/storage/nodeStorage.ts:187`.

- To change patch sync, inspect `findChatInternalFieldOps()` at `server/node/server.cjs:442`, `persistDbCache()` at `server/node/server.cjs:516`, and `/api/patch` at `server/node/server.cjs:3683`.

- To add chat-level metadata, update `chatToStub()` and merge semantics at `server/node/chatRows.cjs:33` and `server/node/chatRows.cjs:150`, the server allowlist at `server/node/server.cjs:412`, and the client equivalent at `src/ts/storage/chatStorage.ts:40`.

- To change chat-row keys, encoding, assembly, or orphan cleanup, start in `server/node/chatRows.cjs:15`; tests begin at `server/node/chatRows.test.ts:133`.

- To change chat hydration or persistence, inspect the chat endpoints at `server/node/server.cjs:4628`, the client adapter at `src/ts/storage/nodeStorage.ts:631`, and runtime hydration at `src/ts/storage/chatStorage.ts:108`.

- To change RisuAI save-format compatibility, inspect format detection/decoding at `server/node/utils.cjs:154`, `server/node/utils.cjs:204`, and `server/node/utils.cjs:369`; compare coordinated client behavior before changing constants.

- To change monolith ingestion, optimized plugin re-externalization, or boot chat migration, inspect `ingestDatabase()`, `externalizePluginStorageIfNeeded()`, `server/node/chatRows.cjs`'s `ingestFullDatabase()`, and `migrateChatsToRowsIfNeeded()`.

- To change legacy remote-block migration, inspect `migrateRemoteBlocksIfNeeded()` at `server/node/server.cjs:303`.

- To change cold-storage recovery, inspect the canonical key/encoding helpers at `server/node/server.cjs:1973` and character/chat restoration at `server/node/server.cjs:4374`.

- To change asset storage, inspect `/api/read` and `/api/write` prefix special cases at `server/node/server.cjs:3281` and `server/node/server.cjs:3478`.

- To change inlay filesystem layout or migration, inspect path validation at `server/node/server.cjs:1018`, file helpers at `server/node/server.cjs:1089`, and `migrateInlaysToFilesystem()` at `server/node/server.cjs:1302`.

- To change backup framing or compatibility, inspect `encodeBackupEntry()` at `server/node/server.cjs:1893` and assembled database creation at `server/node/server.cjs:2074`.

- To change streamed backup import, inspect `importBackupFromSource()` at `server/node/server.cjs:2172` and `/api/backup/import` at `server/node/server.cjs:4127`.

- To change server-side backup files or their directory, inspect initialization at `server/node/server.cjs:784`, route handling at `server/node/server.cjs:4091`, and path configuration at `server/node/server.cjs:5519`.

- To change snapshot creation, retention, or cost accounting, inspect `createBackupAndRotate()` at `server/node/server.cjs:231`, `snapshotFootprint()` at `server/node/db.cjs:189`, and snapshot routes at `server/node/server.cjs:5529`.

- To change storage-dashboard calculations or orphan cleanup, inspect `buildUncleanableSet()` at `server/node/server.cjs:5046`, `/api/db/stats` at `server/node/server.cjs:5129`, and `/api/db/optimize` at `server/node/server.cjs:5443`; keep asset reachability synchronized with `getUncleanables()` at `src/ts/globalApi.svelte.ts:1458`.

- To change logging retention, filtering, or masking, inspect `server/node/logs.cjs:8`, `server/node/logs.cjs:62`, and `server/node/logs.cjs:257`.

- To change local-network model streaming, inspect URL validation at `server/node/server.cjs:1553`, job execution at `server/node/server.cjs:1807`, WebSockets at `server/node/server.cjs:1859`, and the frontend transport at `src/ts/globalApi.svelte.ts:2156`.

- To change Quick Tunnel behavior, inspect binary discovery/download at `server/node/server.cjs:897`, API routes at `server/node/server.cjs:6034`, and process lifecycle at `server/node/server.cjs:6080`.

- To change update checks, inspect `fetchLatestRelease()` at `server/node/server.cjs:1348` and `src/ts/update.ts:35`.

- To change portable self-update or restart behavior, inspect the endpoint at `server/node/server.cjs:5676`; coordinate with the standalone updater rather than editing one implementation in isolation.

- To make Hono functional, begin with the shared app at `server/hono/src/app/index.ts:4`, but plan explicit replacements for authentication, SQLite/chunk storage, backup streaming, WebSockets, and runtime-specific filesystem/process features.

## Out of scope, noticed

- `src/ts/storage/nodeStorage.ts` and `src/ts/storage/autoStorage.ts` are the frontend-side protocol adapters and should be documented with the frontend storage subsystem.
- `src/ts/globalApi.svelte.ts` and `src/ts/storage/chatStorage.ts` own save scheduling, proxy selection, and chat hydration on the client.
- `scripts/updater.cjs` contains a standalone portable update path parallel to the in-server `/api/self-update` implementation.
- `docs/*/remote.md` documents external Tailscale setup; no Tailscale process management exists under `server/`.
