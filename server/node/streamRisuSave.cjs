'use strict';

const fs = require('fs/promises');
const { Packr } = require('msgpackr');
const {
    magicHeader,
    magicPluginStorageHeader,
    pluginStorageLegacyEscapeField,
    pluginStorageLegacyEscapeMarker,
} = require('./utils.cjs');
const { mergeChatStubWithFullChat } = require('./chatRows.cjs');
const { PLUGIN_STORAGE_FOLDED_MARKER } = require('./pluginSaveKeys.cjs');
const {
    streamJsonFileToMessagePack,
    validateJsonSource,
} = require('./streamJsonToMsgpack.cjs');

const packr = new Packr({ useRecords: false });
const PAGE_BYTES = 64 * 1024;

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

function stringHeader(length) {
    if (!Number.isInteger(length) || length < 0 || length > 0xffffffff) {
        throw new RangeError(`Invalid msgpack string length: ${length}`);
    }
    if (length <= 31) return Buffer.from([0xa0 | length]);
    if (length <= 0xff) return Buffer.from([0xd9, length]);
    if (length <= 0xffff) {
        const header = Buffer.allocUnsafe(3);
        header[0] = 0xda;
        header.writeUInt16BE(length, 1);
        return header;
    }
    const header = Buffer.allocUnsafe(5);
    header[0] = 0xdb;
    header.writeUInt32BE(length, 1);
    return header;
}

function encodeStandalone(value) {
    // Packr reuses its internal target. Copy each result so a later encode
    // cannot overwrite bytes that fs.WriteStream has not flushed yet.
    return Buffer.from(packr.encode(value));
}

class PagedFileWriter {
    constructor(handle, shouldAbort) {
        this.handle = handle;
        this.shouldAbort = shouldAbort;
        this.position = 0;
    }

    throwIfAborted() {
        if (this.shouldAbort()) throw abortError();
    }

    async write(input) {
        const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
        for (let offset = 0; offset < bytes.length; offset += PAGE_BYTES) {
            this.throwIfAborted();
            const page = bytes.subarray(offset, Math.min(bytes.length, offset + PAGE_BYTES));
            let written = 0;
            while (written < page.length) {
                const result = await this.handle.write(
                    page,
                    written,
                    page.length - written,
                    this.position + written,
                );
                if (result.bytesWritten <= 0) {
                    throw new Error('Risu save spool write made no progress');
                }
                written += result.bytesWritten;
            }
            this.position += page.length;
            await new Promise(resolve => setImmediate(resolve));
        }
    }

    async patch(position, input) {
        this.throwIfAborted();
        const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
        if (bytes.length > PAGE_BYTES || position < 0 || position + bytes.length > this.position) {
            throw new RangeError('Invalid Risu save spool patch');
        }
        let written = 0;
        while (written < bytes.length) {
            const result = await this.handle.write(
                bytes,
                written,
                bytes.length - written,
                position + written,
            );
            if (result.bytesWritten <= 0) {
                throw new Error('Risu save spool patch made no progress');
            }
            written += result.bytesWritten;
        }
    }

    async copySource(source) {
        const sourceHandle = await fs.open(source.filePath, 'r');
        try {
            const stat = await sourceHandle.stat();
            const offset = source.offset ?? 0;
            if (!stat.isFile()
                || !Number.isSafeInteger(offset) || offset < 0
                || !Number.isSafeInteger(source.size) || source.size < 0
                || offset + source.size > stat.size) {
                throw new Error('Plugin storage row changed while streaming');
            }
            let copied = 0;
            while (copied < source.size) {
                this.throwIfAborted();
                const page = Buffer.allocUnsafe(Math.min(PAGE_BYTES, source.size - copied));
                let read = 0;
                while (read < page.length) {
                    const result = await sourceHandle.read(
                        page,
                        read,
                        page.length - read,
                        offset + copied + read,
                    );
                    if (result.bytesRead <= 0) {
                        throw new Error('Plugin storage row ended while streaming');
                    }
                    read += result.bytesRead;
                }
                await this.write(page);
                copied += page.length;
            }
        } finally {
            await sourceHandle.close();
        }
    }
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

function buildPluginMapPlan(baseValue, rows, readRow, rowSource) {
    const base = baseValue == null ? {} : baseValue;
    if (!base || typeof base !== 'object' || Array.isArray(base)) {
        // This mirrors the old property-assignment behavior for malformed
        // primitive values: row assignments do not turn them into a map.
        return null;
    }

    const rowByKey = new Map();
    const keySkeleton = Object.create(null);
    for (const key of Object.keys(base)) keySkeleton[key] = true;
    for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
            throw new TypeError('Invalid plugin storage row descriptor');
        }
        const keyDescriptor = Reflect.getOwnPropertyDescriptor(row, 'key');
        const sourceDescriptor = Reflect.getOwnPropertyDescriptor(row, 'source');
        if (!keyDescriptor || !sourceDescriptor
            || !Object.prototype.hasOwnProperty.call(keyDescriptor, 'value')
            || !Object.prototype.hasOwnProperty.call(sourceDescriptor, 'value')
            || typeof keyDescriptor.value !== 'string'
            || !keyDescriptor.value.isWellFormed()) {
            throw new TypeError('Invalid plugin storage row descriptor');
        }
        const key = keyDescriptor.value;
        rowByKey.set(key, sourceDescriptor.value);
        keySkeleton[key] = true;
    }

    // Match the property order of the legacy object-assembly path, including
    // JavaScript's numeric-index ordering. Repeated rows overwrite their
    // source while retaining the first insertion position.
    const keys = Object.keys(keySkeleton);

    return { base, keys, rowByKey, readRow, rowSource };
}

