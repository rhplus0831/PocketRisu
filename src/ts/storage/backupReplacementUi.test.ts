import { describe, expect, it, vi } from 'vitest'
import { runBackupReplacementUi } from './backupReplacementUi'
import { StorageError } from './storageError'

function dependencies(replace: () => Promise<{ ok: true }>) {
    return {
        replace: vi.fn(replace),
        onCommitted: vi.fn(),
        onCommittedFailure: vi.fn(),
        onDefinitiveFailure: vi.fn(),
        onCommitUnknown: vi.fn(),
        hardReload: vi.fn(),
    }
}

describe('backup replacement UI policy', () => {
    it('reloads after one confirmed replacement request', async () => {
        const result = { ok: true as const }
        const deps = dependencies(async () => result)

        await expect(runBackupReplacementUi(deps)).resolves.toBe('committed')

        expect(deps.replace).toHaveBeenCalledOnce()
        expect(deps.onCommitted).toHaveBeenCalledWith(result)
        expect(deps.hardReload).toHaveBeenCalledOnce()
        expect(deps.onCommitUnknown).not.toHaveBeenCalled()
        expect(deps.onCommittedFailure).not.toHaveBeenCalled()
        expect(deps.onDefinitiveFailure).not.toHaveBeenCalled()
    })

    it('warns and reloads authoritative state without replaying an unknown outcome', async () => {
        const failure = new StorageError('terminal response lost', {
            code: 'COMMIT_OUTCOME_UNKNOWN',
            retryable: false,
            commitOutcome: 'unknown',
            commitOutcomeUnknown: true,
            operation: 'write',
        })
        const deps = dependencies(async () => { throw failure })

        await expect(runBackupReplacementUi(deps)).resolves.toBe('commit-unknown')

        expect(deps.replace).toHaveBeenCalledOnce()
        expect(deps.onCommitUnknown).toHaveBeenCalledWith(failure)
        expect(deps.hardReload).toHaveBeenCalledOnce()
        expect(deps.onCommitted).not.toHaveBeenCalled()
        expect(deps.onCommittedFailure).not.toHaveBeenCalled()
        expect(deps.onDefinitiveFailure).not.toHaveBeenCalled()
    })

    it.each([
        'local upload',
        'server-file restore',
    ])('warns and reloads after one exact committed-error response for %s', async () => {
        const failure = new StorageError('committed but cleanup reported an error', {
            status: 500,
            code: 'BACKUP_IMPORT_COMMITTED_WITH_ERROR',
            retryable: false,
            commitOutcome: 'committed',
            commitOutcomeUnknown: false,
            operation: 'write',
        })
        const deps = dependencies(async () => { throw failure })

        await expect(runBackupReplacementUi(deps)).resolves.toBe('committed-with-error')

        expect(deps.replace).toHaveBeenCalledOnce()
        expect(deps.onCommittedFailure).toHaveBeenCalledWith(failure)
        expect(deps.hardReload).toHaveBeenCalledOnce()
        expect(deps.onCommitted).not.toHaveBeenCalled()
        expect(deps.onCommitUnknown).not.toHaveBeenCalled()
        expect(deps.onDefinitiveFailure).not.toHaveBeenCalled()
    })

    it('does not reload or replay a definitive not-committed failure', async () => {
        const failure = new StorageError('rolled back', {
            status: 500,
            code: 'BACKUP_IMPORT_NOT_COMMITTED',
            retryable: true,
            commitOutcome: 'not-committed',
            commitOutcomeUnknown: false,
            operation: 'write',
        })
        const deps = dependencies(async () => { throw failure })

        await expect(runBackupReplacementUi(deps)).resolves.toBe('not-committed')

        expect(deps.replace).toHaveBeenCalledOnce()
        expect(deps.onDefinitiveFailure).toHaveBeenCalledWith(failure)
        expect(deps.hardReload).not.toHaveBeenCalled()
        expect(deps.onCommitUnknown).not.toHaveBeenCalled()
        expect(deps.onCommittedFailure).not.toHaveBeenCalled()
        expect(deps.onCommitted).not.toHaveBeenCalled()
    })
})
