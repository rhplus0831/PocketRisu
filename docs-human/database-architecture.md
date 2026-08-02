# How PocketRisu handles database data

An analysis of how PocketRisu stores, transports, and maintains its core application
data: the main `Database` object, chat data, and plugin data. Assets, inlays, and other
binary resources are out of scope except where they share a code path that must be
mentioned.

> Investigated 2026-07-28 against commit `ec45e7c9` by six code-grounded audits
> (server read paths, client save pipeline, server write paths, server self-management,
> upstream RisuAI comparison, memory/performance/bandwidth), cross-checked against
> `docs/structure/`. File paths and symbol names are durable references; line numbers
> are hints as of the audited commit and should be confirmed with `rg`.

---

## 1. Overview: three data planes over one SQLite KV core

PocketRisu keeps upstream RisuAI's single logical `Database`, but demotes it to a
metadata/control plane and moves the two unbounded-growth payloads out of it:

| Plane | Storage | Wire unit |
|---|---|---|
| Main database (settings, characters, presets, modules, personas, chat *stubs*) | KV row `database/database.bin`, stubs-only legacy RisuSave (MessagePack) | JSON Patch (normal) or full ETag-guarded write (fallback) |
| Chat bodies | One KV row per chat: `chats/<encodeURIComponent(chaId)>/<encodeURIComponent(chatId)>` | Whole-chat legacy RisuSave per read/write |
| Optimized plugin values (opt-in, V3-only) | `pluginsave/<base64url(key)>.json` + `pluginsave-meta/…` + `plugin-storage/manifest.json`, selected by `Database.pluginStorageGeneration` | Per-key JSON mutations, atomic batches, staged transitions |

All three planes live in one `better-sqlite3` database at `save/risuai.db`
(`server/node/db.cjs`), in a `kv(key, value BLOB, updated_at)` table. Values larger
than 16 MiB are transparently split into SHA-256-addressed, content-defined chunks
(4–64 KiB, ~16 KiB average) with protected manifests (`server/node/chunkStore.cjs`);
the KV row then holds only a `\0RISUCHUNKED\0` marker. Chunks are deduplicated, which
makes the live database, chat rows, and automatic snapshots share unchanged bytes.

Supporting tables: `deleted_keys` (7-day deletion journal for list deltas),
`sync_meta.list_epoch` (invalidates client list caches on boot/import),
`plugin_storage_usage` / `plugin_storage_owners` (derived plugin quota/owner indexes,
rebuilt at every boot), and the chunk manifest tables. `save/logs.db` is a separate
bounded log database (~5,000 rows retained). Legacy `characters`/`chats`/`settings`
tables from very old installs are orphaned and unused (`server/node/db.cjs:72-75`).

The browser holds the whole decoded `Database` in `DBState.db` (Svelte 5 `$state`).
Unopened chats are runtime `_placeholder` objects; `_stub` is the wire marker. The
server is always authoritative; the optional IndexedDB resource cache and list cache
are disposable performance layers.

---

## 2. How the server provides data to clients

### 2.1 Boot database read

`loadData()` → `readDatabaseForBoot()` uses one of two endpoints
(`src/ts/bootstrap.ts`, `src/ts/storage/nodeStorage.ts:2964-3045`):

- **Raw boot read** (resource cache disabled — the default for a fresh browser):
  `GET /api/db/read-raw-for-boot` flushes any pending debounced patch, waits for the
  import barrier, assembles the stored `database/database.bin` bytes (including chunk
  reassembly + verification), and returns them **verbatim** with
  `x-db-etag = MD5(bytes)` (`server/node/server.cjs:7719-7728`). No decode or
  normalization happens, deliberately: corrupt or old-format bytes must reach
  browser-side snapshot recovery instead of being hidden by server decoding.
- **Segmented cached read** (resource cache enabled): `POST /api/db/read-cached` with a
  JSON inventory of up to 8,192 SHA-256 hashes grouped as
  `root/characters/botPresets/modules/personas`. The server prepares the same
  stubs-only view and ETag as `/api/read`, MessagePack-encodes each group member
  separately, and returns one MessagePack envelope where each member is either
  `{hash}` (client already has it) or `{bytes}` (miss)
  (`server/node/dbCachedRead.cjs`, `src/ts/storage/dbCachedRead.ts`). The client
  re-hashes every cached segment before use and verifies the envelope ETag; any
  anomaly falls back to the raw read.

Either way the client ends up with one complete in-memory `Database`; segmentation
saves transfer, not browser memory. `_stub` chats are converted to `_placeholder`
runtime chats before the app runs.

The normalized `GET /api/read` for `database/database.bin` (decode → defensive chat/
plugin externalization → stubs-only re-encode → MD5 ETag) is used by the client for
conflict/rebase reads, not boot (`server/node/server.cjs:7581-7659`).

### 2.2 Chat reads (lazy hydration)

