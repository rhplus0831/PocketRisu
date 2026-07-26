import { describe, expect, test } from "vitest";
import { capturePreTrackingPluginStorageChanges } from "../plugins/pluginStorageTracking";
import {
    createDatabasePluginStorageRecord,
    setDatabasePluginStorageRecordValue,
} from "../plugins/pluginStorageRecord";
import {
    cloneDatabaseState,
    mergeTrackedDatabaseOnConflict,
} from "./databaseClone";

function pluginRecord(value: unknown) {
    const record = createDatabasePluginStorageRecord<unknown>();
    setDatabasePluginStorageRecordValue(record, "__proto__", value);
    return record;
}

function emptyToSave() {
    return {
        character: [],
        chat: [],
        root: false,
        botPreset: false,
        modules: false,
        plugins: false,
        pluginCustomStorage: false,
    };
}

describe("database-aware plugin storage cloning", () => {
    test("initial baseline is detached and deterministically retains value and metadata keys", () => {
        const database = $state({
            characters: [],
            pluginCustomStorage: pluginRecord({ nested: "persisted" }),
            pluginStorageMeta: pluginRecord({ plugin: "Owner", updatedAt: 1 }),
        });
        const baseline = cloneDatabaseState(database as any);

        expect(Object.hasOwn(baseline.pluginCustomStorage, "__proto__")).toBe(true);
        expect(Object.hasOwn(baseline.pluginStorageMeta, "__proto__")).toBe(true);
        expect(capturePreTrackingPluginStorageChanges(
            { pluginCustomStorage: false },
            database as any,
            baseline,
        )).toBe(false);

        (database.pluginCustomStorage.__proto__ as any).nested = "startup-write";
        (database.pluginStorageMeta.__proto__ as any).updatedAt = 2;
        expect(baseline.pluginCustomStorage.__proto__).toEqual({ nested: "persisted" });
        expect(baseline.pluginStorageMeta.__proto__).toEqual({
            plugin: "Owner",
            updatedAt: 1,
        });
        const tracker = { pluginCustomStorage: false };
        expect(capturePreTrackingPluginStorageChanges(
            tracker,
            database as any,
            baseline,
        )).toBe(true);
        expect(tracker.pluginCustomStorage).toBe(true);
    });

    test("conflict rebase copies tracked value and metadata maps without resurrecting server rows", () => {
        const latest = {
            characters: [],
            username: "server",
            pluginCustomStorage: pluginRecord({ source: "server" }),
            pluginStorageMeta: pluginRecord({ plugin: "Server", updatedAt: 1 }),
        } as any;
        const local = {
            characters: [],
            username: "local",
            pluginCustomStorage: pluginRecord({ source: "local" }),
            pluginStorageMeta: pluginRecord({ plugin: "Local", updatedAt: 2 }),
        } as any;
        const merged = mergeTrackedDatabaseOnConflict(latest, local, {
            ...emptyToSave(),
            pluginCustomStorage: true,
        });

        expect(merged.username).toBe("local");
        expect(Object.keys(merged.pluginCustomStorage)).toEqual(["__proto__"]);
        expect(Object.keys(merged.pluginStorageMeta!)).toEqual(["__proto__"]);
        expect(merged.pluginCustomStorage.__proto__).toEqual({ source: "local" });
        expect(merged.pluginStorageMeta!.__proto__).toEqual({
            plugin: "Local",
            updatedAt: 2,
        });

        (local.pluginCustomStorage.__proto__ as any).source = "later-local-mutation";
        expect(merged.pluginCustomStorage.__proto__).toEqual({ source: "local" });
    });
});