/**
 * Write a legacy, uncompressed Risu save without assembling its row-backed
 * collections into one JavaScript object tree.
 *
 * pluginStorage rows contain only key/source identifiers. A rowSource streams
 * canonical JSON directly into MessagePack with bounded pages. The legacy
 * readRow callback remains supported for callers whose rows are already small.
 */
async function streamRisuSaveToFile({
    dbObj,
    filePath,
    readChatRow,
    pluginStorage = null,
    foldChatRows = true,
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
    const pluginRowSource = pluginStorage?.rowSource;
    if ((valueRows.length > 0 || metaRows.length > 0)
        && typeof readPluginRow !== 'function'
        && typeof pluginRowSource !== 'function') {
        throw new TypeError('pluginStorage requires readRow or rowSource when rows are present');
    }

    const shouldMarkPluginStorageFolded = markPluginStorageFolded
        && pluginStorage !== null;
    const valuePlan = valueRows.length > 0
        || Object.prototype.hasOwnProperty.call(dbObj.pluginCustomStorage ?? {}, '__proto__')
        ? buildPluginMapPlan(dbObj.pluginCustomStorage, valueRows, readPluginRow, pluginRowSource)
        : null;
    const metaPlan = metaRows.length > 0
        || Object.prototype.hasOwnProperty.call(dbObj.pluginStorageMeta ?? {}, '__proto__')
        ? buildPluginMapPlan(dbObj.pluginStorageMeta, metaRows, readPluginRow, pluginRowSource)
        : null;

    function extractProtoEscapePlan(plan, field) {
        if (!plan) return null;
        const index = plan.keys.indexOf('__proto__');
        if (index === -1) return null;
        plan.keys.splice(index, 1);
        if (plan.rowByKey.has('__proto__')) {
            // Retain only the already-validated opaque row descriptor. The
            // parsed value must not be read until its envelope entry is the
            // next thing written to the spool.
            return {
                field,
                index,
                readRow: plan.readRow,
                rowSource: plan.rowSource,
                source: plan.rowByKey.get('__proto__'),
            };
        }
        return { field, index, inlineValue: plan.base.__proto__ };
    }

    const pluginStorageEscapePlans = [];
    const valueEscape = extractProtoEscapePlan(valuePlan, 'pluginCustomStorage');
    const metaEscape = extractProtoEscapePlan(metaPlan, 'pluginStorageMeta');
    if (valueEscape) pluginStorageEscapePlans.push(valueEscape);
    if (metaEscape) pluginStorageEscapePlans.push(metaEscape);
    const hasPluginStorageEscapes = pluginStorageEscapePlans.length > 0;

    const topKeys = Object.keys(dbObj).filter(key =>
        key !== PLUGIN_STORAGE_FOLDED_MARKER
        && (!hasPluginStorageEscapes || key !== pluginStorageLegacyEscapeField)
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
    if (hasPluginStorageEscapes) {
        topKeys.push(pluginStorageLegacyEscapeField);
    }

    let outputHandle = null;
    let output = null;

    async function writeValue(value) {
        await output.write(encodeStandalone(value));
    }

    function pluginRowFileSource(plan, source) {
        if (typeof plan.rowSource !== 'function') return null;
        const row = plan.rowSource(source);
        if (!row || typeof row !== 'object' || Array.isArray(row)
            || typeof row.filePath !== 'string'
            || !Number.isSafeInteger(row.size) || row.size < 0) {
            throw new TypeError('pluginStorage.rowSource returned an invalid file source');
        }
        return row;
    }

    async function writePluginRow(plan, source) {
        const fileSource = pluginRowFileSource(plan, source);
        if (fileSource) {
            await streamJsonFileToMessagePack(fileSource, output, { shouldAbort });
            return;
        }
        const rowValue = await plan.readRow(source);
        await writeValue(rowValue);
    }

    async function writePluginMap(plan) {
        await output.write(mapHeader(plan.keys.length));
        for (const key of plan.keys) {
            await writeValue(key);
            if (plan.rowByKey.has(key)) {
                await writePluginRow(plan, plan.rowByKey.get(key));
            } else {
                await writeValue(plan.base[key]);
            }
        }
    }

    async function writeSerializedLegacyEscapeValue(value) {
        const json = JSON.stringify(value);
        if (json === undefined) {
            await output.write(arrayHeader(1));
            await writeValue(0);
            return;
        }
        await output.write(arrayHeader(2));
        await writeValue(1);
        await writeValue(json);
    }

    async function writeSerializedLegacyEscapeSource(plan) {
        const fileSource = pluginRowFileSource(plan, plan.source);
        if (!fileSource) {
            await writeSerializedLegacyEscapeValue(await plan.readRow(plan.source));
            return;
        }
        // The escape envelope stores JSON text for a later JSON.parse(). The
        // staged bytes are already that exact text, so stream them as one
        // MessagePack string without materializing the parsed value.
        await validateJsonSource(fileSource, { shouldAbort });
        await output.write(arrayHeader(2));
        await writeValue(1);
        await output.write(stringHeader(fileSource.size));
        await output.copySource(fileSource);
    }

    async function writePluginStorageEscape(plan) {
        await output.write(arrayHeader(3));
        await writeValue(plan.field);
        await writeValue(plan.index);
        if (Object.prototype.hasOwnProperty.call(plan, 'source')) {
            await writeSerializedLegacyEscapeSource(plan);
        } else {
            await writeSerializedLegacyEscapeValue(plan.inlineValue);
        }
    }

    async function writePluginStorageEscapeEnvelope() {
        // Encode the fixed legacy sidecar shape directly instead of building
        // an aggregate object containing both parsed and JSON-stringified
        // __proto__ rows.
        await output.write(arrayHeader(4));
        await writeValue(pluginStorageLegacyEscapeMarker);
        await writeValue(1);
        if (Object.prototype.hasOwnProperty.call(dbObj, pluginStorageLegacyEscapeField)) {
            await writeSerializedLegacyEscapeValue(dbObj[pluginStorageLegacyEscapeField]);
        } else {
            await writeValue(null);
        }
        await output.write(arrayHeader(pluginStorageEscapePlans.length));
        for (const plan of pluginStorageEscapePlans) {
            await writePluginStorageEscape(plan);
        }
    }

    async function writeChats(char) {
        await output.write(arrayHeader(char.chats.length));
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
        await output.write(mapHeader(charKeys.length));
        for (const key of charKeys) {
            await writeValue(key);
            if (key === 'chats') await writeChats(char);
            else await writeValue(char[key]);
        }
    }

    try {
        outputHandle = await fs.open(filePath, 'wx', 0o600);
        output = new PagedFileWriter(outputHandle, shouldAbort);
        await output.write(Buffer.from(
            hasPluginStorageEscapes ? magicPluginStorageHeader : magicHeader
        ));
        await output.write(mapHeader(topKeys.length));
        for (const key of topKeys) {
            await writeValue(key);
            if (key === 'characters' && foldChatRows && Array.isArray(characters)) {
                await output.write(arrayHeader(characters.length));
                for (const char of characters) await writeCharacter(char);
            } else if (key === 'pluginCustomStorage' && valuePlan) {
                await writePluginMap(valuePlan);
            } else if (key === 'pluginStorageMeta' && metaPlan) {
                await writePluginMap(metaPlan);
            } else if (key === PLUGIN_STORAGE_FOLDED_MARKER) {
                await writeValue(true);
            } else if (key === pluginStorageLegacyEscapeField
                && hasPluginStorageEscapes) {
                await writePluginStorageEscapeEnvelope();
            } else {
                await writeValue(dbObj[key]);
            }
        }
        await outputHandle.sync();
        await outputHandle.close();
        outputHandle = null;
        return { filePath, size: output.position };
    } catch (error) {
        if (outputHandle) await outputHandle.close().catch(() => {});
        await fs.unlink(filePath).catch(() => {});
        throw error;
    }
}

module.exports = {
    streamRisuSaveToFile,
    mapHeader,
    arrayHeader,
};
