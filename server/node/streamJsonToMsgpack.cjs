'use strict';

const fs = require('fs/promises');
const crypto = require('crypto');
const { TextDecoder } = require('util');
const { Packr } = require('msgpackr');
const { Unpackr } = require('msgpackr');
const {
    PLUGIN_STORAGE_LOSSLESS_MAGIC,
} = require('./pluginStorageJson.cjs');

const PAGE_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 1024;
// A bounded decimal prefix is sufficient to convert every finite JSON number
// used by the storage protocol without retaining an attacker-sized lexeme.
// The sticky tail is only relevant at an exact binary64 midpoint; keeping far
// more than the 17 significant decimal digits binary64 can represent also
// makes the ordinary conversion path agree with JSON.parse in practice.
const MAX_SIGNIFICANT_NUMBER_PREFIX = 768;
const packr = new Packr({ useRecords: false, variableMapSize: true });
const unpackr = new Unpackr({ int64AsType: 'number', useRecords: false });
const SIMPLE_JSON_ESCAPES = new Map([
    [0x22, 0x22], [0x5c, 0x5c], [0x2f, 0x2f], [0x62, 0x08],
    [0x66, 0x0c], [0x6e, 0x0a], [0x72, 0x0d], [0x74, 0x09],
]);

function encodedScalar(value) {
    return Buffer.from(packr.encode(value));
}

class JsonByteReader {
    constructor(handle, offset, size, shouldAbort) {
        this.handle = handle;
        this.offset = offset;
        this.size = size;
        this.shouldAbort = shouldAbort;
        this.position = 0;
        this.buffer = Buffer.alloc(0);
        this.index = 0;
    }

    throwIfAborted() {
        if (!this.shouldAbort()) return;
        const error = new Error('Backup database assembly cancelled');
        error.code = 'BACKUP_STREAM_ABORTED';
        throw error;
    }

    async fill() {
        if (this.index < this.buffer.length || this.position >= this.size) return;
        this.throwIfAborted();
        const length = Math.min(PAGE_BYTES, this.size - this.position);
        const buffer = Buffer.allocUnsafe(length);
        let read = 0;
        while (read < length) {
            const result = await this.handle.read(
                buffer,
                read,
                length - read,
                this.offset + this.position + read,
            );
            if (result.bytesRead <= 0) throw new SyntaxError('Truncated plugin storage JSON');
            read += result.bytesRead;
        }
        this.buffer = buffer;
        this.index = 0;
    }

    async peek() {
        await this.fill();
        return this.index < this.buffer.length ? this.buffer[this.index] : null;
    }

    async read() {
        const value = await this.peek();
        if (value !== null) {
            this.index++;
            this.position++;
        }
        return value;
    }

    async rawStringRun() {
        await this.fill();
        if (this.index >= this.buffer.length) return Buffer.alloc(0);
        const start = this.index;
        let end = start;
        while (end < this.buffer.length) {
            const byte = this.buffer[end];
            if (byte === 0x22 || byte === 0x5c || byte < 0x20) break;
            end++;
        }
        this.index = end;
        this.position += end - start;
        return this.buffer.subarray(start, end);
    }
}

class DiscardWriter {
    constructor(limit = Number.MAX_SAFE_INTEGER) {
        this.position = 0;
        this.limit = limit;
    }

    async write(input) {
        const length = input.length ?? Buffer.byteLength(input);
        const next = this.position + length;
        if (!Number.isSafeInteger(next) || next > this.limit) {
            throw new SyntaxError('Selected plugin storage JSON value is too large');
        }
        this.position = next;
    }

    async patch() {}
}

class MemoryWriter extends DiscardWriter {
    constructor(limit) {
        super(limit);
        this.buffer = Buffer.alloc(limit);
    }

    async write(input) {
        const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
        const prior = this.position;
        await super.write(bytes);
        bytes.copy(this.buffer, prior);
    }

    async patch(position, input) {
        const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
        if (position < 0 || position + bytes.length > this.position) {
            throw new RangeError('Invalid in-memory JSON transform patch');
        }
        bytes.copy(this.buffer, position);
    }

    value() {
        return this.buffer.subarray(0, this.position);
    }
}

