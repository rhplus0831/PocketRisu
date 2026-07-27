/**
 * Build a detached JSON-value tree without invoking getters or `toJSON`.
 *
 * Plugin storage accepts JSON data, not every value that `JSON.stringify`
 * happens to coerce. Rejecting unsupported values here prevents the inline and
 * externalized backends from silently choosing different/lossy representations.
 */
function createJsonSnapshot<T>(input: T, protectSerialization: boolean): T {
    const visiting = new Set<object>();

    const snapshot = (value: unknown, path: string): unknown => {
        if (value === null || typeof value === "string" || typeof value === "boolean") {
            return value;
        }
        if (typeof value === "number") {
            if (!Number.isFinite(value)) {
                throw new TypeError(`Persistent JSON requires a finite number at ${path}.`);
            }
            // JSON has no observable negative-zero distinction after the usual
            // stringify/parse round trip. Canonicalize it explicitly in every
            // backend instead of allowing modes to retain different values.
            return Object.is(value, -0) ? 0 : value;
        }
        if (typeof value !== "object") {
            throw new TypeError(`Persistent storage requires JSON data at ${path}.`);
        }

        const object = value as object;
        if (visiting.has(object)) {
            throw new TypeError(`Persistent JSON does not accept circular data at ${path}.`);
        }

        const isArray = Array.isArray(object);
        const prototype = Reflect.getPrototypeOf(object);
        if (!isArray && prototype !== Object.prototype && prototype !== null) {
            throw new TypeError(`Persistent JSON requires plain objects at ${path}.`);
        }

        visiting.add(object);
        try {
            if (isArray) {
                const lengthDescriptor = Reflect.getOwnPropertyDescriptor(object, "length");
                const length = lengthDescriptor && "value" in lengthDescriptor
                    ? lengthDescriptor.value
                    : undefined;
                if (!Number.isSafeInteger(length) || length < 0) {
                    throw new TypeError(`Persistent JSON received an invalid array at ${path}.`);
                }

                const ownKeys = Reflect.ownKeys(object);
                for (const key of ownKeys) {
                    if (key === "length") continue;
                    if (typeof key !== "string") {
                        throw new TypeError(`Persistent JSON does not accept symbol keys at ${path}.`);
                    }
                    const index = Number(key);
                    if (!Number.isInteger(index) || index < 0 || index >= length || String(index) !== key) {
                        throw new TypeError(
                            `Persistent JSON arrays do not accept extra property ${JSON.stringify(key)} at ${path}.`,
                        );
                    }
                }

                const result: unknown[] = new Array(length);
                if (protectSerialization) {
                    // Do not allow a subsequently poisoned
                    // Array.prototype.toJSON to transform this private copy.
                    Object.defineProperty(result, "toJSON", {
                        configurable: false,
                        enumerable: false,
                        value: undefined,
                        writable: false,
                    });
                }
                for (let index = 0; index < length; index += 1) {
                    const descriptor = Reflect.getOwnPropertyDescriptor(object, String(index));
                    if (!descriptor) {
                        throw new TypeError(`Persistent JSON does not accept array holes at ${path}[${index}].`);
                    }
                    if (!("value" in descriptor)) {
                        throw new TypeError(`Persistent JSON does not accept accessors at ${path}[${index}].`);
                    }
                    if (!descriptor.enumerable) {
                        throw new TypeError(
                            `Persistent JSON requires enumerable array data at ${path}[${index}].`,
                        );
                    }
                    result[index] = snapshot(descriptor.value, `${path}[${index}]`);
                }
                return result;
            }

            const keys = Reflect.ownKeys(object);
            const seen = new Set<PropertyKey>(keys);
            // Svelte's deep proxy can hide a configurable own property whose
            // name is inherited from Object.prototype. Discover those names
            // through descriptors so special plugin keys remain lossless.
            for (const key of Object.getOwnPropertyNames(Object.prototype)) {
                if (!seen.has(key) && Reflect.getOwnPropertyDescriptor(object, key)) {
                    keys.push(key);
                    seen.add(key);
                }
            }

            const result = Object.create(null) as Record<string, unknown>;
            for (const key of keys) {
                if (typeof key !== "string") {
                    throw new TypeError(`Persistent JSON does not accept symbol keys at ${path}.`);
                }
                const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
                if (!descriptor || !("value" in descriptor)) {
                    throw new TypeError(
                        `Persistent JSON does not accept accessors at ${path}.${key}.`,
                    );
                }
                if (!descriptor.enumerable) {
                    throw new TypeError(
                        `Persistent JSON requires enumerable object data at ${path}.${key}.`,
                    );
                }
                Object.defineProperty(result, key, {
                    configurable: true,
                    enumerable: true,
                    value: snapshot(descriptor.value, `${path}.${key}`),
                    writable: true,
                });
            }
            return result;
        } finally {
            visiting.delete(object);
        }
    };

    return snapshot(input, "$") as T;
}

export function snapshotJsonValue<T>(input: T): T {
    return createJsonSnapshot(input, false);
}

const dateGetTime = Date.prototype.getTime;
const dateToISOString = Date.prototype.toISOString;
const mapForEach = Map.prototype.forEach;
const setForEach = Set.prototype.forEach;
const bigintToString = BigInt.prototype.toString;

function hasNoOwnProperties(value: object, path: string, type: string): void {
    if (Reflect.ownKeys(value).length > 0) {
        throw new TypeError(
            "Automatic JSON conversion does not accept custom properties on "
            + type + " at " + path + ".",
        );
    }
}

