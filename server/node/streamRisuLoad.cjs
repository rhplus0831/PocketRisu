'use strict';

const { createReadStream, createWriteStream } = require('fs');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const nodeCrypto = require('crypto');
const zlib = require('zlib');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { Unpackr } = require('msgpackr');
const {
    ensureBotPresetIds,
    magicHeader,
    magicCompressedHeader,
    magicStreamCompressedHeader,
    normalizeJSON,
} = require('./utils.cjs');
const { PLUGIN_STORAGE_FOLDED_MARKER } = require('./pluginSaveKeys.cjs');

const DEFAULT_STREAM_INGEST_MIN_BYTES = 32 * 1024 * 1024;
const CURSOR_CACHE_BYTES = 256 * 1024;
const unpackr = new Unpackr({ int64AsType: 'number', useRecords: false });

function configuredStreamIngestMinBytes() {
    const raw = process.env.RISU_STREAM_INGEST_MIN_BYTES;
    if (raw === undefined || raw === '') return DEFAULT_STREAM_INGEST_MIN_BYTES;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0
        ? Math.floor(parsed)
        : DEFAULT_STREAM_INGEST_MIN_BYTES;
}

function normalizeInput(input) {
    if (Buffer.isBuffer(input)) return { buffer: input, size: input.length };
    if (input instanceof Uint8Array) {
        const buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
        return { buffer, size: buffer.length };
    }
    if (input?.buffer && (Buffer.isBuffer(input.buffer) || input.buffer instanceof Uint8Array)) {
        return normalizeInput(input.buffer);
    }
    if (typeof input?.filePath === 'string') {
        return { filePath: input.filePath, size: input.size };
    }
    throw new TypeError('Streaming Risu load source must be a Buffer, Uint8Array, or { filePath }');
}

function startsWith(buffer, prefix) {
    if (buffer.length < prefix.length) return false;
    for (let index = 0; index < prefix.length; index++) {
        if (buffer[index] !== prefix[index]) return false;
    }
    return true;
}

function isZlibHeader(first, second) {
    if (first === undefined || second === undefined) return false;
    return (first & 0x0f) === 8 && (((first << 8) | second) % 31) === 0;
}

async function readInputPrefix(input, length) {
    const normalized = normalizeInput(input);
    if (normalized.buffer) {
        return {
            normalized,
            prefix: normalized.buffer.subarray(0, Math.min(length, normalized.buffer.length)),
        };
    }
    const handle = await fs.open(normalized.filePath, 'r');
    try {
        const stat = await handle.stat();
        normalized.size = stat.size;
        const prefix = Buffer.allocUnsafe(Math.min(length, stat.size));
        if (prefix.length > 0) await handle.read(prefix, 0, prefix.length, 0);
        return { normalized, prefix };
    } finally {
        await handle.close();
    }
}

async function inspectRisuSaveSource(input) {
    const headerBytes = magicHeader.length;
    const { normalized, prefix } = await readInputPrefix(input, headerBytes + 2);
    let format = null;
    let compression = null;

    if (startsWith(prefix, magicHeader)) {
        format = 'raw';
    } else if (startsWith(prefix, magicCompressedHeader)) {
        format = 'compressed';
        const first = prefix[headerBytes];
        const second = prefix[headerBytes + 1];
        if (first === 0x1f && second === 0x8b) compression = 'gzip';
        else if (isZlibHeader(first, second)) compression = 'zlib';
    } else if (startsWith(prefix, magicStreamCompressedHeader)) {
        format = 'stream';
        if (prefix[headerBytes] === 0x1f && prefix[headerBytes + 1] === 0x8b) {
            compression = 'gzip';
        }
    }

    const supported = format === 'raw' || compression !== null;
    return {
        ...normalized,
        format,
        compression,
        payloadOffset: supported ? headerBytes : 0,
        supported,
        size: normalized.size,
    };
}

