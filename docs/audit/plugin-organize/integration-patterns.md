# Integration patterns unsafe under the beta

Plugin-side coding patterns, observed across the three audited workloads, that
are harmless while plugin storage is a local in-memory map but become unsafe
once the beta turns each operation into an independent, fallible, durable
server commit. Responsibility is shared: the plugins own their error handling
and protocols. At the audit point the host offered no versioned read or atomic
write primitive. AA3 is now fixed: bounded `getWithRevision()` and
`atomicBatch()` provide per-key revisions/CAS and atomic generation publish.
That enables safe guidance for the patterns below, but does not repair plugin
fallbacks, loaders, or cancellation by itself. IP1–IP5 are now fixed on the
host side with explicit read outcomes, guarded CAS writes, structured mutation
outcomes, a non-destructive rewrite helper, an immutable-generation helper,
a mutex-bound `updateItem()` primitive, and adoption guidance. Existing
third-party plugins still have to adopt those protocols. See
[README.md](README.md) for the full index.

<a id="ip1"></a>
## IP1 — A failed read treated as a missing key becomes a destructive overwrite

**Severity:** High

### Evidence

With the beta off, `getPluginSaveStorageItem()` reads the already-resident map
and JSON-clones it; with it on, the same call performs cached
persistent/server I/O that can reject on transport, session, import-barrier,
cache-negotiation, and JSON-parse failures
(`src/ts/plugins/pluginSaveStorage.ts:71-84`,
`src/ts/storage/persistentKv.ts:41-52`,
`src/ts/storage/nodeStorage.ts:372-415`). The API correctly rejects; the
hazard is that all three audited workloads collapse every rejection into the
same fallback used for a genuinely missing key (caught exception → `null`,
`{}`, empty set/array, or a caller-provided default), and then perform
unconditional whole-value writes. Non-database `/api/write` requests have no
ETag or compare-and-swap check — `x-if-match` applies only to
`database/database.bin` (`server/node/server.cjs:4241-4251`); everything else
is an unconditional `kvSet()` (`:4350-4356`).

Confirmed destructive read/modify/write shapes:

- a failed configuration read is treated as an old/empty schema, and the
  migration output — nearly empty — is immediately written over the real
  configuration;
- a failed sensitive-credential read defeats a blank-overwrite guard, letting
  an empty value replace a real API credential;
- a failed collection/visibility/ledger read initializes an empty cache whose
  next scheduled flush replaces the entire history with only current entries;
- a failed shard/bucket read is treated as an absent shard; the partial record
  is hydrated, and a later persist writes the reduced set as authoritative;
  and
- a failed record read is treated as "snapshot missing", and an
  auto-approved `clearOnMissingSnapshot` flow empties the live store.

### Required correction

- Plugins must propagate an explicit `missing | value | failed` result; a
  failed prerequisite read must retry or abort the compound update, never
  return an empty repository.
- Plugins should use the host's versioned read plus atomic-batch CAS so a
  fallback-derived value cannot unconditionally replace a newer row; stable
  read-error guidance must still distinguish missing from transient failure.
- Fault-inject one failed GET followed by a healthy SET for configuration,
  credentials, indexes, ledgers, and shard reads; assert the old value
  survives.

### Resolution

**Fixed 2026-07-27 within the host and integration-guidance boundary.** V3 now
exposes `pluginStorage.readItem()` as an explicit `missing | value | failed`
result. The failed branch preserves the stable bridge-safe `name`, `message`,
HTTP `status`, `code`, `retryAfter`, `retryable`, `commitOutcomeUnknown`, and
`operation` fields. A stored JSON `null` is a `value`; only authoritative
absence is `missing`.

`setFromRead()` accepts that read result and publishes through AA3 CAS. A
failed prerequisite read is a guaranteed no-op, a missing read uses
`expectedRevision: null`, and a stale value/mistaken-missing snapshot returns
an explicit conflict without changing the row. Guest-local `updateItem()`
performs the read/transform/guarded-set pattern and never invokes its transform
after a failed read. Guarded writes retain the existing abort, lifecycle-drain,
structured failure, atomic owner, and mode-transition behavior.