/**
 * Convert the small set of non-JSON values with predictable representations
 * without dropping fields or entries. This intentionally does not invoke
 * getters, toJSON, or replace functions/cycles with lossy placeholders.
 */
export function convertCompatibleJsonValue(input: unknown): unknown {
    const visiting = new Set<object>();

    const convert = (value: unknown, path: string): unknown => {
        if (value === null || typeof value === "string" || typeof value === "boolean") {
            return value;
        }
        if (typeof value === "number") {
            if (!Number.isFinite(value)) return null;
            return Object.is(value, -0) ? 0 : value;
        }
        if (typeof value === "bigint") {
            return Reflect.apply(bigintToString, value, []);
        }
        if (value === undefined) return null;
        if (typeof value !== "object") {
            throw new TypeError("Automatic JSON conversion cannot represent data at " + path + ".");
        }
        if (visiting.has(value)) {
            throw new TypeError(
                "Automatic JSON conversion does not accept circular data at " + path + ".",
            );
        }

        visiting.add(value);
        try {
            if (Array.isArray(value)) {
                const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
                const length = lengthDescriptor && "value" in lengthDescriptor
                    ? lengthDescriptor.value
                    : undefined;
                if (!Number.isSafeInteger(length) || length < 0) {
                    throw new TypeError(
                        "Automatic JSON conversion received an invalid array at " + path + ".",
                    );
                }
                for (const key of Reflect.ownKeys(value)) {
                    if (key === "length") continue;
                    if (typeof key !== "string") {
                        throw new TypeError(
                            "Automatic JSON conversion does not accept symbol keys at "
                            + path + ".",
                        );
                    }
                    const index = Number(key);
                    if (!Number.isInteger(index)
                        || index < 0
                        || index >= length
                        || String(index) !== key) {
                        throw new TypeError(
                            "Automatic JSON conversion does not accept extra array property "
                            + JSON.stringify(key) + " at " + path + ".",
                        );
                    }
                }
                const result: unknown[] = new Array(length);
                for (let index = 0; index < length; index += 1) {
                    const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
                    if (!descriptor) {
                        result[index] = null;
                        continue;
                    }
                    if (!("value" in descriptor) || !descriptor.enumerable) {
                        throw new TypeError(
                            "Automatic JSON conversion requires enumerable array data at "
                            + path + "[" + index + "].",
                        );
                    }
                    result[index] = convert(
                        descriptor.value,
                        path + "[" + index + "]",
                    );
                }
                return result;
            }

            let dateValue = false;
            let dateTime = Number.NaN;
            try {
                dateTime = Reflect.apply(dateGetTime, value, []);
                dateValue = true;
            } catch {
                // Not a Date; continue with the other supported object types.
            }
            if (dateValue) {
                hasNoOwnProperties(value, path, "Date");
                if (!Number.isFinite(dateTime)) {
                    throw new TypeError(
                        "Automatic JSON conversion does not accept an invalid Date at "
                        + path + ".",
                    );
                }
                return Reflect.apply(dateToISOString, value, []);
            }

            let mapEntries: [unknown, unknown][] | null = [];
            try {
                Reflect.apply(mapForEach, value, [
                    (entryValue: unknown, entryKey: unknown) => {
                        mapEntries!.push([entryKey, entryValue]);
                    },
                ]);
            } catch {
                mapEntries = null;
            }
            if (mapEntries !== null) {
                hasNoOwnProperties(value, path, "Map");
                return mapEntries.map(([entryKey, entryValue], index) => [
                    convert(entryKey, path + "<map>[" + index + "][0]"),
                    convert(entryValue, path + "<map>[" + index + "][1]"),
                ]);
            }

            let setEntries: unknown[] | null = [];
            try {
                Reflect.apply(setForEach, value, [
                    (entryValue: unknown) => setEntries!.push(entryValue),
                ]);
            } catch {
                setEntries = null;
            }
            if (setEntries !== null) {
                hasNoOwnProperties(value, path, "Set");
                return setEntries.map((entryValue, index) => (
                    convert(entryValue, path + "<set>[" + index + "]")
                ));
            }

            const prototype = Reflect.getPrototypeOf(value);
            if (prototype !== Object.prototype && prototype !== null) {
                throw new TypeError(
                    "Automatic JSON conversion requires plain objects at " + path + ".",
                );
            }
            const result = Object.create(null) as Record<string, unknown>;
            for (const key of Reflect.ownKeys(value)) {
                if (typeof key !== "string") {
                    throw new TypeError(
                        "Automatic JSON conversion does not accept symbol keys at "
                        + path + ".",
                    );
                }
                const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
                if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
                    throw new TypeError(
                        "Automatic JSON conversion requires enumerable data properties at "
                        + path + "." + key + ".",
                    );
                }
                Object.defineProperty(result, key, {
                    configurable: true,
                    enumerable: true,
                    value: convert(descriptor.value, path + "." + key),
                    writable: true,
                });
            }
            return result;
        } finally {
            visiting.delete(value);
        }
    };

    return snapshotJsonValue(convert(input, "$"));
}

export function stringifyJsonValue(value: unknown): string {
    const serialized = JSON.stringify(createJsonSnapshot(value, true));
    if (serialized === undefined) {
        // The validator should make this unreachable; keep the persistence
        // boundary defensive if its accepted value set changes later.
        throw new TypeError("Persistent storage requires a representable JSON value.");
    }
    return serialized;
}
