import { beforeEach, describe, expect, test, vi } from "vitest";
import { awaitWithAbort, throwIfAborted } from "../../storage/abort";

const storageMocks = vi.hoisted(() => ({
    persistent: new Map<string, unknown>(),
    readGate: null as null | ((key: string, signal?: AbortSignal | null) => Promise<void>),
    writeGate: null as null | ((key: string, signal?: AbortSignal | null) => Promise<void>),
    removeGate: null as null | ((key: string, signal?: AbortSignal | null) => Promise<void>),
    clearGate: null as null | ((prefix: string, signal?: AbortSignal | null) => Promise<void>),
}));
const alertConfirmMock = vi.hoisted(() => vi.fn(async () => true));
const notifyErrorMock = vi.hoisted(() => vi.fn());
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
const manifestKey = "plugin-storage/manifest.json";

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
    clearExternalizedPluginStorage: async (signal?: AbortSignal | null) => {
        await storageMocks.clearGate?.("pluginsave/", signal);
        throwIfAborted(signal);
        for (const key of [...storageMocks.persistent.keys()]) {
            throwIfAborted(signal);
            if (key.startsWith("pluginsave/") || key.startsWith("pluginsave-meta/")) {
                storageMocks.persistent.delete(key);
            }
        }
    },
    clearPersistentPrefix: async (prefix: string, signal?: AbortSignal | null) => {
        await storageMocks.clearGate?.(prefix, signal);
        throwIfAborted(signal);
        for (const key of [...storageMocks.persistent.keys()]) {
            throwIfAborted(signal);
            if (key.startsWith(prefix)) storageMocks.persistent.delete(key);
        }
    },
    commitPersistentPluginStorageMutation: async (
        mutation: any,
        signal?: AbortSignal | null,
    ) => {
        for (const write of mutation.writes) {
            await storageMocks.writeGate?.(write.storageKey, signal);
            throwIfAborted(signal);
            storageMocks.persistent.set(write.storageKey, cloneJson(write.value));
        }
        for (const key of mutation.deletes) {
            await storageMocks.removeGate?.(key, signal);
            throwIfAborted(signal);
            storageMocks.persistent.delete(key);
        }
        storageMocks.persistent.set(manifestKey, cloneJson(mutation.nextManifest));
    },
    commitPersistentPluginStorageTransition: vi.fn(),
    decodeStorageKeyComponent: decodeKey,
    listPersistentKeys: async (prefix = "", signal?: AbortSignal | null) => {
        throwIfAborted(signal);
        return [...storageMocks.persistent.keys()].filter(key => key.startsWith(prefix));
    },
    makeEncodedStorageKey: (prefix: string, key: string) => `${prefix}${encodeKey(key)}.json`,
    mutatePersistentPluginStorage: async (
        valueKey: string,
        operation: "set" | "remove",
        valueOrSignal?: unknown,
        owner = "",
        signal?: AbortSignal | null,
    ) => {
        const activeSignal = operation === "remove"
            ? valueOrSignal as AbortSignal | null | undefined
            : signal;
        const encoded = valueKey.slice("pluginsave/".length, -".json".length);
        const ownerKey = `pluginsave-meta/${encoded}.json`;
        if (operation === "set") {
            await storageMocks.writeGate?.(valueKey, activeSignal);
            throwIfAborted(activeSignal);
            storageMocks.persistent.set(valueKey, cloneJson(valueOrSignal));
            if (owner) {
                storageMocks.persistent.set(ownerKey, {
                    plugin: owner,
                    updatedAt: Date.now(),
                });
            } else {
                storageMocks.persistent.delete(ownerKey);
            }
        } else {
            await storageMocks.removeGate?.(valueKey, activeSignal);
            throwIfAborted(activeSignal);
            storageMocks.persistent.delete(valueKey);
            storageMocks.persistent.delete(ownerKey);
        }
        return {
            outcome: "committed" as const,
            operation,
            verification: "verified" as const,
        };
    },
    readPersistentJson: async <T>(
        key: string,
        options: {
            signal?: AbortSignal | null;
            pluginStorageGeneration?: string;
        } = {},
    ) => {
        await storageMocks.readGate?.(key, options.signal);
        throwIfAborted(options.signal);
        if (key === manifestKey) {
            return {
                version: 1,
                generation: testState.database.pluginStorageGeneration,
                valueKeys: [...storageMocks.persistent.keys()].filter(
                    candidate => candidate.startsWith("pluginsave/"),
                ),
                metaKeys: [...storageMocks.persistent.keys()].filter(
                    candidate => candidate.startsWith("pluginsave-meta/"),
                ),
            } as T;
        }
        const value = storageMocks.persistent.get(key);
        return value === undefined ? null : cloneJson(value) as T;
    },
    removePersistentKey: async (key: string, signal?: AbortSignal | null) => {
        await storageMocks.removeGate?.(key, signal);
        throwIfAborted(signal);
        storageMocks.persistent.delete(key);
    },
    writePersistentJson: async (
        key: string,
        value: unknown,
        signal?: AbortSignal | null,
    ) => {
        await storageMocks.writeGate?.(key, signal);
        throwIfAborted(signal);
        storageMocks.persistent.set(key, cloneJson(value));
    },
}));