Chat bodies are never in the boot payload. Opening a placeholder calls
`ensureChatHydrated()` → `GET /api/chat-content/:chaId/:chatIndex` with the durable ID
in `x-chat-id`. The server reads the row by ID first, falling back to index resolution
with a 409 on mismatch, and returns the whole encoded chat with
`x-content-hash = SHA-256` (`server/node/server.cjs:12143-12195`). With the resource
cache enabled, the client advertises up to 8 verified hashes in `x-cached-hashes`; a
match returns `204` + `x-content-hash` and the client re-verifies its local bytes
before reuse. Hydration is deduplicated per `chaId/chatId`, re-finds the chat by ID
after the fetch, and is suppressed from dirty tracking.

### 2.3 Plugin data reads

- **Inline mode** (default): plugin storage is embedded in the boot database; no
  further requests.
- **Optimized mode**: reads are manifest-gated. The client fetches
  `GET /api/plugin-storage/manifest` once per generation and answers "missing" locally
  for keys the manifest does not own — no network round-trip. Owned values are read
  per-key via hash-aware `GET /api/read` (raw UTF-8 JSON body) with
  `x-plugin-storage-generation`; `GET /api/plugin-storage/state` returns
  value + owner + opaque `sha256:` revision for CAS flows
  (`src/ts/plugins/pluginSaveStorage.ts:1141-1205`, `server/node/server.cjs:7913-8019`).
  Physical rows absent from the active manifest are treated as absent (quarantine).
  The storage viewer is the one truly streaming read: a pinned SQLite snapshot paged
  as NDJSON, ≤50 rows per page (`server/node/server.cjs:8067-8337`).
- The server pins each session's observed plugin mode/generation after a database read
  and rejects mismatched plugin reads, so a page cannot mix an old root with newly
  published plugin rows (`server/node/server.cjs:3113-3133`, `:4302-4358`).

### 2.4 Key listings

`GET /api/list` supports full and delta responses (`server/node/listDelta.cjs`). A
client with a cached prefix listing sends `x-last-sync` + `x-list-epoch`; the server
returns `{added, deleted}` if the baseline is under six days old and the epoch matches,
otherwise a full listing. Sources are `kv.updated_at`, the `deleted_keys` journal
(7-day retention, pruned at boot and hourly), and the list epoch, which changes on
every boot and import/restore outcome. `/api/list` waits for the import barrier so a
transactional intermediate key set can never be cached.

### 2.5 Transport notes

- All bulk payloads are `application/octet-stream`; inner formats are legacy RisuSave
  (11-byte header + MessagePack) for database/chats and raw JSON for plugin values.
- Express `compression` makes octet-stream responses *eligible* for negotiated HTTP
  compression; backup/NDJSON/SSE streams are explicitly excluded so heartbeats are not
  buffered (`server/node/server.cjs:1666-1702`).
- Responses are fully buffered server-side (`Buffer.concat` → `res.send()`); only the
  plugin viewer, exports, and import ingest stream.
- Reads require a 5-minute HMAC-SHA256 JWT (`risu-auth`); reads do **not** require
  being the active writer, so a displaced page can still read.

---

## 3. What the client does when saving

### 3.1 The reactive save loop (`saveDb()` in `src/ts/globalApi.svelte.ts`)

1. At boot, the authoritative decoded database is cloned as the **patch baseline**
   before `setDatabase()` adds defaults, so first save syncs defaults too.
2. Separate `$effect`s `deepTouch()` distinct branches: root fields, presets, modules,
   plugins/inline plugin storage, the selected character (excluding chat bodies —
   only chat ordering/stub metadata), and — deeply — **only the active chat**.
   Hydration and initial runs are suppressed.
3. A mutation resets a 500 ms quiet-period timer; a 200 ms polling loop picks up the
   dirty flag. `DatabaseSaveCoordinator` allows one save in flight; failures requeue
   tracked changes with bounded backoff (5th consecutive failure alerts and stops
   until the next mutation).
4. `requestImmediateSave()` returns an explicit outcome (`committed` / `retry` /
   `failed` / `displaced`); durability-sensitive callers must check `committed` or use
   `requireCommittedDatabaseSave()`.
5. `visibilitychange`/`pagehide` force an immediate save with chat persistence, then a
   best-effort keepalive `POST /api/db/flush` (server flushes pending state and
   verifies a FULL WAL checkpoint).

### 3.2 Chat rows first, stubs second

Before any database bytes are built, `prepareChatPersistStage()`
(`src/ts/storage/chatPersistStage.ts`) writes every changed/new full chat through
`POST /api/chat-content`. Only if **all** row writes succeed does the client proceed
to the stubs-only database commit; new chat IDs enter the durable "known" baseline
only after the stub commit also succeeds. This ordering guarantees a failure produces
a harmless orphan row rather than a stub pointing at a body that never existed.

During generation, the active chat is checkpointed on first dirtiness and then at most
every 20 seconds, with an unconditional final save when generation ends. Chats are
detected by active-chat tracking and new-ID discovery — existing *non-active* chat
bodies are not content-diffed.

### 3.3 Patch first, full write as fallback

