import { getDatabase, type Database } from "../storage/database.svelte";
import {
    clearExternalizedPluginStorage,
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
import { StorageError } from "../storage/storageError";
import { abortReason, awaitWithAbort, throwIfAborted } from "../storage/abort";
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
import {
    getPluginStorageKeySetGeneration,
    markPluginStorageKeySetChanged,
} from "./pluginStorageEnumeration";

export { PLUGIN_SAVE_META_PREFIX, PLUGIN_SAVE_PREFIX };

export const PLUGIN_STORAGE_TRANSITION_WAIT_TIMEOUT_MS = 30_000;

type BarrierWaiter = {
    kind: "shared" | "exclusive";
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    cleanup?: () => void;
    timer?: ReturnType<typeof setTimeout>;
};

/** Fair writer-preferring barrier used to preserve MT2 routing order. */
class PluginStorageBarrier {
    private activeShared = 0;
    private exclusiveActive = false;
    private readonly waiters: BarrierWaiter[] = [];

    acquireShared(signal?: AbortSignal | null): Promise<() => void> {
        throwIfAborted(signal);
        if (!this.exclusiveActive && this.waiters.length === 0) {
            this.activeShared += 1;
            return Promise.resolve(this.sharedRelease());
        }
        return new Promise((resolve, reject) => {
            const waiter: BarrierWaiter = { kind: "shared", resolve, reject };
            if (signal) {
                const onAbort = () => this.cancelWaiter(waiter, abortReason(signal));
                signal.addEventListener("abort", onAbort, { once: true });
                waiter.cleanup = () => signal.removeEventListener("abort", onAbort);
            }
            this.waiters.push(waiter);
            this.drain();
        });
    }

    acquireExclusive(
        timeoutMs = PLUGIN_STORAGE_TRANSITION_WAIT_TIMEOUT_MS,
        signal?: AbortSignal | null,
    ): Promise<() => void> {
        throwIfAborted(signal);
        if (!this.exclusiveActive && this.activeShared === 0 && this.waiters.length === 0) {
            this.exclusiveActive = true;
            return Promise.resolve(this.exclusiveRelease());
        }
        return new Promise((resolve, reject) => {
            const waiter: BarrierWaiter = { kind: "exclusive", resolve, reject };
            waiter.timer = setTimeout(() => {
                this.cancelWaiter(waiter, new StorageError(
                    "Plugin storage transition timed out waiting for earlier storage work.",
                    {
                        code: "STORAGE_TIMEOUT",
                        operation: "transition",
                        retryable: true,
                    },
                ));
            }, timeoutMs);
            if (signal) {
                const onAbort = () => this.cancelWaiter(waiter, abortReason(signal));
                signal.addEventListener("abort", onAbort, { once: true });
                waiter.cleanup = () => signal.removeEventListener("abort", onAbort);
            }
            this.waiters.push(waiter);
            this.drain();
        });
    }

    private cancelWaiter(waiter: BarrierWaiter, error: unknown): void {
        const index = this.waiters.indexOf(waiter);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.cleanup?.();
        waiter.reject(error);
        this.drain();
    }

    private sharedRelease(): () => void {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.activeShared -= 1;
            this.drain();
        };
    }

    private exclusiveRelease(): () => void {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.exclusiveActive = false;
            this.drain();
        };
    }

    private drain(): void {
        if (this.exclusiveActive || this.activeShared > 0 || this.waiters.length === 0) return;
        if (this.waiters[0].kind === "exclusive") {
            const waiter = this.waiters.shift()!;
            if (waiter.timer) clearTimeout(waiter.timer);
            waiter.cleanup?.();
            this.exclusiveActive = true;
            waiter.resolve(this.exclusiveRelease());
            return;
        }
        while (this.waiters[0]?.kind === "shared") {
            const waiter = this.waiters.shift()!;
            waiter.cleanup?.();
            this.activeShared += 1;
            waiter.resolve(this.sharedRelease());
        }
    }
}

const storageBarrier = new PluginStorageBarrier();
const storageScopeQueues = new Map<string, Promise<void>>();
let storageEnumerationSnapshot: {
    database: Database;
    optimized: boolean;
    generation: number;
    keys: string[];
} | null = null;

