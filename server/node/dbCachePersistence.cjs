'use strict';

const DB_BLOB_KEY = 'database/database.bin';

class DbCachePersistenceGuardError extends Error {
    constructor(guard, message) {
        super(message);
        this.name = 'DbCachePersistenceGuardError';
        this.guard = guard;
    }
}

class DbCacheNormalizationError extends Error {
    constructor() {
        super('Acknowledged database patch cache was not normalized before persistence');
        this.name = 'DbCacheNormalizationError';
    }
}

function findStubFlagLossChats(dbObj) {
    if (!dbObj?.characters) return [];
    const losses = [];
    for (let ci = 0; ci < dbObj.characters.length; ci++) {
        const char = dbObj.characters[ci];
        if (!char?.chats) continue;
        for (let chi = 0; chi < char.chats.length; chi++) {
            const chat = char.chats[chi];
            if (!chat || typeof chat !== 'object') continue;
            if (chat._stub !== true && !Array.isArray(chat.message)) {
                losses.push({
                    chaId: char.chaId,
                    charIndex: ci,
                    chatIndex: chi,
                    chatId: chat.id || null,
                });
            }
        }
    }
    return losses;
}

function duplicateChatIdSample(duplicates) {
    return duplicates.slice(0, 3).map(duplicate => {
        const characterLabel = duplicate.chaId ?? `character[${duplicate.characterIndex}]`;
        return `${characterLabel}/${duplicate.chatId}`;
    }).join(', ');
}

function prepareDbCachePersistence(options) {
    const {
        cachedDb,
        decodedKey,
        assertCurrent = () => {},
        findDuplicateChatIds,
        preparePluginStorageExternalization,
        retainCanonicalEncoding,
        encodeRisuSaveLegacy,
    } = options;

    assertCurrent();
    if (decodedKey === DB_BLOB_KEY) {
        const losses = findStubFlagLossChats(cachedDb);
        if (losses.length > 0) {
            const sample = losses.slice(0, 3)
                .map(loss => `${loss.chaId}/${loss.chatId ?? loss.chatIndex}`)
                .join(', ');
            throw new DbCachePersistenceGuardError(
                'stub-flag-loss',
                `persist aborted: ${losses.length} chat(s) lost _stub flag without upgrade — `
                + `would silently strip messages on disk. sample=[${sample}]`,
            );
        }
        const duplicateChatIds = findDuplicateChatIds(cachedDb);
        if (duplicateChatIds.length > 0) {
            throw new DbCachePersistenceGuardError(
                'duplicate-chat-ids',
                `persist aborted: ${duplicateChatIds.length} duplicate chat id(s) — `
                + `would alias authoritative rows. sample=[${duplicateChatIdSample(duplicateChatIds)}]`,
            );
        }
    }

    const pluginExternalization = decodedKey === DB_BLOB_KEY
        ? preparePluginStorageExternalization(cachedDb)
        : { strippedDb: cachedDb, rows: [], changed: false, manifest: null };
    const strippedDb = pluginExternalization.strippedDb;
    if (decodedKey === DB_BLOB_KEY && strippedDb !== cachedDb) {
        throw new DbCacheNormalizationError();
    }
    const data = decodedKey === DB_BLOB_KEY
        ? retainCanonicalEncoding().bytes
        : Buffer.from(encodeRisuSaveLegacy(strippedDb));
    return { cachedDb, data, decodedKey, pluginExternalization, strippedDb };
}

function commitPreparedDbCachePersistence(options) {
    const {
        prepared,
        chatRowsToDelete = [],
        assertCurrent = () => {},
        sqliteDb,
        writePluginStorageRows,
        writePluginStorageManifest,
        kvSet,
        kvDel,
        kvGetDatabaseRevision,
    } = options;
    let committedRevision = null;
    try {
        // better-sqlite3 commits when this synchronous callback returns.
        sqliteDb.transaction(() => {
            assertCurrent();
            writePluginStorageRows(prepared.pluginExternalization.rows);
            writePluginStorageManifest(prepared.pluginExternalization.manifest);
            kvSet(prepared.decodedKey, prepared.data);
            for (const key of chatRowsToDelete) kvDel(key);
            if (prepared.decodedKey === DB_BLOB_KEY) {
                committedRevision = kvGetDatabaseRevision();
            }
        })();
    } catch (error) {
        if (error && typeof error === 'object') {
            try { error.attemptedSize = prepared.data.length; } catch {}
        }
        throw error;
    }
    return { ...prepared, committedRevision };
}

function persistDbCacheGenerationSync(options) {
    const prepared = prepareDbCachePersistence(options);
    return commitPreparedDbCachePersistence({ ...options, prepared });
}

function errorText(error) {
    try {
        return error instanceof Error ? error.message : String(error);
    } catch {
        return 'unknown error';
    }
}

function runEmergencyDbFlush(options = {}) {
    const log = typeof options.log === 'function' ? options.log : console.error;
    const safeLog = message => {
        try { log(message); } catch {}
    };
    const skip = (reason, detail) => {
        safeLog(`[FatalFlush] skipped: ${detail}`);
        return { status: 'skipped', reason };
    };

    try {
        if (options.isImportInProgress()) {
            return skip('import-in-progress', 'import in progress');
        }
        if (options.isInTransaction()) {
            return skip('sqlite-transaction-active', 'SQLite transaction active');
        }
        if (!options.hasPendingWork()) {
            return skip('no-pending-work', 'no pending database work');
        }
        const cachedDb = options.peekCachedDb();
        if (!cachedDb) {
            return skip('empty-cache', 'pending database cache is empty');
        }
        const cacheMetadata = options.getCacheMetadata();
        if (cacheMetadata?.revision !== options.kvGetDatabaseRevision()) {
            return skip('cache-revision-mismatch', 'database cache revision changed');
        }
        try {
            options.persist({ cachedDb, cacheMetadata });
        } catch (error) {
            if (error instanceof DbCachePersistenceGuardError) {
                return skip(error.guard, error.message);
            }
            if (error instanceof DbCacheNormalizationError) {
                return skip('cache-not-normalized', error.message);
            }
            throw error;
        }
        safeLog('[FatalFlush] persisted pending database state');
        return { status: 'persisted' };
    } catch (error) {
        safeLog(`[FatalFlush] failed: ${errorText(error)}`);
        return { status: 'failed', error };
    }
}

module.exports = {
    DbCacheNormalizationError,
    DbCachePersistenceGuardError,
    commitPreparedDbCachePersistence,
    findStubFlagLossChats,
    persistDbCacheGenerationSync,
    prepareDbCachePersistence,
    runEmergencyDbFlush,
};
