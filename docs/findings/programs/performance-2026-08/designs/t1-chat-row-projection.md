# T1 design note — persisted-row projection for chat save-path deltas

Drafted 2026-08-04 against `053944f3`, per the T1 design gate in
[the active backlog](../backlog.md). Findings: PF-01
(deltas never engage), PF-02 (double full-row write). All file:line
references verified at drafting time; re-`rg` before implementing.

Status: **passed adversarial review with amendments** (2026-08-04, Codex
xhigh refutation pass). The review confirmed the client-only Phase 1, the
choke point, and delete-keys semantics; it refuted the original snapshot
wording and produced the §3 binding invariant plus a reproduced
`CHAT_DELTA_LOG_CORRUPT` failure for the forbidden variant. Implement
exactly as specified in §3.

## 1. Problem

Every ordinary streamed send mutates `chat.isStreaming` and
`chat.activeStreamingDisplayOptimizationMode`
(`src/ts/process/index.svelte.ts:1548-1550`, `:1683-1686`), and both persist
into the encoded row. `prepareChatDeltaPatch()` admits only `/message/...`
JSON-Patch paths (`src/ts/storage/chatDelta.ts:38-44`), so every save around
a generation differs from its acknowledged base by a non-message field and
falls back to the full encoded row: measured 427 KB (single save) to 872 KB
(checkpoint + final, PF-02) per exchange on a 400-message chat, versus ~1–2 KB
of workable delta.

## 2. Decision

