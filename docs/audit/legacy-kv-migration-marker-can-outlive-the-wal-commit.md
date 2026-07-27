# The legacy KV migration marker can outlive the WAL commit

- Status: Open
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
