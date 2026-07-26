import { describe, expect, it } from "vitest";

import { snapshotJsonValue, stringifyJsonValue } from "./jsonValue";

describe("persistent JSON values", () => {
    it.each([
        ["top-level undefined", undefined],
        ["top-level function", () => undefined],
        ["nested undefined", { nested: undefined }],
        ["nested function", { nested: () => undefined }],
        ["Map", new Map([["key", "value"]])],
        ["Set", new Set(["value"])],
        ["NaN", { nested: Number.NaN }],
        ["infinity", { nested: Number.POSITIVE_INFINITY }],
        ["BigInt", { nested: 1n }],
        ["sparse array", [1, , 3]],
    ])("rejects %s instead of acknowledging a lossy value", (_name, value) => {
        expect(() => snapshotJsonValue(value)).toThrow(TypeError);
        expect(() => stringifyJsonValue(value)).toThrow(TypeError);
    });

    it("rejects cycles", () => {
        const value: Record<string, unknown> = {};
        value.self = value;

        expect(() => snapshotJsonValue(value)).toThrow("circular data");
    });

    it("does not invoke accessors or toJSON while validating", () => {
        let getterCalled = false;
        const accessor = {};
        Object.defineProperty(accessor, "secret", {
            enumerable: true,
            get: () => {
                getterCalled = true;
                return "lossy";
            },
        });
        let toJsonCalled = false;
        const transformed = {
            safe: true,
            toJSON: () => {
                toJsonCalled = true;
                return { replaced: true };
            },
        };

        expect(() => snapshotJsonValue(accessor)).toThrow("accessors");
        expect(() => stringifyJsonValue(transformed)).toThrow("JSON data");
        expect(getterCalled).toBe(false);
        expect(toJsonCalled).toBe(false);
    });

    it("does not let a proxy get trap disguise an invalid nested value", () => {
        let getCalled = false;
        const value = new Proxy({ nested: undefined }, {
            get: () => {
                getCalled = true;
                return "masked";
            },
        });

        expect(() => snapshotJsonValue(value)).toThrow("JSON data");
        expect(getCalled).toBe(false);
    });

    it("returns a detached JSON tree and canonicalizes negative zero", () => {
        const shared = { value: "original" };
        const input = { array: [-0, shared], repeated: shared };

        const snapshot = snapshotJsonValue(input);
        shared.value = "mutated";

        expect(snapshot).toEqual({
            array: [0, { value: "original" }],
            repeated: { value: "original" },
        });
        expect(Object.is(snapshot.array[0], -0)).toBe(false);
        expect(snapshot.array[1]).not.toBe(snapshot.repeated);
    });

    it("serializes without consulting poisoned built-in toJSON methods", () => {
        let objectToJsonCalled = false;
        let arrayToJsonCalled = false;
        const objectToJson = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
        const arrayToJson = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
        Object.defineProperty(Object.prototype, "toJSON", {
            configurable: true,
            value: () => {
                objectToJsonCalled = true;
                return { poisoned: true };
            },
        });
        Object.defineProperty(Array.prototype, "toJSON", {
            configurable: true,
            value: () => {
                arrayToJsonCalled = true;
                return ["poisoned"];
            },
        });

        try {
            expect(JSON.parse(stringifyJsonValue({ nested: [1, { safe: true }] })))
                .toEqual({ nested: [1, { safe: true }] });
        } finally {
            if (objectToJson) Object.defineProperty(Object.prototype, "toJSON", objectToJson);
            else delete (Object.prototype as { toJSON?: unknown }).toJSON;
            if (arrayToJson) Object.defineProperty(Array.prototype, "toJSON", arrayToJson);
            else delete (Array.prototype as unknown as { toJSON?: unknown }).toJSON;
        }

        expect(objectToJsonCalled).toBe(false);
        expect(arrayToJsonCalled).toBe(false);
    });
});
