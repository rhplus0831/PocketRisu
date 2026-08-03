import { serializeJsonValueToUtf8 } from "./jsonValue";

export const PLUGIN_STORAGE_JSON_CODEC = "json-v1";
export const PLUGIN_STORAGE_LOSSLESS_CODEC = "lossless-json-v1";
export const PLUGIN_STORAGE_JSON_CONTENT_TYPE = "application/json";
export const PLUGIN_STORAGE_LOSSLESS_CONTENT_TYPE = "application/octet-stream";

// This prefix is deliberately not valid at the beginning of a JSON document.
// It makes the lossless representation unambiguous even when a plugin stores
// strings or objects that resemble the codec's internal tags.
export const PLUGIN_STORAGE_LOSSLESS_MAGIC = "PRISUL01";
const losslessMagicBytes = new TextEncoder().encode(PLUGIN_STORAGE_LOSSLESS_MAGIC);
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
const HOLE = Symbol("pocketrisu-plugin-storage-array-hole");

type EncodedLosslessNode =
    | null
    | boolean
    | number
    | string
    | ["u"]
    | ["h"]
    | ["a", EncodedLosslessNode[]]
    | ["o", [string, EncodedLosslessNode][]];

function hasLosslessMagic(bytes: Uint8Array): boolean {
    if (bytes.byteLength < losslessMagicBytes.byteLength) return false;
    for (let index = 0; index < losslessMagicBytes.byteLength; index += 1) {
        if (bytes[index] !== losslessMagicBytes[index]) return false;
    }
    return true;
}

export function pluginStorageCodecFromBytes(bytes: Uint8Array):
    typeof PLUGIN_STORAGE_JSON_CODEC | typeof PLUGIN_STORAGE_LOSSLESS_CODEC {
    return hasLosslessMagic(bytes)
        ? PLUGIN_STORAGE_LOSSLESS_CODEC
        : PLUGIN_STORAGE_JSON_CODEC;
}

function encodeLosslessNode(
    value: unknown,
    path: string,
    visiting: Set<object>,
): EncodedLosslessNode {
    if (value === undefined) return ["u"];
    if (value === null || typeof value === "string" || typeof value === "boolean") {
        return value as null | string | boolean;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new TypeError(`Lossless plugin storage requires a finite number at ${path}.`);
        }
        return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value !== "object") {
        throw new TypeError(`Lossless plugin storage cannot represent data at ${path}.`);
    }
    if (visiting.has(value)) {
        throw new TypeError(`Lossless plugin storage does not accept circular data at ${path}.`);
    }

    const isArray = Array.isArray(value);
    const prototype = Reflect.getPrototypeOf(value);
    if (!isArray && prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`Lossless plugin storage requires plain objects at ${path}.`);
    }

    visiting.add(value);
    try {
        if (isArray) {
            const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
            const length = lengthDescriptor && "value" in lengthDescriptor
                ? lengthDescriptor.value
                : undefined;
            if (!Number.isSafeInteger(length) || length < 0) {
                throw new TypeError(`Lossless plugin storage received an invalid array at ${path}.`);
            }
            for (const key of Reflect.ownKeys(value)) {
                if (key === "length") continue;
                if (typeof key !== "string") {
                    throw new TypeError(`Lossless plugin storage rejects symbol keys at ${path}.`);
                }
                const index = Number(key);
                if (!Number.isInteger(index)
                    || index < 0
                    || index >= length
                    || String(index) !== key) {
                    throw new TypeError(
                        `Lossless plugin storage rejects extra array property ${JSON.stringify(key)} at ${path}.`,
                    );
                }
            }

            const items: EncodedLosslessNode[] = new Array(length);
            for (let index = 0; index < length; index += 1) {
                const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
                if (!descriptor) {
                    items[index] = ["h"];
                    continue;
                }
                if (!("value" in descriptor) || !descriptor.enumerable) {
                    throw new TypeError(
                        `Lossless plugin storage requires enumerable array data at ${path}[${index}].`,
                    );
                }
                items[index] = encodeLosslessNode(
                    descriptor.value,
                    `${path}[${index}]`,
                    visiting,
                );
            }
            return ["a", items];
        }

        const entries: [string, EncodedLosslessNode][] = [];
        for (const key of Reflect.ownKeys(value)) {
            if (typeof key !== "string") {
                throw new TypeError(`Lossless plugin storage rejects symbol keys at ${path}.`);
            }
            const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
                throw new TypeError(
                    `Lossless plugin storage requires enumerable data properties at ${path}.${key}.`,
                );
            }
            entries.push([
                key,
                encodeLosslessNode(descriptor.value, `${path}.${key}`, visiting),
            ]);
        }
        return ["o", entries];
    } finally {
        visiting.delete(value);
    }
}

