# MessagePack remediation runway — interim handover

Written 2026-08-03 on branch `serve` at `f5c9ab58` (nothing pushed). This note lets a
fresh session continue the autonomous execution of [docs/WORK-INDEX.md](docs/WORK-INDEX.md)
without re-deriving decisions or process. The durable state of record is the work index
itself (statuses and counts are kept current), the auto-memory file
`messagepack-remediation-decisions.md`, and this note; scratchpad prompt files under
`/tmp` are session-specific and disposable.

## What this effort is

All user decisions for the remaining audit work were collected in advance on 2026-08-02;
execution proceeds item by item with no further input needed unless re-verification
contradicts a decision's premise (then: pause and report, never silently re-decide).

Confirmed decisions:

- **Track 2.3 ETags**: option (a) — shared canonical encoding, byte-digest ETags kept.
  **Landed.**
- **Version skew**: handshake-primary — client build stamp (`x-client-build`,
  `dist/build-stamp.json`), 426 `CLIENT_UPGRADE_REQUIRED` pre-body at admission,
  reload-once loop guard, dirty-state recovery routing. Session-lock semantics
  unchanged. **Landed.** This collapses capability negotiation in 5.5/5.2 to a safety
  interlock.
- **Track 4.5 legacy transition**: retired outright in the same release as the
  handshake. **Landed** (S14/S15 + compressed-save bounding remain open under 4.5).
- **Track 4.1 chat backups**: design the new bundle layout so per-row `chats/` entries
  are a compatible extension; the per-row format itself stays deferred.
- **Track 5.2 chat deltas**: operation-log rows — JSON-patch-style wire deltas reusing
  existing patch machinery; storage = base row + per-chat operation log with
  compaction; lands LAST, preceded by its Track 6 budget test.
- **Standing deferrals (unchanged)**: Track 5.1 residency decoupling (design 5.5 so it
  is not foreclosed); per-row `chats/` backup entries; full-DB `/api/write` pre-image
  bypass.

## Per-item workflow (repeat exactly)

1. Pull the audit text for the item (`docs/messagepack-memory-performance-audit.md`)
   and write a self-contained brief. Every brief requires: **re-verify the finding
   against current code first; STOP and report if materially changed**, preserve named
   contracts byte-exactly, add regression coverage, run focused + relevant
   `test/compat` + full `pnpm test`, do NOT commit, report honestly.
2. Delegate via the `call-codex` skill (`codex_run.py run --cwd /home/codex/PocketRisu
   --effort xhigh --name "Track N.N: ..." --file <brief> -o <out> --meta <meta>`,
   `run_in_background: true`). Note `pnpm check` has one known pre-existing failure
   (`src/ts/plugins/pluginSaveStorage.test.ts` ~line 1933, `unknown + number`; separate
   fix task chip exists) plus four accessibility warnings in `DefaultChatScreen.svelte`.