function isWhitespace(byte) {
    return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

async function skipWhitespace(reader) {
    while (isWhitespace(await reader.peek())) await reader.read();
}

async function expectByte(reader, expected) {
    const actual = await reader.read();
    if (actual !== expected) throw new SyntaxError('Invalid plugin storage JSON');
}

function hexValue(byte) {
    if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
    if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
    if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
    return -1;
}

async function readHexCodeUnit(reader) {
    let value = 0;
    for (let index = 0; index < 4; index++) {
        const digit = hexValue(await reader.read());
        if (digit < 0) throw new SyntaxError('Invalid plugin storage JSON escape');
        value = value * 16 + digit;
    }
    return value;
}

async function writeJsonString(reader, writer, captureIdentity = false) {
    await expectByte(reader, 0x22);
    const headerOffset = writer.position;
    await writer.write(Buffer.from([0xdb, 0, 0, 0, 0]));
    const contentOffset = writer.position;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const identityHash = captureIdentity ? crypto.createHash('sha256') : null;
    const updateIdentity = (value) => {
        if (identityHash) identityHash.update(Buffer.from(value, 'utf16le'));
    };
    let jsonContentSize = 0;
    const addJsonCodePoint = (codePoint, decodedBytes) => {
        if (codePoint === 0x22 || codePoint === 0x5c) jsonContentSize += 2;
        else if (codePoint === 0x08 || codePoint === 0x09 || codePoint === 0x0a
            || codePoint === 0x0c || codePoint === 0x0d) jsonContentSize += 2;
        else if (codePoint < 0x20) jsonContentSize += 6;
        else jsonContentSize += decodedBytes;
    };
    for (;;) {
        reader.throwIfAborted();
        const run = await reader.rawStringRun();
        if (run.length > 0) {
            // Validate incrementally without constructing a whole-row string.
            updateIdentity(decoder.decode(run, { stream: true }));
            await writer.write(run);
            jsonContentSize += run.length;
            continue;
        }
        const byte = await reader.read();
        if (byte === null || byte < 0x20) {
            throw new SyntaxError('Invalid plugin storage JSON string');
        }
        if (byte === 0x22) {
            updateIdentity(decoder.decode());
            break;
        }
        if (byte !== 0x5c) throw new SyntaxError('Invalid plugin storage JSON string');
        updateIdentity(decoder.decode());
        const escape = await reader.read();
        const simple = SIMPLE_JSON_ESCAPES.get(escape);
        if (simple !== undefined) {
            await writer.write(Buffer.from([simple]));
            updateIdentity(String.fromCharCode(simple));
            addJsonCodePoint(simple, 1);
            continue;
        }
        if (escape !== 0x75) throw new SyntaxError('Invalid plugin storage JSON escape');
        let codePoint = await readHexCodeUnit(reader);
        if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
            const first = await reader.peek();
            if (first === 0x5c) {
                await reader.read();
                if (await reader.peek() === 0x75) {
                    await reader.read();
                    const low = await readHexCodeUnit(reader);
                    if (low >= 0xdc00 && low <= 0xdfff) {
                        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + low - 0xdc00;
                    } else {
                        // JSON.parse preserves both code units. Packr replaces
                        // the lone high surrogate, while the following ordinary
                        // code unit retains its value (or is replaced if it too
                        // is an unpaired surrogate).
                        const second = low >= 0xd800 && low <= 0xdfff ? 0xfffd : low;
                        const normalizedText = `\ufffd${String.fromCodePoint(second)}`;
                        await writer.write(Buffer.from(
                            normalizedText,
                            'utf-8',
                        ));
                        updateIdentity(normalizedText);
                        addJsonCodePoint(0xfffd, 3);
                        addJsonCodePoint(second, Buffer.byteLength(
                            String.fromCodePoint(second),
                            'utf-8',
                        ));
                        continue;
                    }
                } else {
                    const followingEscape = await reader.read();
                    const following = SIMPLE_JSON_ESCAPES.get(followingEscape);
                    if (following === undefined) {
                        throw new SyntaxError('Invalid plugin storage JSON escape');
                    }
                    await writer.write(Buffer.from('\ufffd', 'utf-8'));
                    updateIdentity(`\ufffd${String.fromCharCode(following)}`);
                    addJsonCodePoint(0xfffd, 3);
                    await writer.write(Buffer.from([following]));
                    addJsonCodePoint(following, 1);
                    continue;
                }
            } else {
                codePoint = 0xfffd;
            }
        } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
            codePoint = 0xfffd;
        }
        updateIdentity(String.fromCodePoint(codePoint));
        const encoded = Buffer.from(String.fromCodePoint(codePoint), 'utf-8');
        await writer.write(encoded);
        addJsonCodePoint(codePoint, encoded.length);
    }
    const length = writer.position - contentOffset;
    if (length > 0xffffffff) throw new RangeError('Plugin storage JSON string is too large');
    const header = Buffer.allocUnsafe(5);
    header[0] = 0xdb;
    header.writeUInt32BE(length, 1);
    await writer.patch(headerOffset, header);
    return {
        type: 'string',
        truthy: length > 0,
        length,
        jsonSize: jsonContentSize + 2,
        ...(identityHash ? { identity: identityHash.digest('hex') } : {}),
    };
}

