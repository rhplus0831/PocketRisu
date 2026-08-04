# Performance audit charter — concurrency invariants and cost model

Drafted 2026-08-04 against `7ddb8aca`. Scope seed: `08ce0647..HEAD` (the MessagePack
remediation runway and post-runway debugging fixes); the audit itself is system-wide.
This charter is the adjudication standard for the audit: every finding that claims
"unnecessary defensive work", "redundant revalidation", or "over-serialization" must
classify the mechanism against §4–§5, and every finding must state its cost using §6.

Status: living document during the audit. If evidence contradicts a statement here,
fix the charter first, then re-adjudicate findings that relied on it.

## 1. Why this document exists

PocketRisu is a single-user, self-hosted system with an explicit single-active-writer
protocol, but its ancestry (upstream RisuAI, multi-user-shaped web patterns) and its
own safety work have left defensive mechanisms whose cost is only justified under
concurrency models the design excludes. The audit must separate:

- guards that protect against **real residual hazards** (crash, import overlap,
  in-process interleaving, tab takeover, restart) — these stay, though they may be
  re-priced; and
- guards whose only justification is **sustained independent multi-writer operation**
  — which the writer-lock protocol deliberately makes impossible — and which therefore
  tax every ordinary operation for a scenario that cannot occur.

The dangerous failure mode of this audit is the reverse error: condemning a guard as
"phantom multi-writer tax" when it actually defends against import overlap, crash
recovery, or the server's own background actors. Single-writer does **not** mean
single-threaded: the server process interleaves queued mutations, background
schedulers, and worker threads even when exactly one browser session exists.

## 2. Actor model

Every piece of persistent state can be touched by exactly these actors:

| ID | Actor | Mutation rights |
|---|---|---|
| A1 | Active writer session (one tab in one browser) | All ordinary mutations, via the storage FIFO |
| A2 | Passive sessions (other tabs, other devices) | Reads; fresh *passive compatibility writes* (boot/keepalive) that do not move the lock; writer takeover only when fresh relative to the last accepted write **and** gesture-backed |
| A3 | Server request-time self-mutation | Defensive recovery (`ingestDatabase()` on leaked full rows), lazy metadata repair, boot migrations, epoch rotation |
| A4 | In-process background actors | Snapshot scheduler, WAL/durability checkpoints, asset GC, chat-backup capture/reconciliation, deferred chat-log compaction, model-job recovery/expiry, journal pruning, request-log rotation |
| A5 | Destructive import/restore | Exclusive: owns the import barrier; all other mutation refused with retryable 503 |
| A6 | Crash / power loss | Can interrupt any of the above at any point |
| A7 | Operator filesystem actions | Out of band (hardlink dedup across instances, manual edits); constrains write strategy (never write files in place) but is otherwise out of audit scope |

## 3. Permitted concurrency

What the design **allows** to happen at the same time:

1. **Reads concurrent with the writer.** Any session may read at any time; reads are
   not fenced by writer authority (they are fenced by the import barrier).
2. **Passive writes concurrent with the writer.** Boot/keepalive-shaped writes from
   fresh non-writer sessions are accepted without moving or refreshing the lock.
3. **One mutation at a time server-side.** Ordinary mutations serialize through the
   promise FIFO (`queueStorageMutation()`); "concurrent" client mutations exist only
   as queued neighbors, never as interleaved SQLite writes.
4. **Background actors interleaved at await points.** A4 work runs on the same event
   loop and enters the same FIFO for its mutations; long work (snapshot assembly,
   chunk planning) deliberately runs *outside* the queue against pinned/token-bound
   state and revalidates at publication.
5. **Import excludes everything.** A5 drains the FIFO, holds exclusivity, and later
   mutations are refused rather than queued.

What the design **excludes**:

6. **Sustained independent multi-writer.** Two sessions cannot both hold ordinary
   mutation rights. Displacement is a discrete, observable event (423 → frozen
   recovery UI or reload); a displaced session must never replay dirty state. There
   is no merge protocol, no last-writer-wins window, no OT/CRDT reconciliation — and
   the audit must not price any mechanism as if there were.
7. **Cross-instance shared state.** Multi-instance hosting shares nothing but
   operator-level hardlinked asset files (A7); no live state is co-written.

## 4. Hazard register

Residual hazards that legitimately justify defensive cost. Each guard classification
in the audit must name the hazard(s) it defends against.

