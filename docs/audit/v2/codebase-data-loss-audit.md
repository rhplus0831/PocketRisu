# Codebase data-loss audit (v2)

- Audit point: `bbe0e024` (branch `serve`, clean tree)
- Prior audit: [v1](../../../.archived-docs/v1/serve-branch-data-loss-audit.md) — 16 findings, all fixed at `2e3d4f05`
- Current status: **36 open findings** — 13 fatal, 23 warning

## Scope and method

v1 audited only the serve-branch diff. v2 widens to the whole codebase's
persistence surface, using the v1 failure patterns (non-atomic multi-store
commits, ack-before-durable windows, unverified derivatives, size-only
equality, crash windows in swaps) as the recurring-pattern lens. Six areas
were swept independently, each by a dedicated agent, and every reported
finding was re-verified against the code before being documented here;
unsubstantiated or duplicate reports were discarded or merged.

1. Server KV persistence core (mutation routes, dbCache, import barrier)
2. Server recovery paths (backups, snapshots, import/export, self-update)
3. Server file stores (assets, inlays, GC, logs)
4. Client save loop and sync protocol
5. Client caches, boot hydration, drafts, recovery UI
6. Application-logic destructive operations (chat flows, scripts/plugins, round-trips)

Severity: **fatal** = plausible under realistic conditions (ordinary actions,
one crash at the wrong moment, a second tab/device) and loses primary data or
renders a recovery copy silently unusable. **warning** = needs rarer timing,
unusual inputs, or multiple failures; or degrades recovery depth; still worth
fixing.

## Fatal findings

