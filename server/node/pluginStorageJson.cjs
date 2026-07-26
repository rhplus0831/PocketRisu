const { TextDecoder } = require('util');
const {
    PLUGIN_SAVE_PREFIX,
    PLUGIN_SAVE_META_PREFIX,
    decodePluginSaveStorageKey,
    encodePluginSaveStorageKey,
} = require('./pluginSaveKeys.cjs');

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

class PluginStorageValidationError extends Error {
    constructor(encodedKey) {
        super('Invalid plugin storage JSON row');
        this.name = 'PluginStorageValidationError';
        this.code = 'INVALID_PLUGIN_STORAGE_ROW';
        this.encodedKey = encodedKey;
    }
}

function isPluginStorageValidationError(error) {
    return error instanceof PluginStorageValidationError
        || error?.code === 'INVALID_PLUGIN_STORAGE_ROW';
}

function snapshotPluginStorageJson(
    input,
    path = '$',
    visiting = new Set(),
    protectSerialization = false,
) {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') {
        return input;
    }
    if (typeof input === 'number') {
        if (!Number.isFinite(input)) {
            throw new TypeError('Invalid plugin storage JSON value');
        }
        return Object.is(input, -0) ? 0 : input;
    }
    if (typeof input !== 'object') {
        throw new TypeError('Invalid plugin storage JSON value');
    }
    if (visiting.has(input)) {
        throw new TypeError('Invalid plugin storage JSON value');
    }

    const isArray = Array.isArray(input);
    const prototype = Reflect.getPrototypeOf(input);
    if (!isArray && prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('Invalid plugin storage JSON value');
    }

    visiting.add(input);
    try {
        if (isArray) {
            const ownKeys = Reflect.ownKeys(input);
            for (const key of ownKeys) {
                if (key === 'length') continue;
                if (typeof key !== 'string') {
                    throw new TypeError('Invalid plugin storage JSON value');
                }
                const index = Number(key);
                if (!Number.isInteger(index)
                    || index < 0
                    || index >= input.length
                    || String(index) !== key) {
                    throw new TypeError('Invalid plugin storage JSON value');
                }
            }
            const result = new Array(input.length);
            if (protectSerialization) {
                Object.defineProperty(result, 'toJSON', {
                    configurable: false,
                    enumerable: false,
                    value: undefined,
                    writable: false,
                });
            }
            for (let index = 0; index < input.length; index += 1) {
                const descriptor = Reflect.getOwnPropertyDescriptor(input, String(index));
                if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
                    throw new TypeError('Invalid plugin storage JSON value');
                }
                result[index] = snapshotPluginStorageJson(
                    descriptor.value,
                    `${path}[${index}]`,
                    visiting,
                    protectSerialization,
                );
            }
            return result;
        }

        const result = Object.create(null);
        for (const key of Reflect.ownKeys(input)) {
            if (typeof key !== 'string') {
                throw new TypeError('Invalid plugin storage JSON value');
            }
            const descriptor = Reflect.getOwnPropertyDescriptor(input, key);
            if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
                throw new TypeError('Invalid plugin storage JSON value');
            }
            Object.defineProperty(result, key, {
                configurable: true,
                enumerable: true,
                value: snapshotPluginStorageJson(
                    descriptor.value,
                    `${path}.${key}`,
                    visiting,
                    protectSerialization,
                ),
                writable: true,
            });
        }
        return result;
    } finally {
        visiting.delete(input);
    }
}

function stringifyPluginStorageJson(value) {
    const serialized = JSON.stringify(snapshotPluginStorageJson(
        value,
        '$',
        new Set(),
        true,
    ));
    if (serialized === undefined) {
        throw new TypeError('Plugin storage requires representable JSON data');
    }
    return serialized;
}

function encodeValidatedPluginStorageKey(rawKey, prefix) {
    try {
        return encodePluginSaveStorageKey(rawKey, prefix);
    } catch {
        throw new PluginStorageValidationError(prefix);
    }
}

function decodeValidatedPluginStorageKey(storageKey, prefix) {
    try {
        return decodePluginSaveStorageKey(storageKey, prefix);
    } catch {
        throw new PluginStorageValidationError(prefix);
    }
}

function snapshotPluginStorageRecord(value, _fieldName, prefix) {
    try {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            throw new TypeError('invalid record');
        }
        const prototype = Reflect.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError('invalid record prototype');
        }
        const result = Object.create(null);
        for (const rawKey of Reflect.ownKeys(value)) {
            if (typeof rawKey !== 'string') {
                throw new PluginStorageValidationError(prefix);
            }
            const storageKey = encodeValidatedPluginStorageKey(rawKey, prefix);
            let descriptor;
            try {
                descriptor = Reflect.getOwnPropertyDescriptor(value, rawKey);
            } catch {
                throw new PluginStorageValidationError(storageKey);
            }
            if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
                throw new PluginStorageValidationError(storageKey);
            }
            let snapshot;
            try {
                snapshot = snapshotPluginStorageJson(descriptor.value);
            } catch {
                throw new PluginStorageValidationError(storageKey);
            }
            Object.defineProperty(result, rawKey, {
                configurable: true,
                enumerable: true,
                value: snapshot,
                writable: true,
            });
        }
        return result;
    } catch (error) {
        if (isPluginStorageValidationError(error)) throw error;
        throw new PluginStorageValidationError(prefix);
    }
}

function parsePluginStorageJsonBuffer(value, storageKey = 'plugin storage row') {
    const buffer = Buffer.from(value);
    if (buffer.length === 0) {
        throw new SyntaxError('Invalid plugin storage JSON row');
    }
    let text;
    try {
        text = utf8Decoder.decode(buffer);
    } catch {
        throw new SyntaxError('Invalid plugin storage JSON row');
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new SyntaxError('Invalid plugin storage JSON row');
    }
    return snapshotPluginStorageJson(parsed);
}

function pluginStoragePrefixForKey(storageKey) {
    if (storageKey.startsWith(PLUGIN_SAVE_PREFIX)) return PLUGIN_SAVE_PREFIX;
    if (storageKey.startsWith(PLUGIN_SAVE_META_PREFIX)) return PLUGIN_SAVE_META_PREFIX;
    return null;
}

function validatePluginStorageRow(storageKey, value) {
    const prefix = pluginStoragePrefixForKey(storageKey);
    if (prefix === null) return null;
    decodeValidatedPluginStorageKey(storageKey, prefix);
    try {
        return parsePluginStorageJsonBuffer(value, storageKey);
    } catch {
        throw new PluginStorageValidationError(storageKey);
    }
}

function serializePluginStorageRow(storageKey, value) {
    try {
        return Buffer.from(stringifyPluginStorageJson(value), 'utf-8');
    } catch {
        throw new PluginStorageValidationError(storageKey);
    }
}

module.exports = {
    PluginStorageValidationError,
    decodeValidatedPluginStorageKey,
    encodeValidatedPluginStorageKey,
    isPluginStorageValidationError,
    parsePluginStorageJsonBuffer,
    pluginStoragePrefixForKey,
    snapshotPluginStorageJson,
    snapshotPluginStorageRecord,
    serializePluginStorageRow,
    stringifyPluginStorageJson,
    validatePluginStorageRow,
};
