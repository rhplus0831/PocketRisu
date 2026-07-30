const policy = require('../../shared/plugin-save-key-policy.json');

const BACKUP_ENTRY_NAME_MAX_BYTES = policy.backupEntryNameMaxBytes;
const PLUGIN_SAVE_PREFIX = policy.valuePrefix;
const PLUGIN_SAVE_META_PREFIX = policy.metaPrefix;
const PLUGIN_SAVE_ILL_FORMED_UTF16_TAG = policy.illFormedUtf16Tag;
const PLUGIN_STORAGE_FOLDED_MARKER = 'pluginStorageFolded';
const PLUGIN_STORAGE_GENERATION_FIELD = 'pluginStorageGeneration';
const PLUGIN_STORAGE_MANIFEST_KEY = 'plugin-storage/manifest.json';
const PLUGIN_STORAGE_MANIFEST_VERSION = 2;
const LEGACY_PLUGIN_STORAGE_MANIFEST_VERSION = 1;

function assertArchiveSafePluginSaveStorageKey(storageKey) {
    if (Buffer.byteLength(storageKey, 'utf-8') > BACKUP_ENTRY_NAME_MAX_BYTES) {
        throw new RangeError(
            `Plugin storage key is too long for backup archives (maximum entry name: ${BACKUP_ENTRY_NAME_MAX_BYTES} UTF-8 bytes).`
        );
    }
}

function decodePluginSaveStorageKey(storageKey, prefix) {
    assertArchiveSafePluginSaveStorageKey(storageKey);
    if (!storageKey.startsWith(prefix) || !storageKey.endsWith('.json')) {
        throw new Error(`Invalid external plugin storage key: ${storageKey}`);
    }
    const component = storageKey.slice(prefix.length, -'.json'.length);
    const taggedUtf16 = component.startsWith(PLUGIN_SAVE_ILL_FORMED_UTF16_TAG);
    const encoded = taggedUtf16
        ? component.slice(PLUGIN_SAVE_ILL_FORMED_UTF16_TAG.length)
        : component;
    if (!/^[A-Za-z0-9_-]*$/.test(encoded)) {
        throw new Error(`Invalid encoded plugin storage key: ${storageKey}`);
    }
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) {
        throw new Error(`Non-canonical plugin storage key: ${storageKey}`);
    }
    if (taggedUtf16) {
        if (bytes.length === 0 || bytes.length % 2 !== 0) {
            throw new Error(`Invalid UTF-16 plugin storage key: ${storageKey}`);
        }
        let decoded = '';
        for (let index = 0; index < bytes.length; index += 2) {
            decoded += String.fromCharCode(bytes.readUInt16BE(index));
        }
        if (decoded.isWellFormed()) {
            throw new Error(`Non-canonical plugin storage key: ${storageKey}`);
        }
        return decoded;
    }
    const decoded = bytes.toString('utf-8');
    if (!decoded.isWellFormed()
        || Buffer.from(decoded, 'utf-8').toString('base64url') !== encoded) {
        throw new Error(`Non-canonical plugin storage key: ${storageKey}`);
    }
    return decoded;
}

function encodePluginSaveStorageKey(rawKey, prefix) {
    if (typeof rawKey !== 'string') {
        throw new TypeError('Plugin storage keys must be strings');
    }
    let encoded;
    if (rawKey.isWellFormed()) {
        encoded = Buffer.from(rawKey, 'utf-8').toString('base64url');
    } else {
        const bytes = Buffer.allocUnsafe(rawKey.length * 2);
        for (let index = 0; index < rawKey.length; index += 1) {
            bytes.writeUInt16BE(rawKey.charCodeAt(index), index * 2);
        }
        encoded = `${PLUGIN_SAVE_ILL_FORMED_UTF16_TAG}${bytes.toString('base64url')}`;
    }
    const storageKey = `${prefix}${encoded}.json`;
    // Keep generated names subject to the same canonical-form contract as
    // imported backup entries.
    decodePluginSaveStorageKey(storageKey, prefix);
    return storageKey;
}

function normalizeManifestKeyList(value, prefix) {
    if (!Array.isArray(value)) return null;
    const keys = [];
    const seen = new Set();
    for (const key of value) {
        if (typeof key !== 'string') return null;
        try {
            decodePluginSaveStorageKey(key, prefix);
        } catch {
            return null;
        }
        if (!seen.has(key)) {
            seen.add(key);
            keys.push(key);
        }
    }
    return keys;
}

function parsePluginStorageManifest(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || (value.version !== LEGACY_PLUGIN_STORAGE_MANIFEST_VERSION
            && value.version !== PLUGIN_STORAGE_MANIFEST_VERSION)
        || typeof value.generation !== 'string' || value.generation.length === 0) {
        return null;
    }
    const valueKeys = normalizeManifestKeyList(value.valueKeys, PLUGIN_SAVE_PREFIX);
    const metaKeys = normalizeManifestKeyList(value.metaKeys, PLUGIN_SAVE_META_PREFIX);
    if (!valueKeys || !metaKeys) return null;
    return {
        version: value.version,
        generation: value.generation,
        valueKeys,
        metaKeys,
    };
}

function createPluginStorageManifest(generation, valueKeys, metaKeys) {
    if (typeof generation !== 'string' || generation.length === 0) {
        throw new TypeError('Plugin storage generation must be a non-empty string');
    }
    return {
        version: PLUGIN_STORAGE_MANIFEST_VERSION,
        generation,
        valueKeys: [...new Set(valueKeys)],
        metaKeys: [...new Set(metaKeys)],
    };
}

module.exports = {
    BACKUP_ENTRY_NAME_MAX_BYTES,
    PLUGIN_SAVE_PREFIX,
    PLUGIN_SAVE_META_PREFIX,
    PLUGIN_SAVE_ILL_FORMED_UTF16_TAG,
    PLUGIN_STORAGE_FOLDED_MARKER,
    assertArchiveSafePluginSaveStorageKey,
    PLUGIN_STORAGE_GENERATION_FIELD,
    PLUGIN_STORAGE_MANIFEST_KEY,
    PLUGIN_STORAGE_MANIFEST_VERSION,
    createPluginStorageManifest,
    parsePluginStorageManifest,
    decodePluginSaveStorageKey,
    encodePluginSaveStorageKey,
};
