import { beforeEach, describe, expect, test, vi } from "vitest";
import { awaitWithAbort, throwIfAborted } from "../../storage/abort";

const storageMocks = vi.hoisted(() => ({
    persistent: new Map<string, unknown>(),
    readGate: null as null | ((key: string, signal?: AbortSignal | null) => Promise<void>),
    writeGate: null as null | ((key: string, signal?: AbortSignal | null) => Promise<void>),
    removeGate: null as null | ((key: string, signal?: AbortSignal | null) => Promise<void>),
    clearGate: null as null | ((prefix: string, signal?: AbortSignal | null) => Promise<void>),
    batchGate: null as null | ((signal?: AbortSignal | null, request?: any) => Promise<void>),
    batchCalls: 0,
    batchApplyBeforeGate: false,
    revisionOverrides: new Map<string, string>(),
}));
const alertConfirmMock = vi.hoisted(() => vi.fn(async () => true));
const notifyErrorMock = vi.hoisted(() => vi.fn());
const notifyWarningMock = vi.hoisted(() => vi.fn());
const nativeConsoleWarnMock = vi.hoisted(() => vi.fn());
const dirtyTargetMocks = vi.hoisted(() => ({
    markCharacterDirty: vi.fn(),
    markChatDirty: vi.fn(),
}));
const unloadFinalizationMocks = vi.hoisted(() => ({
    fetchNative: vi.fn(async () => ({ status: 204 })),
    globalFetch: vi.fn(async () => ({ ok: true, status: 204 })),
    saveAsset: vi.fn(async () => "assets/finalized.png"),
}));
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
const FORMER_BRIDGE_DEADLINE_MS = 30 * 60_000;

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
    fetchNative: unloadFinalizationMocks.fetchNative,
    forageStorage: { realStorage: null },
    getFetchLogs: vi.fn(async () => []),
    globalFetch: unloadFinalizationMocks.globalFetch,
    markCharacterDirty: dirtyTargetMocks.markCharacterDirty,
    markChatDirty: dirtyTargetMocks.markChatDirty,
    readImage: vi.fn(),
    requestImmediateSave: vi.fn(),
    saveAsset: unloadFinalizationMocks.saveAsset,
    toGetter: (getter: () => unknown) => ({ get value() { return getter(); } }),
}));

vi.mock("../../storage/chatStorage", () => ({ chatToStub: (chat: unknown) => chat }));

vi.mock("src/ts/gui/colorscheme", () => ({
    changeColorScheme: vi.fn((name: string) => {
        testState.database.colorSchemeName = name;
    }),
    updateColorScheme: vi.fn(),
    updateTextThemeAndCSS: vi.fn(),
}));

