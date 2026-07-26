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
import { requireCommittedDatabaseSave } from "../storage/databaseSave";
import { beginPluginStorageModeTransition } from "./pluginMemoryOptimization";
import {
    copyDatabasePluginStorageRecord,
    createDatabasePluginStorageRecord,
    createPluginStorageRecord,
    definePluginStorageRecordValue,
    getPluginStorageRecordKeys,
    hasPluginStorageRecordValue,
} from "./pluginStorageRecord";

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

function cloneJsonPluginStorageRecord(
    source: Record<string, unknown>,
): Record<string, unknown> {
    if (source === null || typeof source !== "object" || Array.isArray(source)) {
        throw new TypeError("pluginCustomStorage must be a JSON object.");
    }
    const prototype = Reflect.getPrototypeOf(source);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("pluginCustomStorage must be a plain JSON object.");
    }

    const keys: string[] = [];
    const seen = new Set<PropertyKey>();
    const validateKey = (key: PropertyKey) => {
        if (seen.has(key)) return;
        seen.add(key);
        if (typeof key !== "string") {
            throw new TypeError("pluginCustomStorage does not accept symbol keys.");
        }
        const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
        if (!descriptor || !("value" in descriptor)) {
            throw new TypeError(`pluginCustomStorage does not accept an accessor for ${key}.`);
        }
        if (!descriptor.enumerable) {
            throw new TypeError(
                `pluginCustomStorage requires an enumerable data property for ${key}.`,
            );
        }
        keys.push(key);
    };
    for (const key of Reflect.ownKeys(source)) validateKey(key);
    // A Svelte proxy may omit a configurable own inherited-name key from
    // ownKeys. The dynamic fallback discovers both built-in and late-added
    // Object.prototype names and subjects them to the same validation.
    for (const key of getPluginStorageRecordKeys(source)) validateKey(key);

    const snapshot = createDatabasePluginStorageRecord<unknown>();
    for (const key of keys) {
        const descriptor = Reflect.getOwnPropertyDescriptor(source, key)!;
        const json = JSON.stringify(descriptor.value);
        if (json === undefined) {
            throw new TypeError(`pluginCustomStorage value for ${JSON.stringify(key)} is not JSON.`);
        }
        definePluginStorageRecordValue(snapshot, key, JSON.parse(json));
    }
    return snapshot;
}

async function readExternalizedPluginStorageUnlocked(): Promise<{
    values: Record<string, unknown>;
    meta: NonNullable<Database["pluginStorageMeta"]>;
}> {
    const [listedValueKeys, listedMetaKeys] = await Promise.all([
        listPersistentKeys(PLUGIN_SAVE_PREFIX),
        listPersistentKeys(PLUGIN_SAVE_META_PREFIX),
    ]);
    const values = createPluginStorageRecord<unknown>();
    const meta = createPluginStorageRecord<
        NonNullable<Database["pluginStorageMeta"]>[string]
    >();

    for (const storageKey of listedValueKeys) {
        const key = decodeListedStorageKey(storageKey, PLUGIN_SAVE_PREFIX);
        if (key === null) continue;
        definePluginStorageRecordValue(
            values,
            key,
            await readPersistentJson(storageKey, { cached: true }),
        );
    }
    for (const storageKey of listedMetaKeys) {
        const key = decodeListedStorageKey(storageKey, PLUGIN_SAVE_META_PREFIX);
        if (key === null) continue;
        definePluginStorageRecordValue(meta, key, await readPersistentJson(storageKey));
    }

    return { values, meta };
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
    return withPluginSaveStorageLock(readExternalizedPluginStorageUnlocked);
}

/** Detached authoritative snapshot used by the V3 database bridge. */
export async function getPluginSaveStorageSnapshot(): Promise<Record<string, unknown>> {
    return withPluginSaveStorageLock(async () => {
        const db = getDatabase();
        const source = db.optimizePluginMemory
            ? (await readExternalizedPluginStorageUnlocked()).values
            : db.pluginCustomStorage;
        return cloneJsonPluginStorageRecord(source ?? createDatabasePluginStorageRecord());
    });
}

/**
 * Apply a V3 database mutation while holding the same queue as pluginStorage.
 * A provided plugin map is an exact replacement; `undefined` leaves the
 * authoritative key set unchanged. Optimized mode never retains inline rows.
 */
