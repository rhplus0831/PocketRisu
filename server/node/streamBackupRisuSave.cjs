'use strict';

const fs = require('fs/promises');
const path = require('path');
const { createReadStream, createWriteStream } = require('fs');
const zlib = require('zlib');
const nodeCrypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { TextDecoder } = require('util');
const { Packr } = require('msgpackr');
const {
    magicHeader,
    magicPluginStorageHeader,
    magicRisuSaveHeader,
    RisuSaveType,
    presetTemplate,
    pluginStorageLegacyEscapeField,
    pluginStorageLegacyEscapeMarker,
} = require('./utils.cjs');
const { mapHeader, arrayHeader } = require('./streamRisuSave.cjs');
const {
    inspectRisuSaveSource,
    prepareMessagePackSource,
    readCollectionCount,
    descriptorCollectionKind,
    decodeDescriptor,
    skipMessagePackValue,
} = require('./streamRisuLoad.cjs');
const { PLUGIN_STORAGE_FOLDED_MARKER } = require('./pluginSaveKeys.cjs');
const { PluginStorageValidationError } = require('./pluginStorageJson.cjs');
const {
    readJsonObjectFields,
    readJsonRootFields,
    readJsonValue,
    streamJsonFileToMessagePack,
    streamJsonObjectField,
    streamJsonRootEntries,
    validateJsonSource,
} = require('./streamJsonToMsgpack.cjs');

const PAGE_BYTES = 64 * 1024;
const MAX_METADATA_DESCRIPTOR_BYTES = 64 * 1024;
const packr = new Packr({ useRecords: false });
const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true });
const RISU_BLOCK_MAX_COUNT = 1_000_000;
const RISU_REMOTE_MAX_COUNT = 1_000_000;
const RISU_BLOCK_MAX_DECODED_BYTES = 4 * 1024 * 1024 * 1024;
const KNOWN_RISU_SAVE_TYPES = new Set(Object.values(RisuSaveType));
const INHERITED_OBJECT_TRUTHY_KEYS = new Set(
    Object.getOwnPropertyNames(Object.prototype).filter((key) => Boolean({}[key])),
);

function encoded(value) {
    return Buffer.from(packr.encode(value));
}

function abortError(signal) {
    const reason = signal?.reason;
    const error = reason instanceof Error
        ? new Error(reason.message, { cause: reason })
        : new Error('Backup database assembly cancelled');
    error.code = 'BACKUP_STREAM_ABORTED';
    return error;
}

function throwMissingChatRow(chaId, chatId) {
    const error = new Error(`Backup cannot read referenced chat row: ${chaId}/${chatId}`);
    error.code = 'BACKUP_MISSING_CHAT_ROW';
    throw error;
}

class PagedFileWriter {
    constructor(handle, shouldAbort, signal) {
        this.handle = handle;
        this.shouldAbort = shouldAbort;
        this.signal = signal;
        this.position = 0;
        this.maxPageBytes = 0;
    }

    throwIfAborted() {
        if (!this.signal?.aborted && !this.shouldAbort()) return;
        throw abortError(this.signal);
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
                if (result.bytesWritten <= 0) throw new Error('Backup spool write made no progress');
                written += result.bytesWritten;
            }
            this.position += page.length;
            this.maxPageBytes = Math.max(this.maxPageBytes, page.length);
            await new Promise(resolve => setImmediate(resolve));
        }
    }

    async patch(position, input) {
        this.throwIfAborted();
        const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
        if (bytes.length > PAGE_BYTES || position < 0 || position + bytes.length > this.position) {
            throw new RangeError('Invalid backup spool patch');
        }
        let written = 0;
        while (written < bytes.length) {
            const result = await this.handle.write(
                bytes,
                written,
                bytes.length - written,
                position + written,
            );
            if (result.bytesWritten <= 0) throw new Error('Backup spool patch made no progress');
            written += result.bytesWritten;
        }
    }

    async copyRange(source, offset, length) {
        let copied = 0;
        while (copied < length) {
            this.throwIfAborted();
            const pageLength = Math.min(PAGE_BYTES, length - copied);
            const page = await source.readRange(offset + copied, pageLength);
            if (page.length !== pageLength) throw new Error('Truncated MessagePack descriptor');
            await this.write(page);
            copied += page.length;
        }
    }

    async copyDescriptor(source, descriptor) {
        await this.copyRange(source, descriptor.offset, descriptor.length);
    }
}

class CountingWriter {
    constructor() {
        this.position = 0;
    }

    async write(input) {
        const length = input.length ?? Buffer.byteLength(input);
        const next = this.position + length;
        if (!Number.isSafeInteger(next) || next > 0xffffffff) {
            throw new Error('Serialized plugin escape exceeds the u32 string limit');
        }
        this.position = next;
    }
}

async function decodeMetadata(source, descriptor, label) {
    if (descriptor.length > MAX_METADATA_DESCRIPTOR_BYTES) {
        throw new Error(`${label} exceeds the bounded backup metadata limit`);
    }
    return decodeDescriptor(source, descriptor);
}

async function readMapEntries(source, descriptor, label) {
    if (await descriptorCollectionKind(source, descriptor) !== 'map') return null;
    const cursor = source.cursor(descriptor.offset);
    const count = await readCollectionCount(cursor, 'map');
    const entries = [];
    const byKey = new Map();
    for (let index = 0; index < count; index++) {
        const keyDescriptor = await skipMessagePackValue(cursor);
        const decodedKey = await decodeMetadata(source, keyDescriptor, `${label} key`);
        const key = typeof decodedKey === 'string' ? decodedKey : String(decodedKey);
        const valueDescriptor = await skipMessagePackValue(cursor);
        const prior = byKey.get(key);
        if (prior === undefined) {
            byKey.set(key, entries.length);
            entries.push({ key, descriptor: valueDescriptor });
        } else {
            entries[prior].descriptor = valueDescriptor;
        }
    }
    if (cursor.position !== descriptor.offset + descriptor.length) {
        throw new Error(`Invalid ${label} MessagePack map span`);
    }
    return entries;
}

