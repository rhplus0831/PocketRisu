import { describe, expect, test, vi } from "vitest";
import { Unpackr } from "msgpackr/index-no-eval";
import {
    parsePluginStorageTransitionStreamCapabilities,
    preparePluginStorageBulkTransition,
    PLUGIN_STORAGE_TRANSITION_STREAM_MAGIC,
    PLUGIN_STORAGE_TRANSITION_STREAM_PREFIX_BYTES,
    PluginStorageTransitionPreparationError,
    UnsupportedPluginStorageTransitionValue,
} from "./pluginStorageTransitionBulk";

const capabilities = {
    transport: "framed-v1" as const,
    maxEntries: 100,
    maxMetadataBytes: 1024 * 1024,
    maxValueBytes: 1024 * 1024,
    maxPayloadBytes: 4 * 1024 * 1024,
};

describe("bulk plugin storage transition framing", () => {
    test("preserves rich inline values for server-side conversion", async () => {
        const cycle: Record<string, unknown> = { label: "cycle" };
        cycle.self = cycle;
        const sparse = new Array(3);
        sparse[1] = Number.NaN;
        const value = {
            date: new Date("2026-01-02T03:04:05.000Z"),
            map: new Map([[1n, new Set(["a", "b"])]]),
            missing: undefined,
            sparse,
            cycle,
            fn: () => "must be rejected by the server",
        };
        const prepared = await preparePluginStorageBulkTransition({
            transitionId: "11111111-1111-4111-8111-111111111111",
            source: { optimized: false, generation: null, manifest: null },
            targetOptimized: true,
            targetGeneration: "22222222-2222-4222-8222-222222222222",
            autoConvert: true,
            rows: [{
                rawKey: "rich",
                storageKey: "pluginsave/cmljaA.json",
                value,
            }],
        }, capabilities);

        const bytes = new Uint8Array(await prepared.body.arrayBuffer());
        expect(new TextDecoder().decode(bytes.slice(0, 8)))
            .toBe(PLUGIN_STORAGE_TRANSITION_STREAM_MAGIC);
        const metadataLength = new DataView(bytes.buffer).getUint32(8);
        const metadata = JSON.parse(new TextDecoder().decode(bytes.slice(
            PLUGIN_STORAGE_TRANSITION_STREAM_PREFIX_BYTES,
            PLUGIN_STORAGE_TRANSITION_STREAM_PREFIX_BYTES + metadataLength,
        )));
        expect(metadata).toMatchObject({
            version: 1,
            autoConvert: true,
            rows: [{ rawKey: "rich", storageKey: "pluginsave/cmljaA.json" }],
        });
        const payload = bytes.slice(
            PLUGIN_STORAGE_TRANSITION_STREAM_PREFIX_BYTES + metadataLength,
        );
        const decoded = new Unpackr({ structuredClone: true, useRecords: true })
            .decode(payload) as typeof value;
        expect(decoded.date).toEqual(value.date);
        expect(decoded.map).toBeInstanceOf(Map);
        expect(decoded.map.get(1n)).toEqual(new Set(["a", "b"]));
        expect(decoded.missing).toBeUndefined();
        expect(decoded.sparse[1]).toBeNaN();
        expect(decoded.cycle.self).toBe(decoded.cycle);
        expect(decoded.fn).toBeInstanceOf(UnsupportedPluginStorageTransitionValue);
        expect(prepared.byteLength).toBe(bytes.byteLength);
    });

    test("parses only bounded framed-v1 capabilities", () => {
        expect(parsePluginStorageTransitionStreamCapabilities(capabilities))
            .toEqual(capabilities);
        expect(parsePluginStorageTransitionStreamCapabilities({
            ...capabilities,
            maxEntries: 0,
        })).toBeNull();
    });

    test("rejects an aggregate payload beyond the advertised limit", async () => {
        await expect(preparePluginStorageBulkTransition({
            transitionId: "11111111-1111-4111-8111-111111111111",
            source: { optimized: false, generation: null, manifest: null },
            targetOptimized: true,
            targetGeneration: "22222222-2222-4222-8222-222222222222",
            autoConvert: false,
            rows: [{
                rawKey: "large",
                storageKey: "pluginsave/bGFyZ2U.json",
                value: "x".repeat(256),
            }],
        }, {
            ...capabilities,
            maxValueBytes: 64,
            maxPayloadBytes: 64,
        })).rejects.toBeInstanceOf(PluginStorageTransitionPreparationError);
    });

    test("hands each encoded row to Blob storage before encoding the next row", async () => {
        const NativeBlob = Blob;
        const constructions: BlobPart[][] = [];
        class ObservedBlob extends NativeBlob {
            constructor(parts: BlobPart[] = [], options?: BlobPropertyBag) {
                constructions.push([...parts]);
                super(parts, options);
            }
        }
        vi.stubGlobal("Blob", ObservedBlob);
        try {
            const prepared = await preparePluginStorageBulkTransition({
                transitionId: "11111111-1111-4111-8111-111111111111",
                source: { optimized: false, generation: null, manifest: null },
                targetOptimized: true,
                targetGeneration: "22222222-2222-4222-8222-222222222222",
                autoConvert: false,
                rows: Array.from({ length: 3 }, (_, index) => ({
                    rawKey: `row-${index}`,
                    storageKey: `pluginsave/cm93LS${index}.json`,
                    value: { index, payload: "x".repeat(32) },
                })),
            }, capabilities);

            expect(constructions).toHaveLength(4);
            for (const rowParts of constructions.slice(0, 3)) {
                expect(rowParts).toHaveLength(1);
                expect(ArrayBuffer.isView(rowParts[0])).toBe(true);
            }
            const finalParts = constructions.at(-1)!;
            expect(finalParts).toHaveLength(5);
            expect(finalParts.slice(2).every(part => part instanceof NativeBlob)).toBe(true);
            expect(finalParts.slice(2).some(part => ArrayBuffer.isView(part))).toBe(false);
            expect(prepared.body).toBeInstanceOf(NativeBlob);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
