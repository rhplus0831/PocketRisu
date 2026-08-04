# Delta audit — coverage map

Built 2026-08-04 at `9b589e0e` for the range `fa4414e7..HEAD` (creation of the
`serve` branch, 2026-07-23, through 2026-08-04). Audit goals: (1) data
corruption / data loss introduced anywhere in the range; (2) meaningful missed
performance improvements. This map records what prior audit programs already
cover so the delta audit spends effort only on genuinely unaudited slices.

## Range facts

- 381 commits (311 first-parent), 843 files, +186,130 / −8,872 lines.
- 14 merges, including two upstream syncs; the v1.9.0 sync (`1b9e536f`,
  2026-08-01) alone is 297 files / +22k lines of upstream-authored code.
- 71 of the 108 first-parent commits after the data-loss watermark are runtime
  changes; the rest are docs/index-only.

## Prior audit programs and their watermarks

| Program | Lens | Coverage point | Record |
|---|---|---|---|
| v1 serve-diff data-loss audit | data loss | serve @ `1c0f5257`, remediated @ `2e3d4f05`; 16/16 fixed | `.archived-docs/v1/` |
| v2 whole-codebase audit | data loss | 2026-07-25 @ `bbe0e024` (13 fatal + 23 warning) | `.archived-docs/findings/2026-07-data-loss-audit/` + `docs/findings/open/` |
| v3 whole-codebase audit | data loss (4 lenses) | 2026-07-26 @ `1a7952f1` (6 fatal + 35 warning) | `.archived-docs/findings/2026-07-data-loss-audit/` + `docs/findings/open/` |
| Compatibility investigation | main→serve compat | 2026-07-29 @ `f2da33aa` (46 reports, 20 sub-agents) | `.archived-docs/findings/2026-07-compatibility/` + `docs/findings/open/` |
| Unified revalidation | data loss + compat | **2026-07-31 @ `61a8c511`** — every open finding re-verified | `docs/findings/WORK-INDEX.md` |
| MessagePack memory/perf audit | memory/perf | 2026-08-01 @ `8a385fad` (42 findings) | `.archived-docs/performance/` |
| MessagePack remediation runway | remediation + per-item regressions | 31/32 complete 2026-08-03 (only 5.1 deferred) | `.archived-docs/performance/WORK-INDEX.md` |
| Manifest revision echo | targeted (plugin manifest CAS) | resolved 2026-08-03, 3 phases + gated diagnostics | memory/session record |
| Performance audit phases 0–4 | perf + concurrency charter | 2026-08-04 @ `7ddb8aca`/`ebc7ec88`, system-wide; scope seed `08ce0647..HEAD` | `.archived-docs/findings/2026-08-performance-evidence/` |
| Perf remediation wave 1 | perf | through `208fc56a`, budgets/specs locked per fix | `perf-audit/HANDOVER.md` |
| Adversarial review of wave 1 | correctness of `ebc7ec88..208fc56a` | 2 findings, both fixed same day (`732c8cde`, `9b589e0e`) | memory/session record |

## Coverage statement

**Data-loss lens.** Everything up to `61a8c511` (2026-07-31) has been through
three audit rounds plus a full open-finding revalidation; the 32 still-open
tiered items are catalogued in `WORK-INDEX.md` and are *known*, not missed.
After `61a8c511`, only the perf-remediation window `ebc7ec88..208fc56a`
received an adversarial correctness review. Roughly 60 runtime commits in
between — including the MessagePack runway, which rewrote the persistence
spine — have only their own per-item regression tests and the perf audit's
concurrency-charter scrutiny. **That window is the data-loss audit delta.**

**Perf lens.** The 2026-08-04 audit was system-wide at essentially current
HEAD; its open backlog (PF-03 fix, T4, T5 remainder + PF-14 design, T6
measurement, T8 harness, T1 Phase 2 / PF-02) is the catalogued answer to
"what perf work remains" — those are identified, not missed. The residual
audit question is only whether any surface sat outside the audit's traces and
capability inventory.

