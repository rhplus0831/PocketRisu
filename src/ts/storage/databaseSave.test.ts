import { describe, expect, test, vi } from "vitest";
import {
    beginDatabaseSavePause,
    DatabaseSaveCoordinator,
    requireCommittedDatabaseSave,
    type DatabaseSaveOutcome,
} from "./databaseSave";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe("DatabaseSaveCoordinator", () => {
    test("holds ordinary saves until a staged publication resumes them", async () => {
        const coordinator = new DatabaseSaveCoordinator();
        const resume = beginDatabaseSavePause();
        const writer = vi.fn(async () => ({ status: "committed" }) as const);
        const result = coordinator.run(writer);

        await Promise.resolve();
        expect(writer).not.toHaveBeenCalled();
        resume();

        await expect(result).resolves.toEqual({ status: "committed" });
        expect(writer).toHaveBeenCalledOnce();
    });

    test("queues a durability-sensitive save behind an ordinary in-flight save", async () => {
        const coordinator = new DatabaseSaveCoordinator();
        const first = deferred<DatabaseSaveOutcome>();
        const ordinarySave = vi.fn(async () => first.promise);
        const forcedSave = vi.fn(async () => ({ status: "committed" }) as const);

        const ordinaryResult = coordinator.run(ordinarySave);
        await vi.waitFor(() => expect(ordinarySave).toHaveBeenCalledTimes(1));

        const forcedResult = coordinator.run(forcedSave, { queueAfterInFlight: true });
        await Promise.resolve();
        expect(forcedSave).not.toHaveBeenCalled();

        first.resolve({ status: "committed" });
        await expect(ordinaryResult).resolves.toEqual({ status: "committed" });
        await expect(forcedResult).resolves.toEqual({ status: "committed" });
        expect(forcedSave).toHaveBeenCalledTimes(1);
    });

    test("still runs the follow-up save when the active save rejects", async () => {
        const coordinator = new DatabaseSaveCoordinator();
        const first = deferred<DatabaseSaveOutcome>();
        const ordinaryResult = coordinator.run(async () => first.promise);
        const forcedSave = vi.fn(async () => ({ status: "committed" }) as const);
        const forcedResult = coordinator.run(forcedSave, { queueAfterInFlight: true });

        first.reject(new Error("ordinary save crashed"));
        await expect(ordinaryResult).rejects.toThrow("ordinary save crashed");
        await expect(forcedResult).resolves.toEqual({ status: "committed" });
        expect(forcedSave).toHaveBeenCalledTimes(1);
    });

    test("ordinary callers share the active save without starting another", async () => {
        const coordinator = new DatabaseSaveCoordinator();
        const first = deferred<DatabaseSaveOutcome>();
        const firstSave = vi.fn(async () => first.promise);
        const joinedSave = vi.fn(async () => ({ status: "committed" }) as const);

        const firstResult = coordinator.run(firstSave);
        await vi.waitFor(() => expect(firstSave).toHaveBeenCalledTimes(1));
        const joinedResult = coordinator.run(joinedSave);
        first.resolve({ status: "retry" });

        await expect(firstResult).resolves.toEqual({ status: "retry" });
        await expect(joinedResult).resolves.toEqual({ status: "retry" });
        expect(joinedSave).not.toHaveBeenCalled();
    });
});

describe("requireCommittedDatabaseSave", () => {
    test.each([
        { status: "retry" } as const,
        { status: "displaced" } as const,
        { status: "failed", error: new Error("write rejected") } as const,
    ])("rejects a non-commit outcome: $status", (outcome) => {
        expect(() => requireCommittedDatabaseSave(outcome, "Plugin storage transition"))
            .toThrow(/not durably committed/);
    });

    test("accepts only a committed outcome", () => {
        expect(() => requireCommittedDatabaseSave(
            { status: "committed" },
            "Plugin storage transition",
        )).not.toThrow();
    });
});