function invalidateStorageEnumerationSnapshot(): void {
    storageEnumerationSnapshot = null;
    markPluginStorageKeySetChanged();
}

async function withPluginSaveStorageScope<T>(
    scope: string,
    operation: () => Promise<T>,
    signal?: AbortSignal | null,
): Promise<T> {
    // Acquire shared admission immediately. This makes every ordinary call
    // submitted before a transition part of the old-mode drain, while calls
    // submitted after it wait for the new mode.
    const releaseBarrier = await storageBarrier.acquireShared(signal);
    const previous = storageScopeQueues.get(scope) ?? Promise.resolve();
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
    });
    // Cancellation may already be observable before awaitWithAbort attaches;
    // the returned raced promise still carries the error to the caller.
    void result.catch(() => undefined);

    // The queue token is intentionally separate from the caller-facing
    // promise. A queued caller can reject immediately on abort, but its token
    // must remain behind the predecessor until that predecessor settles. This
    // prevents a later same-key operation from overtaking active work.
    const current = previous
        .catch(() => undefined)
        .then(async () => {
            try {
                throwIfAborted(signal);
                resolveResult(await operation());
            } catch (error) {
                rejectResult(error);
            }
        });
    storageScopeQueues.set(scope, current);
    void current.then(() => {
        if (storageScopeQueues.get(scope) === current) storageScopeQueues.delete(scope);
        releaseBarrier();
    });

    return await awaitWithAbort(result, signal);
}

function normalizePluginStorageKey(key: unknown): string {
    // The inline object backend historically applies ordinary property-key
    // coercion. Do it before routing so optimized mode has identical behavior.
    const normalized = String(key);
    assertWellFormedUnicode(normalized);
    return normalized;
}

/**
 * Serialize mode transitions with V3/viewer storage operations. V2 calls are
 * synchronous and cannot join this barrier, which is why the UI forbids this
 * mode while an enabled V2/V2.1 plugin exists.
 */
export function withPluginSaveStorageLock<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal | null,
): Promise<T> {
    return (async () => {
        const release = await storageBarrier.acquireExclusive(
            PLUGIN_STORAGE_TRANSITION_WAIT_TIMEOUT_MS,
            signal,
        );
        try {
            throwIfAborted(signal);
            return await operation();
        } finally {
            release();
        }
    })();
}

/** Serialize one logical save key without blocking unrelated plugin keys. */
export function withPluginSaveStorageKeyLock<T>(
    key: string,
    operation: () => Promise<T>,
    signal?: AbortSignal | null,
): Promise<T> {
    return withPluginSaveStorageScope(`save:${key}`, operation, signal);
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
        assertWellFormedUnicode(key);
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
    for (const key of orderPluginStorageKeys(keys)) {
        const descriptor = Reflect.getOwnPropertyDescriptor(source, key)!;
        definePluginStorageRecordValue(snapshot, key, snapshotJsonValue(descriptor.value));
    }
    return snapshot;
}

async function readExternalizedPluginStorageUnlocked(
    signal?: AbortSignal | null,
): Promise<{
    values: Record<string, unknown>;
    meta: NonNullable<Database["pluginStorageMeta"]>;
}> {
    throwIfAborted(signal);
    const [listedValueKeys, listedMetaKeys] = await Promise.all([
        signal
            ? listPersistentKeys(PLUGIN_SAVE_PREFIX, signal)
            : listPersistentKeys(PLUGIN_SAVE_PREFIX),
        signal
            ? listPersistentKeys(PLUGIN_SAVE_META_PREFIX, signal)
            : listPersistentKeys(PLUGIN_SAVE_META_PREFIX),
    ]);
    const values = createPluginStorageRecord<unknown>();
    const meta = createPluginStorageRecord<
        NonNullable<Database["pluginStorageMeta"]>[string]
    >();

    for (const storageKey of listedValueKeys) {
        throwIfAborted(signal);
        const key = decodeListedStorageKey(storageKey, PLUGIN_SAVE_PREFIX);
        if (key === null) continue;
        const options = signal ? { cached: true, signal } : { cached: true };
        definePluginStorageRecordValue(
            values,
            key,
            await readPersistentJson(storageKey, options),
        );
    }
    for (const storageKey of listedMetaKeys) {
        throwIfAborted(signal);
        const key = decodeListedStorageKey(storageKey, PLUGIN_SAVE_META_PREFIX);
        if (key === null) continue;
        const value = signal
            ? await readPersistentJson(storageKey, { signal })
            : await readPersistentJson(storageKey);
        definePluginStorageRecordValue(meta, key, value);
    }

    return { values, meta };
}