async function readArrayDescriptors(source, descriptor, label) {
    if (await descriptorCollectionKind(source, descriptor) !== 'array') return null;
    const cursor = source.cursor(descriptor.offset);
    const count = await readCollectionCount(cursor, 'array');
    const descriptors = [];
    for (let index = 0; index < count; index++) {
        descriptors.push(await skipMessagePackValue(cursor));
    }
    if (cursor.position !== descriptor.offset + descriptor.length) {
        throw new Error(`Invalid ${label} MessagePack array span`);
    }
    return descriptors;
}

function keyPlan(entries, rows, protoIndex = null) {
    const skeleton = Object.create(null);
    const valueByKey = new Map();
    const baseKeys = entries.map(entry => entry.key);
    if (protoIndex !== null) {
        baseKeys.splice(Math.min(protoIndex, baseKeys.length), 0, '__proto__');
    }
    for (const key of baseKeys) {
        Object.defineProperty(skeleton, key, {
            configurable: true,
            enumerable: true,
            value: true,
            writable: true,
        });
    }
    for (const entry of entries) valueByKey.set(entry.key, { kind: 'descriptor', ...entry });
    for (const row of rows) {
        Object.defineProperty(skeleton, row.key, {
            configurable: true,
            enumerable: true,
            value: true,
            writable: true,
        });
        valueByKey.set(row.key, { kind: 'row', row });
    }
    return { keys: Object.keys(skeleton), valueByKey };
}

async function parseExistingEscapeEnvelope(source, descriptor) {
    const values = await readArrayDescriptors(source, descriptor, 'plugin escape envelope');
    if (!values || values.length !== 4) return null;
    const marker = await decodeMetadata(source, values[0], 'plugin escape marker');
    const version = await decodeMetadata(source, values[1], 'plugin escape version');
    if (marker !== pluginStorageLegacyEscapeMarker || version !== 1) return null;
    const escapeDescriptors = await readArrayDescriptors(
        source,
        values[3],
        'plugin escape entries',
    );
    if (!escapeDescriptors) return null;
    const escapes = new Map();
    for (const entryDescriptor of escapeDescriptors) {
        const entry = await readArrayDescriptors(source, entryDescriptor, 'plugin escape entry');
        if (!entry || entry.length !== 3) return null;
        const field = await decodeMetadata(source, entry[0], 'plugin escape field');
        const index = await decodeMetadata(source, entry[1], 'plugin escape index');
        if ((field !== 'pluginCustomStorage' && field !== 'pluginStorageMeta')
            || !Number.isInteger(index) || index < 0 || escapes.has(field)) return null;
        escapes.set(field, {
            field,
            index,
            serializedDescriptor: entry[2],
        });
    }
    return {
        originalDescriptor: values[2],
        escapes,
    };
}

async function writeJsonRow(writer, row, readPluginRowSource, options) {
    const source = await readPluginRowSource(row.source);
    if (!source) throw new PluginStorageValidationError(row.source);
    try {
        if (process.env.NODE_ENV === 'test') {
            const configured = String(
                process.env.POCKETRISU_TEST_FULL_EXPORT_PLUGIN_TRANSCODE_GATE_DIR ?? '',
            ).trim();
            if (configured) {
                const gateDir = path.resolve(configured);
                const holdPath = path.join(gateDir, 'hold');
                if (await fs.stat(holdPath).then(() => true, () => false)) {
                    await fs.mkdir(gateDir, { recursive: true });
                    await fs.writeFile(path.join(gateDir, 'entered'), 'row-pinned', 'utf-8');
                    const releasePath = path.join(gateDir, 'release');
                    while (await fs.stat(holdPath).then(() => true, () => false)
                        && !await fs.stat(releasePath).then(() => true, () => false)) {
                        writer.throwIfAborted();
                        await new Promise(resolve => setTimeout(resolve, 10));
                    }
                    writer.throwIfAborted();
                }
            }
        }
        await streamJsonFileToMessagePack(source, writer, options);
    } catch (error) {
        if (error?.code === 'BACKUP_STREAM_ABORTED') throw error;
        throw new PluginStorageValidationError(row.source);
    } finally {
        await source.cleanup?.();
    }
}

async function writeJsonRowAsSerializedEscape(writer, row, readPluginRowSource, options) {
    const source = await readPluginRowSource(row.source);
    if (!source) throw new PluginStorageValidationError(row.source);
    const normalizedPath = path.join(
        options.tempDir,
        `.plugin-escape-${process.pid}-${nodeCrypto.randomUUID()}.risudat`,
    );
    let normalizedHandle = null;
    try {
        normalizedHandle = await fs.open(normalizedPath, 'wx', 0o600);
        const normalizedWriter = new PagedFileWriter(
            normalizedHandle,
            options.shouldAbort,
            options.signal,
        );
        await normalizedWriter.write(Buffer.from(magicHeader));
        await streamJsonFileToMessagePack(source, normalizedWriter, options);
        await normalizedHandle.sync();
        await normalizedHandle.close();
        normalizedHandle = null;
        await withPreparedSource({
            filePath: normalizedPath,
            size: normalizedWriter.position,
        }, options, async (normalizedSource, payloadOffset) => {
            const cursor = normalizedSource.cursor(payloadOffset);
            const descriptor = await skipMessagePackValue(cursor);
            if (cursor.position !== normalizedSource.size) {
                throw new Error('Trailing bytes after normalized plugin escape');
            }
            await writeDescriptorAsSerializedEscape(
                writer,
                normalizedSource,
                descriptor,
            );
        });
    } catch (error) {
        if (error?.code === 'BACKUP_STREAM_ABORTED') throw error;
        throw new PluginStorageValidationError(row.source);
    } finally {
        await normalizedHandle?.close().catch(() => {});
        await fs.unlink(normalizedPath).catch(() => {});
        await source.cleanup?.();
    }
}

async function messagePackStringSpan(source, descriptor) {
    const prefix = await source.readRange(descriptor.offset, Math.min(5, descriptor.length));
    const tag = prefix[0];
    let headerBytes;
    let length;
    if (tag >= 0xa0 && tag <= 0xbf) {
        headerBytes = 1;
        length = tag & 0x1f;
    } else if (tag === 0xd9 && prefix.length >= 2) {
        headerBytes = 2;
        length = prefix[1];
    } else if (tag === 0xda && prefix.length >= 3) {
        headerBytes = 3;
        length = prefix.readUInt16BE(1);
    } else if (tag === 0xdb && prefix.length >= 5) {
        headerBytes = 5;
        length = prefix.readUInt32BE(1);
    } else {
        return null;
    }
    if (headerBytes + length !== descriptor.length) {
        throw new Error('Invalid MessagePack string descriptor');
    }
    return { offset: descriptor.offset + headerBytes, length };
}

