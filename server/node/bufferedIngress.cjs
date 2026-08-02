'use strict';

const { CHAT_DELTA_CONTENT_TYPE } = require('./chatDelta.cjs');

const BUFFERED_INGRESS_POLICY = Symbol('bufferedIngressPolicy');
const CLIENT_BUILD_HEADER = 'x-client-build';
const CLIENT_UPGRADE_REQUIRED_CODE = 'CLIENT_UPGRADE_REQUIRED';
const RETIRED_PLUGIN_STORAGE_TRANSITION_PATH = '/api/plugin-storage/transition';

const MIB = 1024 * 1024;
const DEFAULT_BUFFERED_INGRESS_MAX_BYTES = 512 * MIB;
const DEFAULT_DATABASE_WRITE_MAX_BYTES = 512 * MIB;
const DEFAULT_KV_WRITE_MAX_BYTES = 256 * MIB;
const DEFAULT_CHAT_WRITE_MAX_BYTES = 128 * MIB;
const DEFAULT_PROXY_BODY_MAX_BYTES = 100 * MIB;

function positiveIntegerFromEnv(name, fallback, env = process.env) {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function createBufferedIngressLimits({
    env = process.env,
    pluginValueMaxBytes,
    pluginStorageMaxBytes,
    pluginBatchMaxBytes,
} = {}) {
    return Object.freeze({
        global: positiveIntegerFromEnv(
            'POCKETRISU_BUFFERED_INGRESS_MAX_BYTES',
            DEFAULT_BUFFERED_INGRESS_MAX_BYTES,
            env,
        ),
        database: positiveIntegerFromEnv(
            'POCKETRISU_DATABASE_WRITE_MAX_BYTES',
            DEFAULT_DATABASE_WRITE_MAX_BYTES,
            env,
        ),
        kv: positiveIntegerFromEnv(
            'POCKETRISU_KV_WRITE_MAX_BYTES',
            DEFAULT_KV_WRITE_MAX_BYTES,
            env,
        ),
        chat: positiveIntegerFromEnv(
            'POCKETRISU_CHAT_WRITE_MAX_BYTES',
            DEFAULT_CHAT_WRITE_MAX_BYTES,
            env,
        ),
        proxy: positiveIntegerFromEnv(
            'POCKETRISU_PROXY_BODY_MAX_BYTES',
            DEFAULT_PROXY_BODY_MAX_BYTES,
            env,
        ),
        pluginValue: pluginValueMaxBytes,
        pluginStorage: pluginStorageMaxBytes,
        pluginBatch: pluginBatchMaxBytes,
        json: 100 * MIB,
        jsonControl: 8 * MIB,
        jsonPatch: 32 * MIB,
        jsonLog: 16 * MIB,
        jsonPublic: 64 * 1024,
        jsonReadCached: 1 * MIB,
    });
}

function createInFlightByteBudget(maxBytes) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new TypeError('maxBytes must be a positive safe integer');
    }
    let usedBytes = 0;

    function tryReserve(bytes) {
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxBytes - usedBytes) {
            return null;
        }
        usedBytes += bytes;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            usedBytes -= bytes;
        };
    }

    return {
        maxBytes,
        tryReserve,
        snapshot: () => ({ maxBytes, usedBytes, availableBytes: maxBytes - usedBytes }),
    };
}