async function shouldStreamRisuSave(input, options = {}) {
    const inspection = options.inspection ?? await inspectRisuSaveSource(input);
    const minBytes = options.minBytes ?? configuredStreamIngestMinBytes();
    return inspection.supported && inspection.size >= minBytes;
}

class RandomAccessSource {
    constructor({ buffer = null, handle = null, size, filePath = null }) {
        this.buffer = buffer;
        this.handle = handle;
        this.size = size;
        this.filePath = filePath;
    }

    async readRange(offset, length) {
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
            || offset < 0 || length < 0 || offset + length > this.size) {
            throw new Error(`Truncated MessagePack payload at byte ${offset}`);
        }
        if (this.buffer) return this.buffer.subarray(offset, offset + length);
        const result = Buffer.allocUnsafe(length);
        let written = 0;
        while (written < length) {
            const read = await this.handle.read(result, written, length - written, offset + written);
            if (read.bytesRead === 0) {
                throw new Error(`Truncated MessagePack payload at byte ${offset + written}`);
            }
            written += read.bytesRead;
        }
        return result;
    }

    cursor(position = 0) {
        return new SourceCursor(this, position);
    }

    async close() {
        if (this.handle) await this.handle.close();
    }
}

class SourceCursor {
    constructor(source, position) {
        this.source = source;
        this.position = position;
        this.cache = null;
        this.cacheOffset = 0;
    }

    seek(position) {
        if (!Number.isSafeInteger(position) || position < 0 || position > this.source.size) {
            throw new Error(`Invalid MessagePack seek offset ${position}`);
        }
        this.position = position;
    }

    skip(length) {
        const next = this.position + length;
        if (!Number.isSafeInteger(length) || length < 0 || next > this.source.size) {
            throw new Error(`Truncated MessagePack payload at byte ${this.position}`);
        }
        this.position = next;
    }

    async readBytes(length) {
        if (!Number.isSafeInteger(length) || length < 0 || this.position + length > this.source.size) {
            throw new Error(`Truncated MessagePack payload at byte ${this.position}`);
        }
        if (length === 0) return Buffer.alloc(0);
        if (this.source.buffer) {
            const result = this.source.buffer.subarray(this.position, this.position + length);
            this.position += length;
            return result;
        }

        const cacheEnd = this.cacheOffset + (this.cache?.length ?? 0);
        if (!this.cache || this.position < this.cacheOffset || this.position + length > cacheEnd) {
            const cacheLength = Math.min(
                Math.max(CURSOR_CACHE_BYTES, length),
                this.source.size - this.position
            );
            this.cacheOffset = this.position;
            this.cache = await this.source.readRange(this.position, cacheLength);
        }
        const relative = this.position - this.cacheOffset;
        const result = this.cache.subarray(relative, relative + length);
        this.position += length;
        return result;
    }

    async readUInt8() {
        return (await this.readBytes(1))[0];
    }

    async readUInt16BE() {
        return (await this.readBytes(2)).readUInt16BE(0);
    }

    async readUInt32BE() {
        return (await this.readBytes(4)).readUInt32BE(0);
    }
}

function valueDescriptor(offset, end) {
    return { offset, length: end - offset };
}

