import { describe, expect, test } from "vitest";
import { capturePreTrackingPluginStorageChanges } from "../plugins/pluginStorageTracking";
import {
    createDatabasePluginStorageRecord,
    setDatabasePluginStorageRecordValue,
} from "../plugins/pluginStorageRecord";
import {
    cloneDatabaseState,
    mergeTrackedDatabaseOnConflict,
    mergeTrackedDatabaseOnConflictLegacyForTests,
} from "./databaseClone";
import type { toSaveType } from "./risuSave";

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

type ConflictScenario = {
    name: string;
    mutateLocal?: (database: any) => void;
    mutateRemote?: (database: any) => void;
    toSave: toSaveType;
};

function tracked(overrides: Partial<toSaveType> = {}): toSaveType {
    return { ...emptyToSave(), ...overrides };
}

function baseConflictDatabase() {
    return {
        username: "base-user",
        personaPrompt: "base-prompt",
        optimizePluginMemory: true,
        pluginStorageGeneration: "authoritative-generation",
        pluginStorageFolded: false,
        characters: [
            {
                chaId: "char-a",
                name: "Character A",
                order: 0,
                chats: [
                    { id: "chat-a", name: "Chat A", message: [{ role: "user", data: "base-a" }] },
                    { id: "chat-b", name: "Chat B", message: [{ role: "user", data: "base-b" }] },
                ],
            },
            { chaId: "char-b", name: "Character B", order: 1, chats: [] },
        ],
        botPresets: [
            { id: "preset-a", name: "Preset A", temperature: 70 },
            { id: "preset-b", name: "Preset B", temperature: 80 },
        ],
        botPresetsId: 0,
        modules: [
            { id: "module-a", name: "Module A", data: "base-a" },
            { id: "module-b", name: "Module B", data: "base-b" },
        ],
        plugins: [{ id: "plugin-a", version: "1.0.0" }],
        pluginCustomStorage: pluginRecord({ source: "base-value" }),
        pluginStorageMeta: pluginRecord({ plugin: "Base owner", updatedAt: 1 }),
    } as any;
}

function triad(
    branch: string,
    mutateLocal: (database: any) => void,
    mutateRemote: (database: any) => void,
    toSave: toSaveType,
): ConflictScenario[] {
    return [
        { name: `${branch}: local only`, mutateLocal, toSave },
        { name: `${branch}: remote only`, mutateRemote, toSave: tracked() },
        { name: `${branch}: both sides`, mutateLocal, mutateRemote, toSave },
    ];
}

