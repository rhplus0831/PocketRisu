# Runtime asset writes can replace a case-colliding asset on case-insensitive volumes

- Status: Open
- Severity: Medium
- Owner: media and translation
- Source reports: [portable filename remediation](../../../../.archived-docs/findings/2026-08-remediation/fixed/portable-asset-filename-mapping.md) (residual carved out of the fixed migration/import surface)

## Risk

`f3e8aa11` made the startup migration and import staging preflight the
host-independent portable identity, but the runtime write paths —
`writeAssetValue()` and `writeAssetValueFromSpool()` in
`server/node/server.cjs` — still map any safe name verbatim to
`save/assets/<name>` via temp-file plus rename. On a case-insensitive volume,
writing key `assets/Foo.png` while a different key's file `foo.png` exists
replaces that file's payload through the rename and deletes only the writer's
own KV row: both logical keys then serve the new bytes and the old payload is
gone. Reserved-device and trailing-dot names can also still be created as new
files at runtime, reintroducing a non-portable layout that later restores on
Windows reject.

Exposure requires a runtime write of a case-variant or non-portable custom
name — client-side character imports and external `/api/write` callers; the
official client's generated names are lowercase content hashes and safe.

## Required fix and coverage

Before publishing a runtime asset file, verify the destination by exact
directory-entry name (a folded `stat` hit is not proof of self-identity) and
route cross-colliding or non-portable new names to SQLite like the migration
and import paths do. Any KV routing must not let an existing case-aliased
file shadow the row on reads — pair it with read-side exact-name
verification, or demote the aliased file within the storage queue. Cover a
case-variant runtime write on a simulated case-folding filesystem preserving
both payloads, and a reserved-name runtime write staying out of the
filesystem.
