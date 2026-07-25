import { beforeEach, describe, expect, test, vi } from "vitest";

let database: any;

vi.mock("../storage/database.svelte", () => ({
    getDatabase: () => database,
}));

vi.mock("../storage/persistentKv", () => {
    const encode = (value: string) => Buffer.from(value, "utf-8").toString("base64url");
    const decode = (value: string) => Buffer.from(value, "base64url").toString("utf-8");
    return {
        clearPersistentPrefix: vi.fn(),
        decodeStorageKeyComponent: decode,
        listPersistentKeys: vi.fn(),
        makeEncodedStorageKey: (prefix: string, key: string) => `${prefix}${encode(key)}.json`,
        readPersistentJson: vi.fn(),
        removePersistentKey: vi.fn(),
        writePersistentJson: vi.fn(),
    };
});

const {
    getPluginSaveStorageItem,
    PLUGIN_SAVE_META_PREFIX,
    PLUGIN_SAVE_PREFIX,
    readExternalizedPluginStorage,
    reconcilePluginStorageMode,
} = await import("./pluginSaveStorage");

function encoded(prefix: string, key: string) {
    return `${prefix}${Buffer.from(key, "utf-8").toString("base64url")}.json`;
}

beforeEach(() => {
    vi.clearAllMocks();
    database = {
        optimizePluginMemory: false,
        pluginCustomStorage: {},
    };
});

describe("readExternalizedPluginStorage", () => {
    test("reads and decodes values and metadata with their respective cache modes", async () => {
        const valueKey = encoded(PLUGIN_SAVE_PREFIX, "plain key");
        const unicodeValueKey = encoded(PLUGIN_SAVE_PREFIX, "키🔑");
        const metaKey = encoded(PLUGIN_SAVE_META_PREFIX, "키🔑");
        const persistent = new Map<string, unknown>([
            [valueKey, { value: 1 }],
            [unicodeValueKey, ["external"]],
            [metaKey, { plugin: "Test", updatedAt: 7 }],
        ]);
        const { listPersistentKeys, readPersistentJson } = await import("../storage/persistentKv");
        vi.mocked(listPersistentKeys).mockImplementation(async (prefix: string) =>
            [...persistent.keys()].filter((key) => key.startsWith(prefix))
        );
        vi.mocked(readPersistentJson).mockImplementation(async (key: string) => persistent.get(key));

        await expect(readExternalizedPluginStorage()).resolves.toEqual({
            values: {
                "plain key": { value: 1 },
                "키🔑": ["external"],
            },
            meta: {
                "키🔑": { plugin: "Test", updatedAt: 7 },
            },
        });
        expect(listPersistentKeys).toHaveBeenCalledWith(PLUGIN_SAVE_PREFIX);
        expect(listPersistentKeys).toHaveBeenCalledWith(PLUGIN_SAVE_META_PREFIX);
        expect(readPersistentJson).toHaveBeenCalledWith(valueKey, { cached: true });
        expect(readPersistentJson).toHaveBeenCalledWith(unicodeValueKey, { cached: true });
        expect(readPersistentJson).toHaveBeenCalledWith(metaKey);
    });

    test("skips listed keys with the wrong prefix or without a json suffix", async () => {
        const validValueKey = encoded(PLUGIN_SAVE_PREFIX, "valid");
        const validMetaKey = encoded(PLUGIN_SAVE_META_PREFIX, "valid");
        const { listPersistentKeys, readPersistentJson } = await import("../storage/persistentKv");
        vi.mocked(listPersistentKeys).mockImplementation(async (prefix: string) => {
            if (prefix === PLUGIN_SAVE_PREFIX) {
                return [
                    validValueKey,
                    encoded("wrong-prefix/", "wrong"),
                    validValueKey.slice(0, -".json".length),
                ];
            }
            return [
                validMetaKey,
                encoded("wrong-meta-prefix/", "wrong"),
                validMetaKey.slice(0, -".json".length),
            ];
        });
        vi.mocked(readPersistentJson).mockImplementation(async (key: string) =>
            key === validValueKey ? 42 : { plugin: "Test", updatedAt: 9 }
        );

        await expect(readExternalizedPluginStorage()).resolves.toEqual({
            values: { valid: 42 },
            meta: { valid: { plugin: "Test", updatedAt: 9 } },
        });
        expect(readPersistentJson).toHaveBeenCalledTimes(2);
        expect(readPersistentJson).toHaveBeenCalledWith(validValueKey, { cached: true });
        expect(readPersistentJson).toHaveBeenCalledWith(validMetaKey);
    });
});

describe("plugin save storage transport", () => {
    test("opts only externalized plugin values into cached persistent reads", async () => {
        database.optimizePluginMemory = true;
        const { readPersistentJson } = await import("../storage/persistentKv");
        vi.mocked(readPersistentJson).mockResolvedValueOnce({ value: 1 });

        await expect(getPluginSaveStorageItem("alpha")).resolves.toEqual({ value: 1 });
        expect(readPersistentJson).toHaveBeenCalledWith(
            encoded(PLUGIN_SAVE_PREFIX, "alpha"),
            { cached: true },
        );
    });
});

