import { beforeEach, describe, expect, test, vi } from "vitest";

const storageMocks = vi.hoisted(() => ({
    persistent: new Map<string, unknown>(),
    writeGate: null as null | ((key: string) => Promise<void>),
    removeGate: null as null | ((key: string) => Promise<void>),
    clearGate: null as null | ((prefix: string) => Promise<void>),
}));
const alertConfirmMock = vi.hoisted(() => vi.fn(async () => true));
const testState = $state({ database: {} as any });

const encodeKey = (value: string) => Buffer.from(value, "utf-8").toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
const decodeKey = (value: string) => Buffer.from(
    value.replace(/-/g, "+").replace(/_/g, "/")
        .padEnd(Math.ceil(value.length / 4) * 4, "="),
    "base64",
).toString("utf-8");
const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value));

vi.mock("../../storage/database.svelte", () => ({
    changeToPreset: vi.fn(),
    getCurrentCharacter: () => undefined,
    getCurrentChat: () => undefined,
    getDatabase: (options?: { snapshot?: boolean }) => options?.snapshot
        ? $state.snapshot(testState.database)
        : testState.database,
    normalizeChat: (value: unknown) => value,
    presetTemplate: {},
    setCurrentCharacter: vi.fn(),
    setCurrentChat: vi.fn(),
    setDatabase: (value: unknown) => { testState.database = value; },
}));

vi.mock("../../globalApi.svelte", () => ({
    checkCharOrder: vi.fn(),
    fetchNative: vi.fn(),
    forageStorage: { realStorage: null },
    getFetchLogs: vi.fn(async () => []),
    globalFetch: vi.fn(),
    readImage: vi.fn(),
    requestImmediateSave: vi.fn(),
    saveAsset: vi.fn(),
    toGetter: (getter: () => unknown) => ({ get value() { return getter(); } }),
}));

vi.mock("../../storage/chatStorage", () => ({ chatToStub: (chat: unknown) => chat }));

vi.mock("../../storage/persistentKv", () => ({
    clearExternalizedPluginStorage: async () => {
        await storageMocks.clearGate?.("pluginsave/");
        for (const key of [...storageMocks.persistent.keys()]) {
            if (key.startsWith("pluginsave/") || key.startsWith("pluginsave-meta/")) {
                storageMocks.persistent.delete(key);
            }
        }
    },
    clearPersistentPrefix: async (prefix: string) => {
        await storageMocks.clearGate?.(prefix);
        for (const key of [...storageMocks.persistent.keys()]) {
            if (key.startsWith(prefix)) storageMocks.persistent.delete(key);
        }
    },
    decodeStorageKeyComponent: decodeKey,
    listPersistentKeys: async (prefix = "") => [...storageMocks.persistent.keys()]
        .filter(key => key.startsWith(prefix)),
    makeEncodedStorageKey: (prefix: string, key: string) => `${prefix}${encodeKey(key)}.json`,
    readPersistentJson: async <T>(key: string) => {
        const value = storageMocks.persistent.get(key);
        return value === undefined ? null : cloneJson(value) as T;
    },
    removePersistentKey: async (key: string) => {
        await storageMocks.removeGate?.(key);
        storageMocks.persistent.delete(key);
    },
    writePersistentJson: async (key: string, value: unknown) => {
        await storageMocks.writeGate?.(key);
        storageMocks.persistent.set(key, cloneJson(value));
    },
}));

vi.mock("../../alert", () => ({
    alertConfirm: alertConfirmMock,
    alertError: vi.fn(),
    alertNormal: vi.fn(),
}));

