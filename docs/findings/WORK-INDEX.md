# Findings work index

Generated from the machine-readable headers in `open/` and `decisions/`.
Run `pnpm check:docs` after changing a finding, status, path, or link.
These are point-in-time reports; revalidate their evidence against current code
before implementation.

Current catalog: **23 open**, **0 deferred**, and **5 accepted decisions**.

## Active work by owner

### backup and recovery

| ID | Finding | Status | Source |
|---|---|---|---|
| `FND-chat-version-import-acknowledges-before-save` | [Chat-version import reports success before anything is persisted](open/backup-recovery/chat-version-import-acknowledges-before-save.md) | Open | 2026-07 data-loss audit |
| `FND-server-backup-published-without-fsync` | [Server backups are acknowledged before the directory entry is durable](open/backup-recovery/server-backup-published-without-fsync.md) | Open | 2026-07 data-loss audit |
| `FND-upstream-compatible-backup-drops-live-inlays-but-keeps-their-chat-references` | [Upstream-compatible backup drops live inlays but keeps their chat references](open/backup-recovery/upstream-compatible-backup-drops-live-inlays-but-keeps-their-chat-references.md) | Open | 2026-07 data-loss audit |

### characters and personas

| ID | Finding | Status | Source |
|---|---|---|---|
| `FND-ccv2-export-drops-regex-lore-semantics` | [CCv2 export drops regex lore semantics](open/characters-personas/ccv2-export-drops-regex-lore-semantics.md) | Open | 2026-07 data-loss audit |
| `FND-character-package-remaps-chat-ids-without-remapping-inlay-metadata` | [Character package remaps chat IDs without remapping inlay metadata](open/characters-personas/character-package-remaps-chat-ids-without-remapping-inlay-metadata.md) | Open | 2026-07 data-loss audit |
| `FND-charx-importer-mistakes-json-assets-for-metadata` | [CharX importer mistakes JSON assets for metadata](open/characters-personas/charx-importer-mistakes-json-assets-for-metadata.md) | Open | 2026-07 data-loss audit |
| `FND-module-charx-export-drops-namespace-and-cjs` | [Module CharX export drops `namespace` and `cjs`](open/characters-personas/module-charx-export-drops-namespace-and-cjs.md) | Open | 2026-07 data-loss audit |
| `FND-persona-exports-drop-advanced-fields` | [Persona exports silently drop advanced persona data](open/characters-personas/persona-exports-drop-advanced-fields.md) | Open | 2026-07 data-loss audit |

### chat pipeline

| ID | Finding | Status | Source |
|---|---|---|---|
| `FND-model-job-claim-precedes-chat-durability` | [Live model-job claim precedes chat-row durability](open/chat-pipeline/model-job-claim-precedes-chat-durability.md) | Open | delta audit DA-5 |
| `FND-streaming-checkpoint-rearm-can-absorb-unsaved-tokens` | [Streaming checkpoint re-arm can absorb unsaved tokens](open/chat-pipeline/streaming-checkpoint-rearm-can-absorb-unsaved-tokens.md) | Open | delta audit DA-8 |
| `FND-terminal-job-recovery-uses-stale-message-index` | [Terminal job recovery can overwrite a newer generation by stale index](open/chat-pipeline/terminal-job-recovery-uses-stale-message-index.md) | Open | delta audit DA-6 |

### client storage

| ID | Finding | Status | Source |
|---|---|---|---|
| `FND-build-mismatch-reload-can-discard-composer-draft` | [Build-mismatch reload can discard an undurable composer draft](open/client-storage/build-mismatch-reload-can-discard-composer-draft.md) | Open | delta audit DA-12 |
| `FND-draft-save-failures-have-no-retry-or-signal` | [Draft-save failures have no retry or user signal](open/client-storage/draft-save-failures-have-no-retry-or-signal.md) | Open | delta audit DA-9 |

### media and translation

