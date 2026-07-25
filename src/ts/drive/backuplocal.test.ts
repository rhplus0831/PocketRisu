import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    database: undefined as any,
    persistent: new Map<string, unknown>(),
    alertConfirm: vi.fn(),
    alertWait: vi.fn(),
    encodeRisuSaveLegacy: vi.fn(),
    fetchChatFromServer: vi.fn(),
    listPersistentKeys: vi.fn(),
    readPersistentJson: vi.fn(),
    writerInit: vi.fn(),
    writerWriteBackup: vi.fn(),
    writerClose: vi.fn(),
    forageGetItem: vi.fn(),
}));

vi.mock("../alert", () => ({
    alertConfirm: mocks.alertConfirm,
    alertError: vi.fn(),
    alertMd: vi.fn(),
    alertStore: { set: vi.fn() },
    alertWait: mocks.alertWait,
    notifyError: vi.fn(),
    notifyInfo: vi.fn(),
    notifySuccess: vi.fn(),
    waitAlert: vi.fn(),
}));

vi.mock("../globalApi.svelte", () => ({
    downloadFile: vi.fn(),
    LocalWriter: vi.fn(function LocalWriter() {
        return {
            init: mocks.writerInit,
            writeBackup: mocks.writerWriteBackup,
            close: mocks.writerClose,
        };
    }),
    forageStorage: {
        getItem: mocks.forageGetItem,
    },
}));

vi.mock("../storage/risuSave", () => ({
    encodeRisuSaveLegacy: mocks.encodeRisuSaveLegacy,
}));

vi.mock("../storage/database.svelte", () => ({
    getDatabase: () => mocks.database,
}));

vi.mock("../storage/chatStorage", () => ({
    fetchChatFromServer: mocks.fetchChatFromServer,
}));

vi.mock("src/lang", () => ({
    language: {
        partialBackupFirstConfirm: "first",
        partialBackupSecondConfirm: "second",
    },
}));

vi.mock("../storage/persistentKv", () => {
    const encode = (value: string) => Buffer.from(value, "utf-8").toString("base64url");
    const decode = (value: string) => Buffer.from(value, "base64url").toString("utf-8");
    return {
        clearPersistentPrefix: vi.fn(),
        decodeStorageKeyComponent: decode,
        listPersistentKeys: mocks.listPersistentKeys,
        makeEncodedStorageKey: (prefix: string, key: string) => `${prefix}${encode(key)}.json`,
        readPersistentJson: mocks.readPersistentJson,
        removePersistentKey: vi.fn(),
        writePersistentJson: vi.fn(),
    };
});

const { SavePartialLocalBackup } = await import("./backuplocal");
const { PLUGIN_SAVE_META_PREFIX, PLUGIN_SAVE_PREFIX } = await import("../plugins/pluginSaveStorage");

function encoded(prefix: string, key: string) {
    return `${prefix}${Buffer.from(key, "utf-8").toString("base64url")}.json`;
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.persistent.clear();
    mocks.database = {
        characters: [],
        optimizePluginMemory: false,
        pluginCustomStorage: {},
    };
    mocks.alertConfirm.mockResolvedValue(true);
    mocks.writerInit.mockResolvedValue(true);
    mocks.writerWriteBackup.mockResolvedValue(undefined);
    mocks.writerClose.mockResolvedValue(undefined);
    mocks.encodeRisuSaveLegacy.mockReturnValue(new Uint8Array([1, 2, 3]));
    mocks.listPersistentKeys.mockImplementation(async (prefix: string) =>
        [...mocks.persistent.keys()].filter((key) => key.startsWith(prefix))
    );
    mocks.readPersistentJson.mockImplementation(async (key: string) => mocks.persistent.get(key));
});

describe("SavePartialLocalBackup", () => {
    test("folds optimized external plugin storage into the encoded clone", async () => {
        mocks.database = {
            account: { token: "secret" },
            characters: [],
            optimizePluginMemory: true,
            pluginCustomStorage: {
                duplicate: { source: "inline" },
                inlineOnly: true,
            },
            pluginStorageMeta: {
                duplicate: { plugin: "Inline Plugin", updatedAt: 20 },
            },
        };
        mocks.persistent.set(encoded(PLUGIN_SAVE_PREFIX, "키🔑"), { nested: "외부" });
        mocks.persistent.set(encoded(PLUGIN_SAVE_PREFIX, "duplicate"), { source: "external" });
        mocks.persistent.set(
            encoded(PLUGIN_SAVE_META_PREFIX, "키🔑"),
            { plugin: "External Plugin", updatedAt: 10 },
        );
        mocks.persistent.set(
            encoded(PLUGIN_SAVE_META_PREFIX, "duplicate"),
            { plugin: "Old Plugin", updatedAt: 5 },
        );

        await SavePartialLocalBackup();

        expect(mocks.encodeRisuSaveLegacy).toHaveBeenCalledTimes(1);
        const [encodedDatabase, mode] = mocks.encodeRisuSaveLegacy.mock.calls[0];
        expect(mode).toBe("compression");
        expect(encodedDatabase.pluginCustomStorage).toEqual({
            "키🔑": { nested: "외부" },
            duplicate: { source: "inline" },
            inlineOnly: true,
        });
        expect(encodedDatabase.pluginStorageMeta).toEqual({
            "키🔑": { plugin: "External Plugin", updatedAt: 10 },
            duplicate: { plugin: "Inline Plugin", updatedAt: 20 },
        });
        expect(encodedDatabase.optimizePluginMemory).toBe(true);
        expect(mocks.database.pluginCustomStorage).toEqual({
            duplicate: { source: "inline" },
            inlineOnly: true,
        });
    });

    test("passes inline storage through without persistent reads when optimization is disabled", async () => {
        mocks.database = {
            characters: [],
            optimizePluginMemory: false,
            pluginCustomStorage: {
                inline: { untouched: true },
            },
            pluginStorageMeta: {
                inline: { plugin: "Inline Plugin", updatedAt: 30 },
            },
        };
        mocks.persistent.set(encoded(PLUGIN_SAVE_PREFIX, "external"), "ignored");

        await SavePartialLocalBackup();

        const [encodedDatabase] = mocks.encodeRisuSaveLegacy.mock.calls[0];
        expect(encodedDatabase.pluginCustomStorage).toEqual({
            inline: { untouched: true },
        });
        expect(encodedDatabase.pluginStorageMeta).toEqual({
            inline: { plugin: "Inline Plugin", updatedAt: 30 },
        });
        expect(encodedDatabase.optimizePluginMemory).toBe(false);
        expect(mocks.listPersistentKeys).not.toHaveBeenCalled();
        expect(mocks.readPersistentJson).not.toHaveBeenCalled();
    });
});
