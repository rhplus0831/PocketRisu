import { beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";

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

vi.mock("../storage/risuSave", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../storage/risuSave")>();
    mocks.encodeRisuSaveLegacy.mockImplementation(actual.encodeRisuSaveLegacy);
    return {
        ...actual,
        encodeRisuSaveLegacy: mocks.encodeRisuSaveLegacy,
    };
});

vi.mock("../storage/database.svelte", () => ({
    createBotPresetTemplate: () => ({ id: "test-preset" }),
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
        preparePersistentJson: (value: unknown) => {
            const bytes = new TextEncoder().encode(JSON.stringify(value));
            return { bytes, byteLength: bytes.byteLength, value };
        },
        writePreparedPersistentJson: vi.fn(),
    };
});

const { SavePartialLocalBackup } = await import("./backuplocal");
const { decodeRisuSave } = await import("../storage/risuSave");
const { PLUGIN_SAVE_META_PREFIX, PLUGIN_SAVE_PREFIX } = await import("../plugins/pluginSaveStorage");
const {
    createPluginStorageRecord,
    definePluginStorageRecordValue,
} = await import("../plugins/pluginStorageRecord");

const SPECIAL_PLUGIN_STORAGE_KEYS = [
    "__proto__",
    "constructor",
    "prototype",
    "toString",
    "hasOwnProperty",
    "",
] as const;
const LEGACY_ESCAPE_FIELD = "__pocketRisuPluginStorageEscapesV1";

