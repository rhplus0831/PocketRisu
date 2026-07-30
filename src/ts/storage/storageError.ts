export interface StorageErrorOptions {
    status?: number | null;
    code?: string | null;
    /** Retry delay in seconds, matching HTTP Retry-After semantics. */
    retryAfter?: number | null;
    retryable?: boolean;
    commitOutcomeUnknown?: boolean;
    commitOutcome?: "not-committed" | "committed" | "unknown" | null;
    operation?: string | null;
    limit?: number;
    actual?: number;
    cause?: unknown;
}

/**
 * A storage failure that keeps the server retry contract intact across callers
 * and the V3 iframe bridge.
 */
export class StorageError extends Error {
    readonly status: number | null;
    readonly code: string | null;
    readonly retryAfter: number | null;
    readonly retryable: boolean;
    readonly commitOutcomeUnknown: boolean;
    readonly commitOutcome: "not-committed" | "committed" | "unknown" | null;
    readonly operation: string | null;
    readonly limit?: number;
    readonly actual?: number;

    constructor(message: string, options: StorageErrorOptions = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = "StorageError";
        this.status = options.status ?? null;
        this.code = options.code ?? null;
        this.retryAfter = options.retryAfter ?? null;
        this.retryable = options.retryable === true;
        this.commitOutcomeUnknown = options.commitOutcomeUnknown === true;
        this.commitOutcome = options.commitOutcome ?? null;
        this.operation = options.operation ?? null;
        this.limit = options.limit;
        this.actual = options.actual;
    }
}

export function getThrownMessage(error: unknown, fallback: string): string {
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
        const message = (error as { message?: unknown }).message;
        if (typeof message === "string" && message.length > 0) return message;
    }
    if (error !== undefined && error !== null) {
        const coerced = String(error);
        if (coerced && coerced !== "[object Object]") return coerced;
    }
    return fallback;
}
