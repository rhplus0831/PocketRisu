import { describe, expect, test } from "vitest";
import { formatPluginStorageTransitionBytes } from "./pluginStorageTransitionUi";

describe("plugin storage transition byte display", () => {
    test.each([
        [0, "0 B"],
        [1023, "1023 B"],
        [1024, "1.00 KiB"],
        [10 * 1024, "10.0 KiB"],
        [50 * 1024 * 1024, "50.0 MiB"],
        [64 * 1024 * 1024, "64.0 MiB"],
        [100 * 1024 * 1024, "100.0 MiB"],
    ])("formats %i actual bytes as %s", (bytes, expected) => {
        expect(formatPluginStorageTransitionBytes(bytes)).toBe(expected);
    });

    test("does not expose invalid estimates in the UI", () => {
        expect(formatPluginStorageTransitionBytes(Number.NaN)).toBe("0 B");
        expect(formatPluginStorageTransitionBytes(-1)).toBe("0 B");
    });
});
