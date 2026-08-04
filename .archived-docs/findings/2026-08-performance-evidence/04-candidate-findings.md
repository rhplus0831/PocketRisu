# Phase 2 candidate findings register

Compiled 2026-08-04 against `7ddb8aca` from five lens surveys
([05-lens-evidence.md](05-lens-evidence.md)) cross-checked against the measured
baselines ([03-trace-baselines.md](03-trace-baselines.md)). **Candidates, not
verdicts** — Phase 3 adversarially verifies before anything enters a remediation
runway. Severity/waste codes per the charter §6. "Empirical" = reproduced by the
E2E harness; "static" = code-derived.

## Top priority (empirically confirmed, large, user-visible)

| ID | Finding | Class | Evidence |
|---|---|---|---|
| PF-01 | **Chat save-path deltas never engage on ordinary streaming sends.** `chat.isStreaming` and its optimization-mode toggle are runtime-only fields mutated on every streamed generation (`src/ts/process/index.svelte.ts:1548`, `:1684`); they produce non-message diffs, so `prepareChatDeltaPatch()` returns null and every save falls back to the full encoded row. Hooks writing `scriptstate` compound it. Measured: one exchange in a 400-message chat uploads 427 KB (good case) to 872 KB (checkpoint + final, PF-02). With deltas working these would be ~1–2 KB patches. | W2 / S2, scales with active-chat row bytes | Empirical + static |
| PF-02 | **One exchange performs up to two full-row writes.** The user-message save fires during generation (no checkpoint timestamp yet, `chatPersistStage.ts:260`), the tracker re-arms on completion and the final pass writes again (`globalApi.svelte.ts:600`). Both are full rows because of PF-01. Fix couples with PF-01; coalescing alone must not weaken checkpoint durability. | W2 / S2 | Empirical + static |
| PF-03 | **Fresh-instance initialization runs ~7 patch/read cycles uploading ~205 KB on an empty DB.** First-run boot: 7× `/api/patch` (204,932 B total) + 7× `/api/read` + 6× `/api/logs` before any user action. Successive startup phases (defaults fill, plugin fields, per-character migration) each trigger their own save/re-read cycle. | W1+W2 / S3, per fresh instance | Empirical |
| PF-04 | **First boot after any import/restore uploads a DB-scaled normalization patch.** Confirmed one-time: 31.7 KB (10 characters) → 294 KB (300 characters), zero on second boot. Boot fills defaults/migrations after capturing the pre-default baseline (`bootstrap.ts:157`, `database.svelte.ts:42-126`), so the whole normalization diff — including a whole-`/characters` array replacement when IDs/order change (`risuSave.ts:1857`) — uploads once per restored DB. On production-size DBs this is potentially many MB after every restore, competing with first-use interactivity. | W2 / S3, scales with DB bytes; per restore | Empirical + static |
| PF-05 | **The segmented cached boot read is a net loss for small databases.** Fixed costs: hash advertisement ≈ 67 B/hash, ≈ 72 B per all-hit segment envelope, one segment per array member across characters/botPresets/modules/personas (`dbCachedRead.cjs:80`, `:319`); client verifies up to 5× the 8,192-hash advertisement cap before selection (`nodeStorage.ts:4421`, `resourceCache.ts:512`). Network-only crossover ≈ `raw > 200 + 139·N` bytes — ≈ 1.1 MB at the segment cap. Measured: warm cached boot rx 6,703 B vs 3,642 B raw. Fix: size-aware bypass negotiating raw boot below the crossover; budget-aware verification. Must not weaken hash/ETag fallback. | W2+W5 / S2–S3 | Empirical + static |

## Plugin storage (adoption + cache)

