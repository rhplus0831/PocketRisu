# Remediation handover

For the agent continuing remediation of the 2026-08 performance audit.
Rewritten 2026-08-04 at `cbd13754`: the audit (phases 0–4) is complete, and
the first remediation wave has landed and been pushed through `208fc56a`.
Your job is the remainder of the runway in
[07-remediation-runway.md](07-remediation-runway.md) — the work index there
is the live status table. This file tells you what to read, what already
landed, the rules, and where each remaining item starts. It duplicates
nothing; follow the links.

## Read first, in this order

1. `STRUCTURE.md` (repo root) — architecture, run/verify commands, and the
   **cross-cutting contracts**; the contracts are inviolable.
2. [00-charter.md](00-charter.md) — concurrency model, cost rules, and the
   §5 guard rubric. One line: every guard you meet is load-bearing — re-price,
   never remove. Re-verify anything not CONFIRMED before implementing.
3. [04-candidate-findings.md](04-candidate-findings.md) +
   [06-verification.md](06-verification.md) — the findings register and
   verdicts. 06 now also carries the T5-contained and T7 pre-implementation
   re-verifications and the **PF-03 reattribution** (see traps below).
4. [07-remediation-runway.md](07-remediation-runway.md) — tracks, fix
   directions, gates, and the work index you keep updated.
5. The design notes — both survived adversarial review and contain binding
   invariants their implementations (and future changes) must preserve:
   - [08-t1-chat-row-projection-design.md](08-t1-chat-row-projection-design.md)
     (T1; §3 invariant: project only the current wire-bound row, never
     acknowledged bases)
   - [09-t2-boot-normalization-design.md](09-t2-boot-normalization-design.md)
     (T2; §2.2 ingest ID-ordering invariant; §3-A is the measured PF-03
     attribution and the spec for its fix)

Supporting: [03-trace-baselines.md](03-trace-baselines.md) (pre-remediation
numbers), [01](01-evidence-concurrency.md)/[02](02-capability-inventory.md)/
[05](05-lens-evidence.md) (evidence appendices; line hints drift — re-`rg`).

## What has landed (pushed through `208fc56a`)

| Commit | What | Key regression lock |
|---|---|---|
| `8b17bb4d` | T3: size-aware cached-boot bypass (≤128 KiB raw hint via `/api/session`) | PF-05 spec asserts route choice both ways |
| `90f903e7` | T5-contained: stats routes + chat-content fallback through `prepareLiveDatabaseRead()`; cold-storage stats memo (`coldstorage/` `updated_at` now monotonic) | `NODE_ENV=test` cache-hit / recompute-counter assertions |
| `053944f3` | T7 quick wins: `getInlayMetasBatch` in export, `readPersistentJsonBulk`, `readImage`/`loadAsset` → `getItemCached` | unit call-count assertions |
| `c158794d` | T1 design note (08) | — |
| `16236817` | T1 Phase 1: runtime-field projection; **sends are now sub-KB deltas** | PF-01 spec flipped: post-warm-up saves must be `chat-delta`, no `isStreaming`, ≤64 KB/post |
| `e1d6fbbd` | T2 design note (09) | — |
| `208fc56a` | T2 PF-04: shared defaults contract + ingest normalization + marker migration; **xl import patch 292 KB → 26 KB** | xl decomposition ceiling 320 ops / 32 KB; `xl-cold-boot` 64 KB |
| `cbd13754` | PF-03 attribution (docs; unpushed at rewrite time) | — |

Reclassifications the register now records: **PF-14** BLOCKED-NEEDS-DESIGN
(recovery-inspect decode is load-bearing for its token protocol — the fix
this file originally prescribed was wrong), **PF-31** refuted (no production
caller), **PF-05 medium verdict** amended (the audit's raw reference was
pre-normalization), **PF-03** reattributed (see below).

## Binding rules (unchanged)

- Design gates are real; BLOCKED-NEEDS-DESIGN items get a design note checked
  against the STRUCTURE.md contracts, then an adversarial review round —
  both T1 and T2 notes were materially corrected by review; budget for it.
- The budget ritual: every landed fix tightens its ceiling in
  `test/e2e/helpers/budgets.ts` or flips/tightens a `verification.spec.ts`
  assertion in the same commit.
- Track status lives in the 07 work index; update as you go.
- Project conventions (`CLAUDE.local.md`): conventional commit prefixes;
  Codex for broad/app-logic work with the `Codex <noreply@openai.com>`
  co-author trailer; `parallel-luna-research` for broad read-only
  exploration; `pnpm` only.

## Verifying your work

```bash
pnpm build                 # REQUIRED before E2E (426 on stamp mismatch)
pnpm test                  # client (~2,137) + server (547) suites
pnpm test:e2e              # 14/14; specs now encode FIXED behavior — never
                           # loosen a flipped assertion to make a change pass
pnpm test:compat           # storage/interchange; run for storage changes
POCKETRISU_QUEUE_DIAG=true pnpm test:e2e   # queue wait/hold histograms →
                           # test-results/queue-diag.ndjson
```

Harness facts (details in `test/e2e/readme.md`):

- Fixture templates cache under `test/e2e/.templates/` — **delete the
  directory whenever a change affects imported state** (server ingest,
  seed shape); stale templates silently mask ingest changes.
- `test:compat` full runs currently flake under memory pressure
  (`full-export-import-race` RSS caps, occasional `EADDRINUSE`,
  `admitted-write-spool` timeout). Known issue, fix deferred by the owner:
  if those are the only failures, rerun the files in isolation and report.
