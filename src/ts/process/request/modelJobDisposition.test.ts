import { describe, expect, test } from 'vitest'
import { ModelJobConnectionLostError } from './modelJobErrors'
import {
    recoveryDispositionForModelJobError,
    recoveryDispositionForModelJobRequestError,
    isRecoverableModelJobFailure,
    throwRecoverableModelJobFailure,
} from './modelJobDisposition'

describe('model-job recoverable disposition', () => {
    test('main direct and adapter-wrapped loss bypass retry and reach sendChat as recoverable', () => {
        const direct = new ModelJobConnectionLostError()
        const wrapped = new Error('adapter request failed', { cause: direct })

        expect(recoveryDispositionForModelJobError(direct)).toBe('connection-lost')
        expect(recoveryDispositionForModelJobError(wrapped)).toBe('connection-lost')
        for (const error of [direct, wrapped]) {
            const failure = {
                recoveryDisposition: recoveryDispositionForModelJobRequestError(error, 'chat-main'),
            }
            // This is the predicate requestChatData uses before its ordinary
            // retry/fallback loop, and the rethrow sendChat uses afterward.
            expect(isRecoverableModelJobFailure(failure)).toBe(true)
            expect(() => throwRecoverableModelJobFailure(failure))
                .toThrow(ModelJobConnectionLostError)
        }
    })

    test('identical aux loss remains an ordinary retry/fallback failure', () => {
        const direct = new ModelJobConnectionLostError()
        const wrapped = new Error('adapter request failed', { cause: direct })

        for (const error of [direct, wrapped]) {
            const failure = {
                recoveryDisposition: recoveryDispositionForModelJobRequestError(error, undefined),
            }
            expect(isRecoverableModelJobFailure(failure)).toBe(false)
            expect(() => throwRecoverableModelJobFailure(failure)).not.toThrow()
        }
    })

    test('ordinary failures stay ordinary', () => {
        expect(recoveryDispositionForModelJobError(new Error('HTTP 500'))).toBeUndefined()
        expect(() => throwRecoverableModelJobFailure({})).not.toThrow()
    })
})
