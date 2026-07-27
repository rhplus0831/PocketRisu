'use strict';

const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { TextDecoder } = require('util');
const { Readable } = require('stream');

const IMPORT_IO_PAGE_BYTES = 64 * 1024;
const SAVE_FOLDER_IMPORT_STAGE_PREFIX = '.save-folder-import-';
const ZIP_EOCD_MAX_BYTES = 22 + 0xffff;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_ENCRYPTION_FLAGS = 0x0001 | 0x0040 | 0x2000;

class ImportIngressError extends Error {
    constructor(message, {
        code,
        statusCode,
        limit,
        actual,
        retryable = false,
        commitOutcome = 'not-committed',
    }) {
        super(message);
        this.name = 'ImportIngressError';
        this.code = code;
        this.statusCode = statusCode;
        this.limit = limit;
        this.actual = actual;
        this.retryable = retryable;
        this.commitOutcome = commitOutcome;
        this.commitOutcomeUnknown = commitOutcome === 'unknown';
    }
}

function finiteByteLimit(raw, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return fallback;
    return parsed;
}

function importSizeError(label, limit, actual, code = 'IMPORT_SIZE_LIMIT') {
    return new ImportIngressError(`${label} exceeds the ${limit}-byte import limit`, {
        code,
        statusCode: 413,
        limit,
        actual,
    });
}

function importFormatError(message, code = 'INVALID_IMPORT_SOURCE') {
    return new ImportIngressError(message, {
        code,
        statusCode: 400,
    });
}

function importAbortError(message = 'Import cancelled before publication') {
    const error = new ImportIngressError(message, {
        code: 'IMPORT_ABORTED',
        statusCode: 499,
    });
    error.name = 'AbortError';
    return error;
}

function importErrorPayload(error) {
    if (!(error instanceof ImportIngressError)) return null;
    return {
        error: error.message,
        code: error.code,
        ...(error.limit === undefined ? {} : { limit: error.limit }),
        ...(error.actual === undefined ? {} : { actual: error.actual }),
        retryable: error.retryable,
        commitOutcome: error.commitOutcome,
        commitOutcomeUnknown: error.commitOutcomeUnknown,
    };
}

function assertImportSize(actual, limit, label, code) {
    if (!Number.isSafeInteger(actual) || actual < 0) {
        throw importFormatError(`${label} has an invalid byte length`, 'INVALID_IMPORT_SIZE');
    }
    if (actual > limit) throw importSizeError(label, limit, actual, code);
}

function throwIfAborted(signal, shouldAbort) {
    if (signal?.aborted || shouldAbort?.()) throw importAbortError();
}

function createImportAbortTracker(req, res) {
    const controller = new AbortController();
    const abort = () => {
        if (!controller.signal.aborted) controller.abort(importAbortError());
    };
    const onResponseClose = () => {
        if (!res.writableEnded) abort();
    };
    req.once('aborted', abort);
    res.once('close', onResponseClose);
    // The peer can disappear before a route has installed these listeners
    // (authentication and session validation both yield). Seed the signal from
    // the current stream state so that an already-observed disconnect is not
    // lost, then keep tracking future disconnects while the import waits for
    // the mutation barrier.
    // Express has already consumed JSON bodies for directory/server restores;
    // their IncomingMessage may be destroyed after a *complete* body without a
    // peer disconnect. Only a destroyed, incomplete request is cancellation.
    if (req.aborted || (req.destroyed && !req.complete) || res.destroyed) abort();
    return {
        signal: controller.signal,
        abort,
        cleanup() {
            req.removeListener('aborted', abort);
            res.removeListener('close', onResponseClose);
        },
    };
}

const yieldToEventLoop = () => new Promise(resolve => setImmediate(resolve));

async function writeAll(fileHandle, data, position = null) {
    let offset = 0;
    while (offset < data.length) {
        const result = await fileHandle.write(
            data,
            offset,
            data.length - offset,
            position === null ? null : position + offset,
        );
        if (result.bytesWritten <= 0) {
            throw importFormatError('Import spool write made no progress', 'IMPORT_SPOOL_WRITE_FAILED');
        }
        offset += result.bytesWritten;
    }
}