- The client encodes the stubs-only database (`RisuSaveEncoder.set()/encode()`), then
  — when patch sync is enabled — computes an RFC 6902 patch against the normalized
  stubs-only baseline plus a custom 32-bit structural `expectedHash`
  (`src/ts/storage/risuSave.ts`: `RisuSavePatcher`, `normalizeJSON()`,
  `calculateHash()`). Arrays with stable IDs use whole-array replacement on
  add/delete/reorder instead of index-shift diffs.
- `findDangerousChatOps()` refuses patches touching chat internals outside the stub
  metadata allowlist (`id`, `name`, `_stub`, `lastDate`, `folderId`, `modules`).
- Fallbacks to an ETag-guarded full `/api/write` occur when patch sync is unsupported,
  on `forceFullWrite` (plugin lifecycle changes use this), on dangerous-chat-op
  detection, or on any non-conflict patch rejection. Patch-enabled clients refuse an
  unversioned full write.
- **Conflicts are HTTP 409** (both patch-hash and ETag mismatches; 412 is not used).
  The client then does an authoritative `/api/read`, overlays only its tracked dirty
  branches (root/presets/modules/plugins/characters/chats), reinstalls placeholders,
  rebuilds encoder + patcher from the new baseline, installs the ETag last, and
  retries. HTTP 423 means another session took writer ownership: the page latches
  `displaced`, stops sending stale state, and offers reload or a frozen read-only
  view (`src/ts/storage/writerTakeover.ts`). Same-browser tabs coordinate earlier via
  `BroadcastChannel('risu-db')`.

### 3.4 Plugin and draft saves

- **Inline mode**: plugin set/remove mutates `db.pluginCustomStorage` /
  `pluginStorageMeta` synchronously in the browser; the ordinary save loop persists it.
  No plugin HTTP call happens.
- **Optimized mode**: per-key `POST /api/plugin-storage/mutate` (raw JSON body,
  generation-bound, streamed to a disk spool at ≥1 MiB), atomic
  `POST /api/plugin-storage/batch` (≤128 ops, ≤16 MiB, manifest-revision +
  per-row `sha256:` revision CAS, request-hash echo verification), and staged
  inline↔optimized transitions (per-row stage uploads + one atomic finalize; database
  saves are paused during the stage and fenced until reload on an unresolved outcome).
  Unknown commit outcomes are never replayed.
- **Drafts**: composer text is deliberately outside `Chat` —
  `drafts/<chaId>/<chatId>` rows written via generic `/api/write` with an 800 ms
  debounce and one serialized write/remove chain, so typing never re-uploads a chat
  body and a late write cannot resurrect a deleted draft.

---

## 4. What goes over the network when saving

All requests carry `risu-auth` (JWT) and `x-session-id`. `file-path` headers are
hex-encoded logical keys.

| Operation | Request | Payload / key fields | Size profile |
|---|---|---|---|
| Database patch | `POST /api/patch` (JSON, ≤32 MiB) | `{patch: [RFC 6902 ops], expectedHash}` | Proportional to changed fields, but ID-array structural changes embed whole arrays; a "patch" can approach database scale (chats always excluded) |
| Database full write | `POST /api/write` (octet-stream, `x-if-match: <MD5 ETag>`) | Complete uncompressed `RISUSAVE\0` block container, chats as stubs | O(database); dominated by characters/presets/modules/inline plugin storage |
| Chat row | `POST /api/chat-content/:chaId/:chatIndex`, `x-chat-id`, optional `x-chat-backup-reason` | Entire chat, legacy RisuSave (header + MessagePack), uncompressed; **no version/ETag field** | O(chat); every save retransmits all messages |
| Flush | `POST /api/db/flush` (keepalive) | none | tiny |
| Plugin mutate | `POST /api/plugin-storage/mutate`, op/generation/owner headers, `x-plugin-storage-stream: 1` ≥1 MiB | Raw UTF-8 JSON value (set) or empty (remove); response hash must match client-side SHA-256 | O(value), ≤128 MiB |
| Plugin batch | `POST /api/plugin-storage/batch` | JSON: `{version: 2, generation, expectedManifestRevision, operations[]}` with base64 values + `expectedRevision` CAS | ≤16 MiB; base64 adds ~33 % |
| Draft | `POST /api/write` to `drafts/<chaId>/<chatId>` | `{"m": "...", "t": "..."}` | tiny |
| Removal | mutating `GET /api/remove` | none (key in header) | tiny — a deliberate upstream-compatibility oddity |

Uploads are never compressed at the HTTP layer; download compression is negotiated.
Reads negotiate hash-based `204`s when the resource cache is on; successful writes
return content hashes so the client can seed its cache without re-downloading.

---

## 5. How the server stores what it receives

### 5.1 Patch path (`POST /api/patch`)