async function writeJsonStringSpan(writer, source, span) {
    await writer.write(Buffer.from('"'));
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const escapes = new Map([
        [0x08, '\\b'], [0x09, '\\t'], [0x0a, '\\n'], [0x0c, '\\f'], [0x0d, '\\r'],
        [0x22, '\\"'], [0x5c, '\\\\'],
    ]);
    let offset = 0;
    while (offset < span.length) {
        const length = Math.min(PAGE_BYTES, span.length - offset);
        const page = await source.readRange(span.offset + offset, length);
        if (page.length !== length) throw new Error('Truncated MessagePack string');
        decoder.decode(page, { stream: true });
        let runStart = 0;
        for (let index = 0; index < page.length; index++) {
            const byte = page[index];
            if (byte >= 0x20 && byte !== 0x22 && byte !== 0x5c) continue;
            if (index > runStart) await writer.write(page.subarray(runStart, index));
            const escaped = escapes.get(byte) ?? `\\u${byte.toString(16).padStart(4, '0')}`;
            await writer.write(Buffer.from(escaped, 'ascii'));
            runStart = index + 1;
        }
        if (runStart < page.length) await writer.write(page.subarray(runStart));
        offset += length;
    }
    decoder.decode();
    await writer.write(Buffer.from('"'));
}

async function writeDescriptorJson(writer, source, descriptor, depth = 0) {
    if (depth > 1024) throw new Error('Plugin escape nesting exceeds the bounded limit');
    const kind = await descriptorCollectionKind(source, descriptor);
    if (kind === 'array') {
        const values = await readArrayDescriptors(source, descriptor, 'plugin escape array');
        await writer.write(Buffer.from('['));
        for (let index = 0; index < values.length; index++) {
            if (index > 0) await writer.write(Buffer.from(','));
            const rendered = await writeDescriptorJson(writer, source, values[index], depth + 1);
            if (!rendered) await writer.write(Buffer.from('null'));
        }
        await writer.write(Buffer.from(']'));
        return true;
    }
    if (kind === 'map') {
        const entries = await readMapEntries(source, descriptor, 'plugin escape object');
        await writer.write(Buffer.from('{'));
        let count = 0;
        for (const entry of entries) {
            const probe = new CountingWriter();
            if (!await writeDescriptorJson(probe, source, entry.descriptor, depth + 1)) continue;
            if (count++ > 0) await writer.write(Buffer.from(','));
            await writer.write(Buffer.from(JSON.stringify(entry.key), 'utf-8'));
            await writer.write(Buffer.from(':'));
            await writeDescriptorJson(writer, source, entry.descriptor, depth + 1);
        }
        await writer.write(Buffer.from('}'));
        return true;
    }
    const stringSpan = await messagePackStringSpan(source, descriptor);
    if (stringSpan) {
        await writeJsonStringSpan(writer, source, stringSpan);
        return true;
    }
    const value = await decodeMetadata(source, descriptor, 'plugin escape scalar');
    const json = JSON.stringify(value);
    if (json === undefined) return false;
    await writer.write(Buffer.from(json, 'utf-8'));
    return true;
}

async function writeDescriptorAsSerializedEscape(writer, source, descriptor) {
    const counter = new CountingWriter();
    if (!await writeDescriptorJson(counter, source, descriptor)) {
        await writer.write(arrayHeader(1));
        await writer.write(encoded(0));
        return;
    }
    await writer.write(arrayHeader(2));
    await writer.write(encoded(1));
    const header = Buffer.allocUnsafe(5);
    header[0] = 0xdb;
    header.writeUInt32BE(counter.position, 1);
    await writer.write(header);
    await writeDescriptorJson(writer, source, descriptor);
}

async function withPreparedSource(input, options, callback) {
    const inspection = await inspectRisuSaveSource(input);
    if (!inspection.supported) {
        throw new Error('Large backup rows require a supported streaming Risu save format');
    }
    const prepared = await prepareMessagePackSource(
        input,
        inspection,
        options.tempDir,
        options.shouldAbort,
        { signal: options.signal },
    );
    try {
        return await callback(prepared.source, prepared.payloadOffset, inspection);
    } finally {
        await prepared.cleanup();
    }
}

async function readFileRange(handle, offset, length) {
    if (!Number.isSafeInteger(offset) || offset < 0
        || !Number.isSafeInteger(length) || length < 0 || length > PAGE_BYTES) {
        throw new RangeError('Invalid bounded RisuSave block read');
    }
    const output = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
        const result = await handle.read(output, read, length - read, offset + read);
        if (result.bytesRead <= 0) throw new Error('Truncated RisuSave block');
        read += result.bytesRead;
    }
    return output;
}

async function scanRisuSaveBlocks(input, options = {}) {
    const handle = await fs.open(input.filePath, 'r');
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== input.size) {
            throw new Error('Backup database changed while scanning blocks');
        }
        const header = await readFileRange(handle, 0, magicRisuSaveHeader.length);
        if (!header.equals(Buffer.from(magicRisuSaveHeader))) {
            throw new Error('Invalid RisuSave block header');
        }
        const blocks = [];
        let offset = magicRisuSaveHeader.length;
        while (offset < stat.size) {
            if (blocks.length >= RISU_BLOCK_MAX_COUNT || offset + 7 > stat.size) {
                throw new Error('Invalid or excessive RisuSave block inventory');
            }
            options.throwIfAborted?.();
            const prefix = await readFileRange(handle, offset, 3);
            const type = prefix[0];
            const compression = prefix[1];
            const nameLength = prefix[2];
            if (compression !== 0 && compression !== 1) {
                throw new Error('Invalid RisuSave block compression flag');
            }
            offset += 3;
            if (offset + nameLength + 4 > stat.size) {
                throw new Error('Truncated RisuSave block name');
            }
            const nameBytes = await readFileRange(handle, offset, nameLength);
            const name = fatalUtf8Decoder.decode(nameBytes);
            offset += nameLength;
            const lengthBytes = await readFileRange(handle, offset, 4);
            const length = lengthBytes.readUInt32LE(0);
            offset += 4;
            if (offset + length > stat.size) throw new Error('Truncated RisuSave block body');
            let expectedDecodedSize = length;
            if (compression === 1) {
                if (length < 18) throw new Error('Truncated gzip RisuSave block');
                const footer = await readFileRange(handle, offset + length - 4, 4);
                expectedDecodedSize = footer.readUInt32LE(0);
            }
            blocks.push({
                type,
                compression: compression === 1,
                name,
                filePath: input.filePath,
                offset,
                size: length,
                expectedDecodedSize,
            });
            offset += length;
        }
        return blocks;
    } finally {
        await handle.close();
    }
}

