import { RisuSaveBlockIntegrityError } from './strictRisuSaveCodec'
import type {
    PayloadCodecOperation,
    PayloadCodecResult,
} from './payloadCodecOperations'

export type SerializedCodecError = {
    name: string
    message: string
    code?: string
    stack?: string
    cause?: SerializedCodecError
}

export type PayloadCodecWorkerRequest = {
    type: 'request'
    id: number
    operation: PayloadCodecOperation
}

export type PayloadCodecWorkerResponse =
    | { type: 'ready' }
    | { type: 'result'; id: number; result: PayloadCodecResult }
    | { type: 'error'; id: number; error: SerializedCodecError }

export function serializeCodecError(error: unknown, depth = 0): SerializedCodecError {
    if (!(error instanceof Error)) {
        return { name: 'Error', message: String(error) }
    }
    const code = typeof (error as Error & { code?: unknown }).code === 'string'
        ? (error as Error & { code: string }).code
        : undefined
    const cause = depth < 4 && error.cause !== undefined
        ? serializeCodecError(error.cause, depth + 1)
        : undefined
    return {
        name: error.name || 'Error',
        message: error.message,
        code,
        stack: error.stack,
        cause,
    }
}

export function deserializeCodecError(serialized: SerializedCodecError): Error {
    const cause = serialized.cause
        ? deserializeCodecError(serialized.cause)
        : undefined
    const error = serialized.code === 'RISU_SAVE_INVALID'
        ? new RisuSaveBlockIntegrityError(
            serialized.message,
            cause === undefined ? undefined : { cause },
        )
        : new Error(
            serialized.message,
            cause === undefined ? undefined : { cause },
        )
    error.name = serialized.name || error.name
    if (serialized.stack) error.stack = serialized.stack
    if (serialized.code && serialized.code !== 'RISU_SAVE_INVALID') {
        Object.defineProperty(error, 'code', {
            configurable: true,
            enumerable: true,
            value: serialized.code,
        })
    }
    return error
}
