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
