import { afterEach, describe, expect, test, vi } from 'vitest'
import { LiveModelJobFinalization } from './liveModelJobFinalization'
import { resetLiveModelJobOwnershipForTest } from './liveModelJobOwnership'

function terminal(jobId: string, events: string[]) {
    return {
        jobId,
        status: 'done' as const,
        claim: vi.fn(async () => { events.push(`claim:${jobId}`) }),
    }
}

afterEach(() => {
    resetLiveModelJobOwnershipForTest()
    vi.restoreAllMocks()
})

describe('LiveModelJobFinalization', () => {
    test('claims and deletes the tombstone only after the save commits', async () => {
        const events: string[] = []
        let releaseSave!: (outcome: { status: 'committed' }) => void
        const save = vi.fn(() => new Promise<{ status: 'committed' }>((resolve) => {
            events.push('save:start')
            releaseSave = resolve
        }))
        const clear = vi.fn(async () => { events.push('tombstone:delete'); return true })
        const finalization = new LiveModelJobFinalization()
        const job = terminal('job-1', events)
        finalization.register(job)

        const pending = finalization.finalizeAfterCommittedSave(save, clear)
        await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1))
        expect(job.claim).not.toHaveBeenCalled()
        expect(clear).not.toHaveBeenCalled()

        releaseSave({ status: 'committed' })
        await expect(pending).resolves.toBe(true)
        expect(events).toEqual(['save:start', 'claim:job-1', 'tombstone:delete'])
    })

    test.each([
        { status: 'retry' as const },
        { status: 'failed' as const, error: new Error('disk full') },
        { status: 'displaced' as const },
    ])('retains both recovery artifacts after a $status save', async (outcome) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        const events: string[] = []
        const finalization = new LiveModelJobFinalization()
        const job = terminal('job-1', events)
        const clear = vi.fn(async () => true)
        finalization.register(job)

        await expect(finalization.finalizeAfterCommittedSave(
            async () => outcome,
            clear,
        )).resolves.toBe(false)
        expect(job.claim).not.toHaveBeenCalled()
        expect(clear).not.toHaveBeenCalled()
    })

    test('post-commit finalization runs once', async () => {
        const events: string[] = []
        const finalization = new LiveModelJobFinalization()
        const first = terminal('job-1', events)
        const second = terminal('job-2', events)
        const save = vi.fn(async () => ({ status: 'committed' as const }))
        const clear = vi.fn(async () => true)
        finalization.register(first)
        finalization.register(second)

        await expect(finalization.finalizeAfterCommittedSave(save, clear)).resolves.toBe(true)
        await expect(finalization.finalizeAfterCommittedSave(save, clear)).resolves.toBe(true)

        expect(save).toHaveBeenCalledTimes(1)
        expect(first.claim).toHaveBeenCalledTimes(1)
        expect(second.claim).toHaveBeenCalledTimes(1)
        expect(clear).toHaveBeenCalledTimes(1)
    })
})