Auth → writer-ownership check → storage-mutation FIFO → plugin-publication guard
(patches touching `pluginCustomStorage`/`pluginStorageGeneration`/manifest roots are
rejected with 409 — those fields belong to the dedicated plugin protocols) →
`expectedHash` compared against a memoized compositional hash of the cached stubs-only
database → `applyPatchAtomic()` (`server/node/atomicJsonPatch.cjs`) applies operations
with path-scoped copy-on-write (only mutation-path ancestors are cloned — this is the
recent "stop O(database) work per patch" fix) → payload-bearing whole-chat operations
are externalized to chat rows immediately, removed stub references are queued →
**the response is acknowledged from RAM**, and persistence is debounced ~5 seconds.
The debounced persist legacy-encodes the whole stripped database and commits it plus
queued chat-row deletions in one synchronous SQLite transaction; a persist failure is
surfaced on the *next* patch response (`recordPersistFailure`). Reads, backups, and
`/api/db/flush` flush pending work first.

Consequences worth knowing:
- A process crash inside the 5-second window loses acknowledged patches; only
  `/api/db/flush` (and full writes) are durability proofs.
- Two whole-database passes still occur per mutation generation: the compositional
  hash of the pre-patch state and the full re-encode + MD5 for the response ETag.

### 5.2 Full-write path (`POST /api/write` for `database.bin`)

Pre-parser auth/stale-writer/declared-size admission → body buffered whole (512 MiB
database-route cap by default, also charged to the process-wide 512 MiB ingress
budget) → ETag check — **only enforced when both**
`x-if-match` **and the in-process ETag exist**; a cache-cold (freshly restarted)
server skips it (`server/node/server.cjs:10516-10525`) → full decode → guards
(stub-loss chats rejected, duplicate `chaId` rejected) → `splitFullDb()` separates
payload chats into individually encoded rows and inline plugin data into external rows
→ one synchronous transaction commits plugin rows + manifest + chat rows + stripped
`database.bin` + known removed chat rows. On a cache-cold write, removed-chat
detection is skipped; orphans wait for `/api/db/optimize` (1-hour grace).

### 5.3 Chat rows and plugin rows

- `POST /api/chat-content` writes are write-through (no debounce): inside the storage
  FIFO, the existing row is captured as a pre-image backup (best-effort, never blocks
  the save), the new row is written (byte-for-byte if valid binary; re-encoded if
  JSON/healed hybrid), read back, and its SHA-256 returned. Bare stubs are rejected;
  hybrid `_stub`+messages objects are healed. There is no per-row version/CAS — chat
  rows are last-write-wins behind the writer fence.
- Plugin mutations write value + owner sidecar + manifest + recovery-dirty token in
  one transaction, with quota enforcement against the derived usage counter
  (128 MiB/value, 1 GiB aggregate by default). Owner revisions are
  `sha256(domain-separator + owner incarnation + value bytes)`, so delete/recreate
  with identical bytes yields a new revision. Post-commit verification failures are
  reported as `verification: unavailable` rather than pretending rollback.

### 5.4 Concurrency and crash-safety

- One process-wide promise FIFO serializes all ordinary mutations
  (`queueStorageMutation()`); there is a single writable SQLite connection.
- Destructive imports claim the abortable import barrier, drain the FIFO, then hold an
  exclusive transaction; later mutations get retryable `503 IMPORT_IN_PROGRESS`
  instead of silently joining a transaction that may roll back.
- Writer fencing: last `/api/session` caller wins; displaced sessions get 423 on
  mutations. Requests without `x-session-id` bypass the fence (compatibility).
- SQLite runs WAL + `synchronous=FULL` by default (`balanced`/`performance` modes
  drop to `NORMAL` with documented 1/5-minute power-loss windows). Transactions are
  the crash-atomicity boundary; the one exception is the patch debounce window above.

---

## 6. Server self-management of existing data

Maintenance exists but is deliberately uneven: recovery-oriented mechanisms are
automatic; space reclamation is mostly operator-triggered.

### Automatic

| Mechanism | Behavior |
|---|---|
| **Automatic snapshots** | Event-driven (after full writes, debounced patch persists, chat writes, before destructive imports; plugin publications set a durable dirty token that retries until satisfied). Cooldown 5 min (`POCKETRISU_BACKUP_INTERVAL_MS`). Each snapshot is a *self-contained* database (chat rows and selected plugin generation folded back in, streamed via the disk spool, never monolithized in RAM). Retention: 20 snapshots / 500 MiB by default; the byte cap measures **marginal physical chunk cost after dedup**, and the newest snapshot is always kept. Missing chat rows are preserved as bare stubs so damaged state still gets a recovery point. |
| **Chat version backups** (`server/node/chatBackups.cjs`) | Pre-image capture immediately before each `/api/chat-content` overwrite (45 s per-chat cooldown; skipped for cold-storage placeholders). Loose `v-*.bin` files are gzipped, folded into 25-version solid bundles, max 4 bundles/chat (≈124 recognized versions), global 50 MiB budget with oldest-first eviction that never removes a chat's newest version. Reconciliation runs at startup and 7.5 s after captures — not periodically. Full-write/import chat writes bypass capture. |
| **Startup recovery** | Import-journal replay (finalize or roll back staged filesystem swaps), spool/stage/temp sweeps, plugin transition receipt reconciliation (24 h stage TTL), chat-externalization migration with a pre-migration safety copy, read-only database preflight — a corrupt database boots into authenticated snapshot-recovery mode instead of being mutated. Snapshot restore is operator/browser-chosen, not automatic. |
| **WAL checkpointing** | Background scheduler in all modes (TRUNCATE maintenance checkpoints every 1–5 min depending on durability mode, busy retries); flush verifies FULL; shutdown truncates. |
| **Plugin derived state** | Quota counter and owner index rebuilt from physical rows at every boot. Manifest-based quarantine is automatic *logically* (unmanifested rows read as absent) but their bytes are not deleted. |
| **Tombstones / logs** | `deleted_keys` pruned at boot + hourly (7-day retention). `logs.db` trims to ~5,000 rows by insertion count. |

