export const STAGED_ACK_CONFIRM_DELAY_MS = 6_500

const INITIAL_RETRY_DELAY_MS = 2_000
const MAX_RETRY_DELAY_MS = 30_000
const MAX_ETAG_MISMATCHES = 3

export interface FlushResult {
    ok: boolean
    durable: boolean
    etag?: string
    displaced?: boolean
    retryable?: boolean
}

export interface StagedAckEntry {
    etag?: string
    commit: () => void
    replay: () => void
}

type TimerHandle = ReturnType<typeof setTimeout>

export interface StagedAckTrackerOptions {
    flush: () => Promise<FlushResult>
    confirmationDelayMs?: number
    setTimer?: (callback: () => void, delayMs: number) => TimerHandle
    clearTimer?: (handle: TimerHandle) => void
    onReplay?: (reason: string) => void
}

interface SequencedStagedAckEntry extends StagedAckEntry {
    sequence: number
}

/**
 * Holds patch acknowledgements until a database flush proves their ETag is
 * durable. Callback ownership stays with the save loop so this module remains
 * independent from Svelte state and database revision implementations.
 */
export class StagedAckTracker {
    private readonly flush: () => Promise<FlushResult>
    private readonly confirmationDelayMs: number
    private readonly setTimer: StagedAckTrackerOptions['setTimer']
    private readonly clearTimer: StagedAckTrackerOptions['clearTimer']
    private readonly onReplay?: (reason: string) => void
    private entries: SequencedStagedAckEntry[] = []
    private nextSequence = 0
    private timer: TimerHandle | null = null
    private confirmationInFlight: Promise<boolean> | null = null
    private retryAttempt = 0
    private consecutiveEtagMismatches = 0
    private stopped = false

    constructor(options: StagedAckTrackerOptions) {
        this.flush = options.flush
        this.confirmationDelayMs = options.confirmationDelayMs
            ?? STAGED_ACK_CONFIRM_DELAY_MS
        this.setTimer = options.setTimer ?? ((callback, delayMs) => (
            setTimeout(callback, delayMs)
        ))
        this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle))
        this.onReplay = options.onReplay
    }

    recordStaged(entry: StagedAckEntry): number {
        this.nextSequence += 1
        const sequence = this.nextSequence
        if (this.stopped) {
            entry.replay()
            this.onReplay?.('displaced')
            return sequence
        }
        this.entries.push({ ...entry, sequence })
        this.schedule(this.confirmationDelayMs)
        return sequence
    }

    confirmThroughEtag(etag: string): void {
        let matchingIndex = -1
        for (let index = this.entries.length - 1; index >= 0; index--) {
            if (this.entries[index].etag === etag) {
                matchingIndex = index
                break
            }
        }
        if (matchingIndex === -1) return

        const confirmed = this.entries.splice(0, matchingIndex + 1)
        for (const entry of confirmed) entry.commit()
        this.resetRetryState()
        if (this.entries.length === 0) this.cancelTimer()
    }

    confirmAll(): void {
        const confirmed = this.takeAllEntries()
        for (const entry of confirmed) entry.commit()
        this.resetRetryState()
    }

    replayAll(reason: string): void {
        if (reason === 'displaced') this.stopped = true
        const replayed = this.takeAllEntries()
        for (const entry of replayed) entry.replay()
        this.resetRetryState()
        if (replayed.length > 0) this.onReplay?.(reason)
    }

    hasStaged(): boolean {
        return this.entries.length > 0
    }

    async confirmNow(): Promise<boolean> {
        if (!this.hasStaged()) return true
        this.cancelTimer()
        const confirmed = await this.confirm()
        if (!confirmed && this.hasStaged() && !this.stopped) {
            this.replayAll('confirmation-failed')
        }
        return confirmed && !this.hasStaged()
    }

    private confirm(): Promise<boolean> {
        if (this.confirmationInFlight) return this.confirmationInFlight

        let confirmation: Promise<boolean>
        confirmation = this.runConfirmation().finally(() => {
            if (this.confirmationInFlight === confirmation) {
                this.confirmationInFlight = null
            }
        })
        this.confirmationInFlight = confirmation
        return confirmation
    }

    private async runConfirmation(): Promise<boolean> {
        if (!this.hasStaged() || this.stopped) return !this.hasStaged()

        let result: FlushResult
        try {
            result = await this.flush()
        } catch {
            this.consecutiveEtagMismatches = 0
            this.scheduleRetry()
            return false
        }

        if (result.displaced) {
            this.replayAll('displaced')
            return false
        }

        if (!result.ok || result.durable !== true) {
            this.consecutiveEtagMismatches = 0
            this.scheduleRetry()
            return false
        }

        const matchingEntry = typeof result.etag === 'string'
            && this.entries.some(entry => entry.etag === result.etag)
        if (!matchingEntry) {
            this.consecutiveEtagMismatches += 1
            if (this.consecutiveEtagMismatches >= MAX_ETAG_MISMATCHES) {
                this.replayAll('etag-diverged')
                return false
            }
            this.scheduleRetry()
            return false
        }

        this.confirmThroughEtag(result.etag as string)
        if (this.hasStaged() && this.timer === null) {
            this.schedule(this.confirmationDelayMs)
        }
        return !this.hasStaged()
    }

    private scheduleRetry(): void {
        const delayMs = Math.min(
            INITIAL_RETRY_DELAY_MS * (2 ** this.retryAttempt),
            MAX_RETRY_DELAY_MS,
        )
        this.retryAttempt += 1
        this.schedule(delayMs)
    }

    private schedule(delayMs: number): void {
        if (!this.hasStaged() || this.stopped) return
        this.cancelTimer()
        this.timer = this.setTimer?.(() => {
            this.timer = null
            void this.confirm()
        }, delayMs) ?? null
    }

    private cancelTimer(): void {
        if (this.timer === null) return
        this.clearTimer?.(this.timer)
        this.timer = null
    }

    private takeAllEntries(): SequencedStagedAckEntry[] {
        this.cancelTimer()
        const entries = this.entries
        this.entries = []
        return entries
    }

    private resetRetryState(): void {
        this.retryAttempt = 0
        this.consecutiveEtagMismatches = 0
    }
}