| Area | Finding | Class |
|---|---|---|
| recovery | [Small-database imports validate after the destructive commit](fatal/import-validates-small-database-after-destructive-commit.md) | Direct loss |
| scripts | [install.sh can delete the only copy of all user data](fatal/install-script-can-delete-the-only-data-copy.md) | Direct loss |
| recovery | [Every recovery copy omits MCP tool-call payloads](fatal/recovery-copies-omit-mcp-tool-call-payloads.md) | Broken recovery copy |
| sync | [A patch conflict promotes the ETag and authorizes a stale full write](fatal/patch-conflict-etag-promotion-enables-stale-full-write.md) | Direct loss |
| server core | [Acknowledged patches are not durable for up to five seconds](fatal/acknowledged-patches-are-not-durable.md) | Direct loss |
| sync | [A new tab silently steals the writer lease; the displaced tab discards dirty state](fatal/writer-lease-displacement-discards-dirty-state.md) | Direct loss |
| file mgmt | [The inlay orphan scan classifies referenced inlays as deletable](fatal/inlay-orphan-scan-classifies-referenced-inlays-as-deletable.md) | Direct loss |
| file mgmt | [Automatic boot GC deletes plugin-owned assets](fatal/boot-asset-gc-deletes-plugin-owned-assets.md) | Direct loss |
| file stores | [Inlay replacement unlinks the only copy before publishing](fatal/inlay-replacement-unlinks-before-publish.md) | Direct loss |
| drafts | [A draft read failure or quick chat switch deletes the saved draft](fatal/draft-load-race-deletes-saved-drafts.md) | Direct loss |
| chat flows | [Sending can replace another chat's history after an async trigger gap](fatal/send-input-race-replaces-another-chats-history.md) | Direct loss |
| chat flows | [Reroll completion targets the currently selected chat](fatal/reroll-failure-restores-into-the-current-chat.md) | Direct loss |
| chat flows | [Reroll can leave no durable copy of the discarded response](fatal/reroll-discards-the-only-copy-within-preimage-cooldown.md) | Direct loss |

## Warning findings

| Area | Finding |
|---|---|
| deploy | [Docker server backups live in the container's writable layer](warning/docker-server-backups-are-ephemeral.md) |
| scripts | [update.sh deletes custom in-tree backup roots](warning/update-script-wipes-custom-in-tree-backup-roots.md) |
| recovery | [Backups omit composer drafts and imports delete them](warning/backups-omit-drafts-and-imports-delete-them.md) |
| recovery UI | [Chat-version import reports success before persistence](warning/chat-version-import-acknowledges-before-save.md) |
| file mgmt | [Boot asset GC can race a concurrent publication](warning/boot-asset-gc-races-concurrent-publication.md) |
| file stores | [A crash during inlay migration can discard the valid KV source](warning/interrupted-inlay-migration-discards-the-source-row.md) |
| recovery | [Snapshot restores can reference assets the GC already deleted](warning/snapshots-reference-assets-the-gc-can-delete.md) |
| recovery | [Server backups are acknowledged before reaching stable storage](warning/server-backup-published-without-fsync.md) |
| recovery | [Backup size checks accept equal-length torn inlays](warning/backup-size-check-accepts-equal-length-torn-inlays.md) |
| recovery | [Unmigrated KV inlays are omitted from backups and cleared on restore](warning/unmigrated-kv-inlays-are-omitted-from-backups.md) |
| save loop | [The save loop stops retrying after five consecutive failures](warning/save-loop-idles-after-five-failures.md) |
| decoding | [A corrupted save block is skipped and the partial database becomes authoritative](warning/partial-block-decode-becomes-authoritative.md) |
| trust | [Imported card triggers can bulk-delete history without consent](warning/card-triggers-can-bulk-delete-history-without-consent.md) |
| trust | [V3 plugin database setters bypass the `db` permission](warning/v3-plugin-database-setters-bypass-the-db-permission.md) |
| round-trips | [Persona exports drop advanced fields](warning/persona-exports-drop-advanced-fields.md) |
| round-trips | [Module CharX export drops `namespace` and `cjs`](warning/module-charx-export-drops-namespace-and-cjs.md) |
| server core | [/api/remove bypasses the writer lock](warning/remove-route-bypasses-the-writer-lock.md) |
| server core | [A failed deferred persist is never retried](warning/failed-deferred-persist-is-never-retried.md) |
| server core | [Non-canonical hex path headers split the patch cache](warning/noncanonical-hex-path-splits-the-patch-cache.md) |
| server core | [The full-write ETag does not cover chat rows](warning/full-write-etag-does-not-cover-chat-rows.md) |
| file stores | [Inlay compression can overwrite an import](warning/inlay-compression-can-overwrite-an-import.md) |
| server core | [Deleting a young chat leaves no recovery copy](warning/chat-deletion-has-no-preimage-history.md) |
| server core | [Payload-bearing whole-chat patches can half-apply external rows](warning/whole-chat-patches-half-apply-external-rows.md) |

## Recurring patterns (fix themes)

- **Validate before the point of no return**: import decode ordering, inlay
  migration, install.sh staging all destroy the old copy before proving the
  new one.
- **Cooldowns silently disable the safety net**: the pre-image 45 s cooldown
  and snapshot 5-minute cooldown each suppress exactly the capture the
  destructive paths (reroll, deletion, script wipes, failed imports) rely on.
  Destructive operations need cooldown-exempt captures.
- **Current-selection addressing across awaits**: sendMain, reroll
  completion, and the gallery scan all read live selection/state after an
  async gap instead of resolving stable IDs.
- **Keep-set/enumeration drift**: every new store (MCP payloads, drafts, KV
  fallback inlays, plugin-owned assets) must be added to backup enumeration
  and GC keep-sets in lockstep; nothing enforces this today.
- **Acknowledge only durable state**: the 5 s dbCache window, missing persist
  retry, missing backup fsync, and success-before-save UI toasts all report
  completion the storage cannot yet guarantee.

## Verified as guarded (spot checks during this audit)

- Full `/api/write` commits plugin rows, chat rows, `database.bin`, and row
  deletions in one synchronous transaction; no `better-sqlite3` transaction
  in the audited files spans an `await`.
- The import barrier holds before drain; list-delta epochs are bumped on
  import commit and rollback; journaled directory swaps recover at startup.
- Content-addressed asset writes use exclusive temp files, fsync, atomic
  rename, and byte-equality checks (`assetStore.cjs`).
- Exports pin a read-only WAL snapshot and abort on missing referenced chat
  rows; snapshot trimming always retains the newest snapshot.
- Chat hydration re-finds its target by ID and suppresses reactive
  write-back; chat rows persist before their stubs; branching clones instead
  of truncating the source.
- Verified browser caches (KV, chat rows, DB segments, list deltas) are
  hash-negotiated and fall back to authoritative reads on any anomaly.
