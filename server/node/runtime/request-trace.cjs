const fs = require('fs/promises');
const path = require('path');
const nodeCrypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);
const TRACE_FILE_SUFFIX = '.json.gz';
const DEFAULT_MAX_TRACES = 500;

function isRequestTracingEnabled(env = process.env) {
    return env.TRACE_REQUEST_FOR_DEBUG === 'true';
}

function headerValue(headers, name) {
    const value = headers?.[name];
    return Array.isArray(value) ? value.join(',') : String(value ?? '');
}

function isWebSocketUpgradeRequest(req) {
    const upgrade = headerValue(req?.headers, 'upgrade').trim().toLowerCase();
    const connectionTokens = headerValue(req?.headers, 'connection')
        .toLowerCase()
        .split(',')
        .map(token => token.trim());
    return upgrade === 'websocket' || connectionTokens.includes('upgrade');
}

function isStreamingResponseContentType(res) {
    const contentType = String(res.getHeader?.('content-type') ?? '').toLowerCase();
    return contentType.includes('text/event-stream')
        || contentType.includes('application/x-ndjson');
}

function isTextualContentType(contentType) {
    const normalized = String(contentType ?? '').toLowerCase();
    return normalized.startsWith('text/')
        || normalized.includes('json')
        || normalized.includes('javascript')
        || normalized.includes('xml')
        || normalized.includes('x-www-form-urlencoded')
        || normalized.includes('graphql');
}

function bufferTraceBody(buffer, contentType) {
    if (!buffer || buffer.length === 0) return null;
    const textual = isTextualContentType(contentType);
    return {
        encoding: textual ? 'utf8' : 'base64',
        byteLength: buffer.length,
        data: buffer.toString(textual ? 'utf8' : 'base64'),
    };
}

function requestTraceBody(body, contentType) {
    if (body === undefined) return null;
    if (Buffer.isBuffer(body)) return bufferTraceBody(body, contentType);
    if (body instanceof Uint8Array) {
        return bufferTraceBody(Buffer.from(body.buffer, body.byteOffset, body.byteLength), contentType);
    }
    if (typeof body === 'string') {
        const buffer = Buffer.from(body);
        return {
            encoding: 'utf8',
            byteLength: buffer.length,
            data: body,
        };
    }

    try {
        const json = JSON.stringify(body);
        return {
            encoding: 'json',
            byteLength: Buffer.byteLength(json),
            data: JSON.parse(json),
        };
    } catch {
        return {
            encoding: 'unavailable',
            byteLength: null,
            data: '[Request body could not be serialized]',
        };
    }
}

function responseEndBuffer(chunk, encoding) {
    if (chunk === undefined || chunk === null || typeof chunk === 'function') return null;
    if (Buffer.isBuffer(chunk)) return chunk;
    if (chunk instanceof Uint8Array) {
        return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    if (typeof chunk === 'string') {
        return Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined);
    }
    return null;
}

