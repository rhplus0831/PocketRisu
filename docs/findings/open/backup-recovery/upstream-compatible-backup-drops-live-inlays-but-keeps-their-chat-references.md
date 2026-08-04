# Upstream-compatible backup drops live inlays but keeps their chat references

- Status: Open
- Owner: backup and recovery
- Source: [2026-07 data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Low
- Lens: L3, D3
- Area: Area 8 — mode matrix and round trips
- Affected code: `server/node/server.cjs:4715`, `server/node/server.cjs:4726`, `server/node/server.cjs:4752`, `server/node/server.cjs:4759`, `src/ts/process/scriptings.ts:374`, `/home/codex/Risuai/src/ts/drive/backuplocal.ts:502`, `/home/codex/Risuai/src/ts/drive/backuplocal.ts:558`, `/home/codex/Risuai/src/ts/process/files/inlays.ts:30`
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../../../.archived-docs/findings/2026-08-revalidation/README.md)

## Risk

The upstream target folds chats and plugin rows into `database.risudat` but
deliberately omits filesystem inlays, sidecars, and `inlay_meta/` rows. Chat
text is preserved unchanged, including inlay and signature tokens, so the
archive is structurally loadable but semantically contains dangling image,
audio, video, or provider-signature references that a round trip through
upstream cannot recover.

This is a warned, intentional limitation, not a silent one: an explicit
pre-download confirmation naming the inlay exclusion has shipped with the
feature since `5e461a0d` (the original "no warning shown" framing was wrong
even at audit time), and the structure documentation records it as an
upstream-target limitation. The unimplemented residue is the per-export scan
and machine-readable manifest of omitted referenced inlays, a compatibility
transform or companion importer, and warning text covering non-image inlay
types.

## Required fix and coverage

Scan the folded database at export time and emit a machine-readable manifest
of every omitted referenced inlay; extend the warning to non-image inlay
types; optionally provide a compatibility transform or companion upstream
importer.

Execute an inlay-bearing archive through the real upstream loader and back.
