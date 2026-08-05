'use strict';

const nodeCrypto = require('crypto');
const fs = require('node:fs/promises');
const { Unpackr } = require('msgpackr');
const {
    decodeRisuSave,
    encodeRisuSaveLegacy,
    normalizeJSON,
} = require('./utils.cjs');
const { walkRisuSave } = require('./streamRisuLoad.cjs');
const {
    CHARACTER_DEFAULTS_MARKER_KEY,
    CHARACTER_DEFAULTS_MARKER_VALUE,
    applyDatabaseCharacterDefaults,
} = require('./characterDefaults.cjs');
const {
    CHAT_DELTA_FORMAT,
    CHAT_DELTA_PATCH_CONTENT_TYPE,
    applyValidatedChatDelta,
    validateChatDeltaPayload,
} = require('./chatDelta.cjs');

const DB_BLOB_KEY = 'database/database.bin';
const CHAT_PREFIX = 'chats/';
const CHAT_ROW_METADATA_TABLE = 'chat_row_metadata';
const CHAT_ROW_OPERATIONS_TABLE = 'chat_row_operations';
const EXTERNALIZATION_MARKER_KEY = 'migration/chats-externalized';
const EXTERNALIZATION_MARKER_VALUE = Buffer.from('done', 'utf-8');
const COLD_STORAGE_HEADER = '\uEF01COLDSTORAGE\uEF01';
const LEGACY_RAW_HEADER = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7]);
const chatRowUnpackr = new Unpackr({
    copyBuffers: true,
    int64AsType: 'number',
    useRecords: false,
});

function isCanonicalRawChatRow(bytes) {
    return Buffer.isBuffer(bytes)
        && bytes.length > LEGACY_RAW_HEADER.length
        && bytes.subarray(0, LEGACY_RAW_HEADER.length).equals(LEGACY_RAW_HEADER);
}

function decodeCanonicalRawChatRow(bytes) {
    if (!isCanonicalRawChatRow(bytes)) {
        const error = new Error('Chat operation logs require a canonical raw base row');
        error.code = 'CHAT_DELTA_LOG_UNSUPPORTED';
        throw error;
    }
    return chatRowUnpackr.decode(bytes.subarray(LEGACY_RAW_HEADER.length));
}

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

