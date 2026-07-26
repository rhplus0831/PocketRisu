'use strict';

const nodeCrypto = require('crypto');
const {
    decodeRisuSave,
    encodeRisuSaveLegacy,
    normalizeJSON,
} = require('./utils.cjs');
const { walkRisuSave } = require('./streamRisuLoad.cjs');

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

function isOrdinaryObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate the structural contract traversed by chat externalization without
 * mutating the decoded database. Keep this shared between startup preflight
 * and the ingest/split boundary so a newly added traversal cannot silently
 * make preflight weaker than publication.
 */
function validateDatabaseShape(dbObj) {
    if (!isOrdinaryObject(dbObj)) {
        throw new TypeError('Database root must be a non-null object');
    }
    // Bootstrap's first durable save is the legacy empty `{}` envelope. An
    // absent characters field means an empty collection; a present non-array
    // field is structural corruption because migrations will iterate it.
    if (dbObj.characters === undefined) return dbObj;
    if (!Array.isArray(dbObj.characters)) {
        throw new TypeError('Database characters must be an array');
    }
    for (let characterIndex = 0; characterIndex < dbObj.characters.length; characterIndex++) {
        const character = dbObj.characters[characterIndex];
        // Legacy saves may contain null placeholders. Every migration traversal
        // already skips those via optional access; validate only structures it
        // will actually iterate.
        if (!isOrdinaryObject(character)) continue;
        if (character.chats !== undefined && !Array.isArray(character.chats)) {
            throw new TypeError(`Database character ${characterIndex} chats must be an array`);
        }
        if (character.chatFolders !== undefined && !Array.isArray(character.chatFolders)) {
            throw new TypeError(`Database character ${characterIndex} chatFolders must be an array`);
        }
        for (let chatIndex = 0; chatIndex < (character.chats?.length ?? 0); chatIndex++) {
            const chat = character.chats[chatIndex];
            if (!isOrdinaryObject(chat)) continue;
            if (chat.message !== undefined && !Array.isArray(chat.message)) {
                throw new TypeError(
                    `Database character ${characterIndex} chat ${chatIndex} message must be an array`
                );
            }
        }
    }
    return dbObj;
}

function assignMissingChatId(chat, makeId = nodeCrypto.randomUUID) {
    if (!chat || chat._stub || chat.id) return false;
    chat.id = makeId();
    return true;
}

function assignMissingChatIds(dbObj, makeId = nodeCrypto.randomUUID) {
    let changed = false;
    if (!dbObj?.characters) return changed;
    for (const char of dbObj.characters) {
        if (!char?.chats) continue;
        for (const chat of char.chats) {
            if (assignMissingChatId(chat, makeId)) changed = true;
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
            if (normalizeChatOrphanFolderId(chat, validIds)) changed = true;
        }
    }
    return changed;
}

function normalizeChatOrphanFolderId(chat, validIds) {
    if (!chat || !chat.folderId || validIds.has(chat.folderId)) return false;
    chat.folderId = null;
    return true;
}

function hasChatPayloads(dbObj) {
    if (!dbObj?.characters) return false;
    for (const char of dbObj.characters) {
        if (!char?.chats) continue;
        if (char.chats.some(chat => Array.isArray(chat?.message))) return true;
    }
    return false;
}

function findDuplicateChaIds(dbObj) {
    const duplicates = [];
    const seen = new Set();
    const reported = new Set();
    if (!Array.isArray(dbObj?.characters)) return duplicates;

    for (const character of dbObj.characters) {
        const chaId = character?.chaId;
        if (!chaId) continue;
        if (seen.has(chaId) && !reported.has(chaId)) {
            duplicates.push(chaId);
            reported.add(chaId);
        }
        seen.add(chaId);
    }
    return duplicates;
}

