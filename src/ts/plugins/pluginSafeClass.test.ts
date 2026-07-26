import { beforeEach, describe, expect, test, vi } from "vitest";

const kv = vi.hoisted(() => ({
    readPersistentJson: vi.fn(async () => null as unknown),
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
    clearPersistentPrefix: vi.fn(async () => undefined),
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
});