async function materializeBlockJson(block, options, decodedState) {
    options.throwIfAborted();
    if (!block.compression) {
        if (!block.decodedCharged) {
            decodedState.bytes += block.size;
            if (!Number.isSafeInteger(decodedState.bytes)
                || decodedState.bytes > (decodedState.limit ?? RISU_BLOCK_MAX_DECODED_BYTES)) {
                throw new Error('RisuSave blocks exceed the bounded decode limit');
            }
        }
        return block;
    }
    const filePath = `${options.tempBase}.block-${options.nextTempIndex++}.json`;
    let size = 0;
    const meter = new Transform({
        readableHighWaterMark: PAGE_BYTES,
        writableHighWaterMark: PAGE_BYTES,
        transform(chunk, _encoding, callback) {
            try {
                options.throwIfAborted();
                const bytes = Buffer.from(chunk);
                const nextSize = size + bytes.length;
                if (nextSize > block.expectedDecodedSize) {
                    throw new Error('RisuSave gzip block exceeds its declared decoded size');
                }
                size = nextSize;
                decodedState.bytes += bytes.length;
                if (!Number.isSafeInteger(decodedState.bytes)
                    || decodedState.bytes > (decodedState.limit ?? RISU_BLOCK_MAX_DECODED_BYTES)) {
                    throw new Error('RisuSave blocks exceed the bounded decode limit');
                }
                for (let offset = 0; offset < bytes.length; offset += PAGE_BYTES) {
                    this.push(bytes.subarray(offset, Math.min(bytes.length, offset + PAGE_BYTES)));
                }
                callback();
            } catch (error) {
                callback(error);
            }
        },
    });
    const input = createReadStream(block.filePath, {
        start: block.offset,
        end: block.offset + block.size - 1,
        highWaterMark: PAGE_BYTES,
    });
    const gunzip = zlib.createGunzip({ chunkSize: PAGE_BYTES });
    const output = createWriteStream(filePath, {
        flags: 'wx',
        mode: 0o600,
        highWaterMark: PAGE_BYTES,
    });
    try {
        await pipeline(input, gunzip, meter, output, options.signal ? { signal: options.signal } : {});
        if (size !== block.expectedDecodedSize) {
            throw new Error('RisuSave gzip block decoded size is invalid');
        }
        return {
            filePath,
            offset: 0,
            size,
            cleanup: () => fs.unlink(filePath).catch(() => {}),
        };
    } catch (error) {
        await fs.unlink(filePath).catch(() => {});
        throw error;
    }
}

function blockFieldName(type) {
    switch (type) {
        case RisuSaveType.BOTPRESET: return 'botPresets';
        case RisuSaveType.MODULES: return 'modules';
        case RisuSaveType.PLUGINS: return 'plugins';
        case RisuSaveType.LOADOUTS: return 'loadouts';
        case RisuSaveType.PLUGIN_STORAGE: return 'pluginCustomStorage';
        default: return null;
    }
}

async function readSmallJson(source, label) {
    if (source.size > PAGE_BYTES) throw new Error(`${label} exceeds the bounded metadata limit`);
    const handle = await fs.open(source.filePath, 'r');
    try {
        const bytes = await readFileRange(handle, source.offset ?? 0, source.size);
        return JSON.parse(fatalUtf8Decoder.decode(bytes));
    } finally {
        await handle.close();
    }
}

async function expandRemoteBlocks(blocks, options, decodedState) {
    const queue = blocks.map(block => ({ ...block, remoteChain: [] }));
    const ownedSources = [];
    const sourceCache = new Map();
    let remoteCount = 0;
    try {
        for (let index = 0; index < queue.length; index++) {
            const block = queue[index];
            if (block.type !== RisuSaveType.REMOTE) continue;
            if (++remoteCount > (options.maxRemoteCount ?? RISU_REMOTE_MAX_COUNT)) {
                throw new Error('RisuSave REMOTE inventory exceeds the bounded limit');
            }
            const source = await materializeBlockJson(block, options, decodedState);
            try {
                const remote = await readSmallJson(source, 'REMOTE block');
                if (!remote || typeof remote.name !== 'string' || remote.name.length === 0
                    || !Number.isInteger(remote.type)
                    || !KNOWN_RISU_SAVE_TYPES.has(remote.type)) {
                    throw new Error('Invalid REMOTE block metadata');
                }
                if (block.remoteChain.includes(remote.name) || block.remoteChain.length >= 32) {
                    throw new Error('REMOTE block cycle or nesting overflow');
                }

                let remoteSource = sourceCache.get(remote.name) ?? null;
                let expectedSize = remoteSource?.size ?? null;
                if (remoteSource === null && typeof options.readRemoteRowSize === 'function') {
                    expectedSize = await options.readRemoteRowSize(remote.name);
                    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
                        throw new Error(`Referenced REMOTE block ${remote.name} is missing`);
                    }
                }
                // Charge each logical expansion before a new row is spooled.
                // Duplicate pointers share one physical source but still count
                // independently against the authoritative decoded-byte bound.
                if (expectedSize !== null) {
                    const nextDecoded = decodedState.bytes + expectedSize;
                    if (!Number.isSafeInteger(nextDecoded)
                        || nextDecoded > (decodedState.limit ?? RISU_BLOCK_MAX_DECODED_BYTES)) {
                        throw new Error('RisuSave blocks exceed the bounded decode limit');
                    }
                    decodedState.bytes = nextDecoded;
                }
                if (remoteSource === null) {
                    remoteSource = await options.readRemoteRowSource?.(remote.name);
                    if (!remoteSource) {
                        throw new Error(`Referenced REMOTE block ${remote.name} is missing`);
                    }
                    if (!Number.isSafeInteger(remoteSource.size) || remoteSource.size < 0
                        || (expectedSize !== null && remoteSource.size !== expectedSize)) {
                        await remoteSource.cleanup?.();
                        throw new Error(`Referenced REMOTE block ${remote.name} changed while spooling`);
                    }
                    if (expectedSize === null) {
                        const nextDecoded = decodedState.bytes + remoteSource.size;
                        if (!Number.isSafeInteger(nextDecoded)
                            || nextDecoded > (decodedState.limit ?? RISU_BLOCK_MAX_DECODED_BYTES)) {
                            await remoteSource.cleanup?.();
                            throw new Error('RisuSave blocks exceed the bounded decode limit');
                        }
                        decodedState.bytes = nextDecoded;
                    }
                    sourceCache.set(remote.name, remoteSource);
                    ownedSources.push(remoteSource);
                }
                queue.push({
                    type: remote.type,
                    compression: false,
                    decodedCharged: true,
                    name: remote.name,
                    filePath: remoteSource.filePath,
                    offset: 0,
                    size: remoteSource.size,
                    remoteChain: [...block.remoteChain, remote.name],
                });
            } finally {
                await source.cleanup?.();
            }
        }
        return { blocks: queue, ownedSources };
    } catch (error) {
        await Promise.allSettled(ownedSources.map(source => source.cleanup?.()));
        throw error;
    }
}