function parseContentLength(value) {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

function requestBodyKind(req) {
    const contentType = String(req.headers?.['content-type'] ?? '')
        .split(';', 1)[0]
        .trim()
        .toLowerCase();
    if (contentType === 'application/octet-stream') return 'raw';
    if (contentType === 'application/json' || contentType.endsWith('+json')) return 'json';
    if (contentType === 'text/plain') return 'text';
    return null;
}

function isChatDeltaRequest(req) {
    return String(req.headers?.['content-type'] ?? '')
        .split(';', 1)[0]
        .trim()
        .toLowerCase() === CHAT_DELTA_CONTENT_TYPE;
}

function isStreamedIngress(req) {
    const requestPath = req.path;
    if (requestPath === '/api/backup/import'
        || requestPath === '/api/migrate/save-folder/upload'
        || requestPath === '/api/plugin-storage/transition/stage/upload'
        || requestPath === '/api/plugin-storage/transition/bulk') return true;
    if (requestPath === '/api/plugin-storage/mutate') {
        return req.headers['x-plugin-storage-stream'] === '1';
    }
    if (requestPath === '/api/plugin-storage/batch') {
        return req.headers['x-plugin-storage-batch-stream'] === '1';
    }
    return false;
}

const WRITER_ROUTES = new Set([
    'GET /api/remove',
    'POST /api/db/create-if-absent',
    'POST /api/plugin-storage/clear',
    'POST /api/inlays/delete-unreferenced',
    'POST /api/plugin-storage/reconcile-boot',
    'POST /api/plugin-storage/batch',
    'POST /api/plugin-storage/mutate',
    'DELETE /api/logs',
    'DELETE /api/request-logs',
    'POST /api/plugin-storage/transition/stage/begin',
    'POST /api/plugin-storage/transition/stage/upload',
    'POST /api/plugin-storage/transition/stage/abort',
    'POST /api/plugin-storage/transition/stage/finalize',
    'POST /api/plugin-storage/transition/bulk',
    'POST /api/plugin-storage/transition',
    'POST /api/write',
    'POST /api/db/flush',
    'POST /api/patch',
    'POST /api/assets/bulk-write',
    'POST /api/backup/import/prepare',
    'POST /api/backup/import',
    'POST /api/backup/server/save',
    'POST /api/backup/server/restore',
    'POST /api/migrate/save-folder/scan',
    'POST /api/migrate/save-folder/execute',
    'POST /api/migrate/save-folder/upload',
    'POST /api/migrate/save-folder/cleanup/scan',
    'POST /api/migrate/save-folder/cleanup/execute',
    'POST /api/assets/cleanup',
    'POST /api/db/optimize',
    'PUT /api/db/durability',
    'POST /api/db/wal-checkpoint',
    'PUT /api/db/snapshots/limits',
    'DELETE /api/db/snapshots',
    'POST /api/db/snapshots/restore',
    'PUT /api/backup/boot-reminder',
    'PUT /api/backup/server/path',
    'POST /api/inlays/compress',
]);

function isWriterRoute(req) {
    if (WRITER_ROUTES.has(`${req.method} ${req.path}`)) return true;
    if (req.method === 'POST' && /^\/api\/chat-content\/[^/]+\/[^/]+$/.test(req.path)) {
        return true;
    }
    if (req.method === 'DELETE' && /^\/api\/backup\/server\/[^/]+$/.test(req.path)) {
        return true;
    }
    return false;
}

function authMode(req) {
    if (req.path.startsWith('/hub-proxy/')) {
        return String(req.headers.authorization ?? '').toLowerCase()
            === 'x-node-server-auth'.toLowerCase()
            ? 'jwt'
            : 'none';
    }
    if (req.path === '/api/login'
        || req.path === '/api/crypto'
        || req.path === '/api/set_password') return 'none';
    if (req.path === '/api/token/refresh') return 'jwt-expired';
    if (req.path === '/api/db/flush' || req.path === '/api/inlays/compress') return 'cookie';
    if (req.path === '/proxy'
        || req.path === '/proxy2'
        || req.path === '/proxy-stream-jobs'
        || req.path.startsWith('/api/')) return 'jwt';
    return 'none';
}

function decodeFilePath(req) {
    const encoded = req.headers['file-path'];
    if (typeof encoded !== 'string'
        || encoded.length % 2 !== 0
        || !/^[0-9a-f]+$/i.test(encoded)) return '';
    return Buffer.from(encoded, 'hex').toString('utf8');
}

function jsonLimit(req, limits) {
    if (req.path === '/api/login'
        || req.path === '/api/crypto'
        || req.path === '/api/set_password'
        || req.path === '/api/token/refresh') return limits.jsonPublic;
    if (req.path === '/api/db/read-cached') return limits.jsonReadCached;
    if (req.path === '/api/patch') return limits.jsonPatch;
    if (req.path.startsWith('/api/chat-content/')) {
        return isChatDeltaRequest(req)
            ? limits.jsonPatch
            : Math.min(limits.chat, limits.json);
    }
    if (req.path === '/api/plugin-storage/transition/stage/begin') return 64 * MIB;
    if (req.path === '/proxy'
        || req.path === '/proxy2'
        || req.path.startsWith('/hub-proxy/')) return limits.proxy;
    if (req.path === '/proxy-stream-jobs') return 16 * MIB;
    if (req.path === '/api/assets/bulk-write'
        || req.path === '/api/model-jobs') return limits.json;
    if (req.path === '/api/logs' || req.path === '/api/request-logs') return limits.jsonLog;
    return limits.jsonControl;
}

function rawPolicy(req, limits) {
    if (req.path === '/proxy'
        || req.path === '/proxy2'
        || req.path.startsWith('/hub-proxy/')) {
        return { maxBytes: limits.proxy, responseKind: 'generic' };
    }
    if (req.path === '/api/plugin-storage/batch') {
        return { maxBytes: limits.pluginBatch, responseKind: 'plugin-batch' };
    }
    if (req.path === '/api/plugin-storage/mutate') {
        const operation = req.headers['x-plugin-storage-operation'];
        if (operation === 'set') {
            return { maxBytes: limits.pluginValue, responseKind: 'plugin-set' };
        }
        return { maxBytes: limits.pluginStorage, responseKind: 'generic' };
    }
    if (req.path === '/api/chat-content'
        || req.path.startsWith('/api/chat-content/')) {
        return { maxBytes: limits.chat, responseKind: 'generic' };
    }
    if (req.path === '/api/write') {
        const key = decodeFilePath(req);
        if (key === 'database/database.bin') {
            return { maxBytes: limits.database, responseKind: 'generic' };
        }
        if (key.startsWith('pluginsave/')) {
            return { maxBytes: limits.pluginValue, responseKind: 'generic-plugin-value' };
        }
        return { maxBytes: limits.kv, responseKind: 'generic' };
    }
    return { maxBytes: limits.kv, responseKind: 'generic' };
}

function createRoutePolicyResolver(limits) {
    return (req) => {
        const writer = isWriterRoute(req);
        const bodyKind = requestBodyKind(req);
        if (req.method === 'POST' && req.path === RETIRED_PLUGIN_STORAGE_TRANSITION_PATH) {
            return {
                maxBytes: 0,
                responseKind: 'generic',
                bodyKind: null,
                authMode: authMode(req),
                writer: true,
                admissionOnly: true,
                retiredUpgradeRequired: true,
            };
        }
        if (!bodyKind
            || isStreamedIngress(req)
            || (writer && (req.method === 'GET' || req.method === 'DELETE'))) {
            // Writer-only admission still runs for bodyless and directly
            // streamed mutations. It authenticates and checks client/session
            // identity, but deliberately never reserves buffered-ingress bytes.
            if (!writer) return null;
            return {
                maxBytes: 0,
                responseKind: 'generic',
                bodyKind: null,
                authMode: authMode(req),
                writer: true,
                admissionOnly: true,
            };
        }
        const bodyPolicy = bodyKind === 'raw'
            ? rawPolicy(req, limits)
            : bodyKind === 'json'
                ? { maxBytes: jsonLimit(req, limits), responseKind: 'generic' }
                : {
                    maxBytes: req.path === '/proxy'
                        || req.path === '/proxy2'
                        || req.path.startsWith('/hub-proxy/')
                        ? limits.proxy
                        : limits.jsonControl,
                    responseKind: 'generic',
                };
        return {
            ...bodyPolicy,
            maxBytes: Math.min(bodyPolicy.maxBytes, limits.global),
            bodyKind,
            authMode: authMode(req),
            writer,
            admissionOnly: false,
        };
    };
}

function admissionPayload(policy, {
    code,
    error,
    retryable,
    limit,
    actual,
    expectedBuild,
}) {
    if (policy.responseKind === 'plugin-set' || policy.responseKind === 'plugin-batch') {
        return {
            success: false,
            outcome: 'not-committed',
            operation: policy.responseKind === 'plugin-set' ? 'set' : 'batch',
            error,
            code,
            ...(limit === undefined ? {} : { limit }),
            ...(actual === undefined ? {} : { actual }),
            ...(expectedBuild === undefined ? {} : { expectedBuild }),
            retryable,
        };
    }
    return {
        error,
        code,
        ...(limit === undefined ? {} : { limit }),
        ...(actual === undefined ? {} : { actual }),
        ...(expectedBuild === undefined ? {} : { expectedBuild }),
        retryable,
        commitOutcome: 'not-committed',
        commitOutcomeUnknown: false,
    };
}

function sendAdmissionError(res, policy, status, details) {
    // The request body is deliberately left unread. Do not reuse a connection
    // whose next bytes still belong to the rejected request.
    res.setHeader('Connection', 'close');
    if (status === 503) res.setHeader('Retry-After', '1');
    return res.status(status).json(admissionPayload(policy, details));
}

function sendClientUpgradeRequired(
    res,
    policy,
    expectedBuild,
    error = 'This client build does not match the server. Reload to continue.',
) {
    return sendAdmissionError(res, policy, 426, {
        code: CLIENT_UPGRADE_REQUIRED_CODE,
        error,
        expectedBuild: expectedBuild ?? undefined,
        retryable: false,
    });
}

function tooLargeCode(policy) {
    if (policy.responseKind === 'plugin-set'
        || policy.responseKind === 'generic-plugin-value') return 'PLUGIN_VALUE_TOO_LARGE';
    if (policy.responseKind === 'plugin-batch') return 'PLUGIN_STORAGE_BATCH_TOO_LARGE';
    return 'BUFFERED_INGRESS_TOO_LARGE';
}

function createBufferedIngressMiddleware({
    resolvePolicy,
    budget,
    authenticate,
    authenticateCookie,
    writerState,
    expectedClientBuild = null,
}) {
    if (typeof resolvePolicy !== 'function' || !budget) {
        throw new TypeError('resolvePolicy and budget are required');
    }
    return (req, res, next) => {
        const policy = resolvePolicy(req);
        if (!policy) return next();

        const admit = async () => {
            let authenticated = true;
            if (policy.authMode === 'jwt') authenticated = await authenticate(req, res, false);
            else if (policy.authMode === 'jwt-expired') authenticated = await authenticate(req, res, true);
            else if (policy.authMode === 'cookie') authenticated = authenticateCookie(req, res);
            if (!authenticated) return;

            if (policy.retiredUpgradeRequired) {
                sendClientUpgradeRequired(
                    res,
                    policy,
                    expectedClientBuild,
                    'This plugin storage transition protocol is retired. Reload to continue.',
                );
                return;
            }

            if (policy.writer && expectedClientBuild) {
                const clientBuild = req.headers[CLIENT_BUILD_HEADER];
                if (typeof clientBuild !== 'string'
                    || clientBuild !== expectedClientBuild.stamp) {
                    sendClientUpgradeRequired(res, policy, expectedClientBuild);
                    return;
                }
            }

            if (policy.writer && writerState(req) === 'stale') {
                res.setHeader('Connection', 'close');
                res.status(423).json({ error: 'Session deactivated' });
                return;
            }

            if (policy.admissionOnly) {
                req[BUFFERED_INGRESS_POLICY] = policy;
                next();
                return;
            }

            const contentEncoding = String(req.headers['content-encoding'] ?? 'identity')
                .trim()
                .toLowerCase();
            if (contentEncoding !== '' && contentEncoding !== 'identity') {
                sendAdmissionError(res, policy, 415, {
                    code: 'BUFFERED_INGRESS_CONTENT_ENCODING_UNSUPPORTED',
                    error: 'Compressed buffered request bodies are not supported.',
                    retryable: false,
                });
                return;
            }

            const rawLength = req.headers['content-length'];
            if (rawLength === undefined) {
                sendAdmissionError(res, policy, 411, {
                    code: 'BUFFERED_INGRESS_LENGTH_REQUIRED',
                    error: 'Content-Length is required for buffered request bodies.',
                    retryable: false,
                });
                return;
            }
            const contentLength = parseContentLength(rawLength);
            if (contentLength === null) {
                sendAdmissionError(res, policy, 400, {
                    code: 'BUFFERED_INGRESS_LENGTH_INVALID',
                    error: 'Content-Length must be a non-negative safe integer.',
                    retryable: false,
                });
                return;
            }
            if (contentLength > policy.maxBytes) {
                sendAdmissionError(res, policy, 413, {
                    code: tooLargeCode(policy),
                    error: `Request body exceeds the ${policy.maxBytes}-byte route limit.`,
                    limit: policy.maxBytes,
                    actual: contentLength,
                    retryable: false,
                });
                return;
            }

            if (req.destroyed || res.destroyed || res.writableEnded) return;

            const release = budget.tryReserve(contentLength);
            if (!release) {
                sendAdmissionError(res, policy, 503, {
                    code: 'BUFFERED_INGRESS_BUSY',
                    error: 'The server is already buffering its configured ingress budget. Retry shortly.',
                    limit: budget.maxBytes,
                    actual: Math.min(
                        Number.MAX_SAFE_INTEGER,
                        budget.snapshot().usedBytes + contentLength,
                    ),
                    retryable: true,
                });
                return;
            }
            req[BUFFERED_INGRESS_POLICY] = policy;
            res.once('finish', release);
            res.once('close', release);
            if (req.destroyed || res.destroyed || res.writableEnded) {
                release();
                return;
            }
            next();
        };

        admit().catch(next);
    };
}

module.exports = {
    BUFFERED_INGRESS_POLICY,
    CLIENT_BUILD_HEADER,
    CLIENT_UPGRADE_REQUIRED_CODE,
    DEFAULT_BUFFERED_INGRESS_MAX_BYTES,
    DEFAULT_DATABASE_WRITE_MAX_BYTES,
    DEFAULT_KV_WRITE_MAX_BYTES,
    DEFAULT_CHAT_WRITE_MAX_BYTES,
    DEFAULT_PROXY_BODY_MAX_BYTES,
    positiveIntegerFromEnv,
    createBufferedIngressLimits,
    createInFlightByteBudget,
    parseContentLength,
    requestBodyKind,
    isStreamedIngress,
    isWriterRoute,
    createRoutePolicyResolver,
    isChatDeltaRequest,
    admissionPayload,
    sendClientUpgradeRequired,
    createBufferedIngressMiddleware,
};
