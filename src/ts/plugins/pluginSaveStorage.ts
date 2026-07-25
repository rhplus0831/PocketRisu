import { getDatabase, type Database } from "../storage/database.svelte";
import {
    clearPersistentPrefix,
    decodeStorageKeyComponent,
    listPersistentKeys,
    makeEncodedStorageKey,
    readPersistentJson,
    removePersistentKey,
    writePersistentJson,
} from "../storage/persistentKv";

export const PLUGIN_SAVE_PREFIX = "pluginsave/";
export const PLUGIN_SAVE_META_PREFIX = "pluginsave-meta/";

let storageOperationQueue: Promise<unknown> = Promise.resolve();

/**
 * Serialize mode transitions with V3/viewer storage operations. V2 calls are
 * synchronous and cannot join this queue, which is why the UI forbids this
 * mode while an enabled V2/V2.1 plugin exists.
 */
export function withPluginSaveStorageLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = storageOperationQueue.then(operation, operation);
    storageOperationQueue = run.then(() => undefined, () => undefined);
    return run;
}

function decodeListedStorageKey(fullKey: string, prefix: string): string | null {
    if (!fullKey.startsWith(prefix) || !fullKey.endsWith(".json")) return null;
    const encoded = fullKey.slice(prefix.length, -".json".length);
    return decodeStorageKeyComponent(encoded);
}

async function listDecodedStorageKeys(prefix: string): Promise<string[]> {
    const storageKeys = await listPersistentKeys(prefix);
    const keys: string[] = [];
    for (const storageKey of storageKeys) {
        const decoded = decodeListedStorageKey(storageKey, prefix);
        if (decoded !== null) keys.push(decoded);
    }
    return keys;
}

export async function readExternalizedPluginStorage(): Promise<{
    values: Record<string, unknown>;
    meta: NonNullable<Database["pluginStorageMeta"]>;
}> {
    return withPluginSaveStorageLock(async () => {
        const [listedValueKeys, listedMetaKeys] = await Promise.all([
            listPersistentKeys(PLUGIN_SAVE_PREFIX),
            listPersistentKeys(PLUGIN_SAVE_META_PREFIX),
        ]);
        const values: Record<string, unknown> = {};
        const meta: NonNullable<Database["pluginStorageMeta"]> = {};

        for (const storageKey of listedValueKeys) {
            const key = decodeListedStorageKey(storageKey, PLUGIN_SAVE_PREFIX);
            if (key === null) continue;
            values[key] = await readPersistentJson(storageKey, { cached: true });
        }
        for (const storageKey of listedMetaKeys) {
            const key = decodeListedStorageKey(storageKey, PLUGIN_SAVE_META_PREFIX);
            if (key === null) continue;
            meta[key] = await readPersistentJson(storageKey);
        }

        return { values, meta };
    });
}

export async function getPluginSaveStorageItem<T>(key: string): Promise<T | null> {
    return withPluginSaveStorageLock(async () => {
        const db = getDatabase();
        if (!db.optimizePluginMemory) {
            const value = db.pluginCustomStorage?.[key];
            if (value === undefined || value === null) return null;
            // db is reactive $state, so inline values are Svelte proxies.
            // postMessage/structuredClone reject proxies (DataCloneError), and
            // this value crosses the V3 iframe bridge — return the same plain
            // JSON round-trip the optimized branch produces.
            return JSON.parse(JSON.stringify(value)) as T;
        }
        return await readPersistentJson<T>(makeEncodedStorageKey(PLUGIN_SAVE_PREFIX, key), { cached: true });
    });
}

export async function setPluginSaveStorageItem<T>(key: string, value: T): Promise<void> {
    await withPluginSaveStorageLock(async () => {
        const db = getDatabase();
        if (!db.optimizePluginMemory) {
            db.pluginCustomStorage ??= {};
            db.pluginCustomStorage[key] = value;
            return;
        }
        await writePersistentJson(makeEncodedStorageKey(PLUGIN_SAVE_PREFIX, key), value);
    });
}

