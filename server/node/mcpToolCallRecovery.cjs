'use strict';

const fs = require('fs');

const MCP_TOOL_CALL_CACHE_PREFIX = 'cache/mcp-tool-calls/';
const MCP_TOOL_CALL_SNAPSHOT_FIELD = '__pocketRisuMcpToolCallPayloadsV1';
const MCP_TOOL_CALL_SNAPSHOT_MARKER = '__pocketRisuMcpToolCallsFoldedV1';

const TOOL_CALL_OPEN = '<tool_call>';
const TOOL_CALL_SEPARATOR = '\uf100';
const TOOL_CALL_CLOSE = '</tool_call>';
const MAX_TOOL_CALL_MARKER_CHARS = 64 * 1024;

function encodeMcpToolCallId(callId) {
    if (typeof callId !== 'string' || callId.length === 0) return null;
    return Buffer.from(callId, 'utf8').toString('base64url');
}

function mcpToolCallStorageKey(callId) {
    const encoded = encodeMcpToolCallId(callId);
    return encoded ? `${MCP_TOOL_CALL_CACHE_PREFIX}${encoded}.json` : null;
}

function parseMcpToolCallStorageKey(storageKey) {
    if (typeof storageKey !== 'string'
        || !storageKey.startsWith(MCP_TOOL_CALL_CACHE_PREFIX)) return null;
    const suffix = storageKey.slice(MCP_TOOL_CALL_CACHE_PREFIX.length);
    const match = /^([A-Za-z0-9_-]+)\.json$/.exec(suffix);
    if (!match) return null;
    const bytes = Buffer.from(match[1], 'base64url');
    if (bytes.length === 0 || bytes.toString('base64url') !== match[1]) return null;
    const callId = bytes.toString('utf8');
    if (!Buffer.from(callId, 'utf8').equals(bytes) || callId.length === 0) return null;
    return { callId, suffix, storageKey };
}

function parseMcpToolCallSnapshotKey(suffix) {
    return parseMcpToolCallStorageKey(`${MCP_TOOL_CALL_CACHE_PREFIX}${suffix}`);
}

function collectMcpToolCallIdsFromString(value, output) {
    let offset = 0;
    while (offset < value.length) {
        const open = value.indexOf(TOOL_CALL_OPEN, offset);
        if (open < 0) return;
        const payloadStart = open + TOOL_CALL_OPEN.length;
        const close = value.indexOf(TOOL_CALL_CLOSE, payloadStart);
        if (close < 0) return;
        if (close - payloadStart <= MAX_TOOL_CALL_MARKER_CHARS) {
            const separator = value.indexOf(TOOL_CALL_SEPARATOR, payloadStart);
            if (separator >= payloadStart && separator < close) {
                const callId = value.slice(payloadStart, separator).trim();
                if (callId) output.add(callId);
            }
        }
        offset = close + TOOL_CALL_CLOSE.length;
    }
}

function collectMcpToolCallIds(value, output = new Set(), seen = new Set()) {
    if (typeof value === 'string') {
        collectMcpToolCallIdsFromString(value, output);
        return output;
    }
    if (value === null || typeof value !== 'object' || seen.has(value)) return output;
    seen.add(value);
    if (Array.isArray(value)) {
        for (const entry of value) collectMcpToolCallIds(entry, output, seen);
    } else {
        for (const entry of Object.values(value)) {
            collectMcpToolCallIds(entry, output, seen);
        }
    }
    return output;
}

/**
 * Scan an assembled, uncompressed MessagePack RisuSave for remembered markers.
 * Marker text is UTF-8 inside MessagePack string bodies, so a streaming decoder
 * finds it without materializing the potentially multi-gigabyte database.
 */
async function scanMcpToolCallIdsFromFile(filePath, {
    shouldAbort = () => false,
    offset = 0,
    size = null,
} = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0
        || (size !== null && (!Number.isSafeInteger(size) || size < 0))) {
        throw new RangeError('Invalid remembered MCP tool-call scan range');
    }
    const ids = new Set();
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let carry = '';

    const streamOptions = size === null
        ? { start: offset }
        : size === 0
            ? null
            : { start: offset, end: offset + size - 1 };
    const chunks = streamOptions ? fs.createReadStream(filePath, streamOptions) : [];
    for await (const chunk of chunks) {
        if (shouldAbort()) {
            const error = new Error('MCP tool-call reference scan cancelled');
            error.name = 'AbortError';
            throw error;
        }
        let text = carry + decoder.decode(chunk, { stream: true });
        carry = '';
        let offset = 0;
        while (offset < text.length) {
            const open = text.indexOf(TOOL_CALL_OPEN, offset);
            if (open < 0) {
                carry = text.slice(Math.max(offset, text.length - TOOL_CALL_OPEN.length + 1));
                break;
            }
            const payloadStart = open + TOOL_CALL_OPEN.length;
            const close = text.indexOf(TOOL_CALL_CLOSE, payloadStart);
            if (close < 0) {
                if (text.length - payloadStart <= MAX_TOOL_CALL_MARKER_CHARS) {
                    carry = text.slice(open);
                    break;
                }
                offset = payloadStart;
                continue;
            }
            if (close - payloadStart <= MAX_TOOL_CALL_MARKER_CHARS) {
                const separator = text.indexOf(TOOL_CALL_SEPARATOR, payloadStart);
                if (separator >= payloadStart && separator < close) {
                    const callId = text.slice(payloadStart, separator).trim();
                    if (callId) ids.add(callId);
                }
            }
            offset = close + TOOL_CALL_CLOSE.length;
        }
    }

    const tail = carry + decoder.decode();
    if (tail) collectMcpToolCallIdsFromString(tail, ids);
    return ids;
}

module.exports = {
    MCP_TOOL_CALL_CACHE_PREFIX,
    MCP_TOOL_CALL_SNAPSHOT_FIELD,
    MCP_TOOL_CALL_SNAPSHOT_MARKER,
    collectMcpToolCallIds,
    encodeMcpToolCallId,
    mcpToolCallStorageKey,
    parseMcpToolCallSnapshotKey,
    parseMcpToolCallStorageKey,
    scanMcpToolCallIdsFromFile,
};
