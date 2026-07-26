import { hasher } from "../parser/parser.svelte";
import { forageStorage } from "../globalApi.svelte";
import { stringifyJsonValue } from "./jsonValue";
import { assertWellFormedUnicode } from "./unicodeWellFormed";
import { awaitWithAbort, throwIfAborted } from "./abort";

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
}

export async function readPersistentJson<T>(
    storageKey: string,
    options: PersistentJsonReadOptions = {},
): Promise<T | null> {
    await ensureStorageReady(options.signal);
    const data = options.cached
        ? options.signal
            ? await forageStorage.getItemCached(storageKey, options.signal)
            : await forageStorage.getItemCached(storageKey)
        : options.signal
            ? await forageStorage.getItem(storageKey, options.signal)
            : await forageStorage.getItem(storageKey);
    if (!data) {
        return null;
    }
    return JSON.parse(decoder.decode(data)) as T;
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