3. On completion: review the diff yourself (assertion-weakening in existing tests,
   contract drift, stray `.luna-*`/`.codex-luna-*` helper files, edits made after the
   last verification run), independently re-run the focused + compat suites, then
   commit with a conventional title and BOTH trailers:
   `Co-Authored-by: Codex <noreply@openai.com>` and
   `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
4. Update `docs/WORK-INDEX.md`: adjust the header counts, move the item's row to
   "Completed remediations" (past-tense impact, "Fixed: ..." resolution), fix any
   execution-order/validation-table mentions; commit as `docs: mark Track N.N resolved
   in work index`.
5. Update auto-memory `messagepack-remediation-decisions.md` progress line.

## Progress (all landed on `serve`, all suites green at each step)

| Commit | Item |
|---|---|
| `3e65d76e` | Client build handshake at mutation admission (decision infra) |
| `6e31965d` | Track 4.5 part: legacy non-bulk transition retired |
| `96037a72` | Track 3.4: stream-validate single-row plugin mutations |
| `f1b96e1e` | Track 4.3: per-publication-revision parsed manifest cache |
| `783a4ef8` | Track 4.4: incremental viewer facets (+ snapshot cap 2) |
| `17746297` | Track 3.5: verified-metadata sizes + indexed list deltas |
| `f9415905` | Track 2.6: chat rows without re-materialization |
| `0694ea8b` | Track 3.3: streamed verified chunk reads + content memo |
| `a5da369d` | Track 2.3 (a): shared canonical encoding for ETags |

Each is followed by its `docs:` index commit. Index now: **20 of 32 resolved, 12 open
(1 deferred)**. Server suite grew 476 → 506 tests during the runway.

Infrastructure built along the way that later items should reuse: trigger-backed
revision clocks (`databaseRevision.cjs`: database revision + publication revision;
`chunkStore.cjs`: `chunk_manifest_inventory_revision` with `verified_revision` and
`content_verified_revision`; viewer-facet source/index revisions; `chat_row_metadata`
mutation tokens), `revisionBoundCache.cjs`, streamed verified reads
(`iterateValue()`/`kvIterate()`), and the admission-layer build gate.

## IN FLIGHT right now

**Track 4.2 (snapshot assembly outside the mutation queue)** is running as a Codex
appserver thread `019fc2f6-be6e-7ba2-b396-37885e1bd463` (background task id
`btkd47gzt`, output at
`/tmp/claude-1000/-home-codex-PocketRisu/f601dda8-592b-4760-90e9-f6eb73a4e8b2/tasks/btkd47gzt.output`).
Its brief: global source token composed from the existing revision clocks covering
database row, chat rows, plugin generation + exact manifest, quota/owner state, and the
recovery-dirty token; assemble outside the queue through a pinned snapshot only;
re-enter and publish only on token match (failpoint-proven discard on mismatch); fold
read-triggered flush snapshots into the same discipline; replace the existence-check
whole-DB `kvGet` with a metadata query. If the session handling its completion has no
context, review per the workflow above; the thread can be continued with
`codex_run.py run --thread-id <id>`.

## Remaining queue (execution order)

1. **Track 4.1 — restructure chat-backup bundles** (S4, Tier 4): independently
   compressed frames per version + offset index; caps by uncompressed bytes AND count;
   streamed creation; off-loop compression. Decided: design the layout so per-row
   `chats/` entries are a compatible extension, but do not implement per-row now.
   Intersects the streamed pre-image work already landed in 2.6 (`chatBackups.cjs`).
2. **Tier 1 client memory** (largest client items; client+server coordination):
   - **Track 5.5 — binary streaming plugin-value transport** (C6, C13): versioned raw-
     byte reads with metadata headers, fused validate-and-serialize writes,
     streamed/spooled transition rows; removes base64 inflation. Handshake makes the
     capability negotiation a simple interlock. Must not foreclose deferred 5.1.
   - **Track 5.3 — bound conflict recovery** (C5, C11): merge only tracked dirty
     branches into one authoritative working graph (preserve every branch current merge
     handles); retire old encoder/patcher state before building replacements; commit
     patcher baselines only on server acknowledgement; expose the encoder's normalized
     baseline to full writes. Track 6 "conflict rebase graph bound" scenario lands with
     it.
   - **C8 — stream character-package/dataset export-import** (no track item): spool
     chats incrementally, stream archive entries and unzip, emit dataset rows per chat.
     Interchange fixtures assert semantic round-trips (verified), so byte-identical
     archives are NOT required; preserve output formats.
3. **Tier 2 client CPU**:
   - **Track 1.2 — dirty revisions** (C9): revision tracking at the proxy/state layer;
     the JSON-equality comparison stays as correctness fallback until every mutation
     path is instrumented (decided). Track 6 "unrelated-save work bounds" lands here.
   - **Track 5.4 remainder — codec worker** (C1/C3 client half): worker-based codec for
     payload-sized client encode/decode/hash; feature-detect, main-thread fallback.
4. **Tier 5 server memory**:
   - **Track 3.2 — spool large ingress** (S2): stream admitted bodies to disk, validate
     outside the queue, publication recheck at commit against spooled bytes inside
     `queueStorageMutation()`; logical digest during chunking pass; CDC/hash off the
     event loop. Composes with the admission layer landed at `add06b20`/`3e65d76e`.
   - **Track 4.5 remainder** (S8 compressed-save bounding, S14 session-state TTL/bounds,
     S15 staged-download single hash). The endpoint retirement is already done.
5. **Tier 3 — Track 5.2 chat deltas** (C3 client half + S3 remainder): operation-log
   rows per the decided design; coordinated client/server change; its Track 6 budget
   scenario ("chat checkpoint O(delta)") must land FIRST. Rides on 2.6's
   `chat_row_metadata` and the 4.1 bundle design.

Deferred (touch only on explicit reprioritization): Track 5.1, per-row backup entries,
full-DB pre-image bypass.

## Follow-ups / loose ends (not blocking the queue)

- **Track 6 payload-budget scenarios**: landed items shipped functional/counter
  regressions, but the audit's formal payload-budgeted performance scenarios (in
  `test/performance/`) were not systematically added. Before declaring Track 6 done,
  audit which of the nine scenarios exist and backfill the gaps for resolved items.
- **`pnpm test:performance`** has not been run during this runway; run it (and ideally
  the full `pnpm test:compat`) before the next release/push. Full compat last ran clean
  except one known-flaky 16 MiB plugin-batch EPIPE test (passes on retry).
- **Pre-existing `pnpm check` error**: task chip exists ("Fix pre-existing TS error
  breaking pnpm check", `pluginSaveStorage.test.ts`). If it lands, drop the caveat from
  future Codex briefs.
- Nothing has been pushed; the user decides when to push `serve`.
- The client build handshake means any release build must ship a fresh
  `dist/build-stamp.json` (produced automatically by `pnpm build`); servers without it
  log once and run with the gate disabled (fail-open).
