# T2 design note — boot normalization stops uploading the database

Drafted 2026-08-04 against `16236817`, per the T2 design gate in
[the active backlog](../backlog.md). Findings: PF-03
(first-run boots through ~7 patch cycles), PF-04 (first boot after any
import uploads a DB-scaled default-fill patch — 292,736 B / 3,870 ops on the
300-character fixture, 3,600 of them the per-character `??=` fills in
`checkNewFormat()`, `src/ts/bootstrap.ts:560-588`). File:line references
verified at drafting; re-`rg` before implementing.

Status: **revised after two adversarial review rounds** (Codex xhigh +
8/8 Luna cross-check, 2026-08-04). Round 1 refuted the original §1
mechanism and PF-03 barrier premise and surfaced the ingest ID-ordering
hazard; round 2 corrected the §1 rebase semantics (branch-selective), the
§2.2 hazard attribution (naive-implementation trap, not current behavior),
the marker placement level, and the PF-03 interception scope. The
server-persisted-defaults direction survived both rounds unchanged.

## 1. Why the client-side fix shapes are rejected (corrected mechanism)

The runway offered "decode-time fill that does not mark branches dirty".
Rejected, with the mechanism the adversarial review corrected:

- The boot baseline is captured **pre-normalization on purpose**
  (`setPatchSyncBaseline(decoded)`, `bootstrap.ts:179`), and `saveDb()`'s
  startup reconciliation deliberately turns the fills into the one-time
  sync patch (`globalApi.svelte.ts:424-526`). PF-04 is designed behavior.
