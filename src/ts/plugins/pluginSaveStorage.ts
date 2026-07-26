import { getDatabase, type Database } from "../storage/database.svelte";
import {
    commitPersistentPluginStorageMutation,
    commitPersistentPluginStorageTransition,
    decodeStorageKeyComponent,
    listPersistentKeys,
    makeEncodedStorageKey,
    mutatePersistentPluginStorage,
    restorePersistentPluginStoragePair,
    readPersistentJson,
    readPersistentJsonRow,
    removePersistentKey,
    writePersistentJson,
} from "../storage/persistentKv";
import { snapshotJsonValue, stringifyJsonValue } from "../storage/jsonValue";
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
import { v4 as uuidv4 } from "uuid";
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
import {
    setPluginStorageRecoveryState,
    type PluginStorageRecoveryIssue,
} from "./pluginStorageRecovery";

export { PLUGIN_SAVE_META_PREFIX, PLUGIN_SAVE_PREFIX };
export const PLUGIN_STORAGE_MANIFEST_KEY = "plugin-storage/manifest.json";

interface PluginStorageManifest {
    version: 1;
    generation: string;
    valueKeys: string[];
    metaKeys: string[];
}

interface PluginStorageOwnership {
    manifest: PluginStorageManifest | null;
    manifestPresent: boolean;
    manifestValid: boolean;
    valueKeys: string[];
    metaKeys: string[];
}

export const PLUGIN_STORAGE_TRANSITION_WAIT_TIMEOUT_MS = 30_000;
export const PLUGIN_STORAGE_BOOT_RECOVERY_TIMEOUT_MS = 30_000;

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

function normalizeManifestKeys(value: unknown, prefix: string): string[] | null {
    if (!Array.isArray(value)) return null;
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        if (typeof item !== "string") {
            return null;
        }
        try {
            const decoded = decodeListedStorageKey(item, prefix);
            if (
                decoded === null
                || makeArchiveSafePluginSaveStorageKey(
                    prefix as PluginSaveStoragePrefix,
                    decoded,
                ) !== item
            ) return null;
        } catch {
            return null;
        }
        if (!seen.has(item)) {
            seen.add(item);
            keys.push(item);
        }
    }
    return keys;
}

function normalizePluginStorageManifest(value: unknown): PluginStorageManifest | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = value as Partial<PluginStorageManifest>;
    if (candidate.version !== 1 || typeof candidate.generation !== "string"
        || candidate.generation.length === 0) return null;
    const valueKeys = normalizeManifestKeys(candidate.valueKeys, PLUGIN_SAVE_PREFIX);
    const metaKeys = normalizeManifestKeys(candidate.metaKeys, PLUGIN_SAVE_META_PREFIX);
    if (!valueKeys || !metaKeys) return null;
    return {
        version: 1,
        generation: candidate.generation,
        valueKeys,
        metaKeys,
    };
}

function buildPluginStorageManifest(
    generation: string,
    valueKeys: Iterable<string>,
    metaKeys: Iterable<string>,
): PluginStorageManifest {
    return {
        version: 1,
        generation,
        valueKeys: [...new Set(valueKeys)],
        metaKeys: [...new Set(metaKeys)],
    };
}

async function resolvePluginStorageOwnership(
    db: Database,
    listedValueKeys: string[],
    listedMetaKeys: string[],
    readJson: typeof readPersistentJson = readPersistentJson,
    signal?: AbortSignal | null,
): Promise<PluginStorageOwnership> {
    let manifest: PluginStorageManifest | null = null;
    let manifestPresent = false;
    let manifestValid = true;
    try {
        const rawManifest = signal
            ? await readJson(PLUGIN_STORAGE_MANIFEST_KEY, { signal })
            : await readJson(PLUGIN_STORAGE_MANIFEST_KEY);
        manifestPresent = rawManifest != null;
        manifest = normalizePluginStorageManifest(rawManifest);
        manifestValid = !manifestPresent || manifest !== null;
    } catch (error) {
        // A corrupt manifest cannot authorize rows. Leave them quarantined.
        // Transport/auth/import failures must remain observable; treating one
        // as a missing manifest could publish a replacement exact set.
        if (!(error instanceof SyntaxError)) throw error;
        manifestPresent = true;
        manifestValid = false;
    }
    const generation = typeof db.pluginStorageGeneration === "string"
        && db.pluginStorageGeneration.length > 0
        ? db.pluginStorageGeneration
        : null;
    const physicalValues = new Set(listedValueKeys.filter(
        key => decodeListedStorageKey(key, PLUGIN_SAVE_PREFIX) !== null,
    ));
    const physicalMeta = new Set(listedMetaKeys.filter(
        key => decodeListedStorageKey(key, PLUGIN_SAVE_META_PREFIX) !== null,
    ));

    if (generation && manifest?.generation === generation) {
        const valueKeys = manifest.valueKeys.filter(key => physicalValues.has(key));
        const metaKeys = manifest.metaKeys.filter(key => physicalMeta.has(key));
        return {
            manifest,
            manifestPresent,
            manifestValid,
            valueKeys,
            metaKeys,
        };
    }

    // Compatibility with pre-generation optimized databases: only a database
    // that already routes reads externally may adopt the unmarked physical set.
    // Disabled/imported databases never let leftover rows become authoritative.
    if (!generation && !manifestPresent && db.optimizePluginMemory === true) {
        return {
            manifest: null,
            manifestPresent: false,
            manifestValid: true,
            valueKeys: [...physicalValues],
            metaKeys: [...physicalMeta],
        };
    }

    return {
        manifest,
        manifestPresent,
        manifestValid,
        valueKeys: [],
        metaKeys: [],
    };
}

async function readCurrentOwnership(
    db: Database,
    signal?: AbortSignal | null,
): Promise<PluginStorageOwnership> {
    const [valueKeys, metaKeys] = await Promise.all([
        signal
            ? listPersistentKeys(PLUGIN_SAVE_PREFIX, signal)
            : listPersistentKeys(PLUGIN_SAVE_PREFIX),
        signal
            ? listPersistentKeys(PLUGIN_SAVE_META_PREFIX, signal)
            : listPersistentKeys(PLUGIN_SAVE_META_PREFIX),
    ]);
    return resolvePluginStorageOwnership(db, valueKeys, metaKeys, readPersistentJson, signal);
}

