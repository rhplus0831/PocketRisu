# The legacy KV migration marker can outlive the WAL commit

- Status: Fixed 2026-07-31
- Severity: Medium
- Lens: D5
- Area: Area 5 — server KV core and chat rows
- Affected code: `server/node/db.cjs:16-18`, `server/node/db.cjs:60-63`, `server/node/db.cjs:82-99`

## Risk

Legacy hex-file migration commits its SQLite copy under WAL/NORMAL and then
creates a separate `.migrated_to_sqlite` marker without checkpointing first.
Filesystem marker persistence is not ordered with WAL persistence, and later
boots skip migration solely because the marker exists.

A power loss can preserve the marker while SQLite rolls back the unsynced copy.
The next boot exposes an empty or incomplete database even though the original
hex files remain under `save/`. Those sources permit manual recovery, but the
server permanently hides them without an operator knowing why.

## Required fix and coverage

Record completion in the same SQLite transaction, or checkpoint/sync SQLite
before atomically publishing and fsyncing the marker and its parent. Verify the
marker against migrated state on boot and retry from preserved sources on drift.

Add power-loss ordering coverage for the transaction/marker boundary.

## Resolution (2026-07-31)

Legacy migration completion now lives in the SQLite-only `storage_migrations`
table and is committed in the same transaction as every imported raw or
chunked value. The `.migrated_to_sqlite` file remains for rollback and UI
compatibility, but it is published through a synced temporary file, atomic
rename, and parent-directory sync; cleanup authorization now consults the
transactional completion row instead of marker existence.

Boot also reconciles markers written by older versions. When the preserved
legacy database file exists but SQLite lacks its authoritative database row,
the server treats the marker as drift and reimports the preserved files. When
the database row proves the old all-or-nothing transaction committed, the
server adopts the marker without resurrecting individual keys intentionally
deleted since migration. Explicit directory and ZIP imports record the same
completion state before their SQLite commit.

`test/compat/legacy-kv-migration-durability.test.ts` constructs both sides of
the transaction/marker crash boundary, verifies stale-marker recovery, marker
repair, preserved sources, and one-shot migration semantics. The direct-import
regression in `test/compat/import-ingress-memory.test.ts` verifies committed
state and cleanup authorization even when post-commit marker publication fails.