function metadataForValue(value) {
    if (value === undefined) return { type: 'undefined', truthy: false };
    if (value === null) return { type: 'null', truthy: false };
    if (Array.isArray(value)) return { type: 'array', truthy: true, count: value.length };
    if (typeof value === 'object') return { type: 'object', truthy: true };
    return { type: typeof value, truthy: Boolean(value), value };
}

function stateValueIsTruthy(state, key) {
    const own = state.get(key);
    if (own) return own.metadata.truthy;
    return INHERITED_OBJECT_TRUTHY_KEYS.has(key);
}

function setRootStateValue(state, key, record) {
    if (key.startsWith('__') || stateValueIsTruthy(state, key)) return;
    state.set(key, record);
}

function appendCharacterStateValue(state, record) {
    const current = state.get('characters');
    let composite;
    if (!current || current.metadata.type === 'null' || current.metadata.type === 'undefined') {
        composite = {
            kind: 'composite-array',
            base: null,
            appends: [],
            metadata: { type: 'array', truthy: true, count: 0 },
        };
    } else if (current.kind === 'composite-array') {
        composite = current;
    } else if (current.metadata.type === 'array') {
        composite = {
            kind: 'composite-array',
            base: current,
            appends: [],
            metadata: { ...current.metadata },
        };
    } else {
        throw new Error('RisuSave characters value is not appendable');
    }
    composite.appends.push(record);
    composite.metadata.count++;
    if (composite.metadata.count > 0xffffffff) {
        throw new Error('RisuSave characters array is too large');
    }
    state.set('characters', composite);
}

async function reduceBlockRisuSave(input, options, adapter) {
    const rawBlocks = await scanRisuSaveBlocks(input, options);
    const decodedState = { bytes: 0, limit: options.maxDecodedBytes };
    const expanded = await expandRemoteBlocks(rawBlocks, options, decodedState);
    const state = new Map();
    try {
        for (const block of expanded.blocks) {
            if (block.type === RisuSaveType.REMOTE) continue;
            const source = await materializeBlockJson(block, options, decodedState);
            try {
                if (block.type === RisuSaveType.CONFIG || block.type === RisuSaveType.CHAT) {
                    await validateJsonSource(source, {
                        signal: options.signal,
                        shouldAbort: options.shouldAbort,
                    });
                    continue;
                }
                if (block.type === RisuSaveType.ROOT) {
                    const entries = await adapter.rootEntries(source);
                    for (const [key, record] of entries) setRootStateValue(state, key, record);
                } else if (block.type === RisuSaveType.ROOT_COMPONENT) {
                    const component = await adapter.component(source);
                    const key = String(component.key);
                    if (key === '__proto__') {
                        throw new Error('ROOT_COMPONENT __proto__ is not supported by bounded export');
                    }
                    if (adapter.capture(key)) state.set(key, component.record);
                } else if (block.type === RisuSaveType.CHARACTER_WITH_CHAT
                    || block.type === RisuSaveType.CHARACTER_WITHOUT_CHAT) {
                    if (adapter.capture('characters')) {
                        appendCharacterStateValue(state, await adapter.value(source));
                    } else {
                        await validateJsonSource(source, {
                            signal: options.signal,
                            shouldAbort: options.shouldAbort,
                        });
                    }
                } else {
                    const field = blockFieldName(block.type);
                    if (!field) continue;
                    if (adapter.capture(field)) state.set(field, await adapter.value(source));
                    else await validateJsonSource(source, {
                        signal: options.signal,
                        shouldAbort: options.shouldAbort,
                    });
                }
            } finally {
                await source.cleanup?.();
            }
        }
        return state;
    } finally {
        await Promise.allSettled(expanded.ownedSources.map(source => source.cleanup?.()));
    }
}

async function writeScratchRecord(writer, scratchSource, record) {
    if (record.kind === 'buffer') {
        await writer.write(record.bytes);
        return;
    }
    if (record.kind === 'composite-array') {
        await writer.write(arrayHeader(record.metadata.count));
        if (record.base) {
            if (record.base.metadata.type !== 'array' || record.base.descriptor.length < 5) {
                throw new Error('Invalid spooled RisuSave character array');
            }
            const header = await scratchSource.readRange(record.base.descriptor.offset, 5);
            if (header.length !== 5 || header[0] !== 0xdd
                || header.readUInt32BE(1) !== record.base.metadata.count) {
                throw new Error('Invalid spooled RisuSave character array header');
            }
            await writer.copyRange(
                scratchSource,
                record.base.descriptor.offset + 5,
                record.base.descriptor.length - 5,
            );
        }
        for (const appended of record.appends) {
            await writeScratchRecord(writer, scratchSource, appended);
        }
        return;
    }
    await writer.copyRange(scratchSource, record.descriptor.offset, record.descriptor.length);
}

