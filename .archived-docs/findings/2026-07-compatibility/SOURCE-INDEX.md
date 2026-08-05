# main to serve compatibility investigation

## Scope

- Audited: 2026-07-29
- Baseline: main at 63832a138c14cc7f11364cf7efdcb61950e7894c
- Target: serve HEAD at f2da33aac633cb90ec4c84dde6e9b92676ff2ae8
- Merge base: the baseline commit above
- Change set: 156 commits, 383 files, 101,144 insertions, 5,059 deletions
- Reference implementation: the Plain RisuAI checkout named in AGENTS.md where
  upstream behavior mattered

Twenty independent sub-agents reviewed history, client persistence, server
contracts, plugin API/lifecycle/bridge/storage, chat hooks, providers,
scripting, assets, backups, MCP, character/preset formats, tests, and an
adversarial cross-cut. The root review de-duplicated and rechecked their
evidence before writing these reports.

The index contains 46 separate reports: 43 runtime, data, API, or deployment
compatibility findings and three test/CI coverage gaps.

## Reading the results

Confirmed regression means a behavior available on main is no longer available
or safe on serve. Intentional breaking change means the new policy is
understandable, but still requires explicit migration. Internal contract break
means a newly added serve API accepts state that another part of that same API
cannot handle. Coverage gaps are documented separately and are not counted as
runtime regressions.

Severity ranks impact if the affected path is used; it does not estimate how
many users use that path.

## Highest-priority findings

- [New client 404 could overwrite an older server database (fixed 2026-07-31)](reports/boot-raw-read-404-overwrites-older-server-database.md)
- [Authoritative storage still stops at 15 seconds](reports/authoritative-storage-15-second-deadline.md)
- [Chat saves wait for a full snapshot after committing](reports/chat-save-blocked-by-synchronous-snapshot.md)
- [V3 top-level completion blocks application startup](reports/v3-top-level-startup-barrier.md)
- [Chat-row migration breaks direct rollback to main (fixed 2026-07-31)](reports/chat-row-migration-breaks-main-rollback.md)
- [Asset externalization breaks direct rollback to main (fixed 2026-07-31)](reports/asset-externalization-breaks-main-rollback.md)
- [Default export/import limits did not round-trip (fixed 2026-07-30)](reports/backup-export-import-limit-mismatch.md)

## Plugin and storage reports

- [Residual 30-minute bridge deadline (fixed 2026-07-31)](reports/plugin-bridge-residual-30-minute-deadline.md)
- [V3 hook callback identity](reports/v3-hook-callback-identity.md)
- [V3 unload API allowlist](reports/v3-onunload-api-allowlist.md)
- [loadPlugins readiness contract](reports/plugin-loadplugins-readiness.md)
- [Silent V3 database permission denial (fixed 2026-07-31)](reports/v3-database-setter-permission.md)
- [Removed V3 custom-key fallback](reports/v3-database-custom-key-fallback.md)
- [V2 rich-value rejection](reports/v2-plugin-storage-rich-values.md)
- [V2 caller-alias detachment](../../../docs/findings/open/plugin-storage/v2-plugin-storage-live-aliases.md)
- [V2 object-prototype change](reports/v2-plugin-storage-object-prototype.md)
- [Local plugin storage strict JSON](reports/local-plugin-storage-strict-json.md)
- [Inline rich values broke enumeration (fixed 2026-07-30)](reports/inline-plugin-storage-enumeration-rich-values.md)
- [Enumeration order change](reports/plugin-storage-enumeration-order.md)
- [Ill-formed legacy key compatibility (fixed 2026-07-30)](reports/legacy-plugin-storage-key-compatibility.md)
- [Optimized-storage key-length limit (fixed 2026-07-31)](reports/optimized-plugin-storage-key-length-limit.md)
- [Optimized-mode transition lock-in (fixed 2026-07-30)](reports/optimized-plugin-storage-transition-lock-in.md)
- [Raw boot does not pin a plugin generation](reports/raw-boot-plugin-generation-not-pinned.md)
- [Configured optimized-storage limit differed from client limit (fixed 2026-07-30)](reports/plugin-storage-configured-limit-client-mismatch.md)
- [Safe update APIs had a smaller value limit (fixed 2026-07-30)](reports/plugin-storage-batch-size-mismatch.md)
- [V2 unload could wedge lifecycle (fixed 2026-07-30)](reports/v2-unload-can-wedge-plugin-lifecycle.md)
- [Unrelated failure can poison an install](reports/unrelated-plugin-failure-poisons-install.md)
- [Permission editor cannot reset to Ask](reports/permission-editor-cannot-reset-to-ask.md)
- [Input hooks cannot call sendChat](reports/input-hooks-cannot-call-sendchat.md)
- [Viewer requires String.isWellFormed (fixed 2026-07-31)](reports/plugin-storage-viewer-requires-string-iswellformed.md)

