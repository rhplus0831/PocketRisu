# 2026-07 compatibility investigation archive

The [source index](SOURCE-INDEX.md) compared `main` with the early `serve`
branch and produced 46 reports. This archive retains 35 reports marked fixed and
the three source reports superseded by merged canonical findings.

The still-actionable compatibility work moved into the owner-based
[`docs/findings/open/`](../../../docs/findings/open/) catalog. Deliberate
deployment and proxy policy changes moved to
[`decisions/`](../../../docs/findings/decisions/).

## Consolidated completed work

| Resolution family | Shared contract | Source reports |
|---|---|---|
| Main-target rollback export | One pinned, non-destructive `target=main` export now folds chat rows and preserves compatible asset/inlay bytes for a fresh main directory. | [Chat rows](reports/chat-row-migration-breaks-main-rollback.md), [assets](reports/asset-externalization-breaks-main-rollback.md), canonical [backup and recovery](../../../docs/structure/backup-recovery.md) |
| Plugin lifecycle compatibility | Bounded startup, load, unload, callback, and timeout behavior replaced several unrelated hangs and false-ready states. | [Bridge deadline](reports/plugin-bridge-residual-30-minute-deadline.md), [load readiness](reports/plugin-loadplugins-readiness.md), [V2 unload](reports/v2-unload-can-wedge-plugin-lifecycle.md), [V3 startup](reports/v3-top-level-startup-barrier.md) |
| Plugin-storage value compatibility | Rich values, key policy, enumeration order, limits, viewer support, and reverse transitions now have explicit compatibility contracts. | [Rich values](reports/v2-plugin-storage-rich-values.md), [legacy keys](reports/legacy-plugin-storage-key-compatibility.md), [enumeration](reports/plugin-storage-enumeration-order.md), [transition](reports/optimized-plugin-storage-transition-lock-in.md) |
| Bounded import and restore | Import size and deadline mismatches were aligned with the formats the server itself emits. | [RisuSave limit](reports/legacy-risusave-64mib-import-cap.md), [opaque rows](reports/save-folder-opaque-row-32mib-cap.md), [restore deadline](reports/save-folder-restore-fixed-deadline.md) |