const conflictParityScenarios: ConflictScenario[] = [
    ...triad(
        "root",
        db => { db.username = "local-user"; db.localRoot = { value: 1 }; },
        db => { db.username = "remote-user"; db.remoteRoot = { value: 2 }; },
        tracked({ root: true }),
    ),
    ...triad(
        "character fields",
        db => { db.characters[0].name = "Local A"; },
        db => { db.characters[0].name = "Remote A"; },
        tracked({ character: ["char-a"] }),
    ),
    ...triad(
        "character add",
        db => { db.characters.push({ chaId: "char-local", name: "Local add", chats: [] }); },
        db => { db.characters.push({ chaId: "char-remote", name: "Remote add", chats: [] }); },
        tracked({ character: ["char-local"] }),
    ),
    ...triad(
        "character remove",
        db => { db.characters = db.characters.filter((character: any) => character.chaId !== "char-b"); },
        db => { db.characters[1].name = "Remote changed before local remove"; },
        tracked({ character: ["char-b"] }),
    ),
    ...triad(
        "character reorder",
        db => { db.characters = [db.characters[1], db.characters[0]]; },
        db => { db.characters[0].name = "Remote A during reorder"; },
        tracked({ character: ["char-b", "char-a"] }),
    ),
    ...triad(
        "chat",
        db => { db.characters[0].chats[0].message[0].data = "local chat edit"; },
        db => { db.characters[0].chats[0].message[0].data = "remote chat edit"; },
        tracked({ chat: [["char-a", "chat-a"]] }),
    ),
    ...triad(
        "bot presets",
        db => { db.botPresets = [db.botPresets[1], { id: "preset-local", name: "Local preset" }]; db.botPresetsId = 1; },
        db => { db.botPresets[0].temperature = 99; },
        tracked({ botPreset: true }),
    ),
    ...triad(
        "modules",
        db => { db.modules = [{ id: "module-local", name: "Local module" }, db.modules[0]]; },
        db => { db.modules[0].data = "remote module edit"; },
        tracked({ modules: true }),
    ),
    ...triad(
        "plugins",
        db => { db.plugins = [{ id: "plugin-local", version: "2.0.0" }]; },
        db => { db.plugins[0].version = "1.1.0"; },
        tracked({ plugins: true }),
    ),
    ...triad(
        "plugin values and metadata",
        db => {
            db.pluginCustomStorage = pluginRecord({ source: "local-value" });
            db.pluginStorageMeta = pluginRecord({ plugin: "Local owner", updatedAt: 2 });
        },
        db => {
            db.pluginCustomStorage = pluginRecord({ source: "remote-value" });
            db.pluginStorageMeta = pluginRecord({ plugin: "Remote owner", updatedAt: 3 });
        },
        tracked({ pluginCustomStorage: true }),
    ),
    {
        name: "degenerate: no local changes",
        mutateRemote: db => {
            db.username = "remote-only";
            db.characters[0].chats.push({ id: "remote-chat", name: "Remote", message: [] });
        },
        toSave: tracked(),
    },
    {
        name: "degenerate: no remote changes",
        mutateLocal: db => {
            db.personaPrompt = "local-only";
            db.characters[0].chats[0].message[0].data = "local-only-chat";
        },
        toSave: tracked({ root: true, chat: [["char-a", "chat-a"]] }),
    },
];

describe("in-place conflict merge differential parity", () => {
    test.each(conflictParityScenarios)("$name", ({ mutateLocal, mutateRemote, toSave }) => {
        const base = baseConflictDatabase();
        const local = cloneDatabaseState(base);
        const remote = cloneDatabaseState(base);
        mutateLocal?.(local);
        mutateRemote?.(remote);
        const knownChats = new Map([
            ["char-a", new Set(["chat-a", "chat-b"])],
            ["char-b", new Set<string>()],
        ]);

        const legacy = mergeTrackedDatabaseOnConflictLegacyForTests(
            cloneDatabaseState(remote),
            cloneDatabaseState(local),
            cloneDatabaseState(toSave as any),
            knownChats,
        );
        const authoritativeWorkingGraph = cloneDatabaseState(remote);
        const merged = mergeTrackedDatabaseOnConflict(
            authoritativeWorkingGraph,
            cloneDatabaseState(local),
            cloneDatabaseState(toSave as any),
            knownChats,
        );

        expect(merged).toBe(authoritativeWorkingGraph);
        expect(merged).toEqual(legacy);
    });

    test("keeps optimized publication controls authoritative during a generic root merge", () => {
        const local = baseConflictDatabase();
        const latest = baseConflictDatabase();
        local.username = "local root edit";
        local.optimizePluginMemory = false;
        local.pluginStorageGeneration = "stale-local-generation";
        local.pluginStorageFolded = true;
        latest.optimizePluginMemory = true;
        latest.pluginStorageGeneration = "fresh-server-generation";
        latest.pluginStorageFolded = false;

        const merged = mergeTrackedDatabaseOnConflict(latest, local, tracked({ root: true }));

        expect(merged.username).toBe("local root edit");
        expect(merged.optimizePluginMemory).toBe(true);
        expect(merged.pluginStorageGeneration).toBe("fresh-server-generation");
        expect((merged as any).pluginStorageFolded).toBe(false);
    });
});
