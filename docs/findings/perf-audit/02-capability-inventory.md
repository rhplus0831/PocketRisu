# Capability-adoption inventory

Compiled 2026-08-04 against `7ddb8aca` from six independent code surveys over the
`08ce0647..HEAD` runway primitives, cross-checked against `.archived-docs/performance/`
track records. Companion to [00-charter.md](00-charter.md). Entries are **candidates
for the Phase 2 adoption lens, not findings** — several bypasses may be intentional
(point-in-time snapshot semantics, proof-fresh reads); the lens must verify each
against the charter before it becomes a finding. Line hints are approximate.

## How to read this

Each primitive lists its entry points, its adopters (abridged — full citations in
the survey transcripts), and **non-adopters**: call sites still paying the old
pattern. `LIKELY` = a same-shape sibling clearly could adopt; `SPECULATIVE` =
adoption needs protocol or freshness design; `INTENTIONAL?` = the bypass may be a
deliberate semantic (verify before judging).

## 1. Server read path

| # | Primitive | Non-adopters (cost) |
|---|---|---|
| R1 | Revision-bound decoded DB cache (`databaseRevision.cjs`, `revisionBoundCache.cjs`) | Plugin viewer pin decodes `database.bin` directly per request (`server.cjs:11888`) INTENTIONAL? (pinned snapshot consistency); recovery-management inspect re-decodes per read (`:6498`) LIKELY; `/api/db/stats/characters` and `/modules` kvGet + full decode per request (`:19622`, `:19714`) LIKELY; plugin transition paths decode live DB at 5 sites (`:13870`–`:15483`) INTENTIONAL? (mutation-fresh validation) |
| R2 | Verified size-from-metadata (`chunkStore` `sizeValue`/`listValuesWithSizes`) | Partial-export preflight materializes the whole `database.bin` and uses `raw.length` (`:8981`) where `snapshot.kvSize()` exists — LIKELY |
| R3 | `/api/list` deltas (`listDelta.cjs`) | Sole consumer is `GET /api/list`; internal full `kvList` scans (viewer `:11912`, manifest `:12338`, boot reconcile `:6286`, owned-keys `:7078`, publication guards `:6865`) are point-in-time proofs — INTENTIONAL?, but each is O(namespace) |
| R4 | Chat rows without re-materialization (`chatRows.cjs` metadata/raw reads) | `scanAuthoritativeInlayReferences()` decodes every full chat row per reference scan (`:3643`; used by `/api/inlays/references` and delete guards) — LIKELY (bounded scan or reference index); self-contained backup DB spool decodes each chat row (`:7329`) — SPECULATIVE (export semantics) |
| R5 | Manifest parse cache per publication revision (`pluginStorageManifestCache.cjs`) | Owned-keys resolution and backup listing parse manifests uncached (`:7060`, `:7630`) — INTENTIONAL? (point-in-time); viewer parses pinned manifest per request (`:11888`) — INTENTIONAL? |

## 2. Server write path

| # | Primitive | Non-adopters (cost) |
|---|---|---|
| W1 | Admitted-ingress disk spooling | `/api/assets/bulk-write` buffers whole body + base64-decodes every value (`:17005`) — extension candidate (no spool policy exists for the route); non-spool `req.body` fallbacks on `/api/write` (`:16264`) and legacy chat POST (`:18432`) retain payload buffers when spooling is not selected |
| W2 | Worker-thread chunk planning before queue entry | `kvSetFromFile()` without a plan *inside* the mutation queue: snapshot publication (`:1613`), plugin boot reconciliation (`:6194`), streamed plugin batch/single mutations (`:13180`, `:13667`), both transition finalize paths (`:14945`, `:15140`), backup-import rows (`:4480`, `:4571`) — LIKELY; synchronous FastCDC+SHA-256 runs while the queue is held (compounds the W6 hold-duration seeds) |
| W3 | Canonical encoding shared between ETag and persistence | No confirmed non-adopter; open question whether `prepareLiveDatabaseRead()` can double-encode when observing a dirty patch cache (`:2174`) — UNK, needs a runtime trace |
| W4 | Stream-validation of plugin rows | Generic `/api/write` plugin rows validate via `readFile()` of the whole spooled row (`:16017`) — LIKELY (exact pattern the streamed route replaced) |
| W5 | Bounded legacy decompression | Cold-storage import still `gunzipSync` + `JSON.parse` with unbounded expansion (`:4591`, `:5491`) — LIKELY (bounded sibling exists for RisuSave) |

## 3. Client save path

| # | Primitive | Non-adopters (cost) |
|---|---|---|
| C1 | Dirty-revision gated save serialization | No production bypass found in the ordinary save path |
| C2 | Payload codec worker (off-main-thread encode/hash) | Plugin bulk-transition and compatibility-batch encoding/hashing run on the main thread (`pluginStorageTransitionBulk.ts`, `pluginStorageBatch.ts`) — LIKELY; conflict recovery decodes the authoritative DB inline — SPECULATIVE (rare path, but DB-sized main-thread work) |
| C3 | Chat operation-log deltas | Delta applies only when an acknowledged baseline exists **and** the patch is message-only/replay-exact **and** delta bytes are smaller. Empirically (baselines doc): one typed message on a freshly opened large chat transmitted ~882 KB — the common send case appears to take the full-row path. Top Phase 2 verification target |
| C4 | Bounded conflict recovery | No bypass found |

