# Backup, snapshot, and recovery

Enabled-mode gaps in recovery freshness, snapshot ownership, restore
semantics, and backup portability. All depend on external `pluginsave/` rows
or folded-snapshot markers, which exist only when the beta is (or was)
enabled. See [README.md](README.md) for the full index.

<a id="br1"></a>
## BR1 — Optimized-only mutations never advance automatic recovery snapshots

**Severity:** Medium

### Evidence

Successful direct `pluginsave/` writes and deletes use the generic
`/api/write` / `/api/remove` paths, and only a `database/database.bin` write
calls `createBackupAndRotate()` in that route
(`server/node/server.cjs:4350-4364`, `:4525-4531`). Snapshot creation itself
correctly folds external plugin rows (`server/node/server.cjs:363-384`); the
gap is the trigger, not snapshot contents.

Consequences:

- a long plugin-only sequence (configuration, credentials, usage logs,
  caches, sharded record commits) creates no new recovery point until an
  unrelated database/chat mutation does, so restoring the newest snapshot can
  reset a plugin even though its live row committed long before the failure;
- a plugin that deliberately defers its authoritative state save until after
  the chat response can have the chat snapshot precede the plugin commit,
  leaving the newest recovery point cross-domain inconsistent;
- a nearby chat write can consume the five-minute snapshot cooldown before the
  later plugin rows finish; and
- plugin-side workarounds that request a database dirty mark only under an
  account save method never run, because `getRuntimeInfo()` derives
  `saveMethod` from `forageStorage.isAccount`
  (`src/ts/plugins/apiV3/v3.svelte.ts:1292-1299`) and `AutoStorage.isAccount`
  is `false` (`src/ts/storage/autoStorage.ts:3-5`), so the runtime reports
  `local`.

Current snapshot tests first write `database.bin` to create the snapshot
(`server/node/snapshotPluginStorage.e2e.test.ts:245-251`, `:301-303`); they do
not test plugin-only snapshot cadence.

### Required correction

- Make successful `pluginsave/` value mutations and deletes eligible for a
  coalesced automatic snapshot, scheduled after the logical value/owner
  operation (or batch) completes so a snapshot is not taken between the two
  rows.
- With a short test interval, mutate only a plugin row and assert a new
  snapshot restores it; also cover post-chat plugin commit ordering.

### Resolution

**Fixed 2026-07-27.** Every successful logical plugin-storage mutation and
mode transition now publishes a durable recovery-dirty token inside the same
SQLite transaction as its value rows, owner-metadata rows, manifest, storage
generation, and database change. A snapshot captures the current token before
assembling its folded database and clears only that exact token, atomically
with publishing the snapshot. A newer token therefore survives completion of
an older in-flight snapshot and remains eligible for its own recovery point.

A single coalescing scheduler honors the existing snapshot cooldown while
guaranteeing eventual progress for plugin-only sequences. It enters the shared
storage queue after the logical publication, flushes pending database changes
before snapshotting, waits behind imports and mode transitions, and resumes a
persisted dirty token after process restart. A plugin commit after a chat
snapshot consequently produces a later point containing both commits rather
than being lost to the chat snapshot's cooldown.

Snapshot assembly/publication failures leave the token durable and retryable.
Database flush failures likewise block snapshot acknowledgement until the
pending cache persists; if an integrity guard deliberately invalidates a
malformed cache, that discarded state is not retained as an impossible retry
and the scheduler continues from authoritative live bytes. Pre-generation
legacy rows can still be adopted through the atomic transition endpoint, but
generic write/remove/bulk staging into the canonical plugin namespace is now
rejected so it cannot bypass the logical publication and recovery token.

Regression coverage uses short intervals and deterministic gates/failpoints
for plugin-only set/remove/coalescing, exact value/owner restoration,
post-chat ordering, rollback and one-shot snapshot failure, failed database
flush plus stub-loss cache invalidation, active import and transition barriers,
restart/restore, T1/T2 token replacement during snapshot publication, and a
real concurrent mutation queued behind snapshot assembly. The resulting
snapshots contain only complete generation-consistent publications, never an
intermediate value/owner pair.

<a id="br2"></a>
## BR2 — Cross-mode snapshot ownership is ambiguous

**Severity:** Medium

### Evidence