function finalizeBlockState(state) {
    const characters = state.get('characters');
    if (!characters || (characters.kind !== 'composite-array'
        && characters.metadata.type !== 'array')) {
        state.set('characters', {
            kind: 'buffer',
            bytes: arrayHeader(0),
            metadata: { type: 'array', truthy: true, count: 0 },
        });
    }
    const presets = state.get('botPresets');
    if (!presets || presets.metadata.type !== 'array' || presets.metadata.count === 0) {
        state.set('botPresets', {
            kind: 'buffer',
            bytes: encoded([{ ...presetTemplate, id: nodeCrypto.randomUUID() }]),
            metadata: { type: 'array', truthy: true, count: 1 },
        });
        state.set('botPresetsId', {
            kind: 'buffer',
            bytes: encoded(0),
            metadata: { type: 'number', truthy: false, value: 0 },
        });
    }
}

async function convertBlockRisuSaveToMessagePack(input, filePath, options) {
    options.tempBase = filePath;
    options.nextTempIndex = 0;
    const scratchPath = `${filePath}.values`;
    let scratchWriteHandle = null;
    let scratchReadHandle = null;
    let outputHandle = null;
    try {
        scratchWriteHandle = await fs.open(scratchPath, 'wx', 0o600);
        const scratchWriter = new PagedFileWriter(
            scratchWriteHandle,
            options.shouldAbort,
            options.signal,
        );
        const jsonOptions = { signal: options.signal, shouldAbort: options.shouldAbort };
        const captureValue = async (source) => {
            const offset = scratchWriter.position;
            const metadata = await streamJsonFileToMessagePack(source, scratchWriter, jsonOptions);
            return {
                kind: 'descriptor',
                descriptor: { offset, length: scratchWriter.position - offset },
                metadata,
            };
        };
        const state = await reduceBlockRisuSave(input, options, {
            capture: () => true,
            rootEntries: (source) => streamJsonRootEntries(source, scratchWriter, jsonOptions)
                .then((entries) => new Map([...entries].map(([key, value]) => [key, {
                    kind: 'descriptor',
                    ...value,
                }]))),
            value: captureValue,
            component: async (source) => {
                const fields = await readJsonObjectFields(source, ['key'], jsonOptions);
                const selected = await streamJsonObjectField(
                    source,
                    'data',
                    scratchWriter,
                    jsonOptions,
                );
                return {
                    key: fields.key,
                    record: selected
                        ? { kind: 'descriptor', ...selected }
                        : {
                            kind: 'buffer',
                            bytes: encoded(undefined),
                            metadata: { type: 'undefined', truthy: false },
                        },
                };
            },
        });
        finalizeBlockState(state);
        await scratchWriteHandle.sync();
        await scratchWriteHandle.close();
        scratchWriteHandle = null;
        scratchReadHandle = await fs.open(scratchPath, 'r');
        const scratchStat = await scratchReadHandle.stat();
        const scratchSource = {
            size: scratchStat.size,
            readRange: (offset, length) => readFileRange(scratchReadHandle, offset, length),
        };

        const fields = [...state].filter(([, record]) => record.metadata.type !== 'undefined');
        if (fields.length > 0xffffffff) throw new Error('RisuSave root has too many fields');
        outputHandle = await fs.open(filePath, 'wx', 0o600);
        const writer = new PagedFileWriter(outputHandle, options.shouldAbort, options.signal);
        await writer.write(Buffer.from(magicHeader));
        await writer.write(mapHeader(fields.length));
        for (const [key, record] of fields) {
            await writer.write(encoded(key));
            await writeScratchRecord(writer, scratchSource, record);
        }
        await outputHandle.sync();
        await outputHandle.close();
        outputHandle = null;
        await scratchReadHandle.close();
        scratchReadHandle = null;
        await fs.unlink(scratchPath).catch(() => {});
        return {
            filePath,
            size: writer.position,
            cleanup: () => fs.unlink(filePath).catch(() => {}),
        };
    } catch (error) {
        await outputHandle?.close().catch(() => {});
        await scratchWriteHandle?.close().catch(() => {});
        await scratchReadHandle?.close().catch(() => {});
        await fs.unlink(filePath).catch(() => {});
        await fs.unlink(scratchPath).catch(() => {});
        throw error;
    }
}

async function readBlockRisuSaveTopLevelFields(input, requestedKeys, options = {}) {
    const throwIfAborted = () => {
        if (!options.signal?.aborted && !options.shouldAbort?.()) return;
        throw abortError(options.signal);
    };
    const requested = new Set(requestedKeys);
    const jsonOptions = { signal: options.signal, shouldAbort: options.shouldAbort };
    const materializeOptions = {
        ...options,
        throwIfAborted,
        tempBase: path.join(
            options.tempDir,
            `.block-fields-${process.pid}-${nodeCrypto.randomUUID()}`,
        ),
        nextTempIndex: 0,
    };
    const state = await reduceBlockRisuSave(input, materializeOptions, {
        capture: (key) => requested.has(key),
        rootEntries: async (source) => {
            const fields = await readJsonRootFields(source, requestedKeys, jsonOptions);
            return new Map(Object.keys(fields).map((key) => [key, {
                kind: 'value',
                value: fields[key],
                metadata: metadataForValue(fields[key]),
            }]));
        },
        value: async (source) => {
            const value = await readJsonValue(source, jsonOptions);
            return { kind: 'value', value, metadata: metadataForValue(value) };
        },
        component: async (source) => {
            const fields = await readJsonObjectFields(source, ['key'], jsonOptions);
            const key = String(fields.key);
            if (!requested.has(key)) return { key, record: null };
            const selected = await readJsonObjectFields(source, ['data'], jsonOptions);
            return {
                key,
                record: {
                    kind: 'value',
                    value: selected.data,
                    metadata: metadataForValue(selected.data),
                },
            };
        },
    });
    const result = {};
    for (const key of requestedKeys) {
        const record = state.get(key);
        if (record && record.metadata.type !== 'undefined') {
            Object.defineProperty(result, key, {
                configurable: true,
                enumerable: true,
                value: record.value,
                writable: true,
            });
        }
    }
    return result;
}

