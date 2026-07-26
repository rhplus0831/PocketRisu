// Best-effort "origin plugin" tagging for plugin storage.
//
// Plugin data lives in a single global namespace with no record of which
// plugin wrote which key. We cannot reconstruct ownership for existing data,
// but for NEW writes the V3 API does know the calling plugin. This module
// stores that origin as a SIDECAR — a separate map keyed by storage key —
// alongside the value, never wrapping the value itself. Reads of the actual
// value are untouched, so existing plugins keep working.
//
// The sidecar must live in the SAME backend as the data it describes, so its
// lifecycle/travel matches (save → travels with the save; local/idb →
// device-local). Hence one store per backend:
//   - save  → db.pluginStorageMeta, or pluginsave-meta/ KV entries while
//             optimizePluginMemory is enabled
//   - local → a single localStorage JSON blob (not safe_plugin_* prefixed, so
//             it never shows up in the viewer's local listing)
//   - idb   → persistentKv under a dedicated prefix (separate from the data
//             prefix, so it never shows up in the viewer's idb listing)

import {
    listPersistentKeys,
    makeEncodedStorageKey,
    decodeStorageKeyComponent,
    readPersistentJson,
    writePersistentJson,
    removePersistentKey,
    clearPersistentPrefix,
} from "../storage/persistentKv";
import { throwIfAborted } from "../storage/abort";
import {
    clearPluginSaveStorageOwners,
    getPluginSaveStorageOwners,
    removePluginSaveStorageOwner,
    setPluginSaveStorageOwner,
} from "./pluginSaveStorage";
import {
    copyPluginStorageRecord,
    createPluginStorageRecord,
    definePluginStorageRecordValue,
} from "./pluginStorageRecord";

export type PluginStorageBackend = "save" | "local" | "idb";
export interface PluginOwnerRecord {
    plugin: string;
    updatedAt: number;
    /** AA3 opaque incarnation and transaction generation for save storage. */
    revision?: string;
    generation?: string;
}

const LOCAL_META_KEY = "risu_plugin_storage_owners";
const IDB_META_PREFIX = "cache/plugin-storage-meta/";

// ── local backend blob helpers ──────────────────────────────────────────────
function readLocalMeta(): Record<string, PluginOwnerRecord> {
    try {
        return copyPluginStorageRecord(
            JSON.parse(localStorage.getItem(LOCAL_META_KEY) || "{}"),
        );
    } catch {
        return createPluginStorageRecord();
    }
}

function writeLocalMeta(map: Record<string, PluginOwnerRecord>): void {
    try {
        localStorage.setItem(LOCAL_META_KEY, JSON.stringify(map));
    } catch {}
}

// ── write side (called from V3 storage wrappers) ────────────────────────────
export function recordOwner(
    backend: PluginStorageBackend,
    key: string,
    plugin: string,
    signal?: AbortSignal | null,
): void | Promise<void> {
    throwIfAborted(signal);
    if (!plugin) return;
    const record: PluginOwnerRecord = { plugin, updatedAt: Date.now() };
    if (backend === "save") {
        return setPluginSaveStorageOwner(key, plugin, signal);
    }
    if (backend === "local") {
        const map = readLocalMeta();
        definePluginStorageRecordValue(map, key, record);
        writeLocalMeta(map);
        return;
    }
    const storageKey = makeEncodedStorageKey(IDB_META_PREFIX, key);
    return signal
        ? writePersistentJson(storageKey, record, signal)
        : writePersistentJson(storageKey, record);
}

export function removeOwner(
    backend: PluginStorageBackend,
    key: string,
    signal?: AbortSignal | null,
): void | Promise<void> {
    throwIfAborted(signal);
    if (backend === "save") {
        return removePluginSaveStorageOwner(key, signal);
    }
    if (backend === "local") {
        const map = readLocalMeta();
        delete map[key];
        writeLocalMeta(map);
        return;
    }
    const storageKey = makeEncodedStorageKey(IDB_META_PREFIX, key);
    return signal
        ? removePersistentKey(storageKey, signal)
        : removePersistentKey(storageKey);
}

export function clearOwners(
    backend: PluginStorageBackend,
    signal?: AbortSignal | null,
): void | Promise<void> {
    throwIfAborted(signal);
    if (backend === "save") {
        return clearPluginSaveStorageOwners(signal);
    }
    if (backend === "local") {
        writeLocalMeta(createPluginStorageRecord());
        return;
    }
    return signal
        ? clearPersistentPrefix(IDB_META_PREFIX, signal)
        : clearPersistentPrefix(IDB_META_PREFIX);
}

// ── read side (called from the viewer) ──────────────────────────────────────
// Returns a { storageKey → plugin name } map for the given backend.
export async function getOwners(
    backend: PluginStorageBackend,
    signal?: AbortSignal | null,
): Promise<Record<string, string>> {
    throwIfAborted(signal);
    const out = createPluginStorageRecord<string>();
    if (backend === "save") {
        return getPluginSaveStorageOwners(signal);
    }
    if (backend === "local") {
        const map = readLocalMeta();
        for (const key of Object.keys(map)) {
            if (map[key]?.plugin) definePluginStorageRecordValue(out, key, map[key].plugin);
        }
        return out;
    }
    const storageKeys = signal
        ? await listPersistentKeys(IDB_META_PREFIX, signal)
        : await listPersistentKeys(IDB_META_PREFIX);
    for (const fullKey of storageKeys) {
        throwIfAborted(signal);
        const encoded = fullKey.slice(IDB_META_PREFIX.length, -".json".length);
        const rawKey = decodeStorageKeyComponent(encoded);
        const record = signal
            ? await readPersistentJson<PluginOwnerRecord>(fullKey, { signal })
            : await readPersistentJson<PluginOwnerRecord>(fullKey);
        if (record?.plugin) definePluginStorageRecordValue(out, rawKey, record.plugin);
    }
    return out;
}
