import { beforeEach, describe, expect, test, vi } from "vitest";

let database: any;
const persistent = vi.hoisted(() => new Map<string, unknown>());
const requestImmediateSave = vi.hoisted(() => vi.fn());

vi.mock("../storage/database.svelte", () => ({
    getDatabase: () => database,
    getCurrentCharacter: () => null,
    setDatabase: (value: unknown) => {
        database = value;
    },
    setDatabaseLite: (value: unknown) => {
        database = value;
    },
}));

vi.mock("../globalApi.svelte", () => ({
    fetchNative: vi.fn(),
    globalFetch: vi.fn(),
    readImage: vi.fn(),
    requestImmediateSave,
    saveAsset: vi.fn(),
    toGetter: (getter: () => unknown) => getter,
}));

vi.mock("../stores.svelte", () => {
    const DBState = {} as { db: unknown };
    Object.defineProperty(DBState, "db", {
        get: () => database,
        set: (value) => {
            database = value;
        },
    });
    return {
        DBState,
        hotReloading: [],
        pluginAlertModalStore: { errors: [], open: false },
        selectedCharID: { subscribe: (run: (value: number) => void) => {
            run(0);
            return () => undefined;
        } },
    };
});

vi.mock("../alert", () => ({
    alertConfirm: vi.fn(async () => false),
    alertError: vi.fn(),
    alertPluginConfirm: vi.fn(async () => false),
    notifyWarning: vi.fn(),
}));

vi.mock("../util", () => ({
    selectSingleFile: vi.fn(),
    sleep: vi.fn(async () => undefined),
}));

vi.mock("./pluginSafety", () => ({
    checkCodeSafety: vi.fn(async (code: string) => ({
        errors: [],
        isSafe: true,
        modifiedCode: code,
    })),
}));

vi.mock("./pluginSafeClass", () => ({
    SafeDocument: {},
    SafeIdbFactory: class {},
    SafeLocalStorage: class {},
}));

vi.mock("./apiV3/v3.svelte", () => ({
    loadV3Plugins: vi.fn(async () => undefined),
}));

