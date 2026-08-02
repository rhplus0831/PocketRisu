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

/**
 * The original whole-graph conflict merge. Kept only as a differential oracle
 * for the data-loss-sensitive in-place implementation below.
 *
 * @internal
 */
export function mergeTrackedDatabaseOnConflictLegacyForTests(
    latest: Database,
    local: Database,
    toSave: toSaveType,
    knownChatIdsByCharacter?: ReadonlyMap<string, ReadonlySet<string>>,
): Database {
    const merged = cloneDatabaseState(latest);
    const localClone = cloneDatabaseState(local);

    if (toSave.root) {
        for (const key in localClone) {
            if (
                key !== "characters" && key !== "botPresets" && key !== "modules"
                && key !== "plugins" && key !== "pluginCustomStorage"
                && key !== "pluginStorageMeta"
            ) {
                merged[key] = cloneDatabaseField(key, localClone[key]);
            }
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
    const trackedChatIdsByCharacter = new Map<string, Set<string>>();
    for (const trackedChat of toSave.chat) {
        const [chaId, chatId] = trackedChat ?? [];
        if (!chaId || !chatId) continue;
        const trackedIds = trackedChatIdsByCharacter.get(chaId) ?? new Set<string>();
        trackedIds.add(chatId);
        trackedChatIdsByCharacter.set(chaId, trackedIds);
    }
    const mergedCharacters = Array.isArray(merged.characters) ? merged.characters : [];
    const localCharacters = Array.isArray(localClone.characters) ? localClone.characters : [];

    // Character tracking has no field-level diff, but the committed chat-ID
    // baseline still distinguishes an intentional local deletion from a chat
    // added concurrently on the server. Preserve the latter; when that
    // baseline is unavailable, fail conservatively toward preserving data.
    for (const charId of trackedCharIds) {
        const localChar = localCharacters.find(character => character?.chaId === charId);
        const mergedIndex = mergedCharacters.findIndex(character => character?.chaId === charId);
        if (localChar) {
            const clonedLocalChar = safeStructuredClone(localChar);
            const latestChats = mergedIndex >= 0 && Array.isArray(mergedCharacters[mergedIndex]?.chats)
                ? mergedCharacters[mergedIndex].chats
                : [];
            const localChatIds = new Set(
                (clonedLocalChar.chats ?? []).map(chat => chat?.id).filter(Boolean),
            );
            const previouslyKnownChatIds = knownChatIdsByCharacter?.get(charId);
            clonedLocalChar.chats = [
                ...(clonedLocalChar.chats ?? []),
                ...latestChats
                    .filter(chat => chat?.id
                        && !localChatIds.has(chat.id)
                        // Missing chats that were already in the client's
                        // committed baseline are intentional local deletions.
                        // Preserve only chats that arrived on the server after
                        // that baseline (or conservatively all when unavailable).
                        && (!previouslyKnownChatIds || !previouslyKnownChatIds.has(chat.id)))
                    .map(chat => safeStructuredClone(chat)),
            ];
            if (mergedIndex >= 0) mergedCharacters[mergedIndex] = clonedLocalChar;
            else mergedCharacters.push(clonedLocalChar);
        } else if (mergedIndex >= 0) {
            mergedCharacters.splice(mergedIndex, 1);
        }
    }

    // Chat-body tracking is narrower than character tracking. Overlay only
    // those explicit chats so a local edit cannot remove or replace unrelated
    // chats that arrived in the authoritative database.
    for (const [charId, trackedChatIds] of trackedChatIdsByCharacter) {
        if (trackedCharIds.has(charId)) continue;
        const localChar = localCharacters.find(character => character?.chaId === charId);
        let mergedChar = mergedCharacters.find(character => character?.chaId === charId);
        if (!localChar) continue;
        if (!mergedChar) {
            mergedChar = safeStructuredClone(localChar);
            mergedCharacters.push(mergedChar);
            continue;
        }
        const mergedChats = Array.isArray(mergedChar.chats) ? mergedChar.chats : [];
        const localChats = Array.isArray(localChar.chats) ? localChar.chats : [];
        for (const chatId of trackedChatIds) {
            const localChat = localChats.find(chat => chat?.id === chatId);
            if (!localChat) continue;
            const mergedChatIndex = mergedChats.findIndex(chat => chat?.id === chatId);
            const clonedLocalChat = safeStructuredClone(localChat);
            if (mergedChatIndex >= 0) mergedChats[mergedChatIndex] = clonedLocalChat;
            else mergedChats.push(clonedLocalChat);
        }
        mergedChar.chats = mergedChats;
    }
    merged.characters = mergedCharacters;
    return merged;
}

const GENERIC_ROOT_MERGE_EXCLUSIONS = new Set<PropertyKey>([
    "characters",
    "botPresets",
    "modules",
    "plugins",
    "pluginCustomStorage",
    "pluginStorageMeta",
    // These fields select an optimized plugin-storage publication and move
    // only through its generation-fenced CAS protocol. A generic conflict
    // rebase must retain the freshly read authoritative values.
    "optimizePluginMemory",
    "pluginStorageGeneration",
    "pluginStorageFolded",
]);

/**
 * Overlay only conservatively tracked local branches onto the freshly decoded
 * authoritative graph. `latest` becomes the one working graph; clean server
 * branches retain their identity and only dirty local branches are cloned.
 */
export function mergeTrackedDatabaseOnConflict(
    latest: Database,
    local: Database,
    toSave: toSaveType,
    knownChatIdsByCharacter?: ReadonlyMap<string, ReadonlySet<string>>,
): Database {
    if (toSave.root) {
        for (const key in local) {
            if (!GENERIC_ROOT_MERGE_EXCLUSIONS.has(key)) {
                latest[key] = cloneDatabaseField(key, local[key]);
            }
        }
    }

    if (toSave.botPreset) {
        latest.botPresets = safeStructuredClone(local.botPresets);
        latest.botPresetsId = local.botPresetsId;
    }
    if (toSave.modules) latest.modules = safeStructuredClone(local.modules);
    if (toSave.plugins) latest.plugins = safeStructuredClone(local.plugins);
    if (toSave.pluginCustomStorage) {
        latest.pluginCustomStorage = cloneDatabasePluginStorageRecord(
            local.pluginCustomStorage,
        );
        if (Object.hasOwn(local, "pluginStorageMeta")
            && local.pluginStorageMeta !== undefined) {
            latest.pluginStorageMeta = cloneDatabasePluginStorageRecord(
                local.pluginStorageMeta,
            );
        } else {
            delete latest.pluginStorageMeta;
        }
    }

    const trackedCharIds = new Set<string>(toSave.character.filter(Boolean));
    const trackedChatIdsByCharacter = new Map<string, Set<string>>();
    for (const trackedChat of toSave.chat) {
        const [chaId, chatId] = trackedChat ?? [];
        if (!chaId || !chatId) continue;
        const trackedIds = trackedChatIdsByCharacter.get(chaId) ?? new Set<string>();
        trackedIds.add(chatId);
        trackedChatIdsByCharacter.set(chaId, trackedIds);
    }
    const authoritativeCharacters = Array.isArray(latest.characters) ? latest.characters : [];
    const localCharacters = Array.isArray(local.characters) ? local.characters : [];

    for (const charId of trackedCharIds) {
        const localChar = localCharacters.find(character => character?.chaId === charId);
        const authoritativeIndex = authoritativeCharacters.findIndex(
            character => character?.chaId === charId,
        );
        if (localChar) {
            const clonedLocalChar = safeStructuredClone(localChar);
            const authoritativeChats = authoritativeIndex >= 0
                && Array.isArray(authoritativeCharacters[authoritativeIndex]?.chats)
                ? authoritativeCharacters[authoritativeIndex].chats
                : [];
            const localChatIds = new Set(
                (clonedLocalChar.chats ?? []).map(chat => chat?.id).filter(Boolean),
            );
            const previouslyKnownChatIds = knownChatIdsByCharacter?.get(charId);
            clonedLocalChar.chats = [
                ...(clonedLocalChar.chats ?? []),
                ...authoritativeChats
                    .filter(chat => chat?.id
                        && !localChatIds.has(chat.id)
                        && (!previouslyKnownChatIds || !previouslyKnownChatIds.has(chat.id)))
                    .map(chat => safeStructuredClone(chat)),
            ];
            if (authoritativeIndex >= 0) {
                authoritativeCharacters[authoritativeIndex] = clonedLocalChar;
            } else {
                authoritativeCharacters.push(clonedLocalChar);
            }
        } else if (authoritativeIndex >= 0) {
            authoritativeCharacters.splice(authoritativeIndex, 1);
        }
    }

    for (const [charId, trackedChatIds] of trackedChatIdsByCharacter) {
        if (trackedCharIds.has(charId)) continue;
        const localChar = localCharacters.find(character => character?.chaId === charId);
        let authoritativeChar = authoritativeCharacters.find(
            character => character?.chaId === charId,
        );
        if (!localChar) continue;
        if (!authoritativeChar) {
            authoritativeChar = safeStructuredClone(localChar);
            authoritativeCharacters.push(authoritativeChar);
            continue;
        }
        const authoritativeChats = Array.isArray(authoritativeChar.chats)
            ? authoritativeChar.chats
            : [];
        const localChats = Array.isArray(localChar.chats) ? localChar.chats : [];
        for (const chatId of trackedChatIds) {
            const localChat = localChats.find(chat => chat?.id === chatId);
            if (!localChat) continue;
            const authoritativeChatIndex = authoritativeChats.findIndex(
                chat => chat?.id === chatId,
            );
            const clonedLocalChat = safeStructuredClone(localChat);
            if (authoritativeChatIndex >= 0) {
                authoritativeChats[authoritativeChatIndex] = clonedLocalChat;
            } else {
                authoritativeChats.push(clonedLocalChat);
            }
        }
        authoritativeChar.chats = authoritativeChats;
    }
    latest.characters = authoritativeCharacters;
    return latest;
}