function readGenerationBoundPluginStorageJson<T>(
    reader: typeof readPersistentJson,
    storageKey: string,
    generation: string | undefined,
    cached = false,
    signal?: AbortSignal | null,
): Promise<T | null> {
    const options = {
        ...(cached ? { cached: true } : {}),
        ...(generation ? { pluginStorageGeneration: generation } : {}),
        ...(signal ? { signal } : {}),
    };
    return Object.keys(options).length > 0
        ? reader<T>(storageKey, options)
        : reader<T>(storageKey);
}

async function commitOptimizedStorageMutation(
    db: Database,
    writes: { storageKey: string; value: unknown }[],
    deletes: string[],
    mutate: (valueKeys: Set<string>, metaKeys: Set<string>) => void,
    signal?: AbortSignal | null,
): Promise<void> {
    const generation = db.pluginStorageGeneration;
    for (let attempt = 0; ; attempt++) {
        const ownership = await readCurrentOwnership(db, signal);
        if (
            !generation
            || !ownership.manifestValid
            || ownership.manifest?.generation !== generation
        ) {
            throw new Error(
                "Optimized plugin storage is not reconciled; reload to complete its atomic adoption.",
            );
        }
        const valueKeys = new Set(ownership.manifest.valueKeys);
        const metaKeys = new Set(ownership.manifest.metaKeys);
        mutate(valueKeys, metaKeys);
        try {
            await commitPersistentPluginStorageMutation({
                generation,
                expectedManifest: ownership.manifest,
                nextManifest: buildPluginStorageManifest(generation, valueKeys, metaKeys),
                writes,
                deletes,
            }, signal);
            return;
        } catch (error) {
            if (
                attempt < 2
                && error instanceof StorageError
                && error.code === "STORAGE_CONFLICT"
                && !error.commitOutcomeUnknown
            ) continue;
            throw error;
        }
    }
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
    const ownership = await resolvePluginStorageOwnership(
        getDatabase(),
        listedValueKeys,
        listedMetaKeys,
    );
    const values = createPluginStorageRecord<unknown>();
    const meta = createPluginStorageRecord<
        NonNullable<Database["pluginStorageMeta"]>[string]
    >();

    for (const storageKey of ownership.valueKeys) {
        throwIfAborted(signal);
        const key = decodeListedStorageKey(storageKey, PLUGIN_SAVE_PREFIX);
        if (key === null) continue;
        definePluginStorageRecordValue(
            values,
            key,
            await readGenerationBoundPluginStorageJson(
                readPersistentJson,
                storageKey,
                ownership.manifest?.generation,
                true,
                signal,
            ),
        );
    }
    for (const storageKey of ownership.metaKeys) {
        throwIfAborted(signal);
        const key = decodeListedStorageKey(storageKey, PLUGIN_SAVE_META_PREFIX);
        if (key === null) continue;
        definePluginStorageRecordValue(meta, key, await readGenerationBoundPluginStorageJson(
            readPersistentJson,
            storageKey,
            ownership.manifest?.generation,
            false,
            signal,
        ));
    }

    return { values, meta };
}

