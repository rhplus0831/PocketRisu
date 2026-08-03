import { describe, expect, test } from "vitest";
import { classifyPluginStorageMutationAcknowledgement } from "./pluginStorageMutation";

describe("plugin storage mutation ingress acknowledgement", () => {
    test("accepts a previous revision only beside a valid committed revision", () => {
        const manifestRevision = `sha256:${"d".repeat(64)}`;
        const previousManifestRevision = `sha256:${"c".repeat(64)}`;
        expect(classifyPluginStorageMutationAcknowledgement(200, {
            success: true,
            outcome: "committed",
            operation: "remove",
            verification: "verified",
            manifestRevision,
            previousManifestRevision,
        }, "remove")).toMatchObject({
            outcome: "committed",
            manifestRevision,
            previousManifestRevision,
        });

        expect(classifyPluginStorageMutationAcknowledgement(200, {
            success: true,
            outcome: "committed",
            operation: "remove",
            verification: "verified",
            previousManifestRevision,
        }, "remove")).toMatchObject({
            outcome: "unknown",
            commitOutcomeUnknown: true,
        });
    });

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
