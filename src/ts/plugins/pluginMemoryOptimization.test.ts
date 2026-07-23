import { describe, expect, test } from "vitest";
import {
    canEnablePlugin,
    canOptimizePluginMemory,
    shouldDisableImportedPlugin,
} from "./pluginMemoryOptimization";

const plugin = (
    version: 2 | "2.1" | "3.0",
    enabled: boolean,
) => ({
    name: String(version),
    script: "",
    arguments: {},
    realArg: {},
    version,
    customLink: [],
    argMeta: {},
    enabled,
});

describe("plugin memory optimization gating", () => {
    test("checkbox is eligible only when no enabled V2/V2.1 plugin exists", () => {
        expect(canOptimizePluginMemory([
            plugin(2, false),
            plugin("2.1", false),
            plugin("3.0", true),
        ])).toBe(true);
        expect(canOptimizePluginMemory([plugin(2, true)])).toBe(false);
        expect(canOptimizePluginMemory([plugin("2.1", true)])).toBe(false);
    });

    test("imports V2/V2.1 disabled only while optimization is on", () => {
        expect(shouldDisableImportedPlugin(2, true)).toBe(true);
        expect(shouldDisableImportedPlugin("2.1", true)).toBe(true);
        expect(shouldDisableImportedPlugin("3.0", true)).toBe(false);
        expect(shouldDisableImportedPlugin(2, false)).toBe(false);
    });

    test("blocks enabling V2/V2.1 while allowing V3", () => {
        expect(canEnablePlugin(plugin(2, false), true)).toBe(false);
        expect(canEnablePlugin(plugin("2.1", false), true)).toBe(false);
        expect(canEnablePlugin(plugin("3.0", false), true)).toBe(true);
        expect(canEnablePlugin(plugin(2, false), false)).toBe(true);
    });
});
