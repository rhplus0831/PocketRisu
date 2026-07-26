export type PluginStorageRecord<T> = Record<string, T>;

export function createPluginStorageRecord<T>(): PluginStorageRecord<T> {
    return Object.create(null) as PluginStorageRecord<T>;
}

/** Ordinary-prototype records remain deeply reactive when assigned into Svelte $state. */
export function createDatabasePluginStorageRecord<T>(): PluginStorageRecord<T> {
    return {};
}

export function definePluginStorageRecordValue<T>(
    record: PluginStorageRecord<T>,
    key: PropertyKey,
    value: T,
): void {
    Object.defineProperty(record, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
    });
}

const reactivePluginStorageWriteSentinel = {};
let reactivePluginStorageNotificationId = 0;

/**
 * Add/update an own key without invoking an inherited setter, while still
 * passing the final write through Svelte's reactive `set` proxy trap.
 */
export function setDatabasePluginStorageRecordValue<T>(
    record: PluginStorageRecord<T>,
    key: PropertyKey,
    value: T,
): void {
    const isNewKey = !hasPluginStorageRecordValue(record, key);
    let notificationKey: string | undefined;
    if (isNewKey) {
        // Establish Svelte's own-key source before defining `__proto__`.
        // Defining it first on an otherwise empty proxy can be discarded when
        // Svelte later observes the first ordinary `set` operation.
        do {
            notificationKey = `\0pocket-risu-plugin-storage-write-${
                reactivePluginStorageNotificationId++
            }`;
        } while (hasPluginStorageRecordValue(record, notificationKey));
        Reflect.set(record, notificationKey, true, record);
        Reflect.deleteProperty(record, notificationKey);
        definePluginStorageRecordValue(
            record,
            key,
            reactivePluginStorageWriteSentinel as T,
        );
    }
    if (!Reflect.set(record, key, value, record)) {
        throw new TypeError(`Unable to write plugin storage key ${String(key)}.`);
    }
}

export function hasPluginStorageRecordValue<T>(
    record: PluginStorageRecord<T> | null | undefined,
    key: PropertyKey,
): boolean {
    return record !== null && record !== undefined && Object.hasOwn(record, key);
}

/**
 * Enumerate storage keys even when Svelte hides a first own property whose
 * name is inherited from Object.prototype (for example `constructor`).
 */
export function getPluginStorageRecordKeys<T>(
    record: PluginStorageRecord<T> | null | undefined,
): string[] {
    if (record === null || record === undefined) return [];
    const keys = Object.keys(record);
    const seen = new Set(keys);
    // Resolve this dynamically: plugin code can add a name to Object.prototype
    // after this module loads, and Svelte can then hide that first own name.
    for (const key of Object.getOwnPropertyNames(Object.prototype)) {
        const descriptor = Reflect.getOwnPropertyDescriptor(record, key);
        if (!seen.has(key) && descriptor?.enumerable) {
            keys.push(key);
        }
    }
    return keys;
}

export function copyPluginStorageRecord<T>(
    source: PluginStorageRecord<T> | null | undefined,
): PluginStorageRecord<T> {
    const copy = createPluginStorageRecord<T>();
    for (const key of getPluginStorageRecordKeys(source)) {
        definePluginStorageRecordValue(copy, key, source![key]);
    }
    return copy;
}

export function copyDatabasePluginStorageRecord<T>(
    source: PluginStorageRecord<T> | null | undefined,
): PluginStorageRecord<T> {
    const copy = createDatabasePluginStorageRecord<T>();
    for (const key of getPluginStorageRecordKeys(source)) {
        definePluginStorageRecordValue(copy, key, source![key]);
    }
    return copy;
}

/** Later records win, matching object-spread precedence without prototype keys. */
export function mergePluginStorageRecords<T>(
    ...sources: Array<PluginStorageRecord<T> | null | undefined>
): PluginStorageRecord<T> {
    const merged = createPluginStorageRecord<T>();
    for (const source of sources) {
        for (const key of getPluginStorageRecordKeys(source)) {
            definePluginStorageRecordValue(merged, key, source![key]);
        }
    }
    return merged;
}
