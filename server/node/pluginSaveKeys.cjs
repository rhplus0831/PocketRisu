const policy = require('../../shared/plugin-save-key-policy.json');

const BACKUP_ENTRY_NAME_MAX_BYTES = policy.backupEntryNameMaxBytes;
const PLUGIN_SAVE_PREFIX = policy.valuePrefix;
const PLUGIN_SAVE_META_PREFIX = policy.metaPrefix;
const PLUGIN_STORAGE_FOLDED_MARKER = 'pluginStorageFolded';

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
    const encoded = storageKey.slice(prefix.length, -'.json'.length);
    if (!/^[A-Za-z0-9_-]*$/.test(encoded)) {
        throw new Error(`Invalid encoded plugin storage key: ${storageKey}`);
    }
    const decoded = Buffer.from(encoded, 'base64url').toString('utf-8');
    if (Buffer.from(decoded, 'utf-8').toString('base64url') !== encoded) {
        throw new Error(`Non-canonical plugin storage key: ${storageKey}`);
    }
    return decoded;
}

function encodePluginSaveStorageKey(rawKey, prefix) {
    if (!rawKey.isWellFormed()) {
        throw new Error(
            `Plugin storage keys must be well-formed Unicode (no unpaired surrogates): ${JSON.stringify(rawKey)}`
        );
    }
    const encoded = Buffer.from(rawKey, 'utf-8').toString('base64url');
    const storageKey = `${prefix}${encoded}.json`;
    // Keep generated names subject to the same canonical-form contract as
    // imported backup entries.
    decodePluginSaveStorageKey(storageKey, prefix);
    return storageKey;
}

module.exports = {
    BACKUP_ENTRY_NAME_MAX_BYTES,
    PLUGIN_SAVE_PREFIX,
    PLUGIN_SAVE_META_PREFIX,
    PLUGIN_STORAGE_FOLDED_MARKER,
    assertArchiveSafePluginSaveStorageKey,
    decodePluginSaveStorageKey,
    encodePluginSaveStorageKey,
};