| ID | Finding | Class |
|---|---|---|
| PF-06 | Legacy full-manifest mutation route returns no manifest-revision echo (`server.cjs:13952`), forcing clients to invalidate ownership state before dispatch (`pluginSaveStorage.ts:1562`); callers: hashed/non-generation set/remove, owner ops, clear, DB-bridge writes, boot recovery. Next ownership op pays a full authoritative re-read. | W1+W5 / S2 |
| PF-07 | `clearPluginSaveStorage()` and `setPluginSaveStorageOwner()` read full ownership twice per invocation (`pluginSaveStorage.ts:3418`, `:3790` + `:1536`). | W1+W4 / S2 |
| PF-08 | Enumeration snapshots are invalidated on every set/remove even when the echo path retained/restamped ownership and membership did not change (`pluginSaveStorage.ts:2387`, `:472-498`). | W5 / S2 |
| PF-09 | Server manifest cache is keyed to a revision that advances on **every** `database.bin` write, so ordinary chat/character saves evict a valid parsed manifest (`databaseRevision.cjs:61`, `pluginStorageManifestCache.cjs:116`). Split the revision or key on the publication tuple. | W5 / S3 |
| PF-10 | Externalized plugin snapshot/owner/boot reads are per-row round trips, partly serial (`pluginSaveStorage.ts:1862`, `:3887`, `nodeStorage.ts:5418`); batch/page siblings exist. Generation pinning must be preserved. | W1 / S2–S3 |
| PF-11 | Bulk-transition and batch preparation MessagePack-encode and SHA-hash rows on the main thread (`pluginStorageTransitionBulk.ts:173`, `nodeStorage.ts:3401`); `PayloadCodecService` covers only chat rows. | W4 / S2 |
| PF-12 | Generic `/api/write` plugin rows validate by reading the whole spooled row into memory (`server.cjs:16011`) while the streamed routes validate incrementally (`importSpool.cjs:291`). | W4 / S2 |

## Server materialization (request paths that decode the world)

| ID | Finding | Class |
|---|---|---|
| PF-13 | `/api/db/stats/characters` and `/modules` kvGet + fully decode `database.bin` per request; siblings use `prepareLiveDatabaseRead()`. | W3+W4 / S2 |
| PF-14 | Plugin recovery-management inspection flushes + decodes the full DB per read. | W3 / S2 |
| PF-15 | Header-less `/api/chat-content` fallback decodes the full DB for one stub lookup on a cache-cold path. | W3 / S3 |
| PF-16 | `/api/db/stats` estimated-backup-size parses and re-stringifies every cold-storage row for an aggregate number; verified logical-size metadata exists. | W3+W4 / S3 |
| PF-17 | Inlay reference scans decode **every** chat row inside the mutation queue, for reference lists and delete guards (`server.cjs:3643`, `:11143`). Needs a reference index or pinned out-of-queue scan with token revalidation (conservative staged-row/cold-storage semantics must survive). | W3+W6 / S2 |
| PF-18 | Partial export loads the whole `database.bin` and uses the object-based encoder while full export's source-to-source streaming sibling exists (`server.cjs:8981`, `:7329`). | W3 / S3 |
| PF-19 | Cold-storage import/restore `gunzipSync` + `JSON.parse` with no decoded-output bound (`server.cjs:4591`, `:5491`); bounded disk-backed decompression exists for RisuSave. | W3 / S2 |
| PF-20 | Plugin viewer pin decodes DB + parses manifest per page request (`server.cjs:11888`) — point-in-time semantics intentional; needs a snapshot-revision fast path (BLOCKED-NEEDS-DESIGN). | W3 / S3 |

## FIFO hold pricing (all load-bearing; re-price, never remove)

| ID | Finding | Class |
|---|---|---|
| PF-21 | Asset GC holds one mutation turn for flush + DB decode + full reference scan (≤2 M nodes) + deletes (`server.cjs:7213-7282`). Discovery could run outside with token revalidation at delete; blocked on a composite reference token covering DB + external plugin values. | W6 / S4 |
| PF-22 | Chat pre-image capture streams the old row to disk, fsyncs, and renames inside the mutation hold on every eligible overwrite (`server.cjs:18269-18496`, `chatBackups.cjs:825`). Pin-outside/revalidate-at-publish candidate; deletion captures must stay fail-closed. | W6 / S2 |
| PF-23 | Chat-backup reconciliation performs discovery, conversion, migration, trims, and repeated tree rescans in one queued turn (`chatBackups.cjs:1275-1459`); global eviction can rescan per removal. A dedicated backup-filesystem mutex would decouple it from the storage FIFO. | W6 / S2 |
| PF-24 | Deferred patch persistence encodes the full DB and captures deletion pre-images inside its hold (`server.cjs:2426-2503`); prepare-outside with the existing revision/identity tokens as the O(1) commit gate. | W6+W4 / S2 |
| PF-25 | Chat-log compaction materializes base + log inside the queue although `publishCompactedChatRow` already has an exact `rowToken` check to publish against (`chatRows.cjs:874-910`). | W6 / S2 |
| PF-26 | Plugin manifest mutation and boot reconciliation decode the full live DB inside the FIFO (`server.cjs:13858`, `:6222`). | W6 / S3 |
| PF-27 | Six write paths run synchronous FastCDC/SHA chunking inside their mutation/publication turns where the worker-plan path exists: snapshot publish, boot cleanup, streamed plugin mutations ×2, transition finalize ×2, backup-import rows (`chunkStore.cjs:1459` null-plan branch; call sites per appendix). | W6 / S2–S4 |
| PF-28 | `kvCleanupOldDeletions()` outside the FIFO: **not a finding** — single connection, one DELETE, 7-day retention vs 6-day delta window; can technically join an import transaction (operational tombstones only). Recorded as verified-acceptable. | — |