| ID | Finding | Status | Source |
|---|---|---|---|
| `FND-interrupted-inlay-migration-discards-the-source-row` | [A crash during inlay migration can discard inlay metadata](open/media-translation/interrupted-inlay-migration-discards-the-source-row.md) | Open | 2026-07 data-loss audit |

### model providers

| ID | Finding | Status | Source |
|---|---|---|---|
| `FND-gemini-streaming-signature-save-is-fire-and-forget` | [Gemini cross-turn signature persistence is disconnected](open/model-providers/gemini-streaming-signature-save-is-fire-and-forget.md) | Open | delta audit DA-11 |

### operations and coverage

| ID | Finding | Status | Source |
|---|---|---|---|
| `FND-real-upstream-backup-fixture-skipped` | [Real upstream backup tests silently skip without a local fixture](open/operations-coverage/real-upstream-backup-fixture-skipped.md) | Open | 2026-07 compatibility investigation |

### plugin storage

| ID | Finding | Status | Source |
|---|---|---|---|
| `FND-recovery-use-inline-cannot-serialize-lossless-values` | [Plugin recovery offers an inline repair it cannot serialize](open/plugin-storage/recovery-use-inline-cannot-serialize-lossless-values.md) | Open | delta audit DA-15 |
| `FND-sparse-array-holes-densified` | [Sparse-array holes are densified in plugin-storage transitions and snapshots](open/plugin-storage/sparse-array-holes-densified.md) | Open | delta audit DA-14 |
| `FND-v2-plugin-storage-live-aliases` | [V2 storage assignments now always detach caller aliases](open/plugin-storage/v2-plugin-storage-live-aliases.md) | Open | 2026-07 compatibility investigation |

### scripting and extensions

| ID | Finding | Status | Source |
|---|---|---|---|
| `FND-callback-bridge-skips-stream-transfer-and-remote-class-serialization` | [Callback bridge skips deep stream transfer and remote-class serialization](open/scripting-extensions/callback-bridge-skips-stream-transfer-and-remote-class-serialization.md) | Open | 2026-07 data-loss audit |
| `FND-lua-local-lore-upsert-is-discarded` | [Lua local-lore upserts are discarded in non-display trigger modes](open/scripting-extensions/lua-local-lore-upsert-is-discarded.md) | Open | delta audit DA-10 |

### server backend

| ID | Finding | Status | Source |
|---|---|---|---|
| `FND-sidecar-databases-use-normal-wal-without-shutdown-drain` | [Sidecar databases use NORMAL WAL without a shutdown drain](open/server-backend/sidecar-databases-use-normal-wal-without-shutdown-drain.md) | Open | delta audit DA-7 |
| `FND-full-write-etag-does-not-cover-chat-rows` | [The full-write ETag does not cover externalized chat rows](open/server-backend/full-write-etag-does-not-cover-chat-rows.md) | Open | 2026-07 data-loss audit |

## Accepted decisions and limitations

| Decision | Owner | Source |
|---|---|---|
| [Cloudflare Quick Tunnel UI and API were removed](decisions/cloudflare-quick-tunnel-removed.md) | server backend | 2026-07 compatibility investigation |
| [Custom hub proxy targets are now rejected](decisions/hub-proxy-custom-targets-rejected.md) | server backend | 2026-07 compatibility investigation |
| [DB-only snapshots do not preserve assets](decisions/db-only-snapshots-exclude-assets.md) | backup and recovery | 2026-07 data-loss audit |
| [Remote plain-HTTP deployments no longer boot](decisions/remote-http-requires-explicit-override.md) | server backend | 2026-07 compatibility investigation |
| [The generic HOST environment variable now changes server binding](decisions/generic-host-controls-listen-address.md) | server backend | 2026-07 compatibility investigation |

## Active audit and remediation programs

- [2026-08 performance remediation](programs/performance-2026-08/README.md)

Completed programs and source reports are indexed in
[`.archived-docs/`](../../.archived-docs/README.md).
