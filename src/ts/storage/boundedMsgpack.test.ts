import { describe, expect, test } from "vitest";
import { Packr, Unpackr } from "msgpackr/index-no-eval";
import { createBoundedMsgpackEncoder } from "./boundedMsgpack";

const TEST_RETENTION_LIMIT = 64 * 1024;

describe("bounded msgpackr encoding", () => {
    test("releases an oversized shared target without invalidating returned bytes", () => {
        const encoder = new Packr({ useRecords: false, variableMapSize: true });
        const observer = new Packr({ useRecords: false });
        const encode = createBoundedMsgpackEncoder(encoder, TEST_RETENTION_LIMIT);
        const value = { payload: "x".repeat(256 * 1024), marker: 42 };

        const encoded = encode(value);
        expect(encoded.buffer.byteLength).toBeGreaterThan(TEST_RETENTION_LIMIT);

        // A different Packr sees the replacement because msgpackr's target is
        // module-global. Its write must not overwrite the view returned above.
        const next = observer.encode({ next: true });
        expect(next.buffer.byteLength).toBeLessThanOrEqual(TEST_RETENTION_LIMIT);
        expect(new Unpackr({ useRecords: false }).decode(encoded)).toEqual(value);
    });

    test("also releases the hidden arena for structured-clone reference insertion", () => {
        const encoder = new Packr({ structuredClone: true, useRecords: true });
        const observer = new Packr({ useRecords: false });
        const encode = createBoundedMsgpackEncoder(encoder, TEST_RETENTION_LIMIT);
        const value: { payload: string; self?: unknown } = {
            payload: "y".repeat(256 * 1024),
        };
        value.self = value;

        const encoded = encode(value);
        const next = observer.encode("small");
        const decoded = new Unpackr({ structuredClone: true, useRecords: true })
            .decode(encoded) as typeof value;

        expect(next.buffer.byteLength).toBeLessThanOrEqual(TEST_RETENTION_LIMIT);
        expect(decoded.payload).toBe(value.payload);
        expect(decoded.self).toBe(decoded);
    });

    test("releases a grown target when encoding throws", () => {
        const encoder = new Packr({ useRecords: false });
        const observer = new Packr({ useRecords: false });
        const encode = createBoundedMsgpackEncoder(encoder, TEST_RETENTION_LIMIT);
        const failure = new Error("getter failed");
        const value = {
            payload: "z".repeat(256 * 1024),
            get invalid(): never {
                throw failure;
            },
        };

        expect(() => encode(value)).toThrow(failure);
        const next = observer.encode({ recovered: true });
        expect(next.buffer.byteLength).toBeLessThanOrEqual(TEST_RETENTION_LIMIT);
    });

    test("rejects a cap smaller than msgpackr's normal initial target", () => {
        const encoder = new Packr({ useRecords: false });
        expect(() => createBoundedMsgpackEncoder(encoder, 8191)).toThrow(RangeError);
    });
});