async function listTraceFiles(traceDir) {
    const entries = await fs.readdir(traceDir, { withFileTypes: true });
    const files = [];
    await Promise.all(entries.map(async (entry) => {
        if (!entry.isFile() || !entry.name.endsWith(TRACE_FILE_SUFFIX)) return;
        const filePath = path.join(traceDir, entry.name);
        try {
            const stat = await fs.stat(filePath);
            files.push({ name: entry.name, path: filePath, mtimeMs: stat.mtimeMs });
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }));
    files.sort((left, right) => left.mtimeMs - right.mtimeMs
        || left.name.localeCompare(right.name));
    return files;
}

async function enforceTraceLimit(traceDir, maxTraces) {
    const files = await listTraceFiles(traceDir);
    const excess = Math.max(0, files.length - maxTraces);
    for (let index = 0; index < excess; index += 1) {
        try {
            await fs.unlink(files[index].path);
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
}

function traceFilename(timestampMs) {
    const timestamp = new Date(timestampMs).toISOString().replaceAll(':', '-');
    return `request-${timestamp}-${process.pid}-${nodeCrypto.randomUUID()}${TRACE_FILE_SUFFIX}`;
}

function createRequestTracer(options = {}) {
    const traceDir = path.resolve(options.traceDir ?? path.join(process.cwd(), 'save', 'trace'));
    const maxTraces = Number.isSafeInteger(options.maxTraces) && options.maxTraces > 0
        ? options.maxTraces
        : DEFAULT_MAX_TRACES;
    const isStreamingRequest = typeof options.isStreamingRequest === 'function'
        ? options.isStreamingRequest
        : () => false;
    const onError = typeof options.onError === 'function' ? options.onError : () => {};
    let workQueue = Promise.resolve();

    function reportError(context, error) {
        try {
            onError(context, error);
        } catch {
            // Debug tracing must never interfere with request handling.
        }
    }

    function enqueue(context, task) {
        workQueue = workQueue.then(async () => {
            try {
                await task();
            } catch (error) {
                reportError(context, error);
            }
        });
    }

    async function writeTrace(trace) {
        await fs.mkdir(traceDir, { recursive: true, mode: 0o700 });
        const finalPath = path.join(traceDir, traceFilename(trace.startedAtMs));
        const temporaryPath = `${finalPath}.${nodeCrypto.randomUUID()}.tmp`;
        const payload = Buffer.from(JSON.stringify(trace, null, 2));
        const compressed = await gzip(payload);
        try {
            await fs.writeFile(temporaryPath, compressed, { flag: 'wx', mode: 0o600 });
            await fs.rename(temporaryPath, finalPath);
        } catch (error) {
            try { await fs.unlink(temporaryPath); } catch {}
            throw error;
        }
        await enforceTraceLimit(traceDir, maxTraces);
    }

    enqueue('initializing the trace directory', async () => {
        await fs.mkdir(traceDir, { recursive: true, mode: 0o700 });
        await enforceTraceLimit(traceDir, maxTraces);
    });

    function middleware(req, res, next) {
        if (isWebSocketUpgradeRequest(req)) return next();

        const startedAtMs = Date.now();
        const responseChunks = [];
        let streamingResponse = false;
        const originalWrite = res.write;
        const originalEnd = res.end;
        const originalFlushHeaders = res.flushHeaders;

        res.write = function tracedWrite(...args) {
            streamingResponse = true;
            responseChunks.length = 0;
            return originalWrite.apply(this, args);
        };
        res.end = function tracedEnd(...args) {
            if (!streamingResponse) {
                try {
                    const chunk = responseEndBuffer(args[0], args[1]);
                    if (chunk) responseChunks.push(chunk);
                } catch {
                    responseChunks.length = 0;
                }
            }
            return originalEnd.apply(this, args);
        };
        if (typeof originalFlushHeaders === 'function') {
            res.flushHeaders = function tracedFlushHeaders(...args) {
                streamingResponse = true;
                responseChunks.length = 0;
                return originalFlushHeaders.apply(this, args);
            };
        }

        res.once('finish', () => {
            let streamingRequest = true;
            try {
                streamingRequest = isStreamingRequest(req);
            } catch (error) {
                reportError('classifying a request', error);
            }
            if (streamingRequest
                || streamingResponse
                || isStreamingResponseContentType(res)
                || isWebSocketUpgradeRequest(req)) {
                return;
            }

            const completedAtMs = Date.now();
            const requestContentType = req.headers?.['content-type'];
            const responseContentType = res.getHeader('content-type');
            const responseBuffer = responseChunks.length > 0
                ? Buffer.concat(responseChunks)
                : null;
            const trace = {
                version: 1,
                startedAt: new Date(startedAtMs).toISOString(),
                startedAtMs,
                completedAt: new Date(completedAtMs).toISOString(),
                durationMs: completedAtMs - startedAtMs,
                request: {
                    method: req.method,
                    url: req.originalUrl || req.url,
                    httpVersion: req.httpVersion,
                    remoteAddress: req.socket?.remoteAddress ?? null,
                    headers: { ...req.headers },
                    body: requestTraceBody(req.body, requestContentType),
                },
                response: {
                    statusCode: res.statusCode,
                    statusMessage: res.statusMessage,
                    headers: { ...res.getHeaders() },
                    body: bufferTraceBody(responseBuffer, responseContentType),
                },
            };
            enqueue('writing a request trace', () => writeTrace(trace));
        });

        return next();
    }

    return {
        middleware,
        flush: () => workQueue,
        traceDir,
    };
}

module.exports = {
    DEFAULT_MAX_TRACES,
    TRACE_FILE_SUFFIX,
    createRequestTracer,
    enforceTraceLimit,
    isRequestTracingEnabled,
    isStreamingResponseContentType,
    isWebSocketUpgradeRequest,
};
