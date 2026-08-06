import { ModelJobConnectionLostError } from './modelJobErrors'

export type ModelJobRecoveryDisposition = 'connection-lost'

export interface RecoverableModelJobFailure {
    recoveryDisposition?: ModelJobRecoveryDisposition
}

function causedByConnectionLoss(error: unknown): boolean {
    const seen = new Set<unknown>()
    let current = error
    while (current && !seen.has(current)) {
        if (current instanceof ModelJobConnectionLostError) return true
        seen.add(current)
        current = typeof current === 'object' && current !== null
            ? (current as { cause?: unknown }).cause
            : undefined
    }
    return false
}

/** Preserve typed recovery intent when an adapter catches/wraps transport
 * failure into the ordinary request response union. */
export function recoveryDispositionForModelJobError(
    error: unknown,
): ModelJobRecoveryDisposition | undefined {
    return causedByConnectionLoss(error) ? 'connection-lost' : undefined
}

/** Only main jobs have recoverable journals. Mirror request.ts's jobKind
 * identity contract exactly: a truthy realChatId means main; absence means aux. */
export function recoveryDispositionForModelJobRequestError(
    error: unknown,
    realChatId: string | undefined,
): ModelJobRecoveryDisposition | undefined {
    if (!realChatId) return undefined
    return recoveryDispositionForModelJobError(error)
}

/** Reconstitute the recoverable control flow at sendChat's publication owner. */
export function throwRecoverableModelJobFailure(
    response: RecoverableModelJobFailure,
): void {
    if (response.recoveryDisposition === 'connection-lost') {
        throw new ModelJobConnectionLostError()
    }
}

export function isRecoverableModelJobFailure(
    response: RecoverableModelJobFailure,
): boolean {
    return response.recoveryDisposition === 'connection-lost'
}