vi.mock("./apiV3/transpiler", () => ({
    pluginCodeTranspiler: vi.fn(async (code: string) => code),
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
    countExternalizedPluginStorageEntries,
    getPluginSaveStorageItem,
    getPluginSaveStorageKeys,
    PLUGIN_SAVE_META_PREFIX,
    PLUGIN_SAVE_PREFIX,
    readExternalizedPluginStorage,
    reconcilePluginStorageMode,
    removePluginSaveStorageItem,
    setPluginSaveStorageItem,
    transitionPluginStorageMode,
} = await import("./pluginSaveStorage");
const {
    beginPluginStorageModeTransition,
    canEnablePlugin,
    isPluginStorageModeTransitioning,
} = await import("./pluginMemoryOptimization");
const {
    getV2PluginAPIs,
    loadV2Plugin,
    pluginV2,
} = await import("./plugins.svelte");
const {
    createPluginStorageRecord,
    definePluginStorageRecordValue,
} = await import("./pluginStorageRecord");

const SPECIAL_PLUGIN_STORAGE_KEYS = [
    "__proto__",
    "constructor",
    "prototype",
    "toString",
    "hasOwnProperty",
    "",
] as const;

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
        plugins: [],
    };
    pluginV2.loaded = false;
    pluginV2.providers.clear();
    pluginV2.editdisplay.clear();
    pluginV2.editoutput.clear();
    pluginV2.editprocess.clear();
    pluginV2.editinput.clear();
    pluginV2.unload.clear();
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

    test("preserves special property names in value and metadata records", async () => {
        for (const [index, key] of SPECIAL_PLUGIN_STORAGE_KEYS.entries()) {
            persistent.set(encoded(PLUGIN_SAVE_PREFIX, key), { index });
            persistent.set(encoded(PLUGIN_SAVE_META_PREFIX, key), {
                plugin: `Plugin ${index}`,
                updatedAt: index,
            });
        }

        const external = await readExternalizedPluginStorage();

        expect(Object.getPrototypeOf(external.values)).toBeNull();
        expect(Object.getPrototypeOf(external.meta)).toBeNull();
        expect(Object.keys(external.values)).toEqual(SPECIAL_PLUGIN_STORAGE_KEYS);
        expect(Object.keys(external.meta)).toEqual(SPECIAL_PLUGIN_STORAGE_KEYS);
        for (const [index, key] of SPECIAL_PLUGIN_STORAGE_KEYS.entries()) {
            expect(Object.hasOwn(external.values, key)).toBe(true);
            expect(external.values[key]).toEqual({ index });
            expect(Object.hasOwn(external.meta, key)).toBe(true);
            expect(external.meta[key]).toEqual({
                plugin: `Plugin ${index}`,
                updatedAt: index,
            });
        }
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

    test("inline set/get/list/remove treats special names as exact own keys", async () => {
        // Start from an ordinary legacy object to cover inherited-name misses.
        database.pluginCustomStorage = {};
        for (const key of SPECIAL_PLUGIN_STORAGE_KEYS) {
            await expect(getPluginSaveStorageItem(key)).resolves.toBeNull();
        }

        for (const [index, key] of SPECIAL_PLUGIN_STORAGE_KEYS.entries()) {
            await setPluginSaveStorageItem(key, { index });
        }

        expect(Object.getPrototypeOf(database.pluginCustomStorage)).toBe(Object.prototype);
        await expect(getPluginSaveStorageKeys()).resolves.toEqual(SPECIAL_PLUGIN_STORAGE_KEYS);
        for (const [index, key] of SPECIAL_PLUGIN_STORAGE_KEYS.entries()) {
            await expect(getPluginSaveStorageItem(key)).resolves.toEqual({ index });
            expect(Object.hasOwn(database.pluginCustomStorage, key)).toBe(true);
        }

        for (const key of SPECIAL_PLUGIN_STORAGE_KEYS) {
            await removePluginSaveStorageItem(key);
            await expect(getPluginSaveStorageItem(key)).resolves.toBeNull();
        }
        await expect(getPluginSaveStorageKeys()).resolves.toEqual([]);
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

describe("transitionPluginStorageMode", () => {
    test("round-trips special value and metadata keys through both mode transitions", async () => {
        const values = createPluginStorageRecord<unknown>();
        const meta = createPluginStorageRecord<any>();
        for (const [index, key] of SPECIAL_PLUGIN_STORAGE_KEYS.entries()) {
            definePluginStorageRecordValue(values, key, { index });
            definePluginStorageRecordValue(meta, key, {
                plugin: `Plugin ${index}`,
                updatedAt: index,
            });
        }
        database.pluginCustomStorage = values;
        database.pluginStorageMeta = meta;
        const persistDatabase = vi.fn(async () => undefined);

        await expect(transitionPluginStorageMode(true, {
            dependencies: { persistDatabase },
        })).resolves.toEqual({
            direction: "externalize",
            values: SPECIAL_PLUGIN_STORAGE_KEYS.length,
            meta: SPECIAL_PLUGIN_STORAGE_KEYS.length,
        });

        expect(database.optimizePluginMemory).toBe(true);
        expect(Object.keys(database.pluginCustomStorage)).toEqual([]);
        expect(database.pluginStorageMeta).toBeUndefined();
        await expect(getPluginSaveStorageKeys()).resolves.toEqual(SPECIAL_PLUGIN_STORAGE_KEYS);
        for (const [index, key] of SPECIAL_PLUGIN_STORAGE_KEYS.entries()) {
            await expect(getPluginSaveStorageItem(key)).resolves.toEqual({ index });
            expect(persistent.get(encoded(PLUGIN_SAVE_META_PREFIX, key))).toEqual({
                plugin: `Plugin ${index}`,
                updatedAt: index,
            });
        }

        await expect(transitionPluginStorageMode(false, {
            dependencies: { persistDatabase },
        })).resolves.toEqual({
            direction: "internalize",
            values: SPECIAL_PLUGIN_STORAGE_KEYS.length,
            meta: SPECIAL_PLUGIN_STORAGE_KEYS.length,
        });

        expect(database.optimizePluginMemory).toBe(false);
        expect(Object.getPrototypeOf(database.pluginCustomStorage)).toBe(Object.prototype);
        expect(Object.getPrototypeOf(database.pluginStorageMeta)).toBe(Object.prototype);
        expect(Object.keys(database.pluginCustomStorage)).toEqual(SPECIAL_PLUGIN_STORAGE_KEYS);
        expect(Object.keys(database.pluginStorageMeta)).toEqual(SPECIAL_PLUGIN_STORAGE_KEYS);
        for (const [index, key] of SPECIAL_PLUGIN_STORAGE_KEYS.entries()) {
            await expect(getPluginSaveStorageItem(key)).resolves.toEqual({ index });
            expect(Object.hasOwn(database.pluginCustomStorage, key)).toBe(true);
            expect(database.pluginStorageMeta[key]).toEqual({
                plugin: `Plugin ${index}`,
                updatedAt: index,
            });
        }
        expect(persistent.size).toBe(0);
        expect(persistDatabase).toHaveBeenCalledTimes(2);
    });

    test("drains SETs queued behind a held count before disabling", async () => {
        database.optimizePluginMemory = true;
        const valueKey = encoded(PLUGIN_SAVE_PREFIX, "alpha");
        persistent.set(valueKey, "old");
        const { listPersistentKeys } = await import("../storage/persistentKv");
        let releaseCount!: () => void;
        let markCountStarted!: () => void;
        const countBlocked = new Promise<void>((resolve) => {
            releaseCount = resolve;
        });
        const countStarted = new Promise<void>((resolve) => {
            markCountStarted = resolve;
        });
        vi.mocked(listPersistentKeys)
            .mockImplementationOnce(async (prefix: string) => {
                markCountStarted();
                await countBlocked;
                return [...persistent.keys()].filter((key) => key.startsWith(prefix));
            })
            .mockImplementationOnce(async (prefix: string) => {
                await countBlocked;
                return [...persistent.keys()].filter((key) => key.startsWith(prefix));
            });

        const count = countExternalizedPluginStorageEntries();
        await countStarted;
        const firstSet = setPluginSaveStorageItem("alpha", "newer");
        const secondSet = setPluginSaveStorageItem("alpha", "newest");
        const persistDatabase = vi.fn(async () => {
            expect(database.optimizePluginMemory).toBe(false);
            expect(database.pluginCustomStorage.alpha).toBe("newest");
        });
        const transition = transitionPluginStorageMode(false, {
            dependencies: { persistDatabase },
        });

        // Calling the transition must not flip the live mode while older work
        // is still waiting behind the current queue owner.
        expect(database.optimizePluginMemory).toBe(true);
        releaseCount();
        await expect(count).resolves.toBe(1);
        await Promise.all([firstSet, secondSet, transition]);

        expect(database.optimizePluginMemory).toBe(false);
        expect(database.pluginCustomStorage.alpha).toBe("newest");
        expect(persistent.has(valueKey)).toBe(false);
        expect(persistDatabase).toHaveBeenCalledTimes(1);
    });

    test("drains removes queued behind a held count before disabling", async () => {
        database.optimizePluginMemory = true;
        const valueKey = encoded(PLUGIN_SAVE_PREFIX, "alpha");
        persistent.set(valueKey, "old");
        const { listPersistentKeys } = await import("../storage/persistentKv");
        let releaseCount!: () => void;
        let markCountStarted!: () => void;
        const countBlocked = new Promise<void>((resolve) => {
            releaseCount = resolve;
        });
        const countStarted = new Promise<void>((resolve) => {
            markCountStarted = resolve;
        });
        vi.mocked(listPersistentKeys)
            .mockImplementationOnce(async (prefix: string) => {
                markCountStarted();
                await countBlocked;
                return [...persistent.keys()].filter((key) => key.startsWith(prefix));
            })
            .mockImplementationOnce(async (prefix: string) => {
                await countBlocked;
                return [...persistent.keys()].filter((key) => key.startsWith(prefix));
            });

        const count = countExternalizedPluginStorageEntries();
        await countStarted;
        const firstRemove = removePluginSaveStorageItem("alpha");
        const secondRemove = removePluginSaveStorageItem("alpha");
        const persistDatabase = vi.fn(async () => {
            expect(database.optimizePluginMemory).toBe(false);
            expect(database.pluginCustomStorage.alpha).toBeUndefined();
        });
        const transition = transitionPluginStorageMode(false, {
            dependencies: { persistDatabase },
        });

        expect(database.optimizePluginMemory).toBe(true);
        releaseCount();
        await expect(count).resolves.toBe(1);
        await Promise.all([firstRemove, secondRemove, transition]);

        expect(database.optimizePluginMemory).toBe(false);
        expect(database.pluginCustomStorage.alpha).toBeUndefined();
        expect(persistent.has(valueKey)).toBe(false);
        expect(persistDatabase).toHaveBeenCalledTimes(1);
    });

    test("holds new-mode operations until migration is durably persisted", async () => {
        database.optimizePluginMemory = true;
        const valueKey = encoded(PLUGIN_SAVE_PREFIX, "alpha");
        persistent.set(valueKey, "old");
        let releasePersist!: () => void;
        let markPersistStarted!: () => void;
        const persistBlocked = new Promise<void>((resolve) => {
            releasePersist = resolve;
        });
        const persistStarted = new Promise<void>((resolve) => {
            markPersistStarted = resolve;
        });
        const persistDatabase = vi.fn(async () => {
            markPersistStarted();
            await persistBlocked;
        });

        const transition = transitionPluginStorageMode(false, {
            dependencies: { persistDatabase },
        });
        await persistStarted;
        let setCompleted = false;
        const queuedSet = setPluginSaveStorageItem("alpha", "after-transition")
            .then(() => {
                setCompleted = true;
            });
        await Promise.resolve();

        expect(database.pluginCustomStorage.alpha).toBe("old");
        expect(setCompleted).toBe(false);
        expect(persistent.has(valueKey)).toBe(true);

        releasePersist();
        await transition;
        await queuedSet;

        expect(database.optimizePluginMemory).toBe(false);
        expect(database.pluginCustomStorage.alpha).toBe("after-transition");
        expect(persistent.has(valueKey)).toBe(false);
    });

    test("rolls a failed transition back before releasing queued operations", async () => {
        database.optimizePluginMemory = true;
        const valueKey = encoded(PLUGIN_SAVE_PREFIX, "alpha");
        persistent.set(valueKey, "old");
        const persistDatabase = vi.fn()
            .mockRejectedValueOnce(new Error("transition save failed"))
            .mockResolvedValueOnce(undefined);

        const transition = transitionPluginStorageMode(false, {
            dependencies: { persistDatabase },
        });
        const queuedSet = setPluginSaveStorageItem("alpha", "after-failure");

        await expect(transition).rejects.toThrow("transition save failed");
        await queuedSet;

        expect(database.optimizePluginMemory).toBe(true);
        expect(database.pluginCustomStorage).toEqual({});
        expect(persistent.get(valueKey)).toBe("after-failure");
        expect(persistDatabase).toHaveBeenCalledTimes(2);
    });

    test("blocks legacy activation and synchronous SET during a held disable read", async () => {
        database.optimizePluginMemory = true;
        const valueKey = encoded(PLUGIN_SAVE_PREFIX, "alpha");
        persistent.set(valueKey, "newest-external-value");
        const { readPersistentJson } = await import("../storage/persistentKv");
        let releaseRead!: () => void;
        let markReadStarted!: () => void;
        const readBlocked = new Promise<void>((resolve) => {
            releaseRead = resolve;
        });
        const readStarted = new Promise<void>((resolve) => {
            markReadStarted = resolve;
        });
        vi.mocked(readPersistentJson).mockImplementation(async (key: string) => {
            const value = persistent.get(key);
            if (key === valueKey) {
                markReadStarted();
                await readBlocked;
            }
            return value;
        });

        const transition = transitionPluginStorageMode(false, {
            dependencies: { persistDatabase: vi.fn(async () => undefined) },
        });
        await readStarted;

        let synchronousSetRan = false;
        const legacyPlugin = { version: "2.1" as const };
        const activated = canEnablePlugin(legacyPlugin, database.optimizePluginMemory);
        if (activated) {
            synchronousSetRan = true;
            database.pluginCustomStorage.alpha = "legacy-write";
        }

        expect(database.optimizePluginMemory).toBe(false);
        expect(isPluginStorageModeTransitioning()).toBe(true);
        expect(activated).toBe(false);
        expect(synchronousSetRan).toBe(false);

        releaseRead();
        await transition;

        expect(isPluginStorageModeTransitioning()).toBe(false);
        expect(database.pluginCustomStorage.alpha).toBe("newest-external-value");
        expect(persistent.has(valueKey)).toBe(false);
    });

    test("blocks legacy activation and synchronous remove during a held disable read", async () => {
        database.optimizePluginMemory = true;
        const valueKey = encoded(PLUGIN_SAVE_PREFIX, "alpha");
        persistent.set(valueKey, "value-that-must-not-be-resurrected");
        const { readPersistentJson } = await import("../storage/persistentKv");
        let releaseRead!: () => void;
        let markReadStarted!: () => void;
        const readBlocked = new Promise<void>((resolve) => {
            releaseRead = resolve;
        });
        const readStarted = new Promise<void>((resolve) => {
            markReadStarted = resolve;
        });
        vi.mocked(readPersistentJson).mockImplementation(async (key: string) => {
            const value = persistent.get(key);
            if (key === valueKey) {
                markReadStarted();
                await readBlocked;
            }
            return value;
        });

        const transition = transitionPluginStorageMode(false, {
            dependencies: { persistDatabase: vi.fn(async () => undefined) },
        });
        await readStarted;

        let synchronousRemoveRan = false;
        const legacyPlugin = { version: 2 as const };
        const activated = canEnablePlugin(legacyPlugin, database.optimizePluginMemory);
        if (activated) {
            synchronousRemoveRan = true;
            delete database.pluginCustomStorage.alpha;
        }

        expect(database.optimizePluginMemory).toBe(false);
        expect(isPluginStorageModeTransitioning()).toBe(true);
        expect(activated).toBe(false);
        expect(synchronousRemoveRan).toBe(false);

        releaseRead();
        await transition;

        expect(isPluginStorageModeTransitioning()).toBe(false);
        expect(database.pluginCustomStorage.alpha).toBe("value-that-must-not-be-resurrected");
        expect(persistent.has(valueKey)).toBe(false);
    });

    test("actual retained V2 APIs cannot mutate inline storage during a held disable read", async () => {
        database.pluginCustomStorage = {
            alpha: { nested: "inline-stale" },
            removed: "inline-stale",
        };
        const v2Apis = getV2PluginAPIs();
        const retainedDatabase = v2Apis.getDatabase() as any;
        const retainedStorage = retainedDatabase.pluginCustomStorage as any;
        const retainedNested = retainedStorage.alpha as any;

        database.optimizePluginMemory = true;
        const alphaKey = encoded(PLUGIN_SAVE_PREFIX, "alpha");
        const removedKey = encoded(PLUGIN_SAVE_PREFIX, "removed");
        persistent.set(alphaKey, { nested: "newest-external-value" });
        persistent.set(removedKey, "external-value");
        const { readPersistentJson } = await import("../storage/persistentKv");
        let releaseRead!: () => void;
        let markReadStarted!: () => void;
        const readBlocked = new Promise<void>((resolve) => {
            releaseRead = resolve;
        });
        const readStarted = new Promise<void>((resolve) => {
            markReadStarted = resolve;
        });
        vi.mocked(readPersistentJson).mockImplementation(async (key: string) => {
            const value = persistent.get(key);
            if (key === alphaKey) {
                markReadStarted();
                await readBlocked;
            }
            return value;
        });

        const transition = transitionPluginStorageMode(false, {
            dependencies: { persistDatabase: vi.fn(async () => undefined) },
        });
        await readStarted;

        // Direct compatibility APIs are no-ops while guarded.
        v2Apis.pluginStorage.setItem("alpha", "pluginStorage-write");
        v2Apis.pluginStorage.removeItem("removed");
        v2Apis.setDatabaseLite({ alpha: "setDatabaseLite-write" });
        await v2Apis.setDatabase({ removed: "setDatabase-write" });

        // Proxies and nested handles captured before the transition remain
        // membranes. Every access/mutation route is checked dynamically.
        expect(() => {
            retainedDatabase.alpha = "top-level-proxy-write";
        }).toThrow("unavailable during a storage mode transition");
        expect(() => {
            retainedStorage.alpha = "retained-storage-write";
        }).toThrow("unavailable during a storage mode transition");
        expect(() => {
            retainedNested.nested = "retained-nested-write";
        }).toThrow("unavailable during a storage mode transition");
        expect(() => {
            delete retainedStorage.removed;
        }).toThrow("unavailable during a storage mode transition");
        expect(() => Object.getOwnPropertyDescriptor(retainedStorage, "alpha"))
            .toThrow("unavailable during a storage mode transition");
        expect(() => (v2Apis.getDatabase() as any).pluginCustomStorage)
            .toThrow("unavailable during a storage mode transition");

        expect(database.pluginCustomStorage).toEqual({
            alpha: { nested: "inline-stale" },
            removed: "inline-stale",
        });

        releaseRead();
        await transition;

        expect(database.pluginCustomStorage).toEqual({
            alpha: { nested: "newest-external-value" },
            removed: "external-value",
        });
        expect(persistent.size).toBe(0);
    });

    test("V2 pluginStorage round-trips special keys including an empty key at index zero", () => {
        const v2Apis = getV2PluginAPIs();
        for (const [index, key] of SPECIAL_PLUGIN_STORAGE_KEYS.entries()) {
            v2Apis.pluginStorage.setItem(key, `value-${index}`);
        }

        expect(v2Apis.pluginStorage.keys()).toEqual(SPECIAL_PLUGIN_STORAGE_KEYS);
        expect(v2Apis.pluginStorage.length()).toBe(SPECIAL_PLUGIN_STORAGE_KEYS.length);
        for (const [index, key] of SPECIAL_PLUGIN_STORAGE_KEYS.entries()) {
            expect(v2Apis.pluginStorage.key(index)).toBe(key);
            expect(v2Apis.pluginStorage.getItem(key)).toBe(`value-${index}`);
            expect(Object.hasOwn(database.pluginCustomStorage, key)).toBe(true);
        }

        v2Apis.pluginStorage.clear();
        v2Apis.pluginStorage.setItem("", "empty-first");
        expect(v2Apis.pluginStorage.key(0)).toBe("");
        expect(v2Apis.pluginStorage.getItem("")).toBe("empty-first");
    });

    test("V2.0 rechecks the transition guard immediately before execution", async () => {
        let finishTransition: (() => void) | undefined;
        database.optimizePluginMemory = false;
        Object.defineProperty(database, "allowV2Plugin", {
            configurable: true,
            get: () => {
                finishTransition ??= beginPluginStorageModeTransition();
                return true;
            },
        });
        const executionMarker = "__pocketRisuMt2V2Executed";
        delete (globalThis as any)[executionMarker];

        try {
            await loadV2Plugin([{
                name: "MT2 V2.0 regression",
                script: `globalThis.${executionMarker} = true`,
                arguments: {},
                realArg: {},
                version: 2,
                customLink: [],
                argMeta: {},
                enabled: true,
            }]);

            expect(finishTransition).toBeTypeOf("function");
            expect(isPluginStorageModeTransitioning()).toBe(true);
            expect((globalThis as any)[executionMarker]).toBeUndefined();
        } finally {
            finishTransition?.();
            delete (globalThis as any)[executionMarker];
        }
        expect(isPluginStorageModeTransitioning()).toBe(false);
    });

    test("legacy storage ingress snapshots caller objects before a held enable write", async () => {
        const v2Apis = getV2PluginAPIs();
        const databaseProxy = v2Apis.getDatabase() as any;
        const storageProxy = databaseProxy.pluginCustomStorage as any;
        const callerOwned = { nested: { value: "captured-at-assignment" } };
        const proxyCallerOwned = { nested: { value: "proxy-snapshot" } };
        const liteCallerOwned = { nested: { value: "lite-snapshot" } };
        const asyncCallerOwned = { nested: { value: "async-snapshot" } };

        (v2Apis.pluginStorage.setItem as any)("alpha", callerOwned);
        databaseProxy.beta = proxyCallerOwned;
        v2Apis.setDatabaseLite({ gamma: liteCallerOwned });
        await v2Apis.setDatabase({ delta: asyncCallerOwned });

        expect(database.pluginCustomStorage.alpha).toEqual(callerOwned);
        expect(database.pluginCustomStorage.alpha).not.toBe(callerOwned);
        expect(database.pluginCustomStorage.alpha.nested).not.toBe(callerOwned.nested);
        expect(database.pluginCustomStorage.beta).not.toBe(proxyCallerOwned);
        expect(database.pluginCustomStorage.gamma).not.toBe(liteCallerOwned);
        expect(database.pluginCustomStorage.delta).not.toBe(asyncCallerOwned);

        expect(() => Object.defineProperty(storageProxy, "accessorEscape", {
            configurable: true,
            enumerable: true,
            get: () => callerOwned,
        })).toThrow("does not accept accessor descriptors");
        expect(() => Object.defineProperty(storageProxy, "nonConfigurableEscape", {
            configurable: false,
            enumerable: true,
            value: callerOwned,
            writable: true,
        })).toThrow("must be configurable, enumerable, and writable");
        let accessorInvoked = false;
        const accessorInput = {};
        Object.defineProperty(accessorInput, "nested", {
            configurable: true,
            enumerable: true,
            get: () => {
                accessorInvoked = true;
                return callerOwned;
            },
        });
        expect(() => (v2Apis.pluginStorage.setItem as any)("accessorInput", accessorInput))
            .toThrow("does not accept accessors");
        expect(accessorInvoked).toBe(false);
        expect(() => {
            databaseProxy.frozenInput = Object.freeze({ value: "unsafe-alias" });
        }).toThrow("requires configurable enumerable data");

        let inheritedToJsonInvoked = false;
        const previousToJson = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
        Object.defineProperty(Object.prototype, "toJSON", {
            configurable: true,
            value: () => {
                inheritedToJsonInvoked = true;
                return { replaced: true };
            },
        });
        try {
            (v2Apis.pluginStorage.setItem as any)("toJSONInput", { safe: "snapshot" });
        } finally {
            if (previousToJson) {
                Object.defineProperty(Object.prototype, "toJSON", previousToJson);
            } else {
                delete (Object.prototype as any).toJSON;
            }
        }
        expect(inheritedToJsonInvoked).toBe(false);
        expect(database.pluginCustomStorage.toJSONInput).toEqual({ safe: "snapshot" });

        let proxyGetInvoked = false;
        const proxyInput = new Proxy({ safe: { nested: "descriptor-only" } }, {
            get: () => {
                proxyGetInvoked = true;
                throw new Error("Proxy get must not be invoked while snapshotting");
            },
        });
        (v2Apis.pluginStorage.setItem as any)("proxyInput", proxyInput);
        expect(proxyGetInvoked).toBe(false);
        expect(database.pluginCustomStorage.proxyInput).toEqual({
            safe: { nested: "descriptor-only" },
        });

        let inheritedSetterTarget: unknown;
        Object.defineProperty(Object.prototype, "capturedBySetter", {
            configurable: true,
            set(this: unknown) {
                inheritedSetterTarget = this;
            },
        });
        try {
            storageProxy.capturedBySetter = { safe: "own-data-property" };
        } finally {
            delete (Object.prototype as any).capturedBySetter;
        }
        expect(inheritedSetterTarget).toBeUndefined();
        expect(Object.hasOwn(database.pluginCustomStorage, "capturedBySetter")).toBe(true);
        expect(database.pluginCustomStorage.capturedBySetter).toEqual({
            safe: "own-data-property",
        });

        expect(() => Object.setPrototypeOf(storageProxy, {
            toJSON: () => ({ escaped: true }),
        })).toThrow("prototypes cannot be changed");
        expect(Object.getPrototypeOf(storageProxy)).toBeNull();
        expect(() => Object.preventExtensions(storageProxy))
            .toThrow("must remain extensible");
        expect(Object.isExtensible(storageProxy)).toBe(true);
        expect(() => Object.setPrototypeOf(databaseProxy, {}))
            .toThrow("database prototypes cannot be changed");
        expect(() => Object.preventExtensions(databaseProxy))
            .toThrow("database proxies must remain extensible");

        const durable = new Map<string, unknown>();
        let releaseWrite!: () => void;
        let markWriteStarted!: () => void;
        const writeBlocked = new Promise<void>((resolve) => {
            releaseWrite = resolve;
        });
        const writeStarted = new Promise<void>((resolve) => {
            markWriteStarted = resolve;
        });
        const writePersistentJson = vi.fn(async (key: string, value: unknown) => {
            // Model the production boundary: JSON bytes are captured before
            // the network/durable write completes.
            const serialized = JSON.parse(JSON.stringify(value));
            if (key === encoded(PLUGIN_SAVE_PREFIX, "alpha")) {
                markWriteStarted();
                await writeBlocked;
            }
            durable.set(key, serialized);
        });

        const transition = transitionPluginStorageMode(true, {
            dependencies: {
                persistDatabase: vi.fn(async () => undefined),
                writePersistentJson,
            },
        });
        await writeStarted;
        expect(isPluginStorageModeTransitioning()).toBe(true);

        // Legacy assignment has localStorage-like snapshot semantics. The
        // caller may mutate its own object, but it is no longer a live storage
        // alias and therefore cannot create an unacknowledged late write.
        callerOwned.nested.value = "mutated-after-serialization";
        proxyCallerOwned.nested.value = "mutated-after-serialization";
        liteCallerOwned.nested.value = "mutated-after-serialization";
        asyncCallerOwned.nested.value = "mutated-after-serialization";

        expect(database.pluginCustomStorage.alpha.nested.value)
            .toBe("captured-at-assignment");
        releaseWrite();
        await transition;

        expect(isPluginStorageModeTransitioning()).toBe(false);
        expect(database.pluginCustomStorage).toEqual({});
        expect(durable.get(encoded(PLUGIN_SAVE_PREFIX, "alpha"))).toEqual({
            nested: { value: "captured-at-assignment" },
        });
        expect(durable.get(encoded(PLUGIN_SAVE_PREFIX, "beta"))).toEqual({
            nested: { value: "proxy-snapshot" },
        });
        expect(durable.get(encoded(PLUGIN_SAVE_PREFIX, "gamma"))).toEqual({
            nested: { value: "lite-snapshot" },
        });
        expect(durable.get(encoded(PLUGIN_SAVE_PREFIX, "delta"))).toEqual({
            nested: { value: "async-snapshot" },
        });
    });
});
