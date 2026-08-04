# Delta audit — summary and actions

Completed 2026-08-05 at `9b589e0e` for `fa4414e7..HEAD` (serve branch
creation → 2026-08-04). Method: coverage-map-scoped delta audit
([00](00-coverage-map.md)) — prior audit programs own everything ≤
`61a8c511` plus the adversarially-reviewed perf window; this audit reviewed
only the genuinely unaudited slices with four parallel deep reviews
(persistence spine, encoding/cache identity, plugin storage, upstream
merge/exports), a standing-surface sweep, and migration-window archaeology.
Every reported finding was independently re-verified against HEAD code.

## Question 1: data corruption / data loss

16 findings ([02-findings.md](02-findings.md)); 5 fatal:

| # | Finding | Introduced by | Class |
|---|---|---|---|
| DA-1 | Remote tip `208fc56a` runs the strict-storage-detaching boot migration; fix `9b589e0e` unpushed; marker-gating prevents later self-repair | wave-1 remediation | deployment hazard |
| DA-2 | 409 rebase reverts edits made during the save's network await; still-dirty revision then persists reverted bytes | `e2ca4ddd`+`e1e60b0d` | acknowledged-edit loss |
| DA-3 | Server restart clears the process-local writer lock; a pre-restart tab's delta-refusal → unconditional full-row chat write replaces newer rows (pre-image mitigates) | merge cluster + row fallback | stale overwrite |
| DA-4 | Streamed package import reports success when declared chats are missing/truncated | `bcb67b3a` | fail-open migration vehicle |
| DA-13 | Plugin-storage viewer Save retypes unchanged values (string `"true"`→boolean, `null`→`''`, `undefined` props deleted) | viewer + facets | silent live corruption |

Warnings: DA-5 model-job claim before chat durability; DA-6 stale-index
recovery overwrite of a newer generation; DA-7 sidecar DBs reintroduce
NORMAL-WAL + no shutdown drain; DA-8 streaming checkpoint re-arm absorbs
post-snapshot tokens; DA-9 swallowed draft-save failures; DA-10 Lua
`upsertLocalLoreBook` discarded in non-display trigger modes; DA-11 Gemini
streaming signature fire-and-forget; DA-12 426 deploy-reload discards
composer drafts; DA-14 sparse-hole densification (transition + folded
snapshots); DA-15 recovery `use-inline` cannot serialize lossless copies;
DA-16 queued recovery actions not epoch-bound.

Historical windows ([01-migration-windows.md](01-migration-windows.md)):
merge-day writer-takeover/boot-etag windows (2026-08-01, closed);
irreversible `null` substitutions in optimized plugin storage before
`244d7a88` (repair impossible — backups only). Most same-day fix windows
were never deployable (push-batch analysis).

The persistence-spine rewrite itself (snapshots, frames, spool, delta log,
verified reads) verified clean with specific guard evidence — the runway's
per-item regression discipline held.

## Question 2: missed performance improvements

None missed in the analyzed sense — the 2026-08 perf audit + MessagePack
runway identified and either landed or catalogued the meaningful wins; the
open backlog (PF-03, T4, T5/PF-14, T6, T8, T1P2/PF-02) is the answer. The
real gap is measurement coverage: ten subsystems have no trace
instrumentation ([03-perf-coverage.md](03-perf-coverage.md)); fold
per-message scripting and large-chat rendering into T8 first.

## Actions, in order

1. **Push `732c8cde` + `9b589e0e` now** (closes DA-1); if any instance
   already booted on `208fc56a`, audit plugin storage and restore from the
   `migration-backup/pre-character-defaults-*` copy.
2. Fix DA-2 (rebase overlay must union post-capture dirty revisions) and
   DA-13 (typed viewer editing) — both are silent-corruption paths in
   ordinary flows.
3. Fix DA-3 with a persistent writer-lock boot epoch + base-hash on the
   full-row fallback; DA-4 with fail-closed import counts.
4. Batch the remaining warnings into the normal work queue; fold all DA
   findings into `WORK-INDEX.md` at the next indexing pass.
5. Delete dormant `loadInternalBackup()`; triage the Python-worker
   protocol naming mismatch separately.