async function transformChat(writer, dbSource, descriptor, chaId, options) {
    const stubEntries = await readMapEntries(dbSource, descriptor, 'chat stub');
    if (!stubEntries) {
        await writer.copyDescriptor(dbSource, descriptor);
        return;
    }
    const stubByKey = new Map(stubEntries.map(entry => [entry.key, entry]));
    const stubMarker = stubByKey.has('_stub')
        ? await decodeMetadata(dbSource, stubByKey.get('_stub').descriptor, 'chat stub marker')
        : undefined;
    const chatId = stubByKey.has('id')
        ? await decodeMetadata(dbSource, stubByKey.get('id').descriptor, 'chat id')
        : undefined;
    if (stubMarker !== true || !chatId) {
        await writer.copyDescriptor(dbSource, descriptor);
        return;
    }

    const rowSource = await options.readChatRowSource(chaId, chatId);
    if (!rowSource) {
        await options.onMissingChatRow?.(chaId, chatId);
        await writer.copyDescriptor(dbSource, descriptor);
        return;
    }
    try {
        await withPreparedSource(rowSource, options, async (chatSource, payloadOffset) => {
            const cursor = chatSource.cursor(payloadOffset);
            const fullDescriptor = await skipMessagePackValue(cursor);
            if (cursor.position !== chatSource.size) {
                throw new Error('Trailing bytes after external chat row');
            }
            const fullEntries = await readMapEntries(chatSource, fullDescriptor, 'external chat');
            if (!fullEntries) throw new Error('External chat row must be a MessagePack map');
            const plan = [];
            const byKey = new Map();
            for (const entry of fullEntries) {
                if (entry.key === '_stub') continue;
                byKey.set(entry.key, plan.length);
                plan.push({ key: entry.key, source: chatSource, descriptor: entry.descriptor });
            }
            const overlay = (key, fallback) => {
                const stub = stubByKey.get(key);
                const value = stub
                    ? { key, source: dbSource, descriptor: stub.descriptor }
                    : { key, encoded: encoded(fallback) };
                const prior = byKey.get(key);
                if (prior === undefined) {
                    byKey.set(key, plan.length);
                    plan.push(value);
                } else {
                    plan[prior] = value;
                }
            };
            overlay('id', '');
            overlay('name', undefined);
            for (const key of ['lastDate', 'folderId', 'modules']) {
                if (stubByKey.has(key)) overlay(key, undefined);
            }
            await writer.write(mapHeader(plan.length));
            for (const field of plan) {
                await writer.write(encoded(field.key));
                if (field.encoded) await writer.write(field.encoded);
                else await writer.copyDescriptor(field.source, field.descriptor);
            }
        });
    } finally {
        await rowSource.cleanup?.();
    }
}

async function transformChats(writer, source, descriptor, chaId, options) {
    const chats = await readArrayDescriptors(source, descriptor, 'character chats');
    if (!chats) {
        await writer.copyDescriptor(source, descriptor);
        return;
    }
    await writer.write(arrayHeader(chats.length));
    for (const chat of chats) await transformChat(writer, source, chat, chaId, options);
}

async function transformCharacter(writer, source, descriptor, options) {
    const entries = await readMapEntries(source, descriptor, 'character');
    if (!entries) {
        await writer.copyDescriptor(source, descriptor);
        return;
    }
    const chaIdEntry = entries.find(entry => entry.key === 'chaId');
    const chaId = chaIdEntry
        ? await decodeMetadata(source, chaIdEntry.descriptor, 'character id')
        : undefined;
    await writer.write(mapHeader(entries.length));
    for (const entry of entries) {
        await writer.write(encoded(entry.key));
        if (entry.key === 'chats' && chaId) {
            await transformChats(writer, source, entry.descriptor, chaId, options);
        } else {
            await writer.copyDescriptor(source, entry.descriptor);
        }
    }
}

async function transformCharacters(writer, source, descriptor, options) {
    const characters = await readArrayDescriptors(source, descriptor, 'characters');
    if (!characters) {
        await writer.copyDescriptor(source, descriptor);
        return;
    }
    await writer.write(arrayHeader(characters.length));
    for (const character of characters) {
        await transformCharacter(writer, source, character, options);
    }
}

