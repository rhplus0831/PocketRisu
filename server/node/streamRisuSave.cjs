'use strict';

const { createWriteStream } = require('fs');
const fs = require('fs/promises');
const { once } = require('events');
const { finished } = require('stream/promises');
const { Packr } = require('msgpackr');
const {
    createLegacyPluginStorageEnvelope,
    magicHeader,
    magicPluginStorageHeader,
    pluginStorageLegacyEscapeField,
} = require('./utils.cjs');
const { mergeChatStubWithFullChat } = require('./chatRows.cjs');
const { PLUGIN_STORAGE_FOLDED_MARKER } = require('./pluginSaveKeys.cjs');

const packr = new Packr({ useRecords: false });

function collectionHeader(length, fixBase, type16, type32) {
    if (!Number.isInteger(length) || length < 0 || length > 0xffffffff) {
        throw new RangeError(`Invalid msgpack collection length: ${length}`);
    }
    if (length <= 15) return Buffer.from([fixBase | length]);
    if (length <= 0xffff) {
        const header = Buffer.allocUnsafe(3);
        header[0] = type16;
        header.writeUInt16BE(length, 1);
        return header;
    }
    const header = Buffer.allocUnsafe(5);
    header[0] = type32;
    header.writeUInt32BE(length, 1);
    return header;
}

function mapHeader(length) {
    return collectionHeader(length, 0x80, 0xde, 0xdf);
}

function arrayHeader(length) {
    return collectionHeader(length, 0x90, 0xdc, 0xdd);
}

function encodeStandalone(value) {
    // Packr reuses its internal target. Copy each result so a later encode
    // cannot overwrite bytes that fs.WriteStream has not flushed yet.
    return Buffer.from(packr.encode(value));
}

function abortError() {
    const error = new Error('Backup database assembly cancelled');
    error.code = 'BACKUP_STREAM_ABORTED';
    return error;
}

function throwMissingChatRow(chaId, chatId) {
    const error = new Error(`Backup cannot read referenced chat row: ${chaId}/${chatId}`);
    error.code = 'BACKUP_MISSING_CHAT_ROW';
    throw error;
}

function buildPluginMapPlan(baseValue, rows, readRow) {
    const base = baseValue == null ? {} : baseValue;
    if (!base || typeof base !== 'object' || Array.isArray(base)) {
        // This mirrors the old property-assignment behavior for malformed
        // primitive values: row assignments do not turn them into a map.
        return null;
    }

    const rowByKey = new Map();
    for (const row of rows) rowByKey.set(row.key, row.source);

    const keys = Object.keys(base);
    const knownKeys = new Set(keys);
    for (const row of rows) {
        if (!knownKeys.has(row.key)) {
            knownKeys.add(row.key);
            keys.push(row.key);
        }
    }

    return { base, keys, rowByKey, readRow };
}

/**
 * Write a legacy, uncompressed Risu save without assembling its row-backed
 * collections into one JavaScript object tree.
 *
 * pluginStorage rows contain only key/source identifiers. readRow is called
 * immediately before that one value is encoded, so parsed plugin values are
 * not retained across rows.
 */
