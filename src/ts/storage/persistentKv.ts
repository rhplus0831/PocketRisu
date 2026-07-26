import { hasher } from "../parser/parser.svelte";
import { forageStorage } from "../globalApi.svelte";
import { stringifyJsonValue } from "./jsonValue";
import { assertWellFormedUnicode } from "./unicodeWellFormed";
import { awaitWithAbort, throwIfAborted } from "./abort";
import { StorageError } from "./storageError";
import {
    requireCommittedPluginStorageMutation,
    type PluginStorageMutationResult,
} from "./pluginStorageMutation";
import type {
    PluginStorageBatchRequest,
    PluginStorageBatchResult,
    PluginStorageVersionedState,
} from "./pluginStorageBatch";
import { PluginStorageBatchError } from "./pluginStorageBatch";
import type {
    PluginStorageManifestSnapshotTransport,
    PluginStorageManifestTransport,
    PluginStorageStagedTransitionBegin,
    PluginStorageStagedTransitionAbortTombstone,
    PluginStorageStagedTransitionStatus,
    PluginStorageTransitionTransport,
} from "./nodeStorage";
import {
    PLUGIN_VALUE_MAX_BYTES,
    pluginStorageLimitMessage,
} from "./pluginStorageLimits";

export { hasNativeStringWellFormed } from "./unicodeWellFormed";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let initPromise: Promise<void> | null = null;

async function ensureStorageReady(signal?: AbortSignal | null) {
    throwIfAborted(signal);
    if (!initPromise) {
        initPromise = forageStorage.Init();
    }
    await awaitWithAbort(initPromise, signal);
}

function encodeKeyComponent(value: string) {
    assertWellFormedUnicode(value);
    return Buffer.from(value, "utf-8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function decodeKeyComponent(value: string) {
    const padded = value
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(value.length / 4) * 4, "=");
    return Buffer.from(padded, "base64").toString("utf-8");
}

export interface PersistentJsonReadOptions {
    cached?: boolean;
    signal?: AbortSignal | null;
    pluginStorageGeneration?: string;
}

export type PersistentJsonRow<T> =
    | { kind: "missing" }
    | { kind: "value"; value: T };

export async function readPersistentJsonRow<T>(
    storageKey: string,
    options: PersistentJsonReadOptions = {},
): Promise<PersistentJsonRow<T>> {
    await ensureStorageReady(options.signal);
    const storageOptions = {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.pluginStorageGeneration
            ? { pluginStorageGeneration: options.pluginStorageGeneration }
            : {}),
    };
    const hasStorageOptions = Object.keys(storageOptions).length > 0;
    const data = options.cached
        ? hasStorageOptions
            ? await forageStorage.getItemCached(storageKey, storageOptions)
            : await forageStorage.getItemCached(storageKey)
        : hasStorageOptions
            ? await forageStorage.getItem(storageKey, storageOptions)
            : await forageStorage.getItem(storageKey);
    if (data === null || data === undefined) {
        return { kind: "missing" };
    }
    return {
        kind: "value",
        value: JSON.parse(decoder.decode(data)) as T,
    };
}

export interface PreparedPersistentJson {
    /** Fresh immutable bytes owned by the persistence operation. */
    bytes: Uint8Array;
    byteLength: number;
}

export function preparePersistentJson<T>(
    value: T,
    options: { pluginValue?: boolean } = {},
): PreparedPersistentJson {
    const serialized = stringifyJsonValue(value);
    const bytes = encoder.encode(serialized);
    const byteLength = bytes.byteLength;
    if (options.pluginValue && byteLength > PLUGIN_VALUE_MAX_BYTES) {
        throw new StorageError(pluginStorageLimitMessage(byteLength), {
            status: 413,
            code: "PLUGIN_VALUE_TOO_LARGE",
            retryable: false,
            operation: "write",
        });
    }
    return { bytes, byteLength };
}

export async function readPersistentJson<T>(
    storageKey: string,
    options: PersistentJsonReadOptions = {},
): Promise<T | null> {
    const row = await readPersistentJsonRow<T>(storageKey, options);
    return row.kind === "missing" ? null : row.value;
}

export async function writePersistentJson<T>(
    storageKey: string,
    value: T,
    signal?: AbortSignal | null,
): Promise<void> {
    throwIfAborted(signal);
    // Snapshot and validate before the first await. Callers may mutate their
    // object after invoking this async method, and storage initialization must
    // not turn that into an unacknowledged change to the bytes being written.
    const prepared = preparePersistentJson(value, {
        pluginValue: storageKey.startsWith("pluginsave/"),
    });
    await writePreparedPersistentJson(storageKey, prepared, signal);
}

