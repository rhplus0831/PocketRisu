import { describe, expect, test } from "vitest";
import {
    beginPluginStorageModeTransition,
    canEnablePlugin,
    canOptimizePluginMemory,
    disableEnabledLegacyPluginsForOptimizedMemory,
    isPluginStorageModeTransitioning,
    shouldDisableImportedPlugin,
    withPluginLifecycleLock,
} from "./pluginMemoryOptimization";

const plugin = (
    version: 2 | "2.1" | "3.0",
    enabled: boolean,
) => ({
    name: String(version),
    displayName: undefined as string | undefined,
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

    test("blocks every legacy entry path for the full transition guard lifetime", () => {
        const finishFirst = beginPluginStorageModeTransition();
        const finishSecond = beginPluginStorageModeTransition();
        try {
            expect(isPluginStorageModeTransitioning()).toBe(true);
            expect(canOptimizePluginMemory([plugin("3.0", true)])).toBe(false);
            expect(canEnablePlugin(plugin(2, false), false)).toBe(false);
            expect(canEnablePlugin(plugin("2.1", false), false)).toBe(false);
            expect(canEnablePlugin(plugin("3.0", false), false)).toBe(true);
            expect(shouldDisableImportedPlugin(2, false)).toBe(true);
            expect(shouldDisableImportedPlugin("2.1", false)).toBe(true);

            finishFirst();
            expect(isPluginStorageModeTransitioning()).toBe(true);
            expect(canEnablePlugin(plugin("2.1", false), false)).toBe(false);
        } finally {
            finishFirst();
            finishSecond();
        }

        expect(isPluginStorageModeTransitioning()).toBe(false);
        expect(canEnablePlugin(plugin("2.1", false), false)).toBe(true);
    });

    test("resolves an invalid optimized persisted state by visibly powering legacy plugins off", () => {
        const v2 = plugin(2, true);
        const v21 = plugin("2.1", true);
        const v3 = plugin("3.0", true);

        expect(disableEnabledLegacyPluginsForOptimizedMemory(
            [v2, v21, v3],
            true,
        )).toEqual(["2", "2.1"]);
        expect(v2.enabled).toBe(false);
        expect(v21.enabled).toBe(false);
        expect(v3.enabled).toBe(true);

        expect(disableEnabledLegacyPluginsForOptimizedMemory([v2, v21, v3], true))
            .toEqual([]);
        v2.enabled = true;
        expect(disableEnabledLegacyPluginsForOptimizedMemory([v2], false)).toEqual([]);
        expect(v2.enabled).toBe(true);

        v2.name = "fallback-name";
        v2.displayName = "   ";
        v21.enabled = true;
        v21.name = "";
        v21.displayName = "  Visible label  ";
        expect(disableEnabledLegacyPluginsForOptimizedMemory([v2, v21], true))
            .toEqual(["fallback-name", "Visible label"]);

        v2.enabled = true;
        v2.name = "";
        expect(disableEnabledLegacyPluginsForOptimizedMemory([v2], true))
            .toEqual(["Unnamed plugin"]);
    });

    test("re-enters with an explicit lifecycle lease while unrelated work remains queued", async () => {
        const events: string[] = [];
        let releaseOuter!: () => void;
        let markOuterStarted!: () => void;
        const outerBlocked = new Promise<void>(resolve => { releaseOuter = resolve; });
        const outerStarted = new Promise<void>(resolve => { markOuterStarted = resolve; });

        const outer = withPluginLifecycleLock(async lifecycleLease => {
            events.push("outer-start")
            await withPluginLifecycleLock(async () => {
                events.push("nested")
            }, lifecycleLease)
            markOuterStarted()
            await outerBlocked
            events.push("outer-end")
        });
        await outerStarted;
        const unrelated = withPluginLifecycleLock(async () => {
            events.push("unrelated")
        });
        await Promise.resolve();
        expect(events).toEqual(["outer-start", "nested"]);

        releaseOuter();
        await Promise.all([outer, unrelated]);
        expect(events).toEqual(["outer-start", "nested", "outer-end", "unrelated"]);
    });
});
