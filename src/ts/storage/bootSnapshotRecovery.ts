import { StorageError } from "./storageError"

export type BootSnapshotDatabaseRead =
    | { kind: "bytes"; bytes: Uint8Array | null }
    | { kind: "decoded"; database: unknown }

export interface BootInternalSnapshot {
    key: string
    /** null means the server could not determine this publication's logical size. */
    size: number | null
    timestamp: number
}

export interface BootSnapshotRecoveryStorage {
    listInternalSnapshotsForBoot(): Promise<BootInternalSnapshot[]>
    restoreInternalSnapshot(key: string): Promise<"committed">
    readDatabaseForBoot(): Promise<BootSnapshotDatabaseRead>
}

export interface BootSnapshotRecoveryOptions<T> {
    storage: BootSnapshotRecoveryStorage
    decode: (bytes: Uint8Array) => Promise<T>
    onStatus?: (status: string) => void
}

/**
 * Ask the authoritative server to validate and publish each internal snapshot
 * through its atomic restore boundary. The browser must not fetch/decompress a
 * folded candidate first: doing so would duplicate the repository in memory
 * and bypass the server's decoded-size and disk-headroom limits. Discovery is
 * metadata-only, and folded candidate bodies never cross the browser boundary.
 * Known pre-commit failures may try an older candidate. A lost acknowledgement,
 * or any failure after a confirmed commit, must stop immediately so a possibly
 * committed recovery point is never overwritten by blind fallback.
 */
export async function recoverDatabaseFromInternalSnapshots<T>({
    storage,
    decode,
    onStatus = () => undefined,
}: BootSnapshotRecoveryOptions<T>): Promise<T | null> {
    const snapshots = await storage.listInternalSnapshotsForBoot()
    for (const snapshot of snapshots) {
        let candidateCommitted = false
        try {
            onStatus(`Restoring Backup File ${snapshot.timestamp}...`)
            await storage.restoreInternalSnapshot(snapshot.key)
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
            if (candidateCommitted
                || !(error instanceof StorageError)
                || error.commitOutcomeUnknown
                || error.commitOutcome !== "not-committed") {
                throw error
            }
        }
    }
    return null
}
