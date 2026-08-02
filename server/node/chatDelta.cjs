'use strict';

const { applyPatch } = require('fast-json-patch');

const CHAT_DELTA_VERSION = 1;
const CHAT_DELTA_FORMAT = 'pocketrisu-chat-operation-v1';
const CHAT_DELTA_CONTENT_TYPE = 'application/vnd.pocketrisu.chat-delta+json';
const CHAT_DELTA_PATCH_CONTENT_TYPE = 'application/json-patch+json';
// Leave fixed headroom for the version/hash/size envelope under the existing
// 32 MiB `/api/patch` JSON admission ceiling.
const DEFAULT_CHAT_DELTA_MAX_BYTES = 32 * 1024 * 1024 - 4096;
const DEFAULT_CHAT_DELTA_MAX_OPERATIONS = 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MESSAGE_INDEX_PATH = /^\/message\/(0|[1-9]\d*)$/;

class ChatDeltaValidationError extends Error {
    constructor(message, code = 'CHAT_DELTA_INVALID') {
        super(message);
        this.name = 'ChatDeltaValidationError';
        this.code = code;
        this.status = 400;
    }
}

function isJsonValue(value, seen = new Set()) {
    if (value === null) return true;
    if (typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    try {
        if (Array.isArray(value)) return value.every((item) => isJsonValue(item, seen));
        if (Object.getPrototypeOf(value) !== Object.prototype
            && Object.getPrototypeOf(value) !== null) return false;
        return Object.entries(value).every(([key, item]) => (
            key !== '__proto__'
            && key !== 'prototype'
            && key !== 'constructor'
            && isJsonValue(item, seen)
        ));
    } finally {
        seen.delete(value);
    }
}

function validateChatDeltaPayload(payload, {
    baseMessageCount,
    maxBytes = DEFAULT_CHAT_DELTA_MAX_BYTES,
    maxOperations = DEFAULT_CHAT_DELTA_MAX_OPERATIONS,
    maxResultBytes = Number.MAX_SAFE_INTEGER,
} = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new ChatDeltaValidationError('Chat delta body must be an object');
    }
    const keys = Object.keys(payload).sort();
    const expectedKeys = ['baseHash', 'patch', 'resultHash', 'resultSize', 'version'];
    if (keys.length !== expectedKeys.length
        || keys.some((key, index) => key !== expectedKeys[index])) {
        throw new ChatDeltaValidationError('Chat delta body has an invalid schema');
    }
    if (payload.version !== CHAT_DELTA_VERSION) {
        throw new ChatDeltaValidationError('Unsupported chat delta version');
    }
    if (!SHA256_PATTERN.test(payload.baseHash ?? '')
        || !SHA256_PATTERN.test(payload.resultHash ?? '')) {
        throw new ChatDeltaValidationError('Chat delta hashes must be lowercase SHA-256');
    }
    if (!Number.isSafeInteger(payload.resultSize)
        || payload.resultSize <= 0
        || payload.resultSize > maxResultBytes) {
        throw new ChatDeltaValidationError('Chat delta result size is outside the row limit');
    }
    if (!Number.isSafeInteger(baseMessageCount) || baseMessageCount < 0) {
        throw new ChatDeltaValidationError(
            'The chat row has no delta-compatible structural metadata',
            'CHAT_DELTA_BASE_UNAVAILABLE',
        );
    }
    if (!Array.isArray(payload.patch)
        || payload.patch.length === 0
        || payload.patch.length > maxOperations) {
        throw new ChatDeltaValidationError('Chat delta operation count is outside the limit');
    }

    let messageCount = baseMessageCount;
    for (const operation of payload.patch) {
        if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
            throw new ChatDeltaValidationError('Chat delta contains an invalid operation');
        }
        const operationKeys = Object.keys(operation).sort();
        if (operationKeys.length !== 3
            || operationKeys[0] !== 'op'
            || operationKeys[1] !== 'path'
            || operationKeys[2] !== 'value'
            || !isJsonValue(operation.value)) {
            throw new ChatDeltaValidationError('Chat delta operation has an invalid schema');
        }
        if (operation.op === 'replace') {
            const match = MESSAGE_INDEX_PATH.exec(operation.path);
            const index = match ? Number(match[1]) : -1;
            if (!match || !Number.isSafeInteger(index) || index >= messageCount) {
                throw new ChatDeltaValidationError(
                    'Chat delta replace path does not identify an existing message',
                );
            }
            continue;
        }
        if (operation.op === 'add' && operation.path === '/message/-') {
            messageCount += 1;
            continue;
        }
        throw new ChatDeltaValidationError(
            'Chat deltas may only replace whole messages or append messages',
        );
    }

    const patchJson = JSON.stringify(payload.patch);
    const patchBytes = Buffer.byteLength(patchJson, 'utf-8');
    if (patchBytes <= 0 || patchBytes > maxBytes) {
        throw new ChatDeltaValidationError('Chat delta payload exceeds the patch limit');
    }
    return {
        version: CHAT_DELTA_VERSION,
        baseHash: payload.baseHash,
        resultHash: payload.resultHash,
        resultSize: payload.resultSize,
        patch: payload.patch,
        patchJson,
        patchBytes,
        messageCount,
    };
}

function applyValidatedChatDelta(document, patch) {
    return applyPatch(document, patch, true, true, true).newDocument;
}

module.exports = {
    CHAT_DELTA_VERSION,
    CHAT_DELTA_FORMAT,
    CHAT_DELTA_CONTENT_TYPE,
    CHAT_DELTA_PATCH_CONTENT_TYPE,
    DEFAULT_CHAT_DELTA_MAX_BYTES,
    DEFAULT_CHAT_DELTA_MAX_OPERATIONS,
    ChatDeltaValidationError,
    validateChatDeltaPayload,
    applyValidatedChatDelta,
};