async function readExact(fileHandle, position, length, { signal, shouldAbort } = {}) {
    if (!Number.isSafeInteger(position) || position < 0
        || !Number.isSafeInteger(length) || length < 0 || length > IMPORT_IO_PAGE_BYTES) {
        throw new RangeError('Import reads must be safe 64 KiB pages');
    }
    throwIfAborted(signal, shouldAbort);
    const result = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
        const read = await fileHandle.read(result, offset, length - offset, position + offset);
        if (read.bytesRead <= 0) {
            throw importFormatError('Import source ended unexpectedly', 'TRUNCATED_IMPORT_SOURCE');
        }
        offset += read.bytesRead;
    }
    throwIfAborted(signal, shouldAbort);
    return result;
}

async function spoolAsyncIterable(source, filePath, {
    maxBytes,
    expectedBytes = null,
    signal,
    shouldAbort,
    onPage,
    onProgress,
} = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new TypeError('A finite positive import spool limit is required');
    }
    if (expectedBytes !== null) assertImportSize(expectedBytes, maxBytes, 'Import source');
    const fileHandle = await fs.open(filePath, 'wx', 0o600);
    let size = 0;
    let pages = 0;
    let maxPageBytes = 0;
    try {
        for await (const sourceChunk of source) {
            throwIfAborted(signal, shouldAbort);
            if (!(Buffer.isBuffer(sourceChunk) || sourceChunk instanceof Uint8Array)) {
                throw importFormatError('Import source produced a non-binary chunk');
            }
            const chunk = Buffer.from(
                sourceChunk.buffer,
                sourceChunk.byteOffset,
                sourceChunk.byteLength,
            );
            for (let offset = 0; offset < chunk.length; offset += IMPORT_IO_PAGE_BYTES) {
                const page = chunk.subarray(offset, Math.min(chunk.length, offset + IMPORT_IO_PAGE_BYTES));
                const nextSize = size + page.length;
                if (!Number.isSafeInteger(nextSize) || nextSize > maxBytes) {
                    throw importSizeError('Import source', maxBytes, nextSize);
                }
                await writeAll(fileHandle, page);
                size = nextSize;
                pages++;
                maxPageBytes = Math.max(maxPageBytes, page.length);
                onPage?.({ index: pages - 1, size: page.length, total: size });
                onProgress?.(size, expectedBytes ?? 0);
                await yieldToEventLoop();
                throwIfAborted(signal, shouldAbort);
            }
        }
        if (expectedBytes !== null && size !== expectedBytes) {
            throw importFormatError(
                `Import source length changed while being spooled (expected ${expectedBytes}, received ${size})`,
                'IMPORT_SOURCE_CHANGED',
            );
        }
        await fileHandle.sync();
        await fileHandle.close();
        return { filePath, size, pages, maxPageBytes };
    } catch (error) {
        try { await fileHandle.close(); } catch {}
        await fs.unlink(filePath).catch(() => {});
        throw error;
    }
}

async function copyFileToSpool(sourcePath, destinationPath, options = {}) {
    const noFollow = fsSync.constants.O_NOFOLLOW ?? 0;
    const sourceHandle = await fs.open(sourcePath, fsSync.constants.O_RDONLY | noFollow);
    let stream;
    try {
        const stat = await sourceHandle.stat();
        if (!stat.isFile()) {
            throw importFormatError('Save-folder entries must be regular files', 'INVALID_SAVE_FOLDER_ENTRY');
        }
        assertImportSize(stat.size, options.maxBytes, 'Save-folder entry');
        // Read through the already-open descriptor. A path replacement after
        // preflight cannot redirect the staged import to a symlink or new file.
        stream = sourceHandle.createReadStream({
            autoClose: false,
            highWaterMark: IMPORT_IO_PAGE_BYTES,
        });
        return await spoolAsyncIterable(stream, destinationPath, {
            ...options,
            expectedBytes: stat.size,
        });
    } finally {
        stream?.destroy();
        await sourceHandle.close().catch(() => {});
    }
}

