import { describe, expect, test, vi } from "vitest";
import {
    PluginStorageUpdateCoordinator,
    type PluginStorageUpdateDependencies,
} from "./pluginStorageUpdate";

const revision = (letter: string) => `sha256:${letter.repeat(64)}`;

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>(res => { resolve = res; });
    return { promise, resolve };
}

describe("PluginStorageUpdateCoordinator", () => {
    test("has no default elapsed-time deadline", async () => {
        vi.useFakeTimers();
        try {
            const transformStarted = deferred();
            const releaseTransform = deferred();
            let transformSignal: AbortSignal | undefined;
            const atomicSet = vi.fn(async () => ({
                committed: true as const,
                generation: "published",
                revisions: [{ key: "settings", revision: revision("b") }],
            }));
            const coordinator = new PluginStorageUpdateCoordinator({
                read: vi.fn(async () => ({
                    status: "value" as const,
                    value: { schema: 1 },
                    revision: revision("a"),
                    generation: null,
                })),
                atomicSet,
            });
            let settled = false;
            const update = coordinator.updateItem("settings", async (current, signal) => {
                transformSignal = signal;
                transformStarted.resolve();
                await releaseTransform.promise;
                return { ...(current.value as object), schema: 2 };
            }, undefined).finally(() => { settled = true; });
            await transformStarted.promise;

            await vi.advanceTimersByTimeAsync(30 * 60_000 + 1);
            expect(settled).toBe(false);
            expect(transformSignal?.aborted).toBe(false);
            expect(atomicSet).not.toHaveBeenCalled();

            releaseTransform.resolve();
            await expect(update).resolves.toMatchObject({ committed: true });
            expect(atomicSet).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    test("returns the newer revision without publishing a stale transform", async () => {
        let state = {
            status: "value" as const,
            value: { schema: 1, source: "old" },
            revision: revision("a"),
            generation: "old-generation",
        };
        const transformStarted = deferred();
        const releaseTransform = deferred();
        const atomicSet = vi.fn<PluginStorageUpdateDependencies["atomicSet"]>();
        const coordinator = new PluginStorageUpdateCoordinator({
            read: vi.fn(async () => structuredClone(state)),
            atomicSet,
        });

        const update = coordinator.updateItem("settings", async current => {
            transformStarted.resolve();
            await releaseTransform.promise;
            return { ...(current.value as object), schema: 2 };
        }, { timeoutMs: 1_000 });
        await transformStarted.promise;

        state = {
            status: "value",
            value: { schema: 3, source: "newer" },
            revision: revision("b"),
            generation: "newer-generation",
        };
        releaseTransform.resolve();

        await expect(update).resolves.toEqual({
            committed: false,
            conflicts: [{
                key: "settings",
                revision: revision("b"),
                generation: "newer-generation",
            }],
        });
        expect(atomicSet).not.toHaveBeenCalled();
        expect(state.value).toEqual({ schema: 3, source: "newer" });
    });

    test("holds later plugin writers for the complete transform and CAS interval", async () => {
        const transformStarted = deferred();
        const releaseTransform = deferred();
        const releaseCas = deferred();
        const casStarted = deferred();
        const writer = vi.fn(async () => undefined);
        const coordinator = new PluginStorageUpdateCoordinator({
            read: vi.fn(async () => ({
                status: "value" as const,
                value: { schema: 1 },
                revision: revision("a"),
                generation: null,
            })),
            atomicSet: vi.fn(async () => {
                casStarted.resolve();
                await releaseCas.promise;
                return {
                    committed: true as const,
                    generation: "published",
                    revisions: [{ key: "settings", revision: revision("b") }],
                };
            }),
        });

        const update = coordinator.updateItem("settings", async current => {
            transformStarted.resolve();
            await releaseTransform.promise;
            return { ...(current.value as object), schema: 2 };
        }, { timeoutMs: 1_000 });
        await transformStarted.promise;
        const laterWriter = coordinator.runWriter(writer);
        await Promise.resolve();
        expect(writer).not.toHaveBeenCalled();

        releaseTransform.resolve();
        await casStarted.promise;
        expect(writer).not.toHaveBeenCalled();
        releaseCas.resolve();

        await expect(update).resolves.toMatchObject({ committed: true });
        await laterWriter;
        expect(writer).toHaveBeenCalledOnce();
    });

    test("aborts one total deadline and never submits a late SET", async () => {
        vi.useFakeTimers();
        try {
            const transformStarted = deferred();
            const releaseTransform = deferred();
            const atomicSet = vi.fn<PluginStorageUpdateDependencies["atomicSet"]>();
            const coordinator = new PluginStorageUpdateCoordinator({
                read: vi.fn(async () => ({
                    status: "value" as const,
                    value: { schema: 1 },
                    revision: revision("a"),
                    generation: null,
                })),
                atomicSet,
            });

            const update = coordinator.updateItem("settings", async (_current, signal) => {
                transformStarted.resolve();
                await releaseTransform.promise;
                expect(signal.aborted).toBe(true);
                return { schema: 2 };
            }, { timeoutMs: 25 });
            const outcome = update.catch(error => error);
            await transformStarted.promise;
            await vi.advanceTimersByTimeAsync(25);

            await expect(outcome).resolves.toMatchObject({
                name: "StorageError",
                code: "STORAGE_TIMEOUT",
                operation: "update",
                commitOutcomeUnknown: false,
            });
            releaseTransform.resolve();
            await vi.advanceTimersByTimeAsync(0);
            expect(atomicSet).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    test("surfaces a CAS conflict that races the final revision re-read", async () => {
        const newer = {
            status: "value" as const,
            value: { schema: 3, source: "newer" },
            revision: revision("b"),
            generation: "newer-generation",
        };
        const atomicSet = vi.fn(async () => ({
            committed: false as const,
            conflicts: [{
                key: "settings",
                revision: newer.revision,
                generation: newer.generation,
            }],
        }));
        const coordinator = new PluginStorageUpdateCoordinator({
            read: vi.fn(async () => ({
                status: "value" as const,
                value: { schema: 1 },
                revision: revision("a"),
                generation: "old-generation",
            })),
            atomicSet,
        });

        const result = await coordinator.updateItem(
            "settings",
            current => ({ ...(current.value as object), schema: 2 }),
            { timeoutMs: 1_000 },
        );

        expect(result).toEqual({ committed: false, conflicts: [{
            key: "settings",
            revision: newer.revision,
            generation: newer.generation,
        }] });
        expect(atomicSet).toHaveBeenCalledWith(
            "settings",
            { schema: 2 },
            revision("a"),
            undefined,
        );
    });

    test("a queued migration fairly blocks writers that arrived after it", async () => {
        const releaseFirstWriter = deferred();
        const migrationStarted = deferred();
        const releaseMigration = deferred();
        const laterWriter = vi.fn(async () => undefined);
        const coordinator = new PluginStorageUpdateCoordinator({
            read: vi.fn(async () => ({
                status: "missing" as const,
                value: null,
                revision: null,
                generation: null,
            })),
            atomicSet: vi.fn(async () => ({
                committed: true as const,
                generation: "published",
                revisions: [{ key: "settings", revision: revision("a") }],
            })),
        });
        const firstWriter = coordinator.runWriter(() => releaseFirstWriter.promise);
        const migration = coordinator.updateItem("settings", async () => {
            migrationStarted.resolve();
            await releaseMigration.promise;
            return { schema: 1 };
        }, { timeoutMs: 1_000 });
        const queuedWriter = coordinator.runWriter(laterWriter);

        await Promise.resolve();
        expect(laterWriter).not.toHaveBeenCalled();
        releaseFirstWriter.resolve();
        await firstWriter;
        await migrationStarted.promise;
        expect(laterWriter).not.toHaveBeenCalled();

        releaseMigration.resolve();
        await migration;
        await queuedWriter;
        expect(laterWriter).toHaveBeenCalledOnce();
    });

    test.each(["mutex", "initial-read", "final-read"] as const)(
        "deadline at %s is known not committed and never submits CAS",
        async phase => {
            vi.useFakeTimers();
            try {
                const release = deferred();
                let reads = 0;
                const atomicSet = vi.fn<PluginStorageUpdateDependencies["atomicSet"]>();
                const coordinator = new PluginStorageUpdateCoordinator({
                    read: vi.fn(async () => {
                        reads += 1;
                        if ((phase === "initial-read" && reads === 1)
                            || (phase === "final-read" && reads === 2)) {
                            await release.promise;
                        }
                        return {
                            status: "value" as const,
                            value: { schema: 1 },
                            revision: revision("a"),
                            generation: null,
                        };
                    }),
                    atomicSet,
                });
                const activeWriter = phase === "mutex"
                    ? coordinator.runWriter(() => release.promise)
                    : null;
                const update = coordinator.updateItem(
                    "settings",
                    current => ({ ...(current.value as object), schema: 2 }),
                    { timeoutMs: 25 },
                );
                const outcome = update.catch(error => error);

                await vi.advanceTimersByTimeAsync(25);
                await expect(outcome).resolves.toMatchObject({
                    code: "STORAGE_TIMEOUT",
                    operation: "update",
                    commitOutcomeUnknown: false,
                });
                expect(atomicSet).not.toHaveBeenCalled();
                release.resolve();
                await activeWriter;
                await vi.advanceTimersByTimeAsync(0);
                expect(atomicSet).not.toHaveBeenCalled();
            } finally {
                vi.useRealTimers();
            }
        },
    );

    test("deadline during CAS is ambiguous and drains the possible commit", async () => {
        vi.useFakeTimers();
        try {
            const casStarted = deferred();
            const releaseAcknowledgement = deferred();
            const writer = vi.fn(async () => undefined);
            let durableValue: unknown = { schema: 1 };
            const coordinator = new PluginStorageUpdateCoordinator({
                read: vi.fn(async () => ({
                    status: "value" as const,
                    value: durableValue,
                    revision: revision("a"),
                    generation: null,
                })),
                atomicSet: vi.fn(async (_key, value) => {
                    // The server commits before the acknowledgement becomes
                    // observable to the caller.
                    durableValue = value;
                    casStarted.resolve();
                    await releaseAcknowledgement.promise;
                    return {
                        committed: true as const,
                        generation: "published",
                        revisions: [{ key: "settings", revision: revision("b") }],
                    };
                }),
            });
            const update = coordinator.updateItem(
                "settings",
                () => ({ schema: 2 }),
                { timeoutMs: 25 },
            );
            const outcome = update.catch(error => error);
            await casStarted.promise;
            const laterWriter = coordinator.runWriter(writer);
            await vi.advanceTimersByTimeAsync(25);

            await expect(outcome).resolves.toMatchObject({
                name: "StorageError",
                code: "COMMIT_OUTCOME_UNKNOWN",
                operation: "update",
                retryable: false,
                commitOutcomeUnknown: true,
            });
            expect(durableValue).toEqual({ schema: 2 });
            expect(writer).not.toHaveBeenCalled();

            let drained = false;
            const drain = coordinator.drainPendingPublications()
                .finally(() => { drained = true; });
            await vi.advanceTimersByTimeAsync(0);
            expect(drained).toBe(false);
            releaseAcknowledgement.resolve();
            await Promise.all([drain, laterWriter]);
            expect(drained).toBe(true);
            expect(writer).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    test("external cancellation after CAS dispatch is also outcome-unknown", async () => {
        const controller = new AbortController();
        const casStarted = deferred();
        const releaseCas = deferred();
        const coordinator = new PluginStorageUpdateCoordinator({
            read: vi.fn(async () => ({
                status: "missing" as const,
                value: null,
                revision: null,
                generation: null,
            })),
            atomicSet: vi.fn(async () => {
                casStarted.resolve();
                await releaseCas.promise;
                return {
                    committed: true as const,
                    generation: "published",
                    revisions: [{ key: "settings", revision: revision("a") }],
                };
            }),
        });
        const outcome = coordinator.updateItem(
            "settings",
            () => ({ schema: 1 }),
            { timeoutMs: 1_000 },
            [controller.signal],
        ).catch(error => error);
        await casStarted.promise;
        controller.abort(new DOMException("teardown", "AbortError"));

        await expect(outcome).resolves.toMatchObject({
            code: "COMMIT_OUTCOME_UNKNOWN",
            operation: "update",
            commitOutcomeUnknown: true,
        });
        releaseCas.resolve();
        await coordinator.drainPendingPublications();
    });
});
