import isEqual from "lodash/isEqual";
import type { Database } from "../storage/database.svelte";
import type { toSaveType } from "../storage/risuSave";

type PluginStorageState = Pick<Database, "pluginCustomStorage" | "pluginStorageMeta">;

/**
 * saveDb starts after bootstrap plugins have loaded. Detect plugin writes made
 * before its reactive effects can establish their initial (non-dirty) state.
 */
export function capturePreTrackingPluginStorageChanges(
    changeTracker: Pick<toSaveType, "pluginCustomStorage">,
    current: Partial<PluginStorageState>,
    persistedBaseline: Partial<PluginStorageState> | null | undefined,
): boolean {
    if (!persistedBaseline) return false;

    const changed = !isEqual(
        current.pluginCustomStorage ?? {},
        persistedBaseline.pluginCustomStorage ?? {},
    ) || !isEqual(
        current.pluginStorageMeta ?? {},
        persistedBaseline.pluginStorageMeta ?? {},
    );
    if (changed) changeTracker.pluginCustomStorage = true;
    return changed;
}
