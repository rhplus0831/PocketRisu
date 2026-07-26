import { describe, expect, it, vi } from 'vitest'
import { StorageError } from './storageError'
import { runInternalSnapshotRestoreUi } from './snapshotRestoreUi'

const key = 'database/dbbackup-123.bin'

function dependencies(restore: () => Promise<'committed'>) {
    return {
        restore: vi.fn(restore),
        onCommitted: vi.fn(),
        onDefinitiveFailure: vi.fn(),
        onCommitUnknown: vi.fn(),
        hardReload: vi.fn(),
    }
}

describe('internal snapshot restore UI policy', () => {
    it('reloads only after a strict committed acknowledgement', async () => {
        const deps = dependencies(async () => 'committed')

        await expect(runInternalSnapshotRestoreUi(key, deps)).resolves.toBe('committed')

        expect(deps.restore).toHaveBeenCalledOnce()
        expect(deps.onCommitted).toHaveBeenCalledOnce()
        expect(deps.hardReload).toHaveBeenCalledOnce()
        expect(deps.onDefinitiveFailure).not.toHaveBeenCalled()
        expect(deps.onCommitUnknown).not.toHaveBeenCalled()
    })

    it('still reloads after commit if the success notification fails', async () => {
        const deps = dependencies(async () => 'committed')
        deps.onCommitted.mockRejectedValue(new Error('toast unavailable'))

        await expect(runInternalSnapshotRestoreUi(key, deps)).rejects.toThrow('toast unavailable')

        expect(deps.restore).toHaveBeenCalledOnce()
        expect(deps.hardReload).toHaveBeenCalledOnce()
        expect(deps.onDefinitiveFailure).not.toHaveBeenCalled()
    })

    it.each([
        new StorageError('rolled back', {
            status: 500,
            code: 'SNAPSHOT_RESTORE_NOT_COMMITTED',
            commitOutcomeUnknown: false,
            operation: 'transition',
        }),
        new StorageError('session displaced', {
            status: 423,
            code: 'HTTP_423',
            commitOutcomeUnknown: false,
            operation: 'transition',
        }),
    ])('stays on the page after definitive failure: $code', async (failure) => {
        const deps = dependencies(async () => { throw failure })

        await expect(runInternalSnapshotRestoreUi(key, deps)).resolves.toBe('not-committed')

        expect(deps.restore).toHaveBeenCalledOnce()
        expect(deps.onDefinitiveFailure).toHaveBeenCalledWith(failure)
        expect(deps.hardReload).not.toHaveBeenCalled()
        expect(deps.onCommitUnknown).not.toHaveBeenCalled()
    })

    it.each([
        'transport response loss',
        'proxy 2xx malformed body',
        'restore timeout after dispatch',
    ])('warns and hard-reloads to reconcile an unknown commit without retrying: %s', async (message) => {
        const failure = new StorageError(message, {
            code: 'COMMIT_OUTCOME_UNKNOWN',
            commitOutcomeUnknown: true,
            retryable: false,
            operation: 'transition',
        })
        const deps = dependencies(async () => { throw failure })

        await expect(runInternalSnapshotRestoreUi(key, deps)).resolves.toBe('commit-unknown')

        expect(deps.restore).toHaveBeenCalledOnce()
        expect(deps.onCommitUnknown).toHaveBeenCalledWith(failure)
        expect(deps.hardReload).toHaveBeenCalledOnce()
        expect(deps.onDefinitiveFailure).not.toHaveBeenCalled()
    })
})
