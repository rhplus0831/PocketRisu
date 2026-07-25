# Backups omit composer drafts and imports delete them

- Status: Open
- Severity: Medium
- Area: server recovery / drafts
- Affected code: `server/node/server.cjs:4703-4776`, `server/node/server.cjs:5025-5035` (no `drafts/` in backup enumeration), `server/node/server.cjs:2814-2816` (import clears the prefix), `src/ts/storage/chatDraft.ts:3-9` (drafts are designed to sync across devices)

## Risk

Drafts are persistent server KV rows that the client documents as
cross-device state, but no backup path enumerates `drafts/`, and both import
paths explicitly clear the prefix (the server-side comment calls them
"session/device-local", contradicting the client design). Restoring a "full"
backup therefore permanently discards every unsent draft, with no warning.

## Required fix and coverage

Either include `drafts/` as a backup namespace (restoring only drafts whose
chat identities exist in the imported graph), or stop deleting them on import
and document the exclusion. Add a round-trip test either way.