async function listDecodedStorageKeys(
    prefix: string,
    signal?: AbortSignal | null,
): Promise<string[]> {
    const storageKeys = signal
        ? await listPersistentKeys(prefix, signal)
        : await listPersistentKeys(prefix);
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
export async function getPluginSaveStorageSnapshot(
    signal?: AbortSignal | null,
): Promise<Record<string, unknown>> {
    return withPluginSaveStorageLock(async () => {
        throwIfAborted(signal);
        const db = getDatabase();
        const source = db.optimizePluginMemory
            ? (await readExternalizedPluginStorageUnlocked(signal)).values
            : db.pluginCustomStorage;
        throwIfAborted(signal);
        return cloneJsonPluginStorageRecord(
            source ?? createDatabasePluginStorageRecord(),
        );
    }, signal);
}

/**
 * Apply a V3 database mutation while holding the exclusive pluginStorage barrier.
 * A provided plugin map is an exact replacement; `undefined` leaves the
 * authoritative key set unchanged. Optimized mode never retains inline rows.
 */
export async function updateDatabaseWithPluginStorageSnapshot<T>(
    pluginCustomStorage: Record<string, unknown> | undefined,
    mutateDatabase: (signal?: AbortSignal) => T | Promise<T>,
    signal?: AbortSignal | null,
): Promise<T> {
    throwIfAborted(signal);
    // Snapshot and validate before waiting so caller-owned objects cannot
    // change underneath the queued operation.
    const replacement = pluginCustomStorage === undefined
        ? undefined
        : cloneJsonPluginStorageRecord(pluginCustomStorage);

    try {
        return await withPluginSaveStorageLock(async () => {
            throwIfAborted(signal);
            const db = getDatabase();
            // Validate live records descriptor-by-descriptor before this
            // database operation can clear, replace, or preserve any part.
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
                    // backend is known to be external. Prepare every
                    // destination before any persistent or database mutation.
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
                        signal
                            ? listPersistentKeys(PLUGIN_SAVE_PREFIX, signal)
                            : listPersistentKeys(PLUGIN_SAVE_PREFIX),
                        signal
                            ? listPersistentKeys(PLUGIN_SAVE_META_PREFIX, signal)
                            : listPersistentKeys(PLUGIN_SAVE_META_PREFIX),
                    ]);
                    throwIfAborted(signal);
                    const destinationKeys = new Set(prepared.map(entry => entry.storageKey));
                    const existingKeySet = new Set(existingKeys);
                    const retainedMetaKeys = new Set<string>();
                    // Only actual metadata rows can be retained. In
                    // particular, do not fabricate a stricter metadata
                    // destination for a value-only key at the value prefix's
                    // archive-size boundary.
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
                        throwIfAborted(signal);
                        if (signal) {
                            await writePersistentJson(entry.storageKey, entry.value, signal);
                        } else {
                            await writePersistentJson(entry.storageKey, entry.value);
                        }
                    }
                    for (const storageKey of existingKeys) {
                        if (!destinationKeys.has(storageKey)) {
                            throwIfAborted(signal);
                            if (signal) await removePersistentKey(storageKey, signal);
                            else await removePersistentKey(storageKey);
                        }
                    }
                    // A direct database replacement has no plugin-owner context.
                    // Preserve metadata for retained keys, discard it for deleted
                    // keys, and leave new keys unowned.
                    for (const storageKey of existingMetaKeys) {
                        if (!retainedMetaKeys.has(storageKey)) {
                            throwIfAborted(signal);
                            if (signal) await removePersistentKey(storageKey, signal);
                            else await removePersistentKey(storageKey);
                        }
                    }
                }
                throwIfAborted(signal);
                if (getPluginStorageRecordKeys(previousValues).length > 0) {
                    db.pluginCustomStorage = createDatabasePluginStorageRecord();
                }
                if (getPluginStorageRecordKeys(previousMeta).length > 0) {
                    delete db.pluginStorageMeta;
                }
            } else if (replacement !== undefined) {
                throwIfAborted(signal);
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

            throwIfAborted(signal);
            const result = await mutateDatabase(signal ?? undefined);
            throwIfAborted(signal);
            return result;
        }, signal);
    } finally {
        if (replacement !== undefined) invalidateStorageEnumerationSnapshot();
    }
}