export async function writePreparedPersistentJson(
    storageKey: string,
    prepared: PreparedPersistentJson,
    signal?: AbortSignal | null,
): Promise<void> {
    throwIfAborted(signal);
    await ensureStorageReady(signal);
    if (signal) await forageStorage.setItem(storageKey, prepared.bytes, undefined, signal);
    else await forageStorage.setItem(storageKey, prepared.bytes);
}

export async function removePersistentKey(
    storageKey: string,
    signal?: AbortSignal | null,
): Promise<void> {
    await ensureStorageReady(signal);
    if (signal) await forageStorage.removeItem(storageKey, signal);
    else await forageStorage.removeItem(storageKey);
}

/**
 * Mutate one optimized save value and its matching ownership row as one
 * acknowledged server transaction. An empty owner deliberately removes stale
 * ownership; remove also cleans an owner orphan when the value is absent.
 */
export async function mutatePersistentPluginStorage<T>(
    valueStorageKey: string,
    operation: "set",
    value: T,
    owner: string,
    signal?: AbortSignal | null,
    generation?: string,
    preparedValue?: PreparedPersistentJson,
): Promise<PluginStorageMutationResult>;
export async function mutatePersistentPluginStorage(
    valueStorageKey: string,
    operation: "remove",
    signal?: AbortSignal | null,
    generation?: string,
): Promise<PluginStorageMutationResult>;
export async function mutatePersistentPluginStorage<T>(
    valueStorageKey: string,
    operation: "set" | "remove",
    valueOrSignal?: T | AbortSignal | null,
    ownerOrGeneration = "",
    signal?: AbortSignal | null,
    generation?: string,
    preparedValue?: PreparedPersistentJson,
): Promise<PluginStorageMutationResult> {
    const activeSignal = operation === "remove"
        ? valueOrSignal as AbortSignal | null | undefined
        : signal;
    const owner = operation === "set" ? ownerOrGeneration : "";
    const activeGeneration = operation === "set" ? generation : ownerOrGeneration || undefined;
    throwIfAborted(activeSignal);
    // Preserve the ordinary persistent JSON rule: validation and detachment
    // happen before storage initialization or any queued mutation can run.
    const valueBytes = operation === "set"
        ? (preparedValue
            ?? preparePersistentJson(valueOrSignal as T, { pluginValue: true })).bytes
        : undefined;
    await ensureStorageReady(activeSignal);
    const request = {
        operation,
        valueKey: valueStorageKey,
        valueBytes,
        ...(operation === "set" ? { ownedValueBytes: true as const } : {}),
        owner,
        ...(activeGeneration ? { generation: activeGeneration } : {}),
    } as const;
    const result = activeSignal
        ? await forageStorage.mutatePluginStorage(request, activeSignal)
        : await forageStorage.mutatePluginStorage(request);
    return requireCommittedPluginStorageMutation(result);
}

/**
 * Boot recovery copy with an exact ownership sidecar and the same strict
 * acknowledgement/hash/retry contract as an ordinary AA1 mutation. Undefined
 * metadata preserves any historical sidecar already present at the destination.
 */
export async function restorePersistentPluginStoragePair<T>(
    valueStorageKey: string,
    value: T,
    ownerRecord: unknown | undefined,
    signal?: AbortSignal | null,
): Promise<PluginStorageMutationResult> {
    throwIfAborted(signal);
    const valueBytes = preparePersistentJson(value, { pluginValue: true }).bytes;
    const ownerRecordBytes = ownerRecord === undefined
        ? undefined
        : encoder.encode(stringifyJsonValue(ownerRecord));
    await ensureStorageReady(signal);
    const request = {
        operation: "set" as const,
        valueKey: valueStorageKey,
        valueBytes,
        ...(ownerRecordBytes
            ? { ownerRecordBytes }
            : { preserveOwner: true }),
    };
    const result = signal
        ? await forageStorage.mutatePluginStorage(request, signal)
        : await forageStorage.mutatePluginStorage(request);
    return requireCommittedPluginStorageMutation(result);
}

/** Set one logical value while retaining its existing ownership sidecar. */
export async function setPreparedPersistentPluginStoragePreservingOwner(
    valueStorageKey: string,
    preparedValue: PreparedPersistentJson,
    signal?: AbortSignal | null,
    generation?: string,
): Promise<PluginStorageMutationResult> {
    throwIfAborted(signal);
    await ensureStorageReady(signal);
    const request = {
        operation: "set" as const,
        valueKey: valueStorageKey,
        valueBytes: preparedValue.bytes,
        ownedValueBytes: true as const,
        preserveOwner: true,
        ...(generation ? { generation } : {}),
    };
    const result = signal
        ? await forageStorage.mutatePluginStorage(request, signal)
        : await forageStorage.mutatePluginStorage(request);
    return requireCommittedPluginStorageMutation(result);
}