### Manual only (`POST /api/db/optimize`)

Orphan chat-row sweep (rows unreferenced by the live stub graph, 1-hour grace),
**chunk garbage collection** (mark/sweep of unreferenced chunk bodies), checkpoint,
`VACUUM`, checkpoint again. Chunk GC is deliberately off the hot save path — replaced
chunks and rotated-snapshot chunks accumulate until an operator clicks Optimize.

### Confirmed absent

No scheduled VACUUM/incremental vacuum/`ANALYZE`/`PRAGMA optimize`; no automatic chunk
GC; no server-backup file rotation (completed `backups/risu-backup-*.bin` files
accumulate until manually deleted; `POCKETRISU_HUB_HOSTING` disables the whole file
feature); no quarantined-plugin-row sweep (only an explicit full plugin clear removes
them); no chat-backup pruning tied to chat/character deletion (a deleted chat keeps at
least its newest backup version indefinitely); character deletion is client-side
trash (3-day `trashTime`, removed at a later boot) rather than a server cascade.

---

## 7. Architectural changes vs. original RisuAI

Comparison against `/home/codex/Risuai`. Two common claims need qualification first:
upstream's current encoder is already internally block-segmented (root/presets/
modules/plugin/character blocks) — "monolithic" is accurate at the write boundary,
not internally — and upstream already has deep proxy-based mutation tracking. The
comparable upstream backend (its Node server) is a plain filesystem object store with
unconditional whole-file writes and no ETag/writer identity.

| # | Upstream RisuAI | PocketRisu | Why it matters |
|---|---|---|---|
| 1 | Every save writes the complete encoded database (`database.bin`); server replaces the file blindly | JSON Patch + `expectedHash` against a stubs-only baseline; ETag-guarded full-write fallback; 409/rebase conflict protocol | Bandwidth (routine edits no longer upload everything) and correctness (no silent last-writer-wins database loss) |
| 2 | Chats embedded in the database (`character.chats[].message[]`); cold storage and remote-character saving are partial exceptions | Permanent `chats/…` rows; stubs in the root; lazy per-chat hydration; row-before-stub commit ordering | Browser memory (unopened chats never load), startup payload, write amplification (editing one chat writes one row), ID-keyed correctness |
| 3 | `pluginCustomStorage` inline in the database; whole plugin block re-encoded on any change | Opt-in optimized mode: per-key `pluginsave/` rows + owner sidecars + exact manifest bound to `pluginStorageGeneration`; CAS/batches; staged transitions; quarantine of unmanifested rows | Removes plugin data from every database read/write; per-key I/O; lost-update protection; abandoned rows cannot silently become state. V2/V2.1 plugins block the mode (synchronous inline access) |
| 4 | Pluggable backends (account storage, localForage/OPFS, Tauri fs, plain-fs Node server) | One Node/SQLite authority: KV + chunk store, WAL, real transactions, pinned snapshot reads | Transactional multi-row commits, point-in-time exports, dedup; trade-off: single-process self-hosted deployment only |
| 5 | Deep tracking exists, but a chat edit dirties its whole character block; no separate chat durability protocol | Scoped tracking (active chat only deep-observed), staged chat rows, 20 s generation checkpoints, explicit save outcomes | Less CPU per keystroke, per-chat write units, verifiable durability (`committed`) |
| 6 | One serialization envelope for everything | Layered formats: stubs-only root, per-row chat/plugin encodings, chunking below SQLite, self-contained RisuSave only at export/snapshot boundaries (streamed server-side) | Small live payloads while keeping upstream interchange; cost is codec/migration complexity |
| 7 | `BroadcastChannel` advisory tab coordination only; no server-side write fencing | Server-enforced writer ownership (`/api/session`, 423) + BroadcastChannel; displaced pages get a frozen recovery UI | Cross-device stale-writer protection; still last-registration-wins, not collaboration |
| 8 | Rolling whole-database backup blobs (count-capped at 20), decoded in the browser | Layered recovery: dedup-aware self-contained snapshots, per-chat pre-image history, import barrier + journal with committed/not-committed/unknown outcomes, corrupt-boot recovery mode | Chat-level mistakes recoverable without rolling back everything; destructive operations cannot be half-applied or blindly replayed |
| 9 | Name-based block cache in localForage (no content hash) | SHA-256-verified, disposable IndexedDB resource cache + hash-negotiated 204s + segmented boot | Repeat-boot bandwidth without trusting browser storage |
| 10 | Composer text is component state | Durable `drafts/…` rows, serialized writes | Typing doesn't dirty the chat; drafts survive reloads |