function isColdStorageChat(chat) {
    return chat?.message?.[0]?.data?.startsWith(COLD_STORAGE_HEADER) === true;
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

function findDuplicateChatIds(dbObj) {
    const duplicates = [];
    if (!Array.isArray(dbObj?.characters)) return duplicates;

    for (let characterIndex = 0; characterIndex < dbObj.characters.length; characterIndex++) {
        const character = dbObj.characters[characterIndex];
        if (!Array.isArray(character?.chats)) continue;
        const firstIndexById = new Map();
        for (let chatIndex = 0; chatIndex < character.chats.length; chatIndex++) {
            const chatId = character.chats[chatIndex]?.id;
            if (typeof chatId !== 'string' || chatId.length === 0) continue;
            const firstIndex = firstIndexById.get(chatId);
            if (firstIndex === undefined) {
                firstIndexById.set(chatId, chatIndex);
                continue;
            }
            duplicates.push({
                chaId: character.chaId ?? null,
                characterIndex,
                chatId,
                firstIndex,
                duplicateIndex: chatIndex,
            });
        }
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

function removedChatRowKeys(oldStrippedDb, newStrippedDb) {
    const oldKeys = referencedChatRowKeys(oldStrippedDb);
    const newKeys = referencedChatRowKeys(newStrippedDb);
    return [...oldKeys].filter(key => !newKeys.has(key));
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
        kvGetAsync = async (key) => kvGet(key),
        kvSet,
        kvSetFromFile = null,
        kvDel,
        kvList,
        kvListWithSizes,
        kvWriteToFile,
        kvSize,
        kvGetUpdatedAt = () => null,
        randomUUID = nodeCrypto.randomUUID,
        chatDeltaCompactMaxOperations = 64,
        chatDeltaCompactMaxBytes = 1024 * 1024,
        chatDeltaCompactionFailpoint = null,
    } = options;

    // Metadata and the authoritative operation-log extension live outside the
    // public logical KV namespace. Full/direct row mutations clear the log and
    // invalidate metadata through KV triggers; store-owned full writers then
    // republish logical-row metadata in that same outer transaction. Existing
    // chat KV rows therefore start as valid bases with an empty log and need no
    // data migration.
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${CHAT_ROW_METADATA_TABLE} (
        row_key        TEXT PRIMARY KEY,
        row_token      TEXT NOT NULL,
        content_sha256 TEXT CHECK (
          content_sha256 IS NULL OR (
            length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
          )
        ),
        content_size   INTEGER CHECK (content_size IS NULL OR content_size >= 0),
        cold_storage  INTEGER CHECK (cold_storage IS NULL OR cold_storage IN (0, 1)),
        message_count INTEGER CHECK (message_count IS NULL OR message_count >= 0),
        log_supported INTEGER CHECK (log_supported IS NULL OR log_supported IN (0, 1)),
        log_count     INTEGER NOT NULL DEFAULT 0 CHECK (log_count >= 0),
        log_bytes     INTEGER NOT NULL DEFAULT 0 CHECK (log_bytes >= 0),
        CHECK (
          (content_sha256 IS NULL AND content_size IS NULL AND cold_storage IS NULL)
          OR
          (content_sha256 IS NOT NULL AND content_size IS NOT NULL AND cold_storage IS NOT NULL)
        )
      );
    `);
    const metadataColumns = new Set(
        db.prepare(`PRAGMA table_info(${CHAT_ROW_METADATA_TABLE})`).all().map((row) => row.name)
    );
    const metadataColumnMigrations = [
        ['message_count', 'INTEGER CHECK (message_count IS NULL OR message_count >= 0)'],
        ['log_supported', 'INTEGER CHECK (log_supported IS NULL OR log_supported IN (0, 1))'],
        ['log_count', 'INTEGER NOT NULL DEFAULT 0 CHECK (log_count >= 0)'],
        ['log_bytes', 'INTEGER NOT NULL DEFAULT 0 CHECK (log_bytes >= 0)'],
    ];
    for (const [column, definition] of metadataColumnMigrations) {
        if (!metadataColumns.has(column)) {
            db.exec(`ALTER TABLE ${CHAT_ROW_METADATA_TABLE} ADD COLUMN ${column} ${definition}`);
        }
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${CHAT_ROW_OPERATIONS_TABLE} (
        row_key        TEXT NOT NULL,
        sequence       INTEGER NOT NULL CHECK (sequence > 0),
        format         TEXT NOT NULL,
        content_type   TEXT NOT NULL,
        base_sha256    TEXT NOT NULL CHECK (
          length(base_sha256) = 64 AND base_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        result_sha256  TEXT NOT NULL CHECK (
          length(result_sha256) = 64 AND result_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        result_size    INTEGER NOT NULL CHECK (result_size > 0),
        patch_json     TEXT NOT NULL,
        patch_bytes    INTEGER NOT NULL CHECK (patch_bytes > 0),
        created_at     INTEGER NOT NULL,
        PRIMARY KEY (row_key, sequence)
      );
      CREATE INDEX IF NOT EXISTS pocketrisu_chat_row_operations_row
        ON ${CHAT_ROW_OPERATIONS_TABLE}(row_key, sequence);

      DROP TRIGGER IF EXISTS pocketrisu_chat_row_metadata_insert;
      DROP TRIGGER IF EXISTS pocketrisu_chat_row_metadata_update;
      DROP TRIGGER IF EXISTS pocketrisu_chat_row_metadata_delete;
      CREATE TRIGGER IF NOT EXISTS pocketrisu_chat_row_metadata_insert
      AFTER INSERT ON kv
      WHEN NEW.key LIKE 'chats/%'
      BEGIN
        DELETE FROM ${CHAT_ROW_OPERATIONS_TABLE} WHERE row_key = NEW.key;
        INSERT INTO ${CHAT_ROW_METADATA_TABLE} (row_key, row_token)
        VALUES (NEW.key, lower(hex(randomblob(16))))
        ON CONFLICT(row_key) DO UPDATE SET
          row_token = lower(hex(randomblob(16))),
          content_sha256 = NULL,
          content_size = NULL,
          cold_storage = NULL,
          message_count = NULL,
          log_supported = NULL,
          log_count = 0,
          log_bytes = 0;
      END;

      CREATE TRIGGER IF NOT EXISTS pocketrisu_chat_row_metadata_update
      AFTER UPDATE OF key, value ON kv
      WHEN OLD.key LIKE 'chats/%' OR NEW.key LIKE 'chats/%'
      BEGIN
        DELETE FROM ${CHAT_ROW_OPERATIONS_TABLE}
         WHERE row_key = OLD.key OR row_key = NEW.key;
        DELETE FROM ${CHAT_ROW_METADATA_TABLE} WHERE row_key = OLD.key;
        INSERT INTO ${CHAT_ROW_METADATA_TABLE} (row_key, row_token)
        SELECT NEW.key, lower(hex(randomblob(16))) WHERE NEW.key LIKE 'chats/%'
        ON CONFLICT(row_key) DO UPDATE SET
          row_token = lower(hex(randomblob(16))),
          content_sha256 = NULL,
          content_size = NULL,
          cold_storage = NULL,
          message_count = NULL,
          log_supported = NULL,
          log_count = 0,
          log_bytes = 0;
      END;

      CREATE TRIGGER IF NOT EXISTS pocketrisu_chat_row_metadata_delete
      AFTER DELETE ON kv
      WHEN OLD.key LIKE 'chats/%'
      BEGIN
        DELETE FROM ${CHAT_ROW_OPERATIONS_TABLE} WHERE row_key = OLD.key;
        DELETE FROM ${CHAT_ROW_METADATA_TABLE} WHERE row_key = OLD.key;
      END;
    `);
    const selectChatRowMetadata = db.prepare(`
      SELECT row_token, content_sha256, content_size, cold_storage,
             message_count, log_supported, log_count, log_bytes
        FROM ${CHAT_ROW_METADATA_TABLE}
       WHERE row_key = ?
    `);
    const ensureChatRowMetadataSlot = db.prepare(`
      INSERT OR IGNORE INTO ${CHAT_ROW_METADATA_TABLE} (row_key, row_token)
      SELECT key, lower(hex(randomblob(16))) FROM kv WHERE key = ?
    `);
    const publishChatRowMetadata = db.prepare(`
      UPDATE ${CHAT_ROW_METADATA_TABLE}
         SET content_sha256 = ?, content_size = ?, cold_storage = ?,
             message_count = ?, log_supported = ?, log_count = 0, log_bytes = 0
       WHERE row_key = ?
    `);
    const repairSelectedChatRowMetadata = db.prepare(`
      UPDATE ${CHAT_ROW_METADATA_TABLE}
         SET content_sha256 = ?, content_size = ?, cold_storage = ?,
             message_count = ?, log_supported = ?
       WHERE row_key = ? AND row_token = ?
    `);
    const selectChatRowOperations = db.prepare(`
      SELECT sequence, format, content_type, base_sha256, result_sha256,
             result_size, patch_json, patch_bytes, created_at
        FROM ${CHAT_ROW_OPERATIONS_TABLE}
       WHERE row_key = ?
       ORDER BY sequence
    `);
    const insertChatRowOperation = db.prepare(`
      INSERT INTO ${CHAT_ROW_OPERATIONS_TABLE} (
        row_key, sequence, format, content_type, base_sha256, result_sha256,
        result_size, patch_json, patch_bytes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const publishChatDeltaMetadata = db.prepare(`
      UPDATE ${CHAT_ROW_METADATA_TABLE}
         SET row_token = ?, content_sha256 = ?, content_size = ?, cold_storage = 0,
             message_count = ?, log_supported = 1,
             log_count = log_count + 1, log_bytes = log_bytes + ?
       WHERE row_key = ? AND row_token = ? AND content_sha256 = ?
    `);
    const summarizeChatRowOperations = db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(patch_bytes), 0) AS bytes,
             MIN(sequence) AS first_sequence, MAX(sequence) AS last_sequence
        FROM ${CHAT_ROW_OPERATIONS_TABLE}
       WHERE row_key = ?
    `);
    const selectChatRowOperationTail = db.prepare(`
      SELECT base_sha256, result_sha256
        FROM ${CHAT_ROW_OPERATIONS_TABLE}
       WHERE row_key = ?
       ORDER BY sequence DESC
       LIMIT 1
    `);

    function contentDigest(buffer) {
        return nodeCrypto.createHash('sha256').update(buffer).digest('hex');
    }

    function metadataForKey(key) {
        const metadata = selectChatRowMetadata.get(key);
        if (!metadata) return null;
        return {
            rowToken: metadata.row_token,
            contentHash: metadata.content_sha256,
            contentSize: metadata.content_size,
            coldStorage: metadata.cold_storage === null
                ? null
                : metadata.cold_storage === 1,
            messageCount: metadata.message_count,
            logSupported: metadata.log_supported === null
                ? null
                : metadata.log_supported === 1,
            logCount: metadata.log_count,
            logBytes: metadata.log_bytes,
        };
    }

    function operationEntriesForKey(key) {
        return selectChatRowOperations.all(key);
    }

    function materializeChatRowBytesFromState(key, baseBytes, operations, metadata) {
        if (baseBytes === null) return null;
        if (operations.length === 0) return baseBytes;
        if (!metadata
            || metadata.logSupported !== true
            || metadata.logCount !== operations.length
            || !Number.isSafeInteger(metadata.logBytes)
            || metadata.logBytes < 0
            || !/^[0-9a-f]{64}$/.test(metadata.contentHash ?? '')
            || !Number.isSafeInteger(metadata.contentSize)
            || metadata.contentSize <= 0) {
            const error = new Error(`Chat operation metadata is incomplete for ${key}`);
            error.code = 'CHAT_DELTA_LOG_CORRUPT';
            throw error;
        }

        let declaredHash = contentDigest(baseBytes);
        let messageCount;
        let document = normalizeJSON(decodeCanonicalRawChatRow(baseBytes));
        if (!document || typeof document !== 'object' || !Array.isArray(document.message)) {
            const error = new Error(`Chat operation base is structurally invalid for ${key}`);
            error.code = 'CHAT_DELTA_LOG_CORRUPT';
            throw error;
        }
        messageCount = document.message.length;

        for (let index = 0; index < operations.length; index++) {
            const entry = operations[index];
            if (entry.sequence !== index + 1
                || entry.format !== CHAT_DELTA_FORMAT
                || entry.content_type !== CHAT_DELTA_PATCH_CONTENT_TYPE
                || entry.base_sha256 !== declaredHash
                || Buffer.byteLength(entry.patch_json, 'utf-8') !== entry.patch_bytes) {
                const error = new Error(`Chat operation chain is invalid for ${key}`);
                error.code = 'CHAT_DELTA_LOG_CORRUPT';
                throw error;
            }
            let patch;
            try {
                patch = JSON.parse(entry.patch_json);
            } catch (cause) {
                const error = new Error(`Chat operation JSON is invalid for ${key}`, { cause });
                error.code = 'CHAT_DELTA_LOG_CORRUPT';
                throw error;
            }
            let validated;
            try {
                validated = validateChatDeltaPayload({
                    version: 1,
                    baseHash: entry.base_sha256,
                    resultHash: entry.result_sha256,
                    resultSize: entry.result_size,
                    patch,
                }, { baseMessageCount: messageCount });
                document = applyValidatedChatDelta(document, validated.patch);
            } catch (cause) {
                const error = new Error(`Chat operation cannot be applied for ${key}`, { cause });
                error.code = 'CHAT_DELTA_LOG_CORRUPT';
                throw error;
            }
            messageCount = validated.messageCount;
            declaredHash = entry.result_sha256;
        }

        const materialized = Buffer.from(encodeRisuSaveLegacy(normalizeJSON(document)));
        const actualHash = contentDigest(materialized);
        if (actualHash !== declaredHash
            || actualHash !== metadata.contentHash
            || materialized.length !== metadata.contentSize
            || messageCount !== metadata.messageCount) {
            const error = new Error(`Chat operation materialization digest mismatch for ${key}`);
            error.code = 'CHAT_DELTA_LOG_CORRUPT';
            throw error;
        }
        return materialized;
    }

    function materializeChatRowBytes(key, baseBytes) {
        return materializeChatRowBytesFromState(
            key,
            baseBytes,
            operationEntriesForKey(key),
            metadataForKey(key),
        );
    }

    function materializeChatRowBytesFromReader(reader, key) {
        if (!reader || typeof reader.kvGet !== 'function') {
            throw new TypeError('A pinned KV reader is required to materialize a chat row');
        }
        const baseBytes = reader.kvGet(key);
        const operations = typeof reader.chatRowOperationEntries === 'function'
            ? reader.chatRowOperationEntries(key)
            : [];
        const rawMetadata = typeof reader.chatRowMetadata === 'function'
            ? reader.chatRowMetadata(key)
            : null;
        const metadata = rawMetadata === null ? null : {
            rowToken: rawMetadata.rowToken ?? rawMetadata.row_token,
            contentHash: rawMetadata.contentHash ?? rawMetadata.content_sha256,
            contentSize: rawMetadata.contentSize ?? rawMetadata.content_size,
            coldStorage: typeof (rawMetadata.coldStorage ?? rawMetadata.cold_storage) === 'boolean'
                ? (rawMetadata.coldStorage ?? rawMetadata.cold_storage)
                : (rawMetadata.coldStorage ?? rawMetadata.cold_storage) === null
                    ? null
                    : (rawMetadata.coldStorage ?? rawMetadata.cold_storage) === 1,
            messageCount: rawMetadata.messageCount ?? rawMetadata.message_count,
            logSupported: typeof (rawMetadata.logSupported ?? rawMetadata.log_supported) === 'boolean'
                ? (rawMetadata.logSupported ?? rawMetadata.log_supported)
                : (rawMetadata.logSupported ?? rawMetadata.log_supported) === null
                    ? null
                    : (rawMetadata.logSupported ?? rawMetadata.log_supported) === 1,
            logCount: rawMetadata.logCount ?? rawMetadata.log_count,
            logBytes: rawMetadata.logBytes ?? rawMetadata.log_bytes,
        };
        return materializeChatRowBytesFromState(key, baseBytes, operations, metadata);
    }

    const persistOwnedChatRow = db.transaction((
        key,
        buffer,
        coldStorage,
        messageCount,
        logSupported,
    ) => {
        const digest = contentDigest(buffer);
        kvSet(key, buffer);
        if (typeof coldStorage === 'boolean'
            && Number.isSafeInteger(messageCount)
            && messageCount >= 0
            && typeof logSupported === 'boolean') {
            const published = publishChatRowMetadata.run(
                digest,
                buffer.length,
                coldStorage ? 1 : 0,
                messageCount,
                logSupported ? 1 : 0,
                key,
            );
            if (published.changes !== 1) {
                throw new Error(`Chat row metadata slot was not published for ${key}`);
            }
        }
        return digest;
    });
    const persistOwnedChatRowIfToken = db.transaction((
        key,
        expectedToken,
        buffer,
        coldStorage,
        messageCount,
        logSupported,
    ) => {
        if (metadataForKey(key)?.rowToken !== expectedToken) return null;
        return persistOwnedChatRow(
            key,
            buffer,
            coldStorage,
            messageCount,
            logSupported,
        );
    });
    const persistChatRowFromFile = db.transaction((
        key,
        filePath,
        coldStorage,
        messageCount,
        logSupported,
        expectedHash,
        chunkPlan,
    ) => {
        if (typeof kvSetFromFile !== 'function') {
            throw new TypeError('kvSetFromFile is required for file-backed chat writes');
        }
        const result = kvSetFromFile(key, filePath, { chunkPlan });
        const digest = result?.sha256 ?? expectedHash;
        if (!/^[0-9a-f]{64}$/.test(digest ?? '')
            || (expectedHash && digest !== expectedHash)) {
            throw new Error(`Chat row file digest did not match its prepared source for ${key}`);
        }
        if (typeof coldStorage === 'boolean'
            && Number.isSafeInteger(messageCount)
            && messageCount >= 0
            && typeof logSupported === 'boolean') {
            const published = publishChatRowMetadata.run(
                digest,
                result.size,
                coldStorage ? 1 : 0,
                messageCount,
                logSupported ? 1 : 0,
                key,
            );
            if (published.changes !== 1) {
                throw new Error(`Chat row metadata slot was not published for ${key}`);
            }
        }
        return digest;
    });

    function prepareChatDeltaAppend(key, payload, maxResultBytes) {
        ensureChatRowMetadataSlot.run(key);
        const metadata = metadataForKey(key);
        if (!metadata) {
            return { applied: false, code: 'CHAT_DELTA_BASE_MISSING' };
        }
        if (metadata.logSupported !== true
            || metadata.coldStorage !== false
            || !Number.isSafeInteger(metadata.messageCount)
            || metadata.messageCount < 0
            || !/^[0-9a-f]{64}$/.test(metadata.contentHash ?? '')) {
            return { applied: false, code: 'CHAT_DELTA_BASE_UNAVAILABLE' };
        }
        const validated = validateChatDeltaPayload(payload, {
            baseMessageCount: metadata.messageCount,
            maxResultBytes,
        });
        if (validated.baseHash !== metadata.contentHash) {
            return {
                applied: false,
                code: 'CHAT_DELTA_BASE_MISMATCH',
                currentHash: metadata.contentHash,
            };
        }
        const summary = summarizeChatRowOperations.get(key);
        const expectedCount = metadata.logCount;
        const tail = expectedCount > 0 ? selectChatRowOperationTail.get(key) : null;
        if (summary.count !== expectedCount
            || summary.bytes !== metadata.logBytes
            || (expectedCount > 0 && (
                summary.first_sequence !== 1
                || summary.last_sequence !== expectedCount
                || tail?.result_sha256 !== metadata.contentHash
            ))) {
            return { applied: false, code: 'CHAT_DELTA_LOG_CONFLICT' };
        }

        return { applied: true, metadata, validated };
    }

    const appendChatDeltaTransaction = db.transaction((key, payload, maxResultBytes) => {
        const prepared = prepareChatDeltaAppend(key, payload, maxResultBytes);
        if (!prepared.applied) return prepared;
        const { metadata, validated } = prepared;
        const expectedCount = metadata.logCount;
        const sequence = expectedCount + 1;
        insertChatRowOperation.run(
            key,
            sequence,
            CHAT_DELTA_FORMAT,
            CHAT_DELTA_PATCH_CONTENT_TYPE,
            validated.baseHash,
            validated.resultHash,
            validated.resultSize,
            validated.patchJson,
            validated.patchBytes,
            Date.now(),
        );
        const nextToken = String(randomUUID()).replaceAll('-', '').toLowerCase();
        const published = publishChatDeltaMetadata.run(
            nextToken,
            validated.resultHash,
            validated.resultSize,
            validated.messageCount,
            validated.patchBytes,
            key,
            metadata.rowToken,
            metadata.contentHash,
        );
        if (published.changes !== 1) {
            const error = new Error(`Chat delta metadata changed before append for ${key}`);
            error.code = 'CHAT_DELTA_LOG_CONFLICT';
            throw error;
        }
        const logCount = sequence;
        const logBytes = metadata.logBytes + validated.patchBytes;
        return {
            applied: true,
            hash: validated.resultHash,
            size: validated.resultSize,
            logCount,
            logBytes,
            shouldCompact: logCount >= chatDeltaCompactMaxOperations
                || logBytes >= chatDeltaCompactMaxBytes,
        };
    });

    function appendChatDelta(chaId, chatId, payload, { maxResultBytes } = {}) {
        return appendChatDeltaTransaction(
            chatRowKey(chaId, chatId),
            payload,
            Number.isSafeInteger(maxResultBytes) && maxResultBytes > 0
                ? maxResultBytes
                : Number.MAX_SAFE_INTEGER,
        );
    }

    function inspectChatDelta(chaId, chatId, payload, { maxResultBytes } = {}) {
        const prepared = prepareChatDeltaAppend(
            chatRowKey(chaId, chatId),
            payload,
            Number.isSafeInteger(maxResultBytes) && maxResultBytes > 0
                ? maxResultBytes
                : Number.MAX_SAFE_INTEGER,
        );
        if (!prepared.applied) return prepared;
        return { applied: true };
    }

    const publishCompactedChatRow = db.transaction((key, expectedToken, materialized, metadata) => {
        if (metadataForKey(key)?.rowToken !== expectedToken) return false;
        chatDeltaCompactionFailpoint?.('before-base-write', key);
        const hash = persistOwnedChatRow(
            key,
            materialized,
            metadata.coldStorage,
            metadata.messageCount,
            true,
        );
        if (hash !== metadata.contentHash || materialized.length !== metadata.contentSize) {
            throw new Error(`Compacted chat row changed logical bytes for ${key}`);
        }
        chatDeltaCompactionFailpoint?.('after-base-write', key);
        return true;
    });

    function compactChatRow(chaId, chatId, { force = false } = {}) {
        const key = chatRowKey(chaId, chatId);
        const metadata = metadataForKey(key);
        if (!metadata || metadata.logCount === 0) return { compacted: false, reason: 'empty' };
        if (!force
            && metadata.logCount < chatDeltaCompactMaxOperations
            && metadata.logBytes < chatDeltaCompactMaxBytes) {
            return { compacted: false, reason: 'below-threshold' };
        }
        const baseBytes = kvGet(key);
        if (baseBytes === null) return { compacted: false, reason: 'missing' };
        const materialized = materializeChatRowBytes(key, baseBytes);
        const compacted = publishCompactedChatRow(
            key,
            metadata.rowToken,
            materialized,
            metadata,
        );
        return { compacted, reason: compacted ? 'compacted' : 'changed' };
    }

    async function readChatRow(chaId, chatId) {
        const value = readChatRowRaw(chaId, chatId);
        if (value === null) return null;
        return decodeRisuSave(value);
    }

    function readChatRowRaw(chaId, chatId) {
        const key = chatRowKey(chaId, chatId);
        return materializeChatRowBytes(key, kvGet(key));
    }

    function readChatRowRawWithMetadata(chaId, chatId) {
        const key = chatRowKey(chaId, chatId);
        const bytes = materializeChatRowBytes(key, kvGet(key));
        return chatRowStateFromBytes(key, bytes);
    }

    async function readChatRowRawWithMetadataAsync(chaId, chatId) {
        const key = chatRowKey(chaId, chatId);
        // kvGetAsync deliberately yields so identical protected-row reads can
        // coalesce. Bind that body to the operation-log token selected before
        // the yield; a checkpoint/full write that wins meanwhile forces a
        // fresh selection instead of mixing an old base with a new log.
        for (let attempt = 0; attempt < 3; attempt++) {
            const selectedToken = metadataForKey(key)?.rowToken ?? null;
            const baseBytes = await kvGetAsync(key);
            if (selectedToken !== (metadataForKey(key)?.rowToken ?? null)) continue;
            const bytes = materializeChatRowBytes(key, baseBytes);
            if (selectedToken !== (metadataForKey(key)?.rowToken ?? null)) continue;
            return chatRowStateFromBytes(key, bytes);
        }
        // All operations above are reads. A synchronous final selection cannot
        // interleave with another JavaScript storage mutation.
        return readChatRowRawWithMetadata(chaId, chatId);
    }

    function chatRowStateFromBytes(key, bytes) {
        if (bytes === null) return null;
        ensureChatRowMetadataSlot.run(key);
        const contentHash = contentDigest(bytes);
        const metadata = metadataForKey(key);
        const metadataMatches = metadata !== null
            && metadata.contentSize === bytes.length
            && metadata.contentHash === contentHash;
        return {
            key,
            rowToken: metadata?.rowToken ?? null,
            bytes,
            contentHash,
            coldStorage: metadataMatches ? metadata.coldStorage : null,
            messageCount: metadataMatches ? metadata.messageCount : null,
            logSupported: metadataMatches ? metadata.logSupported : null,
        };
    }

    // The mutation token makes this lazy derivative repair conditional on the
    // exact row selection that was decoded, even when that decode yielded to
    // another request. This never changes authoritative row bytes.
    function repairChatRowMetadata(rowState, coldStorage, messageCount = undefined) {
        if (!rowState || typeof rowState.key !== 'string'
            || !Buffer.isBuffer(rowState.bytes)
            || !/^[0-9a-f]{64}$/.test(rowState.contentHash)
            || typeof coldStorage !== 'boolean') {
            throw new TypeError('A selected chat row and cold-storage state are required');
        }
        if (typeof rowState.rowToken !== 'string') return false;
        const resolvedMessageCount = messageCount === undefined
            ? null
            : messageCount;
        const logSupported = Number.isSafeInteger(resolvedMessageCount)
            && resolvedMessageCount >= 0
            && isCanonicalRawChatRow(rowState.bytes);
        const result = repairSelectedChatRowMetadata.run(
            rowState.contentHash,
            rowState.bytes.length,
            coldStorage ? 1 : 0,
            logSupported ? resolvedMessageCount : null,
            logSupported ? 1 : 0,
            rowState.key,
            rowState.rowToken,
        );
        return result.changes === 1;
    }

    function inspectChatRowForBackup(chaId, chatId) {
        if (typeof kvSize !== 'function') {
            const bytes = readChatRowRaw(chaId, chatId);
            return bytes === null
                ? null
                : { size: bytes.length, coldStorage: null };
        }
        const key = chatRowKey(chaId, chatId);
        const baseSize = kvSize(key);
        if (baseSize === null) return null;
        ensureChatRowMetadataSlot.run(key);
        const metadata = metadataForKey(key);
        const size = metadata?.logCount > 0
            ? metadata.contentSize
            : baseSize;
        return {
            size,
            coldStorage: metadata?.contentSize === size ? metadata.coldStorage : null,
        };
    }

    async function streamChatRowRawToFile(chaId, chatId, filePath, options) {
        if (typeof kvWriteToFile !== 'function') {
            throw new TypeError('kvWriteToFile is required to stream a chat row');
        }
        const key = chatRowKey(chaId, chatId);
        const metadata = metadataForKey(key);
        if (!metadata || metadata.logCount === 0) {
            return kvWriteToFile(key, filePath, options);
        }
        const bytes = materializeChatRowBytes(key, kvGet(key));
        if (bytes === null) return null;
        await fs.writeFile(filePath, bytes, { flag: 'wx', mode: 0o600 });
        return {
            filePath,
            size: bytes.length,
            chunks: 1,
            maxChunkBytes: bytes.length,
        };
    }

    function writeChatRow(chaId, chatId, chatObj) {
        const owned = Buffer.from(encodeRisuSaveLegacy(chatObj));
        return writeChatRowRawOwned(chaId, chatId, owned, {
            coldStorage: isColdStorageChat(chatObj),
            messageCount: Array.isArray(chatObj?.message) ? chatObj.message.length : 0,
            logSupported: true,
        });
    }

    function writeChatRowIfUnchanged(chaId, chatId, rowState, chatObj) {
        if (!rowState || typeof rowState.rowToken !== 'string') return null;
        const owned = Buffer.from(encodeRisuSaveLegacy(chatObj));
        return persistOwnedChatRowIfToken(
            chatRowKey(chaId, chatId),
            rowState.rowToken,
            owned,
            isColdStorageChat(chatObj),
            Array.isArray(chatObj?.message) ? chatObj.message.length : 0,
            true,
        );
    }

    // Retained-buffer API: callers may continue using or mutating their input.
    function writeChatRowRaw(chaId, chatId, buffer, options = {}) {
        return writeChatRowRawOwned(chaId, chatId, Buffer.from(buffer), options);
    }

    // Ownership-transfer API: the caller gives up this Buffer after the call.
    // The exact object is passed to kvSet and its digest is returned without a
    // committed-row reread.
    function writeChatRowRawOwned(chaId, chatId, buffer, options = {}) {
        if (!Buffer.isBuffer(buffer)) {
            throw new TypeError('Owned chat row bytes must be a Buffer');
        }
        return persistOwnedChatRow(
            chatRowKey(chaId, chatId),
            buffer,
            options.coldStorage,
            options.messageCount,
            options.logSupported,
        );
    }

    function writeChatRowFromFile(chaId, chatId, filePath, options = {}) {
        return persistChatRowFromFile(
            chatRowKey(chaId, chatId),
            filePath,
            options.coldStorage,
            options.messageCount,
            options.logSupported,
            options.contentHash ?? null,
            options.chunkPlan ?? null,
        );
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
            .reduce((sum, entry) => {
                const metadata = metadataForKey(entry.key);
                const size = metadata?.logCount > 0
                    ? metadata.contentSize
                    : entry.size;
                return sum + (Number.isSafeInteger(size) ? size : entry.size);
            }, 0);
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
        const removedKeys = removedChatRowKeys(oldStrippedDb, newStrippedDb);
        if (removedKeys.length === 0) return 0;

        db.transaction(() => {
            for (const key of removedKeys) kvDel(key);
        })();
        return removedKeys.length;
    }

    async function sweepOrphanChatRows(strippedDb, opts = {}) {
        const now = opts.now ?? Date.now();
        const graceMs = opts.graceMs ?? 60 * 60 * 1000;
        const cutoff = now - graceMs;
        const referencedKeys = referencedChatRowKeys(strippedDb);
        const deleteKeys = [];
        let skippedRecent = 0;
        let skippedPreImage = 0;

        for (const key of listAllChatRowKeys()) {
            if (referencedKeys.has(key)) continue;
            const updatedAt = kvGetUpdatedAt(key);
            if (Number.isFinite(updatedAt) && updatedAt > cutoff) {
                skippedRecent++;
                continue;
            }

            const identity = parseChatRowKey(key);
            if (!identity || typeof opts.capturePreImage !== 'function') {
                skippedPreImage++;
                continue;
            }
            try {
                const captureResult = await opts.capturePreImage({ ...identity, key });
                if (captureResult !== 'captured' && captureResult !== 'skipped-no-row') {
                    skippedPreImage++;
                    continue;
                }
            } catch (error) {
                skippedPreImage++;
                opts.onPreImageCaptureFailure?.(identity, error);
                continue;
            }
            // The sweep may unlink a row only after its durable recovery copy exists.
            deleteKeys.push(key);
        }

        if (deleteKeys.length > 0) {
            db.transaction(() => {
                for (const key of deleteKeys) kvDel(key);
            })();
        }
        return { deleted: deleteKeys.length, skippedRecent, skippedPreImage };
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

        applyDatabaseCharacterDefaults(dbObj, randomUUID);
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
            kvSet(CHARACTER_DEFAULTS_MARKER_KEY, CHARACTER_DEFAULTS_MARKER_VALUE);
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
                signal: opts.signal,
                maxDecodedBytes: opts.maxDecodedBytes,
                diskHeadroomBytes: opts.diskHeadroomBytes,
                availableDiskBytes: opts.availableDiskBytes,
                onDecodedChunk: opts.onDecodedChunk,
                externalizePluginStorage: typeof opts.onPluginStorageEntry === 'function',
                externalizeMcpToolCalls: typeof opts.onMcpToolCallEntry === 'function',
                onPluginStorageEntry: opts.onPluginStorageEntry,
                onPluginStorageFolded: opts.onPluginStorageFolded,
                onMcpToolCallEntry: opts.onMcpToolCallEntry,
                onMcpToolCallsFolded: opts.onMcpToolCallsFolded,
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
                if (!character.chaId) continue;
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
            // Missing-ID characters deliberately stayed inline during the
            // walk. Assign only on the restored remainder so the final shared
            // extraction can never publish chats/undefined/* rows.
            applyDatabaseCharacterDefaults(dbObj, randomUUID);
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
            kvSet(CHARACTER_DEFAULTS_MARKER_KEY, CHARACTER_DEFAULTS_MARKER_VALUE);

            if (ownsTransaction) db.exec('COMMIT');
            return {
                strippedDb: dbObj,
                pluginStats: walked.pluginStats,
                mcpToolCallStats: walked.mcpToolCallStats,
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
        readChatRowRawWithMetadata,
        readChatRowRawWithMetadataAsync,
        repairChatRowMetadata,
        inspectChatRowForBackup,
        streamChatRowRawToFile,
        writeChatRow,
        writeChatRowIfUnchanged,
        writeChatRowRaw,
        writeChatRowRawOwned,
        writeChatRowFromFile,
        appendChatDelta,
        inspectChatDelta,
        compactChatRow,
        materializeChatRowBytes,
        materializeChatRowBytesFromReader,
        operationEntriesForKey,
        metadataForKey,
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
        removedChatRowKeys,
        deleteRemovedChatRows,
        sweepOrphanChatRows,
        splitFullDb,
        assembleFullDb,
        assignMissingChatIds,
        dedupeCharacterIds,
        findDuplicateChaIds,
        findDuplicateChatIds,
        normalizeOrphanFolderIds,
        ingestFullDatabase,
        ingestStreamingDatabase,
    };
}

module.exports = {
    createChatRowStore,
    chatRowKey,
    parseChatRowKey,
    isCanonicalRawChatRow,
    chatToStub,
    validateDatabaseShape,
    mergeChatStubWithFullChat,
    hasChatPayloads,
    referencedChatRowKeys,
    removedChatRowKeys,
    extractPayloadChats,
    splitFullDb,
    assignMissingChatId,
    assignMissingChatIds,
    dedupeCharacterIds,
    findDuplicateChaIds,
    findDuplicateChatIds,
    createChatExternalizer,
    normalizeOrphanFolderIds,
};