/** Remove one logical value while retaining its historical owner sidecar. */
export async function removePersistentPluginStoragePreservingOwner(
    valueStorageKey: string,
    signal?: AbortSignal | null,
    generation?: string,
): Promise<PluginStorageMutationResult> {
    throwIfAborted(signal);
    await ensureStorageReady(signal);
    const request = {
        operation: "remove" as const,
        valueKey: valueStorageKey,
        preserveOwner: true,
        ...(generation ? { generation } : {}),
    };
    const result = signal
        ? await forageStorage.mutatePluginStorage(request, signal)
        : await forageStorage.mutatePluginStorage(request);
    return requireCommittedPluginStorageMutation(result);
}

export async function batchPersistentPluginStorage(
    request: PluginStorageBatchRequest,
    signal?: AbortSignal | null,
): Promise<Extract<PluginStorageBatchResult, { outcome: "committed" }> | Extract<
    PluginStorageBatchResult,
    { outcome: "not-committed" }
>> {
    throwIfAborted(signal);
    await ensureStorageReady(signal);
    const result = signal
        ? await forageStorage.batchPluginStorage(request, signal)
        : await forageStorage.batchPluginStorage(request);
    if (result.outcome === "committed"
        || (result.outcome === "not-committed"
            && (result.code === "PLUGIN_STORAGE_REVISION_CONFLICT"
                || result.code === "PLUGIN_STORAGE_GENERATION_CONFLICT"))) {
        return result as never;
    }
    throw new PluginStorageBatchError(result);
}

export async function readPersistentPluginStorageState<T>(
    valueStorageKey: string,
    signal?: AbortSignal | null,
    pluginStorageGeneration?: string,
): Promise<{
    status: "missing";
    value: null;
    revision: null;
    generation: string | null;
} | {
    status: "value";
    value: T;
    revision: string;
    generation: string | null;
}> {
    await ensureStorageReady(signal);
    const readOptions = {
        ...(signal ? { signal } : {}),
        ...(pluginStorageGeneration ? { pluginStorageGeneration } : {}),
    };
    const state: PluginStorageVersionedState = Object.keys(readOptions).length > 0
        ? await forageStorage.getPluginStorageState(valueStorageKey, readOptions)
        : await forageStorage.getPluginStorageState(valueStorageKey);
    if (state.missing) {
        return { status: "missing", value: null, revision: null, generation: state.generation };
    }
    if (!state.valueBytes || !state.revision) {
        throw new StorageError("Plugin storage state omitted committed value bytes.", {
            code: "STORAGE_RESPONSE_ERROR",
            operation: "read",
            retryable: true,
        });
    }
    return {
        status: "value",
        value: JSON.parse(decoder.decode(state.valueBytes)) as T,
        revision: state.revision,
        generation: state.generation,
    };
}

export async function readPersistentPluginStorageManifestSnapshot(
    generation: string,
    signal?: AbortSignal | null,
): Promise<PluginStorageManifestSnapshotTransport> {
    throwIfAborted(signal);
    await ensureStorageReady(signal);
    return await forageStorage.getPluginStorageManifestSnapshot(generation, signal);
}

export async function readPersistentPluginStorageManifestState(
    generation: string,
    signal?: AbortSignal | null,
): Promise<{ generation: string; manifestRevision: string }> {
    throwIfAborted(signal);
    await ensureStorageReady(signal);
    return await forageStorage.getPluginStorageManifestState(generation, signal);
}

export async function listPersistentKeys(
    prefix = "",
    signal?: AbortSignal | null,
): Promise<string[]> {
    await ensureStorageReady(signal);
    return signal
        ? await forageStorage.keys(prefix, signal)
        : await forageStorage.keys(prefix);
}

/** Free bytes on the authoritative save volume, or null when unavailable. */
export async function getPersistentStorageFreeBytes(
    signal?: AbortSignal | null,
): Promise<number | null> {
    await ensureStorageReady(signal);
    const capacity = signal
        ? await forageStorage.getStorageCapacity(signal)
        : await forageStorage.getStorageCapacity();
    return capacity.freeBytes;
}

export interface PersistentEntrySize {
    key: string;
    size: number;
}

/** Logical authoritative sizes without downloading or parsing row bodies. */
export async function listPersistentEntriesWithSizes(
    prefix: string,
    signal?: AbortSignal | null,
): Promise<PersistentEntrySize[]> {
    await ensureStorageReady(signal);
    return signal
        ? await forageStorage.listEntriesWithSizes(prefix, signal)
        : await forageStorage.listEntriesWithSizes(prefix);
}

export async function clearPersistentPrefix(
    prefix: string,
    signal?: AbortSignal | null,
): Promise<void> {
    const keys = signal
        ? await listPersistentKeys(prefix, signal)
        : await listPersistentKeys(prefix);
    // Generic/device-local prefixes do not have a server transaction, but they
    // must still avoid launching an unbounded number of mutations at once.
    for (const key of keys) {
        if (signal) await removePersistentKey(key, signal);
        else await removePersistentKey(key);
    }
}