export async function updateDatabaseWithPluginStorageSnapshot<T>(
    pluginCustomStorage: Record<string, unknown> | undefined,
    mutateDatabase: () => T | Promise<T>,
): Promise<T> {
    // Snapshot and validate before waiting so caller-owned objects cannot
    // change underneath the queued operation.
    const replacement = pluginCustomStorage === undefined
        ? undefined
        : cloneJsonPluginStorageRecord(pluginCustomStorage);
    const prepared = replacement === undefined
        ? []
        : getPluginStorageRecordKeys(replacement).map((key) => ({
            key,
            storageKey: makeEncodedStorageKey(PLUGIN_SAVE_PREFIX, key),
            value: replacement[key],
        }));
    if (new Set(prepared.map(entry => entry.storageKey)).size !== prepared.length) {
        throw new Error("Plugin storage key collision while replacing V3 database storage.");
    }

    return withPluginSaveStorageLock(async () => {
        const db = getDatabase();
        if (db.optimizePluginMemory) {
            if (replacement !== undefined) {
                const [existingKeys, existingMetaKeys] = await Promise.all([
                    listPersistentKeys(PLUGIN_SAVE_PREFIX),
                    listPersistentKeys(PLUGIN_SAVE_META_PREFIX),
                ]);
                const destinationKeys = new Set(prepared.map(entry => entry.storageKey));
                const existingKeySet = new Set(existingKeys);
                const retainedMetaKeys = new Set(prepared
                    .filter(entry => existingKeySet.has(entry.storageKey))
                    .map(entry => makeEncodedStorageKey(PLUGIN_SAVE_META_PREFIX, entry.key)));
                // Upsert the complete replacement before deleting omitted rows.
                for (const entry of prepared) {
                    await writePersistentJson(entry.storageKey, entry.value);
                }
                for (const storageKey of existingKeys) {
                    if (!destinationKeys.has(storageKey)) {
                        await removePersistentKey(storageKey);
                    }
                }
                // A direct database replacement has no plugin-owner context.
                // Preserve metadata for retained keys, discard it for deleted
                // keys, and leave new keys unowned.
                for (const storageKey of existingMetaKeys) {
                    if (!retainedMetaKeys.has(storageKey)) {
                        await removePersistentKey(storageKey);
                    }
                }
            }
            if (getPluginStorageRecordKeys(db.pluginCustomStorage).length > 0) {
                db.pluginCustomStorage = createDatabasePluginStorageRecord();
            }
            if (getPluginStorageRecordKeys(db.pluginStorageMeta).length > 0) {
                delete db.pluginStorageMeta;
            }
        } else if (replacement !== undefined) {
            const previousValues = db.pluginCustomStorage;
            db.pluginCustomStorage = copyDatabasePluginStorageRecord(replacement);
            const nextMeta = createDatabasePluginStorageRecord<
                NonNullable<Database["pluginStorageMeta"]>[string]
            >();
            for (const key of getPluginStorageRecordKeys(replacement)) {
                if (
                    hasPluginStorageRecordValue(previousValues, key)
                    && hasPluginStorageRecordValue(db.pluginStorageMeta, key)
                ) {
                    definePluginStorageRecordValue(nextMeta, key, db.pluginStorageMeta![key]);
                }
            }
            if (Object.keys(nextMeta).length > 0) {
                db.pluginStorageMeta = nextMeta;
            } else {
                delete db.pluginStorageMeta;
            }
        }

        return await mutateDatabase();
    });
}

export async function getPluginSaveStorageItem<T>(key: string): Promise<T | null> {
    return withPluginSaveStorageLock(async () => {
        const db = getDatabase();
        if (!db.optimizePluginMemory) {
            if (!hasPluginStorageRecordValue(db.pluginCustomStorage, key)) return null;
            const value = db.pluginCustomStorage![key];
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
            const next = copyDatabasePluginStorageRecord(db.pluginCustomStorage);
            definePluginStorageRecordValue(next, key, value);
            db.pluginCustomStorage = next;
            return;
        }
        await writePersistentJson(makeEncodedStorageKey(PLUGIN_SAVE_PREFIX, key), value);
    });
}