async function readBoundedJsonString(reader, maxBytes = PAGE_BYTES) {
    const bytes = [];
    let escaped = false;
    for (;;) {
        const byte = await reader.read();
        if (byte === null || bytes.length >= maxBytes) {
            throw new SyntaxError('Plugin storage JSON key is too large or truncated');
        }
        bytes.push(byte);
        if (bytes.length === 1) {
            if (byte !== 0x22) throw new SyntaxError('Invalid plugin storage JSON string');
            continue;
        }
        if (!escaped && byte === 0x22) break;
        if (!escaped && byte === 0x5c) escaped = true;
        else escaped = false;
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(bytes));
    const value = JSON.parse(text);
    if (typeof value !== 'string') throw new SyntaxError('Invalid plugin storage JSON key');
    return value;
}

async function writeLiteral(reader, writer, literal, value) {
    for (const expected of Buffer.from(literal, 'ascii')) await expectByte(reader, expected);
    await writer.write(encodedScalar(value));
    return {
        type: value === null ? 'null' : typeof value,
        truthy: Boolean(value),
        jsonSize: literal.length,
    };
}

async function writeNumber(reader, writer) {
    let state = 'start';
    let negative = false;
    let mantissaDigits = 0;
    let digitsBeforeDecimal = 0;
    let firstNonZeroIndex = null;
    let significantPrefix = '';
    let significantTailNonZero = false;
    let exponentNegative = false;
    let exponentValue = 0;
    let exponentSaturated = false;
    const exponentSaturation = Math.min(
        Number.MAX_SAFE_INTEGER,
        Math.max(1024, reader.size + 1024),
    );
    const recordMantissaDigit = (byte, beforeDecimal) => {
        const index = mantissaDigits++;
        if (beforeDecimal) digitsBeforeDecimal++;
        if (firstNonZeroIndex === null && byte !== 0x30) firstNonZeroIndex = index;
        if (firstNonZeroIndex !== null) {
            if (significantPrefix.length < MAX_SIGNIFICANT_NUMBER_PREFIX) {
                significantPrefix += String.fromCharCode(byte);
            } else if (byte !== 0x30) {
                significantTailNonZero = true;
            }
        }
    };
    const recordExponentDigit = (byte) => {
        if (exponentSaturated) return;
        const digit = byte - 0x30;
        if (exponentValue > Math.floor((exponentSaturation - digit) / 10)) {
            exponentValue = exponentSaturation;
            exponentSaturated = true;
            return;
        }
        exponentValue = exponentValue * 10 + digit;
    };
    for (;;) {
        reader.throwIfAborted();
        const byte = await reader.peek();
        const digit = byte !== null && byte >= 0x30 && byte <= 0x39;
        if (state === 'start') {
            if (byte === 0x2d) {
                negative = true;
                state = 'minus';
                await reader.read();
                continue;
            }
            if (!digit) throw new SyntaxError('Invalid plugin storage JSON number');
            state = byte === 0x30 ? 'zero' : 'integer';
            recordMantissaDigit(byte, true);
            await reader.read();
            continue;
        }
        if (state === 'minus') {
            if (!digit) throw new SyntaxError('Invalid plugin storage JSON number');
            state = byte === 0x30 ? 'zero' : 'integer';
            recordMantissaDigit(byte, true);
            await reader.read();
            continue;
        }
        if (state === 'zero') {
            if (digit) throw new SyntaxError('Invalid plugin storage JSON number');
            if (byte === 0x2e) state = 'decimal-point';
            else if (byte === 0x65 || byte === 0x45) state = 'exponent';
            else break;
            await reader.read();
            continue;
        }
        if (state === 'integer') {
            if (digit) {
                recordMantissaDigit(byte, true);
                await reader.read();
                continue;
            }
            if (byte === 0x2e) state = 'decimal-point';
            else if (byte === 0x65 || byte === 0x45) state = 'exponent';
            else break;
            await reader.read();
            continue;
        }
        if (state === 'decimal-point') {
            if (!digit) throw new SyntaxError('Invalid plugin storage JSON number');
            state = 'fraction';
            recordMantissaDigit(byte, false);
            await reader.read();
            continue;
        }
        if (state === 'fraction') {
            if (digit) {
                recordMantissaDigit(byte, false);
                await reader.read();
                continue;
            }
            if (byte === 0x65 || byte === 0x45) {
                state = 'exponent';
                await reader.read();
                continue;
            }
            break;
        }
        if (state === 'exponent') {
            if (byte === 0x2b || byte === 0x2d) {
                exponentNegative = byte === 0x2d;
                state = 'exponent-sign';
                await reader.read();
                continue;
            }
            if (!digit) throw new SyntaxError('Invalid plugin storage JSON number');
            state = 'exponent-digits';
            recordExponentDigit(byte);
            await reader.read();
            continue;
        }
        if (state === 'exponent-sign') {
            if (!digit) throw new SyntaxError('Invalid plugin storage JSON number');
            state = 'exponent-digits';
            recordExponentDigit(byte);
            await reader.read();
            continue;
        }
        if (state === 'exponent-digits') {
            if (!digit) break;
            recordExponentDigit(byte);
            await reader.read();
            continue;
        }
    }
    if (!['zero', 'integer', 'fraction', 'exponent-digits'].includes(state)) {
        throw new SyntaxError('Invalid plugin storage JSON number');
    }

    let value = 0;
    if (firstNonZeroIndex !== null) {
        if (exponentSaturated) {
            if (!exponentNegative) throw new SyntaxError('Invalid plugin storage JSON number');
        } else {
            const explicitExponent = exponentNegative ? -exponentValue : exponentValue;
            const magnitude = digitsBeforeDecimal - firstNonZeroIndex - 1 + explicitExponent;
            if (magnitude > 308) throw new SyntaxError('Invalid plugin storage JSON number');
            if (magnitude >= -400) {
                // A non-zero discarded tail is retained as one final sticky
                // digit, avoiding an artificial exact midpoint after bounding.
                const prefix = significantTailNonZero ? `${significantPrefix}1` : significantPrefix;
                const normalized = prefix.length === 1
                    ? `${prefix}e${magnitude}`
                    : `${prefix[0]}.${prefix.slice(1)}e${magnitude}`;
                value = Number(normalized);
                if (!Number.isFinite(value)) {
                    throw new SyntaxError('Invalid plugin storage JSON number');
                }
            }
        }
    }
    if (negative) value = -value;
    const normalizedValue = Object.is(value, -0) ? 0 : value;
    await writer.write(encodedScalar(normalizedValue));
    return {
        type: 'number',
        truthy: normalizedValue !== 0,
        value: normalizedValue,
        jsonSize: Buffer.byteLength(JSON.stringify(normalizedValue), 'utf-8'),
    };
}

