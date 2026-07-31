const { TextDecoder } = require('util');
const {
    PLUGIN_SAVE_PREFIX,
    PLUGIN_SAVE_META_PREFIX,
    decodePluginSaveStorageKey,
    encodePluginSaveStorageKey,
    isHashedPluginSaveStorageKey,
} = require('./pluginSaveKeys.cjs');

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const PLUGIN_STORAGE_OWNER_CAPTURE_MAX_BYTES = 64 * 1024;

class PluginStorageValidationError extends Error {
    constructor(encodedKey) {
        super('Invalid plugin storage JSON row');
        this.name = 'PluginStorageValidationError';
        this.code = 'INVALID_PLUGIN_STORAGE_ROW';
        this.encodedKey = encodedKey;
    }
}

function decodedCapturedJsonString(bytes) {
    if (!Array.isArray(bytes)) return null;
    try {
        return JSON.parse(Buffer.concat([
            Buffer.from('"', 'utf-8'),
            Buffer.from(bytes),
            Buffer.from('"', 'utf-8'),
        ]).toString('utf-8'));
    } catch {
        return null;
    }
}

function normalizedPluginStorageOwner(value) {
    return typeof value === 'string'
        && value.length > 0
        && value.isWellFormed()
        ? value
        : null;
}

/**
 * Extract the last top-level `plugin` string from an already-validated JSON
 * row without retaining the row body. Plugin ownership is a best-effort
 * derived index, so an implausibly large owner name is deliberately omitted
 * while the authoritative metadata bytes remain untouched.
 */
function createPluginStorageOwnerScanner({
    maxCaptureBytes = PLUGIN_STORAGE_OWNER_CAPTURE_MAX_BYTES,
} = {}) {
    let started = false;
    let rootObject = false;
    let rootComplete = false;
    let depth = 0;
    let inString = false;
    let escape = false;
    let stringRole = null;
    let captured = null;
    let captureOverflow = false;
    let expectingKey = false;
    let pendingKey = null;
    let awaitingValue = false;
    let owner = null;

    const beginString = (role) => {
        inString = true;
        escape = false;
        stringRole = role;
        captured = role === 'key' || role === 'owner' ? [] : null;
        captureOverflow = false;
    };
    const appendCaptured = (byte) => {
        if (captured === null || captureOverflow) return;
        if (captured.length >= maxCaptureBytes) {
            captured = null;
            captureOverflow = true;
            return;
        }
        captured.push(byte);
    };
    const finishString = () => {
        const decoded = captureOverflow ? null : decodedCapturedJsonString(captured);
        if (stringRole === 'key') {
            pendingKey = decoded;
            expectingKey = false;
        } else if (stringRole === 'owner') {
            owner = normalizedPluginStorageOwner(decoded);
            awaitingValue = false;
        } else if (rootObject && depth === 1 && awaitingValue) {
            awaitingValue = false;
        }
        inString = false;
        escape = false;
        stringRole = null;
        captured = null;
        captureOverflow = false;
    };
    const consumeNonStringValue = () => {
        if (!rootObject || depth !== 1 || !awaitingValue) return;
        if (pendingKey === 'plugin') owner = null;
        awaitingValue = false;
    };

    return {
        push(buffer) {
            for (const byte of buffer) {
                if (rootComplete) continue;
                if (inString) {
                    if (escape) {
                        appendCaptured(byte);
                        escape = false;
                        continue;
                    }
                    if (byte === 0x5c) {
                        appendCaptured(byte);
                        escape = true;
                        continue;
                    }
                    if (byte === 0x22) {
                        finishString();
                        continue;
                    }
                    appendCaptured(byte);
                    continue;
                }

                if (byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a) {
                    continue;
                }
                if (!started) {
                    started = true;
                    if (byte === 0x7b) {
                        rootObject = true;
                        depth = 1;
                        expectingKey = true;
                    } else {
                        rootComplete = true;
                    }
                    continue;
                }
                if (!rootObject) continue;

                if (byte === 0x22) {
                    if (depth === 1 && expectingKey) beginString('key');
                    else if (depth === 1 && awaitingValue && pendingKey === 'plugin') {
                        beginString('owner');
                    } else beginString('other');
                    continue;
                }
                if (byte === 0x3a && depth === 1 && pendingKey !== null) {
                    awaitingValue = true;
                    continue;
                }
                if (byte === 0x7b || byte === 0x5b) {
                    consumeNonStringValue();
                    depth++;
                    continue;
                }
                if (byte === 0x7d || byte === 0x5d) {
                    if (depth === 1 && byte === 0x7d) {
                        consumeNonStringValue();
                        depth = 0;
                        rootComplete = true;
                    } else if (depth > 1) {
                        depth--;
                    }
                    continue;
                }
                if (byte === 0x2c && depth === 1) {
                    consumeNonStringValue();
                    pendingKey = null;
                    expectingKey = true;
                    continue;
                }
                consumeNonStringValue();
            }
        },
        finish() {
            if (!rootObject || !rootComplete || inString || depth !== 0) return null;
            return owner;
        },
    };
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

function decodePluginStorageJsonBuffer(value) {
    // TextDecoder accepts Uint8Array directly. Keep SQLite/Buffer-backed rows
    // as views instead of cloning a second full byte body before JSON.parse.
    const bytes = value instanceof Uint8Array ? value : Buffer.from(value);
    if (bytes.byteLength === 0) {
        throw new SyntaxError('Invalid plugin storage JSON row');
    }
    let text;
    try {
        text = utf8Decoder.decode(bytes);
    } catch {
        throw new SyntaxError('Invalid plugin storage JSON row');
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new SyntaxError('Invalid plugin storage JSON row');
    }
}

function assertPluginStorageJson(value, visiting = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new TypeError('Invalid plugin storage JSON value');
        return;
    }
    if (typeof value !== 'object' || visiting.has(value)) {
        throw new TypeError('Invalid plugin storage JSON value');
    }
    const isArray = Array.isArray(value);
    const prototype = Reflect.getPrototypeOf(value);
    if (!isArray && prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('Invalid plugin storage JSON value');
    }
    visiting.add(value);
    try {
        for (const key of Reflect.ownKeys(value)) {
            if (isArray && key === 'length') continue;
            if (typeof key !== 'string') {
                throw new TypeError('Invalid plugin storage JSON value');
            }
            if (isArray) {
                const index = Number(key);
                if (!Number.isInteger(index)
                    || index < 0
                    || index >= value.length
                    || String(index) !== key) {
                    throw new TypeError('Invalid plugin storage JSON value');
                }
            }
            const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
                throw new TypeError('Invalid plugin storage JSON value');
            }
            assertPluginStorageJson(descriptor.value, visiting);
        }
    } finally {
        visiting.delete(value);
    }
}

