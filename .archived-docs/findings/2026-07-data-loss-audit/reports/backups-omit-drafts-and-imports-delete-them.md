# Backups omit composer drafts and imports delete them

- Status: Fixed 2026-07-31
- Severity: Medium
- Area: server recovery / drafts
- Affected code: `server/node/server.cjs` (draft archive planning and graph-filtered restore), `src/ts/storage/chatDraft.ts:3-9` (drafts are designed to sync across devices)

## Resolution

Fixed 2026-07-31. Node-only downloads, server-file backups, and partial export
jobs now select draft rows from the same pinned SQLite snapshot as the chat
graph. Only `drafts/<chaId>/<chatId>` keys backed by an authoritative chat row
are published; rows with no corresponding chat payload are omitted. Upstream-target exports remain
intentionally lossy because upstream RisuAI does not understand this namespace.

Archive and legacy save-folder imports still clear drafts from the prior
dataset, but draft entries are now held in private staging until the imported
database has assigned missing IDs and normalized duplicate character IDs. The
replacement transaction publishes only entries whose exact key exists in that
normalized graph, preventing stale or cross-dataset drafts from attaching to a
reused identity. Failed imports roll draft deletion and restoration back with
the rest of the SQLite replacement.

`test/compat/draft-backup-roundtrip.test.ts` covers full and partial fresh-server
round trips, stale and orphan filtering, upstream omission, and graph-filtered
legacy save-folder restoration.

## Risk (historical)

Drafts are persistent server KV rows that the client documents as
cross-device state, but no backup path enumerates `drafts/`, and both import
paths explicitly clear the prefix (the server-side comment calls them
"session/device-local", contradicting the client design). Restoring a "full"
backup therefore permanently discards every unsent draft, with no warning.

## Required fix and coverage (completed)

Either include `drafts/` as a backup namespace (restoring only drafts whose
chat identities exist in the imported graph), or stop deleting them on import
and document the exclusion. Add a round-trip test either way.
