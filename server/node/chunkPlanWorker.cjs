'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { parentPort, workerData } = require('worker_threads');

const MIN_SIZE = 4096;
const MAX_SIZE = 65536;
const MASK = 0x3fff;
const GEAR = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
    GEAR[index] = Math.imul(index + 1, 2654435761) >>> 0;
}

function readRange(fd, length, position) {
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
        const bytesRead = fs.readSync(fd, buffer, offset, length - offset, position + offset);
        if (bytesRead <= 0) throw new Error(`Unexpected end of spool at byte ${position + offset}`);
        offset += bytesRead;
    }
    return buffer;
}

function firstBoundary(buffer) {
    const end = buffer.length;
    let hash = 0;
    for (let index = Math.min(MIN_SIZE, end); index < end; index++) {
        hash = ((hash << 1) + GEAR[buffer[index]]) >>> 0;
        if ((hash & MASK) === 0) return index + 1;
    }
    return end;
}

function fileIdentity(stat) {
    return {
        size: stat.size,
        dev: String(stat.dev),
        ino: String(stat.ino),
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
    };
}

function buildPlan(filePath) {
    if (workerData?.forceFailure) throw new Error('Injected chunk-plan worker failure');
    const fd = fs.openSync(filePath, 'r');
    try {
        const before = fs.fstatSync(fd);
        if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 0) {
            throw new Error('Chunk-plan source must be a finite regular file');
        }
        const sha256 = crypto.createHash('sha256');
        const md5 = crypto.createHash('md5');
        const chunks = [];
        let position = 0;
        let maxWindowBytes = 0;
        while (position < before.size) {
            const window = readRange(fd, Math.min(MAX_SIZE, before.size - position), position);
            maxWindowBytes = Math.max(maxWindowBytes, window.length);
            const length = firstBoundary(window);
            const data = window.subarray(0, length);
            const hash = crypto.createHash('sha256').update(data).digest('hex');
            sha256.update(data);
            md5.update(data);
            chunks.push({ offset: position, length, hash });
            position += length;
        }
        const after = fs.fstatSync(fd);
        const beforeIdentity = fileIdentity(before);
        const afterIdentity = fileIdentity(after);
        if (JSON.stringify(beforeIdentity) !== JSON.stringify(afterIdentity)) {
            throw new Error('Chunk-plan source changed during worker inspection');
        }
        return {
            version: 1,
            identity: afterIdentity,
            size: after.size,
            sha256: sha256.digest('hex'),
            md5: md5.digest('hex'),
            chunks,
            maxWindowBytes,
            cdcPasses: 1,
            logicalDigestPasses: 1,
        };
    } finally {
        fs.closeSync(fd);
    }
}

try {
    parentPort.postMessage({ ok: true, plan: buildPlan(workerData.filePath) });
} catch (error) {
    parentPort.postMessage({
        ok: false,
        error: error?.message || String(error),
        code: error?.code,
    });
}
