import { StorageError } from './storageError'

export type SnapshotRestoreUiResult = 'committed' | 'not-committed' | 'commit-unknown'

export interface SnapshotRestoreUiDependencies {
    restore: (key: string, signal?: AbortSignal | null) => Promise<'committed'>
    onCommitted: () => void | Promise<void>
    onDefinitiveFailure: (error: unknown) => void | Promise<void>
    onCommitUnknown: (error: StorageError) => void | Promise<void>
    hardReload: () => void
}

/**
 * UI policy for the destructive internal-snapshot mutation. There is exactly
 * one restore call. A confirmed commit reloads into the new publication; a
 * confirmed rejection stays on the current page; an ambiguous outcome warns
 * the user and reloads solely to reconcile what the server actually committed.
 */
export async function runInternalSnapshotRestoreUi(
    key: string,
    dependencies: SnapshotRestoreUiDependencies,
    signal?: AbortSignal | null,
): Promise<SnapshotRestoreUiResult> {
    try {
        await dependencies.restore(key, signal)
    } catch (error) {
        if (error instanceof StorageError && error.commitOutcomeUnknown) {
            try {
                await dependencies.onCommitUnknown(error)
            } finally {
                dependencies.hardReload()
            }
            return 'commit-unknown'
        }
        await dependencies.onDefinitiveFailure(error)
        return 'not-committed'
    }

    // The authoritative commit has already happened. UI notification failures
    // cannot safely keep the stale in-memory database alive.
    try {
        await dependencies.onCommitted()
    } finally {
        dependencies.hardReload()
    }
    return 'committed'
}