function assertPluginStorageJsonBuffer(value) {
    assertPluginStorageJson(decodePluginStorageJsonBuffer(value));
}

function parsePluginStorageJsonBuffer(value, storageKey = 'plugin storage row') {
    return snapshotPluginStorageJson(decodePluginStorageJsonBuffer(value));
}

function pluginStoragePrefixForKey(storageKey) {
    if (storageKey.startsWith(PLUGIN_SAVE_PREFIX)) return PLUGIN_SAVE_PREFIX;
    if (storageKey.startsWith(PLUGIN_SAVE_META_PREFIX)) return PLUGIN_SAVE_META_PREFIX;
    return null;
}

function validatePluginStorageRow(storageKey, value) {
    const prefix = pluginStoragePrefixForKey(storageKey);
    if (prefix === null) return null;
    if (!isHashedPluginSaveStorageKey(storageKey, prefix)) {
        decodeValidatedPluginStorageKey(storageKey, prefix);
    }
    try {
        return parsePluginStorageJsonBuffer(value, storageKey);
    } catch {
        throw new PluginStorageValidationError(storageKey);
    }
}

function assertPluginStorageRow(storageKey, value) {
    const prefix = pluginStoragePrefixForKey(storageKey);
    if (prefix === null) return false;
    if (!isHashedPluginSaveStorageKey(storageKey, prefix)) {
        decodeValidatedPluginStorageKey(storageKey, prefix);
    }
    try {
        assertPluginStorageJsonBuffer(value);
    } catch {
        throw new PluginStorageValidationError(storageKey);
    }
    return true;
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
    createPluginStorageOwnerScanner,
    assertPluginStorageJsonBuffer,
    assertPluginStorageRow,
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
