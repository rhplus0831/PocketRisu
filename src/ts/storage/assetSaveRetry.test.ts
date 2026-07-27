import { describe, test, expect } from 'vitest'
import { withAssetSaveRetry, ASSET_SAVE_RETRY_DELAYS_MS } from './assetSaveRetry'

// Tiny delays + a no-op waiter keep these instant; the production table is
// asserted separately so a careless edit to it still gets noticed.
const DELAYS = [1, 1, 1, 1]
const noWait = async () => {}

const KEY = `assets/${'a'.repeat(64)}.png`

function failingWrite(failTimes: number, error: unknown = new Error('setItem Error')) {
    const state = { attempts: 0 }
    const write = async () => {
        state.attempts++
        if (state.attempts <= failTimes) throw error
        return 'written'
    }
    return { state, write }
}

class ConflictErrorStub extends Error {
    constructor() {
        super('conflict')
        this.name = 'ConflictError'
    }
}

describe('withAssetSaveRetry', () => {
    test('does not retry when the write succeeds', async () => {
        const { state, write } = failingWrite(0)
        await expect(withAssetSaveRetry(KEY, write, DELAYS, noWait)).resolves.toBe('written')
        expect(state.attempts).toBe(1)
    })

    test('recovers from a transient failure instead of aborting the import', async () => {
        const { state, write } = failingWrite(3)
        await expect(withAssetSaveRetry(KEY, write, DELAYS, noWait)).resolves.toBe('written')
        expect(state.attempts).toBe(4)
    })

    test('survives a failure on every attempt but the last', async () => {
        const { state, write } = failingWrite(DELAYS.length)
        await expect(withAssetSaveRetry(KEY, write, DELAYS, noWait)).resolves.toBe('written')
        expect(state.attempts).toBe(DELAYS.length + 1)
    })

    test('gives up after a bounded number of attempts', async () => {
        const { state, write } = failingWrite(Number.MAX_SAFE_INTEGER)
        await expect(withAssetSaveRetry(KEY, write, DELAYS, noWait))
            .rejects.toThrow(/after 5 attempts/)
        expect(state.attempts).toBe(DELAYS.length + 1)
    })

    test('names the asset and preserves the cause so the aggregate error is useful', async () => {
        const cause = new Error('502 Bad Gateway')
        const { write } = failingWrite(Number.MAX_SAFE_INTEGER, cause)
        const error = await withAssetSaveRetry(KEY, write, DELAYS, noWait).catch(e => e)
        expect(error.message).toContain(KEY)
        expect(error.message).toContain('502 Bad Gateway')
        expect(error.cause).toBe(cause)
    })

    test('reports non-Error throws rather than swallowing them', async () => {
        // The node storage layer throws bare strings for non-2xx responses.
        const { write } = failingWrite(Number.MAX_SAFE_INTEGER, 'setItem Error')
        await expect(withAssetSaveRetry(KEY, write, DELAYS, noWait))
            .rejects.toThrow(/setItem Error/)
    })

    test('does not retry a conflict — resending identical bytes cannot resolve it', async () => {
        const { state, write } = failingWrite(Number.MAX_SAFE_INTEGER, new ConflictErrorStub())
        await expect(withAssetSaveRetry(KEY, write, DELAYS, noWait))
            .rejects.toBeInstanceOf(ConflictErrorStub)
        expect(state.attempts).toBe(1)
    })

    test('waits between attempts, with jitter above the base delay', async () => {
        const waited: number[] = []
        const { write } = failingWrite(2)
        await withAssetSaveRetry(KEY, write, [100, 200], async (ms) => { waited.push(ms) })
        expect(waited.length).toBe(2)
        expect(waited[0]).toBeGreaterThanOrEqual(100)
        expect(waited[0]).toBeLessThan(150)
        expect(waited[1]).toBeGreaterThanOrEqual(200)
        expect(waited[1]).toBeLessThan(300)
    })

    test('production backoff spans long enough to outlast a short server stall', () => {
        const total = ASSET_SAVE_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0)
        expect(ASSET_SAVE_RETRY_DELAYS_MS.length).toBe(4)
        expect(total).toBeGreaterThanOrEqual(15000)
    })
})
