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

        expect(merged.username).toBe("server");
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

    test("conflict rebase preserves authoritative root and unrelated chats", () => {
        const latest = {
            username: "server-new",
            characters: [{
                chaId: "char-a",
                name: "Server character",
                chats: [
                    { id: "chat-a", name: "A", message: [{ role: "user", data: "server old" }] },
                    { id: "chat-b", name: "B", message: [{ role: "user", data: "server new" }] },
                ],
            }],
        } as any;
        const local = {
            username: "local-stale",
            characters: [{
                chaId: "char-a",
                name: "Local stale character",
                chats: [
                    { id: "chat-a", name: "A", message: [{ role: "user", data: "local edit" }] },
                ],
            }],
        } as any;

        const merged = mergeTrackedDatabaseOnConflict(latest, local, {
            ...emptyToSave(),
            chat: [["char-a", "chat-a"]],
        });

        expect(merged.username).toBe("server-new");
        expect(merged.characters[0].name).toBe("Server character");
        expect(merged.characters[0].chats).toEqual([
            { id: "chat-a", name: "A", message: [{ role: "user", data: "local edit" }] },
            { id: "chat-b", name: "B", message: [{ role: "user", data: "server new" }] },
        ]);
    });

    test("character-level rebase keeps chats absent from a stale local list", () => {
        const latest = {
            characters: [{
                chaId: "char-a",
                name: "Server name",
                chats: [{ id: "server-chat", name: "Server chat", _stub: true }],
            }],
        } as any;
        const local = {
            characters: [{
                chaId: "char-a",
                name: "Local rename",
                chats: [{ id: "local-chat", name: "Local chat", message: [] }],
            }],
        } as any;

        const merged = mergeTrackedDatabaseOnConflict(latest, local, {
            ...emptyToSave(),
            character: ["char-a"],
        }, new Map([["char-a", new Set<string>()]]));

        expect(merged.characters[0].name).toBe("Local rename");
        expect(merged.characters[0].chats.map((chat: any) => chat.id)).toEqual([
            "local-chat",
            "server-chat",
        ]);
    });

    test("character-level rebase retains an intentional deletion from the known baseline", () => {
        const latest = {
            characters: [{
                chaId: "char-a",
                chats: [
                    { id: "deleted-chat", name: "Delete me", _stub: true },
                    { id: "concurrent-chat", name: "Keep me", _stub: true },
                ],
            }],
        } as any;
        const local = {
            characters: [{ chaId: "char-a", chats: [] }],
        } as any;

        const merged = mergeTrackedDatabaseOnConflict(latest, local, {
            ...emptyToSave(),
            character: ["char-a"],
        }, new Map([["char-a", new Set(["deleted-chat"])]]));

        expect(merged.characters[0].chats.map((chat: any) => chat.id)).toEqual([
            "concurrent-chat",
        ]);
    });
});