## Client N+1 and missed caches

| ID | Finding | Class |
|---|---|---|
| PF-29 | Package export: one `getInlayMeta` request per inlay; `getInlayMetasBatch` exists (`characterPackage.ts:605`). | W1 / S4 |
| PF-30 | Translator cache search/export: one read per persisted key (`translator.ts:618`); bulk-read sibling exists. | W1 / S4 |
| PF-31 | `listInlayAssets()`: sequential per-inlay body reads after one list (`inlays.ts:251`). | W1 / S4 |
| PF-32 | Plugin owner-row enumeration: one request per row on two backends (`pluginStorageMeta.ts:152`, `pluginSaveStorage.ts:3887`). | W1 / S4 |
| PF-33 | `readImage`/`loadAsset` bypass the verified resource cache; content-hash-named assets are immutable and ideal for it (`globalApi.svelte.ts:218-264`; `getItemCached` exists at `nodeStorage.ts:4320`). | W5 / S2 |
| PF-34 | Inlay bodies use only an in-memory LRU, never the verified cache (`inlays.ts:128-268`); needs sidecar-consistent cache keying (BLOCKED-NEEDS-DESIGN). | W5 / S3 |
| PF-35 | Every cached `keys()` still costs one `/api/list` round trip; skipping needs a per-prefix mutation watermark riding other responses, covering KV+assets+inlays atomically (BLOCKED-NEEDS-DESIGN). | W1 / S2 |
| PF-36 | Client dataset export accumulates all encoded rows as `Blob[]` then copies into one final Blob (`exportAsDataset.ts:32`); `processzip`/`processZip` materialize whole archives, `stableDiff` uses only the first image (`processzip.ts:19`, `:253`). | W3 / S2 |
| PF-37 | Boot plugin reconciliation persistence paths force full-database writes (`bootstrap.ts:49-66`, `pluginSaveStorage.ts:3989`, `:5793`) even when the publication did not change. | W2 / S3 |

## Charter verdicts carried forward

- **No PT findings.** The concurrency lens confirmed §8: every guard names a real
  hazard; all concurrency findings above are LB-COND re-pricing, and every fix
  direction preserves the named protection (tokens revalidated at publish,
  fail-closed deletion captures, authoritative fallbacks intact).
- Findings touching stub guards, publication atomicity, outcome protocols, or
  never-replay rules are marked BLOCKED-NEEDS-DESIGN in the appendix and must
  enter Phase 4 as design items, not quick fixes.

## Phase 3 verification queue (ordered)

1. **PF-01**: prove `isStreaming`/optimization-mode fields are actually part of
   the persisted encoded row (if the row projection strips them, the root cause
   is elsewhere); instrument one send and capture the prepared-patch rejection
   reason. Highest value, gates the biggest fix.
2. **PF-04/PF-03**: decompose the normalization patch (defaults vs whole-array
   replacement vs per-character migration) on the xl fixture; confirm the 7-cycle
   first-run sequence and which phases could coalesce.
3. **PF-05**: reproduce the byte model against a ≥1 MB fixture to confirm the
   crossover sign flips (cache should win there).
4. **PF-21–PF-27**: verify hold shapes with targeted timing instrumentation
   (queue-wait histograms) rather than asymptotics alone.
5. Spot-verify one finding per remaining group (PF-06, PF-13, PF-29, PF-33)
   against current code before ranking the remediation runway.