export async function removePluginSaveStorageItem(key: string): Promise<void> {
    await withPluginSaveStorageLock(async () => {
        const db = getDatabase();
        if (!db.optimizePluginMemory) {
            if (db.pluginCustomStorage) delete db.pluginCustomStorage[key];
            return;
        }
        await removePersistentKey(makeEncodedStorageKey(PLUGIN_SAVE_PREFIX, key));
    });
}

export async function clearPluginSaveStorage(): Promise<void> {
    await withPluginSaveStorageLock(async () => {
        const db = getDatabase();
        if (!db.optimizePluginMemory) {
            db.pluginCustomStorage = {};
            return;
        }
        await clearPersistentPrefix(PLUGIN_SAVE_PREFIX);
    });
}

export async function getPluginSaveStorageKeys(): Promise<string[]> {
    return withPluginSaveStorageLock(async () => {
        const db = getDatabase();
        if (!db.optimizePluginMemory) {
            return Object.keys(db.pluginCustomStorage ?? {});
        }
        return await listDecodedStorageKeys(PLUGIN_SAVE_PREFIX);
    });
}

export async function getPluginSaveStorageKey(index: number): Promise<string | null> {
    const keys = await getPluginSaveStorageKeys();
    return keys[index] ?? null;
}

export async function getPluginSaveStorageLength(): Promise<number> {
    return (await getPluginSaveStorageKeys()).length;
}

export async function countExternalizedPluginStorageEntries(): Promise<number> {
    return withPluginSaveStorageLock(async () => {
        const [values, meta] = await Promise.all([
            listPersistentKeys(PLUGIN_SAVE_PREFIX),
            listPersistentKeys(PLUGIN_SAVE_META_PREFIX),
        ]);
        return values.length + meta.length;
    });
}

export interface PluginStorageReconcileProgress {
    direction: "externalize" | "internalize";
    completed: number;
    total: number;
}

export interface PluginStorageReconcileResult {
    direction: "externalize" | "internalize" | "none";
    values: number;
    meta: number;
}

interface ReconcileDependencies {
    getDatabase: () => Database;
    listPersistentKeys: typeof listPersistentKeys;
    readPersistentJson: typeof readPersistentJson;
    writePersistentJson: typeof writePersistentJson;
    removePersistentKey: typeof removePersistentKey;
    persistDatabase: () => Promise<void>;
}

export interface PluginStorageReconcileOptions {
    onProgress?: (progress: PluginStorageReconcileProgress) => void;
    /** Test/bootstrap injection. Normal UI calls use the immediate save path. */
    dependencies?: Partial<ReconcileDependencies>;
}

async function persistDatabaseImmediately(): Promise<void> {
    const { requestImmediateSave } = await import("../globalApi.svelte");
    await requestImmediateSave({ forceFullWrite: true });
}

/**
 * Move save-backed plugin values and their ownership sidecar to the backend
 * selected by db.optimizePluginMemory.
 *
 * Externalize: write every KV value before deleting its inline copy, then save.
 * Internalize: populate inline values, save the DB, then delete the KV copies.
 * Those orderings make a crash leave duplicates rather than lose the only copy.
 */
