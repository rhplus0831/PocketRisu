import { describe, expect, it, vi } from "vitest"
import { recoverDatabaseFromInternalSnapshots } from "./bootSnapshotRecovery"
import { StorageError } from "./storageError"

function bytes(value: number): Uint8Array {
    return new Uint8Array([value])
}

describe("boot internal snapshot selection", () => {
    it("does not replay an older snapshot when the restore acknowledgement is lost", async () => {
        const storage = {
            getItem: vi.fn(async (key: string) => key.includes("200") ? bytes(2) : bytes(1)),
            restoreInternalSnapshotForBoot: vi.fn(async () => {
                throw new StorageError("connection closed after dispatch", {
                    code: "COMMIT_OUTCOME_UNKNOWN",
                    commitOutcomeUnknown: true,
                    operation: "transition",
                })
            }),
            readDatabaseForBoot: vi.fn(),
        }

        await expect(recoverDatabaseFromInternalSnapshots({
            backups: [200, 100],
            storage,
            decode: vi.fn(async (value) => ({ candidate: value[0] })),
        })).rejects.toMatchObject({
            code: "COMMIT_OUTCOME_UNKNOWN",
            commitOutcomeUnknown: true,
        })
        expect(storage.getItem).toHaveBeenCalledTimes(1)
        expect(storage.restoreInternalSnapshotForBoot).toHaveBeenCalledTimes(1)
        expect(storage.readDatabaseForBoot).not.toHaveBeenCalled()
    })

    it("does not replay an older snapshot after a committed candidate cannot be read back", async () => {
        const storage = {
            getItem: vi.fn(async () => bytes(2)),
            restoreInternalSnapshotForBoot: vi.fn(async () => "committed" as const),
            readDatabaseForBoot: vi.fn(async () => {
                throw new Error("read-back failed")
            }),
        }

        await expect(recoverDatabaseFromInternalSnapshots({
            backups: [200, 100],
            storage,
            decode: vi.fn(async (value) => ({ candidate: value[0] })),
        })).rejects.toThrow("read-back failed")
        expect(storage.getItem).toHaveBeenCalledTimes(1)
        expect(storage.restoreInternalSnapshotForBoot).toHaveBeenCalledTimes(1)
        expect(storage.readDatabaseForBoot).toHaveBeenCalledTimes(1)
    })

    it("may continue after a known not-committed failure", async () => {
        const storage = {
            getItem: vi.fn(async (key: string) => key.includes("200") ? bytes(2) : bytes(1)),
            restoreInternalSnapshotForBoot: vi.fn()
                .mockRejectedValueOnce(new StorageError("rolled back", {
                    code: "SNAPSHOT_RESTORE_NOT_COMMITTED",
                    commitOutcomeUnknown: false,
                    operation: "transition",
                }))
                .mockResolvedValueOnce("committed"),
            readDatabaseForBoot: vi.fn(async () => ({
                kind: "decoded" as const,
                database: { candidate: "older-committed" },
            })),
        }

        await expect(recoverDatabaseFromInternalSnapshots({
            backups: [200, 100],
            storage,
            decode: vi.fn(async (value) => ({ candidate: value[0] })),
        })).resolves.toEqual({ candidate: "older-committed" })
        expect(storage.restoreInternalSnapshotForBoot).toHaveBeenCalledTimes(2)
    })
})
