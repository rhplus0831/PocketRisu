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

const JSON_HEX = "0123456789abcdef";

/**
 * Small owned UTF-8 sink for strict JSON serialization. It grows geometrically
 * and returns a view over its private buffer, so a complete intermediate JSON
 * string or detached object graph is never required by the persistence path.
 */
class JsonUtf8Writer {
    private bytes = new Uint8Array(1024);
    private length = 0;

    private reserve(additional: number): void {
        const required = this.length + additional;
        if (required <= this.bytes.byteLength) return;
        let capacity = this.bytes.byteLength;
        while (capacity < required) {
            capacity = Math.max(required, capacity * 2);
        }
        const next = new Uint8Array(capacity);
        next.set(this.bytes);
        this.bytes = next;
    }

    byte(value: number): void {
        this.reserve(1);
        this.bytes[this.length++] = value;
    }

    ascii(value: string): void {
        this.reserve(value.length);
        for (let index = 0; index < value.length; index += 1) {
            this.bytes[this.length++] = value.charCodeAt(index);
        }
    }

    private unicodeEscape(codeUnit: number): void {
        this.reserve(6);
        this.bytes[this.length++] = 0x5c;
        this.bytes[this.length++] = 0x75;
        this.bytes[this.length++] = JSON_HEX.charCodeAt((codeUnit >>> 12) & 0xf);
        this.bytes[this.length++] = JSON_HEX.charCodeAt((codeUnit >>> 8) & 0xf);
        this.bytes[this.length++] = JSON_HEX.charCodeAt((codeUnit >>> 4) & 0xf);
        this.bytes[this.length++] = JSON_HEX.charCodeAt(codeUnit & 0xf);
    }

    private codePoint(value: number): void {
        if (value <= 0x7f) {
            this.byte(value);
            return;
        }
        if (value <= 0x7ff) {
            this.reserve(2);
            this.bytes[this.length++] = 0xc0 | (value >>> 6);
            this.bytes[this.length++] = 0x80 | (value & 0x3f);
            return;
        }
        if (value <= 0xffff) {
            this.reserve(3);
            this.bytes[this.length++] = 0xe0 | (value >>> 12);
            this.bytes[this.length++] = 0x80 | ((value >>> 6) & 0x3f);
            this.bytes[this.length++] = 0x80 | (value & 0x3f);
            return;
        }
        this.reserve(4);
        this.bytes[this.length++] = 0xf0 | (value >>> 18);
        this.bytes[this.length++] = 0x80 | ((value >>> 12) & 0x3f);
        this.bytes[this.length++] = 0x80 | ((value >>> 6) & 0x3f);
        this.bytes[this.length++] = 0x80 | (value & 0x3f);
    }

    string(value: string): void {
        this.byte(0x22);
        for (let index = 0; index < value.length; index += 1) {
            const codeUnit = value.charCodeAt(index);
            if (codeUnit === 0x22 || codeUnit === 0x5c) {
                this.byte(0x5c);
                this.byte(codeUnit);
            } else if (codeUnit === 0x08) {
                this.ascii("\\b");
            } else if (codeUnit === 0x09) {
                this.ascii("\\t");
            } else if (codeUnit === 0x0a) {
                this.ascii("\\n");
            } else if (codeUnit === 0x0c) {
                this.ascii("\\f");
            } else if (codeUnit === 0x0d) {
                this.ascii("\\r");
            } else if (codeUnit < 0x20) {
                this.unicodeEscape(codeUnit);
            } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
                const low = value.charCodeAt(index + 1);
                if (low >= 0xdc00 && low <= 0xdfff) {
                    this.codePoint(
                        0x10000 + ((codeUnit - 0xd800) << 10) + (low - 0xdc00),
                    );
                    index += 1;
                } else {
                    this.unicodeEscape(codeUnit);
                }
            } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
                this.unicodeEscape(codeUnit);
            } else {
                this.codePoint(codeUnit);
            }
        }
        this.byte(0x22);
    }

    finish(): Uint8Array {
        return this.bytes.subarray(0, this.length);
    }
}

export interface JsonValueSerializationOptions {
    /** Test/diagnostic hook: called exactly once for each serialized value. */
    onVisit?: (path: string, value: unknown) => void;
    /** Preserve the established V3 atomic-batch validation messages/rules. */
    validation?: "persistent" | "plugin-batch";
}

/**
 * Validate and serialize one strict JSON value directly into owned UTF-8
 * bytes. Descriptor-only traversal keeps the existing refusal surface without
 * invoking getters or `toJSON`, while one visiting set detects only cycles
 * (repeated non-cyclic references remain valid JSON, as before).
 */