async function listDecodedStorageKeys(
    prefix: string,
    signal?: AbortSignal | null,
): Promise<string[]> {
    const ownership = await readCurrentOwnership(getDatabase());
    const storageKeys = prefix === PLUGIN_SAVE_META_PREFIX
        ? ownership.metaKeys
        : ownership.valueKeys;
    const keys: string[] = [];
    for (const storageKey of storageKeys) {
        throwIfAborted(signal);
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
                    const ownership = await resolvePluginStorageOwnership(
                        db,
                        existingKeys,
                        existingMetaKeys,
                        readPersistentJson,
                        signal,
                    );
                    const destinationKeys = new Set(prepared.map(entry => entry.storageKey));
                    const existingKeySet = new Set(ownership.valueKeys);
                    const retainedMetaKeys = new Set<string>();
                    // Only actual metadata rows can be retained. In
                    // particular, do not fabricate a stricter metadata
                    // destination for a value-only key at the value prefix's
                    // archive-size boundary.
                    for (const existingMetaKey of ownership.metaKeys) {
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
                    // A direct database replacement has no plugin-owner context.
                    // Preserve metadata for retained keys, discard it for deleted
                    // keys, and leave new keys unowned.
                    const deletes = [
                        ...ownership.valueKeys.filter(key => !destinationKeys.has(key)),
                        ...ownership.metaKeys.filter(key => !retainedMetaKeys.has(key)),
                    ];
                    await commitOptimizedStorageMutation(
                        db,
                        prepared.map(entry => ({
                            storageKey: entry.storageKey,
                            value: entry.value,
                        })),
                        deletes,
                        (values, meta) => {
                            values.clear();
                            for (const key of destinationKeys) values.add(key);
                            meta.clear();
                            for (const key of retainedMetaKeys) meta.add(key);
                        },
                        signal,
                    );
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
        const storageKey = makeArchiveSafePluginSaveStorageKey(
            PLUGIN_SAVE_PREFIX,
            normalizedKey,
        );
        if (db.pluginStorageGeneration) {
            const ownership = await readCurrentOwnership(db, signal);
            if (!ownership.valueKeys.includes(storageKey)) return null;
        }
        return await readGenerationBoundPluginStorageJson<T>(
            readPersistentJson,
            storageKey,
            db.pluginStorageGeneration,
            true,
            signal,
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
            await commitOptimizedStorageMutation(
                db,
                [{ storageKey, value: snapshot }],
                [],
                values => values.add(storageKey),
                signal,
            );
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
                const valueStorageKey = makeArchiveSafePluginSaveStorageKey(
                    PLUGIN_SAVE_PREFIX,
                    normalizedKey,
                );
                // The server derives this row, but preflight its stricter archive
                // boundary before dispatching either side of the transaction.
                makeArchiveSafePluginSaveStorageKey(
                    PLUGIN_SAVE_META_PREFIX,
                    normalizedKey,
                );
                if (db.pluginStorageGeneration) {
                    await mutatePersistentPluginStorage(
                        valueStorageKey,
                        "set",
                        snapshot,
                        owner,
                        signal,
                        db.pluginStorageGeneration,
                    );
                } else {
                    await mutatePersistentPluginStorage(
                        valueStorageKey,
                        "set",
                        snapshot,
                        owner,
                        signal,
                    );
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
            definePluginStorageRecordValue(nextValues, normalizedKey, snapshot);
            if (owner) {
                definePluginStorageRecordValue(nextMeta, normalizedKey, ownerRecord);
            } else {
                delete nextMeta[normalizedKey];
            }
            // Both detached records have passed preflight. Publish synchronously,
            // with no await or observable plugin callback between the two fields.
            db.pluginCustomStorage = nextValues;
            if (getPluginStorageRecordKeys(nextMeta).length > 0) {
                db.pluginStorageMeta = nextMeta;
            } else {
                delete db.pluginStorageMeta;
            }
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
            const storageKey = makeArchiveSafePluginSaveStorageKey(
                PLUGIN_SAVE_PREFIX,
                normalizedKey,
            );
            await commitOptimizedStorageMutation(
                db,
                [],
                [storageKey],
                values => values.delete(storageKey),
                signal,
            );
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
                const valueStorageKey = makeArchiveSafePluginSaveStorageKey(
                    PLUGIN_SAVE_PREFIX,
                    normalizedKey,
                );
                if (db.pluginStorageGeneration) {
                    await mutatePersistentPluginStorage(
                        valueStorageKey,
                        "remove",
                        signal,
                        db.pluginStorageGeneration,
                    );
                } else {
                    await mutatePersistentPluginStorage(
                        valueStorageKey,
                        "remove",
                        signal,
                    );
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
            const ownership = await readCurrentOwnership(db, signal);
            await commitOptimizedStorageMutation(
                db,
                [],
                ownership.valueKeys,
                values => values.clear(),
                signal,
            );
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
                const ownership = await readCurrentOwnership(db, signal);
                await commitOptimizedStorageMutation(
                    db,
                    [],
                    [...ownership.valueKeys, ...ownership.metaKeys],
                    (values, meta) => {
                        values.clear();
                        meta.clear();
                    },
                    signal,
                );
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

export async function setPluginSaveStorageOwner(
    key: string,
    plugin: string,
    signal?: AbortSignal | null,
): Promise<void> {
    throwIfAborted(signal);
    if (!plugin) return;
    const normalizedKey = normalizePluginStorageKey(key);
    const record = { plugin, updatedAt: Date.now() };
    await withPluginSaveStorageKeyLock(normalizedKey, async () => {
        throwIfAborted(signal);
        const db = getDatabase();
        if (!db.optimizePluginMemory) {
            const next = cloneJsonPluginStorageRecord(
                db.pluginStorageMeta ?? createDatabasePluginStorageRecord(),
                "pluginStorageMeta",
            ) as NonNullable<Database["pluginStorageMeta"]>;
            definePluginStorageRecordValue(next, normalizedKey, record);
            db.pluginStorageMeta = next;
            return;
        }
        const storageKey = makeArchiveSafePluginSaveStorageKey(
            PLUGIN_SAVE_META_PREFIX,
            normalizedKey,
        );
        const ownership = await readCurrentOwnership(db, signal);
        const valueStorageKey = makeArchiveSafePluginSaveStorageKey(
            PLUGIN_SAVE_PREFIX,
            normalizedKey,
        );
        if (!ownership.valueKeys.includes(valueStorageKey)) return;
        await commitOptimizedStorageMutation(
            db,
            [{ storageKey, value: record }],
            [],
            (_values, meta) => meta.add(storageKey),
            signal,
        );
    }, signal);
}

export async function removePluginSaveStorageOwner(
    key: string,
    signal?: AbortSignal | null,
): Promise<void> {
    const normalizedKey = normalizePluginStorageKey(key);
    await withPluginSaveStorageKeyLock(normalizedKey, async () => {
        throwIfAborted(signal);
        const db = getDatabase();
        if (!db.optimizePluginMemory) {
            if (!hasPluginStorageRecordValue(db.pluginStorageMeta, normalizedKey)) return;
            const next = cloneJsonPluginStorageRecord(
                db.pluginStorageMeta ?? createDatabasePluginStorageRecord(),
                "pluginStorageMeta",
            ) as NonNullable<Database["pluginStorageMeta"]>;
            delete next[normalizedKey];
            if (getPluginStorageRecordKeys(next).length > 0) db.pluginStorageMeta = next;
            else delete db.pluginStorageMeta;
            return;
        }
        const storageKey = makeArchiveSafePluginSaveStorageKey(
            PLUGIN_SAVE_META_PREFIX,
            normalizedKey,
        );
        await commitOptimizedStorageMutation(
            db,
            [],
            [storageKey],
            (_values, meta) => meta.delete(storageKey),
            signal,
        );
    }, signal);
}

export async function clearPluginSaveStorageOwners(
    signal?: AbortSignal | null,
): Promise<void> {
    await withPluginSaveStorageLock(async () => {
        throwIfAborted(signal);
        const db = getDatabase();
        if (!db.optimizePluginMemory) {
            delete db.pluginStorageMeta;
            return;
        }
        const ownership = await readCurrentOwnership(db, signal);
        await commitOptimizedStorageMutation(
            db,
            [],
            ownership.metaKeys,
            (_values, meta) => meta.clear(),
            signal,
        );
    }, signal);
}

export async function getPluginSaveStorageOwners(
    signal?: AbortSignal | null,
): Promise<Record<string, string>> {
    return withPluginSaveStorageLock(async () => {
        throwIfAborted(signal);
        const out = createPluginStorageRecord<string>();
        const db = getDatabase();
        if (!db.optimizePluginMemory) {
            const meta = db.pluginStorageMeta ?? createDatabasePluginStorageRecord();
            for (const key of getPluginStorageRecordKeys(meta)) {
                if (meta[key]?.plugin) {
                    definePluginStorageRecordValue(out, key, meta[key].plugin);
                }
            }
            return out;
        }
        const ownership = await readCurrentOwnership(db, signal);
        const activeValues = new Set(ownership.valueKeys);
        for (const fullKey of ownership.metaKeys) {
            const key = decodeListedStorageKey(fullKey, PLUGIN_SAVE_META_PREFIX);
            if (key === null) continue;
            if (!activeValues.has(makeEncodedStorageKey(PLUGIN_SAVE_PREFIX, key))) continue;
            const record = await readGenerationBoundPluginStorageJson<{ plugin?: string }>(
                readPersistentJson,
                fullKey,
                ownership.manifest?.generation,
                false,
                signal,
            );
            if (record?.plugin) definePluginStorageRecordValue(out, key, record.plugin);
        }
        return out;
    }, signal);
}

export async function countExternalizedPluginStorageEntries(): Promise<number> {
    return withPluginSaveStorageLock(async () => {
        const ownership = await readCurrentOwnership(getDatabase());
        return ownership.valueKeys.length + ownership.metaKeys.length;
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

export interface PluginStorageBootReconcileResult extends PluginStorageReconcileResult {
    issues: PluginStorageRecoveryIssue[];
}

interface ReconcileDependencies {
    getDatabase: () => Database;
    listPersistentKeys: typeof listPersistentKeys;
    readPersistentJson: typeof readPersistentJson;
    readPersistentJsonRow: typeof readPersistentJsonRow;
    restorePersistentPluginStoragePair: typeof restorePersistentPluginStoragePair;
    writePersistentJson: typeof writePersistentJson;
    removePersistentKey: typeof removePersistentKey;
    persistDatabase: () => Promise<void>;
}

export interface PluginStorageReconcileOptions {
    onStart?: (progress: PluginStorageReconcileProgress) => void;
    onProgress?: (progress: PluginStorageReconcileProgress) => void;
    signal?: AbortSignal | null;
    /** Whole-pass boot recovery deadline; individual storage calls remain bounded too. */
    timeoutMs?: number;
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
        readPersistentJsonRow,
        restorePersistentPluginStoragePair,
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
        generation: string;
        activeValueKeys: string[];
        activeMetaKeys: string[];
        nextValues: Record<string, unknown>;
        nextMeta: NonNullable<Database["pluginStorageMeta"]>;
    }
    | {
        direction: "internalize";
        valueStorageKeys: string[];
        metaStorageKeys: string[];
        nextValues: Record<string, unknown>;
        nextMeta: NonNullable<Database["pluginStorageMeta"]>;
        generation: string;
    };

/**
 * Validate and detach the complete source set before reconciliation mutates
 * the mode flag, either backend, or the live database records.
 */
async function preparePluginStorageReconciliation(
    deps: ReconcileDependencies,
    target: boolean,
    options: Omit<PluginStorageReconcileOptions, "dependencies">,
    rotateGeneration = false,
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
            deps.listPersistentKeys(PLUGIN_SAVE_PREFIX, options.signal),
            deps.listPersistentKeys(PLUGIN_SAVE_META_PREFIX, options.signal),
        ]);
        const ownership = await resolvePluginStorageOwnership(
            db,
            listedValueKeys,
            listedMetaKeys,
            deps.readPersistentJson,
            options.signal,
        );
        const retainExisting = db.optimizePluginMemory === true;
        const activeValueKeys = new Set(retainExisting ? ownership.valueKeys : []);
        const activeMetaKeys = new Set(retainExisting ? ownership.metaKeys : []);
        const overwrittenValueKeys = new Set(valueEntries.map(entry => entry.storageKey));
        const overwrittenMetaKeys = new Set(metaEntries.map(entry => entry.storageKey));
        for (const storageKey of activeValueKeys) {
            if (
                overwrittenValueKeys.has(storageKey)
                || decodeListedStorageKey(storageKey, PLUGIN_SAVE_PREFIX) === null
            ) continue;
            const value = snapshotJsonValue(
                await readGenerationBoundPluginStorageJson(
                    deps.readPersistentJson,
                    storageKey,
                    ownership.manifest?.generation,
                    true,
                    options.signal,
                ),
            );
            const key = decodeListedStorageKey(storageKey, PLUGIN_SAVE_PREFIX)!;
            definePluginStorageRecordValue(values, key, value);
        }
        for (const storageKey of activeMetaKeys) {
            if (
                overwrittenMetaKeys.has(storageKey)
                || decodeListedStorageKey(storageKey, PLUGIN_SAVE_META_PREFIX) === null
            ) continue;
            const record = snapshotJsonValue(await readGenerationBoundPluginStorageJson(
                deps.readPersistentJson,
                storageKey,
                ownership.manifest?.generation,
                false,
                options.signal,
            ));
            const key = decodeListedStorageKey(storageKey, PLUGIN_SAVE_META_PREFIX)!;
            definePluginStorageRecordValue(
                meta,
                key,
                record as NonNullable<Database["pluginStorageMeta"]>[string],
            );
        }

        const total = valueEntries.length + metaEntries.length;
        options.onStart?.({ direction: "externalize", completed: 0, total });
        const ownershipCurrent = Boolean(
            db.pluginStorageGeneration
            && ownership.manifest?.generation === db.pluginStorageGeneration,
        );
        if (total === 0 && retainExisting && ownershipCurrent) {
            return { direction: "none", values: 0, meta: 0 };
        }
        for (const entry of valueEntries) activeValueKeys.add(entry.storageKey);
        for (const entry of metaEntries) activeMetaKeys.add(entry.storageKey);
        return {
            direction: "externalize",
            valueEntries,
            metaEntries,
            generation: rotateGeneration
                ? uuidv4()
                : db.pluginStorageGeneration ?? uuidv4(),
            activeValueKeys: [...activeValueKeys],
            activeMetaKeys: [...activeMetaKeys],
            nextValues: values,
            nextMeta: meta as NonNullable<Database["pluginStorageMeta"]>,
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
        deps.listPersistentKeys(PLUGIN_SAVE_PREFIX, options.signal),
        deps.listPersistentKeys(PLUGIN_SAVE_META_PREFIX, options.signal),
    ]);
    const ownership = await resolvePluginStorageOwnership(
        db,
        listedValueKeys,
        listedMetaKeys,
        deps.readPersistentJson,
        options.signal,
    );
    const valueStorageKeys = ownership.valueKeys;
    const metaStorageKeys = ownership.metaKeys;
    const total = valueStorageKeys.length + metaStorageKeys.length;
    options.onStart?.({ direction: "internalize", completed: 0, total });
    const ownershipCurrent = Boolean(
        db.pluginStorageGeneration
        && (
            ownership.manifest?.generation === db.pluginStorageGeneration
            || (!ownership.manifest && db.optimizePluginMemory !== true)
        ),
    );
    if (total === 0 && ownershipCurrent && db.optimizePluginMemory !== true) {
        return { direction: "none", values: 0, meta: 0 };
    }

    let completed = 0;
    for (const storageKey of valueStorageKeys) {
        const key = decodeListedStorageKey(storageKey, PLUGIN_SAVE_PREFIX);
        if (key === null) continue;
        const value = snapshotJsonValue(
            await readGenerationBoundPluginStorageJson(
                deps.readPersistentJson,
                storageKey,
                ownership.manifest?.generation,
                true,
                options.signal,
            ),
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
        const record = snapshotJsonValue(await readGenerationBoundPluginStorageJson(
            deps.readPersistentJson,
            storageKey,
            ownership.manifest?.generation,
            false,
            options.signal,
        ));
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
        generation: rotateGeneration
            ? uuidv4()
            : db.pluginStorageGeneration ?? uuidv4(),
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
        db.pluginStorageGeneration = prepared.generation;
        await deps.writePersistentJson(
            PLUGIN_STORAGE_MANIFEST_KEY,
            buildPluginStorageManifest(
                prepared.generation,
                prepared.activeValueKeys,
                prepared.activeMetaKeys,
            ),
        );
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
    db.pluginStorageGeneration = prepared.generation;
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
    // Revoke the old exact set before deleting its physical rows. A snapshot
    // in the preceding just-disabled window still folds and marks that exact
    // set; one after this commit owns the inline set and no external rows.
    await deps.writePersistentJson(
        PLUGIN_STORAGE_MANIFEST_KEY,
        buildPluginStorageManifest(prepared.generation, [], []),
    );
    for (const storageKey of prepared.valueStorageKeys) {
        await deps.removePersistentKey(storageKey);
    }
    for (const storageKey of prepared.metaStorageKeys) {
        await deps.removePersistentKey(storageKey);
    }
    // Disabled mode carries its exact inline set in database.bin. Once the
    // external set is gone, absence of a manifest is the canonical empty
    // external ownership state and keeps legacy backup surfaces unchanged.
    await deps.removePersistentKey(PLUGIN_STORAGE_MANIFEST_KEY);
    return {
        direction: "internalize",
        values: prepared.valueStorageKeys.length,
        meta: prepared.metaStorageKeys.length,
    };
}

async function applyAtomicPluginStorageReconciliation(
    prepared: PreparedReconciliation,
    deps: ReconcileDependencies,
    options: Omit<PluginStorageReconcileOptions, "dependencies">,
): Promise<PluginStorageReconcileResult> {
    if (prepared.direction === "none") return prepared;
    const db = deps.getDatabase();
    const sourceOwnership = await readCurrentOwnership(db, options.signal);
    if (
        !sourceOwnership.manifestValid
        || (db.pluginStorageGeneration
            && sourceOwnership.manifest?.generation !== db.pluginStorageGeneration)
    ) {
        throw new Error("Cannot replace an invalid plugin storage ownership manifest.");
    }
    const { cloneDatabaseState } = await import("../storage/databaseClone");
    const target = cloneDatabaseState(db);
    target.pluginStorageGeneration = prepared.generation;
    if (prepared.direction === "externalize") {
        target.optimizePluginMemory = true;
        target.pluginCustomStorage = copyDatabasePluginStorageRecord(prepared.nextValues);
        if (getPluginStorageRecordKeys(prepared.nextMeta).length > 0) {
            target.pluginStorageMeta = copyDatabasePluginStorageRecord(prepared.nextMeta);
        } else {
            delete target.pluginStorageMeta;
        }
    } else {
        target.optimizePluginMemory = false;
        target.pluginCustomStorage = copyDatabasePluginStorageRecord(prepared.nextValues);
        if (getPluginStorageRecordKeys(prepared.nextMeta).length > 0) {
            target.pluginStorageMeta = copyDatabasePluginStorageRecord(prepared.nextMeta);
        } else {
            delete target.pluginStorageMeta;
        }
    }

    const { RisuSaveEncoder } = await import("../storage/risuSave");
    const encoder = new RisuSaveEncoder();
    await encoder.init(target, {
        compression: false,
        skipRemoteSavingOnCharacters: false,
    });
    const encoded = encoder.encode();
    if (!encoded) throw new Error("Failed to encode plugin storage transition");
    await commitPersistentPluginStorageTransition({
        version: 1,
        source: {
            optimized: db.optimizePluginMemory === true,
            generation: db.pluginStorageGeneration ?? null,
            manifest: sourceOwnership.manifest,
        },
        database: new Uint8Array(encoded),
    }, options.signal);

    // Publish the same routing state in memory only after SQLite has committed
    // the database generation, exact manifest, and every affected row.
    db.optimizePluginMemory = target.optimizePluginMemory;
    db.pluginStorageGeneration = prepared.generation;
    if (prepared.direction === "externalize") {
        db.pluginCustomStorage = createDatabasePluginStorageRecord();
        delete db.pluginStorageMeta;
        const total = prepared.valueEntries.length + prepared.metaEntries.length;
        let completed = 0;
        for (let index = 0; index < total; index++) {
            options.onProgress?.({
                direction: "externalize",
                completed: ++completed,
                total,
            });
        }
        const { setPatchSyncBaseline } = await import("../globalApi.svelte");
        setPatchSyncBaseline?.(db);
        return {
            direction: "externalize",
            values: prepared.valueEntries.length,
            meta: prepared.metaEntries.length,
        };
    }

    db.pluginCustomStorage = copyDatabasePluginStorageRecord(prepared.nextValues);
    if (getPluginStorageRecordKeys(prepared.nextMeta).length > 0) {
        db.pluginStorageMeta = copyDatabasePluginStorageRecord(prepared.nextMeta);
    } else {
        delete db.pluginStorageMeta;
    }
    const { setPatchSyncBaseline } = await import("../globalApi.svelte");
    setPatchSyncBaseline?.(db);
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
        const productionAtomic = options.dependencies === undefined;
        const prepared = await preparePluginStorageReconciliation(
            deps,
            target,
            options,
            productionAtomic,
        );
        return productionAtomic
            ? applyAtomicPluginStorageReconciliation(prepared, deps, options)
            : applyPluginStorageReconciliation(prepared, deps, options);
    }, options.signal);
}

function bootRecoveryIssue(
    error: unknown,
    encodedKey: string,
    fallback: "read-failed" | "write-failed" | "remove-failed" | "persist-failed",
): PluginStorageRecoveryIssue {
    return {
        code: error instanceof SyntaxError
            ? "invalid-json"
            : error instanceof TypeError
                ? "unsupported-json"
                : fallback,
        encodedKey,
    };
}

interface BootInlineCollection {
    entries: PreparedStorageEntry[];
    storageKeys: Set<string>;
    /** Descriptor-preserving copy, or null when a source trap prevented one. */
    preserved: Record<string, unknown> | null;
}

function collectBootInlineEntries(
    source: unknown,
    prefix: PluginSaveStoragePrefix,
    issues: PluginStorageRecoveryIssue[],
): BootInlineCollection {
    const failed = (): BootInlineCollection => ({
        entries: [],
        storageKeys: new Set(),
        preserved: null,
    });
    if (source === null || typeof source !== "object" || Array.isArray(source)) {
        issues.push({ code: "unsupported-json", encodedKey: prefix });
        return failed();
    }
    let prototype: object | null;
    try {
        prototype = Reflect.getPrototypeOf(source);
    } catch {
        issues.push({ code: "unsupported-json", encodedKey: prefix });
        return failed();
    }
    if (prototype !== Object.prototype && prototype !== null) {
        issues.push({ code: "unsupported-json", encodedKey: prefix });
        return failed();
    }

    let ownKeys: PropertyKey[];
    try {
        ownKeys = Reflect.ownKeys(source);
    } catch {
        issues.push({ code: "unsupported-json", encodedKey: prefix });
        return failed();
    }
    const seen = new Set<PropertyKey>(ownKeys);
    for (const key of Object.getOwnPropertyNames(Object.prototype)) {
        if (seen.has(key)) continue;
        try {
            if (Reflect.getOwnPropertyDescriptor(source, key)?.enumerable) {
                ownKeys.push(key);
                seen.add(key);
            }
        } catch {
            issues.push({ code: "unsupported-json", encodedKey: prefix });
            return failed();
        }
    }

    const entries: PreparedStorageEntry[] = [];
    const storageKeys = new Set<string>();
    const preserved = prototype === null
        ? createPluginStorageRecord<unknown>()
        : createDatabasePluginStorageRecord<unknown>();
    for (const key of ownKeys) {
        let descriptor: PropertyDescriptor | undefined;
        try {
            descriptor = Reflect.getOwnPropertyDescriptor(source, key);
        } catch {
            issues.push({ code: "unsupported-json", encodedKey: prefix });
            return failed();
        }
        if (descriptor) {
            try {
                Object.defineProperty(preserved, key, descriptor);
            } catch {
                issues.push({ code: "unsupported-json", encodedKey: prefix });
                return failed();
            }
        }
        if (typeof key !== "string") {
            issues.push({ code: "unsupported-json", encodedKey: prefix });
            continue;
        }
        let storageKey: string;
        try {
            storageKey = makeArchiveSafePluginSaveStorageKey(prefix, key);
        } catch {
            issues.push({ code: "invalid-encoded-key", encodedKey: prefix });
            continue;
        }
        storageKeys.add(storageKey);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
            issues.push({ code: "unsupported-json", encodedKey: storageKey });
            continue;
        }
        try {
            entries.push({
                key,
                storageKey,
                value: snapshotJsonValue(descriptor.value),
            });
        } catch (error) {
            issues.push(bootRecoveryIssue(error, storageKey, "read-failed"));
        }
    }
    return { entries, storageKeys, preserved };
}

async function listBootStorageKeys(
    deps: ReconcileDependencies,
    prefix: PluginSaveStoragePrefix,
    issues: PluginStorageRecoveryIssue[],
    signal?: AbortSignal | null,
): Promise<string[] | null> {
    try {
        throwIfAborted(signal);
        return await deps.listPersistentKeys(prefix, signal);
    } catch {
        throwIfAborted(signal);
        issues.push({ code: "list-failed", encodedKey: prefix });
        return null;
    }
}

async function readBootStorageRows(
    deps: ReconcileDependencies,
    prefix: PluginSaveStoragePrefix,
    listed: string[] | null,
    cached: boolean,
    issues: PluginStorageRecoveryIssue[],
    signal?: AbortSignal | null,
): Promise<PreparedStorageEntry[]> {
    if (listed === null) return [];
    const rows: PreparedStorageEntry[] = [];
    for (const storageKey of listed) {
        throwIfAborted(signal);
        let key: string | null = null;
        try {
            key = decodeListedStorageKey(storageKey, prefix);
            if (
                key === null
                || makeArchiveSafePluginSaveStorageKey(prefix, key) !== storageKey
            ) {
                throw new Error("non-canonical encoded key");
            }
        } catch {
            issues.push({ code: "invalid-encoded-key", encodedKey: storageKey });
            continue;
        }
        try {
            const row = await deps.readPersistentJsonRow(
                storageKey,
                cached ? { cached: true, signal } : { signal },
            );
            if (row.kind === "missing") {
                issues.push({ code: "read-failed", encodedKey: storageKey });
                continue;
            }
            const value = snapshotJsonValue(row.value);
            rows.push({ key, storageKey, value });
        } catch (error) {
            throwIfAborted(signal);
            issues.push(bootRecoveryIssue(error, storageKey, "read-failed"));
        }
    }
    return rows;
}

function bootJsonValuesEqual(left: unknown, right: unknown): boolean {
    return stringifyJsonValue(left) === stringifyJsonValue(right);
}

function restoreBootInlineRecords(
    db: Database,
    values: Database["pluginCustomStorage"],
    meta: Database["pluginStorageMeta"] | undefined,
): void {
    db.pluginCustomStorage = values;
    if (meta === undefined) delete db.pluginStorageMeta;
    else db.pluginStorageMeta = meta;
}

/**
 * Boot-only recovery boundary for storage left half-migrated by an older build.
 *
 * Unlike the explicit settings transition, this path isolates malformed and
 * transient rows by encoded KV key. Once any source is suspect, reconciliation
 * becomes copy-only: good rows are usable for this session while neither the
 * inline nor external set is destructively cleaned up. The user can repair the
 * underlying row or connectivity and retry from Settings -> Plugins.
 */
export async function reconcilePluginStorageModeForBoot(
    options: PluginStorageReconcileOptions = {},
): Promise<PluginStorageBootReconcileResult> {
    const deps = resolveReconcileDependencies(options.dependencies);
    const controller = new AbortController();
    const onAbort = () => controller.abort(abortReason(options.signal));
    if (options.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    const timeout = setTimeout(
        () => controller.abort(new Error("Plugin storage boot recovery timed out.")),
        options.timeoutMs ?? PLUGIN_STORAGE_BOOT_RECOVERY_TIMEOUT_MS,
    );
    const signal = controller.signal;
    try {
        if (options.dependencies === undefined) {
            const db = getDatabase();
            const direction = db.optimizePluginMemory === true
                ? "externalize"
                : "internalize";
            try {
                const result = await reconcilePluginStorageMode({
                    ...options,
                    signal,
                    dependencies: undefined,
                });
                setPluginStorageRecoveryState(null);
                return { ...result, issues: [] };
            } catch (error) {
                const issue = bootRecoveryIssue(
                    error,
                    "plugin-storage/manifest.json",
                    "persist-failed",
                );
                setPluginStorageRecoveryState({ direction, issues: [issue] });
                return {
                    direction,
                    values: 0,
                    meta: 0,
                    issues: [issue],
                };
            }
        }
        return await withPluginSaveStorageLock(async () => {
        throwIfAborted(signal);
        invalidateStorageEnumerationSnapshot();
        const db = deps.getDatabase();
        const target = db.optimizePluginMemory === true;
        const direction = target ? "externalize" : "internalize";
        const issues: PluginStorageRecoveryIssue[] = [];
        const valueSource = db.pluginCustomStorage ?? createDatabasePluginStorageRecord();
        const metaSource = db.pluginStorageMeta ?? createDatabasePluginStorageRecord<
            NonNullable<Database["pluginStorageMeta"]>[string]
        >();
        const inlineValueEntries = collectBootInlineEntries(
            valueSource,
            PLUGIN_SAVE_PREFIX,
            issues,
        );
        const inlineMetaEntries = collectBootInlineEntries(
            metaSource,
            PLUGIN_SAVE_META_PREFIX,
            issues,
        );

        const [listedValueKeys, listedMetaKeys] = await Promise.all([
            listBootStorageKeys(deps, PLUGIN_SAVE_PREFIX, issues, signal),
            listBootStorageKeys(deps, PLUGIN_SAVE_META_PREFIX, issues, signal),
        ]);
        const [externalValueEntries, externalMetaEntries] = await Promise.all([
            readBootStorageRows(
                deps,
                PLUGIN_SAVE_PREFIX,
                listedValueKeys,
                true,
                issues,
                signal,
            ),
            readBootStorageRows(
                deps,
                PLUGIN_SAVE_META_PREFIX,
                listedMetaKeys,
                false,
                issues,
                signal,
            ),
        ]);

        const externalValuesByKey = new Map(
            externalValueEntries.map(entry => [entry.storageKey, entry]),
        );
        const externalMetaByKey = new Map(
            externalMetaEntries.map(entry => [entry.storageKey, entry]),
        );

        const recordConflicts = (
            inline: BootInlineCollection,
            external: Map<string, PreparedStorageEntry>,
        ) => {
            for (const entry of inline.entries) {
                const duplicate = external.get(entry.storageKey);
                if (duplicate && !bootJsonValuesEqual(entry.value, duplicate.value)) {
                    issues.push({
                        code: "conflicting-copies",
                        encodedKey: entry.storageKey,
                    });
                }
            }
        };
        recordConflicts(inlineValueEntries, externalValuesByKey);
        recordConflicts(inlineMetaEntries, externalMetaByKey);

        if (target) {
            const valueEntries = inlineValueEntries.entries;
            const metaEntries = inlineMetaEntries.entries;
            const total = valueEntries.length + metaEntries.length;
            options.onStart?.({ direction, completed: 0, total });
            let completed = 0;
            let valueCopies = 0;
            let metaCopies = 0;
            const listedValueSet = listedValueKeys === null
                ? null
                : new Set(listedValueKeys);
            const listedMetaSet = listedMetaKeys === null
                ? null
                : new Set(listedMetaKeys);
            const inlineMetaByKey = new Map(metaEntries.map(entry => [entry.key, entry]));
            const pairedMetaKeys = new Set<string>();

            if (listedValueSet !== null) {
                for (const entry of valueEntries) {
                    throwIfAborted(signal);
                    if (listedValueSet.has(entry.storageKey)) continue;
                    const metaEntry = inlineMetaByKey.get(entry.key);
                    if (metaEntry && listedMetaSet?.has(metaEntry.storageKey)) {
                        const externalMeta = externalMetaByKey.get(metaEntry.storageKey);
                        // A conflicting or unreadable destination is quarantined;
                        // never let the atomic recovery copy overwrite it.
                        if (!externalMeta
                            || !bootJsonValuesEqual(metaEntry.value, externalMeta.value)) {
                            continue;
                        }
                    }
                    if (metaEntry) pairedMetaKeys.add(metaEntry.storageKey);
                    try {
                        await deps.restorePersistentPluginStoragePair(
                            entry.storageKey,
                            entry.value,
                            metaEntry?.value,
                            signal,
                        );
                        valueCopies += 1;
                        completed += 1;
                        if (metaEntry) {
                            if (!listedMetaSet?.has(metaEntry.storageKey)) metaCopies += 1;
                            completed += 1;
                        }
                        options.onProgress?.({ direction, completed, total });
                    } catch (error) {
                        throwIfAborted(signal);
                        issues.push(bootRecoveryIssue(error, entry.storageKey, "write-failed"));
                    }
                }
            }

            // Historical owner orphans have no value to pair atomically. They
            // remain recoverable as isolated strict JSON rows.
            if (listedMetaSet !== null) {
                for (const entry of metaEntries) {
                    throwIfAborted(signal);
                    if (pairedMetaKeys.has(entry.storageKey)
                        || listedMetaSet.has(entry.storageKey)) continue;
                    try {
                        await deps.writePersistentJson(entry.storageKey, entry.value, signal);
                        metaCopies += 1;
                        options.onProgress?.({ direction, completed: ++completed, total });
                    } catch (error) {
                        throwIfAborted(signal);
                        issues.push(bootRecoveryIssue(error, entry.storageKey, "write-failed"));
                    }
                }
            }

            if (issues.length === 0) {
                const originalValues = db.pluginCustomStorage;
                const originalMeta = db.pluginStorageMeta;
                if (total > 0) {
                    try {
                        db.pluginCustomStorage = createDatabasePluginStorageRecord();
                        delete db.pluginStorageMeta;
                        throwIfAborted(signal);
                        await deps.persistDatabase();
                    } catch (error) {
                        restoreBootInlineRecords(db, originalValues, originalMeta);
                        throwIfAborted(signal);
                        issues.push(bootRecoveryIssue(error, "database/database.bin", "persist-failed"));
                    }
                }
            }

            const result: PluginStorageBootReconcileResult = {
                direction: total > 0 || issues.length > 0 ? direction : "none",
                values: valueCopies,
                meta: metaCopies,
                issues,
            };
            setPluginStorageRecoveryState(issues.length > 0 ? { direction, issues } : null);
            return result;
        }

        const valueRows = externalValueEntries;
        const metaRows = externalMetaEntries;
        const total = valueRows.length + metaRows.length;
        options.onStart?.({ direction, completed: 0, total });
        let completed = 0;

        // Never overwrite a duplicate during boot. Equal duplicates need no
        // assignment; conflicting or unreadable duplicates remain exact.
        const appliedValueRows = inlineValueEntries.preserved === null
            ? []
            : valueRows.filter(entry => !inlineValueEntries.storageKeys.has(entry.storageKey));
        const appliedMetaRows = inlineMetaEntries.preserved === null
            ? []
            : metaRows.filter(entry => !inlineMetaEntries.storageKeys.has(entry.storageKey));
        const originalValues = db.pluginCustomStorage;
        const originalMeta = db.pluginStorageMeta;
        let publishedLiveCopy = false;
        try {
            if (appliedValueRows.length > 0) {
                const nextValues = inlineValueEntries.preserved!;
                for (const entry of appliedValueRows) {
                    throwIfAborted(signal);
                    definePluginStorageRecordValue(nextValues, entry.key, entry.value);
                    options.onProgress?.({ direction, completed: ++completed, total });
                }
                db.pluginCustomStorage = nextValues;
                publishedLiveCopy = true;
            }
            if (appliedMetaRows.length > 0) {
                const nextMeta = inlineMetaEntries.preserved! as NonNullable<
                    Database["pluginStorageMeta"]
                >;
                for (const entry of appliedMetaRows) {
                    throwIfAborted(signal);
                    definePluginStorageRecordValue(nextMeta, entry.key, entry.value as never);
                    options.onProgress?.({ direction, completed: ++completed, total });
                }
                db.pluginStorageMeta = nextMeta;
                publishedLiveCopy = true;
            }
        } catch {
            restoreBootInlineRecords(db, originalValues, originalMeta);
            throwIfAborted(signal);
            issues.push({ code: "unsupported-json", encodedKey: PLUGIN_SAVE_PREFIX });
            publishedLiveCopy = false;
        }

        const applied = appliedValueRows.length + appliedMetaRows.length;
        let persisted = applied === 0 && issues.length === 0;
        if (publishedLiveCopy && applied > 0 && issues.length === 0) {
            try {
                throwIfAborted(signal);
                await deps.persistDatabase();
                persisted = true;
            } catch (error) {
                restoreBootInlineRecords(db, originalValues, originalMeta);
                throwIfAborted(signal);
                issues.push(bootRecoveryIssue(error, "database/database.bin", "persist-failed"));
                persisted = false;
            }
        }

        // Any suspect source keeps the complete external set as a recovery
        // copy. A clean run removes rows only after the inline DB committed.
        if (persisted && issues.length === 0) {
            for (const entry of valueRows) {
                try {
                    throwIfAborted(signal);
                    await deps.removePersistentKey(entry.storageKey, signal);
                } catch (error) {
                    throwIfAborted(signal);
                    issues.push(bootRecoveryIssue(error, entry.storageKey, "remove-failed"));
                }
            }
            for (const entry of metaRows) {
                try {
                    throwIfAborted(signal);
                    await deps.removePersistentKey(entry.storageKey, signal);
                } catch (error) {
                    throwIfAborted(signal);
                    issues.push(bootRecoveryIssue(error, entry.storageKey, "remove-failed"));
                }
            }
        }

        const result: PluginStorageBootReconcileResult = {
            direction: total > 0 || issues.length > 0 ? direction : "none",
            values: appliedValueRows.length,
            meta: appliedMetaRows.length,
            issues,
        };
        setPluginStorageRecoveryState(issues.length > 0 ? { direction, issues } : null);
        return result;
        }, signal);
    } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
    }
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
                    true,
                );
                if (options.dependencies === undefined) {
                    return await applyAtomicPluginStorageReconciliation(
                        prepared,
                        deps,
                        options,
                    );
                }
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
            }, options.signal);
        } finally {
            finishTransition();
        }
    });
}