async function writeJsonValue(reader, writer, depth) {
    if (depth > MAX_JSON_DEPTH) throw new SyntaxError('Plugin storage JSON nesting is too deep');
    await skipWhitespace(reader);
    const byte = await reader.peek();
    if (byte === 0x22) return writeJsonString(reader, writer);
    if (byte === 0x6e) return writeLiteral(reader, writer, 'null', null);
    if (byte === 0x74) return writeLiteral(reader, writer, 'true', true);
    if (byte === 0x66) return writeLiteral(reader, writer, 'false', false);
    if (byte === 0x2d || (byte >= 0x30 && byte <= 0x39)) return writeNumber(reader, writer);
    if (byte === 0x5b) {
        await reader.read();
        const headerOffset = writer.position;
        await writer.write(Buffer.from([0xdd, 0, 0, 0, 0]));
        let count = 0;
        let jsonSize = 2;
        await skipWhitespace(reader);
        if (await reader.peek() !== 0x5d) {
            for (;;) {
                const value = await writeJsonValue(reader, writer, depth + 1);
                jsonSize += value.jsonSize;
                if (++count > 0xffffffff) throw new RangeError('Plugin storage JSON array is too large');
                if (count > 1) jsonSize += 1;
                await skipWhitespace(reader);
                const separator = await reader.read();
                if (separator === 0x5d) break;
                if (separator !== 0x2c) throw new SyntaxError('Invalid plugin storage JSON array');
            }
        } else {
            await reader.read();
        }
        const header = Buffer.allocUnsafe(5);
        header[0] = 0xdd;
        header.writeUInt32BE(count, 1);
        await writer.patch(headerOffset, header);
        return { type: 'array', truthy: true, count, jsonSize };
    }
    if (byte === 0x7b) {
        await reader.read();
        const headerOffset = writer.position;
        await writer.write(Buffer.from([0xdf, 0, 0, 0, 0]));
        let count = 0;
        let uniqueCount = 0;
        let jsonSize = 2;
        const contributions = new Map();
        await skipWhitespace(reader);
        if (await reader.peek() !== 0x7d) {
            for (;;) {
                await skipWhitespace(reader);
                if (await reader.peek() !== 0x22) {
                    throw new SyntaxError('Invalid plugin storage JSON object key');
                }
                const key = await writeJsonString(reader, writer, true);
                await skipWhitespace(reader);
                await expectByte(reader, 0x3a);
                const value = await writeJsonValue(reader, writer, depth + 1);
                if (++count > 0xffffffff) {
                    throw new RangeError('Plugin storage JSON object is too large');
                }
                const contribution = key.jsonSize + 1 + value.jsonSize;
                const previous = contributions.get(key.identity);
                if (previous === undefined) {
                    contributions.set(key.identity, contribution);
                    jsonSize += contribution;
                    if (++uniqueCount > 1) jsonSize += 1;
                } else {
                    contributions.set(key.identity, contribution);
                    jsonSize += contribution - previous;
                }
                await skipWhitespace(reader);
                const separator = await reader.read();
                if (separator === 0x7d) break;
                if (separator !== 0x2c) throw new SyntaxError('Invalid plugin storage JSON object');
            }
        } else {
            await reader.read();
        }
        const header = Buffer.allocUnsafe(5);
        header[0] = 0xdf;
        header.writeUInt32BE(count, 1);
        await writer.patch(headerOffset, header);
        return { type: 'object', truthy: true, count, jsonSize };
    }
    throw new SyntaxError('Invalid plugin storage JSON value');
}

