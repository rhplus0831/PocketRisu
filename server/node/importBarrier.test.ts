import { describe, expect, it } from 'vitest'
import pkg from './importBarrier.cjs'

const { createImportBarrier } = pkg as {
    createImportBarrier: (opts?: { drainMutations?: () => Promise<unknown> }) => {
        acquire: () => Promise<() => void>
        isHeld: () => boolean
        waitUntilIdle: (signal?: AbortSignal | null) => Promise<void>
    }
}

/** Minimal stand-in for the server's serial storage queue. */
function createSerialQueue() {
    let tail: Promise<unknown> = Promise.resolve()
    return (operation: () => unknown) => {
        const run = tail.then(operation, operation)
        tail = run.catch(() => {})
        return run
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

    it('lets an abandoned waiter cancel while the holder remains active', async () => {
        const barrier = createImportBarrier()
        const release = await barrier.acquire()
        const controller = new AbortController()
        const reason = new DOMException('viewer closed', 'AbortError')
        const waiter = barrier.waitUntilIdle(controller.signal)

        controller.abort(reason)
        await expect(waiter).rejects.toBe(reason)
        expect(barrier.isHeld()).toBe(true)

        release()
        await expect(barrier.waitUntilIdle()).resolves.toBeUndefined()
    })

    it('reports held only between acquire and release', async () => {
        const barrier = createImportBarrier()
        expect(barrier.isHeld()).toBe(false)

        const release = await barrier.acquire()
        expect(barrier.isHeld()).toBe(true)

        release()
        expect(barrier.isHeld()).toBe(false)
        // Releasing twice must not drop a concurrent holder's claim.
        release()
        expect(barrier.isHeld()).toBe(false)
    })

    it('drains queued mutations before acquire resolves, and claims the hold first', async () => {
        const queue = createSerialQueue()
        const barrier = createImportBarrier({ drainMutations: () => queue(() => {}) })
        const order: string[] = []

        // Enqueued ahead of the drain: must complete before the import proceeds.
        let releaseInFlight: () => void
        const inFlight = new Promise<void>((resolve) => { releaseInFlight = resolve })
        const early = queue(async () => {
            await inFlight
            order.push('early-mutation')
        })

        let acquired = false
        const acquisition = barrier.acquire().then((release) => {
            acquired = true
            order.push('import')
            return release
        })

        await nextTurn()
        expect(acquired).toBe(false)
        // The hold is claimed before draining, so anything arriving now is
        // already refusable rather than able to join the import transaction.
        expect(barrier.isHeld()).toBe(true)

        releaseInFlight!()
        await early
        const release = await acquisition
        expect(order).toEqual(['early-mutation', 'import'])

        release()
        expect(barrier.isHeld()).toBe(false)
    })

    it('releases the hold when the drain fails', async () => {
        const barrier = createImportBarrier({
            drainMutations: () => Promise.reject(new Error('drain exploded')),
        })

        await expect(barrier.acquire()).rejects.toThrow('drain exploded')
        expect(barrier.isHeld()).toBe(false)
        // A failed acquire must not wedge the queue for the next import.
        const release = await barrier.acquire().catch(() => null)
        expect(release).toBeNull()
        await expect(barrier.waitUntilIdle()).resolves.toBeUndefined()
    })
})
