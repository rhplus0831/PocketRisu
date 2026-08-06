const policy = require('../../../shared/plugin-save-key-policy.json');
const { createHash } = require('crypto');

const BACKUP_ENTRY_NAME_MAX_BYTES = policy.backupEntryNameMaxBytes;
const PLUGIN_SAVE_PREFIX = policy.valuePrefix;
const PLUGIN_SAVE_META_PREFIX = policy.metaPrefix;
const PLUGIN_SAVE_ILL_FORMED_UTF16_TAG = policy.illFormedUtf16Tag;
const PLUGIN_SAVE_HASHED_KEY_TAG = policy.hashedKeyTag;
const PLUGIN_SAVE_HASHED_KEY_DOMAIN = policy.hashedKeyDomain;
const PLUGIN_STORAGE_FOLDED_MARKER = 'pluginStorageFolded';
const PLUGIN_STORAGE_GENERATION_FIELD = 'pluginStorageGeneration';
const PLUGIN_STORAGE_MANIFEST_KEY = 'plugin-storage/manifest.json';
const PLUGIN_STORAGE_MANIFEST_VERSION = 3;
const LEGACY_PLUGIN_STORAGE_MANIFEST_VERSION = 1;

function assertArchiveSafePluginSaveStorageKey(storageKey) {
    if (Buffer.byteLength(storageKey, 'utf-8') > BACKUP_ENTRY_NAME_MAX_BYTES) {
        throw new RangeError(
            `Plugin storage key is too long for backup archives (maximum entry name: ${BACKUP_ENTRY_NAME_MAX_BYTES} UTF-8 bytes).`
        );
    }
}

const HASHED_COMPONENT_PATTERN = new RegExp(
    `^${PLUGIN_SAVE_HASHED_KEY_TAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[0-9a-f]{64}\\.json$`
);

function hashedPluginStorageComponent(rawKey) {
    const domain = Buffer.from(`${PLUGIN_SAVE_HASHED_KEY_DOMAIN}\0utf16be\0`, 'utf-8');
    const keyBytes = Buffer.allocUnsafe(rawKey.length * 2);
    for (let index = 0; index < rawKey.length; index += 1) {
        keyBytes.writeUInt16BE(rawKey.charCodeAt(index), index * 2);
    }
    const digest = createHash('sha256').update(domain).update(keyBytes).digest('hex');
    return `${PLUGIN_SAVE_HASHED_KEY_TAG}${digest}.json`;
}

function isHashedPluginSaveStorageKey(storageKey, prefix) {
    return storageKey.startsWith(prefix)
        && HASHED_COMPONENT_PATTERN.test(storageKey.slice(prefix.length));
}

function pluginSaveStorageKeyMappingComponent(storageKey, prefix) {
    return isHashedPluginSaveStorageKey(storageKey, prefix)
        ? storageKey.slice(prefix.length)
        : null;
}