async function readFileToBufferBounded(filePath, {
    size,
    maxBytes,
    label = 'Legacy import database',
    code = 'IMPORT_LEGACY_DATABASE_LIMIT',
    signal,
    shouldAbort,
    onPage,
} = {}) {
    const fileHandle = await fs.open(filePath, 'r');
    try {
        const stat = await fileHandle.stat();
        const expected = size ?? stat.size;
        if (stat.size !== expected) {
            throw importFormatError('Import database changed after preflight', 'IMPORT_SOURCE_CHANGED');
        }
        assertImportSize(expected, maxBytes, label, code);
        const result = Buffer.allocUnsafe(expected);
        let offset = 0;
        let pages = 0;
        while (offset < expected) {
            throwIfAborted(signal, shouldAbort);
            const length = Math.min(IMPORT_IO_PAGE_BYTES, expected - offset);
            let pageOffset = 0;
            while (pageOffset < length) {
                const read = await fileHandle.read(
                    result,
                    offset + pageOffset,
                    length - pageOffset,
                    offset + pageOffset,
                );
                if (read.bytesRead <= 0) {
                    throw importFormatError('Legacy import database is truncated', 'TRUNCATED_IMPORT_SOURCE');
                }
                pageOffset += read.bytesRead;
            }
            onPage?.({ index: pages++, size: length, total: offset + length });
            offset += length;
            await yieldToEventLoop();
        }
        throwIfAborted(signal, shouldAbort);
        return result;
    } finally {
        await fileHandle.close();
    }
}

