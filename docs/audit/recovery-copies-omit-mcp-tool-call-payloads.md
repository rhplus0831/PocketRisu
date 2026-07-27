# Every recovery copy omits MCP tool-call payloads referenced by chats

- Status: Open
- Severity: High
- Area: server recovery (backup completeness)
- Affected code: `src/ts/process/mcp/mcp.ts:247-287` (payload stored only under `cache/mcp-tool-calls/`), `src/ts/storage/persistentKv.ts:55-58` (lands in the server KV), `server/node/server.cjs:4703-4776` (portable export enumeration), `server/node/server.cjs:5025-5035` (server backup enumeration), `server/node/server.cjs:355-378` (DB-only snapshots fold chats + plugin rows only)

## Risk

With remembered tool usage, `encodeToolCall()` writes the complete
`{call, response}` record to a `cache/mcp-tool-calls/<id>` KV row and puts only
an opaque `<tool_call>id</tool_call>` marker into the chat. Historical request
reconstruction (`src/ts/process/request/modelPresetMessages.ts`) requires
`decodeToolCall()` to resolve that row.

No recovery copy enumerates the `cache/` namespace: portable exports and server
`.bin` backups list assets, cold storage, plugin rows, inlay files/sidecars/meta,
and the database; automatic snapshots fold chats and plugin storage only. A
backup restored onto a fresh instance (machine migration, disk loss — the
primary purpose of portable backups) therefore contains chats whose tool-call
markers can never be resolved again: the tool arguments and responses are
permanently gone, and reconstructed request history silently degrades.

Same-instance restores mask the gap because imports do not clear `cache/` rows,
so the omission goes unnoticed until the original SQLite database is lost.

## Required fix and coverage

Include the MCP rows referenced by exported chats in Node-only portable and
server backups (and fold them into automatic snapshots like plugin storage), and
whitelist the namespace on import. Alternatively make the marker self-contained
by embedding the recorded call in the chat representation.

Cover with a round-trip test: chat with a remembered tool call → portable
export → import into a fresh server → `decodeToolCall()` resolves.
