'use strict';

const LIST_DELTA_MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000;

function canUseListDelta({ lastSync, clientEpoch, serverEpoch, now }) {
    return Number.isSafeInteger(lastSync)
        && lastSync > 0
        && lastSync <= now
        && now - lastSync <= LIST_DELTA_MAX_AGE_MS
        && typeof clientEpoch === 'string'
        && clientEpoch === serverEpoch;
}

function uniqueKeys(...lists) {
    return [...new Set(lists.flat())];
}

async function modifiedInlayKeys(entries, lastSync, statFile) {
    const keys = [];
    for (const entry of entries) {
        try {
            const stat = await statFile(entry.filePath);
            if (stat.mtimeMs >= lastSync) keys.push(`inlay/${entry.id}`);
        } catch {
            // A concurrent remove or transient stat error is reflected by the
            // deletion journal or a later sync; do not fail the whole listing.
        }
    }
    return keys;
}

async function buildListResponse(options) {
    const {
        keyPrefix,
        lastSync,
        clientEpoch,
        serverEpoch,
        now,
        listKv,
        listModifiedKv,
        listDeletedKv,
        listAssetEntries,
        listInlayEntries,
        statFile,
    } = options;

    if (!canUseListDelta({ lastSync, clientEpoch, serverEpoch, now })) {
        let content;
        if (keyPrefix === 'inlay/') {
            const fileKeys = (await listInlayEntries()).map((entry) => `inlay/${entry.id}`);
            content = uniqueKeys(fileKeys, listKv('inlay/'));
        } else {
            const fileKeys = listAssetEntries()
                .map((entry) => entry.key)
                .filter((key) => key.startsWith(keyPrefix));
            content = uniqueKeys(fileKeys, listKv(keyPrefix || undefined));
        }
        return { mode: 'full', content, timestamp: now, epoch: serverEpoch };
    }

    let added;
    if (keyPrefix === 'inlay/') {
        const fileKeys = await modifiedInlayKeys(await listInlayEntries(), lastSync, statFile);
        added = uniqueKeys(fileKeys, listModifiedKv(lastSync, 'inlay/'));
    } else {
        const fileKeys = listAssetEntries()
            .filter((entry) => (
                entry.source === 'fs'
                && entry.mtimeMs >= lastSync
                && entry.key.startsWith(keyPrefix)
            ))
            .map((entry) => entry.key);
        added = uniqueKeys(fileKeys, listModifiedKv(lastSync, keyPrefix || undefined));
    }

    const deleted = listDeletedKv(lastSync, keyPrefix || undefined);
    return { mode: 'delta', added, deleted, timestamp: now, epoch: serverEpoch };
}

module.exports = {
    LIST_DELTA_MAX_AGE_MS,
    canUseListDelta,
    buildListResponse,
};
