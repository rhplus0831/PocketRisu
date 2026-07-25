# A concurrent plugin write can corrupt a streamed export

- Status: Fixed
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

## Resolution

Both streamed downloads and server-side saves now acquire one pinned SQLite KV snapshot after flushing pending database work inside the storage-operation queue. That externally owned snapshot is used for the complete backup operation: assembling the self-contained `database.risudat` spool, enumerating every KV-backed namespace with chunk-aware logical sizes, and reading KV/plugin values when their archive entries are emitted. The snapshot is closed in the endpoint `finally` block, while concurrent `/api/write` operations remain free to proceed after the short snapshot-acquisition queue operation completes.

Asset reads use the same snapshot for their KV fallback. Cold-storage enumeration and decoding also use the snapshot with legacy migration disabled, so exports no longer write `coldstorage/` rows while planning an archive. Filesystem-backed assets, inlays, and sidecars retain their existing behavior, but both endpoints now verify that every entry still exists and exactly matches its planned size before writing it. A mismatch destroys the HTTP export response so clients receive a transport failure, or throws during a server save so its temporary file is removed.

Regression coverage in `test/compat/export-concurrent-mutation.test.ts` backpressures an export behind six 8 MiB assets, then both grows a one-byte plugin row to 8 MiB and shrinks an 8 MiB row to one byte through a concurrent `/api/write`. In both cases the write returns successfully, the downloaded byte count equals `Content-Length`, the archive walks to an intact `database.risudat`, the plugin entry contains its original snapshot value, and a fresh server imports the archive successfully.
