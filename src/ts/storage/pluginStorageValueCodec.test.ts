import { describe, expect, it } from "vitest";
import {
    decodePluginStorageValueBytes,
    encodeLosslessPluginStorageValueToUtf8,
    PLUGIN_STORAGE_JSON_CODEC,
    PLUGIN_STORAGE_LOSSLESS_CODEC,
    pluginStorageCodecFromBytes,
} from "./pluginStorageValueCodec";

describe("lossless plugin storage value codec", () => {
    it("round-trips undefined properties, undefined elements, and sparse holes", () => {
        const sparse = new Array(4);
        sparse[1] = undefined;
        sparse[3] = { missing: undefined };
        const source = {
            ownUndefined: undefined,
            sparse,
            nested: [{ value: undefined }],
        };

        const bytes = encodeLosslessPluginStorageValueToUtf8(source);
        expect(pluginStorageCodecFromBytes(bytes)).toBe(PLUGIN_STORAGE_LOSSLESS_CODEC);
        const decoded = decodePluginStorageValueBytes<typeof source>(
            bytes,
            PLUGIN_STORAGE_LOSSLESS_CODEC,
        );

        expect(Object.prototype.hasOwnProperty.call(decoded, "ownUndefined")).toBe(true);
        expect(decoded.ownUndefined).toBeUndefined();
        expect(decoded.sparse).toHaveLength(4);
        expect(0 in decoded.sparse).toBe(false);
        expect(1 in decoded.sparse).toBe(true);
        expect(decoded.sparse[1]).toBeUndefined();
        expect(2 in decoded.sparse).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(decoded.sparse[3], "missing")).toBe(true);
    });

    it("cannot collide with plugin strings or objects resembling internal tags", () => {
        const source = {
            literal: "**POCKET_UNDEFINED**",
            undefinedTag: ["u"],
            holeTag: ["h"],
            arrayTag: ["a", [["u"]]],
            objectTag: ["o", [["key", ["u"]]]],
        };
        const bytes = encodeLosslessPluginStorageValueToUtf8(source);
        expect(decodePluginStorageValueBytes(bytes)).toEqual(source);
    });

    it("keeps legacy json-v1 rows readable and verifies codec metadata", () => {
        const bytes = new TextEncoder().encode('{"value":null}');
        expect(pluginStorageCodecFromBytes(bytes)).toBe(PLUGIN_STORAGE_JSON_CODEC);
        expect(decodePluginStorageValueBytes(bytes, PLUGIN_STORAGE_JSON_CODEC))
            .toEqual({ value: null });
        expect(() => decodePluginStorageValueBytes(bytes, PLUGIN_STORAGE_LOSSLESS_CODEC))
            .toThrow("did not match");
    });

    it("preserves the absent optional path semantics used by provider plugins", () => {
        const field: {
            key: string;
            path: string | string[] | undefined;
            target: string;
        } = {
            key: "session_id",
            path: undefined,
            target: "body",
        };
        const decoded = decodePluginStorageValueBytes<typeof field>(
            encodeLosslessPluginStorageValueToUtf8(field),
        );
        const resolvePath = (value: typeof field) => {
            if (value.target === "body" && value.path !== undefined) {
                return Array.isArray(value.path)
                    ? value.path
                    : value.path.split(".");
            }
            return [value.key];
        };

        expect(Object.prototype.hasOwnProperty.call(decoded, "path")).toBe(true);
        expect(resolvePath(decoded)).toEqual(["session_id"]);
    });

    it("preserves special own keys without prototype mutation", () => {
        const source = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(source, "__proto__", {
            configurable: true,
            enumerable: true,
            value: undefined,
            writable: true,
        });
        const decoded = decodePluginStorageValueBytes<Record<string, unknown>>(
            encodeLosslessPluginStorageValueToUtf8(source),
        );
        expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
        expect(Object.prototype.hasOwnProperty.call(decoded, "__proto__")).toBe(true);
        expect(decoded.__proto__).toBeUndefined();
    });
});