vi.mock("../../alert", () => ({
    alertConfirm: alertConfirmMock,
    alertError: vi.fn(),
    alertNormal: vi.fn(),
    notifyError: notifyErrorMock,
    notifyWarning: vi.fn(),
}));

const {
    getPluginSaveStorageItem,
    getPluginSaveStorageKeys,
    getPluginSaveStorageSnapshot,
    setPluginSaveStorageItem,
    updateDatabaseWithPluginStorageSnapshot,
    withPluginSaveStorageLock,
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
const {
    additionalFloatingActionButtons,
    additionalSettingsMenu,
    bodyIntercepterStore,
    chatPanelStore,
    DBState,
} = await import("../../stores.svelte");
const {
    customV3ProviderMetaStore,
    getV3PluginInstance,
    loadV3PluginGeneration,
    makeRisuaiAPIV3,
    resetAllPluginPermissions,
    teardownV3Plugins,
    pluginChannel,
} = await import("./v3.svelte");
const { customProviderStore, pluginV2 } = await import("../plugins.svelte");
const { get } = await import("svelte/store");
const { registeredCustomPluginMCPs } = await import("../../process/mcp/pluginmcp");
const { getTTSPostprocessors, getTTSPreprocessors } = await import("../../process/ttsHooks");
const {
    PLUGIN_BRIDGE_INITIALIZATION_TIMEOUT_MS,
    PLUGIN_BRIDGE_REQUEST_TIMEOUT_MS,
    SandboxHost,
    createV3BridgeRequestRegistry,
    deserializeV3BridgeError,
    validateV3DatabaseMutationForTransport,
} = await import("./factory");
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

function installManifestOwnedStartupKeys(...keys: string[]) {
    const storageKeys = keys.map(storageKey);
    for (const key of storageKeys) {
        if (!storageMocks.persistent.has(key)) {
            storageMocks.persistent.set(key, { fixture: true });
        }
    }
    storageMocks.persistent.set(manifestKey, {
        version: 1,
        generation: testState.database.pluginStorageGeneration,
        valueKeys: storageKeys,
        metaKeys: [],
    });
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

function deferred() {
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/**
 * happy-dom materializes iframe srcdoc but does not execute its scripts. Run
 * the exact generated guest script manually and preserve a browser-realistic
 * MessageEvent.source so SandboxHost's source check remains exercised.
 */
function executeGeneratedGuest(iframe: HTMLIFrameElement) {
    const guestWindow = iframe.contentWindow;
    const scripts = [...(iframe.contentDocument?.querySelectorAll("script") ?? [])];
    if (!guestWindow || scripts.length !== 2) throw new Error("Generated V3 guest scripts are unavailable.");
    if (!(guestWindow as any).ImageBitmap) {
        (guestWindow as any).ImageBitmap = class ImageBitmap {};
    }
    if (!(guestWindow as any).MessageChannel) {
        (guestWindow as any).MessageChannel = MessageChannel;
    }
    const originalParent = Object.getOwnPropertyDescriptor(guestWindow, "parent");
    Object.defineProperty(guestWindow, "parent", {
        configurable: true,
        value: {
            postMessage(data: unknown) {
                window.dispatchEvent(new MessageEvent("message", {
                    data,
                    origin: "null",
                    source: guestWindow,
                }));
            },
        },
    });
    for (const script of scripts) {
        try {
            (guestWindow as any).eval(script.textContent ?? "");
        } catch (error) {
            guestWindow.dispatchEvent(new ErrorEvent("error", {
                error,
                message: error instanceof Error ? error.message : String(error),
            }));
        }
    }
    return () => {
        if (originalParent) Object.defineProperty(guestWindow, "parent", originalParent);
    };
}

function startupPlugin(name: string, script: string) {
    return {
        name,
        script,
        arguments: {},
        realArg: {},
        customLink: [],
        argMeta: {},
        version: "3.0" as const,
        enabled: true,
    };
}

beforeEach(async () => {
    await teardownV3Plugins();
    document.body.replaceChildren();
    storageMocks.persistent.clear();
    storageMocks.readGate = null;
    storageMocks.writeGate = null;
    storageMocks.removeGate = null;
    storageMocks.clearGate = null;
    alertConfirmMock.mockClear();
    notifyErrorMock.mockClear();
    pluginV2.providers.clear();
    pluginV2.providerOptions.clear();
    pluginV2.editdisplay.clear();
    pluginV2.replacerbeforeRequest.clear();
    customProviderStore.set([]);
    customV3ProviderMetaStore.splice(0);
    pluginChannel.clear();
    registeredCustomPluginMCPs.clear();
    additionalSettingsMenu.splice(0);
    additionalFloatingActionButtons.splice(0);
    bodyIntercepterStore.splice(0);
    chatPanelStore.splice(0);
    testState.database = {
        characters: [],
        botPresets: [],
        modules: [],
        optimizePluginMemory: true,
        pluginStorageGeneration: "bridge-generation",
        pluginCustomStorage: { staleInline: { mustDisappear: true } },
        temperature: 10,
        theme: "default",
    };
    storageMocks.persistent.set(manifestKey, {
        version: 1,
        generation: "bridge-generation",
        valueKeys: [],
        metaKeys: [],
    });
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

    test.each([false, true])(
        "returns canonical detached pluginCustomStorage key order with optimized mode %s",
        async (optimized) => {
            const insertionOrder = [
                "beta",
                "10",
                "2",
                "01",
                "alpha",
                "�",
                "🔑",
                "0",
                "",
            ];
            const expected = ["0", "2", "10", "", "01", "alpha", "beta", "🔑", "�"];
            testState.database.optimizePluginMemory = optimized;
            testState.database.pluginCustomStorage = {};
            for (const key of insertionOrder) {
                if (optimized) storageMocks.persistent.set(storageKey(key), { key });
                else testState.database.pluginCustomStorage[key] = { key };
            }
            const bridge = createBridge();

            const snapshot = await bridge.getDatabase(["pluginCustomStorage"]);

            expect(Object.keys(snapshot.pluginCustomStorage)).toEqual(expected);
            expect(snapshot.pluginCustomStorage["🔑"]).toEqual({ key: "🔑" });
            expect(snapshot.pluginCustomStorage["�"]).toEqual({ key: "�" });
            expect(snapshot.pluginCustomStorage).not.toBe(testState.database.pluginCustomStorage);
        },
    );

    test.each([false, true])(
        "rejects malformed Unicode replacement keys before mutating optimized mode %s",
        async (optimized) => {
            testState.database.optimizePluginMemory = optimized;
            testState.database.pluginCustomStorage = { inlineExisting: { retained: true } };
            storageMocks.persistent.set(storageKey("externalExisting"), { retained: true });
            const beforePersistent = new Map(storageMocks.persistent);
            const beforeInline = cloneJson(testState.database.pluginCustomStorage);
            const malformed = {} as Record<string, unknown>;
            Object.defineProperty(malformed, "\uD800", {
                configurable: true,
                enumerable: true,
                value: { invalid: true },
                writable: true,
            });
            const bridge = createBridge();

            await expect(bridge.setDatabaseLite({
                pluginCustomStorage: malformed,
                temperature: 99,
            })).rejects.toThrow("well-formed Unicode");

            expect(testState.database.temperature).toBe(10);
            expect(testState.database.pluginCustomStorage).toEqual(beforeInline);
            expect(storageMocks.persistent).toEqual(beforePersistent);
        },
    );

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

        const malformedUnicode = {} as Record<string, unknown>;
        Object.defineProperty(malformedUnicode, "\uD800", {
            configurable: true,
            enumerable: true,
            value: true,
            writable: true,
        });
        expect(() => validateV3DatabaseMutationForTransport({
            pluginCustomStorage: malformedUnicode,
        })).toThrow("well-formed Unicode");
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
        storageMocks.removeGate = async (key) => {
            if (key === storageKey("clear-race")) {
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
        storageMocks.removeGate = null;
        expect(await getPluginSaveStorageSnapshot()).toEqual({ afterClear: true });
        expect(await getOwners("save")).toEqual({});
    });

    test("real bridge cancellation stops an exact replacement and releases queued storage", async () => {
        const plugin = {
            name: "Cancelled Database Plugin",
            script: "// cancelled database replacement",
            arguments: {},
            realArg: {},
            customLink: [],
            argMeta: {},
            version: "3.0",
            enabled: true,
        } as const;
        testState.database.plugins = [plugin];
        DBState.db = testState.database;
        storageMocks.persistent.set(storageKey("existing"), { source: "existing" });

        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        const api = makeRisuaiAPIV3(iframe, plugin as any) as any;
        // Resolve and cache the permission before timing the storage request.
        await api.setDatabaseLite({});

        let releaseWrite!: () => void;
        let markWriteStarted!: () => void;
        const blockedWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
        const writeStarted = new Promise<void>(resolve => { markWriteStarted = resolve; });
        storageMocks.writeGate = async (key, signal) => {
            if (key !== storageKey("replacement")) return;
            markWriteStarted();
            await awaitWithAbort(blockedWrite, signal);
        };

        const host = new SandboxHost(api);
        const startup = host.run(iframe, "").catch(() => undefined);
        const source = iframe.contentWindow!;
        const sent: any[] = [];
        const hostResponses: any[] = [];
        let registry!: ReturnType<typeof createV3BridgeRequestRegistry>;
        vi.spyOn(source, "postMessage").mockImplementation((message: any) => {
            if (message?.type === "RESPONSE") {
                hostResponses.push(message);
                registry.handleResponse(message);
            }
        });
        registry = createV3BridgeRequestRegistry({
            requestTimeoutMs: PLUGIN_BRIDGE_REQUEST_TIMEOUT_MS,
            serializeArgs: args => args,
            collectTransferables: () => [],
            send: message => {
                sent.push(message);
                window.dispatchEvent(new MessageEvent("message", {
                    source,
                    origin: "null",
                    data: message,
                }));
            },
            deserializeError: deserializeV3BridgeError,
            deserializeResult: value => value,
        });

        vi.useFakeTimers();
        try {
            const replacement = registry.sendRequest("CALL_ROOT", {
                method: "setDatabaseLite",
                args: [{
                    pluginCustomStorage: {
                        replacement: { source: "replacement" },
                    },
                    temperature: 99,
                }],
            }).catch(error => error);
            await writeStarted;

            let unrelatedSettled = false;
            const unrelated = getPluginSaveStorageItem("existing").then(value => {
                unrelatedSettled = true;
                return value;
            });
            let transitionSettled = false;
            const transitionBarrier = withPluginSaveStorageLock(async () => {
                transitionSettled = true;
            });
            await Promise.resolve();
            expect(unrelatedSettled).toBe(false);
            expect(transitionSettled).toBe(false);

            await vi.advanceTimersByTimeAsync(PLUGIN_BRIDGE_REQUEST_TIMEOUT_MS);
            await expect(replacement).resolves.toMatchObject({
                code: "COMMIT_OUTCOME_UNKNOWN",
                commitOutcomeUnknown: true,
                operation: "write",
            });
            await expect(unrelated).resolves.toEqual({ source: "existing" });
            await expect(transitionBarrier).resolves.toBeUndefined();

            expect(storageMocks.persistent.has(storageKey("replacement"))).toBe(false);
            expect(testState.database.temperature).toBe(10);
            expect(hostResponses).toEqual([]);
            expect(registry.pendingCount()).toBe(0);

            const reqId = sent.find(message => message.type === "CALL_ROOT")?.reqId;
            expect(sent).toContainEqual({ type: "CANCEL_REQUEST", reqId });
            expect(registry.handleResponse({
                type: "RESPONSE",
                reqId,
                result: "late",
            })).toBe(false);

            releaseWrite();
            await vi.advanceTimersByTimeAsync(0);
            expect(storageMocks.persistent.has(storageKey("replacement"))).toBe(false);
            expect(hostResponses).toEqual([]);

            storageMocks.writeGate = null;
            let releaseRead!: () => void;
            let markReadStarted!: () => void;
            const blockedRead = new Promise<void>(resolve => { releaseRead = resolve; });
            const readStarted = new Promise<void>(resolve => { markReadStarted = resolve; });
            storageMocks.readGate = async (key, signal) => {
                if (key !== storageKey("existing")) return;
                markReadStarted();
                await awaitWithAbort(blockedRead, signal);
            };

            const snapshot = registry.sendRequest("CALL_ROOT", {
                method: "getDatabase",
                args: [["pluginCustomStorage"]],
            }).catch(error => error);
            await readStarted;
            const queuedWrite = setPluginSaveStorageItem("unrelated", { available: true });

            await vi.advanceTimersByTimeAsync(PLUGIN_BRIDGE_REQUEST_TIMEOUT_MS);
            await expect(snapshot).resolves.toMatchObject({
                code: "STORAGE_TIMEOUT",
                commitOutcomeUnknown: false,
                retryable: true,
            });
            await expect(queuedWrite).resolves.toBeUndefined();
            expect(storageMocks.persistent.get(storageKey("unrelated")))
                .toEqual({ available: true });
            expect(hostResponses).toEqual([]);

            const getReqId = sent.find(message => message.type === "CALL_ROOT"
                && message.method === "getDatabase")?.reqId;
            expect(registry.handleResponse({
                type: "RESPONSE",
                reqId: getReqId,
                result: { pluginCustomStorage: { late: true } },
            })).toBe(false);
            releaseRead();
            await vi.advanceTimersByTimeAsync(0);
            expect(hostResponses).toEqual([]);
        } finally {
            storageMocks.writeGate = null;
            storageMocks.readGate = null;
            host.terminate();
            await startup;
            vi.useRealTimers();
        }
    });

    test("database cancellation stops a pending permission wait before mutation", async () => {
        const plugin = {
            name: "Permission Cancellation Plugin",
            script: "// permission cancellation",
            arguments: {},
            realArg: {},
            customLink: [],
            argMeta: {},
            version: "3.0",
            enabled: true,
        } as const;
        testState.database.plugins = [plugin];
        DBState.db = testState.database;
        let releaseDialog!: (allowed: boolean) => void;
        alertConfirmMock.mockImplementationOnce(() => new Promise<boolean>(resolve => {
            releaseDialog = resolve;
        }));
        const api = makeRisuaiAPIV3(document.createElement("iframe"), plugin as any) as any;
        const controller = new AbortController();

        const setting = api.setDatabaseLite(
            { temperature: 77 },
            controller.signal,
        );
        await vi.waitFor(() => expect(alertConfirmMock).toHaveBeenCalledOnce());
        controller.abort(new DOMException("cancelled permission", "AbortError"));

        await expect(setting).rejects.toMatchObject({ name: "AbortError" });
        releaseDialog(true);
        await Promise.resolve();
        expect(testState.database.temperature).toBe(10);

        alertConfirmMock.mockResolvedValueOnce(false);
        await api.setDatabaseLite({ temperature: 88 });
        expect(alertConfirmMock).toHaveBeenCalledTimes(2);
        expect(testState.database.temperature).toBe(10);
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

describe("V3 guest startup handshake", () => {
    test("watchdog cleans a timed-out production instance without harming its peer or reload", async () => {
        vi.useFakeTimers();
        const timedOut = startupPlugin("Timed Out Production Startup", `
            await risuai.addProvider("timed-residue", async () => ({ success: true, content: "bad" }));
            await new Promise(() => {});
        `);
        const healthy = startupPlugin("Healthy Production Startup", `
            await risuai.addProvider("healthy-provider", async () => ({ success: true, content: "ok" }));
        `);
        testState.database.plugins = [timedOut, healthy];
        DBState.db = testState.database;
        let restoreTimedOutRelay: (() => void) | undefined;
        let restoreHealthyRelay: (() => void) | undefined;
        let restoreReloadRelay: (() => void) | undefined;

        try {
            let generationSettled = false;
            const startedAt = Date.now();
            const loading = loadV3PluginGeneration([timedOut, healthy]);
            const loadingOutcome = loading.then(
                () => null,
                error => error,
            ).finally(() => {
                generationSettled = true;
            });
            const [timedOutIframe, healthyIframe] = [
                ...document.body.querySelectorAll("iframe"),
            ];
            restoreTimedOutRelay = executeGeneratedGuest(timedOutIframe);
            restoreHealthyRelay = executeGeneratedGuest(healthyIframe);
            const healthyInstance = getV3PluginInstance(healthy.name)!;
            await healthyInstance.initialization;

            expect(pluginV2.providers.has("timed-residue")).toBe(true);
            expect(pluginV2.providers.has("healthy-provider")).toBe(true);
            expect(getV3PluginInstance(timedOut.name)).toBeDefined();
            expect(getV3PluginInstance(healthy.name)).toBe(healthyInstance);
            expect(generationSettled).toBe(false);
            const elapsed = Date.now() - startedAt;
            expect(elapsed).toBeLessThan(PLUGIN_BRIDGE_INITIALIZATION_TIMEOUT_MS);

            await vi.advanceTimersByTimeAsync(
                PLUGIN_BRIDGE_INITIALIZATION_TIMEOUT_MS - elapsed - 1,
            );
            expect(generationSettled).toBe(false);
            expect(timedOutIframe.isConnected).toBe(true);
            expect(pluginV2.providers.has("timed-residue")).toBe(true);

            await vi.advanceTimersByTimeAsync(1);
            const failure = await loadingOutcome;

            expect(failure).toBeInstanceOf(AggregateError);
            expect(failure).toMatchObject({
                message: "One or more V3 plugins failed to initialize.",
                errors: [expect.objectContaining({
                    name: "PluginInitializationTimeoutError",
                    code: "PLUGIN_INITIALIZATION_TIMEOUT",
                    retryable: false,
                    commitOutcomeUnknown: false,
                    operation: "initialization",
                    message: `Plugin initialization timed out after ${PLUGIN_BRIDGE_INITIALIZATION_TIMEOUT_MS}ms.`,
                })],
            });
            expect(notifyErrorMock).toHaveBeenCalledOnce();
            expect(notifyErrorMock).toHaveBeenCalledWith(
                `Plugin "${timedOut.name}" failed to start.`,
                {
                    description: `Plugin initialization timed out after ${PLUGIN_BRIDGE_INITIALIZATION_TIMEOUT_MS}ms.`,
                    source: "plugin-startup",
                },
            );

            expect(timedOutIframe.isConnected).toBe(false);
            expect(getV3PluginInstance(timedOut.name)).toBeUndefined();
            expect(pluginV2.providers.has("timed-residue")).toBe(false);
            expect(pluginV2.providerOptions.has("timed-residue")).toBe(false);
            expect(get(customProviderStore)).not.toContain("timed-residue");
            expect(customV3ProviderMetaStore.some(
                model => model.id === "pluginmodel:::timed-residue",
            )).toBe(false);

            expect(healthyIframe.isConnected).toBe(true);
            expect(getV3PluginInstance(healthy.name)).toBe(healthyInstance);
            expect(pluginV2.providers.has("healthy-provider")).toBe(true);
            expect(pluginV2.providerOptions.has("healthy-provider")).toBe(true);
            expect(get(customProviderStore)).toContain("healthy-provider");
            expect(customV3ProviderMetaStore.some(
                model => model.id === "pluginmodel:::healthy-provider",
            )).toBe(true);

            const reloaded = startupPlugin(timedOut.name, `
                await risuai.addProvider("reloaded-provider", async () => ({ success: true, content: "recovered" }));
            `);
            const reload = loadV3PluginGeneration([reloaded]);
            const reloadIframe = [...document.body.querySelectorAll("iframe")]
                .find(iframe => iframe !== healthyIframe)!;
            restoreReloadRelay = executeGeneratedGuest(reloadIframe);
            await reload;

            expect(getV3PluginInstance(timedOut.name)).toBeDefined();
            expect(pluginV2.providers.has("reloaded-provider")).toBe(true);
            expect(pluginV2.providers.has("timed-residue")).toBe(false);
            expect(notifyErrorMock).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
            await teardownV3Plugins().catch(() => undefined);
            restoreReloadRelay?.();
            restoreHealthyRelay?.();
            restoreTimedOutRelay?.();
        }
    });

    test("teardown closes registration before awaiting a hanging pre-ready unload callback", async () => {
        const startupReadStarted = deferred();
        const releaseStartupRead = deferred();
        const preprocessorCount = getTTSPreprocessors().length;
        installManifestOwnedStartupKeys("startup-held");
        storageMocks.readGate = async (key) => {
            if (key === storageKey("startup-held")) {
                startupReadStarted.resolve();
                await releaseStartupRead.promise;
            }
        };
        const plugin = startupPlugin("Teardown Before Ready", `
            globalThis.callbackCount = 0;
            const callback = async (value) => {
                globalThis.callbackCount += 1;
                return value;
            };
            await risuai.addProvider("pre-unload-provider", async () => {
                globalThis.callbackCount += 1;
                return { success: true, content: "unexpected" };
            });
            await risuai.addRisuScriptHandler("display", callback);
            await risuai.addTTSPreprocessor(callback);
            await risuai.addPluginChannelListener("pre-unload-channel", callback);
            await risuai.onUnload(async () => {
                globalThis.unloadStarted = true;
                await new Promise(() => {});
            });
            await risuai.pluginStorage.getItem("startup-held");
            try {
                await risuai.pluginStorage.setItem("late-write", { durable: true });
            } catch (error) {
                globalThis.lateWriteRejected = true;
            }
            try {
                await risuai.addProvider("too-late-provider", async () => ({ success: true, content: "late" }));
            } catch (error) {
                globalThis.lateRegistrationRejected = true;
            }
        `);
        testState.database.plugins = [plugin];
        DBState.db = testState.database;
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        const loading = loadV3PluginGeneration([plugin]);
        const loadingOutcome = loading.then(
            () => null,
            error => error,
        );
        const iframe = document.body.querySelector("iframe")!;
        const restoreRelay = executeGeneratedGuest(iframe);
        await startupReadStarted.promise;
        const capturedProvider = pluginV2.providers.get("pre-unload-provider")!;
        const capturedScriptHandler = [...pluginV2.editdisplay][0];
        const capturedPreprocessor = getTTSPreprocessors()[preprocessorCount];
        const channelKey = `${plugin.name}pre-unload-channel`;
        const capturedChannel = pluginChannel.get(channelKey)!;

        const teardown = teardownV3Plugins();
        await vi.waitFor(() => expect((iframe.contentWindow as any).unloadStarted).toBe(true));
        expect(getV3PluginInstance(plugin.name)).toBeUndefined();
        expect(pluginV2.providers.has("pre-unload-provider")).toBe(false);
        expect(pluginV2.editdisplay.size).toBe(0);
        expect(getTTSPreprocessors()).toHaveLength(preprocessorCount);
        expect(pluginChannel.has(channelKey)).toBe(false);
        expect(pluginV2.providers.has("too-late-provider")).toBe(false);
        await expect(capturedProvider({} as any)).rejects.toThrow("terminating");
        expect(() => capturedScriptHandler("")).toThrow("terminating");
        expect(() => capturedPreprocessor({
            text: "detached",
            ttsMode: "test",
            characterId: "test",
        })).toThrow("terminating");
        expect(() => capturedChannel("detached")).toThrow("terminating");
        expect((iframe.contentWindow as any).callbackCount).toBe(0);

        releaseStartupRead.resolve();
        await vi.waitFor(() => {
            expect((iframe.contentWindow as any).lateWriteRejected).toBe(true);
            expect((iframe.contentWindow as any).lateRegistrationRejected).toBe(true);
        });
        expect(storageMocks.persistent.has(storageKey("late-write"))).toBe(false);
        expect(pluginV2.providers.has("too-late-provider")).toBe(false);
        await teardown;
        const loadingError = await loadingOutcome;

        expect(loadingError).toBeInstanceOf(AggregateError);
        expect(pluginV2.providers.has("too-late-provider")).toBe(false);
        expect(get(customProviderStore)).not.toContain("too-late-provider");
        expect(logSpy.mock.calls.some(([message]) =>
            String(message).includes(`[RisuAI Plugin: ${plugin.name}] Loaded API V3 plugin.`),
        )).toBe(false);
        expect(iframe.isConnected).toBe(false);
        restoreRelay();
        errorSpy.mockRestore();
        logSpy.mockRestore();
    });

    test("keeps a plugin generation pending until delayed storage finishes before registration", async () => {
        const readStarted = deferred();
        const releaseRead = deferred();
        const postRegistrationReadStarted = deferred();
        const releasePostRegistrationRead = deferred();
        storageMocks.persistent.set(storageKey("startup-config"), { enabled: true });
        installManifestOwnedStartupKeys("startup-config", "post-registration");
        storageMocks.readGate = async (key) => {
            if (key === storageKey("startup-config")) {
                readStarted.resolve();
                await releaseRead.promise;
            }
            if (key === storageKey("post-registration")) {
                postRegistrationReadStarted.resolve();
                await releasePostRegistrationRead.promise;
            }
        };
        const plugin = startupPlugin("Delayed Startup", `
            await risuai.pluginStorage.getItem("startup-config");
            await risuai.addProvider("delayed-provider", async () => ({ success: true, content: "ok" }));
            await risuai.pluginStorage.getItem("post-registration");
        `);

        let generationSettled = false;
        const loading = loadV3PluginGeneration([plugin]);
        void loading.then(
            () => { generationSettled = true; },
            () => { generationSettled = true; },
        );
        const iframe = document.body.querySelector("iframe");
        expect(iframe).toBeInstanceOf(HTMLIFrameElement);
        const restoreRelay = executeGeneratedGuest(iframe!);

        await readStarted.promise;
        expect(generationSettled).toBe(false);
        expect(pluginV2.providers.has("delayed-provider")).toBe(false);

        releaseRead.resolve();
        await postRegistrationReadStarted.promise;
        expect(pluginV2.providers.has("delayed-provider")).toBe(true);
        expect(generationSettled).toBe(false);

        releasePostRegistrationRead.resolve();
        await loading;

        expect(pluginV2.providers.has("delayed-provider")).toBe(true);
        expect(getV3PluginInstance(plugin.name)).toBeDefined();
        expect(notifyErrorMock).not.toHaveBeenCalled();
        restoreRelay();
    });

    test("waits for every guest, reports rejection visibly, and never logs the failed guest as loaded", async () => {
        const slowReadStarted = deferred();
        const releaseSlowRead = deferred();
        installManifestOwnedStartupKeys("rejected-config", "slow-config");
        storageMocks.readGate = async (key) => {
            if (key === storageKey("rejected-config")) {
                throw new Error("optimized storage unavailable");
            }
            if (key === storageKey("slow-config")) {
                slowReadStarted.resolve();
                await releaseSlowRead.promise;
            }
        };
        const rejected = startupPlugin("Rejected Startup", `
            await risuai.pluginStorage.getItem("rejected-config");
            await risuai.addProvider("rejected-provider", async () => ({ success: true, content: "bad" }));
        `);
        const slow = startupPlugin("Slow Startup", `
            await risuai.pluginStorage.getItem("slow-config");
            await risuai.addProvider("slow-provider", async () => ({ success: true, content: "ok" }));
        `);
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        let generationSettled = false;
        const loading = loadV3PluginGeneration([rejected, slow]);
        void loading.then(
            () => { generationSettled = true; },
            () => { generationSettled = true; },
        );
        const iframes = [...document.body.querySelectorAll("iframe")];
        expect(iframes).toHaveLength(2);
        const restoreRejectedRelay = executeGeneratedGuest(iframes[0]);
        const restoreSlowRelay = executeGeneratedGuest(iframes[1]);
        await slowReadStarted.promise;
        await vi.waitFor(() => expect(notifyErrorMock).toHaveBeenCalledOnce());
        expect(generationSettled).toBe(false);
        expect(pluginV2.providers.has("slow-provider")).toBe(false);
        expect(pluginV2.providers.has("rejected-provider")).toBe(false);
        expect(getV3PluginInstance(rejected.name)).toBeUndefined();
        expect(logSpy.mock.calls.some(([message]) =>
            String(message).includes(`[RisuAI Plugin: ${rejected.name}] Loaded API V3 plugin.`),
        )).toBe(false);

        releaseSlowRead.resolve();
        await expect(loading).rejects.toThrow("One or more V3 plugins failed to initialize.");

        expect(pluginV2.providers.has("slow-provider")).toBe(true);
        expect(getV3PluginInstance(slow.name)).toBeDefined();
        expect(notifyErrorMock).toHaveBeenCalledWith(
            `Plugin "${rejected.name}" failed to start.`,
            expect.objectContaining({
                description: "optimized storage unavailable",
                source: "plugin-startup",
            }),
        );
        restoreRejectedRelay();
        restoreSlowRelay();
        errorSpy.mockRestore();
        logSpy.mockRestore();
    });

    test("reject-after-register rolls back every plugin-owned registration", async () => {
        const preprocessorCount = getTTSPreprocessors().length;
        const postprocessorCount = getTTSPostprocessors().length;
        const disconnectSpy = vi.spyOn(MutationObserver.prototype, "disconnect");
        const removeEventListenerSpy = vi.spyOn(document, "removeEventListener");
        installManifestOwnedStartupKeys("fail-after-register");
        storageMocks.readGate = async (key) => {
            if (key === storageKey("fail-after-register")) {
                throw new Error("late startup rejection");
            }
        };
        const plugin = startupPlugin("Residue Startup", `
            const callback = async (value) => value;
            await risuai.addProvider("residue-provider", async () => ({ success: true, content: "bad" }));
            await risuai.addRisuScriptHandler("display", callback);
            await risuai.addRisuReplacer("beforeRequest", callback);
            await risuai.addTTSPreprocessor(callback);
            await risuai.addTTSPostprocessor(callback);
            await risuai.registerSetting("Residue", callback, "", "none", "residue-setting");
            await risuai.registerButton({ name: "Residue", icon: "", iconType: "none", id: "residue-button" }, callback);
            await risuai.registerBodyIntercepter(callback);
            await risuai.setChatPanel("residue", { id: "residue-panel" });
            await risuai.registerMCP(
                { identifier: "plugin:residue", name: "Residue", version: "1", description: "test" },
                async () => [],
                async () => []
            );
            await risuai.addPluginChannelListener("channel", callback);
            const root = await risuai.getRootDocument();
            await root.addEventListener("click", callback);
            const observer = await risuai.createMutationObserver(callback);
            await observer.observe(root, { childList: true });
            await risuai.pluginStorage.getItem("fail-after-register");
        `);
        testState.database.plugins = [plugin];
        DBState.db = testState.database;
        const loading = loadV3PluginGeneration([plugin]);
        const iframe = document.body.querySelector("iframe")!;
        const restoreRelay = executeGeneratedGuest(iframe);

        await expect(loading).rejects.toThrow("One or more V3 plugins failed to initialize.");

        expect(getV3PluginInstance(plugin.name)).toBeUndefined();
        expect(pluginV2.providers.has("residue-provider")).toBe(false);
        expect(pluginV2.providerOptions.has("residue-provider")).toBe(false);
        expect(get(customProviderStore)).not.toContain("residue-provider");
        expect(customV3ProviderMetaStore.some(model => model.id === "pluginmodel:::residue-provider"))
            .toBe(false);
        expect(pluginV2.editdisplay.size).toBe(0);
        expect(pluginV2.replacerbeforeRequest.size).toBe(0);
        expect(getTTSPreprocessors()).toHaveLength(preprocessorCount);
        expect(getTTSPostprocessors()).toHaveLength(postprocessorCount);
        expect(additionalSettingsMenu.some(item => item.id === "residue-setting")).toBe(false);
        expect(additionalFloatingActionButtons.some(item => item.id === "residue-button")).toBe(false);
        expect(bodyIntercepterStore).toHaveLength(0);
        expect(chatPanelStore.some(item => item.id === "residue-panel")).toBe(false);
        expect(registeredCustomPluginMCPs.has("plugin:residue")).toBe(false);
        expect(pluginChannel.has(`${plugin.name}channel`)).toBe(false);
        expect(disconnectSpy).toHaveBeenCalled();
        expect(removeEventListenerSpy.mock.calls.some(([type]) => type === "click")).toBe(true);
        expect(iframe.isConnected).toBe(false);
        restoreRelay();
        disconnectSpy.mockRestore();
        removeEventListenerSpy.mockRestore();
    });
});