async function skipMessagePackValue(cursor) {
    const start = cursor.position;
    let remaining = 1;
    while (remaining > 0) {
        remaining--;
        const markerOffset = cursor.position;
        const marker = await cursor.readUInt8();
        let children = 0;
        let payloadBytes = 0;

        if (marker <= 0x7f || marker >= 0xe0 || marker === 0xc0
            || marker === 0xc2 || marker === 0xc3) {
            // fixint, negative fixint, nil, and booleans have no payload.
        } else if (marker >= 0x80 && marker <= 0x8f) {
            children = (marker & 0x0f) * 2;
        } else if (marker >= 0x90 && marker <= 0x9f) {
            children = marker & 0x0f;
        } else if (marker >= 0xa0 && marker <= 0xbf) {
            payloadBytes = marker & 0x1f;
        } else {
            switch (marker) {
                case 0xc1:
                    throw new Error(`Invalid reserved MessagePack marker 0xc1 at byte ${markerOffset}`);
                case 0xc4: payloadBytes = await cursor.readUInt8(); break;
                case 0xc5: payloadBytes = await cursor.readUInt16BE(); break;
                case 0xc6: payloadBytes = await cursor.readUInt32BE(); break;
                case 0xc7: payloadBytes = 1 + await cursor.readUInt8(); break;
                case 0xc8: payloadBytes = 1 + await cursor.readUInt16BE(); break;
                case 0xc9: payloadBytes = 1 + await cursor.readUInt32BE(); break;
                case 0xca: payloadBytes = 4; break;
                case 0xcb: payloadBytes = 8; break;
                case 0xcc: payloadBytes = 1; break;
                case 0xcd: payloadBytes = 2; break;
                case 0xce: payloadBytes = 4; break;
                case 0xcf: payloadBytes = 8; break;
                case 0xd0: payloadBytes = 1; break;
                case 0xd1: payloadBytes = 2; break;
                case 0xd2: payloadBytes = 4; break;
                case 0xd3: payloadBytes = 8; break;
                case 0xd4: payloadBytes = 2; break;
                case 0xd5: payloadBytes = 3; break;
                case 0xd6: payloadBytes = 5; break;
                case 0xd7: payloadBytes = 9; break;
                case 0xd8: payloadBytes = 17; break;
                case 0xd9: payloadBytes = await cursor.readUInt8(); break;
                case 0xda: payloadBytes = await cursor.readUInt16BE(); break;
                case 0xdb: payloadBytes = await cursor.readUInt32BE(); break;
                case 0xdc: children = await cursor.readUInt16BE(); break;
                case 0xdd: children = await cursor.readUInt32BE(); break;
                case 0xde: children = (await cursor.readUInt16BE()) * 2; break;
                case 0xdf: children = (await cursor.readUInt32BE()) * 2; break;
                default:
                    throw new Error(`Unsupported MessagePack marker 0x${marker.toString(16)} at byte ${markerOffset}`);
            }
        }

        cursor.skip(payloadBytes);
        remaining += children;
        if (!Number.isSafeInteger(remaining)) {
            throw new Error(`MessagePack collection is too large at byte ${markerOffset}`);
        }
    }
    return valueDescriptor(start, cursor.position);
}

async function readCollectionCount(cursor, kind) {
    const markerOffset = cursor.position;
    const marker = await cursor.readUInt8();
    if (kind === 'map') {
        if (marker >= 0x80 && marker <= 0x8f) return marker & 0x0f;
        if (marker === 0xde) return cursor.readUInt16BE();
        if (marker === 0xdf) return cursor.readUInt32BE();
    } else {
        if (marker >= 0x90 && marker <= 0x9f) return marker & 0x0f;
        if (marker === 0xdc) return cursor.readUInt16BE();
        if (marker === 0xdd) return cursor.readUInt32BE();
    }
    throw new Error(`Expected MessagePack ${kind} at byte ${markerOffset}`);
}

async function descriptorCollectionKind(source, descriptor) {
    const marker = (await source.readRange(descriptor.offset, 1))[0];
    if ((marker >= 0x80 && marker <= 0x8f) || marker === 0xde || marker === 0xdf) return 'map';
    if ((marker >= 0x90 && marker <= 0x9f) || marker === 0xdc || marker === 0xdd) return 'array';
    return null;
}

async function decodeDescriptor(source, descriptor) {
    const bytes = await source.readRange(descriptor.offset, descriptor.length);
    return unpackr.decode(bytes);
}

