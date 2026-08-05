import { describe, expect, test } from 'vitest'
import {
    QUICK_SAVE_RETRY_LIMIT,
    SLOW_SAVE_RETRY_INTERVAL_MS,
    SaveRetryScheduler,
} from './saveRetryScheduler'

function fakeClock() {
    let currentTime = 0
    return {
        now: () => currentTime,
        advance: (delayMs: number) => {
            currentTime += delayMs
        },
    }
}

describe('SaveRetryScheduler', () => {
    test('uses the existing quick delays for the first four failures', () => {
        const scheduler = new SaveRetryScheduler()

        expect([
            scheduler.recordFailure(),
            scheduler.recordFailure(),
            scheduler.recordFailure(),
            scheduler.recordFailure(),
        ]).toEqual([
            { kind: 'quick', delayMs: 500 },
            { kind: 'quick', delayMs: 1_000 },
            { kind: 'quick', delayMs: 1_500 },
            { kind: 'quick', delayMs: 2_000 },
        ])
    })

    test('alerts only on the first slow failure in an outage streak', () => {
        const scheduler = new SaveRetryScheduler()

        for (let failure = 0; failure < QUICK_SAVE_RETRY_LIMIT; failure++) {
            scheduler.recordFailure()
        }

        expect(scheduler.recordFailure()).toEqual({ kind: 'slow', alert: true })
        expect(scheduler.recordFailure()).toEqual({ kind: 'slow', alert: false })
        expect(scheduler.recordFailure()).toEqual({ kind: 'slow', alert: false })
    })

    test('wakes once at the slow deadline and requires another failure to re-arm', () => {
        const clock = fakeClock()
        const scheduler = new SaveRetryScheduler({ now: clock.now })
        for (let failure = 0; failure <= QUICK_SAVE_RETRY_LIMIT; failure++) {
            scheduler.recordFailure()
        }

        clock.advance(SLOW_SAVE_RETRY_INTERVAL_MS - 1)
        expect(scheduler.shouldWakeIdleLoop()).toBe(false)
        clock.advance(1)
        expect(scheduler.shouldWakeIdleLoop()).toBe(true)
        expect(scheduler.shouldWakeIdleLoop()).toBe(false)

        expect(scheduler.recordFailure()).toEqual({ kind: 'slow', alert: false })
        clock.advance(SLOW_SAVE_RETRY_INTERVAL_MS)
        expect(scheduler.shouldWakeIdleLoop()).toBe(true)
        expect(scheduler.shouldWakeIdleLoop()).toBe(false)
    })

    test('recordSuccess resets failures, alerts, and an armed deadline', () => {
        const clock = fakeClock()
        const scheduler = new SaveRetryScheduler({ now: clock.now })
        for (let failure = 0; failure <= QUICK_SAVE_RETRY_LIMIT; failure++) {
            scheduler.recordFailure()
        }

        scheduler.recordSuccess()
        clock.advance(SLOW_SAVE_RETRY_INTERVAL_MS)

        expect(scheduler.shouldWakeIdleLoop()).toBe(false)
        expect(scheduler.recordFailure()).toEqual({ kind: 'quick', delayMs: 500 })
        for (let failure = 1; failure < QUICK_SAVE_RETRY_LIMIT; failure++) {
            scheduler.recordFailure()
        }
        expect(scheduler.recordFailure()).toEqual({ kind: 'slow', alert: true })
    })

    test('expedites only an armed slow retry deadline', () => {
        const scheduler = new SaveRetryScheduler()

        expect(scheduler.expediteOnline()).toBe(false)
        scheduler.recordFailure()
        expect(scheduler.expediteOnline()).toBe(false)
        for (let failure = 1; failure <= QUICK_SAVE_RETRY_LIMIT; failure++) {
            scheduler.recordFailure()
        }

        expect(scheduler.expediteOnline()).toBe(true)
        expect(scheduler.expediteOnline()).toBe(false)
        scheduler.recordFailure()
        scheduler.recordSuccess()
        expect(scheduler.expediteOnline()).toBe(false)
    })

    test('preserves conflict backoff progression and caps it at three seconds', () => {
        const scheduler = new SaveRetryScheduler()

        expect(scheduler.conflictBackoffMs()).toBe(500)
        const expectedDelays = [1_000, 1_500, 2_000, 2_500, 3_000, 3_000]
        for (const expectedDelay of expectedDelays) {
            scheduler.recordFailure()
            expect(scheduler.conflictBackoffMs()).toBe(expectedDelay)
        }
    })

    test('retries the five-failure outage protocol through recovery', () => {
        const clock = fakeClock()
        const scheduler = new SaveRetryScheduler({ now: clock.now })
        for (let failure = 0; failure < QUICK_SAVE_RETRY_LIMIT; failure++) {
            expect(scheduler.recordFailure().kind).toBe('quick')
        }

        expect(scheduler.recordFailure()).toEqual({ kind: 'slow', alert: true })
        clock.advance(SLOW_SAVE_RETRY_INTERVAL_MS)
        expect(scheduler.shouldWakeIdleLoop()).toBe(true)
        expect(scheduler.shouldWakeIdleLoop()).toBe(false)

        expect(scheduler.recordFailure()).toEqual({ kind: 'slow', alert: false })
        clock.advance(SLOW_SAVE_RETRY_INTERVAL_MS)
        expect(scheduler.shouldWakeIdleLoop()).toBe(true)

        scheduler.recordSuccess()
        expect(scheduler.shouldWakeIdleLoop()).toBe(false)
        expect(scheduler.expediteOnline()).toBe(false)
        expect(scheduler.recordFailure()).toEqual({ kind: 'quick', delayMs: 500 })
    })
})
