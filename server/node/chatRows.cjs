'use strict';

const nodeCrypto = require('crypto');
const {
    decodeRisuSave,
    encodeRisuSaveLegacy,
    normalizeJSON,
} = require('./utils.cjs');

const DB_BLOB_KEY = 'database/database.bin';
const CHAT_PREFIX = 'chats/';
const EXTERNALIZATION_MARKER_KEY = 'migration/chats-externalized';
const EXTERNALIZATION_MARKER_VALUE = Buffer.from('done', 'utf-8');

function chatRowKey(chaId, chatId) {
    return `${CHAT_PREFIX}${encodeURIComponent(chaId)}/${encodeURIComponent(chatId)}`;
}

function parseChatRowKey(key) {
    if (typeof key !== 'string') return null;
    const match = key.match(/^chats\/([^/]*)\/([^/]*)$/);
    if (!match) return null;
    try {
        return {
            chaId: decodeURIComponent(match[1]),
            chatId: decodeURIComponent(match[2]),
        };
    } catch {
        return null;
    }
}

function chatToStub(chat) {
    if (!chat) return chat;
    if (chat._stub === true && !Array.isArray(chat.message)) return chat;
    const stub = {
        id: chat.id || '',
        name: chat.name ?? '',
        _stub: true,
    };
    if ('lastDate' in chat) stub.lastDate = chat.lastDate;
    if ('folderId' in chat) stub.folderId = chat.folderId;
    if ('modules' in chat) stub.modules = chat.modules;
    return stub;
}

function assignMissingChatIds(dbObj) {
    let changed = false;
    if (!dbObj?.characters) return changed;
    for (const char of dbObj.characters) {
        if (!char?.chats) continue;
        for (const chat of char.chats) {
            if (!chat || chat._stub || chat.id) continue;
            chat.id = nodeCrypto.randomUUID();
            changed = true;
        }
    }
    return changed;
}

function normalizeOrphanFolderIds(dbObj) {
    let changed = false;
    if (!dbObj?.characters) return changed;
    for (const char of dbObj.characters) {
        if (!char?.chats) continue;
        const validIds = new Set((char.chatFolders ?? []).map(f => f?.id).filter(Boolean));
        for (const chat of char.chats) {
            if (!chat) continue;
            if (chat.folderId && !validIds.has(chat.folderId)) {
                chat.folderId = null;
                changed = true;
            }
        }
    }
    return changed;
}

function hasChatPayloads(dbObj) {
    if (!dbObj?.characters) return false;
    for (const char of dbObj.characters) {
        if (!char?.chats) continue;
        if (char.chats.some(chat => Array.isArray(chat?.message))) return true;
    }
    return false;
}

function referencedChatRowKeys(dbObj) {
    const keys = new Set();
    if (!dbObj?.characters) return keys;
    for (const char of dbObj.characters) {
        if (!char?.chaId || !char.chats) continue;
        for (const chat of char.chats) {
            if (chat?._stub === true && chat.id) {
                keys.add(chatRowKey(char.chaId, chat.id));
            }
        }
    }
    return keys;
}

function extractPayloadChats(dbObj, onPayload) {
    let extracted = 0;
    if (!dbObj?.characters) return extracted;

    for (const char of dbObj.characters) {
        if (!char?.chaId || !char.chats) continue;
        const seenChatIds = new Set();
        for (let index = 0; index < char.chats.length; index++) {
            const chat = char.chats[index];
            if (!chat) continue;
            if (!Array.isArray(chat.message)) {
                if (chat.id) seenChatIds.add(chat.id);
                continue;
            }

            const payload = { ...chat };
            if (payload._stub === true) delete payload._stub;
            if (!payload.id || seenChatIds.has(payload.id)) {
                do {
                    payload.id = nodeCrypto.randomUUID();
                } while (seenChatIds.has(payload.id));
            }
            seenChatIds.add(payload.id);

            onPayload(char.chaId, payload.id, payload);
            char.chats[index] = chatToStub(payload);
            extracted++;
        }
    }

    return extracted;
}

