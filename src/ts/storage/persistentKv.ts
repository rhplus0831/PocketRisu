import { hasher } from "../parser/parser.svelte";
import { forageStorage } from "../globalApi.svelte";
import { stringifyJsonValue } from "./jsonValue";
import { assertWellFormedUnicode } from "./unicodeWellFormed";
import { awaitWithAbort, throwIfAborted } from "./abort";
import {
    requireCommittedPluginStorageMutation,
    type PluginStorageMutationResult,
} from "./pluginStorageMutation";
import type {
    PluginStorageManifestTransport,
    PluginStorageTransitionTransport,
} from "./nodeStorage";

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
    const json = stringifyJsonValue(value);
    await ensureStorageReady(signal);
    const bytes = encoder.encode(json);
    if (signal) await forageStorage.setItem(storageKey, bytes, undefined, signal);
    else await forageStorage.setItem(storageKey, bytes);
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
        ? encoder.encode(stringifyJsonValue(valueOrSignal as T))
        : undefined;
    await ensureStorageReady(activeSignal);
    const request = {
        operation,
        valueKey: valueStorageKey,
        valueBytes,
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
    const valueBytes = encoder.encode(stringifyJsonValue(value));
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

export async function listPersistentKeys(
    prefix = "",
    signal?: AbortSignal | null,
): Promise<string[]> {
    await ensureStorageReady(signal);
    return signal
        ? await forageStorage.keys(prefix, signal)
        : await forageStorage.keys(prefix);
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
    writes: { storageKey: string; value: unknown }[];
    deletes: string[];
}

export async function commitPersistentPluginStorageMutation(
    mutation: PersistentPluginStorageMutation,
    signal?: AbortSignal | null,
): Promise<void> {
    throwIfAborted(signal);
    const writes = mutation.writes.map(({ storageKey, value }) => ({
        storageKey,
        valueJson: stringifyJsonValue(value),
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