export async function reconcilePluginStorageMode(
    options: PluginStorageReconcileOptions = {},
): Promise<PluginStorageReconcileResult> {
    const deps: ReconcileDependencies = {
        getDatabase,
        listPersistentKeys,
        readPersistentJson,
        writePersistentJson,
        removePersistentKey,
        persistDatabase: persistDatabaseImmediately,
        ...options.dependencies,
    };

    return withPluginSaveStorageLock(async () => {
        const db = deps.getDatabase();

        if (db.optimizePluginMemory) {
            const valueEntries = Object.entries(db.pluginCustomStorage ?? {});
            const metaEntries = Object.entries(db.pluginStorageMeta ?? {});
            const total = valueEntries.length + metaEntries.length;
            if (total === 0) {
                return { direction: "none", values: 0, meta: 0 };
            }

            const destinationStorageKeys = new Set<string>();
            const prepareEntries = <T>(entries: Array<[string, T]>, prefix: string) => (
                entries.map(([key, value]) => {
                    const storageKey = makeEncodedStorageKey(prefix, key);
                    if (destinationStorageKeys.has(storageKey)) {
                        throw new Error(
                            `Plugin storage key collision while externalizing: ${JSON.stringify(key)}`,
                        );
                    }
                    destinationStorageKeys.add(storageKey);
                    return { key, storageKey, value };
                })
            );
            // Validate every destination before writing or deleting anything.
            const preparedValueEntries = prepareEntries(valueEntries, PLUGIN_SAVE_PREFIX);
            const preparedMetaEntries = prepareEntries(metaEntries, PLUGIN_SAVE_META_PREFIX);

            let completed = 0;
            for (const { key, storageKey, value } of preparedValueEntries) {
                // Inline wins if a previous partial run left a duplicate.
                await deps.writePersistentJson(storageKey, value);
                delete db.pluginCustomStorage[key];
                options.onProgress?.({
                    direction: "externalize",
                    completed: ++completed,
                    total,
                });
            }
            for (const { key, storageKey, value: record } of preparedMetaEntries) {
                await deps.writePersistentJson(storageKey, record);
                if (db.pluginStorageMeta) delete db.pluginStorageMeta[key];
                options.onProgress?.({
                    direction: "externalize",
                    completed: ++completed,
                    total,
                });
            }
            if (db.pluginStorageMeta && Object.keys(db.pluginStorageMeta).length === 0) {
                delete db.pluginStorageMeta;
            }

            await deps.persistDatabase();
            return {
                direction: "externalize",
                values: valueEntries.length,
                meta: metaEntries.length,
            };
        }

        const [listedValueKeys, listedMetaKeys] = await Promise.all([
            deps.listPersistentKeys(PLUGIN_SAVE_PREFIX),
            deps.listPersistentKeys(PLUGIN_SAVE_META_PREFIX),
        ]);
        const valueStorageKeys = listedValueKeys.filter(
            (key) => decodeListedStorageKey(key, PLUGIN_SAVE_PREFIX) !== null,
        );
        const metaStorageKeys = listedMetaKeys.filter(
            (key) => decodeListedStorageKey(key, PLUGIN_SAVE_META_PREFIX) !== null,
        );
        const total = valueStorageKeys.length + metaStorageKeys.length;
        if (total === 0) {
            return { direction: "none", values: 0, meta: 0 };
        }

        db.pluginCustomStorage ??= {};
        if (metaStorageKeys.length > 0) db.pluginStorageMeta ??= {};

        let completed = 0;
        for (const storageKey of valueStorageKeys) {
            const key = decodeListedStorageKey(storageKey, PLUGIN_SAVE_PREFIX);
            if (key === null) continue;
            db.pluginCustomStorage[key] = await deps.readPersistentJson(storageKey, { cached: true });
            options.onProgress?.({
                direction: "internalize",
                completed: ++completed,
                total,
            });
        }
        for (const storageKey of metaStorageKeys) {
            const key = decodeListedStorageKey(storageKey, PLUGIN_SAVE_META_PREFIX);
            if (key === null) continue;
            db.pluginStorageMeta![key] = await deps.readPersistentJson(storageKey);
            options.onProgress?.({
                direction: "internalize",
                completed: ++completed,
                total,
            });
        }

        // The database becomes the durable copy before any external key goes.
        await deps.persistDatabase();
        for (const storageKey of valueStorageKeys) {
            await deps.removePersistentKey(storageKey);
        }
        for (const storageKey of metaStorageKeys) {
            await deps.removePersistentKey(storageKey);
        }
        return {
            direction: "internalize",
            values: valueStorageKeys.length,
            meta: metaStorageKeys.length,
        };
    });
}