## Delta audit targets

Priority order. "Covered by" names the partial coverage that already exists.

| # | Cluster | Commits | Risk rationale | Covered by (partial) |
|---|---|---|---|---|
| D1 | MessagePack audit-driven hardening | `a4efb604`, `1443f822`, `e23b744c`, `d78a2009`, `fdf380ba`, `b6631dfc`, `2f37f1a8`, `c43dde93`, `1a4d9354`, `6f13f3a2`, `9d5d9378`, `add06b20`, `08ce0647` | Encoding boundaries, cache identity/binding, request admission — classic corruption territory | own regressions; perf audit saw current state |
| D2 | MessagePack runway tracks | `3e65d76e`, `6e31965d`, `96037a72`, `f1b96e1e`, `783a4ef8`, `17746297`, `f9415905`, `0694ea8b`, `a5da369d`, `3e758f9a`, `8f85a58f`, `d12cd721`, `82c4d5e1`, `e1e60b0d`, `bcb67b3a`, `e2ca4ddd`, `a44a64b9`, `ca9b37f9`, `c1f3423f`, `e28bf1d3` | Rewrote snapshots, chat backups (per-version frames), chat-row serving, op-log delta checkpoints, ingress spool, codec worker, canonical ETag encoding, conflict recovery | per-track regressions + Track 6 validation; perf-audit scope seed |
| D3 | Upstream v1.9.0 merge cluster | `f31585f1`, `faf6a239`, `1b9e536f`, `eae52cbc`, `b52fe4d1`, `e57b6fbd`, `013c4a46`, `b799a704`, `818c3bc1` | 22k upstream lines meeting fork persistence; send-guard reshape; new request-logs/token-stats persistence; mode-migration consolidation | Codex overlap report at merge time; suites green |
| D4 | Plugin-storage recovery + fidelity | `a3a98da6`, `244d7a88`, `a65c9393`, `95c2ea30` (echo trio `ac988998`/`14e8c456`/`89604efa` lower priority) | New destructive-adjacent recovery-management surface; `244d7a88` is itself a data-fidelity fix (undefined preservation) | manifest-echo targeted tests |
| D5 | Rollback export + plugin settings UI | `9342c09b`, `e53ec7a3`, `d4d68dfe`, `8a385fad` | `target=main` export is a migration vehicle (loss becomes permanent); landed hours after the revalidation watermark | written as audited-finding remediation with contract coverage |
| D6 | Migration ran-buggy-window analysis | `013c4a46`, `8f85a58f`, `16236817`, `208fc56a`+`9b589e0e`, `244d7a88` | One-shot transforms: a bug fixed later may already have transformed live data while buggy. Sharpest case: `208fc56a`'s character-defaults migration detached strict plugin storage until `9b589e0e` — `208fc56a` is pushed, the fix is not | adversarial review found the defect; deployment window unknown |
| D7 | Standing unaudited surfaces (v3 critic list) | n/a (surfaces, not commits) | `src/ts/storage/chatDraft.ts` swallowed errors; `process/files/inlays.ts` triple-write; dormant `loadInternalBackup()`; triggers/Lua scriptstate never re-swept; V3 startup vs tracker readiness | explicitly flagged unaudited in v3 |
| P1 | Perf trace-coverage gaps | n/a | Any subsystem absent from `02-capability-inventory` / `03-trace-baselines` (candidates: UI rendering, Lua/scripting, translation/TTS/media paths) | system-wide audit at HEAD |

## Explicit non-goals

- Re-auditing anything ≤ `61a8c511`: the corpus + revalidation own it; open
  items are tracked in `WORK-INDEX.md`.
- Re-deriving the perf backlog: `perf-audit/07-remediation-runway.md` +
  `HANDOVER.md` own it.
- Upstream-internal correctness of v1.9.0 code that does not touch fork
  persistence or interchange surfaces.
