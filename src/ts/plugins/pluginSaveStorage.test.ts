import { beforeEach, describe, expect, test, vi } from "vitest";

type MockV3PluginInitializationOutcome =
    | { pluginName: string; status: "fulfilled" }
    | { pluginName: string; status: "rejected"; reason: unknown };

let database: any;
const persistent = vi.hoisted(() => new Map<string, unknown>());
const requestImmediateSave = vi.hoisted(() => vi.fn());
const teardownV3PluginsMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadV3PluginGenerationOutcomesMock = vi.hoisted(() => vi.fn(
    async (plugins: any[]): Promise<MockV3PluginInitializationOutcome[]> => plugins.map(plugin => ({
        pluginName: plugin.name,
        status: "fulfilled" as const,
    })),
));

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
    setPatchSyncBaseline: vi.fn(),
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
    loadV3PluginGenerationOutcomes: loadV3PluginGenerationOutcomesMock,
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
        return Buffer.from(value, "utf-8").toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/g, "");
    };
    const decode = (value: string) => Buffer.from(
        value.replace(/-/g, "+").replace(/_/g, "/")
            .padEnd(Math.ceil(value.length / 4) * 4, "="),
        "base64",
    ).toString("utf-8");
    const writePersistentJson = vi.fn(async (key: string, value: unknown) => {
        persistent.set(key, value);
    });
    let stagedPlan: any = null;
    const stagedRows = new Map<string, Uint8Array>();
    const stagedStatus = async () => {
        const storageKeys = stagedPlan.targetOptimized
            ? stagedPlan.rows.map((row: any) => row.storageKey)
            : [
                ...(stagedPlan.source.manifest?.valueKeys ?? []),
                ...(stagedPlan.source.manifest?.metaKeys ?? []),
            ];
        return {
            success: true as const,
            transitionId: stagedPlan.transitionId,
            state: "ready" as const,
            direction: stagedPlan.targetOptimized ? "externalize" as const : "internalize" as const,
            targetGeneration: stagedPlan.targetGeneration,
            rows: await Promise.all(storageKeys.map(async (storageKey: string) => {
                const bytes = stagedRows.get(storageKey)
                    ?? new TextEncoder().encode(JSON.stringify(persistent.get(storageKey)));
                return {
                    storageKey,
                    size: bytes.byteLength,
                    sha256: [...new Uint8Array(await crypto.subtle.digest(
                        "SHA-256",
                        bytes as unknown as BufferSource,
                    ))]
                        .map(byte => byte.toString(16).padStart(2, "0"))
                        .join(""),
                    uploaded: !stagedPlan.targetOptimized || stagedRows.has(storageKey),
                };
            })),
            uploaded: storageKeys.filter((storageKey: string) => (
                !stagedPlan.targetOptimized || stagedRows.has(storageKey)
            )).length,
            total: storageKeys.length,
            totalBytes: storageKeys.reduce((total: number, storageKey: string) => total + (
                stagedRows.get(storageKey)
                    ?? new TextEncoder().encode(JSON.stringify(persistent.get(storageKey)))
            ).byteLength, 0),
        };
    };
    return {
        abortPersistentPluginStorageTransition: vi.fn(async () => ({
            ...await stagedStatus(),
            state: "aborted" as const,
        })),
        batchPersistentPluginStorage: vi.fn(async (request: any) => {
            const generation = crypto.randomUUID();
            for (const operation of request.operations) {
                const valueKey = `pluginsave/${encode(operation.key)}.json`;
                const metaKey = `pluginsave-meta/${encode(operation.key)}.json`;
                if (operation.operation === "set") {
                    persistent.set(valueKey, JSON.parse(new TextDecoder().decode(operation.valueBytes)));
                    persistent.set(metaKey, {
                        plugin: operation.owner,
                        updatedAt: Date.now(),
                        generation,
                    });
                } else {
                    persistent.delete(valueKey);
                    persistent.delete(metaKey);
                }
            }
            return {
                outcome: "committed" as const,
                generation,
                revisions: request.operations.map((operation: any) => ({
                    key: operation.key,
                    revision: operation.operation === "set" ? `sha256:${"a".repeat(64)}` : null,
                    valueHash: operation.operation === "set" ? "c".repeat(64) : null,
                })),
            };
        }),
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
        commitPersistentPluginStorageMutation: vi.fn(async (mutation: any) => {
            for (const write of mutation.writes) {
                persistent.set(
                    write.storageKey,
                    JSON.parse(new TextDecoder().decode(write.valueBytes)),
                );
            }
            for (const key of mutation.deletes) persistent.delete(key);
            persistent.set("plugin-storage/manifest.json", mutation.nextManifest);
        }),
        commitPersistentPluginStorageTransition: vi.fn(),
        beginPersistentPluginStorageTransition: vi.fn(async (plan: any) => {
            stagedPlan = plan;
            stagedRows.clear();
            return await stagedStatus();
        }),
        decodeStorageKeyComponent: decode,
        getPersistentStorageFreeBytes: vi.fn(async () => null),
        listPersistentEntriesWithSizes: vi.fn(async (prefix: string) =>
            [...persistent.entries()]
                .filter(([key]) => key.startsWith(prefix))
                .map(([key, value]) => ({
                    key,
                    size: new TextEncoder().encode(JSON.stringify(value)).byteLength,
                })),
        ),
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
        restorePersistentPluginStoragePair: vi.fn(async (
            valueKey: string,
            value: unknown,
            ownerRecord: unknown | undefined,
        ) => {
            const encodedKey = valueKey.slice("pluginsave/".length, -".json".length);
            const metaKey = `pluginsave-meta/${encodedKey}.json`;
            persistent.set(valueKey, value);
            if (ownerRecord !== undefined) persistent.set(metaKey, ownerRecord);
            return {
                outcome: "committed" as const,
                operation: "set" as const,
                verification: "verified" as const,
            };
        }),
        setPreparedPersistentPluginStoragePreservingOwner: vi.fn(async (
            valueKey: string,
            prepared: { value?: unknown; bytes: Uint8Array },
        ) => {
            persistent.set(
                valueKey,
                prepared.value ?? JSON.parse(new TextDecoder().decode(prepared.bytes)),
            );
            return {
                outcome: "committed" as const,
                operation: "set" as const,
                verification: "verified" as const,
            };
        }),
        removePersistentPluginStoragePreservingOwner: vi.fn(async (
            valueKey: string,
        ) => {
            persistent.delete(valueKey);
            const manifest = persistent.get("plugin-storage/manifest.json") as any;
            if (manifest) {
                persistent.set("plugin-storage/manifest.json", {
                    ...manifest,
                    valueKeys: manifest.valueKeys.filter((key: string) => key !== valueKey),
                });
            }
            return {
                outcome: "committed" as const,
                operation: "remove" as const,
                verification: "verified" as const,
            };
        }),
        readPersistentPluginStorageManifestSnapshot: vi.fn(async (generation: string) => {
            const manifest = persistent.get("plugin-storage/manifest.json") as any ?? {
                version: 1,
                generation,
                valueKeys: [...persistent.keys()].filter(key => key.startsWith("pluginsave/")),
                metaKeys: [...persistent.keys()].filter(key => key.startsWith("pluginsave-meta/")),
            };
            return {
                generation,
                manifestRevision: `sha256:${"d".repeat(64)}`,
                manifest,
                valueKeys: manifest.valueKeys.filter((key: string) => persistent.has(key)),
                metaKeys: manifest.metaKeys.filter((key: string) => persistent.has(key)),
            };
        }),
        readPersistentPluginStorageManifestState: vi.fn(async (generation: string) => ({
            generation,
            manifestRevision: `sha256:${"d".repeat(64)}`,
        })),
        readPersistentPluginStorageViewerPage: vi.fn(async (
            generation: string,
            options: { page: number; pageSize: number },
        ) => ({
            generation,
            manifestRevision: `sha256:${"d".repeat(64)}`,
            databaseRevision: "e".repeat(32),
            pageToken: `sha256:${"f".repeat(64)}`,
            page: options.page,
            pageSize: options.pageSize,
            pageCount: 1,
            total: 0,
            ownerFacets: [],
            unknownOwnerCount: 0,
            ownerFacetTotal: 0,
            entries: [],
            metrics: {
                manifestParses: 1,
                valueReads: 0,
                ownerReads: 0,
                maxRowParses: 0,
            },
        })),
        readPersistentPluginStorageState: vi.fn(async (valueKey: string) => {
            if (!persistent.has(valueKey)) {
                return { status: "missing" as const, value: null, revision: null, generation: null };
            }
            return {
                status: "value" as const,
                value: persistent.get(valueKey),
                revision: `sha256:${"b".repeat(64)}`,
                generation: null,
            };
        }),
        readPersistentPluginStorageTransitionRow: vi.fn(async (
            _transitionId: string,
            storageKey: string,
        ) => stagedRows.get(storageKey)
            ?? new TextEncoder().encode(JSON.stringify(persistent.get(storageKey)))),
        readPersistentJson: vi.fn(async (key: string) => persistent.get(key) ?? null),
        readPersistentJsonRow: vi.fn(async (key: string) => persistent.has(key)
            ? { kind: "value", value: persistent.get(key) }
            : { kind: "missing" }),
        removePersistentKey: vi.fn(async (key: string) => {
            persistent.delete(key);
        }),
        uploadPersistentPluginStorageTransitionRow: vi.fn(async (
            _transitionId: string,
            storageKey: string,
            bytes: Uint8Array,
        ) => {
            stagedRows.set(storageKey, new Uint8Array(bytes));
            return await stagedStatus();
        }),
        finalizePersistentPluginStorageTransition: vi.fn(async () => {
            if (stagedPlan.targetOptimized) {
                for (const [storageKey, bytes] of stagedRows) {
                    persistent.set(
                        storageKey,
                        JSON.parse(new TextDecoder().decode(bytes)),
                    );
                }
                persistent.set("plugin-storage/manifest.json", {
                    version: 1,
                    generation: stagedPlan.targetGeneration,
                    valueKeys: stagedPlan.rows
                        .map((row: any) => row.storageKey)
                        .filter((key: string) => key.startsWith("pluginsave/")),
                    metaKeys: stagedPlan.rows
                        .map((row: any) => row.storageKey)
                        .filter((key: string) => key.startsWith("pluginsave-meta/")),
                });
            } else {
                for (const storageKey of [
                    ...(stagedPlan.source.manifest?.valueKeys ?? []),
                    ...(stagedPlan.source.manifest?.metaKeys ?? []),
                ]) persistent.delete(storageKey);
                persistent.delete("plugin-storage/manifest.json");
            }
            return { ...await stagedStatus(), state: "committed" as const };
        }),
        writePersistentJson,
        preparePersistentJson: vi.fn((value: unknown) => {
            const bytes = new TextEncoder().encode(JSON.stringify(value));
            return { bytes, byteLength: bytes.byteLength, value };
        }),
        writePreparedPersistentJson: vi.fn(
            async (key: string, prepared: { value: unknown }) =>
                writePersistentJson(key, prepared.value),
        ),
    };
});

const {
    atomicBatchOwnedPluginSaveStorage,
    clearOwnedPluginSaveStorage,
    countExternalizedPluginStorageEntries,
    getPluginSaveStorageItem,
    getPluginSaveStorageItemWithRevision,
    readPluginSaveStorageItemResult,
    getPluginSaveStorageKey,
    getPluginSaveStorageKeys,
    getPluginSaveStorageLength,
    getPluginSaveStorageOwners,
    getPluginSaveStorageViewerPage,
    PLUGIN_STORAGE_TRANSITION_WAIT_TIMEOUT_MS,
    PLUGIN_SAVE_META_PREFIX,
    PLUGIN_SAVE_PREFIX,
    PLUGIN_STORAGE_MANIFEST_KEY,
    readExternalizedPluginStorage,
    reconcilePluginStorageMode,
    reconcilePluginStorageModeForBoot,
    removePluginSaveStorageItem,
    rewriteOwnedPluginSaveStorageItem,
    setOwnedPluginSaveStorageItem,
    setOwnedPluginSaveStorageItemFromRead,
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
    waitForDeferredPluginApiReloadIdle,
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
    const component = Buffer.from(key, "utf-8").toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
    return `${prefix}${component}.json`;
}

function installOwnershipManifest(
    generation: string,
    valueKeys: string[],
    metaKeys: string[],
    destination = persistent,
) {
    database.pluginStorageGeneration = generation;
    destination.set(PLUGIN_STORAGE_MANIFEST_KEY, {
        version: 1,
        generation,
        valueKeys,
        metaKeys,
    });
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
    loadV3PluginGenerationOutcomesMock.mockImplementation(async (plugins: any[]) => (
        plugins.map(plugin => ({ pluginName: plugin.name, status: "fulfilled" as const }))
    ));
    database = {
        characters: [],
        botPresets: [],
        modules: [],
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
        restorePersistentPluginStoragePair,
        readPersistentPluginStorageManifestSnapshot,
        readPersistentPluginStorageManifestState,
        removePersistentKey,
        setPreparedPersistentPluginStoragePreservingOwner,
        writePersistentJson,
        commitPersistentPluginStorageTransition,
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
        const manifest = persistent.get(PLUGIN_STORAGE_MANIFEST_KEY) as any;
        if (manifest) {
            const valueKeys = new Set<string>(manifest.valueKeys);
            const metaKeys = new Set<string>(manifest.metaKeys);
            if (operation === "set") valueKeys.add(valueKey);
            else {
                valueKeys.delete(valueKey);
                metaKeys.delete(metaKey);
            }
            persistent.set(PLUGIN_STORAGE_MANIFEST_KEY, {
                ...manifest,
                valueKeys: [...valueKeys],
                metaKeys: [...metaKeys],
            });
        }
        return { outcome: "committed", operation, verification: "verified" };
    });
    restorePersistentPluginStoragePair.mockImplementation(async (
        valueKey: string,
        value: unknown,
        ownerRecord: unknown | undefined,
    ) => {
        const encodedKey = valueKey.slice(PLUGIN_SAVE_PREFIX.length, -".json".length);
        const metaKey = `${PLUGIN_SAVE_META_PREFIX}${encodedKey}.json`;
        persistent.set(valueKey, value);
        if (ownerRecord !== undefined) persistent.set(metaKey, ownerRecord);
        return { outcome: "committed", operation: "set", verification: "verified" };
    });
    setPreparedPersistentPluginStoragePreservingOwner.mockImplementation(async (
        valueKey: string,
        prepared: { value?: unknown; bytes: Uint8Array },
    ) => {
        persistent.set(
            valueKey,
            prepared.value ?? JSON.parse(new TextDecoder().decode(prepared.bytes)),
        );
        const manifest = persistent.get(PLUGIN_STORAGE_MANIFEST_KEY) as any;
        if (manifest) {
            persistent.set(PLUGIN_STORAGE_MANIFEST_KEY, {
                ...manifest,
                valueKeys: [...new Set<string>([...manifest.valueKeys, valueKey])],
            });
        }
        return { outcome: "committed", operation: "set", verification: "verified" };
    });
    readPersistentPluginStorageManifestSnapshot.mockImplementation(async (generation: string) => {
        const manifest = persistent.get(PLUGIN_STORAGE_MANIFEST_KEY) as any ?? {
            version: 1, generation, valueKeys: [], metaKeys: [],
        };
        return {
            generation,
            manifestRevision: `sha256:${"d".repeat(64)}`,
            manifest,
            valueKeys: manifest.valueKeys.filter((key: string) => persistent.has(key)),
            metaKeys: manifest.metaKeys.filter((key: string) => persistent.has(key)),
        };
    });
    readPersistentPluginStorageManifestState.mockImplementation(async (generation: string) => ({
        generation,
        manifestRevision: `sha256:${"d".repeat(64)}`,
    }));
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
    commitPersistentPluginStorageTransition.mockResolvedValue({ etag: "test-etag" });
});

