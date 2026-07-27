'use strict';

const { createReadStream, createWriteStream } = require('fs');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const nodeCrypto = require('crypto');
const zlib = require('zlib');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { Unpackr } = require('msgpackr');
const {
    decodeRisuSave,
    ensureBotPresetIds,
    magicHeader,
    magicCompressedHeader,
    magicStreamCompressedHeader,
    magicPluginStorageHeader,
    magicPluginStorageCompressedHeader,
    magicPluginStorageStreamHeader,
    normalizeJSON,
    RisuSaveType,
    parseLegacyPluginStorageEnvelope,
    pluginStorageLegacyEscapeField,
    restoreLegacyPluginStorageKeys,
} = require('./utils.cjs');
const {
    PLUGIN_SAVE_PREFIX,
    PLUGIN_SAVE_META_PREFIX,
    PLUGIN_STORAGE_FOLDED_MARKER,
} = require('./pluginSaveKeys.cjs');
const {
    PluginStorageValidationError,
    encodeValidatedPluginStorageKey,
    snapshotPluginStorageJson,
    snapshotPluginStorageRecord,
} = require('./pluginStorageJson.cjs');

const DEFAULT_STREAM_INGEST_MIN_BYTES = 32 * 1024 * 1024;
const CURSOR_CACHE_BYTES = 64 * 1024;
const DECODE_OUTPUT_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_DECODED_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_DECODE_DISK_HEADROOM_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_LEGACY_RESTORE_BYTES = 64 * 1024 * 1024;
const unpackr = new Unpackr({ int64AsType: 'number', useRecords: false });
const streamingCallbackErrors = new WeakSet();
const JSON_RISU_SAVE_TYPES = new Set(Object.values(RisuSaveType));

function guardStreamingCallback(callback, synchronous = false) {
    if (typeof callback !== 'function') return callback;
    const markAndRethrow = (error) => {
        if (error && (typeof error === 'object' || typeof error === 'function')) {
            streamingCallbackErrors.add(error);
            throw error;
        }
        const wrapped = new Error(`Streaming callback failed: ${String(error)}`);
        wrapped.streamingCallbackCause = error;
        streamingCallbackErrors.add(wrapped);
        throw wrapped;
    };
    if (synchronous) {
        return (...args) => {
            try {
                return callback(...args);
            } catch (error) {
                return markAndRethrow(error);
            }
        };
    }
    return async (...args) => {
        try {
            return await callback(...args);
        } catch (error) {
            return markAndRethrow(error);
        }
    };
}

class RisuSavePreparationLimitError extends Error {
    constructor(message, { code, limit, actual }) {
        super(message);
        this.name = 'RisuSavePreparationLimitError';
        this.code = code;
        this.status = 413;
        this.limit = limit;
        this.actual = actual;
        this.retryable = false;
        this.commitOutcome = 'not-committed';
        this.commitOutcomeUnknown = false;
        this.risuSavePreparationLimit = true;
    }
}

class RisuSavePreparationError extends Error {
    constructor(message, options = {}) {
        super(message, options);
        this.name = 'RisuSavePreparationError';
        this.code = 'RISU_SAVE_INVALID';
        this.status = 400;
        this.retryable = false;
        this.commitOutcome = 'not-committed';
        this.commitOutcomeUnknown = false;
        this.risuSavePreparationInvalid = true;
    }
}

function streamAbortError(signal) {
    const reason = signal?.reason;
    const error = reason instanceof Error
        ? new Error(reason.message, { cause: reason })
        : new Error('Streaming Risu load cancelled');
    error.name = 'AbortError';
    error.code = 'RISU_STREAM_ABORTED';
    return error;
}

function positiveSafeInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function configuredMaxDecodedBytes() {
    return positiveSafeInteger(
        process.env.RISU_RESTORE_MAX_DECODED_BYTES,
        DEFAULT_MAX_DECODED_BYTES,
    );
}

function configuredDecodeDiskHeadroomBytes() {
    const parsed = Number(process.env.RISU_RESTORE_DISK_HEADROOM_BYTES);
    return Number.isSafeInteger(parsed) && parsed >= 0
        ? parsed
        : DEFAULT_DECODE_DISK_HEADROOM_BYTES;
}