async function validateJsonFileStreaming(filePath, {
    size,
    maxBytes,
    signal,
    shouldAbort,
    maxDepth = 1024,
} = {}) {
    const fileHandle = await fs.open(filePath, 'r');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const stack = [];
    let rootState = 'value';
    let token = null;
    let offset = 0;
    // A decimal exponent only needs to remain exact while it can cancel the
    // mantissa's decimal offset. That offset is bounded by the finite source
    // size. Beyond this threshold, a positive exponent is unavoidably overflow
    // and a negative exponent unavoidably finite underflow.
    const exponentSaturation = Math.min(
        Number.MAX_SAFE_INTEGER,
        Math.max(1024, Number(maxBytes) + 1024),
    );

    const invalid = () => importFormatError(
        'Invalid plugin storage JSON row',
        'INVALID_PLUGIN_STORAGE_ROW',
    );
    const completeValue = () => {
        if (stack.length === 0) {
            if (rootState !== 'value') throw invalid();
            rootState = 'end';
            return;
        }
        const parent = stack[stack.length - 1];
        if (parent.kind === 'array'
            && (parent.state === 'value_or_end' || parent.state === 'value')) {
            parent.state = 'comma_or_end';
            return;
        }
        if (parent.kind === 'object' && parent.state === 'value') {
            parent.state = 'comma_or_end';
            return;
        }
        throw invalid();
    };
    const pushContainer = (kind) => {
        if (stack.length >= maxDepth) throw invalid();
        stack.push({
            kind,
            state: kind === 'array' ? 'value_or_end' : 'key_or_end',
        });
    };
    const closeContainer = (kind) => {
        const current = stack[stack.length - 1];
        if (!current || current.kind !== kind) throw invalid();
        if (kind === 'array'
            ? current.state !== 'value_or_end' && current.state !== 'comma_or_end'
            : current.state !== 'key_or_end' && current.state !== 'comma_or_end') {
            throw invalid();
        }
        stack.pop();
        completeValue();
    };
    const beginValue = (character) => {
        if (character === '{') pushContainer('object');
        else if (character === '[') pushContainer('array');
        else if (character === '"') token = { kind: 'string', role: 'value', escape: false, unicode: 0 };
        else if (character === 't') token = { kind: 'literal', expected: 'true', index: 1 };
        else if (character === 'f') token = { kind: 'literal', expected: 'false', index: 1 };
        else if (character === 'n') token = { kind: 'literal', expected: 'null', index: 1 };
        else if (character === '-' || (character >= '0' && character <= '9')) {
            token = {
                kind: 'number',
                state: character === '-' ? 'minus' : character === '0' ? 'zero' : 'integer',
                mantissaDigits: character === '-' ? 0 : 1,
                digitsBeforeDecimal: character === '-' ? 0 : 1,
                firstNonZeroIndex: character >= '1' && character <= '9' ? 0 : null,
                significantPrefix: character >= '1' && character <= '9' ? character : '',
                exponentNegative: false,
                exponentValue: 0,
                exponentSaturated: false,
            };
        } else throw invalid();
    };
    const recordMantissaDigit = (number, character, beforeDecimal) => {
        const index = number.mantissaDigits++;
        if (beforeDecimal) number.digitsBeforeDecimal++;
        if (number.firstNonZeroIndex === null && character !== '0') {
            number.firstNonZeroIndex = index;
        }
        // A fixed prefix is enough to decide IEEE-754 overflow at magnitude
        // 308 without retaining an arbitrarily long numeric token. Digits past
        // this point are far below binary64 rounding precision.
        if (number.firstNonZeroIndex !== null && number.significantPrefix.length < 320) {
            number.significantPrefix += character;
        }
    };
    const recordExponentDigit = (number, character) => {
        if (number.exponentSaturated) return;
        const digit = character.charCodeAt(0) - 0x30;
        if (number.exponentValue > Math.floor((exponentSaturation - digit) / 10)) {
            number.exponentValue = exponentSaturation;
            number.exponentSaturated = true;
            return;
        }
        number.exponentValue = number.exponentValue * 10 + digit;
    };
    const finishNumber = (number) => {
        if (!['zero', 'integer', 'fraction', 'exponent-digits'].includes(number.state)) {
            throw invalid();
        }
        if (number.firstNonZeroIndex === null) return;
        if (number.exponentSaturated) {
            if (!number.exponentNegative) throw invalid();
            return;
        }
        const explicitExponent = number.exponentNegative
            ? -number.exponentValue
            : number.exponentValue;
        const magnitude = number.digitsBeforeDecimal - number.firstNonZeroIndex - 1
            + explicitExponent;
        if (magnitude > 308) throw invalid();
        if (magnitude === 308) {
            const prefix = number.significantPrefix;
            const normalized = prefix.length === 1
                ? `${prefix}e308`
                : `${prefix[0]}.${prefix.slice(1)}e308`;
            if (!Number.isFinite(Number(normalized))) throw invalid();
        }
    };
    const processCharacter = (character) => {
        let reprocess = true;
        while (reprocess) {
            reprocess = false;
            if (token?.kind === 'string') {
                if (token.unicode > 0) {
                    if (!/[0-9a-fA-F]/.test(character)) throw invalid();
                    token.unicode--;
                    return;
                }
                if (token.escape) {
                    token.escape = false;
                    if (character === 'u') token.unicode = 4;
                    else if (!'"\\/bfnrt'.includes(character)) throw invalid();
                    return;
                }
                if (character === '\\') {
                    token.escape = true;
                    return;
                }
                if (character === '"') {
                    const role = token.role;
                    token = null;
                    if (role === 'key') stack[stack.length - 1].state = 'colon';
                    else completeValue();
                    return;
                }
                if (character.charCodeAt(0) < 0x20) throw invalid();
                return;
            }
            if (token?.kind === 'literal') {
                if (character !== token.expected[token.index]) throw invalid();
                token.index++;
                if (token.index === token.expected.length) {
                    token = null;
                    completeValue();
                }
                return;
            }
            if (token?.kind === 'number') {
                const number = token;
                const digit = character >= '0' && character <= '9';
                if (number.state === 'minus') {
                    if (!digit) throw invalid();
                    number.state = character === '0' ? 'zero' : 'integer';
                    recordMantissaDigit(number, character, true);
                    return;
                }
                if (number.state === 'zero') {
                    if (digit) throw invalid();
                    if (character === '.') {
                        number.state = 'decimal-point';
                        return;
                    }
                    if (character === 'e' || character === 'E') {
                        number.state = 'exponent';
                        return;
                    }
                } else if (number.state === 'integer') {
                    if (digit) {
                        recordMantissaDigit(number, character, true);
                        return;
                    }
                    if (character === '.') {
                        number.state = 'decimal-point';
                        return;
                    }
                    if (character === 'e' || character === 'E') {
                        number.state = 'exponent';
                        return;
                    }
                } else if (number.state === 'decimal-point') {
                    if (!digit) throw invalid();
                    number.state = 'fraction';
                    recordMantissaDigit(number, character, false);
                    return;
                } else if (number.state === 'fraction') {
                    if (digit) {
                        recordMantissaDigit(number, character, false);
                        return;
                    }
                    if (character === 'e' || character === 'E') {
                        number.state = 'exponent';
                        return;
                    }
                } else if (number.state === 'exponent') {
                    if (character === '+' || character === '-') {
                        number.exponentNegative = character === '-';
                        number.state = 'exponent-sign';
                        return;
                    }
                    if (!digit) throw invalid();
                    number.state = 'exponent-digits';
                    recordExponentDigit(number, character);
                    return;
                } else if (number.state === 'exponent-sign') {
                    if (!digit) throw invalid();
                    number.state = 'exponent-digits';
                    recordExponentDigit(number, character);
                    return;
                } else if (number.state === 'exponent-digits') {
                    if (digit) {
                        recordExponentDigit(number, character);
                        return;
                    }
                }
                finishNumber(number);
                token = null;
                completeValue();
                reprocess = true;
                continue;
            }

            if (character === ' ' || character === '\t'
                || character === '\r' || character === '\n') return;
            const current = stack[stack.length - 1];
            if (!current) {
                if (rootState !== 'value') throw invalid();
                beginValue(character);
                return;
            }
            if (current.kind === 'array') {
                if (current.state === 'value_or_end') {
                    if (character === ']') closeContainer('array');
                    else beginValue(character);
                    return;
                }
                if (current.state === 'value') {
                    beginValue(character);
                    return;
                }
                if (current.state === 'comma_or_end') {
                    if (character === ']') closeContainer('array');
                    else if (character === ',') current.state = 'value';
                    else throw invalid();
                    return;
                }
                throw invalid();
            }
            if (current.state === 'key_or_end') {
                if (character === '}') closeContainer('object');
                else if (character === '"') {
                    token = { kind: 'string', role: 'key', escape: false, unicode: 0 };
                } else throw invalid();
                return;
            }
            if (current.state === 'key') {
                if (character !== '"') throw invalid();
                token = { kind: 'string', role: 'key', escape: false, unicode: 0 };
                return;
            }
            if (current.state === 'colon') {
                if (character !== ':') throw invalid();
                current.state = 'value';
                return;
            }
            if (current.state === 'value') {
                beginValue(character);
                return;
            }
            if (current.state === 'comma_or_end') {
                if (character === '}') closeContainer('object');
                else if (character === ',') current.state = 'key';
                else throw invalid();
                return;
            }
            throw invalid();
        }
    };
    const processText = (text) => {
        if (token === null && stack.length === 0 && rootState === 'end' && /^[ \t\r\n]*$/.test(text)) {
            return;
        }
        for (const character of text) processCharacter(character);
    };

    try {
        const stat = await fileHandle.stat();
        const expected = size ?? stat.size;
        if (stat.size !== expected) {
            throw importFormatError('Import source changed after preflight', 'IMPORT_SOURCE_CHANGED');
        }
        assertImportSize(expected, maxBytes, 'Plugin storage row', 'PLUGIN_VALUE_TOO_LARGE');
        const page = Buffer.allocUnsafe(IMPORT_IO_PAGE_BYTES);
        while (offset < expected) {
            throwIfAborted(signal, shouldAbort);
            const read = await fileHandle.read(
                page,
                0,
                Math.min(page.length, expected - offset),
                offset,
            );
            if (read.bytesRead <= 0) {
                throw importFormatError('Plugin storage row is truncated', 'TRUNCATED_IMPORT_SOURCE');
            }
            processText(decoder.decode(page.subarray(0, read.bytesRead), { stream: true }));
            offset += read.bytesRead;
            await yieldToEventLoop();
        }
        processText(decoder.decode());
        if (token?.kind === 'number') {
            finishNumber(token);
            token = null;
            completeValue();
        }
        if (token !== null || stack.length !== 0 || rootState !== 'end') throw invalid();
        throwIfAborted(signal, shouldAbort);
        return { size: expected };
    } catch (error) {
        if (error instanceof ImportIngressError) throw error;
        throw invalid();
    } finally {
        await fileHandle.close();
    }
}