function runServerCodec(
    operation: "decode" | "encode" | "raw" | "fallback" | "modern",
    input: Uint8Array | Record<string, unknown>,
): Uint8Array | Record<string, unknown> {
    const script = `
const fs = require('node:fs');
const utils = require('./server/node/utils.cjs');
const operation = process.argv[1];
const input = fs.readFileSync(0);
(async () => {
  if (operation === 'decode') {
    process.stdout.write(JSON.stringify(await utils.decodeRisuSave(input)));
    return;
  }
  const value = JSON.parse(input.toString('utf8'));
  if (operation === 'encode') {
    process.stdout.write(Buffer.from(utils.encodeRisuSaveLegacy(value, 'compression')));
    return;
  }
  const { Packr } = require('msgpackr');
  const payload = Buffer.from(new Packr({ useRecords: false }).encode(value));
  if (operation === 'raw') {
    process.stdout.write(Buffer.concat([Buffer.from(utils.magicHeader), payload]));
    return;
  }
  if (operation === 'fallback') {
    process.stdout.write(payload);
    return;
  }
  const block = (type, name, content) => {
    const nameBuffer = Buffer.from(name, 'utf8');
    const dataBuffer = Buffer.from(JSON.stringify(content), 'utf8');
    const header = Buffer.alloc(7 + nameBuffer.length);
    header[0] = type;
    header[1] = 0;
    header[2] = nameBuffer.length;
    nameBuffer.copy(header, 3);
    header.writeUInt32LE(dataBuffer.length, 3 + nameBuffer.length);
    return Buffer.concat([header, dataBuffer]);
  };
  const blocks = Object.keys(value).map(key => key === 'pluginCustomStorage'
    ? block(11, 'pluginCustomStorage', value[key])
    : block(8, key, { key, data: value[key] }));
  process.stdout.write(Buffer.concat([Buffer.from(utils.magicRisuSaveHeader), ...blocks]));
})().catch(error => { console.error(error); process.exitCode = 1; });
`;
    const output = execFileSync(process.execPath, ["-e", script, operation], {
        cwd: process.cwd(),
        input: operation === "decode"
            ? Buffer.from(input as Uint8Array)
            : Buffer.from(JSON.stringify(input), "utf-8"),
    });
    return operation === "decode"
        ? JSON.parse(output.toString("utf-8"))
        : new Uint8Array(output);
}

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

    test("folds every special external key into a partial backup as an own property", async () => {
        const inlineValues = createPluginStorageRecord<unknown>();
        const inlineMeta = createPluginStorageRecord<any>();
        // Inline wins duplicate rows during a partial transition/recovery state.
        definePluginStorageRecordValue(inlineValues, "constructor", { source: "inline" });
        definePluginStorageRecordValue(inlineMeta, "constructor", {
            plugin: "Inline Plugin",
            updatedAt: 100,
        });
        mocks.database = {
            characters: [],
            optimizePluginMemory: true,
            pluginCustomStorage: inlineValues,
            pluginStorageMeta: inlineMeta,
        };
        for (const [index, key] of SPECIAL_PLUGIN_STORAGE_KEYS.entries()) {
            mocks.persistent.set(encoded(PLUGIN_SAVE_PREFIX, key), {
                index,
                source: "external",
            });
            mocks.persistent.set(encoded(PLUGIN_SAVE_META_PREFIX, key), {
                plugin: `External Plugin ${index}`,
                updatedAt: index,
            });
        }

        await SavePartialLocalBackup();

        const [encodedDatabase] = mocks.encodeRisuSaveLegacy.mock.calls[0];
        expect(Object.getPrototypeOf(encodedDatabase.pluginCustomStorage)).toBeNull();
        expect(Object.getPrototypeOf(encodedDatabase.pluginStorageMeta)).toBeNull();
        expect(Object.keys(encodedDatabase.pluginCustomStorage))
            .toEqual(SPECIAL_PLUGIN_STORAGE_KEYS);
        expect(Object.keys(encodedDatabase.pluginStorageMeta))
            .toEqual(SPECIAL_PLUGIN_STORAGE_KEYS);
        for (const [index, key] of SPECIAL_PLUGIN_STORAGE_KEYS.entries()) {
            expect(Object.hasOwn(encodedDatabase.pluginCustomStorage, key)).toBe(true);
            expect(Object.hasOwn(encodedDatabase.pluginStorageMeta, key)).toBe(true);
            if (key === "constructor") {
                expect(encodedDatabase.pluginCustomStorage[key]).toEqual({ source: "inline" });
                expect(encodedDatabase.pluginStorageMeta[key]).toEqual({
                    plugin: "Inline Plugin",
                    updatedAt: 100,
                });
            } else {
                expect(encodedDatabase.pluginCustomStorage[key]).toEqual({
                    index,
                    source: "external",
                });
                expect(encodedDatabase.pluginStorageMeta[key]).toEqual({
                    plugin: `External Plugin ${index}`,
                    updatedAt: index,
                });
            }
        }

        const databaseWrite = mocks.writerWriteBackup.mock.calls.find(
            ([name]) => name === "database.risudat",
        );
        expect(databaseWrite).toBeDefined();
        expect(databaseWrite![1][10]).toBe(11);
        const decodedDatabase = await decodeRisuSave(databaseWrite![1]);
        expect(Object.keys(decodedDatabase.pluginCustomStorage))
            .toEqual(SPECIAL_PLUGIN_STORAGE_KEYS);
        expect(Object.keys(decodedDatabase.pluginStorageMeta))
            .toEqual(SPECIAL_PLUGIN_STORAGE_KEYS);
        for (const [index, key] of SPECIAL_PLUGIN_STORAGE_KEYS.entries()) {
            expect(Object.hasOwn(decodedDatabase.pluginCustomStorage, key)).toBe(true);
            expect(Object.hasOwn(decodedDatabase.pluginStorageMeta, key)).toBe(true);
            expect(decodedDatabase.pluginCustomStorage[key]).toEqual(
                key === "constructor" ? { source: "inline" } : { index, source: "external" },
            );
        }

        const serverDecoded = runServerCodec("decode", databaseWrite![1]) as any;
        expect(Object.keys(serverDecoded.pluginCustomStorage)).toEqual(SPECIAL_PLUGIN_STORAGE_KEYS);
        expect(Object.keys(serverDecoded.pluginStorageMeta)).toEqual(SPECIAL_PLUGIN_STORAGE_KEYS);
        for (const key of SPECIAL_PLUGIN_STORAGE_KEYS) {
            expect(Object.hasOwn(serverDecoded.pluginCustomStorage, key)).toBe(true);
            expect(Object.hasOwn(serverDecoded.pluginStorageMeta, key)).toBe(true);
        }

        const reservedCollision = [
            "PocketRisu.plugin-storage-escapes",
            1,
            null,
            [["pluginCustomStorage", 0, [1, '"user-collision"']]],
        ];
        definePluginStorageRecordValue(encodedDatabase, LEGACY_ESCAPE_FIELD, reservedCollision);
        const serverEncoded = runServerCodec("encode", encodedDatabase) as Uint8Array;
        expect(serverEncoded[10]).toBe(11);
        const clientDecodedServerData = await decodeRisuSave(serverEncoded);
        expect(Object.keys(clientDecodedServerData.pluginCustomStorage))
            .toEqual(SPECIAL_PLUGIN_STORAGE_KEYS);
        expect(clientDecodedServerData[LEGACY_ESCAPE_FIELD]).toEqual(reservedCollision);
    });

    test("restores sidecars only for their dedicated legacy wire formats", async () => {
        const validCollision = [
            "PocketRisu.plugin-storage-escapes",
            1,
            null,
            [["pluginCustomStorage", 0, [1, '"forged"']]],
        ];
        const database = {
            characters: [],
            pluginCustomStorage: { safe: "external" },
        } as Record<string, unknown>;
        definePluginStorageRecordValue<unknown>(database, LEGACY_ESCAPE_FIELD, validCollision);

        for (const format of ["raw", "fallback", "modern"] as const) {
            const bytes = runServerCodec(format, database) as Uint8Array;
            const clientDecoded = await decodeRisuSave(bytes);
            const serverDecoded = runServerCodec("decode", bytes) as any;
            for (const decoded of [clientDecoded, serverDecoded]) {
                expect(decoded[LEGACY_ESCAPE_FIELD]).toEqual(validCollision);
                expect(decoded.pluginCustomStorage.safe).toBe("external");
                expect(Object.hasOwn(decoded.pluginCustomStorage, "__proto__")).toBe(false);
            }
        }

        const clientEncoded = await mocks.encodeRisuSaveLegacy(database, "compression");
        const serverEncoded = runServerCodec("encode", database) as Uint8Array;
        expect(clientEncoded[10]).toBe(8);
        expect(serverEncoded[10]).toBe(8);
        expect((await decodeRisuSave(clientEncoded))[LEGACY_ESCAPE_FIELD])
            .toEqual(validCollision);
        expect((runServerCodec("decode", serverEncoded) as any)[LEGACY_ESCAPE_FIELD])
            .toEqual(validCollision);
    });
});