function dedupeCharacterIds(dbObj, makeId = nodeCrypto.randomUUID, state = {}) {
    const usedChaIds = state.usedChaIds ?? new Set();
    const seenCharacters = state.seenCharacters ?? new WeakSet();
    const reassignments = [];
    if (!Array.isArray(dbObj?.characters)) {
        return { reassignedDuplicateChaIds: 0, reassignments, usedChaIds, seenCharacters };
    }

    for (const character of dbObj.characters) {
        if (!character || (typeof character !== 'object' && typeof character !== 'function')) {
            continue;
        }
        if (seenCharacters.has(character)) continue;
        seenCharacters.add(character);

        const oldChaId = character.chaId;
        if (!oldChaId) continue;
        if (usedChaIds.has(oldChaId)) {
            let newChaId;
            do {
                newChaId = makeId();
            } while (!newChaId || usedChaIds.has(newChaId));
            character.chaId = newChaId;
            reassignments.push({ character, oldChaId, newChaId });
        }
        usedChaIds.add(character.chaId);
    }

    return {
        reassignedDuplicateChaIds: reassignments.length,
        reassignments,
        usedChaIds,
        seenCharacters,
    };
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

function createChatExternalizer(chaId, onPayload, makeId = nodeCrypto.randomUUID) {
    const seenChatIds = new Set();
    return function externalizeChat(chat) {
        if (!chat) return { chat, extracted: false };
        if (!Array.isArray(chat.message)) {
            if (chat.id) seenChatIds.add(chat.id);
            return { chat, extracted: false };
        }

        const payload = { ...chat };
        if (payload._stub === true) delete payload._stub;
        if (!payload.id || seenChatIds.has(payload.id)) {
            do {
                payload.id = makeId();
            } while (seenChatIds.has(payload.id));
        }
        seenChatIds.add(payload.id);

        onPayload(chaId, payload.id, payload);
        return { chat: chatToStub(payload), extracted: true };
    };
}

function extractPayloadChats(dbObj, onPayload, makeId = nodeCrypto.randomUUID) {
    let extracted = 0;
    if (!dbObj?.characters) return extracted;

    for (const char of dbObj.characters) {
        if (!char?.chaId || !char.chats) continue;
        const externalizeChat = createChatExternalizer(char.chaId, onPayload, makeId);
        for (let index = 0; index < char.chats.length; index++) {
            const result = externalizeChat(char.chats[index]);
            char.chats[index] = result.chat;
            if (result.extracted) extracted++;
        }
    }

    return extracted;
}

function splitFullDb(dbObj, makeId = nodeCrypto.randomUUID) {
    validateDatabaseShape(dbObj);
    const chatEntries = [];
    if (dbObj.characters === undefined) return { strippedDb: dbObj, chatEntries };

    const strippedDb = { ...dbObj };
    strippedDb.characters = dbObj.characters.map(char => {
        if (!char?.chaId || !char.chats) return char;
        return { ...char, chats: [...char.chats] };
    });
    extractPayloadChats(strippedDb, (chaId, chatId, chat) => {
        chatEntries.push({ chaId, chatId, chat });
    }, makeId);

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
        randomUUID = nodeCrypto.randomUUID,
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
        return extractPayloadChats(dbObj, writeChatRow, randomUUID);
    }

    function collectReassignedStubRowCopies(reassignments) {
        const copies = [];
        for (const { character, oldChaId, newChaId } of reassignments) {
            if (!Array.isArray(character?.chats)) continue;
            for (const chat of character.chats) {
                if (chat?._stub !== true || !chat.id) continue;
                const value = readChatRowRaw(oldChaId, chat.id);
                if (value !== null) {
                    copies.push({ newChaId, chatId: chat.id, value: Buffer.from(value) });
                }
            }
        }
        return copies;
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
        validateDatabaseShape(dbObj);
        const assignedMissingChatIds = assignMissingChatIds(dbObj, randomUUID);

        let restoreResult;
        if (opts.restoreColdStorageCharacters) {
            restoreResult = await opts.restoreColdStorageCharacters(dbObj);
        }

        const dedupeResult = dedupeCharacterIds(dbObj, randomUUID);
        const stubRowCopies = collectReassignedStubRowCopies(dedupeResult.reassignments);
        const normalizedOrphanFolderIds = normalizeOrphanFolderIds(dbObj);
        const { strippedDb, chatEntries } = splitFullDb(dbObj, randomUUID);
        const referencedKeys = referencedChatRowKeys(strippedDb);

        const staleKeys = listAllChatRowKeys().filter(key => !referencedKeys.has(key));
        // kvSet may enter the chunk store's nested transaction. better-sqlite3
        // implements it as a savepoint, so one failure still rolls back all rows.
        const persist = db.transaction(() => {
            kvSet(DB_BLOB_KEY, Buffer.from(encodeRisuSaveLegacy(strippedDb)));
            for (const copy of stubRowCopies) {
                writeChatRowRaw(copy.newChaId, copy.chatId, copy.value);
            }
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
                reassignedDuplicateChaIds: dedupeResult.reassignedDuplicateChaIds,
            },
        };
    }

    async function ingestStreamingDatabase(source, opts = {}) {
        // A standalone snapshot/defensive ingest owns its transaction. Backup
        // and save-folder imports already hold a broader transaction, in which
        // case all row writes naturally join that atomic unit.
        const canOwnTransaction = typeof db?.exec === 'function';
        const ownsTransaction = canOwnTransaction && !db.inTransaction;
        if (ownsTransaction) db.exec('BEGIN');

        let assignedMissingChatIds = false;
        let streamedOrphanFolderIds = false;
        let streamedChats = 0;
        let reassignedDuplicateChaIds = 0;
        const processors = new WeakMap();
        const validFolderIds = new WeakMap();
        const usedChaIds = new Set();
        const seenCharacters = new WeakSet();
        const reassignments = [];
        const reassignmentsByCharacter = new WeakMap();
        const reassignmentsByNewChaId = new Map();
        const copiedStubIds = new WeakMap();
        const externalizedReassignmentIds = new Set();
        const skipStubCopySweep = new WeakSet();
        const streamedCharacterChaIds = new WeakMap();

        const repairCharacterId = (character) => {
            const result = dedupeCharacterIds(
                { characters: [character] },
                randomUUID,
                { usedChaIds, seenCharacters }
            );
            reassignedDuplicateChaIds += result.reassignedDuplicateChaIds;
            for (const reassignment of result.reassignments) {
                reassignments.push(reassignment);
                reassignmentsByCharacter.set(character, reassignment);
                reassignmentsByNewChaId.set(reassignment.newChaId, reassignment);
            }
        };

        const copyStubRowForReassignedCharacter = (character, chat) => {
            if (chat?._stub !== true || !chat.id) return;
            const reassignment = reassignmentsByCharacter.get(character);
            if (!reassignment) return;
            let copiedIds = copiedStubIds.get(character);
            if (!copiedIds) {
                copiedIds = new Set();
                copiedStubIds.set(character, copiedIds);
            }
            if (copiedIds.has(chat.id)) return;
            const value = readChatRowRaw(reassignment.oldChaId, chat.id);
            if (value === null) return;
            writeChatRowRaw(reassignment.newChaId, chat.id, value);
            copiedIds.add(chat.id);
        };

        try {
            const walked = await walkRisuSave(source, {
                inspection: opts.inspection,
                tempDir: opts.tempDir,
                shouldAbort: opts.shouldAbort,
                externalizePluginStorage: typeof opts.onPluginStorageEntry === 'function',
                onPluginStorageEntry: opts.onPluginStorageEntry,
                onPluginStorageFolded: opts.onPluginStorageFolded,
                retainCharacterChats: (character) => Boolean(
                    opts.restoreColdStorageCharacters && character?.coldstorage
                ),
                onMissingChatId: () => {
                    assignedMissingChatIds = true;
                    return randomUUID();
                },
                onChat: ({ character, chat, externalizable }) => {
                    repairCharacterId(character);
                    const reassignment = reassignmentsByCharacter.get(character);
                    if (externalizable && reassignment) {
                        externalizedReassignmentIds.add(reassignment.newChaId);
                    }
                    copyStubRowForReassignedCharacter(character, chat);
                    if (!externalizable) return chat;

                    let validIds = validFolderIds.get(character);
                    if (!validIds) {
                        validIds = new Set(
                            (character.chatFolders ?? []).map(folder => folder?.id).filter(Boolean)
                        );
                        validFolderIds.set(character, validIds);
                    }
                    if (normalizeChatOrphanFolderId(chat, validIds)) {
                        streamedOrphanFolderIds = true;
                    }

                    let processChat = processors.get(character);
                    if (!processChat) {
                        processChat = createChatExternalizer(
                            character.chaId,
                            writeChatRow,
                            randomUUID
                        );
                        processors.set(character, processChat);
                    }
                    const result = processChat(chat);
                    if (result.extracted) streamedChats++;
                    return result.chat;
                },
            });
            const dbObj = walked.remainder;
            validateDatabaseShape(dbObj);
            if (typeof opts.onPluginStorageComplete === 'function') {
                await opts.onPluginStorageComplete({
                    dbObj,
                    pluginStats: walked.pluginStats,
                });
            }

            // walkRisuSave normalizes its remainder into fresh objects. Bind
            // their streamed state before the shared post-walk sweep.
            for (const character of dbObj.characters ?? []) {
                if (!Array.isArray(character?.chats) || character.chats.length === 0) continue;
                seenCharacters.add(character);
                streamedCharacterChaIds.set(character, character.chaId);
                const reassignment = reassignmentsByNewChaId.get(character.chaId);
                if (!reassignment) continue;
                const copiedIds = copiedStubIds.get(reassignment.character);
                reassignment.character = character;
                reassignmentsByCharacter.set(character, reassignment);
                if (copiedIds) copiedStubIds.set(character, copiedIds);
                if (externalizedReassignmentIds.has(reassignment.newChaId)) {
                    skipStubCopySweep.add(character);
                }
            }

            let restoreResult;
            if (opts.restoreColdStorageCharacters) {
                restoreResult = await opts.restoreColdStorageCharacters(dbObj);
            }

            for (const character of dbObj.characters ?? []) {
                if (streamedCharacterChaIds.has(character)) {
                    character.chaId = streamedCharacterChaIds.get(character);
                }
            }
            for (const reassignment of reassignments) {
                reassignment.character.chaId = reassignment.newChaId;
            }
            // Characters without chats are first observed here, so streaming
            // cannot always preserve array-order ownership of a duplicate ID.
            const sweepResult = dedupeCharacterIds(
                dbObj,
                randomUUID,
                { usedChaIds, seenCharacters }
            );
            reassignedDuplicateChaIds += sweepResult.reassignedDuplicateChaIds;
            for (const reassignment of sweepResult.reassignments) {
                reassignments.push(reassignment);
                reassignmentsByCharacter.set(reassignment.character, reassignment);
                reassignmentsByNewChaId.set(reassignment.newChaId, reassignment);
            }
            // Payload chats streamed above are now stubs too; only copy stubs
            // that still represent pre-existing rows under the old chaId.
            for (const { character } of reassignments) {
                if (skipStubCopySweep.has(character)) continue;
                if (!Array.isArray(character?.chats)) continue;
                for (const chat of character.chats) {
                    copyStubRowForReassignedCharacter(character, chat);
                }
            }

            const normalizedOrphanFolderIds = normalizeOrphanFolderIds(dbObj)
                || streamedOrphanFolderIds;
            // Ordinary characters already contain stubs. This second shared
            // pass handles chats introduced by cold-storage restoration and is
            // otherwise a no-op, preserving the legacy operation order.
            const restoredChats = extractPayloadChats(dbObj, writeChatRow, randomUUID);
            const referencedKeys = referencedChatRowKeys(dbObj);
            const staleKeys = listAllChatRowKeys().filter(key => !referencedKeys.has(key));

            kvSet(DB_BLOB_KEY, Buffer.from(encodeRisuSaveLegacy(dbObj)));
            for (const key of staleKeys) kvDel(key);
            kvSet(EXTERNALIZATION_MARKER_KEY, EXTERNALIZATION_MARKER_VALUE);

            if (ownsTransaction) db.exec('COMMIT');
            return {
                strippedDb: dbObj,
                pluginStats: walked.pluginStats,
                stats: {
                    ...(restoreResult || {}),
                    chats: streamedChats + restoredChats,
                    deletedStale: staleKeys.length,
                    assignedMissingChatIds,
                    normalizedOrphanFolderIds,
                    reassignedDuplicateChaIds,
                },
            };
        } catch (error) {
            if (ownsTransaction) {
                try { db.exec('ROLLBACK'); } catch (_) {}
            }
            throw error;
        }
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
        validateDatabaseShape,
        hasChatPayloads,
        referencedChatRowKeys,
        extractPayloadChats: extractAndWritePayloadChats,
        deleteRemovedChatRows,
        sweepOrphanChatRows,
        splitFullDb,
        assembleFullDb,
        assignMissingChatIds,
        dedupeCharacterIds,
        findDuplicateChaIds,
        normalizeOrphanFolderIds,
        ingestFullDatabase,
        ingestStreamingDatabase,
    };
}

module.exports = {
    createChatRowStore,
    chatRowKey,
    parseChatRowKey,
    chatToStub,
    validateDatabaseShape,
    mergeChatStubWithFullChat,
    hasChatPayloads,
    referencedChatRowKeys,
    extractPayloadChats,
    splitFullDb,
    assignMissingChatId,
    assignMissingChatIds,
    dedupeCharacterIds,
    findDuplicateChaIds,
    createChatExternalizer,
    normalizeOrphanFolderIds,
};