function crcTable() {
    const table = new Uint32Array(256);
    for (let index = 0; index < table.length; index++) {
        let value = index;
        for (let bit = 0; bit < 8; bit++) {
            value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        }
        table[index] = value >>> 0;
    }
    return table;
}

const CRC_TABLE = crcTable();

function updateCrc32(state, data) {
    let value = state;
    for (let index = 0; index < data.length; index++) {
        value = CRC_TABLE[(value ^ data[index]) & 0xff] ^ (value >>> 8);
    }
    return value >>> 0;
}

async function findZipEndRecord(fileHandle, size, options) {
    const searchStart = Math.max(0, size - ZIP_EOCD_MAX_BYTES);
    let end = size;
    while (end > searchStart) {
        const start = Math.max(searchStart, end - IMPORT_IO_PAGE_BYTES);
        const chunk = await readExact(fileHandle, start, end - start, options);
        let index = chunk.length;
        while ((index = chunk.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]), index - 1)) !== -1) {
            const position = start + index;
            if (position + 22 <= size) {
                const record = await readExact(fileHandle, position, 22, options);
                const commentLength = record.readUInt16LE(20);
                if (position + 22 + commentLength === size) return { position, record };
            }
        }
        if (start === searchStart) break;
        // A signature may straddle page boundaries; retain a three-byte overlap.
        end = start + 3;
    }
    throw importFormatError('ZIP end-of-central-directory record is missing', 'INVALID_SAVE_FOLDER_ZIP');
}

