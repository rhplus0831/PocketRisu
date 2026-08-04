# Remediation runway

Opened 2026-08-04 against `12e90fa9`. Orders the verified findings of
[04-candidate-findings.md](04-candidate-findings.md) /
[06-verification.md](06-verification.md) into executable tracks, following the
MessagePack-runway model: each track lists its findings, fix direction, design
gates, and the regression proof that locks the win in. The work index at the
bottom is the living status table.

Rules of engagement (from the [charter](00-charter.md)):

1. Registry entries not yet marked CONFIRMED are verified before
   implementation (charter §5 procedure); Phase 3 verdicts stand for the rest.
2. BLOCKED-NEEDS-DESIGN items start with a short design note reviewed against
   the cross-cutting contracts in STRUCTURE.md; no quick fixes across
   serialization, publication-atomicity, outcome, or never-replay boundaries.
3. Every landed fix tightens its budget ceiling in
   `test/e2e/helpers/budgets.ts` (or flips a verification assertion) in the
   same change, so the win cannot silently regress.

## T1 — Chat save-path deltas engage on real sends (PF-01, PF-02)

**Impact: the largest single win** — ~430–870 KB uploaded per chat exchange
becomes a few KB. **Design-gated** (serialization identity).

1. Design note: a persisted-row projection that excludes runtime-only fields
   (`isStreaming`, `activeStreamingDisplayOptimizationMode`; audit the `Chat`
   type for any other runtime-only members) — mirroring the existing stub
   projection precedent — versus a delta-protocol allowance for a declared
   runtime-field set. The projection changes row bytes, hence hash-ack
   domains, resource-cache seeding, and backup byte-exactness: client/server
   must move in lockstep behind the build-stamp handshake.
2. Implement; then decide whether checkpoint/final write coalescing (PF-02) is
   still worth pursuing once both writes are cheap deltas.
3. Regression flip: `verification.spec.ts` PF-01 assertions invert
   (post-generation saves must use `chat-delta`); `send-and-save` /
   `send-generate-save` budgets drop from 1.1 MB to ≤ 64 KB.

## T2 — Boot normalization stops uploading the database (PF-03, PF-04)

Per-character defaults fill (12 ops × every character) becomes either
decode-time fill that does not mark branches dirty, or one server-side
normalization at import/first-run. First-run's seven patch/read cycles
consolidate to one. **Design-gated** (baseline-capture semantics; the
authoritative baseline must be established *after* idempotent normalization).
Regression: the two-cold-boots invariant already pins one-time behavior;
after the fix, `first-run-boot` budget drops to ≤ 15 requests / ≤ 32 KB and
`xl-cold-boot` to ≤ 64 KB.

## T3 — Size-aware cached boot (PF-05)

Smallest design surface of the top findings: the server knows the stubs-DB
size and segment count; below a threshold the client takes the raw read
(cache stays authoritative-fallback-correct by construction). Optionally
coarsen segmentation for small groups and make IDB verification budget-aware
(verify only what will be advertised). The first-enabled-boot full-miss cost
is inherent to popup ordering — document it; a "prefetch after enabling"
follow-up is optional polish. Regression: PF-05 steady-state invariants
already assert both ends; add a small-DB assertion that the cached path is
chosen only above the threshold once implemented.

## T4 — Plugin-storage protocol adoption (PF-06..PF-12)

Ordered inside the track:

1. PF-09 manifest-cache revision split (server-contained; stops ordinary DB
   writes evicting a valid parsed manifest).