/**
 * Clear the server-owned optimized plugin value and owner namespaces in one
 * transaction. This deliberately accepts no caller-selected prefix.
 */
export async function clearExternalizedPluginStorage(
    signal?: AbortSignal | null,
): Promise<void> {
    await ensureStorageReady(signal);
    if (signal) await forageStorage.clearPluginSaveStorage(signal);
    else await forageStorage.clearPluginSaveStorage();
}

export interface PersistentPluginStorageMutation {
    generation: string;
    expectedManifest: PluginStorageManifestTransport;
    nextManifest: PluginStorageManifestTransport;
    writes: { storageKey: string; valueBytes: Uint8Array }[];
    deletes: string[];
}

export async function commitPersistentPluginStorageMutation(
    mutation: PersistentPluginStorageMutation,
    signal?: AbortSignal | null,
): Promise<void> {
    throwIfAborted(signal);
    const writes = mutation.writes.map(({ storageKey, valueBytes }) => ({
        storageKey,
        valueBytes,
    }));
    await ensureStorageReady(signal);
    const plan = {
        version: 1,
        generation: mutation.generation,
        expectedManifest: mutation.expectedManifest,
        nextManifest: mutation.nextManifest,
        writes,
        deletes: mutation.deletes,
    } as const;
    if (signal) await forageStorage.commitPluginStorageMutation(plan, signal);
    else await forageStorage.commitPluginStorageMutation(plan);
}

export async function commitPersistentPluginStorageTransition(
    transition: PluginStorageTransitionTransport,
    signal?: AbortSignal | null,
): Promise<{ etag?: string }> {
    throwIfAborted(signal);
    await ensureStorageReady(signal);
    const plan = {
        ...transition,
        expectedEtag: transition.expectedEtag
            ?? forageStorage.getDbEtag()
            ?? undefined,
    };
    return signal
        ? await forageStorage.commitPluginStorageTransition(plan, signal)
        : await forageStorage.commitPluginStorageTransition(plan);
}

export async function beginPersistentPluginStorageTransition(
    plan: PluginStorageStagedTransitionBegin,
    signal?: AbortSignal | null,
): Promise<PluginStorageStagedTransitionStatus> {
    throwIfAborted(signal);
    await ensureStorageReady(signal);
    return await forageStorage.beginPluginStorageTransition({
        ...plan,
        expectedEtag: plan.expectedEtag
            ?? forageStorage.getDbEtag()
            ?? undefined,
    }, signal);
}

export async function uploadPersistentPluginStorageTransitionRow(
    transitionId: string,
    storageKey: string,
    bytes: Uint8Array,
    signal?: AbortSignal | null,
): Promise<PluginStorageStagedTransitionStatus> {
    throwIfAborted(signal);
    await ensureStorageReady(signal);
    return await forageStorage.uploadPluginStorageTransitionRow(
        transitionId,
        storageKey,
        bytes,
        signal,
    );
}

export async function readPersistentPluginStorageTransitionRow(
    transitionId: string,
    storageKey: string,
    signal?: AbortSignal | null,
): Promise<Uint8Array> {
    throwIfAborted(signal);
    await ensureStorageReady(signal);
    return await forageStorage.readPluginStorageTransitionRow(
        transitionId,
        storageKey,
        signal,
    );
}

export async function getPersistentPluginStorageTransitionStatus(
    transitionId: string,
    signal?: AbortSignal | null,
): Promise<PluginStorageStagedTransitionStatus> {
    await ensureStorageReady(signal);
    return await forageStorage.getPluginStorageTransitionStatus(transitionId, signal);
}

export async function finalizePersistentPluginStorageTransition(
    transitionId: string,
    signal?: AbortSignal | null,
): Promise<PluginStorageStagedTransitionStatus> {
    await ensureStorageReady(signal);
    return await forageStorage.finalizePluginStorageTransition(transitionId, signal);
}

export async function abortPersistentPluginStorageTransition(
    transitionId: string,
): Promise<PluginStorageStagedTransitionStatus | PluginStorageStagedTransitionAbortTombstone> {
    await ensureStorageReady();
    return await forageStorage.abortPluginStorageTransition(transitionId);
}

export async function makeHashedStorageKey(prefix: string, rawKey: string): Promise<string> {
    const hash = await hasher(encoder.encode(rawKey));
    return `${prefix}${hash}.json`;
}

export function makeEncodedStorageKey(prefix: string, rawKey: string): string {
    return `${prefix}${encodeKeyComponent(rawKey)}.json`;
}

export function decodeStorageKeyComponent(encodedKey: string): string {
    return decodeKeyComponent(encodedKey);
}