async function inspectZipFile(zipPath, {
    acceptEntry,
    maxEntries,
    maxExpandedBytes,
    signal,
    shouldAbort,
    onPage,
} = {}) {
    if (typeof acceptEntry !== 'function') throw new TypeError('acceptEntry is required');
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
        throw new TypeError('A finite positive ZIP entry limit is required');
    }
    if (!Number.isSafeInteger(maxExpandedBytes) || maxExpandedBytes <= 0) {
        throw new TypeError('A finite positive ZIP expansion limit is required');
    }
    const fileHandle = await fs.open(zipPath, 'r');
    try {
        const { size } = await fileHandle.stat();
        const { position: endPosition, record } = await findZipEndRecord(fileHandle, size, {
            signal,
            shouldAbort,
        });
        if (record.readUInt32LE(0) !== ZIP_EOCD_SIGNATURE) {
            throw importFormatError('ZIP end-of-central-directory record is invalid', 'INVALID_SAVE_FOLDER_ZIP');
        }
        const diskEntries = record.readUInt16LE(8);
        const entryCount = record.readUInt16LE(10);
        const centralSize = record.readUInt32LE(12);
        const centralOffset = record.readUInt32LE(16);
        if (diskEntries === 0xffff || entryCount === 0xffff
            || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
            throw importFormatError('ZIP64 save-folder archives are not supported', 'UNSUPPORTED_SAVE_FOLDER_ZIP64');
        }
        if (record.readUInt16LE(4) !== 0
            || record.readUInt16LE(6) !== 0
            || diskEntries !== entryCount) {
            throw importFormatError('Multi-disk ZIP archives are not supported', 'INVALID_SAVE_FOLDER_ZIP');
        }
        if (entryCount > maxEntries) {
            throw importSizeError('ZIP entry count', maxEntries, entryCount, 'IMPORT_ENTRY_COUNT_LIMIT');
        }
        if (!Number.isSafeInteger(centralOffset + centralSize)
            || centralOffset + centralSize !== endPosition) {
            throw importFormatError('ZIP central directory bounds are invalid', 'INVALID_SAVE_FOLDER_ZIP');
        }

        const entries = [];
        const acceptedKeys = new Set();
        let expandedBytes = 0;
        let cursor = centralOffset;
        for (let index = 0; index < entryCount; index++) {
            throwIfAborted(signal, shouldAbort);
            const fixed = await readExact(fileHandle, cursor, 46, { signal, shouldAbort });
            onPage?.({ kind: 'zip-central-header', size: fixed.length });
            if (fixed.readUInt32LE(0) !== ZIP_CENTRAL_SIGNATURE) {
                throw importFormatError('ZIP central directory entry is invalid', 'INVALID_SAVE_FOLDER_ZIP');
            }
            const flags = fixed.readUInt16LE(8);
            const compression = fixed.readUInt16LE(10);
            const expectedCrc32 = fixed.readUInt32LE(16);
            const compressedSize = fixed.readUInt32LE(20);
            const uncompressedSize = fixed.readUInt32LE(24);
            const nameLength = fixed.readUInt16LE(28);
            const extraLength = fixed.readUInt16LE(30);
            const commentLength = fixed.readUInt16LE(32);
            const diskStart = fixed.readUInt16LE(34);
            const localHeaderOffset = fixed.readUInt32LE(42);
            if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff
                || localHeaderOffset === 0xffffffff || diskStart === 0xffff) {
                throw importFormatError('ZIP64 save-folder entries are not supported', 'UNSUPPORTED_SAVE_FOLDER_ZIP64');
            }
            const recordSize = 46 + nameLength + extraLength + commentLength;
            if (!Number.isSafeInteger(cursor + recordSize)
                || cursor + recordSize > centralOffset + centralSize) {
                throw importFormatError('ZIP central directory entry is truncated', 'INVALID_SAVE_FOLDER_ZIP');
            }
            const nameBytes = await readExact(fileHandle, cursor + 46, nameLength, {
                signal,
                shouldAbort,
            });
            onPage?.({ kind: 'zip-entry-name', size: nameBytes.length });
            const name = nameBytes.toString((flags & 0x800) !== 0 ? 'utf8' : 'latin1');
            const accepted = acceptEntry(name);
            if (accepted) {
                const key = typeof accepted === 'string' ? accepted : accepted.key;
                if (typeof key !== 'string' || key.length === 0) {
                    throw importFormatError('ZIP entry resolved to an invalid storage key', 'INVALID_SAVE_FOLDER_ENTRY');
                }
                if (acceptedKeys.has(key)) {
                    throw importFormatError(`Duplicate save-folder entry: ${key}`, 'DUPLICATE_SAVE_FOLDER_ENTRY');
                }
                acceptedKeys.add(key);
                if ((flags & ZIP_ENCRYPTION_FLAGS) !== 0) {
                    throw importFormatError('Encrypted save-folder ZIP entries are not supported', 'ENCRYPTED_SAVE_FOLDER_ENTRY');
                }
                if (diskStart !== 0 || (compression !== 0 && compression !== 8)) {
                    throw importFormatError('Save-folder ZIP entry uses unsupported compression', 'UNSUPPORTED_SAVE_FOLDER_COMPRESSION');
                }
                const nextExpanded = expandedBytes + uncompressedSize;
                if (!Number.isSafeInteger(nextExpanded) || nextExpanded > maxExpandedBytes) {
                    throw importSizeError(
                        'Expanded save-folder archive',
                        maxExpandedBytes,
                        nextExpanded,
                        'IMPORT_EXPANDED_SIZE_LIMIT',
                    );
                }
                expandedBytes = nextExpanded;
                entries.push({
                    key,
                    name,
                    nameBytes,
                    flags,
                    compression,
                    expectedCrc32,
                    compressedSize,
                    uncompressedSize,
                    localHeaderOffset,
                    dataLimit: centralOffset,
                });
            }
            cursor += recordSize;
            await yieldToEventLoop();
        }
        if (cursor !== centralOffset + centralSize) {
            throw importFormatError('ZIP central directory size does not match its entries', 'INVALID_SAVE_FOLDER_ZIP');
        }
        return { zipPath, size, entries, entryCount, expandedBytes };
    } finally {
        await fileHandle.close();
    }
}