async function losslessCollectionSeparator(reader, closingByte, label) {
    await skipWhitespace(reader);
    const separator = await reader.read();
    if (separator === closingByte) return false;
    if (separator !== 0x2c) throw new SyntaxError(`Invalid lossless plugin storage ${label}`);
    return true;
}

async function writeLosslessPluginStorageNode(
    reader,
    writer,
    depth,
    { allowHole = false } = {},
) {
    if (depth > MAX_JSON_DEPTH) {
        throw new SyntaxError('Lossless plugin storage nesting is too deep');
    }
    await skipWhitespace(reader);
    if (await reader.peek() !== 0x5b) {
        const byte = await reader.peek();
        if (byte === 0x7b) {
            throw new SyntaxError('Invalid lossless plugin storage node');
        }
        return writeJsonValue(reader, writer, depth);
    }

    await expectByte(reader, 0x5b);
    await skipWhitespace(reader);
    const tag = await readBoundedJsonString(reader);
    if (tag === 'u' || tag === 'h') {
        if (tag === 'h' && !allowHole) {
            throw new SyntaxError('Lossless plugin storage hole is outside an array');
        }
        await skipWhitespace(reader);
        await expectByte(reader, 0x5d);
        await writer.write(encodedScalar(undefined));
        return { type: tag === 'h' ? 'hole' : 'undefined', truthy: false, jsonSize: 0 };
    }

    await skipWhitespace(reader);
    await expectByte(reader, 0x2c);
    await skipWhitespace(reader);
    await expectByte(reader, 0x5b);

    if (tag === 'a') {
        const headerOffset = writer.position;
        await writer.write(Buffer.from([0xdd, 0, 0, 0, 0]));
        let count = 0;
        let jsonSize = 2;
        await skipWhitespace(reader);
        if (await reader.peek() !== 0x5d) {
            for (;;) {
                const item = await writeLosslessPluginStorageNode(
                    reader,
                    writer,
                    depth + 1,
                    { allowHole: true },
                );
                jsonSize += item.type === 'undefined' || item.type === 'hole'
                    ? 4
                    : item.jsonSize;
                if (++count > 0xffffffff) {
                    throw new RangeError('Lossless plugin storage array is too large');
                }
                if (count > 1) jsonSize += 1;
                if (!await losslessCollectionSeparator(reader, 0x5d, 'array')) break;
            }
        } else {
            await reader.read();
        }
        await skipWhitespace(reader);
        await expectByte(reader, 0x5d);
        const header = Buffer.allocUnsafe(5);
        header[0] = 0xdd;
        header.writeUInt32BE(count, 1);
        await writer.patch(headerOffset, header);
        return { type: 'array', truthy: true, count, jsonSize };
    }

    if (tag === 'o') {
        const headerOffset = writer.position;
        await writer.write(Buffer.from([0xdf, 0, 0, 0, 0]));
        let count = 0;
        let visibleCount = 0;
        let jsonSize = 2;
        const seen = new Set();
        await skipWhitespace(reader);
        if (await reader.peek() !== 0x5d) {
            for (;;) {
                await skipWhitespace(reader);
                await expectByte(reader, 0x5b);
                await skipWhitespace(reader);
                const key = await writeJsonString(reader, writer, true);
                if (seen.has(key.identity)) {
                    throw new SyntaxError('Lossless plugin storage object repeats a key');
                }
                seen.add(key.identity);
                await skipWhitespace(reader);
                await expectByte(reader, 0x2c);
                const item = await writeLosslessPluginStorageNode(
                    reader,
                    writer,
                    depth + 1,
                );
                await skipWhitespace(reader);
                await expectByte(reader, 0x5d);
                if (item.type !== 'undefined') {
                    jsonSize += key.jsonSize + 1 + item.jsonSize;
                    if (++visibleCount > 1) jsonSize += 1;
                }
                if (++count > 0xffffffff) {
                    throw new RangeError('Lossless plugin storage object is too large');
                }
                if (!await losslessCollectionSeparator(reader, 0x5d, 'object')) break;
            }
        } else {
            await reader.read();
        }
        await skipWhitespace(reader);
        await expectByte(reader, 0x5d);
        const header = Buffer.allocUnsafe(5);
        header[0] = 0xdf;
        header.writeUInt32BE(count, 1);
        await writer.patch(headerOffset, header);
        return { type: 'object', truthy: true, count, jsonSize };
    }

    throw new SyntaxError('Invalid lossless plugin storage tag');
}

