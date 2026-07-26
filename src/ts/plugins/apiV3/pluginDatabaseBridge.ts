export interface PluginDatabaseBridgeDependencies {
    allowedDbKeys: readonly string[];
    getLiveDatabase: () => Record<string, unknown>;
    snapshotField: (key: string, value: unknown) => unknown;
    getPluginStorageSnapshot: () => Promise<Record<string, unknown>>;
    updateWithPluginStorageSnapshot: <T>(
        pluginCustomStorage: Record<string, unknown> | undefined,
        mutateDatabase: () => T | Promise<T>,
    ) => Promise<T>;
    applyLite: (database: Record<string, unknown>) => void | Promise<void>;
    applyFull: (database: Record<string, unknown>) => void | Promise<void>;
}

function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
    Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
    });
}

function prepareMutation(
    input: unknown,
    dependencies: PluginDatabaseBridgeDependencies,
): {
    database: Record<string, unknown>;
    pluginCustomStorage: Record<string, unknown> | undefined;
} {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new TypeError("V3 database updates require a DatabaseSubset object.");
    }

    const database = {} as Record<string, unknown>;
    let pluginCustomStorage: Record<string, unknown> | undefined;
    for (const key of Reflect.ownKeys(input)) {
        if (typeof key !== "string") {
            throw new TypeError("V3 database updates do not accept symbol keys.");
        }
        const descriptor = Reflect.getOwnPropertyDescriptor(input, key);
        if (!descriptor) continue;
        if (!("value" in descriptor)) {
            throw new TypeError(`V3 database updates do not accept an accessor for ${key}.`);
        }
        if (!dependencies.allowedDbKeys.includes(key)) {
            throw new TypeError(
                `Unsupported V3 database key ${JSON.stringify(key)}; use pluginStorage for plugin data.`,
            );
        }
        if (!descriptor.enumerable) {
            throw new TypeError(`V3 database updates require an enumerable data property for ${key}.`);
        }
        if (key === "pluginCustomStorage") {
            const value = descriptor.value;
            if (value === null || typeof value !== "object" || Array.isArray(value)) {
                throw new TypeError("pluginCustomStorage must be a JSON object when provided.");
            }
            pluginCustomStorage = value as Record<string, unknown>;
            continue;
        }
        defineOwn(
            database,
            key,
            dependencies.snapshotField(key, descriptor.value),
        );
    }
    return { database, pluginCustomStorage };
}

/**
 * V3 database semantics:
 * - provided ordinary fields merge into live DB state;
 * - omitted ordinary fields remain unchanged;
 * - provided pluginCustomStorage exactly replaces the authoritative key set;
 * - replacement preserves owner metadata for retained keys and removes it for
 *   deleted keys; new keys remain unowned until a pluginStorage write;
 * - omitted pluginCustomStorage leaves the authoritative key set unchanged.
 * Input must contain enumerable string data properties only; symbols,
 * accessors, non-enumerable properties, and unsupported keys are rejected.
 */
export function createPluginDatabaseBridge(dependencies: PluginDatabaseBridgeDependencies) {
    const getDatabase = async (includeOnly: string[] | "all" = "all") => {
        const live = dependencies.getLiveDatabase();
        const result = {} as Record<string, unknown>;
        for (const key of dependencies.allowedDbKeys) {
            if (includeOnly !== "all" && !includeOnly.includes(key)) continue;
            const value = key === "pluginCustomStorage"
                ? await dependencies.getPluginStorageSnapshot()
                : dependencies.snapshotField(key, live[key]);
            defineOwn(result, key, value);
        }
        return result;
    };

    const setDatabaseLite = async (input: unknown): Promise<void> => {
        const prepared = prepareMutation(input, dependencies);
        await dependencies.updateWithPluginStorageSnapshot(
            prepared.pluginCustomStorage,
            () => dependencies.applyLite(prepared.database),
        );
    };

    const setDatabase = async (input: unknown): Promise<void> => {
        const prepared = prepareMutation(input, dependencies);
        await dependencies.updateWithPluginStorageSnapshot(
            prepared.pluginCustomStorage,
            () => dependencies.applyFull(prepared.database),
        );
    };

    return { getDatabase, setDatabaseLite, setDatabase };
}
