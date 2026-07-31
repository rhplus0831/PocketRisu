import { addExtension, Packr } from "msgpackr/index-no-eval";
import { sha256OwnedBytes } from "./resourceCache";
import { StorageError } from "./storageError";

export const PLUGIN_STORAGE_TRANSITION_STREAM_MAGIC = "PRISUT01";
export const PLUGIN_STORAGE_TRANSITION_STREAM_PREFIX_BYTES = 12;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UNSUPPORTED_FUNCTION_EXTENSION_TYPE = 63;

export class UnsupportedPluginStorageTransitionValue {
    readonly kind = "function";
}

// msgpackr's default function encoding is `undefined`, which would let the
// server's optional converter turn a function into null. Preserve a distinct
// unsupported marker so validation remains wholly server-owned and lossless.
addExtension({
    Class: Function,
    type: UNSUPPORTED_FUNCTION_EXTENSION_TYPE,
    pack: () => Uint8Array.of(1),
    unpack: (bytes) => {
        if (bytes.byteLength !== 1 || bytes[0] !== 1) {
            throw new TypeError("Invalid plugin transition function marker.");
        }
        return new UnsupportedPluginStorageTransitionValue();
    },
});

export interface PluginStorageTransitionStreamCapabilities {
    transport: "framed-v1";
    maxEntries: number;
    maxMetadataBytes: number;
    maxValueBytes: number;
    maxPayloadBytes: number;
}

export interface PluginStorageTransitionSource {
    optimized: boolean;
    generation: string | null;
    manifest: {
        version: 1 | 2 | 3;
        generation: string;
        valueKeys: string[];
        metaKeys: string[];
        keyMappings?: [string, string][];
    } | null;
}

export interface PluginStorageTransitionRichRow {
    rawKey: string;
    storageKey: string;
    value: unknown;
}

export interface PluginStorageBulkTransitionRequest {
    transitionId: string;
    source: PluginStorageTransitionSource;
    targetOptimized: boolean;
    targetGeneration: string;
    expectedEtag?: string;
    autoConvert: boolean;
    rows: PluginStorageTransitionRichRow[];
}

export interface PreparedPluginStorageBulkTransition {
    body: Blob;
    byteLength: number;
    metadataBytes: Uint8Array;
    payloadBytes: number;
}

export interface PluginStorageBulkTransitionResult {
    success: true;
    transitionId: string;
    state: "committed";
    direction: "externalize" | "internalize";
    targetGeneration: string;
    values: number;
    meta: number;
    totalBytes: number;
    etag: string;
}

export class PluginStorageTransitionPreparationError extends RangeError {
    readonly code: string;
    readonly limit?: number;
    readonly actual?: number;

    constructor(message: string, options: {
        code: string;
        limit?: number;
        actual?: number;
    }) {
        super(message);
        this.name = "PluginStorageTransitionPreparationError";
        this.code = options.code;
        this.limit = options.limit;
        this.actual = options.actual;
    }
}

const richValuePacker = new Packr({
    structuredClone: true,
    useRecords: true,
});

export function parsePluginStorageTransitionStreamCapabilities(
    value: unknown,
): PluginStorageTransitionStreamCapabilities | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.transport !== "framed-v1"
        || !Number.isSafeInteger(record.maxEntries) || Number(record.maxEntries) < 1
        || !Number.isSafeInteger(record.maxMetadataBytes) || Number(record.maxMetadataBytes) < 1
        || !Number.isSafeInteger(record.maxValueBytes) || Number(record.maxValueBytes) < 1
        || !Number.isSafeInteger(record.maxPayloadBytes)
        || Number(record.maxPayloadBytes) < Number(record.maxValueBytes)) {
        return null;
    }
    return {
        transport: "framed-v1",
        maxEntries: Number(record.maxEntries),
        maxMetadataBytes: Number(record.maxMetadataBytes),
        maxValueBytes: Number(record.maxValueBytes),
        maxPayloadBytes: Number(record.maxPayloadBytes),
    };
}

/**
 * Encode a complete inline publication as canonical metadata followed by one
 * structured-clone MessagePack payload per row. The transport deliberately
 * preserves rich legacy values; JSON validation and optional conversion are
 * server responsibilities.
 */