async function consumeLosslessPluginStorageMagic(reader) {
    for (const expected of PLUGIN_STORAGE_LOSSLESS_MAGIC) {
        await expectByte(reader, expected);
    }
}

async function withJsonReader(source, options, callback) {
    const handle = await fs.open(source.filePath, 'r');
    const shouldAbort = () => options.signal?.aborted === true || options.shouldAbort?.() === true;
    try {
        const stat = await handle.stat();
        const offset = source.offset ?? 0;
        if (!stat.isFile() || !Number.isSafeInteger(offset) || offset < 0
            || !Number.isSafeInteger(source.size) || source.size < 0
            || offset + source.size > stat.size) {
            throw new Error('Plugin storage row changed while streaming');
        }
        const reader = new JsonByteReader(handle, offset, source.size, shouldAbort);
        const result = await callback(reader);
        await skipWhitespace(reader);
        if (await reader.peek() !== null) throw new SyntaxError('Trailing plugin storage JSON data');
        return result;
    } finally {
        await handle.close();
    }
}

async function streamJsonFileToMessagePack(source, writer, options = {}) {
    return withJsonReader(source, options, async (reader) => {
        await skipWhitespace(reader);
        if (await reader.peek() === PLUGIN_STORAGE_LOSSLESS_MAGIC[0]) {
            await consumeLosslessPluginStorageMagic(reader);
            return writeLosslessPluginStorageNode(reader, writer, 0);
        }
        return writeJsonValue(reader, writer, 0);
    });
}

async function validateJsonSource(source, options = {}) {
    return streamJsonFileToMessagePack(source, new DiscardWriter(), options);
}

function capturedValue(writer, offset, metadata) {
    return {
        descriptor: { offset, length: writer.position - offset },
        metadata,
    };
}

async function writeCapturedJsonValue(reader, writer, depth) {
    const offset = writer.position;
    const metadata = await writeJsonValue(reader, writer, depth);
    return capturedValue(writer, offset, metadata);
}

/**
 * Streams the enumerable fields produced by `for (const key in JSON.parse())`.
 * Object duplicate keys therefore collapse to their last JSON value before the
 * caller applies ROOT truthiness. Arrays expose their numeric elements. Small
 * string roots use their UTF-16 index semantics; other primitives are no-ops.
 */
