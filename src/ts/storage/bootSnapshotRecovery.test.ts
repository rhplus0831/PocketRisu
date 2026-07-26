import { describe, expect, it, vi } from "vitest"
import { recoverDatabaseFromInternalSnapshots } from "./bootSnapshotRecovery"
import { StorageError } from "./storageError"

function bytes(value: number): Uint8Array {
    return new Uint8Array([value])
}

function snapshot(timestamp: number) {
    return {
        key: `database/dbbackup-${timestamp / 100}.bin`,
        size: timestamp,
        timestamp,
    }
}

describe("boot internal snapshot selection", () => {
    it("does not replay an older snapshot when the restore acknowledgement is lost", async () => {
        const storage = {
            listInternalSnapshotsForBoot: vi.fn(async () => [snapshot(20_000), snapshot(10_000)]),
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
            storage,
            decode: vi.fn(async (value) => ({ candidate: value[0] })),
        })).rejects.toMatchObject({
            code: "COMMIT_OUTCOME_UNKNOWN",
            commitOutcomeUnknown: true,
        })
        expect(storage.listInternalSnapshotsForBoot).toHaveBeenCalledTimes(1)
        expect(storage.restoreInternalSnapshotForBoot).toHaveBeenCalledTimes(1)
        expect(storage.readDatabaseForBoot).not.toHaveBeenCalled()
    })

    it("does not replay an older snapshot after a committed candidate cannot be read back", async () => {
        const storage = {
            listInternalSnapshotsForBoot: vi.fn(async () => [snapshot(20_000), snapshot(10_000)]),
            restoreInternalSnapshotForBoot: vi.fn(async () => "committed" as const),
            readDatabaseForBoot: vi.fn(async () => {
                throw new Error("read-back failed")
            }),
        }

        await expect(recoverDatabaseFromInternalSnapshots({
            storage,
            decode: vi.fn(async (value) => ({ candidate: value[0] })),
        })).rejects.toThrow("read-back failed")
        expect(storage.listInternalSnapshotsForBoot).toHaveBeenCalledTimes(1)
        expect(storage.restoreInternalSnapshotForBoot).toHaveBeenCalledTimes(1)
        expect(storage.readDatabaseForBoot).toHaveBeenCalledTimes(1)
    })

    it("may continue after a known not-committed failure", async () => {
        const storage = {
            listInternalSnapshotsForBoot: vi.fn(async () => [snapshot(20_000), snapshot(10_000)]),
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
            storage,
            decode: vi.fn(async (value) => ({ candidate: value[0] })),
        })).resolves.toEqual({ candidate: "older-committed" })
        expect(storage.restoreInternalSnapshotForBoot).toHaveBeenCalledTimes(2)
    })

    it("never reads or decodes a candidate body before server validation", async () => {
        const storage = {
            listInternalSnapshotsForBoot: vi.fn(async () => [snapshot(20_000), snapshot(10_000)]),
            restoreInternalSnapshotForBoot: vi.fn()
                .mockRejectedValueOnce(new StorageError("invalid candidate", {
                    code: "INVALID_DATABASE",
                    commitOutcomeUnknown: false,
                    operation: "transition",
                }))
                .mockResolvedValueOnce("committed"),
            readDatabaseForBoot: vi.fn(async () => ({
                kind: "bytes" as const,
                bytes: bytes(7),
            })),
        }
        const decode = vi.fn(async (value: Uint8Array) => ({ live: value[0] }))

        await expect(recoverDatabaseFromInternalSnapshots({
            storage,
            decode,
        })).resolves.toEqual({ live: 7 })

        expect(storage.restoreInternalSnapshotForBoot.mock.calls).toEqual([
            ["database/dbbackup-200.bin"],
            ["database/dbbackup-100.bin"],
        ])
        expect(storage.readDatabaseForBoot).toHaveBeenCalledOnce()
        expect(decode).toHaveBeenCalledOnce()
        expect(decode).toHaveBeenCalledWith(bytes(7))
    })
})