[Public integration guidance](../../en/plugin-storage.md) documents safe
configuration, credential, index, ledger, and shard migration patterns,
including conflict retry and committed-unknown reconciliation. Client and real
iframe-bridge fault tests prove those five fallback transforms do not run or
publish after a failed GET. A real Node server failpoint then attempts the
same fallback values with absence CAS and verifies a 409
`PLUGIN_STORAGE_REVISION_CONFLICT` response plus byte-for-byte preservation of
the old rows. Client and server coverage also distinguish stored JSON `null`
from a missing key.

The compatibility boundary is explicit: the host cannot infer that a legacy
unconditional `setItem()` was derived from a swallowed read error. Existing
third-party plugins must migrate compound update paths to `readItem()` plus
`setFromRead()`/`updateItem()` (or explicit AA3 revision-bound batches).

<a id="ip2"></a>
## IP2 — Remove-then-rewrite maintenance flows durably delete rows

**Severity:** High

### Evidence

One audited workload advertises an "old data forced replacement" cleanup as a
same-value, zero-deletion safe action, implemented as GET → REMOVE → SET per
enumerated key. Under the beta, REMOVE and SET are independent durable
requests: closing the page, losing the session, hitting the import barrier, or
a disk/network failure after REMOVE succeeds but before SET succeeds leaves
the only copy of the row deleted. Inline mode performs both map mutations
before the 500 ms database persistence debounce, so the intermediate deletion
is never durable there.

The failure is also reported as success: the raw storage wrappers catch all
host errors and resolve normally, so removal/rewrite counters increment and
the outer error path never runs. The same suppression makes single-key pruning
and several cleanup/delete counters report success after a failed mutation.

### Required correction

- Rewrite with a single SET; if cache invalidation is required, the host needs
  an explicit non-destructive invalidate/rewrite primitive.
- Raw storage wrappers must propagate failure, and maintenance counters must
  be based on confirmed outcomes.
- Fault-inject termination and SET failure immediately after every successful
  REMOVE; the original row must survive or the action must report an exact,
  repairable failure.

### Resolution (fixed)

V3 now exposes `pluginStorage.rewriteItem(key, value, expectedRevision?,
unloadSignal?)`. The public method snapshots and validates its arguments in the
guest before dispatch, then routes through
`rewriteOwnedPluginSaveStorageItem()` as exactly one AA3 `atomicBatch()` SET.
It never publishes a REMOVE. Supplying the revision returned by
`getWithRevision()` makes a stale maintenance copy return the structured
`committed: false` conflict result instead of overwriting a newer row. Abort,
unload, timeout, rollback, and acknowledgement-unknown paths retain the
structured storage outcome rather than resolving as success.

Cache publication follows the same exact commit boundary: a trusted committed
SET refreshes the verified value cache directly, while a conflict, known
rollback, malformed/lost acknowledgement, or pre-dispatch abort neither seeds
nor invalidates it. There is therefore no disposable-cache gap that requires a
durable delete. The V3 migration guide demonstrates the versioned rewrite
protocol, propagates errors, and increments its maintenance counter only for
`committed: true`.

Focused unit and sandbox tests cover public API exposure, detached argument
transport, stale CAS, cancellation, confirmed-only counting, and cache
publication. The real-server failpoint matrix in
`test/compat/plugin-storage-batch-atomicity.test.ts` stops the rewrite before
the transaction and after value, owner, operation, manifest, and pre-commit
boundaries. Every known failure retains the exact original value/owner pair;
acknowledgement loss retains the same value and is exactly reconcilable by a
new versioned read.

<a id="ip3"></a>
## IP3 — Swallowed mutation failures desynchronize caches and status reporting

**Severity:** Medium

### Evidence

