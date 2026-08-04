# Delta audit — one-shot migration / ran-buggy-window analysis (D6)

Built 2026-08-04 at `9b589e0e`. Question: for every one-shot transform in
`fa4414e7..HEAD`, was there a window in which a *buggy* version of the
transform could have run against live data — even if the code is fixed now?
Method: fix-commit archaeology cross-referenced against the `origin/serve`
reflog (push batches are the only deployable states; a bug introduced and
fixed inside one batch was never fetchable).

## Deployable-state model

`git reflog show origin/serve` push batches in the window:
07-31 19:41 (`e23276b2`) → 08-01 05:16/07:05/08:46/14:55/18:40/19:54 (merge
day) → 08-03 00:00 (`f5c9ab58`) → 08-03 19:55 (`89604efa`) → 08-04 14:07
(`5331339d`) → 08-04 20:44 (`208fc56a`, **current remote tip**).

## Findings

### M1. OPEN — remote tip runs the strict-storage-detaching migration  [fatal until pushed]

`208fc56a` (pushed 08-04 20:44, current `origin/serve` tip) ships the T2
PF-04 marker-gated one-time boot migration that re-encodes already-persisted
databases through the authoritative codec. The adversarial review found it
drops optimized plugin value/metadata attachment during normalization; the
fix `9b589e0e` (snapshot the fields pre-normalization, re-attach with
ingest-equivalent presence semantics) is **local-only**. Consequences:

- Any instance updating to current `origin/serve` runs the buggy migration
  on its next boot.
- The migration is marker-gated *once*: a database migrated by the buggy
  version is **not** re-repaired after later updating to `9b589e0e` — the
  marker is already set. Recovery is the migration's automatic
  pre-migration safety backup, not self-healing.

**Action: push `732c8cde` + `9b589e0e` (and the two docs commits) before any
instance updates; if an instance already booted on `208fc56a`, verify plugin
storage attachment and restore from the pre-migration backup if needed.**

### M2. Historical — merge-day windows (2026-08-01)  [low likelihood, closed]

- 07:05 → 08:46: deployed state lacked `b799a704` (equivalent boot-ETag
  reconciliation). Impact: spurious boot 409/conflict handling after the
  merge — availability nuisance, no identified loss path.
- 07:05 → 14:55: deployed state lacked `818c3bc1` ("restore explicit writer
  takeover choice"). In that window writer takeover behavior from the
  upstream merge was not gated on an explicit choice; with multiple
  tabs/devices, dirty-state displacement (the v2 `writer-lease-displacement`
  class) was possible. Closed same day; only relevant if an instance
  updated inside the window *and* used concurrent sessions.

### M3. Long-lived — `undefined` collapsed in optimized plugin storage  [warning, tail closed]

`244d7a88` (08-03 22:05, deployable only from the 08-04 14:07 push) added a
collision-safe lossless codec "across reads, writes, transitions, recovery,
backups, and imports". Before it (cluster-C evidence, `244d7a88^`):
`jsonValue.ts:457` returned `null` for `undefined`, `:498-503` wrote `null`
for sparse holes, and both the ordinary optimized write path (after strict
serialization failed) and server-side bulk migration used that conversion —
with compatibility conversion **enabled by default**
(`database.svelte.ts:767`). Rows written lossily during that period remain
lossy: an intentional `null` and a substituted `null` are byte-identical,
so automatic repair is impossible. Blast radius: users with optimized
(Beta, V3-gated) plugin storage whose plugin values contained `undefined`
or sparse holes; recovery only via pre-transition backups. See DA-14 for
the *still-current* hole densification in transition transport and folded
snapshots.

Companion `95c2ea30` (recovery-side acceptance of the new lossless rows)
landed in the same push batch — the incompatible intermediate state
(lossless writer + strict recovery) was never deployable.

### M4. Never-deployable same-batch windows  [no exposure]

- `6f13f3a2` (cache unbound → revision-bound) — intra-batch, 08-03 00:00.
- `d12cd721` (pinned-assembly flush 503 regression from `3e758f9a`) —
  introduced and fixed between the 08-03 00:00 and 08-03 19:55 pushes.
- `9510ec2c`/`cbd13754` docs — no runtime effect.

## Latent-correctness review of the transforms themselves

Current-state correctness of the surviving transforms (frame conversion
`8f85a58f`, mode-migration consolidation `013c4a46`, T1 projection
`16236817`, fixed T2 migration `9b589e0e`) is assigned to review clusters
A/C of this audit (see `00-coverage-map.md` D1/D2/D4); the T1/T2 design
notes' invariants (perf-audit docs 08 §3, 09 §2.2) were adversarially
reviewed 2026-08-04.
