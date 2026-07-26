import { describe, expect, test } from "vitest";
import { flushSync } from "svelte";
import {
    createDatabasePluginStorageRecord,
    setDatabasePluginStorageRecordValue,
} from "./pluginStorageRecord";

describe("reactive database plugin storage records", () => {
    test("tracks legacy add, nested mutation, special-key write, and removal", () => {
        const state = $state({
            pluginCustomStorage: createDatabasePluginStorageRecord<unknown>(),
        });
        let runs = 0;
        const stop = $effect.root(() => {
            $effect(() => {
                $state.snapshot(state.pluginCustomStorage);
                runs++;
            });
        });
        flushSync();
        expect(runs).toBe(1);

        setDatabasePluginStorageRecordValue(
            state.pluginCustomStorage,
            "normal",
            { nested: "before" },
        );
        flushSync();
        expect(runs).toBe(2);

        (state.pluginCustomStorage.normal as { nested: string }).nested = "after";
        flushSync();
        expect(runs).toBe(3);

        setDatabasePluginStorageRecordValue(
            state.pluginCustomStorage,
            "__proto__",
            { exact: true },
        );
        flushSync();
        expect(runs).toBe(4);
        expect(Object.hasOwn(state.pluginCustomStorage, "__proto__")).toBe(true);
        expect(state.pluginCustomStorage.__proto__).toEqual({ exact: true });

        delete state.pluginCustomStorage.normal;
        flushSync();
        expect(runs).toBe(5);
        stop();
    });
});