async function extractZipEntry(zipPath, entry, destinationPath, {
    signal,
    shouldAbort,
    onPage,
} = {}) {
    const handle = await fs.open(zipPath, 'r');
    let local;
    try {
        local = await readExact(handle, entry.localHeaderOffset, 30, { signal, shouldAbort });
        if (local.readUInt32LE(0) !== ZIP_LOCAL_SIGNATURE
            || local.readUInt16LE(8) !== entry.compression) {
            throw importFormatError('ZIP local entry header does not match the central directory', 'INVALID_SAVE_FOLDER_ZIP');
        }
        const localFlags = local.readUInt16LE(6);
        const nameLength = local.readUInt16LE(26);
        const extraLength = local.readUInt16LE(28);
        if ((localFlags & ZIP_ENCRYPTION_FLAGS) !== 0) {
            throw importFormatError('Encrypted save-folder ZIP entries are not supported', 'ENCRYPTED_SAVE_FOLDER_ENTRY');
        }
        if (localFlags !== entry.flags) {
            throw importFormatError('ZIP local entry flags do not match the central directory', 'INVALID_SAVE_FOLDER_ZIP');
        }
        if ((localFlags & 0x0008) === 0
            && (local.readUInt32LE(14) !== entry.expectedCrc32
                || local.readUInt32LE(18) !== entry.compressedSize
                || local.readUInt32LE(22) !== entry.uncompressedSize)) {
            throw importFormatError('ZIP local entry metadata does not match the central directory', 'INVALID_SAVE_FOLDER_ZIP');
        }
        const localName = await readExact(handle, entry.localHeaderOffset + 30, nameLength, {
            signal,
            shouldAbort,
        });
        if (!localName.equals(entry.nameBytes)) {
            throw importFormatError('ZIP local entry name does not match the central directory', 'INVALID_SAVE_FOLDER_ZIP');
        }
        entry.dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
        if (!Number.isSafeInteger(entry.dataOffset + entry.compressedSize)
            || entry.dataOffset + entry.compressedSize > entry.dataLimit) {
            throw importFormatError('ZIP entry data bounds are invalid', 'INVALID_SAVE_FOLDER_ZIP');
        }
    } finally {
        await handle.close();
    }

    const output = await fs.open(destinationPath, 'wx', 0o600);
    let input;
    let decoded;
    let inflater;
    let actualSize = 0;
    let pages = 0;
    let maxPageBytes = 0;
    let crc = 0xffffffff;
    try {
        if (entry.compressedSize > 0) {
            input = fsSync.createReadStream(zipPath, {
                start: entry.dataOffset,
                end: entry.dataOffset + entry.compressedSize - 1,
                highWaterMark: IMPORT_IO_PAGE_BYTES,
            });
        }
        if (entry.compressedSize === 0 && entry.uncompressedSize !== 0) {
            throw importFormatError('ZIP entry has no compressed bytes', 'INVALID_SAVE_FOLDER_ZIP');
        }
        if (entry.compression === 8) {
            input ??= Readable.from([]);
            inflater = zlib.createInflateRaw({ chunkSize: IMPORT_IO_PAGE_BYTES });
            decoded = input.pipe(inflater);
        } else {
            decoded = input;
        }
        if (decoded) {
            for await (const chunk of decoded) {
                throwIfAborted(signal, shouldAbort);
                for (let offset = 0; offset < chunk.length; offset += IMPORT_IO_PAGE_BYTES) {
                    const chunkBuffer = Buffer.isBuffer(chunk)
                        ? chunk
                        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
                    const page = chunkBuffer.subarray(
                        offset,
                        Math.min(chunk.length, offset + IMPORT_IO_PAGE_BYTES),
                    );
                    const nextSize = actualSize + page.length;
                    if (!Number.isSafeInteger(nextSize) || nextSize > entry.uncompressedSize) {
                        throw importFormatError('ZIP entry expands beyond its declared size', 'CORRUPT_SAVE_FOLDER_ENTRY');
                    }
                    await writeAll(output, page);
                    crc = updateCrc32(crc, page);
                    actualSize = nextSize;
                    pages++;
                    maxPageBytes = Math.max(maxPageBytes, page.length);
                    onPage?.({ index: pages - 1, size: page.length, total: actualSize });
                    await yieldToEventLoop();
                    throwIfAborted(signal, shouldAbort);
                }
            }
        }
        // Raw DEFLATE permits consumers to stop at an end marker. ZIP entries
        // do not: every declared compressed byte must belong to that stream.
        if (inflater && inflater.bytesWritten !== entry.compressedSize) {
            throw importFormatError('ZIP entry contains bytes after its compressed stream', 'CORRUPT_SAVE_FOLDER_ENTRY');
        }
        if (actualSize !== entry.uncompressedSize
            || ((crc ^ 0xffffffff) >>> 0) !== entry.expectedCrc32) {
            throw importFormatError('ZIP entry length or CRC32 is invalid', 'CORRUPT_SAVE_FOLDER_ENTRY');
        }
        await output.sync();
        await output.close();
        return {
            key: entry.key,
            filePath: destinationPath,
            size: actualSize,
            pages,
            maxPageBytes,
        };
    } catch (error) {
        input?.destroy();
        if (decoded && decoded !== input) decoded.destroy();
        try { await output.close(); } catch {}
        await fs.unlink(destinationPath).catch(() => {});
        if (typeof error?.code === 'string' && error.code.startsWith('Z_')) {
            throw importFormatError('ZIP compressed stream is invalid', 'CORRUPT_SAVE_FOLDER_ENTRY');
        }
        throw error;
    }
}

async function extractZipEntries(inventory, stageDir, options = {}) {
    await fs.mkdir(stageDir, { recursive: true, mode: 0o700 });
    const sources = [];
    try {
        for (let index = 0; index < inventory.entries.length; index++) {
            throwIfAborted(options.signal, options.shouldAbort);
            const destination = path.join(stageDir, `${String(index).padStart(8, '0')}.row`);
            sources.push(await extractZipEntry(
                inventory.zipPath,
                inventory.entries[index],
                destination,
                options,
            ));
        }
        return sources;
    } catch (error) {
        await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
        throw error;
    }
}

module.exports = {
    IMPORT_IO_PAGE_BYTES,
    SAVE_FOLDER_IMPORT_STAGE_PREFIX,
    ImportIngressError,
    finiteByteLimit,
    importSizeError,
    importFormatError,
    importAbortError,
    importErrorPayload,
    assertImportSize,
    throwIfAborted,
    createImportAbortTracker,
    spoolAsyncIterable,
    copyFileToSpool,
    readFileToBufferBounded,
    validateJsonFileStreaming,
    inspectZipFile,
    extractZipEntry,
    extractZipEntries,
};
