# Concurrency evidence dossiers

Gathered 2026-08-04 against `7ddb8aca` by four independent read-only code surveys,
cross-checked against `docs/structure/` and spot-verified by hand
(`server/node/server.cjs:645`, `:699`, `:4839`; `src/ts/storage/nodeStorage.ts:1130`).
Companion to [00-charter.md](00-charter.md) §8. Line hints are approximate; re-verify
with `rg` before relying on one.

## D1 — Writer-lock semantics

- Authenticated reads never call `checkActiveSession()`; concurrent reads are always
  permitted (`/api/read`, `/api/list`, bulk asset read, chat-content GET —
  `server/node/server.cjs:10797`, `:11274`, `:16929`, `:18151`).
- `register()` records boot time, adopts only a free lock, never steals
  (`server/node/session-lock.cjs:48-62`). Writer routes are the `WRITER_ROUTES` set
  plus dynamic chat/backup routes (`server/node/bufferedIngress.cjs:133-183`).
- `checkWrite()` outcomes (`server/node/session-lock.cjs:64-88`): active session
  passes and refreshes `lastWriteAt`; fresh (booted after last accepted write) +
  gesture-backed takes over; fresh without gesture passes **passively** without
  moving or refreshing the lock; stale is rejected. Stale + gesture is still
  rejected (`server/node/session-lock.test.ts:127-133`).
- Gesture proof: capture-phase `pointerdown`/`keydown` set a 15-second recency
  window; `authFetch` adds `x-user-active: 1` only inside it
  (`src/ts/storage/nodeStorage.ts:1130-1145`, `:1882-1888`); the server accepts
  exactly `'1'` (`server/node/server.cjs:4839-4845`). Session identity persists in
  `sessionStorage` (`risu-writer-session-id`, `src/ts/storage/nodeStorage.ts:1545-1560`).
- Restart: lock state is in-memory; first registration or write adopts
  (`server/node/session-lock.cjs:40`, `:68-70`).
- 423 path: `authFetch` dispatches `risu-session-deactivated`
  (`src/ts/storage/nodeStorage.ts:1906-1911`); buffered admission pre-refuses stale
  writers via side-effect-free `peek()` before body buffering
  (`server/node/bufferedIngress.cjs:385-435`); the client latches writer loss and
  offers frozen read-only recovery or reload, never replaying stale state
  (`src/ts/storage/writerTakeover.ts:38-120`; `src/ts/globalApi.svelte.ts:817-829`).
- Compatibility exemption: an empty/absent `x-session-id` passes the lock untouched
  (`server/node/session-lock.cjs:64-67`); auth/bootstrap/read/log routes are outside
  the writer gate entirely.

## D2 — Server guard inventory (hazard classification per charter §4)

| Mechanism | Where | Hazards |
|---|---|---|
| Storage promise FIFO | `server/node/server.cjs:645-650` | H4 |
| Barrier check inside the queued callback | `server/node/server.cjs:699-707` | H3 |
| Import barrier claim/drain/refuse; read retry on import race; retryable 503 | `server/node/importBarrier.cjs:55-139`; `server/node/server.cjs:911-955`, `:17472`, `:20062` | H3 |
| Writer session lock + 423 | `server/node/server.cjs:4795-4851` | Boundary enforcing §3.6 (see charter §8 note) |
| Client-build admission (426) | `server/node/server.cjs:2593-2609` | H8 |
| Per-mutation SQLite transactions (KV set/delete, `/api/write`, patch persistence, chat rows) | `server/node/db.cjs:546-632`; `server/node/server.cjs:16490-16509`, `:16133-16155`, `:2426-2503`; `server/node/chatRows.cjs:684-850` | H1, H4, H3 |
| WAL + `synchronous` policy; busy-checkpoint retry | `server/node/db.cjs:50-64`; `server/node/server.cjs:816-892` | H1 |
| Stripped-view ETag CAS; patch base-hash check | `server/node/server.cjs:16104-16111`, `:16359-16368`, `:16770-16783` | H9, H10, H5 |
| Revision triggers + revision-bound decoded cache | `server/node/databaseRevision.cjs:6-55`; `server/node/revisionBoundCache.cjs:78-89` | H4, H9 (pricing exemplar: O(token) gate before expensive decode) |
| Post-queue revalidation of cache/publication/prior state | `server/node/server.cjs:16728-16735`, `:2429-2495` | H4 |
| Chunk publication atomicity; plan-to-file identity binding; revision-bound verified-read memos | `server/node/chunkStore.cjs:1304-1488`, `:1382-1404`, `:1636-1653` | H1, H4 |
| Chat `row_token` bind/retry on async reads; token-conditional metadata repair; import-hold suppression | `server/node/chatRows.cjs:929-994`; `server/node/server.cjs:18184-18211` | H4, H3 |
| Chat delta base-hash/log-chain validation | `server/node/chatRows.cjs:780-850` | H10, H4 |
| Pre-image capture inside queue immediately before overwrite; forced deletion pre-images | `server/node/server.cjs:18297-18311`, `:18370-18389`, `:2386-2403` | H1, H2 (recovery provisioning) |
| Snapshot global-token match-then-publish; assembly outside queue | `server/node/db.cjs:758-835`; `server/node/server.cjs:1607-1633` | H4 (pricing exemplar: pin outside, revalidate at publish) |
| Plugin publication guards: `PLUGIN_STORAGE_PUBLICATION_GUARD`, post-admission generation/manifest re-read, per-row CAS, commit-then-cache ordering | `server/node/server.cjs:16700-16725`, `:13050-13222`, `:13582-13735` | H4, H10, H2 |

The survey found **no server mechanism whose only justification is a second
independent writer**, other than the writer lock itself — which is the boundary that
makes that exclusion true, at O(1) cost.

