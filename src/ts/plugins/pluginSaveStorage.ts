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
import { snapshotJsonValue } from "../storage/jsonValue";
import { assertWellFormedUnicode } from "../storage/unicodeWellFormed";
import { requireCommittedDatabaseSave } from "../storage/databaseSave";
import {
    makeArchiveSafePluginSaveStorageKey,
    PLUGIN_SAVE_META_PREFIX,
    PLUGIN_SAVE_PREFIX,
    type PluginSaveStoragePrefix,
} from "../storage/pluginSaveKeyPolicy";
import {
    beginPluginStorageModeTransition,
    hasEnabledLegacyPlugins,
    withPluginLifecycleLock,
} from "./pluginMemoryOptimization";
import {
    copyDatabasePluginStorageRecord,
    createDatabasePluginStorageRecord,
    createPluginStorageRecord,
    definePluginStorageRecordValue,
    getPluginStorageRecordKeys,
    hasPluginStorageRecordValue,
    orderPluginStorageKeys,
} from "./pluginStorageRecord";

export { PLUGIN_SAVE_META_PREFIX, PLUGIN_SAVE_PREFIX };

let storageOperationQueue: Promise<unknown> = Promise.resolve();

function normalizePluginStorageKey(key: unknown): string {
    // The inline object backend historically applies ordinary property-key
    // coercion. Do it before routing so optimized mode has identical behavior.
    const normalized = String(key);
    assertWellFormedUnicode(normalized);
    return normalized;
}

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

