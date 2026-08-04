# Delta audit — missed-performance review

Built 2026-08-04/05 at `9b589e0e`. Question 2 of the audit charter: were
meaningful performance improvements missed in `fa4414e7..HEAD`?

## Verdict

No unknown-and-missed optimization of the storage/persistence paths was
found: the 2026-08 performance audit (system-wide at `7ddb8aca`, formal
concurrency charter, traced baselines) plus the MessagePack runway already
identified and either landed or catalogued the meaningful wins. The honest
gap is *measurement coverage*, not analysis: several plausibly-hot
subsystems were never traced, so "no known finding" there is absence of
evidence.

## What is already catalogued (do not re-derive)

Open backlog per `perf-audit/07-remediation-runway.md` + `HANDOVER.md`:
PF-03 first-run 409-storm fix (also a live idle-traffic bug), T4 plugin
protocol (PF-09→12, PF-06/07/08/10/11), T5 remainder (PF-14 needs design,
PF-17..20 design-gated), T6 FIFO re-pricing (blocked on measurement), T8
harness follow-ups, T1 Phase 2 / PF-02 (needs durable-churn fixture).
Landed wins are logged in HANDOVER §"Wins locked so far".

## Trace-coverage gaps (worker-verified against docs 02/03/04/07)

Subsystems with neither runtime measurement nor a findings-register entry:

1. UI rendering: frame time, memory, scrolling. (Chat list is paged via
   `loadPages` + scroll increments — no naive full render — but large-chat
   rendering cost is unmeasured.)
2. CBS/regex/Lua/trigger execution per message (PF-01 touches scriptstate
   only as save-payload weight; execution cost unmeasured).
3. Translation runtime and TTS (translation cache statics exist: PF-30/T7).
4. Inlay/media serving through UI flows and gallery (static findings
   PF-17/29/31/33/34 exist; no trace).
5. Lorebook activation, HypaV3, embedding search.
6. Settings screens; realm/hub browsing (harness fences external traffic).
7. Known-deferred harness items (07/HANDOVER): long-generation checkpoint
   behavior, bulk import, optimized-plugin-storage transition scenario, UI
   backup/export/import flows.

## Recommendation

Fold the gap list into T8 (harness) as candidate scenarios; prioritize
(2) per-message scripting and (1) large-chat rendering, since both scale
with the user's core loop and have zero current instrumentation. No other
action: the backlog ordering in HANDOVER remains correct.
