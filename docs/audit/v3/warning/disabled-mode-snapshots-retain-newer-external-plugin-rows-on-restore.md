# Disabled-mode snapshots retain newer external plugin rows on restore

- Status: Open
- Severity: Medium
- Lens: L3, D1, D3
- Area: Area 8 — mode matrix and round trips
- Affected code: `src/ts/plugins/pluginSaveStorage.ts:303`, `server/node/server.cjs:4349`, `server/node/server.cjs:355`, `server/node/streamRisuSave.cjs:114`, `server/node/streamRisuSave.cjs:132`, `server/node/server.cjs:2373`, `server/node/server.cjs:2433`, `src/ts/plugins/pluginSaveStorage.ts:263`

## Risk

On optimized-to-inline transition, the client correctly commits inline values
before deleting external rows. A cooldown-eligible automatic snapshot can occur
in that window and folds those still-present rows, but writes the ownership marker
only when the now-disabled flag is true. The snapshot is therefore unmarked.

Restoring it later over newer optimized state does not clear current external
rows. On boot, false-mode reconciliation reads those surviving newer rows over
the older inline snapshot values. Restore reports success while plugin save state
does not roll back—the exact enabled-to-disabled transition risk.

## Required fix and coverage

Mark every snapshot that folded a plugin-row set, independent of the database
flag, or record explicit exact-set ownership. Restore must clear current prefixes
before applying that snapshot.

Cover legacy and streaming restoration of a just-disabled snapshot over later
optimized values and metadata.
