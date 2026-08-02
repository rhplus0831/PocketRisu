import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
    classifyPluginStorageBatchAcknowledgement,
    encodePluginStorageBatchRequest,
    parsePluginStorageBatchStreamCapabilities,
    preparePluginStorageBatchStream,
    PLUGIN_STORAGE_BATCH_STREAM_MAGIC,
    PLUGIN_STORAGE_BATCH_STREAM_PREFIX_BYTES,
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
                {
                    key: "body",
                    revision: `sha256:${"a".repeat(64)}`,
                    valueHash: "b".repeat(64),
                },
                { key: "old", revision: null, valueHash: null },
            ],
            ...overrides,
        },
    };
}

describe("plugin storage batch acknowledgement", () => {
    test("frames a value above the legacy ceiling as raw bytes with bounded metadata", async () => {
        const largeValue = new Uint8Array(13 * 1024 * 1024);
        largeValue[0] = 0x22;
        largeValue[largeValue.length - 1] = 0x22;
        const valueHash = createHash("sha256").update(largeValue).digest("hex");
        const capabilities = parsePluginStorageBatchStreamCapabilities({
            transport: "framed-v1",
            maxOperations: 128,
            maxMetadataBytes: 1024 * 1024,
            maxValueBytes: 128 * 1024 * 1024,
            maxPayloadBytes: 1024 * 1024 * 1024,
        });
        expect(capabilities).not.toBeNull();
        const prepared = preparePluginStorageBatchStream({
            generation: "selected-generation",
            expectedManifestRevision: `sha256:${"c".repeat(64)}`,
            operations: [{
                operation: "set",
                key: "large",
                owner: "AA3",
                valueBytes: largeValue,
            }],
        }, [valueHash], capabilities!);

        expect(prepared.metadataBytes.byteLength).toBeLessThan(1024);
        expect(prepared.byteLength).toBe(
            PLUGIN_STORAGE_BATCH_STREAM_PREFIX_BYTES
            + prepared.metadataBytes.byteLength
            + largeValue.byteLength,
        );
        expect(prepared.body.size).toBe(prepared.byteLength);
        const prefix = Buffer.from(await prepared.body
            .slice(0, PLUGIN_STORAGE_BATCH_STREAM_PREFIX_BYTES)
            .arrayBuffer());
        expect(prefix.subarray(0, 8).toString("ascii")).toBe(PLUGIN_STORAGE_BATCH_STREAM_MAGIC);
        expect(prefix.readUInt32BE(8)).toBe(prepared.metadataBytes.byteLength);
        const metadata = JSON.parse(new TextDecoder().decode(prepared.metadataBytes));
        expect(metadata.operations[0]).toMatchObject({
            key: "large",
            valueLength: largeValue.byteLength,
            valueHash,
        });
        expect(Buffer.from(await prepared.body.slice(-1).arrayBuffer())).toEqual(Buffer.from('"'));
    });

    test("enforces negotiated streamed value and payload limits before dispatch", () => {
        const capabilities = {
            transport: "framed-v1" as const,
            maxOperations: 2,
            maxMetadataBytes: 4096,
            maxValueBytes: 8,
            maxPayloadBytes: 12,
        };
        const operation = (key: string, size: number) => ({
            operation: "set" as const,
            key,
            owner: "AA3",
            valueBytes: new Uint8Array(size),
        });
        expect(() => preparePluginStorageBatchStream({
            generation: "selected-generation",
            expectedManifestRevision: `sha256:${"c".repeat(64)}`,
            operations: [operation("large", 9)],
        }, ["a".repeat(64)], capabilities)).toThrow(/per-value limit/);
        expect(() => preparePluginStorageBatchStream({
            generation: "selected-generation",
            expectedManifestRevision: `sha256:${"c".repeat(64)}`,
            operations: [operation("a", 7), operation("b", 6)],
        }, ["a".repeat(64), "b".repeat(64)], capabilities)).toThrow(/payload limit/);
    });

    test("encodes a compact manifest CAS without repository-cardinality payload", () => {
        const operations = Array.from({ length: 128 }, (_, index) => ({
            operation: "set" as const,
            key: `row-${index}`,
            owner: "PM4",
            valueBytes: new TextEncoder().encode(JSON.stringify({ index })),
        }));
        const encoded = encodePluginStorageBatchRequest({
            generation: "selected-generation",
            expectedManifestRevision: `sha256:${"c".repeat(64)}`,
            operations,
        });
        const envelope = JSON.parse(new TextDecoder().decode(encoded));
        expect(envelope).toMatchObject({
            version: 2,
            generation: "selected-generation",
            expectedManifestRevision: `sha256:${"c".repeat(64)}`,
        });
        expect(envelope).not.toHaveProperty("expectedManifest");
        expect(encoded.byteLength).toBeLessThan(64 * 1024);
    });

    test("rejects missing or ambiguous manifest CAS inputs", () => {
        expect(() => encodePluginStorageBatchRequest({
            generation: request.generation,
            operations: request.operations,
        })).toThrow(/exactly one manifest CAS/);
        expect(() => encodePluginStorageBatchRequest({
            ...request,
            expectedManifestRevision: `sha256:${"c".repeat(64)}`,
        })).toThrow(/exactly one manifest CAS/);
    });

    test("binds a committed acknowledgement to exact request bytes and key order", () => {
        const { body, requestHash } = ack();
        expect(classifyPluginStorageBatchAcknowledgement(
            200, body, requestHash, request.operations,
        )).toMatchObject({ outcome: "committed", generation: body.generation });
    });

    test.each([
        { requestHash: "0".repeat(64) },
        {
            revisions: [
                { key: "old", revision: null, valueHash: null },
                { key: "body", revision: null, valueHash: null },
            ],
        },
        {
            revisions: [
                { key: "body", revision: null, valueHash: "b".repeat(64) },
                { key: "old", revision: null, valueHash: null },
            ],
        },
        {
            revisions: [
                {
                    key: "body",
                    revision: `sha256:${"a".repeat(64)}`,
                    valueHash: "b".repeat(64),
                },
                { key: "old", revision: `sha256:${"b".repeat(64)}`, valueHash: null },
            ],
        },
        {
            revisions: [
                {
                    key: "body",
                    revision: `sha256:${"a".repeat(64)}`,
                    valueHash: "B".repeat(64),
                },
                { key: "old", revision: null, valueHash: null },
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

    test("accepts the exact retryable pre-buffer budget refusal", () => {
        expect(classifyPluginStorageBatchAcknowledgement(503, {
            success: false,
            outcome: "not-committed",
            operation: "batch",
            error: "buffer budget is in use",
            code: "BUFFERED_INGRESS_BUSY",
            limit: 512,
            actual: 640,
            retryable: true,
        }, "a".repeat(64), request.operations, 1)).toMatchObject({
            outcome: "not-committed",
            code: "BUFFERED_INGRESS_BUSY",
            retryable: true,
            retryAfter: 1,
            limit: 512,
            actual: 640,
            commitOutcomeUnknown: false,
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
