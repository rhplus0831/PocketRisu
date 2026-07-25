# Duplicate character IDs collapse distinct chat rows

- Status: Open
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