Optimized `removeItem()` is a one-shot remote request that can be rejected by
network, import, or active-session conditions
(`src/ts/plugins/pluginSaveStorage.ts:99-107`,
`src/ts/storage/nodeStorage.ts:518-531`); inline removes are local map
mutations that effectively cannot fail independently. Audited workloads catch
every `removeItem()` (and some `setItem()`) rejection and resolve normally,
which under the beta produces:

- dirty flags cleared after a swallowed delete failure, so stale authoritative
  data reattaches on the next load;
- reset/cleanup UIs reporting success after only swallowed removals; and
- plugin-local caches diverging from durable server state — the server holds a
  new value while the cache holds the old one, or the row is deleted while the
  cache retains a ghost.

### Required correction

- Plugins should queue removes with same-key writes, propagate failure, retry
  idempotently, and verify absence before clearing dirty state or reporting
  success.
- The host should return structured outcomes (see AA1) so "swallow
  everything" stops being the only ergonomic option.

### Resolution

**Fixed 2026-07-27.** V3 save storage now exposes
`setItemWithOutcome()`, `removeItemWithOutcome()`, and
`removeItemConfirmed()` alongside the original rejecting `setItem()` and
`removeItem()` methods. The outcome APIs preserve `committed`,
`not-committed`, and `unknown` across the iframe bridge, including local RPC
timeouts. Definitive import/session refusals retain their structured status,
code, retry delay, and retryability; network loss, acknowledgement loss,
malformed or contradictory failures, and unclassified bridge errors remain
conservatively unknown. The new workflows add no retry of their own, and an
unknown mutation is never made retryable or replayed.

`removeItemConfirmed()` sends exactly one REMOVE. A definitive refusal returns
immediately. After a committed or unknown request outcome it performs a fresh,
generation-bound versioned read against the authoritative state endpoint and
reports success only when that read observes the key missing. A present row —
including stale data that reattaches after deletion — or an unavailable read
returns unknown, with present-row revision/generation metadata but not the
value. The result also retains the original mutation outcome, so callers can
distinguish an acknowledged delete from absence confirmed after a lost
acknowledgement.

The public types and [safe mutation workflow guide](../../plugin-storage-mutation-outcomes.md)
show plugin authors how to publish cache entries only after confirmed SET,
retain dirty edits after known refusal, evict and re-read after an unknown
outcome, clear deletion dirtiness only after authoritative absence, and derive
reset/cleanup counters from confirmed results rather than attempted promises.
For multi-key logical records, the guide directs authors to AA3
`getWithRevision()` plus `atomicBatch()` instead of treating an individually
confirmed loop as atomic.

Adversarial tests carry network, import, expired-session, and lost-
acknowledgement SET/REMOVE failures through the generated V3 guest bridge and
assert one mutation attempt. Cache tests cover retention after known refusal
and eviction/reload after unknown outcomes. Workflow tests cover committed
absence after acknowledgement loss, failed confirmation reads, authoritative
reattachment, dirty-state retention, and reset counters advancing only for
confirmed absence. Independent verification passed the focused and full
client suites, server and compatibility suites, type checking, production
build, help-key audit, and diff hygiene.

<a id="ip4"></a>
## IP4 — Reused sub-row keys with manifest-last publishing; loaders accept mixed generations

**Severity:** Medium

### Evidence

Two audited workloads shard large records across multiple rows and publish a
parent index/manifest last. In both, the sub-row keys are deterministic from
stable identifiers (chat/field path, or message count) rather than versioned
or content-addressed, so writing a new generation overwrites bodies still
referenced by the old parent. If a body or owner write fails mid-sequence, the
plugin reports the record unsaved while the old parent already resolves to a
subset of new bodies.

Manifest-last also fails to protect the reader: one audited loader checks only
the manifest's bucket count and never recomputes bucket hashes, checks unit
counts, or binds rows to the manifest's generation, so after a restart it
accepts new buckets mixed with old buckets under the old manifest.

