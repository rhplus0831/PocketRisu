# Changing the chat-backup root hides all existing version history

- Status: Open
- Severity: Medium
- Lens: L3, D3, D5
- Area: Area 8 — mode matrix and round trips
- Affected code: `server/node/chatBackups.cjs:67`, `server/node/server.cjs:932`, `server/node/server.cjs:976`, `server/node/server.cjs:985`, `server/node/chatBackups.cjs:391`, `server/node/chatBackups.cjs:1007`

## Risk

The environment selects exactly one chat-backup root. Startup immediately
overwrites the marker with that root and migrates only one historical hard-coded
location; it never reads the previous marker or scans the prior configured root.
All list and read operations resolve exclusively under the new root.

Changing the override from volume A to B makes all versions on A disappear from
the UI while new history begins on B. The files still exist initially, but an
operator may detach or clean A after believing migration occurred, deleting the
only pre-image recovery copies.

## Required fix and coverage

Read and validate the previous marker before overwriting it, then merge/migrate
history with conflict handling. If migration cannot be automatic, keep both roots
readable and require an explicit operator action.

Test A-to-B, B-to-default, conflicts, interruption, and restart visibility.
