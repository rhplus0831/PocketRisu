# Upstream-target export can emit a PocketRisu-only magic version byte

- Status: Fixed (2026-08-05 remediation queue)
- Owner: plugin storage
- Source: [2026-07 compatibility investigation](../../2026-07-compatibility/SOURCE-INDEX.md)
- Severity: High (at fix time)
- Resolution: `3da789b4` — `target=upstream` now runs the same post-spool
  header check as the `main` rollback target: a folded database spool whose
  header is not the legacy version-7 magic is rejected with a definitive 409
  `BACKUP_UPSTREAM_UNSUPPORTED_PLUGIN_KEYS` (rename/remove migration
  guidance) before any archive bytes or response headers are published, and
  the upstream backup UI surfaces that message instead of a generic failure.
  Rejection was chosen over re-encoding because no faithful 7/8/9
  representation exists: upstream's msgpackr renames a decoded `__proto__`
  map key to `__proto_`, and ill-formed UTF-16 keys cannot round-trip
  through msgpack's UTF-8 strings. Partial exports and automatic snapshots
  keep the escape envelope — they are not upstream-labeled and PocketRisu
  decodes version byte 10 natively.
- Regression coverage: `test/compat/plugin-backup-entries.test.ts` (an
  escape-key `target=upstream` export returns 409 with no
  `content-disposition` or `x-risu-backup-target` headers, mirroring the
  existing `main` assertions; a pinned `upstreamV190AcceptsRisuSaveHeader`
  helper replicates upstream's accepted header bytes — legacy 7/8/9 and
  `RISUSAVE\0` — literally and validates the ordinary-key upstream export's
  `database.risudat`, replacing the PocketRisu-decoder round trip that
  masked the mismatch; the partial-export escape-envelope round trip in the
  same file retains fold/restore coverage).
- Canonical architecture: [backup and recovery](../../../../docs/structure/backup-recovery.md),
  [plugin storage](../../../../docs/structure/plugin-storage.md)

## Original difference (historical)

serve folds optimized plugin rows when target=upstream. If
pluginCustomStorage or pluginStorageMeta owns a __proto__ key, the encoder
uses PocketRisu's escape envelope and legacy magic/version byte 10.

Current upstream RisuAI recognizes only the legacy 7/8/9 and RISUSAVE block
headers. It does not decode version byte 10. Existing compatibility tests
decode the result with PocketRisu's decoder, masking the target mismatch.

## Original compatibility impact (historical)

An archive explicitly labeled and named for upstream can fail to open in
upstream RisuAI based on one legal plugin storage key.

## Original recommendation (historical)

Make target selection choose an encoder supported by that target. For
upstream, use a 7/8/9-compatible data representation or reject the
exceptional key with a clear migration message before export. Test the
bytes with the actual pinned upstream decoder, not PocketRisu's decoder.
