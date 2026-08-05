import { afterEach, describe, expect, test, vi } from 'vitest'
import { DatabaseDirtyRevisionLedger } from './databaseDirtyRevisions'
import {
    STAGED_ACK_CONFIRM_DELAY_MS,
    StagedAckTracker,
    type FlushResult,
} from './stagedAckTracker'

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise
    })
    return { promise, resolve }
}

function stagedCallbacks(label: string, events: string[]) {
    return {
        etag: label,
        commit: vi.fn(() => events.push(`commit:${label}`)),
        replay: vi.fn(() => events.push(`replay:${label}`)),
    }
}

afterEach(() => {
    vi.useRealTimers()
})

describe('StagedAckTracker', () => {
    test('holds a staged entry until a durable flush confirms its ETag', async () => {
        vi.useFakeTimers()
        const events: string[] = []
        const entry = stagedCallbacks('etag-a', events)
        const flush = vi.fn(async (): Promise<FlushResult> => ({
            ok: true,
            durable: true,
            etag: 'etag-a',
        }))
        const tracker = new StagedAckTracker({ flush })

        tracker.recordStaged(entry)
        expect(tracker.hasStaged()).toBe(true)
        expect(entry.commit).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(STAGED_ACK_CONFIRM_DELAY_MS - 1)
        expect(flush).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)

        expect(flush).toHaveBeenCalledOnce()
        expect(events).toEqual(['commit:etag-a'])
        expect(tracker.hasStaged()).toBe(false)
    })

    test('uses a matching ETag as a watermark for that entry and every earlier entry', () => {
        vi.useFakeTimers()
        const events: string[] = []
        const tracker = new StagedAckTracker({
            flush: vi.fn(),
        })
        const first = stagedCallbacks('etag-a', events)
        const second = stagedCallbacks('etag-b', events)
        const third = stagedCallbacks('etag-c', events)
        tracker.recordStaged(first)
        tracker.recordStaged(second)
        tracker.recordStaged(third)

        tracker.confirmThroughEtag('etag-b')

        expect(events).toEqual(['commit:etag-a', 'commit:etag-b'])
        expect(third.commit).not.toHaveBeenCalled()
        expect(tracker.hasStaged()).toBe(true)
        tracker.confirmThroughEtag('unknown')
        expect(events).toEqual(['commit:etag-a', 'commit:etag-b'])
    })

    test('retries a transport failure with backoff without dropping staged entries', async () => {
        vi.useFakeTimers()
        const events: string[] = []
        const flush = vi.fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce({ ok: true, durable: true, etag: 'etag-a' })
        const tracker = new StagedAckTracker({ flush })
        tracker.recordStaged(stagedCallbacks('etag-a', events))

        await vi.advanceTimersByTimeAsync(STAGED_ACK_CONFIRM_DELAY_MS)
        expect(flush).toHaveBeenCalledTimes(1)
        expect(tracker.hasStaged()).toBe(true)
        expect(events).toEqual([])

        await vi.advanceTimersByTimeAsync(1_999)
        expect(flush).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1)

        expect(flush).toHaveBeenCalledTimes(2)
        expect(events).toEqual(['commit:etag-a'])
        expect(tracker.hasStaged()).toBe(false)
    })

    test('keeps staged entries when a checkpoint-busy flush is not durable', async () => {
        vi.useFakeTimers()
        const events: string[] = []
        const flush = vi.fn()
            .mockResolvedValueOnce({ ok: false, durable: false, retryable: true })
            .mockResolvedValueOnce({ ok: true, durable: true, etag: 'etag-a' })
        const tracker = new StagedAckTracker({ flush })
        tracker.recordStaged(stagedCallbacks('etag-a', events))

        await vi.advanceTimersByTimeAsync(STAGED_ACK_CONFIRM_DELAY_MS)
        expect(tracker.hasStaged()).toBe(true)
        expect(events).toEqual([])

        await vi.advanceTimersByTimeAsync(2_000)
        expect(events).toEqual(['commit:etag-a'])
        expect(tracker.hasStaged()).toBe(false)
    })

    test('replays all entries after three consecutive durable unknown ETags', async () => {
        vi.useFakeTimers()
        const events: string[] = []
        const flush = vi.fn(async () => ({
            ok: true,
            durable: true,
            etag: 'server-rolled-back',
        }))
        const tracker = new StagedAckTracker({ flush })
        tracker.recordStaged(stagedCallbacks('etag-a', events))
        tracker.recordStaged(stagedCallbacks('etag-b', events))

        await vi.advanceTimersByTimeAsync(STAGED_ACK_CONFIRM_DELAY_MS)
        await vi.advanceTimersByTimeAsync(2_000)
        await vi.advanceTimersByTimeAsync(4_000)

        expect(flush).toHaveBeenCalledTimes(3)
        expect(events).toEqual(['replay:etag-a', 'replay:etag-b'])
        expect(tracker.hasStaged()).toBe(false)
    })

    test('confirmAll commits every staged entry after a durable full write', () => {
        const events: string[] = []
        const tracker = new StagedAckTracker({ flush: vi.fn() })
        tracker.recordStaged(stagedCallbacks('etag-a', events))
        tracker.recordStaged(stagedCallbacks('etag-b', events))

        tracker.confirmAll()

        expect(events).toEqual(['commit:etag-a', 'commit:etag-b'])
        expect(tracker.hasStaged()).toBe(false)
    })

    test('replayAll invokes replay callbacks oldest-first exactly once', () => {
        const events: string[] = []
        const tracker = new StagedAckTracker({ flush: vi.fn() })
        const first = stagedCallbacks('etag-a', events)
        const second = stagedCallbacks('etag-b', events)
        tracker.recordStaged(first)
        tracker.recordStaged(second)

        tracker.replayAll('conflict')
        tracker.replayAll('conflict')

        expect(events).toEqual(['replay:etag-a', 'replay:etag-b'])
        expect(first.replay).toHaveBeenCalledOnce()
        expect(second.replay).toHaveBeenCalledOnce()
        expect(tracker.hasStaged()).toBe(false)
    })

    test('confirmNow coalesces with an in-flight debounced confirmation', async () => {
        vi.useFakeTimers()
        const events: string[] = []
        const confirmation = deferred<FlushResult>()
        const flush = vi.fn(() => confirmation.promise)
        const tracker = new StagedAckTracker({ flush })
        tracker.recordStaged(stagedCallbacks('etag-a', events))

        await vi.advanceTimersByTimeAsync(STAGED_ACK_CONFIRM_DELAY_MS)
        const immediate = tracker.confirmNow()
        expect(flush).toHaveBeenCalledOnce()

        confirmation.resolve({ ok: true, durable: true, etag: 'etag-a' })
        await expect(immediate).resolves.toBe(true)
        expect(flush).toHaveBeenCalledOnce()
        expect(events).toEqual(['commit:etag-a'])
    })

    test('confirmNow replays staged entries when immediate durability cannot be proven', async () => {
        const events: string[] = []
        const tracker = new StagedAckTracker({
            flush: vi.fn(async () => ({ ok: false, durable: false, retryable: true })),
        })
        tracker.recordStaged(stagedCallbacks('etag-a', events))

        await expect(tracker.confirmNow()).resolves.toBe(false)

        expect(events).toEqual(['replay:etag-a'])
        expect(tracker.hasStaged()).toBe(false)
    })

    test('dirty tracking survives a staged ack without confirmation and is replayed', () => {
        const ledger = new DatabaseDirtyRevisionLedger()
        ledger.markCharacter('char-a')
        const proposal = ledger.capture()
        const requeued: string[] = []
        const tracker = new StagedAckTracker({ flush: vi.fn() })

        tracker.recordStaged({
            etag: 'etag-a',
            commit: () => ledger.commit(proposal),
            replay: () => {
                ledger.discard(proposal)
                requeued.push('char-a')
            },
        })

        expect(ledger.hasDirty()).toBe(true)
        expect(tracker.hasStaged()).toBe(true)
        tracker.replayAll('conflict')

        expect(ledger.hasDirty()).toBe(true)
        expect(requeued).toEqual(['char-a'])
        expect(tracker.hasStaged()).toBe(false)
    })
})