export function serializeJsonValueToUtf8(
    input: unknown,
    options: JsonValueSerializationOptions = {},
): Uint8Array {
    const writer = new JsonUtf8Writer();
    const visiting = new Set<object>();
    const pluginBatch = options.validation === "plugin-batch";

    const serialize = (value: unknown, path: string): void => {
        options.onVisit?.(path, value);
        if (value === null) {
            writer.ascii("null");
            return;
        }
        if (typeof value === "string") {
            writer.string(value);
            return;
        }
        if (typeof value === "boolean") {
            writer.ascii(value ? "true" : "false");
            return;
        }
        if (typeof value === "number") {
            if (!Number.isFinite(value)) {
                throw new TypeError(pluginBatch
                    ? `Plugin batch value must be finite at ${path}.`
                    : `Persistent JSON requires a finite number at ${path}.`);
            }
            writer.ascii(Object.is(value, -0) ? "0" : String(value));
            return;
        }
        if (typeof value !== "object") {
            throw new TypeError(pluginBatch
                ? `Plugin batch value is not JSON-representable at ${path}.`
                : `Persistent storage requires JSON data at ${path}.`);
        }

        if (visiting.has(value)) {
            throw new TypeError(pluginBatch
                ? `Plugin batch value is cyclic at ${path}.`
                : `Persistent JSON does not accept circular data at ${path}.`);
        }
        const isArray = Array.isArray(value);
        const prototype = Reflect.getPrototypeOf(value);
        const prototypeConstructor = prototype
            ? Reflect.getOwnPropertyDescriptor(prototype, "constructor")?.value
            : null;
        if (!isArray && prototype !== null && (pluginBatch
            ? (typeof prototypeConstructor !== "function"
                || prototypeConstructor.name !== "Object")
            : prototype !== Object.prototype)) {
            throw new TypeError(pluginBatch
                ? `Plugin batch values require plain objects at ${path}.`
                : `Persistent JSON requires plain objects at ${path}.`);
        }

        visiting.add(value);
        try {
            if (isArray) {
                const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
                const length = lengthDescriptor && "value" in lengthDescriptor
                    ? lengthDescriptor.value
                    : undefined;
                if (!Number.isSafeInteger(length) || length < 0) {
                    throw new TypeError(pluginBatch
                        ? `Plugin batch arrays must be dense at ${path}.`
                        : `Persistent JSON received an invalid array at ${path}.`);
                }
                for (const key of Reflect.ownKeys(value)) {
                    if (key === "length") continue;
                    if (typeof key !== "string") {
                        throw new TypeError(pluginBatch
                            ? `Plugin batch arrays must be dense at ${path}.`
                            : `Persistent JSON does not accept symbol keys at ${path}.`);
                    }
                    const index = Number(key);
                    if (!Number.isInteger(index)
                        || index < 0
                        || index >= length
                        || String(index) !== key) {
                        throw new TypeError(pluginBatch
                            ? `Plugin batch arrays must be dense at ${path}.`
                            : `Persistent JSON arrays do not accept extra property ${JSON.stringify(key)} at ${path}.`);
                    }
                }

                writer.byte(0x5b);
                for (let index = 0; index < length; index += 1) {
                    const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
                    if (!descriptor) {
                        throw new TypeError(pluginBatch
                            ? `Plugin batch arrays must be dense at ${path}[${index}].`
                            : `Persistent JSON does not accept array holes at ${path}[${index}].`);
                    }
                    if (!("value" in descriptor)) {
                        throw new TypeError(pluginBatch
                            ? `Plugin batch arrays must be dense at ${path}[${index}].`
                            : `Persistent JSON does not accept accessors at ${path}[${index}].`);
                    }
                    if (!descriptor.enumerable) {
                        throw new TypeError(pluginBatch
                            ? `Plugin batch arrays must be dense at ${path}[${index}].`
                            : `Persistent JSON requires enumerable array data at ${path}[${index}].`);
                    }
                    if (index > 0) writer.byte(0x2c);
                    serialize(descriptor.value, `${path}[${index}]`);
                }
                writer.byte(0x5d);
                return;
            }

            const keys = Reflect.ownKeys(value);
            const seen = new Set<PropertyKey>(keys);
            if (!pluginBatch) {
                for (const key of Object.getOwnPropertyNames(Object.prototype)) {
                    if (!seen.has(key) && Reflect.getOwnPropertyDescriptor(value, key)) {
                        keys.push(key);
                        seen.add(key);
                    }
                }
            }
            writer.byte(0x7b);
            let emitted = 0;
            for (const key of keys) {
                if (typeof key !== "string") {
                    throw new TypeError(pluginBatch
                        ? `Plugin batch symbols are invalid at ${path}.`
                        : `Persistent JSON does not accept symbol keys at ${path}.`);
                }
                const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
                if (!descriptor || !("value" in descriptor)) {
                    throw new TypeError(pluginBatch
                        ? `Plugin batch values require enumerable data properties at ${path}.${key}.`
                        : `Persistent JSON does not accept accessors at ${path}.${key}.`);
                }
                if (!descriptor.enumerable) {
                    throw new TypeError(pluginBatch
                        ? `Plugin batch values require enumerable data properties at ${path}.${key}.`
                        : `Persistent JSON requires enumerable object data at ${path}.${key}.`);
                }
                if (emitted > 0) writer.byte(0x2c);
                writer.string(key);
                writer.byte(0x3a);
                serialize(descriptor.value, `${path}.${key}`);
                emitted += 1;
            }
            writer.byte(0x7d);
        } finally {
            visiting.delete(value);
        }
    };

    serialize(input, "$");
    return writer.finish();
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
        // Optimized plugin storage can wrap this converted graph in its
        // versioned lossless codec. Keep the structured-clone distinction
        // instead of collapsing it to JSON null.
        if (value === undefined) return undefined;
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
                        // Leave a real sparse hole. A dense `undefined` entry
                        // is assigned below and remains observably distinct.
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

    // `convert()` already constructs a detached descriptor-only graph. The
    // strict snapshot intentionally rejects the undefined values and holes
    // that the plugin-value codec preserves.
    return convert(input, "$");
}

export function stringifyJsonValue(value: unknown): string {
    return new TextDecoder().decode(serializeJsonValueToUtf8(value));
}