Net assessment: PocketRisu moved from *one logical object with coarse publication* to
*a hybrid object/row architecture with explicit publication protocols*. The cost is
substantial state-machine/recovery complexity and tight coupling to a single Node
process — a good trade for a self-hosted, large-dataset, single-writer deployment.

---

## 8. Which server parts consume the most memory

### Steady-state residents

- **`dbCache`** — the decoded stubs-only database, held indefinitely
  (`server/node/server.cjs:209-216`). This is by design O(database-without-chats),
  and is the main reason chat/plugin externalization matters.
- SQLite native memory: 64 MiB page cache + up to 256 MiB mmap ceiling.
- Small unbounded maps: per-session plugin-publication state
  (`pluginStorageReadStateBySession`, never evicted with the cookie store) and the
  chat-backup `newestByChatDir` timestamp map — minor leaks, O(sessions)/O(chats).

### Per-request spikes (largest first)

1. **Full database writes**: admitted raw body Buffer + fully decoded object + stripped clone +
   every payload chat encoded simultaneously + re-encoded stripped blob — several
   database-sized representations at once; worst for legacy/imported monoliths that
   still embed chats/plugin data. The database route admits at most 512 MiB by default,
   and all concurrent buffered bodies share a 512 MiB declared-byte budget. One
   admitted body still stays resident while it waits for and runs through the FIFO.
2. **Segmented boot read** (`/api/db/read-cached`): reassembled raw value + decoded
   graph + full legacy blob (for the ETag) + every encoded segment + response
   envelope. A perfect client cache saves bytes on the wire but none of this server
   work.
3. **Chunked value reads**: all chunk buffers + the concatenated logical value
   (~2× the value transiently), plus full SHA-256 verification.
4. **Plugin value writes**: request bytes + UTF-8 string + parsed JSON graph
   (≤128 MiB/value). The "streaming" variant spools ingress to disk but then
   `readFileSync`s the whole spool for validation, so the memory bound is unchanged.
5. **Chat-backup bundling**: gunzips up to 25 versions, concatenates, re-gzips —
   O(25 × chat size) periodically.
6. **Imports/exports are the good citizens**: bounded 64 KiB paged spooling, streaming
   RisuSave walker above 32 MiB, `streamRisuSaveToFile` folding one row at a time,
   ≤2 concurrent export pins. Peak ≈ O(stripped DB + one largest row), the result of
   deliberate fixes to earlier fold-in-RAM spikes.

The performance suite encodes these expectations as contracts (e.g.
`test/performance/plugin-storage-transition-memory.test.ts`: 56 MiB of rows must stay
within ~157 MiB transient ArrayBuffers during externalization; the opt-in extreme test
pushes 448 MiB of rows toward a ~2 GiB RSS target).

---

## 9. Likely performance bottlenecks

- **Client-side whole-database work per save (probably the dominant interactive
  cost)**: every save builds the complete encoded `database.bin`
  (`encoder.set()` stringifies every character, `encode()` allocates the full buffer)
  *before* the patcher runs — a successful small patch discards a fresh full-database
  payload (`src/ts/globalApi.svelte.ts:794-809`). The patcher's fast paths avoid
  re-diffing unchanged entries but still JSON-stringify every root key and character
  to prove it. Several O(database) baselines coexist (encoder blocks, block cache,
  normalized baseline, patcher string baselines).
- **Server patch path is amortized O(database + chat count) per mutation**: one
  compositional hash of the pre-patch state, one full encode + MD5 for the ETag, plus
  chat-payload extraction and old/new referenced-row set construction on every
  mutating patch — even an empty or chat-irrelevant one. (The former deep-clone per
  patch is fixed; this is what remains.)
- **Synchronous SQLite + one storage FIFO**: every large `kvGet`/transaction/gzip/
  chunk-hash pass blocks the event loop and all queued requests. Chunked values add
  FastCDC scanning + per-chunk SHA-256 + whole-value SHA-256 on both read and write
  (~D/16 KiB statement executions).
- **Chat save hot path**: each checkpoint decodes the incoming chat, captures a
  pre-image, writes + re-reads + hashes the row, and attempts snapshot creation; the
  first post-cooldown save pays a full disk-spooled snapshot inside the storage queue.
  Chat-backup reconciliation (sync gzip + whole-tree size rescans) also runs in the
  queue.
- **Per-key plugin mutations are O(manifest)**: full manifest parse, two key-set
  clones, manifest rewrite + reread verification per value write — high-cardinality
  plugins doing many single-key writes pay O(mutations × keys). The batch endpoint
  amortizes this but is not what plugins do by default.