async function readMapDescriptors(source, descriptor) {
    const cursor = source.cursor(descriptor.offset);
    const count = await readCollectionCount(cursor, 'map');
    const entries = [];
    const indexByKey = new Map();
    for (let index = 0; index < count; index++) {
        const keyDescriptor = await skipMessagePackValue(cursor);
        const decodedKey = await decodeDescriptor(source, keyDescriptor);
        const key = typeof decodedKey === 'string' ? decodedKey : String(decodedKey);
        const descriptorValue = await skipMessagePackValue(cursor);
        const priorIndex = indexByKey.get(key);
        if (priorIndex === undefined) {
            indexByKey.set(key, entries.length);
            entries.push({ key, descriptor: descriptorValue });
        } else {
            entries[priorIndex].descriptor = descriptorValue;
        }
    }
    if (cursor.position !== descriptor.offset + descriptor.length) {
        throw new Error(`Invalid MessagePack map span at byte ${descriptor.offset}`);
    }
    return entries;
}

function assignNormalizedProperty(target, key, value) {
    if (value === undefined) return;
    const normalized = normalizeJSON(value);
    if (normalized !== undefined) target[key] = normalized;
}

async function processPluginMap(source, descriptor, field, onEntry) {
    const entries = await readMapDescriptors(source, descriptor);
    let count = 0;
    for (const entry of entries) {
        const normalized = normalizeJSON(await decodeDescriptor(source, entry.descriptor));
        if (normalized === undefined) continue;
        await onEntry({ field, key: entry.key, value: normalized });
        count++;
    }
    return count;
}

async function collectAssignedChatIds(source, charactersDescriptor, onMissingChatId) {
    const assignedIds = new Map();
    if (!charactersDescriptor
        || await descriptorCollectionKind(source, charactersDescriptor) !== 'array') {
        return assignedIds;
    }

    const charactersCursor = source.cursor(charactersDescriptor.offset);
    const characterCount = await readCollectionCount(charactersCursor, 'array');
    for (let characterIndex = 0; characterIndex < characterCount; characterIndex++) {
        const characterDescriptor = await skipMessagePackValue(charactersCursor);
        if (await descriptorCollectionKind(source, characterDescriptor) !== 'map') continue;
        const fields = await readMapDescriptors(source, characterDescriptor);
        const chatsField = fields.find(field => field.key === 'chats');
        if (!chatsField
            || await descriptorCollectionKind(source, chatsField.descriptor) !== 'array') continue;

        const chatsCursor = source.cursor(chatsField.descriptor.offset);
        const chatCount = await readCollectionCount(chatsCursor, 'array');
        for (let chatIndex = 0; chatIndex < chatCount; chatIndex++) {
            const chatDescriptor = await skipMessagePackValue(chatsCursor);
            if (await descriptorCollectionKind(source, chatDescriptor) !== 'map') {
                const chat = normalizeJSON(await decodeDescriptor(source, chatDescriptor));
                if (!chat) continue;
                if (typeof chat !== 'object') {
                    throw new TypeError('Invalid primitive chat value cannot receive a generated id');
                }
                if (!chat._stub && !chat.id) {
                    assignedIds.set(chatDescriptor.offset, await onMissingChatId({
                        characterIndex,
                        chatIndex,
                    }));
                }
                continue;
            }
            const chatFields = await readMapDescriptors(source, chatDescriptor);
            const idField = chatFields.find(field => field.key === 'id');
            const stubField = chatFields.find(field => field.key === '_stub');
            const id = idField
                ? normalizeJSON(await decodeDescriptor(source, idField.descriptor))
                : undefined;
            const stub = stubField
                ? normalizeJSON(await decodeDescriptor(source, stubField.descriptor))
                : undefined;
            if (!stub && !id) {
                assignedIds.set(chatDescriptor.offset, await onMissingChatId({
                    characterIndex,
                    chatIndex,
                }));
            }
        }
    }
    return assignedIds;
}

