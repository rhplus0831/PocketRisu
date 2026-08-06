import type { DatabaseSaveOutcome } from '../../storage/databaseSave'
import type { TerminalModelJob } from './jobFetch'
import { ownLiveTerminalModelJob, releaseLiveTerminalModelJob } from './liveModelJobOwnership'

/**
 * Collects terminal main-model jobs whose live response has been published to
 * chat state. The transport may finish before output processing does, so the
 * send owner releases these recovery records only after its final chat state
 * has crossed a committed database-save barrier.
 */
export class LiveModelJobFinalization {
    private readonly jobs = new Map<string, TerminalModelJob>()
    private finalized = false

    register(job: TerminalModelJob): void {
        if (this.finalized) return
        this.jobs.set(job.jobId, job)
        ownLiveTerminalModelJob(job.jobId)
    }

    hasTerminalJobs(): boolean {
        return this.jobs.size > 0
    }

    async finalizeAfterCommittedSave(
        save: () => Promise<DatabaseSaveOutcome>,
        clearPendingSend: () => Promise<boolean>,
    ): Promise<boolean> {
        if (this.finalized) return true
        if (this.jobs.size === 0) return false

        let outcome: DatabaseSaveOutcome
        try {
            outcome = await save()
        } catch (error) {
            console.warn('[ModelJob] live chat save barrier rejected; recovery records retained', error)
            return false
        }
        if (outcome.status !== 'committed') {
            console.warn('[ModelJob] live chat save was not committed; recovery records retained', outcome.status)
            return false
        }

        try {
            for (const job of this.jobs.values()) await job.claim()
            if (!await clearPendingSend()) return false
        } catch (error) {
            console.warn('[ModelJob] post-save recovery-record cleanup failed', error)
            return false
        }

        this.finalized = true
        this.releaseOwnership()
        return true
    }

    releaseOwnership(): void {
        for (const job of this.jobs.values()) releaseLiveTerminalModelJob(job.jobId)
    }
}
