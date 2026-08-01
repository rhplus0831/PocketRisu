# Asset filenames collide on case-insensitive filesystems

- Status: Open
- Severity: Medium
- Lens: D4
- Area: Area 7 — server file stores
- Affected code: `server/node/assetStore.cjs:9-10`, `server/node/assetStore.cjs:88-103`, `server/node/assetStore.cjs:117-143`, `server/node/server.cjs:1526-1545`, `server/node/server.cjs:4219-4228`, `server/node/server.cjs:4341-4344`

## Risk

The safe-name grammar admits uppercase and lowercase basenames and maps them
directly to host paths. Distinct logical keys such as `Foo.png` and `foo.png`
therefore collapse to one directory entry on default case-insensitive macOS and
Windows volumes. Imports do not detect case-fold collisions before publication.

Hash verification recognizes only lowercase 64-hex names, so an uppercase
spelling is treated as an unverified legacy asset while addressing the same
case-folded path. A cross-platform restore can silently replace one of two
referenced legacy assets, making both references return one byte sequence.

## Required fix and coverage

Enforce a portable canonical form for content-addressed names and reject
case-fold-equivalent destinations before any write or import. Escape unavoidable
legacy case-distinct keys into an injective KV representation.

Round-trip collision fixtures across case-sensitive and insensitive stores.
