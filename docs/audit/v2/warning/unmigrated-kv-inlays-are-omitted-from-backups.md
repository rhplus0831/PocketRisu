# Inlays still served from KV fallback are omitted from backups and cleared on restore

- Status: Open
- Severity: Medium
- Area: server recovery (backup completeness)
- Affected code: `server/node/server.cjs:1397-1443` (migration writes the global marker despite per-entry skips), `server/node/server.cjs:3965-3975` (reads fall back to KV), `server/node/server.cjs:4715-4776`, `server/node/server.cjs:5012-5035` (backups enumerate filesystem inlays + `inlay_meta/` only), `server/node/server.cjs:2800-2804` (import clears `inlay/` prefixes)

## Risk

If an inlay fails or is skipped during the one-time filesystem migration
(unsafe ID, transient error), the marker is still written, so it is never
retried — the inlay lives permanently in its KV fallback row, which the server
happily serves. Backups enumerate only filesystem inlays, so the fallback
payload and its `inlay_info/` row are silently absent from every archive, and
restoring an archive clears the legacy prefixes, deleting the live copy.

## Required fix and coverage

Do not write the migration marker while readable legacy rows remain (or
retry them per-boot), and make backup enumeration take the union of
filesystem and KV inlays, including the KV payload whenever no verified
filesystem equivalent exists.
