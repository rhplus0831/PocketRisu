import { StorageError } from "./storageError"

export type BootSnapshotDatabaseRead =
    | { kind: "bytes"; bytes: Uint8Array | null }
    | { kind: "decoded"; database: unknown }

export interface BootSnapshotRecoveryStorage {
    getItem(key: string): Promise<Uint8Array>
    restoreInternalSnapshotForBoot(key: string): Promise<"committed">
    readDatabaseForBoot(): Promise<BootSnapshotDatabaseRead>
}

export interface BootSnapshotRecoveryOptions<T> {
    backups: readonly number[]
    storage: BootSnapshotRecoveryStorage
    decode: (bytes: Uint8Array) => Promise<T>
    onStatus?: (status: string) => void
}

/**
 * Select the first decodable internal snapshot and publish it through the
 * server's atomic restore boundary. Known pre-commit failures may try an older
 * candidate. A lost acknowledgement, or any failure after a confirmed commit,
 * must stop immediately so a possibly committed recovery point is never
 * overwritten by blind fallback.
 */
export async function recoverDatabaseFromInternalSnapshots<T>({
    backups,
    storage,
    decode,
    onStatus = () => undefined,
}: BootSnapshotRecoveryOptions<T>): Promise<T | null> {
    for (const backup of backups) {
        let candidateCommitted = false
        try {
            const backupKey = `database/dbbackup-${backup}.bin`
            onStatus(`Reading Backup File ${backup}...`)
            const backupData = await storage.getItem(backupKey)
            // Validate the candidate before it can replace live state. The
            // server repeats strict plugin/chat checks inside the transaction.
            await decode(backupData)
            onStatus(`Restoring Backup File ${backup}...`)
            await storage.restoreInternalSnapshotForBoot(backupKey)
            candidateCommitted = true

            // Install only the committed stripped publication read back from
            // the server, never the folded ingest-only snapshot object.
            const restoredRead = await storage.readDatabaseForBoot()
            if (restoredRead.kind === "bytes") {
                if (!restoredRead.bytes) throw new Error("Restored database is missing")
                return await decode(restoredRead.bytes)
            }
            return restoredRead.database as T
        } catch (error) {
            if (
                candidateCommitted
                || (error instanceof StorageError && error.commitOutcomeUnknown)
            ) {
                throw error
            }
        }
    }
    return null
}