const {
    getPluginSaveStorageItem,
    getPluginSaveStorageKeys,
    getPluginSaveStorageSnapshot,
    setPluginSaveStorageItem,
    updateDatabaseWithPluginStorageSnapshot,
} = await import("../pluginSaveStorage");
const { cloneDatabaseField, cloneDatabaseState } = await import("../../storage/databaseClone");
const { normalizeJSON, RisuSavePatcher } = await import("../../storage/risuSave");
const { createPluginDatabaseBridge } = await import("./pluginDatabaseBridge");
const { getOwners } = await import("../pluginStorageMeta");
const {
    copyDatabasePluginStorageRecord,
    getPluginStorageRecordKeys,
    mergePluginStorageRecords,
    setDatabasePluginStorageRecordValue,
} = await import("../pluginStorageRecord");
const { applyPatch } = await import("fast-json-patch");
const { DBState } = await import("../../stores.svelte");
const { makeRisuaiAPIV3, resetAllPluginPermissions } = await import("./v3.svelte");
const { validateV3DatabaseMutationForTransport } = await import("./factory");
const serverUtilsPath = "../../../../server/node/utils.cjs";
const serverUtils = await import(/* @vite-ignore */ serverUtilsPath) as {
    calculateHash: (value: unknown) => number;
    normalizeJSON: (value: unknown) => unknown;
};

const ALLOWED_KEYS = ["pluginCustomStorage", "temperature", "theme"];

function createBridge(onFull = vi.fn()) {
    return createPluginDatabaseBridge({
        allowedDbKeys: ALLOWED_KEYS,
        getLiveDatabase: () => testState.database,
        snapshotField: (key, value) => cloneDatabaseField(key, value),
        getPluginStorageSnapshot: getPluginSaveStorageSnapshot,
        updateWithPluginStorageSnapshot: updateDatabaseWithPluginStorageSnapshot,
        applyLite: (mutation) => {
            for (const key of Object.keys(mutation)) testState.database[key] = mutation[key];
        },
        applyFull: (mutation) => {
            for (const key of Object.keys(mutation)) testState.database[key] = mutation[key];
            onFull(cloneDatabaseState(testState.database));
        },
    });
}

function storageKey(key: string) {
    return `pluginsave/${encodeKey(key)}.json`;
}

function emptyToSave() {
    return {
        character: [],
        chat: [] as [string, string][],
        root: false,
        botPreset: false,
        modules: false,
        plugins: false,
        pluginCustomStorage: false,
    };
}

beforeEach(async () => {
    storageMocks.persistent.clear();
    storageMocks.writeGate = null;
    storageMocks.removeGate = null;
    storageMocks.clearGate = null;
    alertConfirmMock.mockClear();
    testState.database = {
        characters: [],
        botPresets: [],
        modules: [],
        optimizePluginMemory: true,
        pluginCustomStorage: { staleInline: { mustDisappear: true } },
        temperature: 10,
        theme: "default",
    };
    DBState.db = testState.database;
    await resetAllPluginPermissions();
});

