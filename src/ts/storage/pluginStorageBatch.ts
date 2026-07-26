import { StorageError } from "./storageError";

export const PLUGIN_STORAGE_BATCH_MAX_OPERATIONS = 128;
export const PLUGIN_STORAGE_BATCH_MAX_BODY_BYTES = 16 * 1024 * 1024;
export const PLUGIN_STORAGE_REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const PLUGIN_STORAGE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type PluginStorageBatchOperation =
    | {
        operation: "set";
        key: string;
        valueBytes: Uint8Array;
        owner: string;
        expectedRevision?: string | null;
    }
    | {
        operation: "remove";
        key: string;
        expectedRevision?: string | null;
    };

export interface PluginStorageBatchManifest {
    version: 1;
    generation: string;
    valueKeys: string[];
    metaKeys: string[];
}

export interface PluginStorageBatchRequest {
    generation: string;
    expectedManifest: PluginStorageBatchManifest;
    operations: PluginStorageBatchOperation[];
}

export interface PluginStorageRevisionResult {
    key: string;
    revision: string | null;
}

export interface PluginStorageConflictResult extends PluginStorageRevisionResult {
    currentGeneration: string | null;
}

export type PluginStorageBatchResult =
    | {
        outcome: "committed";
        operation: "batch";
        verification: "verified" | "unavailable";
        requestHash: string;
        generation: string;
        revisions: PluginStorageRevisionResult[];
        status: 200;
        commitOutcomeUnknown: false;
    }
    | {
        outcome: "not-committed";
        operation: "batch";
        code: string;
        error: string;
        retryable: boolean;
        status: number;
        retryAfter: number | null;
        limit?: number;
        actual?: number;
        conflicts?: PluginStorageConflictResult[];
        commitOutcomeUnknown: false;
    }
    | {
        outcome: "unknown";
        operation: "batch";
        code: string;
        error: string;
        retryable: false;
        status: number | null;
        commitOutcomeUnknown: true;
    };

export interface PluginStorageVersionedState {
    missing: boolean;
    valueBytes: Uint8Array | null;
    revision: string | null;
    generation: string | null;
}

export function encodePluginStorageBatchRequest(request: PluginStorageBatchRequest): Uint8Array {
    if (request.operations.length < 1
        || request.operations.length > PLUGIN_STORAGE_BATCH_MAX_OPERATIONS) {
        throw new RangeError(
            `Plugin storage atomicBatch requires 1-${PLUGIN_STORAGE_BATCH_MAX_OPERATIONS} operations.`,
        );
    }
    const envelope = {
        version: 1,
        generation: request.generation,
        expectedManifest: request.expectedManifest,
        operations: request.operations.map(operation => ({
            operation: operation.operation,
            key: operation.key,
            ...(operation.operation === "set"
                ? {
                    value: Buffer.from(operation.valueBytes).toString("base64"),
                    owner: operation.owner,
                }
                : {}),
            ...(Object.prototype.hasOwnProperty.call(operation, "expectedRevision")
                ? { expectedRevision: operation.expectedRevision }
                : {}),
        })),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));
    if (bytes.byteLength > PLUGIN_STORAGE_BATCH_MAX_BODY_BYTES) {
        throw new RangeError("Plugin storage atomicBatch exceeds the 16 MiB request limit.");
    }
    return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
    const set = new Set(allowed);
    return Object.keys(value).every(key => set.has(key));
}

function validRevision(value: unknown): value is string {
    return typeof value === "string" && PLUGIN_STORAGE_REVISION_PATTERN.test(value);
}

function validUuid(value: unknown): value is string {
    return typeof value === "string" && PLUGIN_STORAGE_UUID_PATTERN.test(value);
}