## 4. Plugin storage

| # | Primitive | Non-adopters / gaps (cost) |
|---|---|---|
| P1 | Manifest-revision echo | The legacy full-manifest mutation route returns no echo and forces snapshot invalidation (`server.cjs:13858`; client `pluginSaveStorage.ts:1528`). Users of that route: hashed/non-generation set/remove, owner set/remove/clear, clear/clear-owned, database-bridge writes, boot recovery — each pays a forced full ownership re-read on the next operation — LIKELY (extend echo to the legacy route or migrate callers) |
| P2 | Stamped ownership snapshots | Clear and owner-set read full ownership twice per invocation (`:3418`, `:3790`) — LIKELY; externalized full-record reads re-list both prefixes + read manifest + every row per call (`:1061`, `:1943`) — LIKELY (bulk transport exists); owner-map reads fetch each owner row individually (`:3887`); entry counting forces a full ownership read per call (`:3921`) |
| P3 | Binary/streamed value transport | Ordinary reads (basic `getItem`, bulk snapshots, owner reads, reconciliation, backup/export) bypass the raw-state verified read path and buffer fully (`persistentKv.ts:64`) — SPECULATIVE (protocol extension); V2 plugins use none of the primitives (inline memory only, by design) |
| P4 | Incremental viewer facets | Inline/non-optimized viewer recomputes owner facets + total sizes O(all keys) per page request (`pluginSaveStorage.ts:3614`) — LIKELY; facet staleness (file writes without display size, invalid JSON, prefix deletes) triggers O(all values) backfill per stale request (`server.cjs:11997`) — verify trigger frequency |
| P5 | V3 iframe bridge | One `CALL_ROOT` postMessage round trip per storage method; `updateItem` = two versioned reads + one batch (`apiV3/factory.ts:1997`, `pluginStorageUpdate.ts:157`) — SPECULATIVE (bridge-level batching) |

## 5. Backup / export

| # | Primitive | Non-adopters (cost) |
|---|---|---|
| B1 | Per-version chat frames | Legacy solid-bundle restore gunzips the entire bundle for one entry (`chatBackups.cjs:1577`) — migration-only path, S4 |
| B2 | Pinned out-of-queue snapshot assembly | Adopted by full export, server-file save, automatic snapshots. Partial export is the non-adopter: loads whole `database.bin` (`server.cjs:8981`) and uses object-based `streamRisuSaveToFile` (`:7329`) — LIKELY (full export's source-to-source sibling exists) |
| B3 | Streaming package/dataset interchange | `exportAsDataset` accumulates every row as `Blob[]` (`exportAsDataset.ts:32`) — LIKELY; `processzip` retains full decompressed asset buffers (`processzip.ts:253`); `processZip` fully unzips in memory (used by `stableDiff.ts:362`) — LIKELY |
| B4 | Protected chunk streaming reads | No non-adopter found among current consumers |
| B5 | Object-based `streamRisuSaveToFile` residual callers | Plugin boot cleanup (`:6194`), transition paths (`:14912`, `:15101`), admitted DB writes (`:15852`) — receive already-materialized roots; SPECULATIVE |

## 6. Cross-sweep: client N+1 request patterns

| Site | Old pattern | Existing sibling | Class |
|---|---|---|---|
| `characterPackage.ts` export | One `getInlayMeta(id)` per inlay | `getInlayMetasBatch` | LIKELY |
| `translator.ts` cache search + export | One persistent read per key | generic bulk read (`getItems`) | LIKELY |
| `pluginStorageMeta.ts` owner enumeration | One IDB read per owner row | bulk read | LIKELY |
| `pluginSaveStorage.ts` externalized snapshot | One request per value/meta row | bulk read / batch transport | LIKELY |
| `server.cjs` asset cleanup | `loadStrippedDatabase` full decode per action | revision-bound cache (used by siblings) | LIKELY |
| `inlays.ts` `listInlayAssets` | Sequential per-inlay body fetch | needs fs-inlay bulk endpoint | SPECULATIVE |
| `characterPackage.ts` inlay assets | One fetch per inlay body after batched metadata | needs raw-inlay bulk/streaming endpoint | SPECULATIVE |
| `globalApi.svelte.ts` `readImage`/`loadAsset` | Authoritative single read, resource cache bypassed | `getItemCached()` | SPECULATIVE (cache suitability) |
| `inlays.ts` body reads | Local LRU + authoritative read only | verified resource cache | SPECULATIVE |

## Survey caveats (carried from the dossiers)

- Transition/import/proof paths that re-decode fresh state may be deliberately
  uncached; classify with the charter's INTENTIONAL? test before pricing.
- No same-side duplicate hashing of identical bytes was found; client-hash +
  server-verify pairs are contract, not drift.
- `encodeChatRowPayload()` appears to have no production caller (dead-code check).
- Exact cold-storage export size cannot move to metadata without changing the
  estimator contract.
