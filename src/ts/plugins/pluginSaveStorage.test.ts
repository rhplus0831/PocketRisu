import { beforeEach, describe, expect, test, vi } from "vitest";

let database: any;
const persistent = vi.hoisted(() => new Map<string, unknown>());
const requestImmediateSave = vi.hoisted(() => vi.fn());
const teardownV3PluginsMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadV3PluginGenerationMock = vi.hoisted(() => vi.fn(async (..._plugins: any[]) => undefined));

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
    teardownV3Plugins: teardownV3PluginsMock,
    loadV3PluginGeneration: loadV3PluginGenerationMock,
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
        clearExternalizedPluginStorage: vi.fn(async () => {
            for (const key of persistent.keys()) {
                if (key.startsWith("pluginsave/") || key.startsWith("pluginsave-meta/")) {
                    persistent.delete(key);
                }
            }
        }),
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
        mutatePersistentPluginStorage: vi.fn(async (
            valueKey: string,
            operation: "set" | "remove",
            value?: unknown,
            owner = "",
        ) => {
            const encodedKey = valueKey.slice("pluginsave/".length, -".json".length);
            const metaKey = `pluginsave-meta/${encodedKey}.json`;
            if (operation === "set") {
                persistent.set(valueKey, value);
                if (owner) persistent.set(metaKey, { plugin: owner, updatedAt: Date.now() });
                else persistent.delete(metaKey);
            } else {
                persistent.delete(valueKey);
                persistent.delete(metaKey);
            }
            return {
                outcome: "committed" as const,
                operation,
                verification: "verified" as const,
            };
        }),
        readPersistentJson: vi.fn(async (key: string) => persistent.get(key) ?? null),
        removePersistentKey: vi.fn(async (key: string) => {
            persistent.delete(key);
        }),
        writePersistentJson: vi.fn(async (
            key: string,
            value: unknown,
            _signal?: AbortSignal | null,
        ) => {
            persistent.set(key, value);
        }),
    };
});

const {
    clearOwnedPluginSaveStorage,
    countExternalizedPluginStorageEntries,
    getPluginSaveStorageItem,
    getPluginSaveStorageKey,
    getPluginSaveStorageKeys,
    getPluginSaveStorageLength,
    PLUGIN_STORAGE_TRANSITION_WAIT_TIMEOUT_MS,
    PLUGIN_SAVE_META_PREFIX,
    PLUGIN_SAVE_PREFIX,
    readExternalizedPluginStorage,
    reconcilePluginStorageMode,
    removePluginSaveStorageItem,
    setOwnedPluginSaveStorageItem,
    setPluginSaveStorageItem,
    transitionPluginStorageMode,
    updateDatabaseWithPluginStorageSnapshot,
    withPluginSaveStorageKeyLock,
    withPluginSaveStorageLock,
} = await import("./pluginSaveStorage");
const {
    beginPluginStorageModeTransition,
    canEnablePlugin,
    isPluginStorageModeTransitioning,
} = await import("./pluginMemoryOptimization");
const {
    getV2PluginAPIs,
    importPlugin,
    loadPlugins,
    loadV2Plugin,
    pluginV2,
    removePluginAndReload,
    setPluginEnabledAndReload,
} = await import("./plugins.svelte");
const {
    createPluginStorageRecord,
    definePluginStorageRecordValue,
} = await import("./pluginStorageRecord");
const {
    clearOwners,
    recordOwner,
    removeOwner,
} = await import("./pluginStorageMeta");

const SPECIAL_PLUGIN_STORAGE_KEYS = [
    "__proto__",
    "constructor",
    "prototype",
    "toString",
    "hasOwnProperty",
    "",
] as const;
const ORDERED_SPECIAL_PLUGIN_STORAGE_KEYS = [
    "",
    "__proto__",
    "constructor",
    "hasOwnProperty",
    "prototype",
    "toString",
] as const;

function encoded(prefix: string, key: string) {
    return `${prefix}${Buffer.from(key, "utf-8").toString("base64url")}.json`;
}

type InvalidRecordKind = "accessor" | "symbol" | "non-enumerable";

function makeInvalidRecord(
    kind: InvalidRecordKind,
    onGetter = () => undefined,
): Record<string, unknown> {
    const record: Record<string, unknown> = {};
    if (kind === "accessor") {
        Object.defineProperty(record, "poisoned", {
            configurable: true,
            enumerable: true,
            get: () => {
                onGetter();
                return { silently: "serialized" };
            },
        });
    } else if (kind === "symbol") {
        Object.defineProperty(record, Symbol("poisoned"), {
            configurable: true,
            enumerable: true,
            value: { silently: "omitted" },
            writable: true,
        });
    } else {
        Object.defineProperty(record, "poisoned", {
            configurable: true,
            enumerable: false,
            value: { silently: "omitted" },
            writable: true,
        });
    }
    return record;
}

