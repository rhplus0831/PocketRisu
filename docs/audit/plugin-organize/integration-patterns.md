# Integration patterns unsafe under the beta

Plugin-side coding patterns, observed across the three audited workloads, that
are harmless while plugin storage is a local in-memory map but become unsafe
once the beta turns each operation into an independent, fallible, durable
server commit. Responsibility is shared: the plugins own their error handling
and protocols, but the host currently offers no primitive (typed read
outcomes, per-key CAS/revisions, atomic batch, non-destructive invalidate)
with which the patterns could be made safe. See [README.md](README.md) for
the full index.

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
- The host should expose stable error classes distinguishing missing from
  transient failure, plus per-key revisions/CAS or an atomic update primitive
  so a fallback-derived value cannot unconditionally replace a newer row.
- Fault-inject one failed GET followed by a healthy SET for configuration,
  credentials, indexes, ledgers, and shard reads; assert the old value
  survives.

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
- A host-side atomic multi-key batch/CAS API (AA3) would let plugins express
  this protocol without exposing compound midpoints.

<a id="ip5"></a>
## IP5 — Uncancelled long-running migrations overwrite newer rows after timeout

**Severity:** Medium

### Evidence

One audited workload runs a startup storage migration that performs an
unguarded GET, transforms (compresses) the value outside its persistence
mutex, and unconditionally SETs the result, wrapped in a 30-second
`Promise.race()` watchdog. The timeout does not abort the migration: the
losing promise continues iterating and mutating rows after the callback has
logged the timeout and returned. PocketRisu provides no per-key ETag/CAS for
ordinary `pluginsave/` writes — the server applies them with unconditional
`kvSet()` (`server/node/server.cjs:4350-4356`) — so a concurrent normal write
that commits between the migration's GET and SET is silently overwritten with
the stale transformed copy.

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
