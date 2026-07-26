export type PublicPluginStorageMutationOperation = "set" | "remove";
export type PublicPluginStorageMutationCommitState =
    | "committed"
    | "not-committed"
    | "unknown";

export interface PublicPluginStorageMutationFailure {
    outcome: "not-committed" | "unknown";
    operation: PublicPluginStorageMutationOperation;
    message: string;
    code: string | null;
    status: number | null;
    retryAfter: number | null;
    retryable: boolean;
    commitOutcomeUnknown: boolean;
}

export interface PublicPluginStorageMutationCommitted {
    outcome: "committed";
    operation: PublicPluginStorageMutationOperation;
    confirmation: "acknowledgement" | "authoritative-absence";
    /** The request outcome before an optional authoritative confirmation read. */
    mutationOutcome: "committed" | "unknown";
}

export type PublicPluginStorageMutationOutcome =
    | PublicPluginStorageMutationCommitted
    | PublicPluginStorageMutationFailure;

export type PublicPluginStorageConfirmedRemoveOutcome =
    | PublicPluginStorageMutationCommitted
    | (PublicPluginStorageMutationFailure & {
        /** Present when the remove committed but its required confirmation did not. */
        mutationOutcome?: PublicPluginStorageMutationCommitState;
        authoritative?: {
            status: "value";
            revision: string;
            generation: string | null;
        };
    });

type ErrorRecord = Record<string, unknown>;

/**
 * Convert an arbitrary host/bridge failure into the conservative public
 * mutation outcome. This function is self-contained because factory.ts also
 * installs its source in the sandbox guest.
 */
export function publicPluginStorageMutationFailure(
    operation: PublicPluginStorageMutationOperation,
    error: unknown,
): PublicPluginStorageMutationFailure {
    const source = error && typeof error === "object"
        ? error as ErrorRecord
        : null;
    const explicitOutcome = source?.outcome;
    const commitOutcomeUnknown = source?.commitOutcomeUnknown;
    const outcome = explicitOutcome === "not-committed"
        ? "not-committed"
        : explicitOutcome === "unknown"
            ? "unknown"
            : explicitOutcome !== undefined
                ? "unknown"
                : commitOutcomeUnknown === false
                    ? "not-committed"
                    : "unknown";
    let message = "Plugin storage mutation failed.";
    if (typeof error === "string" && error.length > 0) message = error;
    else if (typeof source?.message === "string" && source.message.length > 0) {
        message = source.message;
    } else if (error !== undefined && error !== null) {
        const rendered = String(error);
        if (rendered && rendered !== "[object Object]") message = rendered;
    }
    return {
        outcome,
        operation,
        message,
        code: typeof source?.code === "string" ? source.code : null,
        status: typeof source?.status === "number" ? source.status : null,
        retryAfter: typeof source?.retryAfter === "number" ? source.retryAfter : null,
        retryable: outcome === "not-committed" && source?.retryable === true,
        commitOutcomeUnknown: outcome === "unknown",
    };
}

export async function runPublicPluginStorageMutation(
    operation: PublicPluginStorageMutationOperation,
    mutate: () => Promise<unknown>,
): Promise<PublicPluginStorageMutationOutcome> {
    try {
        await mutate();
        return {
            outcome: "committed",
            operation,
            confirmation: "acknowledgement",
            mutationOutcome: "committed",
        };
    } catch (error) {
        return publicPluginStorageMutationFailure(operation, error);
    }
}

export type PluginStorageAbsenceState =
    | { status: "missing"; revision: null; generation: string | null }
    | { status: "value"; revision: string; generation: string | null };

/**
 * Remove once, never replay an ambiguous request, and confirm the durable
 * postcondition before reporting success. A present row is deliberately not
 * returned: callers should re-read it before rebuilding their local cache.
 */
export async function runConfirmedPluginStorageRemove(
    remove: () => Promise<unknown>,
    readState: () => Promise<PluginStorageAbsenceState>,
): Promise<PublicPluginStorageConfirmedRemoveOutcome> {
    const mutation = await runPublicPluginStorageMutation("remove", remove);
    if (mutation.outcome === "not-committed") return mutation;

    try {
        const authoritative = await readState();
        if (authoritative.status === "missing") {
            return {
                outcome: "committed",
                operation: "remove",
                confirmation: "authoritative-absence",
                mutationOutcome: mutation.outcome,
            };
        }
        return {
            outcome: "unknown",
            operation: "remove",
            message: "The authoritative plugin storage value is present after removal.",
            code: "PLUGIN_STORAGE_VALUE_PRESENT",
            status: null,
            retryAfter: null,
            retryable: false,
            commitOutcomeUnknown: true,
            mutationOutcome: mutation.outcome,
            authoritative: {
                status: "value",
                revision: authoritative.revision,
                generation: authoritative.generation,
            },
        };
    } catch (error) {
        const failure = publicPluginStorageMutationFailure("remove", error);
        return {
            ...failure,
            outcome: "unknown",
            code: "PLUGIN_STORAGE_ABSENCE_UNCONFIRMED",
            retryable: false,
            commitOutcomeUnknown: true,
            mutationOutcome: mutation.outcome,
        };
    }
}