Snapshot streaming marks folded plugin storage only when
`dbObj.optimizePluginMemory === true`
(`server/node/streamRisuSave.cjs:107-129`). During a successful
optimized-to-inline transition, the client saves the now-false inline database
before deleting external rows; a snapshot in that window folds those rows
without the marker. Restoring it over newer external rows does not clear the
newer prefix, so boot internalization can overlay newer state onto the
requested older snapshot. Documented in
[`../v3/warning/disabled-mode-snapshots-retain-newer-external-plugin-rows-on-restore.md`](../v3/warning/disabled-mode-snapshots-retain-newer-external-plugin-rows-on-restore.md).

More generally, the inline and external copies carry no migration generation
or ownership epoch. Enabling returns `direction: "none"` when the inline maps
are empty without checking whether external rows are expected or stale
(`src/ts/plugins/pluginSaveStorage.ts:206-212`); disabling and boot
internalization give every listed external row unconditional precedence
(`:263-301`). After an interrupted transition, restore, or manual database
change, a leftover row can resurrect an older value — the mode boolean alone
cannot prove which copy belongs to the selected database generation.

### Required correction

- Mark a snapshot whenever it owns an exact folded plugin-row set,
  independently of the current mode flag.
- Persist a storage generation/manifest and use it to reject or quarantine
  rows belonging to a different database generation.
- Test the just-disabled restore window.

### Resolution

**Fixed 2026-07-27.** Optimized mutations and mode transitions now use queued
SQLite mutation/transition endpoints with compare-and-swap source checks. A
successful transaction publishes the database, exact plugin-row manifest,
value rows, owner-metadata rows, and their new storage generation atomically;
any validation, write, or injected failpoint failure rolls the whole
publication back. The client updates its live mode and generation only after
that durable acknowledgement and restores its prior state when publication
fails.

Optimized reads are bound to the generation pinned to the authenticated
session. An explicit generation header cannot override that pin, and stale or
unowned rows are excluded rather than being combined with the selected
database. The generic write, remove, bulk-write, and patch routes reserve the
database publication fields, manifest, and canonical value/metadata row
namespace once storage ownership exists, including root patches plus `move`
and `copy` operations whose `from` path is protected. This prevents a second
write path from bypassing the atomic publication boundary.

Bootstrap reconciliation and the just-disabled snapshot window now preserve
exact ownership: folded snapshots and external-to-inline transitions retain
the manifest/generation relationship even when the mode flag is false. Backup
export and the plugin-storage viewer enumerate only the manifest-owned rows
for the selected generation, so leftovers from another generation cannot be
published or displayed as current state.

Regression coverage exercises optimized mutation and both transition
directions, source-CAS conflicts, rollback at database/manifest/row
failpoints, session-pinned and generation-bound reads, bootstrap and
just-disabled ownership, export/viewer filtering, generic route and JSON Patch
attacks, exact bytes after flush, and process restart recovery. BR3's separate
corrupt-database fallback boundary is fixed below.

<a id="br3"></a>
## BR3 — Corrupt-database boot fallback ignores a marked snapshot's exact row set

**Severity:** Medium

### Evidence

Automatic snapshots fold the complete external plugin set and set
`pluginStorageFolded: true`; the marker means a restore owns the exact set —
rows not present in the snapshot must be cleared. The official Settings
restore and archive-import paths honor that contract. The corrupt-live-database
boot fallback does not:

1. bootstrap decodes a `database/dbbackup-*` value and installs it with
   `setDatabase()` (`src/ts/bootstrap.ts:158-176`);
2. boot reconciliation writes the folded values to external rows, deletes them
   from the client map, and full-writes the database (`:178-183`, `:45-63`)
   without consuming the folded marker
   (`src/ts/plugins/pluginSaveStorage.ts:206-260`);
3. the server correctly derives `clearExisting: true` from the marker
   (`server/node/server.cjs:2379-2439`); but
4. the generic full-write transaction writes the prepared rows and database
   without ever consulting `pluginExternalization.clearExisting`
   (`:4325-4344`).

Snapshot-listed keys overwrite matching live rows, but keys created after the
snapshot survive. If the folded snapshot contains an empty plugin set, the
client reconciler returns `direction: "none"` before any exact-set action, so
all current external rows survive. The result is a partial union, not the
selected recovery point: newer rows persist after the database has fallen back
to an older snapshot, plugins that enumerate keys can treat them as live, and
every subsequent backup/migration carries them forward.