/** Set a V3 save value and its owner as one ordered storage operation. */
export async function setOwnedPluginSaveStorageItem<T>(
    key: string,
    value: T,
    owner: string,
): Promise<void> {
    await withPluginSaveStorageLock(async () => {
        const db = getDatabase();
        const ownerRecord = { plugin: owner, updatedAt: Date.now() };
        if (db.optimizePluginMemory) {
            await writePersistentJson(makeEncodedStorageKey(PLUGIN_SAVE_PREFIX, key), value);
            if (owner) {
                await writePersistentJson(
                    makeEncodedStorageKey(PLUGIN_SAVE_META_PREFIX, key),
                    ownerRecord,
                );
            }
            return;
        }

        const nextValues = copyDatabasePluginStorageRecord(db.pluginCustomStorage);
        definePluginStorageRecordValue(nextValues, key, value);
        db.pluginCustomStorage = nextValues;
        if (owner) {
            const nextMeta = copyDatabasePluginStorageRecord(db.pluginStorageMeta);
            definePluginStorageRecordValue(nextMeta, key, ownerRecord);
            db.pluginStorageMeta = nextMeta;
        }
    });
}

export async function removePluginSaveStorageItem(key: string): Promise<void> {
    await withPluginSaveStorageLock(async () => {
        const db = getDatabase();
        if (!db.optimizePluginMemory) {
            if (!hasPluginStorageRecordValue(db.pluginCustomStorage, key)) return;
            const next = copyDatabasePluginStorageRecord(db.pluginCustomStorage);
            delete next[key];
            db.pluginCustomStorage = next;
            return;
        }
        await removePersistentKey(makeEncodedStorageKey(PLUGIN_SAVE_PREFIX, key));
    });
}

/** Remove a V3 save value and its owner as one ordered storage operation. */
export async function removeOwnedPluginSaveStorageItem(key: string): Promise<void> {
    await withPluginSaveStorageLock(async () => {
        const db = getDatabase();
        if (db.optimizePluginMemory) {
            await removePersistentKey(makeEncodedStorageKey(PLUGIN_SAVE_PREFIX, key));
            await removePersistentKey(makeEncodedStorageKey(PLUGIN_SAVE_META_PREFIX, key));
            return;
        }

        if (hasPluginStorageRecordValue(db.pluginCustomStorage, key)) {
            const nextValues = copyDatabasePluginStorageRecord(db.pluginCustomStorage);
            delete nextValues[key];
            db.pluginCustomStorage = nextValues;
        }
        if (hasPluginStorageRecordValue(db.pluginStorageMeta, key)) {
            const nextMeta = copyDatabasePluginStorageRecord(db.pluginStorageMeta);
            delete nextMeta[key];
            if (getPluginStorageRecordKeys(nextMeta).length > 0) db.pluginStorageMeta = nextMeta;
            else delete db.pluginStorageMeta;
        }
    });
}

export async function clearPluginSaveStorage(): Promise<void> {
    await withPluginSaveStorageLock(async () => {
        const db = getDatabase();
        if (!db.optimizePluginMemory) {
            db.pluginCustomStorage = createDatabasePluginStorageRecord();
            return;
        }
        await clearPersistentPrefix(PLUGIN_SAVE_PREFIX);
    });
}

/** Clear all V3 save values and owners as one ordered storage operation. */
export async function clearOwnedPluginSaveStorage(): Promise<void> {
    await withPluginSaveStorageLock(async () => {
        const db = getDatabase();
        if (db.optimizePluginMemory) {
            await clearPersistentPrefix(PLUGIN_SAVE_PREFIX);
            await clearPersistentPrefix(PLUGIN_SAVE_META_PREFIX);
            return;
        }
        db.pluginCustomStorage = createDatabasePluginStorageRecord();
        delete db.pluginStorageMeta;
    });
}