describe("reconcilePluginStorageMode", () => {
    test("externalizes write-before-delete, saves afterward, and is idempotent", async () => {
        database = {
            optimizePluginMemory: true,
            pluginCustomStorage: { alpha: { value: 1 } },
            pluginStorageMeta: { alpha: { plugin: "Test", updatedAt: 1 } },
        };
        const persistent = new Map<string, unknown>();
        const operations: string[] = [];
        const persistDatabase = vi.fn(async () => {
            operations.push("persist");
            expect(database.pluginCustomStorage).toEqual({});
            expect(database.pluginStorageMeta).toBeUndefined();
            expect(persistent.get(encoded(PLUGIN_SAVE_PREFIX, "alpha"))).toEqual({ value: 1 });
            expect(persistent.get(encoded(PLUGIN_SAVE_META_PREFIX, "alpha"))).toEqual({
                plugin: "Test",
                updatedAt: 1,
            });
        });
        const dependencies = {
            writePersistentJson: vi.fn(async (key: string, value: unknown) => {
                operations.push(`write:${key}`);
                // The inline copy must still exist until its KV write succeeds.
                expect(database.pluginCustomStorage.alpha ?? database.pluginStorageMeta?.alpha).toBeTruthy();
                persistent.set(key, value);
            }),
            persistDatabase,
        };

        await expect(reconcilePluginStorageMode({ dependencies })).resolves.toEqual({
            direction: "externalize",
            values: 1,
            meta: 1,
        });
        expect(operations.at(-1)).toBe("persist");

        await expect(reconcilePluginStorageMode({ dependencies })).resolves.toEqual({
            direction: "none",
            values: 0,
            meta: 0,
        });
        expect(persistDatabase).toHaveBeenCalledTimes(1);
    });

    test("a failed external write never deletes the key that lacks a KV copy", async () => {
        database = {
            optimizePluginMemory: true,
            pluginCustomStorage: { first: 1, second: 2 },
        };
        const persistent = new Map<string, unknown>();
        const writePersistentJson = vi.fn(async (key: string, value: unknown) => {
            if (key === encoded(PLUGIN_SAVE_PREFIX, "second")) {
                throw new Error("simulated crash");
            }
            persistent.set(key, value);
        });

        await expect(reconcilePluginStorageMode({
            dependencies: {
                writePersistentJson,
                persistDatabase: vi.fn(),
            },
        })).rejects.toThrow("simulated crash");

        expect(persistent.get(encoded(PLUGIN_SAVE_PREFIX, "first"))).toBe(1);
        expect(database.pluginCustomStorage.first).toBeUndefined();
        expect(database.pluginCustomStorage.second).toBe(2);
    });

    test("internalizes and saves before deleting external keys", async () => {
        const valueKey = encoded(PLUGIN_SAVE_PREFIX, "alpha");
        const metaKey = encoded(PLUGIN_SAVE_META_PREFIX, "alpha");
        const persistent = new Map<string, unknown>([
            [valueKey, { value: 1 }],
            [metaKey, { plugin: "Test", updatedAt: 1 }],
        ]);
        const operations: string[] = [];
        const readCalls: Array<[string, { cached?: boolean } | undefined]> = [];
        async function readPersistentJson<T>(
            key: string,
            options?: { cached?: boolean },
        ): Promise<T> {
            readCalls.push([key, options]);
            return persistent.get(key) as T;
        }
        const dependencies = {
            listPersistentKeys: vi.fn(async (prefix: string) =>
                [...persistent.keys()].filter((key) => key.startsWith(prefix))
            ),
            readPersistentJson,
            removePersistentKey: vi.fn(async (key: string) => {
                operations.push(`remove:${key}`);
                persistent.delete(key);
            }),
            persistDatabase: vi.fn(async () => {
                operations.push("persist");
                expect(database.pluginCustomStorage.alpha).toEqual({ value: 1 });
                expect(database.pluginStorageMeta.alpha.plugin).toBe("Test");
                expect(persistent.has(valueKey)).toBe(true);
                expect(persistent.has(metaKey)).toBe(true);
            }),
        };

        await expect(reconcilePluginStorageMode({ dependencies })).resolves.toEqual({
            direction: "internalize",
            values: 1,
            meta: 1,
        });
        expect(operations[0]).toBe("persist");
        expect(persistent.size).toBe(0);
        expect(readCalls).toContainEqual([valueKey, { cached: true }]);
        expect(readCalls).toContainEqual([metaKey, undefined]);

        await expect(reconcilePluginStorageMode({ dependencies })).resolves.toEqual({
            direction: "none",
            values: 0,
            meta: 0,
        });
    });

    test("a failed internalizing save leaves every external key intact", async () => {
        const valueKey = encoded(PLUGIN_SAVE_PREFIX, "alpha");
        const persistent = new Map<string, unknown>([[valueKey, 42]]);
        const removePersistentKey = vi.fn();

        await expect(reconcilePluginStorageMode({
            dependencies: {
                listPersistentKeys: vi.fn(async (prefix: string) =>
                    [...persistent.keys()].filter((key) => key.startsWith(prefix))
                ),
                readPersistentJson: async function <T>(key: string): Promise<T> {
                    return persistent.get(key) as T;
                },
                removePersistentKey,
                persistDatabase: vi.fn(async () => {
                    expect(database.pluginCustomStorage.alpha).toBe(42);
                    throw new Error("save failed");
                }),
            },
        })).rejects.toThrow("save failed");

        expect(persistent.get(valueKey)).toBe(42);
        expect(removePersistentKey).not.toHaveBeenCalled();
    });
});