This is distinct from BR2: here the snapshot has a valid exact-set marker, but
the boot-fallback/full-write path drops its semantics.

### Required correction

- Route corrupt-database fallback through the same atomic restore/ingest
  boundary as explicit snapshot restore, including exact prefix replacement.
- Do not fix this by blindly adding `kvDelPrefix()` to the current full write:
  boot reconciliation has already moved snapshot values out of the incoming
  inline map, so clearing at that point would also erase the restored values.
- Restore a marked non-empty and a marked-empty snapshot over newer external
  keys through the boot fallback, then require exact prefix equality.

### Resolution

**Fixed 2026-07-27.** Bootstrap no longer installs an internal snapshot in
browser memory and later persists it through the generic full-write path. A
decode-free authenticated boot read returns the authoritative monolith behind
the import barrier. If the client cannot decode it, an import-safe queued
`/api/db/snapshots` read returns only strict newest-first key/size/timestamp
metadata. Bootstrap submits those keys directly to the same server-side
snapshot restore/ingest boundary used by an explicit Settings restore; it does
not call the generic key list, trim snapshots, fetch a candidate through
`/api/read`, or decode a folded candidate in browser memory. The server is the
candidate validation boundary. The browser installs only one committed stripped
database read back from the server, never the folded ingest-only snapshot object.

Snapshot list, restore, and delete share one canonical key parser: only
`database/dbbackup-<canonical-digits>.bin` with no leading zeros except `0` is
visible or actionable, and both the suffix and suffix × 100 timestamp must be
nonnegative safe integers. The client repeats that validation, requires an exact
newest-first list schema, and retains an unreadable candidate as `size: null` so
the restore boundary can classify it and continue to an older key. It accepts a
restore acknowledgement only for HTTP 200 with exactly the four expected fields
and values, including the echoed snapshot key. Extra fields, another 2xx status,
truncation, or response loss remain `COMMIT_OUTCOME_UNKNOWN`.

Corrupt boot is nonmutating until a recovery point is selected. Before the
list epoch or any asset, inlay, chat, or REMOTE migration can publish a marker,
safety backup, row, or rewritten database, the server performs a read-only
decode plus strict plugin-JSON and database-shape validation. The shared shape
validator covers the root and every array traversed by chat migration while
retaining the legacy fresh-install `{}` envelope and tolerated null
placeholders. Raw corruption and structurally invalid but decodable databases
therefore start authenticated recovery APIs without changing any KV value or
timestamp; repeated failed boots do not leak migration markers or backups, and
a repaired database runs the deferred migrations normally.

PM2 private transition receipts follow the same preflight boundary.
Recovery-mode startup leaves every receipt byte and timestamp untouched; only a healthy
boot sweeps stale stages and reconciles a receipt against the authoritative
database. This preserves a staged source while the live monolith is corrupt,
then performs the deferred cleanup once that source is repaired.

Marked restore is one exclusive SQLite transaction covering the live
database, chats, migration markers, exact plugin value/owner publication,
manifest, and list epoch. Before destructive replacement, the current
manifest must be canonical, duplicate-free, and complete. The streaming loader
defers that proof until it observes the folded marker, before it emits a target
row: each manifest-owned current body is loaded and validated in a narrow scope,
then released before an abort check and event-loop yield. No current bodies are
read for an unmarked stream, and deletion begins only after all declared rows
prove valid. A missing row, duplicate entry,
malformed owned row, invalid selected snapshot, or injected pre-commit failure
rolls the whole transaction back without publishing even a new epoch. A valid
marked non-empty or marked-empty snapshot removes only the prior
manifest-owned rows, writes its exact selected set and generation, and leaves
foreign/unowned physical rows preserved but quarantined. Unmarked snapshots
remain non-destructive because they cannot prove ownership.
PM1 per-row and aggregate limits remain authoritative inside the restore
transaction: an over-limit selected set rolls back and returns the definitive
non-committed 413 envelope rather than a generic retryable restore failure.