Under the beta every row is independently durable, so these compound
midpoints are exposed to automatic snapshots and pinned exports triggered
between the writes (see AA3); in inline mode the writes normally coalesce into
one debounced database save.

### Required correction

- Use immutable generation/version/content-addressed sub-row keys, publish one
  parent manifest last, and garbage-collect old bodies only after publication.
- Loaders must verify every manifest hash/count before hydrating; on mismatch,
  retry or fall back to a complete prior generation, never load a hybrid.
- The host-side atomic multi-key batch/CAS API added by AA3 now lets plugins
  express this protocol without exposing compound midpoints; affected plugins
  still need to migrate to it and validate generations on load.

### Resolution

**Fixed 2026-07-27.** V3 now exposes
`risuai.pluginStorage.generations.publish()`, `load()`, and
`garbageCollect()` as a complete immutable-generation protocol over AA3. A
repository identity cryptographically binds the exact mutable head key and
normalized, nonempty body-key prefix. Publication snapshots descriptor-only
arguments before its first read, creates a UUIDv4 generation, writes bodies
under immutable generation/content-hash keys, writes a hash-bound immutable
manifest, and CAS-publishes a hash-bound head in one atomic batch. Accessors,
sparse or subclassed arrays, class instances, unsupported JSON values, and
caller mutation after invocation cannot change the publication plan.

Publication never promotes an unverified fallback. Before replacing an
existing head it verifies the current manifest and every current body. If
that generation is structurally corrupt, it may retain the head's exact prior
reference only after fully verifying that manifest and all of its bodies. A
transient read failure or invalid lineage rejects publication without changing
the head. Thus, if generation two is corrupt and generation three is later
published, the last complete generation remains generation three's protected
fallback rather than the corrupt generation two.

`load()` validates exact head, repository, reference, manifest, and body
schemas; repository and head hashes; manifest hash and generation; the head's
exact current/previous linkage; entry identities, keys, hashes, and counts;
and the aggregate count before exposing any body. Structural corruption may
fall back once to the exact, fully verified previous generation. Transport,
authentication, import-barrier, cancellation, and lineage failures reject
instead of selecting stale data. A transplanted head, cross-repository
reference, or recomputed head that splices unrelated history is therefore not
eligible for fallback.

Garbage collection walks only verified manifest lineage and atomically
CAS-rewrites the head while removing the selected immutable manifest and
bodies. It refuses the current and immediate previous generations, rejects
foreign or orphan references, and snapshots its options/reference/signal
before I/O. The supplied unload signal is forwarded through every preliminary
versioned read and the final batch; the bridge combines it with request
cancellation, while normal unload admission and draining keep accepted work
tracked through its authoritative outcome.

Deterministic regression coverage interrupts initial and subsequent
publication before and after every body, owner, manifest, and head write, at
commit, and after commit before acknowledgement. Live and restarted snapshots
load only missing, the complete old generation, or the complete new
generation. Additional tests corrupt body generation/hash/count/identity and
manifest hash/count/generation/shape, distinguish transient failures, reject
repository transplants and lineage splices, and exercise real generated-guest
and teardown/unload paths. The fallback-retention regression publishes
generation one, corrupts generation two, publishes generation three, attempts
garbage collection, corrupts generation three, and still recovers the exact
complete generation one.

<a id="ip5"></a>
## IP5 — Uncancelled long-running migrations overwrite newer rows after timeout

**Severity:** Medium

### Evidence

One audited workload runs a startup storage migration that performs an
unguarded GET, transforms (compresses) the value outside its persistence
mutex, and unconditionally SETs the result, wrapped in a 30-second
`Promise.race()` watchdog. The timeout does not abort the migration: the
losing promise continues iterating and mutating rows after the callback has
logged the timeout and returned. Ordinary `setItem()` remains unconditional,
so a plugin that does not adopt AA3's versioned read and batch CAS can still
overwrite a concurrent normal write with the stale transformed copy.

