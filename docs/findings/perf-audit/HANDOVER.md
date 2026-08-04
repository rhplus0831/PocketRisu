# Remediation handover

For the agent starting remediation of the 2026-08 performance audit. The audit
(phases 0–4) is complete as of 2026-08-04, commit `c2354905` on `serve`; your
job is executing the runway in [07-remediation-runway.md](07-remediation-runway.md).
This file is the entry point — it tells you what to read, the rules that bind
every change, how to verify, and where each track starts. It duplicates
nothing; follow the links.

## Read first, in this order

1. `STRUCTURE.md` (repo root) — architecture, run/verify commands, and the
   **cross-cutting contracts** section; the contracts are inviolable.
2. [00-charter.md](00-charter.md) — the concurrency model and cost rules. The
   one-line version: this is a single-active-writer system, but the server
   process still interleaves a storage FIFO, background schedulers, and worker
   threads (hazard H4), so **every guard you will meet is load-bearing — your
   findings are priced wrong, not wrong to exist. Re-price; never remove.**
3. [04-candidate-findings.md](04-candidate-findings.md) + [06-verification.md](06-verification.md)
   — the findings register (PF-01..PF-37) and which are CONFIRMED vs
   static-only. **Anything not CONFIRMED must be re-verified against current
   code before you implement it** (charter §5 procedure).
4. [07-remediation-runway.md](07-remediation-runway.md) — tracks T1–T8, per-track
   fix directions, design gates, regression proofs, and the work index you
   keep updated.

Supporting: [03-trace-baselines.md](03-trace-baselines.md) (measured numbers and
what they mean), [01-](01-evidence-concurrency.md)/[02-](02-capability-inventory.md)/[05-](05-lens-evidence.md)
(evidence appendices with file:line citations — line hints drift; re-`rg`).

## Binding rules

- **Design gates are real.** Items marked BLOCKED-NEEDS-DESIGN touch
  serialization identity, publication atomicity, commit-outcome protocols, or
  never-replay rules. Write a short design note and check it against the
  STRUCTURE.md contracts before coding. No quick fixes across those lines.
- **The budget ritual.** Every landed fix tightens its ceiling in
  `test/e2e/helpers/budgets.ts` (or flips a `verification.spec.ts` assertion)
  in the same commit. A win that isn't locked in doesn't count.
- **Track status lives in the 07 work index.** Update it as you go, the way
  the MessagePack runway's work index was maintained.
- Project conventions (`CLAUDE.local.md`): conventional commit prefixes; use
  Codex for broad/app-logic work and add the `Codex <noreply@openai.com>`
  co-author trailer when it contributed; `parallel-luna-research` for broad
  read-only exploration; `pnpm` only.

## Verifying your work

```bash
pnpm build                 # REQUIRED before E2E: server serves dist/ and
                           # rejects mutations from mismatched build stamps (426)
pnpm test:e2e              # 14 scenarios incl. budget ceilings + verification specs
pnpm test:server           # server unit suite
pnpm test:compat           # storage/interchange integration (run for storage changes)
POCKETRISU_QUEUE_DIAG=true pnpm test:e2e   # harvests per-label queue wait/hold
                           # histograms into test-results/queue-diag.ndjson
```

Harness facts you'll need (details in `test/e2e/readme.md`):

- Fixture templates cache under `test/e2e/.templates/` — delete the directory
  (or change a spec string in `global-setup.ts`) to force a rebuild.
- Programmatic API calls against an E2E instance must send `x-client-build`
  from `dist/build-stamp.json` (see `test/e2e/helpers/apiClient.ts`).
- The mock model provider uses fixed port 46791; only `provider.spec.ts` and
  `verification.spec.ts` bind it, one worker at a time.
- `verification.spec.ts` assertions encode **current broken behavior** for
  PF-01 (no delta content type, `isStreaming` present in row bytes). When T1
  lands, flip them as described in the spec comments — that flip is the
  regression proof.

## Where to start

Suggested order (rationale in 07): **T3 → T5-contained → T7 quick wins** while
drafting the T1/T2 design notes; then T1 (the big win), T2, T4, T6, remainder.

| Track | Start at | First move |
|---|---|---|
| T3 cached-boot sizing | `server/node/dbCachedRead.cjs`, client `src/ts/storage/nodeStorage.ts` (segmented boot ~`:4412`) | Size/segment-count threshold negotiated at boot; below it, raw read |
| T5 contained | `server.cjs` `/api/db/stats/characters` (~`:19620`), `/modules`, header-less chat-content fallback | Route through `prepareLiveDatabaseRead()` like their siblings. Recovery inspect (PF-14) was reclassified needs-design on re-verification — its raw-byte token binding forbids the cache switch (06 §T5) |
| T7 quick wins | `src/ts/characterPackage.ts:605` (per-inlay meta), `src/ts/translator/translator.ts:618`, `src/ts/globalApi.svelte.ts:218` (`readImage`) | Use the existing batch/cached siblings named in PF-29/30/33 |
| T1 design note | `Chat` type + row encode path (`src/ts/storage/payloadCodec*`, `chatStorage.ts:230` context) | Persisted-row projection stripping runtime fields; hash-domain change ⇒ client/server lockstep behind the build stamp |
| T2 design note | `src/ts/bootstrap.ts:157`, `src/ts/storage/database.svelte.ts:42` | Baseline capture after idempotent normalization, or server-side normalize at import |
| T6 (blocked) | `queueStorageOperation` labels in `server.cjs` | Label the *unlabeled* 65 ms hold first; add contention + production-scale capture before ordering |

## Traps discovered during the audit (do not rediscover them)

1. **First boot after any import/restore uploads a DB-scaled normalization
   patch** (PF-04, one-time). Any boot measurement on a fresh fixture copy
   includes it; the two-cold-boots scenario separates it.
2. **The first cache-enabled boot cannot hit the resource cache** — the
   opt-in popup is answered after that boot's DB read. Steady state begins at
   the third boot. Don't "fix" this as a donation bug; it's ordering.
3. **Response bytes are gzip-dependent** — budgets deliberately assert request
   counts and upload bytes only. Don't add rx budgets without incompressible
   fixtures (`helpers/seedData.ts` bodies are already incompressible).
4. **PF-01's fix changes row bytes** — hash acknowledgements, resource-cache
   seeding, chat-backup pre-images, and delta replay-exactness all key on
   those bytes. That's why it's design-gated; budget for a lockstep deploy.
5. **The send-path double write is timing-dependent** (~445 KB vs ~872 KB per
   exchange). Measure send scenarios several times before drawing conclusions.
6. **Point-in-time reads that bypass caches are sometimes intentional**
   (import proofs, pinned snapshots, mutation-fresh validation). The charter's
   §5 decision procedure tells you which; when in doubt it's INTENTIONAL?
   until proven otherwise.

## State at handover

- Branch `serve`; audit commits `ebc7ec88..c2354905` (6) **unpushed** at the
  time of writing.
- All tracks Open; no remediation has been implemented.
- Known-good: `pnpm test:e2e` 13/13 (14 tests incl. parametrized PF-05),
  `pnpm test:server` 542/542 at `c2354905`.
- Deferred harness work (T8) is listed in `test/e2e/readme.md` — the
  optimized-plugin and backup/import scenarios are prerequisites for T4/T6
  regression proofs, not for design work.
