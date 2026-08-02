import { StorageError } from "./storageError";

export type PluginStorageMutationOperation = "set" | "remove";
export type PluginStorageMutationCommitState =
    | "committed"
    | "not-committed"
    | "unknown";

export interface PluginStorageMutationRequest {
    operation: PluginStorageMutationOperation;
    valueKey: string;
    /** Active optimized publication selected by the caller's database read. */
    generation?: string;
    valueBytes?: Uint8Array;
    /** The caller donates a fresh immutable buffer; storage may retain it for cache seeding. */
    ownedValueBytes?: true;
    /** Empty means the value is deliberately unowned and removes stale metadata. */
    owner?: string;
    /** Recovery-only exact sidecar bytes; mutually exclusive with ordinary owner. */
    ownerRecordBytes?: Uint8Array;
    /** Keep any historical sidecar unchanged (set or value-only remove). */
    preserveOwner?: boolean;
}

export interface PluginStorageMutationResult {
    outcome: PluginStorageMutationCommitState;
    operation: PluginStorageMutationOperation;
    verification?: "verified" | "unavailable";
    hash?: string;
    code?: string;
    error?: string;
    retryable?: boolean;
    status?: number | null;
    retryAfter?: number | null;
    limit?: number;
    actual?: number;
    commitOutcomeUnknown?: boolean;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const NOT_COMMITTED_ACKNOWLEDGEMENTS = new Map<number, {
    code: string;
    retryable: boolean;
}>([
    [400, { code: "INVALID_PLUGIN_STORAGE_MUTATION", retryable: false }],
    [409, { code: "PLUGIN_STORAGE_GENERATION_CONFLICT", retryable: true }],
    [500, { code: "PLUGIN_STORAGE_TRANSACTION_ROLLED_BACK", retryable: false }],
    [503, { code: "IMPORT_IN_PROGRESS", retryable: true }],
]);

const BUFFERED_INGRESS_ACKNOWLEDGEMENTS = new Map<string, {
    status: number;
    retryable: boolean;
    includesBudget: boolean;
}>([
    ["BUFFERED_INGRESS_LENGTH_INVALID", {
        status: 400, retryable: false, includesBudget: false,
    }],
    ["BUFFERED_INGRESS_LENGTH_REQUIRED", {
        status: 411, retryable: false, includesBudget: false,
    }],
    ["BUFFERED_INGRESS_CONTENT_ENCODING_UNSUPPORTED", {
        status: 415, retryable: false, includesBudget: false,
    }],
    ["BUFFERED_INGRESS_BUSY", {
        status: 503, retryable: true, includesBudget: true,
    }],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
    value: Record<string, unknown>,
    allowed: readonly string[],
): boolean {
    const allowedKeys = new Set(allowed);
    return Object.keys(value).every((key) => allowedKeys.has(key));
}

export function pluginStorageTransportOutcomeUnknown(
    operation: PluginStorageMutationOperation,
    error: unknown,
): PluginStorageMutationResult {
    return {
        outcome: "unknown",
        operation,
        code: "TRANSPORT_OUTCOME_UNKNOWN",
        error: error instanceof Error ? error.message : String(error),
        status: null,
        retryable: false,
        commitOutcomeUnknown: true,
    };
}

function unknownAcknowledgement(
    operation: PluginStorageMutationOperation,
    status: number,
): PluginStorageMutationResult {
    return {
        outcome: "unknown",
        operation,
        code: "ACKNOWLEDGEMENT_UNKNOWN",
        error: `Plugin storage mutation acknowledgement was invalid (${status}).`,
        status,
        retryable: false,
        commitOutcomeUnknown: true,
    };
}

/**
 * Trust only the exact status/body combinations emitted by the atomic endpoint.
 * Proxies and generic middleware can replace any response body, so malformed
 * 2xx/4xx/5xx responses (especially 408/499) never imply rollback or commit.
 */
export function classifyPluginStorageMutationAcknowledgement(
    status: number,
    body: unknown,
    operation: PluginStorageMutationOperation,
    expectedValueHash?: string,
    retryAfter?: number | null,
): PluginStorageMutationResult {
    if (!isRecord(body) || body.operation !== operation) {
        return unknownAcknowledgement(operation, status);
    }

    if (status === 200) {
        const hashIsValid = operation === "set"
            ? typeof expectedValueHash === "string"
                && SHA256_PATTERN.test(expectedValueHash)
                && body.hash === expectedValueHash
            : body.hash === undefined;
        if (
            hasOnlyKeys(body, [
                "success",
                "outcome",
                "operation",
                "verification",
                ...(operation === "set" ? ["hash"] : []),
            ])
            && body.success === true
            && body.outcome === "committed"
            && (body.verification === "verified" || body.verification === "unavailable")
            && hashIsValid
            && body.code === undefined
            && body.error === undefined
            && body.retryable === undefined
        ) {
            return {
                outcome: "committed",
                operation,
                verification: body.verification,
                status,
                commitOutcomeUnknown: false,
                ...(operation === "set" ? { hash: body.hash as string } : {}),
            };
        }
        return unknownAcknowledgement(operation, status);
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
            operation,
            code: body.code,
            error: body.error,
            limit: body.limit as number,
            actual: body.actual as number,
            retryable: false,
            status,
            retryAfter: retryAfter ?? null,
            commitOutcomeUnknown: false,
        };
    }

    const ingressAcknowledgement = typeof body.code === "string"
        ? BUFFERED_INGRESS_ACKNOWLEDGEMENTS.get(body.code)
        : undefined;
    if (ingressAcknowledgement
        && ingressAcknowledgement.status === status
        && hasOnlyKeys(body, [
            "success", "outcome", "operation", "error", "code", "retryable",
            ...(ingressAcknowledgement.includesBudget ? ["limit", "actual"] : []),
        ])
        && body.success === false
        && body.outcome === "not-committed"
        && body.retryable === ingressAcknowledgement.retryable
        && typeof body.error === "string"
        && body.error.length > 0
        && (!ingressAcknowledgement.includesBudget
            || (Number.isSafeInteger(body.limit) && Number.isSafeInteger(body.actual)))) {
        return {
            outcome: "not-committed",
            operation,
            code: body.code as string,
            error: body.error,
            retryable: ingressAcknowledgement.retryable,
            status,
            retryAfter: retryAfter ?? null,
            commitOutcomeUnknown: false,
            ...(ingressAcknowledgement.includesBudget
                ? { limit: body.limit as number, actual: body.actual as number }
                : {}),
        };
    }

    const expected = NOT_COMMITTED_ACKNOWLEDGEMENTS.get(status);
    if (
        expected
        && hasOnlyKeys(body, [
            "success",
            "outcome",
            "operation",
            "error",
            "code",
            "retryable",
        ])
        && body.success === false
        && body.outcome === "not-committed"
        && body.code === expected.code
        && body.retryable === expected.retryable
        && typeof body.error === "string"
        && body.error.length > 0
        && body.verification === undefined
        && body.hash === undefined
    ) {
        return {
            outcome: "not-committed",
            operation,
            code: expected.code,
            retryable: expected.retryable,
            error: body.error,
            status,
            retryAfter: retryAfter ?? null,
            commitOutcomeUnknown: false,
        };
    }

    return unknownAcknowledgement(operation, status);
}

export interface PluginStorageMutationCachePublisher {
    enabled: boolean;
    storeValue: (valueKey: string, valueBytes: Uint8Array) => Promise<void>;
    invalidateValue: (valueKey: string) => Promise<void>;
}

/** Publish disposable cache state only for a fully trusted committed ack. */
export async function publishPluginStorageMutationCache(
    request: PluginStorageMutationRequest,
    result: PluginStorageMutationResult,
    cache: PluginStorageMutationCachePublisher,
): Promise<void> {
    if (!cache.enabled || result.outcome !== "committed") return;
    try {
        if (request.operation === "set" && request.valueBytes) {
            await cache.storeValue(request.valueKey, request.valueBytes);
        } else if (request.operation === "remove") {
            await cache.invalidateValue(request.valueKey);
        }
    } catch {
        // The server remains authoritative; cache publication is best-effort.
    }
}

export class PluginStorageMutationError extends StorageError {
    readonly result: PluginStorageMutationResult;
    readonly outcome: PluginStorageMutationCommitState;

    constructor(result: PluginStorageMutationResult) {
        super(
            result.error
            ?? `Plugin storage ${result.operation} outcome is ${result.outcome}.`,
            {
                status: result.status ?? null,
                code: result.code ?? null,
                retryAfter: result.retryAfter ?? null,
                retryable: result.retryable === true,
                commitOutcomeUnknown: result.commitOutcomeUnknown
                    ?? result.outcome === "unknown",
                operation: result.operation,
            },
        );
        this.name = "PluginStorageMutationError";
        this.result = result;
        this.outcome = result.outcome;
    }
}

export function requireCommittedPluginStorageMutation(
    result: PluginStorageMutationResult,
): PluginStorageMutationResult {
    if (result.outcome !== "committed") {
        throw new PluginStorageMutationError(result);
    }
    return result;
}