- Capturing the baseline post-normalization does **not** cause a permanent
  full-write fallback (the original draft's claim — wrong). What actually
  happens (round-2-corrected): the first later mutation sends a
  normalized-baseline `expectedHash`, the server answers
  `409 DATABASE_PATCH_CONFLICT` (`server.cjs:16892`), and the client
  rebases from the raw authoritative graph — but the rebase overlay is
  **branch-selective** (`conflictDirtyBranches()`, `risuSave.ts:1493`;
  `databaseClone.ts:227-266`): only dirty branches survive, root overlays
  exclude characters, and the rebase runs `setDatabase()` — not
  `checkNewFormat()` (`globalApi.svelte.ts:785`), which is the only home
  of the character fills (`bootstrap.ts:556`). So clean characters'
  fills silently **vanish from the live graph mid-session** until the next
  boot re-fills them. Net effect: the defaults never converge to the
  server, every boot re-fills, conflict cycles recur, and code reading a
  suddenly-unfilled field (`char.bias` etc.) mid-session is exposed to
  undefined values. The option is worse than useless.
- The only variant that truly avoids the upload — both sides applying an
  identical fill function inside the shared normalization/hash domain —
  makes every future default addition a hash-domain lockstep event.
  Disproportionate for a **one-time-per-import** cost (trap 1: the second
  boot uploads zero).

## 2. Decision — PF-04: persist the defaults at the server ingest boundary

Defaults become real bytes; hash/patch/ETag domains agree because there is
no divergence to manage. Components:

1. **Shared character-defaults contract** (new `shared/` file, following
   `shared/plugin-save-key-policy.json`). Scope is deliberately narrow:
   **only** the deterministic character-shape fills from `checkNewFormat()`'s
   loop (`bootstrap.ts:560-588`: `type`, `chatPage`, `chats`,
   `customscript`, `firstMessage`, `globalLore`, `name`, `viewScreen`,
   `emotionImages`, and the `type === 'character'` subset `bias`,
   `characterVersion`, `creator`, `desc`, `utilityBot`, `tags`,
   `systemPrompt`, `scenario`) plus ID-assignment rules with the client's
   **exact falsy semantics** preserved (persona `id` is nullish-assigned,
   `bootstrap.ts:652`; character `chaId` and bot-preset IDs treat `''`/falsy
   as missing, `bootstrap.ts:564` + `:797`, `database.svelte.ts:193`).
   **Explicitly excluded**: `formatversion`, `loreBookToken`,
   `characterOrder`, legacy asset cleanup, module lore migration, the
   trash purge, and everything in `characterFormatUpdate()`
   (`characters.ts:517-599`) — that function creates chats, moves fields,
   and stamps `Date.now()`; it is a selection-time migrator, not a defaults
   mapper, and a parity test must NOT equate it with server ingest.
2. **Server fill at ingest** — `ingestDatabase()` and
   `ingestDatabaseStreaming()` (`server.cjs:9800-9828`, `:18803-18823`,
   `:20367-20420`), with one hard invariant (round-2-corrected): **no chat
   row may be written for a character whose `chaId` is unassigned.**
   Current code already respects it — streaming computes
   `externalizable = Boolean(character.chaId) && !retainChats` *before*
   `onChat` (`streamRisuLoad.cjs:767`), so missing-ID characters take the
   inline-retention path, and non-streaming extraction skips missing IDs
   (`chatRows.cjs:301`). The `chats/undefined/<chatId>` write-then-sweep
   data loss (`chatRowKey()` stringifies, `chatRows.cjs:48`; sweep
   `:1437`) is what a **naive fill implementation introduces** if it
   assigns IDs mid-walk after `externalizable` was computed and then
   externalizes. Correct assignment points: non-streaming — after
   cold-storage restoration, before dedupe/split (`chatRows.cjs:1205`);
   streaming — on the post-walk remainder, after cold-storage restoration
   (restoration can overwrite `chaId` via `Object.assign`,
   `server.cjs:18156`) and **before** `extractPayloadChats()`
   (`chatRows.cjs:1396-1437`), with mid-stream missing-ID characters
   deliberately left on the inline-retention path. Characters without
   chats are covered by the same remainder pass.
3. **One-time marker-gated boot migration** for existing databases, using
   the chat-externalization pattern (`server.cjs:2369-2386`,
   `:21330-21373`). Marker topology (round-2-corrected placement): the
   marker must be written at the **lower-level publication points** where
   the existing ingest markers already commit — inside the full-ingest
   transaction (`chatRows.cjs:1233`) and the streaming commit/joined
   transaction (`:1260`, `:1441`) — so standalone defensive ingests
   (`server.cjs:2240`) are atomic too; writing it in the `ingestDatabase()`
   wrapper after awaiting streaming would not be. Snapshot restore's outer
   transaction (`server.cjs:20363-20439`) then covers it like the rest.
   Since chat migration itself invokes ingest, ingest setting the marker
   prevents a redundant defaults-migration pass at startup — with one
   qualification: legacy REMOTE-block databases already take an extra
   copy/rewrite through remote migration inside that chain
   (`server.cjs:2019-2072`); coordinating that away is optional, an extra
   one-time copy for that legacy case is acceptable. The migration must run through the
   **authoritative decoder/encoder** (RisuSave headers v7–12 plus the
   `__pocketRisuPluginStorageEscapesV1` plugin-key envelope,
   `utils.cjs:9`, `:1004`) — a naive MessagePack rewrite risks corrupting
   escaped plugin keys. Re-encoding may legitimately change the framing
   version and therefore the raw ETag/stored size; expected, document it.
4. **The normalized state is NOT a forever invariant — state the contract.**
   Ordinary `/api/write` full replacements bypass ingest
   (`server.cjs:16517`, `:16605`) and can republish an unnormalized graph.
   That is accepted: same-build clients only publish graphs that already
   passed `setDatabase()`/`checkNewFormat()`, and the client fills remain
   the always-on safety net for every other producer. The marker means
   "migration ran once", nothing stronger. No enforcement at `/api/write`.
5. **Client fills stay, and what they still do (corrected).** Only the
   contract's character fills become no-ops. `checkNewFormat()` remains a
   broader ordered migration — `formatversion` 2→5, `loreBookToken`
   promotion, `characterOrder` init/repair, asset cleanup, module lore
   repair (`bootstrap.ts:595-716`) — which still fires on legacy imports
   and produces bounded patches. The honest claim is: **the DB-scaled
   character-default patch disappears; small legacy-migration patches
   remain client-side by design.** Version skew (new client field, older
   server): client fills it → today's one-time patch. Graceful.

Observable server-side deltas (accepted, documented): backup-size
estimates and DB/`cardBytes` stats grow slightly (`server.cjs:19568`,
`:19649`, `:19855`); a migration rewrite invalidates outstanding
plugin-recovery proofs bound to exact old bytes — they go stale safely and
are retried (`server.cjs:6862`); already-open clients hit one 409-rebase,
cached boots take partial segment misses and re-verify
(`nodeStorage.ts:4419`) — all converge safely.

## 3. Decision — PF-03: attribute first, then consolidate

The original draft's boot-completion barrier was **refuted on its
premise**: every obvious synchronous mutation phase (setDatabase, theme/
language, plugin load, `checkNewFormat()`, UI defaults, `assignIds()`)
completes **before** `saveDb()` starts (`bootstrap.ts:327-395`), the app
is mounted and `loadedStore` flips true before `saveDb()` is even called
(`main.ts:17`, `App.svelte:195`, `bootstrap.ts:389`), and the audit's own
appendix never attributed the 7 patch cycles to specific producers
(`05-lens-evidence.md:21-27`). The cycles likely originate in reactive/
mount-effect producers after the UI becomes interactive — unproven.

Plan, measurement-first (T6 discipline):

1. **Attribute**: instrument the first-run E2E scenario to capture each
   `/api/patch` body with timing. Round-2 caveat: dirty-domain labels from
   `watchDatabaseDirtyRevisions()` identify domains and IDs, **not
   producers** (`databaseDirtyRevisionTracker.svelte.ts:43`) — real
   attribution needs temporary mutation-site tags or equivalent tracing
   added for the measurement run.
2. **Then design consolidation** against real producers. Constraints
   already known for any suppression window: `requestImmediateSave()`
   returns failure until the loop installs its implementation
   (`globalApi.svelte.ts:279`, `:1205`) and plugin lifecycle callers
   require a genuinely committed outcome (`plugins.svelte.ts:676`); the
   boot plugin reconciliation's direct ETag-guarded write
   (`bootstrap.ts:49`) must not be suppressed; and the interception point
   must be at the `triggerSave` level, not `requestImmediateSave` alone —
   pagehide calls `triggerSave({forceChatPersist:true})` directly and
   discards the outcome (`globalApi.svelte.ts:612`), so a barrier that
   only wraps the outcome-returning API misses it. Queued requests
   resolve only after a real commit; never report success early. Crash-safety framing (corrected): freshly assigned
   UUIDs ARE referenced pre-persistence (`checkCharOrder()` inserts
   `chaId` into `characterOrder`, `globalApi.svelte.ts:1594-1612`) — on an
   empty DB both are lost together and reconstruct, but once the UI is
   interactive, externally keyed rows can outlive a lost DB ID, so the
   suppression window must end before interactivity or queue-and-commit.

PF-03 budget targets are contingent on attribution; do not promise
≤15 req / ≤32 KB until the producers are known.

## 3-A. PF-03 attribution results (2026-08-04, post-PF-04 baseline)

Measured at `208fc56a` on `serve`. The attribution sample is five isolated
empty-instance runs with the scenario's existing two-second post-ready phase;
seven uninstrumented validation runs checked the phase totals, and a separate
eight-second probe tested whether the sequence stops. Temporary tracing recorded
the scheduling stack, tracked/revision snapshot, patch body and response, and the
complete request list. Source-map symbolization and the op paths were then checked
against the cited source. All tracing was removed before this addendum.

**Result: the audit's “7 cycles” are not seven boot producers or seven completed
phases.** They are a cutoff-sized sample of one valid startup proposal stuck in a
non-converging `409 DATABASE_PATCH_CONFLICT` loop. The eight-second probe reached
16 same-size, same-op-set conflicts (454,672 body B / 468,416 wire-request B), 16 database
rereads, and 15 warning flushes and was still running when the phase ended.

### Measured patch sequence

Offsets below are min–max from navigation start across the five comparable runs.
“Window” names the scheduling window that led to the request, not a distinct data
producer.

| Patch | Offset | Body B | Op-path summary | Producer / scheduling path | Window and mergeability | Confidence | Stability |
|---:|---:|---:|---|---|---|---|---|
| 1 | 1,276–1,423 ms | 28,417 | 296 top-level ops: 295 `add /<root-key>` + 1 `replace /botPresets`; no nested or `/characters` op | The single pre-tracking startup diff: `setDatabase()` defaults (`src/ts/storage/database.svelte.ts:43-798`), fresh theme/language (`src/ts/bootstrap.ts:305-330`), `checkNewFormat()` + final `setDatabase()` (`src/ts/bootstrap.ts:561-718`), and `didFirstSetup` (`src/ts/bootstrap.ts:371-374`), collected by `startupProposal` (`src/ts/globalApi.svelte.ts:497-526`) | W0, immediate save-loop wake; no 500 ms debounce and no earlier neighbor | High | Same op set, size, expected hash, and 409 in 5/5 |
| 2 | 1,929–2,078 ms | 28,417 | Same 296-op set | No new boot producer: conflict rebase rereads `{}`, installs it with `setDatabase()`, requeues the same dirty branches (`src/ts/globalApi.svelte.ts:741-814`), and retries after the conflict backoff (`:1060-1064`) | W1, the 500 ms root-watcher debounce overlaps the 500 ms conflict sleep; both already merge into this one retry | High | 5/5 |
| 3 | 2,570–2,722 ms | 28,417 | Same 296-op set | Same conflict-rebase replay as patch 2 | W2, causally created only after patch 2 fails; cannot merge forward | High | 5/5 |
| 4 | 3,210–3,363 ms | 28,417 | Same 296-op set | Same conflict-rebase replay as patch 2 | W3; cannot merge with W2/W4 because the next graph replacement does not exist until this request returns 409 | High | 5/5 |
| 5 | 3,857–4,002 ms | 28,417 | Same 296-op set | Same conflict-rebase replay as patch 2 | W4; same causal boundary | High | 5/5 |
| 6 | 4,488–4,642 ms | 28,417 | Same 296-op set | Same conflict-rebase replay as patch 2 | W5; same causal boundary | High | 5/5 |
| 7 | 5,124–5,279 ms | 28,417 | Same 296-op set | Same conflict-rebase replay as patch 2 | W6; same causal boundary; “last” only because the test phase ends | High | 5/5 traced; outside the cutoff in 1/7 stock validations |

Every body used `expectedHash: "0"`; every response was 409; none of the
198,919 request-body bytes in a seven-cycle capture committed. Including request
headers, those seven patches were **204,932 B**, exactly the audit baseline. Six
of seven uninstrumented current runs reproduced the whole-phase baseline, **34
API requests / 225,348 B uploaded**. One captured only six cycles before the
phase cutoff: **31 API requests / 194,186 B**. Its 31,162-B delta is exactly one
29,276-B wire patch, one 793-B database reread, and one 1,093-B warning flush.

PF-04 therefore did not change the underlying empty-instance PF-03 storm (as
expected: its character-default ingest has no character to normalize here), but
the audit's exact cutoff count is not invariant: it is currently **6–7 patches /
170,502–198,919 body B**. Within the five traced attribution runs, timing varied
by roughly 147–155 ms at each patch index while counts, bytes, op sets, response
codes, and attribution were stable; the stack-heavy tracing was enough to keep
patch 7 inside all five capture windows.

### Why it cannot converge

The fresh client and server start from different hash-domain graphs:

1. Bootstrap encodes `{}` and calls create-if-absent (`src/ts/bootstrap.ts:164-169`).
   The current client route sends no body (`src/ts/storage/nodeStorage.ts:2736-2808`),
   and the server creates, caches, and persists the literal `{}`
   (`server/node/server.cjs:11140-11182`). Its compositional object hash is the
   object seed, decimal 17 / hex `"11"` (`server/node/utils.cjs:1027-1058`).
2. The client correctly captured decoded `{}` as its untouched boot baseline
   (`src/ts/bootstrap.ts:181-188`), but `RisuSavePatcher.initializeBaseline()`
   then inserts `characters: []` into that private baseline
   (`src/ts/storage/risuSave.ts:1322-1328`). The empty compositional patcher
   baseline produces the observed `expectedHash: "0"` (`:1299-1310`, `:1543`).
   Because the patcher treats `/characters` as already present, the 296-op patch
   contains no operation that can make the server's `{}` match that preimage.
3. The server rejects the mismatch (`server/node/server.cjs:16927-16940`). The
   client rereads the still-authoritative `{}`, creates another patcher that
   again inserts `characters: []`, overlays/requeues the same root defaults, and
   repeats. The dirty callbacks describe the replayed domains; they are not new
   producers.

This directly contradicts the old PF-03 wording in `06-verification.md` that
“successive startup phases each run their own save/re-read cycle,” and it refutes
§3's remaining hypothesis that separate reactive/mount producers likely explain
the seven requests. There is one startup producer set and an unbounded protocol
retry.

### `/api/read` and `/api/logs` attribution

- All seven `/api/read` requests in a seven-cycle capture were `GET` with `file-path` decoding to
  `database/database.bin`, each immediately after its corresponding 409. They
  come from conflict recovery's `readDatabaseCandidate()` call
  (`src/ts/globalApi.svelte.ts:741-747` →
  `src/ts/storage/nodeStorage.ts:4277-4303`), not plugin storage, cache selection,
  or an independent boot phase. The initial capable-server missing-database probe
  is the separate `/api/db/read-raw-for-boot` route and is not one of these seven.
- Each of the six in-phase `/api/logs` bodies contained exactly one entry:
  source `console`, level `warning`, message “`[Save] Patch conflict detected,
  rebasing tracked local changes on latest server DB...`”. The warning is emitted
  at `src/ts/globalApi.svelte.ts:1060-1063`, captured by
  `src/ts/log-capture.ts:45-61`, and flushed after 500 ms by
  `src/ts/log.ts:72-129`. Six rather than seven is just the phase boundary: the
  seventh warning's flush falls after capture. The six-cycle stock capture's
  exact byte delta and the long probe's 16 patches / 16 reads / 15 log POSTs
  confirmed the same **N patches / N reads / N−1 log POSTs** cutoff shape.

### Recommendation and budget consequence

Do **not** add a PF-03 boot suppression/consolidation barrier on this evidence.
Patch 1 already consolidates all known synchronous first-run mutations before
tracking starts; patches 2+ have no independent producer to consolidate. A
longer debounce or a `triggerSave` barrier merely delays the same invalid patch.

The first remediation must align fresh creation, stored/cache state, and the
client patch baseline. At minimum, `{}` versus `{ characters: [] }` must hash the
same graph by making fresh creation include the branch or by keeping the patcher
baseline exact and emitting the missing op. That turns the measured sequence
into one successful 28,417-B body / 29,276-B wire patch and removes all seven
conflict rereads and six warning uploads in the audit window. Projected from the
unchanged baseline, that is **15 requests / about 37,583 wire-upload B**: the
request target is met exactly, but the **≤32 KB byte target is not** (short by
about 5.6 KB).

To meet both runway targets, fresh creation must publish the already-normalized
first-run graph atomically (for example, a shared fresh-database factory at the
create boundary, with any browser-specific language/theme inputs explicitly
represented) so the 296-op defaults patch is also absent. If the server can
construct the same graph without uploading it, the measured projection is
**14 requests / about 8,307 wire-upload B**. If the design instead sends a
client-built seed body to create-if-absent, remeasure its encoding before claiming
≤32 KB. This is creation/normalization work, not debounce consolidation.

The §3 interception constraints remain valid if a broader boot barrier is ever
justified by different data: interception belongs at `triggerSave`; queued
`requestImmediateSave()` calls must resolve only after a real commit; boot plugin
reconciliation's direct fenced write remains exempt; pagehide must retain its
immediate/force-chat-persist escape; and post-interactivity ID references require
queue-and-commit rather than early success. This measurement simply shows that
such a barrier would intercept no mergeable PF-03 producer windows today.

A small permanent **test-only** trace hook is worth proposing, but was not kept:
emit monotonic `startup-proposal`, `triggerSave`, patch op-count/hash, response
status/code, and dirty-target snapshots to an injected E2E sink. Do not retain
stack capture (it is expensive and effect stacks usually stop at the observer).
Pair it with a first-run assertion that no patch receives 409 and a short
post-ready quiet-period assertion; that would have identified this conflict
storm directly instead of fossilizing the cutoff count.

Final tree hygiene after removing the temporary client/spec tracing:
`git diff --stat` contains only this documentation file (`1 file changed, 141
insertions(+)`). No production behavior or E2E instrumentation remains.

## 4. Contract check (STRUCTURE.md)

- *Patch normalization/hashing*: untouched — persisted defaults are
  ordinary bytes inside existing domains; no `normalizeJSON()`/hash change.
- *Imports are exclusive replacements*: the ingest fill runs inside the
  existing staging + transaction + swap-journal protocol; the marker joins
  the existing marker set with the atomic-set rule above.
- *Baseline capture*: mechanics unchanged; reconciliation finds an empty
  character-defaults diff against a normalized DB.
- *Never-replay / outcome protocols*: migration is transactional and
  marker-gated; PF-03's queue-and-commit rule preserves
  `requestImmediateSave()` outcome semantics.
- *Interchange*: persisted defaults (and possible framing-version changes
  from the migration re-encode) change backup/export bytes with identical
  semantics. Upstream RisuAI persists the same fills once a character is
  touched (`/home/codex/Risuai/src/ts/characters.ts:533-612`), so
  normalized exports are within upstream's value space. Upstream-style
  `database.risudat` imports enter the same ingest funnel
  (`server.cjs:9794`) and get normalized like any import; encrypted
  account backups stay rejected (`server.cjs:9716`).
- *Hub hosting*: server-file backup/restore is disabled there
  (`server.cjs:17954`) but snapshot ingestion and the boot migration still
  run — migration tests need a hub-mode variant.

## 5. Regression proof

- Extend the two-cold-boots invariant (`boot.spec.ts:11-31`): first boot
  on a freshly imported fixture uploads only a small bounded patch (legacy
  migrations may legitimately emit ops — assert a ceiling from
  measurement, not zero).
- `xl-cold-boot` budget: 22 req / 420,000 B → ≤64,000 B (the 292 KB
  character-fill patch disappears; the xl decomposition assertion in
  `verification.spec.ts:165` area flips from "3,870 ops dominated by
  /characters" to a small-op ceiling).
- `first-run-boot`: tighten only after PF-03 attribution.
- Server tests: ingest normalization fills the contract set; **the
  missing-`chaId` import fixture with chats proves no `chats/undefined/*`
  rows and no sweep loss** (the §2.2 ordering rule); migration is
  once-only, marker set atomically by every ingest publication, hub-mode
  variant included; escaped-plugin-key DB round-trips the migration
  byte-safely at the logical level.
- Contract-parity test: client fill set == shared contract == server fill
  set, scoped to the contract fields only.

## 6. Risks

- **Streaming-ingest ID timing is the top risk** (data loss if violated);
  it gets the dedicated regression fixture above.
- Defaults-contract drift over time (26 historical revisions to
  `characterFormatUpdate()`); mitigated by the narrow scope + parity test
  + client fills as safety net.
- Migration re-encode changing framing/ETag surprises tooling that assumed
  byte stability; document in the migration's commit.
- PF-03 remains partially unknown until attribution; its design may need
  its own review round once producers are identified.
