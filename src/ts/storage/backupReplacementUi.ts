import { StorageError } from './storageError'

export type BackupReplacementUiResult = 'committed' | 'not-committed' | 'commit-unknown'

export interface BackupReplacementUiDependencies<T> {
    replace: () => Promise<T>
    onCommitted: (result: T) => void | Promise<void>
    onDefinitiveFailure: (error: unknown) => void | Promise<void>
    onCommitUnknown: (error: StorageError) => void | Promise<void>
    hardReload: () => void
}

/**
 * One-call UI policy for full-database backup replacement. An ambiguous
 * acknowledgement is never replayed: the stale browser state is discarded by
 * a hard reload so the next boot observes the authoritative server publication.
 */
export async function runBackupReplacementUi<T>(
    dependencies: BackupReplacementUiDependencies<T>,
): Promise<BackupReplacementUiResult> {
    let result: T
    try {
        result = await dependencies.replace()
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

    try {
        await dependencies.onCommitted(result)
    } finally {
        dependencies.hardReload()
    }
    return 'committed'
}