async function streamJsonRootEntries(source, writer, options = {}) {
    return withJsonReader(source, options, async (reader) => {
        const entries = new Map();
        await skipWhitespace(reader);
        const first = await reader.peek();
        if (first === 0x7b) {
            await reader.read();
            await skipWhitespace(reader);
            if (await reader.peek() === 0x7d) {
                await reader.read();
                return entries;
            }
            for (;;) {
                await skipWhitespace(reader);
                const key = await readBoundedJsonString(reader, options.maxKeyBytes);
                await skipWhitespace(reader);
                await expectByte(reader, 0x3a);
                const value = await writeCapturedJsonValue(reader, writer, 1);
                entries.set(key, value);
                await skipWhitespace(reader);
                const separator = await reader.read();
                if (separator === 0x7d) break;
                if (separator !== 0x2c) throw new SyntaxError('Invalid plugin storage JSON object');
            }
            return entries;
        }
        if (first === 0x5b) {
            await reader.read();
            let index = 0;
            await skipWhitespace(reader);
            if (await reader.peek() !== 0x5d) {
                for (;;) {
                    const value = await writeCapturedJsonValue(reader, writer, 1);
                    entries.set(String(index++), value);
                    await skipWhitespace(reader);
                    const separator = await reader.read();
                    if (separator === 0x5d) break;
                    if (separator !== 0x2c) {
                        throw new SyntaxError('Invalid plugin storage JSON array');
                    }
                }
            } else {
                await reader.read();
            }
            return entries;
        }
        if (first === 0x22) {
            // Enumerating a JSON string is unusual database input. Retain exact
            // JS UTF-16 index behavior under the finite metadata boundary.
            const valueWriter = new MemoryWriter(options.maxSelectedBytes ?? PAGE_BYTES);
            await writeJsonValue(reader, valueWriter, 0);
            const value = unpackr.decode(valueWriter.value());
            for (let index = 0; index < value.length; index++) {
                const offset = writer.position;
                const character = value[index];
                await writer.write(encodedScalar(character));
                entries.set(String(index), capturedValue(writer, offset, {
                    type: 'string',
                    truthy: character.length > 0,
                    length: Buffer.byteLength(character, 'utf-8'),
                }));
            }
            return entries;
        }
        // null, booleans, and numbers have no enumerable properties, but still
        // require strict validation.
        await writeJsonValue(reader, new DiscardWriter(), 0);
        return entries;
    });
}

/** Streams every occurrence of one object field and returns JSON.parse's last. */
async function streamJsonObjectField(source, fieldName, writer, options = {}) {
    return withJsonReader(source, options, async (reader) => {
        await skipWhitespace(reader);
        await expectByte(reader, 0x7b);
        let selected = null;
        await skipWhitespace(reader);
        if (await reader.peek() === 0x7d) {
            await reader.read();
            return selected;
        }
        for (;;) {
            await skipWhitespace(reader);
            const key = await readBoundedJsonString(reader, options.maxKeyBytes);
            await skipWhitespace(reader);
            await expectByte(reader, 0x3a);
            if (key === fieldName) {
                selected = await writeCapturedJsonValue(reader, writer, 1);
            } else {
                await writeJsonValue(reader, new DiscardWriter(), 1);
            }
            await skipWhitespace(reader);
            const separator = await reader.read();
            if (separator === 0x7d) break;
            if (separator !== 0x2c) throw new SyntaxError('Invalid plugin storage JSON object');
        }
        return selected;
    });
}

async function readJsonValue(source, options = {}) {
    const valueWriter = new MemoryWriter(options.maxSelectedBytes ?? PAGE_BYTES);
    await streamJsonFileToMessagePack(source, valueWriter, options);
    return unpackr.decode(valueWriter.value());
}

async function streamJsonObjectEntries(source, writer, options = {}) {
    return withJsonReader(source, options, async (reader) => {
        await skipWhitespace(reader);
        await expectByte(reader, 0x7b);
        let count = 0;
        await skipWhitespace(reader);
        if (await reader.peek() === 0x7d) {
            await reader.read();
            return count;
        }
        for (;;) {
            await skipWhitespace(reader);
            const key = await readBoundedJsonString(reader, options.maxKeyBytes);
            await skipWhitespace(reader);
            await expectByte(reader, 0x3a);
            if (!options.filterKey || options.filterKey(key)) {
                await writer.write(encodedScalar(key));
                await writeJsonValue(reader, writer, 1);
                count++;
            } else {
                await writeJsonValue(reader, new DiscardWriter(), 1);
            }
            await skipWhitespace(reader);
            const separator = await reader.read();
            if (separator === 0x7d) break;
            if (separator !== 0x2c) throw new SyntaxError('Invalid plugin storage JSON object');
        }
        return count;
    });
}

