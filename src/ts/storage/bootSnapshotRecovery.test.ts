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
            restoreInternalSnapshot: vi.fn(async () => {
                throw new StorageError("connection closed after dispatch", {
                    code: "COMMIT_OUTCOME_UNKNOWN",
                    commitOutcomeUnknown: true,
                    operation: "transition",
                })
            }),
            readDatabaseForBoot: vi.fn(),
        }

        const decode = vi.fn(async (value: Uint8Array) => ({ candidate: value[0] }))
        await expect(recoverDatabaseFromInternalSnapshots({
            storage,
            decode,
        })).rejects.toMatchObject({
            code: "COMMIT_OUTCOME_UNKNOWN",
            commitOutcomeUnknown: true,
        })
        expect(storage.listInternalSnapshotsForBoot).toHaveBeenCalledTimes(1)
        expect(storage.restoreInternalSnapshot).toHaveBeenCalledTimes(1)
        expect(storage.readDatabaseForBoot).not.toHaveBeenCalled()
        expect(decode).not.toHaveBeenCalled()
    })

    it("does not replay an older snapshot after a committed candidate cannot be read back", async () => {
        const storage = {
            listInternalSnapshotsForBoot: vi.fn(async () => [snapshot(20_000), snapshot(10_000)]),
            restoreInternalSnapshot: vi.fn(async () => "committed" as const),
            readDatabaseForBoot: vi.fn(async () => {
                throw new Error("read-back failed")
            }),
        }

        const decode = vi.fn(async (value: Uint8Array) => ({ candidate: value[0] }))
        await expect(recoverDatabaseFromInternalSnapshots({
            storage,
            decode,
        })).rejects.toThrow("read-back failed")
        expect(storage.listInternalSnapshotsForBoot).toHaveBeenCalledTimes(1)
        expect(storage.restoreInternalSnapshot).toHaveBeenCalledTimes(1)
        expect(storage.readDatabaseForBoot).toHaveBeenCalledTimes(1)
        expect(decode).not.toHaveBeenCalled()
    })

    it.each([
        ["decoded-size limit", "RISU_SAVE_DECODED_TOO_LARGE", 413],
        ["definitive corruption", "RISU_SAVE_INVALID", 400],
    ])("may continue after a known not-committed %s", async (_label, code, status) => {
        const storage = {
            listInternalSnapshotsForBoot: vi.fn(async () => [snapshot(20_000), snapshot(10_000)]),
            restoreInternalSnapshot: vi.fn()
                .mockRejectedValueOnce(new StorageError("rolled back", {
                    code,
                    status,
                    commitOutcome: "not-committed",
                    commitOutcomeUnknown: false,
                    operation: "transition",
                }))
                .mockResolvedValueOnce("committed"),
            readDatabaseForBoot: vi.fn(async () => ({
                kind: "decoded" as const,
                database: { candidate: "older-committed" },
            })),
        }

        const decode = vi.fn(async (value: Uint8Array) => ({ candidate: value[0] }))
        await expect(recoverDatabaseFromInternalSnapshots({
            storage,
            decode,
        })).resolves.toEqual({ candidate: "older-committed" })
        expect(storage.restoreInternalSnapshot).toHaveBeenNthCalledWith(
            1,
            "database/dbbackup-200.bin",
        )
        expect(storage.restoreInternalSnapshot).toHaveBeenNthCalledWith(
            2,
            "database/dbbackup-100.bin",
        )
        expect(storage.restoreInternalSnapshot).toHaveBeenCalledTimes(2)
        expect(decode).not.toHaveBeenCalled()
    })

    it.each([
        ["a non-storage failure", new Error("unclassified restore failure")],
        ["an unclassified storage failure", new StorageError("unclassified restore failure", {
            code: "HTTP_400",
            commitOutcomeUnknown: false,
            operation: "transition",
        })],
    ])("stops after %s instead of trying an older candidate", async (_label, failure) => {
        const storage = {
            listInternalSnapshotsForBoot: vi.fn(async () => [snapshot(20_000), snapshot(10_000)]),
            restoreInternalSnapshot: vi.fn()
                .mockRejectedValueOnce(failure)
                .mockResolvedValueOnce("committed" as const),
            readDatabaseForBoot: vi.fn(),
        }

        await expect(recoverDatabaseFromInternalSnapshots({
            storage,
            decode: vi.fn(),
        })).rejects.toThrow("unclassified restore failure")
        expect(storage.restoreInternalSnapshot).toHaveBeenCalledTimes(1)
        expect(storage.readDatabaseForBoot).not.toHaveBeenCalled()
    })

    it("never reads or decodes a candidate body before server validation", async () => {
        const storage = {
            listInternalSnapshotsForBoot: vi.fn(async () => [snapshot(20_000), snapshot(10_000)]),
            restoreInternalSnapshot: vi.fn()
                .mockRejectedValueOnce(new StorageError("invalid candidate", {
                    code: "RISU_SAVE_INVALID",
                    commitOutcome: "not-committed",
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

        expect(storage.restoreInternalSnapshot.mock.calls).toEqual([
            ["database/dbbackup-200.bin"],
            ["database/dbbackup-100.bin"],
        ])
        expect(storage.readDatabaseForBoot).toHaveBeenCalledOnce()
        expect(decode).toHaveBeenCalledOnce()
        expect(decode).toHaveBeenCalledWith(bytes(7))
    })
})
