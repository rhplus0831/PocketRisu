import { describe, expect, it } from 'vitest'
import pkg from './importBarrier.cjs'

const { createImportBarrier } = pkg as {
    createImportBarrier: () => {
        acquire: () => Promise<() => void>
        waitUntilIdle: () => Promise<void>
    }
}

function nextTurn(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve))
}

describe('import barrier', () => {
    it('blocks idle waiters until the active holder releases', async () => {
        const barrier = createImportBarrier()
        const release = await barrier.acquire()
        let resolved = false
        const waiter = barrier.waitUntilIdle().then(() => { resolved = true })

        await nextTurn()
        expect(resolved).toBe(false)

        release()
        await waiter
        expect(resolved).toBe(true)
    })

    it('waits across queued back-to-back holders', async () => {
        const barrier = createImportBarrier()
        const releaseFirst = await barrier.acquire()
        let secondAcquired = false
        const secondHolder = barrier.acquire().then((release) => {
            secondAcquired = true
            return release
        })
        let idle = false
        const waiter = barrier.waitUntilIdle().then(() => { idle = true })

        releaseFirst()
        const releaseSecond = await secondHolder
        expect(secondAcquired).toBe(true)
        await nextTurn()
        expect(idle).toBe(false)

        releaseSecond()
        await waiter
        expect(idle).toBe(true)
    })

    it('lets a waiter pass immediately while idle', async () => {
        const barrier = createImportBarrier()

        await expect(barrier.waitUntilIdle()).resolves.toBeUndefined()
    })
})