async function readJsonObjectFields(source, requestedKeys, options = {}) {
    const requested = new Set(requestedKeys);
    const result = Object.create(null);
    await withJsonReader(source, options, async (reader) => {
        await skipWhitespace(reader);
        await expectByte(reader, 0x7b);
        await skipWhitespace(reader);
        if (await reader.peek() === 0x7d) {
            await reader.read();
            return;
        }
        for (;;) {
            await skipWhitespace(reader);
            const key = await readBoundedJsonString(reader, options.maxKeyBytes);
            await skipWhitespace(reader);
            await expectByte(reader, 0x3a);
            if (requested.has(key)) {
                const valueWriter = new MemoryWriter(options.maxSelectedBytes ?? PAGE_BYTES);
                await writeJsonValue(reader, valueWriter, 1);
                result[key] = unpackr.decode(valueWriter.value());
            } else {
                await writeJsonValue(reader, new DiscardWriter(), 1);
            }
            await skipWhitespace(reader);
            const separator = await reader.read();
            if (separator === 0x7d) break;
            if (separator !== 0x2c) throw new SyntaxError('Invalid plugin storage JSON object');
        }
    });
    return result;
}

async function readJsonRootFields(source, requestedKeys, options = {}) {
    const handle = await fs.open(source.filePath, 'r');
    let first = null;
    try {
        const offset = source.offset ?? 0;
        let position = 0;
        while (position < source.size && first === null) {
            if (options.signal?.aborted || options.shouldAbort?.()) {
                const error = new Error('Backup database assembly cancelled');
                error.code = 'BACKUP_STREAM_ABORTED';
                throw error;
            }
            const length = Math.min(PAGE_BYTES, source.size - position);
            const page = Buffer.allocUnsafe(length);
            const result = await handle.read(page, 0, length, offset + position);
            if (result.bytesRead !== length) throw new SyntaxError('Truncated root JSON');
            for (const byte of page) {
                if (!isWhitespace(byte)) {
                    first = byte;
                    break;
                }
            }
            position += length;
        }
    } finally {
        await handle.close();
    }
    if (first === 0x7b) return readJsonObjectFields(source, requestedKeys, options);
    // Arrays/strings only expose numeric for-in keys, which are never backup
    // ownership metadata. Other primitives expose nothing. Validate them all.
    await validateJsonSource(source, options);
    return Object.create(null);
}

async function streamJsonRootComponent(source, writer, options = {}) {
    return withJsonReader(source, options, async (reader) => {
        await skipWhitespace(reader);
        await expectByte(reader, 0x7b);
        let componentKey = options.componentKey ?? null;
        let wroteData = false;
        await skipWhitespace(reader);
        if (await reader.peek() === 0x7d) throw new SyntaxError('Invalid root component JSON');
        for (;;) {
            await skipWhitespace(reader);
            const key = await readBoundedJsonString(reader, options.maxKeyBytes);
            await skipWhitespace(reader);
            await expectByte(reader, 0x3a);
            if (key === 'key') {
                await skipWhitespace(reader);
                const parsedKey = await readBoundedJsonString(reader, options.maxKeyBytes);
                if (componentKey === null) componentKey = parsedKey;
                else if (parsedKey !== componentKey) {
                    throw new SyntaxError('Root component key changed between passes');
                }
            } else if (key === 'data') {
                if (componentKey === null || wroteData) {
                    throw new SyntaxError('Root component key must precede its data');
                }
                await writer.write(encodedScalar(componentKey));
                await writeJsonValue(reader, writer, 1);
                wroteData = true;
            } else {
                await writeJsonValue(reader, new DiscardWriter(), 1);
            }
            await skipWhitespace(reader);
            const separator = await reader.read();
            if (separator === 0x7d) break;
            if (separator !== 0x2c) throw new SyntaxError('Invalid root component JSON');
        }
        if (!wroteData) throw new SyntaxError('Invalid root component JSON');
        return componentKey;
    });
}

module.exports = {
    PAGE_BYTES,
    readJsonObjectFields,
    readJsonRootFields,
    readJsonValue,
    streamJsonObjectField,
    streamJsonObjectEntries,
    streamJsonFileToMessagePack,
    streamJsonRootEntries,
    streamJsonRootComponent,
    validateJsonSource,
};
