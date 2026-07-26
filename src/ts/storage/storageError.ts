export interface StorageErrorOptions {
    status?: number | null;
    code?: string | null;
    /** Retry delay in seconds, matching HTTP Retry-After semantics. */
    retryAfter?: number | null;
    retryable?: boolean;
    commitOutcomeUnknown?: boolean;
    operation?: string | null;
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
    readonly operation: string | null;

    constructor(message: string, options: StorageErrorOptions = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = "StorageError";
        this.status = options.status ?? null;
        this.code = options.code ?? null;
        this.retryAfter = options.retryAfter ?? null;
        this.retryable = options.retryable === true;
        this.commitOutcomeUnknown = options.commitOutcomeUnknown === true;
        this.operation = options.operation ?? null;
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
