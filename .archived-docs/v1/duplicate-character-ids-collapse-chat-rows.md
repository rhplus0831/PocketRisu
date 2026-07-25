# Duplicate character IDs collapse distinct chat rows

- Status: Fixed
- Severity: High
- Commits: `c3e22dc3`, activated by `9cb0086d`
- Affected code: `server/node/chatRows.cjs:108-161`, `server/node/chatRows.cjs:304-337`, `src/ts/bootstrap.ts:685-705`

## Risk

The chat-row key is derived only from `(chaId, chatId)`. `extractPayloadChats()` creates a new chat-ID uniqueness set for each character, so it does not detect two characters that share a `chaId`. If those characters also contain the same chat ID, both payloads map to one `chats/<chaId>/<chatId>` row and the latter write overwrites the former.

A reproduction using payloads `A` and `B` produced one physical row; assembling both characters returned `[B, B]`.

Duplicate character IDs are recoverable legacy/import input rather than an acceptable reason for destructive normalization. Browser bootstrap already repairs duplicate character and chat IDs, but server boot and import ingestion now externalize rows before that browser repair runs. The monolithic format could retain both payloads; the new ingest boundary silently cannot.

## Required fix and coverage

Detect duplicate `chaId` values before any chat-row write. Either assign fresh IDs with the same reference-preserving rules as browser bootstrap, or reject the entire ingest atomically while retaining the source monolith. Per-character chat-ID repair must then run in the final character-ID namespace.

Add an ingest and round-trip regression with two characters sharing `chaId` and chat ID. Require either two distinct reconstructed payloads or a non-destructive validation error. Cover both normal and streaming ingest.

## Resolution

Duplicate character IDs are now repaired before any chat-row write, with the same reference-preserving rules as browser bootstrap: the first occurrence keeps its `chaId`, each later duplicate receives a fresh UUID.

- `dedupeCharacterIds()` in `../../server/node/chatRows.cjs` performs the repair and is shared by both ingest paths. `ingestFullDatabase()` runs it after cold-storage restore and before `splitFullDb()`, so every row write uses the final character-ID namespace; per-character chat-ID repair then runs inside that namespace as before.
- `ingestStreamingDatabase()` repairs at the first `onChat` for each character — before the chat externalizer captures the `chaId` — using shared used-ID state, and a post-walk sweep with the same state catches characters that never stream a chat. A chatless earlier character may therefore not be the duplicate that retains the original ID; uniqueness and payload preservation still hold.
- A reassigned character's stub chats stay resolvable: the pre-existing `chats/<oldChaId>/<chatId>` row is copied to `chats/<newChaId>/<chatId>` (inside the persist transaction on the full path; before stale-key computation on the streaming path). The old row is left for the keeper and the existing stale sweeps.
- Both paths report `stats.reassignedDuplicateChaIds`, and the server logs a warning when it is non-zero. The `/api/write` database handler now rejects a full database containing duplicate `chaId` values via `findDuplicateChaIds()` (non-destructive 500, alongside the stub-flag-loss guard) — clients repair IDs at bootstrap, so duplicates at that boundary signal an external writer rather than recoverable input.

Regression tests in `../../server/node/chatRows.test.ts` cover both normal and streaming ingest with two characters sharing `chaId` and chat ID (two distinct physical rows, both payloads reconstructed on round-trip), stub-row preservation across reassignment on both paths, three characters sharing one ID, the chatless-character sweep, and `findDuplicateChaIds()` itself.

