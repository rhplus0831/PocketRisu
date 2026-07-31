# A corrupted save block is silently skipped and the partial database becomes authoritative

- Status: Fixed (2026-07-31)
- Severity: Medium
- Area: save-format decoding (server and client)
- Resolution code: `server/node/utils.cjs`, `server/node/server.cjs`,
  `server/node/streamRisuLoad.cjs`, `server/node/streamBackupRisuSave.cjs`,
  `src/ts/storage/risuSave.ts`, and `src/ts/bootstrap.ts`

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

## Resolution

Authoritative browser and server database decodes now use a strict block
integrity contract. It validates framing, compression flags, UTF-8 and JSON
for known block types, requires a root object, resolves REMOTE payloads, and,
when a historical `__directory` is present, requires every declared block to
be available. A failure is propagated as `RISU_SAVE_INVALID`; it is not routed
through legacy format fallbacks and the partial object is never cached or
re-encoded.

Server boot therefore preserves the corrupt live bytes and enters the existing
authenticated snapshot-recovery mode. Browser boot likewise invokes internal
snapshot recovery instead of installing the partial result. Bounded restores
and the disk-backed large-block transformer enforce the same completeness
rule before publication.

Compatibility decoding remains deliberately permissive for legacy chat rows
and explicit salvage callers. Historical block saves without `__directory`
remain valid, and complete unknown future block types remain ignorable. Added
coverage proves partial JSON, truncated framing, unresolved directory entries,
and missing roots fail authoritatively while a valid snapshot can be restored
without changing the corrupt source bytes first.