| ID | Hazard | Frequency class | Canonical protection |
|---|---|---|---|
| H1 | Server crash / power loss mid-mutation | Rare | SQLite transactions, WAL + `synchronous` policy, import journal, atomic rename+fsync file publication |
| H2 | Browser death / transport loss mid-request (commit outcome unknown) | Rare | Definitive committed / not-committed / unknown outcome envelopes; durable `replacement_operations`; never auto-replay |
| H3 | Destructive import/restore overlapping runtime mutation | Rare, user-initiated | Import barrier + FIFO drain + retryable refusal; epoch rotation |
| H4 | In-process interleaving across await points (queued ops vs background actors vs worker threads) | **Continuous** | FIFO queue; pin-then-revalidate (snapshot token match, chat `row_token` re-bind, file-identity recheck at publication) |
| H5 | Writer displacement (takeover) with stale dirty state on the loser | Rare, discrete | 423 + writer-loss latch; frozen recovery view; no replay |
| H6 | Server restart resetting in-memory lock/session state | Rare | First registration/write wins; recoverable model jobs; boot reconciliation |
| H7 | Browser cache corruption, loss, or staleness (IDB, list cache) | Occasional | Hash verification before use; epoch/staleness fallback to full authoritative reads |
| H8 | Client/server build skew | Rare (deploys) | 426 handshake at admission; clean-page auto-reload |
| H9 | Server self-mutation invalidating client-held state (defensive recovery, migration, snapshot restore, lazy repair) | Rare | ETag/revision change surfaces on next client operation; client rebase path |
| H10 | The client's own dirty/stale baselines (patch base drift, ambiguous prior outcome) | Occasional | Compositional hash check; provisional-ETag rebase; re-read-and-reconcile instead of replay |

Notes:

- H4 is the only *continuous* hazard. Guards against H4 run on hot paths by necessity;
  their audit question is never "should this exist" but "is it priced right"
  (can a cheap revision/token check replace repeated re-derivation?).
- H5/H6/H9/H10 are rare, *detectable* events. Any guard against them that pays a
  per-operation cost proportional to data size in the no-conflict common case is
  mispriced by definition: detection should be O(token compare), with expensive
  reconciliation only after a detected divergence.
- No hazard row says "another writer changed data behind us during normal operation".
  A mechanism that re-reads or re-derives state which only a concurrent independent
  writer could have changed — after the FIFO, barrier, and token checks already ran —
  defends against nothing in this register.

## 5. Guard classification rubric

Classify every defensive mechanism the audit touches:

| Class | Meaning | Audit action |
|---|---|---|
| **LB** | Load-bearing: defends a §4 hazard at a cost proportional to the hazard's frequency (cheap check always; expensive work only on detected divergence) | Keep; document |
| **LB-COND** | Load-bearing but mispriced: the hazard is real, yet the guard pays data-size-proportional cost in the common no-divergence case | Finding: re-price (revision gate, token compare, memoize, move off hot path); never remove the protection itself |
| **PT** | Phantom tax: the only hazard it could defend against is sustained independent multi-writer (§3.6, excluded by design) | Finding: candidate for removal or demotion to a debug assertion |
| **UNK** | Cannot yet name the hazard; the mechanism's provenance or trigger set is unclear | Escalate to a trace task before judging |

Decision procedure for an auditor staring at a guard:

1. What state does it re-check, and **who** (A1–A7) could have changed that state
   between the last verified point and now?
2. If the answer includes A3/A4/A5 interleaving or a crash window → LB or LB-COND;
   the remaining question is pricing (step 3).
3. Is the common-case cost O(1)/O(token) with expensive work only after detected
   divergence? Yes → LB. No → LB-COND with a finding.
4. If the only honest answer to step 1 is "a second independent writer between two
   points that the FIFO/barrier already ordered" → PT.
5. If tempted to delete something that STRUCTURE.md's cross-cutting contracts call
   intentional (stub/placeholder guards, publication atomicity, outcome protocols,
   never-replay rules) → the finding is **blocked-by-invariant, needs-design**, not
   a removal. These contracts protect data, and this audit does not relitigate them.

## 6. Cost model

### Waste taxonomy

Findings name at least one class:

| ID | Waste class | Typical shape |
|---|---|---|
| W1 | Redundant round trips | Client-side per-item loops over a collection API; N+1 reads; work batchable server-side |
| W2 | Redundant bytes | Full payloads where a delta, hash advert + 204, or size-from-metadata answer exists |
| W3 | Redundant materialization | Whole-DB / whole-collection decode, encode, or (de)compression in service of a small operation |
| W4 | Redundant hot-path CPU | Hashing, deep clone, serialization, equality sweeps that a revision/dirty check could skip |
| W5 | Missed or mis-keyed cache | Recompute/refetch of stable data; cache invalidated too broadly or keyed below its stability level |
| W6 | Over-serialization | Long work held inside the FIFO/queue that pin-then-revalidate could move outside |
| W7 | Phantom-writer tax | Any cost whose guard classifies as PT under §5 |

### Severity tiers

Severity = frequency class × scaling variable. Every finding states both.