function cloneJsonPluginStorageRecord<T>(
    source: Record<string, T>,
    fieldName?: string,
): Record<string, T>;
function cloneJsonPluginStorageRecord(
    source: unknown,
    fieldName?: string,
): Record<string, unknown>;
function cloneJsonPluginStorageRecord(
    source: unknown,
    fieldName = "pluginCustomStorage",
): Record<string, unknown> {
    if (source === null || typeof source !== "object" || Array.isArray(source)) {
        throw new TypeError(`${fieldName} must be a JSON object.`);
    }
    const prototype = Reflect.getPrototypeOf(source);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`${fieldName} must be a plain JSON object.`);
    }

    const keys: string[] = [];
    const seen = new Set<PropertyKey>();
    const validateKey = (key: PropertyKey) => {
        if (seen.has(key)) return;
        seen.add(key);
        if (typeof key !== "string") {
            throw new TypeError(`${fieldName} does not accept symbol keys.`);
        }
        const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
        if (!descriptor || !("value" in descriptor)) {
            throw new TypeError(`${fieldName} does not accept an accessor for ${key}.`);
        }
        if (!descriptor.enumerable) {
            throw new TypeError(
                `${fieldName} requires an enumerable data property for ${key}.`,
            );
        }
        keys.push(key);
    };
    for (const key of Reflect.ownKeys(source)) validateKey(key);
    // A Svelte proxy may omit a configurable own inherited-name key from
    // ownKeys. The dynamic fallback discovers both built-in and late-added
    // Object.prototype names and subjects them to the same validation.
    for (const key of getPluginStorageRecordKeys(source as Record<string, unknown>)) {
        validateKey(key);
    }

    const snapshot = createDatabasePluginStorageRecord<unknown>();
    for (const key of keys) {
        const descriptor = Reflect.getOwnPropertyDescriptor(source, key)!;
        definePluginStorageRecordValue(snapshot, key, snapshotJsonValue(descriptor.value));
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
        return cloneJsonPluginStorageRecord(
            source ?? createDatabasePluginStorageRecord(),
        );
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

    return withPluginSaveStorageLock(async () => {
        const db = getDatabase();
        // Validate live records descriptor-by-descriptor before this database
        // operation can clear, replace, or preserve any part of them.
        const previousValues = cloneJsonPluginStorageRecord(
            db.pluginCustomStorage ?? createDatabasePluginStorageRecord(),
        );
        const previousMeta = cloneJsonPluginStorageRecord(
            db.pluginStorageMeta ?? createDatabasePluginStorageRecord<
                NonNullable<Database["pluginStorageMeta"]>[string]
            >(),
            "pluginStorageMeta",
        );
        if (db.optimizePluginMemory) {
            if (replacement !== undefined) {
                // Archive constraints apply only once the locked, live
                // backend is known to be external. Prepare every destination
                // before any persistent or database mutation.
                const prepared = getPluginStorageRecordKeys(replacement).map((key) => ({
                    key,
                    storageKey: makeArchiveSafePluginSaveStorageKey(
                        PLUGIN_SAVE_PREFIX,
                        key,
                    ),
                    value: replacement[key],
                }));
                if (new Set(prepared.map(entry => entry.storageKey)).size !== prepared.length) {
                    throw new Error(
                        "Plugin storage key collision while replacing V3 database storage.",
                    );
                }
                const [existingKeys, existingMetaKeys] = await Promise.all([
                    listPersistentKeys(PLUGIN_SAVE_PREFIX),
                    listPersistentKeys(PLUGIN_SAVE_META_PREFIX),
                ]);
                const destinationKeys = new Set(prepared.map(entry => entry.storageKey));
                const existingKeySet = new Set(existingKeys);
                const retainedMetaKeys = new Set<string>();
                // Only actual metadata rows can be retained. In particular,
                // do not fabricate a stricter metadata destination for an
                // existing value-only key at the value prefix's 756-byte raw
                // boundary.
                for (const existingMetaKey of existingMetaKeys) {
                    const rawKey = decodeListedStorageKey(
                        existingMetaKey,
                        PLUGIN_SAVE_META_PREFIX,
                    );
                    if (
                        rawKey === null
                        || !hasPluginStorageRecordValue(replacement, rawKey)
                    ) continue;
                    const existingValueKey = makeArchiveSafePluginSaveStorageKey(
                        PLUGIN_SAVE_PREFIX,
                        rawKey,
                    );
                    if (!existingKeySet.has(existingValueKey)) continue;
                    const canonicalMetaKey = makeArchiveSafePluginSaveStorageKey(
                        PLUGIN_SAVE_META_PREFIX,
                        rawKey,
                    );
                    if (existingMetaKey === canonicalMetaKey) {
                        retainedMetaKeys.add(existingMetaKey);
                    }
                }
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
            if (getPluginStorageRecordKeys(previousValues).length > 0) {
                db.pluginCustomStorage = createDatabasePluginStorageRecord();
            }
            if (getPluginStorageRecordKeys(previousMeta).length > 0) {
                delete db.pluginStorageMeta;
            }
        } else if (replacement !== undefined) {
            db.pluginCustomStorage = copyDatabasePluginStorageRecord(replacement);
            const nextMeta = createDatabasePluginStorageRecord<
                NonNullable<Database["pluginStorageMeta"]>[string]
            >();
            for (const key of getPluginStorageRecordKeys(replacement)) {
                if (
                    hasPluginStorageRecordValue(previousValues, key)
                    && hasPluginStorageRecordValue(previousMeta, key)
                ) {
                    definePluginStorageRecordValue(nextMeta, key, previousMeta[key]);
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
    const normalizedKey = normalizePluginStorageKey(key);
    return withPluginSaveStorageLock(async () => {
        const db = getDatabase();
        if (!db.optimizePluginMemory) {
            const descriptor = Reflect.getOwnPropertyDescriptor(
                db.pluginCustomStorage ?? createDatabasePluginStorageRecord(),
                normalizedKey,
            );
            if (!descriptor) return null;
            if (!("value" in descriptor)) {
                throw new TypeError(
                    `pluginCustomStorage does not accept an accessor for ${normalizedKey}.`,
                );
            }
            if (!descriptor.enumerable) {
                throw new TypeError(
                    `pluginCustomStorage requires an enumerable data property for ${normalizedKey}.`,
                );
            }
            const value = descriptor.value;
            if (value === null) return null;
            // db is reactive $state, so inline values are Svelte proxies.
            // postMessage/structuredClone reject proxies (DataCloneError), and
            // this value crosses the V3 iframe bridge — return the same plain
            // JSON round-trip the optimized branch produces.
            return snapshotJsonValue(value) as T;
        }
        return await readPersistentJson<T>(makeEncodedStorageKey(PLUGIN_SAVE_PREFIX, normalizedKey), { cached: true });
    });
}

export async function setPluginSaveStorageItem<T>(key: string, value: T): Promise<void> {
    const normalizedKey = normalizePluginStorageKey(key);
    const snapshot = snapshotJsonValue(value);
    await withPluginSaveStorageLock(async () => {
        const db = getDatabase();
        if (!db.optimizePluginMemory) {
            const next = cloneJsonPluginStorageRecord(
                db.pluginCustomStorage ?? createDatabasePluginStorageRecord(),
            );
            definePluginStorageRecordValue(next, normalizedKey, snapshot);
            db.pluginCustomStorage = next;
            return;
        }
        await writePersistentJson(
            makeArchiveSafePluginSaveStorageKey(PLUGIN_SAVE_PREFIX, normalizedKey),
            snapshot,
        );
    });
}

/** Set a V3 save value and its owner as one ordered storage operation. */
export async function setOwnedPluginSaveStorageItem<T>(
    key: string,
    value: T,
    owner: string,
): Promise<void> {
    const normalizedKey = normalizePluginStorageKey(key);
    const snapshot = snapshotJsonValue(value);
    await withPluginSaveStorageLock(async () => {
        const db = getDatabase();
        const ownerRecord = { plugin: owner, updatedAt: Date.now() };
        if (db.optimizePluginMemory) {
            // Metadata has the longer prefix. Prepare every destination before
            // the primary value write so a rejected owner row cannot leave a
            // durable, unowned value behind.
            const valueStorageKey = makeArchiveSafePluginSaveStorageKey(
                PLUGIN_SAVE_PREFIX,
                normalizedKey,
            );
            const ownerStorageKey = owner
                ? makeArchiveSafePluginSaveStorageKey(PLUGIN_SAVE_META_PREFIX, normalizedKey)
                : null;
            await writePersistentJson(valueStorageKey, snapshot);
            if (owner) {
                await writePersistentJson(ownerStorageKey!, ownerRecord);
            }
            return;
        }

        const nextValues = cloneJsonPluginStorageRecord(
            db.pluginCustomStorage ?? createDatabasePluginStorageRecord(),
        );
        const nextMeta = owner
            ? cloneJsonPluginStorageRecord(
                db.pluginStorageMeta ?? createDatabasePluginStorageRecord<
                    NonNullable<Database["pluginStorageMeta"]>[string]
                >(),
                "pluginStorageMeta",
            )
            : undefined;
        definePluginStorageRecordValue(nextValues, normalizedKey, snapshot);
        if (nextMeta) {
            definePluginStorageRecordValue(nextMeta, normalizedKey, ownerRecord);
        }
        // Both live records have passed preflight; only now publish either.
        db.pluginCustomStorage = nextValues;
        if (nextMeta) db.pluginStorageMeta = nextMeta;
    });
}

export async function removePluginSaveStorageItem(key: string): Promise<void> {
    const normalizedKey = normalizePluginStorageKey(key);
    await withPluginSaveStorageLock(async () => {
        const db = getDatabase();
        if (!db.optimizePluginMemory) {
            if (!hasPluginStorageRecordValue(db.pluginCustomStorage, normalizedKey)) return;
            const next = cloneJsonPluginStorageRecord(
                db.pluginCustomStorage ?? createDatabasePluginStorageRecord(),
            );
            delete next[normalizedKey];
            db.pluginCustomStorage = next;
            return;
        }
        await removePersistentKey(makeEncodedStorageKey(PLUGIN_SAVE_PREFIX, normalizedKey));
    });
}

/** Remove a V3 save value and its owner as one ordered storage operation. */
export async function removeOwnedPluginSaveStorageItem(key: string): Promise<void> {
    const normalizedKey = normalizePluginStorageKey(key);
    await withPluginSaveStorageLock(async () => {
        const db = getDatabase();
        if (db.optimizePluginMemory) {
            await removePersistentKey(makeEncodedStorageKey(PLUGIN_SAVE_PREFIX, normalizedKey));
            await removePersistentKey(makeEncodedStorageKey(PLUGIN_SAVE_META_PREFIX, normalizedKey));
            return;
        }

        const nextValues = cloneJsonPluginStorageRecord(
            db.pluginCustomStorage ?? createDatabasePluginStorageRecord(),
        );
        const nextMeta = cloneJsonPluginStorageRecord(
            db.pluginStorageMeta ?? createDatabasePluginStorageRecord<
                NonNullable<Database["pluginStorageMeta"]>[string]
            >(),
            "pluginStorageMeta",
        );
        if (hasPluginStorageRecordValue(db.pluginCustomStorage, normalizedKey)) {
            delete nextValues[normalizedKey];
            db.pluginCustomStorage = nextValues;
        }
        if (hasPluginStorageRecordValue(db.pluginStorageMeta, normalizedKey)) {
            delete nextMeta[normalizedKey];
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
            const snapshot = cloneJsonPluginStorageRecord(
                db.pluginCustomStorage ?? createDatabasePluginStorageRecord(),
            );
            return orderPluginStorageKeys(getPluginStorageRecordKeys(snapshot));
        }
        return orderPluginStorageKeys(await listDecodedStorageKeys(PLUGIN_SAVE_PREFIX));
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

interface PreparedStorageEntry<T = unknown> {
    key: string;
    storageKey: string;
    value: T;
}

type PreparedReconciliation =
    | {
        direction: "none";
        values: 0;
        meta: 0;
    }
    | {
        direction: "externalize";
        valueEntries: PreparedStorageEntry[];
        metaEntries: PreparedStorageEntry[];
    }
    | {
        direction: "internalize";
        valueStorageKeys: string[];
        metaStorageKeys: string[];
        nextValues: Record<string, unknown>;
        nextMeta: NonNullable<Database["pluginStorageMeta"]>;
    };

/**
 * Validate and detach the complete source set before reconciliation mutates
 * the mode flag, either backend, or the live database records.
 */
async function preparePluginStorageReconciliation(
    deps: ReconcileDependencies,
    target: boolean,
    options: Omit<PluginStorageReconcileOptions, "dependencies">,
): Promise<PreparedReconciliation> {
    const db = deps.getDatabase();

    if (target) {
        const values = cloneJsonPluginStorageRecord(
            db.pluginCustomStorage ?? createDatabasePluginStorageRecord(),
        );
        const meta = cloneJsonPluginStorageRecord(
            db.pluginStorageMeta ?? createDatabasePluginStorageRecord<
                NonNullable<Database["pluginStorageMeta"]>[string]
            >(),
            "pluginStorageMeta",
        );
        const destinationStorageKeys = new Set<string>();
        const prepareEntries = (
            source: Record<string, unknown>,
            prefix: PluginSaveStoragePrefix,
        ): PreparedStorageEntry[] => (
            getPluginStorageRecordKeys(source).map((key) => {
                const storageKey = makeArchiveSafePluginSaveStorageKey(prefix, key);
                if (destinationStorageKeys.has(storageKey)) {
                    throw new Error(
                        `Plugin storage key collision while externalizing: ${JSON.stringify(key)}`,
                    );
                }
                destinationStorageKeys.add(storageKey);
                return { key, storageKey, value: source[key] };
            })
        );
        const valueEntries = prepareEntries(values, PLUGIN_SAVE_PREFIX);
        const metaEntries = prepareEntries(meta, PLUGIN_SAVE_META_PREFIX);

        // External rows not replaced by a valid inline entry become
        // authoritative as soon as the mode flag is enabled. Validate every
        // retained orphan before publishing that flag or writing inline rows.
        const [listedValueKeys, listedMetaKeys] = await Promise.all([
            deps.listPersistentKeys(PLUGIN_SAVE_PREFIX),
            deps.listPersistentKeys(PLUGIN_SAVE_META_PREFIX),
        ]);
        const overwrittenValueKeys = new Set(valueEntries.map(entry => entry.storageKey));
        const overwrittenMetaKeys = new Set(metaEntries.map(entry => entry.storageKey));
        for (const storageKey of listedValueKeys) {
            if (
                overwrittenValueKeys.has(storageKey)
                || decodeListedStorageKey(storageKey, PLUGIN_SAVE_PREFIX) === null
            ) continue;
            snapshotJsonValue(
                await deps.readPersistentJson(storageKey, { cached: true }),
            );
        }
        for (const storageKey of listedMetaKeys) {
            if (
                overwrittenMetaKeys.has(storageKey)
                || decodeListedStorageKey(storageKey, PLUGIN_SAVE_META_PREFIX) === null
            ) continue;
            snapshotJsonValue(await deps.readPersistentJson(storageKey));
        }

        const total = valueEntries.length + metaEntries.length;
        options.onStart?.({ direction: "externalize", completed: 0, total });
        if (total === 0) return { direction: "none", values: 0, meta: 0 };
        return {
            direction: "externalize",
            valueEntries,
            metaEntries,
        };
    }

    // Inline duplicates are part of the internalization source. Validate them
    // even though external rows win, so hidden/accessor properties cannot be
    // silently dropped when the complete inline snapshot is persisted.
    const nextValues = cloneJsonPluginStorageRecord(
        db.pluginCustomStorage ?? createDatabasePluginStorageRecord(),
    );
    const nextMeta = cloneJsonPluginStorageRecord(
        db.pluginStorageMeta ?? createDatabasePluginStorageRecord<
            NonNullable<Database["pluginStorageMeta"]>[string]
        >(),
        "pluginStorageMeta",
    ) as NonNullable<Database["pluginStorageMeta"]>;
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
    if (total === 0) return { direction: "none", values: 0, meta: 0 };

    let completed = 0;
    for (const storageKey of valueStorageKeys) {
        const key = decodeListedStorageKey(storageKey, PLUGIN_SAVE_PREFIX);
        if (key === null) continue;
        const value = snapshotJsonValue(
            await deps.readPersistentJson(storageKey, { cached: true }),
        );
        definePluginStorageRecordValue(
            nextValues,
            key,
            value,
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
        const record = snapshotJsonValue(await deps.readPersistentJson(storageKey));
        definePluginStorageRecordValue(
            nextMeta,
            key,
            record as NonNullable<Database["pluginStorageMeta"]>[string],
        );
        options.onProgress?.({
            direction: "internalize",
            completed: ++completed,
            total,
        });
    }

    return {
        direction: "internalize",
        valueStorageKeys,
        metaStorageKeys,
        nextValues,
        nextMeta,
    };
}

async function applyPluginStorageReconciliation(
    prepared: PreparedReconciliation,
    deps: ReconcileDependencies,
    options: Omit<PluginStorageReconcileOptions, "dependencies">,
): Promise<PluginStorageReconcileResult> {
    if (prepared.direction === "none") return prepared;
    const db = deps.getDatabase();

    if (prepared.direction === "externalize") {
        const total = prepared.valueEntries.length + prepared.metaEntries.length;
        let completed = 0;
        for (const { key, storageKey, value } of prepared.valueEntries) {
            // Inline wins if a previous partial run left a duplicate.
            await deps.writePersistentJson(storageKey, value);
            delete db.pluginCustomStorage[key];
            options.onProgress?.({
                direction: "externalize",
                completed: ++completed,
                total,
            });
        }
        for (const { key, storageKey, value: record } of prepared.metaEntries) {
            await deps.writePersistentJson(storageKey, record);
            if (db.pluginStorageMeta) delete db.pluginStorageMeta[key];
            options.onProgress?.({
                direction: "externalize",
                completed: ++completed,
                total,
            });
        }
        // Replace the now-empty Svelte records instead of retaining proxy
        // bookkeeping for special names such as `__proto__`.
        db.pluginCustomStorage = createDatabasePluginStorageRecord();
        delete db.pluginStorageMeta;

        await deps.persistDatabase();
        return {
            direction: "externalize",
            values: prepared.valueEntries.length,
            meta: prepared.metaEntries.length,
        };
    }

    db.pluginCustomStorage = prepared.nextValues;
    if (
        prepared.metaStorageKeys.length > 0
        || getPluginStorageRecordKeys(prepared.nextMeta).length > 0
    ) {
        db.pluginStorageMeta = prepared.nextMeta;
    } else {
        delete db.pluginStorageMeta;
    }

    // The database becomes the durable copy before any external key goes.
    await deps.persistDatabase();
    for (const storageKey of prepared.valueStorageKeys) {
        await deps.removePersistentKey(storageKey);
    }
    for (const storageKey of prepared.metaStorageKeys) {
        await deps.removePersistentKey(storageKey);
    }
    return {
        direction: "internalize",
        values: prepared.valueStorageKeys.length,
        meta: prepared.metaStorageKeys.length,
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
    return withPluginSaveStorageLock(async () => {
        const target = deps.getDatabase().optimizePluginMemory === true;
        const prepared = await preparePluginStorageReconciliation(deps, target, options);
        return applyPluginStorageReconciliation(prepared, deps, options);
    });
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
    return withPluginLifecycleLock(async () => {
        const eligibilityDatabase = deps.getDatabase();
        if (target && hasEnabledLegacyPlugins(eligibilityDatabase.plugins)) {
            throw new Error(
                "Disable every enabled V2/V2.1 plugin before optimizing plugin memory.",
            );
        }

        // Earlier plugin reloads, including every awaited V2 unload callback,
        // have now drained. Keep the synchronous legacy guard active from this
        // point until reconciliation and its durable save have completed.
        const finishTransition = beginPluginStorageModeTransition();
        try {
            return await withPluginSaveStorageLock(async () => {
                const db = deps.getDatabase();
                // A V3 database mutation may have been queued ahead of this
                // transition after the first eligibility read.
                if (target && hasEnabledLegacyPlugins(db.plugins)) {
                    throw new Error(
                        "Disable every enabled V2/V2.1 plugin before optimizing plugin memory.",
                    );
                }
                const previous = db.optimizePluginMemory === true;
                // This may perform reads, but no mode/backend/database mutation.
                // A malformed source therefore rejects without needing rollback.
                const prepared = await preparePluginStorageReconciliation(
                    deps,
                    target,
                    options,
                );
                db.optimizePluginMemory = target;

                try {
                    const result = await applyPluginStorageReconciliation(
                        prepared,
                        deps,
                        options,
                    );
                    // With no rows to move, reconciliation has no reason to save. An
                    // actual flag transition still needs its own durable acknowledgement.
                    if (result.direction === "none" && previous !== target) {
                        await deps.persistDatabase();
                    }
                    return result;
                } catch (transitionError) {
                    db.optimizePluginMemory = previous;
                    try {
                        const rollbackPrepared = await preparePluginStorageReconciliation(
                            deps,
                            previous,
                            {},
                        );
                        const rollback = await applyPluginStorageReconciliation(
                            rollbackPrepared,
                            deps,
                            {},
                        );
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
    });
}