**Phase 1 (this track's core): a client-side persisted-row projection.**
Strip the runtime-only fields from the snapshot that crosses the codec
boundary, so encoded rows, their hashes, and delta comparisons never see
them. **No server change, no migration, no allowlist change** — §5 shows why
the audit's lockstep warning is priced down for this phase.

**Rejected as the primary fix: delta-protocol tolerance for runtime fields.**
Ignoring `isStreaming` in the client diff is insufficient — the codec worker
proves every delta by replaying it over the acknowledged base and requiring
byte-identical output (`src/ts/storage/payloadCodecOperations.ts:44-68`), and
the server re-encodes its own base exactly
(`server/node/chatRows.cjs:566-641`). Tolerance therefore forces a paired
redefinition of hash/replay semantics on both sides for strictly more
complexity than removing the fields from the byte domain.

**Phase 2 (follow-on, separate change): declared durable-path delta
admission.** The projection cannot help chats whose *durable* fields change
per exchange — see §6. Phase 2 extends the delta protocol's admitted path
set. It is the part that genuinely needs client/server lockstep, and it is
optional until measurement shows Phase 1's ceiling matters in practice.

## 3. Phase 1 specification

**Projected fields — exactly three, all proven runtime-only** (field audit:
`Chat` at `src/ts/storage/database.svelte.ts:2222-2260`):

| Field | Evidence it is runtime-only |
|---|---|
| `isStreaming` | Set/cleared around streaming; hydration already deletes it because "the server copy can carry isStreaming=true forever" (`src/ts/storage/chatStorage.ts:230-234`); boot normalization resets it for every full chat (`database.svelte.ts:786-795`) |
| `activeStreamingDisplayOptimizationMode` | Same lifecycle, same hydration/boot normalization |
| `_placeholder` | Browser-runtime hydration marker (`chatStorage.ts:20-33`); must never reach the wire |

Explicitly **not** projected: `scriptstate`, `hypaV3Data`, `supaMemory`,
`suggestMessages` (durable, reload-relevant readers cited in the audit);
`sdData` and `Message.otherUser` (ambiguous legacy fields with no located
reader — leave untouched until separately resolved). No `Message`-level
field is runtime-only; `generationInfo` is durable (job recovery reads it
after reload, `src/ts/process/request/jobRecovery.ts:430-439`).

**Where:** the codec boundary in `src/ts/storage/payloadCodecClient.ts:19-47`,
which feeds worker and inline encode paths alike
(`payloadCodecOperations.ts:44-68`, `payloadCodecService.ts:256-276`).
Adversarial review confirmed this is a true choke point: every in-repo POST
to `/api/chat-content` goes through `postChatContent()` ←
`saveChatContent()` ← `prepareChatRowCheckpoint()`
(`nodeStorage.ts:6150`, `:6224`), including forced pagehide saves
(`globalApi.svelte.ts:612`), model-job recovery (`jobRecovery.ts:251`), and
character-package row import (`characterPackage.ts:339`).

**THE BINDING INVARIANT (from adversarial review — the note was refuted
without it):** *projection applies ONLY to the current wire-bound row;
acknowledged bases must remain exact decoded representations of the bytes
named by their hashes.* Concretely: project the current snapshot in
`encodeChatRowPayload()` and the **current side only** of
`prepareChatRowCheckpoint()`. Never project `previousChat`, never project
GET-acknowledgement bookkeeping, and never modify the shared
`snapshotPayload()` helper (`nodeStorage.ts:1612` uses it for base
bookkeeping too). Why this is load-bearing: if an old row's base object is
projected while still paired with its old-bytes hash `H-old`, the delta diff
degenerates to message-only ops, the worker's replay proof passes against
the wrong base, and the server ACCEPTS the delta — `prepareChatDeltaAppend`
validates `baseHash` and publishes the client-declared result hash without
materializing it (`server/node/chatRows.cjs:765`, `:805`); the corruption
surfaces only on the next materializing read as
`CHAT_DELTA_LOG_CORRUPT: Chat operation materialization digest mismatch`
(replay at `chatRows.cjs:566`). The reviewer reproduced this end-to-end
against an in-memory `createChatRowStore`. This failure is strictly worse
than today's behavior and is the single biggest implementation risk.

Projection semantics: **delete the keys**, never write `false`.
(Correction from review: hydration at `chatStorage.ts:230-234` writes
`false`/`undefined` rather than deleting — the projection intentionally
differs from the live hydrated shape. `normalizeJSON()` drops
undefined-valued properties but retains `false`
(`legacyRisuSaveCodec.ts:55`), and no decoder requires the keys; absence is
equivalent to false for every located runtime reader.)

**What is deliberately not covered:** rows written by import/restore/package
paths may still carry old runtime fields inside previously-encoded bytes.
They self-heal exactly like pre-upgrade rows (§4); chasing every writer
would spread the projection thin for no additional delta win.

## 4. Transition analysis — why no migration and no lockstep (Phase 1)

The acknowledged-base protocol makes old rows self-healing:

1. Pre-upgrade row (contains `isStreaming`) is GET-hydrated; the base map
   stores the server's exact decoded row (`nodeStorage.ts:1599-1641`).
2. First post-upgrade save: projected current vs unprojected base → the diff
   contains a non-message `remove` op → delta path declines → **full-row
   write with projected bytes** — precisely today's behavior, so the
   transition is never worse than the status quo.
3. The POST hash-ack replaces the base with the projected snapshot
   (`nodeStorage.ts:6279-6285`); every subsequent save differs only in
   `/message/...` paths → deltas engage.

Consumers of row-byte identity, from the audit's trap-4 list, re-verified:

- **Hash acks**: computed over whatever bytes the client sends by the shared
  algorithm; a projected row is just a new row version. Mismatch handling
  (`CHAT_ACK_HASH_MISMATCH`, base forget) is unchanged.
- **Server delta replay/compaction**: replays message ops over its canonical
  base and re-encodes (`chatRows.cjs:566-641`, `:874-909`). A projected base
  yields projected results; the server never introduces the fields. Old
  bases reject new-format deltas via the base-hash check → the client's
  existing full-row fallback covers it (`nodeStorage.ts:6253-6277`).
- **Resource cache**: chat bytes cache under `chat:<chaId>/<chatId>` keyed
  by content hash with a bounded hash history; a new hash is simply a new
  version, and 204-vs-bytes negotiation handles it with zero correctness
  impact.
- **Pre-images / chat version backups**: capture the exact prior row before
  overwrite — old captures stay old bytes; future captures capture projected
  bytes. Framed restore verifies against the recorded hash of what was
  captured, not a recomputed encoding.
- **Backups/snapshots/exports**: nothing compares a row's bytes against a
  re-encoding of stored metadata. (Review correction: self-contained exports
  do decode and re-encode chats, `server/node/server.cjs:7450` — harmless
  for absent optional fields since re-encoding preserves absence.) `.bin`
  interchange stubs chats out entirely (stub projection,
  `risuSave.ts:259-275`), so the stubs-DB hash domain is untouched.
  `chat_row_metadata` repair recomputes the actual byte hash and discards
  mismatched derivatives (`chatRows.cjs:948`).
- **Stub/patch allowlists**: `STUB_METADATA_FIELDS` and the server patch
  guard govern stubs in `database.bin`, not full rows
  (`risuSave.ts:1989-2057`, `server.cjs:2388-2457`). The projection does not
  reclassify any field, so both allowlists stay untouched.

Old client / new server: the server never validates the absence of runtime
fields. (Review correction: binary full-row POSTs ARE decoded for structural
inspection, cold-storage classification, and `_stub` handling —
`server.cjs:18581`, spool path `:16045` — but canonical non-hybrid bytes are
stored unchanged, `:18624`; ingest/restore re-encode paths preserve absence
and introduce no defaults, `:15871`, `:16583`.) A straggler old client keeps
writing old-format rows — its deltas stay broken until it reloads, which the
existing 426 writer gate forces on the next deploy
(`bufferedIngress.cjs:364-423`; `POST /api/chat-content` is in the enforced
writer set, `:175-183`). New client / old server: the projection is
byte-compatible with everything an old server accepts. Deliberate
consequence: **no server-side enforcement** — the absence contract is owned
by the client, and the server's existing exact-materialization checks
already detect any inconsistency a buggy writer could introduce.

## 5. Contract check (STRUCTURE.md cross-cutting contracts)

- *Placeholder/stub guards*: untouched — the projection runs on a
  wire-bound snapshot, never on the live `DBState` graph; `_stub`/
  `_placeholder` hydration semantics unchanged (and `_placeholder` must be
  stripped from wire bytes anyway).
- *Patch normalization/hashing lockstep*: `normalizeJSON()`/`calculateHash()`
  are not modified; the projection changes the input document, not the
  algorithm.
- *`requestImmediateSave()` outcome*: untouched; delta-vs-full selection
  already happens beneath the outcome protocol.
- *Never-replay*: unchanged — delta refusal outcomes remain definitive
  not-committed, and the full-row fallback reuses already-produced bytes,
  not a replayed unknown-outcome request.
- *Build handshake*: relied on as-is (writer gate on the chat POST), no
  change required.

## 6. Phase 1 ceiling and the Phase 2 follow-on

Durable per-exchange churn still defeats message-only deltas after Phase 1:

- `scriptstate` — any trigger/Lua/chatVar write during generation
  (`triggers.ts:1186-1206`, `chatVar.svelte.ts:27-32`);
- `hypaV3Data` / `supaMemory` — written during sends on memory-enabled chats
  (`process/index.svelte.ts:1044-1055`);
- `suggestMessages` — written when the suggestion feature runs.

Verified non-issue: `lastDate` is not written on ordinary sends (only on
restore, `chatStorage.ts:172`), so the default no-trigger, no-memory send
becomes fully delta-eligible under Phase 1.

Phase 2, if measurement justifies it: bump the delta envelope version
(`chatDelta.ts:4-20` / `server/node/chatDelta.cjs:5-15`), admit a declared
non-message path set (candidates above) as whole-field `replace`/`add` ops
on both sides, keep the exact replay/hash verification unchanged. This IS a
paired protocol change: ship client+server together behind the build stamp;
old rows again self-heal via base-hash refusal → full-row fallback. Bound
the admitted set explicitly — an open set would recreate PF-01's problem in
reverse (arbitrary large fields riding every delta).

## 7. PF-02 (checkpoint + final double write)

Deferred, per the runway's own ordering: after Phase 1 both writes become
~KB deltas, so the double write costs little. Coalescing would touch the
checkpoint durability contract (20 s checkpoint interval,
`chatPersistStage.ts:15-17`, `:260-297`; completion re-arm,
`globalApi.svelte.ts:600-609`) for marginal savings. Re-measure after
Phase 1; only revisit if the E2E send scenarios still show meaningful waste.

## 8. Regression proof and measurement plan

- Flip the PF-01 assertions in `test/e2e/scenarios/verification.spec.ts:57-65`
  as their comments prescribe: post-generation saves must use
  `application/vnd.pocketrisu.chat-delta+json`, and encoded bodies must not
  contain the `isStreaming` key.
- Tighten `send-and-save` and `send-generate-save` in
  `test/e2e/helpers/budgets.ts:33-37` from 1,100,000 tx bytes to ≤ 64,000
  (runway target; set the final ceiling from measured post-fix traffic).
  Remember trap 5: the double write is timing-dependent — measure several
  runs.
- New unit tests: projection strips exactly the three fields and deletes
  keys (no `false` writes); delta engages across a
  checkpoint→final sequence with an old-format (runtime-field-bearing)
  acknowledged base healing to delta on the second save; replay proof still
  byte-exact.
- **Mandatory integration test for the §3 invariant** (review requirement):
  seed a server with an old-format row containing `isStreaming`; first
  post-upgrade save must be a full row, second save a delta, and a
  subsequent materializing GET must succeed — proving no
  `CHAT_DELTA_LOG_CORRUPT` and that acknowledged bases were never
  projected. Additionally assert the acknowledged-base map never contains a
  projected object paired with an unprojected-bytes hash.
- E2E fixtures have no triggers/memory, so the flipped spec proves the
  Phase 1 default-path win; a Phase 2 decision needs a fixture with
  scriptstate or HypaV3 churn (add to T8 backlog if pursued).