The selected snapshot bytes are also protected before that transaction begins.
Restore pages raw rows and chunk bodies asynchronously in at most 64 KiB parts,
with no SQLite iterator held across an event-loop yield. Versioned manifest
metadata and a durable per-key publication guard verify dense order, row and
chunk presence, count, and logical length. Body-producing live/pinned reads and
restore spooling additionally verify canonical hashes and logical SHA-256;
sizing/copying enforce the guard and structural length without hashing every
same-size body. Deleting both
manifest tables therefore remains a known corrupt publication rather than
silently restoring the 13-byte chunk marker. Legacy migration verifies each key
independently: a corrupt marker-backed key becomes durably protected-corrupt
without preventing valid siblings or the global migration version from
publishing. A real 52 MiB socket abort is observed during the spool, before
`BEGIN`, cleans the partial file, and leaves the exact database, manifest, and
owned rows durable after restart. Separate corrupt-chunk and repeated keep-alive
tests prove definitive non-commit and listener cleanup.

The same atomic boundary owns compressed and legacy preparation. Snapshot
bytes are file-cursor inspected before publication; gzip/zlib output is
backpressured, AbortSignal-aware, disk-spooled, and capped by decoded bytes and
disk headroom when capacity is available, while cursor-unsupported compatibility
formats use a separately capped full-memory path. Structural corruption is a
known-not-committed 400 and capacity exhaustion is a known-not-committed 413. The block compatibility path
publishes the decoded selected snapshot directly and explicitly suppresses the
ordinary live-monolith REMOTE migration, preventing the current database from
being substituted for the requested recovery point.

Referenced REMOTE content is also part of the selected snapshot's validity.
Restore checks logical row size before materialization, meters and caches the
entire recursive graph, and rejects cycles, excessive depth, missing rows, rows
that disappear between size and read, unsupported target types, and malformed
JSON in both inline and resolved known block types. Resolver size/body/decode
exceptions are never merely logged and omitted: they escape to the restore
transaction and roll back. Duplicate references are read and charged once but
may still materialize the decoded target more than once.
Save-folder adoption follows the same resolver-present rule; a missing payload
rejects the import and preserves the prior database bytes, REMOTE rows, marker,
and normalized export across restart.

ETag and authenticated-session generation state are published only after
COMMIT. The success envelope is strict and explicit. Invalid keys, candidates
deleted after listing, invalid folded-plugin candidates, and other route-known
precommit failures carry explicit not-committed envelopes; the middleware `423`
remains a pre-route header-classified rejection. A lost response after
COMMIT remains `COMMIT_OUTCOME_UNKNOWN`. Bootstrap stops immediately on that
outcome, or on any post-commit read failure, instead of replaying an older
candidate over a possibly committed restore. It tries an older candidate only
after a `StorageError` that explicitly carries `commitOutcome: not-committed`;
plain errors and storage failures without that proof stop conservatively.
Regression coverage includes
marked non-empty and empty exact sets, long keys, extra/foreign/malformed rows,
generation and manifest mismatches, missing and duplicate manifest ownership,
legacy and streaming ingest, raw and structural corrupt boots, fresh install,
active imports, PM2 private-stage preservation/source invalidation, PM1 quota
rollback, pre-commit rollback, response loss after COMMIT, restart durability,
and no-older-candidate replay. A real NodeStorage/corrupt-server case uses a
newer invalid and older valid 64 MiB chunked snapshot pair, records and rejects
any candidate `/api/read`, then proves exact chat bytes, restart durability, and
restore-spool cleanup. Import-barrier races prove metadata listing cannot expose
a tentative replacement.
The bounded proof regression uses eight 7 MiB current rows and records one
active body with forced-GC retained heap below two rows. Further composition
coverage proves a same-key target cannot mask a malformed final current row,
cancellation stops before deletion, PM2 private stages remain invisible and
source-invalidated, and PM4 rejects the pre-restore manifest token before a
fresh-token mutation commits. Further recovery coverage includes manifest and
metadata deletion with the durable publication guard retained, legacy
manifest-protection migration, raw-marker compatibility, a real mid-spool
disconnect, listener cleanup, an unreadable
newest legacy chunk publication with valid older fallback, newer
compressed-limit fallback to an older valid block snapshot, malformed inline
and resolved character blocks, exact requested-target publication over a
distinct live REMOTE database, recursive REMOTE failures, and restore-spool
cleanup. Composition verification found and repaired the cross-layer cases, then
reran independent recovery verification.

