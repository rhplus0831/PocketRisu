import { beforeEach, describe, expect, test, vi } from "vitest";

let database: any;
const persistent = vi.hoisted(() => new Map<string, unknown>());
const requestImmediateSave = vi.hoisted(() => vi.fn());

vi.mock("../storage/database.svelte", () => ({
    getDatabase: () => database,
}));

vi.mock("../globalApi.svelte", () => ({
    requestImmediateSave,
}));

vi.mock("../storage/persistentKv", () => {
    const encode = (value: string) => {
        if (!value.isWellFormed()) {
            throw new Error(
                `Plugin storage keys must be well-formed Unicode (no unpaired surrogates): ${JSON.stringify(value)}`,
            );
        }
        return Buffer.from(value, "utf-8").toString("base64url");
    };
    const decode = (value: string) => Buffer.from(value, "base64url").toString("utf-8");
    return {
        clearPersistentPrefix: vi.fn(async (prefix: string) => {
            for (const key of persistent.keys()) {
                if (key.startsWith(prefix)) persistent.delete(key);
            }
        }),
        decodeStorageKeyComponent: decode,
        listPersistentKeys: vi.fn(async (prefix: string) =>
            [...persistent.keys()].filter((key) => key.startsWith(prefix))
        ),
        makeEncodedStorageKey: vi.fn(
            (prefix: string, key: string) => `${prefix}${encode(key)}.json`,
        ),
        readPersistentJson: vi.fn(async (key: string) => persistent.get(key) ?? null),
        removePersistentKey: vi.fn(async (key: string) => {
            persistent.delete(key);
        }),
        writePersistentJson: vi.fn(async (key: string, value: unknown) => {
            persistent.set(key, value);
        }),
    };
});

const {
    getPluginSaveStorageItem,
    getPluginSaveStorageKeys,
    PLUGIN_SAVE_META_PREFIX,
    PLUGIN_SAVE_PREFIX,
    readExternalizedPluginStorage,
    reconcilePluginStorageMode,
    removePluginSaveStorageItem,
    setPluginSaveStorageItem,
} = await import("./pluginSaveStorage");

function encoded(prefix: string, key: string) {
    return `${prefix}${Buffer.from(key, "utf-8").toString("base64url")}.json`;
}