async function processCharacter(source, descriptor, options) {
    if (await descriptorCollectionKind(source, descriptor) !== 'map') {
        return normalizeJSON(await decodeDescriptor(source, descriptor));
    }

    const fields = await readMapDescriptors(source, descriptor);
    const character = {};
    let chatsDescriptor = null;
    for (const field of fields) {
        if (field.key === 'chats') {
            chatsDescriptor = field.descriptor;
            // Preserve the original property insertion position even when chats
            // precedes chaId in the serialized map.
            character.chats = [];
        } else {
            assignNormalizedProperty(
                character,
                field.key,
                await decodeDescriptor(source, field.descriptor)
            );
        }
    }

    if (!chatsDescriptor) return character;
    if (await descriptorCollectionKind(source, chatsDescriptor) !== 'array') {
        const decoded = await decodeDescriptor(source, chatsDescriptor);
        if (decoded === undefined || normalizeJSON(decoded) === undefined) delete character.chats;
        else character.chats = normalizeJSON(decoded);
        return character;
    }

    const retainChats = Boolean(options.retainCharacterChats?.(character));
    const externalizable = Boolean(character.chaId) && !retainChats;
    const cursor = source.cursor(chatsDescriptor.offset);
    const count = await readCollectionCount(cursor, 'array');
    const chats = [];
    for (let index = 0; index < count; index++) {
        const chatDescriptor = await skipMessagePackValue(cursor);
        const chat = normalizeJSON(await decodeDescriptor(source, chatDescriptor));
        const assignedId = options.assignedChatIds?.get(chatDescriptor.offset);
        if (assignedId !== undefined && chat && typeof chat === 'object') {
            chat.id = assignedId;
        }
        const replacement = options.onChat
            ? await options.onChat({ character, chat, index, externalizable, retainChats })
            : chat;
        chats.push(replacement);
    }
    if (cursor.position !== chatsDescriptor.offset + chatsDescriptor.length) {
        throw new Error(`Invalid MessagePack chats span at byte ${chatsDescriptor.offset}`);
    }
    character.chats = chats;
    return character;
}

async function processCharacters(source, descriptor, options) {
    if (await descriptorCollectionKind(source, descriptor) !== 'array') {
        return normalizeJSON(await decodeDescriptor(source, descriptor));
    }
    const cursor = source.cursor(descriptor.offset);
    const count = await readCollectionCount(cursor, 'array');
    const characters = [];
    for (let index = 0; index < count; index++) {
        const characterDescriptor = await skipMessagePackValue(cursor);
        characters.push(await processCharacter(source, characterDescriptor, options));
    }
    if (cursor.position !== descriptor.offset + descriptor.length) {
        throw new Error(`Invalid MessagePack characters span at byte ${descriptor.offset}`);
    }
    return characters;
}

async function openBaseSource(inspection) {
    if (inspection.buffer) {
        return new RandomAccessSource({ buffer: inspection.buffer, size: inspection.buffer.length });
    }
    const handle = await fs.open(inspection.filePath, 'r');
    return new RandomAccessSource({
        handle,
        size: inspection.size,
        filePath: inspection.filePath,
    });
}

async function prepareMessagePackSource(input, inspection, tempDir = null) {
    if (inspection.format === 'raw') {
        const source = await openBaseSource(inspection);
        return {
            source,
            payloadOffset: inspection.payloadOffset,
            cleanup: () => source.close(),
        };
    }

    const tempBase = inspection.filePath
        ? inspection.filePath
        : path.join(tempDir ?? os.tmpdir(), `.risu-stream-load-${process.pid}`);
    const tempPath = `${tempBase}.decoded-${nodeCrypto.randomUUID()}.tmp`;
    const inputStream = inspection.buffer
        ? Readable.from([inspection.buffer.subarray(inspection.payloadOffset)])
        : createReadStream(inspection.filePath, { start: inspection.payloadOffset });
    const decompressor = inspection.compression === 'gzip'
        ? zlib.createGunzip()
        : zlib.createInflate();

    try {
        await pipeline(inputStream, decompressor, createWriteStream(tempPath, { flags: 'wx' }));
    } catch (error) {
        await fs.unlink(tempPath).catch(() => {});
        throw new Error(`Failed to decompress streaming Risu save: ${error.message}`, { cause: error });
    }

    let handle;
    let stat;
    try {
        handle = await fs.open(tempPath, 'r');
        stat = await handle.stat();
    } catch (error) {
        await handle?.close().catch(() => {});
        await fs.unlink(tempPath).catch(() => {});
        throw error;
    }
    const source = new RandomAccessSource({ handle, size: stat.size, filePath: tempPath });
    return {
        source,
        payloadOffset: 0,
        cleanup: async () => {
            await source.close().catch(() => {});
            await fs.unlink(tempPath).catch(() => {});
        },
    };
}