vi.mock("../../storage/persistentKv", async () => {
    const { serializeJsonValueToUtf8 } = await import("../../storage/jsonValue");
    const writePersistentJson = async (
        key: string,
        value: unknown,
        signal?: AbortSignal | null,
    ) => {
        await storageMocks.writeGate?.(key, signal);
        throwIfAborted(signal);
        storageMocks.persistent.set(key, cloneJson(value));
    };
    return {
    batchPersistentPluginStorage: async (request: any, signal?: AbortSignal | null) => {
        storageMocks.batchCalls += 1;
        const generation = crypto.randomUUID();
        const apply = () => {
            for (const operation of request.operations) {
                const valueKey = `pluginsave/${encodeKey(operation.key)}.json`;
                const ownerKey = `pluginsave-meta/${encodeKey(operation.key)}.json`;
                if (operation.operation === "set") {
                    storageMocks.persistent.set(
                        valueKey,
                        JSON.parse(new TextDecoder().decode(operation.valueBytes)),
                    );
                    storageMocks.persistent.set(ownerKey, {
                        plugin: operation.owner,
                        updatedAt: Date.now(),
                        generation,
                    });
                } else {
                    storageMocks.persistent.delete(valueKey);
                    storageMocks.persistent.delete(ownerKey);
                }
            }
            const currentManifest = storageMocks.persistent.get(manifestKey) as any;
            const valueKeys = new Set<string>(currentManifest?.valueKeys ?? []);
            const metaKeys = new Set<string>(currentManifest?.metaKeys ?? []);
            for (const operation of request.operations) {
                const valueKey = `pluginsave/${encodeKey(operation.key)}.json`;
                const ownerKey = `pluginsave-meta/${encodeKey(operation.key)}.json`;
                if (operation.operation === "set") {
                    valueKeys.add(valueKey);
                    metaKeys.add(ownerKey);
                } else {
                    valueKeys.delete(valueKey);
                    metaKeys.delete(ownerKey);
                }
            }
            storageMocks.persistent.set(manifestKey, {
                version: 1,
                generation: request.generation,
                valueKeys: [...valueKeys].sort(),
                metaKeys: [...metaKeys].sort(),
            });
        };
        if (storageMocks.batchApplyBeforeGate) apply();
        await storageMocks.batchGate?.(signal, request);
        throwIfAborted(signal);
        if (!storageMocks.batchApplyBeforeGate) apply();
        return {
            outcome: "committed" as const,
            generation,
            revisions: request.operations.map((operation: any) => ({
                key: operation.key,
                revision: operation.operation === "set" ? `sha256:${"a".repeat(64)}` : null,
                valueHash: operation.operation === "set" ? "b".repeat(64) : null,
            })),
        };
    },
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
            storageMocks.persistent.set(
                write.storageKey,
                JSON.parse(new TextDecoder().decode(write.valueBytes)),
            );
        }
        for (const key of mutation.deletes) {
            await storageMocks.removeGate?.(key, signal);
            throwIfAborted(signal);
            storageMocks.persistent.delete(key);
        }
        storageMocks.persistent.set(manifestKey, cloneJson(mutation.nextManifest));
    },
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
        _generation?: string,
        prepared?: { bytes: Uint8Array },
    ) => {
        const activeSignal = operation === "remove"
            ? valueOrSignal as AbortSignal | null | undefined
            : signal;
        const encoded = valueKey.slice("pluginsave/".length, -".json".length);
        const ownerKey = `pluginsave-meta/${encoded}.json`;
        if (operation === "set") {
            await storageMocks.writeGate?.(valueKey, activeSignal);
            throwIfAborted(activeSignal);
            storageMocks.persistent.set(
                valueKey,
                prepared
                    ? JSON.parse(new TextDecoder().decode(prepared.bytes))
                    : cloneJson(valueOrSignal),
            );
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
    readPersistentPluginStorageState: async (
        valueKey: string,
        signal?: AbortSignal | null,
    ) => {
        await storageMocks.readGate?.(valueKey, signal);
        throwIfAborted(signal);
        const value = storageMocks.persistent.get(valueKey);
        return value === undefined
            ? { status: "missing" as const, value: null, revision: null, generation: null }
            : {
                status: "value" as const,
                value: cloneJson(value),
                revision: storageMocks.revisionOverrides.get(valueKey)
                    ?? `sha256:${"b".repeat(64)}`,
                generation: null,
            };
    },
    readPersistentPluginStorageManifestSnapshot: async (generation: string) => {
        const manifest = {
            version: 1,
            generation,
            valueKeys: [...storageMocks.persistent.keys()].filter(
                candidate => candidate.startsWith("pluginsave/"),
            ),
            metaKeys: [...storageMocks.persistent.keys()].filter(
                candidate => candidate.startsWith("pluginsave-meta/"),
            ),
        };
        return {
            generation,
            manifestRevision: `sha256:${"c".repeat(64)}`,
            manifest,
            valueKeys: manifest.valueKeys.filter((key: string) => storageMocks.persistent.has(key)),
            metaKeys: manifest.metaKeys.filter((key: string) => storageMocks.persistent.has(key)),
        };
    },
    readPersistentPluginStorageManifestState: async (generation: string) => ({
        generation,
        manifestRevision: `sha256:${"c".repeat(64)}`,
    }),
    removePersistentPluginStoragePreservingOwner: async (key: string) => {
        storageMocks.persistent.delete(key);
        return {
            outcome: "committed" as const,
            operation: "remove" as const,
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
        setPreparedPersistentPluginStoragePreservingOwner: async (
            key: string,
            prepared: { bytes: Uint8Array },
            signal?: AbortSignal | null,
        ) => {
            await storageMocks.writeGate?.(key, signal);
            throwIfAborted(signal);
            storageMocks.persistent.set(
                key,
                JSON.parse(new TextDecoder().decode(prepared.bytes)),
            );
            return {
                outcome: "committed" as const,
                operation: "set" as const,
                verification: "verified" as const,
            };
        },
        writePersistentJson,
        preparePersistentJson: (value: unknown, options?: unknown) => {
            const bytes = serializeJsonValueToUtf8(value, options as never);
            return { bytes, byteLength: bytes.byteLength };
        },
        writePreparedPersistentJson: async (
            key: string,
            prepared: { bytes: Uint8Array },
            signal?: AbortSignal | null,
        ) => writePersistentJson(
            key,
            JSON.parse(new TextDecoder().decode(prepared.bytes)),
            signal,
        ),
    };
});

vi.mock("../../alert", () => ({
    alertConfirm: alertConfirmMock,
    alertError: vi.fn(),
    alertNormal: vi.fn(),
    notifyError: notifyErrorMock,
    notifyWarning: notifyWarningMock,
}));

vi.mock("../../log-capture", () => ({
    nativeConsoleError: vi.fn(),
    nativeConsoleWarn: nativeConsoleWarnMock,
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
    PLUGIN_PERMISSION_DENIED_CODE,
    customV3ProviderMetaStore,
    getV3PluginInstance,
    loadV3PluginGeneration,
    loadV3PluginGenerationOutcomes,
    loadV3Plugins,
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
    SandboxHost,
    createV3BridgeRequestRegistry,
    deserializeV3BridgeError,
    snapshotV3PluginStorageBatchForTransport,
    validateV3DatabaseMutationForTransport,
} = await import("./factory");
const { withPluginLifecycleLock } = await import("../pluginMemoryOptimization");
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
    storageMocks.batchGate = null;
    storageMocks.batchCalls = 0;
    storageMocks.batchApplyBeforeGate = false;
    storageMocks.revisionOverrides.clear();
    alertConfirmMock.mockClear();
    notifyErrorMock.mockClear();
    notifyWarningMock.mockClear();
    nativeConsoleWarnMock.mockClear();
    dirtyTargetMocks.markCharacterDirty.mockClear();
    dirtyTargetMocks.markChatDirty.mockClear();
    unloadFinalizationMocks.fetchNative.mockClear();
    unloadFinalizationMocks.globalFetch.mockClear();
    unloadFinalizationMocks.saveAsset.mockClear();
    pluginV2.providers.clear();
    pluginV2.providerOptions.clear();
    pluginV2.editdisplay.clear();
    pluginV2.editinput.clear();
    pluginV2.editoutput.clear();
    pluginV2.editprocess.clear();
    pluginV2.replacerbeforeRequest.clear();
    pluginV2.replacerafterRequest.clear();
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
    test("schedules a non-selected character replacement without changing index API behavior", () => {
        const plugin = startupPlugin("Targeted character setter", "");
        testState.database.characters = [
            { chaId: "char-a", name: "A", chats: [] },
            { chaId: "char-b", name: "B", chats: [] },
        ];
        testState.database.plugins = [plugin];
        DBState.db = testState.database;
        const api = makeRisuaiAPIV3(document.createElement("iframe"), plugin as any) as any;

        const result = api.setCharacterToIndex(1, {
            chaId: "char-b",
            name: "B updated",
            chats: [],
        });

        expect(result).toBeUndefined();
        expect(testState.database.characters[1].name).toBe("B updated");
        expect(dirtyTargetMocks.markCharacterDirty).toHaveBeenCalledWith("char-b");
        expect(dirtyTargetMocks.markChatDirty).not.toHaveBeenCalled();
    });

    test("schedules an inactive full chat row and its changed stub metadata", () => {
        const plugin = startupPlugin("Targeted chat setter", "");
        testState.database.characters = [{
            chaId: "char-a",
            name: "A",
            chats: [{
                id: "chat-a",
                name: "Old",
                note: "",
                localLore: [],
                message: [{ role: "user", data: "before" }],
            }],
        }];
        testState.database.plugins = [plugin];
        DBState.db = testState.database;
        const api = makeRisuaiAPIV3(document.createElement("iframe"), plugin as any) as any;

        api.setChatToIndex(0, 0, {
            id: "chat-a",
            name: "After",
            note: "",
            localLore: [],
            modules: ["module-a"],
            message: [{ role: "user", data: "after" }],
        });

        expect(dirtyTargetMocks.markCharacterDirty).toHaveBeenCalledWith("char-a");
        expect(dirtyTargetMocks.markChatDirty).toHaveBeenCalledWith("char-a", "chat-a");
    });

    test("never schedules a lazy placeholder as an authoritative chat row", () => {
        const plugin = startupPlugin("Placeholder-safe chat setter", "");
        testState.database.characters = [{
            chaId: "char-a",
            name: "A",
            chats: [{
                id: "chat-a",
                name: "Old",
                note: "",
                localLore: [],
                message: [],
                _placeholder: true,
            }],
        }];
        testState.database.plugins = [plugin];
        DBState.db = testState.database;
        const api = makeRisuaiAPIV3(document.createElement("iframe"), plugin as any) as any;

        api.setChatToIndex(0, 0, {
            ...testState.database.characters[0].chats[0],
            modules: ["module-a"],
        });

        expect(dirtyTargetMocks.markCharacterDirty).toHaveBeenCalledWith("char-a");
        expect(dirtyTargetMocks.markChatDirty).not.toHaveBeenCalled();
    });

    test("whole-database character replacement schedules only changed targets", async () => {
        const plugin = startupPlugin("Targeted database setter", "");
        testState.database.characters = [{
            chaId: "char-a",
            name: "A",
            chats: [{
                id: "chat-a",
                name: "Chat",
                note: "",
                localLore: [],
                message: [{ role: "user", data: "before" }],
            }],
        }];
        testState.database.plugins = [plugin];
        DBState.db = testState.database;
        const api = makeRisuaiAPIV3(document.createElement("iframe"), plugin as any) as any;
        const replacement = cloneJson(testState.database.characters);
        replacement[0].chats[0].message[0].data = "after";

        await api.setDatabaseLite({ characters: replacement });

        expect(dirtyTargetMocks.markCharacterDirty).not.toHaveBeenCalled();
        expect(dirtyTargetMocks.markChatDirty).toHaveBeenCalledWith("char-a", "chat-a");
    });

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

    test.each(["runLLMModel", "sendChat"] as const)(
        "forwards the bridge-owned signal through %s",
        async method => {
            const plugin = startupPlugin("Cancelled Model Work", "");
            testState.database.plugins = [plugin];
            const api = makeRisuaiAPIV3(
                document.createElement("iframe"),
                plugin as any,
            ) as any;
            const controller = new AbortController();
            const cancellation = new DOMException("Bridge lifecycle ended", "AbortError");
            controller.abort(cancellation);

            const operation = method === "runLLMModel"
                ? api.runLLMModel(
                    { mode: "main", messages: [] },
                    undefined,
                    controller.signal,
                )
                : api.sendChat("hello", undefined, controller.signal);

            await expect(operation).rejects.toBe(cancellation);
        },
    );

    test("shows one actionable notification when optimized storage rejects a plugin value", async () => {
        const plugin = startupPlugin("Legacy Value Plugin", "");
        testState.database.plugins = [plugin];
        const api = makeRisuaiAPIV3(document.createElement("iframe"), plugin as any) as any;

        await expect(api._setPluginStorage("unsupported-map", new Map([["key", "value"]])))
            .rejects.toMatchObject({
                name: "StorageError",
                code: "PLUGIN_STORAGE_VALUE_UNSUPPORTED",
                status: 400,
                retryable: false,
                commitOutcomeUnknown: false,
            });
        await expect(api._setPluginStorage("unsupported-set", new Set(["value"])))
            .rejects.toMatchObject({ code: "PLUGIN_STORAGE_VALUE_UNSUPPORTED" });

        expect(notifyErrorMock).toHaveBeenCalledOnce();
        expect(notifyErrorMock).toHaveBeenCalledWith(
            `Plugin "${plugin.name}" could not save its data.`,
            {
                description: expect.stringContaining(
                    "Use only JSON-compatible data: null, booleans, finite numbers, strings, dense arrays, and plain objects.",
                ),
                source: "plugin-storage",
            },
        );
    });

    test("keeps structured-clone values compatible without storage optimization", async () => {
        const plugin = startupPlugin("Structured Clone Plugin", "");
        testState.database.optimizePluginMemory = false;
        testState.database.pluginStorageGeneration = undefined;
        testState.database.pluginCustomStorage = {};
        testState.database.plugins = [plugin];
        const api = makeRisuaiAPIV3(document.createElement("iframe"), plugin as any) as any;
        const value = {
            createdAt: new Date("2026-01-02T03:04:05.000Z"),
            lookup: new Map([["key", "value"]]),
            exact: 1n,
        };

        await expect(api._setPluginStorage("legacy-value", value))
            .resolves.toBeUndefined();
        await expect(api._getPluginStorage("legacy-value")).resolves.toEqual(value);
        expect(notifyErrorMock).not.toHaveBeenCalled();
        expect(storageMocks.persistent.size).toBe(1); // Existing manifest only.
    });

    test("carries network, import, session, and ack-loss mutation outcomes through the guest bridge", async () => {
        const calls = new Map<string, number>();
        const count = (key: string) => calls.set(key, (calls.get(key) ?? 0) + 1);
        storageMocks.writeGate = async (key) => {
            count(key);
            if (key === storageKey("network-set")) throw new TypeError("network unavailable");
            if (key === storageKey("import-set")) {
                throw Object.assign(new Error("import owns storage"), {
                    outcome: "not-committed",
                    code: "IMPORT_IN_PROGRESS",
                    status: 503,
                    retryAfter: 1,
                    retryable: true,
                    commitOutcomeUnknown: false,
                });
            }
        };
        storageMocks.removeGate = async (key) => {
            count(key);
            if (key === storageKey("session-remove")) {
                throw Object.assign(new Error("session expired"), {
                    outcome: "not-committed",
                    code: "AUTH_REQUIRED",
                    status: 401,
                    retryable: false,
                    commitOutcomeUnknown: false,
                });
            }
            if (key === storageKey("ack-remove")) {
                throw Object.assign(new Error("remove response lost"), {
                    outcome: "unknown",
                    code: "COMMIT_OUTCOME_UNKNOWN",
                    commitOutcomeUnknown: true,
                });
            }
        };
        const plugin = startupPlugin("Mutation Outcome Bridge", `
            globalThis.networkSet = await risuai.pluginStorage.setItemWithOutcome(
                "network-set", "attempted"
            );
            globalThis.importSet = await risuai.pluginStorage.setItemWithOutcome(
                "import-set", "attempted"
            );
            globalThis.sessionRemove = await risuai.pluginStorage.removeItemWithOutcome(
                "session-remove"
            );
            globalThis.ackRemove = await risuai.pluginStorage.removeItemWithOutcome(
                "ack-remove"
            );
        `);
        const loading = loadV3PluginGeneration([plugin]);
        const iframe = document.body.querySelector("iframe")!;
        const restoreRelay = executeGeneratedGuest(iframe);
        try {
            await loading;
            await getV3PluginInstance(plugin.name)!.lifetime;
            const guest = iframe.contentWindow as any;
            expect(guest.networkSet).toMatchObject({
                outcome: "unknown",
                operation: "set",
                commitOutcomeUnknown: true,
            });
            expect(guest.importSet).toMatchObject({
                outcome: "not-committed",
                operation: "set",
                code: "IMPORT_IN_PROGRESS",
                retryable: true,
            });
            expect(guest.sessionRemove).toMatchObject({
                outcome: "not-committed",
                operation: "remove",
                code: "AUTH_REQUIRED",
            });
            expect(guest.ackRemove).toMatchObject({
                outcome: "unknown",
                operation: "remove",
                code: "COMMIT_OUTCOME_UNKNOWN",
            });
            for (const key of ["network-set", "import-set", "session-remove", "ack-remove"]) {
                expect(calls.get(storageKey(key))).toBe(1);
            }
        } finally {
            restoreRelay();
            await teardownV3Plugins();
        }
    });

    test("confirmed remove reports a stale authoritative reattach instead of reset success", async () => {
        const plugin = startupPlugin("Confirmed Remove", "");
        const api = makeRisuaiAPIV3(document.createElement("iframe"), plugin as any) as any;
        await api._setPluginStorage("dirty-row", { version: "old" });
        let reattached = false;
        storageMocks.readGate = async (key) => {
            if (key !== storageKey("dirty-row") || reattached) return;
            reattached = true;
            storageMocks.persistent.set(key, { version: "authoritative-reattach" });
        };

        const result = await api._removePluginStorageConfirmed("dirty-row");

        expect(result).toMatchObject({
            outcome: "unknown",
            operation: "remove",
            code: "PLUGIN_STORAGE_VALUE_PRESENT",
            mutationOutcome: "committed",
            authoritative: { status: "value" },
        });
        expect(await api._getPluginStorage("dirty-row")).toEqual({
            version: "authoritative-reattach",
        });
    });

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

        expect(await getPluginSaveStorageKeys()).toEqual(["cfg", "__proto__"]);
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
        "restores legacy custom database keys with a console-only notice in optimized mode %s",
        async (optimized) => {
            const plugin = startupPlugin(
                `Legacy database fallback ${optimized ? "optimized" : "inline"}`,
                "",
            );
            testState.database.optimizePluginMemory = optimized;
            testState.database.legacyPluginCompatibility = true;
            testState.database.pluginCustomStorage = {};
            testState.database.plugins = [plugin];
            DBState.db = testState.database;
            const api = makeRisuaiAPIV3(
                document.createElement("iframe"),
                plugin as any,
            ) as any;

            await api.setDatabaseLite({
                pluginCustomStorage: { directReplacement: { source: "database" } },
                firstLegacyKey: { source: "lite" },
                temperature: 21,
            });
            await api.setDatabase({
                secondLegacyKey: { source: "full" },
            });

            expect(await api._getPluginStorage("firstLegacyKey"))
                .toEqual({ source: "lite" });
            expect(await api._getPluginStorage("secondLegacyKey"))
                .toEqual({ source: "full" });
            expect(await api._getPluginStorage("directReplacement"))
                .toEqual({ source: "database" });
            expect(await getOwners("save")).toEqual({
                firstLegacyKey: plugin.name,
                secondLegacyKey: plugin.name,
            });
            expect(testState.database.temperature).toBe(21);
            expect(nativeConsoleWarnMock).toHaveBeenCalledOnce();
            expect(nativeConsoleWarnMock).toHaveBeenCalledWith(
                expect.stringContaining("used the legacy V3 database custom-key fallback"),
            );
            expect(notifyWarningMock).not.toHaveBeenCalled();
        },
    );

    test("keeps custom database keys strict when legacy compatibility is disabled", async () => {
        const plugin = startupPlugin("Strict database keys", "");
        testState.database.legacyPluginCompatibility = false;
        testState.database.plugins = [plugin];
        DBState.db = testState.database;
        const api = makeRisuaiAPIV3(document.createElement("iframe"), plugin as any) as any;

        await expect(api.setDatabaseLite({ unsupportedKey: true }))
            .rejects.toThrow("Unsupported V3 database key");

        expect(await api._getPluginStorage("unsupportedKey")).toBeNull();
        expect(nativeConsoleWarnMock).not.toHaveBeenCalled();
        expect(notifyWarningMock).not.toHaveBeenCalled();
    });

    test.each([false, true])(
        "returns legacy detached pluginCustomStorage key order with optimized mode %s",
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
            const expected = ["0", "2", "10", "beta", "01", "alpha", "�", "🔑", ""];
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
        "preserves malformed Unicode replacement keys in optimized mode %s",
        async (optimized) => {
            testState.database.optimizePluginMemory = optimized;
            testState.database.pluginCustomStorage = { inlineExisting: { retained: true } };
            storageMocks.persistent.set(storageKey("externalExisting"), { retained: true });
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
            })).resolves.toBeUndefined();

            const snapshot = await bridge.getDatabase(["pluginCustomStorage", "temperature"]);
            const snapshotStorage = snapshot.pluginCustomStorage as Record<string, unknown>;
            expect(snapshot.temperature).toBe(99);
            expect(Reflect.ownKeys(snapshotStorage)).toEqual(["\uD800"]);
            expect(snapshotStorage["\uD800"]).toEqual({ invalid: true });
            expect(snapshotStorage.externalExisting).toBeUndefined();
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
        })).not.toThrow();
    });

    test("guest atomicBatch transport snapshots values without invoking user code", () => {
        const getter = vi.fn(() => "evaluated");
        const toJSON = vi.fn(() => ({ replaced: true }));
        const value = { nested: { version: 1 } } as Record<string, unknown>;
        const operations = [{ type: "set", key: "body", value }];
        const detached = snapshotV3PluginStorageBatchForTransport(operations) as any[];
        (value.nested as any).version = 2;
        operations[0].key = "mutated";
        expect(detached).toEqual([{
            type: "set",
            key: "body",
            value: { nested: { version: 1 } },
        }]);

        const accessor = {};
        Object.defineProperty(accessor, "secret", { enumerable: true, get: getter });
        expect(() => snapshotV3PluginStorageBatchForTransport([
            { type: "set", key: "body", value: accessor },
        ])).toThrow("does not accept an accessor");
        expect(getter).not.toHaveBeenCalled();

        const customJson = { stable: true };
        Object.defineProperty(customJson, "toJSON", {
            enumerable: false,
            value: toJSON,
        });
        expect(() => snapshotV3PluginStorageBatchForTransport([
            { type: "set", key: "body", value: customJson },
        ])).toThrow("invalid property");
        expect(toJSON).not.toHaveBeenCalled();
    });

    test("guest atomicBatch transport rejects lossy descriptors and non-JSON values", () => {
        const hidden = { visible: true } as Record<PropertyKey, unknown>;
        Object.defineProperty(hidden, "hidden", { enumerable: false, value: true });
        const symbol = { visible: true } as Record<PropertyKey, unknown>;
        symbol[Symbol("hidden")] = true;
        const sparse = new Array(2);
        sparse[1] = true;
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        for (const value of [hidden, symbol, sparse, new Date(0), cyclic]) {
            expect(() => snapshotV3PluginStorageBatchForTransport([
                { type: "set", key: "body", value },
            ])).toThrow();
        }

        const operation = { type: "remove", key: "old" } as Record<PropertyKey, unknown>;
        operation[Symbol("hidden")] = true;
        expect(() => snapshotV3PluginStorageBatchForTransport([operation])).toThrow("symbol key");
        expect(() => snapshotV3PluginStorageBatchForTransport(new Array(1))).toThrow("dense");
        expect(snapshotV3PluginStorageBatchForTransport([
            { type: "set", key: "\uD800", value: true },
        ])).toEqual([{ type: "set", key: "\uD800", value: true }]);
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
        patcher.commit(patchResult);

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

            const replacementCancellation = new Error("Plugin bridge terminated.");
            registry.cancelAll(replacementCancellation);
            await expect(replacement).resolves.toBe(replacementCancellation);
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
            await Promise.resolve();
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

            const readCancellation = new Error("Plugin bridge terminated.");
            registry.cancelAll(readCancellation);
            await expect(snapshot).resolves.toBe(readCancellation);
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
            await Promise.resolve();
            expect(hostResponses).toEqual([]);
        } finally {
            storageMocks.writeGate = null;
            storageMocks.readGate = null;
            host.terminate();
            await startup;
        }
    });

    test("rejects forged and expired unload storage capabilities", async () => {
        const atomicBatch = vi.fn(async () => ({ committed: true }));
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        const host = new SandboxHost({
            _atomicBatchPluginStorage: atomicBatch,
        } as any);
        const startup = host.run(iframe, "").catch(() => undefined);
        const source = iframe.contentWindow!;
        const responses: any[] = [];
        vi.spyOn(source, "postMessage").mockImplementation((message: any) => {
            if (message?.type === "RESPONSE") responses.push(message);
        });
        host.beginTermination();
        expect(host.beginUnloadStorageAdmission()).toBe(true);
        const validToken = (host as any).unloadCapabilityToken as string;
        expect(validToken).toMatch(/^[0-9a-f-]{36}$/);
        const dispatch = (reqId: string, unloadToken: string) => {
            window.dispatchEvent(new MessageEvent("message", {
                source,
                origin: "null",
                data: {
                    type: "CALL_ROOT",
                    reqId,
                    method: "_atomicBatchPluginStorage",
                    args: [[{ type: "remove", key: "old" }], {
                        __type: "ABORT_SIGNAL_REF",
                        abortId: `abort-${reqId}`,
                        aborted: false,
                        unloadToken,
                    }],
                },
            }));
        };
        try {
            dispatch("forged", crypto.randomUUID());
            await vi.waitFor(() => expect(responses.some(response => (
                response.reqId === "forged" && response.error
            ))).toBe(true));
            expect(atomicBatch).not.toHaveBeenCalled();

            host.endUnloadStorageAdmission();
            dispatch("expired", validToken);
            await vi.waitFor(() => expect(responses.some(response => (
                response.reqId === "expired" && response.error
            ))).toBe(true));
            expect(atomicBatch).not.toHaveBeenCalled();
        } finally {
            host.terminate();
            await startup;
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
    });

    test.each([
        {
            method: "setDatabaseLite",
            mutation: { temperature: 88 },
            readValue: () => testState.database.temperature,
            initialValue: 10,
        },
        {
            method: "setDatabase",
            mutation: { theme: "denied" },
            readValue: () => testState.database.theme,
            initialValue: "default",
        },
    ])("$method rejects an asked and persisted database denial", async ({
        method,
        mutation,
        readValue,
        initialValue,
    }) => {
        const plugin = startupPlugin(`Denied ${method}`, "// write-only plugin");
        testState.database.plugins = [plugin];
        DBState.db = testState.database;
        alertConfirmMock.mockResolvedValueOnce(false);
        const api = makeRisuaiAPIV3(document.createElement("iframe"), plugin as any) as any;
        const expectedError = {
            name: "PluginPermissionError",
            code: PLUGIN_PERMISSION_DENIED_CODE,
            message: `Plugin "${plugin.name}" was denied the "db" permission.`,
        };

        await expect(api[method](mutation)).rejects.toMatchObject(expectedError);
        expect(readValue()).toBe(initialValue);

        await expect(api[method](mutation)).rejects.toMatchObject(expectedError);
        expect(readValue()).toBe(initialValue);
        expect(alertConfirmMock).toHaveBeenCalledOnce();
    });

    test.each([
        {
            method: "setDatabaseLite",
            mutation: { temperature: 88 },
            readValue: () => testState.database.temperature,
            expectedValue: 88,
        },
        {
            method: "setDatabase",
            mutation: { theme: "granted" },
            readValue: () => testState.database.theme,
            expectedValue: "granted",
        },
    ])("$method applies a write-only mutation after permission is granted", async ({
        method,
        mutation,
        readValue,
        expectedValue,
    }) => {
        const plugin = startupPlugin(`Granted ${method}`, "// write-only plugin");
        testState.database.plugins = [plugin];
        DBState.db = testState.database;
        alertConfirmMock.mockResolvedValueOnce(true);
        const api = makeRisuaiAPIV3(document.createElement("iframe"), plugin as any) as any;

        await expect(api[method](mutation)).resolves.toBeUndefined();
        expect(readValue()).toBe(expectedValue);
        expect(alertConfirmMock).toHaveBeenCalledOnce();
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
    test("carries denied database setter errors through the guest RPC", async () => {
        const plugin = startupPlugin("Denied Database Guest", `
            globalThis.databasePermissionErrors = [];
            for (const [method, mutation] of [
                ["setDatabaseLite", { temperature: 88 }],
                ["setDatabase", { theme: "denied" }],
            ]) {
                try {
                    await risuai[method](mutation);
                    globalThis.databasePermissionErrors.push({ method, resolved: true });
                } catch (error) {
                    globalThis.databasePermissionErrors.push({
                        method,
                        name: error.name,
                        code: error.code,
                        message: error.message,
                    });
                }
            }
        `);
        testState.database.plugins = [plugin];
        DBState.db = testState.database;
        alertConfirmMock.mockResolvedValueOnce(false);

        const loading = loadV3PluginGeneration([plugin]);
        const iframe = document.body.querySelector("iframe")!;
        const guestWindow = iframe.contentWindow as any;
        const restoreRelay = executeGeneratedGuest(iframe);
        try {
            await loading;
            await getV3PluginInstance(plugin.name)!.lifetime;

            expect(Array.from(guestWindow.databasePermissionErrors)).toEqual([
                expect.objectContaining({
                    method: "setDatabaseLite",
                    name: "PluginPermissionError",
                    code: PLUGIN_PERMISSION_DENIED_CODE,
                }),
                expect.objectContaining({
                    method: "setDatabase",
                    name: "PluginPermissionError",
                    code: PLUGIN_PERMISSION_DENIED_CODE,
                }),
            ]);
            expect(alertConfirmMock).toHaveBeenCalledOnce();
            expect(testState.database.temperature).toBe(10);
            expect(testState.database.theme).toBe("default");
        } finally {
            await teardownV3Plugins();
            restoreRelay();
        }
    });

    test("preserves callback identity across duplicate hook registration and removal", async () => {
        const plugin = startupPlugin("Stable Hook Identity", `
            globalThis.scriptCalls = 0;
            globalThis.replacerCalls = 0;
            globalThis.sharedScriptHook = async (content) => {
                globalThis.scriptCalls += 1;
                return content + ":script";
            };
            globalThis.responseReplacer = async (content) => {
                globalThis.replacerCalls += 1;
                return content + ":replacer";
            };
            await risuai.addRisuScriptHandler("display", globalThis.sharedScriptHook);
            await risuai.addRisuScriptHandler("display", globalThis.sharedScriptHook);
            await risuai.addRisuScriptHandler("input", globalThis.sharedScriptHook);
            await risuai.addRisuScriptHandler("input", globalThis.sharedScriptHook);
            await risuai.addRisuReplacer("afterRequest", globalThis.responseReplacer);
            await risuai.addRisuReplacer("afterRequest", globalThis.responseReplacer);
            await new Promise(() => {});
        `);
        testState.database.plugins = [plugin];
        DBState.db = testState.database;

        const loading = loadV3PluginGeneration([plugin]);
        const iframe = document.body.querySelector("iframe")!;
        const restoreRelay = executeGeneratedGuest(iframe);

        try {
            await loading;
            await vi.waitFor(() => {
                expect(pluginV2.editdisplay.size).toBe(1);
                expect(pluginV2.editinput.size).toBe(1);
                expect(pluginV2.replacerafterRequest.size).toBe(1);
            });

            const displayHook = [...pluginV2.editdisplay][0];
            const inputHook = [...pluginV2.editinput][0];
            const responseReplacer = [...pluginV2.replacerafterRequest][0];
            await expect(displayHook("display")).resolves.toBe("display:script");
            await expect(inputHook("input")).resolves.toBe("input:script");
            await expect(responseReplacer("response", "model")).resolves.toBe("response:replacer");
            expect((iframe.contentWindow as any).scriptCalls).toBe(2);
            expect((iframe.contentWindow as any).replacerCalls).toBe(1);

            const instance = getV3PluginInstance(plugin.name)!;
            await instance.host.executeInIframe(`
                await risuai.removeRisuScriptHandler("display", globalThis.sharedScriptHook);
            `);
            expect(pluginV2.editdisplay.size).toBe(0);
            expect(pluginV2.editinput.size).toBe(1);
            expect(pluginV2.replacerafterRequest.size).toBe(1);

            await instance.host.executeInIframe(`
                await risuai.removeRisuScriptHandler("input", globalThis.sharedScriptHook);
                await risuai.removeRisuReplacer("afterRequest", globalThis.responseReplacer);
            `);
            expect(pluginV2.editinput.size).toBe(0);
            expect(pluginV2.replacerafterRequest.size).toBe(0);
        } finally {
            await teardownV3Plugins().catch(() => undefined);
            restoreRelay();
        }
    });

    test("attributes generation startup failures to the rejecting plugin", async () => {
        const rejected = startupPlugin("Rejected generation member", "const broken = ;");
        const healthy = startupPlugin("Healthy generation member", "");
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

        const loading = loadV3PluginGenerationOutcomes([rejected, healthy]);
        const healthyIframe = [...document.body.querySelectorAll("iframe")]
            .find(iframe => (iframe.contentDocument?.querySelectorAll("script").length ?? 0) > 0);
        expect(healthyIframe).toBeDefined();
        const restoreHealthyRelay = executeGeneratedGuest(healthyIframe!);

        await expect(loading).resolves.toEqual([
            expect.objectContaining({
                pluginName: rejected.name,
                status: "rejected",
            }),
            { pluginName: healthy.name, status: "fulfilled" },
        ]);
        expect(getV3PluginInstance(rejected.name)).toBeUndefined();
        expect(getV3PluginInstance(healthy.name)).toBeDefined();

        await teardownV3Plugins();
        restoreHealthyRelay();
        errorSpy.mockRestore();
    });

    test("long-lived top-level work releases startup and the lifecycle queue", async () => {
        vi.useFakeTimers();
        const longLived = startupPlugin("Long-Lived Production Plugin", `
            await risuai.addProvider("long-lived-provider", async () => ({ success: true, content: "ok" }));
            await new Promise(() => {});
        `);
        const healthy = startupPlugin("Healthy Production Startup", `
            await risuai.addProvider("healthy-provider", async () => ({ success: true, content: "ok" }));
        `);
        testState.database.plugins = [longLived, healthy];
        DBState.db = testState.database;
        let restoreLongLivedRelay: (() => void) | undefined;
        let restoreHealthyRelay: (() => void) | undefined;

        try {
            let generationSettled = false;
            const loading = withPluginLifecycleLock(
                async () => loadV3PluginGeneration([longLived, healthy]),
            ).finally(() => {
                generationSettled = true;
            });
            await vi.waitFor(() => {
                expect(document.body.querySelectorAll("iframe")).toHaveLength(2);
            });
            const [longLivedIframe, healthyIframe] = [
                ...document.body.querySelectorAll("iframe"),
            ];
            restoreLongLivedRelay = executeGeneratedGuest(longLivedIframe);
            restoreHealthyRelay = executeGeneratedGuest(healthyIframe);
            await loading;

            expect(generationSettled).toBe(true);
            await vi.waitFor(() => {
                expect(pluginV2.providers.has("long-lived-provider")).toBe(true);
                expect(pluginV2.providers.has("healthy-provider")).toBe(true);
            });
            expect(getV3PluginInstance(longLived.name)).toBeDefined();
            expect(getV3PluginInstance(healthy.name)).toBeDefined();

            let nextLifecycleOperationRan = false;
            await withPluginLifecycleLock(async () => {
                nextLifecycleOperationRan = true;
            });
            expect(nextLifecycleOperationRan).toBe(true);

            await vi.advanceTimersByTimeAsync(FORMER_BRIDGE_DEADLINE_MS + 1);

            expect(longLivedIframe.isConnected).toBe(true);
            expect(healthyIframe.isConnected).toBe(true);
            expect(getV3PluginInstance(longLived.name)).toBeDefined();
            expect(getV3PluginInstance(healthy.name)).toBeDefined();
            expect(pluginV2.providers.has("long-lived-provider")).toBe(true);
            expect(pluginV2.providers.has("healthy-provider")).toBe(true);
            expect(notifyErrorMock).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
            await teardownV3Plugins().catch(() => undefined);
            restoreHealthyRelay?.();
            restoreLongLivedRelay?.();
        }
    });

    test("hot reload replaces a plugin whose old top-level task is still running", async () => {
        const oldPlugin = startupPlugin("Hot Reload Service", `
            await risuai.addProvider("old-hot-provider", async () => ({ success: true, content: "old" }));
            await new Promise(() => {});
        `);
        const replacement = startupPlugin(oldPlugin.name, `
            await risuai.addProvider("new-hot-provider", async () => ({ success: true, content: "new" }));
        `);
        testState.database.plugins = [oldPlugin];
        DBState.db = testState.database;

        const firstLoad = loadV3PluginGeneration([oldPlugin]);
        const oldIframe = document.body.querySelector("iframe")!;
        const restoreOldRelay = executeGeneratedGuest(oldIframe);
        await firstLoad;
        await vi.waitFor(() => expect(pluginV2.providers.has("old-hot-provider")).toBe(true));

        const reload = loadV3Plugins([replacement]);
        await vi.waitFor(() => {
            const replacementIframe = [...document.body.querySelectorAll("iframe")]
                .find(iframe => iframe !== oldIframe);
            expect(replacementIframe).toBeDefined();
        });
        const replacementIframe = [...document.body.querySelectorAll("iframe")]
            .find(iframe => iframe !== oldIframe)!;
        const restoreReplacementRelay = executeGeneratedGuest(replacementIframe);
        await reload;
        await getV3PluginInstance(replacement.name)!.lifetime;

        expect(oldIframe.isConnected).toBe(false);
        expect(pluginV2.providers.has("old-hot-provider")).toBe(false);
        expect(pluginV2.providers.has("new-hot-provider")).toBe(true);
        expect(getV3PluginInstance(replacement.name)).toBeDefined();
        expect(notifyErrorMock).not.toHaveBeenCalled();

        await teardownV3Plugins();
        restoreReplacementRelay();
        restoreOldRelay();
    });

    test("teardown closes registration while a top-level task is still pending", async () => {
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
        const teardownOutcome = teardown.then(() => null, error => error);
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
        const teardownError = await teardownOutcome;
        const loadingError = await loadingOutcome;

        expect(teardownError).toBeInstanceOf(AggregateError);
        expect((teardownError as AggregateError).errors[0]).toBeInstanceOf(AggregateError);
        expect(((teardownError as AggregateError).errors[0] as AggregateError).errors)
            .toContainEqual(expect.objectContaining({
                name: "PluginUnloadIncompleteError",
                code: "PLUGIN_UNLOAD_INCOMPLETE",
                retryable: false,
                commitOutcomeUnknown: false,
                operation: "unload",
            }));
        expect(loadingError).toBeNull();
        expect(pluginV2.providers.has("too-late-provider")).toBe(false);
        expect(get(customProviderStore)).not.toContain("too-late-provider");
        expect(logSpy.mock.calls.some(([message]) =>
            String(message).includes(`[RisuAI Plugin: ${plugin.name}] Loaded API V3 plugin.`),
        )).toBe(true);
        expect(iframe.isConnected).toBe(false);
        restoreRelay();
        errorSpy.mockRestore();
        logSpy.mockRestore();
    });

    test("legacy compatibility admits unload storage cleanup but rejects new registrations", async () => {
        testState.database.legacyPluginCompatibility = true;
        const plugin = startupPlugin("Compatible Unload", `
            const localStore = await risuai.getLocalPluginStorage();
            await risuai.onUnload(async () => {
                await localStore.setItem("compat-unload", "durable");
                globalThis.compatWriteComplete = true;
                try {
                    await risuai.addProvider(
                        "compat-too-late",
                        async () => ({ success: true, content: "late" }),
                    );
                } catch (error) {
                    globalThis.compatRegistrationRejected = true;
                }
            });
        `);
        testState.database.plugins = [plugin];
        DBState.db = testState.database;

        const loading = loadV3PluginGeneration([plugin]);
        const iframe = document.body.querySelector("iframe")!;
        const guestWindow = iframe.contentWindow as any;
        const restoreRelay = executeGeneratedGuest(iframe);
        await loading;
        await getV3PluginInstance(plugin.name)!.lifetime;

        await expect(teardownV3Plugins()).resolves.toBeUndefined();

        expect(guestWindow.compatWriteComplete).toBe(true);
        expect(guestWindow.compatRegistrationRejected).toBe(true);
        expect(storageMocks.persistent.get(
            `cache/plugin-storage/${encodeKey("compat-unload")}.json`,
        )).toBe("durable");
        expect(pluginV2.providers.has("compat-too-late")).toBe(false);
        expect(iframe.isConnected).toBe(false);
        restoreRelay();
    });

    test("legacy compatibility restores bounded database, UI, network, and asset finalization", async () => {
        testState.database.legacyPluginCompatibility = true;
        const plugin = startupPlugin("Legacy Finalizer", `
            await risuai.onUnload(async () => {
                await risuai.setDatabaseLite({ temperature: 73 });
                await risuai.setArgument("finalized", "yes");
                await risuai.changeTextTheme("highcontrast");
                await risuai.setChatPanel(null, { id: "legacy-finalizer-panel" });
                await risuai.nativeFetch("https://example.com/finalize", { method: "DELETE" });
                await risuai.risuFetch("https://example.com/legacy-finalize", { method: "POST" });
                globalThis.savedFinalAsset = await risuai.saveAsset(new Uint8Array([1, 2, 3]));
                globalThis.legacyFinalizationComplete = true;
            });
        `);
        testState.database.plugins = [plugin];
        DBState.db = testState.database;

        const loading = loadV3PluginGeneration([plugin]);
        const iframe = document.body.querySelector("iframe")!;
        const guestWindow = iframe.contentWindow as any;
        const restoreRelay = executeGeneratedGuest(iframe);
        await loading;
        await getV3PluginInstance(plugin.name)!.lifetime;
        chatPanelStore.push({
            id: "legacy-finalizer-panel",
            pluginName: "external-fixture",
            html: "stale",
        });

        await expect(teardownV3Plugins()).resolves.toBeUndefined();

        expect(guestWindow.legacyFinalizationComplete).toBe(true);
        expect(guestWindow.savedFinalAsset).toBe("assets/finalized.png");
        expect(testState.database.temperature).toBe(73);
        expect(testState.database.textTheme).toBe("highcontrast");
        expect(testState.database.plugins[0].realArg.finalized).toBe("yes");
        expect(chatPanelStore.some(panel => panel.id === "legacy-finalizer-panel")).toBe(false);
        expect(unloadFinalizationMocks.fetchNative).toHaveBeenCalledWith(
            "https://example.com/finalize",
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        expect(unloadFinalizationMocks.globalFetch).toHaveBeenCalledWith(
            "https://example.com/legacy-finalize",
            expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
        );
        expect(unloadFinalizationMocks.saveAsset).toHaveBeenCalledOnce();
        restoreRelay();
    });

    test("the onUnload signal authorizes finalization without reopening lifecycle work", async () => {
        testState.database.legacyPluginCompatibility = false;
        const plugin = startupPlugin("Strict Finalizer", `
            await risuai.onUnload(async (signal) => {
                await risuai.setDatabaseLite({ temperature: 91 }, signal);
                await risuai.setArgument("finalized", "strict", signal);
                await risuai.changeTextTheme("highcontrast", signal);
                await risuai.setChatPanel(null, { id: "strict-finalizer-panel" }, signal);
                await risuai.nativeFetch(
                    "https://example.com/strict-finalize",
                    { method: "DELETE" },
                    signal,
                );
                globalThis.savedFinalAsset = await risuai.saveAsset(
                    new Uint8Array([4, 5, 6]),
                    signal,
                );
                try {
                    await risuai.setDatabaseLite({ plugins: [] }, signal);
                } catch (error) {
                    globalThis.pluginGenerationRejected = true;
                }
                try {
                    await risuai.setChatPanel("<b>late UI</b>", {}, signal);
                } catch (error) {
                    globalThis.nonEmptyPanelRejected = true;
                }
                try {
                    await risuai.runLLMModel({ mode: "main", messages: [] }, signal);
                } catch (error) {
                    globalThis.modelWorkRejected = true;
                }
                globalThis.strictFinalizationComplete = true;
            });
        `);
        testState.database.plugins = [plugin];
        DBState.db = testState.database;

        const loading = loadV3PluginGeneration([plugin]);
        const iframe = document.body.querySelector("iframe")!;
        const guestWindow = iframe.contentWindow as any;
        const restoreRelay = executeGeneratedGuest(iframe);
        await loading;
        await getV3PluginInstance(plugin.name)!.lifetime;
        chatPanelStore.push({
            id: "strict-finalizer-panel",
            pluginName: "external-fixture",
            html: "stale",
        });

        await expect(teardownV3Plugins()).resolves.toBeUndefined();

        expect(guestWindow.strictFinalizationComplete).toBe(true);
        expect(guestWindow.savedFinalAsset).toBe("assets/finalized.png");
        expect(guestWindow.pluginGenerationRejected).toBe(true);
        expect(guestWindow.nonEmptyPanelRejected).toBe(true);
        expect(guestWindow.modelWorkRejected).toBe(true);
        expect(testState.database.temperature).toBe(91);
        expect(testState.database.textTheme).toBe("highcontrast");
        expect(testState.database.plugins[0].realArg.finalized).toBe("strict");
        expect(chatPanelStore.some(panel => panel.id === "strict-finalizer-panel")).toBe(false);
        expect(unloadFinalizationMocks.fetchNative).toHaveBeenCalledWith(
            "https://example.com/strict-finalize",
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        expect(unloadFinalizationMocks.saveAsset).toHaveBeenCalledOnce();
        restoreRelay();
    });

    test("legacy compatibility admits only cleanup-shaped DOM mutations", async () => {
        testState.database.legacyPluginCompatibility = true;
        const style = document.createElement("style");
        style.id = "compat-unload-style";
        style.textContent = ".old-chat { display: none; }";
        const marker = document.createElement("div");
        marker.id = "compat-unload-marker";
        marker.setAttribute("x-plugin-state", "active");
        const original = document.createElement("button");
        original.id = "compat-original-button";
        const replacement = document.createElement("button");
        replacement.id = "compat-replacement-button";
        document.body.append(style, marker, original, replacement);

        const plugin = startupPlugin("Compatible DOM Cleanup", `
            const root = await risuai.getRootDocument();
            const style = await root.getElementById("compat-unload-style");
            const marker = await root.getElementById("compat-unload-marker");
            const original = await root.getElementById("compat-original-button");
            const replacement = await root.getElementById("compat-replacement-button");
            await original.remove();
            await risuai.onUnload(async () => {
                try {
                    await style.setInnerHTML("<b>new unload UI</b>");
                } catch (error) {
                    globalThis.nonEmptyHtmlRejected = true;
                }
                try {
                    await marker.setAttribute("x-plugin-state", "still-active");
                } catch (error) {
                    globalThis.nonEmptyAttributeRejected = true;
                }
                await style.setInnerHTML("");
                await marker.setAttribute("x-plugin-state", "");
                await replacement.replaceWith(original);
                globalThis.cleanupDomComplete = true;
            });
        `);
        testState.database.plugins = [plugin];
        DBState.db = testState.database;

        const loading = loadV3PluginGeneration([plugin]);
        const iframe = document.body.querySelector("iframe")!;
        const guestWindow = iframe.contentWindow as any;
        const restoreRelay = executeGeneratedGuest(iframe);
        await loading;
        await getV3PluginInstance(plugin.name)!.lifetime;

        await expect(teardownV3Plugins()).resolves.toBeUndefined();

        expect(guestWindow.nonEmptyHtmlRejected).toBe(true);
        expect(guestWindow.nonEmptyAttributeRejected).toBe(true);
        expect(guestWindow.cleanupDomComplete).toBe(true);
        expect(style.textContent).toBe("");
        expect(marker.getAttribute("x-plugin-state")).toBe("");
        expect(document.getElementById("compat-original-button")).toBe(original);
        expect(document.getElementById("compat-replacement-button")).toBeNull();
        restoreRelay();
    });

    test("legacy compatibility drains fire-and-forget IPC cleanup", async () => {
        testState.database.legacyPluginCompatibility = true;
        const receiverStarted = deferred();
        const releaseReceiver = deferred();
        const senderName = "Unload IPC Sender";
        const receiverName = "Unload IPC Receiver";
        const sender = {
            ...startupPlugin(senderName, `
                await risuai.onUnload(() => {
                    void risuai.postPluginChannelMessage(
                        ${JSON.stringify(receiverName)},
                        "cleanup",
                        { method: "hooks/unregister" }
                    );
                });
            `),
            allowedIPC: [receiverName],
        };
        const receiver = {
            ...startupPlugin(receiverName, ""),
            allowedIPC: [senderName],
        };
        testState.database.plugins = [sender, receiver];
        DBState.db = testState.database;
        pluginChannel.set(`${receiverName}cleanup`, async (message: unknown) => {
            expect(message).toEqual({ method: "hooks/unregister" });
            receiverStarted.resolve();
            await releaseReceiver.promise;
        });

        const loading = loadV3PluginGeneration([sender]);
        const iframe = document.body.querySelector("iframe")!;
        const restoreRelay = executeGeneratedGuest(iframe);
        await loading;
        await getV3PluginInstance(sender.name)!.lifetime;

        let teardownSettled = false;
        const teardown = teardownV3Plugins().finally(() => {
            teardownSettled = true;
        });
        await receiverStarted.promise;
        await Promise.resolve();
        expect(teardownSettled).toBe(false);

        releaseReceiver.resolve();
        await expect(teardown).resolves.toBeUndefined();
        expect(teardownSettled).toBe(true);
        expect(iframe.isConnected).toBe(false);
        restoreRelay();
    });

    test("exposes a non-destructive rewrite helper with a confirmed result", async () => {
        storageMocks.persistent.set(storageKey("maintenance-index"), {
            entries: ["kept"],
        });
        installManifestOwnedStartupKeys("maintenance-index");
        const plugin = startupPlugin("Atomic Rewrite", `
            const current = await risuai.pluginStorage.getWithRevision("maintenance-index");
            if (current.status !== "value") throw new Error("fixture missing");
            globalThis.rewriteResult = await risuai.pluginStorage.rewriteItem(
                "maintenance-index",
                JSON.parse(JSON.stringify(current.value)),
                current.revision,
            );
            globalThis.confirmedRewriteCount = globalThis.rewriteResult.committed ? 1 : 0;
        `);
        const loading = loadV3PluginGeneration([plugin]);
        const iframe = document.body.querySelector("iframe")!;
        const guestWindow = iframe.contentWindow as any;
        const restoreRelay = executeGeneratedGuest(iframe);

        await loading;
        await getV3PluginInstance(plugin.name)!.lifetime;

        expect(guestWindow.rewriteResult).toMatchObject({
            committed: true,
            revisions: [{ key: "maintenance-index" }],
        });
        expect(guestWindow.confirmedRewriteCount).toBe(1);
        expect(storageMocks.persistent.get(storageKey("maintenance-index"))).toEqual({
            entries: ["kept"],
        });
        restoreRelay();
    });

    test("exposes the composed IP1-IP5 API while updateItem remains host-coordinated", async () => {
        const plugin = startupPlugin("Composed Storage Surface", `
            const methodNames = [
                "readItem",
                "setFromRead",
                "rewriteItem",
                "updateItem",
                "setItemWithOutcome",
                "removeItemWithOutcome",
                "removeItemConfirmed",
                "atomicBatch",
            ];
            globalThis.composedStorageSurface = Object.fromEntries(
                methodNames.map(name => [name, typeof risuai.pluginStorage[name]]),
            );
            globalThis.composedStorageSurface.generations =
                typeof risuai.pluginStorage.generations;
            globalThis.composedUpdateResult = await risuai.pluginStorage.updateItem(
                "composed-signature",
                (current, signal) => {
                    globalThis.composedUpdateCallback = {
                        status: current.status,
                        signal: signal instanceof AbortSignal,
                    };
                    return { version: 1 };
                },
                { timeoutMs: 5_000 },
            );
        `);
        const loading = loadV3PluginGeneration([plugin]);
        const iframe = document.body.querySelector("iframe")!;
        const guestWindow = iframe.contentWindow as any;
        const restoreRelay = executeGeneratedGuest(iframe);

        await loading;
        await getV3PluginInstance(plugin.name)!.lifetime;

        expect(guestWindow.composedStorageSurface).toEqual({
            readItem: "function",
            setFromRead: "function",
            rewriteItem: "function",
            updateItem: "function",
            setItemWithOutcome: "function",
            removeItemWithOutcome: "function",
            removeItemConfirmed: "function",
            atomicBatch: "function",
            generations: "object",
        });
        expect(guestWindow.composedUpdateCallback).toEqual({
            status: "missing",
            signal: true,
        });
        expect(guestWindow.composedUpdateResult).toMatchObject({ committed: true });
        expect(storageMocks.persistent.get(storageKey("composed-signature")))
            .toEqual({ version: 1 });

        await teardownV3Plugins();
        restoreRelay();
    });

    test("queues every IP1-IP4 mutation root behind an active IP5 migration", async () => {
        for (const key of [
            "barrier-migration",
            "barrier-guarded",
            "barrier-rewrite",
            "barrier-remove-outcome",
            "barrier-remove-confirmed",
        ]) {
            storageMocks.persistent.set(storageKey(key), { key, version: 1 });
        }
        installManifestOwnedStartupKeys(
            "barrier-migration",
            "barrier-guarded",
            "barrier-rewrite",
            "barrier-remove-outcome",
            "barrier-remove-confirmed",
        );
        const plugin = startupPlugin("Composed Storage Barrier", `
            const guarded = await risuai.pluginStorage.readItem("barrier-guarded");
            const rewrite = await risuai.pluginStorage.getWithRevision("barrier-rewrite");
            globalThis.composedMigration = risuai.pluginStorage.updateItem(
                "barrier-migration",
                async current => {
                    globalThis.composedMigrationStarted = true;
                    await new Promise(resolve => {
                        globalThis.releaseComposedMigration = resolve;
                    });
                    return { ...current.value, version: 2 };
                },
                { timeoutMs: 5_000 },
            );
            globalThis.composedWriters = Promise.all([
                risuai.pluginStorage.setFromRead(guarded, { guarded: true }),
                risuai.pluginStorage.rewriteItem(
                    "barrier-rewrite",
                    { rewritten: true },
                    rewrite.revision,
                ),
                risuai.pluginStorage.setItemWithOutcome(
                    "barrier-set-outcome",
                    "committed-set",
                ),
                risuai.pluginStorage.removeItemWithOutcome("barrier-remove-outcome"),
                risuai.pluginStorage.removeItemConfirmed("barrier-remove-confirmed"),
                risuai.pluginStorage.atomicBatch([{
                    type: "set",
                    key: "barrier-batch",
                    value: { batch: true },
                }]),
                risuai.pluginStorage.generations.publish({
                    manifestKey: "barrier/head",
                    bodyKeyPrefix: "barrier/body",
                    bodies: [{ id: "one", count: 1, value: { generation: true } }],
                }),
            ]).then(results => { globalThis.composedWriterResults = results; });
        `);
        const loading = loadV3PluginGeneration([plugin]);
        const iframe = document.body.querySelector("iframe")!;
        const guestWindow = iframe.contentWindow as any;
        const restoreRelay = executeGeneratedGuest(iframe);
        await loading;
        await getV3PluginInstance(plugin.name)!.lifetime;
        await vi.waitFor(() => expect(guestWindow.composedMigrationStarted).toBe(true));
        await new Promise(resolve => setTimeout(resolve, 25));

        expect(storageMocks.batchCalls).toBe(0);
        expect(storageMocks.persistent.has(storageKey("barrier-set-outcome"))).toBe(false);
        expect(storageMocks.persistent.get(storageKey("barrier-guarded")))
            .toEqual({ key: "barrier-guarded", version: 1 });
        expect(storageMocks.persistent.get(storageKey("barrier-remove-outcome")))
            .toEqual({ key: "barrier-remove-outcome", version: 1 });
        expect(storageMocks.persistent.get(storageKey("barrier-remove-confirmed")))
            .toEqual({ key: "barrier-remove-confirmed", version: 1 });

        guestWindow.releaseComposedMigration();
        await vi.waitFor(() => expect(guestWindow.composedWriterResults).toHaveLength(7));

        expect(storageMocks.persistent.get(storageKey("barrier-migration")))
            .toEqual({ key: "barrier-migration", version: 2 });
        expect(storageMocks.persistent.get(storageKey("barrier-guarded")))
            .toEqual({ guarded: true });
        expect(storageMocks.persistent.get(storageKey("barrier-rewrite")))
            .toEqual({ rewritten: true });
        expect(storageMocks.persistent.get(storageKey("barrier-set-outcome")))
            .toBe("committed-set");
        expect(storageMocks.persistent.has(storageKey("barrier-remove-outcome"))).toBe(false);
        expect(storageMocks.persistent.has(storageKey("barrier-remove-confirmed"))).toBe(false);
        expect(storageMocks.persistent.get(storageKey("barrier-batch")))
            .toEqual({ batch: true });
        expect(guestWindow.composedWriterResults[2]).toMatchObject({
            outcome: "committed",
            operation: "set",
        });
        expect(guestWindow.composedWriterResults[3]).toMatchObject({
            outcome: "committed",
            operation: "remove",
        });
        expect(guestWindow.composedWriterResults[4]).toMatchObject({
            outcome: "committed",
            confirmation: "authoritative-absence",
        });
        expect(guestWindow.composedWriterResults[6]).toMatchObject({ committed: true });

        await teardownV3Plugins();
        restoreRelay();
    });

    test("updateItem preserves a newer value that lands during the guest transform", async () => {
        storageMocks.persistent.set(storageKey("settings"), { schema: 1, source: "old" });
        installManifestOwnedStartupKeys("settings");
        const plugin = startupPlugin("Cancellable Storage Migration", `
            globalThis.updatePending = risuai.pluginStorage.updateItem(
                "settings",
                async (current, signal) => {
                    globalThis.updateInitial = current;
                    globalThis.updateTransformStarted = true;
                    await new Promise(resolve => { globalThis.releaseUpdateTransform = resolve; });
                    signal.throwIfAborted();
                    return { ...current.value, schema: 2, source: "stale-transform" };
                },
                { timeoutMs: 5_000 },
            ).then(
                result => { globalThis.updateResult = result; },
                error => { globalThis.updateError = error; },
            );
        `);
        const loading = loadV3PluginGeneration([plugin]);
        const iframe = document.body.querySelector("iframe")!;
        const guestWindow = iframe.contentWindow as any;
        const restoreRelay = executeGeneratedGuest(iframe);
        await loading;
        await vi.waitFor(() => expect(guestWindow.updateTransformStarted).toBe(true));

        // Represents a different plugin instance/session, outside this
        // instance's migration mutex but still protected by the final CAS.
        storageMocks.persistent.set(storageKey("settings"), {
            schema: 3,
            source: "newer-writer",
        });
        storageMocks.revisionOverrides.set(
            storageKey("settings"),
            `sha256:${"c".repeat(64)}`,
        );
        guestWindow.releaseUpdateTransform();

        await vi.waitFor(() => expect(guestWindow.updateResult).toEqual({
            committed: false,
            conflicts: [{
                key: "settings",
                revision: `sha256:${"c".repeat(64)}`,
                generation: null,
            }],
        }));
        expect(storageMocks.batchCalls).toBe(0);
        expect(storageMocks.persistent.get(storageKey("settings"))).toEqual({
            schema: 3,
            source: "newer-writer",
        });

        await teardownV3Plugins();
        restoreRelay();
    });

    test("updateItem watchdog aborts the transform and never sends a late SET", async () => {
        storageMocks.persistent.set(storageKey("settings"), { schema: 1 });
        installManifestOwnedStartupKeys("settings");
        const plugin = startupPlugin("Timed Storage Migration", `
            globalThis.updatePending = risuai.pluginStorage.updateItem(
                "settings",
                async (_current, signal) => {
                    globalThis.updateSignal = signal;
                    globalThis.updateTransformStarted = true;
                    await new Promise(resolve => { globalThis.releaseUpdateTransform = resolve; });
                    globalThis.updateObservedAbort = signal.aborted;
                    return { schema: 2 };
                },
                { timeoutMs: 25 },
            ).then(
                result => { globalThis.updateResult = result; },
                error => { globalThis.updateError = error; },
            );
        `);
        const loading = loadV3PluginGeneration([plugin]);
        const iframe = document.body.querySelector("iframe")!;
        const guestWindow = iframe.contentWindow as any;
        const restoreRelay = executeGeneratedGuest(iframe);
        await loading;
        await vi.waitFor(() => expect(guestWindow.updateTransformStarted).toBe(true));
        await vi.waitFor(() => expect(guestWindow.updateError).toMatchObject({
            name: "StorageError",
            code: "STORAGE_TIMEOUT",
            operation: "update",
            commitOutcomeUnknown: false,
        }));

        expect(guestWindow.updateSignal.aborted).toBe(true);
        expect(storageMocks.batchCalls).toBe(0);
        guestWindow.releaseUpdateTransform();
        await vi.waitFor(() => expect(guestWindow.updateObservedAbort).toBe(true));
        await new Promise(resolve => setTimeout(resolve, 25));
        expect(storageMocks.batchCalls).toBe(0);
        expect(storageMocks.persistent.get(storageKey("settings")))
            .toEqual({ schema: 1 });

        await teardownV3Plugins();
        restoreRelay();
    });

    test("updateItem deadline cancels a production final read before CAS", async () => {
        storageMocks.persistent.set(storageKey("settings"), { schema: 1 });
        installManifestOwnedStartupKeys("settings");
        const finalReadStarted = deferred();
        const releaseFinalRead = deferred();
        let settingsReads = 0;
        storageMocks.readGate = async (key, signal) => {
            if (key !== storageKey("settings")) return;
            settingsReads += 1;
            if (settingsReads !== 2) return;
            finalReadStarted.resolve();
            await awaitWithAbort(releaseFinalRead.promise, signal);
        };
        const plugin = startupPlugin("Final Read Deadline", `
            globalThis.updatePending = risuai.pluginStorage.updateItem(
                "settings",
                current => ({ ...current.value, schema: 2 }),
                { timeoutMs: 25 },
            ).then(
                result => { globalThis.updateResult = result; },
                error => { globalThis.updateError = error; },
            );
        `);
        const loading = loadV3PluginGeneration([plugin]);
        const iframe = document.body.querySelector("iframe")!;
        const guestWindow = iframe.contentWindow as any;
        const restoreRelay = executeGeneratedGuest(iframe);
        await loading;
        await finalReadStarted.promise;

        await vi.waitFor(() => expect(guestWindow.updateError).toMatchObject({
            code: "STORAGE_TIMEOUT",
            operation: "update",
            commitOutcomeUnknown: false,
        }));
        expect(settingsReads).toBe(2);
        expect(storageMocks.batchCalls).toBe(0);
        expect(storageMocks.persistent.get(storageKey("settings")))
            .toEqual({ schema: 1 });
        releaseFinalRead.resolve();
        storageMocks.readGate = null;
        await teardownV3Plugins();
        restoreRelay();
    });

    test("updateItem reports unknown when timeout loses a committed CAS acknowledgement", async () => {
        storageMocks.persistent.set(storageKey("settings"), { schema: 1 });
        installManifestOwnedStartupKeys("settings");
        const casCommitted = deferred();
        const releaseAcknowledgement = deferred();
        storageMocks.batchApplyBeforeGate = true;
        storageMocks.batchGate = async () => {
            casCommitted.resolve();
            await releaseAcknowledgement.promise;
        };
        const plugin = startupPlugin("Ambiguous Storage Migration", `
            globalThis.updatePending = risuai.pluginStorage.updateItem(
                "settings",
                () => ({ schema: 2, source: "migration" }),
                { timeoutMs: 25 },
            ).then(
                result => { globalThis.updateResult = result; },
                error => { globalThis.updateError = error; },
            );
        `);
        const loading = loadV3PluginGeneration([plugin]);
        const iframe = document.body.querySelector("iframe")!;
        const guestWindow = iframe.contentWindow as any;
        const restoreRelay = executeGeneratedGuest(iframe);
        await loading;
        await casCommitted.promise;

        await vi.waitFor(() => expect(guestWindow.updateError).toMatchObject({
            name: "StorageError",
            code: "COMMIT_OUTCOME_UNKNOWN",
            operation: "update",
            retryable: false,
            commitOutcomeUnknown: true,
        }));
        expect(storageMocks.persistent.get(storageKey("settings"))).toEqual({
            schema: 2,
            source: "migration",
        });
        releaseAcknowledgement.resolve();
        await new Promise(resolve => setTimeout(resolve, 0));
        await teardownV3Plugins();
        restoreRelay();
    });

    test("teardown drains a CAS that may have committed after update cancellation", async () => {
        storageMocks.persistent.set(storageKey("settings"), { schema: 1 });
        installManifestOwnedStartupKeys("settings");
        const casCommitted = deferred();
        const releaseAcknowledgement = deferred();
        storageMocks.batchApplyBeforeGate = true;
        storageMocks.batchGate = async () => {
            casCommitted.resolve();
            await releaseAcknowledgement.promise;
        };
        const plugin = startupPlugin("Teardown Ambiguous Migration", `
            globalThis.updatePending = risuai.pluginStorage.updateItem(
                "settings",
                () => ({ schema: 2, source: "may-have-committed" }),
                { timeoutMs: 5_000 },
            ).catch(error => { globalThis.updateError = error; });
        `);
        const loading = loadV3PluginGeneration([plugin]);
        const iframe = document.body.querySelector("iframe")!;
        const guestWindow = iframe.contentWindow as any;
        const restoreRelay = executeGeneratedGuest(iframe);
        await loading;
        await casCommitted.promise;
        const responseSpy = vi.spyOn(guestWindow, "postMessage");

        let teardownSettled = false;
        const teardown = teardownV3Plugins().finally(() => { teardownSettled = true; });
        await new Promise(resolve => setTimeout(resolve, 25));
        expect(teardownSettled).toBe(false);
        expect(iframe.isConnected).toBe(true);
        expect(storageMocks.persistent.get(storageKey("settings"))).toEqual({
            schema: 2,
            source: "may-have-committed",
        });

        releaseAcknowledgement.resolve();
        await teardown;
        expect(responseSpy.mock.calls.some(([unknownMessage]) => {
            const message = unknownMessage as any;
            return message?.type === "RESPONSE"
                && message?.error?.code === "COMMIT_OUTCOME_UNKNOWN"
                && message?.error?.commitOutcomeUnknown === true;
        })).toBe(true);
        expect(iframe.isConnected).toBe(false);
        restoreRelay();
    });

    test("update transform signals never inherit reusable unload capability", async () => {
        storageMocks.persistent.set(storageKey("settings"), { schema: 1 });
        installManifestOwnedStartupKeys("settings");
        const plugin = startupPlugin("Scoped Update Authorization", `
            await risuai.onUnload(async (unloadSignal) => {
                globalThis.scopedUpdateResult = await risuai.pluginStorage.updateItem(
                    "settings",
                    async (current, updateSignal) => {
                        try {
                            await risuai.pluginStorage.atomicBatch([{
                                type: "set",
                                key: "leaked-capability",
                                value: true,
                            }], updateSignal);
                        } catch (error) {
                            globalThis.leakedCapabilityError = error;
                        }
                        return { ...current.value, schema: 2 };
                    },
                    { timeoutMs: 750 },
                    unloadSignal,
                );
            });
        `);
        const loading = loadV3PluginGeneration([plugin]);
        const iframe = document.body.querySelector("iframe")!;
        const guestWindow = iframe.contentWindow as any;
        const restoreRelay = executeGeneratedGuest(iframe);
        await loading;
        await getV3PluginInstance(plugin.name)!.lifetime;

        await teardownV3Plugins();

        expect(guestWindow.leakedCapabilityError).toMatchObject({
            message: "Plugin sandbox is terminating; RPC invocation was rejected.",
        });
        expect(guestWindow.scopedUpdateResult).toMatchObject({ committed: true });
        expect(storageMocks.persistent.has(storageKey("leaked-capability"))).toBe(false);
        expect(storageMocks.persistent.get(storageKey("settings")))
            .toEqual({ schema: 2 });
        expect(iframe.isConnected).toBe(false);
        restoreRelay();
    });

    test("the same guest function cannot pass unload capability into its nested update transform", async () => {
        storageMocks.persistent.set(storageKey("settings"), { schema: 1 });
        installManifestOwnedStartupKeys("settings");
        const plugin = startupPlugin("Invocation Scoped Update Authorization", `
            const sharedCallback = async (...args) => {
                if (args.length === 1) {
                    const [unloadSignal] = args;
                    globalThis.sameFunctionUpdateResult = await risuai.pluginStorage.updateItem(
                        "settings",
                        sharedCallback,
                        { timeoutMs: 750 },
                        unloadSignal,
                    );
                    return;
                }

                const [current, updateSignal] = args;
                try {
                    await risuai.pluginStorage.atomicBatch([{
                        type: "set",
                        key: "same-function-leaked-capability",
                        value: true,
                    }], updateSignal);
                } catch (error) {
                    globalThis.sameFunctionCapabilityError = error;
                }
                return { ...current.value, schema: 2 };
            };
            await risuai.onUnload(sharedCallback);
        `);
        const loading = loadV3PluginGeneration([plugin]);
        const iframe = document.body.querySelector("iframe")!;
        const guestWindow = iframe.contentWindow as any;
        const restoreRelay = executeGeneratedGuest(iframe);
        await loading;

        await teardownV3Plugins();

        expect(guestWindow.sameFunctionCapabilityError).toMatchObject({
            message: "Plugin sandbox is terminating; RPC invocation was rejected.",
        });
        expect(guestWindow.sameFunctionUpdateResult).toMatchObject({ committed: true });
        expect(storageMocks.persistent.has(storageKey("same-function-leaked-capability")))
            .toBe(false);
        expect(storageMocks.persistent.get(storageKey("settings")))
            .toEqual({ schema: 2 });
        expect(iframe.isConnected).toBe(false);
        restoreRelay();
    });

    test("teardown cancels and drains an active update transform without publishing", async () => {
        storageMocks.persistent.set(storageKey("settings"), { schema: 1 });
        installManifestOwnedStartupKeys("settings");
        const plugin = startupPlugin("Teardown Storage Migration", `
            globalThis.updatePending = risuai.pluginStorage.updateItem(
                "settings",
                async (_current, signal) => {
                    globalThis.updateTransformStarted = true;
                    await new Promise((resolve, reject) => {
                        signal.addEventListener("abort", () => {
                            globalThis.updateTeardownAborted = true;
                            reject(signal.reason);
                        }, { once: true });
                    });
                    return { schema: 2 };
                },
                { timeoutMs: 5_000 },
            ).catch(error => { globalThis.updateError = error; });
        `);
        const loading = loadV3PluginGeneration([plugin]);
        const iframe = document.body.querySelector("iframe")!;
        const guestWindow = iframe.contentWindow as any;
        const restoreRelay = executeGeneratedGuest(iframe);
        await loading;
        await vi.waitFor(() => expect(guestWindow.updateTransformStarted).toBe(true));
        const responseSpy = vi.spyOn(guestWindow, "postMessage");

        await teardownV3Plugins();

        expect(responseSpy.mock.calls.some(([unknownMessage]) => {
            const message = unknownMessage as any;
            return message?.type === "RESPONSE"
            && message?.error?.name === "AbortError"
            && message?.error?.message
                === "Plugin storage update was cancelled during teardown."
        })).toBe(true);
        expect(storageMocks.batchCalls).toBe(0);
        expect(storageMocks.persistent.get(storageKey("settings")))
            .toEqual({ schema: 1 });
        expect(iframe.isConnected).toBe(false);
        restoreRelay();
    });

    test("extends unload for an admitted atomic batch and rejects uncaptured late writes", async () => {
        const batchStarted = deferred();
        const releaseBatch = deferred();
        storageMocks.batchGate = async () => {
            batchStarted.resolve();
            await releaseBatch.promise;
        };
        const plugin = startupPlugin("Atomic Unload Drain", `
            await risuai.onUnload(async (signal) => {
                globalThis.unloadBatchStarted = true;
                globalThis.unloadBatchResult = await risuai.pluginStorage.atomicBatch([
                    { type: "set", key: "body:0", value: { generation: "new", part: 0 } },
                    { type: "set", key: "body:1", value: { generation: "new", part: 1 } },
                    { type: "set", key: "manifest", value: { generation: "new", count: 2 } },
                ], signal);
                globalThis.unloadBatchFinished = true;
            });
        `);
        const loading = loadV3PluginGeneration([plugin]);
        const iframe = document.body.querySelector("iframe")!;
        const guestWindow = iframe.contentWindow as any;
        const restoreRelay = executeGeneratedGuest(iframe);
        await loading;

        let teardownSettled = false;
        const teardown = teardownV3Plugins().finally(() => { teardownSettled = true; });
        await batchStarted.promise;
        await new Promise(resolve => setTimeout(resolve, 1_100));

        expect(teardownSettled).toBe(false);
        expect(iframe.isConnected).toBe(true);
        expect(storageMocks.persistent.has(storageKey("body:0"))).toBe(false);
        releaseBatch.resolve();
        await teardown;

        expect(guestWindow.unloadBatchFinished).toBe(true);
        expect(storageMocks.persistent.get(storageKey("body:0"))).toEqual({
            generation: "new",
            part: 0,
        });
        expect(storageMocks.persistent.get(storageKey("manifest"))).toEqual({
            generation: "new",
            count: 2,
        });
        expect(iframe.isConnected).toBe(false);
        restoreRelay();
    });

    test("admits generation helper reads, publication, load, and GC from the captured unload signal", async () => {
        const plugin = startupPlugin("Generation Helper Unload", `
            globalThis.firstGeneration = await risuai.pluginStorage.generations.publish({
                manifestKey: 'unload/head',
                bodyKeyPrefix: 'unload/immutable',
                bodies: [{ id: 'one', count: 1, value: 'one' }],
            });
            await risuai.pluginStorage.generations.publish({
                manifestKey: 'unload/head',
                bodyKeyPrefix: 'unload/immutable',
                bodies: [{ id: 'two', count: 1, value: 'two' }],
            });
            await risuai.onUnload(async (signal) => {
                globalThis.unloadGenerationPublish = await risuai.pluginStorage.generations.publish({
                    manifestKey: 'unload/head',
                    bodyKeyPrefix: 'unload/immutable',
                    bodies: [{ id: 'three', count: 1, value: 'three' }],
                    unloadSignal: signal,
                });
                globalThis.unloadGenerationLoad = await risuai.pluginStorage.generations.load(
                    'unload/head',
                    signal,
                );
                globalThis.unloadGenerationGc = await risuai.pluginStorage.generations.garbageCollect({
                    manifestKey: 'unload/head',
                    generation: globalThis.firstGeneration.current,
                    unloadSignal: signal,
                });
            });
        `);
        const loading = loadV3PluginGeneration([plugin]);
        const iframe = document.body.querySelector("iframe")!;
        const guestWindow = iframe.contentWindow as any;
        const restoreRelay = executeGeneratedGuest(iframe);
        await loading;
        await getV3PluginInstance(plugin.name)!.lifetime;

        await teardownV3Plugins();

        expect(guestWindow.unloadGenerationPublish).toMatchObject({ committed: true });
        expect(guestWindow.unloadGenerationLoad).toMatchObject({
            status: "value",
            value: { bodies: [{ id: "three", count: 1, value: "three" }] },
        });
        expect(guestWindow.unloadGenerationGc).toMatchObject({
            committed: true,
            removed: true,
        });
        expect(iframe.isConnected).toBe(false);
        restoreRelay();
    });

    test("teardown drains a CAS admitted by onUnload after its acknowledgement exceeds the grace period", async () => {
        storageMocks.persistent.set(storageKey("settings"), { schema: 1 });
        installManifestOwnedStartupKeys("settings");
        const casCommitted = deferred();
        const releaseAcknowledgement = deferred();
        storageMocks.batchApplyBeforeGate = true;
        storageMocks.batchGate = async () => {
            casCommitted.resolve();
            await releaseAcknowledgement.promise;
        };
        const plugin = startupPlugin("Unload Update Publication Drain", `
            await risuai.onUnload(async (signal) => {
                try {
                    globalThis.unloadUpdateResult = await risuai.pluginStorage.updateItem(
                        "settings",
                        current => ({ ...current.value, schema: 2, source: "onUnload" }),
                        { timeoutMs: 5_000 },
                        signal,
                    );
                } catch (error) {
                    globalThis.unloadUpdateError = error;
                }
            });
        `);
        const loading = loadV3PluginGeneration([plugin]);
        const iframe = document.body.querySelector("iframe")!;
        const guestWindow = iframe.contentWindow as any;
        const restoreRelay = executeGeneratedGuest(iframe);
        await loading;

        let teardownSettled = false;
        const teardown = teardownV3Plugins().finally(() => { teardownSettled = true; });
        await casCommitted.promise;
        await new Promise(resolve => setTimeout(resolve, 1_100));

        expect(guestWindow.unloadUpdateError).toMatchObject({
            code: "COMMIT_OUTCOME_UNKNOWN",
            commitOutcomeUnknown: true,
        });
        expect(teardownSettled).toBe(false);
        expect(iframe.isConnected).toBe(true);
        expect(storageMocks.persistent.get(storageKey("settings"))).toEqual({
            schema: 2,
            source: "onUnload",
        });

        releaseAcknowledgement.resolve();
        await teardown;

        expect(teardownSettled).toBe(true);
        expect(iframe.isConnected).toBe(false);
        restoreRelay();
    });

    test("drains a pre-existing storage mutation even without an unload callback", async () => {
        const batchStarted = deferred();
        const releaseBatch = deferred();
        storageMocks.batchGate = async () => {
            batchStarted.resolve();
            await releaseBatch.promise;
        };
        const plugin = startupPlugin("Existing Batch Drain", `
            globalThis.pendingBatch = risuai.pluginStorage.atomicBatch([
                { type: "set", key: "already-started", value: { durable: true } },
            ]);
        `);
        const loading = loadV3PluginGeneration([plugin]);
        const iframe = document.body.querySelector("iframe")!;
        const restoreRelay = executeGeneratedGuest(iframe);
        await batchStarted.promise;
        await loading;

        let settled = false;
        const teardown = teardownV3Plugins().finally(() => { settled = true; });
        await new Promise(resolve => setTimeout(resolve, 25));
        expect(settled).toBe(false);
        expect(iframe.isConnected).toBe(true);
        releaseBatch.resolve();
        await teardown;

        expect(storageMocks.persistent.get(storageKey("already-started"))).toEqual({
            durable: true,
        });
        expect(iframe.isConnected).toBe(false);
        restoreRelay();
    });

    test("slow successful top-level work continues after generation readiness", async () => {
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
        await loading;
        expect(generationSettled).toBe(true);
        expect(pluginV2.providers.has("delayed-provider")).toBe(false);

        releaseRead.resolve();
        await postRegistrationReadStarted.promise;
        expect(pluginV2.providers.has("delayed-provider")).toBe(true);
        expect(generationSettled).toBe(true);

        releasePostRegistrationRead.resolve();
        await getV3PluginInstance(plugin.name)!.lifetime;

        expect(pluginV2.providers.has("delayed-provider")).toBe(true);
        expect(getV3PluginInstance(plugin.name)).toBeDefined();
        expect(notifyErrorMock).not.toHaveBeenCalled();
        restoreRelay();
    });

    test("reports a late top-level rejection without holding a healthy peer", async () => {
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
        await loading;
        await vi.waitFor(() => {
            expect(notifyErrorMock).toHaveBeenCalledOnce();
            expect(getV3PluginInstance(rejected.name)).toBeUndefined();
        });
        expect(generationSettled).toBe(true);
        expect(pluginV2.providers.has("slow-provider")).toBe(false);
        expect(pluginV2.providers.has("rejected-provider")).toBe(false);
        expect(logSpy.mock.calls.some(([message]) =>
            String(message).includes(`[RisuAI Plugin: ${rejected.name}] Loaded API V3 plugin.`),
        )).toBe(true);

        releaseSlowRead.resolve();
        await getV3PluginInstance(slow.name)!.lifetime;

        expect(pluginV2.providers.has("slow-provider")).toBe(true);
        expect(getV3PluginInstance(slow.name)).toBeDefined();
        expect(notifyErrorMock).toHaveBeenCalledWith(
            `Plugin "${rejected.name}" stopped unexpectedly.`,
            expect.objectContaining({
                description: "optimized storage unavailable",
                source: "plugin-runtime",
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

        await loading;
        await vi.waitFor(() => expect(getV3PluginInstance(plugin.name)).toBeUndefined());

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
        expect(notifyErrorMock).toHaveBeenCalledWith(
            `Plugin "${plugin.name}" stopped unexpectedly.`,
            expect.objectContaining({
                description: "late startup rejection",
                source: "plugin-runtime",
            }),
        );
        restoreRelay();
        disconnectSpy.mockRestore();
        removeEventListenerSpy.mockRestore();
    });
});