beforeEach(async () => {
    vi.clearAllMocks();
    persistent.clear();
    requestImmediateSave.mockResolvedValue({ status: "committed" });
    database = {
        optimizePluginMemory: false,
        pluginCustomStorage: {},
    };
    const {
        listPersistentKeys,
        makeEncodedStorageKey,
        readPersistentJson,
        removePersistentKey,
        writePersistentJson,
    } = vi.mocked(await import("../storage/persistentKv"));
    listPersistentKeys.mockImplementation(async (prefix: string) =>
        [...persistent.keys()].filter((key) => key.startsWith(prefix))
    );
    makeEncodedStorageKey.mockImplementation((prefix: string, key: string) => {
        if (!key.isWellFormed()) {
            throw new Error(
                `Plugin storage keys must be well-formed Unicode (no unpaired surrogates): ${JSON.stringify(key)}`,
            );
        }
        return encoded(prefix, key);
    });
    readPersistentJson.mockImplementation(async (key: string) => persistent.get(key) ?? null);
    removePersistentKey.mockImplementation(async (key: string) => {
        persistent.delete(key);
    });
    writePersistentJson.mockImplementation(async (key: string, value: unknown) => {
        persistent.set(key, value);
    });
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

    test("optimized reads and writes reject lone-surrogate keys without touching KV", async () => {
        database.optimizePluginMemory = true;
        const { readPersistentJson, writePersistentJson } = await import("../storage/persistentKv");

        await expect(setPluginSaveStorageItem("\uD800", { value: 1 }))
            .rejects.toThrow("well-formed Unicode");
        await expect(getPluginSaveStorageItem("\uD800"))
            .rejects.toThrow("well-formed Unicode");

        expect(persistent.size).toBe(0);
        expect(writePersistentJson).not.toHaveBeenCalled();
        expect(readPersistentJson).not.toHaveBeenCalled();
    });

    test("inline reads return a structured-cloneable copy, not the reactive proxy", async () => {
        // db values live in Svelte $state, whose proxies make postMessage /
        // structuredClone throw DataCloneError when crossing the V3 iframe
        // bridge. A bare Proxy reproduces that rejection.
        const stored = new Proxy({ nested: { value: 1 } }, {});
        expect(() => structuredClone(stored)).toThrow();
        database.pluginCustomStorage.alpha = stored;

        const read = await getPluginSaveStorageItem("alpha");
        expect(read).toEqual({ nested: { value: 1 } });
        expect(() => structuredClone(read)).not.toThrow();
        expect(read).not.toBe(stored);
    });

    test("a literal replacement-character key round-trips through optimized storage", async () => {
        database.optimizePluginMemory = true;
        const value = { exact: "replacement-character" };

        await setPluginSaveStorageItem("�", value);
        await expect(getPluginSaveStorageItem("�")).resolves.toEqual(value);
        await expect(getPluginSaveStorageKeys()).resolves.toEqual(["�"]);
        await removePluginSaveStorageItem("�");

        expect(persistent.has(encoded(PLUGIN_SAVE_PREFIX, "�"))).toBe(false);
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

    test("rejects colliding lone-surrogate value keys before any mutation", async () => {
        database = {
            optimizePluginMemory: true,
            pluginCustomStorage: {
                ["\uD800"]: "high-surrogate-0",
                ["\uD801"]: "high-surrogate-1",
                "�": "replacement-character",
            },
        };
        const writePersistentJson = vi.fn();
        const persistDatabase = vi.fn();

        await expect(reconcilePluginStorageMode({
            dependencies: { writePersistentJson, persistDatabase },
        })).rejects.toThrow("well-formed Unicode");

        expect(database.pluginCustomStorage).toEqual({
            ["\uD800"]: "high-surrogate-0",
            ["\uD801"]: "high-surrogate-1",
            "�": "replacement-character",
        });
        expect(persistent.size).toBe(0);
        expect(writePersistentJson).not.toHaveBeenCalled();
        expect(persistDatabase).not.toHaveBeenCalled();
    });

    test("rejects an invalid metadata key before writing valid values", async () => {
        database = {
            optimizePluginMemory: true,
            pluginCustomStorage: { safe: { value: 1 } },
            pluginStorageMeta: {
                ["\uD800"]: { plugin: "Test", updatedAt: 1 },
            },
        };
        const writePersistentJson = vi.fn();
        const persistDatabase = vi.fn();

        await expect(reconcilePluginStorageMode({
            dependencies: { writePersistentJson, persistDatabase },
        })).rejects.toThrow("well-formed Unicode");

        expect(database.pluginCustomStorage).toEqual({ safe: { value: 1 } });
        expect(database.pluginStorageMeta).toEqual({
            ["\uD800"]: { plugin: "Test", updatedAt: 1 },
        });
        expect(writePersistentJson).not.toHaveBeenCalled();
        expect(persistDatabase).not.toHaveBeenCalled();
    });

    test("checks every precomputed destination for collisions before mutation", async () => {
        const { makeEncodedStorageKey } = await import("../storage/persistentKv");
        vi.mocked(makeEncodedStorageKey).mockImplementation(
            (prefix: string) => `${prefix}forced-collision.json`,
        );
        database = {
            optimizePluginMemory: true,
            pluginCustomStorage: { first: 1, second: 2 },
        };
        const writePersistentJson = vi.fn();
        const persistDatabase = vi.fn();

        await expect(reconcilePluginStorageMode({
            dependencies: { writePersistentJson, persistDatabase },
        })).rejects.toThrow("Plugin storage key collision");

        expect(database.pluginCustomStorage).toEqual({ first: 1, second: 2 });
        expect(writePersistentJson).not.toHaveBeenCalled();
        expect(persistDatabase).not.toHaveBeenCalled();
    });

    test("well-formed keys externalize and internalize without changing identity", async () => {
        const originalValues = {
            normal: { value: 1 },
            "�": { value: 2 },
            "키🔑": ["unicode"],
        };
        const originalMeta = {
            "�": { plugin: "Replacement", updatedAt: 2 },
            "키🔑": { plugin: "Unicode", updatedAt: 3 },
        };
        database = {
            optimizePluginMemory: true,
            pluginCustomStorage: structuredClone(originalValues),
            pluginStorageMeta: structuredClone(originalMeta),
        };
        const persistDatabase = vi.fn(async () => undefined);
        const dependencies = {
            listPersistentKeys: vi.fn(async (prefix: string) =>
                [...persistent.keys()].filter((key) => key.startsWith(prefix))
            ),
            readPersistentJson: async function <T>(key: string): Promise<T> {
                return persistent.get(key) as T;
            },
            removePersistentKey: vi.fn(async (key: string) => {
                persistent.delete(key);
            }),
            writePersistentJson: vi.fn(async (key: string, value: unknown) => {
                persistent.set(key, value);
            }),
            persistDatabase,
        };

        await expect(reconcilePluginStorageMode({ dependencies })).resolves.toEqual({
            direction: "externalize",
            values: 3,
            meta: 2,
        });
        expect(database.pluginCustomStorage).toEqual({});
        expect(database.pluginStorageMeta).toBeUndefined();

        database.optimizePluginMemory = false;
        await expect(reconcilePluginStorageMode({ dependencies })).resolves.toEqual({
            direction: "internalize",
            values: 3,
            meta: 2,
        });

        expect(database.pluginCustomStorage).toEqual(originalValues);
        expect(database.pluginStorageMeta).toEqual(originalMeta);
        expect(persistent.size).toBe(0);
        expect(persistDatabase).toHaveBeenCalledTimes(2);
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

    test.each([
        { status: "retry" } as const,
        { status: "displaced" } as const,
        { status: "failed", error: new Error("server rejected write") } as const,
    ])("production $status outcome leaves every external key intact", async (outcome) => {
        const valueKey = encoded(PLUGIN_SAVE_PREFIX, "alpha");
        const metaKey = encoded(PLUGIN_SAVE_META_PREFIX, "alpha");
        persistent.set(valueKey, 42);
        persistent.set(metaKey, { plugin: "Test", updatedAt: 1 });
        requestImmediateSave.mockResolvedValueOnce(outcome);
        const { removePersistentKey } = await import("../storage/persistentKv");

        await expect(reconcilePluginStorageMode()).rejects.toThrow("not durably committed");

        expect(requestImmediateSave).toHaveBeenCalledWith({ forceFullWrite: true });
        expect(database.pluginCustomStorage.alpha).toBe(42);
        expect(persistent.get(valueKey)).toBe(42);
        expect(persistent.get(metaKey)).toEqual({ plugin: "Test", updatedAt: 1 });
        expect(removePersistentKey).not.toHaveBeenCalled();
    });

    test("production committed outcome permits external key deletion", async () => {
        const valueKey = encoded(PLUGIN_SAVE_PREFIX, "alpha");
        persistent.set(valueKey, 42);

        await expect(reconcilePluginStorageMode()).resolves.toEqual({
            direction: "internalize",
            values: 1,
            meta: 0,
        });

        expect(requestImmediateSave).toHaveBeenCalledWith({ forceFullWrite: true });
        expect(database.pluginCustomStorage.alpha).toBe(42);
        expect(persistent.has(valueKey)).toBe(false);
    });

    test("internalized data survives a simulated refresh after external rows are deleted", async () => {
        const valueKey = encoded(PLUGIN_SAVE_PREFIX, "alpha");
        const metaKey = encoded(PLUGIN_SAVE_META_PREFIX, "alpha");
        persistent.set(valueKey, { value: 1 });
        persistent.set(metaKey, { plugin: "Test", updatedAt: 1 });
        let persistedDatabase: any = null;
        const dependencies = {
            persistDatabase: vi.fn(async () => {
                persistedDatabase = structuredClone(database);
            }),
        };

        await expect(reconcilePluginStorageMode({ dependencies })).resolves.toEqual({
            direction: "internalize",
            values: 1,
            meta: 1,
        });
        expect(persistent.size).toBe(0);

        database = structuredClone(persistedDatabase);
        await expect(reconcilePluginStorageMode({ dependencies })).resolves.toEqual({
            direction: "none",
            values: 0,
            meta: 0,
        });
        expect(database.pluginCustomStorage.alpha).toEqual({ value: 1 });
        expect(database.pluginStorageMeta.alpha).toEqual({
            plugin: "Test",
            updatedAt: 1,
        });
        expect(dependencies.persistDatabase).toHaveBeenCalledTimes(1);
    });
});
