# A corrupted save block is silently skipped and the partial database becomes authoritative

- Status: Open
- Severity: Medium
- Area: save-format decoding (server and client)
- Affected code: `server/node/utils.cjs:247-286` (block parser: bare `catch { continue; }`, no length validation), `server/node/utils.cjs:292-386` (per-block errors logged and skipped; defaults manufactured), `src/ts/storage/risuSave.ts:429-470` (client decoder mirrors the skip), `src/ts/storage/database.svelte.ts` (`setDatabase` fills missing collections)

## Risk

The block-format decoder skips any block whose framing or content fails to
parse and returns a database missing those blocks — with `characters: []` and
a default preset manufactured when absent. A single corrupted block (torn
write, bit rot) therefore yields a *successfully decoded* partial database:
the server caches and re-encodes it as authoritative, the client's
backup-recovery path is never entered (it triggers only on decode *throw*),
and the next persisted patch overwrites the original bytes — permanently
discarding blocks that were intact on disk next to the corrupt one. Requires
prior on-disk corruption, hence warning; but the response to corruption is
silent amplification instead of failover to recovery copies.

## Required fix and coverage

Validate block headers and declared lengths against the remaining buffer,
require every directory entry to resolve, and make a required-block parse
failure abort the decode so boot falls back to snapshots/backups. Never cache
or re-encode a partial decode as authoritative.