describe("V3 mode-aware database bridge", () => {
    test("normalizes a plugin-list mutation before the setter resolves", async () => {
        const normalizePluginMutation = vi.fn(() => {
            for (const plugin of testState.database.plugins) {
                if (plugin.version === "2.1") plugin.enabled = false;
            }
        });
        const bridge = createPluginDatabaseBridge({
            allowedDbKeys: ["plugins"],
            getLiveDatabase: () => testState.database,
            snapshotField: (key, value) => cloneDatabaseField(key, value),
            getPluginStorageSnapshot: getPluginSaveStorageSnapshot,
            updateWithPluginStorageSnapshot: updateDatabaseWithPluginStorageSnapshot,
            normalizePluginMutation,
            applyLite: (mutation) => {
                testState.database.plugins = mutation.plugins;
            },
            applyFull: (mutation) => {
                testState.database.plugins = mutation.plugins;
            },
        });

        await bridge.setDatabaseLite({
            plugins: [{ name: "Legacy", version: "2.1", enabled: true }],
        });

        expect(normalizePluginMutation).toHaveBeenCalledOnce();
        expect(testState.database.plugins[0].enabled).toBe(false);
    });

    test.each([false, true])(
        "coerces runtime keys identically with optimized mode %s",
        async (optimized) => {
            const plugin = {
                name: "Key Coercion Plugin",
                script: "// key coercion test",
                arguments: {},
                realArg: {},
                customLink: [],
                argMeta: {},
                version: "3.0",
                enabled: true,
            } as const;
            testState.database.optimizePluginMemory = optimized;
            testState.database.pluginCustomStorage = {};
            testState.database.plugins = [plugin];
            DBState.db = testState.database;
            const api = makeRisuaiAPIV3(document.createElement("iframe"), plugin as any) as any;

            await api._setPluginStorage(42, { coerced: true });

            expect(await api._getPluginStorage("42")).toEqual({ coerced: true });
            expect(await api._getPluginStorage(42)).toEqual({ coerced: true });
            expect(await api._keysPluginStorage()).toEqual(["42"]);

            await api._removePluginStorage(42);
            expect(await api._getPluginStorage("42")).toBeNull();
            expect(await api._keysPluginStorage()).toEqual([]);
        },
    );

    test("mixes authoritative get/set/pluginStorage with exact and omitted semantics", async () => {
        storageMocks.persistent.set(storageKey("cfg"), { value: "real" });
        storageMocks.persistent.set(storageKey("old"), { remove: true });
        storageMocks.persistent.set(`pluginsave-meta/${encodeKey("cfg")}.json`, {
            plugin: "Retained Owner",
            updatedAt: 1,
        });
        storageMocks.persistent.set(`pluginsave-meta/${encodeKey("old")}.json`, {
            plugin: "Removed Owner",
            updatedAt: 1,
        });
        storageMocks.persistent.set(`pluginsave-meta/${encodeKey("__proto__")}.json`, {
            plugin: "Orphan Owner",
            updatedAt: 1,
        });
        const bridge = createBridge();

        const first = await bridge.getDatabase(["pluginCustomStorage", "temperature"]);
        expect(first.pluginCustomStorage).toEqual({
            cfg: { value: "real" },
            old: { remove: true },
        });
        expect(first.pluginCustomStorage).not.toBe(testState.database.pluginCustomStorage);
        expect(first.temperature).toBe(10);
        (first.pluginCustomStorage as any).cfg.value = "caller-only";
        expect(await getPluginSaveStorageItem("cfg")).toEqual({ value: "real" });

        await setPluginSaveStorageItem("newer", { value: "pluginStorage" });
        const replacement: Record<string, unknown> = {
            cfg: { value: "database-bridge" },
        };
        Object.defineProperty(replacement, "__proto__", {
            configurable: true,
            enumerable: true,
            value: { special: true },
            writable: true,
        });
        await bridge.setDatabaseLite({
            pluginCustomStorage: replacement,
            temperature: 20,
        });

        expect(await getPluginSaveStorageKeys()).toEqual(["__proto__", "cfg"]);
        expect(await getPluginSaveStorageItem("cfg"))
            .toEqual({ value: "database-bridge" });
        expect(await getPluginSaveStorageItem("__proto__")).toEqual({ special: true });
        expect(await getPluginSaveStorageItem("old")).toBeNull();
        expect(await getPluginSaveStorageItem("newer")).toBeNull();
        expect(await getOwners("save")).toEqual({ cfg: "Retained Owner" });
        expect(testState.database.temperature).toBe(20);
        expect(Object.keys(testState.database.pluginCustomStorage)).toEqual([]);

        await setPluginSaveStorageItem("cfg", { value: "newest-plugin-write" });
        await bridge.setDatabaseLite({ temperature: 30 });
        expect(await getPluginSaveStorageItem("cfg"))
            .toEqual({ value: "newest-plugin-write" });
        expect(testState.database.temperature).toBe(30);
        expect(Object.keys(testState.database.pluginCustomStorage)).toEqual([]);

        await bridge.setDatabaseLite({ pluginCustomStorage: {} });
        expect(await getPluginSaveStorageKeys()).toEqual([]);
        expect(await getOwners("save")).toEqual({});
    });

    test("serializes exact replacement with concurrent pluginStorage writes", async () => {
        const bridge = createBridge();
        let release!: () => void;
        let started!: () => void;
        const writeStarted = new Promise<void>(resolve => { started = resolve; });
        const blocked = new Promise<void>(resolve => { release = resolve; });
        storageMocks.writeGate = async (key) => {
            if (key === storageKey("replacement")) {
                started();
                await blocked;
            }
        };

        const replacing = bridge.setDatabaseLite({
            pluginCustomStorage: { replacement: { value: 1 } },
        });
        await writeStarted;
        const laterWrite = setPluginSaveStorageItem("later", { value: 2 });
        await Promise.resolve();
        expect(storageMocks.persistent.has(storageKey("later"))).toBe(false);

        release();
        await Promise.all([replacing, laterWrite]);
        expect(await getPluginSaveStorageSnapshot()).toEqual({
            replacement: { value: 1 },
            later: { value: 2 },
        });
    });

    test("full setter merges roots, rejects unknown keys, and scrubs stale inline rows", async () => {
        storageMocks.persistent.set(storageKey("cfg"), { retained: true });
        const onFull = vi.fn();
        const bridge = createBridge(onFull);

        await expect(bridge.setDatabaseLite({ unknown: true }))
            .rejects.toThrow("Unsupported V3 database key");
        await bridge.setDatabase({ theme: "night" });

        expect(testState.database.theme).toBe("night");
        expect(testState.database.temperature).toBe(10);
        expect(Object.keys(testState.database.pluginCustomStorage)).toEqual([]);
        expect(await getPluginSaveStorageItem("cfg")).toEqual({ retained: true });
        expect(onFull).toHaveBeenCalledTimes(1);
    });

    test("rejects hidden unsupported keys, accessors, and allowed non-enumerable data", async () => {
        const bridge = createBridge();
        const hiddenUnknown = {};
        Object.defineProperty(hiddenUnknown, "unknown", {
            enumerable: false,
            value: true,
        });
        await expect(bridge.setDatabaseLite(hiddenUnknown))
            .rejects.toThrow("Unsupported V3 database key");

        const getter = vi.fn(() => "night");
        const hiddenAccessor = {};
        Object.defineProperty(hiddenAccessor, "theme", {
            enumerable: false,
            get: getter,
        });
        await expect(bridge.setDatabaseLite(hiddenAccessor))
            .rejects.toThrow("do not accept an accessor");
        expect(getter).not.toHaveBeenCalled();

        const hiddenAllowed = {};
        Object.defineProperty(hiddenAllowed, "theme", {
            enumerable: false,
            value: "night",
        });
        await expect(bridge.setDatabaseLite(hiddenAllowed))
            .rejects.toThrow("require an enumerable data property");
    });

    test("exhaustively validates pluginCustomStorage descriptors before reading values", async () => {
        const bridge = createBridge();

        const symbolStorage: Record<PropertyKey, unknown> = {};
        Object.defineProperty(symbolStorage, Symbol("hidden"), {
            enumerable: true,
            value: 1,
        });
        await expect(bridge.setDatabaseLite({ pluginCustomStorage: symbolStorage }))
            .rejects.toThrow("does not accept symbol keys");

        const hiddenStorage = {};
        Object.defineProperty(hiddenStorage, "arbitrary-hidden", {
            enumerable: false,
            value: 1,
        });
        await expect(bridge.setDatabaseLite({ pluginCustomStorage: hiddenStorage }))
            .rejects.toThrow("requires an enumerable data property");

        const getter = vi.fn(() => 1);
        const accessorStorage = {};
        Object.defineProperty(accessorStorage, "constructor", {
            enumerable: true,
            get: getter,
        });
        await expect(bridge.setDatabaseLite({ pluginCustomStorage: accessorStorage }))
            .rejects.toThrow("does not accept an accessor");
        expect(getter).not.toHaveBeenCalled();

        await expect(bridge.setDatabaseLite({ pluginCustomStorage: new Date() }))
            .rejects.toThrow("must be a plain JSON object");
    });

    test("guest transport validation rejects descriptors before structured clone", () => {
        const getter = vi.fn(() => "evaluated");
        const accessorStorage = {};
        Object.defineProperty(accessorStorage, "toString", {
            enumerable: true,
            get: getter,
        });
        expect(() => validateV3DatabaseMutationForTransport({
            pluginCustomStorage: accessorStorage,
        })).toThrow("does not accept an accessor");
        expect(getter).not.toHaveBeenCalled();

        const hiddenStorage = {};
        Object.defineProperty(hiddenStorage, "hidden", {
            enumerable: false,
            value: true,
        });
        expect(() => validateV3DatabaseMutationForTransport({
            pluginCustomStorage: hiddenStorage,
        })).toThrow("requires an enumerable data property");

        const symbolStorage = { visible: true } as Record<PropertyKey, unknown>;
        symbolStorage[Symbol("guest-symbol")] = true;
        expect(() => validateV3DatabaseMutationForTransport({
            pluginCustomStorage: symbolStorage,
        })).toThrow("does not accept symbol keys");
    });

    test("scrubs every Object.prototype-named value and owner hidden by live Svelte state", async () => {
        const bridge = createBridge();
        for (const key of Object.getOwnPropertyNames(Object.prototype)) {
            testState.database.pluginCustomStorage = {};
            testState.database.pluginStorageMeta = {};
            Object.defineProperty(testState.database.pluginCustomStorage, key, {
                configurable: true,
                enumerable: true,
                value: `stale-${key}`,
                writable: true,
            });
            Object.defineProperty(testState.database.pluginStorageMeta, key, {
                configurable: true,
                enumerable: true,
                value: { plugin: "Stale Owner", updatedAt: 1 },
                writable: true,
            });
            expect(Object.hasOwn(testState.database.pluginCustomStorage, key)).toBe(true);
            expect(Object.hasOwn(testState.database.pluginStorageMeta, key)).toBe(true);

            await bridge.setDatabaseLite({ temperature: 11 });

            expect(Object.hasOwn(testState.database.pluginCustomStorage, key)).toBe(false);
            expect(testState.database.pluginStorageMeta).toBeUndefined();
        }
    });

    test("discovers a late-added Object.prototype name in live storage everywhere", async () => {
        const key = "__ac1_late_object_prototype_key__";
        const priorDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, key);
        Object.defineProperty(Object.prototype, key, {
            configurable: true,
            enumerable: false,
            value: "inherited",
            writable: true,
        });
        try {
            testState.database.optimizePluginMemory = false;
            testState.database.pluginCustomStorage = {};
            testState.database.pluginStorageMeta = {};
            setDatabasePluginStorageRecordValue(
                testState.database.pluginCustomStorage,
                key,
                { source: "late-value" },
            );
            setDatabasePluginStorageRecordValue(
                testState.database.pluginStorageMeta,
                key,
                { plugin: "Late Owner", updatedAt: 1 },
            );
            expect(Object.hasOwn(testState.database.pluginCustomStorage, key)).toBe(true);
            expect(Object.keys(testState.database.pluginCustomStorage)).not.toContain(key);
            expect(getPluginStorageRecordKeys(testState.database.pluginCustomStorage))
                .toEqual([key]);

            expect(await getPluginSaveStorageKeys()).toEqual([key]);
            expect(await getPluginSaveStorageSnapshot()).toEqual({
                [key]: { source: "late-value" },
            });
            expect(await getOwners("save")).toEqual({ [key]: "Late Owner" });
            const copied = copyDatabasePluginStorageRecord(
                testState.database.pluginCustomStorage,
            );
            const merged = mergePluginStorageRecords(
                testState.database.pluginCustomStorage,
            );
            expect(Object.hasOwn(copied, key)).toBe(true);
            expect(Object.hasOwn(merged, key)).toBe(true);

            testState.database.optimizePluginMemory = true;
            await createBridge().setDatabaseLite({ temperature: 12 });
            expect(Object.hasOwn(testState.database.pluginCustomStorage, key)).toBe(false);
            expect(testState.database.pluginStorageMeta).toBeUndefined();
        } finally {
            if (priorDescriptor) {
                Object.defineProperty(Object.prototype, key, priorDescriptor);
            } else {
                delete (Object.prototype as Record<string, unknown>)[key];
            }
        }
    });

    test("keeps client/server patch hashes synchronized after optimized bridge writes", async () => {
        testState.database.pluginCustomStorage = {};
        const bridge = createBridge();
        const baseline = cloneDatabaseState(testState.database);
        const patcher = new RisuSavePatcher();
        await patcher.init(baseline);

        await bridge.setDatabaseLite({
            pluginCustomStorage: { cfg: { value: "external-only" } },
            temperature: 55,
        });
        const tracked = { ...emptyToSave(), root: true };
        const patchResult = await patcher.set(testState.database, tracked);

        expect(Object.keys(testState.database.pluginCustomStorage)).toEqual([]);
        expect(patchResult.patch.some((operation: any) =>
            operation.path.startsWith("/pluginCustomStorage"))).toBe(false);
        const serverState = normalizeJSON(baseline);
        applyPatch(serverState, patchResult.patch, true);
        expect(serverState.pluginCustomStorage).toEqual({});
        expect(serverState.temperature).toBe(55);

        const nextExpectedHash = (await patcher.set(testState.database, emptyToSave()))
            .expectedHash;
        const fresh = new RisuSavePatcher();
        await fresh.init(serverState);
        expect(nextExpectedHash)
            .toBe((await fresh.set(serverState, emptyToSave())).expectedHash);
        expect(nextExpectedHash).toBe(
            serverUtils.calculateHash(serverUtils.normalizeJSON(serverState)).toString(16),
        );
    });

    test("uses exact replacement semantics for inline mode too", async () => {
        testState.database.optimizePluginMemory = false;
        testState.database.pluginCustomStorage = { first: 1, omitted: 2 };
        testState.database.pluginStorageMeta = {
            first: { plugin: "Retained Owner", updatedAt: 1 },
            omitted: { plugin: "Removed Owner", updatedAt: 1 },
            introduced: { plugin: "Orphan Owner", updatedAt: 1 },
        };
        const bridge = createBridge();

        const snapshot = await bridge.getDatabase(["pluginCustomStorage"]);
        expect(snapshot.pluginCustomStorage).toEqual({ first: 1, omitted: 2 });
        (snapshot.pluginCustomStorage as any).first = 99;
        expect(testState.database.pluginCustomStorage.first).toBe(1);

        await bridge.setDatabaseLite({ pluginCustomStorage: { first: 3, introduced: 4 } });
        expect(testState.database.pluginCustomStorage).toEqual({ first: 3, introduced: 4 });
        expect(await getOwners("save")).toEqual({ first: "Retained Owner" });
        await bridge.setDatabaseLite({ temperature: 44 });
        expect(testState.database.pluginCustomStorage).toEqual({ first: 3, introduced: 4 });
        expect(await getOwners("save")).toEqual({ first: "Retained Owner" });

        await bridge.setDatabaseLite({ pluginCustomStorage: {} });
        expect(testState.database.pluginStorageMeta).toBeUndefined();
        expect(await getOwners("save")).toEqual({});
    });

    test("orders actual V3 set/remove/clear mutations with exact database replacement", async () => {
        const plugin = {
            name: "Bridge Test Plugin",
            script: "// bridge test",
            arguments: {},
            realArg: {},
            customLink: [],
            argMeta: {},
            version: "3.0",
            enabled: true,
        } as const;
        testState.database.plugins = [plugin];
        DBState.db = testState.database;
        const api = makeRisuaiAPIV3(document.createElement("iframe"), plugin as any) as any;
        // Cache the periodic database grant before installing operation gates.
        await api.setDatabaseLite({});
        await api._setPluginStorage("authoritative-read", { source: "plugin" });
        const actualSnapshot = await api.getDatabase(["pluginCustomStorage"]);
        expect(actualSnapshot.pluginCustomStorage).toEqual({
            "authoritative-read": { source: "plugin" },
        });
        actualSnapshot.pluginCustomStorage["authoritative-read"].source = "caller";
        expect(await api._getPluginStorage("authoritative-read"))
            .toEqual({ source: "plugin" });
        await api._clearPluginStorage();

        let releaseSet!: () => void;
        let setStarted!: () => void;
        const setBlocked = new Promise<void>(resolve => { releaseSet = resolve; });
        const setWriteStarted = new Promise<void>(resolve => { setStarted = resolve; });
        storageMocks.writeGate = async (key) => {
            if (key === storageKey("deleted")) {
                setStarted();
                await setBlocked;
            }
        };
        const setting = api._setPluginStorage("deleted", { source: "plugin" });
        await setWriteStarted;
        const replacingAfterSet = api.setDatabaseLite({
            pluginCustomStorage: { retained: { source: "database" } },
        });
        await new Promise(resolve => setTimeout(resolve, 0));
        releaseSet();
        await Promise.all([setting, replacingAfterSet]);
        storageMocks.writeGate = null;

        expect(await getPluginSaveStorageSnapshot()).toEqual({
            retained: { source: "database" },
        });
        expect(await getOwners("save")).toEqual({});

        await api._setPluginStorage("remove-race", { source: "plugin" });
        let releaseRemove!: () => void;
        let removeStarted!: () => void;
        const removeBlocked = new Promise<void>(resolve => { releaseRemove = resolve; });
        const removeWriteStarted = new Promise<void>(resolve => { removeStarted = resolve; });
        storageMocks.removeGate = async (key) => {
            if (key === storageKey("remove-race")) {
                removeStarted();
                await removeBlocked;
            }
        };
        const removing = api._removePluginStorage("remove-race");
        await removeWriteStarted;
        const replacingAfterRemove = api.setDatabase({
            pluginCustomStorage: { afterRemove: true },
        });
        await new Promise(resolve => setTimeout(resolve, 0));
        releaseRemove();
        await Promise.all([removing, replacingAfterRemove]);
        storageMocks.removeGate = null;
        expect(await getPluginSaveStorageSnapshot()).toEqual({ afterRemove: true });
        expect(await getOwners("save")).toEqual({});

        await api._setPluginStorage("clear-race", { source: "plugin" });
        let releaseClear!: () => void;
        let clearStarted!: () => void;
        const clearBlocked = new Promise<void>(resolve => { releaseClear = resolve; });
        const clearWriteStarted = new Promise<void>(resolve => { clearStarted = resolve; });
        storageMocks.clearGate = async (prefix) => {
            if (prefix === "pluginsave/") {
                clearStarted();
                await clearBlocked;
            }
        };
        const clearing = api._clearPluginStorage();
        await clearWriteStarted;
        const replacingAfterClear = api.setDatabaseLite({
            pluginCustomStorage: { afterClear: true },
        });
        await new Promise(resolve => setTimeout(resolve, 0));
        releaseClear();
        await Promise.all([clearing, replacingAfterClear]);
        storageMocks.clearGate = null;
        expect(await getPluginSaveStorageSnapshot()).toEqual({ afterClear: true });
        expect(await getOwners("save")).toEqual({});
    });

    test("actual full V3 setter preserves plugin-install filtering", async () => {
        const caller = {
            name: "Caller Plugin",
            script: "// caller",
            arguments: {},
            realArg: {},
            customLink: [],
            argMeta: {},
            version: "3.0",
            enabled: true,
        };
        const installed = {
            ...caller,
            name: "Installed Plugin",
            script: "// installed",
        };
        const rejected = {
            ...caller,
            name: "Rejected Legacy Plugin",
            script: "// legacy",
            version: "2.1",
        };
        testState.database.plugins = [caller];
        DBState.db = testState.database;
        const api = makeRisuaiAPIV3(document.createElement("iframe"), caller as any) as any;

        const actualAccessor = {};
        const getter = vi.fn(() => true);
        Object.defineProperty(actualAccessor, "hasOwnProperty", {
            enumerable: true,
            get: getter,
        });
        await expect(api.setDatabaseLite({ pluginCustomStorage: actualAccessor }))
            .rejects.toThrow("does not accept an accessor");
        expect(getter).not.toHaveBeenCalled();

        const actualHidden = {};
        Object.defineProperty(actualHidden, "hidden", {
            enumerable: false,
            value: true,
        });
        await expect(api.setDatabaseLite({ pluginCustomStorage: actualHidden }))
            .rejects.toThrow("requires an enumerable data property");

        const actualSymbol = {} as Record<PropertyKey, unknown>;
        actualSymbol[Symbol("host-symbol")] = true;
        await expect(api.setDatabaseLite({ pluginCustomStorage: actualSymbol }))
            .rejects.toThrow("does not accept symbol keys");

        await api.setDatabase({
            plugins: [installed, rejected],
            theme: "night",
        });

        expect(testState.database.plugins).toEqual([installed]);
        expect(testState.database.theme).toBe("night");
        expect(alertConfirmMock).toHaveBeenCalled();
    });
});