function configuredMaxLegacyRestoreBytes() {
    return positiveSafeInteger(
        process.env.RISU_RESTORE_MAX_LEGACY_BYTES,
        DEFAULT_MAX_LEGACY_RESTORE_BYTES,
    );
}

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
    const legacyPrefix = Buffer.from('\x00\x00RISU', 'binary');
    const risuSavePrefix = Buffer.from('RISUSAVE\x00', 'binary');
    const { normalized, prefix } = await readInputPrefix(
        input,
        Math.max(headerBytes + 2, risuSavePrefix.length),
    );
    let format = null;
    let compression = null;
    let pluginStorageEscapes = false;
    let boundedFallback = false;

    if (startsWith(prefix, magicHeader)) {
        format = 'raw';
    } else if (startsWith(prefix, magicCompressedHeader)) {
        format = 'compressed';
        const first = prefix[headerBytes];
        const second = prefix[headerBytes + 1];
        if (first === 0x1f && second === 0x8b) compression = 'gzip';
        else if (isZlibHeader(first, second)) compression = 'zlib';
        else compression = 'deflate-raw';
    } else if (startsWith(prefix, magicStreamCompressedHeader)) {
        format = 'stream';
        if (prefix[headerBytes] === 0x1f && prefix[headerBytes + 1] === 0x8b) {
            compression = 'gzip';
        }
    } else if (startsWith(prefix, magicPluginStorageHeader)) {
        format = 'raw';
        pluginStorageEscapes = true;
    } else if (startsWith(prefix, magicPluginStorageCompressedHeader)) {
        format = 'compressed';
        pluginStorageEscapes = true;
        const first = prefix[headerBytes];
        const second = prefix[headerBytes + 1];
        if (first === 0x1f && second === 0x8b) compression = 'gzip';
        else if (isZlibHeader(first, second)) compression = 'zlib';
        else compression = 'deflate-raw';
    } else if (startsWith(prefix, magicPluginStorageStreamHeader)) {
        format = 'stream';
        pluginStorageEscapes = true;
        if (prefix[headerBytes] === 0x1f && prefix[headerBytes + 1] === 0x8b) {
            compression = 'gzip';
        }
    } else if (startsWith(prefix, legacyPrefix)) {
        // Very old PocketRisu/RisuAI saves prefixed a plain MessagePack map
        // with NUL NUL RISU. The cursor walker can safely skip that prefix.
        format = 'raw';
    } else if (startsWith(prefix, risuSavePrefix)) {
        // Block-oriented RisuSave can contain gzip members and REMOTE blocks.
        // It is validated under the explicit legacy preparation cap before the
        // compatibility decoder is allowed to materialize it.
        format = 'risusave';
        boundedFallback = true;
    } else if (
        (prefix[0] >= 0x80 && prefix[0] <= 0x8f)
        || prefix[0] === 0xde
        || prefix[0] === 0xdf
    ) {
        // Headerless legacy MessagePack root. This is as cursor-safe as a
        // canonical raw payload and avoids a whole-file read.
        format = 'raw';
    } else if (prefix[0] === 0x1f && prefix[1] === 0x8b) {
        format = 'legacy-compressed';
        compression = 'gzip';
        boundedFallback = true;
    } else if (isZlibHeader(prefix[0], prefix[1])) {
        // The historical catch-fallback accepts headerless zlib containing
        // either MessagePack or JSON. Prepare it to disk under a hard decoded
        // limit, then retain that decoder compatibility under a memory cap.
        format = 'legacy-compressed';
        compression = 'zlib';
        boundedFallback = true;
    } else {
        format = 'legacy-unknown';
        boundedFallback = true;
    }

    const supported = format === 'raw'
        || ((format === 'compressed' || format === 'stream') && compression !== null);
    const payloadOffset = startsWith(prefix, legacyPrefix)
        ? legacyPrefix.length
        : supported && format !== 'raw'
            ? headerBytes
            : startsWith(prefix, magicHeader)
                || startsWith(prefix, magicPluginStorageHeader)
                ? headerBytes
                : 0;
    return {
        ...normalized,
        format,
        compression,
        pluginStorageEscapes,
        payloadOffset,
        supported,
        boundedFallback,
        size: normalized.size,
    };
}

async function shouldStreamRisuSave(input, options = {}) {
    const inspection = options.inspection ?? await inspectRisuSaveSource(input);
    const minBytes = options.minBytes ?? configuredStreamIngestMinBytes();
    return inspection.supported && inspection.size >= minBytes;
}

class RandomAccessSource {
    constructor({
        buffer = null,
        handle = null,
        size,
        filePath = null,
        shouldAbort = () => false,
        signal = null,
    }) {
        this.buffer = buffer;
        this.handle = handle;
        this.size = size;
        this.filePath = filePath;
        this.shouldAbort = shouldAbort;
        this.signal = signal;
    }

    throwIfAborted() {
        if (!this.signal?.aborted && !this.shouldAbort()) return;
        throw streamAbortError(this.signal);
    }

    async readRange(offset, length) {
        this.throwIfAborted();
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
            || offset < 0 || length < 0 || offset + length > this.size) {
            throw new Error(`Truncated MessagePack payload at byte ${offset}`);
        }
        if (this.buffer) return this.buffer.subarray(offset, offset + length);
        const result = Buffer.allocUnsafe(length);
        let written = 0;
        while (written < length) {
            const read = await this.handle.read(
                result,
                written,
                Math.min(CURSOR_CACHE_BYTES, length - written),
                offset + written,
            );
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
        this.source.throwIfAborted();
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

    async readUInt32LE() {
        return (await this.readBytes(4)).readUInt32LE(0);
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
    const normalized = normalizeJSON(
        value,
        key === 'pluginCustomStorage' || key === 'pluginStorageMeta'
    );
    if (normalized !== undefined) {
        Object.defineProperty(target, key, {
            configurable: true,
            enumerable: true,
            value: normalized,
            writable: true,
        });
    }
}

function defineOwn(target, key, value) {
    Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
    });
}