async function streamRisuSaveToFile({
    dbObj,
    filePath,
    readChatRow,
    pluginStorage = null,
    markPluginStorageFolded = false,
    shouldAbort = () => false,
    onMissingChatRow = throwMissingChatRow,
}) {
    if (!dbObj || typeof dbObj !== 'object' || Array.isArray(dbObj)) {
        throw new TypeError('Streaming Risu save root must be an object');
    }
    if (typeof readChatRow !== 'function') {
        throw new TypeError('readChatRow must be a function');
    }
    if (typeof onMissingChatRow !== 'function') {
        throw new TypeError('onMissingChatRow must be a function');
    }

    const valueRows = pluginStorage?.valueRows ?? [];
    const metaRows = pluginStorage?.metaRows ?? [];
    const readPluginRow = pluginStorage?.readRow;
    if ((valueRows.length > 0 || metaRows.length > 0) && typeof readPluginRow !== 'function') {
        throw new TypeError('pluginStorage.readRow must be a function when rows are present');
    }

    const shouldMarkPluginStorageFolded = markPluginStorageFolded
        && pluginStorage !== null
        && dbObj.optimizePluginMemory === true;
    const valuePlan = valueRows.length > 0
        || Object.prototype.hasOwnProperty.call(dbObj.pluginCustomStorage ?? {}, '__proto__')
        ? buildPluginMapPlan(dbObj.pluginCustomStorage, valueRows, readPluginRow)
        : null;
    const metaPlan = metaRows.length > 0
        || Object.prototype.hasOwnProperty.call(dbObj.pluginStorageMeta ?? {}, '__proto__')
        ? buildPluginMapPlan(dbObj.pluginStorageMeta, metaRows, readPluginRow)
        : null;

    async function extractProtoEscape(plan, field) {
        if (!plan) return null;
        const index = plan.keys.indexOf('__proto__');
        if (index === -1) return null;
        plan.keys.splice(index, 1);
        const value = plan.rowByKey.has('__proto__')
            ? await plan.readRow(plan.rowByKey.get('__proto__'))
            : plan.base.__proto__;
        return { field, index, value };
    }

    const pluginStorageEscapes = [];
    const valueEscape = await extractProtoEscape(valuePlan, 'pluginCustomStorage');
    const metaEscape = await extractProtoEscape(metaPlan, 'pluginStorageMeta');
    if (valueEscape) pluginStorageEscapes.push(valueEscape);
    if (metaEscape) pluginStorageEscapes.push(metaEscape);
    const pluginStorageEscapeEnvelope = createLegacyPluginStorageEnvelope(
        dbObj,
        pluginStorageEscapes,
    );

    const topKeys = Object.keys(dbObj).filter(key =>
        key !== PLUGIN_STORAGE_FOLDED_MARKER
        && (pluginStorageEscapeEnvelope === null || key !== pluginStorageLegacyEscapeField)
    );
    const characters = dbObj.characters;
    if (Array.isArray(characters) && !topKeys.includes('characters')) {
        topKeys.push('characters');
    }
    if (valueRows.length > 0 && !topKeys.includes('pluginCustomStorage')) {
        topKeys.push('pluginCustomStorage');
    }
    if (metaRows.length > 0 && !topKeys.includes('pluginStorageMeta')) {
        topKeys.push('pluginStorageMeta');
    }
    if (shouldMarkPluginStorageFolded) {
        topKeys.push(PLUGIN_STORAGE_FOLDED_MARKER);
    }
    if (pluginStorageEscapeEnvelope !== null) {
        topKeys.push(pluginStorageLegacyEscapeField);
    }

    const output = createWriteStream(filePath, { flags: 'wx' });
    const outputFinished = finished(output);
    // Mark asynchronous open/write failures handled immediately; the original
    // promise is still awaited below so the error reaches the caller.
    outputFinished.catch(() => {});
    let size = 0;

    async function write(chunk) {
        if (shouldAbort()) throw abortError();
        size += chunk.length;
        if (!output.write(chunk)) await once(output, 'drain');
    }

    async function writeValue(value) {
        await write(encodeStandalone(value));
    }

    async function writePluginMap(plan) {
        await write(mapHeader(plan.keys.length));
        for (const key of plan.keys) {
            await writeValue(key);
            if (plan.rowByKey.has(key)) {
                // Keep only this parsed row alive through its encode/write.
                const rowValue = await plan.readRow(plan.rowByKey.get(key));
                await writeValue(rowValue);
            } else {
                await writeValue(plan.base[key]);
            }
        }
    }

    async function writeChats(char) {
        await write(arrayHeader(char.chats.length));
        for (const chat of char.chats) {
            if (chat && chat._stub === true && chat.id) {
                const fullChat = await readChatRow(char.chaId, chat.id);
                if (fullChat == null) await onMissingChatRow(char.chaId, chat.id);
                await writeValue(mergeChatStubWithFullChat(chat, fullChat));
            } else {
                await writeValue(chat);
            }
        }
    }

    async function writeCharacter(char) {
        const hasRowBackedChat = Boolean(
            char
            && char.chaId
            && Array.isArray(char.chats)
            && char.chats.some(chat => chat && chat._stub === true && chat.id)
        );
        if (!hasRowBackedChat) {
            await writeValue(char);
            return;
        }

        const charKeys = Object.keys(char);
        if (!charKeys.includes('chats')) charKeys.push('chats');
        await write(mapHeader(charKeys.length));
        for (const key of charKeys) {
            await writeValue(key);
            if (key === 'chats') await writeChats(char);
            else await writeValue(char[key]);
        }
    }

    try {
        await write(Buffer.from(
            pluginStorageEscapeEnvelope === null ? magicHeader : magicPluginStorageHeader
        ));
        await write(mapHeader(topKeys.length));
        for (const key of topKeys) {
            await writeValue(key);
            if (key === 'characters' && Array.isArray(characters)) {
                await write(arrayHeader(characters.length));
                for (const char of characters) await writeCharacter(char);
            } else if (key === 'pluginCustomStorage' && valuePlan) {
                await writePluginMap(valuePlan);
            } else if (key === 'pluginStorageMeta' && metaPlan) {
                await writePluginMap(metaPlan);
            } else if (key === PLUGIN_STORAGE_FOLDED_MARKER) {
                await writeValue(true);
            } else if (key === pluginStorageLegacyEscapeField
                && pluginStorageEscapeEnvelope !== null) {
                await writeValue(pluginStorageEscapeEnvelope);
            } else {
                await writeValue(dbObj[key]);
            }
        }
        output.end();
        await outputFinished;
        return { filePath, size };
    } catch (error) {
        output.destroy();
        await outputFinished.catch(() => {});
        await fs.unlink(filePath).catch(() => {});
        throw error;
    }
}

module.exports = {
    streamRisuSaveToFile,
    mapHeader,
    arrayHeader,
};
