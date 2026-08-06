'use strict';

// Optimized plugin values are user-controlled JSON payloads. Keep the limits
// centralized on the authoritative server; the browser mirrors the default
// per-value cap only to fail before dispatching an impossible request.
const DEFAULT_PLUGIN_VALUE_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_PLUGIN_STORAGE_MAX_BYTES = 1024 * 1024 * 1024;

function positiveIntegerFromEnv(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const PLUGIN_VALUE_MAX_BYTES = positiveIntegerFromEnv(
    'POCKETRISU_PLUGIN_VALUE_MAX_BYTES',
    DEFAULT_PLUGIN_VALUE_MAX_BYTES,
);
const PLUGIN_STORAGE_MAX_BYTES = positiveIntegerFromEnv(
    'POCKETRISU_PLUGIN_STORAGE_MAX_BYTES',
    DEFAULT_PLUGIN_STORAGE_MAX_BYTES,
);

class PluginStorageLimitError extends Error {
    constructor(message, { code, limit, actual }) {
        super(message);
        this.name = 'PluginStorageLimitError';
        this.code = code;
        this.limit = limit;
        this.actual = actual;
        this.status = 413;
    }
}

function isPluginValueKey(key) {
    return typeof key === 'string' && key.startsWith('pluginsave/');
}

function assertPluginValueSize(size) {
    if (!Number.isSafeInteger(size) || size < 0) {
        throw new PluginStorageLimitError('Plugin value size is invalid.', {
            code: 'PLUGIN_VALUE_SIZE_INVALID',
            limit: PLUGIN_VALUE_MAX_BYTES,
            actual: size,
        });
    }
    if (size > PLUGIN_VALUE_MAX_BYTES) {
        throw new PluginStorageLimitError(
            `Plugin value is ${size} bytes; the per-value limit is ${PLUGIN_VALUE_MAX_BYTES} bytes. Split the value into smaller records.`,
            {
                code: 'PLUGIN_VALUE_TOO_LARGE',
                limit: PLUGIN_VALUE_MAX_BYTES,
                actual: size,
            },
        );
    }
}

function assertPluginStorageTotal(size) {
    if (!Number.isSafeInteger(size) || size < 0 || size > PLUGIN_STORAGE_MAX_BYTES) {
        throw new PluginStorageLimitError(
            `Optimized plugin storage would use ${size} bytes; the aggregate limit is ${PLUGIN_STORAGE_MAX_BYTES} bytes. Remove old records or split data across another storage backend.`,
            {
                code: 'PLUGIN_STORAGE_TOTAL_TOO_LARGE',
                limit: PLUGIN_STORAGE_MAX_BYTES,
                actual: size,
            },
        );
    }
}

module.exports = {
    DEFAULT_PLUGIN_VALUE_MAX_BYTES,
    DEFAULT_PLUGIN_STORAGE_MAX_BYTES,
    PLUGIN_VALUE_MAX_BYTES,
    PLUGIN_STORAGE_MAX_BYTES,
    PluginStorageLimitError,
    isPluginValueKey,
    assertPluginValueSize,
    assertPluginStorageTotal,
};
