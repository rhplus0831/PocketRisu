'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const {
    admissionPayload,
    isChatDeltaRequest,
    parseContentLength,
} = require('./bufferedIngress.cjs');

const ADMITTED_INGRESS_SPOOL = Symbol('admittedIngressSpool');
const ADMITTED_INGRESS_SPOOL_PREFIX = '.admitted-ingress-';
const ADMITTED_WRITE_STAGE_PREFIX = '.admitted-write-stage-';
const SPOOL_PAGE_BYTES = 64 * 1024;

const metrics = {
    requests: 0,
    bytes: 0,
    pages: 0,
    maxPageBytes: 0,
    active: 0,
    maxActive: 0,
    failures: 0,
};

function shouldSpoolAdmittedIngress(req, policy, { disabled = false } = {}) {
    if (disabled || !policy || policy.admissionOnly) return false;
    if (req.method === 'POST' && req.path === '/api/write') {
        return policy.bodyKind === 'raw';
    }
    return req.method === 'POST'
        && /^\/api\/chat-content\/[^/]+\/[^/]+$/.test(req.path)
        && !isChatDeltaRequest(req)
        && (policy.bodyKind === 'raw' || policy.bodyKind === 'json');
}

function isAdmittedSpoolPressureError(error) {
    return error?.code === 'ENOSPC'
        || error?.code === 'EDQUOT'
        || error?.code === 'EFBIG'
        || error?.code === 'EROFS'
        || error?.code === 'EACCES'
        || error?.code === 'EPERM'
        || error?.code === 'ENOENT'
        || error?.code === 'ENOTDIR';
}

function sendRetryableSpoolRefusal(res, policy, limit, actual) {
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    res.setHeader('Connection', 'close');
    res.setHeader('Retry-After', '1');
    res.status(503).json(admissionPayload(policy, {
        code: 'BUFFERED_INGRESS_BUSY',
        error: 'The server is already buffering its configured ingress budget. Retry shortly.',
        limit,
        actual,
        retryable: true,
    }));
}

async function availableBytes(spoolDir) {
    try {
        const stat = await fs.statfs(spoolDir);
        const bytes = Number(stat.bavail) * Number(stat.bsize);
        return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
    } catch {
        return null;
    }
}

async function writeAll(handle, page) {
    let offset = 0;
    while (offset < page.length) {
        const result = await handle.write(page, offset, page.length - offset);
        if (result.bytesWritten <= 0) {
            const error = new Error('Admitted ingress spool write made no progress');
            error.code = 'ENOSPC';
            throw error;
        }
        offset += result.bytesWritten;
    }
}

function createAdmittedIngressSpoolMiddleware({
    policySymbol,
    spoolDir,
    disabled = false,
    globalBudgetBytes,
}) {
    if (!policySymbol || typeof spoolDir !== 'function') {
        throw new TypeError('policySymbol and a spoolDir resolver are required');
    }
    return async (req, res, next) => {
        const policy = req[policySymbol];
        if (!shouldSpoolAdmittedIngress(req, policy, { disabled })) return next();
        const expectedBytes = parseContentLength(req.headers['content-length']);
        if (expectedBytes === null) return next(new Error('Admitted ingress lost its Content-Length'));
        const root = spoolDir();
        const freeBytes = await availableBytes(root);
        if (freeBytes !== null && freeBytes < expectedBytes) {
            metrics.failures++;
            sendRetryableSpoolRefusal(
                res,
                policy,
                globalBudgetBytes ?? policy.maxBytes,
                expectedBytes,
            );
            return;
        }

        const filePath = path.join(
            root,
            `${ADMITTED_INGRESS_SPOOL_PREFIX}${process.pid}-${crypto.randomUUID()}.tmp`,
        );
        let handle;
        let size = 0;
        let pages = 0;
        let maxPageBytes = 0;
        let disposed = false;
        const dispose = async () => {
            if (disposed) return;
            disposed = true;
            await fs.unlink(filePath).catch(() => {});
        };
        metrics.active++;
        metrics.maxActive = Math.max(metrics.maxActive, metrics.active);
        try {
            handle = await fs.open(filePath, 'wx', 0o600);
            for await (const sourceChunk of req) {
                const chunk = Buffer.isBuffer(sourceChunk)
                    ? sourceChunk
                    : Buffer.from(sourceChunk);
                for (let offset = 0; offset < chunk.length; offset += SPOOL_PAGE_BYTES) {
                    const page = chunk.subarray(
                        offset,
                        Math.min(chunk.length, offset + SPOOL_PAGE_BYTES),
                    );
                    const nextSize = size + page.length;
                    if (!Number.isSafeInteger(nextSize) || nextSize > expectedBytes) {
                        const error = new Error('Request body exceeded its declared Content-Length');
                        error.code = 'ADMITTED_INGRESS_LENGTH_CHANGED';
                        throw error;
                    }
                    await writeAll(handle, page);
                    size = nextSize;
                    pages++;
                    maxPageBytes = Math.max(maxPageBytes, page.length);
                }
            }
            if (size !== expectedBytes) {
                const error = new Error('Request body ended before its declared Content-Length');
                error.code = 'ADMITTED_INGRESS_LENGTH_CHANGED';
                throw error;
            }
            await handle.sync();
            await handle.close();
            handle = null;
            req[ADMITTED_INGRESS_SPOOL] = {
                filePath,
                size,
                bodyKind: policy.bodyKind,
                pages,
                maxPageBytes,
                dispose,
            };
            metrics.requests++;
            metrics.bytes += size;
            metrics.pages += pages;
            metrics.maxPageBytes = Math.max(metrics.maxPageBytes, maxPageBytes);
            res.once('finish', dispose);
            res.once('close', dispose);
            next();
        } catch (error) {
            metrics.failures++;
            try { await handle?.close(); } catch {}
            await dispose();
            if (isAdmittedSpoolPressureError(error)) {
                sendRetryableSpoolRefusal(
                    res,
                    policy,
                    globalBudgetBytes ?? policy.maxBytes,
                    expectedBytes,
                );
                return;
            }
            next(error);
        } finally {
            metrics.active--;
        }
    };
}

async function disposeAdmittedIngressSpool(req) {
    await req?.[ADMITTED_INGRESS_SPOOL]?.dispose?.();
}

function admittedIngressSpoolMetrics() {
    return { ...metrics };
}

function resetAdmittedIngressSpoolMetricsForTests() {
    if (metrics.active !== 0) throw new Error('Cannot reset active ingress-spool metrics');
    for (const key of Object.keys(metrics)) metrics[key] = 0;
}

module.exports = {
    ADMITTED_INGRESS_SPOOL,
    ADMITTED_INGRESS_SPOOL_PREFIX,
    ADMITTED_WRITE_STAGE_PREFIX,
    SPOOL_PAGE_BYTES,
    shouldSpoolAdmittedIngress,
    isAdmittedSpoolPressureError,
    sendRetryableSpoolRefusal,
    createAdmittedIngressSpoolMiddleware,
    disposeAdmittedIngressSpool,
    admittedIngressSpoolMetrics,
    resetAdmittedIngressSpoolMetricsForTests,
};
