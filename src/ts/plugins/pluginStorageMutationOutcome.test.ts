import { describe, expect, test, vi } from "vitest";
import {
    publicPluginStorageMutationFailure,
    runConfirmedPluginStorageRemove,
    runPublicPluginStorageMutation,
} from "./pluginStorageMutationOutcome";

function storageFailure(
    message: string,
    fields: Record<string, unknown>,
): Error & Record<string, unknown> {
    return Object.assign(new Error(message), fields);
}

describe("public plugin-storage mutation outcomes", () => {
    test.each([
        ["import refusal", {
            outcome: "not-committed",
            code: "IMPORT_IN_PROGRESS",
            status: 503,
            retryAfter: 2,
            retryable: true,
            commitOutcomeUnknown: false,
        }],
        ["expired session", {
            outcome: "not-committed",
            code: "AUTH_REQUIRED",
            status: 401,
            retryable: false,
            commitOutcomeUnknown: false,
        }],
    ])("preserves a definitive %s without masking it", async (_label, fields) => {
        const mutate = vi.fn(async () => {
            throw storageFailure("request refused", fields);
        });

        await expect(runPublicPluginStorageMutation("set", mutate)).resolves.toEqual({
            outcome: "not-committed",
            operation: "set",
            message: "request refused",
            code: fields.code,
            status: fields.status,
            retryAfter: "retryAfter" in fields ? fields.retryAfter : null,
            retryable: fields.retryable,
            commitOutcomeUnknown: false,
        });
        expect(mutate).toHaveBeenCalledOnce();
    });

    test.each([
        ["network loss", new TypeError("fetch failed")],
        ["acknowledgement loss", storageFailure("response lost", {
            outcome: "unknown",
            code: "COMMIT_OUTCOME_UNKNOWN",
            commitOutcomeUnknown: true,
        })],
    ])("returns unknown and never replays %s", async (_label, failure) => {
        const mutate = vi.fn(async () => { throw failure; });

        await expect(runPublicPluginStorageMutation("remove", mutate)).resolves.toMatchObject({
            outcome: "unknown",
            operation: "remove",
            commitOutcomeUnknown: true,
            retryable: false,
        });
        expect(mutate).toHaveBeenCalledOnce();
    });

    test("reports an exact acknowledgement as committed", async () => {
        await expect(runPublicPluginStorageMutation("set", async () => undefined)).resolves.toEqual({
            outcome: "committed",
            operation: "set",
            confirmation: "acknowledgement",
            mutationOutcome: "committed",
        });
    });

    test("keeps a dirty row and skips verification after a definitive refusal", async () => {
        const readState = vi.fn();
        const result = await runConfirmedPluginStorageRemove(
            async () => {
                throw storageFailure("import active", {
                    outcome: "not-committed",
                    code: "IMPORT_IN_PROGRESS",
                    retryable: true,
                    commitOutcomeUnknown: false,
                });
            },
            readState,
        );

        expect(result).toMatchObject({
            outcome: "not-committed",
            code: "IMPORT_IN_PROGRESS",
        });
        expect(readState).not.toHaveBeenCalled();
    });

    test("can confirm absence after acknowledgement loss without replaying remove", async () => {
        const remove = vi.fn(async () => {
            throw storageFailure("ack lost", {
                outcome: "unknown",
                commitOutcomeUnknown: true,
            });
        });
        const readState = vi.fn(async () => ({
            status: "missing" as const,
            revision: null,
            generation: "generation-2",
        }));

        await expect(runConfirmedPluginStorageRemove(remove, readState)).resolves.toEqual({
            outcome: "committed",
            operation: "remove",
            confirmation: "authoritative-absence",
            mutationOutcome: "unknown",
        });
        expect(remove).toHaveBeenCalledOnce();
        expect(readState).toHaveBeenCalledOnce();
    });

    test("does not clear dirty state when authoritative data reattaches", async () => {
        const result = await runConfirmedPluginStorageRemove(
            async () => undefined,
            async () => ({
                status: "value",
                revision: "sha256:reattached",
                generation: "generation-3",
            }),
        );

        expect(result).toEqual({
            outcome: "unknown",
            operation: "remove",
            message: "The authoritative plugin storage value is present after removal.",
            code: "PLUGIN_STORAGE_VALUE_PRESENT",
            status: null,
            retryAfter: null,
            retryable: false,
            commitOutcomeUnknown: true,
            mutationOutcome: "committed",
            authoritative: {
                status: "value",
                revision: "sha256:reattached",
                generation: "generation-3",
            },
        });
    });

    test("treats an unavailable absence read as unsuccessful", async () => {
        const result = await runConfirmedPluginStorageRemove(
            async () => undefined,
            async () => { throw new TypeError("verification network failed"); },
        );

        expect(result).toMatchObject({
            outcome: "unknown",
            code: "PLUGIN_STORAGE_ABSENCE_UNCONFIRMED",
            mutationOutcome: "committed",
            commitOutcomeUnknown: true,
        });
    });

    test("reset counters and dirty flags advance only for confirmed absence", async () => {
        const dirty = new Set(["removed", "reattached", "refused"]);
        const outcomes = [
            await runConfirmedPluginStorageRemove(
                async () => undefined,
                async () => ({ status: "missing", revision: null, generation: null }),
            ),
            await runConfirmedPluginStorageRemove(
                async () => undefined,
                async () => ({
                    status: "value",
                    revision: "sha256:stale",
                    generation: null,
                }),
            ),
            await runConfirmedPluginStorageRemove(
                async () => {
                    throw storageFailure("session expired", {
                        outcome: "not-committed",
                        commitOutcomeUnknown: false,
                    });
                },
                async () => ({ status: "missing", revision: null, generation: null }),
            ),
        ];

        let successCount = 0;
        ["removed", "reattached", "refused"].forEach((key, index) => {
            if (outcomes[index].outcome !== "committed") return;
            dirty.delete(key);
            successCount += 1;
        });

        expect(successCount).toBe(1);
        expect([...dirty]).toEqual(["reattached", "refused"]);
    });

    test("a generic error is conservative even if it has a misleading retryable bit", () => {
        expect(publicPluginStorageMutationFailure("set", {
            message: "opaque middleware failure",
            retryable: true,
        })).toMatchObject({
            outcome: "unknown",
            retryable: false,
            commitOutcomeUnknown: true,
        });
    });
});
