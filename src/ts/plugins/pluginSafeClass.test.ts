import { beforeEach, describe, expect, test, vi } from "vitest";

const kv = vi.hoisted(() => ({
    clearPersistentPrefix: vi.fn(async (
        _prefix: string,
        _signal?: AbortSignal | null,
    ) => undefined),
    readPersistentJson: vi.fn(async (
        _key: string,
        _options?: { signal?: AbortSignal | null },
    ) => null as unknown),
    writePersistentJson: vi.fn(async (_key: string, _value: unknown) => undefined),
    removePersistentKey: vi.fn(async () => undefined),
}));

const ownership = vi.hoisted(() => ({
    recordOwner: vi.fn(async () => undefined),
    removeOwner: vi.fn(async () => undefined),
    clearOwners: vi.fn(async () => undefined),
}));

vi.mock("../globalApi.svelte", () => ({
    toGetter: (getter: () => unknown) => getter(),
}));

vi.mock("../storage/persistentKv", () => ({
    clearPersistentPrefix: kv.clearPersistentPrefix,
    decodeStorageKeyComponent: (value: string) => value,
    listPersistentKeys: vi.fn(async () => []),
    makeEncodedStorageKey: (prefix: string, key: string) => `${prefix}${key}.json`,
    readPersistentJson: kv.readPersistentJson,
    removePersistentKey: kv.removePersistentKey,
    writePersistentJson: kv.writePersistentJson,
}));

vi.mock("./pluginStorageMeta", () => ownership);

const { SafeLocalPluginStorage } = await import("./pluginSafeClass");

let keySequence = 0;

beforeEach(() => {
    keySequence += 1;
    kv.readPersistentJson.mockReset();
    kv.readPersistentJson.mockResolvedValue(null);
    kv.writePersistentJson.mockReset();
    kv.writePersistentJson.mockResolvedValue(undefined);
    kv.removePersistentKey.mockReset();
    kv.removePersistentKey.mockResolvedValue(undefined);
    kv.clearPersistentPrefix.mockReset();
    kv.clearPersistentPrefix.mockResolvedValue(undefined);
    ownership.recordOwner.mockClear();
    ownership.removeOwner.mockClear();
    ownership.clearOwners.mockClear();
});

