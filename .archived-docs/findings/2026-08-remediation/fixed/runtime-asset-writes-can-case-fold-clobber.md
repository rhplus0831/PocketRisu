# Runtime asset writes can replace a case-colliding asset on case-insensitive volumes

- Status: Fixed (2026-08-06 remediation queue)
- Owner: media and translation
- Source reports: [portable filename remediation](portable-asset-filename-mapping.md)
- Severity: Medium (at fix time)
- Resolution: this remediation commit — `runtimeAssetFileDisposition()` and
  its batched companion in `server/node/assetStore.cjs` now centralize the
  exact directory-entry and host-independent portable-identity checks for
  runtime assets. Both buffered and spooled writes retain unsafe,
  Windows-reserved, trailing-dot, and case-colliding names in SQLite instead
  of publishing a clobbering filesystem rename. Filesystem reads, metadata,
  and deletes require an exact directory-entry name, while ordinary reads,
  direct asset responses, and dual-source listings give an ineligible name's
  KV row precedence. Thus a case-aliased path resolution cannot shadow the
  distinct logical row, and both payloads remain live.
- Regression coverage: `server/node/assetStore.test.ts` (reserved/trailing-dot
  runtime disposition; simulated case-insensitive filesystem preserving entry
  casing; exact-name read/metadata/delete checks; case-fold collision refusal),
  `test/compat/admitted-write-spool.test.ts` (buffered and admitted-spool route
  matrix preserving `Foo.png` plus KV-backed `foo.png`, keeping `CON.png` off
  the filesystem, verifying physical backends and KV precedence over an
  injected stale reserved file, `/api/read`, direct `/api/asset`, and spool
  cleanup).
- Canonical architecture: [media and translation](../../../../docs/structure/media-translation.md),
  [server backend](../../../../docs/structure/server-backend.md)

## Original risk (historical)

The startup migration and import staging preflighted host-independent portable
identity, but the runtime `writeAssetValue()` and
`writeAssetValueFromSpool()` paths still mapped any safe name verbatim to
`save/assets/<name>` through temp-file plus rename. On a case-insensitive
volume, writing `assets/Foo.png` while `foo.png` existed could replace the old
file, discard only the writer's KV row, and make both logical keys serve the
new payload. Reserved-device and trailing-dot runtime names could also
reintroduce a layout that a later Windows restore rejected.

Exposure required a runtime write of a case variant or non-portable custom
name. Official-client generated asset names are lowercase content hashes and
were not affected.

## Original required fix (historical)

Before runtime publication, verify the destination by exact directory-entry
name and portable identity, routing colliding or non-portable names to SQLite.
Ensure reads cannot resolve a case alias ahead of that KV row. Cover payload
preservation on a simulated case-folding filesystem and a reserved-name
runtime write that stays out of the filesystem.