beforeEach(async () => {
    vi.clearAllMocks();
    persistent.clear();
    requestImmediateSave.mockResolvedValue({ status: "committed" });
    teardownV3PluginsMock.mockResolvedValue(undefined);
    loadV3PluginGenerationMock.mockResolvedValue(undefined);
    database = {
        optimizePluginMemory: false,
        pluginCustomStorage: {},
        plugins: [],
    };
    pluginV2.loaded = false;
    pluginV2.providers.clear();
    pluginV2.providerOptions.clear();
    pluginV2.editdisplay.clear();
    pluginV2.editoutput.clear();
    pluginV2.editprocess.clear();
    pluginV2.editinput.clear();
    pluginV2.replacerbeforeRequest.clear();
    pluginV2.replacerafterRequest.clear();
    pluginV2.unload.clear();
    const {
        listPersistentKeys,
        makeEncodedStorageKey,
        mutatePersistentPluginStorage,
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
    mutatePersistentPluginStorage.mockImplementation(async (
        valueKey: string,
        operation: "set" | "remove",
        value?: unknown,
        owner = "",
    ) => {
        const encodedKey = valueKey.slice(PLUGIN_SAVE_PREFIX.length, -".json".length);
        const metaKey = `${PLUGIN_SAVE_META_PREFIX}${encodedKey}.json`;
        if (operation === "set") {
            persistent.set(valueKey, value);
            if (owner) persistent.set(metaKey, { plugin: owner, updatedAt: Date.now() });
            else persistent.delete(metaKey);
        } else {
            persistent.delete(valueKey);
            persistent.delete(metaKey);
        }
        return { outcome: "committed", operation, verification: "verified" };
    });
    readPersistentJson.mockImplementation(async (key: string) => persistent.get(key) ?? null);
    removePersistentKey.mockImplementation(async (key: string) => {
        persistent.delete(key);
    });
    writePersistentJson.mockImplementation(async (
        key: string,
        value: unknown,
        _signal?: AbortSignal | null,
    ) => {
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

    test("rejects poisoned rows instead of treating them as absent during enumeration", async () => {
        const validKey = encoded(PLUGIN_SAVE_PREFIX, "valid");
        const poisonedKey = encoded(PLUGIN_SAVE_PREFIX, "poisoned");
        const { readPersistentJson } = await import("../storage/persistentKv");
        persistent.set(validKey, { safe: true });
        persistent.set(poisonedKey, "corrupt bytes sentinel");
        vi.mocked(readPersistentJson).mockImplementation(async (key: string) => {
            if (key === poisonedKey) throw new SyntaxError("Unexpected end of JSON input");
            return persistent.get(key);
        });

        await expect(readExternalizedPluginStorage()).rejects.toThrow(SyntaxError);
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
    test("cancels optimized owner sidecar persistence with the caller signal", async () => {
        database.optimizePluginMemory = true;
        const controller = new AbortController();
        const { writePersistentJson } = await import("../storage/persistentKv");
        let markWriteStarted!: () => void;
        const writeStarted = new Promise<void>((resolve) => {
            markWriteStarted = resolve;
        });
        vi.mocked(writePersistentJson).mockImplementation(async (_key, _value, signal) => {
            markWriteStarted();
            await new Promise<void>((resolve, reject) => {
                const onAbort = () => reject(signal?.reason);
                signal?.addEventListener("abort", onAbort, { once: true });
                if (signal?.aborted) onAbort();
            });
        });

        const writing = Promise.resolve(recordOwner(
            "save",
            "sidecar-key",
            "Sidecar Plugin",
            controller.signal,
        ));
        await writeStarted;
        controller.abort(new DOMException("sidecar cancelled", "AbortError"));

        await expect(writing).rejects.toMatchObject({ name: "AbortError" });
        expect(writePersistentJson).toHaveBeenCalledWith(
            encoded(PLUGIN_SAVE_META_PREFIX, "sidecar-key"),
            expect.objectContaining({ plugin: "Sidecar Plugin" }),
            controller.signal,
        );
    });

    test("forwards one signal through optimized owner remove and clear persistence", async () => {
        database.optimizePluginMemory = true;
        const controller = new AbortController();
        const {
            clearPersistentPrefix,
            removePersistentKey,
        } = await import("../storage/persistentKv");

        await removeOwner("save", "sidecar-key", controller.signal);
        await clearOwners("save", controller.signal);

        expect(removePersistentKey).toHaveBeenCalledWith(
            encoded(PLUGIN_SAVE_META_PREFIX, "sidecar-key"),
            controller.signal,
        );
        expect(clearPersistentPrefix).toHaveBeenCalledWith(
            PLUGIN_SAVE_META_PREFIX,
            controller.signal,
        );
    });

    test("optimized owned clear is one fixed-namespace server mutation", async () => {
        database.optimizePluginMemory = true;
        persistent.set(encoded(PLUGIN_SAVE_PREFIX, "alpha"), { value: 1 });
        persistent.set(encoded(PLUGIN_SAVE_META_PREFIX, "alpha"), {
            plugin: "Plugin",
            updatedAt: 1,
        });
        const {
            clearExternalizedPluginStorage,
            clearPersistentPrefix,
        } = await import("../storage/persistentKv");

        await clearOwnedPluginSaveStorage();

        expect(clearExternalizedPluginStorage).toHaveBeenCalledOnce();
        expect(clearPersistentPrefix).not.toHaveBeenCalled();
        expect(persistent.size).toBe(0);
    });

    test("inline owned clear publishes one empty value map", async () => {
        const previousValues = { alpha: { value: 1 } };
        database.pluginCustomStorage = previousValues;
        database.pluginStorageMeta = {
            alpha: { plugin: "Plugin", updatedAt: 1 },
        };
        const { clearExternalizedPluginStorage } = await import("../storage/persistentKv");

        await clearOwnedPluginSaveStorage();

        expect(database.pluginCustomStorage).not.toBe(previousValues);
        expect(Object.keys(database.pluginCustomStorage)).toEqual([]);
        expect(database.pluginStorageMeta).toBeUndefined();
        expect(clearExternalizedPluginStorage).not.toHaveBeenCalled();
    });

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

    test("owned writes reject the metadata boundary before writing either row", async () => {
        database.optimizePluginMemory = true;
        const { writePersistentJson } = await import("../storage/persistentKv");

        await expect(setOwnedPluginSaveStorageItem(
            "k".repeat(753),
            { value: 1 },
            "Boundary Plugin",
        )).rejects.toThrow("too long for backup archives");

        expect(writePersistentJson).not.toHaveBeenCalled();
        expect(persistent.size).toBe(0);
    });

    test("owned writes accept the maximum metadata-safe raw ASCII identifier", async () => {
        database.optimizePluginMemory = true;
        const rawKey = "k".repeat(752);
        const { mutatePersistentPluginStorage, writePersistentJson } = await import("../storage/persistentKv");

        await expect(setOwnedPluginSaveStorageItem(
            rawKey,
            { value: "maximum" },
            "Boundary Plugin",
        )).resolves.toBeUndefined();

        expect(mutatePersistentPluginStorage).toHaveBeenCalledOnce();
        expect(mutatePersistentPluginStorage).toHaveBeenCalledWith(
            encoded(PLUGIN_SAVE_PREFIX, rawKey),
            "set",
            { value: "maximum" },
            "Boundary Plugin",
            undefined,
        );
        expect(writePersistentJson).not.toHaveBeenCalled();
    });

    test("snapshots an inline oversized-key replacement before waiting without archive limits", async () => {
        database.optimizePluginMemory = false;
        const rawKey = "i".repeat(757);
        let release!: () => void;
        let started!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const lockStarted = new Promise<void>(resolve => { started = resolve; });
        const holding = withPluginSaveStorageLock(async () => {
            started();
            await held;
        });
        await lockStarted;

        const caller = { [rawKey]: { source: "before-queue" } };
        const mutateDatabase = vi.fn();
        const replacing = updateDatabaseWithPluginStorageSnapshot(
            caller,
            mutateDatabase,
        );
        caller[rawKey].source = "caller-mutated";
        release();
        await Promise.all([holding, replacing]);

        expect(database.pluginCustomStorage[rawKey]).toEqual({
            source: "before-queue",
        });
        expect(mutateDatabase).toHaveBeenCalledOnce();
        const { writePersistentJson } = await import("../storage/persistentKv");
        expect(writePersistentJson).not.toHaveBeenCalled();
    });

    test("keeps an optimized value-only 756-byte key through exact and omitted replacements", async () => {
        database.optimizePluginMemory = true;
        database.pluginCustomStorage = {};
        const rawKey = "v".repeat(756);
        const valueStorageKey = encoded(PLUGIN_SAVE_PREFIX, rawKey);
        persistent.set(valueStorageKey, { source: "existing-value-only" });

        await expect(updateDatabaseWithPluginStorageSnapshot(
            { [rawKey]: { source: "exact-replacement" } },
            vi.fn(),
        )).resolves.toBeUndefined();
        expect(persistent.get(valueStorageKey)).toEqual({
            source: "exact-replacement",
        });
        expect([...persistent.keys()].filter(key =>
            key.startsWith(PLUGIN_SAVE_META_PREFIX))).toEqual([]);

        const { writePersistentJson, removePersistentKey } = await import(
            "../storage/persistentKv"
        );
        vi.mocked(writePersistentJson).mockClear();
        vi.mocked(removePersistentKey).mockClear();
        await expect(updateDatabaseWithPluginStorageSnapshot(
            undefined,
            vi.fn(),
        )).resolves.toBeUndefined();
        expect(persistent.get(valueStorageKey)).toEqual({
            source: "exact-replacement",
        });
        expect(writePersistentJson).not.toHaveBeenCalled();
        expect(removePersistentKey).not.toHaveBeenCalled();
    });

    test("rejects an oversized optimized value replacement before any mutation", async () => {
        database.optimizePluginMemory = true;
        database.pluginCustomStorage = {};
        const retainedValueKey = encoded(PLUGIN_SAVE_PREFIX, "retained");
        const retainedMetaKey = encoded(PLUGIN_SAVE_META_PREFIX, "retained");
        persistent.set(retainedValueKey, { source: "retained" });
        persistent.set(retainedMetaKey, { plugin: "Owner", updatedAt: 1 });
        const before = new Map(persistent);
        const mutateDatabase = vi.fn();
        const { writePersistentJson, removePersistentKey } = await import(
            "../storage/persistentKv"
        );

        await expect(updateDatabaseWithPluginStorageSnapshot(
            { ["x".repeat(757)]: { source: "oversized" } },
            mutateDatabase,
        )).rejects.toThrow("too long for backup archives");

        expect(persistent).toEqual(before);
        expect(database.pluginCustomStorage).toEqual({});
        expect(writePersistentJson).not.toHaveBeenCalled();
        expect(removePersistentKey).not.toHaveBeenCalled();
        expect(mutateDatabase).not.toHaveBeenCalled();
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
        await expect(getPluginSaveStorageKeys()).resolves.toEqual(
            ORDERED_SPECIAL_PLUGIN_STORAGE_KEYS,
        );
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

    test.each([false, true])(
        "rejects unrepresentable JSON without mutating %s mode",
        async (optimized) => {
            database.optimizePluginMemory = optimized;
            const invalidValues: unknown[] = [
                undefined,
                () => undefined,
                new Map([["key", "value"]]),
                new Set(["value"]),
                { nested: undefined },
                { nested: Number.NaN },
                { nested: 1n },
            ];
            const cycle: Record<string, unknown> = {};
            cycle.self = cycle;
            invalidValues.push(cycle);

            const { writePersistentJson } = await import("../storage/persistentKv");
            for (const [index, value] of invalidValues.entries()) {
                await expect(setPluginSaveStorageItem(`invalid-${index}`, value))
                    .rejects.toThrow(TypeError);
            }

            expect(Object.keys(database.pluginCustomStorage)).toEqual([]);
            expect(persistent.size).toBe(0);
            expect(writePersistentJson).not.toHaveBeenCalled();
        },
    );

    test("inline get rejects an accessor without invoking it", async () => {
        let getterCalls = 0;
        database.pluginCustomStorage = makeInvalidRecord("accessor", () => {
            getterCalls += 1;
        });

        await expect(getPluginSaveStorageItem("poisoned"))
            .rejects.toThrow("does not accept an accessor");
        expect(getterCalls).toBe(0);
    });

    test.each(["accessor", "symbol", "non-enumerable"] as const)(
        "inline set rejects an existing %s property without replacing the record",
        async (kind) => {
            let getterCalls = 0;
            const original = makeInvalidRecord(kind, () => {
                getterCalls += 1;
            });
            database.pluginCustomStorage = original;

            await expect(setPluginSaveStorageItem("new-key", { safe: true }))
                .rejects.toThrow(TypeError);

            expect(database.pluginCustomStorage).toBe(original);
            expect(Object.hasOwn(database.pluginCustomStorage, "new-key")).toBe(false);
            expect(getterCalls).toBe(0);
        },
    );

    test("owned inline set validates metadata before publishing the value", async () => {
        let getterCalls = 0;
        const invalidMeta = makeInvalidRecord("accessor", () => {
            getterCalls += 1;
        });
        database.pluginCustomStorage = { existing: { safe: true } };
        database.pluginStorageMeta = invalidMeta;
        const originalValues = database.pluginCustomStorage;

        await expect(setOwnedPluginSaveStorageItem("new-key", { safe: true }, "Plugin"))
            .rejects.toThrow("does not accept an accessor");

        expect(database.pluginCustomStorage).toBe(originalValues);
        expect(database.pluginStorageMeta).toBe(invalidMeta);
        expect(Object.hasOwn(database.pluginCustomStorage, "new-key")).toBe(false);
        expect(getterCalls).toBe(0);
    });

    test.each([false, true])(
        "owned set replaces stale ownership and empty owner removes it in %s mode",
        async (optimized) => {
            database.optimizePluginMemory = optimized;
            const valueKey = encoded(PLUGIN_SAVE_PREFIX, "owned");
            const metaKey = encoded(PLUGIN_SAVE_META_PREFIX, "owned");
            if (optimized) {
                persistent.set(valueKey, { state: "old" });
                persistent.set(metaKey, { plugin: "Old", updatedAt: 1 });
            } else {
                database.pluginCustomStorage.owned = { state: "old" };
                database.pluginStorageMeta = {
                    owned: { plugin: "Old", updatedAt: 1 },
                };
            }

            await setOwnedPluginSaveStorageItem("owned", { state: "new" }, "New");
            await setOwnedPluginSaveStorageItem("owned", { state: "unowned" }, "");

            if (optimized) {
                expect(persistent.get(valueKey)).toEqual({ state: "unowned" });
                expect(persistent.has(metaKey)).toBe(false);
            } else {
                expect(database.pluginCustomStorage.owned).toEqual({ state: "unowned" });
                expect(database.pluginStorageMeta).toBeUndefined();
            }
        },
    );

    test("uses one stable ECMAScript-aware key order in both modes", async () => {
        const insertionOrder = ["beta", "10", "2", "01", "alpha", "4294967295", "0", ""];
        const expected = ["0", "2", "10", "", "01", "4294967295", "alpha", "beta"];
        for (const key of insertionOrder) {
            await setPluginSaveStorageItem(key, key);
        }
        await expect(getPluginSaveStorageKeys()).resolves.toEqual(expected);

        database.optimizePluginMemory = true;
        database.pluginCustomStorage = {};
        for (const key of [...insertionOrder].reverse()) {
            persistent.set(encoded(PLUGIN_SAVE_PREFIX, key), key);
        }
        await expect(getPluginSaveStorageKeys()).resolves.toEqual(expected);

        // Model a list-delta merge that moves an updated row to the end.
        const movedKey = encoded(PLUGIN_SAVE_PREFIX, "alpha");
        const value = persistent.get(movedKey);
        persistent.delete(movedKey);
        persistent.set(movedKey, value);
        await expect(getPluginSaveStorageKeys()).resolves.toEqual(expected);
    });

    test("a stalled write does not block another key and bounds a requested transition", async () => {
        vi.useFakeTimers();
        database.optimizePluginMemory = true;
        persistent.set(encoded(PLUGIN_SAVE_PREFIX, "beta"), { available: true });
        const { writePersistentJson } = await import("../storage/persistentKv");
        let markWriteStarted!: () => void;
        let releaseWrite!: () => void;
        const writeStarted = new Promise<void>(resolve => { markWriteStarted = resolve; });
        const stalledWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
        vi.mocked(writePersistentJson).mockImplementation(async (storageKey, value) => {
            if (storageKey === encoded(PLUGIN_SAVE_PREFIX, "alpha")) {
                markWriteStarted();
                await stalledWrite;
            }
            persistent.set(storageKey, value);
        });

        try {
            const write = setPluginSaveStorageItem("alpha", { delayed: true });
            await writeStarted;

            // A process-wide promise chain would leave this read pending.
            await expect(getPluginSaveStorageItem("beta"))
                .resolves.toEqual({ available: true });

            const transition = transitionPluginStorageMode(false, {
                dependencies: { persistDatabase: vi.fn(async () => undefined) },
            });
            const transitionFailure = transition.catch(error => error);
            await vi.advanceTimersByTimeAsync(PLUGIN_STORAGE_TRANSITION_WAIT_TIMEOUT_MS);

            const error = await transitionFailure;
            expect(error).toMatchObject({
                name: "StorageError",
                code: "STORAGE_TIMEOUT",
                operation: "transition",
                retryable: true,
                commitOutcomeUnknown: false,
            });
            expect(database.optimizePluginMemory).toBe(true);

            // Test-only cleanup: production transport timeouts abort this work.
            releaseWrite();
            await write;
        } finally {
            vi.useRealTimers();
        }
    });

    test("a cancelled queued key operation cannot let its successor overtake", async () => {
        const order: string[] = [];
        let releaseFirst!: () => void;
        let markFirstStarted!: () => void;
        const firstBlocked = new Promise<void>(resolve => { releaseFirst = resolve; });
        const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });

        const first = withPluginSaveStorageKeyLock("same-key", async () => {
            order.push("first:start");
            markFirstStarted();
            await firstBlocked;
            order.push("first:end");
        });
        await firstStarted;

        const controller = new AbortController();
        const secondResult = withPluginSaveStorageKeyLock("same-key", async () => {
            order.push("second:must-not-run");
        }, controller.signal).catch(error => error);
        // Let the second call install its queue token behind the first.
        await Promise.resolve();

        let thirdStarted = false;
        const third = withPluginSaveStorageKeyLock("same-key", async () => {
            thirdStarted = true;
            order.push("third");
        });
        // Let the third call capture the second token as its predecessor.
        await Promise.resolve();

        controller.abort(new DOMException("cancel queued operation", "AbortError"));
        await expect(secondResult).resolves.toMatchObject({ name: "AbortError" });
        await Promise.resolve();
        expect(thirdStarted).toBe(false);
        expect(order).toEqual(["first:start"]);

        let transitionStarted = false;
        const transitionBarrier = withPluginSaveStorageLock(async () => {
            transitionStarted = true;
            order.push("transition");
        });
        await Promise.resolve();
        expect(transitionStarted).toBe(false);

        releaseFirst();
        await Promise.all([first, third, transitionBarrier]);

        expect(order).toEqual([
            "first:start",
            "first:end",
            "third",
            "transition",
        ]);
        expect(thirdStarted).toBe(true);
        expect(transitionStarted).toBe(true);
    });

    test("length/key enumeration reuses one authoritative key snapshot", async () => {
        database.optimizePluginMemory = true;
        for (const key of ["alpha", "beta", "gamma"]) {
            persistent.set(encoded(PLUGIN_SAVE_PREFIX, key), key);
        }
        const { listPersistentKeys } = await import("../storage/persistentKv");

        const enumerated: string[] = [];
        for (let index = 0; index < await getPluginSaveStorageLength(); index += 1) {
            const key = await getPluginSaveStorageKey(index);
            if (key !== null) enumerated.push(key);
        }

        expect(enumerated).toEqual(["alpha", "beta", "gamma"]);
        expect(listPersistentKeys).toHaveBeenCalledTimes(1);
        expect(listPersistentKeys).toHaveBeenCalledWith(PLUGIN_SAVE_PREFIX);
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

    test("validates every value before writing or deleting any inline source", async () => {
        database = {
            optimizePluginMemory: true,
            pluginCustomStorage: {
                valid: { value: 1 },
                invalid: new Map([["lost", "if-written-as-empty-object"]]),
            },
        };
        const writePersistentJson = vi.fn();
        const persistDatabase = vi.fn();

        await expect(reconcilePluginStorageMode({
            dependencies: { writePersistentJson, persistDatabase },
        })).rejects.toThrow("plain objects");

        expect(database.pluginCustomStorage.valid).toEqual({ value: 1 });
        expect(database.pluginCustomStorage.invalid).toBeInstanceOf(Map);
        expect(writePersistentJson).not.toHaveBeenCalled();
        expect(persistDatabase).not.toHaveBeenCalled();
    });

    test("rejects an enumerable source accessor without invoking it", async () => {
        let getterCalls = 0;
        const invalid = makeInvalidRecord("accessor", () => {
            getterCalls += 1;
        });
        database = {
            optimizePluginMemory: true,
            pluginCustomStorage: invalid,
        };
        const writePersistentJson = vi.fn();
        const removePersistentKey = vi.fn();
        const persistDatabase = vi.fn();

        await expect(reconcilePluginStorageMode({
            dependencies: {
                writePersistentJson,
                removePersistentKey,
                persistDatabase,
            },
        })).rejects.toThrow("does not accept an accessor");

        expect(database.pluginCustomStorage).toBe(invalid);
        expect(getterCalls).toBe(0);
        expect(writePersistentJson).not.toHaveBeenCalled();
        expect(removePersistentKey).not.toHaveBeenCalled();
        expect(persistDatabase).not.toHaveBeenCalled();
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
    test("durably saves a disabled plugin before surfacing a rejecting unload", async () => {
        database.plugins = [{
            name: "Disable despite unload error",
            script: "",
            arguments: {},
            realArg: {},
            version: "2.1",
            customLink: [],
            argMeta: {},
            enabled: true,
        }];
        pluginV2.loaded = true;
        pluginV2.unload.add(async () => { throw new Error("unload failed"); });
        let persistedEnabled: boolean | undefined;
        requestImmediateSave.mockImplementationOnce(async () => {
            persistedEnabled = database.plugins[0].enabled;
            return { status: "committed" };
        });

        await expect(setPluginEnabledAndReload(
            "Disable despite unload error",
            false,
        )).rejects.toThrow("durably committed, but plugin teardown or reload failed");

        expect(database.plugins[0].enabled).toBe(false);
        expect(persistedEnabled).toBe(false);
        expect(requestImmediateSave).toHaveBeenCalledOnce();
        expect(requestImmediateSave).toHaveBeenCalledWith({ forceFullWrite: true });
    });

    test("durably saves removal before surfacing a rejecting unload", async () => {
        database.plugins = [{
            name: "Remove despite unload error",
            script: "",
            arguments: {},
            realArg: {},
            version: "2.1",
            customLink: [],
            argMeta: {},
            enabled: true,
        }];
        pluginV2.loaded = true;
        pluginV2.unload.add(async () => { throw new Error("unload failed"); });
        let persistedPluginNames: string[] | undefined;
        requestImmediateSave.mockImplementationOnce(async () => {
            persistedPluginNames = database.plugins.map((plugin: any) => plugin.name);
            return { status: "committed" };
        });

        await expect(removePluginAndReload("Remove despite unload error"))
            .rejects.toThrow("durably committed, but plugin teardown or reload failed");

        expect(database.plugins).toEqual([]);
        expect(persistedPluginNames).toEqual([]);
        expect(requestImmediateSave).toHaveBeenCalledOnce();
        expect(requestImmediateSave).toHaveBeenCalledWith({ forceFullWrite: true });
    });

    test.each([
        { status: "retry" } as const,
        { status: "displaced" } as const,
        { status: "failed", error: new Error("write failed") } as const,
    ])("rolls a list mutation back after a non-committed $status exact save", async (outcome) => {
        database.plugins = [{
            name: "Rollback list mutation",
            script: "",
            arguments: {},
            realArg: {},
            version: "3.0",
            customLink: [],
            argMeta: {},
            enabled: true,
        }];
        requestImmediateSave
            .mockResolvedValueOnce(outcome)
            .mockResolvedValueOnce({ status: "committed" });

        await expect(setPluginEnabledAndReload("Rollback list mutation", false))
            .rejects.toThrow("failed and was rolled back");

        expect(database.plugins[0].enabled).toBe(true);
        expect(requestImmediateSave).toHaveBeenCalledTimes(2);
        expect(requestImmediateSave).toHaveBeenNthCalledWith(1, { forceFullWrite: true });
        expect(requestImmediateSave).toHaveBeenNthCalledWith(2, { forceFullWrite: true });
    });

    test("restores a disabled plugin through the live list after teardown replaces it", async () => {
        const originalPlugin = {
            name: "Live-list power rollback",
            script: "original script",
            arguments: { original: "string" },
            realArg: { original: "value" },
            version: "3.0" as const,
            customLink: [],
            argMeta: {},
            enabled: true,
        };
        database.plugins = [structuredClone(originalPlugin)];
        teardownV3PluginsMock.mockImplementationOnce(async () => {
            const replacement = structuredClone(database.plugins);
            replacement[0].script = "callback replacement";
            replacement[0].arguments = { callback: "string" };
            database.plugins = replacement;
        });
        let persistedRollback: any[] | undefined;
        requestImmediateSave
            .mockRejectedValueOnce(new Error("exact save rejected"))
            .mockImplementationOnce(async () => {
                persistedRollback = structuredClone(database.plugins);
                return { status: "committed" };
            });

        await expect(setPluginEnabledAndReload(originalPlugin.name, false))
            .rejects.toThrow("failed and was rolled back");

        expect(database.plugins).toEqual([originalPlugin]);
        expect(persistedRollback).toEqual([originalPlugin]);
        expect(requestImmediateSave).toHaveBeenCalledTimes(2);
        expect(requestImmediateSave).toHaveBeenNthCalledWith(1, { forceFullWrite: true });
        expect(requestImmediateSave).toHaveBeenNthCalledWith(2, { forceFullWrite: true });
        expect(loadV3PluginGenerationMock.mock.calls[0]?.[0]).toEqual([]);
        expect(loadV3PluginGenerationMock.mock.calls.at(-1)?.[0]).toEqual([originalPlugin]);
    });

    test("restores removal order and provider without duplicating a callback replacement", async () => {
        const removedPlugin = {
            name: "Live-list removal rollback",
            script: "original removed script",
            arguments: {},
            realArg: {},
            version: "3.0" as const,
            customLink: [],
            argMeta: {},
            enabled: true,
        };
        const retainedPlugin = {
            ...removedPlugin,
            name: "Retained plugin",
            script: "retained script",
        };
        database.plugins = [
            structuredClone(removedPlugin),
            structuredClone(retainedPlugin),
        ];
        database.currentPluginProvider = removedPlugin.name;
        teardownV3PluginsMock.mockImplementationOnce(async () => {
            database.plugins = [
                structuredClone(database.plugins[0]),
                { ...structuredClone(removedPlugin), script: "callback update" },
                { ...structuredClone(removedPlugin), script: "callback duplicate" },
            ];
            database.currentPluginProvider = "callback provider";
        });
        let persistedRollback: any;
        requestImmediateSave
            .mockResolvedValueOnce({ status: "displaced" })
            .mockImplementationOnce(async () => {
                persistedRollback = {
                    plugins: structuredClone(database.plugins),
                    provider: database.currentPluginProvider,
                };
                return { status: "committed" };
            });

        await expect(removePluginAndReload(removedPlugin.name))
            .rejects.toThrow("failed and was rolled back");

        expect(database.plugins).toEqual([removedPlugin, retainedPlugin]);
        expect(database.currentPluginProvider).toBe(removedPlugin.name);
        expect(database.plugins.filter((plugin: any) => plugin.name === removedPlugin.name))
            .toHaveLength(1);
        expect(persistedRollback).toEqual({
            plugins: [removedPlugin, retainedPlugin],
            provider: removedPlugin.name,
        });
        expect(loadV3PluginGenerationMock.mock.calls.at(-1)?.[0])
            .toEqual([removedPlugin, retainedPlugin]);
        expect(requestImmediateSave).toHaveBeenNthCalledWith(1, { forceFullWrite: true });
        expect(requestImmediateSave).toHaveBeenNthCalledWith(2, { forceFullWrite: true });
    });

    test.each([
        { status: "retry" } as const,
        { status: "displaced" } as const,
        { status: "failed", error: new Error("write failed") } as const,
    ])("rolls an import back after a non-committed $status exact save", async (outcome) => {
        requestImmediateSave
            .mockResolvedValueOnce(outcome)
            .mockResolvedValueOnce({ status: "committed" });

        await importPlugin(`//@name Durable import ${outcome.status}\n//@api 3.0\n`);

        expect(database.plugins).toEqual([]);
        expect(requestImmediateSave).toHaveBeenCalledTimes(2);
        expect(requestImmediateSave).toHaveBeenNthCalledWith(1, { forceFullWrite: true });
        expect(requestImmediateSave).toHaveBeenNthCalledWith(2, { forceFullWrite: true });
        const { alertError } = vi.mocked(await import("../alert"));
        expect(alertError).toHaveBeenCalledWith(
            expect.stringContaining("Plugin import failed and was rolled back"),
        );
    });

    test("does not let an inherited older save outcome acknowledge an import", async () => {
        let forcedCalls = 0;
        requestImmediateSave.mockImplementation(async (options) => {
            if (options?.forceFullWrite !== true) {
                return { status: "committed" };
            }
            forcedCalls += 1;
            return forcedCalls === 1
                ? { status: "retry" }
                : { status: "committed" };
        });

        await importPlugin("//@name Exact import acknowledgement\n//@api 3.0\n");

        expect(database.plugins).toEqual([]);
        expect(forcedCalls).toBe(2);
        expect(requestImmediateSave).toHaveBeenCalledTimes(2);
        expect(requestImmediateSave).toHaveBeenNthCalledWith(1, { forceFullWrite: true });
        expect(requestImmediateSave).toHaveBeenNthCalledWith(2, { forceFullWrite: true });
    });

    test("waits for delayed V2 unload writes before externalizing storage", async () => {
        database.plugins = [{
            name: "Legacy lifecycle plugin",
            script: "",
            arguments: {},
            realArg: {},
            version: "2.1",
            customLink: [],
            argMeta: {},
            enabled: false,
        }];
        pluginV2.loaded = true;
        const v2Apis = getV2PluginAPIs();
        let releaseUnload!: () => void;
        let markUnloadStarted!: () => void;
        const unloadBlocked = new Promise<void>(resolve => { releaseUnload = resolve; });
        const unloadStarted = new Promise<void>(resolve => { markUnloadStarted = resolve; });
        pluginV2.unload.add(async () => {
            markUnloadStarted();
            await unloadBlocked;
            v2Apis.pluginStorage.setItem("unload-final", "included");
        });

        const reload = loadPlugins();
        await unloadStarted;
        const transition = transitionPluginStorageMode(true, {
            dependencies: { persistDatabase: vi.fn(async () => undefined) },
        });
        await Promise.resolve();

        expect(database.optimizePluginMemory).toBe(false);
        expect(isPluginStorageModeTransitioning()).toBe(false);

        releaseUnload();
        await reload;
        await transition;

        expect(persistent.get(encoded(PLUGIN_SAVE_PREFIX, "unload-final")))
            .toBe("included");
        expect(database.pluginCustomStorage).toEqual({});
    });

    test("drains every V2 unload callback and releases a queued transition after errors", async () => {
        database.plugins = [{
            name: "Rejecting legacy plugin",
            script: "",
            arguments: {},
            realArg: {},
            version: "2.1",
            customLink: [],
            argMeta: {},
            enabled: false,
        }];
        pluginV2.loaded = true;
        const v2Apis = getV2PluginAPIs();
        const calls: string[] = [];
        pluginV2.unload.add(async () => {
            calls.push("first");
            throw new Error("first unload failed");
        });
        pluginV2.unload.add(async () => {
            calls.push("final-write");
            v2Apis.pluginStorage.setItem("late", "kept");
        });
        pluginV2.unload.add(async () => {
            calls.push("last");
            throw new Error("last unload failed");
        });

        const reload = loadPlugins().then(() => null, error => error);
        const transition = transitionPluginStorageMode(true, {
            dependencies: { persistDatabase: vi.fn(async () => undefined) },
        });

        const reloadError = await reload;
        await transition;

        expect(reloadError).toBeInstanceOf(AggregateError);
        expect(calls).toEqual(["first", "final-write", "last"]);
        expect(pluginV2.unload.size).toBe(0);
        expect(persistent.get(encoded(PLUGIN_SAVE_PREFIX, "late"))).toBe("kept");
    });

    test("lets a V2 unload callback await its reload request without deadlocking", async () => {
        pluginV2.loaded = true;
        const v2Apis = getV2PluginAPIs();
        let acknowledged = false;
        pluginV2.unload.add(async () => {
            await v2Apis.loadPlugins();
            acknowledged = true;
        });

        await loadPlugins();

        expect(acknowledged).toBe(true);
        expect(pluginV2.unload.size).toBe(0);
    });

    test("durably powers off an invalid enabled V2 record instead of silently skipping it", async () => {
        database.optimizePluginMemory = true;
        database.plugins = [{
            name: "Persisted legacy plugin",
            script: "",
            arguments: {},
            realArg: {},
            version: "2.1",
            customLink: [],
            argMeta: {},
            enabled: true,
        }];

        await loadPlugins();

        expect(database.plugins[0].enabled).toBe(false);
        expect(requestImmediateSave).toHaveBeenCalledOnce();
        expect(requestImmediateSave).toHaveBeenCalledWith({ forceFullWrite: true });
        expect(pluginV2.loaded).toBe(false);
    });

    test("rechecks eligibility inside the lifecycle barrier", async () => {
        database.plugins = [{
            name: "Enabled legacy plugin",
            script: "",
            arguments: {},
            realArg: {},
            version: 2,
            customLink: [],
            argMeta: {},
            enabled: true,
        }];

        await expect(transitionPluginStorageMode(true, {
            dependencies: { persistDatabase: vi.fn(async () => undefined) },
        })).rejects.toThrow("Disable every enabled V2/V2.1 plugin");
        database.plugins[0].enabled = false;
        database.optimizePluginMemory = true;
        await expect(setPluginEnabledAndReload("Enabled legacy plugin", true))
            .resolves.toBe("blocked");

        expect(database.plugins[0].enabled).toBe(false);
        expect(isPluginStorageModeTransitioning()).toBe(false);
    });

    test("rechecks eligibility after storage operations queued ahead of the transition", async () => {
        const legacyPlugin = {
            name: "Queued legacy plugin",
            script: "",
            arguments: {},
            realArg: {},
            version: "2.1",
            customLink: [],
            argMeta: {},
            enabled: false,
        };
        database.plugins = [legacyPlugin];
        let releaseMutation!: () => void;
        let markStorageLockHeld!: () => void;
        const mutationAllowed = new Promise<void>(resolve => { releaseMutation = resolve; });
        const storageLockHeld = new Promise<void>(resolve => { markStorageLockHeld = resolve; });
        const earlierMutation = withPluginSaveStorageLock(async () => {
            markStorageLockHeld();
            await mutationAllowed;
            legacyPlugin.enabled = true;
        });
        await storageLockHeld;

        const transition = transitionPluginStorageMode(true, {
            dependencies: { persistDatabase: vi.fn(async () => undefined) },
        });
        const transitionAssertion = expect(transition)
            .rejects.toThrow("Disable every enabled V2/V2.1 plugin");
        await Promise.resolve();
        releaseMutation();
        await earlierMutation;

        await transitionAssertion;
        expect(database.optimizePluginMemory).toBe(false);
    });

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
        await expect(getPluginSaveStorageKeys()).resolves.toEqual(
            ORDERED_SPECIAL_PLUGIN_STORAGE_KEYS,
        );
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
        expect(Object.keys(database.pluginCustomStorage)).toEqual(
            ORDERED_SPECIAL_PLUGIN_STORAGE_KEYS,
        );
        expect(Object.keys(database.pluginStorageMeta)).toEqual(
            ORDERED_SPECIAL_PLUGIN_STORAGE_KEYS,
        );
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

    test.each([
        ["pluginCustomStorage", "accessor"],
        ["pluginCustomStorage", "symbol"],
        ["pluginCustomStorage", "non-enumerable"],
        ["pluginStorageMeta", "accessor"],
        ["pluginStorageMeta", "symbol"],
        ["pluginStorageMeta", "non-enumerable"],
    ] as const)(
        "enable preflight rejects %s %s properties before every mutation",
        async (field, kind) => {
            let getterCalls = 0;
            const invalid = makeInvalidRecord(kind, () => {
                getterCalls += 1;
            });
            database.optimizePluginMemory = false;
            database.pluginCustomStorage = field === "pluginCustomStorage" ? invalid : { safe: 1 };
            database.pluginStorageMeta = field === "pluginStorageMeta" ? invalid : undefined;
            const originalValues = database.pluginCustomStorage;
            const originalMeta = database.pluginStorageMeta;
            const listPersistentKeys = vi.fn();
            const readPersistentJson = vi.fn();
            const writePersistentJson = vi.fn();
            const removePersistentKey = vi.fn();
            const persistDatabase = vi.fn();

            await expect(transitionPluginStorageMode(true, {
                dependencies: {
                    listPersistentKeys,
                    readPersistentJson,
                    writePersistentJson,
                    removePersistentKey,
                    persistDatabase,
                },
            })).rejects.toThrow(TypeError);

            expect(database.optimizePluginMemory).toBe(false);
            expect(database.pluginCustomStorage).toBe(originalValues);
            expect(database.pluginStorageMeta).toBe(originalMeta);
            expect(getterCalls).toBe(0);
            expect(listPersistentKeys).not.toHaveBeenCalled();
            expect(readPersistentJson).not.toHaveBeenCalled();
            expect(writePersistentJson).not.toHaveBeenCalled();
            expect(removePersistentKey).not.toHaveBeenCalled();
            expect(persistDatabase).not.toHaveBeenCalled();
            expect(persistent.size).toBe(0);
        },
    );

    test("enable preflight rejects a poisoned retained orphan value before mutation", async () => {
        let getterCalls = 0;
        const invalid = makeInvalidRecord("accessor", () => {
            getterCalls += 1;
        });
        const orphanKey = encoded(PLUGIN_SAVE_PREFIX, "orphan");
        database.optimizePluginMemory = false;
        database.pluginCustomStorage = { inline: { safe: true } };
        const originalValues = database.pluginCustomStorage;
        persistent.set(orphanKey, "durable-row-sentinel");
        const readCalls: Array<[string, { cached?: boolean } | undefined]> = [];
        async function readPersistentJson<T>(
            key: string,
            options?: { cached?: boolean },
        ): Promise<T> {
            readCalls.push([key, options]);
            return (key === orphanKey ? invalid : persistent.get(key)) as T;
        }
        const writePersistentJson = vi.fn();
        const removePersistentKey = vi.fn();
        const persistDatabase = vi.fn();

        await expect(transitionPluginStorageMode(true, {
            dependencies: {
                readPersistentJson,
                writePersistentJson,
                removePersistentKey,
                persistDatabase,
            },
        })).rejects.toThrow("does not accept accessors");

        expect(database.optimizePluginMemory).toBe(false);
        expect(database.pluginCustomStorage).toBe(originalValues);
        expect(getterCalls).toBe(0);
        expect(readCalls).toContainEqual([orphanKey, { cached: true }]);
        expect(writePersistentJson).not.toHaveBeenCalled();
        expect(removePersistentKey).not.toHaveBeenCalled();
        expect(persistDatabase).not.toHaveBeenCalled();
        expect(persistent.get(orphanKey)).toBe("durable-row-sentinel");
    });

    test("enable preflight propagates a retained orphan metadata parse failure", async () => {
        const orphanMetaKey = encoded(PLUGIN_SAVE_META_PREFIX, "orphan");
        database.optimizePluginMemory = false;
        database.pluginCustomStorage = { inline: { safe: true } };
        database.pluginStorageMeta = { inline: { plugin: "Plugin", updatedAt: 1 } };
        const originalValues = database.pluginCustomStorage;
        const originalMeta = database.pluginStorageMeta;
        persistent.set(orphanMetaKey, "corrupt-json-sentinel");
        async function readPersistentJson<T>(key: string): Promise<T> {
            if (key === orphanMetaKey) {
                throw new SyntaxError("Unexpected end of JSON input");
            }
            return persistent.get(key) as T;
        }
        const writePersistentJson = vi.fn();
        const removePersistentKey = vi.fn();
        const persistDatabase = vi.fn();

        await expect(transitionPluginStorageMode(true, {
            dependencies: {
                readPersistentJson,
                writePersistentJson,
                removePersistentKey,
                persistDatabase,
            },
        })).rejects.toThrow(SyntaxError);

        expect(database.optimizePluginMemory).toBe(false);
        expect(database.pluginCustomStorage).toBe(originalValues);
        expect(database.pluginStorageMeta).toBe(originalMeta);
        expect(writePersistentJson).not.toHaveBeenCalled();
        expect(removePersistentKey).not.toHaveBeenCalled();
        expect(persistDatabase).not.toHaveBeenCalled();
        expect(persistent.get(orphanMetaKey)).toBe("corrupt-json-sentinel");
    });

    test("enable preflight skips an external row definitely overwritten inline", async () => {
        const overwrittenKey = encoded(PLUGIN_SAVE_PREFIX, "same");
        database.optimizePluginMemory = false;
        database.pluginCustomStorage = { same: { newest: true } };
        persistent.set(overwrittenKey, "poisoned-old-row");
        const readPersistentJson = vi.fn(async () => {
            throw new SyntaxError("overwritten row must not be read");
        });
        const writePersistentJson = vi.fn(async (key: string, value: unknown) => {
            persistent.set(key, value);
        });
        const persistDatabase = vi.fn();

        await expect(transitionPluginStorageMode(true, {
            dependencies: { readPersistentJson, writePersistentJson, persistDatabase },
        })).resolves.toEqual({ direction: "externalize", values: 1, meta: 0 });

        expect(readPersistentJson).not.toHaveBeenCalled();
        expect(database.optimizePluginMemory).toBe(true);
        expect(persistent.get(overwrittenKey)).toEqual({ newest: true });
    });

    test.each([
        ["pluginCustomStorage", "accessor"],
        ["pluginCustomStorage", "symbol"],
        ["pluginCustomStorage", "non-enumerable"],
        ["pluginStorageMeta", "accessor"],
        ["pluginStorageMeta", "symbol"],
        ["pluginStorageMeta", "non-enumerable"],
    ] as const)(
        "disable preflight rejects inline %s %s properties before reading external rows",
        async (field, kind) => {
            let getterCalls = 0;
            const invalid = makeInvalidRecord(kind, () => {
                getterCalls += 1;
            });
            database.optimizePluginMemory = true;
            database.pluginCustomStorage = field === "pluginCustomStorage" ? invalid : {};
            database.pluginStorageMeta = field === "pluginStorageMeta" ? invalid : undefined;
            const originalValues = database.pluginCustomStorage;
            const originalMeta = database.pluginStorageMeta;
            persistent.set(encoded(PLUGIN_SAVE_PREFIX, "external"), { durable: true });
            const listPersistentKeys = vi.fn();
            const readPersistentJson = vi.fn();
            const writePersistentJson = vi.fn();
            const removePersistentKey = vi.fn();
            const persistDatabase = vi.fn();

            await expect(transitionPluginStorageMode(false, {
                dependencies: {
                    listPersistentKeys,
                    readPersistentJson,
                    writePersistentJson,
                    removePersistentKey,
                    persistDatabase,
                },
            })).rejects.toThrow(TypeError);

            expect(database.optimizePluginMemory).toBe(true);
            expect(database.pluginCustomStorage).toBe(originalValues);
            expect(database.pluginStorageMeta).toBe(originalMeta);
            expect(getterCalls).toBe(0);
            expect(listPersistentKeys).not.toHaveBeenCalled();
            expect(readPersistentJson).not.toHaveBeenCalled();
            expect(writePersistentJson).not.toHaveBeenCalled();
            expect(removePersistentKey).not.toHaveBeenCalled();
            expect(persistDatabase).not.toHaveBeenCalled();
            expect(persistent.get(encoded(PLUGIN_SAVE_PREFIX, "external")))
                .toEqual({ durable: true });
        },
    );

    test.each(["accessor", "symbol", "non-enumerable"] as const)(
        "disable preflight rejects an external %s value before mode/database mutation",
        async (kind) => {
            let getterCalls = 0;
            const invalid = makeInvalidRecord(kind, () => {
                getterCalls += 1;
            });
            const valueKey = encoded(PLUGIN_SAVE_PREFIX, "external");
            database.optimizePluginMemory = true;
            database.pluginCustomStorage = {};
            persistent.set(valueKey, "durable-row-sentinel");
            const readCalls: Array<[string, { cached?: boolean } | undefined]> = [];
            async function readPersistentJson<T>(
                key: string,
                options?: { cached?: boolean },
            ): Promise<T> {
                readCalls.push([key, options]);
                return (key === valueKey ? invalid : null) as T;
            }
            const writePersistentJson = vi.fn();
            const removePersistentKey = vi.fn();
            const persistDatabase = vi.fn();

            await expect(transitionPluginStorageMode(false, {
                dependencies: {
                    readPersistentJson,
                    writePersistentJson,
                    removePersistentKey,
                    persistDatabase,
                },
            })).rejects.toThrow(TypeError);

            expect(database.optimizePluginMemory).toBe(true);
            expect(database.pluginCustomStorage).toEqual({});
            expect(getterCalls).toBe(0);
            expect(readCalls).toContainEqual([valueKey, { cached: true }]);
            expect(writePersistentJson).not.toHaveBeenCalled();
            expect(removePersistentKey).not.toHaveBeenCalled();
            expect(persistDatabase).not.toHaveBeenCalled();
            expect(persistent.get(valueKey)).toBe("durable-row-sentinel");
        },
    );

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

        expect(database.optimizePluginMemory).toBe(true);
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

        expect(database.optimizePluginMemory).toBe(true);
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

        expect(database.optimizePluginMemory).toBe(true);

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

    test("V2 inline mutations invalidate a V3 length/key enumeration snapshot", async () => {
        const v2Apis = getV2PluginAPIs();
        database.pluginCustomStorage = { alpha: 1 };

        await expect(getPluginSaveStorageLength()).resolves.toBe(1);
        await expect(getPluginSaveStorageKey(0)).resolves.toBe("alpha");

        v2Apis.pluginStorage.setItem("beta", "two");
        await expect(getPluginSaveStorageLength()).resolves.toBe(2);
        await expect(getPluginSaveStorageKey(1)).resolves.toBe("beta");

        v2Apis.pluginStorage.removeItem("alpha");
        await expect(getPluginSaveStorageLength()).resolves.toBe(1);
        await expect(getPluginSaveStorageKey(0)).resolves.toBe("beta");

        v2Apis.pluginStorage.clear();
        await expect(getPluginSaveStorageLength()).resolves.toBe(0);
        await expect(getPluginSaveStorageKey(0)).resolves.toBeNull();

        v2Apis.setDatabaseLite({ pluginCustomStorage: { gamma: 3 } });
        await expect(getPluginSaveStorageLength()).resolves.toBe(1);
        await expect(getPluginSaveStorageKey(0)).resolves.toBe("gamma");

        await v2Apis.setDatabase({ pluginCustomStorage: { delta: 4 } });
        await expect(getPluginSaveStorageLength()).resolves.toBe(1);
        await expect(getPluginSaveStorageKey(0)).resolves.toBe("delta");
    });

    test("V2 lite replacement invalidates V3 enumeration before a later field throws", async () => {
        const v2Apis = getV2PluginAPIs();
        database.pluginCustomStorage = { stale: true };
        await expect(getPluginSaveStorageLength()).resolves.toBe(1);
        await expect(getPluginSaveStorageKey(0)).resolves.toBe("stale");
        const mutation = {
            pluginCustomStorage: { replacement: true },
        } as Record<string, unknown>;
        Object.defineProperty(mutation, "temperature", {
            configurable: true,
            enumerable: true,
            get: () => {
                throw new Error("later lite field failed");
            },
        });

        expect(() => v2Apis.setDatabaseLite(mutation))
            .toThrow("later lite field failed");

        await expect(getPluginSaveStorageLength()).resolves.toBe(1);
        await expect(getPluginSaveStorageKey(0)).resolves.toBe("replacement");
    });

    test("V2 full replacement invalidates while later plugin approval is pending and rejected", async () => {
        const v2Apis = getV2PluginAPIs();
        database.pluginCustomStorage = { stale: true };
        await expect(getPluginSaveStorageLength()).resolves.toBe(1);
        await expect(getPluginSaveStorageKey(0)).resolves.toBe("stale");
        const { alertConfirm } = await import("../alert");
        let markApprovalStarted!: () => void;
        let rejectApproval!: (error: Error) => void;
        const approvalStarted = new Promise<void>((resolve) => {
            markApprovalStarted = resolve;
        });
        vi.mocked(alertConfirm).mockImplementationOnce(() => {
            markApprovalStarted();
            return new Promise<boolean>((_resolve, reject) => {
                rejectApproval = reject;
            });
        });
        const installCandidate = {
            name: "Interleaved V3 install",
            script: "// pending approval",
            arguments: {},
            realArg: {},
            version: "3.0" as const,
            customLink: [],
            argMeta: {},
            enabled: true,
        };

        const mutation = v2Apis.setDatabase({
            pluginCustomStorage: { replacement: true },
            plugins: [installCandidate],
        });
        await approvalStarted;

        // The async setter is still interleaved inside plugin approval, but
        // the earlier storage replacement is already authoritative.
        await expect(getPluginSaveStorageLength()).resolves.toBe(1);
        await expect(getPluginSaveStorageKey(0)).resolves.toBe("replacement");

        rejectApproval(new Error("plugin approval rejected"));
        await expect(mutation).rejects.toThrow("plugin approval rejected");
        await expect(getPluginSaveStorageLength()).resolves.toBe(1);
        await expect(getPluginSaveStorageKey(0)).resolves.toBe("replacement");
    });

    test("V2 full replacement invalidates after an interleaved plugin approval and before a later throw", async () => {
        const v2Apis = getV2PluginAPIs();
        database.pluginCustomStorage = { alpha: 1 };
        await expect(getPluginSaveStorageLength()).resolves.toBe(1);
        await expect(getPluginSaveStorageKey(0)).resolves.toBe("alpha");
        const { alertConfirm } = await import("../alert");
        let markApprovalStarted!: () => void;
        let resolveApproval!: (confirmed: boolean) => void;
        const approvalStarted = new Promise<void>((resolve) => {
            markApprovalStarted = resolve;
        });
        vi.mocked(alertConfirm).mockImplementationOnce(() => {
            markApprovalStarted();
            return new Promise<boolean>((resolve) => {
                resolveApproval = resolve;
            });
        });
        const installCandidate = {
            name: "Approved interleaved V3 install",
            script: "// approved after interleaving",
            arguments: {},
            realArg: {},
            version: "3.0" as const,
            customLink: [],
            argMeta: {},
            enabled: true,
        };
        const mutationInput = {
            plugins: [installCandidate],
            pluginCustomStorage: { final: 3 },
        } as Record<string, unknown>;
        Object.defineProperty(mutationInput, "temperature", {
            configurable: true,
            enumerable: true,
            get: () => {
                throw new Error("later full field failed");
            },
        });

        const mutation = v2Apis.setDatabase(mutationInput);
        await approvalStarted;
        v2Apis.pluginStorage.setItem("interleaved", "two");
        await expect(getPluginSaveStorageLength()).resolves.toBe(2);
        await expect(getPluginSaveStorageKey(1)).resolves.toBe("interleaved");

        resolveApproval(true);
        await expect(mutation).rejects.toThrow("later full field failed");
        expect(database.pluginCustomStorage).toEqual({ final: 3 });
        await expect(getPluginSaveStorageLength()).resolves.toBe(1);
        await expect(getPluginSaveStorageKey(0)).resolves.toBe("final");
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