export async function getPluginSaveStorageKeys(): Promise<string[]> {
    return withPluginSaveStorageLock(async () => {
        const db = getDatabase();
        if (!db.optimizePluginMemory) {
            return getPluginStorageRecordKeys(db.pluginCustomStorage);
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
    onStart?: (progress: PluginStorageReconcileProgress) => void;
    onProgress?: (progress: PluginStorageReconcileProgress) => void;
    /** Test/bootstrap injection. Normal UI calls use the immediate save path. */
    dependencies?: Partial<ReconcileDependencies>;
}

async function persistDatabaseImmediately(): Promise<void> {
    const { requestImmediateSave } = await import("../globalApi.svelte");
    const outcome = await requestImmediateSave({ forceFullWrite: true });
    requireCommittedDatabaseSave(outcome, "Plugin storage mode transition");
}

function resolveReconcileDependencies(
    overrides: Partial<ReconcileDependencies> = {},
): ReconcileDependencies {
    return {
        getDatabase,
        listPersistentKeys,
        readPersistentJson,
        writePersistentJson,
        removePersistentKey,
        persistDatabase: persistDatabaseImmediately,
        ...overrides,
    };
}

async function reconcilePluginStorageModeUnlocked(
    deps: ReconcileDependencies,
    options: Omit<PluginStorageReconcileOptions, "dependencies">,
): Promise<PluginStorageReconcileResult> {
    const db = deps.getDatabase();

    if (db.optimizePluginMemory) {
        const valueEntries = getPluginStorageRecordKeys(db.pluginCustomStorage)
            .map(key => [key, db.pluginCustomStorage[key]] as const);
        const metaEntries = getPluginStorageRecordKeys(db.pluginStorageMeta)
            .map(key => [key, db.pluginStorageMeta![key]] as const);
        const total = valueEntries.length + metaEntries.length;
        options.onStart?.({ direction: "externalize", completed: 0, total });
        if (total === 0) {
            return { direction: "none", values: 0, meta: 0 };
        }

        const destinationStorageKeys = new Set<string>();
        const prepareEntries = <T>(
            entries: ReadonlyArray<readonly [string, T]>,
            prefix: string,
        ) => (
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
        if (db.pluginStorageMeta && getPluginStorageRecordKeys(db.pluginStorageMeta).length === 0) {
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
    options.onStart?.({ direction: "internalize", completed: 0, total });
    if (total === 0) {
        return { direction: "none", values: 0, meta: 0 };
    }

    const nextValues = copyDatabasePluginStorageRecord(db.pluginCustomStorage);
    const nextMeta = copyDatabasePluginStorageRecord(db.pluginStorageMeta);

    let completed = 0;
    for (const storageKey of valueStorageKeys) {
        const key = decodeListedStorageKey(storageKey, PLUGIN_SAVE_PREFIX);
        if (key === null) continue;
        definePluginStorageRecordValue(
            nextValues,
            key,
            await deps.readPersistentJson(storageKey, { cached: true }),
        );
        options.onProgress?.({
            direction: "internalize",
            completed: ++completed,
            total,
        });
    }
    for (const storageKey of metaStorageKeys) {
        const key = decodeListedStorageKey(storageKey, PLUGIN_SAVE_META_PREFIX);
        if (key === null) continue;
        definePluginStorageRecordValue(
            nextMeta,
            key,
            await deps.readPersistentJson(storageKey),
        );
        options.onProgress?.({
            direction: "internalize",
            completed: ++completed,
            total,
        });
    }

    db.pluginCustomStorage = nextValues;
    if (metaStorageKeys.length > 0 || Object.keys(nextMeta).length > 0) {
        db.pluginStorageMeta = nextMeta;
    } else {
        delete db.pluginStorageMeta;
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
    const deps = resolveReconcileDependencies(options.dependencies);
    return withPluginSaveStorageLock(() => reconcilePluginStorageModeUnlocked(deps, options));
}

/**
 * Atomically switch plugin storage routing with respect to queued plugin calls.
 * Operations already queued run in the old mode; later operations cannot observe
 * the new flag until migration and its durable database save have completed.
 */
export async function transitionPluginStorageMode(
    target: boolean,
    options: PluginStorageReconcileOptions = {},
): Promise<PluginStorageReconcileResult> {
    const deps = resolveReconcileDependencies(options.dependencies);
    // Acquire synchronously, before waiting behind the storage queue. This
    // prevents legacy activation while a requested transition is draining old
    // operations as well as while its new mode is being reconciled.
    const finishTransition = beginPluginStorageModeTransition();

    try {
        return await withPluginSaveStorageLock(async () => {
            const db = deps.getDatabase();
            const previous = db.optimizePluginMemory === true;
            db.optimizePluginMemory = target;

            try {
                const result = await reconcilePluginStorageModeUnlocked(deps, options);
                // With no rows to move, reconciliation has no reason to save. An
                // actual flag transition still needs its own durable acknowledgement.
                if (result.direction === "none" && previous !== target) {
                    await deps.persistDatabase();
                }
                return result;
            } catch (transitionError) {
                db.optimizePluginMemory = previous;
                try {
                    const rollback = await reconcilePluginStorageModeUnlocked(deps, {});
                    if (rollback.direction === "none") {
                        await deps.persistDatabase();
                    }
                } catch (rollbackError) {
                    console.error("[Plugin storage] mode rollback failed", rollbackError);
                }
                throw transitionError;
            }
        });
    } finally {
        finishTransition();
    }
}