## Persistence, assets, and server API reports

- [Asset filename migration is not portable](reports/asset-filename-migration-not-portable.md)
- [Legacy hash-looking assets became unwritable (fixed 2026-07-31)](reports/legacy-hash-named-assets-become-unwritable.md)
- [Whole-chat patches partially commit rows](reports/whole-chat-patch-partially-commits-rows.md)
- [Bulk asset writes partially commit files](reports/bulk-asset-write-partially-commits-files.md)
- [Bulk inlay deletion exceeded its request limit (fixed 2026-07-30)](reports/bulk-inlay-deletion-limit.md)

## Backup and interchange reports

- [RISUSAVE block databases over 64 MiB were rejected (fixed 2026-07-30)](reports/legacy-risusave-64mib-import-cap.md)
- [Large buffered backup/save-folder rows were rejected (fixed 2026-07-30)](reports/save-folder-opaque-row-32mib-cap.md)
- [Save-folder restore had a fixed deadline (fixed 2026-07-30)](reports/save-folder-restore-fixed-deadline.md)
- [Upstream export can emit a PocketRisu-only version byte](../2026-08-remediation/fixed/upstream-export-plugin-proto-header.md)

## Intentional deployment breaks

- [Remote plain HTTP no longer boots](../../../docs/findings/decisions/remote-http-requires-explicit-override.md)
- [Cloudflare Quick Tunnel was removed](../../../docs/findings/decisions/cloudflare-quick-tunnel-removed.md)
- [Custom hub proxy targets are rejected](../../../docs/findings/decisions/hub-proxy-custom-targets-rejected.md)
- [Generic HOST now changes the listen address](../../../docs/findings/decisions/generic-host-controls-listen-address.md)

## Coverage gaps

- [Compatibility suites are absent from CI](../2026-08-remediation/fixed/compatibility-suites-not-run-in-ci.md)
- [Real upstream fixture tests silently skip](../../../docs/findings/open/operations-coverage/real-upstream-backup-fixture-skipped.md)
- [Plugin timeout test was self-referential (fixed 2026-07-31)](reports/plugin-timeout-regression-test-is-self-referential.md)

## Verification

All existing suites passed during the parallel investigation:

- pnpm test: 99 files, 1,625 passed, 3 skipped
- pnpm test:server: 25 files, 344 passed
- pnpm test:compat: 35 files passed, 1 skipped; 281 passed, 5 skipped

Focused plugin, storage, asset, secure-context, provider, character/preset, and
real-server boundary suites also passed. Passing results do not invalidate the
reports: several tests explicitly codify the changed limit or behavior, while
the mixed-version, rollback, slow-I/O, platform-filesystem, and real-upstream
cases are absent.

## Deliberate exclusions

The audit did not refile defects whose relevant implementation is unchanged
from main, including the existing CCV2 regex-lore, CharX non-card JSON,
module namespace/CommonJS, persona export, preset export, inlay remap, callback
serialization, and several save-scheduler findings already under docs/audit.

Core provider adapters, streaming parsers, MCP protocol/transport, scripting
interpreters, character/preset codecs, persisted enum ordering, and public V3
method names were checked without another main-to-serve regression. A possible
stale live MCP client after reload was also excluded because the same practical
failure existed on main through a different stale-host path.