| Tier | Frequency | Examples |
|---|---|---|
| S1 | Continuous / per-tick (save-loop poll, per-message-token, per-checkpoint) | Costs here dominate everything; even O(n) with small constants is a finding if n is DB-sized |
| S2 | Per user action (send, open chat, save, plugin op) | Findings when cost scales with a collection larger than the action's object |
| S3 | Per boot / per session | Findings when cost scales super-linearly or defeats an existing cache |
| S4 | Background, idle, or rare-path (recovery, import, displacement) | Findings only for egregious scaling or when they steal the FIFO from foreground work |

Scaling variables must be named: DB bytes, character count, chat count, message count
of the active chat, plugin key count, asset/inlay count, snapshot size. "Slow" without
a variable is not a finding.

### Measurement contract

- Every S1/S2 finding should carry either a measured trace (Playwright scenario with
  request/byte counts, or `TRACE_REQUEST_FOR_DEBUG` capture) or an explicit static
  cost derivation with its scaling variable. S3/S4 findings may be static-only.
- The Playwright harness scenarios (Phase 1) define the budget baselines; post-remediation
  budgets become regression assertions. A finding that cannot state "what number goes
  down" is a refactor proposal, not a performance finding.

## 7. Non-goals

- **Data-loss correctness.** Audited in the v1–v3 rounds (now archived under `.archived-docs/findings/`,
  `AUDIT-INDEX.md`). This audit may *reference* those invariants but does not re-open
  them. A perf fix that would weaken one is blocked-by-invariant, needs-design.
- **Memory ceilings and payload-sized buffering.** Completed by the MessagePack
  remediation runway (`.archived-docs/performance/`). Only regressions or missed
  adopters of its primitives are in scope (the Phase 1 capability inventory).
- **Upstream interchange fidelity.** Deliberate compatibility contracts (RisuAI
  quirks, lossy upstream exports) are format law, not waste.
- **The Hono scaffold** and `util/` legacy tree.

## 8. Baseline classification of major mechanisms

Sources: structure docs at `95c2ea30` plus four independent code-evidence dossiers
(writer lock, server guards, client defenses, background actors), spot-verified by
hand. Full citations live in [01-evidence-concurrency.md](01-evidence-concurrency.md).
The Phase 2 lens re-verifies anything it relies on.

**Headline result: no mechanism surveyed classifies as PT at the architectural
level.** Every principal guard names a real hazard from §4. Two consequences:

1. The writer lock itself is not a tax — it is the O(1) boundary that *makes*
   sustained multi-writer impossible (its own header states the data model would
   silently clobber under concurrent writers, `server/node/session-lock.cjs:3-11`).
   PT findings are defined *relative to* this boundary: work that would only matter
   if the boundary did not exist.
2. The audit's concurrency lens is therefore a **pricing and hold-duration lens**,
   not a removal lens. Expected finding shapes are LB-COND (data-size-proportional
   cost in the no-divergence case) and W6 (long work inside the mutation FIFO that
   the pin-then-revalidate pattern could move outside). Per-callsite PT remains
   possible — §8 clears the architecture, not every call site.

Baseline classifications (details and citations in the evidence file):

| Mechanism group | Class | Hazards | Note |
|---|---|---|---|
| Storage FIFO; barrier-inside-queue; import barrier + retryable refusal | LB | H3, H4 | The core serialization boundary |
| Writer lock, gesture takeover, 423 latch, foreground `peek` (5 s throttle) | LB | §3.6 boundary; H5 | O(1); the only mechanisms whose sole subject is another session, priced correctly |
| Build-stamp admission (426) | LB | H8 | O(1) |
| SQLite transactions; WAL/synchronous policy; checkpoint busy-retry | LB | H1, H4 | |
| ETag CAS; patch base-hash check; delta base-hash/log-chain validation | LB | H9, H10, H5 | O(token) detection, expensive work only on divergence |
| Revision triggers + revision-bound decoded cache; verified-read memos | LB | H4, H9 | The pricing exemplar other guards should match |
| Post-queue revalidation (cache identity, plugin generation/manifest, prior DB state) | LB | H4 | Justified by await-point interleaving, not phantom writers |
| Snapshot pin + token match-then-publish, assembly outside the queue | LB | H4 | The hold-duration exemplar |
| Chat `row_token` bind/retry; token-conditional metadata repair | LB | H4, H3 | |
| Pre-image capture before overwrite/delete | LB | H1, H2 | Hold duration is a Phase 2 seed |
| Client conflict recovery (patch rebase, ETag fallback, delta full-row fallback, boot-cache fallbacks, 204 re-hash, outcome protocol) | LB | H2, H7, H9, H10 | Zero-cost when no divergence; fallback costs fire on detection only |
| Stub/placeholder hydration guards; never-replay rules; publication atomicity | Out of scope | — | Data contracts per §5.5 and §7 |

Phase 2 starts from the seed list at the end of the evidence file (asset-GC and
chat-backup FIFO holds, per-`keys()` round trip, out-of-queue deletion-journal
cleanup, in-hold encode/materialize sites).