function parseRevisionList(
    value: unknown,
    expectedOperations: readonly Pick<PluginStorageBatchOperation, "operation" | "key">[],
): PluginStorageRevisionResult[] | null {
    if (!Array.isArray(value) || value.length !== expectedOperations.length) return null;
    const out: PluginStorageRevisionResult[] = [];
    for (let index = 0; index < value.length; index++) {
        const row = value[index];
        const expected = expectedOperations[index];
        if (!isRecord(row)
            || !hasOnlyKeys(row, ["key", "revision"])
            || row.key !== expected.key
            || (expected.operation === "set"
                ? !validRevision(row.revision)
                : row.revision !== null)) return null;
        out.push({ key: row.key as string, revision: row.revision as string | null });
    }
    return out;
}

function unknown(status: number | null, message: string): PluginStorageBatchResult {
    return {
        outcome: "unknown",
        operation: "batch",
        code: status === null ? "TRANSPORT_OUTCOME_UNKNOWN" : "ACKNOWLEDGEMENT_UNKNOWN",
        error: message,
        retryable: false,
        status,
        commitOutcomeUnknown: true,
    };
}

export function pluginStorageBatchTransportOutcomeUnknown(error: unknown): PluginStorageBatchResult {
    return unknown(null, error instanceof Error ? error.message : String(error));
}

