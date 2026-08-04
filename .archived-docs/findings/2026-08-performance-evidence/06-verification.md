# Phase 3 verification verdicts

Recorded 2026-08-04 against `843b3d24`. Method: request-content capture via
`test/e2e/scenarios/verification.spec.ts` (permanent — its assertions flip into
regression proofs after remediation) plus targeted code reads. Verdicts amend
the register in [04-candidate-findings.md](04-candidate-findings.md).

## PF-01 — chat deltas never engage: **CONFIRMED** (runtime + static)

- Runtime: the chat-row POST after a real streamed generation is
  `application/octet-stream`, 426,518 B, and its MessagePack body contains the
  `isStreaming` key. No `chat-delta` content type appeared in any capture.
- Static chain: send sets `chat.isStreaming = true`
  (`src/ts/process/index.svelte.ts:1549`) and clears it at completion
  (`:1684`); `activeStreamingDisplayOptimizationMode` toggles alongside. The
  fields persist into row bytes — hydration explicitly normalizes them
  *because* "the server copy can carry isStreaming=true forever"
  (`src/ts/storage/chatStorage.ts:230-234`).
- Mechanism: every save around a generation differs from its acknowledged base
  by at least one non-message field — checkpoint save (true vs false/absent),
  final save (false vs the checkpoint's true), and even the first save after
  hydration (key added where the server row lacked it). `prepareChatDeltaPatch()`
  rejects all of them; every save takes the full-row path.
- Fix shape: a persisted-row projection that strips runtime-only fields (the
  stub projection precedent exists), or delta-protocol tolerance for a
  declared runtime-field set. Serialization contract change →
  BLOCKED-NEEDS-DESIGN, Phase 4 design item. The PF-01 spec assertions flip
  when fixed.

## PF-02 — two full-row writes per exchange: **CONFIRMED**

Checkpoint-then-final save mechanics (`chatPersistStage.ts:260-297`,
`globalApi.svelte.ts:600-609`) produce the measured 872 KB double-write when
generation outlasts the first save; both writes are full rows because of
PF-01. Fixing PF-01 collapses the cost (two ~1 KB deltas); write-count
coalescing is a separate, durability-sensitive question.

## PF-03 — first-run initialization churn: **CONFIRMED, reattributed 2026-08-04**

Fresh empty instance: 7× `/api/patch` totaling 204,932 B, 7× `/api/read`,
6× `/api/logs` before any user action. Successive startup phases each run
their own save/re-read cycle. (An imported instance shows a single
consolidated patch instead — see PF-04 — so the 7-cycle shape is specific to
first-run defaults construction.)

**Reattribution (see 09 §3-A for the full measurement):** the
"successive startup phases" explanation above is **wrong**. Instrumented
runs show ONE valid 296-op startup defaults proposal stuck in a
non-converging `409 DATABASE_PATCH_CONFLICT` loop: the patcher baseline
implicitly gains `characters: []` (`risuSave.ts:1322-1328`) while
create-if-absent persisted literal `{}`, the hashes can never match, and
the identical 28,417 B patch replays every ~640 ms — an 8-second probe
reached 16 conflicts and was still looping. "7 cycles" was the capture
cutoff (current runs measure 6–7). The reads are conflict-recovery
`readDatabaseCandidate()` calls; the logs are the batched conflict
warnings (N patches / N reads / N−1 logs). Severity is therefore
**higher than priced**: the storm is not a one-time boot cost — it
continues while a fresh instance sits idle, until some later full write
converges the baselines. Fix direction: align fresh creation with the
patch baseline (normalized fresh-database publication at the create
boundary), not save consolidation — no independent producers exist to
consolidate.

## PF-04 — post-import normalization patch: **CONFIRMED + decomposed**

One-time (first boot 31.7 KB / second boot 0 on medium; 292,736 B on xl).
Decomposition on xl: 3,870 ops, of which **3,600 target `/characters` — 12
default-fill ops × 300 characters**; only ~4 root-key ops. No whole-array
replacement occurs (IDs are stable). Fix shape: fill per-character defaults at
decode time without marking branches dirty, or normalize once server-side at
import. Baseline-capture semantics → BLOCKED-NEEDS-DESIGN.

## PF-05 — segmented cached boot: **CONFIRMED, reframed by measurement**

Steady-state (third boot onward, full hits), `/api/db/read-cached` request +
response vs the raw read:

| Fixture | Raw read rx | Cached steady state (tx + rx) | Verdict |
|---|---|---|---|
| medium (~10 characters) | 846 B | 1,699 + 1,259 ≈ 2,958 B | Cache costs ~3.5× raw |
| xxl-desc (1.2 MB stubs) | 915,884 B | 21,129 + 10,920 ≈ 32,049 B | Cache saves 96.5% |

Two amendments to the original A2 story:

1. **The first cache-enabled boot cannot hit and pays the pricier envelope**
   (923,620 B vs 915,884 raw on xxl): the enable decision comes from the
   first-boot popup *after* that boot's database read, so the first
   cache-path read starts with an empty inventory (`tx = 898 B` signature).
   A 20 s post-boot wait does not change it — this is ordering, not slow
   donation; donation itself completes within ~4 s and the next boot hits
   fully. The original A2 measurement compared exactly this first-miss boot
   against a cold boot, overstating the steady-state penalty.
2. **The steady-state penalty is real but small-DB-only.** The fixed costs
   (≈67 B per advertised hash, ≈72 B per hit envelope, per-array-member
   segmentation) dominate below roughly the tens-of-kilobytes range and are
   irrelevant at megabyte scale. Fix shape: a size-aware bypass (serve raw
   below a threshold) and/or coarser segments for small groups; fallback and
   hash verification must remain intact.
3. **(2026-08-04, T3 landing.)** The medium raw reference above (846 B) was
   captured on a fresh fixture's first boot — before the one-time PF-04
   normalization patch grew the row (trap 1 of the handover). The same
   database's steady-state raw read is ≈6.7 KB rx (7,390 B tx+rx), so at
   medium scale the segmented path was already byte-cheaper at steady state
   and the "~3.5× raw" verdict does not hold there. The small-DB byte penalty
   is confined to genuinely tiny databases; the medium-scale motivation for
   the T3 bypass (raw boot below a 128 KiB row-length hint from
   `/api/session`) is eliminating the pre-network IndexedDB SHA-256
   verification and inventory upload, not wire bytes. A later fix made that
   hint chunk-aware after finding that chunked rows advertised the 13-byte
   storage marker instead of the logical database length.

## Spot verifications (one representative per group)

- **PF-13** stats routes decode the full DB per request: **CONFIRMED**
  (`kvGet(DB_BLOB_KEY)` + `decodeAuthoritativeDatabase` in
  `/api/db/stats/characters`).
- **PF-29** per-inlay metadata reads next to the batched sibling: **CONFIRMED**
  (`Promise.all(ids.map(id => getInlayMeta(id)))` beside
  `getInlayInfosBatch(ids)`, `characterPackage.ts:605-617`; concurrent, but
  still N requests).
- **PF-33** `readImage` bypasses the verified cache: **CONFIRMED**
  (plain `forageStorage.getItem`, `globalApi.svelte.ts:218-220`).
- **PF-06** legacy plugin route returns no manifest echo: **CONFIRMED by dual
  independent citation** plus client-side corroboration (the helper
  invalidates ownership before dispatch specifically because no echo exists,
  `pluginSaveStorage.ts:1562-1578`). Exact response-shape line to be pinned
  when the fix lands.
- **PF-28** (`kvCleanupOldDeletions` outside the FIFO): affirmatively cleared
  in Phase 2; unchanged.

## T5-contained re-verification (2026-08-04, pre-implementation per charter §5)

- **PF-13**: re-CONFIRMED against current code. Both `/api/db/stats/characters`
  and `/api/db/stats/modules` `kvGet` + `decodeAuthoritativeDatabase` per
  request with no queue wrapper and no flush. Stripped-form deltas checked:
  neither route reads the fields normalization removes, and `stats/characters`
  already discards `chats` before sizing.
- **PF-14**: **reclassified BLOCKED-NEEDS-DESIGN — the prescribed contained
  fix is refuted.** `inspectOptimizedPluginStorageRecoveryManagement()` binds
  its action token to `sha256Hex(rawDatabase)` (the verbatim row bytes) and
  builds inline recovery candidates from `liveDb.pluginCustomStorage` /
  `pluginStorageMeta` — fields `prepareLiveDatabaseRead()`'s stripped form
  empties. The full decode is load-bearing for the recovery token protocol
  (charter §5 step 5). The route already runs behind
  `queueStorageReadAfterImports` + explicit flush and is cold operator
  tooling; any re-pricing needs a design note covering token identity, not a
  cache switch.
- **PF-15**: CONFIRMED, edge-only. All current clients send `x-chat-id`; the
  header-less fallback prefers the dirty revision cache (`allowDirty: true`)
  and pays a one-off `loadStrippedDatabase` full decode only on a cold cache.
  Fix must keep the dirty-cache preference and the untouched hot path.
- **PF-16**: CONFIRMED with a premise correction: the "verified logical-size
  metadata" (`chunkStore` `logical_size`, `chatRows` `content_size`) measures
  STORED (gzipped) bytes, not the re-stringified JSON the backup emits —
  substituting it would systematically underestimate and could suppress the
  boot low-space warning. Fix shape is memoization of the per-row output size
  keyed by a cheap change signal, preserving current output semantics.

## T7 quick-win re-verification (2026-08-04, pre-implementation per charter §5)

- **PF-29**: re-CONFIRMED. The export's per-inlay `getInlayMeta` loop sits
  beside `getInlayInfosBatch`; the exact metadata sibling is
  `getInlayMetasBatch` (`inlayMeta.ts`), which returns precisely the four
  fields the export consumes with matching missing-row semantics. The two
  single-id `getInlayMeta` uses in `inlays.ts` are read-modify-write and stay.
- **PF-30**: CONFIRMED, reframed cold-path. The per-key loops serve only the
  V3 plugin `searchTranslationCache` API and the user-triggered settings
  export — not per-message translation, which does a single exact lookup.
  Key count is unbounded (one row per persisted LLM translation), so the
  N+1 is still worth fixing. The bulk sibling is the generic
  `getItems` → `POST /api/assets/bulk-read` path, which reads arbitrary KV
  keys server-side; the fix is a persistent-KV bulk JSON helper on top of it.
- **PF-31**: **refuted as priced — no production caller.**
  `listInlayAssets()` is invoked only by its own unit tests; the settings
  gallery, Playground explorer, and parser all use the lightweight
  `listInlayExplorerItems()` (info/meta sidecars, bodies on demand), and
  package export reads bodies per-id separately. There is also no bulk
  inlay-body route to batch onto. No code change; the function is a
  dead-code-removal candidate, tracked outside the runway.
- **PF-33**: re-CONFIRMED. `readImage`/`loadAsset` use plain
  `forageStorage.getItem`; `AutoStorage.getItemCached` →
  `getItemCachedAuthoritative` already exists with cache-off fallback, and
  its 204 protocol validates the server-confirmed hash against the local
  manifest before serving cached bytes, so the switch is safe even for
  non-hash-named keys. Normal assets are content-hash-named by `saveAsset`.
  On Node, avatar/background renders use `getFileSrc` direct URLs and never
  hit `readImage`; the winners are export, multimodal prompt assembly,
  plugin, and TTS reads.

## Still open

- PF-21–PF-27 hold-shape verification needs server-side queue-wait timing
  instrumentation (asymptotic evidence only so far). Recommended: a gated
  histogram around `queueStorageOperation()`, evaluated under the E2E
  scenarios, before the remediation runway orders the W6 items.
- Remaining unverified register entries carry Phase 2 static evidence only;
  verify each before implementation, per the charter.