function pluginStoragePrefixForField(field) {
    return field === 'pluginStorageMeta'
        ? PLUGIN_SAVE_META_PREFIX
        : PLUGIN_SAVE_PREFIX;
}

function snapshotStreamingPluginStorageValue(field, key, value) {
    const prefix = pluginStoragePrefixForField(field);
    const storageKey = encodeValidatedPluginStorageKey(key, prefix);
    try {
        return snapshotPluginStorageJson(value);
    } catch {
        throw new PluginStorageValidationError(storageKey);
    }
}

async function inspectStreamingPluginStorageRecord(source, entry, field) {
    if (!entry) {
        return { present: false, count: 0, decodedRecord: null };
    }
    if (await descriptorCollectionKind(source, entry.descriptor) === 'map') {
        const cursor = source.cursor(entry.descriptor.offset);
        return {
            present: true,
            count: await readCollectionCount(cursor, 'map'),
            decodedRecord: null,
        };
    }

    const decoded = await decodeDescriptor(source, entry.descriptor);
    if (field === 'pluginCustomStorage' && (decoded === null || decoded === undefined)) {
        return { present: true, count: 0, decodedRecord: Object.create(null) };
    }
    const prefix = pluginStoragePrefixForField(field);
    const record = snapshotPluginStorageRecord(decoded, field, prefix);
    return {
        present: true,
        count: Object.keys(record).length,
        decodedRecord: record,
    };
}

async function emitStreamingPluginStorageEntry(onEntry, field, key, value) {
    await onEntry({
        field,
        key,
        value: snapshotStreamingPluginStorageValue(field, key, value),
    });
}

