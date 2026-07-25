const PLUGIN_SAVE_PREFIX = 'pluginsave/';
const PLUGIN_SAVE_META_PREFIX = 'pluginsave-meta/';

function decodePluginSaveStorageKey(storageKey, prefix) {
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
    PLUGIN_SAVE_PREFIX,
    PLUGIN_SAVE_META_PREFIX,
    decodePluginSaveStorageKey,
    encodePluginSaveStorageKey,
};