The GET/SET race exists in inline mode too, but with local map mutations the
migration completes almost instantly; optimized per-row network I/O plus owner
writes make both the deadline overrun and the overlap with live persistence
realistic, which is why this is listed as an enabled-mode issue.

### Required correction

- Make plugin-side migrations cancellable and stop all writes after the
  deadline; hold a migration mutex that excludes other writers for the
  complete GET-transform-SET interval.
- Re-read/compare a revision immediately before SET, or use host-provided
  CAS/an atomic transform operation.
- Test a newer write landing during the transform and after watchdog expiry;
  the newer value must survive and no late SET may occur.

### Resolution

**Fixed 2026-07-27.** V3 now exposes typed
`pluginStorage.updateItem(key, transform, options?, unloadSignal?)` as the
one-row migration/read-modify-write primitive. Its default timeout is 10
seconds, callers may select an integer from 1 ms through 15 seconds, and one
total `AbortSignal` covers fair mutex admission, the initial versioned read,
the guest transform, the final versioned read, and the caller's wait for CAS.
The transform receives that same signal. A timeout or cancellation before CAS
submission is known not committed, and an expired transform cannot submit a
late write after it eventually returns.

Each plugin instance has a fair shared-writer/exclusive-migration barrier.
`setItem()`, `removeItem()`, `clear()`, `atomicBatch()`, and the V3 database
replacement APIs enter as writers; `updateItem()` excludes them for its full
read-transform-CAS interval. A queued migration prevents later writers from
overtaking it. If the caller's deadline expires after CAS admission, the
barrier remains held until that non-cancellable publication settles. Writers
in another plugin instance or session are outside the local barrier, so the
coordinator re-reads the opaque revision immediately before publication and
the AA3 atomic batch supplies the final server-side `expectedRevision` check.
A changed revision returns `committed: false` without writing.

The CAS admission boundary is intentionally explicit. Before dispatch,
cancellation is `STORAGE_TIMEOUT`/abort with `commitOutcomeUnknown: false`.
After dispatch, cancelling the transport cannot prove rollback because the
server may already have committed; the caller instead receives the
non-retryable `COMMIT_OUTCOME_UNKNOWN` storage error with
`commitOutcomeUnknown: true`. The CAS itself continues without the caller's
signal, remains tracked, and must be re-read before any deliberate retry.
Official guidance in `src/ts/plugins/migrationGuide.md` documents this rule,
requires pure transforms, and shows both startup and bounded unload updates.
The public contract is mirrored in `src/ts/plugins/apiV3/risuai.d.ts`.

Teardown now aborts active pre-publication updates, runs admitted unload
callbacks, and then drains all outstanding CAS publications before terminating
the iframe. Thus a CAS that committed but whose acknowledgement outlives the
one-second unload grace period cannot escape the only drain. Unload authority
is also invocation-scoped: the captured `onUnload` callback receives the
capability, but the host-created transform signal never does—even when the
same guest function is simultaneously the outer unload callback and the nested
transform. The transform therefore cannot use its internal signal to open a
new storage RPC during termination.

Unit and iframe-bridge coverage in
`src/ts/plugins/apiV3/pluginStorageUpdate.test.ts` and
`src/ts/plugins/apiV3/pluginDatabaseBridge.svelte.test.ts` exercises total
deadlines at the mutex, both reads, transform, and CAS; fair writer exclusion;
a newer write during transform; final-read and final-CAS conflicts; no late
SET; committed-but-lost acknowledgements; teardown cancellation;
post-`onUnload` publication drain; and same-function capability overlap.
Real-server coverage in `server/node/snapshotPluginStorage.e2e.test.ts`
verifies stale CAS preservation and a commit followed by delayed
acknowledgement and caller abort. Independent verification passed all 50
focused coordinator/bridge tests, 1,314 frontend tests (3 skipped), 196 server
tests, 145 compatibility tests (5 skipped), `pnpm check`, and a production
build.