describe("AA3 versioned atomic plugin storage", () => {
    test.each([
        "config",
        "credential",
        "index",
        "ledger",
        "shard",
    ])("a failed %s read cannot publish its destructive fallback", async (key) => {
        database.optimizePluginMemory = true;
        const valueKey = encoded(PLUGIN_SAVE_PREFIX, key);
        const metaKey = encoded(PLUGIN_SAVE_META_PREFIX, key);
        persistent.set(valueKey, { durable: key, entries: ["old"] });
        persistent.set(metaKey, { plugin: "Existing", updatedAt: 1 });
        installOwnershipManifest("selected-generation", [valueKey], [metaKey]);

        const { batchPersistentPluginStorage, readPersistentPluginStorageState } = vi.mocked(
            await import("../storage/persistentKv"),
        );
        readPersistentPluginStorageState.mockRejectedValueOnce(Object.assign(
            new Error(`temporary ${key} read failure`),
            {
                name: "StorageError",
                status: 503,
                code: "TEMPORARY_STORAGE_FAILURE",
                retryAfter: 0,
                retryable: true,
                commitOutcomeUnknown: false,
                operation: "read",
            },
        ));

        const read = await readPluginSaveStorageItemResult(key);
        expect(read).toMatchObject({
            status: "failed",
            key,
            error: {
                code: "TEMPORARY_STORAGE_FAILURE",
                retryable: true,
                operation: "read",
            },
        });
        const result = await setOwnedPluginSaveStorageItemFromRead(
            read,
            key === "credential" ? "" : { entries: [] },
            "IP1",
        );

        expect(result).toMatchObject({ status: "failed", stage: "read" });
        expect(batchPersistentPluginStorage).not.toHaveBeenCalled();
        expect(persistent.get(valueKey)).toEqual({ durable: key, entries: ["old"] });
    });

    test("the public read result keeps missing distinct from a stored null", async () => {
        database.pluginCustomStorage = { nullable: null };
        database.pluginStorageMeta = { nullable: { plugin: "IP1", updatedAt: 1 } };

        const nullable = await readPluginSaveStorageItemResult("nullable");
        const missing = await readPluginSaveStorageItemResult("missing");

        expect(nullable).toMatchObject({
            status: "value",
            key: "nullable",
            value: null,
            revision: expect.stringMatching(/^sha256:/),
        });
        expect(missing).toEqual({
            status: "missing",
            key: "missing",
            value: null,
            revision: null,
            generation: null,
        });
    });

    test("setFromRead conflicts instead of overwriting a changed or mistaken-missing row", async () => {
        database.pluginCustomStorage = { record: { version: 1 } };
        database.pluginStorageMeta = { record: { plugin: "IP1", updatedAt: 1 } };
        const oldRecord = await readPluginSaveStorageItemResult("record");
        const missing = await readPluginSaveStorageItemResult("new-record");

        await setOwnedPluginSaveStorageItem("record", { version: 2 }, "Concurrent");
        await setOwnedPluginSaveStorageItem("new-record", { version: "current" }, "Concurrent");

        await expect(setOwnedPluginSaveStorageItemFromRead(
            oldRecord,
            { version: "stale-fallback" },
            "IP1",
        )).resolves.toMatchObject({ status: "conflict" });
        await expect(setOwnedPluginSaveStorageItemFromRead(
            missing,
            { version: "empty-fallback" },
            "IP1",
        )).resolves.toMatchObject({ status: "conflict" });
        expect(database.pluginCustomStorage).toMatchObject({
            record: { version: 2 },
            "new-record": { version: "current" },
        });
    });

    test("rewrites one value with a single atomic set and reports only its confirmed outcome", async () => {
        database.pluginCustomStorage = { index: { entries: [1, 2, 3] } };
        database.pluginStorageMeta = { index: { plugin: "legacy", updatedAt: 1 } };
        const current = await getPluginSaveStorageItemWithRevision("index");
        expect(current.status).toBe("value");

        const result = await rewriteOwnedPluginSaveStorageItem(
            "index",
            current.value,
            "Maintenance Plugin",
            current.revision,
        );

        expect(result).toMatchObject({
            committed: true,
            revisions: [{ key: "index", revision: expect.stringMatching(/^sha256:/) }],
        });
        expect(database.pluginCustomStorage.index).toEqual({ entries: [1, 2, 3] });
        expect(database.pluginStorageMeta.index.plugin).toBe("Maintenance Plugin");
    });

    test("a cancelled or stale rewrite preserves the original row and exposes no false success", async () => {
        database.pluginCustomStorage = { index: { version: 1 } };
        database.pluginStorageMeta = { index: { plugin: "legacy", updatedAt: 1 } };
        const stale = await getPluginSaveStorageItemWithRevision("index");
        expect(stale.status).toBe("value");

        await setOwnedPluginSaveStorageItem("index", { version: 2 }, "Live Writer");
        const conflict = await rewriteOwnedPluginSaveStorageItem(
            "index",
            stale.value,
            "Maintenance Plugin",
            stale.revision,
        );
        expect(conflict).toMatchObject({
            committed: false,
            conflicts: [{ key: "index" }],
        });
        expect(database.pluginCustomStorage.index).toEqual({ version: 2 });

        const controller = new AbortController();
        controller.abort(new DOMException("terminated before rewrite", "AbortError"));
        await expect(rewriteOwnedPluginSaveStorageItem(
            "index",
            { version: 3 },
            "Maintenance Plugin",
            undefined,
            controller.signal,
        )).rejects.toMatchObject({ name: "AbortError" });
        expect(database.pluginCustomStorage.index).toEqual({ version: 2 });
    });

    test("publishes an inline multi-key generation without an observable prefix", async () => {
        database.pluginCustomStorage = { retained: { generation: "old" } };
        const result = await atomicBatchOwnedPluginSaveStorage([
            { type: "set", key: "body:0", value: { generation: "new", part: 0 } },
            { type: "set", key: "body:1", value: { generation: "new", part: 1 } },
            { type: "set", key: "manifest", value: { generation: "new", count: 2 } },
            { type: "remove", key: "retained" },
        ], "AA3 Plugin");

        expect(result.committed).toBe(true);
        expect(database.pluginCustomStorage).toEqual({
            "body:0": { generation: "new", part: 0 },
            "body:1": { generation: "new", part: 1 },
            manifest: { generation: "new", count: 2 },
        });
        expect(new Set(Object.values(database.pluginStorageMeta)
            .map((record: any) => record.generation))).toEqual(new Set([(result as any).generation]));
    });

    test("distinguishes stored null from missing and rejects a stale CAS before publish", async () => {
        database.pluginCustomStorage = { nullable: null, record: { version: 1 } };
        database.pluginStorageMeta = {
            nullable: { plugin: "AA3", updatedAt: 1 },
            record: { plugin: "AA3", updatedAt: 1 },
        };
        const nullable = await getPluginSaveStorageItemWithRevision("nullable");
        const missing = await getPluginSaveStorageItemWithRevision("missing");
        const original = await getPluginSaveStorageItemWithRevision("record");
        expect(nullable).toMatchObject({ status: "value", value: null });
        expect(missing).toEqual({ status: "missing", value: null, revision: null, generation: null });
        expect(original.status).toBe("value");

        await setOwnedPluginSaveStorageItem("record", { version: 2 }, "AA3");
        const conflict = await atomicBatchOwnedPluginSaveStorage([
            {
                type: "set",
                key: "record",
                value: { version: 3 },
                expectedRevision: original.revision,
            },
            { type: "set", key: "must-not-appear", value: true },
        ], "AA3");
        expect(conflict).toMatchObject({ committed: false });
        expect(database.pluginCustomStorage.record).toEqual({ version: 2 });
        expect(database.pluginCustomStorage).not.toHaveProperty("must-not-appear");
    });

    test("serializes whole-map inline publication against a disjoint single-key write", async () => {
        database.pluginCustomStorage = { cas: { version: 1 } };
        database.pluginStorageMeta = { cas: { plugin: "legacy", updatedAt: 1 } };
        const original = await getPluginSaveStorageItemWithRevision("cas");
        expect(original.status).toBe("value");

        const actualDigest = crypto.subtle.digest.bind(crypto.subtle);
        let releaseDigest!: () => void;
        const digestGate = new Promise<void>(resolve => { releaseDigest = resolve; });
        let firstDigestStarted!: () => void;
        const firstDigest = new Promise<void>(resolve => { firstDigestStarted = resolve; });
        let gated = false;
        const digestSpy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
            if (!gated) {
                gated = true;
                firstDigestStarted();
                await digestGate;
            }
            return actualDigest(...args);
        });
        try {
            const batch = atomicBatchOwnedPluginSaveStorage([{
                type: "set",
                key: "cas",
                value: { version: 2 },
                expectedRevision: original.revision,
            }, {
                type: "set",
                key: "batch-only",
                value: true,
            }], "AA3");
            await firstDigest;
            const disjoint = setOwnedPluginSaveStorageItem("single-only", true, "AA3");
            releaseDigest();
            await expect(batch).resolves.toMatchObject({ committed: true });
            await expect(disjoint).resolves.toBeUndefined();
        } finally {
            digestSpy.mockRestore();
            releaseDigest?.();
        }

        expect(database.pluginCustomStorage).toMatchObject({
            cas: { version: 2 },
            "batch-only": true,
            "single-only": true,
        });
        expect(database.pluginStorageMeta).toHaveProperty("batch-only");
        expect(database.pluginStorageMeta).toHaveProperty("single-only");
    });

    test.each([
        "set",
        "remove",
        "clear",
        "setDatabaseLite",
        "setDatabase",
        "nested-set",
    ] as const)("retries V3 publication after a synchronous V2 %s", async legacyMutation => {
        database.pluginCustomStorage = {
            retained: { nested: { version: 1 } },
            "remove-me": true,
            stale: true,
        };
        database.pluginStorageMeta = {};
        const v2Apis = getV2PluginAPIs();
        const retainedDatabase = v2Apis.getDatabase() as any;
        const retainedNested = retainedDatabase.pluginCustomStorage.retained.nested;
        const actualDigest = crypto.subtle.digest.bind(crypto.subtle);
        let releaseDigest!: () => void;
        const digestGate = new Promise<void>(resolve => { releaseDigest = resolve; });
        let markDigestStarted!: () => void;
        const digestStarted = new Promise<void>(resolve => { markDigestStarted = resolve; });
        let gated = false;
        const digestSpy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
            if (!gated) {
                gated = true;
                markDigestStarted();
                await digestGate;
            }
            return actualDigest(...args);
        });
        let legacyCompletion: Promise<unknown> = Promise.resolve();
        try {
            const batch = atomicBatchOwnedPluginSaveStorage([{
                type: "set",
                key: "batch-only",
                value: { from: "v3" },
            }], "AA3");
            await digestStarted;
            switch (legacyMutation) {
                case "set":
                    v2Apis.pluginStorage.setItem("legacy-set", "kept");
                    break;
                case "remove":
                    v2Apis.pluginStorage.removeItem("remove-me");
                    break;
                case "clear":
                    v2Apis.pluginStorage.clear();
                    break;
                case "setDatabaseLite":
                    v2Apis.setDatabaseLite({ pluginCustomStorage: { "lite-replacement": true } });
                    break;
                case "setDatabase":
                    legacyCompletion = v2Apis.setDatabase({
                        pluginCustomStorage: { "full-replacement": true },
                    });
                    break;
                case "nested-set":
                    retainedNested.version = 2;
                    break;
            }
            releaseDigest();
            await legacyCompletion;
            await expect(batch).resolves.toMatchObject({ committed: true });
        } finally {
            digestSpy.mockRestore();
            releaseDigest?.();
        }

        expect(database.pluginCustomStorage["batch-only"]).toEqual({ from: "v3" });
        if (legacyMutation === "set") {
            expect(database.pluginCustomStorage["legacy-set"]).toBe("kept");
        } else if (legacyMutation === "remove") {
            expect(database.pluginCustomStorage).not.toHaveProperty("remove-me");
        } else if (legacyMutation === "clear") {
            expect(database.pluginCustomStorage).toEqual({
                "batch-only": { from: "v3" },
            });
        } else if (legacyMutation === "setDatabaseLite") {
            expect(database.pluginCustomStorage).toEqual({
                "lite-replacement": true,
                "batch-only": { from: "v3" },
            });
        } else if (legacyMutation === "setDatabase") {
            expect(database.pluginCustomStorage).toEqual({
                "full-replacement": true,
                "batch-only": { from: "v3" },
            });
        } else {
            expect(database.pluginCustomStorage.retained.nested.version).toBe(2);
        }
    });

    test("re-evaluates CAS after a synchronous V2 write to the touched key", async () => {
        database.pluginCustomStorage = { cas: { version: 1 } };
        database.pluginStorageMeta = { cas: { plugin: "legacy", updatedAt: 1 } };
        const original = await getPluginSaveStorageItemWithRevision("cas");
        expect(original.status).toBe("value");
        const v2Apis = getV2PluginAPIs();
        const actualDigest = crypto.subtle.digest.bind(crypto.subtle);
        let releaseDigest!: () => void;
        const digestGate = new Promise<void>(resolve => { releaseDigest = resolve; });
        let markDigestStarted!: () => void;
        const digestStarted = new Promise<void>(resolve => { markDigestStarted = resolve; });
        let gated = false;
        const digestSpy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
            if (!gated) {
                gated = true;
                markDigestStarted();
                await digestGate;
            }
            return actualDigest(...args);
        });
        try {
            const batch = atomicBatchOwnedPluginSaveStorage([{
                type: "set",
                key: "cas",
                value: { version: 3 },
                expectedRevision: original.revision,
            }], "AA3");
            await digestStarted;
            (v2Apis.pluginStorage.setItem as any)("cas", { version: 2 });
            releaseDigest();
            await expect(batch).resolves.toMatchObject({
                committed: false,
                conflicts: [{ key: "cas" }],
            });
        } finally {
            digestSpy.mockRestore();
            releaseDigest?.();
        }
        expect(database.pluginCustomStorage.cas).toEqual({ version: 2 });
    });

    test("treats malformed UUID-looking owners as deterministic legacy rows", async () => {
        database.pluginCustomStorage = {
            alpha: { stable: true },
            beta: { stable: true },
            malformedNull: { stable: true },
            unowned: { stable: true },
        };
        database.pluginStorageMeta = {
            alpha: {
                plugin: "legacy-a",
                updatedAt: 1,
                revision: "123e4567-e89b-42d3-a456-426614174000",
            },
            beta: {
                plugin: "legacy-b",
                updatedAt: 1,
                revision: "123e4567-e89b-42d3-a456-426614174000",
            },
            malformedNull: null,
        };
        const alpha1 = await getPluginSaveStorageItemWithRevision("alpha");
        const alpha2 = await getPluginSaveStorageItemWithRevision("alpha");
        const beta = await getPluginSaveStorageItemWithRevision("beta");
        const malformedNull = await getPluginSaveStorageItemWithRevision("malformedNull");
        const unowned = await getPluginSaveStorageItemWithRevision("unowned");
        expect(alpha1).toMatchObject({ status: "value", generation: null });
        expect(alpha2).toEqual(alpha1);
        expect(beta).toMatchObject({ status: "value", generation: null });
        expect((alpha1 as any).revision).not.toBe((beta as any).revision);
        expect((malformedNull as any).revision).not.toBe((unowned as any).revision);
    });

    test("rejects duplicate keys during bounded preflight", async () => {
        await expect(atomicBatchOwnedPluginSaveStorage([
            { type: "set", key: "same", value: 1 },
            { type: "remove", key: "same" },
        ], "AA3")).rejects.toThrow("Duplicate");
        expect(database.pluginCustomStorage).toEqual({});
    });

    test("cancels bounded preparation before queue admission", async () => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 0);
        const mutations = Array.from({ length: 17 }, (_, index) => ({
            type: "set" as const,
            key: `prepared:${index}`,
            value: { index },
        }));
        await expect(atomicBatchOwnedPluginSaveStorage(
            mutations,
            "AA3",
            controller.signal,
        )).rejects.toMatchObject({ name: "AbortError" });
        expect(database.pluginCustomStorage).toEqual({});
    });

    test("detaches every batch value synchronously before bounded preparation yields", async () => {
        database.optimizePluginMemory = true;
        installOwnershipManifest("selected-generation", [], []);
        const {
            batchPersistentPluginStorage,
            listPersistentKeys,
            readPersistentJson,
            readPersistentPluginStorageManifestSnapshot,
            readPersistentPluginStorageManifestState,
        } = vi.mocked(
            await import("../storage/persistentKv"),
        );
        const values = Array.from({ length: 17 }, (_, index) => ({ captured: index }));
        const batch = atomicBatchOwnedPluginSaveStorage(values.map((value, index) => ({
            type: "set" as const,
            key: `detached:${index}`,
            value,
        })), "AA3");

        values[0].captured = -1;
        values[16].captured = -1;
        await expect(batch).resolves.toMatchObject({ committed: true });

        const request = batchPersistentPluginStorage.mock.calls[0][0];
        expect(JSON.parse(new TextDecoder().decode(
            (request.operations[0] as any).valueBytes,
        ))).toEqual({ captured: 0 });
        expect(JSON.parse(new TextDecoder().decode(
            (request.operations[16] as any).valueBytes,
        ))).toEqual({ captured: 16 });
    });

    test("optimized mode sends one detached authoritative batch", async () => {
        database.optimizePluginMemory = true;
        installOwnershipManifest("selected-generation", [], []);
        const {
            batchPersistentPluginStorage,
            listPersistentKeys,
            readPersistentJson,
            readPersistentPluginStorageManifestSnapshot,
            readPersistentPluginStorageManifestState,
        } = vi.mocked(
            await import("../storage/persistentKv"),
        );
        const result = await atomicBatchOwnedPluginSaveStorage([
            { type: "set", key: "body", value: { detached: true } },
            { type: "set", key: "manifest", value: ["body"] },
        ], "AA3");
        expect(result.committed).toBe(true);
        expect(batchPersistentPluginStorage).toHaveBeenCalledOnce();
        expect(readPersistentPluginStorageManifestState).toHaveBeenCalledOnce();
        expect(readPersistentPluginStorageManifestState).toHaveBeenCalledWith(
            "selected-generation",
            undefined,
        );
        expect(readPersistentPluginStorageManifestSnapshot).not.toHaveBeenCalled();
        expect(listPersistentKeys).not.toHaveBeenCalled();
        expect(readPersistentJson).not.toHaveBeenCalled();
        const request = batchPersistentPluginStorage.mock.calls[0][0];
        expect(request).toMatchObject({
            generation: "selected-generation",
            expectedManifestRevision: `sha256:${"d".repeat(64)}`,
        });
        expect(request).not.toHaveProperty("expectedManifest");
        expect(request.operations).toHaveLength(2);
        expect(JSON.parse(new TextDecoder().decode(
            (request.operations[0] as any).valueBytes,
        ))).toEqual({ detached: true });
    });

    test("orders overlapping key sets without deadlock while disjoint batches proceed", async () => {
        database.optimizePluginMemory = true;
        installOwnershipManifest("selected-generation", [], []);
        const { batchPersistentPluginStorage } = vi.mocked(
            await import("../storage/persistentKv"),
        );
        const original = batchPersistentPluginStorage.getMockImplementation()!;
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
        const entered: string[][] = [];
        batchPersistentPluginStorage.mockImplementation(async (request: any) => {
            const requestKeys = request.operations.map((operation: any) => operation.key);
            entered.push(requestKeys);
            if (requestKeys.includes("shared")) await firstGate;
            return {
                outcome: "committed",
                generation: crypto.randomUUID(),
                revisions: request.operations.map((operation: any) => ({
                    key: operation.key,
                    revision: operation.operation === "set" ? `sha256:${"a".repeat(64)}` : null,
                })),
            } as any;
        });
        try {
            const first = atomicBatchOwnedPluginSaveStorage([
                { type: "set", key: "shared", value: 1 },
                { type: "set", key: "z", value: 1 },
            ], "AA3");
            await vi.waitFor(() => expect(entered).toHaveLength(1));
            const overlapping = atomicBatchOwnedPluginSaveStorage([
                { type: "set", key: "a", value: 2 },
                { type: "set", key: "shared", value: 2 },
            ], "AA3");
            const disjoint = atomicBatchOwnedPluginSaveStorage([
                { type: "set", key: "other", value: 3 },
            ], "AA3");
            await vi.waitFor(() => expect(entered).toContainEqual(["other"]));
            expect(entered).not.toContainEqual(["a", "shared"]);
            releaseFirst();
            await expect(Promise.all([first, overlapping, disjoint])).resolves.toHaveLength(3);
            expect(entered).toEqual([
                ["shared", "z"],
                ["other"],
                ["a", "shared"],
            ]);
        } finally {
            releaseFirst?.();
            batchPersistentPluginStorage.mockImplementation(original);
        }
    });

    test("keeps an aborted overlapping batch queued so its successor cannot overtake", async () => {
        database.optimizePluginMemory = true;
        installOwnershipManifest("selected-generation", [], []);
        const { batchPersistentPluginStorage } = vi.mocked(
            await import("../storage/persistentKv"),
        );
        const original = batchPersistentPluginStorage.getMockImplementation()!;
        let releaseFirst!: () => void;
        const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
        const entered: string[] = [];
        batchPersistentPluginStorage.mockImplementation(async (request: any) => {
            const key = request.operations[0].key;
            entered.push(key);
            if (key === "held") await gate;
            return {
                outcome: "committed",
                generation: crypto.randomUUID(),
                revisions: request.operations.map((operation: any) => ({
                    key: operation.key,
                    revision: `sha256:${"b".repeat(64)}`,
                })),
            } as any;
        });
        const controller = new AbortController();
        try {
            const held = atomicBatchOwnedPluginSaveStorage([
                { type: "set", key: "held", value: 1 },
                { type: "set", key: "shared", value: 1 },
            ], "AA3");
            await vi.waitFor(() => expect(entered).toEqual(["held"]));
            const cancelled = atomicBatchOwnedPluginSaveStorage([
                { type: "set", key: "shared", value: 2 },
                { type: "set", key: "successor", value: 2 },
            ], "AA3", controller.signal);
            const successor = atomicBatchOwnedPluginSaveStorage([
                { type: "set", key: "successor", value: 3 },
            ], "AA3");
            controller.abort();
            await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(entered).toEqual(["held"]);
            releaseFirst();
            await expect(held).resolves.toMatchObject({ committed: true });
            await expect(successor).resolves.toMatchObject({ committed: true });
            expect(entered).toEqual(["held", "successor"]);
        } finally {
            releaseFirst?.();
            batchPersistentPluginStorage.mockImplementation(original);
        }
    });

    test("holds a mode transition behind an active batch", async () => {
        database.optimizePluginMemory = true;
        installOwnershipManifest("selected-generation", [], []);
        const { batchPersistentPluginStorage } = vi.mocked(
            await import("../storage/persistentKv"),
        );
        const original = batchPersistentPluginStorage.getMockImplementation()!;
        let releaseBatch!: () => void;
        let markEntered!: () => void;
        const gate = new Promise<void>(resolve => { releaseBatch = resolve; });
        const entered = new Promise<void>(resolve => { markEntered = resolve; });
        batchPersistentPluginStorage.mockImplementation(async (request: any) => {
            markEntered();
            await gate;
            return {
                outcome: "committed",
                generation: crypto.randomUUID(),
                revisions: request.operations.map((operation: any) => ({
                    key: operation.key,
                    revision: `sha256:${"c".repeat(64)}`,
                })),
            } as any;
        });
        try {
            const batch = atomicBatchOwnedPluginSaveStorage([
                { type: "set", key: "transition", value: true },
            ], "AA3");
            await entered;
            let transitioned = false;
            const transition = withPluginSaveStorageLock(async () => { transitioned = true; });
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(transitioned).toBe(false);
            releaseBatch();
            await expect(batch).resolves.toMatchObject({ committed: true });
            await expect(transition).resolves.toBeUndefined();
            expect(transitioned).toBe(true);
        } finally {
            releaseBatch?.();
            batchPersistentPluginStorage.mockImplementation(original);
        }
    });
});