export async function preparePluginStorageBulkTransition(
    request: PluginStorageBulkTransitionRequest,
    capabilities: PluginStorageTransitionStreamCapabilities,
): Promise<PreparedPluginStorageBulkTransition> {
    if (!UUID_PATTERN.test(request.transitionId)
        || !UUID_PATTERN.test(request.targetGeneration)) {
        throw new TypeError("Plugin storage transition identifiers must be canonical UUIDs.");
    }
    if (request.rows.length > capabilities.maxEntries) {
        throw new PluginStorageTransitionPreparationError(
            `Plugin storage transition has ${request.rows.length} entries; the limit is ${capabilities.maxEntries}.`,
            {
                code: "PLUGIN_STORAGE_SIZE_LIMIT",
                limit: capabilities.maxEntries,
                actual: request.rows.length,
            },
        );
    }
    if (!request.targetOptimized && request.rows.length !== 0) {
        throw new TypeError("Plugin storage internalization must not upload inline rows.");
    }

    let payloadBytes = 0;
    const encodedRows: Uint8Array[] = [];
    const rowMetadata: Array<{
        rawKey: string;
        storageKey: string;
        valueLength: number;
        valueHash: string;
    }> = [];
    const seen = new Set<string>();
    for (const [index, row] of request.rows.entries()) {
        if (typeof row.rawKey !== "string" || typeof row.storageKey !== "string") {
            throw new TypeError(`Plugin storage transition row ${index} has an invalid key.`);
        }
        if (seen.has(row.storageKey)) {
            throw new TypeError(`Plugin storage transition repeats ${row.storageKey}.`);
        }
        seen.add(row.storageKey);
        let encoded: Uint8Array;
        try {
            // Copy the returned view: Packr may reuse its internal target on a
            // later encode, while Blob construction happens after this loop.
            encoded = new Uint8Array(richValuePacker.encode(row.value));
        } catch (error) {
            throw new StorageError(
                "Plugin storage contains a value that cannot be transported for server-side migration.",
                {
                    status: 400,
                    code: "PLUGIN_STORAGE_VALUE_UNSUPPORTED",
                    operation: "transition",
                    retryable: false,
                    commitOutcomeUnknown: false,
                    commitOutcome: "not-committed",
                    cause: error,
                },
            );
        }
        if (encoded.byteLength < 1 || encoded.byteLength > capabilities.maxValueBytes) {
            throw new PluginStorageTransitionPreparationError(
                `Plugin transition transport row ${index} is ${encoded.byteLength} bytes; the limit is ${capabilities.maxValueBytes}.`,
                {
                    code: "PLUGIN_VALUE_TOO_LARGE",
                    limit: capabilities.maxValueBytes,
                    actual: encoded.byteLength,
                },
            );
        }
        payloadBytes += encoded.byteLength;
        if (!Number.isSafeInteger(payloadBytes)
            || payloadBytes > capabilities.maxPayloadBytes) {
            throw new PluginStorageTransitionPreparationError(
                `Plugin transition transport uses ${payloadBytes} bytes; the limit is ${capabilities.maxPayloadBytes}.`,
                {
                    code: "PLUGIN_STORAGE_TOTAL_TOO_LARGE",
                    limit: capabilities.maxPayloadBytes,
                    actual: payloadBytes,
                },
            );
        }
        const valueHash = await sha256OwnedBytes(encoded);
        if (!SHA256_PATTERN.test(valueHash)) {
            throw new TypeError("Plugin transition transport produced an invalid row hash.");
        }
        encodedRows.push(encoded);
        rowMetadata.push({
            rawKey: row.rawKey,
            storageKey: row.storageKey,
            valueLength: encoded.byteLength,
            valueHash,
        });
    }

    const metadata = {
        version: 1,
        transitionId: request.transitionId,
        source: request.source,
        targetOptimized: request.targetOptimized,
        targetGeneration: request.targetGeneration,
        ...(request.expectedEtag ? { expectedEtag: request.expectedEtag } : {}),
        autoConvert: request.autoConvert,
        rows: rowMetadata,
    };
    const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
    if (metadataBytes.byteLength > capabilities.maxMetadataBytes) {
        throw new PluginStorageTransitionPreparationError(
            `Plugin transition metadata is ${metadataBytes.byteLength} bytes; the limit is ${capabilities.maxMetadataBytes}.`,
            {
                code: "PLUGIN_STORAGE_SIZE_LIMIT",
                limit: capabilities.maxMetadataBytes,
                actual: metadataBytes.byteLength,
            },
        );
    }
    const prefix = new Uint8Array(PLUGIN_STORAGE_TRANSITION_STREAM_PREFIX_BYTES);
    prefix.set(new TextEncoder().encode(PLUGIN_STORAGE_TRANSITION_STREAM_MAGIC), 0);
    new DataView(prefix.buffer).setUint32(
        PLUGIN_STORAGE_TRANSITION_STREAM_MAGIC.length,
        metadataBytes.byteLength,
    );
    const byteLength = PLUGIN_STORAGE_TRANSITION_STREAM_PREFIX_BYTES
        + metadataBytes.byteLength
        + payloadBytes;
    return {
        body: new Blob(
            [prefix, metadataBytes, ...encodedRows] as unknown as BlobPart[],
            { type: "application/x-pocketrisu-plugin-storage-transition" },
        ),
        byteLength,
        metadataBytes,
        payloadBytes,
    };
}

export function isPluginStorageBulkTransitionResult(
    value: unknown,
    transitionId: string,
    targetGeneration: string,
): value is PluginStorageBulkTransitionResult {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return record.success === true
        && record.transitionId === transitionId
        && record.state === "committed"
        && (record.direction === "externalize" || record.direction === "internalize")
        && record.targetGeneration === targetGeneration
        && Number.isSafeInteger(record.values) && Number(record.values) >= 0
        && Number.isSafeInteger(record.meta) && Number(record.meta) >= 0
        && Number.isSafeInteger(record.totalBytes) && Number(record.totalBytes) >= 0
        && typeof record.etag === "string"
        && /^[0-9a-f]{32}$/.test(record.etag);
}
