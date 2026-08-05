export const QUICK_SAVE_RETRY_LIMIT = 4
export const SLOW_SAVE_RETRY_INTERVAL_MS = 10_000

const QUICK_SAVE_RETRY_BASE_DELAY_MS = 500
const MAX_QUICK_SAVE_RETRY_DELAY_MS = 3_000

export interface SaveRetrySchedulerOptions {
    now?: () => number
}

export type SaveRetryPlan =
    | { kind: 'quick', delayMs: number }
    | { kind: 'slow', alert: boolean }

/**
 * Owns save-failure pacing so five consecutive failures enter a slow capped
 * cadence instead of idling the save loop with dirty state still queued.
 */
export class SaveRetryScheduler {
    private readonly now: () => number
    private failures = 0
    private alerted = false
    private slowRetryAt: number | null = null

    constructor(options: SaveRetrySchedulerOptions = {}) {
        this.now = options.now ?? Date.now
    }

    recordFailure(): SaveRetryPlan {
        this.failures = Math.min(
            this.failures + 1,
            QUICK_SAVE_RETRY_LIMIT + 1,
        )
        if (this.failures <= QUICK_SAVE_RETRY_LIMIT) {
            return {
                kind: 'quick',
                delayMs: Math.min(
                    QUICK_SAVE_RETRY_BASE_DELAY_MS * this.failures,
                    MAX_QUICK_SAVE_RETRY_DELAY_MS,
                ),
            }
        }

        const alert = !this.alerted
        this.alerted = true
        this.slowRetryAt = this.now() + SLOW_SAVE_RETRY_INTERVAL_MS
        return { kind: 'slow', alert }
    }

    recordSuccess(): void {
        this.failures = 0
        this.alerted = false
        this.slowRetryAt = null
    }

    conflictBackoffMs(): number {
        return Math.min(
            QUICK_SAVE_RETRY_BASE_DELAY_MS * (this.failures + 1),
            MAX_QUICK_SAVE_RETRY_DELAY_MS,
        )
    }

    shouldWakeIdleLoop(): boolean {
        if (this.slowRetryAt === null || this.now() < this.slowRetryAt) {
            return false
        }
        this.slowRetryAt = null
        return true
    }

    expediteOnline(): boolean {
        if (this.slowRetryAt === null) return false
        this.slowRetryAt = null
        return true
    }
}
