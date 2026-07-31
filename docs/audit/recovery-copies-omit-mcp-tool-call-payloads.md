# Every recovery copy omits MCP tool-call payloads referenced by chats

- Status: Fixed 2026-07-31
- Severity: High
- Area: server recovery (backup completeness)
- Affected code: `src/ts/process/mcp/mcp.ts` (payload storage), `server/node/mcpToolCallRecovery.cjs` (key/reference policy), `server/node/server.cjs` (export/import/snapshot coordination), `server/node/streamRisuSave.cjs` and `server/node/streamRisuLoad.cjs` (folded snapshot transport)

## Resolution

Node-only downloads, server-file backups, and partial export jobs now pin the
dedicated MCP cache namespace at the same SQLite snapshot boundary, scan the
assembled chat graph without materializing the database, and publish only rows
referenced by complete remembered-tool markers. Missing referenced rows fail
strict exports instead of publishing an incomplete recovery copy. Upstream-target
exports remain unchanged.

Automatic snapshots fold referenced payloads into a versioned private top-level
map and stream them back into exact cache rows during restore. The envelope is
removed before the live database is published. Destructive archive and save-folder
imports clear the prior MCP namespace, accept only canonical
`cache/mcp-tool-calls/<base64url>.json` archive names, and restore entries inside
the existing replacement transaction.

Coverage includes download, server-file, partial, fresh-server round trips,
unreferenced-row exclusion, missing-row failure, stale-prefix replacement, upstream
omission, split-page marker scanning, and automatic snapshot restore.

## Risk (historical)

With remembered tool usage, `encodeToolCall()` writes the complete
`{call, response}` record to a `cache/mcp-tool-calls/<id>` KV row and puts only
an opaque `<tool_call>id</tool_call>` marker into the chat. Historical request
reconstruction (`src/ts/process/request/modelPresetMessages.ts`) requires
`decodeToolCall()` to resolve that row.

Before this fix, no recovery copy enumerated the `cache/` namespace: portable
exports and server `.bin` backups listed assets, cold storage, plugin rows,
inlay files/sidecars/meta, and the database; automatic snapshots folded chats
and plugin storage only. A backup restored onto a fresh instance (machine
migration, disk loss — the primary purpose of portable backups) therefore
contained chats whose tool-call markers could never be resolved again: the tool
arguments and responses were permanently gone, and reconstructed request
history silently degraded.

Same-instance restores masked the gap because imports did not clear `cache/`
rows, so the omission went unnoticed until the original SQLite database was
lost.

## Required fix and coverage (completed)

Include the MCP rows referenced by exported chats in Node-only portable and
server backups (and fold them into automatic snapshots like plugin storage), and
whitelist the namespace on import. Alternatively make the marker self-contained
by embedding the recorded call in the chat representation.

Cover with a round-trip test: chat with a remembered tool call → portable
export → import into a fresh server → `decodeToolCall()` resolves.
