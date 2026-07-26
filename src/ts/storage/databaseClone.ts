import { safeStructuredClone } from "../polyfill";
import type { toSaveType } from "./risuSave";
import type { Database } from "./database.svelte";
import {
    createDatabasePluginStorageRecord,
    definePluginStorageRecordValue,
    getPluginStorageRecordKeys,
    hasPluginStorageRecordValue,
} from "../plugins/pluginStorageRecord";

function clonePluginStorageValue<T>(value: T, seen = new WeakMap<object, unknown>()): T {
    if (value === null || typeof value !== "object") return value;
    const object = value as object;
    const cached = seen.get(object);
    if (cached !== undefined) return cached as T;

    if (value instanceof Date) return new Date(value.getTime()) as T;
    if (value instanceof RegExp) return new RegExp(value.source, value.flags) as T;
    if (value instanceof ArrayBuffer) return value.slice(0) as T;
    if (ArrayBuffer.isView(value)) {
        return safeStructuredClone(value);
    }
    if (value instanceof Map || value instanceof Set) {
        return safeStructuredClone(value);
    }

    if (Array.isArray(value)) {
        const clone: unknown[] = new Array(value.length);
        seen.set(object, clone);
        for (const key of Object.keys(value)) {
            definePluginStorageRecordValue<unknown>(
                clone as unknown as Record<string, unknown>,
                key,
                clonePluginStorageValue((value as unknown as Record<string, unknown>)[key], seen),
            );
        }
        return clone as T;
    }

    const clone = createDatabasePluginStorageRecord<unknown>();
    seen.set(object, clone);
    for (const key of getPluginStorageRecordKeys(value as Record<string, unknown>)) {
        definePluginStorageRecordValue(
            clone,
            key,
            clonePluginStorageValue((value as Record<string, unknown>)[key], seen),
        );
    }
    return clone as T;
}

export function cloneDatabasePluginStorageRecord<T>(
    source: Record<string, T> | null | undefined,
): Record<string, T> {
    return clonePluginStorageValue(
        source ?? createDatabasePluginStorageRecord<T>(),
    );
}

export function cloneDatabaseField<T>(key: PropertyKey, value: T): T {
    return key === "pluginCustomStorage" || key === "pluginStorageMeta"
        ? cloneDatabasePluginStorageRecord(value as Record<string, unknown>) as T
        : safeStructuredClone(value);
}

/**
 * Clone a database graph while repairing the two plugin maps from the live
 * source. Svelte snapshots and rfdc both omit an own `__proto__`, so generic
 * cloning alone cannot be used for patch/save baselines.
 */
export function cloneDatabaseState<T extends Partial<Database>>(database: T): T {
    const clone = safeStructuredClone(database) as T;
    for (const key of ["pluginCustomStorage", "pluginStorageMeta"] as const) {
        if (hasPluginStorageRecordValue(database as Record<string, unknown>, key)) {
            definePluginStorageRecordValue<unknown>(
                clone as Record<string, unknown>,
                key,
                key === "pluginStorageMeta" && database[key] === undefined
                    ? undefined
                    : cloneDatabasePluginStorageRecord(database[key] as Record<string, unknown>),
            );
        } else {
            delete (clone as Record<string, unknown>)[key];
        }
    }
    return clone;
}

/** Pure conflict merge used by the ETag rebase path. */
export function mergeTrackedDatabaseOnConflict(
    latest: Database,
    local: Database,
    toSave: toSaveType,
): Database {
    const merged = cloneDatabaseState(latest);
    const localClone = cloneDatabaseState(local);

    for (const key in localClone) {
        if (
            key !== "characters" && key !== "botPresets" && key !== "modules"
            && key !== "plugins" && key !== "pluginCustomStorage"
            && key !== "pluginStorageMeta"
        ) {
            merged[key] = cloneDatabaseField(key, localClone[key]);
        }
    }

    if (toSave.botPreset) {
        merged.botPresets = safeStructuredClone(localClone.botPresets);
        merged.botPresetsId = localClone.botPresetsId;
    }
    if (toSave.modules) merged.modules = safeStructuredClone(localClone.modules);
    if (toSave.plugins) merged.plugins = safeStructuredClone(localClone.plugins);
    if (toSave.pluginCustomStorage) {
        merged.pluginCustomStorage = cloneDatabasePluginStorageRecord(
            localClone.pluginCustomStorage,
        );
        if (Object.hasOwn(localClone, "pluginStorageMeta")
            && localClone.pluginStorageMeta !== undefined) {
            merged.pluginStorageMeta = cloneDatabasePluginStorageRecord(
                localClone.pluginStorageMeta,
            );
        } else {
            delete merged.pluginStorageMeta;
        }
    }

    const trackedCharIds = new Set<string>(toSave.character.filter(Boolean));
    for (const trackedChat of toSave.chat) {
        if (trackedChat?.[0]) trackedCharIds.add(trackedChat[0]);
    }
    const mergedCharacters = Array.isArray(merged.characters) ? merged.characters : [];
    const localCharacters = Array.isArray(localClone.characters) ? localClone.characters : [];
    for (const charId of trackedCharIds) {
        const localChar = localCharacters.find(character => character?.chaId === charId);
        const mergedIndex = mergedCharacters.findIndex(character => character?.chaId === charId);
        if (localChar) {
            const clonedLocalChar = safeStructuredClone(localChar);
            if (mergedIndex >= 0) mergedCharacters[mergedIndex] = clonedLocalChar;
            else mergedCharacters.push(clonedLocalChar);
        } else if (mergedIndex >= 0) {
            mergedCharacters.splice(mergedIndex, 1);
        }
    }
    merged.characters = mergedCharacters;
    return merged;
}