- Programmatic API calls need `x-client-build` from `dist/build-stamp.json`.
- The mock model provider uses fixed port 46791 (provider + verification
  specs only, one worker at a time).

## Where to start: the remaining work

| Item | Status / gate | Start at |
|---|---|---|
| **PF-03 fix** (recommended next — also fixes a live idle-traffic bug) | Implementable; spec is 09 §3-A | Fresh creation publishes the normalized first-run graph atomically at the create boundary (shared fresh-database factory; browser-specific language/theme inputs explicitly represented). Touch points: client `bootstrap.ts` create-if-absent call (~`:164`), server `/api/db/create-if-absent` (`server.cjs` ~`:11140`), `RisuSavePatcher.initializeBaseline()` implicit `characters: []` (`risuSave.ts` ~`:1322`). Server-constructed graph projects 14 req / ~8.3 KB (meets both targets); a client-seeded body must be re-measured before claiming ≤32 KB. Regression: `first-run-boot` budget drops from 45 / 320 KB, plus a **no-409-on-first-run assertion** |
| **T6 FIFO re-pricing** | Blocked on measurement | Label the *unlabeled* 65 ms hold in `queueStorageOperation` call sites first; then a contention scenario + production-scale fixture capture; ordering in 07 §T6 |
| **T4 plugin protocol** | Ordered list in 07 §T4 | PF-09 manifest-cache revision split (server-contained) → PF-12 → PF-07 → PF-08; PF-06/PF-10 design-gated; PF-11 last. Regression needs the T8 plugin scenario |
| **T5 remainder** | PF-17..20 design-gated; PF-14 needs its own design note | 07 §T5; PF-14's note must handle the raw-byte token binding (06 §T5 re-verification explains why the cache switch is forbidden) |
| **T8 harness** | Prerequisite for T4/T6 proofs + new items | `test/e2e/readme.md` list, plus from this wave: the PF-03 test-only trace hook + first-run quiet-period assertion (09 §3-A proposal), and a durable-churn fixture (scriptstate/HypaV3) for T1 Phase 2 |
| **T1 Phase 2 + PF-02** | Deferred pending measurement | 08 §6/§7; needs the durable-churn fixture to justify; PF-02 only if post-Phase-1 measurement still shows waste |

## Traps (updated — do not rediscover)

1. **Fresh instances are in a 409 patch storm until the PF-03 fix lands**
   (09 §3-A): one 296-op / 28.4 KB proposal replays every ~640 ms
   indefinitely — `{}` vs the patcher's implicit `{characters: []}` can
   never hash-match. Any measurement on an empty instance includes this
   storm; the audit's "7 cycles" was just the capture window. Do not
   interpret fresh-instance patch counts as producers.
2. **The 08 §3 invariant is how T1 corrupts data if violated**: projection
   applies only to the current wire-bound row; a projected acknowledged
   base paired with an old-bytes hash makes the server accept a delta it
   later fails to materialize (`CHAT_DELTA_LOG_CORRUPT`). Unit + compat
   tests enforce it; keep them.
3. **The 09 §2.2 invariant is how T2 loses data if violated**: no chat row
   before its character's `chaId` exists. Assignment points are named in
   the note; the `chats/undefined/*` write-then-sweep loss is what a naive
   refactor reintroduces. The missing-`chaId` compat fixture enforces it.
4. **First cache-enabled boot cannot hit the resource cache** (popup answers
   after that boot's read). Steady state begins at the third boot. Ordering,
   not a donation bug.
5. **Response bytes are gzip-dependent** — budgets assert request counts and
   upload bytes only. The PF-05 medium "3.5× penalty" verdict was an artifact
   of a pre-normalization raw reference; per-post spec assertions, not rx
   budgets, are the byte locks.
6. **The send budgets (960 KB / 500 KB) deliberately include a legitimate
   one-time full-row save** (chatId backfill on imported fixtures). The
   steady-state protection is the per-post ≤64 KB delta assertion in the
   PF-01 spec. Don't "fix" the budgets downward without restructuring the
   scenario's warm-up.
7. **Point-in-time reads that bypass caches are sometimes intentional** —
   PF-14 is the canonical example now (token binds sha256 of raw bytes).
   Charter §5 step 5; when in doubt it's INTENTIONAL until proven otherwise.
8. **Cold-storage rows now rely on monotonic `updated_at`** (T5 PF-16 memo):
   same-millisecond rewrites get +1 ms and the deletion journal is
   consulted. Namespace-scoped to `coldstorage/`; don't generalize it, and
   don't bypass `kvMutationUpdatedAt` when adding cold-row writers.
9. **Adversarial review earns its cost** — every design note this wave was
   materially corrected by refutation (T1 once, T2 twice). Run one before
   implementing any gated item.

## State at rewrite

- Branch `serve` pushed through `208fc56a`; `cbd13754` (PF-03 attribution
  docs) plus this rewrite are the only unpushed work at the time of writing.
- Known-good: `pnpm test` client 2,137 + server 547, `pnpm test:e2e` 14/14,
  `pnpm check` clean at `cbd13754`.
- Wins locked so far: sends ~870 KB → sub-KB deltas; xl import boot patch
  292 KB → 26 KB; small-DB boots skip IDB verification; stats/chat-content/
  cold-storage request paths stopped re-decoding the world; client N+1s
  batched and asset reads cache-routed.