export async function getPluginSaveStorageItem<T>(
    key: string,
    signal?: AbortSignal | null,
): Promise<T | null> {
    const normalizedKey = normalizePluginStorageKey(key);
    return withPluginSaveStorageKeyLock(normalizedKey, async () => {
        throwIfAborted(signal);
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
        const options = signal ? { cached: true, signal } : { cached: true };
        return await readPersistentJson<T>(
            makeEncodedStorageKey(PLUGIN_SAVE_PREFIX, normalizedKey),
            options,
        );
    }, signal);
}

export async function setPluginSaveStorageItem<T>(
    key: string,
    value: T,
    signal?: AbortSignal | null,
): Promise<void> {
    throwIfAborted(signal);
    const normalizedKey = normalizePluginStorageKey(key);
    const snapshot = snapshotJsonValue(value);
    try {
        await withPluginSaveStorageKeyLock(normalizedKey, async () => {
            throwIfAborted(signal);
            const db = getDatabase();
            if (!db.optimizePluginMemory) {
                const next = cloneJsonPluginStorageRecord(
                    db.pluginCustomStorage ?? createDatabasePluginStorageRecord(),
                );
                definePluginStorageRecordValue(next, normalizedKey, snapshot);
                db.pluginCustomStorage = next;
                return;
            }
            const storageKey = makeArchiveSafePluginSaveStorageKey(
                PLUGIN_SAVE_PREFIX,
                normalizedKey,
            );
            if (signal) await writePersistentJson(storageKey, snapshot, signal);
            else await writePersistentJson(storageKey, snapshot);
        }, signal);
    } finally {
        // A timed-out remote mutation may have committed even though its
        // acknowledgement was lost, so no enumeration snapshot remains valid.
        invalidateStorageEnumerationSnapshot();
    }
}

