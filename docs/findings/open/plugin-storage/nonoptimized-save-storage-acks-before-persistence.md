# Non-optimized plugin save storage acknowledges before persistence

- Status: Open
- Owner: plugin storage
- Source: [2026-07 data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium
- Lens: L3, L4, D2
- Area: Area 2 — client/plugin boundary
- Affected code: `src/ts/plugins/pluginSaveStorage.ts:2315-2326`, `src/ts/plugins/pluginSaveStorage.ts:2481-2505`, `src/ts/plugins/pluginSaveStorage.ts:3392-3401` (inline in-memory publication), outcome APIs (`setItemWithOutcome`), guarded batches, and viewer CAS rewrites over the same gap
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../../../.archived-docs/findings/2026-08-revalidation/README.md)

## Risk

Optimized plugin storage awaits its transactional server publication. In the
default inline mode, the same APIs mutate the reactive map and resolve as soon
as the in-memory publication completes; the actual database write is scheduled
later by the ordinary reactive save loop.

The module has been rebuilt since the original report (per-key queues, an
inline publish mutex, revision hashing) and the surface has broadened: guarded
batches, the outcome APIs, and viewer CAS rewrites can now all report a
committed result — `setItemWithOutcome` literally returns outcome
`'committed'` — for a memory-only inline publication. That terminology
collides with the repository's committed-save contract, under which
"committed" is supposed to prove durability. A page unload or a later save
failure inside the window silently reverts an acknowledged plugin write, and
the viewer's inline save success has the same gap. API durability still
changes with the storage mode.

## Required fix and coverage

Give inline V3, batch, outcome, and viewer mutations a durability-aware commit
path — do not resolve or report `committed` until the database save settles —
or expose explicit staged-versus-persisted semantics and stop using committed
terminology for staged publications.

Test identical write, remove, and clear failures in both optimization modes,
including the outcome APIs.