- **Conflict recovery** re-downloads and decodes the full database and performs
  multiple whole-database clones during the merge.

---

## 10. Where network traffic is wasted

- **First boot / cache-off boots** transfer the complete stubs-only database; the
  resource-cache opt-in prompt appears only *after* the first full download, and
  cache-envelope failures fall back to a second full download on top of the partial
  one. Conflict/rebase reads always use full `/api/read` without `If-None-Match`
  (the server's 304 branch is effectively unused by first-party flows).
- **Whole-chat retransmission**: every chat save uploads the entire message history;
  during a long generation each ≥20 s checkpoint resends all prior messages plus the
  new suffix — roughly quadratic bytes in generated length across a session. There is
  no append/delta protocol and no pre-upload hash no-op check.
- **Patches that aren't small**: ID-array structural changes (add/delete/reorder of
  characters, modules, presets) embed the whole array in one operation; dangerous-op
  or other non-conflict patch failures escalate to a full database upload.
- **Empty patch requests**: a generation checkpoint whose stub metadata didn't change
  can reach `/api/patch` with zero operations (`patch.length` is not checked before
  sending).
- **Uncompressed uploads**: full writes (JSON-block container), chat rows
  (MessagePack), and plugin JSON are sent without `Content-Encoding`; only downloads
  negotiate compression. Backup downloads are deliberately uncompressed (heartbeat
  correctness) even when highly compressible.
- **Cache-limits misses**: the resource cache caps at 64 MiB total / 32 MiB per value;
  big databases or chats churn out of it and re-download. Every `keys()` call still
  contacts `/api/list` (delta, not local-only), and a stale/epoch-mismatched baseline
  degrades to a full listing (O(keys) bytes).
- **Legacy plugin discovery** (pre-generation states) lists both `pluginsave*`
  prefixes; boot reconciliation transiently reads *every* optimized row.
- **Polling**: only partial-export preparation polls (250 ms status requests); the
  save loop itself does not poll the network.

---

## 11. Recommendations: better ways to process and manage `Database` data

Ranked by expected impact; all are grounded in the findings above.

### High impact

1. **Run the patcher first; build the full encoded database only when actually
   needed.** Today every save constructs a complete `database.bin` that a successful
   patch throws away. Reordering (patch → send → keep encoder baselines incrementally;
   encode fully only on fallback) removes the all-character stringify and full-buffer
   copy from routine saves (`src/ts/globalApi.svelte.ts:794-809`,
   `src/ts/storage/risuSave.ts`).
2. **Replace content-derived patch hash/ETag with an opaque server revision counter.**
   The MD5-of-full-encode ETag and the compositional hash force two whole-database
   passes per mutation generation. A monotonically incremented revision (returned on
   every read/patch, compared on write) preserves the conflict protocol while making
   patch cost proportional to the patch (`server/node/server.cjs:231-269`,
   `:10826-10846`, `:10923-10926`). This is a coordinated client/server protocol
   change and should keep the current ETag as a migration fallback.
3. **Append/delta chat persistence.** Chat rows are the largest recurring upload.
   An append protocol (send new/changed messages plus a base-row hash; server folds
   into the row; periodic full checkpoint as a safety net) turns generation traffic
   from O(chat size) per checkpoint into O(new tokens), and also shrinks the
   chat-backup churn that follows every overwrite. The existing `x-content-hash`
   response is a natural building block for the no-op check half of this.
4. **Make maintenance self-running.** Chunk GC, the orphan chat-row sweep, and VACUUM
   currently depend on an operator pressing Optimize; server-backup files and
   quarantined plugin rows are never reclaimed at all. A low-frequency background
   task (idle-triggered or interval, behind the storage queue, hub-mode-aware) that
   runs chunk GC + orphan sweep, plus a retention cap for `backups/risu-backup-*.bin`
   and an explicit "purge quarantined plugin rows older than N days" policy, would
   bound long-term disk growth without changing semantics.

### Medium impact

5. **Cache segmented boot payloads by database generation.** `/api/db/read-cached`
   re-decodes, re-encodes, re-segments, and re-hashes the whole database on every
   boot even when the client has everything. Segments are immutable between mutations;
   memoizing them per cache generation (like the ETag memo) makes warm boots cheap on
   the server too (`server/node/dbCachedRead.cjs`).
6. **Make plugin manifest membership incremental.** Store membership in normalized
   SQLite rows (or maintain the manifest index incrementally) instead of parse → clone
   → rewrite → reread of the full key list per single-value mutation; nudge plugin
   authors toward the batch endpoint (`server/node/server.cjs:9077-9208`).
7. **Fix the "streaming" plugin mutation to actually stream validation** — replace the
   `readFileSync` of the spooled value with the existing 64 KiB streaming JSON
   validator, removing an up-to-128 MiB buffer and a long synchronous parse from the
   event loop (`server/node/server.cjs:8999-9055`).