2. PF-12 stream-validation for generic `/api/write` plugin rows (contained;
   the streamed sibling's exact pattern).
3. PF-07 duplicate ownership reads (pass the freshness-stamped snapshot into
   the mutation helper).
4. PF-08 enumeration-invalidation narrowing (retain on exact echo/restamp;
   conservative on ambiguity).
5. PF-06 manifest echo for the legacy route **or** caller migration to the
   revision-bound protocol — design-gated (outcome protocol).
6. PF-10 generation-pinned batch reads for snapshot/owner/boot paths —
   design-gated (publication pinning).
7. PF-11 plugin encode/hash on the codec worker.

Regression: a plugin-storage E2E scenario (harness follow-up below) with
request-count budgets per operation family.

## T5 — Request paths stop materializing the world (PF-13..PF-20)

Contained first: PF-13 stats routes, PF-14 recovery inspect, PF-15 header-less
chat lookup → the revision-bound decoded cache their siblings already use;
PF-16 cold-storage stats → verified logical-size metadata. Design-gated
follow-ons: PF-17 inlay reference index (must preserve the conservative
staged-row/cold-storage guarantees), PF-18 partial-export streaming (reuse the
full-export source-to-source path), PF-19 bounded cold-storage decompression,
PF-20 viewer snapshot-revision fast path. Regression: response-time/count
checks are weak here; instead add server-side unit assertions that the cache
path is taken (decode-counter probes under `NODE_ENV=test`).

## T6 — FIFO hold re-pricing (PF-21..PF-27) — measure first

The `POCKETRISU_QUEUE_DIAG` wait/hold instrumentation landed with this phase
(gated; per-label count/max/p50/p95 via `GET /api/debug/queue-diag`; the E2E
harness harvests it into `test-results/queue-diag.ndjson` when the env is set).

First capture (2026-08-04, full E2E suite — small fixtures, so magnitudes are
floors, shapes are the signal):

| Label | count | hold max (ms) |
|---|---|---|
| unlabeled | 67 | 65.1 |
| chat-backup-reconcile | 14 | 36.0 |
| asset-gc | 2 | 13.0 |
| chat-preimage+write | 5 | 9.9 |
| snapshot-publish | 8 | 7.6 |
| patch-persist | 7 | 4.3 |
| snapshot-capture | 9 | 2.8 |

Consequences: (1) the largest observed hold is an **unlabeled** operation —
label the remaining call sites before ordering; (2) reconciliation and
asset GC lead the labeled set even on near-empty instances (asset GC's 13 ms
is its pure DB-decode floor), consistent with the static ranking; (3) waits
are ~0 in sequential scenarios — a contention scenario (mutations racing a
background sweep) and a production-scale fixture run are required before the
final ordering. Then proceed: PF-25 compaction (token-conditional publish
exists) → PF-24 patch-persist encode-outside → PF-22 pre-image pin-outside →
PF-27 chunk-plan adoption per site → PF-23 reconciliation mutex → PF-21
asset-GC (blocked on a composite reference token) → PF-26 plugin decode
in-queue. Every fix preserves the named hazard protection (pin outside,
revalidate tokens at publish, fail closed).

## T7 — Client N+1 and missed caches (PF-29..PF-36)

Quick wins, largely un-gated: PF-29 batched inlay metadata (sibling exists),
PF-30 translator bulk reads, PF-31 bulk inlay listing, PF-33 `readImage`/
`loadAsset` through `getItemCached()`. Design-gated: PF-34 inlay-body cache
keying (sidecar consistency), PF-35 list-freshness watermark (must cover
KV+assets+inlays atomically), PF-32 owner-page reads, PF-36 streaming export
sinks. Regression: budgets on the affected scenarios once each path has one.

## T8 — Harness follow-ups (supporting)

Optimized-plugin-storage scenario (fixture V3 plugin + UI transition),
UI backup/export + import scenarios, long-generation checkpoint scenario,
and a bulk-import scenario for T6 measurement. These are prerequisites for
T4/T6 regression proofs, not for their design work.

## Work index

| Track | Findings | Status | Gate |
|---|---|---|---|
| T1 chat deltas | PF-01, PF-02 | Open | Design note (serialization identity, lockstep deploy) |
| T2 boot normalization | PF-03, PF-04 | Open | Design note (baseline capture) |
| T3 size-aware cached boot | PF-05 | Open | None (threshold + negotiation) |
| T4 plugin protocol | PF-06..12 | Open | Items 5–6 design-gated |
| T5 materialization | PF-13..20 | Open | Items PF-17..20 design-gated |
| T6 FIFO holds | PF-21..27 | Open (blocked: measurement) | `POCKETRISU_QUEUE_DIAG` data |
| T7 client N+1/caches | PF-29..36 | Open | PF-34/35/32/36 design-gated |
| T8 harness follow-ups | — | Open | None |

Suggested execution order: T3 → T5-contained → T7-quick-wins (small, un-gated,
build confidence in the budget ritual) in parallel with the T1 and T2 design
notes; then T1 (the big win), T2, T4, T6 post-measurement, remainder.
