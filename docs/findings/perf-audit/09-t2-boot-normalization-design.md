# T2 design note — boot normalization stops uploading the database

Drafted 2026-08-04 against `16236817`, per the T2 design gate in
[07-remediation-runway.md](07-remediation-runway.md). Findings: PF-03
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