/**
 * Incrementally walk the plain-map MessagePack payload of a supported Risu save.
 * Only one chat (or one externalized plugin value) is decoded at a time.
 */
async function walkRisuSave(input, options = {}) {
    if (options.externalizePluginStorage
        && typeof options.onPluginStorageEntry !== 'function') {
        throw new TypeError('onPluginStorageEntry is required when plugin storage is externalized');
    }
    const inspection = options.inspection ?? await inspectRisuSaveSource(input);
    if (!inspection.supported) {
        throw new Error('Risu save format is not supported by the streaming loader');
    }

    const prepared = await prepareMessagePackSource(input, inspection, options.tempDir);
    try {
        const source = prepared.source;
        const rootCursor = source.cursor(prepared.payloadOffset);
        const rootStart = rootCursor.position;
        const rootCount = await readCollectionCount(rootCursor, 'map');
        const rootEntries = [];
        const rootIndexByKey = new Map();
        for (let index = 0; index < rootCount; index++) {
            const keyDescriptor = await skipMessagePackValue(rootCursor);
            const decodedKey = await decodeDescriptor(source, keyDescriptor);
            const key = typeof decodedKey === 'string' ? decodedKey : String(decodedKey);
            const descriptor = await skipMessagePackValue(rootCursor);
            const priorIndex = rootIndexByKey.get(key);
            if (priorIndex === undefined) {
                rootIndexByKey.set(key, rootEntries.length);
                rootEntries.push({ key, descriptor });
            } else {
                rootEntries[priorIndex].descriptor = descriptor;
            }
        }
        if (rootCursor.position !== source.size) {
            throw new Error(`Trailing bytes after MessagePack root at byte ${rootCursor.position}`);
        }

        const byKey = new Map(rootEntries.map(entry => [entry.key, entry]));
        const assignedChatIds = options.onMissingChatId
            ? await collectAssignedChatIds(
                source,
                byKey.get('characters')?.descriptor,
                options.onMissingChatId
            )
            : new Map();
        const foldedMarkerEntry = byKey.get(PLUGIN_STORAGE_FOLDED_MARKER);
        const pluginStorageFolded = foldedMarkerEntry
            ? normalizeJSON(await decodeDescriptor(source, foldedMarkerEntry.descriptor)) === true
            : false;
        let externalizePlugins = false;
        if (options.externalizePluginStorage) {
            const optimizeEntry = byKey.get('optimizePluginMemory');
            const optimize = optimizeEntry
                ? normalizeJSON(await decodeDescriptor(source, optimizeEntry.descriptor))
                : undefined;
            const valueEntry = byKey.get('pluginCustomStorage');
            const metaEntry = byKey.get('pluginStorageMeta');
            let hasValues = false;
            if (valueEntry) {
                if (await descriptorCollectionKind(source, valueEntry.descriptor) === 'map') {
                    const cursor = source.cursor(valueEntry.descriptor.offset);
                    hasValues = (await readCollectionCount(cursor, 'map')) > 0;
                } else {
                    const value = normalizeJSON(await decodeDescriptor(source, valueEntry.descriptor));
                    hasValues = value !== null && typeof value === 'object'
                        && Object.keys(value).length > 0;
                }
            }
            let hasMetaField = false;
            if (metaEntry) {
                const kind = await descriptorCollectionKind(source, metaEntry.descriptor);
                hasMetaField = kind === 'map'
                    || normalizeJSON(await decodeDescriptor(source, metaEntry.descriptor)) !== undefined;
            }
            externalizePlugins = pluginStorageFolded
                || (optimize === true && (hasValues || hasMetaField));
            if (pluginStorageFolded) {
                if (typeof options.onPluginStorageFolded !== 'function') {
                    throw new TypeError(
                        'onPluginStorageFolded is required for a folded plugin storage snapshot'
                    );
                }
                await options.onPluginStorageFolded();
            }
        }

        const remainder = {};
        const pluginStats = { changed: externalizePlugins, values: 0, meta: 0 };
        for (const entry of rootEntries) {
            if (entry.key === PLUGIN_STORAGE_FOLDED_MARKER) {
                continue;
            } else if (entry.key === 'characters') {
                assignNormalizedProperty(
                    remainder,
                    entry.key,
                    await processCharacters(source, entry.descriptor, {
                        ...options,
                        assignedChatIds,
                    })
                );
            } else if (externalizePlugins && entry.key === 'pluginCustomStorage') {
                if (await descriptorCollectionKind(source, entry.descriptor) === 'map') {
                    pluginStats.values = await processPluginMap(
                        source,
                        entry.descriptor,
                        entry.key,
                        options.onPluginStorageEntry
                    );
                } else {
                    const value = normalizeJSON(await decodeDescriptor(source, entry.descriptor));
                    for (const [key, rowValue] of Object.entries(value ?? {})) {
                        await options.onPluginStorageEntry({ field: entry.key, key, value: rowValue });
                        pluginStats.values++;
                    }
                }
                remainder.pluginCustomStorage = {};
            } else if (externalizePlugins && entry.key === 'pluginStorageMeta') {
                if (await descriptorCollectionKind(source, entry.descriptor) === 'map') {
                    pluginStats.meta = await processPluginMap(
                        source,
                        entry.descriptor,
                        entry.key,
                        options.onPluginStorageEntry
                    );
                } else {
                    const value = normalizeJSON(await decodeDescriptor(source, entry.descriptor));
                    for (const [key, rowValue] of Object.entries(value ?? {})) {
                        await options.onPluginStorageEntry({ field: entry.key, key, value: rowValue });
                        pluginStats.meta++;
                    }
                }
            } else {
                const decoded = await decodeDescriptor(source, entry.descriptor);
                if (entry.key === 'botPresets') {
                    // decodeRisuSave performs this migration before normalizeJSON.
                    // Preserve that order for unusual truthy non-string ids.
                    ensureBotPresetIds({ botPresets: decoded });
                }
                assignNormalizedProperty(
                    remainder,
                    entry.key,
                    decoded
                );
            }
        }
        if (externalizePlugins
            && !Object.prototype.hasOwnProperty.call(remainder, 'pluginCustomStorage')) {
            remainder.pluginCustomStorage = {};
        }

        return {
            remainder,
            pluginStats,
            format: inspection.format,
            messagePackBytes: source.size - rootStart,
        };
    } finally {
        await prepared.cleanup();
    }
}

async function scanMessagePackValue(input) {
    const normalized = normalizeInput(input);
    if (!normalized.buffer) {
        throw new TypeError('scanMessagePackValue requires a Buffer or Uint8Array');
    }
    const source = new RandomAccessSource({
        buffer: normalized.buffer,
        size: normalized.buffer.length,
    });
    const cursor = source.cursor();
    const descriptor = await skipMessagePackValue(cursor);
    if (cursor.position !== source.size) {
        throw new Error(`Trailing bytes after MessagePack value at byte ${cursor.position}`);
    }
    return descriptor.length;
}

module.exports = {
    DEFAULT_STREAM_INGEST_MIN_BYTES,
    configuredStreamIngestMinBytes,
    inspectRisuSaveSource,
    shouldStreamRisuSave,
    scanMessagePackValue,
    skipMessagePackValue,
    walkRisuSave,
};