export function classifyPluginStorageBatchAcknowledgement(
    status: number,
    body: unknown,
    expectedRequestHash: string,
    expectedOperations: readonly Pick<
        PluginStorageBatchOperation,
        "operation" | "key" | "expectedRevision"
    >[],
    retryAfter: number | null = null,
): PluginStorageBatchResult {
    if (!isRecord(body) || body.operation !== "batch") {
        return unknown(status, `Plugin storage batch acknowledgement was invalid (${status}).`);
    }
    if (status === 200) {
        const revisions = parseRevisionList(body.revisions, expectedOperations);
        if (hasOnlyKeys(body, [
            "success", "outcome", "operation", "verification",
            "requestHash", "generation", "revisions",
        ])
            && body.success === true
            && body.outcome === "committed"
            && (body.verification === "verified" || body.verification === "unavailable")
            && body.requestHash === expectedRequestHash
            && validUuid(body.generation)
            && revisions) {
            return {
                outcome: "committed",
                operation: "batch",
                verification: body.verification,
                requestHash: body.requestHash,
                generation: body.generation,
                revisions,
                status: 200,
                commitOutcomeUnknown: false,
            };
        }
        return unknown(status, "Plugin storage batch committed acknowledgement was malformed.");
    }

    if (status === 413
        && hasOnlyKeys(body, [
            "success", "outcome", "operation", "error", "code",
            "limit", "actual", "retryable",
        ])
        && body.success === false
        && body.outcome === "not-committed"
        && (body.code === "PLUGIN_VALUE_TOO_LARGE"
            || body.code === "PLUGIN_STORAGE_TOTAL_TOO_LARGE")
        && body.retryable === false
        && typeof body.error === "string"
        && Number.isSafeInteger(body.limit)
        && Number.isSafeInteger(body.actual)) {
        return {
            outcome: "not-committed",
            operation: "batch",
            code: body.code,
            error: body.error,
            limit: body.limit as number,
            actual: body.actual as number,
            retryable: false,
            status,
            retryAfter,
            commitOutcomeUnknown: false,
        };
    }

    const expected = new Map<number, { code: string; retryable: boolean }>([
        [400, { code: "INVALID_PLUGIN_STORAGE_BATCH", retryable: false }],
        [413, { code: "INVALID_PLUGIN_STORAGE_BATCH", retryable: false }],
        [500, { code: "PLUGIN_STORAGE_BATCH_ROLLED_BACK", retryable: false }],
        [503, { code: "IMPORT_IN_PROGRESS", retryable: true }],
    ]).get(status);
    if (expected
        && hasOnlyKeys(body, [
            "success", "outcome", "operation", "error", "code", "retryable",
        ])
        && body.success === false
        && body.outcome === "not-committed"
        && body.code === expected.code
        && body.retryable === expected.retryable
        && typeof body.error === "string"
        && body.error.length > 0) {
        return {
            outcome: "not-committed",
            operation: "batch",
            code: expected.code,
            error: body.error,
            retryable: expected.retryable,
            status,
            retryAfter,
            commitOutcomeUnknown: false,
        };
    }

    if (status === 409
        && hasOnlyKeys(body, [
            "success", "outcome", "operation", "error", "code", "retryable",
        ])
        && body.success === false
        && body.outcome === "not-committed"
        && body.code === "PLUGIN_STORAGE_GENERATION_CONFLICT"
        && body.retryable === true
        && typeof body.error === "string"
        && body.error.length > 0) {
        return {
            outcome: "not-committed",
            operation: "batch",
            code: "PLUGIN_STORAGE_GENERATION_CONFLICT",
            error: body.error,
            retryable: true,
            status,
            retryAfter,
            commitOutcomeUnknown: false,
        };
    }

    if (status === 409
        && hasOnlyKeys(body, [
            "success", "outcome", "operation", "error", "code", "retryable", "conflicts",
        ])
        && body.success === false
        && body.outcome === "not-committed"
        && body.code === "PLUGIN_STORAGE_REVISION_CONFLICT"
        && body.retryable === false
        && typeof body.error === "string"
        && body.error.length > 0
        && Array.isArray(body.conflicts)
        && body.conflicts.length > 0
        && body.conflicts.length <= expectedOperations.length) {
        const conflicts: PluginStorageConflictResult[] = [];
        const expectedConflicts = expectedOperations.filter(operation => (
            Object.prototype.hasOwnProperty.call(operation, "expectedRevision")
        ));
        if (body.conflicts.length > expectedConflicts.length) {
            return unknown(status, "Plugin storage conflict acknowledgement was not request-bound.");
        }
        const seen = new Set<string>();
        let previousRequestIndex = -1;
        for (const conflict of body.conflicts) {
            if (!isRecord(conflict)
                || !hasOnlyKeys(conflict, ["key", "currentRevision", "currentGeneration"])
                || typeof conflict.key !== "string"
                || (conflict.currentRevision !== null && !validRevision(conflict.currentRevision))
                || (conflict.currentGeneration !== null && !validUuid(conflict.currentGeneration))) {
                return unknown(status, "Plugin storage conflict acknowledgement was malformed.");
            }
            const requestIndex = expectedConflicts.findIndex(operation => operation.key === conflict.key);
            const expected = expectedConflicts[requestIndex];
            if (requestIndex <= previousRequestIndex
                || seen.has(conflict.key)
                || conflict.currentRevision === expected?.expectedRevision
                || (conflict.currentRevision === null && conflict.currentGeneration !== null)) {
                return unknown(status, "Plugin storage conflict acknowledgement was not request-bound.");
            }
            seen.add(conflict.key);
            previousRequestIndex = requestIndex;
            conflicts.push({
                key: conflict.key,
                revision: conflict.currentRevision as string | null,
                currentGeneration: conflict.currentGeneration as string | null,
            });
        }
        return {
            outcome: "not-committed",
            operation: "batch",
            code: "PLUGIN_STORAGE_REVISION_CONFLICT",
            error: body.error,
            retryable: false,
            status,
            retryAfter,
            conflicts,
            commitOutcomeUnknown: false,
        };
    }

    return unknown(status, `Plugin storage batch acknowledgement was invalid (${status}).`);
}

export class PluginStorageBatchError extends StorageError {
    readonly result: Exclude<PluginStorageBatchResult, { outcome: "committed" }>;
    readonly outcome: "not-committed" | "unknown";

    constructor(result: Exclude<PluginStorageBatchResult, { outcome: "committed" }>) {
        super(result.error, {
            status: result.status,
            code: result.code,
            retryAfter: "retryAfter" in result ? result.retryAfter : null,
            retryable: result.retryable,
            commitOutcomeUnknown: result.commitOutcomeUnknown,
            operation: "batch",
        });
        this.name = "PluginStorageBatchError";
        this.result = result;
        this.outcome = result.outcome;
    }
}