async function processPluginMap(source, descriptor, field, onEntry, protoEscape = null) {
    const entries = await readMapDescriptors(source, descriptor);
    let count = 0;
    let entryIndex = 0;
    const insertAt = protoEscape === null
        ? -1
        : Math.min(protoEscape.index, entries.length);
    for (let index = 0; index < entries.length + (protoEscape === null ? 0 : 1); index++) {
        if (index === insertAt) {
            await emitStreamingPluginStorageEntry(
                onEntry,
                field,
                '__proto__',
                protoEscape.value
            );
            count++;
            continue;
        }
        const entry = entries[entryIndex++];
        const value = await decodeDescriptor(source, entry.descriptor);
        await emitStreamingPluginStorageEntry(onEntry, field, entry.key, value);
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

function throwIfPreparationAborted(shouldAbort, signal) {
    if (!signal?.aborted && !shouldAbort()) return;
    throw streamAbortError(signal);
}

async function availableBytesForPath(targetPath, override) {
    if (override !== undefined) {
        const parsed = Number(override);
        return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
    }
    try {
        const stat = await fs.statfs(path.dirname(targetPath));
        const available = Number(stat.bavail) * Number(stat.bsize);
        return Number.isSafeInteger(available) && available >= 0 ? available : null;
    } catch {
        return null;
    }
}

async function decodedOutputLimit(tempPath, options) {
    const maxDecodedBytes = positiveSafeInteger(
        options.maxDecodedBytes,
        configuredMaxDecodedBytes(),
    );
    const diskHeadroomBytes = options.diskHeadroomBytes === undefined
        ? configuredDecodeDiskHeadroomBytes()
        : Math.max(0, Number(options.diskHeadroomBytes) || 0);
    const availableBytes = await availableBytesForPath(
        tempPath,
        options.availableDiskBytes,
    );
    const diskLimit = availableBytes === null
        ? maxDecodedBytes
        : Math.max(0, Math.floor(availableBytes - diskHeadroomBytes));
    const limit = Math.min(maxDecodedBytes, diskLimit);
    const code = diskLimit < maxDecodedBytes
        ? 'RISU_SAVE_DECODE_DISK_HEADROOM'
        : 'RISU_SAVE_DECODED_TOO_LARGE';
    if (limit <= 0) {
        throw new RisuSavePreparationLimitError(
            'Insufficient disk headroom to prepare this snapshot safely',
            { code, limit: 0, actual: 1 },
        );
    }
    return { limit, code };
}

function createDecodedOutputMeter({
    limit,
    limitCode,
    shouldAbort,
    signal,
    onDecodedChunk,
}) {
    let total = 0;
    return new Transform({
        readableHighWaterMark: DECODE_OUTPUT_CHUNK_BYTES,
        writableHighWaterMark: DECODE_OUTPUT_CHUNK_BYTES,
        async transform(chunk, _encoding, callback) {
            try {
                throwIfPreparationAborted(shouldAbort, signal);
                const bytes = Buffer.from(chunk);
                for (let offset = 0; offset < bytes.length; offset += DECODE_OUTPUT_CHUNK_BYTES) {
                    throwIfPreparationAborted(shouldAbort, signal);
                    const piece = bytes.subarray(
                        offset,
                        Math.min(bytes.length, offset + DECODE_OUTPUT_CHUNK_BYTES),
                    );
                    const next = total + piece.length;
                    if (!Number.isSafeInteger(next) || next > limit) {
                        throw new RisuSavePreparationLimitError(
                            `Decoded Risu save exceeds the safe preparation limit (${limit} bytes)`,
                            { code: limitCode, limit, actual: next },
                        );
                    }
                    total = next;
                    if (onDecodedChunk) await onDecodedChunk({ bytes: piece.length, total });
                    this.push(piece);
                }
                callback();
            } catch (error) {
                callback(error);
            }
        },
    });
}

async function decompressToBoundedFile({
    inspection,
    tempPath,
    shouldAbort = () => false,
    signal = null,
    maxDecodedBytes,
    diskHeadroomBytes,
    availableDiskBytes,
    onDecodedChunk,
}) {
    throwIfPreparationAborted(shouldAbort, signal);
    const { limit, code } = await decodedOutputLimit(tempPath, {
        maxDecodedBytes,
        diskHeadroomBytes,
        availableDiskBytes,
    });
    const inputStream = inspection.buffer
        ? Readable.from([inspection.buffer.subarray(inspection.payloadOffset)])
        : createReadStream(inspection.filePath, {
            start: inspection.payloadOffset,
            highWaterMark: DECODE_OUTPUT_CHUNK_BYTES,
        });
    const decompressor = inspection.compression === 'gzip'
        ? zlib.createGunzip({ chunkSize: DECODE_OUTPUT_CHUNK_BYTES })
        : inspection.compression === 'deflate-raw'
            ? zlib.createInflateRaw({ chunkSize: DECODE_OUTPUT_CHUNK_BYTES })
            : zlib.createInflate({ chunkSize: DECODE_OUTPUT_CHUNK_BYTES });
    const meter = createDecodedOutputMeter({
        limit,
        limitCode: code,
        shouldAbort,
        signal,
        onDecodedChunk,
    });
    const output = createWriteStream(tempPath, {
        flags: 'wx',
        highWaterMark: DECODE_OUTPUT_CHUNK_BYTES,
    });
    try {
        await pipeline(inputStream, decompressor, meter, output, signal ? { signal } : {});
    } catch (error) {
        await fs.unlink(tempPath).catch(() => {});
        if (error?.risuSavePreparationLimit) throw error;
        if (error?.code === 'RISU_STREAM_ABORTED' || signal?.aborted || shouldAbort()) {
            throw streamAbortError(signal);
        }
        throw new RisuSavePreparationError(`Failed to decompress streaming Risu save: ${error.message}`, {
            cause: error,
        });
    }
    return { filePath: tempPath, size: meter.readableLength, limit };
}

async function openBaseSource(inspection, shouldAbort, signal = null) {
    if (inspection.buffer) {
        return new RandomAccessSource({
            buffer: inspection.buffer,
            size: inspection.buffer.length,
            shouldAbort,
            signal,
        });
    }
    const handle = await fs.open(inspection.filePath, 'r');
    return new RandomAccessSource({
        handle,
        size: inspection.size,
        filePath: inspection.filePath,
        shouldAbort,
        signal,
    });
}

async function prepareMessagePackSource(
    input,
    inspection,
    tempDir = null,
    shouldAbort = () => false,
    options = {},
) {
    if (inspection.format === 'raw') {
        const source = await openBaseSource(inspection, shouldAbort, options.signal);
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
    try {
        await decompressToBoundedFile({
            inspection,
            tempPath,
            shouldAbort,
            signal: options.signal,
            maxDecodedBytes: options.maxDecodedBytes,
            diskHeadroomBytes: options.diskHeadroomBytes,
            availableDiskBytes: options.availableDiskBytes,
            onDecodedChunk: options.onDecodedChunk,
        });
    } catch (error) {
        await fs.unlink(tempPath).catch(() => {});
        throw error;
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
    const source = new RandomAccessSource({
        handle,
        size: stat.size,
        filePath: tempPath,
        shouldAbort,
        signal: options.signal,
    });
    return {
        source,
        payloadOffset: 0,
        cleanup: async () => {
            await source.close().catch(() => {});
            await fs.unlink(tempPath).catch(() => {});
        },
    };
}

function legacySourceLimitError(limit, actual) {
    return new RisuSavePreparationLimitError(
        `Legacy Risu save exceeds the finite restore limit (${limit} bytes)`,
        {
            code: 'RISU_SAVE_LEGACY_TOO_LARGE',
            limit,
            actual,
        },
    );
}

async function readBoundedInput(input, inspection, limit) {
    if (inspection.size > limit) throw legacySourceLimitError(limit, inspection.size);
    if (inspection.buffer) return Buffer.from(inspection.buffer);
    const value = await fs.readFile(inspection.filePath);
    if (value.length > limit) throw legacySourceLimitError(limit, value.length);
    return value;
}

function decodePreparedLegacyPayload(bytes, pluginStorageEscapes = false) {
    let decoded;
    try {
        decoded = unpackr.decode(bytes);
    } catch (messagePackError) {
        try {
            decoded = JSON.parse(Buffer.from(bytes).toString('utf-8'));
        } catch (jsonError) {
            throw new RisuSavePreparationError(
                `Failed to decode bounded legacy Risu save: msgpack=${messagePackError.message}; json=${jsonError.message}`,
                { cause: jsonError },
            );
        }
    }
    return pluginStorageEscapes ? restoreLegacyPluginStorageKeys(decoded) : decoded;
}

async function verifyRisuSaveBlocksBounded(input, inspection, options) {
    const maxDecodedBytes = positiveSafeInteger(
        options.maxDecodedBytes,
        configuredMaxDecodedBytes(),
    );
    const source = await openBaseSource(inspection, options.shouldAbort, options.signal);
    let decodedBytes = 0;
    try {
        const cursor = source.cursor(Buffer.byteLength('RISUSAVE\x00', 'binary'));
        while (cursor.position < source.size) {
            throwIfPreparationAborted(options.shouldAbort, options.signal);
            const type = await cursor.readUInt8();
            const compressed = await cursor.readUInt8() === 1;
            const nameLength = await cursor.readUInt8();
            await cursor.readBytes(nameLength);
            const length = await cursor.readUInt32LE();
            const bodyOffset = cursor.position;
            cursor.skip(length);

            let body;
            if (compressed) {
                const compressedBody = await source.readRange(bodyOffset, length);
                const tempBase = inspection.filePath
                    ? inspection.filePath
                    : path.join(options.tempDir ?? os.tmpdir(), `.risu-legacy-block-${process.pid}`);
                const tempPath = `${tempBase}.block-decoded-${nodeCrypto.randomUUID()}.tmp`;
                const remaining = maxDecodedBytes - decodedBytes;
                if (remaining <= 0) throw legacySourceLimitError(maxDecodedBytes, decodedBytes + 1);
                try {
                    await decompressToBoundedFile({
                        inspection: {
                            buffer: compressedBody,
                            payloadOffset: 0,
                            compression: 'gzip',
                        },
                        tempPath,
                        shouldAbort: options.shouldAbort,
                        signal: options.signal,
                        maxDecodedBytes: remaining,
                        diskHeadroomBytes: options.diskHeadroomBytes,
                        availableDiskBytes: options.availableDiskBytes,
                        onDecodedChunk: options.onDecodedChunk,
                    });
                    body = await fs.readFile(tempPath);
                } finally {
                    await fs.unlink(tempPath).catch(() => {});
                }
            } else {
                body = await source.readRange(bodyOffset, length);
            }

            decodedBytes += body.length;
            if (!Number.isSafeInteger(decodedBytes) || decodedBytes > maxDecodedBytes) {
                throw legacySourceLimitError(maxDecodedBytes, decodedBytes);
            }

            let parsedBody;
            if (JSON_RISU_SAVE_TYPES.has(type)) {
                try {
                    parsedBody = JSON.parse(body.toString('utf-8'));
                } catch (error) {
                    throw new RisuSavePreparationError(
                        `Invalid JSON in RisuSave block type ${type}: ${error.message}`,
                        { cause: error },
                    );
                }
            }

            if (type === RisuSaveType.REMOTE) {
                const remoteInfo = parsedBody;
                if (!remoteInfo || typeof remoteInfo.name !== 'string'
                    || remoteInfo.name.length === 0
                    || !JSON_RISU_SAVE_TYPES.has(remoteInfo.type)) {
                    throw new RisuSavePreparationError('Invalid REMOTE block metadata');
                }
            }
        }
        if (cursor.position !== source.size) {
            throw new Error(`Trailing bytes after RisuSave blocks at byte ${cursor.position}`);
        }
        return { decodedBytes };
    } catch (error) {
        if (error?.risuSavePreparationLimit
            || error?.risuSavePreparationInvalid
            || error?.code === 'RISU_STREAM_ABORTED') throw error;
        throw new RisuSavePreparationError(
            `Invalid block-oriented Risu save: ${error?.message ?? error}`,
            { cause: error },
        );
    } finally {
        await source.close();
    }
}

function createBoundedCachedRemoteResolver({
    resolveRemote,
    resolveRemoteSize,
    initialDecodedBytes,
    maxDecodedBytes,
    shouldAbort,
    signal,
}) {
    if (typeof resolveRemote !== 'function') return null;
    if (typeof resolveRemoteSize !== 'function') {
        throw new RisuSavePreparationError(
            'REMOTE restore requires a logical-size resolver before materialization',
        );
    }
    const cache = new Map();
    let decodedBytes = initialDecodedBytes;

    return async (name) => {
        throwIfPreparationAborted(shouldAbort, signal);
        if (cache.has(name)) return cache.get(name);

        const pending = (async () => {
            let logicalSize;
            try {
                logicalSize = await resolveRemoteSize(name);
            } catch (cause) {
                const error = new Error(
                    `Failed to size referenced REMOTE block ${name}`,
                    { cause },
                );
                error.code = 'RISU_SAVE_REMOTE_READ_FAILED';
                error.risuSaveRemoteResolutionFailure = true;
                throw error;
            }
            throwIfPreparationAborted(shouldAbort, signal);
            if (logicalSize === null || logicalSize === undefined) {
                throw new RisuSavePreparationError(
                    `Referenced REMOTE block ${name} is missing`,
                );
            }
            if (!Number.isSafeInteger(logicalSize) || logicalSize < 0) {
                throw new RisuSavePreparationError(
                    `REMOTE block ${name} has an invalid logical size`,
                );
            }
            const reservedTotal = decodedBytes + logicalSize;
            if (!Number.isSafeInteger(reservedTotal) || reservedTotal > maxDecodedBytes) {
                throw legacySourceLimitError(maxDecodedBytes, reservedTotal);
            }

            // Reserve against the cumulative decoded budget before kvGet can
            // reassemble a chunked value. Duplicate references use this same
            // promise and therefore neither allocate nor count twice.
            decodedBytes = reservedTotal;
            let resolved;
            try {
                resolved = await resolveRemote(name);
            } catch (cause) {
                const error = new Error(
                    `Failed to read referenced REMOTE block ${name}`,
                    { cause },
                );
                error.code = 'RISU_SAVE_REMOTE_READ_FAILED';
                error.risuSaveRemoteResolutionFailure = true;
                throw error;
            }
            throwIfPreparationAborted(shouldAbort, signal);
            if (resolved === null || resolved === undefined) {
                throw new RisuSavePreparationError(
                    `Referenced REMOTE block ${name} disappeared during restore`,
                );
            }
            if (!Buffer.isBuffer(resolved) && !(resolved instanceof Uint8Array)) {
                throw new RisuSavePreparationError(
                    `REMOTE block ${name} did not resolve to bytes`,
                );
            }
            const actualSize = resolved.byteLength;
            const actualTotal = decodedBytes - logicalSize + actualSize;
            if (!Number.isSafeInteger(actualTotal) || actualTotal > maxDecodedBytes) {
                throw legacySourceLimitError(maxDecodedBytes, actualTotal);
            }
            decodedBytes = actualTotal;
            return resolved;
        })();
        cache.set(name, pending);
        return pending;
    };
}

/**
 * Decode inspector-unsupported compatibility formats under an explicit finite
 * memory contract. Headerless compressed saves are expanded through the same
 * disk-backed meter as canonical gzip/zlib. Block/REMOTE and unknown formats
 * remain in-memory only below the legacy cap, with compressed block output
 * pre-validated before the historical decoder runs.
 */
async function decodeBoundedLegacyRisuSave(input, options = {}) {
    const inspection = options.inspection ?? await inspectRisuSaveSource(input);
    const shouldAbort = options.shouldAbort ?? (() => false);
    const maxLegacyBytes = positiveSafeInteger(
        options.maxLegacyBytes,
        configuredMaxLegacyRestoreBytes(),
    );
    throwIfPreparationAborted(shouldAbort, options.signal);

    if (inspection.format === 'legacy-compressed'
        || ((inspection.format === 'compressed' || inspection.format === 'stream')
            && !inspection.supported)) {
        const tempBase = inspection.filePath
            ? inspection.filePath
            : path.join(options.tempDir ?? os.tmpdir(), `.risu-legacy-load-${process.pid}`);
        const tempPath = `${tempBase}.decoded-${nodeCrypto.randomUUID()}.tmp`;
        try {
            await decompressToBoundedFile({
                inspection: inspection.compression
                    ? inspection
                    : { ...inspection, compression: 'deflate-raw' },
                tempPath,
                shouldAbort,
                signal: options.signal,
                maxDecodedBytes: Math.min(
                    maxLegacyBytes,
                    positiveSafeInteger(options.maxDecodedBytes, configuredMaxDecodedBytes()),
                ),
                diskHeadroomBytes: options.diskHeadroomBytes,
                availableDiskBytes: options.availableDiskBytes,
                onDecodedChunk: options.onDecodedChunk,
            });
            const stat = await fs.stat(tempPath);
            if (stat.size > maxLegacyBytes) throw legacySourceLimitError(maxLegacyBytes, stat.size);
            return decodePreparedLegacyPayload(
                await fs.readFile(tempPath),
                inspection.pluginStorageEscapes,
            );
        } finally {
            await fs.unlink(tempPath).catch(() => {});
        }
    }

    if (inspection.format === 'legacy-unknown') {
        // The old catch-fallback also accepted raw-deflate JSON/MessagePack.
        // Probe it through the bounded meter; a normal unknown/corrupt source
        // falls back to the explicitly capped compatibility decoder.
        const tempBase = inspection.filePath
            ? inspection.filePath
            : path.join(options.tempDir ?? os.tmpdir(), `.risu-legacy-load-${process.pid}`);
        const tempPath = `${tempBase}.decoded-${nodeCrypto.randomUUID()}.tmp`;
        try {
            try {
                await decompressToBoundedFile({
                    inspection: { ...inspection, compression: 'deflate-raw', payloadOffset: 0 },
                    tempPath,
                    shouldAbort,
                    signal: options.signal,
                    maxDecodedBytes: Math.min(
                        maxLegacyBytes,
                        positiveSafeInteger(options.maxDecodedBytes, configuredMaxDecodedBytes()),
                    ),
                    diskHeadroomBytes: options.diskHeadroomBytes,
                    availableDiskBytes: options.availableDiskBytes,
                    onDecodedChunk: options.onDecodedChunk,
                });
                return decodePreparedLegacyPayload(await fs.readFile(tempPath));
            } catch (error) {
                if (error?.risuSavePreparationLimit
                    || error?.code === 'RISU_STREAM_ABORTED') throw error;
            }
        } finally {
            await fs.unlink(tempPath).catch(() => {});
        }
    }

    const raw = await readBoundedInput(input, inspection, maxLegacyBytes);
    let boundedRemoteResolver = null;
    let strictBlockDecodedBytes = null;
    if (inspection.format === 'risusave') {
        const maxDecodedBytes = Math.min(
            maxLegacyBytes,
            positiveSafeInteger(options.maxDecodedBytes, configuredMaxDecodedBytes()),
        );
        const verified = await verifyRisuSaveBlocksBounded(input, inspection, {
            ...options,
            shouldAbort,
            maxDecodedBytes,
        });
        boundedRemoteResolver = createBoundedCachedRemoteResolver({
            resolveRemote: options.resolveRemote,
            resolveRemoteSize: options.resolveRemoteSize,
            initialDecodedBytes: verified.decodedBytes,
            maxDecodedBytes,
            shouldAbort,
            signal: options.signal,
        });
        strictBlockDecodedBytes = maxDecodedBytes;
    }
    throwIfPreparationAborted(shouldAbort, options.signal);
    try {
        return await decodeRisuSave(raw, {
            resolveRemote: boundedRemoteResolver,
            strictBlockJson: inspection.format === 'risusave',
            signal: options.signal,
            maxDecodedBytes: strictBlockDecodedBytes ?? maxLegacyBytes,
            onCompressedBlockDecode: options.onCompressedBlockDecode,
            onCompressedBlockDecodedChunk: options.onCompressedBlockDecodedChunk,
        });
    } catch (error) {
        if (error?.risuSavePreparationLimit
            || error?.risuSavePreparationInvalid
            || error?.risuSaveRemoteResolutionFailure
            || error?.code === 'RISU_STREAM_ABORTED') throw error;
        throw new RisuSavePreparationError(
            `Invalid bounded legacy Risu save: ${error?.message ?? error}`,
            { cause: error },
        );
    }
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
    options = {
        ...options,
        onMissingChatId: guardStreamingCallback(options.onMissingChatId),
        onChat: guardStreamingCallback(options.onChat),
        onPluginStorageEntry: guardStreamingCallback(options.onPluginStorageEntry),
        onPluginStorageFolded: guardStreamingCallback(options.onPluginStorageFolded),
        retainCharacterChats: guardStreamingCallback(options.retainCharacterChats, true),
    };

    const prepared = await prepareMessagePackSource(
        input,
        inspection,
        options.tempDir,
        options.shouldAbort,
        {
            signal: options.signal,
            maxDecodedBytes: options.maxDecodedBytes,
            diskHeadroomBytes: options.diskHeadroomBytes,
            availableDiskBytes: options.availableDiskBytes,
            onDecodedChunk: options.onDecodedChunk,
        },
    );
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
        const pluginStorageEscapeEntry = inspection.pluginStorageEscapes
            ? byKey.get(pluginStorageLegacyEscapeField)
            : null;
        const pluginStorageEscapeEnvelope = pluginStorageEscapeEntry
            ? parseLegacyPluginStorageEnvelope(
                await decodeDescriptor(source, pluginStorageEscapeEntry.descriptor)
            )
            : null;
        const escapedPluginFields = new Set(
            pluginStorageEscapeEnvelope?.escapes.map(escape => escape.field) ?? []
        );
        const pluginStorageEscapeByField = new Map(
            pluginStorageEscapeEnvelope?.escapes.map(escape => [escape.field, escape]) ?? []
        );
        let externalizePlugins = false;
        let strictPluginStorageActive = false;
        let valueRecordInspection = { present: false, count: 0, decodedRecord: null };
        let metaRecordInspection = { present: false, count: 0, decodedRecord: null };
        if (options.externalizePluginStorage) {
            const optimizeEntry = byKey.get('optimizePluginMemory');
            const optimize = optimizeEntry
                ? normalizeJSON(await decodeDescriptor(source, optimizeEntry.descriptor))
                : undefined;
            const valueEntry = byKey.get('pluginCustomStorage');
            const metaEntry = byKey.get('pluginStorageMeta');
            strictPluginStorageActive = pluginStorageFolded || optimize === true;
            if (strictPluginStorageActive) {
                // Match snapshotOptimizedPluginStorageFields exactly before
                // deciding whether an optimized record is empty. In
                // particular, null/missing values canonicalize to {}, while
                // arrays/primitives and any present invalid metadata reject.
                valueRecordInspection = await inspectStreamingPluginStorageRecord(
                    source,
                    valueEntry,
                    'pluginCustomStorage'
                );
                metaRecordInspection = await inspectStreamingPluginStorageRecord(
                    source,
                    metaEntry,
                    'pluginStorageMeta'
                );
            }
            const hasValues = valueRecordInspection.count > 0
                || escapedPluginFields.has('pluginCustomStorage');
            const hasMetaField = metaRecordInspection.present
                || escapedPluginFields.has('pluginStorageMeta');
            externalizePlugins = pluginStorageFolded
                || (strictPluginStorageActive && (hasValues || hasMetaField));
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
        const processedExternalEscapes = new Set();
        for (const entry of rootEntries) {
            if (entry.key === PLUGIN_STORAGE_FOLDED_MARKER) {
                continue;
            } else if (entry.key === pluginStorageLegacyEscapeField
                && pluginStorageEscapeEnvelope !== null) {
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
                        options.onPluginStorageEntry,
                        pluginStorageEscapeByField.get(entry.key) ?? null
                    );
                    if (pluginStorageEscapeByField.has(entry.key)) {
                        processedExternalEscapes.add(entry.key);
                    }
                } else {
                    for (const [key, rowValue] of Object.entries(
                        valueRecordInspection.decodedRecord ?? {}
                    )) {
                        await emitStreamingPluginStorageEntry(
                            options.onPluginStorageEntry,
                            entry.key,
                            key,
                            rowValue
                        );
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
                        options.onPluginStorageEntry,
                        pluginStorageEscapeByField.get(entry.key) ?? null
                    );
                    if (pluginStorageEscapeByField.has(entry.key)) {
                        processedExternalEscapes.add(entry.key);
                    }
                } else {
                    for (const [key, rowValue] of Object.entries(
                        metaRecordInspection.decodedRecord ?? {}
                    )) {
                        await emitStreamingPluginStorageEntry(
                            options.onPluginStorageEntry,
                            entry.key,
                            key,
                            rowValue
                        );
                        pluginStats.meta++;
                    }
                }
            } else if (strictPluginStorageActive && entry.key === 'pluginCustomStorage') {
                // An optimized empty/null value record is still canonicalized
                // to the same empty object as the non-stream path.
                remainder.pluginCustomStorage = {};
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
        if (pluginStorageEscapeEnvelope !== null) {
            for (const escape of pluginStorageEscapeEnvelope.escapes) {
                const value = escape.value;
                if (externalizePlugins) {
                    if (processedExternalEscapes.has(escape.field)) continue;
                    await emitStreamingPluginStorageEntry(
                        options.onPluginStorageEntry,
                        escape.field,
                        '__proto__',
                        value
                    );
                    if (escape.field === 'pluginCustomStorage') pluginStats.values++;
                    else pluginStats.meta++;
                } else {
                    const current = remainder[escape.field];
                    const sourceRecord = current && typeof current === 'object' && !Array.isArray(current)
                        ? current
                        : {};
                    const record = {};
                    const keys = Object.keys(sourceRecord);
                    const insertAt = Math.min(escape.index, keys.length);
                    for (let index = 0; index <= keys.length; index++) {
                        if (index === insertAt) defineOwn(record, '__proto__', value);
                        if (index < keys.length) {
                            defineOwn(record, keys[index], sourceRecord[keys[index]]);
                        }
                    }
                    remainder[escape.field] = record;
                }
            }
            if (pluginStorageEscapeEnvelope.originalField.present) {
                assignNormalizedProperty(
                    remainder,
                    pluginStorageLegacyEscapeField,
                    pluginStorageEscapeEnvelope.originalField.value
                );
            }
        }
        if (strictPluginStorageActive
            && !Object.prototype.hasOwnProperty.call(remainder, 'pluginCustomStorage')) {
            remainder.pluginCustomStorage = {};
        }

        return {
            remainder,
            pluginStats,
            format: inspection.format,
            messagePackBytes: source.size - rootStart,
        };
    } catch (error) {
        if (streamingCallbackErrors.has(error)
            || error?.risuSavePreparationLimit
            || error?.risuSavePreparationInvalid
            || error?.code === 'INVALID_PLUGIN_STORAGE_ROW'
            || error?.code === 'RISU_STREAM_ABORTED') throw error;
        throw new RisuSavePreparationError(
            `Invalid streaming Risu save: ${error?.message ?? error}`,
            { cause: error },
        );
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
    DECODE_OUTPUT_CHUNK_BYTES,
    DEFAULT_MAX_DECODED_BYTES,
    DEFAULT_DECODE_DISK_HEADROOM_BYTES,
    DEFAULT_MAX_LEGACY_RESTORE_BYTES,
    DEFAULT_STREAM_INGEST_MIN_BYTES,
    RisuSavePreparationError,
    RisuSavePreparationLimitError,
    configuredStreamIngestMinBytes,
    decodeBoundedLegacyRisuSave,
    inspectRisuSaveSource,
    prepareMessagePackSource,
    shouldStreamRisuSave,
    scanMessagePackValue,
    skipMessagePackValue,
    walkRisuSave,
};