/** Set a V3 save value and its owner as one ordered storage operation. */
export async function setOwnedPluginSaveStorageItem<T>(
    key: string,
    value: T,
    owner: string,
    signal?: AbortSignal | null,
): Promise<void> {
    throwIfAborted(signal);
    const normalizedKey = normalizePluginStorageKey(key);
    const snapshot = snapshotJsonValue(value);
    try {
        await withPluginSaveStorageKeyLock(normalizedKey, async () => {
            throwIfAborted(signal);
            const db = getDatabase();
            const ownerRecord = { plugin: owner, updatedAt: Date.now() };
            if (db.optimizePluginMemory) {
                // Metadata has the longer prefix. Prepare every destination
                // before the primary value write so a rejected owner row
                // cannot leave a durable, unowned value behind.
                const valueStorageKey = makeArchiveSafePluginSaveStorageKey(
                    PLUGIN_SAVE_PREFIX,
                    normalizedKey,
                );
                const ownerStorageKey = owner
                    ? makeArchiveSafePluginSaveStorageKey(
                        PLUGIN_SAVE_META_PREFIX,
                        normalizedKey,
                    )
                    : null;
                if (signal) await writePersistentJson(valueStorageKey, snapshot, signal);
                else await writePersistentJson(valueStorageKey, snapshot);
                if (owner) {
                    if (signal) await writePersistentJson(ownerStorageKey!, ownerRecord, signal);
                    else await writePersistentJson(ownerStorageKey!, ownerRecord);
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
        }, signal);
    } finally {
        invalidateStorageEnumerationSnapshot();
    }
}

export async function removePluginSaveStorageItem(
    key: string,
    signal?: AbortSignal | null,
): Promise<void> {
    const normalizedKey = normalizePluginStorageKey(key);
    try {
        await withPluginSaveStorageKeyLock(normalizedKey, async () => {
            throwIfAborted(signal);
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
            const storageKey = makeEncodedStorageKey(PLUGIN_SAVE_PREFIX, normalizedKey);
            if (signal) await removePersistentKey(storageKey, signal);
            else await removePersistentKey(storageKey);
        }, signal);
    } finally {
        invalidateStorageEnumerationSnapshot();
    }
}

/** Remove a V3 save value and its owner as one ordered storage operation. */
export async function removeOwnedPluginSaveStorageItem(
    key: string,
    signal?: AbortSignal | null,
): Promise<void> {
    const normalizedKey = normalizePluginStorageKey(key);
    try {
        await withPluginSaveStorageKeyLock(normalizedKey, async () => {
            throwIfAborted(signal);
            const db = getDatabase();
            if (db.optimizePluginMemory) {
                const valueStorageKey = makeEncodedStorageKey(
                    PLUGIN_SAVE_PREFIX,
                    normalizedKey,
                );
                const metaStorageKey = makeEncodedStorageKey(
                    PLUGIN_SAVE_META_PREFIX,
                    normalizedKey,
                );
                if (signal) {
                    await removePersistentKey(valueStorageKey, signal);
                    await removePersistentKey(metaStorageKey, signal);
                } else {
                    await removePersistentKey(valueStorageKey);
                    await removePersistentKey(metaStorageKey);
                }
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
        }, signal);
    } finally {
        invalidateStorageEnumerationSnapshot();
    }
}

export async function clearPluginSaveStorage(signal?: AbortSignal | null): Promise<void> {
    try {
        await withPluginSaveStorageLock(async () => {
            throwIfAborted(signal);
            const db = getDatabase();
            if (!db.optimizePluginMemory) {
                db.pluginCustomStorage = createDatabasePluginStorageRecord();
                return;
            }
            if (signal) await clearPersistentPrefix(PLUGIN_SAVE_PREFIX, signal);
            else await clearPersistentPrefix(PLUGIN_SAVE_PREFIX);
        }, signal);
    } finally {
        invalidateStorageEnumerationSnapshot();
    }
}

/** Clear all V3 save values and owners as one ordered storage operation. */
export async function clearOwnedPluginSaveStorage(signal?: AbortSignal | null): Promise<void> {
    try {
        await withPluginSaveStorageLock(async () => {
            throwIfAborted(signal);
            const db = getDatabase();
            if (db.optimizePluginMemory) {
                await clearExternalizedPluginStorage(signal);
                return;
            }
            db.pluginCustomStorage = createDatabasePluginStorageRecord();
            delete db.pluginStorageMeta;
        }, signal);
    } finally {
        invalidateStorageEnumerationSnapshot();
    }
}

async function getPluginSaveStorageEnumerationSnapshot(
    refresh: boolean,
    signal?: AbortSignal | null,
): Promise<string[]> {
    return withPluginSaveStorageScope("enumeration", async () => {
        throwIfAborted(signal);
        const db = getDatabase();
        if (!refresh
            && storageEnumerationSnapshot?.database === db
            && storageEnumerationSnapshot.optimized === (db.optimizePluginMemory === true)
            && storageEnumerationSnapshot.generation === getPluginStorageKeySetGeneration()
        ) {
            return [...storageEnumerationSnapshot.keys];
        }
        const generation = getPluginStorageKeySetGeneration();
        const keys = !db.optimizePluginMemory
            ? getPluginStorageRecordKeys(cloneJsonPluginStorageRecord(
                db.pluginCustomStorage ?? createDatabasePluginStorageRecord(),
            ))
            : await listDecodedStorageKeys(PLUGIN_SAVE_PREFIX, signal);
        const orderedKeys = orderPluginStorageKeys(keys);
        if (generation === getPluginStorageKeySetGeneration()) {
            storageEnumerationSnapshot = {
                database: db,
                optimized: db.optimizePluginMemory === true,
                generation,
                keys: [...orderedKeys],
            };
        }
        return [...orderedKeys];
    }, signal);
}

export async function getPluginSaveStorageKeys(signal?: AbortSignal | null): Promise<string[]> {
    return getPluginSaveStorageEnumerationSnapshot(true, signal);
}

export async function getPluginSaveStorageKey(
    index: number,
    signal?: AbortSignal | null,
): Promise<string | null> {
    const keys = await getPluginSaveStorageEnumerationSnapshot(false, signal);
    return keys[index] ?? null;
}

export async function getPluginSaveStorageLength(signal?: AbortSignal | null): Promise<number> {
    return (await getPluginSaveStorageEnumerationSnapshot(false, signal)).length;
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
    invalidateStorageEnumerationSnapshot();
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
