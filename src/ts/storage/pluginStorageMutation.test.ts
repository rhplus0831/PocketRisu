import { describe, expect, test } from "vitest";
import { classifyPluginStorageMutationAcknowledgement } from "./pluginStorageMutation";

describe("plugin storage mutation ingress acknowledgement", () => {
    test("accepts the exact retryable pre-buffer budget refusal", () => {
        expect(classifyPluginStorageMutationAcknowledgement(503, {
            success: false,
            outcome: "not-committed",
            operation: "set",
            error: "buffer budget is in use",
            code: "BUFFERED_INGRESS_BUSY",
            limit: 512,
            actual: 640,
            retryable: true,
        }, "set")).toMatchObject({
            outcome: "not-committed",
            code: "BUFFERED_INGRESS_BUSY",
            retryable: true,
            limit: 512,
            actual: 640,
            commitOutcomeUnknown: false,
        });
    });

    test("keeps malformed middleware responses outcome-unknown", () => {
        expect(classifyPluginStorageMutationAcknowledgement(503, {
            success: false,
            outcome: "not-committed",
            operation: "set",
            error: "buffer budget is in use",
            code: "BUFFERED_INGRESS_BUSY",
            limit: 512,
            actual: 640,
            retryable: false,
        }, "set")).toMatchObject({
            outcome: "unknown",
            commitOutcomeUnknown: true,
        });
    });
});