## D3 — Client defensive patterns

| Pattern | Trigger | Cost when fired | Normal-operation frequency | Hazards |
|---|---|---|---|---|
| Patch-conflict recovery + dirty-branch rebase | `DATABASE_PATCH_CONFLICT` / ETag conflict | Full DB read + decode + overlay + codec rebuild + retry | Zero while baseline current | H9, H10, H5 |
| ETag-guarded full-write fallback; refuse unversioned writes | Non-conflict patch rejection, guard paths | Full `database.bin` encode + send | Zero when patches succeed | H9, H10 |
| List delta with epoch/staleness fallback | Epoch mismatch, >6-day cache, future-dated | One full key list instead of a delta | Uncommon; but **every** cached `keys()` still costs one round trip | H7 |
| Segmented boot fallback | Any cache/envelope/ETag anomaly | One full raw boot read | Zero on valid cache | H7 |
| Hash-verified 204 protocol | Cache-enabled KV/chat read | Hit: IDB read + re-hash; miss/anomaly: one authoritative re-read without cache header | Hits on every cacheable read once warm | H7 |
| Legacy empty-boot proof | Empty legacy `/api/read` | One uncached `/api/list` | Legacy servers only | H2, H7 |
| Chat hydration/shape guards | `_placeholder`/`_stub` access | One row read per first open, deduplicated | Once per unopened chat | Data-integrity contract (out of audit scope) |
| Chat-delta full-row fallback | `CHAT_DELTA_*` refusal or digest mismatch | Send already-prepared full row; never replay ambiguity | Rare | H10, H2 |
| `requestImmediateSave()` outcome protocol | Every explicit save | No network when clean; explicit `committed`/`retry`/`failed`/`displaced` | Continuous, O(1) when clean | H2, H5 |
| Plugin boot reconcile (`PLUGIN_STORAGE_BOOT_CONFLICT`) | Optimized-mode boot | One server-side reconciliation; DB reload only on change/conflict | Once per boot | H9, H10 |
| Manifest-revision echo (in `pluginSaveStorage.ts`) | Every committed optimized mutation | Valid echo: zero manifest re-read; anomaly: one authoritative snapshot read | Continuous happy path | H9, H10 (adoption exemplar) |
| Writer displacement latch: BroadcastChannel, 423 latch, foreground `peek` (5 s throttle) | Displacement events | No replay; frozen recovery or reload | Zero takeovers in normal operation | H5 — the only client mechanism justified solely by another session, priced O(1) |

## D4 — Background actors (single process, concurrent with requests)

| Actor | Trigger | FIFO relationship |
|---|---|---|
| Boot recovery/migrations, spool/stage sweeps | Boot, before serving | Outside (pre-serving) |
| Automatic snapshots (`createBackupAndRotate()`) | Coalesced after eligible writes; ≥ `POCKETRISU_BACKUP_INTERVAL_MS` (5 min default) | Short capture + publish phases inside; assembly outside on pins |
| Plugin recovery snapshots | `config/plugin-storage-recovery-dirty` marker + debounced retry | Same split as snapshots |
| Durability scheduler | 60 s (balanced) / 5 min checkpoints; busy retry 10 s; truncate maintenance (durable) | Checkpoint briefly inside |
| Asset GC | Delayed first sweep + interval | **Entire scan/plan/delete inside one mutation hold** |
| Chat-backup pre-image capture | Immediately before each chat overwrite/delete | Inside (streams pre-image during hold) |
| Chat-backup reconciliation | Boot-after-listen + 7.5 s debounce per write | **Whole scan/convert/trim inside one hold** |
| Patch persistence (`persistDbCache`) | 5 s debounce after `/api/patch` | Inside (encode + commit) |
| Chat-log compaction | ≥64 ops or ≥1 MiB, deduplicated, `setImmediate` | Inside (materialize + rewrite base) |
| Model jobs (`runJob()`, cleanup) | Per request; 10 min cleanup; 48 h pending-send expiry | Outside (separate DBs/journals) |
| Proxy-stream jobs + 60 s GC | Per request | Outside |
| Partial-export jobs + shared GC | Per request | Pinned read admission inside; assembly outside |
| List-deletion journal cleanup | Boot + hourly | **Outside the FIFO, direct SQLite** |
| Request-log / diagnostic-log rotation | Row-count thresholds | Outside (separate DBs) |
| Request tracing | Response `finish` | Own promise FIFO |
| Chunk-plan workers, JSON validate worker, single-flight protected reads | Per admitted write / per read | Outside until queued publication |

## Phase 2 seeds surfaced by these surveys

Recorded here so the lens passes start from evidence, not memory. These are
*candidates*, not findings.

1. **W6/S4** — Asset GC holds one storage-mutation turn for its entire
   scan/plan/delete sweep; foreground mutations queue behind it.
2. **W6/S2** — Chat-backup pre-image capture streams the old row to disk inside the
   mutation hold on every eligible chat overwrite; reconciliation holds a turn for a
   whole scan/convert/trim pass.
3. **W1/S2** — The list-delta protocol still costs one round trip per cached
   `keys()` call; the delta only shrinks bytes, not requests.
4. **UNK** — `kvCleanupOldDeletions()` mutates the deletion journal outside the
   FIFO; verify the safety argument (SQLite serialization + no compound invariant)
   or bring it inside.
5. **W4/S2 (low)** — Verified-cache hits pay IDB read + SHA-256 re-hash per hit by
   design (H7); confirm the hash cost stays trivial for large chat rows.
6. **W6/S2** — Patch persistence and chat-log compaction encode/materialize inside
   their mutation holds; check whether encoding can be prepared outside the hold
   with a revision recheck at commit (the snapshot pattern).
