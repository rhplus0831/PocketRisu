import { getDatabase, type Database } from "../storage/database.svelte";
import {
    batchPersistentPluginStorage,
    abortPersistentPluginStorageTransition,
    beginPersistentPluginStorageTransition,
    clearExternalizedPluginStorage,
    clearPersistentPrefix,
    commitPersistentPluginStorageMutation,
    getPersistentStorageFreeBytes,
    finalizePersistentPluginStorageTransition,
    listPersistentEntriesWithSizes,
    listPersistentKeys,
    mutatePersistentPluginStorage,
    preparePersistentJson,
    readPersistentPluginStorageManifestSnapshot,
    readPersistentPluginStorageManifestState,
    readPersistentPluginStorageViewerPage,
    readPersistentPluginStorageState,
    readPersistentPluginStorageTransitionRow,
    readPersistentJson,
    readPersistentJsonRow,
    removePersistentPluginStoragePreservingOwner,
    removePersistentKey,
    restorePersistentPluginStoragePair,
    uploadPersistentPluginStorageTransitionRow,
    setPreparedPersistentPluginStoragePreservingOwner,
    writePersistentJson,
} from "../storage/persistentKv";
import {
    convertCompatibleJsonValue,
    snapshotJsonValue,
    stringifyJsonValue,
} from "../storage/jsonValue";
import { assertWellFormedUnicode } from "../storage/unicodeWellFormed";
import {
    beginDatabaseSavePause,
    blockDatabaseSavesUntilReload,
    requireCommittedDatabaseSave,
} from "../storage/databaseSave";
import { StorageError } from "../storage/storageError";
import { abortReason, awaitWithAbort, throwIfAborted } from "../storage/abort";
import { sha256OwnedBytes } from "../storage/resourceCache";
import { safeStructuredClone } from "../polyfill";
import { Packr } from "msgpackr/index-no-eval";
import {
    decodePluginSaveStorageKey,
    isHashedPluginSaveStorageKey,
    makeArchiveSafePluginSaveStorageKey,
    pluginSaveStorageKeyMappingComponent,
    PLUGIN_SAVE_META_PREFIX,
    PLUGIN_SAVE_PREFIX,
    type PluginSaveStoragePrefix,
} from "../storage/pluginSaveKeyPolicy";
import { v4 as uuidv4 } from "uuid";
import {
    beginPluginStorageModeTransition,
    hasEnabledLegacyPlugins,
    latchPluginStorageModeTransitionUntilReload,
    withPluginLifecycleLock,
} from "./pluginMemoryOptimization";
import {
    copyDatabasePluginStorageRecord,
    createDatabasePluginStorageRecord,
    createPluginStorageRecord,
    definePluginStorageRecordValue,
    getPluginStorageRecordKeys,
    hasPluginStorageRecordValue,
    orderLegacyPluginStorageKeys,
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
import {
    PLUGIN_STORAGE_BATCH_MAX_OPERATIONS,
    PLUGIN_STORAGE_REVISION_PATTERN,
    PLUGIN_STORAGE_UUID_PATTERN,
    type PluginStorageBatchOperation as PersistentPluginStorageBatchOperation,
} from "../storage/pluginStorageBatch";
import {
    runConfirmedPluginStorageRemove,
    runPublicPluginStorageMutation,
    type PublicPluginStorageConfirmedRemoveOutcome,
    type PublicPluginStorageMutationOutcome,
} from "./pluginStorageMutationOutcome";
import {
    detectPluginStorageViewerType,
    valueToPluginStorageViewerText,
    type PluginStorageViewerEntry,
} from "./pluginStorageViewerPage";

export { PLUGIN_SAVE_META_PREFIX, PLUGIN_SAVE_PREFIX };
export const PLUGIN_STORAGE_MANIFEST_KEY = "plugin-storage/manifest.json";

interface PluginStorageManifest {
    version: 1 | 2 | 3;
    generation: string;
    valueKeys: string[];
    metaKeys: string[];
    keyMappings?: [string, string][];
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
export const PLUGIN_STORAGE_INTERNALIZE_MAX_ENTRIES = 100_000;
export const PLUGIN_STORAGE_INTERNALIZE_DISK_MULTIPLIER = 3;
export const PLUGIN_STORAGE_LARGE_INLINE_WARNING_BYTES = 64 * 1024 * 1024;
export const PLUGIN_STORAGE_LARGE_INLINE_ROW_WARNING_BYTES = 32 * 1024 * 1024;

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
let pluginStorageBarrierLatchedUntilReload = false;
const storageScopeQueues = new Map<string, Promise<void>>();
let inlinePluginStoragePublishQueue: Promise<void> = Promise.resolve();
let storageEnumerationSnapshot: {
    database: Database;
    optimized: boolean;
    generation: number;
    keys: string[];
} | null = null;
let storageOwnershipSnapshot: {
    database: Database;
    generation: string;
    keySetGeneration: number;
    ownership: PluginStorageOwnership;
} | null = null;

function invalidateStorageEnumerationSnapshot(): void {
    storageEnumerationSnapshot = null;
    storageOwnershipSnapshot = null;
    markPluginStorageKeySetChanged();
}

/**
 * Inline storage publishes by replacing the complete value/meta maps. Per-key
 * queues alone therefore cannot protect a disjoint-key writer from a batch
 * that cloned the maps before awaiting its revision hashes. Keep this mutex
 * inside the already-admitted shared operation so mode transitions cannot
 * deadlock behind a nested barrier acquisition.
 */
async function withInlinePluginStoragePublishLock<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal | null,
): Promise<T> {
    const previous = inlinePluginStoragePublishQueue;
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
    });
    void result.catch(() => undefined);
    const current = previous.catch(() => undefined).then(async () => {
        try {
            throwIfAborted(signal);
            resolveResult(await operation());
        } catch (error) {
            rejectResult(error);
        }
    });
    inlinePluginStoragePublishQueue = current;
    return await awaitWithAbort(result, signal);
}

async function withPluginSaveStorageScope<T>(
    scope: string,
    operation: () => Promise<T>,
    signal?: AbortSignal | null,
): Promise<T> {
    return withPluginSaveStorageScopes([scope], operation, signal);
}

async function withPluginSaveStorageScopes<T>(
    requestedScopes: readonly string[],
    operation: () => Promise<T>,
    signal?: AbortSignal | null,
): Promise<T> {
    const scopes = [...new Set(requestedScopes)].sort();
    if (scopes.length === 0) throw new TypeError("At least one plugin storage scope is required.");
    // Acquire shared admission immediately. This makes every ordinary call
    // submitted before a transition part of the old-mode drain, while calls
    // submitted after it wait for the new mode.
    const releaseBarrier = await storageBarrier.acquireShared(signal);
    const previous = scopes.map(scope => storageScopeQueues.get(scope) ?? Promise.resolve());
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
    const current = Promise.all(previous.map(token => token.catch(() => undefined)))
        .then(async () => {
            try {
                throwIfAborted(signal);
                resolveResult(await operation());
            } catch (error) {
                rejectResult(error);
            }
        });
    for (const scope of scopes) storageScopeQueues.set(scope, current);
    void current.then(() => {
        for (const scope of scopes) {
            if (storageScopeQueues.get(scope) === current) storageScopeQueues.delete(scope);
        }
        releaseBarrier();
    });

    return await awaitWithAbort(result, signal);
}

