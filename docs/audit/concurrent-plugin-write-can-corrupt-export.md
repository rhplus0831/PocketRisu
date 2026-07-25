# A concurrent plugin write can corrupt a streamed export

- Status: Open
- Severity: High
- Commit: `dd678e00`
- Affected code: `server/node/server.cjs:2286-2295`, `server/node/server.cjs:4303-4405`

## Risk

Node-only exports enumerate plugin rows and their sizes, use those sizes to compute the HTTP `Content-Length`, and later reread each row while streaming. The export does not share the storage-operation queue with `/api/write`.

If a plugin value changes size after enumeration, the archive entry is framed with the later size while the HTTP response still advertises the earlier total. A reproduction replaced a one-byte row with an 8 MiB value while export was backpressured behind an earlier entry. The write returned 200, and export also returned 200 with its original `Content-Length`. The client received exactly that advertised length, leaving only 114 bytes after an entry header that claimed 8,388,608 bytes; `database.risudat` was absent. No transport error identified the resulting archive as unsafe.

Deletion during the same window can similarly make the emitted byte count shorter than the planned framing.

## Required fix and coverage

Serialize enumeration and streaming against all row writes, or snapshot/spool immutable copies of every namespaced entry and derive all headers and response length from those copies. If the source changes, the export may represent either complete point in time, but never a mixture with invalid framing.

Add a concurrent mutation test using valid JSON plugin values. Resize or delete a late entry while export is paused and require the downloaded archive to parse completely, contain `database.risudat`, and import successfully with exact framing.

