import { beforeEach, describe, expect, test, vi } from "vitest";
import { flushSync } from "svelte";
import {
    createDatabasePluginStorageRecord,
    setDatabasePluginStorageRecordValue,
} from "./pluginStorageRecord";

const testState = $state({ database: {} as any });

vi.mock("../storage/database.svelte", () => ({
    getDatabase: (options?: { snapshot?: boolean }) => options?.snapshot
        ? $state.snapshot(testState.database)
        : testState.database,
    getCurrentCharacter: () => null,
    setDatabase: (value: unknown) => { testState.database = value },
    setDatabaseLite: (value: unknown) => { testState.database = value },
}));

vi.mock("../globalApi.svelte", () => ({
    fetchNative: vi.fn(),
    globalFetch: vi.fn(),
    readImage: vi.fn(),
    requestImmediateSave: vi.fn(),
    saveAsset: vi.fn(),
    toGetter: (getter: () => unknown) => getter,
}));

vi.mock("../stores.svelte", () => {
    const DBState = {} as { db: unknown };
    Object.defineProperty(DBState, "db", {
        get: () => testState.database,
        set: (value) => { testState.database = value },
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
    alertConfirm: vi.fn(),
    alertError: vi.fn(),
    alertPluginConfirm: vi.fn(),
    notifyWarning: vi.fn(),
}));
vi.mock("../util", () => ({ selectSingleFile: vi.fn(), sleep: vi.fn() }));
vi.mock("./pluginSafety", () => ({ checkCodeSafety: vi.fn() }));
vi.mock("./pluginSafeClass", () => ({
    SafeDocument: {},
    SafeIdbFactory: class {},
    SafeLocalStorage: class {},
}));
vi.mock("./apiV3/v3.svelte", () => ({
    loadV3Plugins: vi.fn(),
    teardownV3Plugins: vi.fn(),
    loadV3PluginGeneration: vi.fn(),
}));
vi.mock("./apiV3/transpiler", () => ({ pluginCodeTranspiler: vi.fn() }));
vi.mock("../storage/persistentKv", () => ({
    clearPersistentPrefix: vi.fn(),
    decodeStorageKeyComponent: (value: string) => value,
    listPersistentKeys: vi.fn(async () => []),
    makeEncodedStorageKey: (prefix: string, key: string) => `${prefix}${key}.json`,
    readPersistentJson: vi.fn(),
    removePersistentKey: vi.fn(),
    writePersistentJson: vi.fn(),
}));

const { getV2PluginAPIs } = await import("./plugins.svelte");
const { getOwners } = await import("./pluginStorageMeta");
const { transitionPluginStorageMode } = await import("./pluginSaveStorage");

beforeEach(() => {
    const pluginCustomStorage = createDatabasePluginStorageRecord<unknown>();
    const pluginStorageMeta = createDatabasePluginStorageRecord<unknown>();
    setDatabasePluginStorageRecordValue(
        pluginCustomStorage,
        "__proto__",
        { nested: "live" },
    );
    setDatabasePluginStorageRecordValue(
        pluginStorageMeta,
        "__proto__",
        { plugin: "Proto Owner", updatedAt: 1 },
    );
    testState.database = {
        characters: [],
        optimizePluginMemory: false,
        plugins: [],
        pluginCustomStorage,
        pluginStorageMeta,
    };
});

describe("live plugin storage reads", () => {
    test("retained V2 storage facade preserves first __proto__ assignment reactively", () => {
        const apis = getV2PluginAPIs();
        const storage = (apis.getDatabase() as any).pluginCustomStorage;
        apis.pluginStorage.clear();
        let runs = 0;
        let nestedSeen: string | undefined;
        const stop = $effect.root(() => {
            $effect(() => {
                JSON.stringify(storage);
                nestedSeen = storage.__proto__?.nested;
                runs++;
            });
        });
        flushSync();
        expect(runs).toBe(1);

        storage.__proto__ = { nested: "assigned" };
        flushSync();
        expect(runs).toBe(2);
        expect(nestedSeen).toBe("assigned");
        expect(Object.hasOwn(storage, "__proto__")).toBe(true);
        expect(Object.keys(storage)).toEqual(["__proto__"]);
        expect(JSON.parse(JSON.stringify(storage)).__proto__).toEqual({ nested: "assigned" });
        const snapshot = $state.snapshot(storage);
        expect(snapshot).not.toBe(storage);
        expect(Object.keys(snapshot)).toEqual(["__proto__"]);
        expect(Object.hasOwn(snapshot, "__proto__")).toBe(true);
        expect(snapshot.__proto__).toEqual({ nested: "assigned" });
        expect(apis.pluginStorage.keys()).toEqual(["__proto__"]);
        expect(apis.pluginStorage.getItem("__proto__")).toEqual({ nested: "assigned" });

        storage.__proto__.nested = "reactive";
        flushSync();
        expect(runs).toBe(3);
        expect(nestedSeen).toBe("reactive");
        expect(apis.pluginStorage.getItem("__proto__")).toEqual({ nested: "reactive" });

        delete storage.__proto__;
        flushSync();
        expect(runs).toBe(4);
        expect(Object.keys(storage)).toEqual([]);
        expect(apis.pluginStorage.keys()).toEqual([]);
        expect(apis.pluginStorage.getItem("__proto__")).toBeNull();
        stop();
    });

    test("retained V2 storage facade preserves first __proto__ defineProperty", () => {
        const apis = getV2PluginAPIs();
        const storage = (apis.getDatabase() as any).pluginCustomStorage;
        apis.pluginStorage.clear();

        Object.defineProperty(storage, "__proto__", {
            configurable: true,
            enumerable: true,
            value: { nested: "defined" },
            writable: true,
        });
        expect(Object.keys(storage)).toEqual(["__proto__"]);
        expect(Object.getOwnPropertyDescriptor(storage, "__proto__")?.value)
            .toEqual({ nested: "defined" });

        // A separate API mutation replaces the underlying Svelte record. The
        // retained facade must continue to resolve the new live map.
        (apis.pluginStorage.setItem as any)("ordinary", { retained: true });
        expect(Object.keys(storage)).toEqual(["__proto__", "ordinary"]);
        expect(storage.__proto__).toEqual({ nested: "defined" });
        expect(storage.ordinary).toEqual({ retained: true });
    });

    test("retained V2 storage survives an externalize/internalize transition", async () => {
        const apis = getV2PluginAPIs();
        const storage = (apis.getDatabase() as any).pluginCustomStorage;
        apis.pluginStorage.clear();
        storage.__proto__ = { nested: "durable" };

        const persistent = new Map<string, unknown>();
        const persistedInlineKeys: string[][] = [];
        const dependencies = {
            getDatabase: () => testState.database,
            listPersistentKeys: async (prefix: string) => [...persistent.keys()]
                .filter(key => key.startsWith(prefix)),
            readPersistentJson: async <T>(key: string) => persistent.get(key) as T,
            writePersistentJson: async (key: string, value: unknown) => {
                persistent.set(key, JSON.parse(JSON.stringify(value)));
            },
            removePersistentKey: async (key: string) => { persistent.delete(key); },
            persistDatabase: async () => {
                persistedInlineKeys.push(Object.keys(testState.database.pluginCustomStorage));
            },
        };

        await transitionPluginStorageMode(true, { dependencies });
        expect(Object.keys(testState.database.pluginCustomStorage)).toEqual([]);
        expect(persistent.get("pluginsave/__proto__.json"))
            .toEqual({ nested: "durable" });

        await transitionPluginStorageMode(false, { dependencies });
        expect(persistedInlineKeys).toEqual([[], ["__proto__"]]);
        expect(Object.keys(storage)).toEqual(["__proto__"]);
        expect(storage.__proto__).toEqual({ nested: "durable" });
        expect(persistent.size).toBe(0);
    });

    test("V2 getItem returns a detached own __proto__ value omitted by Svelte snapshot", () => {
        const storage = getV2PluginAPIs().pluginStorage;
        storage.clear();
        (storage.setItem as any)("__proto__", { nested: "live" });
        expect(Object.hasOwn($state.snapshot(testState.database.pluginCustomStorage), "__proto__"))
            .toBe(false);

        const value = storage.getItem("__proto__") as any;
        expect(value).toEqual({ nested: "live" });
        expect(value).not.toBe(testState.database.pluginCustomStorage.__proto__);
        value.nested = "caller mutation";
        expect(testState.database.pluginCustomStorage.__proto__).toEqual({ nested: "live" });
    });

    test("save ownership reads include an own __proto__ metadata row", async () => {
        expect(Object.keys(testState.database.pluginStorageMeta)).toEqual(["__proto__"]);
        expect(testState.database.pluginStorageMeta.__proto__.plugin).toBe("Proto Owner");
        expect(Object.hasOwn($state.snapshot(testState.database.pluginStorageMeta), "__proto__"))
            .toBe(false);

        const owners = await getOwners("save");
        expect(Object.keys(owners)).toEqual(["__proto__"]);
        expect(Object.hasOwn(owners, "__proto__")).toBe(true);
        expect(owners.__proto__).toBe("Proto Owner");
    });
});