async function streamBackupRisuSaveToFile({
    databaseSource,
    filePath,
    readChatRowSource,
    readRemoteRowSource = null,
    readRemoteRowSize = null,
    maxRemoteCount = undefined,
    maxDecodedBytes = undefined,
    pluginStorage = null,
    markPluginStorageFolded = false,
    shouldAbort = () => false,
    signal = null,
    tempDir = null,
    onMissingChatRow = throwMissingChatRow,
}) {
    if (typeof readChatRowSource !== 'function') {
        throw new TypeError('readChatRowSource must be a function');
    }
    const handle = await fs.open(filePath, 'wx', 0o600);
    const writer = new PagedFileWriter(handle, shouldAbort, signal);
    const options = {
        readChatRowSource,
        readRemoteRowSource,
        readRemoteRowSize,
        maxRemoteCount,
        maxDecodedBytes,
        onMissingChatRow,
        shouldAbort,
        signal,
        tempDir,
    };
    options.throwIfAborted = () => writer.throwIfAborted();
    try {
        const databaseInspection = await inspectRisuSaveSource(databaseSource);
        let transformedDatabase = databaseSource;
        if (databaseInspection.format === 'risusave') {
            transformedDatabase = await convertBlockRisuSaveToMessagePack(
                databaseSource,
                `${filePath}.blocks-${process.pid}`,
                options,
            );
        }
        try {
        await withPreparedSource(transformedDatabase, options, async (source, payloadOffset, inspection) => {
            const cursor = source.cursor(payloadOffset);
            const rootDescriptor = await skipMessagePackValue(cursor);
            if (cursor.position !== source.size) throw new Error('Trailing bytes after backup database');
            const rootEntries = await readMapEntries(source, rootDescriptor, 'database root');
            if (!rootEntries) throw new Error('Backup database root must be a MessagePack map');
            const rootByKey = new Map(rootEntries.map(entry => [entry.key, entry]));

            let existingEnvelope = null;
            if (inspection.pluginStorageEscapes && rootByKey.has(pluginStorageLegacyEscapeField)) {
                existingEnvelope = await parseExistingEscapeEnvelope(
                    source,
                    rootByKey.get(pluginStorageLegacyEscapeField).descriptor,
                );
            }

            const pluginPlans = new Map();
            const outputEscapes = [];
            if (pluginStorage) {
                for (const [field, rows] of [
                    ['pluginCustomStorage', pluginStorage.valueRows ?? []],
                    ['pluginStorageMeta', pluginStorage.metaRows ?? []],
                ]) {
                    const rootEntry = rootByKey.get(field);
                    const inlineEntries = rootEntry
                        ? await readMapEntries(source, rootEntry.descriptor, field)
                        : [];
                    if (inlineEntries === null) {
                        pluginPlans.set(field, { primitiveDescriptor: rootEntry.descriptor });
                        continue;
                    }
                    const priorEscape = existingEnvelope?.escapes.get(field) ?? null;
                    const plan = keyPlan(inlineEntries, rows, priorEscape?.index ?? null);
                    const protoIndex = plan.keys.indexOf('__proto__');
                    if (protoIndex !== -1) {
                        const protoValue = plan.valueByKey.get('__proto__');
                        plan.keys.splice(protoIndex, 1);
                        outputEscapes.push({
                            field,
                            index: protoIndex,
                            value: protoValue?.kind === 'row'
                                ? { kind: 'row', row: protoValue.row }
                                : priorEscape
                                    ? { kind: 'descriptor', descriptor: priorEscape.serializedDescriptor }
                                    : protoValue?.kind === 'descriptor'
                                        ? { kind: 'inline', descriptor: protoValue.descriptor }
                                        : null,
                        });
                    }
                    pluginPlans.set(field, plan);
                }
            }

            const hasEscapes = outputEscapes.length > 0
                || (!pluginStorage && inspection.pluginStorageEscapes);
            await writer.write(Buffer.from(hasEscapes ? magicPluginStorageHeader : magicHeader));

            const topEntries = rootEntries.filter(entry =>
                entry.key !== PLUGIN_STORAGE_FOLDED_MARKER
                && (!pluginStorage || !hasEscapes
                    || entry.key !== pluginStorageLegacyEscapeField)
            );
            for (const field of ['pluginCustomStorage', 'pluginStorageMeta']) {
                const plan = pluginPlans.get(field);
                if (pluginStorage && plan && !rootByKey.has(field)
                    && !plan.primitiveDescriptor && plan.keys.length > 0) {
                    topEntries.push({ key: field, generated: true });
                }
            }
            if (markPluginStorageFolded && pluginStorage) {
                topEntries.push({ key: PLUGIN_STORAGE_FOLDED_MARKER, generated: true });
            }
            if (hasEscapes && pluginStorage) {
                topEntries.push({ key: pluginStorageLegacyEscapeField, generated: true });
            }
            await writer.write(mapHeader(topEntries.length));
            for (const entry of topEntries) {
                await writer.write(encoded(entry.key));
                if (entry.key === 'characters') {
                    await transformCharacters(writer, source, entry.descriptor, options);
                    continue;
                }
                const pluginPlan = pluginPlans.get(entry.key);
                if (pluginStorage && pluginPlan && !pluginPlan.primitiveDescriptor) {
                    await writer.write(mapHeader(pluginPlan.keys.length));
                    for (const key of pluginPlan.keys) {
                        await writer.write(encoded(key));
                        const value = pluginPlan.valueByKey.get(key);
                        if (value.kind === 'row') {
                            await writeJsonRow(
                                writer,
                                value.row,
                                pluginStorage.readRowSource,
                                options,
                            );
                        } else {
                            await writer.copyDescriptor(source, value.descriptor);
                        }
                    }
                } else if (entry.key === PLUGIN_STORAGE_FOLDED_MARKER) {
                    await writer.write(encoded(true));
                } else if (entry.key === pluginStorageLegacyEscapeField
                    && pluginStorage && hasEscapes) {
                    await writer.write(arrayHeader(4));
                    await writer.write(encoded(pluginStorageLegacyEscapeMarker));
                    await writer.write(encoded(1));
                    if (existingEnvelope?.originalDescriptor) {
                        await writer.copyDescriptor(source, existingEnvelope.originalDescriptor);
                    } else if (rootByKey.has(pluginStorageLegacyEscapeField)) {
                        await writeDescriptorAsSerializedEscape(
                            writer,
                            source,
                            rootByKey.get(pluginStorageLegacyEscapeField).descriptor,
                        );
                    } else {
                        await writer.write(encoded(null));
                    }
                    await writer.write(arrayHeader(outputEscapes.length));
                    for (const escape of outputEscapes) {
                        if (!escape.value) {
                            throw new Error('Inline __proto__ plugin value lacks a bounded escape');
                        }
                        await writer.write(arrayHeader(3));
                        await writer.write(encoded(escape.field));
                        await writer.write(encoded(escape.index));
                        if (escape.value.kind === 'row') {
                            await writeJsonRowAsSerializedEscape(
                                writer,
                                escape.value.row,
                                pluginStorage.readRowSource,
                                options,
                            );
                        } else if (escape.value.kind === 'descriptor') {
                            await writer.copyDescriptor(source, escape.value.descriptor);
                        } else {
                            await writeDescriptorAsSerializedEscape(
                                writer,
                                source,
                                escape.value.descriptor,
                            );
                        }
                    }
                } else {
                    await writer.copyDescriptor(source, entry.descriptor);
                }
            }
        });
        } finally {
            if (transformedDatabase !== databaseSource) await transformedDatabase.cleanup?.();
        }
        await handle.sync();
        await handle.close();
        return { filePath, size: writer.position, maxPageBytes: writer.maxPageBytes };
    } catch (error) {
        await handle.close().catch(() => {});
        await fs.unlink(filePath).catch(() => {});
        throw error;
    }
}

module.exports = {
    PAGE_BYTES,
    readBlockRisuSaveTopLevelFields,
    streamBackupRisuSaveToFile,
};