describe("readExternalizedPluginStorage", () => {
    beforeEach(() => {
        // These transport tests model a pre-generation optimized database,
        // the only legacy state allowed to adopt unmarked external rows.
        database.optimizePluginMemory = true;
    });
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
        vi.mocked(readPersistentJson).mockImplementation(async (key: string) => {
            if (key === PLUGIN_STORAGE_MANIFEST_KEY) return null;
            return key === validValueKey ? 42 : { plugin: "Test", updatedAt: 9 };
        });

        await expect(readExternalizedPluginStorage()).resolves.toEqual({
            values: { valid: 42 },
            meta: { valid: { plugin: "Test", updatedAt: 9 } },
        });
        expect(readPersistentJson).toHaveBeenCalledTimes(3);
        expect(readPersistentJson).toHaveBeenCalledWith(PLUGIN_STORAGE_MANIFEST_KEY);
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

    test("save-owner viewer APIs filter and mutate only manifest-owned metadata", async () => {
        database.optimizePluginMemory = true;
        const activeValue = encoded(PLUGIN_SAVE_PREFIX, "active");
        const activeMeta = encoded(PLUGIN_SAVE_META_PREFIX, "active");
        const foreignMeta = encoded(PLUGIN_SAVE_META_PREFIX, "foreign");
        persistent.set(activeValue, { value: true });
        persistent.set(activeMeta, { plugin: "Active", updatedAt: 1 });
        persistent.set(foreignMeta, { plugin: "Foreign", updatedAt: 2 });
        installOwnershipManifest("viewer-generation", [activeValue], [activeMeta]);
        const { getOwners, removeOwner } = await import("./pluginStorageMeta");

        await expect(getOwners("save")).resolves.toEqual({ active: "Active" });
        await removeOwner("save", "active");

        expect(persistent.has(activeMeta)).toBe(false);
        expect(persistent.get(foreignMeta)).toEqual({
            plugin: "Foreign",
            updatedAt: 2,
        });
        expect(persistent.get(PLUGIN_STORAGE_MANIFEST_KEY)).toEqual({
            version: 1,
            generation: "viewer-generation",
            valueKeys: [activeValue],
            metaKeys: [],
        });
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
            undefined,
            expect.objectContaining({
                bytes: expect.any(Uint8Array),
                byteLength: expect.any(Number),
            }),
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
        installOwnershipManifest("value-only-generation", [valueStorageKey], []);

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
        installOwnershipManifest("transport-generation", [], []);
        const value = { exact: "replacement-character" };

        await setPluginSaveStorageItem("�", value);
        await expect(getPluginSaveStorageItem("�")).resolves.toEqual(value);
        await expect(getPluginSaveStorageKeys()).resolves.toEqual(["�"]);
        await removePluginSaveStorageItem("�");

        expect(persistent.has(encoded(PLUGIN_SAVE_PREFIX, "�"))).toBe(false);
    });

    test("generation-bound enumeration aborts its pending manifest snapshot", async () => {
        database.optimizePluginMemory = true;
        installOwnershipManifest("abort-generation", [], []);
        const { readPersistentPluginStorageManifestSnapshot } = vi.mocked(
            await import("../storage/persistentKv"),
        );
        const controller = new AbortController();
        let observedAbort = false;
        readPersistentPluginStorageManifestSnapshot.mockImplementationOnce(
            async (_generation, signal) => await new Promise((_resolve, reject) => {
                signal?.addEventListener("abort", () => {
                    observedAbort = true;
                    reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
                }, { once: true });
            }),
        );

        const listing = getPluginSaveStorageKeys(controller.signal);
        await vi.waitFor(() => {
            expect(readPersistentPluginStorageManifestSnapshot).toHaveBeenCalledWith(
                "abort-generation",
                controller.signal,
            );
        });
        controller.abort(new DOMException("cancel snapshot", "AbortError"));

        await expect(listing).rejects.toMatchObject({ name: "AbortError" });
        expect(observedAbort).toBe(true);
    });

    test("one generation snapshot feeds enumeration and a page of value reads", async () => {
        database.optimizePluginMemory = true;
        const pageKeys = Array.from({ length: 50 }, (_, index) => (
            `page-${index.toString().padStart(2, "0")}`
        ));
        const storageKeys = pageKeys.map(key => encoded(PLUGIN_SAVE_PREFIX, key));
        const metaKeys = pageKeys.map(key => encoded(PLUGIN_SAVE_META_PREFIX, key));
        storageKeys.forEach((storageKey, index) => {
            persistent.set(storageKey, { page: index });
            persistent.set(metaKeys[index], { plugin: `Owner ${index}`, updatedAt: index });
        });
        installOwnershipManifest("viewer-generation", storageKeys, metaKeys);
        const {
            listPersistentKeys,
            readPersistentPluginStorageManifestSnapshot,
        } = vi.mocked(await import("../storage/persistentKv"));

        await expect(getPluginSaveStorageKeys()).resolves.toEqual(pageKeys);
        const owners = await getPluginSaveStorageOwners();
        expect(Object.keys(owners)).toEqual(pageKeys);
        expect(owners[pageKeys[49]]).toBe("Owner 49");
        for (const [index, key] of pageKeys.entries()) {
            await expect(getPluginSaveStorageItem(key)).resolves.toEqual({ page: index });
        }
        expect(readPersistentPluginStorageManifestSnapshot).toHaveBeenCalledOnce();
        expect(listPersistentKeys).not.toHaveBeenCalled();

        await setPluginSaveStorageItem(pageKeys[0], { page: 100 });
        await expect(getPluginSaveStorageItem(pageKeys[49])).resolves.toEqual({ page: 49 });
        expect(readPersistentPluginStorageManifestSnapshot).toHaveBeenCalledTimes(2);
    });

    test("optimized viewer uses one bounded page transport without inventory or per-row reads", async () => {
        database.optimizePluginMemory = true;
        database.pluginStorageGeneration = "viewer-page-generation";
        const {
            listPersistentKeys,
            readPersistentJson,
            readPersistentPluginStorageManifestSnapshot,
            readPersistentPluginStorageViewerPage,
        } = vi.mocked(await import("../storage/persistentKv"));
        readPersistentPluginStorageViewerPage.mockResolvedValueOnce({
            generation: "viewer-page-generation",
            manifestRevision: `sha256:${"a".repeat(64)}`,
            databaseRevision: "b".repeat(32),
            pageToken: `sha256:${"c".repeat(64)}`,
            page: 123,
            pageSize: 50,
            pageCount: 200,
            total: 10_000,
            ownerFacets: [{ owner: "Owner", count: 10_000 }],
            unknownOwnerCount: 0,
            ownerFacetTotal: 10_000,
            entries: Array.from({ length: 50 }, (_, index) => ({
                key: `key-${index}`,
                owner: "Owner",
                text: JSON.stringify({ index }),
                size: 16,
                valueType: "object",
                revision: `sha256:${index.toString(16).padStart(64, "0")}`,
                contentHash: `sha256:${(index + 1).toString(16).padStart(64, "0")}`,
            })),
            metrics: {
                manifestParses: 1,
                valueReads: 50,
                ownerReads: 50,
                maxRowParses: 1,
            },
        });
        const controller = new AbortController();

        const result = await getPluginSaveStorageViewerPage({
            page: 123,
            keyQuery: "key-",
            ownerQuery: "Owner",
            signal: controller.signal,
        });

        expect(result.entries).toHaveLength(50);
        expect(result.entries[37]).toMatchObject({
            key: "key-37",
            revision: `sha256:${(37).toString(16).padStart(64, "0")}`,
        });
        expect(result.total).toBe(10_000);
        expect(readPersistentPluginStorageViewerPage).toHaveBeenCalledOnce();
        expect(readPersistentPluginStorageViewerPage).toHaveBeenCalledWith(
            "viewer-page-generation",
            { page: 123, pageSize: 50, keyQuery: "key-", ownerQuery: "Owner" },
            controller.signal,
            undefined,
        );
        expect(readPersistentPluginStorageManifestSnapshot).not.toHaveBeenCalled();
        expect(readPersistentJson).not.toHaveBeenCalled();
        expect(listPersistentKeys).not.toHaveBeenCalled();
    });

    test("inline viewer returns whole-publication owner facets and authoritative owner pages", async () => {
        database.optimizePluginMemory = false;
        database.pluginCustomStorage = {
            "10": { key: "ten" },
            "2": { key: "two" },
            alpha: { key: "alpha" },
            unknown: { key: "unknown" },
        };
        database.pluginStorageMeta = {
            "10": { plugin: "Owner B", updatedAt: 1 },
            "2": { plugin: "Owner A", updatedAt: 1 },
            alpha: { plugin: "Owner A", updatedAt: 1 },
        };

        const owned = await getPluginSaveStorageViewerPage({
            page: 1,
            pageSize: 1,
            ownerQuery: "Owner A",
        });
        expect(owned.entries.map(entry => entry.key)).toEqual(["alpha"]);
        const versionedAlpha = await getPluginSaveStorageItemWithRevision("alpha");
        expect(owned.entries[0].revision).toBe(versionedAlpha.revision);
        const firstAlphaRevision = owned.entries[0].revision;
        const firstAlphaPageToken = owned.pageToken;
        database.pluginStorageMeta.alpha = {
            plugin: "Owner A",
            updatedAt: 2,
            revision: "123e4567-e89b-42d3-a456-426614174000",
            generation: "123e4567-e89b-42d3-a456-426614174001",
        };
        const republishedAlpha = await getPluginSaveStorageViewerPage({
            page: 1,
            pageSize: 1,
            ownerQuery: "Owner A",
        });
        expect(republishedAlpha.entries[0].revision).not.toBe(firstAlphaRevision);
        expect(republishedAlpha.pageToken).not.toBe(firstAlphaPageToken);
        expect(owned).toMatchObject({
            page: 1,
            pageCount: 2,
            total: 2,
            ownerFacets: [
                { owner: "Owner A", count: 2 },
                { owner: "Owner B", count: 1 },
            ],
            unknownOwnerCount: 1,
            ownerFacetTotal: 4,
        });

        const unknown = await getPluginSaveStorageViewerPage({
            page: 0,
            unknownOwner: true,
        });
        expect(unknown.total).toBe(1);
        expect(unknown.entries.map(entry => entry.key)).toEqual(["unknown"]);

        const firstCollisionTuple = await getPluginSaveStorageViewerPage({
            page: 0,
            keyQuery: "a\0b",
            ownerQuery: "c",
        });
        const secondCollisionTuple = await getPluginSaveStorageViewerPage({
            page: 0,
            keyQuery: "a",
            ownerQuery: "b\0c",
        });
        expect(firstCollisionTuple.total).toBe(0);
        expect(secondCollisionTuple.total).toBe(0);
        expect(firstCollisionTuple.pageToken).not.toBe(secondCollisionTuple.pageToken);

        const controller = new AbortController();
        const progress = vi.fn(() => {
            controller.abort(new DOMException("cancelled by final progress", "AbortError"));
        });
        await expect(getPluginSaveStorageViewerPage({
            page: 0,
            signal: controller.signal,
            onProgress: progress,
        })).rejects.toMatchObject({ name: "AbortError" });
        expect(progress).toHaveBeenCalledOnce();
    });

    test("ordinary optimized set uses one value mutation and no ownership read", async () => {
        database.optimizePluginMemory = true;
        installOwnershipManifest("set-generation", [], []);
        const {
            listPersistentKeys,
            readPersistentPluginStorageManifestSnapshot,
            readPersistentPluginStorageManifestState,
            setPreparedPersistentPluginStoragePreservingOwner,
        } = vi.mocked(await import("../storage/persistentKv"));

        await setPluginSaveStorageItem("alpha", { once: true });

        expect(setPreparedPersistentPluginStoragePreservingOwner).toHaveBeenCalledOnce();
        expect(setPreparedPersistentPluginStoragePreservingOwner).toHaveBeenCalledWith(
            encoded(PLUGIN_SAVE_PREFIX, "alpha"),
            expect.objectContaining({ bytes: expect.any(Uint8Array) }),
            undefined,
            "set-generation",
        );
        expect(readPersistentPluginStorageManifestSnapshot).not.toHaveBeenCalled();
        expect(readPersistentPluginStorageManifestState).not.toHaveBeenCalled();
        expect(listPersistentKeys).not.toHaveBeenCalled();
    });

    test("a stalled viewer owner row does not block an unrelated batch", async () => {
        database.optimizePluginMemory = true;
        const valueKey = encoded(PLUGIN_SAVE_PREFIX, "alpha");
        const metaKey = encoded(PLUGIN_SAVE_META_PREFIX, "alpha");
        persistent.set(valueKey, { retained: true });
        persistent.set(metaKey, { plugin: "Owner", updatedAt: 1 });
        installOwnershipManifest("viewer-batch-generation", [valueKey], [metaKey]);
        const { readPersistentJson } = vi.mocked(await import("../storage/persistentKv"));
        const originalRead = readPersistentJson.getMockImplementation()!;
        let releaseOwner!: () => void;
        let markOwnerStarted!: () => void;
        const ownerBlocked = new Promise<void>(resolve => { releaseOwner = resolve; });
        const ownerStarted = new Promise<void>(resolve => { markOwnerStarted = resolve; });
        readPersistentJson.mockImplementation(async (storageKey, options) => {
            if (storageKey === metaKey) {
                markOwnerStarted();
                await ownerBlocked;
            }
            return originalRead(storageKey, options);
        });

        const owners = getPluginSaveStorageOwners();
        await ownerStarted;
        await expect(atomicBatchOwnedPluginSaveStorage([{
            type: "set",
            key: "beta",
            value: { concurrent: true },
        }], "Viewer Batch")).resolves.toMatchObject({ committed: true });

        releaseOwner();
        await expect(owners).resolves.toEqual({ alpha: "Owner" });
    });

    test("value-only remove preserves ownership identically in inline and optimized modes", async () => {
        const owner = { plugin: "Retained Owner", updatedAt: 7 };
        database.pluginCustomStorage = { shared: { mode: "inline" } };
        database.pluginStorageMeta = { shared: owner };

        await removePluginSaveStorageItem("shared");
        expect(database.pluginCustomStorage).toEqual({});
        expect(database.pluginStorageMeta).toEqual({ shared: owner });

        database.optimizePluginMemory = true;
        database.pluginCustomStorage = {};
        const valueKey = encoded(PLUGIN_SAVE_PREFIX, "shared");
        const metaKey = encoded(PLUGIN_SAVE_META_PREFIX, "shared");
        persistent.set(valueKey, { mode: "optimized" });
        persistent.set(metaKey, owner);
        installOwnershipManifest("remove-parity-generation", [valueKey], [metaKey]);
        const { removePersistentPluginStoragePreservingOwner } = vi.mocked(
            await import("../storage/persistentKv"),
        );

        await removePluginSaveStorageItem("shared");

        expect(removePersistentPluginStoragePreservingOwner).toHaveBeenCalledOnce();
        expect(removePersistentPluginStoragePreservingOwner).toHaveBeenCalledWith(
            valueKey,
            undefined,
            "remove-parity-generation",
        );
        expect(persistent.has(valueKey)).toBe(false);
        expect(persistent.get(metaKey)).toEqual(owner);
        expect(persistent.get(PLUGIN_STORAGE_MANIFEST_KEY)).toMatchObject({
            valueKeys: [],
            metaKeys: [metaKey],
        });
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

    test("preserves structured-clone storage behavior while optimization is disabled", async () => {
        const cycle: Record<string, unknown> = { label: "cycle" };
        cycle.self = cycle;
        const sparse = new Array(2);
        sparse[1] = "present";
        const values = [
            undefined,
            new Date("2026-01-02T03:04:05.000Z"),
            new Map([["key", "value"]]),
            new Set(["value"]),
            { nested: Number.NaN },
            { nested: 1n },
            sparse,
            cycle,
        ];

        for (const [index, value] of values.entries()) {
            await expect(setPluginSaveStorageItem(`legacy-${index}`, value))
                .resolves.toBeUndefined();
        }

        await expect(getPluginSaveStorageItem("legacy-0")).resolves.toBeNull();
        await expect(getPluginSaveStorageItem("legacy-1"))
            .resolves.toEqual(new Date("2026-01-02T03:04:05.000Z"));
        await expect(getPluginSaveStorageItem("legacy-2"))
            .resolves.toEqual(new Map([["key", "value"]]));
        await expect(getPluginSaveStorageItem("legacy-3"))
            .resolves.toEqual(new Set(["value"]));
        expect((await getPluginSaveStorageItem<any>("legacy-4")).nested).toBeNaN();
        await expect(getPluginSaveStorageItem("legacy-5"))
            .resolves.toEqual({ nested: 1n });
        const storedSparse = await getPluginSaveStorageItem<any[]>("legacy-6");
        expect(storedSparse).toHaveLength(2);
        expect(Object.hasOwn(storedSparse!, 0)).toBe(false);
        const storedCycle = await getPluginSaveStorageItem<any>("legacy-7");
        expect(storedCycle.self).toBe(storedCycle);
        const { preparePersistentJson } = vi.mocked(
            await import("../storage/persistentKv"),
        );
        expect(preparePersistentJson).not.toHaveBeenCalled();
        expect(persistent.size).toBe(0);
    });

    test("optimized writes reject unsupported values with an actionable error", async () => {
        database.optimizePluginMemory = true;
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
            await expect(setOwnedPluginSaveStorageItem(
                `invalid-${index}`,
                value,
                "Compatibility Test",
            )).rejects.toMatchObject({
                name: "StorageError",
                status: 400,
                code: "PLUGIN_STORAGE_VALUE_UNSUPPORTED",
                operation: "write",
                retryable: false,
                commitOutcomeUnknown: false,
                message: expect.stringContaining(
                    "Plugin \"Compatibility Test\" cannot save this value while “Optimize plugin memory usage” is enabled.",
                ),
            });
        }

        expect(Object.keys(database.pluginCustomStorage)).toEqual([]);
        expect(persistent.size).toBe(0);
        expect(writePersistentJson).not.toHaveBeenCalled();
    });

    test("optimized writes convert compatible values when the fallback is enabled", async () => {
        database.optimizePluginMemory = true;
        database.autoConvertPluginStorageValues = true;
        const sparse = new Array(3);
        sparse[1] = undefined;
        sparse[2] = Number.NaN;

        await expect(setOwnedPluginSaveStorageItem(
            "converted",
            {
                date: new Date("2026-01-02T03:04:05.000Z"),
                map: new Map<unknown, unknown>([[1n, new Set(["a", "b"])]]),
                bigint: -42n,
                missing: undefined,
                sparse,
            },
            "Compatibility Test",
        )).resolves.toBeUndefined();

        expect(persistent.get(encoded(PLUGIN_SAVE_PREFIX, "converted"))).toEqual({
            date: "2026-01-02T03:04:05.000Z",
            map: [["1", ["a", "b"]]],
            bigint: "-42",
            missing: null,
            sparse: [null, null, null],
        });
    });

    test("automatic conversion still rejects functions and circular references", async () => {
        database.optimizePluginMemory = true;
        database.autoConvertPluginStorageValues = true;
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;

        for (const [index, value] of [() => undefined, cycle].entries()) {
            await expect(setOwnedPluginSaveStorageItem(
                "unsafe-" + index,
                value,
                "Compatibility Test",
            )).rejects.toMatchObject({
                name: "StorageError",
                code: "PLUGIN_STORAGE_VALUE_UNSUPPORTED",
                operation: "write",
                message: expect.stringContaining(
                    "Automatic conversion could not safely transform",
                ),
            });
        }

        expect([...persistent.keys()].filter(key => key.includes("unsafe-"))).toEqual([]);
    });

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
        const originalValues = database.pluginCustomStorage;
        database.pluginStorageMeta = invalidMeta;

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
        const betaKey = encoded(PLUGIN_SAVE_PREFIX, "beta");
        const alphaKey = encoded(PLUGIN_SAVE_PREFIX, "alpha");
        persistent.set(betaKey, { available: true });
        installOwnershipManifest("concurrent-generation", [betaKey], []);
        const { setPreparedPersistentPluginStoragePreservingOwner } = await import(
            "../storage/persistentKv"
        );
        const setPrepared = vi.mocked(setPreparedPersistentPluginStoragePreservingOwner);
        const originalSetPrepared = setPrepared.getMockImplementation()!;
        let markWriteStarted!: () => void;
        let releaseWrite!: () => void;
        const writeStarted = new Promise<void>(resolve => { markWriteStarted = resolve; });
        const stalledWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
        setPrepared.mockImplementation(async (valueKey, prepared, signal, generation) => {
            if (valueKey === alphaKey) {
                markWriteStarted();
                await stalledWrite;
            }
            return originalSetPrepared(valueKey, prepared, signal, generation);
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
        expect(listPersistentKeys).toHaveBeenCalledTimes(2);
        expect(listPersistentKeys).toHaveBeenCalledWith(PLUGIN_SAVE_PREFIX);
        expect(listPersistentKeys).toHaveBeenCalledWith(PLUGIN_SAVE_META_PREFIX);
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
        async function readPersistentJson<T>(key: string): Promise<T> {
            return persistent.get(key) as T;
        }
        const dependencies = {
            listPersistentKeys: vi.fn(async (prefix: string) =>
                [...persistent.keys()].filter(key => key.startsWith(prefix))
            ),
            readPersistentJson,
            writePersistentJson: vi.fn(async (key: string, value: unknown) => {
                operations.push(`write:${key}`);
                // The inline copy must still exist until its KV write succeeds.
                if (key !== PLUGIN_STORAGE_MANIFEST_KEY) {
                    expect(database.pluginCustomStorage.alpha ?? database.pluginStorageMeta?.alpha).toBeTruthy();
                }
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
        installOwnershipManifest("internalize-order", [valueKey], [metaKey], persistent);
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
        expect(readCalls).toContainEqual([valueKey, {
            cached: true,
            pluginStorageGeneration: "internalize-order",
        }]);
        expect(readCalls).toContainEqual([metaKey, {
            pluginStorageGeneration: "internalize-order",
        }]);

        await expect(reconcilePluginStorageMode({ dependencies })).resolves.toEqual({
            direction: "none",
            values: 0,
            meta: 0,
        });
    });

    test("a failed internalizing save leaves every external key intact", async () => {
        const valueKey = encoded(PLUGIN_SAVE_PREFIX, "alpha");
        const persistent = new Map<string, unknown>([[valueKey, 42]]);
        installOwnershipManifest("failed-internalize", [valueKey], [], persistent);
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

    test("direct production reconciliation is refused in favor of staged transition or boot recovery", async () => {
        const valueKey = encoded(PLUGIN_SAVE_PREFIX, "alpha");
        const metaKey = encoded(PLUGIN_SAVE_META_PREFIX, "alpha");
        persistent.set(valueKey, 42);
        persistent.set(metaKey, { plugin: "Test", updatedAt: 1 });
        installOwnershipManifest("production-failure", [valueKey], [metaKey]);
        const {
            commitPersistentPluginStorageTransition,
            removePersistentKey,
        } = vi.mocked(await import("../storage/persistentKv"));
        await expect(reconcilePluginStorageMode()).rejects.toThrow(
            "must use transitionPluginStorageMode or boot recovery",
        );

        expect(commitPersistentPluginStorageTransition).not.toHaveBeenCalled();
        expect(requestImmediateSave).not.toHaveBeenCalled();
        expect(database.optimizePluginMemory).toBe(false);
        expect(database.pluginCustomStorage.alpha).toBeUndefined();
        expect(persistent.get(valueKey)).toBe(42);
        expect(persistent.get(metaKey)).toEqual({ plugin: "Test", updatedAt: 1 });
        expect(removePersistentKey).not.toHaveBeenCalled();
    });

    test("direct production reconciliation never falls back to the aggregate v1 envelope", async () => {
        const valueKey = encoded(PLUGIN_SAVE_PREFIX, "alpha");
        persistent.set(valueKey, 42);
        installOwnershipManifest("production-commit", [valueKey], []);

        await expect(reconcilePluginStorageMode()).rejects.toThrow(
            "must use transitionPluginStorageMode or boot recovery",
        );

        const { commitPersistentPluginStorageTransition } = vi.mocked(
            await import("../storage/persistentKv"),
        );
        expect(commitPersistentPluginStorageTransition).not.toHaveBeenCalled();
        expect(requestImmediateSave).not.toHaveBeenCalled();
        expect(database.pluginCustomStorage.alpha).toBeUndefined();
        expect(persistent.has(valueKey)).toBe(true);
    });

    test("internalized data survives a simulated refresh after external rows are deleted", async () => {
        const valueKey = encoded(PLUGIN_SAVE_PREFIX, "alpha");
        const metaKey = encoded(PLUGIN_SAVE_META_PREFIX, "alpha");
        persistent.set(valueKey, { value: 1 });
        persistent.set(metaKey, { plugin: "Test", updatedAt: 1 });
        installOwnershipManifest("refresh", [valueKey], [metaKey]);
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

describe("boot plugin storage reconciliation recovery", () => {
    test("pins external row reads to the generation decoded during raw boot", async () => {
        const generation = "raw-boot-generation";
        const valueKey = encoded(PLUGIN_SAVE_PREFIX, "selected");
        const metaKey = encoded(PLUGIN_SAVE_META_PREFIX, "selected");
        database = {
            optimizePluginMemory: true,
            pluginStorageGeneration: generation,
            pluginCustomStorage: {},
        };
        persistent.set(valueKey, { selected: true });
        persistent.set(metaKey, { plugin: "Selected", updatedAt: 1 });
        const recordRead = vi.fn();
        async function readPersistentJsonRow<T>(
            key: string,
            options: {
                cached?: boolean;
                signal?: AbortSignal | null;
                pluginStorageGeneration?: string;
            } = {},
        ): Promise<{ kind: "missing" } | { kind: "value"; value: T }> {
            recordRead(key, options);
            expect(options.pluginStorageGeneration).toBe(generation);
            return persistent.has(key)
                ? { kind: "value", value: persistent.get(key) as T }
                : { kind: "missing" };
        }

        const result = await reconcilePluginStorageModeForBoot({
            dependencies: { readPersistentJsonRow },
        });

        expect(result).toEqual({ direction: "none", values: 0, meta: 0, issues: [] });
        expect(recordRead).toHaveBeenCalledWith(valueKey, {
            cached: true,
            pluginStorageGeneration: generation,
            signal: expect.any(AbortSignal),
        });
        expect(recordRead).toHaveBeenCalledWith(metaKey, {
            pluginStorageGeneration: generation,
            signal: expect.any(AbortSignal),
        });
    });

    test("does not pin inline-mode recovery to a stale generation field", async () => {
        const valueKey = encoded(PLUGIN_SAVE_PREFIX, "leftover");
        database = {
            optimizePluginMemory: false,
            pluginStorageGeneration: "stale-generation",
            pluginCustomStorage: {},
        };
        persistent.set(valueKey, { recovered: true });
        const recordRead = vi.fn();
        async function readPersistentJsonRow<T>(
            key: string,
            options: {
                cached?: boolean;
                signal?: AbortSignal | null;
                pluginStorageGeneration?: string;
            } = {},
        ): Promise<{ kind: "missing" } | { kind: "value"; value: T }> {
            recordRead(key, options);
            return persistent.has(key)
                ? { kind: "value", value: persistent.get(key) as T }
                : { kind: "missing" };
        }

        await expect(reconcilePluginStorageModeForBoot({
            dependencies: {
                readPersistentJsonRow,
                persistDatabase: vi.fn(async () => undefined),
            },
        })).resolves.toEqual({
            direction: "internalize",
            values: 1,
            meta: 0,
            issues: [],
        });

        expect(recordRead).toHaveBeenCalledWith(valueKey, {
            cached: true,
            signal: expect.any(AbortSignal),
        });
        expect(database.pluginCustomStorage.leftover).toEqual({ recovered: true });
    });

    test("copies an inline value and owner through one acknowledged atomic mutation", async () => {
        database = {
            optimizePluginMemory: true,
            pluginCustomStorage: { paired: { generation: 2 } },
            pluginStorageMeta: { paired: { plugin: "Owner", updatedAt: 7 } },
        };
        const restorePersistentPluginStoragePair = vi.fn(async () => {
            throw new Error("unknown acknowledgement");
        });
        const writePersistentJson = vi.fn();
        const persistDatabase = vi.fn();

        const result = await reconcilePluginStorageModeForBoot({
            dependencies: {
                restorePersistentPluginStoragePair,
                writePersistentJson,
                persistDatabase,
            },
        });

        expect(restorePersistentPluginStoragePair).toHaveBeenCalledWith(
            encoded(PLUGIN_SAVE_PREFIX, "paired"),
            { generation: 2 },
            { plugin: "Owner", updatedAt: 7 },
            expect.any(AbortSignal),
        );
        expect(writePersistentJson).not.toHaveBeenCalled();
        expect(database.pluginCustomStorage.paired).toEqual({ generation: 2 });
        expect(database.pluginStorageMeta?.paired).toEqual({ plugin: "Owner", updatedAt: 7 });
        expect(persistDatabase).not.toHaveBeenCalled();
        expect(result.issues).toEqual([{
            code: "write-failed",
            encodedKey: encoded(PLUGIN_SAVE_PREFIX, "paired"),
        }]);
    });

    test("aborts the whole recovery pass and releases its exclusive barrier", async () => {
        const controller = new AbortController();
        const listPersistentKeys = vi.fn((_prefix: string, signal?: AbortSignal | null) =>
            new Promise<string[]>((_resolve, reject) => {
                signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            })
        );
        const recovery = reconcilePluginStorageModeForBoot({
            signal: controller.signal,
            timeoutMs: 60_000,
            dependencies: { listPersistentKeys },
        });
        await vi.waitFor(() => expect(listPersistentKeys).toHaveBeenCalled());

        controller.abort(new Error("cancel recovery"));
        await expect(recovery).rejects.toThrow("cancel recovery");
        await expect(withPluginSaveStorageKeyLock("later", async () => "released"))
            .resolves.toBe("released");
    });

    test("waits for unrelated per-key work before taking the exclusive recovery barrier", async () => {
        const externalKey = encoded(PLUGIN_SAVE_PREFIX, "after-held-work");
        persistent.set(externalKey, { available: true });
        let releaseHeld!: () => void;
        let markHeld!: () => void;
        const held = new Promise<void>(resolve => { releaseHeld = resolve; });
        const heldStarted = new Promise<void>(resolve => { markHeld = resolve; });
        const earlier = withPluginSaveStorageKeyLock("unrelated", async () => {
            markHeld();
            await held;
        });
        await heldStarted;
        const listPersistentKeys = vi.fn(async (prefix: string) =>
            [...persistent.keys()].filter(key => key.startsWith(prefix))
        );

        const reconciliation = reconcilePluginStorageModeForBoot({
            dependencies: {
                listPersistentKeys,
                persistDatabase: vi.fn(async () => undefined),
            },
        });
        await Promise.resolve();
        expect(listPersistentKeys).not.toHaveBeenCalled();

        releaseHeld();
        await earlier;
        await expect(reconciliation).resolves.toMatchObject({ issues: [] });
        expect(database.pluginCustomStorage["after-held-work"]).toEqual({ available: true });
    });

    test("invalidates the SA2 enumeration snapshot when recovery changes the live key set", async () => {
        database.pluginCustomStorage = { inline: true };
        await expect(getPluginSaveStorageKeys()).resolves.toEqual(["inline"]);
        const externalKey = encoded(PLUGIN_SAVE_PREFIX, "external");
        persistent.set(externalKey, { recovered: true });

        await expect(reconcilePluginStorageModeForBoot({
            dependencies: { persistDatabase: vi.fn(async () => undefined) },
        })).resolves.toMatchObject({ issues: [] });

        await expect(getPluginSaveStorageKeys()).resolves.toEqual(["external", "inline"]);
    });

    test("quarantines an oversized inline key before violating the BR4 archive boundary", async () => {
        const oversizedKey = "v".repeat(757);
        const originalValues = { [oversizedKey]: { retained: true } };
        database = {
            optimizePluginMemory: true,
            pluginCustomStorage: originalValues,
            plugins: [],
        };
        const writePersistentJson = vi.fn();
        const persistDatabase = vi.fn();

        const result = await reconcilePluginStorageModeForBoot({
            dependencies: { writePersistentJson, persistDatabase },
        });

        expect(result.issues).toEqual([{
            code: "invalid-encoded-key",
            encodedKey: PLUGIN_SAVE_PREFIX,
        }]);
        expect(database.pluginCustomStorage).toBe(originalValues);
        expect(writePersistentJson).not.toHaveBeenCalled();
        expect(persistDatabase).not.toHaveBeenCalled();
    });

    test("isolates zero-length and malformed JSON rows while good rows reach plugins and UI", async () => {
        database = {
            optimizePluginMemory: false,
            pluginCustomStorage: {
                zero: { inline: "zero-recovery-copy" },
                malformed: { inline: "malformed-recovery-copy" },
            },
        };
        const zeroKey = encoded(PLUGIN_SAVE_PREFIX, "zero");
        const malformedKey = encoded(PLUGIN_SAVE_PREFIX, "malformed");
        const goodKey = encoded(PLUGIN_SAVE_PREFIX, "good");
        persistent.set(zeroKey, "zero-length-row-sentinel");
        persistent.set(malformedKey, "malformed-row-sentinel");
        persistent.set(goodKey, { available: true });
        async function readPersistentJsonRow<T>(key: string): Promise<
            { kind: "missing" } | { kind: "value"; value: T }
        > {
            if (key === zeroKey) throw new SyntaxError("Unexpected end of JSON input");
            if (key === malformedKey) throw new SyntaxError("Unexpected token");
            return persistent.has(key)
                ? { kind: "value", value: persistent.get(key) as T }
                : { kind: "missing" };
        }
        const persistDatabase = vi.fn(async () => undefined);
        let pluginsLoaded = false;
        let uiReached = false;

        const result = await reconcilePluginStorageModeForBoot({
            dependencies: { readPersistentJsonRow, persistDatabase },
        });
        // Model the two statements following the reconciliation boundary in
        // bootstrap.ts. Recovery must resolve rather than strand this path.
        pluginsLoaded = true;
        uiReached = true;

        expect(pluginsLoaded).toBe(true);
        expect(uiReached).toBe(true);
        expect(database.pluginCustomStorage.good).toEqual({ available: true });
        expect(database.pluginCustomStorage.zero).toEqual({ inline: "zero-recovery-copy" });
        expect(database.pluginCustomStorage.malformed)
            .toEqual({ inline: "malformed-recovery-copy" });
        // One suspect row makes the internalization copy-only. Good and bad
        // external rows therefore remain available for explicit recovery.
        expect(persistent.get(goodKey)).toEqual({ available: true });
        expect(persistent.get(zeroKey)).toBe("zero-length-row-sentinel");
        expect(persistent.get(malformedKey)).toBe("malformed-row-sentinel");
        expect(result.issues).toEqual([
            { code: "invalid-json", encodedKey: zeroKey },
            { code: "invalid-json", encodedKey: malformedKey },
        ]);
        expect(JSON.stringify(result.issues)).not.toContain("recovery-copy");
        expect(JSON.stringify(result.issues)).not.toContain("row-sentinel");
    });

    test("quarantines accessor and unsupported inline rows without invoking or overwriting them", async () => {
        let getterCalls = 0;
        const inline: Record<string, unknown> = {
            good: { copied: true },
            unsupported: new Map([["secret", "must-not-stringify"]]),
        };
        Object.defineProperty(inline, "accessor", {
            configurable: true,
            enumerable: true,
            get: () => {
                getterCalls += 1;
                return { secret: "must-not-read" };
            },
        });
        database = {
            optimizePluginMemory: true,
            pluginCustomStorage: inline,
        };
        const accessorKey = encoded(PLUGIN_SAVE_PREFIX, "accessor");
        const unsupportedKey = encoded(PLUGIN_SAVE_PREFIX, "unsupported");
        const goodKey = encoded(PLUGIN_SAVE_PREFIX, "good");
        persistent.set(accessorKey, { external: "accessor-recovery-copy" });
        persistent.set(unsupportedKey, { external: "unsupported-recovery-copy" });

        const result = await reconcilePluginStorageModeForBoot({
            dependencies: { persistDatabase: vi.fn(async () => undefined) },
        });

        expect(getterCalls).toBe(0);
        expect(Reflect.getOwnPropertyDescriptor(database.pluginCustomStorage, "accessor")?.get)
            .toBeTypeOf("function");
        expect(database.pluginCustomStorage.unsupported).toBeInstanceOf(Map);
        expect(database.pluginCustomStorage.good).toEqual({ copied: true });
        expect(persistent.get(accessorKey)).toEqual({ external: "accessor-recovery-copy" });
        expect(persistent.get(unsupportedKey)).toEqual({ external: "unsupported-recovery-copy" });
        expect(persistent.get(goodKey)).toEqual({ copied: true });
        expect(result.issues).toEqual([
            { code: "unsupported-json", encodedKey: unsupportedKey },
            { code: "unsupported-json", encodedKey: accessorKey },
        ]);
        const diagnostics = JSON.stringify(result.issues);
        expect(diagnostics).not.toContain("must-not");
        expect(diagnostics).not.toContain("recovery-copy");
        expect(diagnostics).not.toContain("accessor\"");
        expect(diagnostics).not.toContain("unsupported\"");
    });

    test("isolates transient read failure per encoded key and keeps good rows usable", async () => {
        database = {
            optimizePluginMemory: false,
            pluginCustomStorage: { transient: { inline: "retained" } },
        };
        const transientKey = encoded(PLUGIN_SAVE_PREFIX, "transient");
        const goodKey = encoded(PLUGIN_SAVE_PREFIX, "good");
        persistent.set(transientKey, "unread-external-copy");
        persistent.set(goodKey, { available: true });
        async function readPersistentJsonRow<T>(key: string): Promise<
            { kind: "missing" } | { kind: "value"; value: T }
        > {
            if (key === transientKey) throw new Error("temporary network failure");
            return persistent.has(key)
                ? { kind: "value", value: persistent.get(key) as T }
                : { kind: "missing" };
        }

        const result = await reconcilePluginStorageModeForBoot({
            dependencies: {
                readPersistentJsonRow,
                persistDatabase: vi.fn(async () => undefined),
            },
        });

        expect(database.pluginCustomStorage.good).toEqual({ available: true });
        expect(database.pluginCustomStorage.transient).toEqual({ inline: "retained" });
        expect(persistent.get(goodKey)).toEqual({ available: true });
        expect(persistent.get(transientKey)).toBe("unread-external-copy");
        expect(result.issues).toEqual([
            { code: "read-failed", encodedKey: transientKey },
        ]);
        expect(JSON.stringify(result.issues)).not.toContain("network failure");
    });

    test("a transient list failure preserves that prefix while the other prefix stays usable", async () => {
        database = {
            optimizePluginMemory: false,
            pluginCustomStorage: { inline: "retained" },
        };
        const hiddenValueKey = encoded(PLUGIN_SAVE_PREFIX, "hidden");
        const metaKey = encoded(PLUGIN_SAVE_META_PREFIX, "owner");
        persistent.set(hiddenValueKey, { external: "retained" });
        persistent.set(metaKey, { plugin: "Usable", updatedAt: 1 });
        const listPersistentKeys = vi.fn(async (prefix: string) => {
            if (prefix === PLUGIN_SAVE_PREFIX) throw new Error("temporary list failure");
            return [...persistent.keys()].filter(key => key.startsWith(prefix));
        });

        const result = await reconcilePluginStorageModeForBoot({
            dependencies: {
                listPersistentKeys,
                persistDatabase: vi.fn(async () => undefined),
            },
        });

        expect(database.pluginCustomStorage.inline).toBe("retained");
        expect(database.pluginStorageMeta.owner).toEqual({
            plugin: "Usable",
            updatedAt: 1,
        });
        expect(persistent.get(hiddenValueKey)).toEqual({ external: "retained" });
        expect(persistent.get(metaKey)).toEqual({ plugin: "Usable", updatedAt: 1 });
        expect(result.issues).toEqual([
            { code: "list-failed", encodedKey: PLUGIN_SAVE_PREFIX },
        ]);
        expect(JSON.stringify(result.issues)).not.toContain("temporary list failure");
    });

    test("an unrelated suspect row makes externalization globally copy-only", async () => {
        const duplicateKey = encoded(PLUGIN_SAVE_PREFIX, "duplicate");
        const goodKey = encoded(PLUGIN_SAVE_PREFIX, "new-good");
        const suspectKey = encoded(PLUGIN_SAVE_PREFIX, "unrelated-suspect");
        const originalInline = {
            duplicate: { copy: "inline-original" },
            "new-good": { usable: true },
        };
        database = {
            optimizePluginMemory: true,
            pluginCustomStorage: originalInline,
        };
        persistent.set(duplicateKey, { copy: "external-original" });
        persistent.set(suspectKey, "malformed-row-sentinel");
        const persistDatabase = vi.fn(async () => undefined);
        async function readPersistentJsonRow<T>(key: string): Promise<
            { kind: "missing" } | { kind: "value"; value: T }
        > {
            if (key === suspectKey) throw new SyntaxError("secret malformed bytes");
            return persistent.has(key)
                ? { kind: "value", value: persistent.get(key) as T }
                : { kind: "missing" };
        }

        const result = await reconcilePluginStorageModeForBoot({
            dependencies: { readPersistentJsonRow, persistDatabase },
        });

        expect(database.pluginCustomStorage).toBe(originalInline);
        expect(database.pluginCustomStorage.duplicate).toEqual({ copy: "inline-original" });
        expect(persistent.get(duplicateKey)).toEqual({ copy: "external-original" });
        expect(persistent.get(goodKey)).toEqual({ usable: true });
        expect(persistent.get(suspectKey)).toBe("malformed-row-sentinel");
        expect(persistDatabase).not.toHaveBeenCalled();
        expect(result.issues).toEqual(expect.arrayContaining([
            { code: "invalid-json", encodedKey: suspectKey },
            { code: "conflicting-copies", encodedKey: duplicateKey },
        ]));
    });

    test("an unrelated suspect row makes internalization globally copy-only", async () => {
        const duplicateKey = encoded(PLUGIN_SAVE_PREFIX, "duplicate");
        const goodKey = encoded(PLUGIN_SAVE_PREFIX, "new-good");
        const suspectKey = encoded(PLUGIN_SAVE_PREFIX, "unrelated-suspect");
        const originalInline = { duplicate: { copy: "inline-original" } };
        database = {
            optimizePluginMemory: false,
            pluginCustomStorage: originalInline,
        };
        persistent.set(duplicateKey, { copy: "external-original" });
        persistent.set(goodKey, { usable: true });
        persistent.set(suspectKey, "malformed-row-sentinel");
        const persistDatabase = vi.fn(async () => undefined);
        async function readPersistentJsonRow<T>(key: string): Promise<
            { kind: "missing" } | { kind: "value"; value: T }
        > {
            if (key === suspectKey) throw new SyntaxError("secret malformed bytes");
            return { kind: "value", value: persistent.get(key) as T };
        }

        const result = await reconcilePluginStorageModeForBoot({
            dependencies: { readPersistentJsonRow, persistDatabase },
        });

        expect(database.pluginCustomStorage.duplicate).toEqual({ copy: "inline-original" });
        expect(database.pluginCustomStorage["new-good"]).toEqual({ usable: true });
        expect(persistent.get(duplicateKey)).toEqual({ copy: "external-original" });
        expect(persistent.get(goodKey)).toEqual({ usable: true });
        expect(persistent.get(suspectKey)).toBe("malformed-row-sentinel");
        expect(persistDatabase).not.toHaveBeenCalled();
        expect(result.issues).toEqual(expect.arrayContaining([
            { code: "invalid-json", encodedKey: suspectKey },
            { code: "conflicting-copies", encodedKey: duplicateKey },
        ]));
    });

    test("treats a listed but missing row as a read failure while accepting encoded JSON null", async () => {
        const missingKey = encoded(PLUGIN_SAVE_PREFIX, "missing");
        const nullKey = encoded(PLUGIN_SAVE_PREFIX, "null-row");
        database = {
            optimizePluginMemory: false,
            pluginCustomStorage: { missing: { inline: "recovery-copy" } },
        };
        persistent.set(nullKey, null);
        const listPersistentKeys = vi.fn(async (prefix: string) => prefix === PLUGIN_SAVE_PREFIX
            ? [missingKey, nullKey]
            : []);
        const persistDatabase = vi.fn(async () => undefined);

        const result = await reconcilePluginStorageModeForBoot({
            dependencies: { listPersistentKeys, persistDatabase },
        });

        expect(result.issues).toContainEqual({ code: "read-failed", encodedKey: missingKey });
        expect(Object.hasOwn(database.pluginCustomStorage, "null-row")).toBe(true);
        expect(database.pluginCustomStorage["null-row"]).toBeNull();
        expect(database.pluginCustomStorage.missing).toEqual({ inline: "recovery-copy" });
        expect(persistent.has(nullKey)).toBe(true);
        expect(persistDatabase).not.toHaveBeenCalled();
    });

    test("restores exact value and metadata maps after persist failure before retry", async () => {
        const valueKey = encoded(PLUGIN_SAVE_PREFIX, "external-value");
        const metaKey = encoded(PLUGIN_SAVE_META_PREFIX, "external-value");
        const originalValues = { inline: { exact: "value-copy" } };
        const originalMeta = { inline: { plugin: "Inline", updatedAt: 1 } };
        database = {
            optimizePluginMemory: false,
            pluginCustomStorage: originalValues,
            pluginStorageMeta: originalMeta,
        };
        persistent.set(valueKey, { external: "value" });
        persistent.set(metaKey, { plugin: "External", updatedAt: 2 });
        const persistDatabase = vi.fn()
            .mockRejectedValueOnce(new Error("secret persist failure"))
            .mockResolvedValueOnce(undefined);

        const first = await reconcilePluginStorageModeForBoot({
            dependencies: { persistDatabase },
        });

        expect(first.issues).toEqual([
            { code: "persist-failed", encodedKey: "database/database.bin" },
        ]);
        expect(database.pluginCustomStorage).toBe(originalValues);
        expect(database.pluginStorageMeta).toBe(originalMeta);
        expect(persistent.get(valueKey)).toEqual({ external: "value" });
        expect(persistent.get(metaKey)).toEqual({ plugin: "External", updatedAt: 2 });
        expect(JSON.stringify(first.issues)).not.toContain("secret");

        const second = await reconcilePluginStorageModeForBoot({
            dependencies: { persistDatabase },
        });

        expect(second.issues).toEqual([]);
        expect(database.pluginCustomStorage).toEqual({
            inline: { exact: "value-copy" },
            "external-value": { external: "value" },
        });
        expect(database.pluginStorageMeta).toEqual({
            inline: { plugin: "Inline", updatedAt: 1 },
            "external-value": { plugin: "External", updatedAt: 2 },
        });
        expect(persistent.has(valueKey)).toBe(false);
        expect(persistent.has(metaKey)).toBe(false);
        expect(persistDatabase).toHaveBeenCalledTimes(2);
    });

    test.each(["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"] as const)(
        "contains hostile inline %s traps without leaking their messages",
        async (trap) => {
            const secret = "decoded-key=private-key value=private-value";
            const handler: ProxyHandler<Record<string, unknown>> = {};
            if (trap === "getPrototypeOf") handler.getPrototypeOf = () => { throw new Error(secret); };
            if (trap === "ownKeys") handler.ownKeys = () => { throw new Error(secret); };
            if (trap === "getOwnPropertyDescriptor") {
                handler.getOwnPropertyDescriptor = () => { throw new Error(secret); };
            }
            const hostile = new Proxy({}, handler);
            database = {
                optimizePluginMemory: true,
                pluginCustomStorage: hostile,
            };

            const result = await reconcilePluginStorageModeForBoot({
                dependencies: { persistDatabase: vi.fn(async () => undefined) },
            });

            expect(database.pluginCustomStorage).toBe(hostile);
            expect(result.issues).toContainEqual({
                code: "unsupported-json",
                encodedKey: PLUGIN_SAVE_PREFIX,
            });
            expect(JSON.stringify(result.issues)).not.toContain("private-key");
            expect(JSON.stringify(result.issues)).not.toContain("private-value");
        },
    );
});

describe("transitionPluginStorageMode", () => {
    test("production disable stages rows and publishes without a database envelope", async () => {
        const valueKey = encoded(PLUGIN_SAVE_PREFIX, "alpha");
        const metaKey = encoded(PLUGIN_SAVE_META_PREFIX, "alpha");
        database.optimizePluginMemory = true;
        persistent.set(valueKey, { value: "owned" });
        persistent.set(metaKey, { plugin: "Owner", updatedAt: 1 });
        installOwnershipManifest("source-generation", [valueKey], [metaKey]);
        const {
            beginPersistentPluginStorageTransition,
            commitPersistentPluginStorageTransition,
            finalizePersistentPluginStorageTransition,
            listPersistentKeys,
            readPersistentPluginStorageManifestSnapshot,
        } = vi.mocked(
            await import("../storage/persistentKv"),
        );

        await expect(transitionPluginStorageMode(false)).resolves.toEqual({
            direction: "internalize",
            values: 1,
            meta: 1,
        });

        expect(commitPersistentPluginStorageTransition).not.toHaveBeenCalled();
        expect(beginPersistentPluginStorageTransition).toHaveBeenCalledOnce();
        const begin = beginPersistentPluginStorageTransition.mock.calls[0][0];
        expect(begin.source).toEqual({
            optimized: true,
            generation: "source-generation",
            manifest: {
                version: 1,
                generation: "source-generation",
                valueKeys: [valueKey],
                metaKeys: [metaKey],
            },
        });
        expect(begin.rows).toEqual([]);
        expect(begin).not.toHaveProperty("database");
        expect(readPersistentPluginStorageManifestSnapshot).toHaveBeenCalledOnce();
        expect(readPersistentPluginStorageManifestSnapshot).toHaveBeenCalledWith(
            "source-generation",
            undefined,
        );
        expect(listPersistentKeys).not.toHaveBeenCalled();
        expect(finalizePersistentPluginStorageTransition).toHaveBeenCalledOnce();
        expect(database.optimizePluginMemory).toBe(false);
        expect(database.pluginStorageGeneration).not.toBe("source-generation");
        expect(database.pluginCustomStorage).toEqual({ alpha: { value: "owned" } });
        expect(database.pluginStorageMeta).toEqual({
            alpha: { plugin: "Owner", updatedAt: 1 },
        });

        const snapshotCalls = readPersistentPluginStorageManifestSnapshot.mock.calls.length;
        listPersistentKeys.mockClear();
        await expect(transitionPluginStorageMode(true)).resolves.toEqual({
            direction: "externalize",
            values: 1,
            meta: 1,
        });
        expect(readPersistentPluginStorageManifestSnapshot).toHaveBeenCalledTimes(snapshotCalls);
        expect(listPersistentKeys).toHaveBeenCalledTimes(2);
        expect(listPersistentKeys).toHaveBeenCalledWith(PLUGIN_SAVE_PREFIX);
        expect(listPersistentKeys).toHaveBeenCalledWith(PLUGIN_SAVE_META_PREFIX);
        expect(database.optimizePluginMemory).toBe(true);
    });

    test("production disable rejects a same-size altered private-stage row", async () => {
        const valueKey = encoded(PLUGIN_SAVE_PREFIX, "alpha");
        database.optimizePluginMemory = true;
        persistent.set(valueKey, { value: "aa" });
        installOwnershipManifest("source-generation", [valueKey], []);
        const {
            finalizePersistentPluginStorageTransition,
            readPersistentPluginStorageTransitionRow,
        } = vi.mocked(await import("../storage/persistentKv"));
        const substituted = new TextEncoder().encode(JSON.stringify({ value: "bb" }));
        expect(substituted.byteLength).toBe(
            new TextEncoder().encode(JSON.stringify({ value: "aa" })).byteLength,
        );
        readPersistentPluginStorageTransitionRow.mockResolvedValueOnce(substituted);

        await expect(transitionPluginStorageMode(false)).rejects.toMatchObject({
            code: "PLUGIN_STORAGE_CHANGED",
        });

        expect(finalizePersistentPluginStorageTransition).not.toHaveBeenCalled();
        expect(database.optimizePluginMemory).toBe(true);
        expect(database.pluginCustomStorage).toEqual({});
        expect(persistent.get(valueKey)).toEqual({ value: "aa" });
    });

    test("production enable binds the begin acknowledgement to its exact plan", async () => {
        database.optimizePluginMemory = false;
        database.pluginCustomStorage = { alpha: { retained: true } };
        const {
            abortPersistentPluginStorageTransition,
            beginPersistentPluginStorageTransition,
            finalizePersistentPluginStorageTransition,
            uploadPersistentPluginStorageTransitionRow,
        } = vi.mocked(await import("../storage/persistentKv"));
        const originalBegin = beginPersistentPluginStorageTransition.getMockImplementation()!;
        beginPersistentPluginStorageTransition.mockImplementationOnce(async (plan, signal) => ({
            ...await originalBegin(plan, signal),
            targetGeneration: crypto.randomUUID(),
        }));

        await expect(transitionPluginStorageMode(true)).rejects.toMatchObject({
            code: "STORAGE_RESPONSE_ERROR",
        });

        expect(abortPersistentPluginStorageTransition).toHaveBeenCalledOnce();
        expect(uploadPersistentPluginStorageTransitionRow).not.toHaveBeenCalled();
        expect(finalizePersistentPluginStorageTransition).not.toHaveBeenCalled();
        expect(database.optimizePluginMemory).toBe(false);
        expect(database.pluginCustomStorage).toEqual({ alpha: { retained: true } });
    });

    test("production enable explains unsupported existing plugin values", async () => {
        database.optimizePluginMemory = false;
        database.pluginCustomStorage = {
            compatible: { retained: true },
            unsupported: new Map([["key", "value"]]),
        };

        await expect(transitionPluginStorageMode(true)).rejects.toMatchObject({
            name: "StorageError",
            status: 400,
            code: "PLUGIN_STORAGE_VALUE_UNSUPPORTED",
            operation: "transition",
            retryable: false,
            commitOutcomeUnknown: false,
            message: expect.stringContaining(
                "Some existing plugin data cannot be moved into optimized storage",
            ),
        });

        expect(database.optimizePluginMemory).toBe(false);
        expect(database.pluginCustomStorage.compatible).toEqual({ retained: true });
        expect(database.pluginCustomStorage.unsupported).toBeInstanceOf(Map);
    });

    test("production enable does not misreport a network TypeError as incompatible data", async () => {
        database.optimizePluginMemory = false;
        database.pluginCustomStorage = { compatible: { retained: true } };
        const { listPersistentEntriesWithSizes } = vi.mocked(
            await import("../storage/persistentKv"),
        );
        const networkError = new TypeError("network unavailable during inventory");
        listPersistentEntriesWithSizes.mockRejectedValueOnce(networkError);

        await expect(transitionPluginStorageMode(true)).rejects.toBe(networkError);

        expect(database.optimizePluginMemory).toBe(false);
        expect(database.pluginCustomStorage).toEqual({
            compatible: { retained: true },
        });
    });

    test("production enable releases acknowledged rows and switches routing only after commit", async () => {
        database.optimizePluginMemory = false;
        database.pluginCustomStorage = {
            first: { payload: "한😀" },
            second: { payload: "two" },
        };
        database.pluginStorageMeta = {
            first: { plugin: "Owner", updatedAt: 1 },
        };
        const releaseSnapshots: Array<{ values: string[]; meta: string[] }> = [];
        const onProgress = vi.fn((_progress: unknown) => {
            releaseSnapshots.push({
                values: Object.keys(database.pluginCustomStorage),
                meta: Object.keys(database.pluginStorageMeta ?? {}),
            });
        });
        const {
            beginPersistentPluginStorageTransition,
            commitPersistentPluginStorageTransition,
            finalizePersistentPluginStorageTransition,
            uploadPersistentPluginStorageTransitionRow,
        } = vi.mocked(await import("../storage/persistentKv"));

        let releaseFinalize!: () => void;
        const finalizeBlocked = new Promise<void>(resolve => {
            releaseFinalize = resolve;
        });
        const commitFinalize = finalizePersistentPluginStorageTransition.getMockImplementation()!;
        finalizePersistentPluginStorageTransition.mockImplementationOnce(async (...args) => {
            await finalizeBlocked;
            return await commitFinalize(...args);
        });

        const transition = transitionPluginStorageMode(true, { onProgress });
        await vi.waitFor(() => {
            expect(uploadPersistentPluginStorageTransitionRow).toHaveBeenCalledTimes(3);
            expect(finalizePersistentPluginStorageTransition).toHaveBeenCalledOnce();
        });
        expect(database.optimizePluginMemory).toBe(false);
        expect(database.pluginCustomStorage).toEqual({});
        expect(database.pluginStorageMeta).toEqual({});
        expect(releaseSnapshots).toEqual([
            { values: ["second"], meta: ["first"] },
            { values: [], meta: ["first"] },
            { values: [], meta: [] },
        ]);

        // Progressive deletion is an intentional memory optimization, not a
        // partial publication: routing remains in the source mode and even a
        // fresh save coordinator must wait until finalize settles and the
        // transition resumes database saves.
        const { DatabaseSaveCoordinator } = await import("../storage/databaseSave");
        const databaseWriter = vi.fn(async () => ({ status: "committed" as const }));
        const saveDuringTransition = new DatabaseSaveCoordinator().run(databaseWriter);
        await Promise.resolve();
        expect(databaseWriter).not.toHaveBeenCalled();
        releaseFinalize();

        await expect(transition).resolves.toEqual({
            direction: "externalize",
            values: 2,
            meta: 1,
        });
        await expect(saveDuringTransition).resolves.toEqual({ status: "committed" });
        expect(databaseWriter).toHaveBeenCalledOnce();

        expect(commitPersistentPluginStorageTransition).not.toHaveBeenCalled();
        const begin = beginPersistentPluginStorageTransition.mock.calls.at(-1)![0];
        expect(begin).not.toHaveProperty("database");
        expect(begin.rows).toHaveLength(3);
        expect(begin.rows.every(row => Object.keys(row).sort().join(",") === "size,storageKey"))
            .toBe(true);
        const uploads = uploadPersistentPluginStorageTransitionRow.mock.calls.slice(-3);
        expect(uploads).toHaveLength(3);
        expect(uploads.every(call => call[2] instanceof Uint8Array)).toBe(true);
        expect(finalizePersistentPluginStorageTransition).toHaveBeenCalled();
        expect(database.optimizePluginMemory).toBe(true);
        expect(database.pluginStorageGeneration).toEqual(expect.any(String));
        expect(database.pluginCustomStorage).toEqual({});
        expect(database.pluginStorageMeta).toBeUndefined();
        expect(onProgress).toHaveBeenCalledTimes(3);
        expect(onProgress.mock.calls.at(-1)![0]).toMatchObject({
            completed: 3,
            total: 3,
            completedBytes: expect.any(Number),
            totalBytes: expect.any(Number),
        });
    });

    test("enabling an exact empty inline set quarantines stale unmarked rows", async () => {
        const staleKey = encoded(PLUGIN_SAVE_PREFIX, "stale");
        persistent.set(staleKey, { resurrected: false });
        database.optimizePluginMemory = false;
        database.pluginCustomStorage = {};

        await expect(transitionPluginStorageMode(true, {
            dependencies: { persistDatabase: vi.fn(async () => undefined) },
        })).resolves.toEqual({ direction: "externalize", values: 0, meta: 0 });

        expect(database.optimizePluginMemory).toBe(true);
        expect(database.pluginStorageGeneration).toEqual(expect.any(String));
        expect(persistent.get(staleKey)).toEqual({ resurrected: false });
        expect(persistent.get(PLUGIN_STORAGE_MANIFEST_KEY)).toEqual({
            version: 1,
            generation: database.pluginStorageGeneration,
            valueKeys: [],
            metaKeys: [],
        });
        await expect(getPluginSaveStorageItem("stale")).resolves.toBeNull();
        await expect(getPluginSaveStorageKeys()).resolves.toEqual([]);
    });

    test("a foreign generation is never overlaid while disabling", async () => {
        const foreignKey = encoded(PLUGIN_SAVE_PREFIX, "foreign");
        database.optimizePluginMemory = true;
        database.pluginStorageGeneration = "selected-generation";
        database.pluginCustomStorage = { inlineRecovery: "selected" };
        persistent.set(foreignKey, "foreign-value");
        persistent.set(PLUGIN_STORAGE_MANIFEST_KEY, {
            version: 1,
            generation: "other-generation",
            valueKeys: [foreignKey],
            metaKeys: [],
        });

        await expect(transitionPluginStorageMode(false, {
            dependencies: { persistDatabase: vi.fn(async () => undefined) },
        })).resolves.toEqual({ direction: "internalize", values: 0, meta: 0 });

        expect(database.optimizePluginMemory).toBe(false);
        expect(database.pluginCustomStorage).toEqual({ inlineRecovery: "selected" });
        expect(persistent.get(foreignKey)).toBe("foreign-value");
        expect(persistent.has(PLUGIN_STORAGE_MANIFEST_KEY)).toBe(false);
        await expect(readExternalizedPluginStorage()).resolves.toEqual({
            values: {},
            meta: {},
        });
    });

    test("a matching manifest internalizes only its exact row set", async () => {
        const activeKey = encoded(PLUGIN_SAVE_PREFIX, "active");
        const foreignKey = encoded(PLUGIN_SAVE_PREFIX, "foreign");
        database.optimizePluginMemory = true;
        database.pluginStorageGeneration = "matching-generation";
        persistent.set(activeKey, "owned");
        persistent.set(foreignKey, "quarantined");
        persistent.set(PLUGIN_STORAGE_MANIFEST_KEY, {
            version: 1,
            generation: "matching-generation",
            valueKeys: [activeKey],
            metaKeys: [],
        });

        await expect(transitionPluginStorageMode(false, {
            dependencies: { persistDatabase: vi.fn(async () => undefined) },
        })).resolves.toEqual({ direction: "internalize", values: 1, meta: 0 });

        expect(database.pluginCustomStorage).toEqual({ active: "owned" });
        expect(persistent.has(activeKey)).toBe(false);
        expect(persistent.get(foreignKey)).toBe("quarantined");
    });

    test("legacy unmarked optimized rows are adopted into a new generation", async () => {
        const legacyKey = encoded(PLUGIN_SAVE_PREFIX, "legacy");
        database.optimizePluginMemory = true;
        database.pluginCustomStorage = {};
        persistent.set(legacyKey, { compatible: true });

        await expect(reconcilePluginStorageMode({
            dependencies: { persistDatabase: vi.fn(async () => undefined) },
        })).resolves.toEqual({ direction: "externalize", values: 0, meta: 0 });

        expect(database.pluginStorageGeneration).toEqual(expect.any(String));
        expect(persistent.get(PLUGIN_STORAGE_MANIFEST_KEY)).toEqual({
            version: 1,
            generation: database.pluginStorageGeneration,
            valueKeys: [legacyKey],
            metaKeys: [],
        });
        await expect(getPluginSaveStorageItem("legacy")).resolves.toEqual({
            compatible: true,
        });
    });

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

    test("compatibility mode keeps an import after an unrelated teardown failure", async () => {
        database.legacyPluginCompatibility = true;
        teardownV3PluginsMock.mockRejectedValueOnce(new AggregateError(
            [new Error("legacy unload failed")],
            "V3 teardown failed",
        ));

        await importPlugin("//@name Compatible durable import\n//@api 3.0\n");

        expect(database.plugins).toEqual([
            expect.objectContaining({
                name: "Compatible durable import",
                version: "3.0",
                enabled: true,
            }),
        ]);
        expect(requestImmediateSave).toHaveBeenCalledOnce();
        expect(requestImmediateSave).toHaveBeenCalledWith({ forceFullWrite: true });
        const { alertError, notifyWarning } = vi.mocked(await import("../alert"));
        expect(alertError).not.toHaveBeenCalled();
        expect(notifyWarning).toHaveBeenCalledWith(
            "One or more plugins did not unload cleanly. Compatibility mode terminated them and continued the plugin reload.",
        );
    });

    test("keeps a healthy import when an already-enabled V3 plugin fails startup", async () => {
        const brokenPlugin = {
            name: "Existing broken startup",
            script: "const broken = ;",
            arguments: {},
            realArg: {},
            version: "3.0" as const,
            customLink: [],
            argMeta: {},
            enabled: true,
        };
        database.plugins = [brokenPlugin];
        loadV3PluginGenerationOutcomesMock.mockImplementation(async (plugins: any[]) => (
            plugins.map(plugin => plugin.name === brokenPlugin.name
                ? {
                    pluginName: plugin.name,
                    status: "rejected" as const,
                    reason: new Error("existing startup failed"),
                }
                : { pluginName: plugin.name, status: "fulfilled" as const })
        ));
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        await importPlugin("//@name Healthy new plugin\n//@api 3.0\n");

        expect(database.plugins.map((plugin: any) => plugin.name)).toEqual([
            brokenPlugin.name,
            "Healthy new plugin",
        ]);
        expect(requestImmediateSave).toHaveBeenCalledOnce();
        expect(requestImmediateSave).toHaveBeenCalledWith({ forceFullWrite: true });
        const { alertError } = vi.mocked(await import("../alert"));
        expect(alertError).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(
            "[Plugins] Plugin import continued despite unrelated V3 startup failures:",
            [brokenPlugin.name],
        );
        warnSpy.mockRestore();
    });

    test("keeps a healthy enable when an already-enabled V3 plugin fails startup", async () => {
        const plugin = (name: string, enabled: boolean) => ({
            name,
            script: "",
            arguments: {},
            realArg: {},
            version: "3.0" as const,
            customLink: [],
            argMeta: {},
            enabled,
        });
        const brokenPlugin = plugin("Existing broken enable", true);
        const healthyPlugin = plugin("Healthy disabled plugin", false);
        database.plugins = [brokenPlugin, healthyPlugin];
        loadV3PluginGenerationOutcomesMock.mockImplementation(async (plugins: any[]) => (
            plugins.map(candidate => candidate.name === brokenPlugin.name
                ? {
                    pluginName: candidate.name,
                    status: "rejected" as const,
                    reason: new Error("existing startup failed"),
                }
                : { pluginName: candidate.name, status: "fulfilled" as const })
        ));
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        await expect(setPluginEnabledAndReload(healthyPlugin.name, true))
            .resolves.toBe("updated");

        expect(database.plugins.find((candidate: any) => candidate.name === healthyPlugin.name).enabled)
            .toBe(true);
        expect(requestImmediateSave).toHaveBeenCalledOnce();
        expect(warnSpy).toHaveBeenCalledWith(
            "[Plugins] Plugin enable continued despite unrelated V3 startup failures:",
            [brokenPlugin.name],
        );
        warnSpy.mockRestore();
    });

    test("rolls an enable back when the target V3 plugin fails startup", async () => {
        const targetPlugin = {
            name: "Target startup failure",
            script: "const broken = ;",
            arguments: {},
            realArg: {},
            version: "3.0" as const,
            customLink: [],
            argMeta: {},
            enabled: false,
        };
        database.plugins = [targetPlugin];
        loadV3PluginGenerationOutcomesMock.mockImplementation(async (plugins: any[]) => (
            plugins.map(plugin => ({
                pluginName: plugin.name,
                status: "rejected" as const,
                reason: new Error("target startup failed"),
            }))
        ));

        await expect(setPluginEnabledAndReload(targetPlugin.name, true))
            .rejects.toThrow("failed and was rolled back");

        expect(database.plugins[0].enabled).toBe(false);
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
        expect(loadV3PluginGenerationOutcomesMock.mock.calls[0]?.[0]).toEqual([]);
        expect(loadV3PluginGenerationOutcomesMock.mock.calls.at(-1)?.[0]).toEqual([originalPlugin]);
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
        expect(loadV3PluginGenerationOutcomesMock.mock.calls.at(-1)?.[0])
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

    test("lets a loading plugin await a follow-up reload request without deadlocking", async () => {
        database.plugins = [{
            name: "Reloading V3 plugin",
            script: "",
            arguments: {},
            realArg: {},
            version: "3.0",
            customLink: [],
            argMeta: {},
            enabled: true,
        }];
        const v2Apis = getV2PluginAPIs();
        let generations = 0;
        let acknowledged = false;
        loadV3PluginGenerationOutcomesMock.mockImplementation(async (plugins: any[]) => {
            generations += 1;
            if (generations === 1) {
                await v2Apis.loadPlugins();
                acknowledged = true;
            }
            return plugins.map(plugin => ({
                pluginName: plugin.name,
                status: "fulfilled" as const,
            }));
        });

        await loadPlugins();
        expect(acknowledged).toBe(true);
        await waitForDeferredPluginApiReloadIdle();
        expect(generations).toBe(2);
    });

    test("makes plugin API callers share and await deferred reload completion", async () => {
        pluginV2.loaded = true;
        const v2Apis = getV2PluginAPIs();
        let releaseUnload!: () => void;
        let markUnloadStarted!: () => void;
        const unloadBlocked = new Promise<void>(resolve => { releaseUnload = resolve; });
        const unloadStarted = new Promise<void>(resolve => { markUnloadStarted = resolve; });
        pluginV2.unload.add(async () => {
            markUnloadStarted();
            await unloadBlocked;
        });

        const firstReload = v2Apis.loadPlugins();
        const coalescedReload = v2Apis.loadPlugins();
        let settled = false;
        void firstReload.then(() => { settled = true; });

        expect(coalescedReload).toBe(firstReload);
        await unloadStarted;
        await Promise.resolve();
        expect(settled).toBe(false);

        releaseUnload();
        await Promise.all([firstReload, coalescedReload]);
        expect(settled).toBe(true);
        expect(pluginV2.unload.size).toBe(0);
    });

    test("propagates deferred plugin lifecycle failure to plugin API callers", async () => {
        teardownV3PluginsMock.mockRejectedValue(new Error("deferred teardown failed"));
        const v2Apis = getV2PluginAPIs();

        await expect(v2Apis.loadPlugins()).rejects.toThrow(
            "One or more plugin lifecycle phases failed.",
        );

        expect(teardownV3PluginsMock).toHaveBeenCalledTimes(2);
        const { notifyWarning } = vi.mocked(await import("../alert"));
        expect(notifyWarning).toHaveBeenCalledWith(
            "A plugin reload is still pending after repeated reload attempts. Try reloading plugins again or restart the app.",
        );
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
        const enabledGeneration = database.pluginStorageGeneration;
        expect(enabledGeneration).toEqual(expect.any(String));
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
        expect(database.pluginStorageGeneration).toEqual(expect.any(String));
        expect(database.pluginStorageGeneration).not.toBe(enabledGeneration);
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
            })).rejects.toMatchObject({
                name: "StorageError",
                code: "PLUGIN_STORAGE_VALUE_UNSUPPORTED",
                operation: "transition",
                retryable: false,
                commitOutcomeUnknown: false,
            });

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

    test("enable quarantines a poisoned unmarked orphan instead of adopting it", async () => {
        let getterCalls = 0;
        const invalid = makeInvalidRecord("accessor", () => {
            getterCalls += 1;
        });
        const orphanKey = encoded(PLUGIN_SAVE_PREFIX, "orphan");
        database.optimizePluginMemory = false;
        database.pluginCustomStorage = { inline: { safe: true } };
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
        })).resolves.toEqual({ direction: "externalize", values: 1, meta: 0 });

        expect(database.optimizePluginMemory).toBe(true);
        expect(database.pluginCustomStorage).toEqual({});
        expect(getterCalls).toBe(0);
        expect(readCalls).not.toContainEqual([orphanKey, { cached: true }]);
        expect(writePersistentJson).toHaveBeenCalled();
        expect(removePersistentKey).not.toHaveBeenCalled();
        expect(persistDatabase).toHaveBeenCalledOnce();
        expect(persistent.get(orphanKey)).toBe("durable-row-sentinel");
    });

    test("enable quarantines an unmarked metadata row without parsing it", async () => {
        const orphanMetaKey = encoded(PLUGIN_SAVE_META_PREFIX, "orphan");
        database.optimizePluginMemory = false;
        database.pluginCustomStorage = { inline: { safe: true } };
        database.pluginStorageMeta = { inline: { plugin: "Plugin", updatedAt: 1 } };
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
        })).resolves.toEqual({ direction: "externalize", values: 1, meta: 1 });

        expect(database.optimizePluginMemory).toBe(true);
        expect(database.pluginCustomStorage).toEqual({});
        expect(database.pluginStorageMeta).toBeUndefined();
        expect(writePersistentJson).toHaveBeenCalled();
        expect(removePersistentKey).not.toHaveBeenCalled();
        expect(persistDatabase).toHaveBeenCalledOnce();
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

        expect(readPersistentJson).not.toHaveBeenCalledWith(
            overwrittenKey,
            expect.anything(),
        );
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
        installOwnershipManifest("queued-set-generation", [valueKey], []);
        const { readPersistentPluginStorageManifestSnapshot } = await import(
            "../storage/persistentKv"
        );
        const manifestSnapshot = vi.mocked(readPersistentPluginStorageManifestSnapshot);
        const originalManifestSnapshot = manifestSnapshot.getMockImplementation()!;
        let releaseCount!: () => void;
        let markCountStarted!: () => void;
        const countBlocked = new Promise<void>((resolve) => {
            releaseCount = resolve;
        });
        const countStarted = new Promise<void>((resolve) => {
            markCountStarted = resolve;
        });
        manifestSnapshot.mockImplementationOnce(async (generation, signal) => {
            markCountStarted();
            await countBlocked;
            return originalManifestSnapshot(generation, signal);
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
        installOwnershipManifest("queued-remove-generation", [valueKey], []);
        const { readPersistentPluginStorageManifestSnapshot } = await import(
            "../storage/persistentKv"
        );
        const manifestSnapshot = vi.mocked(readPersistentPluginStorageManifestSnapshot);
        const originalManifestSnapshot = manifestSnapshot.getMockImplementation()!;
        let releaseCount!: () => void;
        let markCountStarted!: () => void;
        const countBlocked = new Promise<void>((resolve) => {
            releaseCount = resolve;
        });
        const countStarted = new Promise<void>((resolve) => {
            markCountStarted = resolve;
        });
        manifestSnapshot.mockImplementationOnce(async (generation, signal) => {
            markCountStarted();
            await countBlocked;
            return originalManifestSnapshot(generation, signal);
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
        installOwnershipManifest("rollback-generation", [valueKey], []);
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

    test("an interrupted enable restores inline ownership and quarantines no stale row", async () => {
        const valueKey = encoded(PLUGIN_SAVE_PREFIX, "alpha");
        database.optimizePluginMemory = false;
        database.pluginCustomStorage = { alpha: "inline-before-enable" };
        const persistDatabase = vi.fn()
            .mockRejectedValueOnce(new Error("enable database save failed"))
            .mockResolvedValueOnce(undefined);

        await expect(transitionPluginStorageMode(true, {
            dependencies: { persistDatabase },
        })).rejects.toThrow("enable database save failed");

        expect(database.optimizePluginMemory).toBe(false);
        expect(database.pluginCustomStorage).toEqual({
            alpha: "inline-before-enable",
        });
        expect(persistent.has(valueKey)).toBe(false);
        expect(persistent.has(PLUGIN_STORAGE_MANIFEST_KEY)).toBe(false);
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

    test("V2 pluginCustomStorage preserves ordinary prototype observations", () => {
        database.pluginCustomStorage = {
            alpha: 1,
            nested: { enabled: true },
            items: [{ value: "first" }],
        };
        const storage = (getV2PluginAPIs().getDatabase() as any).pluginCustomStorage;

        expect(Object.getPrototypeOf(storage)).toBe(Object.prototype);
        expect(storage).toBeInstanceOf(Object);
        expect(Object.prototype.isPrototypeOf(storage)).toBe(true);
        expect(storage.hasOwnProperty("alpha")).toBe(true);
        expect(storage.hasOwnProperty("missing")).toBe(false);
        expect("alpha" in storage).toBe(true);
        expect("toString" in storage).toBe(true);
        expect("missing" in storage).toBe(false);
        expect(String(storage)).toBe("[object Object]");

        expect(Object.getPrototypeOf(storage.nested)).toBe(Object.prototype);
        expect(storage.nested).toBeInstanceOf(Object);
        expect(Object.getPrototypeOf(storage.items)).toBe(Array.prototype);
        expect(storage.items).toBeInstanceOf(Array);
        expect(storage.items).toBeInstanceOf(Object);
        expect(Object.getPrototypeOf(storage.items[0])).toBe(Object.prototype);
        expect(storage.items[0]).toBeInstanceOf(Object);
    });

    test("V2 pluginCustomStorage safely shadows inherited special keys", () => {
        database.pluginCustomStorage = { alpha: 1 };
        const storage = (getV2PluginAPIs().getDatabase() as any).pluginCustomStorage;

        storage.hasOwnProperty = "stored-has-own";
        storage.constructor = "stored-constructor";
        storage.__proto__ = { stored: "proto-key" };

        expect(storage.hasOwnProperty).toBe("stored-has-own");
        expect(storage.constructor).toBe("stored-constructor");
        expect(storage.__proto__).toEqual({ stored: "proto-key" });
        expect(Object.prototype.hasOwnProperty.call(storage, "hasOwnProperty")).toBe(true);
        expect(Object.prototype.hasOwnProperty.call(storage, "constructor")).toBe(true);
        expect(Object.prototype.hasOwnProperty.call(storage, "__proto__")).toBe(true);
        expect(Object.getPrototypeOf(storage)).toBe(Object.prototype);

        delete storage.hasOwnProperty;
        delete storage.constructor;
        delete storage.__proto__;
        expect(storage.hasOwnProperty("alpha")).toBe(true);
        expect(storage.constructor).toBe(Object);
        expect(storage.__proto__).toBe(Object.prototype);
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

    test("V2 storage accepts and detaches the inline structured-clone value domain", () => {
        class CustomValue {
            label = "custom";
        }
        const cycle: Record<string, unknown> = { label: "cycle" };
        cycle.self = cycle;
        const sparse = new Array(3);
        sparse[1] = "present";
        const callerOwned = {
            date: new Date("2026-01-02T03:04:05.000Z"),
            binary: new Uint8Array([0, 128, 255]),
            map: new Map([["key", { nested: true }]]),
            set: new Set(["value"]),
            nan: Number.NaN,
            positiveInfinity: Number.POSITIVE_INFINITY,
            negativeInfinity: Number.NEGATIVE_INFINITY,
            bigint: 42n,
            sparse,
            cycle,
            custom: new CustomValue(),
        };
        const v2Apis = getV2PluginAPIs();

        v2Apis.pluginStorage.setItem("rich", callerOwned);

        const stored = database.pluginCustomStorage.rich;
        expect(stored).not.toBe(callerOwned);
        expect(stored.date).toEqual(callerOwned.date);
        expect(stored.date).not.toBe(callerOwned.date);
        expect([...stored.binary]).toEqual([0, 128, 255]);
        expect(stored.binary).not.toBe(callerOwned.binary);
        expect(stored.map).toEqual(new Map([["key", { nested: true }]]));
        expect(stored.set).toEqual(new Set(["value"]));
        expect(stored.nan).toBeNaN();
        expect(stored.positiveInfinity).toBe(Number.POSITIVE_INFINITY);
        expect(stored.negativeInfinity).toBe(Number.NEGATIVE_INFINITY);
        expect(stored.bigint).toBe(42n);
        expect(stored.sparse).toHaveLength(3);
        expect(Object.hasOwn(stored.sparse, 0)).toBe(false);
        expect(Object.hasOwn(stored.sparse, 1)).toBe(true);
        expect(Object.hasOwn(stored.sparse, 2)).toBe(false);
        expect(stored.cycle.self).toBe(stored.cycle);
        expect(stored.custom).toEqual({ label: "custom" });
        expect(stored.custom).not.toBeInstanceOf(CustomValue);

        callerOwned.binary[0] = 99;
        callerOwned.map.get("key")!.nested = false;
        callerOwned.sparse[0] = "late mutation";
        expect([...stored.binary]).toEqual([0, 128, 255]);
        expect(stored.map.get("key")).toEqual({ nested: true });
        expect(Object.hasOwn(stored.sparse, 0)).toBe(false);

        const read = v2Apis.pluginStorage.getItem("rich") as typeof callerOwned;
        expect(read).not.toBe(stored);
        expect(read.date).toEqual(new Date("2026-01-02T03:04:05.000Z"));
        expect([...read.binary]).toEqual([0, 128, 255]);
        expect(read.map).toEqual(new Map([["key", { nested: true }]]));
        expect(read.set).toEqual(new Set(["value"]));
        expect(read.nan).toBeNaN();
        expect(read.positiveInfinity).toBe(Number.POSITIVE_INFINITY);
        expect(read.negativeInfinity).toBe(Number.NEGATIVE_INFINITY);
        expect(read.bigint).toBe(42n);
        expect(Object.hasOwn(read.sparse, 0)).toBe(false);
        expect(read.cycle.self).toBe(read.cycle);

        read.binary[1] = 7;
        read.map.get("key")!.nested = false;
        expect([...stored.binary]).toEqual([0, 128, 255]);
        expect(stored.map.get("key")).toEqual({ nested: true });
    });

    test("V2 reads Date, binary, and non-finite values restored from RisuSave", async () => {
        const { decodeRisuSave, encodeRisuSaveLegacy } = await import("../storage/risuSave");
        const restored = await decodeRisuSave(encodeRisuSaveLegacy({
            pluginCustomStorage: {
                date: new Date("2024-03-04T05:06:07.000Z"),
                binary: new Uint8Array([1, 2, 254, 255]),
                nan: Number.NaN,
                infinity: Number.POSITIVE_INFINITY,
            },
        })) as any;
        database.pluginCustomStorage = restored.pluginCustomStorage;
        const storage = getV2PluginAPIs().pluginStorage;

        expect(storage.getItem("date")).toEqual(new Date("2024-03-04T05:06:07.000Z"));
        expect([...(storage.getItem("binary") as Uint8Array)]).toEqual([1, 2, 254, 255]);
        expect(storage.getItem("nan")).toBeNaN();
        expect(storage.getItem("infinity")).toBe(Number.POSITIVE_INFINITY);
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
        const frozenInput = Object.freeze({ value: "detached-snapshot" });
        databaseProxy.frozenInput = frozenInput;
        expect(database.pluginCustomStorage.frozenInput).toEqual(frozenInput);
        expect(database.pluginCustomStorage.frozenInput).not.toBe(frozenInput);
        expect(Object.isFrozen(database.pluginCustomStorage.frozenInput)).toBe(false);

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
        expect(Object.getPrototypeOf(storageProxy)).toBe(Object.prototype);
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

    // Keep this test last: an unknown production commit deliberately has no
    // in-process reset. Reload/module reinitialization is the recovery path.
    test("an unresolved staged finalize latches V2, V3, and database saves until reload", async () => {
        database.optimizePluginMemory = false;
        database.pluginCustomStorage = { alpha: "must-not-be-reused" };
        const { finalizePersistentPluginStorageTransition } = vi.mocked(
            await import("../storage/persistentKv"),
        );
        const { StorageError } = await import("../storage/storageError");
        finalizePersistentPluginStorageTransition.mockRejectedValueOnce(new StorageError(
            "finalize and status were both lost",
            {
                code: "COMMIT_OUTCOME_UNKNOWN",
                operation: "transition",
                commitOutcomeUnknown: true,
            },
        ));

        await expect(transitionPluginStorageMode(true)).rejects.toMatchObject({
            code: "COMMIT_OUTCOME_UNKNOWN",
            commitOutcomeUnknown: true,
        });
        expect(isPluginStorageModeTransitioning()).toBe(true);

        const v2Storage = getV2PluginAPIs().pluginStorage;
        v2Storage.setItem("late-v2", "blocked");
        v2Storage.removeItem("alpha");
        expect(v2Storage.getItem("late-v2")).toBeNull();
        expect(database.pluginCustomStorage).not.toHaveProperty("late-v2");

        const controller = new AbortController();
        const v3Writer = vi.fn();
        const queuedV3 = setPluginSaveStorageItem(
            "late-v3",
            "blocked",
            controller.signal,
        ).then(v3Writer);
        await Promise.resolve();
        expect(v3Writer).not.toHaveBeenCalled();
        controller.abort();
        await expect(queuedV3).rejects.toMatchObject({ name: "AbortError" });

        const { DatabaseSaveCoordinator } = await import("../storage/databaseSave");
        const databaseWriter = vi.fn(async () => ({ status: "committed" as const }));
        const outcome = await new DatabaseSaveCoordinator().run(databaseWriter);
        expect(outcome).toMatchObject({ status: "failed" });
        expect(databaseWriter).not.toHaveBeenCalled();
    });
});