8. **Skip chat bookkeeping for chat-irrelevant patches, and don't send empty
   patches.** Maintain referenced-row sets incrementally from chat-identity-touching
   operations only; client-side, return no-op before `/api/patch` when
   `patch.length === 0`.
9. **Resolved — body limits and admission control.** `bufferedIngress.cjs` authenticates
   and checks stale-writer eligibility before parsing, requires exact uncompressed
   `Content-Length`, applies database/chat/KV/proxy/plugin/JSON route caps, and bounds
   all concurrent parser reservations with a release-on-finish/close 512 MiB ledger.
   The writer-lock transition remains inside the accepted mutation route.

### Smaller correctness/robustness items surfaced by this audit

10. **Cache-cold full-write ETag gap**: after a server restart, `/api/write` skips the
    ETag comparison when `dbEtag === null` (`server/node/server.cjs:10516-10525`).
    Deriving the current ETag from storage before accepting a guarded write closes a
    lost-update window that defeats the purpose of the guard exactly when it matters
    (post-crash).
11. **Raw-boot plugin reconciliation 409s**: after a raw (uncached) boot the session
    has no recorded plugin publication state, and reconciliation row reads that omit
    a generation can be rejected ("read database.bin first"), surfacing spurious
    boot issues (`src/ts/plugins/pluginSaveStorage.ts:3793-3911`,
    `server/node/server.cjs:4337-4340`).
12. **Unbounded small maps**: evict `pluginStorageReadStateBySession` alongside
    session pruning, and cap `newestByChatDir` in `chatBackups.cjs`.
13. **Chat GET double assembly**: the route decodes the row and then re-reads the raw
    row for the response — a chunked chat is reassembled twice per request
    (`server/node/server.cjs:12142-12195`).
14. **Stream chat-backup bundling** (pipe versions through one gzip stream; keep a
    running byte total instead of re-scanning the tree) to remove the O(25 × chat)
    periodic spike from the storage queue.
15. **Consider compressing uploads** (full-write fallback, chat rows, plugin JSON) —
    `Content-Encoding: gzip` on request bodies is cheap for the mostly-text payloads
    involved, and matters for remote/tunnelled deployments.

### Directional (larger redesigns, not immediate)

- **Character externalization** is the natural next step after chats: characters are
  the largest remaining component of `database.bin`, the segmented-read protocol
  already treats them as independent units, and stubs+rows would shrink the patch
  baseline, `dbCache`, and boot payload alike. The same stub/allowlist/guard machinery
  built for chats is the template — and the main cost driver (every remaining
  O(database) pass above) shrinks proportionally.
- **Per-row versioning for chat rows** (an `x-if-match` on `/api/chat-content`) would
  extend the lost-update protection that the database and plugin planes already have
  to the one plane that is still last-write-wins.

---

## 12. Quick reference: the ten questions in one table

| Question | Short answer |
|---|---|
| How does the server provide data? | Verbatim raw boot read (or hash-segmented cached read) of the stubs-only database with MD5 ETag; lazy per-chat rows with SHA-256-negotiated 204s; manifest-gated per-key plugin reads; full/delta key listings behind the import barrier (§2) |
| What does the client do when saving? | deepTouch-tracked 500 ms-debounced save loop; chat rows written before the stubs-only database; JSON Patch with structural hash, ETag-guarded full-write fallback; 409 rebase, 423 displacement; explicit save outcomes (§3) |
| What goes over the wire? | Patch JSON + `expectedHash`; full writes as uncompressed `RISUSAVE\0` containers; whole-chat MessagePack rows; per-key plugin JSON / base64 batches; tiny drafts (§4) |
| How does the server store it? | One SQLite KV + content-defined chunk store; patch applied copy-on-write to a resident cache with 5 s debounced transactional persist; full writes split chats/plugin data into rows in one transaction; single mutation FIFO + import barrier + writer fence (§5) |
| Self-management? | Automatic: snapshots (cooldown + dedup-aware rotation), chat pre-image history, startup recovery, WAL checkpoints, tombstone/log pruning. Manual only: chunk GC, orphan sweep, VACUUM. Absent: backup-file rotation, quarantine sweeps (§6) |
| Changes vs. upstream? | Stubs-only root + externalized chats and plugin rows, patch/ETag protocol, SQLite transactions + chunk dedup, writer fencing, layered recovery, verified caching, drafts (§7) |
| Better ways? | Patch-first client encoding, opaque revisions, append chat persistence, automated maintenance, then §11's medium/small items; character externalization as the directional step |
| Most memory? | Resident decoded `dbCache`; spikes from full-write multi-copies, segmented-read assembly, chunked-value reassembly, plugin value validation (§8) |
| Bottlenecks? | Client full-encode-per-save; server per-mutation full hash/encode; synchronous SQLite behind one FIFO; O(manifest) plugin mutations; whole-chat checkpoint pipeline (§9) |
| Wasted bandwidth? | Cold-boot full downloads + double download on cache failure; whole-chat retransmission each checkpoint; array-scale "patches" and full-write escalations; empty patches; uncompressed uploads (§10) |