function normalizePluginStorageKey(key: unknown): string {
    // The inline object backend historically applies ordinary property-key
    // coercion. Do it before routing so optimized mode has identical behavior.
    return String(key);
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
            if (!pluginStorageBarrierLatchedUntilReload) release();
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

/** Atomically queue one operation behind every touched key without deadlock. */
export function withPluginSaveStorageKeySetLock<T>(
    keys: readonly string[],
    operation: () => Promise<T>,
    signal?: AbortSignal | null,
): Promise<T> {
    return withPluginSaveStorageScopes(
        keys.map(key => `save:${normalizePluginStorageKey(key)}`),
        operation,
        signal,
    );
}

function pluginStorageManifestMappingMap(
    manifest?: PluginStorageManifest | null,
): Map<string, string> {
    return new Map(manifest?.version === 3 ? manifest.keyMappings ?? [] : []);
}

function decodeListedStorageKey(
    fullKey: string,
    prefix: string,
    manifest?: PluginStorageManifest | null,
): string | null {
    try {
        const component = pluginSaveStorageKeyMappingComponent(
            fullKey,
            prefix as PluginSaveStoragePrefix,
        );
        return decodePluginSaveStorageKey(
            fullKey,
            prefix as PluginSaveStoragePrefix,
            component === null
                ? undefined
                : pluginStorageManifestMappingMap(manifest).get(component),
        );
    } catch {
        return null;
    }
}

function normalizeManifestMappings(value: unknown): [string, string][] | null {
    if (!Array.isArray(value)) return null;
    const mappings: [string, string][] = [];
    const seen = new Set<string>();
    for (const entry of value) {
        if (!Array.isArray(entry) || entry.length !== 2
            || typeof entry[0] !== "string" || typeof entry[1] !== "string"
            || seen.has(entry[0])) return null;
        const storageKey = makeArchiveSafePluginSaveStorageKey(PLUGIN_SAVE_PREFIX, entry[1]);
        if (pluginSaveStorageKeyMappingComponent(storageKey, PLUGIN_SAVE_PREFIX) !== entry[0]) {
            return null;
        }
        seen.add(entry[0]);
        mappings.push([entry[0], entry[1]]);
    }
    return mappings;
}

function normalizeManifestKeys(
    value: unknown,
    prefix: string,
    manifest: PluginStorageManifest,
): string[] | null {
    if (!Array.isArray(value)) return null;
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        if (typeof item !== "string") {
            return null;
        }
        try {
            const decoded = decodeListedStorageKey(item, prefix, manifest);
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
    if ((candidate.version !== 1 && candidate.version !== 2 && candidate.version !== 3)
        || typeof candidate.generation !== "string"
        || candidate.generation.length === 0) return null;
    const keyMappings = candidate.version === 3
        ? normalizeManifestMappings(candidate.keyMappings)
        : [];
    if (!keyMappings) return null;
    const partialManifest: PluginStorageManifest = {
        version: candidate.version,
        generation: candidate.generation,
        valueKeys: [],
        metaKeys: [],
        ...(candidate.version === 3 ? { keyMappings } : {}),
    };
    const valueKeys = normalizeManifestKeys(
        candidate.valueKeys,
        PLUGIN_SAVE_PREFIX,
        partialManifest,
    );
    const metaKeys = normalizeManifestKeys(
        candidate.metaKeys,
        PLUGIN_SAVE_META_PREFIX,
        partialManifest,
    );
    if (!valueKeys || !metaKeys) return null;
    const declaredComponents = new Set<string>();
    for (const [keys, prefix] of [
        [valueKeys, PLUGIN_SAVE_PREFIX],
        [metaKeys, PLUGIN_SAVE_META_PREFIX],
    ] as const) {
        for (const key of keys) {
            const component = pluginSaveStorageKeyMappingComponent(key, prefix);
            if (component !== null) declaredComponents.add(component);
        }
    }
    if (declaredComponents.size !== keyMappings.length
        || keyMappings.some(([component]) => !declaredComponents.has(component))) return null;
    return {
        version: candidate.version,
        generation: candidate.generation,
        valueKeys,
        metaKeys,
        ...(candidate.version === 3 ? { keyMappings } : {}),
    };
}

function buildPluginStorageManifest(
    generation: string,
    valueKeys: Iterable<string>,
    metaKeys: Iterable<string>,
    keyMappings: Iterable<[string, string]> = [],
): PluginStorageManifest {
    const mappings = [...keyMappings].map(([component, rawKey]) => [component, rawKey] as [string, string]);
    const manifest: PluginStorageManifest = {
        version: mappings.length > 0 ? 3 : 2,
        generation,
        valueKeys: [...new Set(valueKeys)],
        metaKeys: [...new Set(metaKeys)],
        ...(mappings.length > 0 ? { keyMappings: mappings } : {}),
    };
    const normalized = normalizePluginStorageManifest(manifest);
    if (!normalized) throw new TypeError("Plugin storage manifest key mappings are invalid.");
    return normalized;
}

function mergedPluginStorageKeyMappings(
    manifest: PluginStorageManifest | null | undefined,
    rawKeys: Iterable<string>,
    valueKeys: Iterable<string>,
    metaKeys: Iterable<string>,
): [string, string][] {
    const mappings = pluginStorageManifestMappingMap(manifest);
    for (const rawKey of rawKeys) {
        const storageKey = makeArchiveSafePluginSaveStorageKey(PLUGIN_SAVE_PREFIX, rawKey);
        const component = pluginSaveStorageKeyMappingComponent(storageKey, PLUGIN_SAVE_PREFIX);
        if (component === null) continue;
        const existing = mappings.get(component);
        if (existing !== undefined && existing !== rawKey) {
            throw new TypeError("Plugin storage key hash collision.");
        }
        mappings.set(component, rawKey);
    }
    const declared = new Set<string>();
    for (const [keys, prefix] of [
        [valueKeys, PLUGIN_SAVE_PREFIX],
        [metaKeys, PLUGIN_SAVE_META_PREFIX],
    ] as const) {
        for (const key of keys) {
            const component = pluginSaveStorageKeyMappingComponent(key, prefix);
            if (component !== null) declared.add(component);
        }
    }
    return [...mappings].filter(([component]) => declared.has(component));
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
    const physicalValues = new Set(listedValueKeys.filter(key => (
        isHashedPluginSaveStorageKey(key, PLUGIN_SAVE_PREFIX)
        || decodeListedStorageKey(key, PLUGIN_SAVE_PREFIX) !== null
    )));
    const physicalMeta = new Set(listedMetaKeys.filter(key => (
        isHashedPluginSaveStorageKey(key, PLUGIN_SAVE_META_PREFIX)
        || decodeListedStorageKey(key, PLUGIN_SAVE_META_PREFIX) !== null
    )));

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
    if (db.optimizePluginMemory === true && db.pluginStorageGeneration) {
        const snapshot = await readPersistentPluginStorageManifestSnapshot(
            db.pluginStorageGeneration,
            signal,
        );
        return {
            manifest: snapshot.manifest,
            manifestPresent: true,
            manifestValid: true,
            valueKeys: snapshot.valueKeys,
            metaKeys: snapshot.metaKeys,
        };
    }
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

function clonePluginStorageOwnership(ownership: PluginStorageOwnership): PluginStorageOwnership {
    return {
        ...ownership,
        manifest: ownership.manifest ? {
            ...ownership.manifest,
            valueKeys: [...ownership.manifest.valueKeys],
            metaKeys: [...ownership.manifest.metaKeys],
            ...(ownership.manifest.version === 3
                ? {
                    keyMappings: ownership.manifest.keyMappings?.map(
                        ([component, rawKey]) => [component, rawKey] as [string, string],
                    ),
                }
                : {}),
        } : null,
        valueKeys: [...ownership.valueKeys],
        metaKeys: [...ownership.metaKeys],
    };
}

async function readCachedCurrentOwnership(
    db: Database,
    signal?: AbortSignal | null,
    refresh = false,
): Promise<PluginStorageOwnership> {
    const generation = db.optimizePluginMemory === true
        ? db.pluginStorageGeneration
        : undefined;
    const keySetGeneration = getPluginStorageKeySetGeneration();
    if (!refresh
        && generation
        && storageOwnershipSnapshot?.database === db
        && storageOwnershipSnapshot.generation === generation
        && storageOwnershipSnapshot.keySetGeneration === keySetGeneration) {
        throwIfAborted(signal);
        return clonePluginStorageOwnership(storageOwnershipSnapshot.ownership);
    }
    const ownership = await readCurrentOwnership(db, signal);
    if (generation && keySetGeneration === getPluginStorageKeySetGeneration()) {
        storageOwnershipSnapshot = {
            database: db,
            generation,
            keySetGeneration,
            ownership: clonePluginStorageOwnership(ownership),
        };
    }
    return ownership;
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
    writes: { storageKey: string; valueBytes: Uint8Array }[],
    deletes: string[],
    mutate: (valueKeys: Set<string>, metaKeys: Set<string>) => void,
    signal?: AbortSignal | null,
    logicalKeys: Iterable<string> = [],
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
        const keyMappings = mergedPluginStorageKeyMappings(
            ownership.manifest,
            logicalKeys,
            valueKeys,
            metaKeys,
        );
        try {
            await commitPersistentPluginStorageMutation({
                generation,
                expectedManifest: ownership.manifest,
                nextManifest: buildPluginStorageManifest(
                    generation,
                    valueKeys,
                    metaKeys,
                    keyMappings,
                ),
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

async function commitHashedOwnedPluginStorageMutation(
    db: Database,
    operation: PersistentPluginStorageBatchOperation,
    signal?: AbortSignal | null,
): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        const generation = db.pluginStorageGeneration;
        if (!generation) {
            throw new Error(
                "Optimized plugin storage is not reconciled; reload to complete its atomic adoption.",
            );
        }
        const manifestState = await readPersistentPluginStorageManifestState(generation, signal);
        const result = await batchPersistentPluginStorage({
            generation,
            expectedManifestRevision: manifestState.manifestRevision,
            operations: [operation],
        }, signal);
        if (result.outcome === "committed") return;
        if (result.code === "PLUGIN_STORAGE_GENERATION_CONFLICT" && attempt < 2) continue;
        throw new StorageError(result.error ?? "Plugin storage mutation failed.", {
            status: result.status,
            code: result.code,
            retryAfter: result.retryAfter,
            retryable: result.retryable,
            commitOutcomeUnknown: false,
            operation: "batch",
        });
    }
}

function validatedPluginStorageRecordKeys(
    source: unknown,
    fieldName = "pluginCustomStorage",
): string[] {
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
    return orderLegacyPluginStorageKeys(keys);
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
    const keys = validatedPluginStorageRecordKeys(source, fieldName);
    const snapshot = createDatabasePluginStorageRecord<unknown>();
    for (const key of keys) {
        const descriptor = Reflect.getOwnPropertyDescriptor(source as object, key)!;
        definePluginStorageRecordValue(snapshot, key, snapshotJsonValue(descriptor.value));
    }
    return snapshot;
}

/**
 * Detach the inline backend without narrowing it to the optimized backend's
 * JSON-only representation. The iframe bridge already structured-clones V3
 * arguments; this additional copy preserves invocation-time values while a
 * queued write waits, including legacy values such as Date, Map, Set, BigInt,
 * non-finite numbers, sparse arrays, and circular structured-clone data.
 *
 * Top-level accessors and hidden properties remain rejected so copying a
 * hostile database record cannot execute plugin-controlled getters.
 */
function cloneInlinePluginStorageRecord<T>(
    source: Record<string, T>,
    fieldName?: string,
): Record<string, T>;
function cloneInlinePluginStorageRecord(
    source: unknown,
    fieldName?: string,
): Record<string, unknown>;
function cloneInlinePluginStorageRecord(
    source: unknown,
    fieldName = "pluginCustomStorage",
): Record<string, unknown> {
    const keys = validatedPluginStorageRecordKeys(source, fieldName);
    const snapshot = createDatabasePluginStorageRecord<unknown>();
    for (const key of keys) {
        const descriptor = Reflect.getOwnPropertyDescriptor(source as object, key)!;
        definePluginStorageRecordValue(
            snapshot,
            key,
            safeStructuredClone(descriptor.value),
        );
    }
    return snapshot;
}

interface PreparedOptimizedPluginStorageValue {
    snapshot: unknown;
    prepared: ReturnType<typeof preparePersistentJson>;
}

function optimizedPluginStorageSubject(owner?: string): string {
    return owner ? `Plugin ${JSON.stringify(owner)}` : "The plugin";
}

function prepareOptimizedPluginStorageValue(
    value: unknown,
    owner?: string,
    autoConvert = false,
): PreparedOptimizedPluginStorageValue {
    let snapshot: unknown;
    try {
        snapshot = snapshotJsonValue(value);
    } catch (error) {
        let cause = error;
        let converted = false;
        if (autoConvert) {
            try {
                snapshot = convertCompatibleJsonValue(value);
                converted = true;
            } catch (conversionError) {
                cause = conversionError;
            }
        }
        if (!converted) {
            throw new StorageError(
                `${optimizedPluginStorageSubject(owner)} cannot save this value while “Optimize plugin memory usage” is enabled. `
                + "Use only JSON-compatible data: null, booleans, finite numbers, strings, dense arrays, and plain objects. "
                + (autoConvert
                    ? "Automatic conversion could not safely transform a function, circular reference, accessor, symbol, or custom class."
                    : "Turn on “Automatically convert compatible plugin values” to transform Date, Map, Set, BigInt, undefined, non-finite numbers, and sparse arrays. Functions and circular references still require plugin changes."),
                {
                    status: 400,
                    code: "PLUGIN_STORAGE_VALUE_UNSUPPORTED",
                    operation: "write",
                    retryable: false,
                    commitOutcomeUnknown: false,
                    commitOutcome: "not-committed",
                    cause,
                },
            );
        }
    }

    try {
        return {
            snapshot,
            prepared: preparePersistentJson(snapshot),
        };
    } catch (error) {
        if (error instanceof StorageError && error.code === "PLUGIN_VALUE_TOO_LARGE") {
            throw new StorageError(
                `${optimizedPluginStorageSubject(owner)} cannot save this value while “Optimize plugin memory usage” is enabled. ${error.message}`,
                {
                    status: error.status,
                    code: error.code,
                    retryAfter: error.retryAfter,
                    retryable: error.retryable,
                    commitOutcomeUnknown: error.commitOutcomeUnknown,
                    commitOutcome: error.commitOutcome,
                    operation: error.operation,
                    cause: error,
                },
            );
        }
        throw error;
    }
}

function unsupportedOptimizedPluginStorageTransition(error: unknown): StorageError {
    return new StorageError(
        "Some existing plugin data cannot be moved into optimized storage because it is not JSON-compatible. "
        + "Turn optimization off and update or reset the affected plugin, or ask its developer to store only null, booleans, finite numbers, strings, dense arrays, and plain objects.",
        {
            status: 400,
            code: "PLUGIN_STORAGE_VALUE_UNSUPPORTED",
            operation: "transition",
            retryable: false,
            commitOutcomeUnknown: false,
            commitOutcome: "not-committed",
            cause: error,
        },
    );
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
        const key = decodeListedStorageKey(storageKey, PLUGIN_SAVE_PREFIX, ownership.manifest);
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
        const key = decodeListedStorageKey(storageKey, PLUGIN_SAVE_META_PREFIX, ownership.manifest);
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
    const ownership = await readCachedCurrentOwnership(getDatabase(), signal, true);
    const storageKeys = prefix === PLUGIN_SAVE_META_PREFIX
        ? ownership.metaKeys
        : ownership.valueKeys;
    const keys: string[] = [];
    for (const storageKey of storageKeys) {
        throwIfAborted(signal);
        const decoded = decodeListedStorageKey(storageKey, prefix, ownership.manifest);
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
        return db.optimizePluginMemory
            ? cloneJsonPluginStorageRecord(
                source ?? createDatabasePluginStorageRecord(),
            )
            : cloneInlinePluginStorageRecord(
                source ?? createDatabasePluginStorageRecord(),
            );
    }, signal);
}

function createPluginStorageOwnerRecord(
    owner: string,
): NonNullable<Database["pluginStorageMeta"]>[string] {
    return {
        plugin: owner,
        updatedAt: Date.now(),
        revision: crypto.randomUUID(),
        generation: crypto.randomUUID(),
    };
}

/**
 * Apply a V3 database mutation while holding the exclusive pluginStorage barrier.
 * A provided plugin map is an exact replacement; `undefined` leaves the
 * authoritative key set unchanged. Legacy database custom keys are merged as
 * owner-attributed pluginStorage writes in the same publication. Optimized mode
 * never retains inline rows.
 */
export async function updateDatabaseWithPluginStorageSnapshot<T>(
    pluginCustomStorage: Record<string, unknown> | undefined,
    mutateDatabase: (signal?: AbortSignal) => T | Promise<T>,
    signal?: AbortSignal | null,
    compatibilityWrite?: {
        values: Record<string, unknown>;
        owner: string;
    },
): Promise<T> {
    throwIfAborted(signal);
    // Snapshot and validate before waiting so caller-owned objects cannot
    // change underneath the queued operation.
    const replacement = pluginCustomStorage === undefined
        ? undefined
        : cloneInlinePluginStorageRecord(pluginCustomStorage);
    const compatibilityValues = compatibilityWrite === undefined
        ? undefined
        : cloneInlinePluginStorageRecord(
            compatibilityWrite.values,
            "legacy database custom keys",
        );
    const compatibilityKeys = compatibilityValues === undefined
        ? []
        : getPluginStorageRecordKeys(compatibilityValues);
    const compatibilityOwner = compatibilityWrite?.owner;
    if (compatibilityKeys.length > 0) {
        if (!compatibilityOwner) {
            throw new TypeError("Legacy database custom-key storage requires a plugin owner.");
        }
        assertWellFormedUnicode(compatibilityOwner);
    }

    try {
        return await withPluginSaveStorageLock(async () => {
            throwIfAborted(signal);
            const db = getDatabase();
            // Validate live records descriptor-by-descriptor before this
            // database operation can clear, replace, or preserve any part.
            const previousValues = db.optimizePluginMemory
                ? cloneJsonPluginStorageRecord(
                    db.pluginCustomStorage ?? createDatabasePluginStorageRecord(),
                )
                : cloneInlinePluginStorageRecord(
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
                    const optimizedReplacement = createDatabasePluginStorageRecord<unknown>();
                    const preparedValues = new Map<string, ReturnType<typeof preparePersistentJson>>();
                    for (const key of getPluginStorageRecordKeys(replacement)) {
                        const optimizedValue = prepareOptimizedPluginStorageValue(
                            replacement[key],
                            undefined,
                            db.autoConvertPluginStorageValues === true,
                        );
                        definePluginStorageRecordValue(
                            optimizedReplacement,
                            key,
                            optimizedValue.snapshot,
                        );
                        preparedValues.set(key, optimizedValue.prepared);
                    }
                    for (const key of compatibilityKeys) {
                        const optimizedValue = prepareOptimizedPluginStorageValue(
                            compatibilityValues![key],
                            compatibilityOwner,
                            db.autoConvertPluginStorageValues === true,
                        );
                        definePluginStorageRecordValue(
                            optimizedReplacement,
                            key,
                            optimizedValue.snapshot,
                        );
                        preparedValues.set(key, optimizedValue.prepared);
                    }
                    // Archive constraints apply only once the locked, live
                    // backend is known to be external. Prepare every
                    // destination before any persistent or database mutation.
                    const prepared = getPluginStorageRecordKeys(optimizedReplacement).map((key) => ({
                        key,
                        storageKey: makeArchiveSafePluginSaveStorageKey(
                            PLUGIN_SAVE_PREFIX,
                            key,
                        ),
                        valueBytes: preparedValues.get(key)!.bytes,
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
                            ownership.manifest,
                        );
                        if (rawKey === null
                            || !hasPluginStorageRecordValue(optimizedReplacement, rawKey)) continue;
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
                    const ownerWrites: { storageKey: string; valueBytes: Uint8Array }[] = [];
                    for (const key of compatibilityKeys) {
                        const storageKey = makeArchiveSafePluginSaveStorageKey(
                            PLUGIN_SAVE_META_PREFIX,
                            key,
                        );
                        const ownerRecord = createPluginStorageOwnerRecord(
                            compatibilityOwner!,
                        );
                        ownerWrites.push({
                            storageKey,
                            valueBytes: preparePersistentJson(ownerRecord).bytes,
                        });
                        retainedMetaKeys.add(storageKey);
                    }
                    // A direct database replacement has no owner context for
                    // ordinary entries. Preserve metadata for retained keys,
                    // attribute fallback entries to the calling plugin, discard
                    // deleted metadata, and leave other new keys unowned.
                    const deletes = [
                        ...ownership.valueKeys.filter(key => !destinationKeys.has(key)),
                        ...ownership.metaKeys.filter(key => !retainedMetaKeys.has(key)),
                    ];
                    await commitOptimizedStorageMutation(
                        db,
                        prepared.map(entry => ({
                            storageKey: entry.storageKey,
                            valueBytes: entry.valueBytes,
                        })).concat(ownerWrites),
                        deletes,
                        (values, meta) => {
                            values.clear();
                            for (const key of destinationKeys) values.add(key);
                            meta.clear();
                            for (const key of retainedMetaKeys) meta.add(key);
                        },
                        signal,
                        [...prepared.map(entry => entry.key), ...compatibilityKeys],
                    );
                } else if (compatibilityKeys.length > 0) {
                    const writes: { storageKey: string; valueBytes: Uint8Array }[] = [];
                    const valueKeys: string[] = [];
                    const metaKeys: string[] = [];
                    for (const key of compatibilityKeys) {
                        const optimizedValue = prepareOptimizedPluginStorageValue(
                            compatibilityValues![key],
                            compatibilityOwner,
                            db.autoConvertPluginStorageValues === true,
                        );
                        const valueStorageKey = makeArchiveSafePluginSaveStorageKey(
                            PLUGIN_SAVE_PREFIX,
                            key,
                        );
                        const metaStorageKey = makeArchiveSafePluginSaveStorageKey(
                            PLUGIN_SAVE_META_PREFIX,
                            key,
                        );
                        const ownerRecord = createPluginStorageOwnerRecord(
                            compatibilityOwner!,
                        );
                        writes.push(
                            { storageKey: valueStorageKey, valueBytes: optimizedValue.prepared.bytes },
                            { storageKey: metaStorageKey, valueBytes: preparePersistentJson(ownerRecord).bytes },
                        );
                        valueKeys.push(valueStorageKey);
                        metaKeys.push(metaStorageKey);
                    }
                    await commitOptimizedStorageMutation(
                        db,
                        writes,
                        [],
                        (values, meta) => {
                            for (const key of valueKeys) values.add(key);
                            for (const key of metaKeys) meta.add(key);
                        },
                        signal,
                        compatibilityKeys,
                    );
                }
                throwIfAborted(signal);
                if (getPluginStorageRecordKeys(previousValues).length > 0) {
                    db.pluginCustomStorage = createDatabasePluginStorageRecord();
                }
                if (getPluginStorageRecordKeys(previousMeta).length > 0) {
                    delete db.pluginStorageMeta;
                }
            } else if (replacement !== undefined || compatibilityKeys.length > 0) {
                throwIfAborted(signal);
                const nextValues = replacement === undefined
                    ? cloneInlinePluginStorageRecord(previousValues)
                    : copyDatabasePluginStorageRecord(replacement);
                const nextMeta: NonNullable<Database["pluginStorageMeta"]> = replacement === undefined
                    ? cloneJsonPluginStorageRecord(previousMeta, "pluginStorageMeta")
                    : createDatabasePluginStorageRecord<
                        NonNullable<Database["pluginStorageMeta"]>[string]
                    >();
                if (replacement !== undefined) {
                    for (const key of getPluginStorageRecordKeys(replacement)) {
                        if (
                            hasPluginStorageRecordValue(previousValues, key)
                            && hasPluginStorageRecordValue(previousMeta, key)
                        ) {
                            definePluginStorageRecordValue(nextMeta, key, previousMeta[key]);
                        }
                    }
                }
                for (const key of compatibilityKeys) {
                    definePluginStorageRecordValue(nextValues, key, compatibilityValues![key]);
                    definePluginStorageRecordValue(
                        nextMeta,
                        key,
                        createPluginStorageOwnerRecord(compatibilityOwner!),
                    );
                }
                db.pluginCustomStorage = nextValues;
                if (getPluginStorageRecordKeys(nextMeta).length > 0) {
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
        if (replacement !== undefined || compatibilityKeys.length > 0) {
            invalidateStorageEnumerationSnapshot();
        }
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
            if (value === null || value === undefined) return null;
            // db is reactive $state, so inline values can be Svelte proxies.
            // Detach them for the iframe bridge without applying the optimized
            // backend's JSON-only compatibility boundary.
            return safeStructuredClone(value) as T;
        }
        const storageKey = makeArchiveSafePluginSaveStorageKey(
            PLUGIN_SAVE_PREFIX,
            normalizedKey,
        );
        if (db.pluginStorageGeneration) {
            const ownership = await readCachedCurrentOwnership(db, signal);
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
    // Preserve invocation-time structured-clone behavior while the operation
    // waits. JSON validation is intentionally deferred until the locked mode
    // is known to be optimized.
    const inlineSnapshot = safeStructuredClone(value);
    try {
        await withPluginSaveStorageKeyLock(normalizedKey, async () => {
            throwIfAborted(signal);
            const db = getDatabase();
            if (!db.optimizePluginMemory) {
                await withInlinePluginStoragePublishLock(async () => {
                    const next = cloneInlinePluginStorageRecord(
                        db.pluginCustomStorage ?? createDatabasePluginStorageRecord(),
                    );
                    definePluginStorageRecordValue(next, normalizedKey, inlineSnapshot);
                    db.pluginCustomStorage = next;
                }, signal);
                return;
            }
            const { prepared } = prepareOptimizedPluginStorageValue(
                inlineSnapshot,
                undefined,
                db.autoConvertPluginStorageValues === true,
            );
            const storageKey = makeArchiveSafePluginSaveStorageKey(
                PLUGIN_SAVE_PREFIX,
                normalizedKey,
            );
            if (db.pluginStorageGeneration
                && !isHashedPluginSaveStorageKey(storageKey, PLUGIN_SAVE_PREFIX)) {
                await setPreparedPersistentPluginStoragePreservingOwner(
                    storageKey,
                    prepared,
                    signal,
                    db.pluginStorageGeneration,
                );
                return;
            }
            await commitOptimizedStorageMutation(
                db,
                [{ storageKey, valueBytes: prepared.bytes }],
                [],
                values => values.add(storageKey),
                signal,
                [normalizedKey],
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
    const inlineSnapshot = safeStructuredClone(value);
    try {
        await withPluginSaveStorageKeyLock(normalizedKey, async () => {
            throwIfAborted(signal);
            const db = getDatabase();
            const ownerRecord = createPluginStorageOwnerRecord(owner);
            if (db.optimizePluginMemory) {
                const { snapshot, prepared: preparedValue } = prepareOptimizedPluginStorageValue(
                    inlineSnapshot,
                    owner,
                    db.autoConvertPluginStorageValues === true,
                );
                const valueStorageKey = makeArchiveSafePluginSaveStorageKey(
                    PLUGIN_SAVE_PREFIX,
                    normalizedKey,
                );
                // The server derives this row, but preflight its stricter archive
                // boundary before dispatching either side of the transaction.
                const metaStorageKey = makeArchiveSafePluginSaveStorageKey(
                    PLUGIN_SAVE_META_PREFIX,
                    normalizedKey,
                );
                if (db.pluginStorageGeneration) {
                    if (
                        isHashedPluginSaveStorageKey(valueStorageKey, PLUGIN_SAVE_PREFIX)
                        || isHashedPluginSaveStorageKey(metaStorageKey, PLUGIN_SAVE_META_PREFIX)
                    ) {
                        await commitHashedOwnedPluginStorageMutation(db, {
                            operation: "set",
                            key: normalizedKey,
                            valueBytes: preparedValue.bytes,
                            ownedValueBytes: true,
                            owner,
                        }, signal);
                    } else {
                        await mutatePersistentPluginStorage(
                            valueStorageKey,
                            "set",
                            snapshot,
                            owner,
                            signal,
                            db.pluginStorageGeneration,
                            preparedValue,
                        );
                    }
                } else {
                    await mutatePersistentPluginStorage(
                        valueStorageKey,
                        "set",
                        snapshot,
                        owner,
                        signal,
                        undefined,
                        preparedValue,
                    );
                }
                return;
            }

            await withInlinePluginStoragePublishLock(async () => {
                const nextValues = cloneInlinePluginStorageRecord(
                    db.pluginCustomStorage ?? createDatabasePluginStorageRecord(),
                );
                const nextMeta = cloneJsonPluginStorageRecord(
                    db.pluginStorageMeta ?? createDatabasePluginStorageRecord<
                        NonNullable<Database["pluginStorageMeta"]>[string]
                    >(),
                    "pluginStorageMeta",
                );
                definePluginStorageRecordValue(nextValues, normalizedKey, inlineSnapshot);
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
                await withInlinePluginStoragePublishLock(async () => {
                    if (!hasPluginStorageRecordValue(db.pluginCustomStorage, normalizedKey)) return;
                    const next = cloneInlinePluginStorageRecord(
                        db.pluginCustomStorage ?? createDatabasePluginStorageRecord(),
                    );
                    delete next[normalizedKey];
                    db.pluginCustomStorage = next;
                }, signal);
                return;
            }
            const storageKey = makeArchiveSafePluginSaveStorageKey(
                PLUGIN_SAVE_PREFIX,
                normalizedKey,
            );
            if (db.pluginStorageGeneration
                && !isHashedPluginSaveStorageKey(storageKey, PLUGIN_SAVE_PREFIX)) {
                await removePersistentPluginStoragePreservingOwner(
                    storageKey,
                    signal,
                    db.pluginStorageGeneration,
                );
                return;
            }
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
                const metaStorageKey = makeArchiveSafePluginSaveStorageKey(
                    PLUGIN_SAVE_META_PREFIX,
                    normalizedKey,
                );
                if (db.pluginStorageGeneration) {
                    if (
                        isHashedPluginSaveStorageKey(valueStorageKey, PLUGIN_SAVE_PREFIX)
                        || isHashedPluginSaveStorageKey(metaStorageKey, PLUGIN_SAVE_META_PREFIX)
                    ) {
                        await commitHashedOwnedPluginStorageMutation(db, {
                            operation: "remove",
                            key: normalizedKey,
                        }, signal);
                    } else {
                        await mutatePersistentPluginStorage(
                            valueStorageKey,
                            "remove",
                            signal,
                            db.pluginStorageGeneration,
                        );
                    }
                } else {
                    await mutatePersistentPluginStorage(
                        valueStorageKey,
                        "remove",
                        signal,
                    );
                }
                return;
            }

            await withInlinePluginStoragePublishLock(async () => {
                const nextValues = cloneInlinePluginStorageRecord(
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
        }, signal);
    } finally {
        invalidateStorageEnumerationSnapshot();
    }
}

/**
 * Public V3 mutation workflow that preserves a definitive refusal versus an
 * ambiguous commit without asking plugins to inspect an untyped rejection.
 * It never retries: a caller may only retry a known-not-committed outcome.
 */
export function setOwnedPluginSaveStorageItemWithOutcome<T>(
    key: string,
    value: T,
    owner: string,
    signal?: AbortSignal | null,
): Promise<PublicPluginStorageMutationOutcome> {
    return runPublicPluginStorageMutation(
        "set",
        () => setOwnedPluginSaveStorageItem(key, value, owner, signal),
    );
}

/** See setOwnedPluginSaveStorageItemWithOutcome(). */
export function removeOwnedPluginSaveStorageItemWithOutcome(
    key: string,
    signal?: AbortSignal | null,
): Promise<PublicPluginStorageMutationOutcome> {
    return runPublicPluginStorageMutation(
        "remove",
        () => removeOwnedPluginSaveStorageItem(key, signal),
    );
}

/**
 * Remove once and perform a fresh versioned read before reporting success.
 * This is the safe boundary for clearing a plugin-owned dirty flag or
 * incrementing a reset/cleanup success counter.
 */
export function removeOwnedPluginSaveStorageItemConfirmed(
    key: string,
    signal?: AbortSignal | null,
): Promise<PublicPluginStorageConfirmedRemoveOutcome> {
    return runConfirmedPluginStorageRemove(
        () => removeOwnedPluginSaveStorageItem(key, signal),
        async () => {
            const state = await getPluginSaveStorageItemWithRevision(key, signal);
            return state.status === "missing"
                ? {
                    status: "missing" as const,
                    revision: null,
                    generation: state.generation,
                }
                : {
                    status: "value" as const,
                    revision: state.revision,
                    generation: state.generation,
                };
        },
    );
}

export type PluginSaveStorageAtomicMutation =
    | {
        type: "set";
        key: string;
        value: unknown;
        expectedRevision?: string | null;
    }
    | {
        type: "remove";
        key: string;
        expectedRevision?: string | null;
    };

export type PluginSaveStorageVersionedResult =
    | { status: "missing"; value: null; revision: null; generation: string | null }
    | { status: "value"; value: unknown; revision: string; generation: string | null };

export interface PluginSaveStorageFailure {
    name: string;
    message: string;
    status: number | null;
    code: string | null;
    retryAfter: number | null;
    retryable: boolean;
    commitOutcomeUnknown: boolean;
    operation: "read" | "batch";
}

export type PluginSaveStorageReadSnapshot =
    | {
        status: "missing";
        key: string;
        value: null;
        revision: null;
        generation: string | null;
    }
    | {
        status: "value";
        key: string;
        value: unknown;
        revision: string;
        generation: string | null;
    };

export type PluginSaveStorageReadResult = PluginSaveStorageReadSnapshot | {
    status: "failed";
    key: string;
    error: PluginSaveStorageFailure;
};

export type PluginSaveStorageGuardedSetResult =
    | {
        status: "committed";
        generation: string;
        revision: string;
    }
    | {
        status: "conflict";
        conflicts: { key: string; revision: string | null; generation: string | null }[];
    }
    | {
        status: "failed";
        stage: "read" | "write";
        error: PluginSaveStorageFailure;
    };

export type PluginSaveStorageAtomicBatchResult =
    | {
        committed: true;
        generation: string;
        revisions: { key: string; revision: string | null }[];
    }
    | {
        committed: false;
        conflicts: { key: string; revision: string | null; generation: string | null }[];
    };

/**
 * Rewrite one logical value as a single atomic set. This is the safe
 * replacement for maintenance code that used to remove a row before writing
 * the same value back: no durable deletion is ever published, and an optional
 * revision binds the rewrite to the exact value that was read.
 */
export async function rewriteOwnedPluginSaveStorageItem(
    key: unknown,
    value: unknown,
    owner: string,
    expectedRevision?: string | null,
    signal?: AbortSignal | null,
): Promise<PluginSaveStorageAtomicBatchResult> {
    return atomicBatchOwnedPluginSaveStorage([{
        type: "set",
        key: normalizePluginStorageKey(key),
        value,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
    }], owner, signal);
}

const pluginStorageBatchEncoder = new TextEncoder();
const inlinePluginStorageRevisionPackr = new Packr({
    structuredClone: true,
    useRecords: false,
});

function describePluginStorageFailure(
    error: unknown,
    operation: "read" | "batch",
): PluginSaveStorageFailure {
    const source = error && typeof error === "object"
        ? error as Record<string, unknown>
        : null;
    const message = typeof source?.message === "string" && source.message.length > 0
        ? source.message
        : error === undefined || error === null
            ? "Plugin storage operation failed."
            : String(error);
    return {
        name: typeof source?.name === "string" && source.name.length > 0
            ? source.name
            : "StorageError",
        message,
        status: typeof source?.status === "number" ? source.status : null,
        code: typeof source?.code === "string"
            ? source.code
            : operation === "read" ? "STORAGE_READ_FAILED" : "STORAGE_WRITE_FAILED",
        retryAfter: typeof source?.retryAfter === "number" ? source.retryAfter : null,
        retryable: source?.retryable === true,
        commitOutcomeUnknown: operation === "batch"
            && source?.commitOutcomeUnknown === true,
        operation,
    };
}

/** Snapshot bridge-realm JSON without trusting getters, toJSON, or prototypes. */
function snapshotPluginBatchValue(
    value: unknown,
    path = "$",
    seen = new Set<object>(),
): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new TypeError(`Plugin batch value must be finite at ${path}.`);
        return value;
    }
    if (typeof value !== "object") {
        throw new TypeError(`Plugin batch value is not JSON-representable at ${path}.`);
    }
    if (seen.has(value)) throw new TypeError(`Plugin batch value is cyclic at ${path}.`);
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            const keys = Reflect.ownKeys(value);
            const out: unknown[] = [];
            for (const key of keys) {
                if (key === "length") continue;
                if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) {
                    throw new TypeError(`Plugin batch arrays must be dense at ${path}.`);
                }
            }
            for (let index = 0; index < value.length; index++) {
                const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
                if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
                    throw new TypeError(`Plugin batch arrays must be dense at ${path}[${index}].`);
                }
                out.push(snapshotPluginBatchValue(descriptor.value, `${path}[${index}]`, seen));
            }
            return out;
        }
        const prototype = Reflect.getPrototypeOf(value);
        const prototypeConstructor = prototype
            ? Reflect.getOwnPropertyDescriptor(prototype, "constructor")?.value
            : null;
        if (prototype !== null
            && (typeof prototypeConstructor !== "function"
                || prototypeConstructor.name !== "Object")) {
            throw new TypeError(`Plugin batch values require plain objects at ${path}.`);
        }
        const out = createDatabasePluginStorageRecord<unknown>();
        for (const key of Reflect.ownKeys(value)) {
            if (typeof key !== "string") throw new TypeError(`Plugin batch symbols are invalid at ${path}.`);
            const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
                throw new TypeError(`Plugin batch values require enumerable data properties at ${path}.${key}.`);
            }
            definePluginStorageRecordValue(
                out,
                key,
                snapshotPluginBatchValue(descriptor.value, `${path}.${key}`, seen),
            );
        }
        return out;
    } finally {
        seen.delete(value);
    }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
    return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function isCanonicalInlinePluginStorageOwner(
    owner: unknown,
): owner is Record<string, unknown> & {
    plugin: string;
    updatedAt: number;
    revision: string;
    generation: string;
} {
    if (owner === null || typeof owner !== "object" || Array.isArray(owner)) return false;
    const keys = Reflect.ownKeys(owner);
    if (keys.length !== 4
        || keys[0] !== "plugin"
        || keys[1] !== "updatedAt"
        || keys[2] !== "revision"
        || keys[3] !== "generation") return false;
    const values = new Map<string, unknown>();
    for (const key of keys) {
        if (typeof key !== "string") return false;
        const descriptor = Reflect.getOwnPropertyDescriptor(owner, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
        values.set(key, descriptor.value);
    }
    const plugin = values.get("plugin");
    try {
        if (typeof plugin !== "string" || plugin.length === 0) return false;
        assertWellFormedUnicode(plugin);
    } catch {
        return false;
    }
    return Number.isSafeInteger(values.get("updatedAt"))
        && (values.get("updatedAt") as number) >= 0
        && typeof values.get("revision") === "string"
        && PLUGIN_STORAGE_UUID_PATTERN.test(values.get("revision") as string)
        && typeof values.get("generation") === "string"
        && PLUGIN_STORAGE_UUID_PATTERN.test(values.get("generation") as string);
}

async function inlinePluginStorageRevision(
    value: unknown,
    owner: unknown,
    ownerRowPresent: boolean,
): Promise<string> {
    let valueBytes: Uint8Array;
    let revisionDomain = "pocketrisu-plugin-storage-v1";
    try {
        valueBytes = pluginStorageBatchEncoder.encode(stringifyJsonValue(value));
    } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        // Inline basic storage intentionally retains the historical structured-
        // clone value domain. Versioned migration reads, viewer maintenance,
        // and guarded removal still need an opaque CAS token for those rows.
        // MessagePack's structured-clone mode preserves cycles and rich types;
        // copy its reusable encoder output before any later encode can run.
        valueBytes = new Uint8Array(inlinePluginStorageRevisionPackr.encode(
            safeStructuredClone(value),
        ));
        revisionDomain = "pocketrisu-plugin-storage-structured-clone-v1";
    }
    const incarnation = isCanonicalInlinePluginStorageOwner(owner)
        ? owner.revision
        : ownerRowPresent
            ? `legacy:${await sha256Hex(pluginStorageBatchEncoder.encode(
                JSON.stringify(snapshotPluginBatchValue(owner)),
            ))}`
            : "legacy:unowned";
    const prefix = pluginStorageBatchEncoder.encode(
        `${revisionDomain}\0${incarnation}\0`,
    );
    const input = new Uint8Array(prefix.byteLength + valueBytes.byteLength);
    input.set(prefix, 0);
    input.set(valueBytes, prefix.byteLength);
    return `sha256:${await sha256Hex(input)}`;
}

/** Read JSON null and a missing key distinctly, with an opaque CAS revision. */
export async function getPluginSaveStorageItemWithRevision(
    key: unknown,
    signal?: AbortSignal | null,
): Promise<PluginSaveStorageVersionedResult> {
    const normalizedKey = normalizePluginStorageKey(key);
    return withPluginSaveStorageKeyLock(normalizedKey, async () => {
        throwIfAborted(signal);
        const db = getDatabase();
        if (db.optimizePluginMemory) {
            const storageKey = makeArchiveSafePluginSaveStorageKey(
                PLUGIN_SAVE_PREFIX,
                normalizedKey,
            );
            makeArchiveSafePluginSaveStorageKey(PLUGIN_SAVE_META_PREFIX, normalizedKey);
            return readPersistentPluginStorageState(
                storageKey,
                signal,
                db.pluginStorageGeneration,
            );
        }
        if (!hasPluginStorageRecordValue(db.pluginCustomStorage, normalizedKey)) {
            return { status: "missing", value: null, revision: null, generation: null };
        }
        // Versioned writes remain strict JSON, but accepting a legacy rich
        // value on read lets plugins migrate or guardedly remove that row.
        const value = safeStructuredClone(db.pluginCustomStorage[normalizedKey]);
        const ownerRowPresent = hasPluginStorageRecordValue(db.pluginStorageMeta, normalizedKey);
        const owner = ownerRowPresent ? db.pluginStorageMeta?.[normalizedKey] : undefined;
        return {
            status: "value",
            value,
            revision: await inlinePluginStorageRevision(value, owner, ownerRowPresent),
            generation: isCanonicalInlinePluginStorageOwner(owner)
                ? owner.generation
                : null,
        };
    }, signal);
}

/**
 * Public V3 read shape for compound updates. Unlike getItem(), a missing row,
 * a stored JSON null, and an unavailable authoritative read are three distinct
 * outcomes. The failure branch contains only stable, bridge-cloneable fields.
 */
export async function readPluginSaveStorageItemResult(
    key: unknown,
    signal?: AbortSignal | null,
): Promise<PluginSaveStorageReadResult> {
    // Key coercion/Unicode validation is a caller error, not an I/O result.
    const normalizedKey = normalizePluginStorageKey(key);
    try {
        const result = await getPluginSaveStorageItemWithRevision(normalizedKey, signal);
        return { key: normalizedKey, ...result } as PluginSaveStorageReadSnapshot;
    } catch (error) {
        return {
            status: "failed",
            key: normalizedKey,
            error: describePluginStorageFailure(error, "read"),
        };
    }
}

/**
 * Publish a value only against an exact successful read. Passing a failed read
 * is a no-op, while missing uses expectedRevision:null and therefore cannot
 * overwrite a row that appeared (or was merely mistaken for missing).
 */
export async function setOwnedPluginSaveStorageItemFromRead(
    read: PluginSaveStorageReadResult,
    value: unknown,
    owner: string,
    signal?: AbortSignal | null,
): Promise<PluginSaveStorageGuardedSetResult> {
    if (!read || typeof read !== "object" || typeof read.key !== "string") {
        throw new TypeError("pluginStorage.setFromRead requires a readItem() result.");
    }
    const key = normalizePluginStorageKey(read.key);
    if (read.status === "failed") {
        if (!read.error || typeof read.error !== "object") {
            throw new TypeError("pluginStorage.setFromRead received an invalid failed read.");
        }
        return { status: "failed", stage: "read", error: read.error };
    }
    if (read.status !== "missing" && read.status !== "value") {
        throw new TypeError("pluginStorage.setFromRead received an invalid read status.");
    }
    if (read.status === "missing") {
        if (read.revision !== null || read.value !== null) {
            throw new TypeError("A missing plugin storage read must carry a null revision and value.");
        }
    } else if (typeof read.revision !== "string"
        || !PLUGIN_STORAGE_REVISION_PATTERN.test(read.revision)) {
        throw new TypeError("A plugin storage value read must carry a valid revision.");
    }

    try {
        const result = await atomicBatchOwnedPluginSaveStorage([{
            type: "set",
            key,
            value,
            expectedRevision: read.revision,
        }], owner, signal);
        if ("conflicts" in result) {
            return { status: "conflict", conflicts: result.conflicts };
        }
        const revision = result.revisions.find(row => row.key === key)?.revision;
        if (typeof revision !== "string") {
            throw new StorageError("Plugin storage guarded set omitted its committed revision.", {
                code: "STORAGE_RESPONSE_ERROR",
                operation: "batch",
                retryable: true,
            });
        }
        return { status: "committed", generation: result.generation, revision };
    } catch (error) {
        return {
            status: "failed",
            stage: "write",
            error: describePluginStorageFailure(error, "batch"),
        };
    }
}

/**
 * Apply a bounded, distinct-key set/remove group atomically. All input is
 * detached and validated before storage readiness or any durable mutation.
 */
export async function atomicBatchOwnedPluginSaveStorage(
    mutations: readonly PluginSaveStorageAtomicMutation[],
    owner: string,
    signal?: AbortSignal | null,
): Promise<PluginSaveStorageAtomicBatchResult> {
    throwIfAborted(signal);
    if (!Array.isArray(mutations)
        || mutations.length < 1
        || mutations.length > PLUGIN_STORAGE_BATCH_MAX_OPERATIONS) {
        throw new RangeError(
            `pluginStorage.atomicBatch requires 1-${PLUGIN_STORAGE_BATCH_MAX_OPERATIONS} operations.`,
        );
    }
    const seen = new Set<string>();
    const detached: Array<
        | {
            type: "set";
            key: string;
            value: unknown;
            expectedRevision?: string | null;
        }
        | {
            type: "remove";
            key: string;
            expectedRevision?: string | null;
        }
    > = [];
    for (let index = 0; index < mutations.length; index++) {
        throwIfAborted(signal);
        const mutation = mutations[index];
        if (!mutation || (mutation.type !== "set" && mutation.type !== "remove")) {
            throw new TypeError(`Plugin storage batch operation ${index} is invalid.`);
        }
        const key = normalizePluginStorageKey(mutation.key);
        if (seen.has(key)) throw new TypeError(`Duplicate plugin storage batch key: ${key}`);
        seen.add(key);
        makeArchiveSafePluginSaveStorageKey(PLUGIN_SAVE_PREFIX, key);
        makeArchiveSafePluginSaveStorageKey(PLUGIN_SAVE_META_PREFIX, key);
        if (Object.prototype.hasOwnProperty.call(mutation, "expectedRevision")
            && mutation.expectedRevision !== null
            && (typeof mutation.expectedRevision !== "string"
                || !PLUGIN_STORAGE_REVISION_PATTERN.test(mutation.expectedRevision))) {
            throw new TypeError(`Plugin storage batch operation ${index} has an invalid revision.`);
        }
        const expected = Object.prototype.hasOwnProperty.call(mutation, "expectedRevision")
            ? { expectedRevision: mutation.expectedRevision }
            : {};
        if (mutation.type === "set") {
            detached.push({
                type: "set",
                key,
                value: snapshotPluginBatchValue(mutation.value),
                ...expected,
            });
        } else {
            detached.push({ type: "remove", key, ...expected });
        }
    }

    const prepared: PersistentPluginStorageBatchOperation[] = [];
    for (let index = 0; index < detached.length; index++) {
        if (index > 0 && index % 16 === 0) {
            await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
        throwIfAborted(signal);
        const mutation = detached[index];
        if (mutation.type === "set") {
            prepared.push({
                operation: "set",
                key: mutation.key,
                valueBytes: preparePersistentJson(mutation.value).bytes,
                ownedValueBytes: true,
                owner,
                ...(Object.prototype.hasOwnProperty.call(mutation, "expectedRevision")
                    ? { expectedRevision: mutation.expectedRevision }
                    : {}),
            });
        } else {
            prepared.push({
                operation: "remove",
                key: mutation.key,
                ...(Object.prototype.hasOwnProperty.call(mutation, "expectedRevision")
                    ? { expectedRevision: mutation.expectedRevision }
                    : {}),
            });
        }
    }
    try {
        return await withPluginSaveStorageKeySetLock([...seen], async () => {
            throwIfAborted(signal);
            const db = getDatabase();
            if (db.optimizePluginMemory) {
                for (let attempt = 0; ; attempt++) {
                    const generation = db.pluginStorageGeneration;
                    if (!generation) {
                        throw new Error(
                            "Optimized plugin storage is not reconciled; reload to complete its atomic adoption.",
                        );
                    }
                    const manifestState = await readPersistentPluginStorageManifestState(
                        generation,
                        signal,
                    );
                    const result = await batchPersistentPluginStorage({
                        generation,
                        expectedManifestRevision: manifestState.manifestRevision,
                        operations: prepared,
                    }, signal);
                    if (result.outcome === "committed") {
                        return {
                            committed: true,
                            generation: result.generation,
                            revisions: result.revisions.map(({ key, revision }) => ({
                                key,
                                revision,
                            })),
                        };
                    }
                    if (result.code === "PLUGIN_STORAGE_GENERATION_CONFLICT" && attempt < 2) {
                        continue;
                    }
                    if (result.code === "PLUGIN_STORAGE_GENERATION_CONFLICT") {
                        throw new StorageError(result.error, {
                            status: result.status,
                            code: result.code,
                            retryAfter: result.retryAfter,
                            retryable: true,
                            commitOutcomeUnknown: false,
                            operation: "batch",
                        });
                    }
                    return {
                        committed: false,
                        conflicts: (result.conflicts ?? []).map(conflict => ({
                            key: conflict.key,
                            revision: conflict.revision,
                            generation: conflict.currentGeneration,
                        })),
                    };
                }
            }

            return await withInlinePluginStoragePublishLock(async () => {
                // V2/V2.1 storage writes are intentionally synchronous and
                // cannot await this mutex. They advance the shared inline
                // content generation. If one runs while revision hashing is
                // suspended, discard this stale whole-map clone and retry.
                while (true) {
                    throwIfAborted(signal);
                    const inlineVersion = getPluginStorageKeySetGeneration();
                    const inlineDb = getDatabase();
                    const nextValues = cloneInlinePluginStorageRecord(
                        inlineDb.pluginCustomStorage ?? createDatabasePluginStorageRecord(),
                    );
                    const nextMeta = cloneJsonPluginStorageRecord(
                        inlineDb.pluginStorageMeta ?? createDatabasePluginStorageRecord(),
                        "pluginStorageMeta",
                    ) as NonNullable<Database["pluginStorageMeta"]>;
                    const conflicts: {
                        key: string;
                        revision: string | null;
                        generation: string | null;
                    }[] = [];
                    for (const mutation of prepared) {
                        if (!Object.prototype.hasOwnProperty.call(mutation, "expectedRevision")) continue;
                        const present = hasPluginStorageRecordValue(nextValues, mutation.key);
                        const metaPresent = hasPluginStorageRecordValue(nextMeta, mutation.key);
                        const meta = metaPresent ? nextMeta[mutation.key] : undefined;
                        const revision = present
                            ? await inlinePluginStorageRevision(
                                nextValues[mutation.key],
                                meta,
                                metaPresent,
                            )
                            : null;
                        if (revision !== mutation.expectedRevision) {
                            conflicts.push({
                                key: mutation.key,
                                revision,
                                generation: isCanonicalInlinePluginStorageOwner(meta)
                                    ? meta.generation
                                    : null,
                            });
                        }
                    }
                    if (conflicts.length > 0) {
                        if (getPluginStorageKeySetGeneration() !== inlineVersion) continue;
                        return { committed: false as const, conflicts };
                    }

                    const generation = crypto.randomUUID();
                    const updatedAt = Date.now();
                    for (const mutation of prepared) {
                        if (mutation.operation === "set") {
                            const value = JSON.parse(new TextDecoder().decode(mutation.valueBytes));
                            definePluginStorageRecordValue(nextValues, mutation.key, value);
                            if (owner) {
                                definePluginStorageRecordValue(nextMeta, mutation.key, {
                                    plugin: owner,
                                    updatedAt,
                                    revision: crypto.randomUUID(),
                                    generation,
                                });
                            } else {
                                delete nextMeta[mutation.key];
                            }
                        } else {
                            delete nextValues[mutation.key];
                            delete nextMeta[mutation.key];
                        }
                    }
                    const revisions = [];
                    for (const mutation of prepared) {
                        revisions.push({
                            key: mutation.key,
                            revision: hasPluginStorageRecordValue(nextValues, mutation.key)
                                ? await inlinePluginStorageRevision(
                                    nextValues[mutation.key],
                                    nextMeta[mutation.key],
                                    hasPluginStorageRecordValue(nextMeta, mutation.key),
                                )
                                : null,
                        });
                    }
                    throwIfAborted(signal);
                    if (getPluginStorageKeySetGeneration() !== inlineVersion) continue;

                    // The version check and both detached assignments are one
                    // synchronous critical publication. Legacy code cannot
                    // interleave between them on the browser event loop.
                    inlineDb.pluginCustomStorage = nextValues;
                    if (getPluginStorageRecordKeys(nextMeta).length > 0) {
                        inlineDb.pluginStorageMeta = nextMeta;
                    } else {
                        delete inlineDb.pluginStorageMeta;
                    }
                    return { committed: true as const, generation, revisions };
                }
            }, signal);
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
            ? validatedPluginStorageRecordKeys(
                db.pluginCustomStorage ?? createDatabasePluginStorageRecord(),
            )
            : await listDecodedStorageKeys(PLUGIN_SAVE_PREFIX, signal);
        const orderedKeys = orderLegacyPluginStorageKeys(keys);
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

export interface PluginSaveStorageViewerPage {
    entries: (PluginStorageViewerEntry & { revision: string })[];
    generation: string | null;
    manifestRevision: string | null;
    databaseRevision: string | null;
    pageToken: string;
    page: number;
    pageSize: number;
    pageCount: number;
    total: number;
    ownerFacets: { owner: string; count: number }[];
    unknownOwnerCount: number;
    ownerFacetTotal: number;
    metrics: {
        manifestParses: number;
        valueReads: number;
        ownerReads: number;
        maxRowParses: number;
    };
}

/**
 * Read one point-in-time viewer page. Optimized mode delegates inventory,
 * owner and body selection to one pinned server snapshot; inline mode captures
 * only the selected values synchronously before yielding.
 */
export async function getPluginSaveStorageViewerPage(
    options: {
        page: number;
        pageSize?: number;
        keyQuery?: string;
        ownerQuery?: string;
        unknownOwner?: boolean;
        signal?: AbortSignal | null;
        onProgress?: (completed: number, total: number) => void;
    },
): Promise<PluginSaveStorageViewerPage> {
    const pageSize = options.pageSize ?? 50;
    if (!Number.isInteger(options.page) || options.page < 0
        || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
        throw new RangeError("Plugin storage viewer pages must contain between 1 and 50 rows.");
    }
    if ((options.ownerQuery !== undefined && options.unknownOwner)
        || (options.ownerQuery !== undefined
            && (!options.ownerQuery || !options.ownerQuery.isWellFormed()))) {
        throw new TypeError("Plugin storage viewer owner filter is invalid.");
    }
    return withPluginSaveStorageScope("viewer", async () => {
        throwIfAborted(options.signal);
        const db = getDatabase();
        if (db.optimizePluginMemory === true) {
            const generation = db.pluginStorageGeneration;
            if (!generation) {
                throw new StorageError(
                    "Optimized plugin storage has no active generation; reload to reconcile it.",
                    {
                        code: "PLUGIN_STORAGE_GENERATION_CONFLICT",
                        operation: "list",
                        retryable: true,
                    },
                );
            }
            const result = await readPersistentPluginStorageViewerPage(
                generation,
                {
                    page: options.page,
                    pageSize,
                    ...(options.keyQuery ? { keyQuery: options.keyQuery } : {}),
                    ...(options.ownerQuery !== undefined ? { ownerQuery: options.ownerQuery } : {}),
                    ...(options.unknownOwner ? { unknownOwner: true } : {}),
                },
                options.signal,
                options.onProgress,
            );
            return {
                ...result,
                entries: result.entries.map(entry => ({
                    key: entry.key,
                    ...(entry.owner ? { owner: entry.owner } : {}),
                    text: entry.text,
                    size: entry.size,
                    type: entry.valueType,
                    revision: entry.revision,
                })),
            };
        }

        const values = db.pluginCustomStorage ?? createDatabasePluginStorageRecord();
        const meta = db.pluginStorageMeta ?? createDatabasePluginStorageRecord();
        const query = options.keyQuery?.trim().toLowerCase() ?? "";
        const keyMatched = orderPluginStorageKeys(getPluginStorageRecordKeys(values))
            .filter(key => !query || key.toLowerCase().includes(query));
        const ownerFacetCounts = new Map<string, number>();
        let unknownOwnerCount = 0;
        for (const key of keyMatched) {
            const owner = meta[key]?.plugin;
            if (typeof owner === "string" && owner) {
                ownerFacetCounts.set(owner, (ownerFacetCounts.get(owner) ?? 0) + 1);
            } else {
                unknownOwnerCount += 1;
            }
        }
        const ownerFacets = [...ownerFacetCounts]
            .map(([owner, count]) => ({ owner, count }))
            .sort((left, right) => left.owner < right.owner ? -1 : left.owner > right.owner ? 1 : 0);
        const keys = keyMatched.filter((key) => {
            const owner = meta[key]?.plugin;
            if (options.unknownOwner) return typeof owner !== "string" || !owner;
            if (options.ownerQuery !== undefined) return owner === options.ownerQuery;
            return true;
        });
        const total = keys.length;
        const pageCount = Math.max(1, Math.ceil(total / pageSize));
        const page = Math.min(options.page, pageCount - 1);
        const selectedKeys = keys.slice(
            page * pageSize,
            Math.min(total, (page + 1) * pageSize),
        );
        // No await occurs while these rows are detached, so every selected
        // value and owner belongs to the same in-memory publication turn.
        const selectedSources = selectedKeys.map((key) => {
            const ownerRowPresent = hasPluginStorageRecordValue(meta, key);
            return {
                key,
                value: safeStructuredClone(values[key]),
                ownerRowPresent,
                ownerRecord: ownerRowPresent ? snapshotJsonValue(meta[key]) : undefined,
            };
        });
        const entries: (PluginStorageViewerEntry & { revision: string })[] = [];
        for (const source of selectedSources) {
            throwIfAborted(options.signal);
            const text = valueToPluginStorageViewerText(source.value);
            const owner = source.ownerRecord
                && typeof source.ownerRecord === "object"
                && !Array.isArray(source.ownerRecord)
                ? (source.ownerRecord as { plugin?: unknown }).plugin
                : undefined;
            entries.push({
                key: source.key,
                ...(typeof owner === "string" && owner ? { owner } : {}),
                text,
                size: new TextEncoder().encode(text).byteLength,
                type: detectPluginStorageViewerType(source.value, text),
                revision: await inlinePluginStorageRevision(
                    source.value,
                    source.ownerRecord,
                    source.ownerRowPresent,
                ),
            });
        }
        throwIfAborted(options.signal);
        const pageToken = `sha256:${await sha256OwnedBytes(new TextEncoder().encode(
            stringifyJsonValue([
                "pocketrisu-inline-plugin-storage-viewer-page-v2",
                page,
                pageSize,
                options.keyQuery?.trim() ?? "",
                options.ownerQuery ?? null,
                options.unknownOwner ?? false,
                ownerFacets.map(facet => [facet.owner, facet.count]),
                unknownOwnerCount,
                total,
                entries.map(entry => [
                    entry.key,
                    entry.owner ?? null,
                    entry.text,
                    entry.size,
                    entry.type,
                    entry.revision,
                ]),
            ]),
        ))}`;
        throwIfAborted(options.signal);
        options.onProgress?.(entries.length, entries.length);
        throwIfAborted(options.signal);
        return {
            entries,
            generation: null,
            manifestRevision: null,
            databaseRevision: null,
            pageToken,
            page,
            pageSize,
            pageCount,
            total,
            ownerFacets,
            unknownOwnerCount,
            ownerFacetTotal: keyMatched.length,
            metrics: {
                manifestParses: 0,
                valueReads: entries.length,
                ownerReads: 0,
                maxRowParses: entries.length > 0 ? 1 : 0,
            },
        };
    }, options.signal);
}

export async function getPluginSaveStorageKeys(signal?: AbortSignal | null): Promise<string[]> {
    return getPluginSaveStorageEnumerationSnapshot(true, signal);
}

export async function getPluginSaveStorageSortedKeys(
    signal?: AbortSignal | null,
): Promise<string[]> {
    return orderPluginStorageKeys(
        await getPluginSaveStorageEnumerationSnapshot(true, signal),
    );
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
    const preparedRecord = preparePersistentJson(record);
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
            [{ storageKey, valueBytes: preparedRecord.bytes }],
            [],
            (_values, meta) => meta.add(storageKey),
            signal,
            [normalizedKey],
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
    return withPluginSaveStorageScope("owners", async () => {
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
        const ownership = await readCachedCurrentOwnership(db, signal);
        const activeValues = new Set(ownership.valueKeys);
        const entries = await Promise.all(ownership.metaKeys.map(async fullKey => {
            const key = decodeListedStorageKey(
                fullKey,
                PLUGIN_SAVE_META_PREFIX,
                ownership.manifest,
            );
            if (key === null) return null;
            if (!activeValues.has(makeArchiveSafePluginSaveStorageKey(
                PLUGIN_SAVE_PREFIX,
                key,
            ))) return null;
            const record = await readGenerationBoundPluginStorageJson<{ plugin?: string }>(
                readPersistentJson,
                fullKey,
                ownership.manifest?.generation,
                false,
                signal,
            );
            return record?.plugin ? { key, plugin: record.plugin } : null;
        }));
        for (const entry of entries) {
            if (entry) definePluginStorageRecordValue(out, entry.key, entry.plugin);
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
    completedBytes?: number;
    totalBytes?: number;
    maxBytes?: number | null;
}

export interface PluginStorageReconcileResult {
    direction: "externalize" | "internalize" | "none";
    values: number;
    meta: number;
}

export interface PluginStorageLargeInlineTransitionWarning {
    direction: "internalize";
    totalBytes: number;
    largestRowBytes: number;
    aggregateWarningBytes: number;
    rowWarningBytes: number;
}

export interface PluginStorageBootReconcileResult extends PluginStorageReconcileResult {
    issues: PluginStorageRecoveryIssue[];
}

interface ReconcileDependencies {
    commitPersistentPluginStorageMutation: typeof commitPersistentPluginStorageMutation;
    getDatabase: () => Database;
    getPersistentStorageFreeBytes: typeof getPersistentStorageFreeBytes;
    listPersistentEntriesWithSizes: typeof listPersistentEntriesWithSizes;
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
    /** Settings-only confirmation before a large optimized publication is loaded into browser memory. */
    confirmLargeInlineTransition?: (
        warning: PluginStorageLargeInlineTransitionWarning,
    ) => boolean | Promise<boolean>;
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
        commitPersistentPluginStorageMutation: (request, signal) => (
            commitPersistentPluginStorageMutation(request, signal)
        ),
        getDatabase,
        getPersistentStorageFreeBytes,
        listPersistentEntriesWithSizes,
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

interface PluginStorageTransitionPreflight {
    direction: "externalize" | "internalize";
    orderedBytes: number[];
    baselineEntries: number;
    baselineBytes: number;
    totalBytes: number;
    largestRowBytes: number;
    maxBytes: number | null;
    entries: Array<{
        rawKey: string;
        storageKey: string;
        size: number;
        prefix: PluginSaveStoragePrefix;
    }>;
}

function utf8ByteLength(value: string): number {
    let bytes = 0;
    for (let index = 0; index < value.length; index += 1) {
        const codeUnit = value.charCodeAt(index);
        if (codeUnit <= 0x7f) bytes += 1;
        else if (codeUnit <= 0x7ff) bytes += 2;
        else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < value.length) {
            const next = value.charCodeAt(index + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                bytes += 4;
                index += 1;
            } else bytes += 3;
        } else bytes += 3;
    }
    return bytes;
}

function addTransitionBytes(total: number, next: number): number {
    const result = total + next;
    if (!Number.isSafeInteger(result)) {
        throw new StorageError("Plugin storage is too large to measure safely.", {
            code: "PLUGIN_STORAGE_SIZE_LIMIT",
            operation: "transition",
        });
    }
    return result;
}

function transitionLimitError(
    kind: "entries",
    actual: number,
    limit: number,
): StorageError {
    const units = kind === "entries" ? "entries" : "bytes";
    return new StorageError(
        `Plugin storage has ${actual} ${units}; this transition is limited to ${limit} ${units}.`,
        { code: "PLUGIN_STORAGE_SIZE_LIMIT", operation: "transition" },
    );
}

function validateTransitionRowSize(size: number): void {
    if (!Number.isSafeInteger(size) || size < 0) {
        throw new StorageError("Plugin storage returned an invalid logical row size.", {
            code: "PLUGIN_STORAGE_SIZE_LIMIT",
            operation: "transition",
        });
    }
}

function measureInlineTransitionEntries(
    source: unknown,
    fieldName: string,
    prefix: PluginSaveStoragePrefix,
    signal?: AbortSignal | null,
): Array<{ key: string; storageKey: string; size: number }> {
    if (source === undefined) return [];
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
            throw new TypeError(`${fieldName} requires an enumerable data property for ${key}.`);
        }
        keys.push(key);
    };
    for (const key of Reflect.ownKeys(source)) validateKey(key);
    for (const key of getPluginStorageRecordKeys(source as Record<string, unknown>)) {
        validateKey(key);
    }
    return orderLegacyPluginStorageKeys(keys).map(key => {
        throwIfAborted(signal);
        const descriptor = Reflect.getOwnPropertyDescriptor(source, key)!;
        const storageKey = makeArchiveSafePluginSaveStorageKey(prefix, key);
        const size = utf8ByteLength(stringifyJsonValue(descriptor.value));
        return { key, storageKey, size };
    });
}

/**
 * Inventory and bound a manual transition before any authoritative row body is
 * loaded or the live routing flag changes. Physical orphan/quarantine rows are
 * deliberately excluded through the active generation manifest.
 */
async function preflightPluginStorageTransition(
    deps: ReconcileDependencies,
    target: boolean,
    signal?: AbortSignal | null,
): Promise<PluginStorageTransitionPreflight> {
    throwIfAborted(signal);
    const db = deps.getDatabase();
    // Reject hostile inline descriptors before touching persistent storage.
    let inlineValues: ReturnType<typeof measureInlineTransitionEntries>;
    let inlineMeta: ReturnType<typeof measureInlineTransitionEntries>;
    try {
        inlineValues = measureInlineTransitionEntries(
            db.pluginCustomStorage,
            "pluginCustomStorage",
            PLUGIN_SAVE_PREFIX,
            signal,
        );
        inlineMeta = measureInlineTransitionEntries(
            db.pluginStorageMeta,
            "pluginStorageMeta",
            PLUGIN_SAVE_META_PREFIX,
            signal,
        );
    } catch (error) {
        if (target && error instanceof TypeError) {
            throw unsupportedOptimizedPluginStorageTransition(error);
        }
        throw error;
    }
    const [valueInventory, metaInventory] = await Promise.all([
        deps.listPersistentEntriesWithSizes(PLUGIN_SAVE_PREFIX, signal),
        deps.listPersistentEntriesWithSizes(PLUGIN_SAVE_META_PREFIX, signal),
    ]);
    throwIfAborted(signal);

    const valueSizeByKey = new Map(valueInventory.map(entry => [entry.key, entry.size]));
    const metaSizeByKey = new Map(metaInventory.map(entry => [entry.key, entry.size]));
    const ownership = await resolvePluginStorageOwnership(
        db,
        valueInventory.map(entry => entry.key),
        metaInventory.map(entry => entry.key),
        deps.readPersistentJson,
        signal,
    );
    const ownedValueKeys = db.optimizePluginMemory === true ? ownership.valueKeys : [];
    const ownedMetaKeys = db.optimizePluginMemory === true ? ownership.metaKeys : [];
    const ownedValueRawKeys = new Set<string>();
    const ownedMetaRawKeys = new Set<string>();
    const ownedBytes: number[] = [];
    const ownedEntries: PluginStorageTransitionPreflight["entries"] = [];
    for (const storageKey of ownedValueKeys) {
        const rawKey = decodeListedStorageKey(
            storageKey,
            PLUGIN_SAVE_PREFIX,
            ownership.manifest,
        );
        const size = valueSizeByKey.get(storageKey);
        if (rawKey === null || size === undefined) {
            throw new StorageError("Plugin storage changed during size inventory; retry.", {
                code: "PLUGIN_STORAGE_CHANGED",
                operation: "transition",
                retryable: true,
            });
        }
        validateTransitionRowSize(size);
        ownedValueRawKeys.add(rawKey);
        ownedBytes.push(size);
        ownedEntries.push({
            rawKey,
            storageKey,
            size,
            prefix: PLUGIN_SAVE_PREFIX,
        });
    }
    for (const storageKey of ownedMetaKeys) {
        const rawKey = decodeListedStorageKey(
            storageKey,
            PLUGIN_SAVE_META_PREFIX,
            ownership.manifest,
        );
        const size = metaSizeByKey.get(storageKey);
        if (rawKey === null || size === undefined) {
            throw new StorageError("Plugin storage changed during size inventory; retry.", {
                code: "PLUGIN_STORAGE_CHANGED",
                operation: "transition",
                retryable: true,
            });
        }
        validateTransitionRowSize(size);
        ownedMetaRawKeys.add(rawKey);
        ownedBytes.push(size);
        ownedEntries.push({
            rawKey,
            storageKey,
            size,
            prefix: PLUGIN_SAVE_META_PREFIX,
        });
    }

    const inlineBytes: number[] = [];
    let baselineEntries = 0;
    let baselineBytes = 0;
    let baselineLargestRowBytes = 0;
    const accountInline = (
        entries: Array<{ key: string; size: number }>,
        externalWinners: Set<string>,
    ) => {
        for (const entry of entries) {
            if (!target && externalWinners.has(entry.key)) continue;
            validateTransitionRowSize(entry.size);
            if (target) inlineBytes.push(entry.size);
            else {
                baselineEntries += 1;
                baselineBytes = addTransitionBytes(baselineBytes, entry.size);
                baselineLargestRowBytes = Math.max(baselineLargestRowBytes, entry.size);
            }
        }
    };
    accountInline(inlineValues, ownedValueRawKeys);
    accountInline(inlineMeta, ownedMetaRawKeys);

    if (target) {
        const overwrittenValueKeys = new Set(inlineValues.map(entry => entry.storageKey));
        const overwrittenMetaKeys = new Set(inlineMeta.map(entry => entry.storageKey));
        const retainedBytes: number[] = [];
        ownedValueKeys.forEach((key, index) => {
            if (!overwrittenValueKeys.has(key)) retainedBytes.push(ownedBytes[index]);
        });
        ownedMetaKeys.forEach((key, index) => {
            if (!overwrittenMetaKeys.has(key)) {
                retainedBytes.push(ownedBytes[ownedValueKeys.length + index]);
            }
        });
        const totalEntries = inlineBytes.length + retainedBytes.length;
        if (totalEntries > PLUGIN_STORAGE_INTERNALIZE_MAX_ENTRIES) {
            throw transitionLimitError(
                "entries",
                totalEntries,
                PLUGIN_STORAGE_INTERNALIZE_MAX_ENTRIES,
            );
        }
        const retainedTotal = retainedBytes.reduce(addTransitionBytes, 0);
        const totalBytes = inlineBytes.reduce(addTransitionBytes, retainedTotal);
        const largestInlineRow = inlineBytes.reduce(
            (largest, size) => Math.max(largest, size),
            0,
        );
        const largestRowBytes = retainedBytes.reduce(
            (largest, size) => Math.max(largest, size),
            largestInlineRow,
        );
        return {
            direction: "externalize",
            orderedBytes: inlineBytes,
            baselineEntries: retainedBytes.length,
            baselineBytes: retainedTotal,
            totalBytes,
            largestRowBytes,
            maxBytes: null,
            entries: [...inlineValues, ...inlineMeta].map(entry => ({
                rawKey: entry.key,
                storageKey: entry.storageKey,
                size: entry.size,
                prefix: entry.storageKey.startsWith(PLUGIN_SAVE_META_PREFIX)
                    ? PLUGIN_SAVE_META_PREFIX
                    : PLUGIN_SAVE_PREFIX,
            })),
        };
    }

    const totalEntries = ownedBytes.length + baselineEntries;
    if (totalEntries > PLUGIN_STORAGE_INTERNALIZE_MAX_ENTRIES) {
        throw transitionLimitError(
            "entries",
            totalEntries,
            PLUGIN_STORAGE_INTERNALIZE_MAX_ENTRIES,
        );
    }
    let totalBytes = baselineBytes;
    for (const size of ownedBytes) {
        totalBytes = addTransitionBytes(totalBytes, size);
    }
    if (totalBytes > 0) {
        const requiredBytes = totalBytes * PLUGIN_STORAGE_INTERNALIZE_DISK_MULTIPLIER;
        if (!Number.isSafeInteger(requiredBytes)) {
            throw new StorageError("Plugin storage disk preflight exceeds the safe integer range.", {
                code: "PLUGIN_STORAGE_SIZE_LIMIT",
                operation: "transition",
            });
        }
        const freeBytes = await deps.getPersistentStorageFreeBytes(signal);
        if (freeBytes !== null && freeBytes < requiredBytes) {
            throw new StorageError(
                `Plugin storage needs approximately ${requiredBytes} free bytes to internalize safely, but only ${freeBytes} bytes are available.`,
                { code: "PLUGIN_STORAGE_DISK_LIMIT", operation: "transition" },
            );
        }
    }
    return {
        direction: "internalize",
        orderedBytes: ownedBytes,
        baselineEntries,
        baselineBytes,
        totalBytes,
        largestRowBytes: ownedBytes.reduce(
            (largest, size) => Math.max(largest, size),
            baselineLargestRowBytes,
        ),
        maxBytes: null,
        entries: ownedEntries,
    };
}

function withTransitionByteProgress(
    options: Omit<PluginStorageReconcileOptions, "dependencies">,
    preflight: PluginStorageTransitionPreflight,
): Omit<PluginStorageReconcileOptions, "dependencies"> {
    const prefixBytes = [preflight.baselineBytes];
    for (const size of preflight.orderedBytes) {
        prefixBytes.push(addTransitionBytes(prefixBytes[prefixBytes.length - 1], size));
    }
    const expand = (progress: PluginStorageReconcileProgress): PluginStorageReconcileProgress => {
        const moved = Math.max(0, Math.min(progress.completed, preflight.orderedBytes.length));
        return {
            ...progress,
            direction: preflight.direction,
            completed: preflight.baselineEntries + moved,
            total: preflight.baselineEntries + preflight.orderedBytes.length,
            completedBytes: prefixBytes[moved],
            totalBytes: preflight.totalBytes,
            maxBytes: preflight.maxBytes,
        };
    };
    return {
        ...options,
        onStart: progress => options.onStart?.(expand(progress)),
        onProgress: progress => options.onProgress?.(expand(progress)),
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
                || decodeListedStorageKey(
                    storageKey,
                    PLUGIN_SAVE_PREFIX,
                    ownership.manifest,
                ) === null
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
            const key = decodeListedStorageKey(
                storageKey,
                PLUGIN_SAVE_PREFIX,
                ownership.manifest,
            )!;
            definePluginStorageRecordValue(values, key, value);
        }
        for (const storageKey of activeMetaKeys) {
            if (
                overwrittenMetaKeys.has(storageKey)
                || decodeListedStorageKey(
                    storageKey,
                    PLUGIN_SAVE_META_PREFIX,
                    ownership.manifest,
                ) === null
            ) continue;
            const record = snapshotJsonValue(await readGenerationBoundPluginStorageJson(
                deps.readPersistentJson,
                storageKey,
                ownership.manifest?.generation,
                false,
                options.signal,
            ));
            const key = decodeListedStorageKey(
                storageKey,
                PLUGIN_SAVE_META_PREFIX,
                ownership.manifest,
            )!;
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
        const key = decodeListedStorageKey(storageKey, PLUGIN_SAVE_PREFIX, ownership.manifest);
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
        const key = decodeListedStorageKey(storageKey, PLUGIN_SAVE_META_PREFIX, ownership.manifest);
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
                mergedPluginStorageKeyMappings(
                    null,
                    [
                        ...prepared.valueEntries.map(entry => entry.key),
                        ...prepared.metaEntries.map(entry => entry.key),
                    ],
                    prepared.activeValueKeys,
                    prepared.activeMetaKeys,
                ),
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

/**
 * Production manual transitions use an unpublished server stage. Only one
 * detached JSON row crosses the transport at a time; the generation, exact
 * manifest, database mode, old-row deletion, and recovery token are published
 * together by the final server transaction.
 */
function latchPluginStorageTransitionForReload(
    target: boolean,
    error: unknown,
): StorageError {
    const reloadError = new StorageError(
        "Plugin storage state could not be recovered safely. Reload before using plugins or saving again.",
        {
            code: "COMMIT_OUTCOME_UNKNOWN",
            operation: "transition",
            commitOutcomeUnknown: true,
            cause: error,
        },
    );
    pluginStorageBarrierLatchedUntilReload = true;
    latchPluginStorageModeTransitionUntilReload();
    blockDatabaseSavesUntilReload(reloadError);
    setPluginStorageRecoveryState({
        direction: target ? "externalize" : "internalize",
        issues: [{ code: "persist-failed", encodedKey: PLUGIN_STORAGE_MANIFEST_KEY }],
    });
    return reloadError;
}

async function applyStagedPluginStorageTransition(
    deps: ReconcileDependencies,
    target: boolean,
    preflight: PluginStorageTransitionPreflight,
    options: Omit<PluginStorageReconcileOptions, "dependencies">,
): Promise<PluginStorageReconcileResult> {
    const db = deps.getDatabase();
    const sourceOwnership = await readCurrentOwnership(db, options.signal);
    if (
        !sourceOwnership.manifestValid
        || (db.pluginStorageGeneration
            && sourceOwnership.manifest?.generation !== db.pluginStorageGeneration
            && db.optimizePluginMemory === true)
    ) {
        throw new StorageError("Cannot transition an invalid plugin storage publication.", {
            code: "PLUGIN_STORAGE_CHANGED",
            operation: "transition",
            retryable: true,
        });
    }

    // Bind the stage to the latest durable non-plugin database state. The
    // server transforms that saved source directly, so no target DB envelope
    // or aggregate plugin map is sent back through the browser.
    await deps.persistDatabase();
    throwIfAborted(options.signal);
    const transitionId = uuidv4();
    const targetGeneration = uuidv4();
    const stage = await beginPersistentPluginStorageTransition({
        version: 2,
        transitionId,
        source: {
            optimized: db.optimizePluginMemory === true,
            generation: db.pluginStorageGeneration ?? null,
            manifest: sourceOwnership.manifest,
        },
        targetOptimized: target,
        targetGeneration,
        rows: target
            ? preflight.entries.map(entry => ({
                storageKey: entry.storageKey,
                rawKey: entry.rawKey,
                size: entry.size,
            }))
            : [],
    }, options.signal);
    const expectedDirection = target ? "externalize" : "internalize";
    if (stage.direction !== expectedDirection
        || stage.targetGeneration !== targetGeneration
        || (stage.state !== "uploading" && stage.state !== "ready")) {
        try {
            await abortPersistentPluginStorageTransition(transitionId);
        } catch {
            // The unpublished stage is already unusable to this client; keep
            // the exact response error as the primary failure.
        }
        throw new StorageError("The staged transition acknowledgement did not match its plan.", {
            code: "STORAGE_RESPONSE_ERROR",
            operation: "transition",
            retryable: false,
        });
    }
    const total = target ? preflight.entries.length : stage.rows.length;
    const totalBytes = target
        ? preflight.entries.reduce((sum, entry) => addTransitionBytes(sum, entry.size), 0)
        : stage.rows.reduce((sum, entry) => addTransitionBytes(sum, entry.size), 0);
    options.onStart?.({
        direction: target ? "externalize" : "internalize",
        completed: 0,
        total,
        completedBytes: 0,
        totalBytes,
        maxBytes: null,
    });

    // The authoritative baseline above is already durable. Acknowledged rows
    // are deliberately removed from the live inline map one at a time so their
    // payloads become collectible. The lifecycle/storage barriers keep plugin
    // operations from observing that temporary map, the source-mode flag stays
    // unchanged, the server stage is unpublished, and this save pause prevents
    // a partial old-mode map from becoming durable. Failure restores each row
    // from the private stage before any of those guards are released.
    const resumeDatabaseSaves = beginDatabaseSavePause();
    let finalizeDispatched = false;
    const uploaded: PluginStorageTransitionPreflight["entries"] = [];
    let completedBytes = 0;
    try {
        if (target) {
            for (const entry of preflight.entries) {
                throwIfAborted(options.signal);
                const source = entry.prefix === PLUGIN_SAVE_PREFIX
                    ? db.pluginCustomStorage
                    : db.pluginStorageMeta;
                const descriptor = Reflect.getOwnPropertyDescriptor(source ?? {}, entry.rawKey);
                if (!descriptor || !("value" in descriptor)) {
                    throw new StorageError("Plugin storage changed during staging; retry.", {
                        code: "PLUGIN_STORAGE_CHANGED",
                        operation: "transition",
                        retryable: true,
                    });
                }
                const prepared = preparePersistentJson(descriptor.value);
                if (prepared.byteLength !== entry.size) {
                    throw new StorageError("Plugin storage changed during staging; retry.", {
                        code: "PLUGIN_STORAGE_CHANGED",
                        operation: "transition",
                        retryable: true,
                    });
                }
                const upload = await uploadPersistentPluginStorageTransitionRow(
                    transitionId,
                    entry.storageKey,
                    prepared.bytes,
                    options.signal,
                );
                if (upload.direction !== expectedDirection
                    || upload.targetGeneration !== targetGeneration) {
                    throw new StorageError("The staged row acknowledgement changed transition identity.", {
                        code: "COMMIT_OUTCOME_UNKNOWN",
                        operation: "transition",
                        commitOutcomeUnknown: true,
                    });
                }
                if (entry.prefix === PLUGIN_SAVE_PREFIX) {
                    delete db.pluginCustomStorage[entry.rawKey];
                } else if (db.pluginStorageMeta) {
                    delete db.pluginStorageMeta[entry.rawKey];
                }
                uploaded.push(entry);
                completedBytes = addTransitionBytes(completedBytes, entry.size);
                options.onProgress?.({
                    direction: "externalize",
                    completed: uploaded.length,
                    total,
                    completedBytes,
                    totalBytes,
                    maxBytes: null,
                });
            }
        }

        let nextValues: Record<string, unknown> | null = null;
        let nextMeta: NonNullable<Database["pluginStorageMeta"]> | null = null;
        if (!target) {
            nextValues = copyDatabasePluginStorageRecord(db.pluginCustomStorage);
            nextMeta = copyDatabasePluginStorageRecord(
                db.pluginStorageMeta,
            ) as NonNullable<Database["pluginStorageMeta"]>;
            let completed = 0;
            for (const row of stage.rows) {
                throwIfAborted(options.signal);
                const prefix = row.storageKey.startsWith(PLUGIN_SAVE_META_PREFIX)
                    ? PLUGIN_SAVE_META_PREFIX
                    : PLUGIN_SAVE_PREFIX;
                const rawKey = typeof row.rawKey === "string"
                    ? row.rawKey
                    : decodeListedStorageKey(row.storageKey, prefix);
                if (rawKey === null
                    || makeArchiveSafePluginSaveStorageKey(prefix, rawKey) !== row.storageKey) {
                    throw new StorageError("The staged transition returned an invalid key.", {
                        code: "PLUGIN_STORAGE_CHANGED",
                        operation: "transition",
                    });
                }
                const bytes = await readPersistentPluginStorageTransitionRow(
                    transitionId,
                    row.storageKey,
                    options.signal,
                );
                if (bytes.byteLength !== row.size) {
                    throw new StorageError("The staged transition row changed size.", {
                        code: "PLUGIN_STORAGE_CHANGED",
                        operation: "transition",
                    });
                }
                if (!row.sha256 || await sha256OwnedBytes(bytes) !== row.sha256) {
                    throw new StorageError("The staged transition row failed its source hash.", {
                        code: "PLUGIN_STORAGE_CHANGED",
                        operation: "transition",
                    });
                }
                const value = JSON.parse(new TextDecoder().decode(bytes));
                if (prefix === PLUGIN_SAVE_PREFIX) {
                    definePluginStorageRecordValue(nextValues, rawKey, value);
                } else {
                    definePluginStorageRecordValue(
                        nextMeta,
                        rawKey,
                        value as NonNullable<Database["pluginStorageMeta"]>[string],
                    );
                }
                completedBytes = addTransitionBytes(completedBytes, row.size);
                options.onProgress?.({
                    direction: "internalize",
                    completed: ++completed,
                    total,
                    completedBytes,
                    totalBytes,
                    maxBytes: null,
                });
            }
        }

        throwIfAborted(options.signal);
        finalizeDispatched = true;
        const committed = await finalizePersistentPluginStorageTransition(transitionId);
        if (committed.state !== "committed"
            || committed.direction !== expectedDirection
            || committed.targetGeneration !== targetGeneration) {
            throw new StorageError("Plugin storage finalize was not acknowledged.", {
                code: "COMMIT_OUTCOME_UNKNOWN",
                operation: "transition",
                commitOutcomeUnknown: true,
            });
        }

        db.optimizePluginMemory = target;
        db.pluginStorageGeneration = targetGeneration;
        if (target) {
            db.pluginCustomStorage = createDatabasePluginStorageRecord();
            delete db.pluginStorageMeta;
        } else {
            db.pluginCustomStorage = nextValues!;
            if (nextMeta && getPluginStorageRecordKeys(nextMeta).length > 0) {
                db.pluginStorageMeta = nextMeta;
            } else {
                delete db.pluginStorageMeta;
            }
        }
        return {
            direction: target ? "externalize" : "internalize",
            values: stage.rows.filter(row => row.storageKey.startsWith(PLUGIN_SAVE_PREFIX)).length,
            meta: stage.rows.filter(row => row.storageKey.startsWith(PLUGIN_SAVE_META_PREFIX)).length,
        };
    } catch (error) {
        const outcomeUnknown = error instanceof StorageError
            && error.commitOutcomeUnknown;
        let restoreFailed = false;
        if (!finalizeDispatched || !outcomeUnknown) {
            // Restore one acknowledged row at a time before allowing database
            // saves to resume. No aggregate rollback copy is retained.
            for (const entry of uploaded) {
                try {
                    const bytes = await readPersistentPluginStorageTransitionRow(
                        transitionId,
                        entry.storageKey,
                    );
                    const value = JSON.parse(new TextDecoder().decode(bytes));
                    if (entry.prefix === PLUGIN_SAVE_PREFIX) {
                        definePluginStorageRecordValue(db.pluginCustomStorage, entry.rawKey, value);
                    } else {
                        if (!db.pluginStorageMeta) {
                            db.pluginStorageMeta = createDatabasePluginStorageRecord<
                                NonNullable<Database["pluginStorageMeta"]>[string]
                            >();
                        }
                        definePluginStorageRecordValue(
                            db.pluginStorageMeta,
                            entry.rawKey,
                            value as NonNullable<Database["pluginStorageMeta"]>[string],
                        );
                    }
                } catch (restoreError) {
                    restoreFailed = true;
                    console.error("[Plugin storage] staged row restore failed", restoreError);
                }
            }
            try {
                await abortPersistentPluginStorageTransition(transitionId);
            } catch (abortError) {
                console.error("[Plugin storage] staged transition abort failed", abortError);
            }
        }
        if (restoreFailed) {
            throw latchPluginStorageTransitionForReload(target, error);
        }
        if (finalizeDispatched && outcomeUnknown) {
            throw latchPluginStorageTransitionForReload(target, error);
        }
        throw error;
    } finally {
        resumeDatabaseSaves();
    }
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
    if (options.dependencies === undefined) {
        throw new Error(
            "Production plugin storage changes must use transitionPluginStorageMode or boot recovery.",
        );
    }
    const deps = resolveReconcileDependencies(options.dependencies);
    return withPluginSaveStorageLock(async () => {
        const target = deps.getDatabase().optimizePluginMemory === true;
        const prepared = await preparePluginStorageReconciliation(
            deps,
            target,
            options,
            false,
        );
        return applyPluginStorageReconciliation(prepared, deps, options);
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
    pluginStorageGeneration: string | undefined,
    manifest: PluginStorageManifest | null,
    issues: PluginStorageRecoveryIssue[],
    signal?: AbortSignal | null,
): Promise<PreparedStorageEntry[]> {
    if (listed === null) return [];
    const rows: PreparedStorageEntry[] = [];
    for (const storageKey of listed) {
        throwIfAborted(signal);
        let key: string | null = null;
        try {
            key = decodeListedStorageKey(storageKey, prefix, manifest);
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
            const readOptions = {
                ...(cached ? { cached: true } : {}),
                ...(pluginStorageGeneration ? { pluginStorageGeneration } : {}),
                ...(signal ? { signal } : {}),
            };
            const row = await deps.readPersistentJsonRow(
                storageKey,
                readOptions,
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
        return await withPluginSaveStorageLock(async () => {
        throwIfAborted(signal);
        invalidateStorageEnumerationSnapshot();
        const db = deps.getDatabase();
        const target = db.optimizePluginMemory === true;
        const selectedGeneration = typeof db.pluginStorageGeneration === "string"
            && db.pluginStorageGeneration.length > 0
            ? db.pluginStorageGeneration
            : undefined;
        const pluginStorageGeneration = target ? selectedGeneration : undefined;
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
        let recoveryManifest: PluginStorageManifest | null = null;
        if (selectedGeneration) {
            try {
                const rawManifest = await deps.readPersistentJson<unknown>(
                    PLUGIN_STORAGE_MANIFEST_KEY,
                    { signal },
                );
                const normalized = normalizePluginStorageManifest(rawManifest);
                if (normalized?.generation === selectedGeneration) {
                    recoveryManifest = normalized;
                }
            } catch (error) {
                throwIfAborted(signal);
                issues.push(bootRecoveryIssue(
                    error,
                    PLUGIN_STORAGE_MANIFEST_KEY,
                    "read-failed",
                ));
            }
        }
        const [externalValueEntries, externalMetaEntries] = await Promise.all([
            readBootStorageRows(
                deps,
                PLUGIN_SAVE_PREFIX,
                listedValueKeys,
                true,
                pluginStorageGeneration,
                recoveryManifest,
                issues,
                signal,
            ),
            readBootStorageRows(
                deps,
                PLUGIN_SAVE_META_PREFIX,
                listedMetaKeys,
                false,
                pluginStorageGeneration,
                recoveryManifest,
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
            let currentRecoveryManifest = recoveryManifest;

            const restorePair = async (
                entry: PreparedStorageEntry,
                metaEntry: PreparedStorageEntry | undefined,
            ): Promise<void> => {
                const mapped = isHashedPluginSaveStorageKey(
                    entry.storageKey,
                    PLUGIN_SAVE_PREFIX,
                ) || (metaEntry !== undefined && isHashedPluginSaveStorageKey(
                    metaEntry.storageKey,
                    PLUGIN_SAVE_META_PREFIX,
                ));
                if (!mapped) {
                    await deps.restorePersistentPluginStoragePair(
                        entry.storageKey,
                        entry.value,
                        metaEntry?.value,
                        signal,
                    );
                    return;
                }
                if (!pluginStorageGeneration
                    || !currentRecoveryManifest
                    || currentRecoveryManifest.generation !== pluginStorageGeneration) {
                    throw new Error(
                        "Mapped plugin storage recovery requires the selected manifest.",
                    );
                }
                const valueKeys = new Set(currentRecoveryManifest.valueKeys);
                const metaKeys = new Set(currentRecoveryManifest.metaKeys);
                valueKeys.add(entry.storageKey);
                if (metaEntry) metaKeys.add(metaEntry.storageKey);
                const nextManifest = buildPluginStorageManifest(
                    pluginStorageGeneration,
                    valueKeys,
                    metaKeys,
                    mergedPluginStorageKeyMappings(
                        currentRecoveryManifest,
                        [entry.key],
                        valueKeys,
                        metaKeys,
                    ),
                );
                await deps.commitPersistentPluginStorageMutation({
                    generation: pluginStorageGeneration,
                    expectedManifest: currentRecoveryManifest,
                    nextManifest,
                    writes: [entry, ...(metaEntry ? [metaEntry] : [])].map(row => ({
                        storageKey: row.storageKey,
                        valueBytes: preparePersistentJson(row.value).bytes,
                    })),
                    deletes: [],
                }, signal);
                currentRecoveryManifest = nextManifest;
            };

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
                        await restorePair(entry, metaEntry);
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
                        if (isHashedPluginSaveStorageKey(
                            entry.storageKey,
                            PLUGIN_SAVE_META_PREFIX,
                        )) {
                            if (!pluginStorageGeneration
                                || !currentRecoveryManifest
                                || currentRecoveryManifest.generation !== pluginStorageGeneration) {
                                throw new Error(
                                    "Mapped plugin storage recovery requires the selected manifest.",
                                );
                            }
                            const valueKeys = new Set(currentRecoveryManifest.valueKeys);
                            const metaKeys = new Set(currentRecoveryManifest.metaKeys);
                            metaKeys.add(entry.storageKey);
                            const nextManifest = buildPluginStorageManifest(
                                pluginStorageGeneration,
                                valueKeys,
                                metaKeys,
                                mergedPluginStorageKeyMappings(
                                    currentRecoveryManifest,
                                    [entry.key],
                                    valueKeys,
                                    metaKeys,
                                ),
                            );
                            await deps.commitPersistentPluginStorageMutation({
                                generation: pluginStorageGeneration,
                                expectedManifest: currentRecoveryManifest,
                                nextManifest,
                                writes: [{
                                    storageKey: entry.storageKey,
                                    valueBytes: preparePersistentJson(entry.value).bytes,
                                }],
                                deletes: [],
                            }, signal);
                            currentRecoveryManifest = nextManifest;
                        } else {
                            await deps.writePersistentJson(entry.storageKey, entry.value, signal);
                        }
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

        // Earlier plugin reloads, including each V2 unload grace period, have
        // now drained. Retired generations cannot publish late writes. Keep the
        // synchronous legacy guard active until reconciliation and its durable
        // save have completed.
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
                const preflight = await preflightPluginStorageTransition(
                    deps,
                    target,
                    options.signal,
                );
                if (!target
                    && options.confirmLargeInlineTransition
                    && (preflight.totalBytes > PLUGIN_STORAGE_LARGE_INLINE_WARNING_BYTES
                        || preflight.largestRowBytes
                            > PLUGIN_STORAGE_LARGE_INLINE_ROW_WARNING_BYTES)) {
                    const confirmed = await options.confirmLargeInlineTransition({
                        direction: "internalize",
                        totalBytes: preflight.totalBytes,
                        largestRowBytes: preflight.largestRowBytes,
                        aggregateWarningBytes: PLUGIN_STORAGE_LARGE_INLINE_WARNING_BYTES,
                        rowWarningBytes: PLUGIN_STORAGE_LARGE_INLINE_ROW_WARNING_BYTES,
                    });
                    throwIfAborted(options.signal);
                    if (!confirmed) {
                        throw new DOMException(
                            "Large plugin storage internalization cancelled.",
                            "AbortError",
                        );
                    }
                }
                if (options.dependencies === undefined) {
                    return await applyStagedPluginStorageTransition(
                        deps,
                        target,
                        preflight,
                        options,
                    );
                }
                const transitionOptions = withTransitionByteProgress(options, preflight);
                // This may perform reads, but no mode/backend/database mutation.
                // A malformed source therefore rejects without needing rollback.
                const prepared = await preparePluginStorageReconciliation(
                    deps,
                    target,
                    transitionOptions,
                    true,
                );
                db.optimizePluginMemory = target;

                try {
                    const result = await applyPluginStorageReconciliation(
                        prepared,
                        deps,
                        transitionOptions,
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