export function encodeLosslessPluginStorageValueToUtf8(value: unknown): Uint8Array {
    const body = serializeJsonValueToUtf8(
        encodeLosslessNode(value, "$", new Set<object>()),
    );
    const encoded = new Uint8Array(losslessMagicBytes.byteLength + body.byteLength);
    encoded.set(losslessMagicBytes, 0);
    encoded.set(body, losslessMagicBytes.byteLength);
    return encoded;
}

function invalidLosslessValue(): never {
    throw new TypeError("Invalid lossless plugin storage value.");
}

function decodeLosslessNode(
    encoded: unknown,
    allowHole: boolean,
    depth: number,
): unknown | typeof HOLE {
    if (depth > 1024) invalidLosslessValue();
    if (encoded === null
        || typeof encoded === "string"
        || typeof encoded === "boolean") return encoded;
    if (typeof encoded === "number") {
        if (!Number.isFinite(encoded)) invalidLosslessValue();
        return Object.is(encoded, -0) ? 0 : encoded;
    }
    if (!Array.isArray(encoded) || typeof encoded[0] !== "string") {
        return invalidLosslessValue();
    }

    if (encoded[0] === "u" && encoded.length === 1) return undefined;
    if (encoded[0] === "h" && encoded.length === 1 && allowHole) return HOLE;
    if (encoded[0] === "a" && encoded.length === 2 && Array.isArray(encoded[1])) {
        const source = encoded[1];
        const value: unknown[] = new Array(source.length);
        for (let index = 0; index < source.length; index += 1) {
            const item = decodeLosslessNode(source[index], true, depth + 1);
            if (item !== HOLE) value[index] = item;
        }
        return value;
    }
    if (encoded[0] === "o" && encoded.length === 2 && Array.isArray(encoded[1])) {
        const value: Record<string, unknown> = {};
        const seen = new Set<string>();
        for (const entry of encoded[1]) {
            if (!Array.isArray(entry)
                || entry.length !== 2
                || typeof entry[0] !== "string"
                || seen.has(entry[0])) return invalidLosslessValue();
            const decoded = decodeLosslessNode(entry[1], false, depth + 1);
            if (decoded === HOLE) return invalidLosslessValue();
            seen.add(entry[0]);
            Object.defineProperty(value, entry[0], {
                configurable: true,
                enumerable: true,
                value: decoded,
                writable: true,
            });
        }
        return value;
    }
    return invalidLosslessValue();
}

export function snapshotLosslessPluginStorageValue<T>(value: T): T {
    const decoded = decodeLosslessNode(
        encodeLosslessNode(value, "$", new Set<object>()),
        false,
        0,
    );
    if (decoded === HOLE) invalidLosslessValue();
    return decoded as T;
}

export function decodePluginStorageValueBytes<T>(
    bytes: Uint8Array,
    expectedCodec?: string | null,
): T {
    const codec = pluginStorageCodecFromBytes(bytes);
    if (expectedCodec !== undefined && expectedCodec !== null && expectedCodec !== codec) {
        throw new TypeError("Plugin storage value codec did not match its metadata.");
    }
    if (codec === PLUGIN_STORAGE_JSON_CODEC) {
        return JSON.parse(fatalUtf8Decoder.decode(bytes)) as T;
    }
    const body = bytes.subarray(losslessMagicBytes.byteLength);
    const encoded = JSON.parse(fatalUtf8Decoder.decode(body));
    const decoded = decodeLosslessNode(encoded, false, 0);
    if (decoded === HOLE) invalidLosslessValue();
    return decoded as T;
}
