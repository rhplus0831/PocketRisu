import { describe, expect, test, vi } from 'vitest'
import { applyPluginEditHandlers } from './pluginEditHandlers'

describe('plugin edit handlers', () => {
    test('isolates one handler failure and continues from the last valid input', async () => {
        const failure = new Error('child turn failed')
        const onError = vi.fn()

        const result = await applyPluginEditHandlers([
            async content => `${content}:first`,
            async () => { throw failure },
            async content => `${content}:third`,
        ], 'input', { isolateErrors: true, onError })

        expect(result).toBe('input:first:third')
        expect(onError).toHaveBeenCalledWith(failure)
    })

    test('preserves rejection behavior when isolation is disabled', async () => {
        const failure = new Error('output hook failed')
        await expect(applyPluginEditHandlers([
            async () => { throw failure },
        ], 'output')).rejects.toBe(failure)
    })
})