describe("SafeLocalPluginStorage write acknowledgement", () => {
    test("invalid JSON rejects without populating or replacing the cache", async () => {
        const storage = new SafeLocalPluginStorage();
        const existingKey = `invalid-existing-${keySequence}`;
        const missingKey = `invalid-missing-${keySequence}`;
        await storage.setItem(existingKey, { state: "previous" });
        kv.writePersistentJson.mockClear();
        kv.readPersistentJson.mockClear();

        await expect(storage.setItem(existingKey, { nested: undefined }))
            .rejects.toThrow(TypeError);
        await expect(storage.setItem(missingKey, new Map([["lost", true]])))
            .rejects.toThrow(TypeError);

        expect(kv.writePersistentJson).not.toHaveBeenCalled();
        await expect(storage.getItem(existingKey)).resolves.toEqual({ state: "previous" });
        await expect(storage.getItem(missingKey)).resolves.toBeNull();
        expect(kv.readPersistentJson).toHaveBeenCalledOnce();
    });

    test("snapshots before the first await and publishes only after persistence", async () => {
        const storage = new SafeLocalPluginStorage();
        const key = `detached-${keySequence}`;
        const callerOwned = { nested: { state: "captured" } };
        let storedValue: unknown;
        let releaseWrite!: () => void;
        let markWriteStarted!: () => void;
        const writeBlocked = new Promise<void>((resolve) => {
            releaseWrite = resolve;
        });
        const writeStarted = new Promise<void>((resolve) => {
            markWriteStarted = resolve;
        });
        kv.writePersistentJson.mockImplementationOnce(async (_storageKey, value) => {
            storedValue = value;
            markWriteStarted();
            await writeBlocked;
        });

        const writing = storage.setItem(key, callerOwned);
        callerOwned.nested.state = "mutated-after-call";
        await writeStarted;

        await expect(storage.getItem(key)).resolves.toBeNull();
        releaseWrite();
        await writing;

        expect(storedValue).toEqual({ nested: { state: "captured" } });
        expect(storedValue).not.toBe(callerOwned);
        await expect(storage.getItem(key)).resolves.toEqual({
            nested: { state: "captured" },
        });
    });

    test("a failed write preserves the previous cached value", async () => {
        const storage = new SafeLocalPluginStorage();
        const key = `write-failure-${keySequence}`;
        await storage.setItem(key, { state: "previous" });
        kv.readPersistentJson.mockClear();
        kv.writePersistentJson.mockRejectedValueOnce(new Error("durable write failed"));

        await expect(storage.setItem(key, { state: "uncommitted" }))
            .rejects.toThrow("durable write failed");

        await expect(storage.getItem(key)).resolves.toEqual({ state: "previous" });
        expect(kv.readPersistentJson).not.toHaveBeenCalled();
    });

    test.each([
        ["import refusal", "IMPORT_IN_PROGRESS", 503],
        ["session refusal", "AUTH_REQUIRED", 401],
    ])("a known-not-committed %s keeps the prior cache", async (_label, code, status) => {
        const storage = new SafeLocalPluginStorage();
        const key = `known-write-${code}-${keySequence}`;
        await storage.setItem(key, { state: "previous" });
        kv.readPersistentJson.mockClear();
        kv.writePersistentJson.mockRejectedValueOnce(Object.assign(
            new Error("write refused"),
            { code, status, commitOutcomeUnknown: false },
        ));

        await expect(storage.setItem(key, { state: "not-written" }))
            .rejects.toThrow("write refused");
        await expect(storage.getItem(key)).resolves.toEqual({ state: "previous" });
        expect(kv.readPersistentJson).not.toHaveBeenCalled();
    });

    test.each([
        ["import refusal", "IMPORT_IN_PROGRESS", 503],
        ["session refusal", "AUTH_REQUIRED", 401],
    ])("a known-not-committed %s keeps the row cached", async (_label, code, status) => {
        const storage = new SafeLocalPluginStorage();
        const key = `known-remove-${code}-${keySequence}`;
        await storage.setItem(key, { state: "still-authoritative" });
        kv.readPersistentJson.mockClear();
        kv.removePersistentKey.mockRejectedValueOnce(Object.assign(
            new Error("remove refused"),
            { code, status, commitOutcomeUnknown: false },
        ));

        await expect(storage.removeItem(key)).rejects.toThrow("remove refused");
        await expect(storage.getItem(key)).resolves.toEqual({ state: "still-authoritative" });
        expect(kv.readPersistentJson).not.toHaveBeenCalled();
    });

    test("returns detached snapshots on cache misses and hits", async () => {
        const storage = new SafeLocalPluginStorage();
        const key = `read-detached-${keySequence}`;
        const persistentValue = { nested: { state: "durable" } };
        kv.readPersistentJson.mockResolvedValueOnce(persistentValue);

        const first = await storage.getItem<typeof persistentValue>(key);
        expect(first).toEqual({ nested: { state: "durable" } });
        expect(first).not.toBe(persistentValue);
        persistentValue.nested.state = "mutated-source";
        first!.nested.state = "mutated-result";

        const second = await storage.getItem<typeof persistentValue>(key);
        expect(second).toEqual({ nested: { state: "durable" } });
        expect(second).not.toBe(first);
        expect(kv.readPersistentJson).toHaveBeenCalledOnce();
    });

    test("a caller cannot mutate a value already published in the cache", async () => {
        const storage = new SafeLocalPluginStorage();
        const key = `cache-egress-${keySequence}`;
        await storage.setItem(key, { nested: { state: "durable" } });

        const first = await storage.getItem<{ nested: { state: string } }>(key);
        first!.nested.state = "caller-only";

        await expect(storage.getItem(key)).resolves.toEqual({
            nested: { state: "durable" },
        });
    });

    test("an unknown write outcome evicts the affected cached value", async () => {
        const storage = new SafeLocalPluginStorage();
        const key = `unknown-write-${keySequence}`;
        await storage.setItem(key, { state: "cached-before" });
        kv.writePersistentJson.mockRejectedValueOnce(Object.assign(
            new Error("write acknowledgement lost"),
            { commitOutcomeUnknown: true, code: "COMMIT_OUTCOME_UNKNOWN" },
        ));
        kv.readPersistentJson.mockResolvedValueOnce({ state: "authoritative-after" });

        await expect(storage.setItem(key, { state: "attempted" }))
            .rejects.toThrow("write acknowledgement lost");
        await expect(storage.getItem(key)).resolves.toEqual({ state: "authoritative-after" });
        expect(kv.readPersistentJson).toHaveBeenCalledOnce();
    });

    test("an unknown remove outcome evicts the affected cached value", async () => {
        const storage = new SafeLocalPluginStorage();
        const key = `unknown-remove-${keySequence}`;
        await storage.setItem(key, { state: "cached-before" });
        kv.removePersistentKey.mockRejectedValueOnce(Object.assign(
            new Error("remove acknowledgement lost"),
            { commitOutcomeUnknown: true, code: "COMMIT_OUTCOME_UNKNOWN" },
        ));
        kv.readPersistentJson.mockResolvedValueOnce({ state: "authoritative-after" });

        await expect(storage.removeItem(key)).rejects.toThrow("remove acknowledgement lost");
        await expect(storage.getItem(key)).resolves.toEqual({ state: "authoritative-after" });
        expect(kv.readPersistentJson).toHaveBeenCalledOnce();
    });

    test("a partially attempted clear evicts every cached value", async () => {
        const storage = new SafeLocalPluginStorage();
        const firstKey = `partial-clear-a-${keySequence}`;
        const secondKey = `partial-clear-b-${keySequence}`;
        await storage.setItem(firstKey, { cached: "a" });
        await storage.setItem(secondKey, { cached: "b" });
        kv.clearPersistentPrefix.mockRejectedValueOnce(new Error("second delete failed"));
        kv.readPersistentJson.mockImplementation(async (storageKey) => ({
            authoritative: storageKey.includes(firstKey) ? "a" : "b",
        }));

        await expect(storage.clear()).rejects.toThrow("second delete failed");
        await expect(storage.getItem(firstKey)).resolves.toEqual({ authoritative: "a" });
        await expect(storage.getItem(secondKey)).resolves.toEqual({ authoritative: "b" });
        expect(kv.readPersistentJson).toHaveBeenCalledTimes(2);
    });

    test("forwards one request signal through every owner sidecar mutation", async () => {
        const storage = new SafeLocalPluginStorage("Owner");
        const key = `owner-signal-${keySequence}`;
        const controller = new AbortController();

        await storage.setItem(key, { durable: true }, controller.signal);
        await storage.removeItem(key, controller.signal);
        await storage.clear(controller.signal);

        expect(ownership.recordOwner).toHaveBeenCalledWith(
            "idb",
            key,
            "Owner",
            controller.signal,
        );
        expect(ownership.removeOwner).toHaveBeenCalledWith("idb", key, controller.signal);
        expect(ownership.clearOwners).toHaveBeenCalledWith("idb", controller.signal);
    });
});
