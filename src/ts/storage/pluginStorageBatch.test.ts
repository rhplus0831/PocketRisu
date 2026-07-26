import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
    classifyPluginStorageBatchAcknowledgement,
    encodePluginStorageBatchRequest,
} from "./pluginStorageBatch";

const request = {
    generation: "selected-generation",
    expectedManifest: {
        version: 1 as const,
        generation: "selected-generation",
        valueKeys: [],
        metaKeys: [],
    },
    operations: [
        {
            operation: "set" as const,
            key: "body",
            owner: "AA3",
            valueBytes: new TextEncoder().encode('{"value":1}'),
            expectedRevision: null,
        },
        { operation: "remove" as const, key: "old" },
    ],
};

function ack(overrides: Record<string, unknown> = {}) {
    const bytes = encodePluginStorageBatchRequest(request);
    const requestHash = createHash("sha256").update(bytes).digest("hex");
    return {
        requestHash,
        body: {
            success: true,
            outcome: "committed",
            operation: "batch",
            verification: "verified",
            requestHash,
            generation: "123e4567-e89b-42d3-a456-426614174000",
            revisions: [
                { key: "body", revision: `sha256:${"a".repeat(64)}` },
                { key: "old", revision: null },
            ],
            ...overrides,
        },
    };
}

describe("plugin storage batch acknowledgement", () => {
    test("binds a committed acknowledgement to exact request bytes and key order", () => {
        const { body, requestHash } = ack();
        expect(classifyPluginStorageBatchAcknowledgement(
            200, body, requestHash, request.operations,
        )).toMatchObject({ outcome: "committed", generation: body.generation });
    });

    test.each([
        { requestHash: "0".repeat(64) },
        { revisions: [{ key: "old", revision: null }, { key: "body", revision: null }] },
        { revisions: [{ key: "body", revision: null }, { key: "old", revision: null }] },
        {
            revisions: [
                { key: "body", revision: `sha256:${"a".repeat(64)}` },
                { key: "old", revision: `sha256:${"b".repeat(64)}` },
            ],
        },
        { generation: "123E4567-E89B-42D3-A456-426614174000" },
        { generation: "123e4567-e89b-42d3-7456-426614174000" },
        { generation: "------------------------------------" },
        { extra: true },
    ])("treats malformed committed envelopes as outcome unknown", override => {
        const { body, requestHash } = ack(override);
        expect(classifyPluginStorageBatchAcknowledgement(
            200, body, requestHash, request.operations,
        )).toMatchObject({ outcome: "unknown", commitOutcomeUnknown: true });
    });

    test("accepts an exact conflict as known not committed", () => {
        expect(classifyPluginStorageBatchAcknowledgement(409, {
            success: false,
            outcome: "not-committed",
            operation: "batch",
            error: "stale",
            code: "PLUGIN_STORAGE_REVISION_CONFLICT",
            retryable: false,
            conflicts: [{
                key: "body",
                currentRevision: `sha256:${"b".repeat(64)}`,
                currentGeneration: null,
            }],
        }, "a".repeat(64), [request.operations[0]])).toMatchObject({
            outcome: "not-committed",
            code: "PLUGIN_STORAGE_REVISION_CONFLICT",
            conflicts: [{ key: "body", revision: `sha256:${"b".repeat(64)}` }],
        });
    });

    test("accepts an exact BR2 publication conflict as known not committed", () => {
        expect(classifyPluginStorageBatchAcknowledgement(409, {
            success: false,
            outcome: "not-committed",
            operation: "batch",
            error: "manifest changed",
            code: "PLUGIN_STORAGE_GENERATION_CONFLICT",
            retryable: true,
        }, "a".repeat(64), request.operations)).toMatchObject({
            outcome: "not-committed",
            code: "PLUGIN_STORAGE_GENERATION_CONFLICT",
            retryable: true,
        });
    });

    test.each([
        [],
        [{ key: "extra", currentRevision: null, currentGeneration: null }],
        [
            { key: "old", currentRevision: null, currentGeneration: null },
            { key: "body", currentRevision: null, currentGeneration: null },
        ],
        [
            { key: "body", currentRevision: null, currentGeneration: null },
            { key: "body", currentRevision: null, currentGeneration: null },
        ],
        [{
            key: "body",
            currentRevision: null,
            currentGeneration: "123e4567-e89b-12d3-a456-426614174000",
        }],
        [{
            key: "body",
            currentRevision: null,
            currentGeneration: "123e4567-e89b-42d3-a456-426614174000",
        }],
        [{ key: "body", currentRevision: null, currentGeneration: null }],
    ])("rejects conflict lists not exactly bound to requested keys", conflicts => {
        expect(classifyPluginStorageBatchAcknowledgement(409, {
            success: false,
            outcome: "not-committed",
            operation: "batch",
            error: "stale",
            code: "PLUGIN_STORAGE_REVISION_CONFLICT",
            retryable: false,
            conflicts,
        }, "a".repeat(64), request.operations)).toMatchObject({
            outcome: "unknown",
            commitOutcomeUnknown: true,
        });
    });
});