function splitFullDb(dbObj) {
    const chatEntries = [];
    if (!dbObj?.characters) return { strippedDb: dbObj, chatEntries };

    const strippedDb = { ...dbObj };
    strippedDb.characters = dbObj.characters.map(char => {
        if (!char?.chaId || !char.chats) return char;
        return { ...char, chats: [...char.chats] };
    });
    extractPayloadChats(strippedDb, (chaId, chatId, chat) => {
        chatEntries.push({ chaId, chatId, chat });
    });

    return { strippedDb, chatEntries };
}

function mergeChatStubWithFullChat(stub, fullChat) {
    if (!fullChat) return stub;
    if (!stub || stub._stub !== true) return fullChat;

    const merged = {
        ...fullChat,
        id: stub.id || fullChat.id || '',
        name: stub.name,
    };
    if ('_stub' in merged) delete merged._stub;
    if ('lastDate' in stub) merged.lastDate = stub.lastDate;
    if ('folderId' in stub) merged.folderId = stub.folderId;
    if ('modules' in stub) merged.modules = stub.modules;
    return merged;
}

function createChatRowStore(options) {
    const {
        db,
        kvGet,
        kvSet,
        kvDel,
        kvList,
        kvListWithSizes,
        kvGetUpdatedAt = () => null,
    } = options;

    async function readChatRow(chaId, chatId) {
        const value = readChatRowRaw(chaId, chatId);
        if (value === null) return null;
        return decodeRisuSave(value);
    }

    function readChatRowRaw(chaId, chatId) {
        return kvGet(chatRowKey(chaId, chatId));
    }

    function writeChatRow(chaId, chatId, chatObj) {
        kvSet(chatRowKey(chaId, chatId), Buffer.from(encodeRisuSaveLegacy(chatObj)));
    }

    function writeChatRowRaw(chaId, chatId, buffer) {
        kvSet(chatRowKey(chaId, chatId), Buffer.from(buffer));
    }

    function deleteChatRow(chaId, chatId) {
        kvDel(chatRowKey(chaId, chatId));
    }

    function listChatRowKeysForChar(chaId) {
        return kvList(`${CHAT_PREFIX}${encodeURIComponent(chaId)}/`);
    }

    function listAllChatRowKeys() {
        return kvList(CHAT_PREFIX);
    }

    function deleteChatRowsForChar(chaId) {
        const keys = listChatRowKeysForChar(chaId);
        const run = db.transaction(() => {
            for (const key of keys) kvDel(key);
        });
        run();
        return keys.length;
    }

    function chatBytesForChar(chaId) {
        return kvListWithSizes(`${CHAT_PREFIX}${encodeURIComponent(chaId)}/`)
            .reduce((sum, entry) => sum + entry.size, 0);
    }

    function extractAndWritePayloadChats(dbObj) {
        return extractPayloadChats(dbObj, writeChatRow);
    }

    function deleteRemovedChatRows(oldStrippedDb, newStrippedDb) {
        const oldKeys = referencedChatRowKeys(oldStrippedDb);
        const newKeys = referencedChatRowKeys(newStrippedDb);
        const removedKeys = [...oldKeys].filter(key => !newKeys.has(key));
        if (removedKeys.length === 0) return 0;

        db.transaction(() => {
            for (const key of removedKeys) kvDel(key);
        })();
        return removedKeys.length;
    }

    function sweepOrphanChatRows(strippedDb, opts = {}) {
        const now = opts.now ?? Date.now();
        const graceMs = opts.graceMs ?? 60 * 60 * 1000;
        const cutoff = now - graceMs;
        const referencedKeys = referencedChatRowKeys(strippedDb);
        const deleteKeys = [];
        let skippedRecent = 0;

        for (const key of listAllChatRowKeys()) {
            if (referencedKeys.has(key)) continue;
            const updatedAt = kvGetUpdatedAt(key);
            if (Number.isFinite(updatedAt) && updatedAt > cutoff) {
                skippedRecent++;
                continue;
            }
            deleteKeys.push(key);
        }

        if (deleteKeys.length > 0) {
            db.transaction(() => {
                for (const key of deleteKeys) kvDel(key);
            })();
        }
        return { deleted: deleteKeys.length, skippedRecent };
    }

    async function assembleFullDb(strippedDb) {
        if (!strippedDb || typeof strippedDb !== 'object') return strippedDb;
        const fullDb = { ...strippedDb };
        if (!strippedDb.characters) return fullDb;
        fullDb.characters = [];

        for (const char of strippedDb.characters) {
            if (!char?.chaId || !char.chats) {
                fullDb.characters.push(char);
                continue;
            }
            const chats = [];
            for (const chat of char.chats) {
                if (chat && chat._stub === true && chat.id) {
                    const fullChat = await readChatRow(char.chaId, chat.id);
                    chats.push(mergeChatStubWithFullChat(chat, fullChat));
                } else {
                    chats.push(chat);
                }
            }
            fullDb.characters.push({ ...char, chats });
        }

        return fullDb;
    }

    async function ingestFullDatabase(raw, opts = {}) {
        let source = raw;
        if (opts.beforeDecode) {
            const fresh = await opts.beforeDecode();
            if (Buffer.isBuffer(fresh)) source = fresh;
        }

        const decoded = Buffer.isBuffer(source) || source instanceof Uint8Array
            ? await decodeRisuSave(source)
            : source;
        const dbObj = normalizeJSON(decoded);
        const assignedMissingChatIds = assignMissingChatIds(dbObj);

        let restoreResult;
        if (opts.restoreColdStorageCharacters) {
            restoreResult = await opts.restoreColdStorageCharacters(dbObj);
        }

        const normalizedOrphanFolderIds = normalizeOrphanFolderIds(dbObj);
        const { strippedDb, chatEntries } = splitFullDb(dbObj);
        const referencedKeys = referencedChatRowKeys(strippedDb);

        const staleKeys = listAllChatRowKeys().filter(key => !referencedKeys.has(key));
        // kvSet may enter the chunk store's nested transaction. better-sqlite3
        // implements it as a savepoint, so one failure still rolls back all rows.
        const persist = db.transaction(() => {
            kvSet(DB_BLOB_KEY, Buffer.from(encodeRisuSaveLegacy(strippedDb)));
            for (const entry of chatEntries) {
                writeChatRow(entry.chaId, entry.chatId, entry.chat);
            }
            for (const key of staleKeys) kvDel(key);
            kvSet(EXTERNALIZATION_MARKER_KEY, EXTERNALIZATION_MARKER_VALUE);
        });
        persist();

        return {
            strippedDb,
            stats: {
                ...(restoreResult || {}),
                chats: chatEntries.length,
                deletedStale: staleKeys.length,
                assignedMissingChatIds,
                normalizedOrphanFolderIds,
            },
        };
    }

    return {
        chatRowKey,
        parseChatRowKey,
        readChatRow,
        readChatRowRaw,
        writeChatRow,
        writeChatRowRaw,
        deleteChatRow,
        deleteChatRowsForChar,
        listChatRowKeysForChar,
        listAllChatRowKeys,
        chatBytesForChar,
        chatToStub,
        hasChatPayloads,
        referencedChatRowKeys,
        extractPayloadChats: extractAndWritePayloadChats,
        deleteRemovedChatRows,
        sweepOrphanChatRows,
        splitFullDb,
        assembleFullDb,
        assignMissingChatIds,
        normalizeOrphanFolderIds,
        ingestFullDatabase,
    };
}

module.exports = {
    createChatRowStore,
    chatRowKey,
    parseChatRowKey,
    chatToStub,
    hasChatPayloads,
    referencedChatRowKeys,
    extractPayloadChats,
    splitFullDb,
    assignMissingChatIds,
    normalizeOrphanFolderIds,
};
