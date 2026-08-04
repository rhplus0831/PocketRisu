# Upstream-compatible backup drops live inlays but keeps their chat references

- Status: Open
- Owner: backup and recovery
- Source: [2026-07 data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium
- Lens: L3, D3
- Area: Area 8 — mode matrix and round trips
- Affected code: `server/node/server.cjs:4715`, `server/node/server.cjs:4726`, `server/node/server.cjs:4752`, `server/node/server.cjs:4759`, `src/ts/process/scriptings.ts:374`, `/home/codex/Risuai/src/ts/drive/backuplocal.ts:502`, `/home/codex/Risuai/src/ts/drive/backuplocal.ts:558`, `/home/codex/Risuai/src/ts/process/files/inlays.ts:30`

## Risk

The upstream target folds chats and plugin rows into `database.risudat` but
explicitly omits filesystem inlays, sidecars, and `inlay_meta/` rows. Chat text
is preserved unchanged, including inlay and signature tokens. Upstream's loader
maps other archive members to flat assets while its inlay store is separate, so
passing PocketRisu namespaces through would not restore them either.

The archive is structurally loadable but semantically contains dangling image,
audio, video, or provider-signature references. A round trip through upstream
cannot recover the omitted bytes or metadata.

## Required fix and coverage

Warn before download and define a real compatibility transform or companion
upstream importer. At minimum, scan the folded database and emit a machine-readable
manifest of every omitted referenced inlay.

Execute an inlay-bearing archive through the real upstream loader and back.