The explicit Settings action and boot fallback now enter that boundary through
one shared `AutoStorage`/`NodeStorage` restore API. Both sides require the exact
internal-snapshot key grammar. Each restore attempt sends one session-fenced
POST under a finite ten-minute `AbortSignal` bound, never retries that POST, and
accepts only an exact committed response whose key echoes the requested
snapshot. Auth retry is disabled for this destructive request. A schema-invalid `2xx`, truncated body,
transport loss, or timeout after dispatch is therefore commit-unknown and is
never automatically retried. A committed result reloads into the new
publication; a definitive non-commit leaves Settings in place; an unknown result
warns and hard-reloads to reconcile. Boot tries an older key only after explicit
non-commit and stops its candidate loop on unknown.

The active-writer middleware's `423` is different: it rejects before the
restore route can execute, so `NodeStorage` classifies it as definitively
not-committed from the headers and disposes of the optional body best-effort.
Even a never-ending body followed by external abort or the full restore timeout
does not change that result or trigger a UI reload. Production-path tests pair
this client/UI policy with real-server displaced sessions, exact response echo,
post-COMMIT response loss, and PM2 staged-transition source invalidation, plus
committed-path PM4 database-cache invalidation assertions.

<a id="br4"></a>
## BR4 — Valid long keys produce Node backups the same server refuses to import

**Severity:** Medium

### Evidence

Runtime plugin keys only need to be well-formed Unicode: the client base64url
encoder has no length limit (`src/ts/storage/persistentKv.ts:16-27`,
`:80-82`), and generic `/api/write` stores the resulting key without applying
an archive name limit (`server/node/server.cjs:4214-4226`, `:4354-4356`).

Node-target portable and server backups emit each external value and owner row
under its full storage key (`server/node/server.cjs:2580-2589`, `:4771-4824`,
`:5038-5091`), and the archive writer supports a 32-bit name length
(`:2176-2186`). The same server's importer rejects any entry name longer than
1,024 bytes (`:1034-1036`, `:2859-2862`;
`resolveBackupStorageKey()` repeats the limit at `:2592-2595`), and export
does not preflight it.

For an ASCII raw plugin key, `pluginsave/<base64url>.json` exceeds 1,024 bytes
at a 757-byte raw key, and `pluginsave-meta/<base64url>.json` at 753 bytes.
V3 `setItem()` normally creates both rows, so a valid 753-byte key can be
stored and exported successfully while making the resulting Node backup
impossible to import — and one such row blocks restoration of the entire
archive. Generated identifiers are normally short, but plugins that embed
imported/user-supplied identifiers in storage keys make the boundary
reachable.

### Required correction

- Make runtime acceptance and archive import/export limits symmetric: either
  reject a raw key before its value write using the longest encoded prefix, or
  safely raise/remove the archive parser's limit.
- Export must fail before publishing an archive it cannot restore.
- Cover raw-key boundaries 752/753 and 756/757 for value and metadata rows,
  then round-trip a backup containing a long imported identifier.

### Resolution

**Fixed 2026-07-26.** Browser and Node code now consume one shared archive
policy: a 1,024-byte UTF-8 entry-name limit with canonical value and owner
prefixes/suffixes. Raw ASCII value keys accept 756 bytes and reject 757; owner
metadata keys accept 752 and reject 753. Non-ASCII limits are calculated from
the encoded UTF-8 path rather than JavaScript character count, while AC3's
well-formed-Unicode validation remains the first boundary.

Owned V3 writes precompute and validate both destinations before the value row
can mutate, making the stricter owner path the effective limit. Direct server
writes reject oversized plugin paths without creating a row, while compatible
short generic/noncanonical KV keys remain supported. Import parsing uses the
same limit. Download and server-side export build and validate the complete
entry plan before sending attachment headers, NDJSON data, or publishing a
temporary/final archive, so legacy oversized rows cannot produce a backup the
server refuses to restore.

Regression coverage exercises 752/753 and 756/757 boundaries, non-ASCII byte
accounting, zero-write rejection, no-publication export failures, legacy short
keys, and a maximum-length value+owner Node backup round trip. Independent
verification passed 58 focused client tests, 7 focused server tests, 10 focused
compatibility tests, all full client/server/compatibility suites, `pnpm check`,
and a production build.