function decodePluginSaveStorageKey(storageKey, prefix, mappedRawKey) {
    assertArchiveSafePluginSaveStorageKey(storageKey);
    if (!storageKey.startsWith(prefix) || !storageKey.endsWith('.json')) {
        throw new Error(`Invalid external plugin storage key: ${storageKey}`);
    }
    if (isHashedPluginSaveStorageKey(storageKey, prefix)) {
        if (typeof mappedRawKey !== 'string'
            || `${prefix}${hashedPluginStorageComponent(mappedRawKey)}` !== storageKey) {
            throw new Error(`Invalid or unmapped hashed plugin storage key: ${storageKey}`);
        }
        return mappedRawKey;
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
    const legacyStorageKey = `${prefix}${encoded}.json`;
    const storageKey = Buffer.byteLength(legacyStorageKey, 'utf-8') <= BACKUP_ENTRY_NAME_MAX_BYTES
        ? legacyStorageKey
        : `${prefix}${hashedPluginStorageComponent(rawKey)}`;
    // Keep generated names subject to the same canonical-form contract as
    // imported backup entries.
    decodePluginSaveStorageKey(
        storageKey,
        prefix,
        isHashedPluginSaveStorageKey(storageKey, prefix) ? rawKey : undefined,
    );
    return storageKey;
}

function normalizeManifestKeyMappings(value) {
    if (!Array.isArray(value)) return null;
    const mappings = [];
    const byComponent = new Map();
    for (const entry of value) {
        if (!Array.isArray(entry) || entry.length !== 2
            || typeof entry[0] !== 'string' || typeof entry[1] !== 'string'
            || !HASHED_COMPONENT_PATTERN.test(entry[0])) return null;
        const [component, rawKey] = entry;
        if (pluginSaveStorageKeyMappingComponent(
            encodePluginSaveStorageKey(rawKey, PLUGIN_SAVE_PREFIX),
            PLUGIN_SAVE_PREFIX,
        ) !== component) return null;
        if (byComponent.has(component)) return null;
        byComponent.set(component, rawKey);
        mappings.push([component, rawKey]);
    }
    return { mappings, byComponent };
}

function normalizeManifestKeyList(value, prefix, mappingByComponent = new Map()) {
    if (!Array.isArray(value)) return null;
    const keys = [];
    const seen = new Set();
    for (const key of value) {
        if (typeof key !== 'string') return null;
        try {
            const component = pluginSaveStorageKeyMappingComponent(key, prefix);
            decodePluginSaveStorageKey(
                key,
                prefix,
                component === null ? undefined : mappingByComponent.get(component),
            );
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
            && value.version !== 2
            && value.version !== PLUGIN_STORAGE_MANIFEST_VERSION)
        || typeof value.generation !== 'string' || value.generation.length === 0) {
        return null;
    }
    const normalizedMappings = value.version === PLUGIN_STORAGE_MANIFEST_VERSION
        ? normalizeManifestKeyMappings(value.keyMappings)
        : { mappings: [], byComponent: new Map() };
    if (!normalizedMappings) return null;
    const valueKeys = normalizeManifestKeyList(
        value.valueKeys,
        PLUGIN_SAVE_PREFIX,
        normalizedMappings.byComponent,
    );
    const metaKeys = normalizeManifestKeyList(
        value.metaKeys,
        PLUGIN_SAVE_META_PREFIX,
        normalizedMappings.byComponent,
    );
    if (!valueKeys || !metaKeys) return null;
    const declaredHashedComponents = new Set();
    for (const [keys, prefix] of [
        [valueKeys, PLUGIN_SAVE_PREFIX],
        [metaKeys, PLUGIN_SAVE_META_PREFIX],
    ]) {
        for (const key of keys) {
            const component = pluginSaveStorageKeyMappingComponent(key, prefix);
            if (component !== null) declaredHashedComponents.add(component);
        }
    }
    if (declaredHashedComponents.size !== normalizedMappings.mappings.length
        || normalizedMappings.mappings.some(([component]) => (
            !declaredHashedComponents.has(component)
        ))) return null;
    return {
        version: value.version,
        generation: value.generation,
        valueKeys,
        metaKeys,
        ...(value.version === PLUGIN_STORAGE_MANIFEST_VERSION
            ? { keyMappings: normalizedMappings.mappings }
            : {}),
    };
}

function createPluginStorageManifest(generation, valueKeys, metaKeys, keyMappings = []) {
    if (typeof generation !== 'string' || generation.length === 0) {
        throw new TypeError('Plugin storage generation must be a non-empty string');
    }
    const mappings = [...keyMappings].map(([component, rawKey]) => [component, rawKey]);
    const candidate = {
        version: mappings.length > 0 ? PLUGIN_STORAGE_MANIFEST_VERSION : 2,
        generation,
        valueKeys: [...new Set(valueKeys)],
        metaKeys: [...new Set(metaKeys)],
        ...(mappings.length > 0 ? { keyMappings: mappings } : {}),
    };
    const manifest = parsePluginStorageManifest(candidate);
    if (!manifest) throw new TypeError('Plugin storage manifest key mappings are invalid');
    return manifest;
}

function pluginStorageManifestMappingMap(manifest) {
    return new Map(manifest?.version === PLUGIN_STORAGE_MANIFEST_VERSION
        ? manifest.keyMappings
        : []);
}

function decodeManifestPluginSaveStorageKey(manifest, storageKey, prefix) {
    const component = pluginSaveStorageKeyMappingComponent(storageKey, prefix);
    const mappedRawKey = component === null
        ? undefined
        : pluginStorageManifestMappingMap(manifest).get(component);
    return decodePluginSaveStorageKey(storageKey, prefix, mappedRawKey);
}

function mergePluginStorageKeyMappings(manifest, rawKeys, valueKeys, metaKeys) {
    const mappings = pluginStorageManifestMappingMap(manifest);
    for (const rawKey of rawKeys) {
        const storageKey = encodePluginSaveStorageKey(rawKey, PLUGIN_SAVE_PREFIX);
        const component = pluginSaveStorageKeyMappingComponent(storageKey, PLUGIN_SAVE_PREFIX);
        if (component === null) continue;
        const existing = mappings.get(component);
        if (existing !== undefined && existing !== rawKey) {
            throw new TypeError('Plugin storage key hash collision');
        }
        mappings.set(component, rawKey);
    }
    if (valueKeys === undefined || metaKeys === undefined) return [...mappings];
    const declared = new Set();
    for (const [keys, prefix] of [
        [valueKeys, PLUGIN_SAVE_PREFIX],
        [metaKeys, PLUGIN_SAVE_META_PREFIX],
    ]) {
        for (const key of keys) {
            const component = pluginSaveStorageKeyMappingComponent(key, prefix);
            if (component !== null) declared.add(component);
        }
    }
    return [...mappings].filter(([component]) => declared.has(component));
}

module.exports = {
    BACKUP_ENTRY_NAME_MAX_BYTES,
    PLUGIN_SAVE_PREFIX,
    PLUGIN_SAVE_META_PREFIX,
    PLUGIN_SAVE_ILL_FORMED_UTF16_TAG,
    PLUGIN_SAVE_HASHED_KEY_TAG,
    PLUGIN_SAVE_HASHED_KEY_DOMAIN,
    PLUGIN_STORAGE_FOLDED_MARKER,
    assertArchiveSafePluginSaveStorageKey,
    PLUGIN_STORAGE_GENERATION_FIELD,
    PLUGIN_STORAGE_MANIFEST_KEY,
    PLUGIN_STORAGE_MANIFEST_VERSION,
    createPluginStorageManifest,
    decodeManifestPluginSaveStorageKey,
    parsePluginStorageManifest,
    mergePluginStorageKeyMappings,
    pluginStorageManifestMappingMap,
    decodePluginSaveStorageKey,
    encodePluginSaveStorageKey,
    isHashedPluginSaveStorageKey,
    pluginSaveStorageKeyMappingComponent,
};
