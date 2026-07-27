const express = require('express');
const app = express();
const http = require('http');
const https = require('https');
const path = require('path');
const net = require('net');
const compression = require('compression');
const htmlparser = require('node-html-parser');
const fsSync = require('fs');
const {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
    readdirSync,
    unlinkSync,
    createReadStream,
    createWriteStream,
} = fsSync;
const fs = require('fs/promises')
const nodeCrypto = require('crypto')
const zlib = require('zlib')
const rateLimit = require('express-rate-limit')
const { WebSocketServer } = require('ws')
const Vips = require('wasm-vips')
let _vipsPromise = null
const getVips = () => {
    if (!_vipsPromise) {
        _vipsPromise = Vips().catch(err => {
            _vipsPromise = null
            throw err
        })
    }
    return _vipsPromise
}
const { kvGet, kvSet, kvSetFromFile, kvDel, kvList,
        kvDelPrefix, kvListWithSizes, kvSize, kvGetUpdatedAt, kvCopyValue, clearEntities, checkpointWal,
        kvClearDeletion, kvRecordDeletion, kvListModifiedSince, kvGetDeletedSince, kvCleanupOldDeletions,
        kvGetListEpoch, kvBumpListEpoch,
        gcChunks, reclaimableChunkBytes, isDbBlobChunked, snapshotFootprint, createKvSnapshot,
        db: sqliteDb } = require('./db.cjs');
const { buildListResponse } = require('./listDelta.cjs');
const {
    assetDir,
    migrationMarkerPath: assetMigrationMarker,
    createAssetStore,
    ensureAssetDir,
    isSafeAssetName,
    writeAssetFile,
    writeAssetFileIfChanged,
    readAssetFile,
    assetFileMtimeMs,
    deleteAssetFile,
    listAssetFiles,
    sumAssetFsBytes,
    swapAssetDirectoryFromStaging,
    swapDirectoryFromStaging,
    migrateAssetRowsToFilesystem,
    verifyAssetHash,
} = require('./assetStore.cjs');
const {
    writeImportJournal,
    readImportJournal,
    clearImportJournal,
    fsyncDirectoryTree,
    recoverImportSwap,
} = require('./importJournal.cjs');
const { createImportBarrier } = require('./importBarrier.cjs');
const {
    addLogBatch, queryLogs, clearLogs, countLogs,
    logger, installProcessHandlers, expressErrorMiddleware,
} = require('./logs.cjs');
const { applyPatchAtomic } = require('./atomicJsonPatch.cjs');
const { createGenerationMemo } = require('./generationMemo.cjs');
const {
    decodeRisuSave,
    encodeRisuSaveLegacy,
    calculateHash,
    normalizeJSON,
    hasRemoteBlocks,
    parseCachedHashesHeader,
    sha256Hex,
} = require('./utils.cjs');
const {
    computeBufferEtag,
    parseDbCacheInventory,
    prepareDatabaseReadPayload,
    encodeDatabaseSegments,
    buildCachedDbReadEnvelope,
    encodeCachedDbReadEnvelope,
} = require('./dbCachedRead.cjs');
const {
    createChatRowStore,
    chatRowKey,
    hasChatPayloads,
    findDuplicateChaIds,
} = require('./chatRows.cjs');
const { streamRisuSaveToFile } = require('./streamRisuSave.cjs');
const { inspectRisuSaveSource, shouldStreamRisuSave } = require('./streamRisuLoad.cjs');
const {
    PLUGIN_SAVE_PREFIX,
    PLUGIN_SAVE_META_PREFIX,
    PLUGIN_STORAGE_FOLDED_MARKER,
    decodePluginSaveStorageKey,
    encodePluginSaveStorageKey,
} = require('./pluginSaveKeys.cjs');
const {
    CHAT_BACKUP_DIRNAME,
    createChatBackupStore,
    migrateLegacyChatBackups,
    resolveChatBackupDir,
    resolveChatBackupMaxBytes,
} = require('./chatBackups.cjs');
const { spawn, execSync } = require('child_process');
const os = require('os');
const { Readable, Transform } = require('stream');

// Install process-level error handlers before any other init so early crashes get logged.
installProcessHandlers();

// Node.js version check
const [nodeMajor] = process.version.slice(1).split('.').map(Number);
if (nodeMajor < 24) {
    logger.warn(`[Server] Node.js ${process.version} is below the recommended version (v24.x). Consider upgrading for best compatibility.`);
}

// Configuration flags for patch-based sync
const enablePatchSync = true;
// Emergency escape hatch for remote plain-HTTP deployments. Only these exact
// values allow the client to boot outside a browser secure context.
const allowInsecureContext = process.env.POCKETRISU_ALLOW_INSECURE_CONTEXT === '1'
    || process.env.POCKETRISU_ALLOW_INSECURE_CONTEXT === 'true';
const HUB_HOSTING_MODE = ['true', '1'].includes(String(process.env.POCKETRISU_HUB_HOSTING ?? '').trim().toLowerCase());

// In-memory database cache for patch-based sync
// dbCache stores the STRIPPED (stubs-only) version matching what the client sees.
let dbCache = {};
const dbDerivedValueMemo = createGenerationMemo();
let saveTimers = {};
const pendingChatRowDeletions = new Set();
const SAVE_INTERVAL = 5000;

const chatRowStore = createChatRowStore({
    db: sqliteDb,
    kvGet,
    kvSet,
    kvDel,
    kvList,
    kvListWithSizes,
    kvGetUpdatedAt,
});

// ETag for database.bin
let dbEtag = null;

function computeDatabaseEtagFromObject(databaseObject) {
    return computeBufferEtag(Buffer.from(encodeRisuSaveLegacy(databaseObject)));
}

// Keep every cache replacement/eviction behind these helpers: derived values
// are valid only for the exact mutation generation in which they were built.
function replaceDbCacheValue(filePath, value) {
    if (dbCache[filePath] === value) return;
    dbCache[filePath] = value;
    dbDerivedValueMemo.bump(filePath);
}

function deleteDbCacheValue(filePath) {
    delete dbCache[filePath];
    dbDerivedValueMemo.bump(filePath);
}

function invalidateDbCacheEntry(filePath) {
    deleteDbCacheValue(filePath);
    if (saveTimers[filePath]) {
        clearTimeout(saveTimers[filePath]);
        delete saveTimers[filePath];
    }
}

function getDbCacheHash(filePath) {
    return dbDerivedValueMemo.getOrCompute(
        filePath,
        'hash',
        () => calculateHash(dbCache[filePath]).toString(16),
    );
}

function getDbCacheEtag(filePath) {
    return dbDerivedValueMemo.getOrCompute(
        filePath,
        'etag',
        () => computeDatabaseEtagFromObject(dbCache[filePath]),
    );
}

function seedDbCacheEtag(filePath, etag) {
    dbDerivedValueMemo.seed(filePath, 'etag', etag);
}

let storageOperationQueue = Promise.resolve();
function queueStorageOperation(operation) {
    const operationRun = storageOperationQueue.then(operation, operation);
    storageOperationQueue = operationRun.catch(() => {});
    return operationRun;
}

let importInProgress = false;
// Imports keep one raw transaction open across streamed decompression, msgpack
// walking and directory swaps. The barrier drains this queue before an import
// begins, so mutations either land entirely before BEGIN or are refused —
// never acknowledged and then discarded by the import's ROLLBACK.
const importBarrier = createImportBarrier({
    drainMutations: () => queueStorageOperation(() => {}),
});

class ImportInProgressError extends Error {
    constructor() {
        super('An import is in progress; the write was not applied');
        this.name = 'ImportInProgressError';
        this.importInProgress = true;
    }
}

// Every KV/chat-row/asset mutation must run through this, not through
// queueStorageOperation directly. The barrier check has to happen inside the
// queued callback: the serial FIFO order is what makes the boundary airtight.
function queueStorageMutation(operation) {
    return queueStorageOperation(() => {
        if (importBarrier.isHeld()) throw new ImportInProgressError();
        return operation();
    });
}

function isImportInProgressError(error) {
    return Boolean(error && error.importInProgress === true);
}

// 503 + Retry-After: the client may safely reissue the same write once the
// import finishes. Anything else would let the caller treat a dropped write as
// applied.
function sendImportBusy(res) {
    if (res.headersSent) return;
    res.setHeader('Retry-After', '5');
    res.status(503).json({
        error: 'An import is in progress; retry this write after it completes',
        code: 'IMPORT_IN_PROGRESS',
        retryable: true,
    });
}

// Captures run inside the endpoint's storage operation. Reconcile enters the
// same queue through runStorageOperation, so neither can observe half-written
// backup state or race a chat-row overwrite.
const chatBackupStore = createChatBackupStore({
    getChatBackupsRoot: () => chatBackupsDir,
    logger,
    readChatRowRaw: (chaId, chatId) => chatRowStore.readChatRowRaw(chaId, chatId),
    getByteBudget: () => resolveChatBackupMaxBytes({ kvGet }),
    runStorageOperation: queueStorageOperation,
});

const DB_HEX_KEY = Buffer.from('database/database.bin', 'utf-8').toString('hex');
const CHAT_EXTERNALIZATION_MARKER_KEY = 'migration/chats-externalized';
const CHAT_EXTERNALIZATION_MARKER_VALUE = Buffer.from('done', 'utf-8');
const CHAT_ORPHAN_GRACE_MS = 60 * 60 * 1000;

// ─── Persist failure tracking (Stage 1 visibility) ───────────────────────────
// Debounced persist runs in setTimeout, so failures cannot be returned in the
// triggering response. Record the latest failure here and surface it on the
// next /api/patch response. Cleared on next successful persist.
let lastPersistFailure = null;

function recordPersistFailure(error, source) {
    const message = String(error?.message || error || 'unknown error');
    const attemptedSize = typeof error?.attemptedSize === 'number' ? error.attemptedSize : null;
    // Preserve timestamp when the failure is identical to the last one — every
    // debounce cycle re-records the same failure, and clients dedupe by ts.
    // Without this guard a fresh ts every 5s would re-fire the toast.
    if (lastPersistFailure
        && lastPersistFailure.source === source
        && lastPersistFailure.message === message
        && lastPersistFailure.attemptedSize === attemptedSize) {
        return;
    }
    lastPersistFailure = {
        timestamp: Date.now(),
        message,
        attemptedSize,
        source,
    };
}

function clearPersistFailure() {
    lastPersistFailure = null;
}

function currentPersistWarning() {
    return lastPersistFailure;
}

// ─── Server-side database backup (DB-only snapshots) ────────────────────────
//
// Snapshots live as `database/dbbackup-{ts}.bin` keys inside the kv table.
// They're created on every successful persist (with a cooldown) and rotated
// to fit user-configured count/size limits — see SNAPSHOT_LIMIT_* below.
const SNAPSHOT_LIMIT_COUNT_KEY = 'config/snapshot-max-count';
const SNAPSHOT_LIMIT_BYTES_KEY = 'config/snapshot-max-bytes';
const SNAPSHOT_LIMIT_DEFAULT_COUNT = 20;
const SNAPSHOT_LIMIT_DEFAULT_BYTES = 500 * 1024 * 1024; // 500 MB
// Safety bounds to keep a stray PUT from making the system unusable.
const SNAPSHOT_LIMIT_MIN_COUNT = 1;
const SNAPSHOT_LIMIT_MAX_COUNT = 100;
const SNAPSHOT_LIMIT_MIN_BYTES = 10 * 1024 * 1024;        // 10 MB
const SNAPSHOT_LIMIT_MAX_BYTES = 50 * 1024 * 1024 * 1024; // 50 GB
// Hub-mode snapshot byte cap. POCKETRISU_HUB_SNAPSHOT_CAP_MB (in MB) replaces
// the tenant-stored value everywhere the cap is read (endpoints and trim
// rotation); unset/invalid falls back to the 500 MB default, clamped to the
// same safety bounds as a PUT. null outside hub mode.
const HUB_SNAPSHOT_CAP_BYTES = (() => {
    if (!HUB_HOSTING_MODE) return null;
    const mb = Number(process.env.POCKETRISU_HUB_SNAPSHOT_CAP_MB);
    if (!Number.isFinite(mb) || mb <= 0) return SNAPSHOT_LIMIT_DEFAULT_BYTES;
    const bytes = Math.floor(mb * 1024 * 1024);
    return Math.min(SNAPSHOT_LIMIT_MAX_BYTES, Math.max(SNAPSHOT_LIMIT_MIN_BYTES, bytes));
})();
const BACKUP_INTERVAL_MS = process.env.POCKETRISU_BACKUP_INTERVAL_MS
    ? Number(process.env.POCKETRISU_BACKUP_INTERVAL_MS)
    : 5 * 60 * 1000; // 5 minutes (override for tests to force snapshot creation)
let lastBackupTime = null;
let backupCreationInFlight = false;
let deferredBackupPending = false;

function readSnapshotConfigInt(key, fallback, min, max) {
    try {
        const raw = kvGet(key);
        if (!raw) return fallback;
        const n = parseInt(Buffer.from(raw).toString('utf-8').trim(), 10);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, n));
    } catch { return fallback; }
}

function getSnapshotLimits() {
    return {
        maxCount: readSnapshotConfigInt(
            SNAPSHOT_LIMIT_COUNT_KEY, SNAPSHOT_LIMIT_DEFAULT_COUNT,
            SNAPSHOT_LIMIT_MIN_COUNT, SNAPSHOT_LIMIT_MAX_COUNT,
        ),
        maxBytes: HUB_SNAPSHOT_CAP_BYTES ?? readSnapshotConfigInt(
            SNAPSHOT_LIMIT_BYTES_KEY, SNAPSHOT_LIMIT_DEFAULT_BYTES,
            SNAPSHOT_LIMIT_MIN_BYTES, SNAPSHOT_LIMIT_MAX_BYTES,
        ),
    };
}

// Walk newest → oldest; keep within both limits, delete the rest. The most
// recent snapshot is always kept (even if it alone exceeds the byte limit) so
// we never end up with zero backups after a config change.
function trimSnapshotsToLimits() {
    const { maxCount, maxBytes } = getSnapshotLimits();
    const keys = kvList(DB_BACKUP_PREFIX)
        .map((key) => {
            const tsRaw = parseInt(key.slice(DB_BACKUP_PREFIX.length, -4), 10);
            return { key, ts: Number.isFinite(tsRaw) ? tsRaw : 0 };
        })
        .sort((a, b) => b.ts - a.ts)
        .map(entry => entry.key);
    let removed = 0;

    // Exclusive footprint is "what deleting this manifest frees". Removing a
    // sibling can make shared chunks exclusive, so recalculate after each trim.
    while (keys.length > 1) {
        const totalBytes = keys.reduce((sum, key) => sum + snapshotFootprint(key), 0);
        if (keys.length <= maxCount && totalBytes <= maxBytes) break;
        kvDel(keys.pop());
        removed++;
    }
    return { kept: keys.length, removed };
}

// Current snapshot count + two totals:
//   bytes        — marginal disk cost (snapshotFootprint), the SAME measure the
//                  byte limit/trim uses, so the limit gauge matches what trimming
//                  sees. kvListWithSizes would report a chunked snapshot's marker.
//   logicalBytes — sum of each snapshot's full logical size (kvSize), i.e. what
//                  the snapshots would cost WITHOUT dedup. Drives the "saved by
//                  deduplication" figure; never used for trimming.
function snapshotUsage() {
    const keys = kvList(DB_BACKUP_PREFIX);
    let bytes = 0, logicalBytes = 0;
    for (const k of keys) {
        bytes += snapshotFootprint(k);
        logicalBytes += (kvSize(k) || 0);
    }
    return { count: keys.length, bytes, logicalBytes };
}

function warnAndPreserveMissingChatRow(source, chaId, chatId) {
    // The referenced payload is already lost. Recovery-oriented backups keep
    // the remaining database usable by retaining its metadata-only stub.
    logger.warn(
        `[${source}] Missing referenced chat row ${chaId}/${chatId}; preserving bare stub`
    );
}

async function createBackupAndRotate() {
    const now = Date.now();
    if (lastBackupTime && now - lastBackupTime < BACKUP_INTERVAL_MS) {
        return;
    }
    if (backupCreationInFlight) return;

    backupCreationInFlight = true;
    let backupDbSpool = null;
    try {
        const backupKey = `${DB_BACKUP_PREFIX}${(now / 100).toFixed()}.bin`;
        const raw = kvGet('database/database.bin');
        if (!raw) return;
        const strippedDb = dbCache[DB_HEX_KEY] || await loadStrippedDatabase(raw, 'snapshot');
        backupDbSpool = await spoolSelfContainedBackupDatabase(strippedDb, {
            foldPluginStorage: true,
            markPluginStorageFolded: true,
            onMissingChatRow: (chaId, chatId) => {
                warnAndPreserveMissingChatRow('Snapshot', chaId, chatId);
            },
        });
        kvSetFromFile(backupKey, backupDbSpool.filePath);
        lastBackupTime = Date.now();
        trimSnapshotsToLimits();
    } catch (error) {
        logger.error(
            `[Snapshot] Failed to create database snapshot using spool ${databaseSpoolDir}:`,
            error
        );
    } finally {
        if (backupDbSpool) {
            await fs.unlink(backupDbSpool.filePath).catch(() => {});
        }
        backupCreationInFlight = false;
    }
}

function scheduleBackupAndRotate() {
    if (deferredBackupPending) return;
    deferredBackupPending = true;
    setImmediate(async () => {
        try {
            while (true) {
                await importBarrier.waitUntilIdle();
                try {
                    await queueStorageMutation(() => createBackupAndRotate());
                    break;
                } catch (error) {
                    // An import can claim the barrier between waitUntilIdle and
                    // the queued check. Wait for that import and retry the backup.
                    if (isImportInProgressError(error)) continue;
                    throw error;
                }
            }
        } catch (error) {
            logger.warn('[Snapshot] Deferred snapshot scheduling failed:', error);
        } finally {
            deferredBackupPending = false;
        }
    });
}

async function flushPendingDb() {
    if (saveTimers[DB_HEX_KEY]) {
        clearTimeout(saveTimers[DB_HEX_KEY]);
        delete saveTimers[DB_HEX_KEY];
        if (dbCache[DB_HEX_KEY]) {
            await persistDbCache(DB_HEX_KEY, 'database/database.bin');
            clearPersistFailure();
            await createBackupAndRotate();
        }
    }
}

function invalidateDbCache() {
    invalidateDbCacheEntry(DB_HEX_KEY);
    pendingChatRowDeletions.clear();
    dbEtag = null;
}

function invalidateAllDbCaches() {
    const filePaths = new Set([...Object.keys(dbCache), ...Object.keys(saveTimers)]);
    filePaths.add(DB_HEX_KEY);
    for (const filePath of filePaths) invalidateDbCacheEntry(filePath);
    pendingChatRowDeletions.clear();
    dbEtag = null;
}

// ─── Remote-block migration ─────────────────────────────────────────────────
//
// Background: upstream RisuAI (and very early NodeOnly versions) split each
// character's data out of database.bin into a separate `remotes/<chaId>.local.bin`
// file. The main database.bin then carries a REMOTE pointer block instead of the
// character payload. The server-side RisuSaveDecoder used to skip those blocks
// outright, so any decode pass — /api/read, /api/chat-content fallback, chat
// store init — saw the character as missing and lost its chats.
//
// NodeOnly never wanted this split (`disableRemoteSaving` is hardcoded to
// true), so we one-shot convert any leftover REMOTE blocks to inline raw blocks
// the first time a server with such data boots. The reencoded database.bin is
// stored in legacy msgpack format, which has no block structure at all — so
// the REMOTE code path becomes unreachable for future decodes.
//
// Idempotent via a KV marker. The marker lives in KV (not on disk) so a backup
// import — which wipes most KV prefixes and INSERTs a new database.bin — naturally
// clears it, letting the new contents be re-evaluated.

const REMOTE_MIGRATION_MARKER_KEY = 'migration/disable-remote-saving';
const REMOTE_MIGRATION_MARKER_VALUE = Buffer.from('done', 'utf-8');

function isRemoteMigrationDone() {
    const value = kvGet(REMOTE_MIGRATION_MARKER_KEY);
    return value !== null && value.length > 0;
}

function markRemoteMigrationDone() {
    kvSet(REMOTE_MIGRATION_MARKER_KEY, REMOTE_MIGRATION_MARKER_VALUE);
}

/**
 * Convert any leftover REMOTE blocks in database.bin into inline raw blocks.
 * Safe to call repeatedly: idempotent via KV marker.
 */
async function migrateRemoteBlocksIfNeeded() {
    if (isRemoteMigrationDone()) return { ran: false, reason: 'already-done' };

    const raw = kvGet('database/database.bin');
    if (!raw) {
        markRemoteMigrationDone();
        return { ran: false, reason: 'no-database' };
    }

    if (!hasRemoteBlocks(raw)) {
        markRemoteMigrationDone();
        return { ran: false, reason: 'no-remote-blocks' };
    }

    logger.info('[Migration] REMOTE blocks detected in database.bin; converting to inline format');

    // Pre-migration backup so a botched migration can be rolled back manually.
    // Use a dedicated prefix — `database/dbbackup-` is on a 20-snapshot rotation
    // whose timestamp parser would assign this entry ts=0 (because of the
    // non-numeric suffix), making it the first to evict. The migration safety
    // net must outlive ordinary backup churn.
    const backupKey = `migration-backup/pre-remote-fix-${Date.now()}.bin`;
    kvCopyValue('database/database.bin', backupKey);

    const dbObj = await decodeRisuSave(raw, {
        resolveRemote: async (name) => {
            const value = kvGet(`remotes/${name}.local.bin`);
            return value || null;
        },
    });

    const reEncoded = encodeRisuSaveLegacy(dbObj, 'compression');

    // Single transaction so swap + marker move together.
    // remotes/ files are intentionally NOT deleted here: pre-migration
    // dbbackup-* snapshots and the migration-backup we just wrote both
    // only carry database.bin (kvCopyValue is single-key). If a user later
    // restores one of those snapshots — which holds REMOTE pointers —
    // resolveRemote needs the remotes/<id>.local.bin payloads to still
    // exist, otherwise every REMOTE-pointed character drops on the next
    // decode and the backup is effectively dead. The orphans don't grow
    // (NodeOnly's disableRemoteSaving = true on writes), so leaving them
    // costs a few MB of disk for full backup recoverability.
    sqliteDb.transaction(() => {
        kvSet('database/database.bin', Buffer.from(reEncoded));
        markRemoteMigrationDone();
    })();

    // Reset in-memory caches whose contents were derived from the pre-migration
    // bytes — next reader recomputes from the migrated database.bin.
    invalidateDbCache();
    dbEtag = null;

    const characterCount = Array.isArray(dbObj.characters) ? dbObj.characters.length : 0;
    logger.info(`[Migration] Remote-block migration complete. Inlined ${characterCount} character(s); pre-migration backup at ${backupKey}`);
    return { ran: true, characterCount, backupKey };
}

async function ingestDatabase(raw, { createBackup = false } = {}) {
    const migration = await migrateRemoteBlocksIfNeeded();
    const source = migration.ran ? kvGet('database/database.bin') : raw;
    if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
        const inspection = await inspectRisuSaveSource(source);
        if (await shouldStreamRisuSave(source, { inspection })) {
            const result = await ingestDatabaseStreaming(source, { inspection });
            if (createBackup) await createBackupAndRotate();
            return result;
        }
    }
    const decoded = Buffer.isBuffer(source) || source instanceof Uint8Array
        ? await decodeRisuSave(source)
        : source;
    const dbObj = normalizeJSON(decoded);

    // Plugin rows commit before chat ingestion rewrites database.bin. If the
    // process stops between those steps, the inline monolith remains the
    // authoritative copy and a later pass overwrites any partial/stale rows.
    externalizePluginStorageIfNeeded(dbObj);

    const result = await chatRowStore.ingestFullDatabase(dbObj, {
        restoreColdStorageCharacters: (dbObj) => {
            const coldRestoreResult = restoreColdStorageCharactersInDb(dbObj);
            if (coldRestoreResult.failed > 0) {
                logger.error(`[ColdStorage] ${coldRestoreResult.failed} character(s) could not be restored and were converted to safe blank characters. Cold storage KV data is preserved.`);
                for (const name of coldRestoreResult.failedNames) {
                    logger.error(`[ColdStorage]   - "${name}"`);
                }
            }
            return coldRestoreResult;
        },
    });
    logDuplicateCharacterIdReassignments(result);
    if (createBackup) await createBackupAndRotate();
    return result;
}

function logColdStorageRestoreFailures(result) {
    if (!result || result.failed <= 0) return;
    logger.error(`[ColdStorage] ${result.failed} character(s) could not be restored and were converted to safe blank characters. Cold storage KV data is preserved.`);
    for (const name of result.failedNames) {
        logger.error(`[ColdStorage]   - "${name}"`);
    }
}

function logDuplicateCharacterIdReassignments(result) {
    const count = result?.stats?.reassignedDuplicateChaIds ?? 0;
    if (count > 0) {
        logger.warn(`[ChatRows] Reassigned ${count} duplicate character ID(s) before externalizing chats`);
    }
}

async function ingestDatabaseStreaming(source, { inspection = null } = {}) {
    const result = await chatRowStore.ingestStreamingDatabase(source, {
        inspection: inspection ?? await inspectRisuSaveSource(source),
        tempDir: savePath,
        onPluginStorageFolded: () => {
            kvDelPrefix(PLUGIN_SAVE_PREFIX);
            kvDelPrefix(PLUGIN_SAVE_META_PREFIX);
        },
        onPluginStorageEntry: ({ field, key, value }) => {
            const prefix = field === 'pluginStorageMeta'
                ? PLUGIN_SAVE_META_PREFIX
                : PLUGIN_SAVE_PREFIX;
            kvSet(
                encodePluginSaveStorageKey(key, prefix),
                Buffer.from(JSON.stringify(value), 'utf-8')
            );
        },
        restoreColdStorageCharacters: (dbObj) => {
            const coldRestoreResult = restoreColdStorageCharactersInDb(dbObj);
            logColdStorageRestoreFailures(coldRestoreResult);
            return coldRestoreResult;
        },
    });
    logDuplicateCharacterIdReassignments(result);
    return result;
}

async function loadStrippedDatabase(raw, source) {
    const inspection = await inspectRisuSaveSource(raw);
    if (kvGet(CHAT_EXTERNALIZATION_MARKER_KEY) === null
        && await shouldStreamRisuSave(raw, { inspection })) {
        logger.warn(`[${source}] Large supported database.bin found; externalizing through the streaming ingest path`);
        return (await ingestDatabaseStreaming(raw, { inspection })).strippedDb;
    }
    const decoded = normalizeJSON(await decodeRisuSave(raw));
    const hasChats = hasChatPayloads(decoded);
    const hasPluginStorage = hasExternalizablePluginStorage(decoded);
    if (!hasChats && !hasPluginStorage) return decoded;
    if (hasChats) {
        logger.warn(`[${source}] Chat payload found in database.bin; externalizing defensively`);
    }
    if (hasPluginStorage) {
        logger.warn(`[${source}] Folded plugin storage found in database.bin; externalizing defensively`);
    }
    return (await ingestDatabase(decoded)).strippedDb;
}

async function prepareLiveDatabaseRead(raw, source) {
    const strippedDatabase = await loadStrippedDatabase(raw, source);
    replaceDbCacheValue(DB_HEX_KEY, strippedDatabase);
    const prepared = prepareDatabaseReadPayload(strippedDatabase);
    seedDbCacheEtag(DB_HEX_KEY, prepared.etag);
    dbEtag = prepared.etag;
    return prepared;
}

async function migrateChatsToRowsIfNeeded() {
    if (kvGet(CHAT_EXTERNALIZATION_MARKER_KEY) !== null) return;
    const raw = kvGet('database/database.bin');
    if (!raw) {
        kvSet(CHAT_EXTERNALIZATION_MARKER_KEY, CHAT_EXTERNALIZATION_MARKER_VALUE);
        logger.info('[Migration] Chat externalization marker initialized (no database present)');
        return;
    }

    const backupKey = `migration-backup/pre-chat-externalization-${Date.now()}.bin`;
    kvCopyValue('database/database.bin', backupKey);
    logger.info(`[Migration] Externalizing chats from database.bin; safety backup at ${backupKey}`);
    const result = await ingestDatabase(raw);
    logger.info(
        `[Migration] Chat externalization complete: ${result.stats.chats} chat row(s), `
        + `${result.stats.deletedStale} stale row(s) removed`
    );
}

// Stub metadata fields a JSON Patch may legitimately touch on a `chats[i]`
// entry. Anything else is a chat-internal field — those live in chat rows, not
// in dbCache, and should never appear in a /api/patch payload. Keep in
// sync with chatToStub on both server and client.
const STUB_METADATA_FIELDS = new Set(['id', 'name', '_stub', 'lastDate', 'folderId', 'modules']);

// Only add/replace/remove are produced by the legitimate patcher. move/copy
// could alias _stub or other chat-internal fields through `from`, bypassing
// the path-based field allowlist. Reject those op types outright on chat
// paths. test ops can also reveal/manipulate state; deny for symmetry.
const ALLOWED_CHAT_OP_TYPES = new Set(['add', 'replace', 'remove']);

const CHAT_FIELD_PATH_RE = /^\/characters\/\d+\/chats\/\d+\/([^/]+)/;

/**
 * Detect JSON Patch ops that mutate chat-internal fields (anything beyond
 * STUB_METADATA_FIELDS). Such ops are the loss vector: applying them to
 * dbCache leaves a metadata-only chat without `_stub`, which then gets
 * persisted as-is.
 *
 * Whole-chat ops (path = `/characters/N/chats/M` or `/characters/N/chats`)
 * are allowed — those replace/add/remove chat slots wholesale and the
 * persist guard takes care of validating the resulting state.
 *
 * The `_stub` field gets stricter treatment than other allowed fields: only
 * `add`/`replace` with literal value `true` is permitted. Any op that could
 * remove the flag or set it to a falsy value is itself the loss mechanism
 * so it must be blocked at the patch boundary, not just at persistence.
 *
 * `move`/`copy` ops are rejected wholesale on chat-internal paths because
 * the field-name allowlist on `path` alone can't catch a `from` that points
 * at `_stub` or another chat-internal field. Both `path` and `from` are
 * checked when present.
 */
function findChatInternalFieldOps(patch) {
    if (!Array.isArray(patch)) return [];
    const violations = [];
    for (const op of patch) {
        if (!op || typeof op !== 'object' || typeof op.path !== 'string') continue;

        const pathMatch = op.path.match(CHAT_FIELD_PATH_RE);
        const fromMatch = typeof op.from === 'string' ? op.from.match(CHAT_FIELD_PATH_RE) : null;
        if (!pathMatch && !fromMatch) continue;

        if (!ALLOWED_CHAT_OP_TYPES.has(op.op)) {
            violations.push({
                op: op.op,
                path: op.path,
                field: (pathMatch && pathMatch[1]) || (fromMatch && fromMatch[1]) || '',
                reason: 'disallowed op type on chat field',
            });
            continue;
        }

        if (pathMatch) {
            const field = pathMatch[1];
            if (!STUB_METADATA_FIELDS.has(field)) {
                violations.push({ op: op.op, path: op.path, field });
                continue;
            }
            if (field === '_stub') {
                if (op.op === 'remove') {
                    violations.push({ op: op.op, path: op.path, field, reason: 'remove _stub' });
                } else if ((op.op === 'add' || op.op === 'replace') && op.value !== true) {
                    violations.push({ op: op.op, path: op.path, field, reason: 'non-true _stub value' });
                }
            }
        }
    }
    return violations;
}

/**
 * Detect chats that lost their `_stub` flag without being upgraded to a real
 * Chat. Persisting such a chat would write metadata-only to disk and silently
 * strip messages — the exact data-loss path reported with PATCH
 * `remove /chats/N/{message,...}` ops.
 *
 * A real Chat has `message` (Array). A real stub has `_stub === true`. Anything
 * with neither is a malformed in-between state; treat as a corruption signal.
 */
function findStubFlagLossChats(dbObj) {
    if (!dbObj?.characters) return [];
    const losses = [];
    for (let ci = 0; ci < dbObj.characters.length; ci++) {
        const char = dbObj.characters[ci];
        if (!char?.chats) continue;
        for (let chi = 0; chi < char.chats.length; chi++) {
            const chat = char.chats[chi];
            if (!chat || typeof chat !== 'object') continue;
            const isStub = chat._stub === true;
            const hasMessage = Array.isArray(chat.message);
            if (!isStub && !hasMessage) {
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

function trackPendingChatRowDeletions(oldStrippedDb, newStrippedDb) {
    const oldKeys = chatRowStore.referencedChatRowKeys(oldStrippedDb);
    const newKeys = chatRowStore.referencedChatRowKeys(newStrippedDb);
    for (const key of oldKeys) {
        if (!newKeys.has(key)) pendingChatRowDeletions.add(key);
    }
    for (const key of newKeys) pendingChatRowDeletions.delete(key);
}

/**
 * Persist the stubs-only patch cache.
 */
async function persistDbCache(filePath, decodedKey) {
    const cachedDb = dbCache[filePath];
    if (!cachedDb) return;

    // Disk protection guard: abort persist on metadata-only chats.
    // Invalidate dbCache so the next request re-reads from disk and rebuilds a
    // consistent stub view; client receives 409 on next /api/patch via hash mismatch.
    if (decodedKey === 'database/database.bin') {
        const losses = findStubFlagLossChats(cachedDb);
        if (losses.length > 0) {
            const sample = losses.slice(0, 3).map(l => `${l.chaId}/${l.chatId ?? l.chatIndex}`).join(', ');
            const err = new Error(
                `persist aborted: ${losses.length} chat(s) lost _stub flag without upgrade — `
                + `would silently strip messages on disk. sample=[${sample}]`
            );
            recordPersistFailure(err, 'persistDbCache:stub-flag-loss');
            invalidateDbCache();
            throw err;
        }
    }

    const pluginExternalization = decodedKey === 'database/database.bin'
        ? preparePluginStorageExternalization(cachedDb)
        : { strippedDb: cachedDb, rows: [], changed: false };
    const strippedDb = pluginExternalization.strippedDb;
    const data = Buffer.from(encodeRisuSaveLegacy(strippedDb));
    const referencedChatRows = decodedKey === 'database/database.bin'
        ? chatRowStore.referencedChatRowKeys(strippedDb)
        : new Set();
    const chatRowsToDelete = decodedKey === 'database/database.bin'
        ? [...pendingChatRowDeletions].filter(key => !referencedChatRows.has(key))
        : [];
    try {
        // Must stay synchronous: better-sqlite3 commits when this callback returns.
        sqliteDb.transaction(() => {
            writePluginStorageRows(pluginExternalization.rows);
            kvSet(decodedKey, data);
            for (const key of chatRowsToDelete) kvDel(key);
        })();
    } catch (err) {
        // Tag with BLOB size so the visibility layer can surface it to the user.
        // The dominant failure mode (better-sqlite3 INT_MAX) is size-driven.
        if (err && typeof err === 'object') {
            try { err.attemptedSize = data.length; } catch {}
        }
        throw err;
    }
    if (decodedKey === 'database/database.bin') {
        replaceDbCacheValue(filePath, strippedDb);
        pendingChatRowDeletions.clear();
    }
}

function shouldCompress(req, res) {
    // Proxy/hub-proxy: pass through external responses without compression.
    // Original upstream server has no compression middleware at all,
    // so proxy responses were never compressed in the first place.
    const url = req.originalUrl || req.url;
    if (url.startsWith('/proxy') || url.startsWith('/hub-proxy') || url.startsWith('/api/backup/export') || url.startsWith('/api/backup/server/download/')) {
        return false;
    }

    const contentType = String(res.getHeader('Content-Type') || '').toLowerCase();
    if (contentType.includes('text/event-stream')) {
        return false;
    }
    // NDJSON endpoints (backup import/restore, inlay bulk compression) emit
    // small per-line events and rely on real-time flushes — keepalive
    // heartbeats in particular must reach reverse proxies before their
    // response timeout fires. gzip would buffer those lines until enough
    // bytes accumulated for an efficient compression block, defeating the
    // 502-avoidance the streaming endpoints were built for. compressible's
    // mime-db happens not to list application/x-ndjson today (so this is
    // a no-op in practice) but a future dep upgrade could flip it on.
    if (contentType.includes('application/x-ndjson')) {
        return false;
    }
    // Already-compressed media formats: gzip adds CPU cost with ~0% size gain
    if (contentType.startsWith('image/') || contentType.startsWith('video/') || contentType.startsWith('audio/')) {
        return false;
    }
    if (contentType.includes('application/octet-stream')) {
        return true;
    }
    return compression.filter(req, res);
}

app.use(compression({
    filter: shouldCompress,
}));
// Vite 산출물은 해시 파일명이므로 /assets는 장기 캐시 안전
app.use('/assets', express.static(path.join(process.cwd(), 'dist/assets'), {
    maxAge: '1y',
    immutable: true,
}));
app.use(express.static(path.join(process.cwd(), 'dist'), {index: false, maxAge: 0}));
const defaultJsonParser = express.json({ limit: '100mb' });
app.use((req, res, next) => {
    if (req.path === '/api/db/read-cached') return next();
    return defaultJsonParser(req, res, next);
});
app.use((req, res, next) => {
    // Skip express.raw() for backup import — it must stream, not buffer into memory
    if (req.path === '/api/backup/import') return next();
    return express.raw({ type: 'application/octet-stream', limit: '2gb' })(req, res, next);
});
app.use(express.text({ limit: '100mb' }));
const { pipeline, finished } = require('stream/promises')
const sslPath = path.join(process.cwd(), 'server/node/ssl/certificate');
const hubURL = 'https://sv.risuai.xyz';

let password = ''

// Ensure /save/ exists for password file and migration source
const savePath = path.join(process.cwd(), "save")
if(!existsSync(savePath)){
    mkdirSync(savePath)
}

const DATABASE_SPOOL_FILE_PREFIX = '.database-risudat-';
// POCKETRISU_SPOOL_DIR may relocate temporary database assembly. The default
// remains on the writable save volume and is independent of server backups.
const configuredDatabaseSpoolDir = String(process.env.POCKETRISU_SPOOL_DIR ?? '').trim();
const databaseSpoolDir = configuredDatabaseSpoolDir
    ? path.resolve(configuredDatabaseSpoolDir)
    : path.join(savePath, '.spool');
let databaseSpoolReady = true;
try {
    mkdirSync(databaseSpoolDir, { recursive: true });
} catch (error) {
    databaseSpoolReady = false;
    logger.error(`[Backup] Could not create database spool directory ${databaseSpoolDir}:`, error);
}
if (databaseSpoolReady) {
    try {
        for (const entry of readdirSync(databaseSpoolDir, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.startsWith(DATABASE_SPOOL_FILE_PREFIX)) continue;
            try {
                unlinkSync(path.join(databaseSpoolDir, entry.name));
            } catch (error) {
                logger.warn(`[Backup] Could not remove orphaned spool file ${entry.name}:`, error);
            }
        }
    } catch (error) {
        logger.warn(`[Backup] Could not sweep database spool directory ${databaseSpoolDir}:`, error);
    }
}

// Server-side backup directory (outside save/ to avoid bloating updater copies).
// Configurable at runtime via the kv key `config/server-backup-path`. When the
// user changes the path the old directory is left in place (existing backups
// stay where they were); only future backups land at the new path.
const DEFAULT_BACKUPS_DIR = path.join(process.cwd(), "backups");
const BACKUP_PATH_CONFIG_KEY = 'config/server-backup-path';
const MANAGED_BACKUP_PATH_ROOTS = new Set(['server', 'dist', 'scripts', 'bin', 'node_modules', '.update-tmp']);
// Plaintext marker the updater reads to preserve a custom in-tree backup dir
// during in-place updates. KV lives inside the SQLite DB so the updater (which
// runs without npm deps) can't read it; this marker bridges that gap.
const BACKUP_PATH_MARKER = path.join(savePath, '__backup_path');
const CHAT_BACKUP_PATH_MARKER = path.join(savePath, '__chat_backup_path');

function readBackupsDirConfig() {
    try {
        const raw = kvGet(BACKUP_PATH_CONFIG_KEY);
        if (!raw) return DEFAULT_BACKUPS_DIR;
        const text = Buffer.from(raw).toString('utf-8').trim();
        return text || DEFAULT_BACKUPS_DIR;
    } catch { return DEFAULT_BACKUPS_DIR; }
}

function writeBackupPathMarker(absPath) {
    try {
        require('fs').writeFileSync(BACKUP_PATH_MARKER, path.resolve(absPath), 'utf-8');
    } catch {
        // Best-effort; marker absence only means the updater falls back to the
        // hard-coded `backups` keep — same as before this feature existed.
    }
}

function writeChatBackupPathMarker(absPath) {
    try {
        require('fs').writeFileSync(CHAT_BACKUP_PATH_MARKER, path.resolve(absPath), 'utf-8');
    } catch {
        // Best-effort. The default is already under save/, which every updater
        // preserves; this marker protects an in-tree operator override.
    }
}

function updaterKeepEntryFromMarker(markerPath, label) {
    try {
        if (!existsSync(markerPath)) return null;
        const raw = readFileSync(markerPath, 'utf-8').trim();
        if (!raw) return null;
        const absolute = path.resolve(raw);
        const relative = path.relative(process.cwd(), absolute);
        if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
        if (!relative) {
            throw new Error(`${label} points at the PocketRisu app root; relocate it before updating.`);
        }
        const top = relative.split(path.sep)[0];
        if (MANAGED_BACKUP_PATH_ROOTS.has(top)) {
            throw new Error(`${label} is inside managed app files (${relative}); relocate it before updating.`);
        }
        return top || null;
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

function isManagedBackupPath(absPath) {
    const rel = path.relative(process.cwd(), absPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
    if (!rel) return true;
    return MANAGED_BACKUP_PATH_ROOTS.has(rel.split(path.sep)[0]);
}

let backupsDir = readBackupsDirConfig();
if(!HUB_HOSTING_MODE && !existsSync(backupsDir)){
    try { mkdirSync(backupsDir, { recursive: true }); }
    catch { backupsDir = DEFAULT_BACKUPS_DIR; mkdirSync(backupsDir, { recursive: true }); }
}
writeBackupPathMarker(backupsDir);
const chatBackupsDir = resolveChatBackupDir({ savePath });
writeChatBackupPathMarker(chatBackupsDir);
try {
    mkdirSync(chatBackupsDir, { recursive: true });
} catch (error) {
    // Capture/reconcile remain best-effort. In particular, an invalid operator
    // override must not make the authoritative database unavailable.
    logger.error('[ChatBackups] Could not create the chat-backup directory:', error?.message || error);
}
migrateLegacyChatBackups({
    legacyRoot: path.join(path.resolve(backupsDir), CHAT_BACKUP_DIRNAME),
    destinationRoot: chatBackupsDir,
    logger,
});
const BACKUP_FILENAME_REGEX = /^risu-backup-\d+\.bin$/;
const CHAT_BACKUP_VERSION_ID_REGEX = /^v-\d+-\d+-[a-z0-9_-]{1,24}$/;

const passwordPath = path.join(process.cwd(), 'save', '__password')
if(existsSync(passwordPath)){
    password = readFileSync(passwordPath, 'utf-8')
}

// ── NodeOnly: server-side JWT (HMAC-SHA256) ─────────────────────────────────
// Upstream uses client-side ECDSA JWT via crypto.subtle, which requires
// Secure Context (HTTPS or localhost). NodeOnly serves over HTTP,
// so we moved JWT signing/verification to the server using HMAC-SHA256.
// If upstream changes its auth flow, this section needs manual sync.
// Related: createServerJwt(), checkAuth(), /api/login, /api/token/refresh
const jwtSecretPath = path.join(savePath, '__jwt_secret')
let jwtSecret
if (existsSync(jwtSecretPath)) {
    jwtSecret = readFileSync(jwtSecretPath, 'utf-8').trim()
} else {
    jwtSecret = nodeCrypto.randomBytes(64).toString('hex')
    writeFileSync(jwtSecretPath, jwtSecret, 'utf-8')
}

// ── Instance ID for anonymous usage analytics ────────────────────────────────
const instanceIdPath = path.join(savePath, '__instance_id')
let instanceId
if (existsSync(instanceIdPath)) {
    instanceId = readFileSync(instanceIdPath, 'utf-8').trim()
} else {
    instanceId = nodeCrypto.randomUUID()
    writeFileSync(instanceIdPath, instanceId, 'utf-8')
}

const authCodePath = path.join(process.cwd(), 'save', '__authcode')
const inlayDir = path.join(savePath, 'inlays')
const inlayMigrationMarker = path.join(inlayDir, '.migrated_to_fs')
const IMPORT_JOURNAL_PATH = path.join(savePath, 'import_journal.json')
const IMPORT_JOURNAL_MARKER_KEY = 'import_journal/marker'
const hexRegex = /^[0-9a-fA-F]+$/;
const BACKUP_IMPORT_MAX_BYTES = Number(process.env.RISU_BACKUP_IMPORT_MAX_BYTES ?? '0');
const BACKUP_ENTRY_NAME_MAX_BYTES = 1024;
// Minimum free disk space headroom multiplier: require 2× the backup size to be free
const BACKUP_DISK_HEADROOM = 2;
// Heartbeat interval for NDJSON import progress stream. 5 s by default —
// shorter than every common reverse-proxy response timeout (nginx 60 s, Cloudflare
// 100 s). Operators behind more aggressive proxies can tighten this. Clamped to
// 100 ms so a misconfiguration can't spam the socket.
const BACKUP_NDJSON_HEARTBEAT_MS = Math.max(
    100,
    Number(process.env.BACKUP_NDJSON_HEARTBEAT_MS ?? '5000') || 5000,
);

function recoverPendingImportSwap(source) {
    const journal = readImportJournal(IMPORT_JOURNAL_PATH);
    if (!journal) return null;

    const markerValue = kvGet(IMPORT_JOURNAL_MARKER_KEY);
    const markerPresent = markerValue !== null
        && Buffer.from(markerValue).toString('utf-8') === journal.id;
    const summary = recoverImportSwap({ journal, markerPresent, fs: fsSync });
    logger.warn(
        `[Import Recovery] ${source}: ${summary.action} ${summary.directories} `
        + `directory swap(s) for journal ${journal.id} `
        + `(phase=${journal.phase}, markerPresent=${markerPresent})`
    );

    // Once backups have been finalized, marker deletion must not make a
    // repeated recovery interpret the imported live directories as uncommitted.
    if (summary.action === 'finalized' && journal.phase !== 'committed') {
        writeImportJournal(IMPORT_JOURNAL_PATH, { ...journal, phase: 'committed' });
    }
    if (markerValue !== null) kvDel(IMPORT_JOURNAL_MARKER_KEY);
    clearImportJournal(IMPORT_JOURNAL_PATH);
    return summary;
}

// ── Update check ─────────────────────────────────────────────────────────────
const UPDATE_CHECK_DISABLED = process.env.RISU_UPDATE_CHECK === 'false';
const UPDATE_CHECK_URL = process.env.RISU_UPDATE_URL || 'https://risu-update-worker.nodridan.workers.dev/check';
const PUBLIC_STATS_URL = (process.env.RISU_UPDATE_URL || 'https://risu-update-worker.nodridan.workers.dev/check').replace(/\/check$/, '/api/public-stats');

// Re-read on each call so non-portable updates (docker/git pull) without a
// process restart don't keep reporting the old version to the update worker.
function getCurrentVersion() {
    try {
        const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
        return pkg.version || '0.0.0';
    } catch { return '0.0.0'; }
}

// ── Deployment type & self-update helpers ─────────────────────────────────────
const GITHUB_REPO = 'PocketRisu/PocketRisu';

const deploymentType = (() => {
    // Only portable builds have the .portable marker (created by CI release workflow).
    // Self-update is gated on this — all other types are inferred for analytics only.
    // Wrapped in try/catch so unexpected filesystem errors can't crash server boot.
    try {
        if (existsSync(path.join(process.cwd(), '.portable'))) return 'portable';
        if (existsSync(path.join(process.cwd(), '.git'))) return 'git';
        if (existsSync('/.dockerenv')) return 'docker';
        try {
            const cgroup = readFileSync('/proc/1/cgroup', 'utf-8');
            if (cgroup.includes('docker') || cgroup.includes('containerd')) return 'docker';
        } catch {}
        if (process.platform === 'android') return 'termux';
    } catch {}
    return 'unknown';
})();

function getSelfUpdateAssetInfo(version) {
    const platformMap = { win32: 'win', linux: 'linux', darwin: 'macos' };
    const platformName = platformMap[process.platform];
    if (!platformName) return null;
    const arch = process.arch; // x64, arm64
    const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
    const filename = `PocketRisu-v${version}-${platformName}-${arch}.${ext}`;
    const url = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${filename}`;
    return { platformName, arch, ext, filename, url };
}

function isSafeInlayId(id) {
    return typeof id === 'string' &&
        id.length > 0 &&
        !id.includes('\0') &&
        !id.includes('/') &&
        !id.includes('\\') &&
        id !== '.' &&
        id !== '..';
}

function normalizeInlayExt(ext) {
    if (typeof ext !== 'string') return 'bin';
    const normalized = ext.trim().toLowerCase().replace(/^\.+/, '').replace(/[\/\\\0]/g, '');
    return normalized || 'bin';
}

const resolvedInlayDir = path.resolve(inlayDir) + path.sep;

function assertInsideInlayDir(filePath) {
    if (!path.resolve(filePath).startsWith(resolvedInlayDir)) {
        throw new Error(`Path escapes inlay directory: ${filePath}`);
    }
}

function getInlayFilePath(id, ext) {
    if (!isSafeInlayId(id)) throw new Error(`Invalid inlay id: ${id}`);
    const p = path.join(inlayDir, `${id}.${normalizeInlayExt(ext)}`);
    assertInsideInlayDir(p);
    return p;
}

function getInlaySidecarPath(id) {
    if (!isSafeInlayId(id)) throw new Error(`Invalid inlay id: ${id}`);
    const p = path.join(inlayDir, `${id}.meta.json`);
    assertInsideInlayDir(p);
    return p;
}

async function ensureInlayDir() {
    await fs.mkdir(inlayDir, { recursive: true });
}

function ensureInlayDirSync() {
    if (!existsSync(inlayDir)) {
        mkdirSync(inlayDir, { recursive: true });
    }
}

function getMimeFromExt(ext, buffer) {
    return ASSET_EXT_MIME[normalizeInlayExt(ext)] || detectMime(buffer);
}

function decodeDataUri(dataUri) {
    if (typeof dataUri !== 'string' || !dataUri.startsWith('data:')) {
        throw new Error('Invalid data URI');
    }
    const commaIdx = dataUri.indexOf(',');
    if (commaIdx === -1) {
        throw new Error('Malformed data URI');
    }
    const meta = dataUri.substring(5, commaIdx);
    return {
        buffer: Buffer.from(dataUri.substring(commaIdx + 1), 'base64'),
        mime: meta.split(';')[0] || 'application/octet-stream',
    };
}

function encodeDataUri(buffer, mime) {
    return `data:${mime || 'application/octet-stream'};base64,${Buffer.from(buffer).toString('base64')}`;
}

async function readInlaySidecar(id) {
    try {
        const raw = await fs.readFile(getInlaySidecarPath(id), 'utf-8');
        const parsed = JSON.parse(raw);
        return {
            ext: normalizeInlayExt(parsed?.ext),
            name: typeof parsed?.name === 'string' ? parsed.name : id,
            type: typeof parsed?.type === 'string' ? parsed.type : 'image',
            height: typeof parsed?.height === 'number' ? parsed.height : undefined,
            width: typeof parsed?.width === 'number' ? parsed.width : undefined,
        };
    } catch {
        return null;
    }
}

async function resolveInlayFilePath(id) {
    if (!isSafeInlayId(id)) return null;
    const sidecar = await readInlaySidecar(id);
    if (sidecar) {
        const candidate = getInlayFilePath(id, sidecar.ext);
        try { await fs.access(candidate); return candidate; } catch {}
    }
    // Fallback: scan directory (covers pre-sidecar files or mismatched ext)
    try {
        const entries = await fs.readdir(inlayDir, { withFileTypes: true });
        const match = entries.find((entry) => (
            entry.isFile() &&
            entry.name.startsWith(`${id}.`) &&
            entry.name !== `${id}.meta.json`
        ));
        return match ? path.join(inlayDir, match.name) : null;
    } catch {
        return null;
    }
}

function resolveInlayFilePathSync(id) {
    if (!isSafeInlayId(id)) return null;
    try {
        const raw = readFileSync(getInlaySidecarPath(id), 'utf-8');
        const parsed = JSON.parse(raw);
        const ext = normalizeInlayExt(parsed?.ext);
        const candidate = getInlayFilePath(id, ext);
        if (existsSync(candidate)) return candidate;
    } catch {}
    // Fallback: scan directory
    try {
        const entries = readdirSync(inlayDir, { withFileTypes: true });
        const match = entries.find((entry) => (
            entry.isFile() &&
            entry.name.startsWith(`${id}.`) &&
            entry.name !== `${id}.meta.json`
        ));
        return match ? path.join(inlayDir, match.name) : null;
    } catch {
        return null;
    }
}

async function readInlayFile(id) {
    const filePath = await resolveInlayFilePath(id);
    if (!filePath) return null;
    const ext = normalizeInlayExt(path.extname(filePath).slice(1));
    const buffer = await fs.readFile(filePath);
    const stat = await fs.stat(filePath);
    return {
        buffer,
        ext,
        filePath,
        mtimeMs: stat.mtimeMs,
        mime: getMimeFromExt(ext, buffer),
    };
}

async function writeInlaySidecar(id, info) {
    await ensureInlayDir();
    const sidecar = {
        ext: normalizeInlayExt(info?.ext),
        name: typeof info?.name === 'string' ? info.name : id,
        type: typeof info?.type === 'string' ? info.type : 'image',
        height: typeof info?.height === 'number' ? info.height : undefined,
        width: typeof info?.width === 'number' ? info.width : undefined,
    };
    await fs.writeFile(getInlaySidecarPath(id), JSON.stringify(sidecar));
}

function writeInlaySidecarSync(id, info) {
    ensureInlayDirSync();
    const sidecar = {
        ext: normalizeInlayExt(info?.ext),
        name: typeof info?.name === 'string' ? info.name : id,
        type: typeof info?.type === 'string' ? info.type : 'image',
        height: typeof info?.height === 'number' ? info.height : undefined,
        width: typeof info?.width === 'number' ? info.width : undefined,
    };
    writeFileSync(getInlaySidecarPath(id), JSON.stringify(sidecar));
}

async function writeInlayFile(id, ext, buffer, info = null) {
    await ensureInlayDir();
    await deleteInlayRawFile(id);
    const normalizedExt = normalizeInlayExt(ext);
    await fs.writeFile(getInlayFilePath(id, normalizedExt), Buffer.from(buffer));
    await writeInlaySidecar(id, {
        ...(info || {}),
        ext: normalizedExt,
    });
    kvClearDeletion(`inlay/${id}`);
}

function writeInlayFileSync(id, ext, buffer, info = null) {
    ensureInlayDirSync();
    deleteInlayRawFileSync(id);
    const normalizedExt = normalizeInlayExt(ext);
    writeFileSync(getInlayFilePath(id, normalizedExt), Buffer.from(buffer));
    writeInlaySidecarSync(id, {
        ...(info || {}),
        ext: normalizedExt,
    });
    kvClearDeletion(`inlay/${id}`);
}

async function deleteInlayRawFile(id) {
    const filePath = await resolveInlayFilePath(id);
    if (!filePath) return;
    await fs.unlink(filePath).catch(() => {});
}

function deleteInlayRawFileSync(id) {
    const filePath = resolveInlayFilePathSync(id);
    if (!filePath) return;
    try {
        unlinkSync(filePath);
    } catch {
        // ignore
    }
}

async function deleteInlayFile(id) {
    await deleteInlayRawFile(id);
    await fs.unlink(getInlaySidecarPath(id)).catch(() => {});
}

function deleteInlayFileSync(id) {
    deleteInlayRawFileSync(id);
    try {
        unlinkSync(getInlaySidecarPath(id));
    } catch {
        // ignore
    }
}

async function listInlayFiles() {
    await ensureInlayDir();
    const entries = await fs.readdir(inlayDir, { withFileTypes: true });
    return entries
        .filter((entry) => (
            entry.isFile() &&
            entry.name !== '.migrated_to_fs' &&
            !entry.name.endsWith('.meta.json')
        ))
        .map((entry) => {
            const ext = normalizeInlayExt(path.extname(entry.name).slice(1));
            const id = entry.name.slice(0, -(ext.length + 1));
            return { id, ext, filePath: path.join(inlayDir, entry.name) };
        })
        .filter((entry) => isSafeInlayId(entry.id));
}

async function readInlayLegacyInfo(id) {
    const value = kvGet(`inlay_info/${id}`);
    if (!value) return null;
    try {
        const parsed = JSON.parse(value.toString('utf-8'));
        return {
            ext: normalizeInlayExt(parsed?.ext),
            name: typeof parsed?.name === 'string' ? parsed.name : id,
            type: typeof parsed?.type === 'string' ? parsed.type : 'image',
            height: typeof parsed?.height === 'number' ? parsed.height : undefined,
            width: typeof parsed?.width === 'number' ? parsed.width : undefined,
        };
    } catch {
        return null;
    }
}

async function readInlayInfoPayload(id) {
    const sidecar = await readInlaySidecar(id);
    if (sidecar) return Buffer.from(JSON.stringify(sidecar));
    const legacy = await readInlayLegacyInfo(id);
    if (legacy) return Buffer.from(JSON.stringify(legacy));
    return kvGet(`inlay_info/${id}`);
}

async function readInlayAssetPayload(id) {
    const file = await readInlayFile(id);
    if (!file) return null;
    const sidecar = (await readInlaySidecar(id)) || (await readInlayLegacyInfo(id));
    const info = {
        ext: sidecar?.ext || file.ext,
        name: sidecar?.name || id,
        type: sidecar?.type || 'image',
        height: sidecar?.height,
        width: sidecar?.width,
    };
    const data = info.type === 'signature'
        ? file.buffer.toString('utf-8')
        : encodeDataUri(file.buffer, file.mime);
    return Buffer.from(JSON.stringify({
        ...info,
        data,
    }));
}

async function migrateInlaysToFilesystem() {
    await ensureInlayDir();
    if (existsSync(inlayMigrationMarker)) return;

    const keys = kvList('inlay/');
    for (const key of keys) {
        const id = key.slice('inlay/'.length);
        if (!isSafeInlayId(id)) continue;
        const fileAlreadyExists = await readInlayFile(id);
        if (fileAlreadyExists) {
            kvDel(key);
            kvDel(`inlay_thumb/${id}`);
            kvDel(`inlay_info/${id}`);
            kvClearDeletion(key);
            continue;
        }
        const value = kvGet(key);
        if (!value) continue;
        try {
            const parsed = JSON.parse(value.toString('utf-8'));
            const type = typeof parsed?.type === 'string' ? parsed.type : 'image';
            const ext = normalizeInlayExt(parsed?.ext);
            let buffer;
            if (type === 'signature') {
                buffer = Buffer.from(typeof parsed?.data === 'string' ? parsed.data : '', 'utf-8');
            } else {
                buffer = decodeDataUri(parsed?.data).buffer;
            }
            const info = (await readInlayLegacyInfo(id)) || {
                ext,
                name: typeof parsed?.name === 'string' ? parsed.name : id,
                type,
                height: typeof parsed?.height === 'number' ? parsed.height : undefined,
                width: typeof parsed?.width === 'number' ? parsed.width : undefined,
            };
            await writeInlayFile(id, ext, buffer, info);
            kvDel(key);
            kvDel(`inlay_thumb/${id}`);
            kvDel(`inlay_info/${id}`);
            kvClearDeletion(key);
        } catch (error) {
            logger.warn(`[InlayFS] Failed to migrate ${key}:`, error?.message || error);
        }
    }

    await fs.writeFile(inlayMigrationMarker, new Date().toISOString(), 'utf-8');
}

function assetNameForKey(key) {
    return typeof key === 'string' && key.startsWith('assets/')
        ? key.slice('assets/'.length)
        : null;
}

function readAssetValue(key, reader = { kvGet }) {
    const name = assetNameForKey(key);
    if (name !== null && isSafeAssetName(name)) {
        const fileValue = readAssetFile(name);
        if (fileValue !== null) return fileValue;
    }
    return reader.kvGet(key);
}

function writeAssetValue(key, value, options = {}) {
    const { skipIfUnchanged = false } = options;
    const name = assetNameForKey(key);
    if (name !== null && isSafeAssetName(name)) {
        let wrote = true;
        if (skipIfUnchanged) {
            wrote = writeAssetFileIfChanged(name, value);
        } else {
            writeAssetFile(name, value);
        }
        // A crash between the file rename and this delete is harmless: reads
        // prefer the file, and the startup migration removes the duplicate.
        kvDel(key);
        // kvDel records logical removals automatically, but this delete only
        // removes the shadow kv row; the freshly written file remains live.
        kvClearDeletion(key);
        return wrote;
    }
    kvSet(key, value);
    return true;
}

function deleteAssetValue(key) {
    const name = assetNameForKey(key);
    if (name !== null && isSafeAssetName(name)) {
        deleteAssetFile(name);
    }
    kvDel(key);
}

function listAssetEntriesWithSizes(reader = { kvListWithSizes }) {
    const entries = new Map();
    for (const file of listAssetFiles()) {
        entries.set(`assets/${file.name}`, {
            key: `assets/${file.name}`,
            size: file.size,
            mtimeMs: file.mtimeMs,
            source: 'fs',
        });
    }
    for (const row of reader.kvListWithSizes('assets/')) {
        if (!entries.has(row.key)) {
            entries.set(row.key, {
                key: row.key,
                size: row.size,
                mtimeMs: null,
                source: 'kv',
            });
        }
    }
    return [...entries.values()].sort((a, b) => a.key.localeCompare(b.key));
}

const assetImportStagingDir = path.join(savePath, 'assets_import_staging');
const assetImportBackupDir = path.join(savePath, 'assets_import_backup');

async function prepareAssetImportStage() {
    recoverPendingImportSwap('Asset import preparation');
    await fs.rm(assetImportStagingDir, { recursive: true, force: true });
    await fs.rm(assetImportBackupDir, { recursive: true, force: true });
    const store = createAssetStore({ assetDir: assetImportStagingDir });
    store.ensureAssetDir();
    writeFileSync(store.migrationMarkerPath, new Date().toISOString(), 'utf-8');
    return { store };
}

function warnImportedAssetHashMismatch(key, value, source) {
    const verification = verifyAssetHash(key, value);
    if (!verification.ok) {
        logger.warn(
            `[AssetFS] ${source} hash mismatch for ${key}: `
            + `expected=${verification.claimed} actual=${verification.actual}; importing verbatim`
        );
    }
}

function writeImportedAsset(assetStage, key, value, source, writeKv = kvSet) {
    warnImportedAssetHashMismatch(key, value, source);
    const name = assetNameForKey(key);
    if (name !== null && isSafeAssetName(name)) {
        assetStage.store.writeAssetFile(name, value);
        kvClearDeletion(key);
        return 'fs';
    }
    writeKv(key, value);
    return 'kv';
}

function migrateAssetsToFilesystem() {
    ensureAssetDir();
    if (existsSync(assetMigrationMarker)) return;

    const keys = kvList('assets/');
    if (keys.length > 0) {
        console.log(`[AssetFS] Migrating ${keys.length} asset row(s) to ${assetDir}...`);
    }
    const result = migrateAssetRowsToFilesystem({
        keys,
        getValue: (key) => {
            const value = kvGet(key);
            if (value !== null) {
                warnImportedAssetHashMismatch(key, value, 'Startup migration');
            }
            return value;
        },
        deleteValue: (key) => {
            kvDel(key);
            kvClearDeletion(key);
        },
        store: {
            isSafeAssetName,
            writeAssetFileIfChanged,
        },
        onProgress: ({ index, total, migrated }) => {
            if (migrated % 100 === 0 || index === total - 1) {
                console.log(`[AssetFS] Migrating... ${index + 1}/${total}`);
            }
        },
    });
    writeFileSync(assetMigrationMarker, new Date().toISOString(), 'utf-8');
    if (keys.length > 0) {
        console.log(
            `[AssetFS] Migration complete. ${result.migrated} moved, `
            + `${result.skippedUnsafe} unsafe name(s) kept in SQLite.`
        );
    }
}

async function fetchLatestRelease(lang) {
    if (UPDATE_CHECK_DISABLED) return null;
    try {
        const currentVersion = getCurrentVersion();
        const params = new URLSearchParams({
            v: currentVersion,
            d: deploymentType,
            os: `${process.platform}-${process.arch}`,
            id: instanceId,
        });
        if (lang) params.set('l', String(lang).slice(0, 16));
        const url = `${UPDATE_CHECK_URL}?${params}`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        if (data.hasUpdate) {
            console.log(`[Update] New version available: v${data.latestVersion} (current: v${currentVersion}, ${data.severity})`);
        }
        return data;
    } catch (e) {
        logger.error('[Update] Failed to check for updates:', e.message);
        return null;
    }
}

// ── Session store for direct asset URL auth (F-0) ──────────────────────────
// <img src="/api/asset/..."> cannot send custom headers, so we use a session
// cookie issued after initial JWT auth. Single-user environment: Map is fine.
// Sessions are persisted to disk so they survive server restarts.
const SESSION_FILE = path.join(process.cwd(), 'save', '__sessions')
const sessions = new Map() // token → expiresAt (ms)

function loadSessions() {
    try {
        const raw = readFileSync(SESSION_FILE, 'utf-8')
        const now = Date.now()
        for (const [token, exp] of JSON.parse(raw)) {
            if (exp > now) sessions.set(token, exp)
        }
    } catch { /* file missing or corrupt – start fresh */ }
}

function saveSessions() {
    try { writeFileSync(SESSION_FILE, JSON.stringify([...sessions])) }
    catch { /* non-critical */ }
}

loadSessions()

function parseSessionCookie(req) {
    const cookieHeader = req.headers.cookie || ''
    for (const part of cookieHeader.split(';')) {
        const eq = part.indexOf('=')
        if (eq === -1) continue
        if (part.slice(0, eq).trim() === 'risu-session') return part.slice(eq + 1).trim()
    }
    return null
}

function sessionAuthMiddleware(req, res, next) {
    const token = parseSessionCookie(req)
    if (token && (sessions.get(token) ?? 0) > Date.now()) return next()
    res.status(401).end()
}

// MIME detection by magic bytes (fallback when key has no extension)
function detectMime(buf) {
    if (!buf || buf.length < 12) return 'application/octet-stream'
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp'
    if (buf[0] === 0x1a && buf[1] === 0x45) return 'video/webm'
    if (buf.length >= 8 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'video/mp4'
    return 'application/octet-stream'
}
const ASSET_EXT_MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp',
    mp4: 'video/mp4', webm: 'video/webm',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
}

async function checkDiskSpace(requiredBytes) {
    try {
        const saveDir = path.join(process.cwd(), 'save');
        const stats = await fs.statfs(saveDir);
        const availableBytes = stats.bavail * stats.bsize;
        return { ok: availableBytes >= requiredBytes, available: availableBytes };
    } catch {
        // statfs unavailable on this platform — skip check
        return { ok: true, available: -1 };
    }
}

// ── Active writer session (single-writer lock) ────────────────────────────────
// Mirrors the BroadcastChannel-based tab lock on the server side so that the
// same protection extends across devices. The last client to call /api/session
// becomes the active writer; older sessions receive 423 on write attempts.
let activeSessionId = null // string | null

function checkActiveSession(req, res) {
    const clientSessionId = req.headers['x-session-id']
    if (!clientSessionId) return true  // client without session support
    if (!activeSessionId) return true  // no session registered yet
    if (clientSessionId === activeSessionId) return true
    res.status(423).json({ error: 'Session deactivated' })
    return false
}

// --- Proxy Stream Job constants ---
const PROXY_STREAM_DEFAULT_TIMEOUT_MS = 600000;
const PROXY_STREAM_MAX_TIMEOUT_MS = 3600000;
const PROXY_STREAM_DEFAULT_HEARTBEAT_SEC = 15;
const PROXY_STREAM_HEARTBEAT_MIN_SEC = 5;
const PROXY_STREAM_HEARTBEAT_MAX_SEC = 60;
const PROXY_STREAM_GC_INTERVAL_MS = 60000;
const PROXY_STREAM_DONE_GRACE_MS = 30000;
const PROXY_STREAM_MAX_ACTIVE_JOBS = 64;
const PROXY_STREAM_MAX_PENDING_EVENTS = 512;
const PROXY_STREAM_MAX_PENDING_BYTES = 2 * 1024 * 1024;
const PROXY_STREAM_MAX_BODY_BASE64_BYTES = 8 * 1024 * 1024;
const proxyStreamJobs = new Map();

const loginRouteLimiter = rateLimit({
    windowMs: 30 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please wait and try again later.' },
    validate: { xForwardedForHeader: false }
});

function isHex(str) {
    return hexRegex.test(str.toUpperCase().trim()) || str === '__password';
}

async function hashJSON(json){
    const hash = nodeCrypto.createHash('sha256');
    hash.update(JSON.stringify(json));
    return hash.digest('hex');
}

// NodeOnly: server-issued JWT (see jwt_secret comment above)
function createServerJwt() {
    const now = Math.floor(Date.now() / 1000)
    const header = { alg: 'HS256', typ: 'JWT' }
    const payload = { iat: now, exp: now + 5 * 60 }
    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url')
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const sig = nodeCrypto.createHmac('sha256', jwtSecret)
        .update(`${headerB64}.${payloadB64}`)
        .digest('base64url')
    return `${headerB64}.${payloadB64}.${sig}`
}

function getRequestTimeoutMs(timeoutHeader) {
    const raw = Array.isArray(timeoutHeader) ? timeoutHeader[0] : timeoutHeader;
    if (!raw) {
        return null;
    }
    const timeoutMs = Number.parseInt(raw, 10);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return null;
    }
    return timeoutMs;
}

function createTimeoutController(timeoutMs) {
    if (!timeoutMs) {
        return {
            signal: undefined,
            cleanup: () => {}
        };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    return {
        signal: controller.signal,
        cleanup: () => clearTimeout(timer)
    };
}

// --- Proxy Stream: auth helpers ---

function normalizeAuthHeader(authHeader) {
    if (Array.isArray(authHeader)) {
        return authHeader[0] || '';
    }
    return typeof authHeader === 'string' ? authHeader : '';
}

async function isAuthorizedProxyRequest(req) {
    return await checkAuth(req, null, true);
}

async function checkProxyAuth(req, res) {
    return await checkAuth(req, res);
}

// --- Proxy Stream: network helpers ---

function isPrivateIPv4Host(hostname) {
    const parts = hostname.split('.');
    if (parts.length !== 4) {
        return false;
    }
    const octets = parts.map((part) => Number.parseInt(part, 10));
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
        return false;
    }
    const [a, b] = octets;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
}

function isLocalNetworkHost(hostname) {
    if (typeof hostname !== 'string' || hostname.trim() === '') {
        return false;
    }
    const normalizedHost = hostname.toLowerCase().replace(/\.$/, '').split('%')[0];
    if (normalizedHost === 'localhost' || normalizedHost === '::1' || normalizedHost.endsWith('.local')) {
        return true;
    }
    // NodeOnly policy: keep server-side validation aligned with the client helper
    // for Node/self-hosted deployments where single-label LAN or Docker DNS names
    // like "litellm" / "ollama" are valid local targets. Upstream currently only
    // allows localhost/.local/IP here, but NodeOnly routes all local-network-mode
    // traffic through the Node server, so rejecting single-label hosts would make
    // the feature unusable for common self-hosted setups.
    if (/^[a-z0-9_-]+$/i.test(normalizedHost) && !normalizedHost.includes('.')) {
        return true;
    }
    if (net.isIP(normalizedHost) === 4) {
        return isPrivateIPv4Host(normalizedHost);
    }
    if (net.isIP(normalizedHost) === 6) {
        if (normalizedHost.startsWith('::ffff:')) {
            const mapped = normalizedHost.substring(7);
            return net.isIP(mapped) === 4 && isPrivateIPv4Host(mapped);
        }
        if (normalizedHost.startsWith('fc') || normalizedHost.startsWith('fd')) {
            return true;
        }
        if (/^fe[89ab]/.test(normalizedHost)) {
            return true;
        }
        return normalizedHost === '::1';
    }
    return false;
}

function sanitizeTargetUrl(raw) {
    if (typeof raw !== 'string' || raw.trim() === '') {
        return null;
    }
    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return null;
        }
        if (!isLocalNetworkHost(parsed.hostname)) {
            return null;
        }
        parsed.username = '';
        parsed.password = '';
        return parsed.toString();
    } catch {
        return null;
    }
}

// --- Proxy Stream: request/response helpers ---

function normalizeForwardHeaders(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return {};
    }
    const normalized = {};
    for (const [key, value] of Object.entries(input)) {
        if (typeof key !== 'string') continue;
        if (typeof value === 'string') {
            normalized[key] = value;
        }
    }
    delete normalized['risu-auth'];
    delete normalized['risu-timeout-ms'];
    delete normalized['host'];
    delete normalized['connection'];
    delete normalized['content-length'];
    return normalized;
}

function normalizeProxyResponseHeaders(headers) {
    const normalized = {};
    for (const [key, value] of Object.entries(headers || {})) {
        if (value === undefined) continue;
        normalized[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    return normalized;
}

function normalizeProxyStreamTimeoutMs(timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return PROXY_STREAM_DEFAULT_TIMEOUT_MS;
    }
    const parsed = Math.max(1, Math.floor(timeoutMs));
    return Math.min(PROXY_STREAM_MAX_TIMEOUT_MS, parsed);
}

function normalizeHeartbeatSec(heartbeatSec) {
    if (!Number.isFinite(heartbeatSec)) {
        return PROXY_STREAM_DEFAULT_HEARTBEAT_SEC;
    }
    const parsed = Math.floor(heartbeatSec);
    return Math.min(PROXY_STREAM_HEARTBEAT_MAX_SEC, Math.max(PROXY_STREAM_HEARTBEAT_MIN_SEC, parsed));
}

// --- Proxy Stream: native HTTP request to local target ---

function requestLocalTargetStream(targetUrl, arg) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(targetUrl);
        const client = parsedUrl.protocol === 'https:' ? https : http;
        const headers = normalizeForwardHeaders(arg.headers);
        if (!headers['host']) {
            headers['host'] = parsedUrl.host;
        }
        if (arg.bodyBuffer && !headers['content-length']) {
            headers['content-length'] = String(arg.bodyBuffer.length);
        }

        let settled = false;
        let cleanupAbort = () => {};
        const finishReject = (error) => {
            if (settled) return;
            settled = true;
            cleanupAbort();
            reject(error);
        };

        const req = client.request(parsedUrl, {
            method: arg.method,
            headers
        }, (res) => {
            if (settled) {
                res.destroy();
                return;
            }
            settled = true;
            cleanupAbort();
            resolve({
                status: res.statusCode || 502,
                headers: normalizeProxyResponseHeaders(res.headers),
                body: res
            });
        });

        req.on('error', (error) => {
            finishReject(error);
        });

        req.setTimeout(arg.timeoutMs, () => {
            req.destroy(new Error(`Upstream request timed out after ${arg.timeoutMs}ms`));
        });

        if (arg.signal) {
            const onAbort = () => {
                const abortError = new Error('Proxy stream job aborted');
                abortError.name = 'AbortError';
                req.destroy(abortError);
            };
            if (arg.signal.aborted) {
                onAbort();
                return;
            }
            arg.signal.addEventListener('abort', onAbort, { once: true });
            cleanupAbort = () => arg.signal.removeEventListener('abort', onAbort);
        }

        if (arg.bodyBuffer && arg.method !== 'GET' && arg.method !== 'HEAD') {
            req.write(arg.bodyBuffer);
        }
        req.end();
    });
}

// --- Proxy Stream: job lifecycle ---

function createProxyStreamJob(arg) {
    const jobId = nodeCrypto.randomUUID();
    const timeoutMs = normalizeProxyStreamTimeoutMs(Number(arg.timeoutMs));
    const heartbeatSec = normalizeHeartbeatSec(arg.heartbeatSec);
    const controller = new AbortController();
    const createdAt = Date.now();
    const job = {
        id: jobId,
        createdAt,
        updatedAt: createdAt,
        done: false,
        cleanupAt: 0,
        clients: new Set(),
        pendingEvents: [],
        pendingBytes: 0,
        abortController: controller,
        deadlineAt: createdAt + timeoutMs,
        heartbeatSec,
        timeoutMs
    };
    proxyStreamJobs.set(jobId, job);
    return job;
}

function pushJobEvent(job, event) {
    job.updatedAt = Date.now();
    const text = JSON.stringify(event);
    if (job.clients.size === 0) {
        job.pendingEvents.push(text);
        job.pendingBytes += Buffer.byteLength(text);
        while (
            job.pendingEvents.length > PROXY_STREAM_MAX_PENDING_EVENTS
            || job.pendingBytes > PROXY_STREAM_MAX_PENDING_BYTES
        ) {
            const removed = job.pendingEvents.shift();
            if (!removed) break;
            job.pendingBytes -= Buffer.byteLength(removed);
        }
        return;
    }
    for (const client of job.clients) {
        if (client.readyState === client.OPEN) {
            client.send(text);
        }
    }
}

function markJobDone(job) {
    if (job.done) return;
    job.done = true;
    job.cleanupAt = Date.now() + PROXY_STREAM_DONE_GRACE_MS;
}

function cleanupJob(jobId) {
    const job = proxyStreamJobs.get(jobId);
    if (!job) return;
    for (const client of job.clients) {
        try { client.close(); } catch { /* ignore */ }
    }
    proxyStreamJobs.delete(jobId);
}

async function runProxyStreamJob(job, arg) {
    const targetUrl = sanitizeTargetUrl(arg.targetUrl);
    if (!targetUrl) {
        pushJobEvent(job, { type: 'error', status: 400, message: 'Blocked non-local target URL' });
        markJobDone(job);
        return;
    }

    const headers = normalizeForwardHeaders(arg.headers);
    if (!headers['x-forwarded-for']) {
        headers['x-forwarded-for'] = arg.clientIp;
    }
    const bodyBuffer = arg.bodyBase64 ? Buffer.from(arg.bodyBase64, 'base64') : undefined;

    try {
        const upstreamResponse = await requestLocalTargetStream(targetUrl, {
            method: arg.method,
            headers,
            bodyBuffer,
            timeoutMs: job.timeoutMs,
            signal: job.abortController.signal
        });

        const filteredHeaders = {};
        for (const [key, value] of Object.entries(upstreamResponse.headers)) {
            if (key === 'content-security-policy' || key === 'content-security-policy-report-only' || key === 'clear-site-data') {
                continue;
            }
            filteredHeaders[key] = value;
        }

        pushJobEvent(job, { type: 'upstream_headers', status: upstreamResponse.status, headers: filteredHeaders });

        if (upstreamResponse.body) {
            for await (const value of upstreamResponse.body) {
                if (job.abortController.signal.aborted) break;
                if (value && value.length > 0) {
                    pushJobEvent(job, { type: 'chunk', dataBase64: Buffer.from(value).toString('base64') });
                }
            }
        }
        pushJobEvent(job, { type: 'done' });
        markJobDone(job);
    } catch (error) {
        const message = error?.name === 'AbortError' ? 'Proxy stream job aborted' : `${error}`;
        pushJobEvent(job, { type: 'error', status: 504, message });
        markJobDone(job);
    }
}

// --- Proxy Stream: WebSocket setup ---

function setupProxyStreamWebSocket(server) {
    const wsServer = new WebSocketServer({ noServer: true });
    server.on('upgrade', async (req, socket, head) => {
        try {
            const reqUrl = new URL(req.url, `http://${req.headers.host}`);
            if (!reqUrl.pathname.startsWith('/proxy-stream-jobs/') || !reqUrl.pathname.endsWith('/ws')) {
                socket.destroy();
                return;
            }

            const auth = reqUrl.searchParams.get('risu-auth') || normalizeAuthHeader(req.headers['risu-auth']);
            if (!await isAuthorizedProxyRequest({ headers: { 'risu-auth': auth } })) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }

            const pathParts = reqUrl.pathname.split('/').filter(Boolean);
            const jobId = pathParts.length >= 3 ? pathParts[1] : '';
            const job = proxyStreamJobs.get(jobId);
            if (!job) {
                socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
                socket.destroy();
                return;
            }

            wsServer.handleUpgrade(req, socket, head, (ws) => {
                wsServer.emit('connection', ws, req, jobId);
            });
        } catch {
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            socket.destroy();
        }
    });

    wsServer.on('connection', (ws, _req, jobId) => {
        const job = proxyStreamJobs.get(jobId);
        if (!job) {
            ws.close();
            return;
        }

        job.clients.add(ws);
        ws.send(JSON.stringify({ type: 'job_accepted', jobId }));
        for (const event of job.pendingEvents) {
            ws.send(event);
        }
        job.pendingEvents = [];
        job.pendingBytes = 0;

        const pingTimer = setInterval(() => {
            if (ws.readyState !== ws.OPEN) return;
            ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
        }, job.heartbeatSec * 1000);

        ws.on('close', () => {
            clearInterval(pingTimer);
            const currentJob = proxyStreamJobs.get(jobId);
            if (!currentJob) return;
            currentJob.clients.delete(ws);
            if (currentJob.done && currentJob.clients.size === 0) {
                cleanupJob(jobId);
            }
        });

        ws.on('error', () => {
            clearInterval(pingTimer);
        });
    });
}

function encodeBackupEntryHeader(name, dataSize) {
    const encodedName = Buffer.from(name, 'utf-8');
    const nameLength = Buffer.allocUnsafe(4);
    nameLength.writeUInt32LE(encodedName.length, 0);
    const dataLength = Buffer.allocUnsafe(4);
    dataLength.writeUInt32LE(dataSize, 0);
    return Buffer.concat([nameLength, encodedName, dataLength]);
}

function encodeBackupEntry(name, data) {
    return Buffer.concat([encodeBackupEntryHeader(name, data.length), data]);
}

function backupEntrySize(name, dataSize) {
    return 8 + Buffer.byteLength(name, 'utf-8') + dataSize;
}

async function writeWithBackpressure(writable, chunk, isClosed = () => false) {
    if (isClosed()) return false;
    if (writable.write(chunk)) return true;
    return new Promise((resolve, reject) => {
        function cleanup() {
            writable.removeListener('drain', onDrain);
            writable.removeListener('error', onError);
            writable.removeListener('close', onClose);
        }
        function onDrain() {
            cleanup();
            resolve(true);
        }
        function onError(error) {
            cleanup();
            reject(error);
        }
        function onClose() {
            cleanup();
            if (isClosed()) resolve(false);
            else reject(new Error('Backup destination closed before draining'));
        }
        writable.once('drain', onDrain);
        writable.once('error', onError);
        writable.once('close', onClose);
    });
}

async function streamFileToWritable(filePath, writable, isClosed = () => false) {
    const input = createReadStream(filePath, { highWaterMark: 256 * 1024 });
    try {
        for await (const chunk of input) {
            if (!await writeWithBackpressure(writable, chunk, isClosed)) return false;
        }
        return !isClosed();
    } finally {
        input.destroy();
    }
}

function isInvalidBackupPathSegment(name) {
    return (
        !name ||
        name.includes('\0') ||
        name.includes('\\') ||
        name.startsWith('/') ||
        name.includes('../') ||
        name.includes('/..') ||
        name === '.' ||
        name === '..'
    );
}

function parseInlayBackupName(name) {
    if (!name.startsWith('inlay/')) return null;
    const suffix = name.slice('inlay/'.length);
    if (!suffix || suffix.includes('/')) return null;
    const dotIdx = suffix.lastIndexOf('.');
    if (dotIdx <= 0) {
        return { id: suffix, ext: null };
    }
    return {
        id: suffix.slice(0, dotIdx),
        ext: suffix.slice(dotIdx + 1),
    };
}

function parseInlaySidecarBackupName(name) {
    if (!name.startsWith('inlay_sidecar/')) return null;
    const id = name.slice('inlay_sidecar/'.length);
    if (!isSafeInlayId(id)) return null;
    return { id };
}

function normalizeColdStorageStorageKey(nameOrKey) {
    let key = nameOrKey;
    if (key.startsWith('coldstorage/')) {
        key = key.slice('coldstorage/'.length);
    }
    if (key.endsWith('.json')) {
        key = key.slice(0, -'.json'.length);
    }
    if (!key || key.includes('/') || isInvalidBackupPathSegment(key)) {
        throw new Error(`Invalid cold storage entry name: ${nameOrKey}`);
    }
    return `coldstorage/${key}`;
}

function toColdStorageBackupName(storageKey) {
    return `${normalizeColdStorageStorageKey(storageKey)}.json`;
}

function parseColdStorageJsonBuffer(buffer, sourceLabel, options = {}) {
    const { allowPlainJson = false } = options;
    try {
        const decompressed = zlib.gunzipSync(buffer);
        return {
            coldData: JSON.parse(decompressed.toString('utf-8')),
            format: 'gzip',
        };
    } catch (gzipError) {
        if (!allowPlainJson) {
            throw gzipError;
        }
        try {
            return {
                coldData: JSON.parse(buffer.toString('utf-8')),
                format: 'plain-json',
            };
        } catch (jsonError) {
            throw new Error(`[ColdStorage] failed to parse ${sourceLabel}: gzip=${gzipError.message}; json=${jsonError.message}`);
        }
    }
}

function encodeColdStorageCanonicalBuffer(coldData) {
    return Buffer.from(zlib.gzipSync(Buffer.from(JSON.stringify(coldData), 'utf-8')));
}

function readColdStorageJsonEntry(nameOrKey, options = {}) {
    const {
        migrateLegacy = false,
        allowPlainJsonFallback = false,
        reader = { kvGet },
    } = options;
    const canonicalKey = normalizeColdStorageStorageKey(nameOrKey);
    const legacyBackupKey = `${canonicalKey}.json`;

    let storageKey = canonicalKey;
    let value = reader.kvGet(canonicalKey);
    if (!value) {
        storageKey = legacyBackupKey;
        value = reader.kvGet(legacyBackupKey);
    }
    if (!value) {
        return null;
    }

    const parsed = parseColdStorageJsonBuffer(value, storageKey, {
        allowPlainJson: allowPlainJsonFallback || storageKey !== canonicalKey,
    });

    if (migrateLegacy && (storageKey !== canonicalKey || parsed.format !== 'gzip')) {
        kvSet(canonicalKey, encodeColdStorageCanonicalBuffer(parsed.coldData));
        if (storageKey !== canonicalKey) {
            kvDel(storageKey);
        }
    }

    return {
        coldData: parsed.coldData,
        storageKey,
        canonicalKey,
        format: parsed.format,
    };
}

function listColdStorageBackupEntries(options = {}) {
    const {
        reader = { kvGet, kvList },
        migrateLegacy = true,
    } = options;
    const canonicalKeys = Array.from(new Set(
        reader.kvList('coldstorage/').map((key) => normalizeColdStorageStorageKey(key))
    )).sort((a, b) => a.localeCompare(b));

    return canonicalKeys.map((storageKey) => {
        const entry = readColdStorageJsonEntry(storageKey, {
            migrateLegacy,
            allowPlainJsonFallback: true,
            reader,
        });
        if (!entry) {
            throw new Error(`[ColdStorage] missing cold storage entry while exporting: ${storageKey}`);
        }
        const plainJson = Buffer.from(JSON.stringify(entry.coldData), 'utf-8');
        return {
            kind: 'buffer',
            buffer: plainJson,
            backupName: toColdStorageBackupName(storageKey),
            sortKey: toColdStorageBackupName(storageKey),
            size: plainJson.length,
        };
    });
}

function hasExternalizablePluginStorage(dbObj) {
    if (!dbObj) return false;
    if (dbObj[PLUGIN_STORAGE_FOLDED_MARKER] === true) return true;
    if (dbObj.optimizePluginMemory !== true) return false;
    const inlineValues = dbObj.pluginCustomStorage;
    const hasValues = inlineValues !== null
        && typeof inlineValues === 'object'
        && Object.keys(inlineValues).length > 0;
    const hasMetaField = Object.prototype.hasOwnProperty.call(dbObj, 'pluginStorageMeta');
    return hasValues || hasMetaField;
}

function preparePluginStorageExternalization(dbObj) {
    const hasMarkerField = Boolean(dbObj)
        && Object.prototype.hasOwnProperty.call(dbObj, PLUGIN_STORAGE_FOLDED_MARKER);
    if (!hasExternalizablePluginStorage(dbObj)) {
        if (!hasMarkerField) {
            return {
                strippedDb: dbObj,
                rows: [],
                changed: false,
                externalized: false,
                clearExisting: false,
                values: 0,
                meta: 0,
            };
        }
        const strippedDb = { ...dbObj };
        delete strippedDb[PLUGIN_STORAGE_FOLDED_MARKER];
        return {
            strippedDb,
            rows: [],
            changed: true,
            externalized: false,
            clearExisting: false,
            values: 0,
            meta: 0,
        };
    }

    const valueEntries = Object.entries(dbObj.pluginCustomStorage ?? {});
    const metaEntries = Object.entries(dbObj.pluginStorageMeta ?? {});
    const rows = [
        ...valueEntries.map(([rawKey, value]) => ({
            storageKey: encodePluginSaveStorageKey(rawKey, PLUGIN_SAVE_PREFIX),
            value: Buffer.from(JSON.stringify(value), 'utf-8'),
        })),
        ...metaEntries.map(([rawKey, value]) => ({
            storageKey: encodePluginSaveStorageKey(rawKey, PLUGIN_SAVE_META_PREFIX),
            value: Buffer.from(JSON.stringify(value), 'utf-8'),
        })),
    ];
    const strippedDb = { ...dbObj, pluginCustomStorage: {} };
    delete strippedDb.pluginStorageMeta;
    delete strippedDb[PLUGIN_STORAGE_FOLDED_MARKER];
    return {
        strippedDb,
        rows,
        changed: true,
        externalized: true,
        clearExisting: dbObj[PLUGIN_STORAGE_FOLDED_MARKER] === true,
        values: valueEntries.length,
        meta: metaEntries.length,
    };
}

function writePluginStorageRows(rows) {
    for (const row of rows) kvSet(row.storageKey, row.value);
}

/**
 * Re-externalize folded plugin storage from an optimized database object.
 * The source object is left untouched if any row write fails.
 */
function externalizePluginStorageIfNeeded(dbObj) {
    const prepared = preparePluginStorageExternalization(dbObj);
    if (!prepared.changed) {
        return { changed: false, values: 0, meta: 0 };
    }

    const writeRows = sqliteDb.transaction(() => {
        if (prepared.clearExisting) {
            kvDelPrefix(PLUGIN_SAVE_PREFIX);
            kvDelPrefix(PLUGIN_SAVE_META_PREFIX);
        }
        writePluginStorageRows(prepared.rows);
    });
    writeRows();

    if (prepared.externalized) {
        dbObj.pluginCustomStorage = {};
        delete dbObj.pluginStorageMeta;
    }
    delete dbObj[PLUGIN_STORAGE_FOLDED_MARKER];
    return {
        changed: true,
        values: prepared.values,
        meta: prepared.meta,
    };
}

function parsePluginSaveJson(storageKey, readValue = kvGet) {
    const value = readValue(storageKey);
    if (!value) {
        throw new Error(`Missing external plugin storage value: ${storageKey}`);
    }
    try {
        return JSON.parse(value.toString('utf-8'));
    } catch (error) {
        throw new Error(`Invalid JSON in ${storageKey}: ${error.message}`);
    }
}

/**
 * Spool an assembled legacy database to disk. Chat and optional plugin rows
 * are decoded and encoded one at a time; strippedDb is never mutated.
 */
async function spoolSelfContainedBackupDatabase(
    strippedDb,
    {
        foldPluginStorage = false,
        markPluginStorageFolded = false,
        shouldAbort = () => false,
        reader = { kvGet, kvList },
        onMissingChatRow,
    } = {}
) {
    const finalPath = path.join(
        databaseSpoolDir,
        `${DATABASE_SPOOL_FILE_PREFIX}${process.pid}-${nodeCrypto.randomUUID()}`
    );
    const filePath = finalPath + '.tmp';
    const pluginStorage = foldPluginStorage
        ? {
            valueRows: reader.kvList(PLUGIN_SAVE_PREFIX).map((storageKey) => ({
                key: decodePluginSaveStorageKey(storageKey, PLUGIN_SAVE_PREFIX),
                source: storageKey,
            })),
            metaRows: reader.kvList(PLUGIN_SAVE_META_PREFIX).map((storageKey) => ({
                key: decodePluginSaveStorageKey(storageKey, PLUGIN_SAVE_META_PREFIX),
                source: storageKey,
            })),
            readRow: (storageKey) => parsePluginSaveJson(storageKey, reader.kvGet),
        }
        : null;

    try {
        return await streamRisuSaveToFile({
            dbObj: strippedDb,
            filePath,
            readChatRow: async (chaId, chatId) => {
                const value = reader.kvGet(chatRowKey(chaId, chatId));
                return value === null ? null : decodeRisuSave(value);
            },
            pluginStorage,
            markPluginStorageFolded,
            shouldAbort,
            onMissingChatRow,
        });
    } catch (error) {
        await fs.unlink(filePath).catch(() => {});
        throw error;
    }
}

/**
 * Chat rows are always assembled into database.risudat. Upstream exports also
 * fold external plugin rows into that database; Node-only exports keep them as
 * independent archive entries so large plugin stores are never monolithized.
 */
async function buildSelfContainedBackupDatabase({
    foldPluginStorage = true,
    shouldAbort = () => false,
    onMissingChatRow,
    snapshot: externalSnapshot = null,
} = {}) {
    let snapshot = externalSnapshot;
    let ownsSnapshot = false;
    try {
        if (!snapshot) {
            snapshot = await queueStorageOperation(async () => {
                await flushPendingDb();
                return createKvSnapshot();
            });
            ownsSnapshot = true;
        }
        const raw = snapshot.kvGet('database/database.bin');
        if (!raw) return null;

        const strippedDb = await loadStrippedDatabase(raw, 'Backup');
        return await spoolSelfContainedBackupDatabase(strippedDb, {
            foldPluginStorage,
            shouldAbort,
            reader: snapshot,
            onMissingChatRow,
        });
    } finally {
        if (ownsSnapshot) snapshot?.close();
    }
}

function listPluginBackupEntries(reader = { kvListWithSizes }) {
    return [PLUGIN_SAVE_PREFIX, PLUGIN_SAVE_META_PREFIX].flatMap((prefix) => (
        reader.kvListWithSizes(prefix).map((entry) => ({
            kind: 'kv',
            key: entry.key,
            backupName: entry.key,
            sortKey: entry.key,
            size: entry.size,
        }))
    ));
}

function resolveBackupStorageKey(name) {
    if (Buffer.byteLength(name, 'utf-8') > BACKUP_ENTRY_NAME_MAX_BYTES) {
        throw new Error(`Backup entry name too long: ${name.slice(0, 64)}`);
    }

    if (name === 'database.risudat') {
        return 'database/database.bin';
    }

    if (
        name.startsWith('inlay_thumb/') ||
        name.startsWith('inlay_meta/')
    ) {
        if (isInvalidBackupPathSegment(name)) {
            throw new Error(`Invalid backup entry name: ${name}`);
        }
        return name;
    }

    if (name.startsWith('inlay/')) {
        const parsed = parseInlayBackupName(name);
        if (!parsed || !isSafeInlayId(parsed.id)) {
            throw new Error(`Invalid inlay backup entry name: ${name}`);
        }
        return name;
    }

    if (name.startsWith('inlay_sidecar/')) {
        const parsed = parseInlaySidecarBackupName(name);
        if (!parsed) {
            throw new Error(`Invalid inlay sidecar backup entry name: ${name}`);
        }
        return name;
    }

    if (
        name.startsWith(PLUGIN_SAVE_PREFIX) ||
        name.startsWith(PLUGIN_SAVE_META_PREFIX)
    ) {
        const prefix = name.startsWith(PLUGIN_SAVE_PREFIX)
            ? PLUGIN_SAVE_PREFIX
            : PLUGIN_SAVE_META_PREFIX;
        decodePluginSaveStorageKey(name, prefix);
        return name;
    }

    // Upstream backups transport cold storage as coldstorage/<uuid>.json.
    // Normalize back to the runtime KV key: coldstorage/<uuid>.
    if (name.startsWith('coldstorage/')) {
        return normalizeColdStorageStorageKey(name);
    }

    if (isInvalidBackupPathSegment(name) || name !== path.basename(name)) {
        throw new Error(`Invalid asset backup entry name: ${name}`);
    }

    return `assets/${name}`;
}

// ─── Shared backup import logic ─────────────────────────────────────────────
// Accepts any async iterable of Buffer chunks (HTTP request body, file stream, etc.)
async function importBackupFromSource(dataSource, { maxBytes = 0, totalBytes = 0, onProgress = null } = {}) {
    recoverPendingImportSwap('Backup import preparation');
    let hasDatabase = false;
    let databaseSpool = null;
    let databaseWriteStream = null;
    let databaseWriteFinished = null;
    let streamingDatabaseIngestion = null;
    let assetsRestored = 0;
    let bytesReceived = 0;
    const seenEntryNames = new Set();
    const importedInlayIds = new Set();
    const importedSidecarIds = new Set();
    const explicitSidecarMap = new Map();
    const legacyInlayInfoMap = new Map();
    const existingInlayKeys = (await listInlayFiles()).map((entry) => `inlay/${entry.id}`);
    const existingAssetKeys = listAssetEntriesWithSizes()
        .filter((entry) => entry.source === 'fs')
        .map((entry) => entry.key);

    const stagingDir = path.join(savePath, 'inlays_import_staging');
    const backupInlayDir = path.join(savePath, 'inlays_import_backup');
    recoverPendingImportSwap('Inlay import preparation');
    await fs.rm(stagingDir, { recursive: true, force: true });
    await fs.rm(backupInlayDir, { recursive: true, force: true });
    await fs.mkdir(stagingDir, { recursive: true });
    let assetStage;
    try {
        assetStage = await prepareAssetImportStage();
    } catch (error) {
        await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
        await fs.rm(backupInlayDir, { recursive: true, force: true }).catch(() => {});
        throw error;
    }

    function stagingInlayFilePath(id, ext) {
        return path.join(stagingDir, `${id}.${normalizeInlayExt(ext)}`);
    }
    function stagingSidecarPath(id) {
        return path.join(stagingDir, `${id}.meta.json`);
    }
    function writeStagingInlayFileSync(id, ext, buffer, info) {
        const normalizedExt = normalizeInlayExt(ext);
        writeFileSync(stagingInlayFilePath(id, normalizedExt), Buffer.from(buffer));
        const sidecar = {
            ext: normalizedExt,
            name: typeof info?.name === 'string' ? info.name : id,
            type: typeof info?.type === 'string' ? info.type : 'image',
            height: typeof info?.height === 'number' ? info.height : undefined,
            width: typeof info?.width === 'number' ? info.width : undefined,
        };
        writeFileSync(stagingSidecarPath(id), JSON.stringify(sidecar));
    }
    function writeStagingSidecarSync(id, info) {
        const sidecar = {
            ext: normalizeInlayExt(info?.ext),
            name: typeof info?.name === 'string' ? info.name : id,
            type: typeof info?.type === 'string' ? info.type : 'image',
            height: typeof info?.height === 'number' ? info.height : undefined,
            width: typeof info?.width === 'number' ? info.width : undefined,
        };
        writeFileSync(stagingSidecarPath(id), JSON.stringify(sidecar));
    }

    function importBufferedEntry(name, data) {
        const inlayRaw = parseInlayBackupName(name);
        const inlaySidecar = parseInlaySidecarBackupName(name);

        if (inlayRaw) {
            importedInlayIds.add(inlayRaw.id);
            if (inlayRaw.ext) {
                writeStagingInlayFileSync(inlayRaw.id, inlayRaw.ext, data, legacyInlayInfoMap.get(inlayRaw.id) || { ext: inlayRaw.ext, name: inlayRaw.id, type: 'image' });
            } else if (data.length > 0 && data[0] === 0x7b) {
                const parsed = JSON.parse(data.toString('utf-8'));
                const type = typeof parsed?.type === 'string' ? parsed.type : 'image';
                const ext = normalizeInlayExt(parsed?.ext);
                const buffer = type === 'signature'
                    ? Buffer.from(typeof parsed?.data === 'string' ? parsed.data : '', 'utf-8')
                    : decodeDataUri(parsed?.data).buffer;
                writeStagingInlayFileSync(inlayRaw.id, ext, buffer, legacyInlayInfoMap.get(inlayRaw.id) || {
                    ext,
                    name: typeof parsed?.name === 'string' ? parsed.name : inlayRaw.id,
                    type,
                    height: typeof parsed?.height === 'number' ? parsed.height : undefined,
                    width: typeof parsed?.width === 'number' ? parsed.width : undefined,
                });
            } else {
                writeStagingInlayFileSync(inlayRaw.id, 'bin', data, legacyInlayInfoMap.get(inlayRaw.id) || {
                    ext: 'bin',
                    name: inlayRaw.id,
                    type: 'image',
                });
            }
            if (explicitSidecarMap.has(inlayRaw.id)) {
                writeStagingSidecarSync(inlayRaw.id, explicitSidecarMap.get(inlayRaw.id));
            } else if (!importedSidecarIds.has(inlayRaw.id)) {
                const legacyInfo = legacyInlayInfoMap.get(inlayRaw.id);
                if (legacyInfo) writeStagingSidecarSync(inlayRaw.id, legacyInfo);
            }
            kvClearDeletion(`inlay/${inlayRaw.id}`);
            assetsRestored += 1;
        } else if (inlaySidecar) {
            const parsed = JSON.parse(data.toString('utf-8'));
            explicitSidecarMap.set(inlaySidecar.id, parsed);
            writeStagingSidecarSync(inlaySidecar.id, parsed);
            importedSidecarIds.add(inlaySidecar.id);
        } else if (name.startsWith('inlay_info/')) {
            const id = name.slice('inlay_info/'.length);
            if (!isSafeInlayId(id)) {
                throw new Error(`Invalid legacy inlay info entry name: ${name}`);
            }
            const parsed = JSON.parse(data.toString('utf-8'));
            legacyInlayInfoMap.set(id, {
                ext: normalizeInlayExt(parsed?.ext),
                name: typeof parsed?.name === 'string' ? parsed.name : id,
                type: typeof parsed?.type === 'string' ? parsed.type : 'image',
                height: typeof parsed?.height === 'number' ? parsed.height : undefined,
                width: typeof parsed?.width === 'number' ? parsed.width : undefined,
            });
            if (importedInlayIds.has(id) && !importedSidecarIds.has(id)) {
                writeStagingSidecarSync(id, legacyInlayInfoMap.get(id));
            }
        } else if (name.startsWith('inlay_thumb/')) {
            // Skip deprecated thumbnail entries from legacy backups.
        } else {
            const storageKey = resolveBackupStorageKey(name);
            const storageValue = storageKey.startsWith('coldstorage/')
                ? encodeColdStorageCanonicalBuffer(
                    parseColdStorageJsonBuffer(data, name, { allowPlainJson: true }).coldData
                )
                : data;
            if (storageKey.startsWith('assets/')) {
                writeImportedAsset(assetStage, storageKey, storageValue, 'Backup import');
            } else {
                kvSet(storageKey, storageValue);
            }
            assetsRestored += 1;
        }
    }

    await flushPendingDb();
    await createBackupAndRotate();

    sqliteDb.pragma('synchronous = OFF');

    let assetSwap = null;
    let inlaySwap = null;
    let journal = null;
    let transactionCommitted = false;
    try {
        sqliteDb.exec('BEGIN');
        // Prefix deletes can only journal kv rows. Record filesystem-backed
        // logical keys before replacing their directories; imported keys clear
        // their records as they are staged below.
        for (const key of existingAssetKeys) kvRecordDeletion(key);
        for (const key of existingInlayKeys) kvRecordDeletion(key);
        kvDelPrefix('assets/');
        kvDelPrefix('inlay/');
        kvDelPrefix('inlay_thumb/');
        kvDelPrefix('inlay_meta/');
        kvDelPrefix('inlay_info/');
        kvDelPrefix('coldstorage/');
        // Chat rows are per-database payloads and are never carried as backup
        // entries; imported database.risudat recreates them before commit.
        for (const key of chatRowStore.listAllChatRowKeys()) kvDel(key);
        // Plugin rows belong to the imported database. New Node-only backups
        // repopulate them as entries below; legacy/upstream backups keep their
        // values folded in database.risudat. Either way, stale rows must go.
        kvDelPrefix(PLUGIN_SAVE_PREFIX);
        kvDelPrefix(PLUGIN_SAVE_META_PREFIX);
        // Composer drafts are session/device-local and not carried in the backup;
        // wipe stale ones so an old snapshot's chats don't resurrect later drafts.
        kvDelPrefix('drafts/');
        // Same reasoning as clearExistingData (save-folder import path): wipe stale
        // remote payloads from the prior user before this backup's contents land.
        // .bin backups never carry REMOTE blocks today, so the migration won't
        // resolveRemote on them — but keeping the two import paths consistent
        // avoids a contamination regression if that ever changes (upstream sync,
        // plugin-generated buffers, etc.).
        kvDelPrefix('remotes/');
        // Allow remote-block migration to re-evaluate against the new database.bin.
        // (.bin backups themselves never carry REMOTE blocks — legacy msgpack
        // format only — but a fresh import is a clear "data changed" signal.)
        kvDel(REMOTE_MIGRATION_MARKER_KEY);
        kvDel(CHAT_EXTERNALIZATION_MARKER_KEY);
        clearEntities();

        let pending = Buffer.alloc(0);
        let currentEntry = null;
        for await (const chunk of dataSource) {
            bytesReceived += chunk.length;
            if (maxBytes > 0 && bytesReceived > maxBytes) {
                throw new Error(`Backup exceeds max allowed size (${maxBytes} bytes)`);
            }
            if (onProgress) onProgress(bytesReceived, totalBytes);

            let buffer = pending.length > 0
                ? Buffer.concat([pending, Buffer.from(chunk)])
                : Buffer.from(chunk);
            pending = Buffer.alloc(0);

            while (buffer.length > 0) {
                if (!currentEntry) {
                    if (buffer.length < 4) {
                        pending = Buffer.from(buffer);
                        break;
                    }
                    const nameLength = buffer.readUInt32LE(0);
                    if (nameLength > BACKUP_ENTRY_NAME_MAX_BYTES) {
                        throw new Error(`Backup entry name exceeds ${BACKUP_ENTRY_NAME_MAX_BYTES} bytes`);
                    }
                    const headerLength = 4 + nameLength + 4;
                    if (buffer.length < headerLength) {
                        pending = Buffer.from(buffer);
                        break;
                    }

                    const name = buffer.subarray(4, 4 + nameLength).toString('utf-8');
                    const dataLength = buffer.readUInt32LE(4 + nameLength);
                    buffer = buffer.subarray(headerLength);

                    if (seenEntryNames.has(name)) {
                        throw new Error(`Duplicate backup entry: ${name}`);
                    }
                    seenEntryNames.add(name);
                    if (name === 'encryption.risudat') {
                        throw new Error('Encrypted risuai.xyz account backups cannot be imported. Re-export the backup without account encryption and try again.');
                    }

                    currentEntry = {
                        name,
                        remaining: dataLength,
                        chunks: name === 'database.risudat' ? null : [],
                        total: 0,
                    };
                    if (name === 'database.risudat') {
                        const filePath = path.join(
                            savePath,
                            `.database-import-${process.pid}-${nodeCrypto.randomUUID()}.tmp`
                        );
                        databaseSpool = { filePath, size: dataLength };
                        databaseWriteStream = createWriteStream(filePath, { flags: 'wx' });
                        databaseWriteFinished = finished(databaseWriteStream);
                        databaseWriteFinished.catch(() => {});
                    }
                }

                const take = Math.min(currentEntry.remaining, buffer.length);
                if (take > 0) {
                    const piece = buffer.subarray(0, take);
                    if (currentEntry.name === 'database.risudat') {
                        if (!await writeWithBackpressure(databaseWriteStream, piece)) {
                            throw new Error('Database spool closed during backup import');
                        }
                    } else {
                        currentEntry.chunks.push(Buffer.from(piece));
                        currentEntry.total += piece.length;
                    }
                    currentEntry.remaining -= take;
                    buffer = buffer.subarray(take);
                }

                if (currentEntry.remaining === 0) {
                    if (currentEntry.name === 'database.risudat') {
                        databaseWriteStream.end();
                        await databaseWriteFinished;
                        databaseWriteStream = null;
                        databaseWriteFinished = null;
                        hasDatabase = true;
                    } else {
                        const data = currentEntry.chunks.length === 1
                            ? currentEntry.chunks[0]
                            : Buffer.concat(currentEntry.chunks, currentEntry.total);
                        importBufferedEntry(currentEntry.name, data);
                    }
                    currentEntry = null;
                }
            }
        }

        if (pending.length > 0 || currentEntry) {
            throw new Error('Backup stream ended with incomplete entry');
        }
        if (!hasDatabase) {
            throw new Error('Backup does not contain database.risudat');
        }

        const databaseSource = {
            filePath: databaseSpool.filePath,
            size: databaseSpool.size,
        };
        const databaseInspection = await inspectRisuSaveSource(databaseSource);
        if (await shouldStreamRisuSave(databaseSource, { inspection: databaseInspection })) {
            streamingDatabaseIngestion = await ingestDatabaseStreaming(databaseSource, {
                inspection: databaseInspection,
            });
            // Supported legacy/gzip saves cannot contain REMOTE blocks.
            markRemoteMigrationDone();
        } else {
            // Exotic/small formats retain the historical monolith + post-commit
            // decoder path so their behavior remains unchanged.
            kvSet(DB_BLOB_KEY, await fs.readFile(databaseSpool.filePath));
        }
        for (const [id, info] of legacyInlayInfoMap.entries()) {
            if (importedInlayIds.has(id) && !importedSidecarIds.has(id)) {
                writeStagingSidecarSync(id, info);
            }
        }
        writeFileSync(
            path.join(stagingDir, path.basename(inlayMigrationMarker)),
            new Date().toISOString(),
            'utf-8'
        );

        fsyncDirectoryTree(assetImportStagingDir);
        fsyncDirectoryTree(stagingDir);
        journal = {
            id: nodeCrypto.randomUUID(),
            phase: 'swapped',
            dirs: [
                {
                    liveDir: assetDir,
                    backupDir: assetImportBackupDir,
                    stagingDir: assetImportStagingDir,
                    liveExisted: fsSync.existsSync(assetDir),
                },
                {
                    liveDir: inlayDir,
                    backupDir: backupInlayDir,
                    stagingDir,
                    liveExisted: fsSync.existsSync(inlayDir),
                },
            ],
        };
        kvSet(IMPORT_JOURNAL_MARKER_KEY, Buffer.from(journal.id, 'utf-8'));
        writeImportJournal(IMPORT_JOURNAL_PATH, journal);
        assetSwap = swapAssetDirectoryFromStaging(
            assetImportStagingDir,
            assetImportBackupDir
        );
        inlaySwap = swapDirectoryFromStaging({
            liveDir: inlayDir,
            stagingDir,
            backupDir: backupInlayDir,
        });
        // Publish the new epoch only once the replacement directories and all
        // logical writes are ready. A list served mid-import is then invalidated
        // when this transaction commits.
        kvBumpListEpoch();
        sqliteDb.exec('COMMIT');
        transactionCommitted = true;

        sqliteDb.pragma('synchronous = NORMAL');
        checkpointWal('TRUNCATE');
        journal = { ...journal, phase: 'committed' };
        writeImportJournal(IMPORT_JOURNAL_PATH, journal);
        assetSwap.finalize();
        inlaySwap.finalize();
        kvDel(IMPORT_JOURNAL_MARKER_KEY);
        clearImportJournal(IMPORT_JOURNAL_PATH);
    } catch (error) {
        if (!transactionCommitted) {
            let rollbackSucceeded = !error?.restoreError;
            try {
                sqliteDb.exec('ROLLBACK');
            } catch (rollbackError) {
                rollbackSucceeded = false;
                logger.error('[Backup Import] Failed to roll back SQLite transaction:', rollbackError);
            }
            try {
                kvBumpListEpoch();
            } catch (epochError) {
                logger.error('[Backup Import] Failed to bump list epoch after rollback:', epochError);
            }
            if (inlaySwap) {
                try { inlaySwap.rollback(); } catch (rollbackError) {
                    rollbackSucceeded = false;
                    logger.error('[Backup Import] Failed to restore previous inlay directory:', rollbackError);
                }
            } else {
                try {
                    await fs.rm(stagingDir, { recursive: true, force: true });
                } catch (cleanupError) {
                    rollbackSucceeded = false;
                    logger.error('[Backup Import] Failed to remove inlay staging directory:', cleanupError);
                }
            }
            if (assetSwap) {
                try { assetSwap.rollback(); } catch (rollbackError) {
                    rollbackSucceeded = false;
                    logger.error('[Backup Import] Failed to restore previous asset directory:', rollbackError);
                }
            } else {
                try {
                    await fs.rm(assetImportStagingDir, { recursive: true, force: true });
                } catch (cleanupError) {
                    rollbackSucceeded = false;
                    logger.error('[Backup Import] Failed to remove asset staging directory:', cleanupError);
                }
            }
            if (journal && rollbackSucceeded) {
                try {
                    clearImportJournal(IMPORT_JOURNAL_PATH);
                } catch (cleanupError) {
                    logger.error('[Backup Import] Failed to clear rolled-back import journal:', cleanupError);
                }
            }
        }
        throw error;
    } finally {
        sqliteDb.pragma('synchronous = NORMAL');
        if (databaseWriteStream) {
            databaseWriteStream.destroy();
            await databaseWriteFinished?.catch(() => {});
        }
        if (databaseSpool) {
            await fs.unlink(databaseSpool.filePath).catch(() => {});
        }
    }

    invalidateAllDbCaches();

    // Small/exotic formats still externalize after commit through the legacy
    // decoder. Supported large formats were ingested inside the import transaction.
    let coldStorageFailed = streamingDatabaseIngestion?.stats.failed || 0;
    const dbRaw = streamingDatabaseIngestion ? null : kvGet(DB_BLOB_KEY);
    if (dbRaw) {
        const ingestion = await ingestDatabase(dbRaw);
        coldStorageFailed = ingestion.stats.failed || 0;
    }

    try {
        checkpointWal('TRUNCATE');
    } catch (checkpointError) {
        logger.warn('[Backup Import] WAL checkpoint after import failed:', checkpointError);
    }

    console.log(`[Backup Import] Complete: ${assetsRestored} assets restored, ${(bytesReceived / 1024 / 1024).toFixed(1)}MB processed`);
    if (coldStorageFailed > 0) {
        logger.error(`[Backup Import] ${coldStorageFailed} cold storage character(s) could not be restored`);
    }
    return { assetsRestored, bytesReceived, coldStorageFailed };
}

app.get('/', async (req, res, next) => {

    const clientIP = req.ip || 'Unknown IP';
    const timestamp = new Date().toISOString();
    console.log(`[Server] ${timestamp} | Connection from: ${clientIP}`);
    
    try {
        const mainIndex = await fs.readFile(path.join(process.cwd(), 'dist', 'index.html'))
        const root = htmlparser.parse(mainIndex)
        const head = root.querySelector('head')
        head.innerHTML = `<script>globalThis.__NODE__ = true; globalThis.__PATCH_SYNC__ = ${enablePatchSync}; globalThis.__ALLOW_INSECURE_CONTEXT__ = ${allowInsecureContext}</script>` + head.innerHTML
        
        res.send(root.toString())
    } catch (error) {
        console.log(error)
        next(error)
    }
})

async function checkAuth(req, res, returnOnlyStatus = false, {allowExpired = false} = {}){
    try {
        const authHeader = req.headers['risu-auth'];

        if(!authHeader){
            console.log('No auth header')
            if(returnOnlyStatus){
                return false;
            }
            res.status(400).send({
                error:'No auth header'
            });
            return false
        }


        //jwt token
        const [
            jsonHeaderB64,
            jsonPayloadB64,
            signatureB64,
        ] = authHeader.split('.');

        //alg, typ
        const jsonHeader = JSON.parse(Buffer.from(jsonHeaderB64, 'base64url').toString('utf-8'));

        //iat, exp
        const jsonPayload = JSON.parse(Buffer.from(jsonPayloadB64, 'base64url').toString('utf-8'));

        
        //check expiration
        if(!allowExpired){
            const now = Math.floor(Date.now() / 1000);
            if(jsonPayload.exp < now){
                console.log('Token expired')
                if(returnOnlyStatus){
                    return false;
                }
                res.status(400).send({
                    error:'Token Expired'
                });
                return false
            }
        }

        //check signature (HMAC-SHA256)
        if(jsonHeader.alg !== "HS256"){
            console.log('Unsupported algorithm')
            if(returnOnlyStatus){
                return false;
            }
            res.status(400).send({
                error:'Unsupported Algorithm'
            });
            return false
        }

        const expectedSig = nodeCrypto.createHmac('sha256', jwtSecret)
            .update(`${jsonHeaderB64}.${jsonPayloadB64}`)
            .digest()
        const actualSig = Buffer.from(signatureB64, 'base64url')

        if(expectedSig.length !== actualSig.length || !nodeCrypto.timingSafeEqual(expectedSig, actualSig)){
            console.log('Invalid signature')
            if(returnOnlyStatus){
                return false;
            }
            res.status(400).send({
                error:'Invalid Signature'
            });
            return false
        }
        return true
    } catch (error) {
        console.log(error)
        if(returnOnlyStatus){
            return false;
        }
        res.status(500).send({
            error:'Internal Server Error'
        });
        return false
    }
}

const reverseProxyFunc = async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    
    const urlParam = req.headers['risu-url'] ? decodeURIComponent(req.headers['risu-url']) : req.query.url;

    if (!urlParam) {
        res.status(400).send({
            error:'URL has no param'
        });
        return;
    }
    const timeoutMs = getRequestTimeoutMs(req.headers['risu-timeout-ms']);
    const timeout = createTimeoutController(timeoutMs);
    let originalResponse;
    try {
    const header = req.headers['risu-header'] ? JSON.parse(decodeURIComponent(req.headers['risu-header'])) : req.headers;
    if (req.headers['x-risu-tk'] && !header['x-risu-tk']) {
        header['x-risu-tk'] = req.headers['x-risu-tk'];
    }
    if (req.headers['risu-location'] && !header['risu-location']) {
        header['risu-location'] = req.headers['risu-location'];
    }
    if(!header['x-forwarded-for']){
        header['x-forwarded-for'] = req.ip
    }

    if(req.headers['authorization']?.startsWith('X-SERVER-REGISTER')){
        if(!existsSync(authCodePath)){
            delete header['authorization']
        }
        else{
            const authCode = await fs.readFile(authCodePath, {
                encoding: 'utf-8'
            })
            header['authorization'] = `Bearer ${authCode}`
        }
    }
        let requestBody = undefined;
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
                requestBody = req.body;
            }
            else if (req.body !== undefined) {
                requestBody = JSON.stringify(req.body);
            }
        }
        // make request to original server
        originalResponse = await fetch(urlParam, {
            method: req.method,
            headers: header,
            body: requestBody,
            signal: timeout.signal
        });
        // get response body as stream
        const originalBody = originalResponse.body;
        // get response headers
        const head = new Headers(originalResponse.headers);
        head.delete('content-security-policy');
        head.delete('content-security-policy-report-only');
        head.delete('clear-site-data');
        head.delete('Cache-Control');
        head.delete('Content-Encoding');
        // Node's fetch already decompressed the body, so the upstream
        // (compressed) Content-Length no longer matches and would truncate the
        // response. Drop it and let the body stream out chunked.
        head.delete('Content-Length');
        const headObj = {};
        for (let [k, v] of head) {
            headObj[k] = v;
        }
        // send response headers to client
        res.header(headObj);
        // send response status to client
        res.status(originalResponse.status);
        // send response body to client
        await pipeline(originalResponse.body, res);


    }
    catch (err) {
        if (err?.name === 'AbortError') {
            if (!res.headersSent) {
                res.status(504).send({
                    error: timeoutMs
                        ? `Proxy request timed out after ${timeoutMs}ms`
                        : 'Proxy request aborted'
                });
            } else {
                res.end();
            }
            return;
        }
        // Pass the actual `err` (not err.cause) so logger.* can tag it and the
        // Express error middleware knows to skip. The cause chain is preserved
        // via formatErrorWithCause in normalizeArgs.
        logger.error(`[Proxy] ${req.method} ${urlParam}`, err);
        next(err);
        return;
    } finally {
        timeout.cleanup();
    }
}

const reverseProxyFunc_get = async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    
    const urlParam = req.headers['risu-url'] ? decodeURIComponent(req.headers['risu-url']) : req.query.url;

    if (!urlParam) {
        res.status(400).send({
            error:'URL has no param'
        });
        return;
    }
    const timeoutMs = getRequestTimeoutMs(req.headers['risu-timeout-ms']);
    const timeout = createTimeoutController(timeoutMs);
    let originalResponse;
    try {
    const header = req.headers['risu-header'] ? JSON.parse(decodeURIComponent(req.headers['risu-header'])) : req.headers;
    if (req.headers['x-risu-tk'] && !header['x-risu-tk']) {
        header['x-risu-tk'] = req.headers['x-risu-tk'];
    }
    if (req.headers['risu-location'] && !header['risu-location']) {
        header['risu-location'] = req.headers['risu-location'];
    }
    if(!header['x-forwarded-for']){
        header['x-forwarded-for'] = req.ip
    }
        // make request to original server
        originalResponse = await fetch(urlParam, {
            method: 'GET',
            headers: header,
            signal: timeout.signal
        });
        // get response body as stream
        const originalBody = originalResponse.body;
        // get response headers
        const head = new Headers(originalResponse.headers);
        head.delete('content-security-policy');
        head.delete('content-security-policy-report-only');
        head.delete('clear-site-data');
        head.delete('Cache-Control');
        head.delete('Content-Encoding');
        // Node's fetch already decompressed the body, so the upstream
        // (compressed) Content-Length no longer matches and would truncate the
        // response. Drop it and let the body stream out chunked.
        head.delete('Content-Length');
        const headObj = {};
        for (let [k, v] of head) {
            headObj[k] = v;
        }
        // send response headers to client
        res.header(headObj);
        // send response status to client
        res.status(originalResponse.status);
        // send response body to client
        await pipeline(originalResponse.body, res);
    }
    catch (err) {
        if (err?.name === 'AbortError') {
            if (!res.headersSent) {
                res.status(504).send({
                    error: timeoutMs
                        ? `Proxy request timed out after ${timeoutMs}ms`
                        : 'Proxy request aborted'
                });
            } else {
                res.end();
            }
            return;
        }
        next(err);
        return;
    } finally {
        timeout.cleanup();
    }
}

let accessTokenCache = {
    token: null,
    expiry: 0
}
async function getSionywAccessToken() {
    if(accessTokenCache.token && Date.now() < accessTokenCache.expiry){
        return accessTokenCache.token;
    }
    //Schema of the client data file
    // {
    //     refresh_token: string;
    //     client_id: string;
    //     client_secret: string;
    // }
    
    const clientDataPath = path.join(process.cwd(), 'save', '__sionyw_client_data.json');
    let refreshToken = ''
    let clientId = ''
    let clientSecret = ''
    if(!existsSync(clientDataPath)){
        throw new Error('No Sionyw client data found');
    }
    const clientDataRaw = readFileSync(clientDataPath, 'utf-8');
    const clientData = JSON.parse(clientDataRaw);
    refreshToken = clientData.refresh_token;
    clientId = clientData.client_id;
    clientSecret = clientData.client_secret;

    //Oauth Refresh Token Flow
    
    const tokenResponse = await fetch('account.sionyw.com/account/api/oauth/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId,
            client_secret: clientSecret
        })
    })

    if(!tokenResponse.ok){
        throw new Error('Failed to refresh Sionyw access token');
    }

    const tokenData = await tokenResponse.json();

    //Update the refresh token in the client data file
    if(tokenData.refresh_token && tokenData.refresh_token !== refreshToken){
        clientData.refresh_token = tokenData.refresh_token;
        writeFileSync(clientDataPath, JSON.stringify(clientData), 'utf-8');
    }

    accessTokenCache.token = tokenData.access_token;
    accessTokenCache.expiry = Date.now() + (tokenData.expires_in * 1000) - (5 * 60 * 1000); //5 minutes early

    return tokenData.access_token;
}


async function hubProxyFunc(req, res) {
    const excludedHeaders = [
        'content-encoding',
        'content-length',
        'transfer-encoding'
    ];

    try {
        let externalURL = '';

        const pathHeader = req.headers['x-risu-node-path'];
        if (pathHeader) {
            const decodedPath = decodeURIComponent(pathHeader);
            externalURL = decodedPath;
        } else {
            const pathAndQuery = req.originalUrl.replace(/^\/hub-proxy/, '');
            externalURL = hubURL + pathAndQuery;
        }
        
        const headersToSend = { ...req.headers };
        delete headersToSend.host;
        delete headersToSend.connection;
        delete headersToSend['content-length'];
        delete headersToSend['x-risu-node-path'];

        const hubOrigin = new URL(hubURL).origin;
        headersToSend.origin = hubOrigin;

        //if Authorization header is "Server-Auth, set the token to be Server-Auth
        if(headersToSend['Authorization'] === 'X-Node-Server-Auth'){
            //this requires password auth
            if(!await checkAuth(req, res)){
                return;
            }

            headersToSend['Authorization'] = "Bearer " + await getSionywAccessToken();
            delete headersToSend['risu-auth'];
        }
        
        
        const response = await fetch(externalURL, {
            method: req.method,
            headers: headersToSend,
            body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
            redirect: 'manual',
            duplex: 'half'
        });
        
        for (const [key, value] of response.headers.entries()) {
            // Skip encoding-related headers to prevent double decoding
            if (excludedHeaders.includes(key.toLowerCase())) {
                continue;
            }
            res.setHeader(key, value);
        }
        res.status(response.status);

        if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
            const redirectUrl = response.headers.get('location');
            const newHeaders = { ...headersToSend };
            const redirectResponse = await fetch(redirectUrl, {
                method: req.method,
                headers: newHeaders,
                body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
                redirect: 'manual',
                duplex: 'half'
            });
            for (const [key, value] of redirectResponse.headers.entries()) {
                if (excludedHeaders.includes(key.toLowerCase())) {
                    continue;
                }
                res.setHeader(key, value);
            }
            res.status(redirectResponse.status);
            if (redirectResponse.body) {
                await pipeline(redirectResponse.body, res);
            } else {
                res.end();
            }
            return;
        }
        
        if (response.body) {
            await pipeline(response.body, res);
        } else {
            res.end();
        }
        
    } catch (error) {
        logger.error("[Hub Proxy] Error:", error);
        if (!res.headersSent) {
            res.status(502).send({ error: 'Proxy request failed: ' + error.message });
        } else {
            res.end();
        }
    }
}

app.get('/proxy', reverseProxyFunc_get);
app.get('/proxy2', reverseProxyFunc_get);
app.get('/hub-proxy/*', hubProxyFunc);

app.post('/proxy', reverseProxyFunc);
app.post('/proxy2', reverseProxyFunc);
app.put('/proxy', reverseProxyFunc);
app.put('/proxy2', reverseProxyFunc);
app.patch('/proxy', reverseProxyFunc);
app.patch('/proxy2', reverseProxyFunc);
app.delete('/proxy', reverseProxyFunc);
app.delete('/proxy2', reverseProxyFunc);
app.post('/hub-proxy/*', hubProxyFunc);

// --- Proxy Stream Job endpoints ---
app.post('/proxy-stream-jobs', async (req, res) => {
    if (!await checkProxyAuth(req, res)) {
        return;
    }

    const rawUrl = typeof req.body?.url === 'string' ? req.body.url : '';
    const encodedUrl = encodeURIComponent(rawUrl);
    const url = sanitizeTargetUrl(decodeURIComponent(encodedUrl));
    if (!url) {
        res.status(400).send({ error: 'Invalid target URL. Only local/private network http(s) endpoints are allowed.' });
        return;
    }

    const method = typeof req.body?.method === 'string' ? req.body.method.toUpperCase() : 'POST';
    if (!['POST', 'GET', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
        res.status(400).send({ error: 'Invalid method' });
        return;
    }

    const bodyBase64 = typeof req.body?.bodyBase64 === 'string' ? req.body.bodyBase64 : '';
    if (bodyBase64.length > PROXY_STREAM_MAX_BODY_BASE64_BYTES) {
        res.status(413).send({ error: 'Request body too large' });
        return;
    }
    if (proxyStreamJobs.size >= PROXY_STREAM_MAX_ACTIVE_JOBS) {
        res.status(429).send({ error: 'Too many active stream jobs. Retry shortly.' });
        return;
    }
    const headers = normalizeForwardHeaders(req.body?.headers);
    const heartbeatSec = normalizeHeartbeatSec(Number(req.body?.heartbeatSec));
    const job = createProxyStreamJob({
        heartbeatSec,
        timeoutMs: req.body?.timeoutMs
    });

    void runProxyStreamJob(job, {
        targetUrl: url,
        headers,
        method,
        bodyBase64,
        clientIp: req.ip
    });

    res.send({
        jobId: job.id,
        heartbeatSec: job.heartbeatSec
    });
});

app.delete('/proxy-stream-jobs/:jobId', async (req, res) => {
    if (!await checkProxyAuth(req, res)) {
        return;
    }
    const job = proxyStreamJobs.get(req.params.jobId);
    if (!job) {
        res.send({ success: true });
        return;
    }
    job.abortController.abort();
    markJobDone(job);
    cleanupJob(job.id);
    res.send({ success: true });
});

// app.get('/api/password', async(req, res)=> {
//     if(password === ''){
//         res.send({status: 'unset'})
//     }
//     else if(req.body.password && req.body.password.trim() === password.trim()){
//         res.send({status:'correct'})
//     }
//     else{
//         res.send({status:'incorrect'})
//     }
// })

app.get('/api/test_auth', async(req, res) => {

    if(!password){
        res.send({status: 'unset'})
    }
    else if(!await checkAuth(req, res, true)){
        // JWT missing/invalid – fall back to session cookie (survives page refresh)
        const sessionToken = parseSessionCookie(req)
        if (sessionToken && (sessions.get(sessionToken) ?? 0) > Date.now()) {
            res.send({status: 'success', token: createServerJwt()})
        } else {
            res.send({status: 'incorrect'})
        }
    }
    else{
        res.send({status: 'success', token: createServerJwt()})
    }
})

app.post('/api/login', loginRouteLimiter, async (req, res) => {
    if(password === ''){
        res.status(400).send({error: 'Password not set'})
        return;
    }
    if(req.body.password && req.body.password.trim() === password.trim()){
        res.send({status:'success', token: createServerJwt()})
    }
    else{
        res.status(400).send({error: 'Password incorrect'})
    }
})

// NodeOnly: token refresh endpoint (pairs with server-side JWT)
app.post('/api/token/refresh', async (req, res) => {
    if (!await checkAuth(req, res, false, {allowExpired: true})) return
    res.json({ token: createServerJwt() })
})

// ── Session cookie issuance (F-0) ──────────────────────────────────────────
// Called once after JWT auth succeeds. Issues a long-lived cookie so that
// <img src="/api/asset/..."> requests can be authenticated without JS.
app.post('/api/session', async (req, res) => {
    if (!await checkAuth(req, res)) return
    const clientSessionId = req.headers['x-session-id']
    if (clientSessionId) {
        activeSessionId = clientSessionId
        console.log('[Session] Active writer session updated')
    }
    const token = nodeCrypto.randomBytes(32).toString('hex')
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000
    sessions.set(token, expiresAt)
    // Prune stale sessions (bounded by single-user usage, safe to do inline)
    for (const [t, exp] of sessions) {
        if (exp < Date.now()) sessions.delete(t)
    }
    saveSessions()
    const maxAge = 7 * 24 * 60 * 60 // seconds
    res.setHeader('Set-Cookie', `risu-session=${token}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Path=/`)
    res.json({ ok: true })
})

// ── Direct asset serving (F-1) ─────────────────────────────────────────────
// Serves filesystem-backed assets (with legacy KV fallback) as proper HTTP
// responses with long-term caching.
// Key is hex-encoded to safely pass through URL. Auth via session cookie.
//
// Storage formats differ by key prefix:
//   assets/*        → raw binary (Uint8Array)
//   inlay/*         → JSON { data: "data:<mime>;base64,...", ext, type, ... }
//   inlay_thumb/*   → JSON { data: "data:<mime>;base64,...", ext, type, ... }

/**
 * Extract raw binary and content-type from a KV value.
 * Handles both raw binary (assets/) and JSON+base64 wrapped (inlay/) formats.
 */
function resolveAssetPayload(key, rawValue) {
    // inlay/ and inlay_thumb/ keys store JSON with base64 data URI
    if (key.startsWith('inlay/') || key.startsWith('inlay_thumb/')) {
        try {
            const json = JSON.parse(rawValue.toString('utf-8'))
            const dataUri = json.data
            if (typeof dataUri === 'string' && dataUri.startsWith('data:')) {
                // Parse "data:<mime>;base64,<payload>"
                const commaIdx = dataUri.indexOf(',')
                const meta = dataUri.substring(5, commaIdx) // after "data:"
                const mime = meta.split(';')[0]
                const binary = Buffer.from(dataUri.substring(commaIdx + 1), 'base64')
                return { binary, contentType: mime || 'application/octet-stream' }
            }
            // Fallback: ext field
            const ext = (json.ext || '').toLowerCase()
            const mime = ASSET_EXT_MIME[ext] || 'application/octet-stream'
            return { binary: rawValue, contentType: mime }
        } catch {
            // JSON parse failed — treat as raw binary
        }
    }

    // assets/* and others: raw binary
    const ext = key.split('.').pop()?.toLowerCase()
    const contentType = ASSET_EXT_MIME[ext] || detectMime(rawValue)
    return { binary: rawValue, contentType }
}

const THUMB_MAX_SIDE = 320;
const THUMB_QUALITY = 75;
const THUMB_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

async function generateThumbnail(buffer) {
    const vips = await getVips()
    const img = vips.Image.thumbnailBuffer(buffer, THUMB_MAX_SIDE, {
        height: THUMB_MAX_SIDE,
        size: 'down',
    })
    try {
        const out = img.writeToBuffer('.webp', { Q: THUMB_QUALITY })
        return Buffer.from(out);
    } finally {
        img.delete()
    }
}

app.get('/api/asset/:hexKey', sessionAuthMiddleware, async (req, res) => {
    try {
        const key = Buffer.from(req.params.hexKey, 'hex').toString('utf-8')

        if (key.startsWith('inlay/')) {
            const id = key.slice('inlay/'.length)
            const file = await readInlayFile(id)
            if (file) {
                const etag = `"${Math.floor(file.mtimeMs)}"`
                if (req.headers['if-none-match'] === etag) {
                    return res.status(304).set('Cache-Control', 'public, max-age=31536000, immutable').end()
                }
                res.set({
                    'Content-Type': file.mime,
                    'Cache-Control': 'public, max-age=31536000, immutable',
                    'ETag': etag,
                })
                return res.send(file.buffer)
            }
            return res.status(404).set('Cache-Control', 'no-store').end()
        }

        if (key.startsWith('inlay_thumb/')) {
            const id = key.slice('inlay_thumb/'.length)
            const sidecar = await readInlaySidecar(id);
            if (!sidecar || sidecar.type !== 'image' || !THUMB_IMAGE_EXTS.has(sidecar.ext)) {
                return res.status(404).end()
            }
            const file = await readInlayFile(id)
            if (!file) return res.status(404).set('Cache-Control', 'no-store').end()
            const etag = `"thumb-${Math.floor(file.mtimeMs)}"`
            if (req.headers['if-none-match'] === etag) {
                return res.status(304).set('Cache-Control', 'public, max-age=31536000, immutable').end()
            }
            const thumb = await generateThumbnail(file.buffer)
            res.set({
                'Content-Type': 'image/webp',
                'Cache-Control': 'public, max-age=31536000, immutable',
                'ETag': etag,
            })
            return res.send(thumb)
        }

        if (key.startsWith('assets/')) {
            const name = assetNameForKey(key)
            if (isSafeAssetName(name)) {
                const data = readAssetFile(name)
                const mtimeMs = assetFileMtimeMs(name)
                if (data !== null && mtimeMs !== null) {
                    const etag = `"${Math.floor(mtimeMs)}"`
                    if (req.headers['if-none-match'] === etag) {
                        return res.status(304).set('Cache-Control', 'public, max-age=31536000, immutable').end()
                    }
                    const { binary, contentType } = resolveAssetPayload(key, data)
                    res.set({
                        'Content-Type': contentType,
                        'Cache-Control': 'public, max-age=31536000, immutable',
                        'ETag': etag,
                    })
                    return res.send(binary)
                }
            }
        }

        // Fast-path 304: check updated_at BEFORE loading the blob.
        const updatedAt = kvGetUpdatedAt(key)
        if (updatedAt === null) return res.status(404).set('Cache-Control', 'no-store').end()

        const etag = `"${updatedAt}"`
        if (req.headers['if-none-match'] === etag) {
            return res.status(304).set('Cache-Control', 'public, max-age=31536000, immutable').end()
        }

        const data = kvGet(key)
        if (!data) return res.status(404).set('Cache-Control', 'no-store').end()

        const { binary, contentType } = resolveAssetPayload(key, data)
        res.set({
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=31536000, immutable',
            'ETag': etag,
        })
        res.send(binary)
    } catch (error) {
        logger.error('[Asset] Failed to serve asset:', error);
        res.status(500).end()
    }
})

app.post('/api/crypto', async (req, res) => {
    try {
        const hash = nodeCrypto.createHash('sha256')
        hash.update(Buffer.from(req.body.data, 'utf-8'))
        res.send(hash.digest('hex'))
    } catch (error) {
        res.status(500).send({ error: 'Crypto operation failed' });
    }
})

// Vertex / google-service-account access tokens. The browser cannot sign the
// RS256 JWT itself: crypto.subtle needs a Secure Context that HTTP remote
// access lacks, and node:crypto isn't in the client bundle. So the client
// forwards the SA JSON here and the server signs + exchanges it. Google's token
// response is forwarded verbatim so the client maps statuses unchanged.
// Never log the SA JSON / private key / assertion / OAuth body.
const GOOGLE_OAUTH_TOKEN_URI = 'https://oauth2.googleapis.com/token'
app.post('/api/model-preset/google-service-account/token', async (req, res) => {
    if (!await checkAuth(req, res)) return
    try {
        const serviceAccountJson = req.body && req.body.serviceAccountJson
        const scope = (req.body && typeof req.body.scope === 'string' && req.body.scope.length > 0)
            ? req.body.scope
            : 'https://www.googleapis.com/auth/cloud-platform'
        if (typeof serviceAccountJson !== 'string' || serviceAccountJson.length === 0) {
            res.status(400).send({ error: 'serviceAccountJson required' })
            return
        }
        let sa
        try {
            sa = JSON.parse(serviceAccountJson)
        } catch {
            res.status(400).send({ error: 'invalid service account JSON' })
            return
        }
        const clientEmail = sa && sa.client_email
        const privateKey = sa && sa.private_key
        const kid = sa && sa.private_key_id
        const tokenUri = (sa && typeof sa.token_uri === 'string' && sa.token_uri.length > 0)
            ? sa.token_uri
            : GOOGLE_OAUTH_TOKEN_URI
        if (typeof clientEmail !== 'string' || typeof privateKey !== 'string') {
            res.status(400).send({ error: 'service account missing client_email / private_key' })
            return
        }
        // SSRF / signed-JWT exfiltration guard: only Google's documented endpoint.
        if (tokenUri !== GOOGLE_OAUTH_TOKEN_URI) {
            res.status(400).send({ error: 'unsupported token_uri' })
            return
        }
        const nowSec = Math.floor(Date.now() / 1000)
        const header = { alg: 'RS256', typ: 'JWT' }
        if (typeof kid === 'string' && kid.length > 0) header.kid = kid
        const payload = { iss: clientEmail, scope, aud: tokenUri, iat: nowSec, exp: nowSec + 3600 }
        const signingInput =
            `${Buffer.from(JSON.stringify(header)).toString('base64url')}.` +
            `${Buffer.from(JSON.stringify(payload)).toString('base64url')}`
        let signature
        try {
            const signer = nodeCrypto.createSign('RSA-SHA256')
            signer.update(signingInput)
            signer.end()
            signature = signer.sign(privateKey).toString('base64url')
        } catch {
            res.status(400).send({ error: 'failed to sign with the provided private key' })
            return
        }
        const assertion = `${signingInput}.${signature}`

        let googleRes
        try {
            googleRes = await fetch(tokenUri, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Accept: 'application/json',
                },
                body: new URLSearchParams({
                    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                    assertion,
                }).toString(),
            })
        } catch {
            res.status(502).send({ error: 'OAuth token endpoint unreachable' })
            return
        }

        // Forward Google's status + body verbatim (client maps errors).
        const text = await googleRes.text().catch(() => '')
        const contentType = googleRes.headers.get('content-type')
        if (contentType) res.set('content-type', contentType)
        res.status(googleRes.status).send(text)
    } catch {
        res.status(500).send({ error: 'service account token exchange failed' })
    }
})


app.post('/api/set_password', async (req, res) => {
    if(password === ''){
        password = req.body.password
        writeFileSync(passwordPath, password, 'utf-8')
        res.send({status: 'success'})
    }
    else{
        res.status(400).send("already set")
    }
})

app.get('/api/read', async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    const filePath = req.headers['file-path'];
    if (!filePath) {
        console.log('no path')
        res.status(400).send({ error:'File path required' });
        return;
    }
    if(!isHex(filePath)){
        res.status(400).send({ error:'Invaild Path' });
        return;
    }
    try {
        const key = Buffer.from(filePath, 'hex').toString('utf-8');
        // Flush pending patches before reading database.bin
        if (key === 'database/database.bin') {
            await flushPendingDb();
        }
        let value = null;
        if (key.startsWith('inlay/')) {
            value = await readInlayAssetPayload(key.slice('inlay/'.length));
        } else if (key.startsWith('inlay_info/')) {
            value = await readInlayInfoPayload(key.slice('inlay_info/'.length));
        } else if (key.startsWith('assets/')) {
            value = readAssetValue(key);
        }
        if (value === null && !key.startsWith('assets/')) {
            value = kvGet(key);
        }
        if(value === null){
            res.send();
        } else {
            // database.bin is stubs-only; recover defensively if an import path
            // ever leaks a payload into the live row.
            if (key === 'database/database.bin') {
                try {
                    value = (await prepareLiveDatabaseRead(value, 'Read')).fullBlob;
                } catch (e) {
                    // Log the Error itself (not just e.message) so logger.*
                    // tags it and the Express middleware won't re-log after next().
                    logger.error('[Read] Failed to load database.bin', e);
                    return next(e);
                }
                if (req.headers['if-none-match'] === dbEtag) {
                    return res.status(304).end();
                }
                res.setHeader('x-db-etag', dbEtag);
            } else {
                const cachedHashes = parseCachedHashesHeader(req.headers['x-cached-hashes']);
                if (cachedHashes.length > 0) {
                    const contentHash = sha256Hex(value);
                    res.setHeader('x-content-hash', contentHash);
                    if (cachedHashes.includes(contentHash)) {
                        return res.status(204).end();
                    }
                }
            }
            res.setHeader('Content-Type', 'application/octet-stream');
            res.send(value);
        }
    } catch (error) {
        next(error);
    }
});

const cachedDbReadJsonParser = express.json({ limit: '1mb' });

app.post('/api/db/read-cached', (req, res, next) => {
    cachedDbReadJsonParser(req, res, (error) => {
        if (!error) return next();
        const status = error.type === 'entity.too.large' ? 413 : 400;
        return res.status(status).json({ error: error.message });
    });
}, async (req, res, next) => {
    if (!await checkAuth(req, res)) return;

    let inventory;
    try {
        inventory = parseDbCacheInventory(req.body);
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }

    try {
        await flushPendingDb();
        const raw = kvGet('database/database.bin');
        if (raw === null) return res.status(404).json({ error: 'Database not found' });

        let prepared;
        try {
            prepared = await prepareLiveDatabaseRead(raw, 'ReadCached');
        } catch (error) {
            logger.error('[ReadCached] Failed to load database.bin', error);
            return next(error);
        }

        let encodedSegments;
        try {
            encodedSegments = encodeDatabaseSegments(prepared.strippedDatabase);
        } catch (error) {
            return res.status(409).json({ error: error.message });
        }
        const envelope = buildCachedDbReadEnvelope(encodedSegments, inventory, prepared.etag);
        res.setHeader('x-db-etag', prepared.etag);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.send(encodeCachedDbReadEnvelope(envelope));
    } catch (error) {
        next(error);
    }
});

app.get('/api/remove', async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    if (!checkActiveSession(req, res)) return;
    const filePath = req.headers['file-path'];
    if (!filePath) {
        res.status(400).send({ error:'File path required' });
        return;
    }
    if(!isHex(filePath)){
        res.status(400).send({ error:'Invaild Path' });
        return;
    }
    try {
        await queueStorageMutation(async () => {
            const key = Buffer.from(filePath, 'hex').toString('utf-8');
            if (key.startsWith('inlay/')) {
                const id = key.slice('inlay/'.length)
                await deleteInlayFile(id)
                kvDel(key);
                kvDel(`inlay_thumb/${id}`);
                kvDel(`inlay_info/${id}`);
                return res.send({ success: true });
            }
            if (key.startsWith('inlay_info/')) {
                await fs.unlink(getInlaySidecarPath(key.slice('inlay_info/'.length))).catch(() => {});
            }
            if (key.startsWith('assets/')) {
                deleteAssetValue(key);
            } else {
                kvDel(key);
            }
            res.send({ success: true });
        });
    } catch (error) {
        if (isImportInProgressError(error)) return sendImportBusy(res);
        next(error);
    }
});

app.get('/api/list', async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    try {
        const firstHeader = (value) => Array.isArray(value) ? value[0] : value;
        const keyPrefixHeader = firstHeader(req.headers['key-prefix']);
        const lastSyncHeader = firstHeader(req.headers['x-last-sync']);
        const epochHeader = firstHeader(req.headers['x-list-epoch']);
        const keyPrefix = typeof keyPrefixHeader === 'string' ? keyPrefixHeader : '';
        const parsedLastSync = Number(lastSyncHeader);
        const lastSync = Number.isSafeInteger(parsedLastSync) ? parsedLastSync : 0;
        await importBarrier.waitUntilIdle();
        const serverEpoch = kvGetListEpoch();
        const response = await buildListResponse({
            keyPrefix,
            lastSync,
            clientEpoch: typeof epochHeader === 'string' ? epochHeader : '',
            serverEpoch,
            now: Date.now(),
            listKv: kvList,
            listModifiedKv: kvListModifiedSince,
            listDeletedKv: kvGetDeletedSince,
            listAssetEntries: listAssetEntriesWithSizes,
            listInlayEntries: listInlayFiles,
            statFile: fs.stat,
        });
        res.send({ success: true, ...response });
    } catch (error) {
        next(error);
    }
});

// ─── /api/logs — client-side error/warning/info log persistence ───────────────
const LOGS_POST_MAX_ENTRIES = 1000;
app.post('/api/logs', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        const body = req.body;
        const entries = Array.isArray(body) ? body : [body];
        if (entries.length === 0) {
            return res.send({ success: true, written: 0 });
        }
        if (entries.length > LOGS_POST_MAX_ENTRIES) {
            return res.status(413).send({ error: `too many entries (max ${LOGS_POST_MAX_ENTRIES})` });
        }
        const prepared = entries
            .filter(e => e && typeof e === 'object' && typeof e.message === 'string')
            .map(e => ({
                timestamp: typeof e.timestamp === 'number' ? e.timestamp : Date.now(),
                level: e.level,
                origin: 'client',
                message: e.message,
                description: e.description,
                source: e.source,
                count: e.count,
                platform: e.platform,
                clientId: e.clientId,
                userAgent: e.userAgent,
            }));
        const written = addLogBatch(prepared);
        res.send({ success: true, written });
    } catch (error) {
        next(error);
    }
});

app.get('/api/logs', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        const parseCsv = (v) => typeof v === 'string' && v.length ? v.split(',').filter(Boolean) : undefined;
        const filterArgs = {
            level: typeof req.query.level === 'string' ? req.query.level : undefined,
            origin: typeof req.query.origin === 'string' ? req.query.origin : undefined,
            since: req.query.since ? Number(req.query.since) : undefined,
            excludeLevels: parseCsv(req.query.exclude_levels),
            excludeOrigins: parseCsv(req.query.exclude_origins),
            excludeBackground: req.query.exclude_background === '1',
        };
        const rows = queryLogs({
            ...filterArgs,
            beforeId: req.query.before_id ? Number(req.query.before_id) : undefined,
            limit: req.query.limit ? Number(req.query.limit) : undefined,
        });
        // total reflects rows matching the same filter — pagination math depends on it.
        res.send({ success: true, content: rows, total: countLogs(filterArgs) });
    } catch (error) {
        next(error);
    }
});

app.delete('/api/logs', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    try {
        clearLogs();
        res.send({ success: true });
    } catch (error) {
        next(error);
    }
});

app.post('/api/write', async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    if (!checkActiveSession(req, res)) return;
    const filePath = req.headers['file-path'];
    const fileContent = req.body;
    if (!filePath || !fileContent) {
        res.status(400).send({ error:'File path required' });
        return;
    }
    if(!isHex(filePath)){
        res.status(400).send({ error:'Invaild Path' });
        return;
    }
    let shouldCreateBackup = false;
    try {
        await queueStorageMutation(async () => {
            const key = Buffer.from(filePath, 'hex').toString('utf-8');
            let persistedDatabaseContent = fileContent;
            const assetVerification = key.startsWith('assets/')
                ? verifyAssetHash(key, fileContent)
                : null;
            if (assetVerification && !assetVerification.ok) {
                res.status(400).json({
                    error: 'asset content does not match its SHA-256 name',
                    key,
                    expected: assetVerification.claimed,
                    actual: assetVerification.actual,
                });
                return;
            }

            // ETag conflict detection for database.bin
            if (key === 'database/database.bin') {
                const ifMatch = req.headers['x-if-match'];
                if (ifMatch && dbEtag && ifMatch !== dbEtag) {
                    res.status(409).send({
                        error: 'ETag mismatch - concurrent modification detected',
                        currentEtag: dbEtag
                    });
                    return;
                }
            }

            if (key.startsWith('inlay/')) {
                const id = key.slice('inlay/'.length)
                const parsed = JSON.parse(Buffer.from(fileContent).toString('utf-8'));
                const type = typeof parsed?.type === 'string' ? parsed.type : 'image';
                const ext = normalizeInlayExt(parsed?.ext);
                const buffer = type === 'signature'
                    ? Buffer.from(typeof parsed?.data === 'string' ? parsed.data : '', 'utf-8')
                    : decodeDataUri(parsed?.data).buffer;
                await writeInlayFile(id, ext, buffer, {
                    ext,
                    name: typeof parsed?.name === 'string' ? parsed.name : id,
                    type,
                    height: typeof parsed?.height === 'number' ? parsed.height : undefined,
                    width: typeof parsed?.width === 'number' ? parsed.width : undefined,
                });
                kvDel(key);
                kvDel(`inlay_thumb/${id}`);
                kvDel(`inlay_info/${id}`);
                kvClearDeletion(key);
            } else if (key.startsWith('inlay_info/')) {
                const id = key.slice('inlay_info/'.length)
                const parsed = JSON.parse(Buffer.from(fileContent).toString('utf-8'));
                await writeInlaySidecar(id, parsed);
                kvDel(key);
            } else if (key === 'database/database.bin') {
                try {
                    // Reuse the existing stripped cache when available. Do not
                    // decode the prior live row solely for targeted cleanup;
                    // optimize's grace-window sweep handles cache-cold writes.
                    const previousStrippedDb = dbCache[filePath] || dbCache[DB_HEX_KEY] || null;
                    const incomingDb = await decodeRisuSave(fileContent);

                    // Mirror the patch-persist guard:
                    // a malformed full-write payload could carry chats with
                    // neither `_stub` nor `message` (the v1.4.x metadata-only
                    // pattern). They would land in the stripped DB and silently
                    // strand the corresponding chat row.
                    // Normal clients are safe (RisuSaveEncoder runs chatToStub
                    // on every chat first), but external tools / future
                    // regressions could bypass that — keep the guard at the
                    // disk boundary for defense in depth.
                    const losses = findStubFlagLossChats(incomingDb);
                    if (losses.length > 0) {
                        const sample = losses.slice(0, 3).map(l => `${l.chaId}/${l.chatId ?? l.chatIndex}`).join(', ');
                        const err = new Error(
                            `write aborted: ${losses.length} chat(s) lost _stub flag without upgrade — `
                            + `would silently strip messages on disk. sample=[${sample}]`
                        );
                        recordPersistFailure(err, '/api/write:stub-flag-loss');
                        logger.error(`[Write] ${err.message}`);
                        res.status(500).json({ error: 'Write aborted: chat data integrity check failed' });
                        return;
                    }

                    const duplicateChaIds = findDuplicateChaIds(incomingDb);
                    if (duplicateChaIds.length > 0) {
                        const sample = duplicateChaIds.slice(0, 3).join(', ');
                        const err = new Error(
                            `write aborted: ${duplicateChaIds.length} duplicate chaId value(s) — `
                            + `would collapse distinct chat rows. sample=[${sample}]`
                        );
                        recordPersistFailure(err, '/api/write:duplicate-cha-ids');
                        logger.error(`[Write] ${err.message}`);
                        res.status(500).json({ error: 'Write aborted: chat data integrity check failed' });
                        return;
                    }

                    const splitDatabase = chatRowStore.splitFullDb(incomingDb);
                    const chatRows = splitDatabase.chatEntries.map(entry => ({
                        ...entry,
                        value: Buffer.from(encodeRisuSaveLegacy(entry.chat)),
                    }));
                    const pluginExternalization = preparePluginStorageExternalization(
                        splitDatabase.strippedDb
                    );
                    const strippedDb = pluginExternalization.strippedDb;
                    if (chatRows.length > 0 || pluginExternalization.changed) {
                        persistedDatabaseContent = Buffer.from(encodeRisuSaveLegacy(strippedDb));
                    }

                    // Must stay synchronous: every external row and the stub graph
                    // commit or roll back together with database.bin.
                    sqliteDb.transaction(() => {
                        writePluginStorageRows(pluginExternalization.rows);
                        for (const row of chatRows) {
                            chatRowStore.writeChatRowRaw(row.chaId, row.chatId, row.value);
                        }
                        kvSet(key, persistedDatabaseContent);
                        if (previousStrippedDb) {
                            chatRowStore.deleteRemovedChatRows(previousStrippedDb, strippedDb);
                        }
                    })();
                } catch (e) {
                    logger.error('[Write] Failed to externalize database payloads:', e.message);
                    res.status(500).json({ error: 'Database write failed' });
                    return;
                }
            } else if (key.startsWith('assets/')) {
                writeAssetValue(key, fileContent, {
                    skipIfUnchanged: assetVerification.claimed !== null,
                });
            } else {
                kvSet(key, fileContent);
            }

            // Update ETag and invalidate cache after database.bin write. The
            // snapshot is queued only after this user-visible mutation returns.
            if (key === 'database/database.bin') {
                invalidateDbCache();
                // ETag based on stripped version (what client sees)
                dbEtag = computeBufferEtag(persistedDatabaseContent);
                shouldCreateBackup = true;
            } else if (Object.hasOwn(dbCache, filePath) || saveTimers[filePath]) {
                // A full write supersedes any cached/debounced patch state for
                // the same non-database key.
                invalidateDbCacheEntry(filePath);
            }

            res.send({
                success: true,
                etag: key === 'database/database.bin' ? dbEtag : undefined,
                hash: key.startsWith(PLUGIN_SAVE_PREFIX) ? sha256Hex(fileContent) : undefined,
            });
        });
        if (shouldCreateBackup) scheduleBackupAndRotate();
    } catch (error) {
        if (isImportInProgressError(error)) return sendImportBusy(res);
        next(error);
    }
});

app.post('/api/db/flush', sessionAuthMiddleware, async (req, res, next) => {
    if (!checkActiveSession(req, res)) return;
    try {
        await queueStorageMutation(async () => {
            await flushPendingDb();
            res.send({
                success: true,
                etag: dbEtag ?? undefined
            });
        });
    } catch (error) {
        if (isImportInProgressError(error)) return sendImportBusy(res);
        next(error);
    }
});

// ─── Patch sync endpoint ──────────────────────────────────────────────────────
app.post('/api/patch', async (req, res, next) => {
    if (!enablePatchSync) {
        res.status(404).send({ error: 'Patch sync is not enabled' });
        return;
    }
    if(!await checkAuth(req, res)){
        return;
    }
    if (!checkActiveSession(req, res)) return;
    const filePath = req.headers['file-path'];
    const patch = req.body.patch;
    const expectedHash = req.body.expectedHash;

    if (!filePath || !patch || !expectedHash) {
        res.status(400).send({ error: 'File path, patch, and expected hash required' });
        return;
    }
    if (!isHex(filePath)) {
        res.status(400).send({ error: 'Invaild Path' });
        return;
    }

    try {
        await queueStorageMutation(async () => {
            const decodedKey = Buffer.from(filePath, 'hex').toString('utf-8');

            // Load database into memory if not already cached
            // For database.bin, cache holds the STRIPPED version (stubs only)
            if (!dbCache[filePath]) {
                const fileContent = kvGet(decodedKey);
                if (fileContent) {
                    const decoded = decodedKey === 'database/database.bin'
                        ? await loadStrippedDatabase(fileContent, 'Patch')
                        : normalizeJSON(await decodeRisuSave(fileContent));
                    replaceDbCacheValue(filePath, decoded);
                } else {
                    replaceDbCacheValue(filePath, {});
                }
            }

            // Reject patch ops that touch chat-internal fields. Lazy loading
            // strips chats to stubs in dbCache; the only legitimate chat ops
            // are stub metadata (id, name, _stub, lastDate, folderId, modules)
            // or whole-chat add/replace/remove. Field-level ops on chats —
            // particularly remove of message/hypaV3Data/scriptstate/etc —
            // strip the `_stub` flag and cause silent on-disk data loss when
            // persistence later sees the metadata-only chat. Reject as 409 so
            // the client falls through to a full write and rebases its
            // patcher baseline. See findStubFlagLossChats for the disk-side
            // partner guard.
            const chatInternalOps = decodedKey === 'database/database.bin'
                ? findChatInternalFieldOps(patch)
                : [];
            if (chatInternalOps.length > 0) {
                const sample = chatInternalOps.slice(0, 5).map(v => `${v.op} ${v.path}`).join(', ');
                logger.warn(
                    `[Patch] Rejected ${chatInternalOps.length} chat-internal field op(s) `
                    + `(would corrupt lazy-loaded chats): ${sample}`
                );
                let currentEtag;
                try {
                    currentEtag = getDbCacheEtag(filePath);
                    dbEtag = currentEtag;
                } catch {}
                res.status(409).send({
                    error: 'Patch rejected: chat-internal field ops not allowed for lazy-loaded chats',
                    code: 'CHAT_GUARD_REJECTED',
                    chatGuardRejected: true,
                    currentEtag,
                });
                return;
            }

            const serverHash = getDbCacheHash(filePath);

            if (expectedHash !== serverHash) {
                console.log(`[Patch] Hash mismatch for ${decodedKey}: expected=${expectedHash}, server=${serverHash}`);
                let currentEtag = undefined;
                if (decodedKey === 'database/database.bin') {
                    currentEtag = getDbCacheEtag(filePath);
                    dbEtag = currentEtag;
                }
                res.status(409).send({
                    error: 'Hash mismatch - data out of sync',
                    currentEtag
                });
                return;
            }

            // Only patch-path ancestors are copied. Until the complete sequence
            // succeeds, every object reachable from dbCache remains untouched.
            const cachedDb = dbCache[filePath];
            const result = applyPatchAtomic(cachedDb, patch);
            const snapshot = result.newDocument;
            if (decodedKey === 'database/database.bin') {
                // Keep dbCache and the ETag on the same optimized stub shape
                // that the debounced persist will write.
                const externalized = externalizePluginStorageIfNeeded(snapshot);
                const extracted = chatRowStore.extractPayloadChats(snapshot);
                trackPendingChatRowDeletions(cachedDb, snapshot);
                // A patch with no mutating op (empty, or test-only) returns the
                // cached object itself, so replaceDbCacheValue sees no identity
                // change and skips the generation bump. These two normalizations
                // edit in place, so bump explicitly when they actually changed
                // something — otherwise the memoized hash/ETag would keep
                // describing the pre-normalization shape.
                if (snapshot === cachedDb && (externalized.changed || extracted > 0)) {
                    dbDerivedValueMemo.bump(filePath);
                }
            }
            replaceDbCacheValue(filePath, snapshot);

            // Schedule stubs-only save to KV (debounced).
            if (saveTimers[filePath]) {
                clearTimeout(saveTimers[filePath]);
            }
            const saveTimer = setTimeout(() => {
                queueStorageMutation(async () => {
                    if (saveTimers[filePath] !== saveTimer) return;
                    try {
                        if (decodedKey === 'database/database.bin') {
                            await persistDbCache(filePath, decodedKey);
                        } else {
                            const data = Buffer.from(encodeRisuSaveLegacy(dbCache[filePath]));
                            try {
                                kvSet(decodedKey, data);
                            } catch (err) {
                                if (err && typeof err === 'object') {
                                    try { err.attemptedSize = data.length; } catch {}
                                }
                                throw err;
                            }
                        }
                        // Persist succeeded — clear before backup so a backup-only
                        // failure isn't attributed to data loss.
                        clearPersistFailure();
                        if (decodedKey === 'database/database.bin') {
                            try {
                                await createBackupAndRotate();
                            } catch (backupErr) {
                                logger.warn(`[Patch] Backup rotation failed for ${decodedKey}:`, backupErr);
                            }
                        }
                    } catch (error) {
                        logger.error(`[Patch] Error saving ${decodedKey}:`, error);
                        recordPersistFailure(error, `patch:${decodedKey}`);
                    } finally {
                        if (saveTimers[filePath] === saveTimer) delete saveTimers[filePath];
                    }
                }).catch((error) => {
                    if (saveTimers[filePath] === saveTimer) delete saveTimers[filePath];
                    if (isImportInProgressError(error)) {
                        // The import replaces this key wholesale and drops dbCache,
                        // so the superseded debounced save is not a persist failure.
                        logger.info(`[Patch] Skipped debounced save for ${decodedKey}: import in progress`);
                        return;
                    }
                    logger.error(`[Patch] Storage queue failed for ${decodedKey}:`, error);
                });
            }, SAVE_INTERVAL);
            saveTimers[filePath] = saveTimer;

            // Update ETag after successful patch (based on stripped version)
            if (decodedKey === 'database/database.bin') {
                dbEtag = getDbCacheEtag(filePath);
            }

            const responsePayload = {
                success: true,
                appliedOperations: result.length,
                etag: decodedKey === 'database/database.bin' ? dbEtag : undefined,
            };
            const persistWarning = currentPersistWarning();
            if (persistWarning) {
                responsePayload.persistWarning = persistWarning;
            }
            res.send(responsePayload);
        });
    } catch (error) {
        if (isImportInProgressError(error)) return sendImportBusy(res);
        logger.error(`[Patch] Error applying patch to ${filePath}:`, error.name);
        res.status(500).send({
            error: 'Patch application failed: ' + (error && error.message ? error.message : error)
        });
    }
});

// ─── Bulk asset endpoints (3-2-B) ─────────────────────────────────────────────
const BULK_BATCH = 50;

app.post('/api/assets/bulk-read', async (req, res, next) => {
    if(!await checkAuth(req, res)){ return; }
    try {
        const keys = req.body; // string[] — decoded key strings
        if(!Array.isArray(keys)){
            res.status(400).send({ error: 'Body must be a JSON array of keys' });
            return;
        }

        const acceptsBinary = (req.headers['accept'] || '').includes('application/octet-stream');

        if (acceptsBinary) {
            // Binary protocol: [count(4)] then per entry: [keyLen(4)][key][valLen(4)][value]
            // Eliminates ~33% base64 overhead
            const entries = [];
            let totalSize = 4; // count header
            for (let i = 0; i < keys.length; i += BULK_BATCH) {
                const batch = keys.slice(i, i + BULK_BATCH);
                for (const key of batch) {
                    let value = null;
                    if (typeof key === 'string' && key.startsWith('inlay_info/')) {
                        value = await readInlayInfoPayload(key.slice('inlay_info/'.length));
                    }
                    if (value === null) {
                        value = typeof key === 'string' && key.startsWith('assets/')
                            ? readAssetValue(key)
                            : kvGet(key);
                    }
                    if (value !== null) {
                        const keyBuf = Buffer.from(key, 'utf-8');
                        const valBuf = Buffer.from(value);
                        entries.push({ keyBuf, valBuf });
                        totalSize += 4 + keyBuf.length + 4 + valBuf.length;
                    }
                }
            }
            const out = Buffer.allocUnsafe(totalSize);
            let offset = 0;
            out.writeUInt32BE(entries.length, offset); offset += 4;
            for (const { keyBuf, valBuf } of entries) {
                out.writeUInt32BE(keyBuf.length, offset); offset += 4;
                keyBuf.copy(out, offset); offset += keyBuf.length;
                out.writeUInt32BE(valBuf.length, offset); offset += 4;
                valBuf.copy(out, offset); offset += valBuf.length;
            }
            res.set('Content-Type', 'application/octet-stream');
            res.send(out);
        } else {
            // Legacy JSON+base64 fallback
            const results = [];
            for (let i = 0; i < keys.length; i += BULK_BATCH) {
                const batch = keys.slice(i, i + BULK_BATCH);
                for (const key of batch) {
                    let value = null;
                    if (typeof key === 'string' && key.startsWith('inlay_info/')) {
                        value = await readInlayInfoPayload(key.slice('inlay_info/'.length));
                    }
                    if (value === null) {
                        value = typeof key === 'string' && key.startsWith('assets/')
                            ? readAssetValue(key)
                            : kvGet(key);
                    }
                    if (value !== null) {
                        results.push({ key, value: Buffer.from(value).toString('base64') });
                    }
                }
            }
            res.json(results);
        }
    } catch(error){ next(error); }
});

app.post('/api/assets/bulk-write', async (req, res, next) => {
    if(!await checkAuth(req, res)){ return; }
    if (!checkActiveSession(req, res)) return;
    try {
        const entries = req.body; // {key: string, value: base64}[]
        if(!Array.isArray(entries)){
            res.status(400).send({ error: 'Body must be a JSON array of {key, value}' });
            return;
        }
        const decodedEntries = entries.map(({ key, value }) => {
            const buffer = Buffer.from(value, 'base64');
            const verification = typeof key === 'string' && key.startsWith('assets/')
                ? verifyAssetHash(key, buffer)
                : null;
            return { key, buffer, verification };
        });
        const mismatches = decodedEntries
            .filter((entry) => entry.verification && !entry.verification.ok)
            .map((entry) => ({
                key: entry.key,
                expected: entry.verification.claimed,
                actual: entry.verification.actual,
            }));
        if (mismatches.length > 0) {
            res.status(400).json({
                error: 'asset content does not match its SHA-256 name',
                keys: mismatches.map((entry) => entry.key),
                mismatches,
            });
            return;
        }

        // One mutation for every batch: a partially-applied bulk write must not
        // straddle the point where an import claims the barrier.
        await queueStorageMutation(() => {
            for(let i = 0; i < decodedEntries.length; i += BULK_BATCH){
                const batch = decodedEntries.slice(i, i + BULK_BATCH);
                const writeBatch = sqliteDb.transaction(() => {
                    for(const { key, buffer, verification } of batch){
                        if (typeof key === 'string' && key.startsWith('assets/')) {
                            writeAssetValue(key, buffer, {
                                skipIfUnchanged: verification.claimed !== null,
                            });
                        } else {
                            kvSet(key, buffer);
                        }
                    }
                });
                writeBatch();
            }
        });
        res.json({ success: true, count: entries.length });
    } catch(error){
        if (isImportInProgressError(error)) return sendImportBusy(res);
        next(error);
    }
});

app.get('/api/backup/export', async (req, res, next) => {
    if(!await checkAuth(req, res)){ return; }
    let backupDbSpool = null;
    let backupSnapshot = null;
    let closed = false;
    res.once('close', () => { closed = true; });
    try {
        backupSnapshot = await queueStorageOperation(async () => {
            await flushPendingDb();
            return createKvSnapshot();
        });

        // ?target=upstream excludes NodeOnly-only slashed namespaces: plugin
        // rows plus inlay/, inlay_sidecar/, and inlay_meta/. Upstream RisuAI's
        // import treats those names as paths under assets/ and fails with
        // ENOENT. Plugin rows are folded inline; inlay images remain lossy.
        const target = req.query.target === 'upstream' ? 'upstream' : 'nodeonly';
        backupDbSpool = await buildSelfContainedBackupDatabase({
            foldPluginStorage: target === 'upstream',
            shouldAbort: () => closed,
            onMissingChatRow: (chaId, chatId) => {
                warnAndPreserveMissingChatRow('Backup Export', chaId, chatId);
            },
            snapshot: backupSnapshot,
        });
        if (closed) return;
        const inlayFiles = target === 'upstream' ? [] : await listInlayFiles();
        const inlayEntries = await Promise.all(inlayFiles.map(async (entry) => {
            const stat = await fs.stat(entry.filePath);
            return {
                kind: 'file',
                sourcePath: entry.filePath,
                backupName: `inlay/${entry.id}.${entry.ext}`,
                sortKey: `inlay/${entry.id}`,
                size: stat.size,
            };
        }));
        const sidecarEntries = await Promise.all(inlayFiles.map(async (entry) => {
            const sidecarPath = getInlaySidecarPath(entry.id);
            try {
                const stat = await fs.stat(sidecarPath);
                return {
                    kind: 'sidecar',
                    sourcePath: sidecarPath,
                    backupName: `inlay_sidecar/${entry.id}`,
                    sortKey: `inlay_sidecar/${entry.id}`,
                    size: stat.size,
                };
            } catch {
                return null;
            }
        }));
        const inlayMetaEntries = target === 'upstream' ? [] : backupSnapshot.kvListWithSizes('inlay_meta/').map((entry) => ({
            kind: 'kv',
            key: entry.key,
            backupName: entry.key,
            sortKey: entry.key,
            size: entry.size,
        }));
        const pluginEntries = target === 'upstream' ? [] : listPluginBackupEntries(backupSnapshot);
        const namespacedEntries = [
            ...listAssetEntriesWithSizes(backupSnapshot).map((entry) => ({
                kind: 'asset',
                key: entry.key,
                backupName: path.basename(entry.key),
                sortKey: entry.key,
                size: entry.size,
            })),
            ...listColdStorageBackupEntries({
                reader: backupSnapshot,
                migrateLegacy: false,
            }),
            ...pluginEntries,
            ...inlayMetaEntries,
            ...inlayEntries,
            ...sidecarEntries.filter(Boolean),
        ].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
        const dbSize = backupDbSpool?.size ?? 0;
        const totalBytes = namespacedEntries.reduce((sum, entry) => {
            return sum + backupEntrySize(entry.backupName, entry.size);
        }, 0) + (dbSize ? backupEntrySize('database.risudat', dbSize) : 0);

        const filenameSuffix = target === 'upstream' ? '-upstream' : '';
        res.setHeader('content-type', 'application/octet-stream');
        res.setHeader('content-disposition', `attachment; filename="risu-backup-${Date.now()}${filenameSuffix}.bin"`);
        res.setHeader('content-length', totalBytes);
        res.setHeader('x-risu-backup-assets', namespacedEntries.length);

        for (const entry of namespacedEntries) {
            if (closed) break;
            const value = entry.kind === 'asset'
                ? readAssetValue(entry.key, backupSnapshot)
                : entry.kind === 'kv'
                    ? backupSnapshot.kvGet(entry.key)
                : entry.kind === 'buffer'
                    ? entry.buffer
                    : await fs.readFile(entry.sourcePath);
            if (closed) break;
            if (value === null || value?.length !== entry.size) {
                const actualSize = value === null ? 'missing' : value?.length;
                const error = new Error(
                    `Backup entry changed while exporting: ${entry.backupName} `
                    + `(planned ${entry.size} bytes, found ${actualSize})`
                );
                logger.error('[Backup Export] Aborting inconsistent stream', error);
                closed = true;
                res.destroy(error);
                return;
            }
            if (!await writeWithBackpressure(
                res,
                encodeBackupEntry(entry.backupName, value),
                () => closed
            )) break;
        }

        if (!closed && dbSize && backupDbSpool) {
            const header = encodeBackupEntryHeader('database.risudat', dbSize);
            if (await writeWithBackpressure(res, header, () => closed)) {
                await streamFileToWritable(backupDbSpool.filePath, res, () => closed);
            }
        }
        if (!closed) res.end();
    } catch (error) {
        if (!closed && error?.code === 'BACKUP_MISSING_CHAT_ROW') {
            logger.error('[Backup Export] Failed:', error);
            res.status(500).json({ error: error.message, code: error.code });
        } else if (!closed) {
            next(error);
        }
    } finally {
        backupSnapshot?.close();
        if (backupDbSpool) {
            await fs.unlink(backupDbSpool.filePath).catch(() => {});
        }
    }
});

// Pre-flight check: auth + size + disk space before client starts uploading
app.post('/api/backup/import/prepare', async (req, res, next) => {
    if (!await checkAuth(req, res)) { return; }
    if (!checkActiveSession(req, res)) return;
    try {
        if (importInProgress) {
            res.status(409).json({ error: 'Another import is already in progress' });
            return;
        }

        const size = Number(req.body?.size ?? 0);
        if (BACKUP_IMPORT_MAX_BYTES > 0 && size > BACKUP_IMPORT_MAX_BYTES) {
            res.status(413).json({ error: `Backup exceeds max allowed size (${BACKUP_IMPORT_MAX_BYTES} bytes)` });
            return;
        }

        if (size > 0) {
            const disk = await checkDiskSpace(size * BACKUP_DISK_HEADROOM);
            if (!disk.ok) {
                res.status(507).json({
                    error: 'Insufficient disk space',
                    available: disk.available,
                    required: size * BACKUP_DISK_HEADROOM,
                });
                return;
            }
        }

        res.json({ ok: true });
    } catch (error) {
        next(error);
    }
});

app.post('/api/backup/import', async (req, res, next) => {
    if(!await checkAuth(req, res)){ return; }
    if (!checkActiveSession(req, res)) return;

    if (importInProgress) {
        res.status(409).json({ error: 'Another import is already in progress' });
        return;
    }
    importInProgress = true;
    const releaseImportBarrier = await importBarrier.acquire();
    let prevRequestTimeout;
    let wantsNdjson = false;
    let heartbeatTimer = null;

    try {
        // Disable timeouts for large backup uploads
        prevRequestTimeout = req.socket.server?.requestTimeout;
        req.socket.setTimeout(0);
        req.socket.setKeepAlive(true);
        if (req.socket.server) req.socket.server.requestTimeout = 0;

        // NDJSON streaming keeps the response socket alive during long
        // post-upload work (WAL checkpoint, cold-storage migration). Without it
        // a reverse proxy in front of the server can hit its response timeout
        // and bounce the request back to the client as 502 Bad Gateway.
        wantsNdjson = String(req.headers['accept'] ?? '').includes('application/x-ndjson');
        const contentType = String(req.headers['content-type'] ?? '');
        if (contentType && !contentType.includes('application/x-risu-backup') && !contentType.includes('application/octet-stream')) {
            res.status(415).json({ error: 'Unsupported backup content-type' });
            return;
        }

        const contentLength = Number(req.headers['content-length'] ?? '0');
        if (BACKUP_IMPORT_MAX_BYTES > 0 && Number.isFinite(contentLength) && contentLength > BACKUP_IMPORT_MAX_BYTES) {
            res.status(413).json({ error: `Backup exceeds max allowed size (${BACKUP_IMPORT_MAX_BYTES} bytes)` });
            return;
        }

        if (wantsNdjson) {
            res.setHeader('content-type', 'application/x-ndjson');
            res.setHeader('cache-control', 'no-cache, no-transform');
            // Disable nginx response buffering so progress events flush immediately.
            res.setHeader('x-accel-buffering', 'no');
            res.flushHeaders();

            // Periodic keepalive — covers the post-stream phase (commit,
            // inlay dir swap, cold storage migration) where onProgress is silent.
            heartbeatTimer = setInterval(() => {
                if (!res.writableEnded) res.write('{"type":"heartbeat"}\n');
            }, BACKUP_NDJSON_HEARTBEAT_MS);

            let lastProgressWrite = 0;
            const totalBytes = Number.isFinite(contentLength) ? contentLength : 0;
            const result = await importBackupFromSource(req, {
                maxBytes: BACKUP_IMPORT_MAX_BYTES,
                totalBytes,
                onProgress: (received, total) => {
                    const now = Date.now();
                    if (now - lastProgressWrite < 200) return;
                    lastProgressWrite = now;
                    res.write(JSON.stringify({ type: 'progress', bytes: received, totalBytes: total }) + '\n');
                },
            });
            res.write(JSON.stringify({
                type: 'done',
                ok: true,
                assetsRestored: result.assetsRestored,
                coldStorageFailed: result.coldStorageFailed,
            }) + '\n');
            res.end();
        } else {
            const result = await importBackupFromSource(req, { maxBytes: BACKUP_IMPORT_MAX_BYTES });
            res.json({
                ok: true,
                assetsRestored: result.assetsRestored,
                coldStorageFailed: result.coldStorageFailed,
            });
        }
    } catch (error) {
        if (wantsNdjson && res.headersSent) {
            try {
                res.write(JSON.stringify({ type: 'error', message: error?.message || 'backup import failed' }) + '\n');
                res.end();
            } catch (_) {}
        } else {
            next(error);
        }
    } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        importInProgress = false;
        releaseImportBarrier();
        if (req.socket.server && prevRequestTimeout !== undefined) {
            req.socket.server.requestTimeout = prevRequestTimeout;
        }
    }
});

// ── Server-side backup endpoints ────────────────────────────────────────────

// Save current data as a .bin backup file on the server
app.post('/api/backup/server/save', async (req, res, next) => {
    if (!await checkAuth(req, res)) { return; }
    if (!checkActiveSession(req, res)) return;
    if (HUB_HOSTING_MODE) return res.status(403).json({ error: 'Server backups are disabled on this instance' });
    let backupDbSpool = null;
    let backupSnapshot = null;
    let closed = false;
    res.once('close', () => { closed = true; });
    try {
        backupSnapshot = await queueStorageOperation(async () => {
            await flushPendingDb();
            return createKvSnapshot();
        });
        backupDbSpool = await buildSelfContainedBackupDatabase({
            foldPluginStorage: false,
            shouldAbort: () => closed,
            snapshot: backupSnapshot,
        });
        if (closed) return;

        // Pre-flight disk check — bail before streaming if the target dir
        // can't fit the backup. Avoids wasted minutes + half-written tmp files.
        try {
            const estimate = await estimateServerBackupSize(backupSnapshot);
            const required = Math.ceil(estimate * 1.05); // 5% safety margin
            const sf = await fs.statfs(backupsDir);
            const free = sf.bsize * sf.bavail;
            if (estimate > 0 && free < required) {
                return res.status(400).json({
                    error: `Insufficient disk space (need ~${(required / 1024 / 1024).toFixed(0)} MB, free ${(free / 1024 / 1024).toFixed(0)} MB)`,
                    code: 'insufficient_space',
                    required,
                    free,
                });
            }
        } catch (e) {
            // Non-fatal: log and proceed. statfs may be unavailable, in which
            // case the streaming fallback path below still fails gracefully.
            console.warn('[Backup] pre-flight disk check failed:', e?.message || e);
        }

        const inlayFiles = await listInlayFiles();
        const inlayEntries = await Promise.all(inlayFiles.map(async (entry) => {
            const stat = await fs.stat(entry.filePath);
            return { kind: 'file', sourcePath: entry.filePath, backupName: `inlay/${entry.id}.${entry.ext}`, size: stat.size };
        }));
        const sidecarEntries = (await Promise.all(inlayFiles.map(async (entry) => {
            const sidecarPath = getInlaySidecarPath(entry.id);
            try {
                const stat = await fs.stat(sidecarPath);
                return { kind: 'sidecar', sourcePath: sidecarPath, backupName: `inlay_sidecar/${entry.id}`, size: stat.size };
            } catch { return null; }
        }))).filter(Boolean);

        const namespacedEntries = [
            ...listAssetEntriesWithSizes(backupSnapshot).map((e) => ({ kind: 'asset', key: e.key, backupName: path.basename(e.key), size: e.size })),
            ...listColdStorageBackupEntries({
                reader: backupSnapshot,
                migrateLegacy: false,
            }),
            ...listPluginBackupEntries(backupSnapshot),
            ...backupSnapshot.kvListWithSizes('inlay_meta/').map((e) => ({ kind: 'kv', key: e.key, backupName: e.key, size: e.size })),
            ...inlayEntries,
            ...sidecarEntries,
        ];

        const totalEntries = namespacedEntries.length + 1; // +1 for database
        const totalBytes = namespacedEntries.reduce(
            (sum, entry) => sum + backupEntrySize(entry.backupName, entry.size),
            0
        ) + (backupDbSpool
            ? backupEntrySize('database.risudat', backupDbSpool.size)
            : 0);

        // Stream progress as NDJSON
        res.setHeader('content-type', 'application/x-ndjson');
        res.flushHeaders();

        const filename = `risu-backup-${Date.now()}.bin`;
        const finalPath = path.join(backupsDir, filename);
        const tmpPath = finalPath + '.tmp';
        const writeStream = createWriteStream(tmpPath);
        const writeStreamFinished = finished(writeStream);
        writeStreamFinished.catch(() => {});

        let writeComplete = false;

        try {
            let written = 0;
            let bytesWritten = 0;
            for (const entry of namespacedEntries) {
                if (closed) break;
                const value = entry.kind === 'asset'
                    ? readAssetValue(entry.key, backupSnapshot)
                    : entry.kind === 'kv'
                        ? backupSnapshot.kvGet(entry.key)
                    : entry.kind === 'buffer'
                        ? entry.buffer
                        : await fs.readFile(entry.sourcePath);
                if (value === null || value?.length !== entry.size) {
                    const actualSize = value === null ? 'missing' : value?.length;
                    throw new Error(
                        `Backup entry changed while saving: ${entry.backupName} `
                        + `(planned ${entry.size} bytes, found ${actualSize})`
                    );
                }
                const encodedEntry = encodeBackupEntry(entry.backupName, value);
                if (!await writeWithBackpressure(writeStream, encodedEntry, () => closed)) break;
                bytesWritten += encodedEntry.length;
                written++;
                if (written % 50 === 0 || written === namespacedEntries.length) {
                    res.write(JSON.stringify({ type: 'progress', current: written, total: totalEntries, bytes: bytesWritten, totalBytes }) + '\n');
                }
            }
            if (closed) throw new Error('Client disconnected during backup save');
            if (backupDbSpool) {
                const header = encodeBackupEntryHeader('database.risudat', backupDbSpool.size);
                if (!await writeWithBackpressure(writeStream, header, () => closed)) {
                    throw new Error('Client disconnected during backup save');
                }
                if (!await streamFileToWritable(backupDbSpool.filePath, writeStream, () => closed)) {
                    throw new Error('Client disconnected during backup save');
                }
                bytesWritten += header.length + backupDbSpool.size;
            }
            res.write(JSON.stringify({ type: 'progress', current: totalEntries, total: totalEntries, bytes: bytesWritten, totalBytes }) + '\n');
            writeStream.end();
            await writeStreamFinished;

            // Atomic rename: only expose the file after successful write
            await fs.rename(tmpPath, finalPath);
            writeComplete = true;

            const stat = await fs.stat(finalPath);
            console.log(`[Server Backup] Saved: ${filename} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
            res.write(JSON.stringify({ type: 'done', ok: true, filename, size: stat.size }) + '\n');
            res.end();
        } catch (innerError) {
            // Clean up incomplete temp file
            if (!writeComplete) {
                writeStream.destroy();
                await writeStreamFinished.catch(() => {});
                await fs.unlink(tmpPath).catch(() => {});
            }
            throw innerError;
        }
    } catch (error) {
        if (closed) {
            return;
        } else if (!res.headersSent && error?.code === 'BACKUP_MISSING_CHAT_ROW') {
            res.status(500).json({ error: error.message, code: error.code });
        } else if (!res.headersSent) {
            next(error);
        } else {
            res.write(JSON.stringify({ type: 'error', message: error.message }) + '\n');
            res.end();
        }
    } finally {
        backupSnapshot?.close();
        if (backupDbSpool) {
            await fs.unlink(backupDbSpool.filePath).catch(() => {});
        }
    }
});

// List backup files on the server
app.get('/api/backup/server/list', async (req, res, next) => {
    if (!await checkAuth(req, res)) { return; }
    if (HUB_HOSTING_MODE) return res.status(403).json({ error: 'Server backups are disabled on this instance' });
    try {
        let entries;
        try {
            entries = await fs.readdir(backupsDir, { withFileTypes: true });
        } catch {
            res.json({ backups: [] });
            return;
        }
        const backups = [];
        for (const entry of entries) {
            if (!entry.isFile() || !BACKUP_FILENAME_REGEX.test(entry.name)) continue;
            const stat = await fs.stat(path.join(backupsDir, entry.name));
            const tsMatch = entry.name.match(/^risu-backup-(\d+)\.bin$/);
            backups.push({
                filename: entry.name,
                size: stat.size,
                createdAt: tsMatch ? Number(tsMatch[1]) : stat.mtimeMs,
            });
        }
        backups.sort((a, b) => b.createdAt - a.createdAt);
        res.json({ backups });
    } catch (error) {
        next(error);
    }
});

// Restore from a server backup file
app.post('/api/backup/server/restore', async (req, res, next) => {
    if (!await checkAuth(req, res)) { return; }
    if (!checkActiveSession(req, res)) return;
    if (HUB_HOSTING_MODE) return res.status(403).json({ error: 'Server backups are disabled on this instance' });

    if (importInProgress) {
        res.status(409).json({ error: 'Another import is already in progress' });
        return;
    }
    importInProgress = true;
    const releaseImportBarrier = await importBarrier.acquire();

    try {
        const filename = req.body?.filename;
        if (!filename || !BACKUP_FILENAME_REGEX.test(filename)) {
            res.status(400).json({ error: 'Invalid backup filename' });
            return;
        }
        const filePath = path.join(backupsDir, filename);
        let fileStat;
        try {
            fileStat = await fs.stat(filePath);
        } catch {
            res.status(404).json({ error: 'Backup file not found' });
            return;
        }

        const disk = await checkDiskSpace(fileStat.size * BACKUP_DISK_HEADROOM);
        if (!disk.ok) {
            res.status(507).json({
                error: 'Insufficient disk space',
                available: disk.available,
                required: fileStat.size * BACKUP_DISK_HEADROOM,
            });
            return;
        }

        res.setHeader('content-type', 'application/x-ndjson');
        res.flushHeaders();

        let lastProgressWrite = 0;
        const { createReadStream } = require('fs');
        const stream = createReadStream(filePath, { highWaterMark: 256 * 1024 });
        const result = await importBackupFromSource(stream, {
            totalBytes: fileStat.size,
            onProgress: (received, total) => {
                const now = Date.now();
                if (now - lastProgressWrite < 200) return;
                lastProgressWrite = now;
                res.write(JSON.stringify({ type: 'progress', bytes: received, totalBytes: total }) + '\n');
            },
        });
        res.write(JSON.stringify({
            type: 'done',
            ok: true,
            assetsRestored: result.assetsRestored,
            coldStorageFailed: result.coldStorageFailed,
        }) + '\n');
        res.end();
    } catch (error) {
        if (!res.headersSent) {
            next(error);
        } else {
            res.write(JSON.stringify({ type: 'error', message: error.message }) + '\n');
            res.end();
        }
    } finally {
        importInProgress = false;
        releaseImportBarrier();
    }
});

// Delete a server backup file
app.delete('/api/backup/server/:filename', async (req, res, next) => {
    if (!await checkAuth(req, res)) { return; }
    if (!checkActiveSession(req, res)) return;
    if (HUB_HOSTING_MODE) return res.status(403).json({ error: 'Server backups are disabled on this instance' });
    try {
        const filename = req.params.filename;
        if (!BACKUP_FILENAME_REGEX.test(filename)) {
            res.status(400).json({ error: 'Invalid backup filename' });
            return;
        }
        const filePath = path.join(backupsDir, filename);
        try {
            await fs.unlink(filePath);
        } catch (err) {
            if (err.code === 'ENOENT') {
                res.status(404).json({ error: 'Backup file not found' });
                return;
            }
            throw err;
        }
        res.json({ ok: true });
    } catch (error) {
        next(error);
    }
});

// Download a server backup file
app.get('/api/backup/server/download/:filename', async (req, res, next) => {
    if (!await checkAuth(req, res)) { return; }
    if (HUB_HOSTING_MODE) return res.status(403).json({ error: 'Server backups are disabled on this instance' });
    try {
        const filename = req.params.filename;
        if (!BACKUP_FILENAME_REGEX.test(filename)) {
            res.status(400).json({ error: 'Invalid backup filename' });
            return;
        }
        const filePath = path.join(backupsDir, filename);
        let stat;
        try {
            stat = await fs.stat(filePath);
        } catch {
            res.status(404).json({ error: 'Backup file not found' });
            return;
        }
        res.setHeader('content-type', 'application/octet-stream');
        res.setHeader('content-disposition', `attachment; filename="${filename}"`);
        res.setHeader('content-length', stat.size);
        const { createReadStream } = require('fs');
        createReadStream(filePath).pipe(res);
    } catch (error) {
        next(error);
    }
});

// ── Chat backup endpoints ──────────────────────────────────────────────────

app.get('/api/chat-backups', async (req, res, next) => {
    if (!await checkAuth(req, res)) { return; }
    try {
        const chats = await queueStorageOperation(
            () => chatBackupStore.listChatBackupChats()
        );
        res.json({ chats });
    } catch (error) {
        next(error);
    }
});

app.get('/api/chat-backups/:chaId/:chatId', async (req, res, next) => {
    if (!await checkAuth(req, res)) { return; }
    try {
        const versions = await queueStorageOperation(
            () => chatBackupStore.listChatBackups(req.params.chaId, req.params.chatId)
        );
        res.json({ versions });
    } catch (error) {
        next(error);
    }
});

app.get('/api/chat-backups/:chaId/:chatId/:versionId', async (req, res, next) => {
    if (!await checkAuth(req, res)) { return; }
    const { chaId, chatId, versionId } = req.params;
    if (!CHAT_BACKUP_VERSION_ID_REGEX.test(versionId)) {
        res.status(400).json({ error: 'Invalid chat backup version ID' });
        return;
    }
    try {
        const raw = await queueStorageOperation(
            () => chatBackupStore.readChatBackup(chaId, chatId, versionId)
        );
        if (!raw) {
            res.status(404).json({ error: 'Chat backup version not found' });
            return;
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.send(raw);
    } catch (error) {
        next(error);
    }
});

// ── Chat content endpoints (runtime lazy load) ─────────────────────────────

// Cold storage compatibility: restore data stored in coldstorage/ KV entries
const COLD_STORAGE_HEADER = '\uEF01COLDSTORAGE\uEF01';

function restoreColdStorageCharacter(character) {
    if (!character?.coldstorage) return true;
    const key = character.coldstorage;
    const entry = readColdStorageJsonEntry(key, {
        migrateLegacy: true,
    });
    if (!entry) {
        logger.error(`[ColdStorage] character data not found for key: ${key}`);
        return false;
    }
    try {
        const coldData = entry.coldData;
        if (coldData?.character) {
            Object.assign(character, coldData.character);
            delete character.coldstorage;
            delete character.coldStoragedChats;
        } else {
            logger.error(`[ColdStorage] unexpected character cold data format for key: ${key}`);
            return false;
        }
        return true;
    } catch (err) {
        logger.error(`[ColdStorage] character restore failed for key ${key}:`, err.message);
        return false;
    }
}

function promoteFailedColdStorageStub(char) {
    const coldKey = char.coldstorage;
    // Fill in missing fields with safe defaults matching createBlankChar() in src/ts/characters.ts.
    // SYNC: if createBlankChar() defaults change, update this object to match.
    const defaults = {
        firstMessage: '', desc: '', notes: '', chatFolders: [],
        emotionImages: [], bias: [], viewScreen: 'none', globalLore: [],
        sdData: [
            ['always', 'solo, 1girl'], ['negative', ''],
            ["|character's appearance", ''], ['current situation', ''],
            ["$character's pose", ''], ["$character's emotion", ''],
            ['current location', ''],
        ],
        utilityBot: false, customscript: [], exampleMessage: '',
        creatorNotes: '', systemPrompt: '', postHistoryInstructions: '',
        alternateGreetings: [], tags: [], creator: '', characterVersion: '',
        personality: '', scenario: '',
        firstMsgIndex: -1,
        replaceGlobalNote: '', additionalText: '',
        triggerscript: [
            { comment: '', type: 'manual', conditions: [], effect: [{ type: 'v2Header', code: '', indent: 0 }] },
            { comment: 'New Event', type: 'manual', conditions: [], effect: [] },
        ],
    };
    for (const [key, value] of Object.entries(defaults)) {
        if (char[key] === undefined || char[key] === null) {
            char[key] = value;
        }
    }
    // Force firstMsgIndex to -1 even if stub had 0 — prevents alternateGreetings[0] access on empty array
    char.firstMsgIndex = -1;
    // Ensure chats array is valid
    if (!Array.isArray(char.chats) || char.chats.length === 0) {
        char.chats = [{ message: [], note: '', name: 'Chat 1', localLore: [] }];
    }
    // Leave recovery breadcrumb and remove cold storage markers
    char.desc = `[Cold storage restore failed. Original key: ${coldKey}]\n\n${char.desc || ''}`.trim();
    delete char.coldstorage;
    delete char.coldStoragedChats;
}

function restoreColdStorageCharactersInDb(dbObj) {
    const result = { restored: 0, failed: 0, failedNames: [] };
    if (!Array.isArray(dbObj?.characters)) return result;
    for (let i = 0; i < dbObj.characters.length; i++) {
        const char = dbObj.characters[i];
        if (!char?.coldstorage) continue;
        if (restoreColdStorageCharacter(char)) {
            result.restored++;
        } else {
            result.failed++;
            result.failedNames.push(char.name || `(index ${i})`);
            promoteFailedColdStorageStub(char);
        }
    }
    return result;
}

function isColdStorageChat(chat) {
    return chat?.message?.[0]?.data?.startsWith(COLD_STORAGE_HEADER);
}

function restoreColdStorageChat(chat) {
    if (!isColdStorageChat(chat)) return true;
    const key = chat.message[0].data.slice(COLD_STORAGE_HEADER.length);
    const entry = readColdStorageJsonEntry(key, {
        migrateLegacy: true,
    });
    if (!entry) {
        logger.error(`[ColdStorage] data not found for key: ${key}`);
        return false;
    }
    try {
        const coldData = entry.coldData;
        if (Array.isArray(coldData)) {
            chat.message = coldData;
        } else if (coldData?.message) {
            chat.message = coldData.message;
            if (coldData.hypaV3Data) chat.hypaV3Data = coldData.hypaV3Data;
            if (coldData.scriptstate) chat.scriptstate = coldData.scriptstate;
            if (coldData.localLore) chat.localLore = coldData.localLore;
        }
        chat.lastDate = Date.now();
        return true;
    } catch (err) {
        logger.error(`[ColdStorage] restore failed for key ${key}:`, err.message);
        return false;
    }
}

// GET /api/chat-content/:chaId/:chatIndex — retrieve full chat from server
app.get('/api/chat-content/:chaId/:chatIndex', async (req, res, next) => {
    if (!await checkAuth(req, res)) { return; }
    try {
        const chaId = req.params.chaId;
        const chatIndex = parseInt(req.params.chatIndex, 10);
        const expectedChatId = req.headers['x-chat-id'];
        let chatId = expectedChatId;
        let chat = chatId ? await chatRowStore.readChatRow(chaId, chatId) : null;

        // Header-less legacy callers resolve index→id through the stripped DB.
        // A failed id lookup also keeps the historical shifted-index 409 check.
        if (!chat) {
            const raw = kvGet('database/database.bin');
            if (!raw) return res.status(404).json({ error: 'Database not found' });
            const strippedDb = dbCache[DB_HEX_KEY]
                || await loadStrippedDatabase(raw, 'ChatContent');
            const char = strippedDb.characters?.find(c => c?.chaId === chaId);
            const stub = char?.chats?.[chatIndex];
            if (!stub) return res.status(404).json({ error: 'Chat not found' });
            if (expectedChatId && stub.id !== expectedChatId) {
                return res.status(409).json({ error: 'Chat ID mismatch — index may have shifted' });
            }
            chatId = stub.id;
            if (!chatId) return res.status(404).json({ error: 'Chat not found' });
            chat = await chatRowStore.readChatRow(chaId, chatId);
        }
        if (!chat) return res.status(404).json({ error: 'Chat not found' });

        const needsRehydration = isColdStorageChat(chat);
        if (!restoreColdStorageChat(chat)) {
            return res.status(500).json({ error: 'Cold storage restore failed' });
        }
        let encoded;
        if (needsRehydration) {
            // Cache-fill only, so it can be skipped rather than gated: writing it
            // during an import would either be rolled back or strand a row under a
            // chaId the import just cleared. The next read rehydrates again.
            if (!importBarrier.isHeld()) {
                chatRowStore.writeChatRow(chaId, chatId, chat);
            }
            encoded = Buffer.from(encodeRisuSaveLegacy(chat));
        } else {
            encoded = chatRowStore.readChatRowRaw(chaId, chatId)
                || Buffer.from(encodeRisuSaveLegacy(chat));
        }
        const contentHash = sha256Hex(encoded);
        res.setHeader('x-content-hash', contentHash);
        const cachedHashes = parseCachedHashesHeader(req.headers['x-cached-hashes']);
        if (cachedHashes.includes(contentHash)) {
            return res.status(204).end();
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.send(encoded);
    } catch (error) {
        next(error);
    }
});

// POST /api/chat-content/:chaId/:chatIndex — save chat content to server
app.post('/api/chat-content/:chaId/:chatIndex', async (req, res, next) => {
    if (!await checkAuth(req, res)) { return; }
    if (!checkActiveSession(req, res)) return;
    try {
        await queueStorageMutation(async () => {
            const chaId = req.params.chaId;
            const expectedChatId = req.headers['x-chat-id'];
            let chatData;
            const isRawBinary = Buffer.isBuffer(req.body);
            if (isRawBinary) {
                // Binary msgpack body (application/octet-stream)
                try {
                    chatData = await decodeRisuSave(req.body);
                } catch (e) {
                    return res.status(400).json({ error: 'Invalid binary chat data' });
                }
            } else {
                // JSON body (legacy)
                chatData = req.body;
            }

            if (!chatData || !expectedChatId) {
                return res.status(400).json({ error: 'Chat data and x-chat-id required' });
            }
            if (chatData._stub === true && !Array.isArray(chatData.message)) {
                return res.status(400).json({ error: 'Bare chat stubs cannot be stored as chat content' });
            }
            let healedHybrid = false;
            if (chatData._stub === true && Array.isArray(chatData.message)) {
                chatData = { ...chatData };
                delete chatData._stub;
                healedHybrid = true;
            }

            // This must remain immediately before the row write: every version
            // is the exact state the incoming save was about to replace.
            await chatBackupStore.captureChatPreImage({
                chaId,
                chatId: expectedChatId,
                reason: req.headers['x-chat-backup-reason'],
            });
            if (isRawBinary && !healedHybrid) {
                chatRowStore.writeChatRowRaw(chaId, expectedChatId, req.body);
            } else {
                chatRowStore.writeChatRow(chaId, expectedChatId, chatData);
            }
            const storedBytes = chatRowStore.readChatRowRaw(chaId, expectedChatId);
            if (!storedBytes) {
                throw new Error('Stored chat row could not be read');
            }
            const hash = sha256Hex(storedBytes);
            await createBackupAndRotate();

            res.json({ success: true, hash });
        });
    } catch (error) {
        if (isImportInProgressError(error)) return sendImportBusy(res);
        next(error);
    }
});

// ── Save-folder migration endpoints ──────────────────────────────────────────
const migrationMarkerPath = path.join(savePath, '.migrated_to_sqlite');

function scanHexFilesInDir(dirPath) {
    let files;
    try {
        files = readdirSync(dirPath);
    } catch {
        return { hexFiles: [], count: 0, totalSize: 0, hasDatabase: false };
    }
    const hexFiles = files.filter(f => hexRegex.test(f));
    let totalSize = 0;
    let hasDatabase = false;
    for (const f of hexFiles) {
        try {
            const stat = require('fs').statSync(path.join(dirPath, f));
            totalSize += stat.size;
        } catch { /* skip unreadable files */ }
        try {
            if (Buffer.from(f, 'hex').toString('utf-8') === 'database/database.bin') hasDatabase = true;
        } catch { /* invalid hex */ }
    }
    return { hexFiles, count: hexFiles.length, totalSize, hasDatabase };
}

function clearExistingData() {
    kvDelPrefix('assets/');
    kvDelPrefix('inlay/');
    kvDelPrefix('inlay_thumb/');
    kvDelPrefix('inlay_meta/');
    kvDelPrefix('inlay_info/');
    kvDelPrefix(PLUGIN_SAVE_PREFIX);
    kvDelPrefix(PLUGIN_SAVE_META_PREFIX);
    for (const key of chatRowStore.listAllChatRowKeys()) kvDel(key);
    // Composer drafts aren't part of a save folder; clear stale ones on import.
    kvDelPrefix('drafts/');
    // Drop the previous user's remote payloads. The new save folder usually
    // brings its own remotes/<id>.local.bin files (INSERT OR REPLACE), but if
    // the imported character ids reuse names from the prior user without
    // shipping a matching payload, the migration's resolveRemote would silently
    // stitch in stale cross-user data. Wiping here ensures only payloads
    // that arrived in this import survive.
    kvDelPrefix('remotes/');
    // Clear remote-block migration marker — newly imported database.bin may
    // contain REMOTE blocks (it usually does, since save-folder imports
    // preserve upstream's split-character format) and we want the migration
    // to re-evaluate against the new contents during post-import ingest.
    kvDel(REMOTE_MIGRATION_MARKER_KEY);
    kvDel(CHAT_EXTERNALIZATION_MARKER_KEY);
    clearEntities();
}

async function importLegacySaveEntries(sources, missingDatabaseMessage) {
    recoverPendingImportSwap('Save-folder import preparation');
    if (sources.length === 0) return { imported: 0 };
    const databaseEntry = sources.find((entry) => entry.key === DB_BLOB_KEY);
    if (!databaseEntry) {
        throw new Error(missingDatabaseMessage);
    }
    const databaseSource = databaseEntry.streamSource ?? databaseEntry.read();
    const databaseInspection = await inspectRisuSaveSource(databaseSource);
    const streamDatabase = await shouldStreamRisuSave(databaseSource, {
        inspection: databaseInspection,
    });
    await flushPendingDb();
    await createBackupAndRotate();
    invalidateAllDbCaches();
    const existingAssetKeys = listAssetEntriesWithSizes()
        .filter((entry) => entry.source === 'fs')
        .map((entry) => entry.key);
    const assetStage = await prepareAssetImportStage();
    let assetSwap = null;
    let streamingIngestion = null;
    let journal = null;
    let transactionCommitted = false;

    try {
        sqliteDb.exec('BEGIN');
        for (const key of existingAssetKeys) kvRecordDeletion(key);
        clearExistingData();
        for (const source of sources) {
            const { key } = source;
            if (key === DB_BLOB_KEY && streamDatabase) continue;
            const value = key === DB_BLOB_KEY && !source.streamSource
                ? databaseSource
                : source.read();
            if (key.startsWith('assets/')) {
                writeImportedAsset(
                    assetStage,
                    key,
                    value,
                    'Save-folder import'
                );
                continue;
            }
            // Modern save folders may also contain externalized chat and plugin
            // rows. Plugin rows use the generic raw-row insert below; route the
            // chunk-capable namespaces through the safe bind path.
            if (key === DB_BLOB_KEY
                || key.startsWith('database/dbbackup-')
                || key.startsWith('chats/')) {
                kvSet(key, value);
                continue;
            }
            kvSet(key, value);
        }

        if (streamDatabase) {
            streamingIngestion = await ingestDatabaseStreaming(databaseSource, {
                inspection: databaseInspection,
            });
            markRemoteMigrationDone();
        }

        fsyncDirectoryTree(assetImportStagingDir);
        journal = {
            id: nodeCrypto.randomUUID(),
            phase: 'swapped',
            dirs: [{
                liveDir: assetDir,
                backupDir: assetImportBackupDir,
                stagingDir: assetImportStagingDir,
                liveExisted: fsSync.existsSync(assetDir),
            }],
        };
        kvSet(IMPORT_JOURNAL_MARKER_KEY, Buffer.from(journal.id, 'utf-8'));
        writeImportJournal(IMPORT_JOURNAL_PATH, journal);
        assetSwap = swapAssetDirectoryFromStaging(
            assetImportStagingDir,
            assetImportBackupDir
        );
        kvBumpListEpoch();
        sqliteDb.exec('COMMIT');
        transactionCommitted = true;

        checkpointWal('TRUNCATE');
        journal = { ...journal, phase: 'committed' };
        writeImportJournal(IMPORT_JOURNAL_PATH, journal);
        assetSwap.finalize();
        kvDel(IMPORT_JOURNAL_MARKER_KEY);
        clearImportJournal(IMPORT_JOURNAL_PATH);
    } catch (error) {
        if (!transactionCommitted) {
            let rollbackSucceeded = !error?.restoreError;
            try {
                sqliteDb.exec('ROLLBACK');
            } catch (rollbackError) {
                rollbackSucceeded = false;
                logger.error('[Save-folder Import] Failed to roll back SQLite transaction:', rollbackError);
            }
            try {
                kvBumpListEpoch();
            } catch (epochError) {
                logger.error('[Save-folder Import] Failed to bump list epoch after rollback:', epochError);
            }
            if (assetSwap) {
                try { assetSwap.rollback(); } catch (rollbackError) {
                    rollbackSucceeded = false;
                    logger.error('[Save-folder Import] Failed to restore previous asset directory:', rollbackError);
                }
            } else {
                try {
                    await fs.rm(assetImportStagingDir, { recursive: true, force: true });
                } catch (cleanupError) {
                    rollbackSucceeded = false;
                    logger.error('[Save-folder Import] Failed to remove asset staging directory:', cleanupError);
                }
            }
            if (journal && rollbackSucceeded) {
                try {
                    clearImportJournal(IMPORT_JOURNAL_PATH);
                } catch (cleanupError) {
                    logger.error('[Save-folder Import] Failed to clear rolled-back import journal:', cleanupError);
                }
            }
        }
        throw error;
    }

    const importedDbRaw = streamingIngestion ? null : kvGet(DB_BLOB_KEY);
    if (importedDbRaw) {
        await ingestDatabase(importedDbRaw);
    }
    writeFileSync(migrationMarkerPath, new Date().toISOString(), 'utf-8');
    return { imported: sources.length };
}

async function importHexFilesFromDir(dirPath) {
    const { hexFiles, hasDatabase } = scanHexFilesInDir(dirPath);
    if (hexFiles.length === 0) return { imported: 0 };
    if (!hasDatabase) throw new Error('Save folder does not contain database/database.bin');
    const sources = hexFiles.map((hexFile) => {
        const key = Buffer.from(hexFile, 'hex').toString('utf-8');
        const filePath = path.join(dirPath, hexFile);
        return {
            key,
            streamSource: key === DB_BLOB_KEY
                ? { filePath, size: require('fs').statSync(filePath).size }
                : null,
            read: () => readFileSync(filePath),
        };
    });
    return importLegacySaveEntries(
        sources,
        'Save folder does not contain database/database.bin'
    );
}

async function importHexEntries(entries) {
    const sources = entries.map(({ key, value }) => ({
        key,
        streamSource: key === DB_BLOB_KEY ? value : null,
        read: () => value,
    }));
    return importLegacySaveEntries(
        sources,
        'Data does not contain database/database.bin'
    );
}

app.post('/api/migrate/save-folder/scan', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    try {
        const folderPath = req.body?.path || savePath;
        const resolved = path.resolve(folderPath);
        try {
            const stat = require('fs').statSync(resolved);
            if (!stat.isDirectory()) {
                res.status(400).json({ error: 'Path is not a directory' });
                return;
            }
        } catch {
            res.status(400).json({ error: 'Cannot access directory' });
            return;
        }
        const { count, totalSize, hasDatabase } = scanHexFilesInDir(resolved);
        res.json({ count, totalSize, hasDatabase });
    } catch (error) {
        next(error);
    }
});

app.post('/api/migrate/save-folder/execute', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    if (importInProgress) {
        res.status(409).json({ error: 'Another import is already in progress' });
        return;
    }
    importInProgress = true;
    const releaseImportBarrier = await importBarrier.acquire();
    try {
        const folderPath = req.body?.path || savePath;
        const resolved = path.resolve(folderPath);
        try {
            const stat = require('fs').statSync(resolved);
            if (!stat.isDirectory()) {
                res.status(400).json({ error: 'Path is not a directory' });
                return;
            }
        } catch {
            res.status(400).json({ error: 'Cannot access directory' });
            return;
        }
        const result = await importHexFilesFromDir(resolved);
        res.json({ ok: true, imported: result.imported });
    } catch (error) {
        res.status(400).json({ error: error.message || 'Import failed' });
    } finally {
        importInProgress = false;
        releaseImportBarrier();
    }
});

app.post('/api/migrate/save-folder/upload', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    if (importInProgress) {
        res.status(409).json({ error: 'Another import is already in progress' });
        return;
    }
    importInProgress = true;
    const releaseImportBarrier = await importBarrier.acquire();
    let prevRequestTimeout;

    try {
        req.socket.setTimeout(0);
        req.socket.setKeepAlive(true);
        prevRequestTimeout = req.socket.server?.requestTimeout;
        if (req.socket.server) req.socket.server.requestTimeout = 0;

        const chunks = [];
        let totalSize = 0;
        for await (const chunk of req) {
            totalSize += chunk.length;
            if (BACKUP_IMPORT_MAX_BYTES > 0 && totalSize > BACKUP_IMPORT_MAX_BYTES) {
                res.status(413).json({ error: 'Zip file exceeds max allowed size' });
                return;
            }
            chunks.push(chunk);
        }
        const zipBuffer = Buffer.concat(chunks);

        const fflate = require('fflate');
        let unzipped;
        try {
            unzipped = fflate.unzipSync(new Uint8Array(zipBuffer));
        } catch {
            res.status(400).json({ error: 'Invalid or corrupted zip file' });
            return;
        }

        const entries = [];
        for (const [entryPath, data] of Object.entries(unzipped)) {
            if (data.length === 0) continue;
            const basename = path.basename(entryPath);
            if (!hexRegex.test(basename)) continue;
            try {
                const key = Buffer.from(basename, 'hex').toString('utf-8');
                entries.push({ key, value: Buffer.from(data) });
            } catch { /* invalid hex filename */ }
        }

        if (entries.length === 0) {
            res.status(400).json({ error: 'No compatible hex files found in zip' });
            return;
        }

        const result = await importHexEntries(entries);
        res.json({ ok: true, imported: result.imported });
    } catch (error) {
        res.status(400).json({ error: error.message || 'Import failed' });
    } finally {
        importInProgress = false;
        releaseImportBarrier();
        if (req.socket.server && prevRequestTimeout !== undefined) {
            req.socket.server.requestTimeout = prevRequestTimeout;
        }
    }
});

app.post('/api/migrate/save-folder/cleanup/scan', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    try {
        if (!existsSync(migrationMarkerPath)) {
            res.status(400).json({ error: 'Migration has not been completed yet' });
            return;
        }
        const { count, totalSize } = scanHexFilesInDir(savePath);
        res.json({ count, totalSize });
    } catch (error) {
        next(error);
    }
});

app.post('/api/migrate/save-folder/cleanup/execute', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    try {
        if (!existsSync(migrationMarkerPath)) {
            res.status(400).json({ error: 'Migration has not been completed yet' });
            return;
        }
        const { hexFiles } = scanHexFilesInDir(savePath);
        let removed = 0;
        let freedBytes = 0;
        for (const f of hexFiles) {
            try {
                const filePath = path.join(savePath, f);
                const stat = require('fs').statSync(filePath);
                unlinkSync(filePath);
                freedBytes += stat.size;
                removed++;
            } catch { /* skip unremovable files */ }
        }
        res.json({ ok: true, removed, freedBytes });
    } catch (error) {
        next(error);
    }
});

// ── Storage dashboard endpoints ──────────────────────────────────────────────

const DB_BLOB_KEY = 'database/database.bin';
const DB_BACKUP_PREFIX = 'database/dbbackup-';
const ASSET_PREFIXES = ['assets/', 'remotes/', 'inlay/', 'inlay_thumb/', 'inlay_meta/', 'inlay_info/', 'coldstorage/'];

function statsBasename(s) {
    if (!s) return '';
    return String(s).replace(/\\/g, '/').split('/').pop();
}

// Mirrors src/ts/globalApi.svelte.ts:getUncleanables — every asset reference reachable from the DB.
function buildUncleanableSet(dbObj) {
    const set = new Set();
    const add = (v) => {
        const bn = statsBasename(v);
        if (bn) set.add(bn);
    };
    if (!dbObj) return set;
    add(dbObj.customBackground);
    add(dbObj.userIcon);
    if (Array.isArray(dbObj.characters)) {
        for (const cha of dbObj.characters) {
            if (!cha) continue;
            add(cha.image);
            if (Array.isArray(cha.emotionImages)) for (const em of cha.emotionImages) add(em?.[1]);
            if (Array.isArray(cha.additionalAssets)) for (const em of cha.additionalAssets) add(em?.[1]);
            if (cha.vits?.files) for (const k of Object.keys(cha.vits.files)) add(cha.vits.files[k]);
            if (Array.isArray(cha.ccAssets)) for (const a of cha.ccAssets) add(a?.uri);
        }
    }
    if (Array.isArray(dbObj.modules)) {
        for (const m of dbObj.modules) if (Array.isArray(m?.assets)) for (const a of m.assets) add(a?.[1]);
    }
    if (Array.isArray(dbObj.personas)) for (const p of dbObj.personas) add(p?.icon);
    if (Array.isArray(dbObj.characterOrder)) {
        for (const item of dbObj.characterOrder) {
            if (item && typeof item === 'object' && 'imgFile' in item) add(item.imgFile);
        }
    }
    return set;
}

function statSafe(p) {
    try { return require('fs').statSync(p); } catch { return null; }
}

async function diskFreeStat(dirPath) {
    try {
        const sf = await fs.statfs(dirPath);
        return { free: sf.bsize * sf.bavail, total: sf.bsize * sf.blocks };
    } catch { return { free: null, total: null }; }
}

// Sum the on-disk inlay payload (image files + sidecar JSONs in save/inlays).
// Returns 0 if the directory is missing. Used by both the backup-size
// estimator and the dashboard inlay total — kv inlay/* prefixes don't
// reflect filesystem bytes after the inlay→fs migration.
async function sumInlayFsBytes() {
    let total = 0;
    try {
        const inlayFiles = await listInlayFiles();
        await Promise.all(inlayFiles.map(async (entry) => {
            try {
                const st = await fs.stat(entry.filePath);
                total += st.size;
            } catch { /* missing — skip */ }
            try {
                const sst = await fs.stat(getInlaySidecarPath(entry.id));
                total += sst.size;
            } catch { /* sidecar may not exist */ }
        }));
    } catch { /* dir missing */ }
    return total;
}

async function sumDirectoryFsBytes(directory) {
    let entries = [];
    try {
        entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
        return 0;
    }
    const sizes = await Promise.all(entries.map(async (entry) => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            return sumDirectoryFsBytes(entryPath);
        } else if (entry.isFile()) {
            try { return (await fs.stat(entryPath)).size; } catch {}
        }
        return 0;
    }));
    return sizes.reduce((total, size) => total + size, 0);
}

// Estimated server-backup size — mirrors the enumeration in
// /api/backup/server/save without writing anything. Inlay files live on the
// filesystem (post-migration), so we have to fs.stat them rather than read
// kvSize. Cost: ~5-50 ms typical, ~200 ms for users with thousands of inlays.
async function estimateServerBackupSize(reader = null) {
    let total = 0;
    total += reader
        ? (reader.kvListWithSizes(DB_BLOB_KEY).find((it) => it.key === DB_BLOB_KEY)?.size ?? 0)
        : (kvSize(DB_BLOB_KEY) || 0);
    // Server backups carry plugin values as individual archive entries. Count
    // their raw payload sizes without reading or decoding them.
    const sizeReader = reader || { kvListWithSizes };
    for (const it of sizeReader.kvListWithSizes(PLUGIN_SAVE_PREFIX)) total += it.size;
    for (const it of sizeReader.kvListWithSizes(PLUGIN_SAVE_META_PREFIX)) total += it.size;
    for (const it of listAssetEntriesWithSizes(sizeReader)) total += it.size;
    for (const it of sizeReader.kvListWithSizes('inlay_meta/')) total += it.size;
    for (const e of reader
        ? listColdStorageBackupEntries({ reader, migrateLegacy: false })
        : listColdStorageBackupEntries()) total += e.size;
    total += await sumInlayFsBytes();
    return total;
}

app.get('/api/db/stats', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        const saveDir = path.join(process.cwd(), 'save');
        const dbFilePath = path.join(saveDir, 'risuai.db');
        const walPath = dbFilePath + '-wal';
        const shmPath = dbFilePath + '-shm';

        const files = {
            db: statSafe(dbFilePath)?.size ?? 0,
            wal: statSafe(walPath)?.size ?? 0,
            shm: statSafe(shmPath)?.size ?? 0,
        };

        const disk = HUB_HOSTING_MODE
            ? { free: null, total: null }
            : await diskFreeStat(saveDir);
        // Backup destination disk — same as save/ in the default config but
        // can diverge when the user points backupsDir at a different mount.
        // Surfaced separately so backup-side warnings target the right disk.
        // `sameAsSaveDir` is true when both paths land on the same filesystem
        // (compared by Stat.dev). Dashboard uses this to decide whether to
        // count file backups against the save/ disk in the storage chart.
        let backupDisk;
        if (!HUB_HOSTING_MODE) {
            const bDisk = await diskFreeStat(backupsDir);
            let sameAsSaveDir = false;
            try {
                const saveStat = require('fs').statSync(saveDir);
                const bStat = require('fs').statSync(backupsDir);
                sameAsSaveDir = saveStat.dev === bStat.dev;
            } catch { /* non-fatal */ }
            backupDisk = { ...bDisk, path: backupsDir, sameAsSaveDir };
        }

        const pageSize = sqliteDb.pragma('page_size', { simple: true });
        const pageCount = sqliteDb.pragma('page_count', { simple: true });
        const freelistCount = sqliteDb.pragma('freelist_count', { simple: true });
        const journalMode = sqliteDb.pragma('journal_mode', { simple: true });
        const autoVacuum = sqliteDb.pragma('auto_vacuum', { simple: true });
        const reclaimable = freelistCount * pageSize;

        const dbBlobSize = kvSize(DB_BLOB_KEY) || 0;

        // Physical storage of the chunked DB blob (and all snapshots, which share
        // chunks). This is where the blob bytes actually live post-chunking — kv
        // holds only a tiny marker, so the chart must count this table separately.
        const chunkStat = sqliteDb.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(LENGTH(data)), 0) AS b FROM chunks').get();
        // Bytes the next gc() would reclaim (true orphans + chunks pinned only by
        // stale/raw-overwritten manifests) — drives the Optimize button.
        const orphanChunkBytes = reclaimableChunkBytes();
        const liveChunked = isDbBlobChunked();

        // Prefix breakdown — split database/ into the live blob vs rotated backups.
        const prefixes = {};
        prefixes[DB_BLOB_KEY] = { totalSize: dbBlobSize, count: dbBlobSize > 0 ? 1 : 0 };
        const backupKeys = kvList(DB_BACKUP_PREFIX);
        let backupTotal = 0;
        let backupOldest = null, backupNewest = null;
        for (const k of backupKeys) {
            const sz = kvSize(k) || 0;
            backupTotal += sz;
            const tsRaw = parseInt(k.slice(DB_BACKUP_PREFIX.length, -4), 10);
            if (Number.isFinite(tsRaw)) {
                const ts = tsRaw * 100;
                if (!backupOldest || ts < backupOldest) backupOldest = ts;
                if (!backupNewest || ts > backupNewest) backupNewest = ts;
            }
        }
        prefixes[DB_BACKUP_PREFIX] = { totalSize: backupTotal, count: backupKeys.length };
        const chatKeys = chatRowStore.listAllChatRowKeys();
        let chatTotal = 0, chatKvRowSize = 0;
        for (const key of chatKeys) chatTotal += kvSize(key) || 0;
        for (const entry of kvListWithSizes('chats/')) chatKvRowSize += entry.size;
        const chatChunkBytes = sqliteDb.prepare(
            `SELECT COALESCE(SUM(LENGTH(data)), 0) AS b
             FROM chunks
             WHERE hash IN (
                 SELECT hash FROM manifest_chunks WHERE manifest_key LIKE 'chats/%'
             )`
        ).get().b;
        prefixes['chats/'] = {
            totalSize: chatTotal,
            count: chatKeys.length,
            physicalSize: chatKvRowSize + chatChunkBytes,
            kvRowSize: chatKvRowSize,
            chunkBytes: chatChunkBytes,
        };
        for (const p of ASSET_PREFIXES) {
            const items = p === 'assets/'
                ? listAssetEntriesWithSizes()
                : kvListWithSizes(p);
            let total = 0;
            for (const it of items) total += it.size;
            prefixes[p] = { totalSize: total, count: items.length };
        }

        const kvRows = sqliteDb.prepare('SELECT COUNT(*) AS c FROM kv').get().c;
        const kvTotalBytes = sqliteDb.prepare('SELECT COALESCE(SUM(LENGTH(value)), 0) AS s FROM kv').get().s;

        let fileBackups = { count: 0, totalSize: 0, oldest: null, newest: null };
        if (!HUB_HOSTING_MODE) {
            try {
                const entries = await fs.readdir(backupsDir, { withFileTypes: true });
                for (const e of entries) {
                    if (!e.isFile() || !BACKUP_FILENAME_REGEX.test(e.name)) continue;
                    const st = await fs.stat(path.join(backupsDir, e.name));
                    fileBackups.count++;
                    fileBackups.totalSize += st.size;
                    const ts = st.mtimeMs;
                    if (!fileBackups.oldest || ts < fileBackups.oldest) fileBackups.oldest = ts;
                    if (!fileBackups.newest || ts > fileBackups.newest) fileBackups.newest = ts;
                }
            } catch { /* backups dir may not exist */ }
        }

        // Quick estimates from in-memory cache only — never decode the BLOB just for stats.
        let trashed = { count: 0, expiredCount: 0, available: false };
        let orphan = { count: 0, totalSize: 0, available: false };
        const stripped = dbCache[DB_HEX_KEY];
        if (stripped?.characters) {
            const now = Date.now();
            const GRACE = 1000 * 60 * 60 * 24 * 3;
            for (const c of stripped.characters) {
                if (c?.trashTime) {
                    trashed.count++;
                    if (c.trashTime + GRACE < now) trashed.expiredCount++;
                }
            }
            trashed.available = true;
        }
        if (stripped) {
            const uncleanable = buildUncleanableSet(stripped);
            for (const it of listAssetEntriesWithSizes()) {
                if (!uncleanable.has(statsBasename(it.key))) {
                    orphan.count++;
                    orphan.totalSize += it.size;
                }
            }
            orphan.available = true;
        }

        const estimatedBackupSize = HUB_HOSTING_MODE
            ? undefined
            : await estimateServerBackupSize();
        // Inlay payload now lives on the filesystem (post-migration) rather
        // than in kv `inlay/*` prefixes. Surface explicitly so the dashboard
        // chart can include it in the inlay slice instead of underreporting.
        const inlayFsBytes = await sumInlayFsBytes();
        const assetFsBytes = sumAssetFsBytes();
        const chatBackupFsBytes = await sumDirectoryFsBytes(chatBackupsDir);
        let chatBackupSameAsSaveDir = true;
        try {
            const saveStat = require('fs').statSync(saveDir);
            const chatBackupStat = require('fs').statSync(chatBackupsDir);
            chatBackupSameAsSaveDir = saveStat.dev === chatBackupStat.dev;
        } catch {
            const relative = path.relative(saveDir, chatBackupsDir);
            chatBackupSameAsSaveDir = !relative.startsWith('..') && !path.isAbsolute(relative);
        }

        res.json({
            hubHosting: HUB_HOSTING_MODE,
            files,
            disk,
            ...(backupDisk ? { backupDisk } : {}),
            sqlite: { pageSize, pageCount, freelistCount, reclaimable, journalMode, autoVacuum },
            chunks: { count: chunkStat.c, bytes: chunkStat.b, orphanBytes: orphanChunkBytes, liveChunked },
            prefixes,
            kvRows,
            kvTotalBytes,
            ...(typeof estimatedBackupSize === 'number' ? { estimatedBackupSize } : {}),
            assetFsBytes,
            inlayFsBytes,
            chatBackupFsBytes,
            chatBackupSameAsSaveDir,
            backups: {
                kv: { count: backupKeys.length, totalSize: backupTotal, oldest: backupOldest, newest: backupNewest },
                file: fileBackups,
            },
            trashed,
            orphan,
            etag: dbEtag,
        });
    } catch (err) { next(err); }
});

app.get('/api/db/stats/characters', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        const raw = kvGet(DB_BLOB_KEY);
        if (!raw) {
            res.json({ characters: [], orphan: { count: 0, totalSize: 0 }, chatBytesNote: 'estimate' });
            return;
        }
        const dbObj = await decodeRisuSave(raw);

        const assetSize = new Map();
        for (const it of listAssetEntriesWithSizes()) {
            assetSize.set(statsBasename(it.key), it.size);
        }
        // remotes/<chaId>.local.bin (+ optional .meta sidecar) → bucket by chaId.
        const remoteSize = new Map();
        for (const it of kvListWithSizes('remotes/')) {
            const bn = statsBasename(it.key).replace(/\.meta$/, '');
            const chaId = bn.replace(/\.local\.bin$/, '');
            if (chaId) remoteSize.set(chaId, (remoteSize.get(chaId) || 0) + it.size);
        }

        const claimed = new Set();
        const characters = [];
        const list = Array.isArray(dbObj.characters) ? dbObj.characters : [];
        for (const cha of list) {
            if (!cha) continue;
            const refs = [];
            const collect = (v) => { if (v) refs.push(statsBasename(v)); };
            collect(cha.image);
            if (Array.isArray(cha.emotionImages)) for (const em of cha.emotionImages) collect(em?.[1]);
            if (Array.isArray(cha.additionalAssets)) for (const em of cha.additionalAssets) collect(em?.[1]);
            if (cha.vits?.files) for (const k of Object.keys(cha.vits.files)) collect(cha.vits.files[k]);
            if (Array.isArray(cha.ccAssets)) for (const a of cha.ccAssets) collect(a?.uri);

            // Same asset shared across characters is attributed to the first one we see — avoids double-counting.
            let imgBytes = 0;
            for (const bn of refs) {
                if (!bn || claimed.has(bn)) continue;
                const sz = assetSize.get(bn);
                if (sz != null) {
                    imgBytes += sz;
                    claimed.add(bn);
                }
            }
            const remoteBytes = remoteSize.get(cha.chaId) || 0;

            const chatBytes = chatRowStore.chatBytesForChar(cha.chaId);

            // Card body = the character row minus chats (which we count separately).
            // Asset URIs themselves are tiny strings — leaving them in card body is fine.
            let cardBytes = 0;
            try {
                const { chats: _drop, ...body } = cha;
                cardBytes = JSON.stringify(body).length;
            } catch { /* skip un-serializable */ }

            characters.push({
                chaId: cha.chaId || '',
                name: cha.name || '',
                image: cha.image || '',
                trashed: !!cha.trashTime,
                cardBytes,
                imgBytes: imgBytes + remoteBytes,
                chatBytes,
                totalBytes: cardBytes + imgBytes + remoteBytes + chatBytes,
            });
        }

        const uncleanable = buildUncleanableSet(dbObj);
        let orphanCount = 0, orphanTotal = 0;
        for (const it of listAssetEntriesWithSizes()) {
            if (!uncleanable.has(statsBasename(it.key))) {
                orphanCount++;
                orphanTotal += it.size;
            }
        }

        characters.sort((a, b) => b.totalBytes - a.totalBytes);
        res.json({
            characters,
            orphan: { count: orphanCount, totalSize: orphanTotal },
            chatBytesNote: 'JSON.stringify estimate; on-disk msgpack ~0.6×',
            etag: dbEtag,
        });
    } catch (err) { next(err); }
});

// Per-module breakdown — modules live inside database.bin (no separate kv keys
// for module bodies), so size = JSON.stringify of the module + sum of its
// referenced assets. Assets attribution is independent from /characters; an
// asset shared between a character and a module would be counted in both.
app.get('/api/db/stats/modules', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        const raw = kvGet(DB_BLOB_KEY);
        if (!raw) {
            res.json({ modules: [] });
            return;
        }
        const dbObj = await decodeRisuSave(raw);
        const list = Array.isArray(dbObj.modules) ? dbObj.modules : [];

        const assetSize = new Map();
        for (const it of listAssetEntriesWithSizes()) {
            assetSize.set(statsBasename(it.key), it.size);
        }

        const modules = [];
        for (const m of list) {
            if (!m) continue;

            let bodyBytes = 0;
            try {
                const { assets: _drop, ...body } = m;
                bodyBytes = JSON.stringify(body).length;
            } catch { /* skip un-serializable */ }

            let assetBytes = 0;
            const seen = new Set();
            if (Array.isArray(m.assets)) {
                for (const a of m.assets) {
                    const bn = statsBasename(a?.[1]);
                    if (!bn || seen.has(bn)) continue;
                    seen.add(bn);
                    const sz = assetSize.get(bn);
                    if (sz != null) assetBytes += sz;
                }
            }

            modules.push({
                id: m.id || m.namespace || m.name || '',
                name: m.name || m.namespace || '',
                bodyBytes,
                assetBytes,
                totalBytes: bodyBytes + assetBytes,
            });
        }

        modules.sort((a, b) => b.totalBytes - a.totalBytes);
        res.json({ modules, etag: dbEtag });
    } catch (err) { next(err); }
});

app.post('/api/db/optimize', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    try {
        const saveDir = path.join(process.cwd(), 'save');
        const dbFilePath = path.join(saveDir, 'risuai.db');
        const preDbSize = statSafe(dbFilePath)?.size ?? 0;

        const { free } = await diskFreeStat(saveDir);
        if (preDbSize > 0 && free != null && free < preDbSize * 1.2) {
            return res.status(400).json({
                error: 'Insufficient disk space for VACUUM',
                required: Math.ceil(preDbSize * 1.2),
                free,
            });
        }

        // VACUUM cannot run inside another request's transaction, and the orphan
        // sweep would delete rows an in-flight import is still publishing.
        const result = await queueStorageMutation(async () => {
            await flushPendingDb();
            const t0 = Date.now();
            const rawDb = kvGet(DB_BLOB_KEY);
            const strippedDb = rawDb
                ? dbCache[DB_HEX_KEY] || await loadStrippedDatabase(rawDb, 'Optimize')
                : { characters: [] };
            const chatSweep = chatRowStore.sweepOrphanChatRows(strippedDb, {
                graceMs: CHAT_ORPHAN_GRACE_MS,
            });
            logger.info(
                `[Optimize] Chat row sweep deleted ${chatSweep.deleted} orphan row(s); `
                + `skipped ${chatSweep.skippedRecent} recent row(s)`
            );
            // Reclaim chunks orphaned by edits/snapshot rotation before VACUUM, so
            // their pages get compacted in the same pass. Serialized with saves by
            // the surrounding queueStorageOperation.
            let gcDeleted = 0;
            try { gcDeleted = gcChunks(); } catch (e) { logger.warn('[Optimize] chunk gc failed:', e?.message || e); }
            try { checkpointWal('TRUNCATE'); } catch (e) { logger.warn('[Optimize] checkpoint failed:', e?.message || e); }
            sqliteDb.exec('VACUUM');
            // VACUUM streams the whole DB through the WAL; without this checkpoint the
            // -wal file stays inflated until the next 5-min background TRUNCATE.
            try { checkpointWal('TRUNCATE'); } catch (e) { logger.warn('[Optimize] post-VACUUM checkpoint failed:', e?.message || e); }
            const elapsed = Date.now() - t0;
            const postDbSize = statSafe(dbFilePath)?.size ?? 0;
            return {
                ok: true,
                elapsedMs: elapsed,
                preDbSize,
                postDbSize,
                reclaimed: Math.max(0, preDbSize - postDbSize),
                chunksReclaimed: gcDeleted,
                orphanChatRowsDeleted: chatSweep.deleted,
                orphanChatRowsSkippedRecent: chatSweep.skippedRecent,
            };
        });
        res.json(result);
    } catch (err) {
        if (isImportInProgressError(err)) return sendImportBusy(res);
        next(err);
    }
});

app.post('/api/db/wal-checkpoint', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    try {
        const saveDir = path.join(process.cwd(), 'save');
        const walFilePath = path.join(saveDir, 'risuai.db-wal');
        const preWalSize = statSafe(walFilePath)?.size ?? 0;

        // A checkpoint cannot truncate past an import's open transaction.
        const result = await queueStorageMutation(async () => {
            await flushPendingDb();
            const t0 = Date.now();
            checkpointWal('TRUNCATE');
            const elapsed = Date.now() - t0;
            const postWalSize = statSafe(walFilePath)?.size ?? 0;
            return {
                ok: true,
                elapsedMs: elapsed,
                preWalSize,
                postWalSize,
                reclaimed: Math.max(0, preWalSize - postWalSize),
            };
        });
        res.json(result);
    } catch (err) {
        if (isImportInProgressError(err)) return sendImportBusy(res);
        next(err);
    }
});

// ── Snapshot list (database/dbbackup-* keys) ─────────────────────────────────

app.get('/api/db/snapshots/limits', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        const { maxCount, maxBytes } = getSnapshotLimits();
        const usage = snapshotUsage();
        res.json({
            maxCount,
            maxBytes,
            currentCount: usage.count,
            currentBytes: usage.bytes,
            logicalBytes: usage.logicalBytes,
            bounds: {
                minCount: SNAPSHOT_LIMIT_MIN_COUNT,
                maxCount: SNAPSHOT_LIMIT_MAX_COUNT,
                minBytes: SNAPSHOT_LIMIT_MIN_BYTES,
                maxBytes: SNAPSHOT_LIMIT_MAX_BYTES,
            },
            defaults: {
                count: SNAPSHOT_LIMIT_DEFAULT_COUNT,
                bytes: SNAPSHOT_LIMIT_DEFAULT_BYTES,
            },
        });
    } catch (err) { next(err); }
});

app.put('/api/db/snapshots/limits', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    try {
        const rawCount = Number(req.body?.maxCount);
        if (!Number.isFinite(rawCount) || rawCount < SNAPSHOT_LIMIT_MIN_COUNT || rawCount > SNAPSHOT_LIMIT_MAX_COUNT) {
            return res.status(400).json({ error: `maxCount out of range (${SNAPSHOT_LIMIT_MIN_COUNT}-${SNAPSHOT_LIMIT_MAX_COUNT})` });
        }
        const maxCount = Math.floor(rawCount);
        // Hub instances pin the byte cap server-side — only the snapshot count
        // is tenant-tunable, so a crafted request can't grow host disk usage.
        let maxBytes;
        if (HUB_HOSTING_MODE) {
            maxBytes = getSnapshotLimits().maxBytes;
        } else {
            const rawBytes = Number(req.body?.maxBytes);
            if (!Number.isFinite(rawBytes) || rawBytes < SNAPSHOT_LIMIT_MIN_BYTES || rawBytes > SNAPSHOT_LIMIT_MAX_BYTES) {
                return res.status(400).json({ error: `maxBytes out of range` });
            }
            maxBytes = Math.floor(rawBytes);
        }
        const { trim, usage } = await queueStorageMutation(() => {
            if (!HUB_HOSTING_MODE) {
                kvSet(SNAPSHOT_LIMIT_BYTES_KEY, Buffer.from(String(maxBytes), 'utf-8'));
            }
            kvSet(SNAPSHOT_LIMIT_COUNT_KEY, Buffer.from(String(maxCount), 'utf-8'));
            return { trim: trimSnapshotsToLimits(), usage: snapshotUsage() };
        });
        res.json({
            maxCount, maxBytes,
            currentCount: usage.count,
            currentBytes: usage.bytes,
            logicalBytes: usage.logicalBytes,
            removed: trim.removed,
        });
    } catch (err) {
        if (isImportInProgressError(err)) return sendImportBusy(res);
        next(err);
    }
});

app.get('/api/db/snapshots', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        const out = kvList(DB_BACKUP_PREFIX).map((key) => {
            const tsRaw = parseInt(key.slice(DB_BACKUP_PREFIX.length, -4), 10);
            const ts = Number.isFinite(tsRaw) ? tsRaw * 100 : null;
            // Logical size — the full data this snapshot represents (the whole DB),
            // not its marginal on-disk cost. Users expect "this backup = my 53 MB
            // DB"; the dedup win is shown once, as the section's savings figure.
            // (kvSize reassembles via the manifest; the marker's 13 bytes are not
            // what a user wants to see for a full backup.) Trimming still sizes by
            // snapshotFootprint in db.cjs, so this display change can't over-trim.
            return { key, size: kvSize(key) || 0, timestamp: ts };
        }).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
        res.json({ snapshots: out });
    } catch (err) { next(err); }
});

app.delete('/api/db/snapshots', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    try {
        const key = typeof req.query?.key === 'string' ? req.query.key : '';
        // Restrict to snapshot prefix — never let this endpoint touch other kv keys.
        if (!key.startsWith(DB_BACKUP_PREFIX)) {
            return res.status(400).json({ error: 'Invalid snapshot key' });
        }
        await queueStorageMutation(() => kvDel(key));
        res.json({ ok: true });
    } catch (err) {
        if (isImportInProgressError(err)) return sendImportBusy(res);
        next(err);
    }
});

// Restore a snapshot server-side. Supported large snapshots ingest directly
// into chat rows + the stripped live blob; legacy formats retain copy-then-
// ingest. Client-side reload is racy because the patch-sync save loop is
// debounced and the reload can fire before the snapshot data lands on disk.
app.post('/api/db/snapshots/restore', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    try {
        const key = typeof req.body?.key === 'string' ? req.body.key : '';
        if (!key.startsWith(DB_BACKUP_PREFIX)) {
            return res.status(400).json({ error: 'Invalid snapshot key' });
        }
        const blob = kvGet(key);
        if (!blob) {
            return res.status(404).json({ error: 'Snapshot not found' });
        }
        // Acquire before entering the storage queue: acquire() drains that same
        // queue, so holding a slot while waiting for it would deadlock.
        const releaseImportBarrier = await importBarrier.acquire();
        try {
            await queueStorageOperation(async () => {
                // Drain any pending debounced persist first — same pattern as
                // /api/db/optimize. Without this, an in-flight save could land
                // after kvCopyValue and overwrite the restored snapshot.
                await flushPendingDb();
                const inspection = await inspectRisuSaveSource(blob);
                let ingestion;
                if (await shouldStreamRisuSave(blob, { inspection })) {
                    // Avoid copying the snapshot monolith into the live key. The
                    // streaming ingest atomically writes rows + stripped DB instead.
                    kvDel(REMOTE_MIGRATION_MARKER_KEY);
                    invalidateAllDbCaches();
                    ingestion = await ingestDatabaseStreaming(blob, { inspection });
                    markRemoteMigrationDone();
                } else {
                    kvCopyValue(key, DB_BLOB_KEY);
                    // Snapshot may pre-date the remote-block migration. Clear the marker
                    // so migrateRemoteBlocksIfNeeded re-evaluates against the restored
                    // bytes instead of skipping based on the prior post-migration state.
                    kvDel(REMOTE_MIGRATION_MARKER_KEY);
                    invalidateAllDbCaches();
                    const raw = kvGet(DB_BLOB_KEY);
                    if (raw) ingestion = await ingestDatabase(raw);
                }
                if (ingestion) {
                    const strippedBytes = Buffer.from(encodeRisuSaveLegacy(ingestion.strippedDb));
                    dbEtag = computeBufferEtag(strippedBytes);
                }
                // A restore can replace a broad logical database state. Force every
                // browser list cache to take one full snapshot after it completes.
                kvBumpListEpoch();
            });
        } catch (error) {
            try {
                kvBumpListEpoch();
            } catch (epochError) {
                logger.error('[Snapshot Restore] Failed to bump list epoch after restore failure:', epochError);
            }
            throw error;
        } finally {
            releaseImportBarrier();
        }
        res.json({ ok: true });
    } catch (err) { next(err); }
});

// ── Boot-time backup reminder ───────────────────────────────────────────────

const BOOT_REMINDER_KEY = 'config/boot-backup-reminder';

function readBootReminder() {
    try {
        const raw = kvGet(BOOT_REMINDER_KEY);
        if (!raw) return false;
        return Buffer.from(raw).toString('utf-8').trim() === '1';
    } catch { return false; }
}

app.get('/api/backup/boot-reminder', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (HUB_HOSTING_MODE) return res.json({ enabled: false });
    try {
        res.json({ enabled: readBootReminder() });
    } catch (err) { next(err); }
});

app.put('/api/backup/boot-reminder', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    if (HUB_HOSTING_MODE) return res.status(403).json({ error: 'Server backups are disabled on this instance' });
    try {
        const enabled = !!req.body?.enabled;
        await queueStorageMutation(() => {
            kvSet(BOOT_REMINDER_KEY, Buffer.from(enabled ? '1' : '0', 'utf-8'));
        });
        res.json({ enabled });
    } catch (err) {
        if (isImportInProgressError(err)) return sendImportBusy(res);
        next(err);
    }
});

// ── Backup directory configuration ──────────────────────────────────────────

app.get('/api/backup/server/path', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (HUB_HOSTING_MODE) return res.status(403).json({ error: 'Server backups are disabled on this instance' });
    try {
        res.json({
            path: backupsDir,
            default: DEFAULT_BACKUPS_DIR,
            isDefault: backupsDir === DEFAULT_BACKUPS_DIR,
        });
    } catch (err) { next(err); }
});

app.put('/api/backup/server/path', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    if (HUB_HOSTING_MODE) return res.status(403).json({ error: 'Server backups are disabled on this instance' });
    try {
        const next = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
        if (!next) {
            return res.status(400).json({ error: 'Path required' });
        }
        const resolved = path.resolve(next);
        if (isManagedBackupPath(resolved)) {
            return res.status(400).json({
                error: 'Backup path cannot be inside PocketRisu app files. Choose a separate folder such as data/backups.',
            });
        }
        // Ensure parent exists / target is writable. Create the dir if missing.
        try {
            if (!existsSync(resolved)) {
                mkdirSync(resolved, { recursive: true });
            }
            // Probe writability with a tmpfile.
            const probe = path.join(resolved, `.risu-write-probe-${Date.now()}`);
            require('fs').writeFileSync(probe, '');
            require('fs').unlinkSync(probe);
        } catch (e) {
            return res.status(400).json({ error: 'Path is not writable: ' + (e?.message || String(e)) });
        }
        const previous = backupsDir;
        await queueStorageMutation(() => {
            kvSet(BACKUP_PATH_CONFIG_KEY, Buffer.from(resolved, 'utf-8'));
        });
        backupsDir = resolved;
        writeBackupPathMarker(resolved);
        res.json({
            path: backupsDir,
            previous,
            default: DEFAULT_BACKUPS_DIR,
            isDefault: backupsDir === DEFAULT_BACKUPS_DIR,
        });
    } catch (err) {
        if (isImportInProgressError(err)) return sendImportBusy(res);
        next(err);
    }
});

// ── Inlay bulk compression endpoint ──────────────────────────────────────────
const COMPRESS_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp']);

app.post('/api/inlays/compress', sessionAuthMiddleware, async (req, res) => {
    if (!checkActiveSession(req, res)) return;
    // Rewrites inlay files an in-flight import is about to replace wholesale.
    if (importBarrier.isHeld()) {
        res.setHeader('Retry-After', '5');
        return res.status(503).json({
            error: 'An import is in progress; retry compression after it completes',
            code: 'IMPORT_IN_PROGRESS',
            retryable: true,
        });
    }
    const quality = typeof req.body?.quality === 'number' ? req.body.quality : 85;

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });

    const send = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
        const files = await listInlayFiles();
        const imageFiles = [];

        for (const entry of files) {
            if (!COMPRESS_IMAGE_EXTS.has(entry.ext)) continue;
            const sidecar = await readInlaySidecar(entry.id);
            if (sidecar && sidecar.type !== 'image') continue;
            imageFiles.push(entry);
        }

        const total = imageFiles.length;
        let compressed = 0;
        let skipped = 0;
        let totalSaved = 0;

        const vips = await getVips()

        for (let i = 0; i < imageFiles.length; i++) {
            const entry = imageFiles[i];
            try {
                const original = await fs.readFile(entry.filePath);
                const img = vips.Image.newFromBuffer(original)
                let webpBuf
                try {
                    const out = img.writeToBuffer('.webp', { Q: quality })
                    webpBuf = Buffer.from(out);
                } finally {
                    img.delete()
                }

                if (webpBuf.length < original.length) {
                    const sidecar = await readInlaySidecar(entry.id);
                    const info = sidecar || {};
                    await writeInlayFile(entry.id, 'webp', webpBuf, { ...info, ext: 'webp' });
                    // invalidate thumbnail cache
                    await queueStorageMutation(() => kvDel(`inlay_thumb/${entry.id}`));
                    const saved = original.length - webpBuf.length;
                    totalSaved += saved;
                    compressed++;
                } else {
                    skipped++;
                }
            } catch (entryError) {
                // An import that claimed the barrier mid-run must stop the sweep,
                // not be counted as a per-image skip: the remaining files are
                // about to be replaced anyway.
                if (isImportInProgressError(entryError)) {
                    send({
                        type: 'error',
                        message: 'An import started; compression stopped. Retry after it completes.',
                    });
                    res.end();
                    return;
                }
                skipped++;
            }

            send({ type: 'progress', current: i + 1, total, compressed, skipped, totalSaved });
        }

        send({ type: 'done', total, compressed, skipped, totalSaved });
    } catch (err) {
        send({ type: 'error', message: err?.message || 'Unknown error' });
    }

    res.end();
});

// ── Public stats proxy ───────────────────────────────────────────────────────
app.get('/api/public-stats', async (req, res) => {
    try {
        const r = await fetch(PUBLIC_STATS_URL);
        if (!r.ok) { res.status(r.status).json({ error: 'upstream error' }); return; }
        const data = await r.json();
        res.json(data);
    } catch {
        res.status(502).json({ error: 'fetch failed' });
    }
});

// ── Update check endpoint ────────────────────────────────────────────────────
app.get('/api/update-check', async (req, res) => {
    const currentVersion = getCurrentVersion();
    if (UPDATE_CHECK_DISABLED) {
        res.json({ currentVersion, hasUpdate: false, severity: 'none', disabled: true, deploymentType, canSelfUpdate: false });
        return;
    }
    const result = await fetchLatestRelease(req.query.lang);
    const response = result || { currentVersion, hasUpdate: false, severity: 'none' };
    response.deploymentType = deploymentType;
    response.canSelfUpdate = deploymentType === 'portable'
        && !!response.hasUpdate
        && !response.manualOnly
        && !!getSelfUpdateAssetInfo(response.latestVersion);
    res.json(response);
});

// ── Self-update endpoint (portable only) ─────────────────────────────────────
let selfUpdateInProgress = false;

app.post('/api/self-update', async (req, res) => {
    if (!await checkAuth(req, res)) return;

    if (deploymentType !== 'portable') {
        res.status(400).json({ error: 'Self-update is only available for portable deployments' });
        return;
    }
    if (selfUpdateInProgress) {
        res.status(409).json({ error: 'Update already in progress' });
        return;
    }
    selfUpdateInProgress = true;

    // Track client disconnect — used to abort download, but NOT to release the lock.
    // The lock stays held until the update fully completes or fails, preventing
    // a second request from touching the same install directory concurrently.
    let clientDisconnected = false;
    res.on('close', () => {
        clientDisconnected = true;
        console.log('[Update] Client disconnected (update continues if past download stage).');
    });

    // NDJSON streaming response
    res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
    });
    const send = (step, progress, message) => {
        try { res.write(JSON.stringify({ step, progress, message }) + '\n'); } catch {}
    };

    let tmpDir = null;
    try {
        // 1. Check update
        send('checking', 0, 'Checking for updates...');
        const updateInfo = await fetchLatestRelease();
        if (!updateInfo?.hasUpdate) {
            send('done', 100, 'Already up to date.');
            res.end();
            selfUpdateInProgress = false;
            return;
        }

        const targetVersion = updateInfo.latestVersion;
        const assetInfo = getSelfUpdateAssetInfo(targetVersion);
        if (!assetInfo) {
            throw new Error(`No release asset for ${process.platform}-${process.arch}`);
        }

        // 2. Download
        tmpDir = path.join(os.tmpdir(), `risu-update-${Date.now()}`);
        await fs.mkdir(tmpDir, { recursive: true });
        const archivePath = path.join(tmpDir, assetInfo.filename);

        send('downloading', 0, 'Starting download...');
        const dlRes = await fetch(assetInfo.url, { redirect: 'follow' });
        if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status} ${dlRes.statusText}`);

        const totalSize = parseInt(dlRes.headers.get('content-length'), 10) || 0;
        const fileStream = require('fs').createWriteStream(archivePath);
        let downloaded = 0;
        let lastPct = -1;

        const progress = new Transform({
            transform(chunk, _enc, cb) {
                if (clientDisconnected) { cb(new Error('Client disconnected')); return; }
                downloaded += chunk.length;
                if (totalSize > 0) {
                    const pct = Math.round((downloaded / totalSize) * 100);
                    if (pct >= lastPct + 5) {
                        lastPct = pct;
                        const dlMB = (downloaded / 1048576).toFixed(0);
                        const totalMB = (totalSize / 1048576).toFixed(0);
                        send('downloading', pct, `Downloading... ${pct}% (${dlMB}/${totalMB} MB)`);
                    }
                }
                cb(null, chunk);
            },
        });
        await pipeline(Readable.fromWeb(dlRes.body), progress, fileStream);
        send('downloading', 100, 'Download complete.');

        // 3. Extract
        send('extracting', null, 'Extracting...');
        const extractDir = path.join(tmpDir, 'extracted');
        await fs.mkdir(extractDir, { recursive: true });

        if (process.platform === 'win32') {
            try {
                // Windows 10 1803+ has tar.exe built-in, handles zip, much faster than PowerShell
                execSync(`tar -xf "${archivePath}" -C "${extractDir}"`, { timeout: 300000 });
            } catch {
                execSync(
                    `powershell -NoProfile -Command "Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${extractDir}'"`,
                    { timeout: 300000 },
                );
            }
        } else {
            execSync(`tar -xzf "${archivePath}" -C "${extractDir}"`, { timeout: 300000 });
        }

        // Resolve possibly nested root directory (same as updater.cjs resolveExtractedRoot)
        const entries = await fs.readdir(extractDir);
        let sourceDir = extractDir;
        if (entries.length === 1) {
            const candidate = path.join(extractDir, entries[0]);
            if ((await fs.stat(candidate)).isDirectory()) sourceDir = candidate;
        }

        // 4. Validate extracted package (mirrors updater.cjs validateExtractedRoot)
        const REQUIRED_ENTRIES = ['dist', 'server', 'package.json'];
        const REQUIRED_DIST_FILES = ['index.html'];
        for (const entry of REQUIRED_ENTRIES) {
            try { await fs.access(path.join(sourceDir, entry)); }
            catch { throw new Error(`Downloaded package is missing required entry: ${entry}`); }
        }
        for (const file of REQUIRED_DIST_FILES) {
            try { await fs.access(path.join(sourceDir, 'dist', file)); }
            catch { throw new Error(`Downloaded package is missing dist/${file}`); }
        }
        if (process.platform === 'win32') {
            try { await fs.access(path.join(sourceDir, 'bin')); }
            catch { throw new Error('Downloaded Windows package is missing bin/'); }
        }

        // 5. Replace files (follows updater.cjs Phase 1-4 pattern)
        send('replacing', null, 'Replacing files...');
        const appDir = process.cwd();
        const isWin = process.platform === 'win32';
        const updateTmp = path.join(appDir, '.update-tmp');

        // Restore from a previous interrupted update if leftover exists
        const prevBackup = path.join(updateTmp, 'backup');
        try {
            await fs.access(prevBackup);
            console.log('[Update] Restoring files from previous interrupted update...');
            await restoreBackup(prevBackup, appDir);
        } catch { /* no leftover */ }
        await fs.rm(updateTmp, { recursive: true, force: true }).catch(() => {});
        await fs.mkdir(updateTmp, { recursive: true });

        // Carry over SSL certificates into new package before swap
        const sslSrc = path.join(appDir, 'server', 'node', 'ssl', 'certificate');
        try {
            await fs.access(sslSrc);
            const sslDst = path.join(sourceDir, 'server', 'node', 'ssl', 'certificate');
            await fs.mkdir(path.dirname(sslDst), { recursive: true });
            await fs.cp(sslSrc, sslDst, { recursive: true });
        } catch { /* no user certs */ }

        // Keep set — matches updater.cjs + user data/config that must survive updates
        const keep = new Set(['save', 'backups', '.installed-version', '.update-tmp', 'scripts', '.env', '.npmrc', '.portable']);
        if (isWin) keep.add('bin');
        for (const [markerPath, label] of [
            [BACKUP_PATH_MARKER, 'Server-backup directory'],
            [CHAT_BACKUP_PATH_MARKER, 'Chat-backup directory'],
        ]) {
            const customKeep = updaterKeepEntryFromMarker(markerPath, label);
            if (customKeep) keep.add(customKeep);
        }

        // Phase 1: move old files to backup — rollback immediately on any failure
        const backupDir = path.join(updateTmp, 'backup');
        await fs.mkdir(backupDir, { recursive: true });

        const oldEntries = await fs.readdir(appDir);
        for (const e of oldEntries) {
            if (keep.has(e)) continue;
            try {
                await fs.rename(path.join(appDir, e), path.join(backupDir, e));
            } catch (backupErr) {
                logger.error(`[Update] Failed to back up ${e}: ${backupErr.message}`);
                console.log('[Update] Restoring files already moved to backup...');
                await restoreBackup(backupDir, appDir);
                throw new Error(isWin
                    ? 'Update failed: some files are in use. Close RisuAI first, then try again.'
                    : 'Update failed: some files are in use. Stop the server first, then try again.');
            }
        }

        // Phase 2: move new files from extracted to app root
        const skipMove = new Set(['save', 'scripts']);
        if (isWin) skipMove.add('bin');
        const moved = [];
        try {
            const newEntries = await fs.readdir(sourceDir);
            for (const e of newEntries) {
                if (skipMove.has(e)) continue;
                const dest = path.join(appDir, e);
                await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
                await moveAcrossVolumes(path.join(sourceDir, e), dest);
                moved.push(e);
            }
            // Post-move validation
            for (const entry of REQUIRED_ENTRIES) {
                if (!moved.includes(entry) && !existsSync(path.join(appDir, entry))) {
                    throw new Error(`Required entry was not installed: ${entry}`);
                }
            }
            for (const file of REQUIRED_DIST_FILES) {
                if (!existsSync(path.join(appDir, 'dist', file))) {
                    throw new Error(`Required file was not installed: dist/${file}`);
                }
            }
        } catch (moveErr) {
            logger.error(`[Update] Move failed: ${moveErr.message}`);
            console.log('[Update] Restoring from backup...');
            await restoreBackup(backupDir, appDir);
            throw new Error('Update failed, previous version restored. Please try again.');
        }

        // Phase 3: update scripts/ from new release
        const newScripts = path.join(sourceDir, 'scripts');
        try {
            await fs.access(newScripts);
            await fs.mkdir(path.join(appDir, 'scripts'), { recursive: true });
            for (const f of await fs.readdir(newScripts)) {
                await fs.copyFile(path.join(newScripts, f), path.join(appDir, 'scripts', f));
            }
        } catch { /* no scripts in release */ }

        // Phase 4 (Windows): stage bin/ for restart script to apply after exit
        if (isWin) {
            const newBin = path.join(sourceDir, 'bin');
            const stagedBin = path.join(updateTmp, 'new-bin');
            await fs.rm(stagedBin, { recursive: true, force: true }).catch(() => {});
            await fs.cp(newBin, stagedBin, { recursive: true });
            // Version marker — finalized after bin/ is applied
            await fs.writeFile(path.join(updateTmp, 'latest-version'), `v${targetVersion}`);
        } else {
            await fs.writeFile(path.join(appDir, '.installed-version'), `v${targetVersion}`);
        }

        // Cleanup temp download (not .update-tmp — that stays on Windows for bin/ post-step)
        fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        tmpDir = null;
        if (!isWin) {
            fs.rm(updateTmp, { recursive: true, force: true }).catch(() => {});
        }

        send('restarting', 100, 'Update complete. Restarting...');
        res.end();

        // 6. Flush DB and restart
        setTimeout(async () => {
            try {
            console.log(`[Update] Self-update to v${targetVersion} complete. Restarting...`);
            try { await flushPendingDb(); } catch {}
            try { checkpointWal('TRUNCATE'); } catch {}

            const port = process.env.PORT || 6001;

            if (isWin) {
                // Windows: use a .bat script to apply bin/, finalize version, and restart.
                // A bat script can replace bin/node.exe after the Node process exits,
                // avoiding file-lock issues that a Node child process would hit.
                const batScript = path.join(os.tmpdir(), `risu-restart-${Date.now()}.bat`);
                const utmp = path.join(appDir, '.update-tmp');
                const binDir = path.join(appDir, 'bin');
                const binBackup = path.join(utmp, 'old-bin');
                const batLines = [
                    '@echo off',
                    'timeout /t 3 /nobreak >nul',
                    // Apply staged bin/: backup current → copy new → on failure restore backup
                    `if exist "${path.join(utmp, 'new-bin')}\\" (`,
                    `  if exist "${binDir}\\" (`,
                    `    xcopy /E /I /Y "${binDir}\\*" "${binBackup}\\" >nul`,
                    `  )`,
                    `  xcopy /E /I /Y "${path.join(utmp, 'new-bin')}\\*" "${binDir}\\" >nul`,
                    `  if errorlevel 1 (`,
                    `    echo [Update] bin/ copy failed, restoring backup...`,
                    `    if exist "${binBackup}\\" (`,
                    `      xcopy /E /I /Y "${binBackup}\\*" "${binDir}\\" >nul`,
                    `    )`,
                    `    echo [Update] bin/ restored. Staged files kept for retry.`,
                    `    goto start`,
                    `  )`,
                    `)`,
                    // Finalize version marker only after successful bin/ copy
                    `if exist "${path.join(utmp, 'latest-version')}" (`,
                    `  copy /Y "${path.join(utmp, 'latest-version')}" "${path.join(appDir, '.installed-version')}" >nul`,
                    `)`,
                    // Cleanup .update-tmp (includes old-bin backup)
                    `rmdir /s /q "${utmp}" 2>nul`,
                    ':start',
                    // Start server with correct working directory
                    `cd /d "${appDir}"`,
                    `start "" "${path.join(appDir, 'bin', 'node.exe')}" "${path.join(appDir, 'server', 'node', 'server.cjs')}"`,
                    'exit /b 0',
                ];
                writeFileSync(batScript, batLines.join('\r\n'));
                spawn('cmd.exe', ['/c', batScript], { detached: true, stdio: 'ignore' }).unref();
            } else {
                // Unix: Node restart helper with port-check to avoid clashing with process managers
                const restartScript = path.join(os.tmpdir(), `risu-restart-${Date.now()}.cjs`);
                writeFileSync(restartScript, [
                    `const net = require('net');`,
                    `const { spawn } = require('child_process');`,
                    `setTimeout(() => {`,
                    `  const s = net.createServer();`,
                    `  s.once('error', () => process.exit(0));`,
                    `  s.once('listening', () => {`,
                    `    s.close();`,
                    `    spawn(${JSON.stringify(process.execPath)}, ['server/node/server.cjs'], {`,
                    `      cwd: ${JSON.stringify(appDir)},`,
                    `      detached: true,`,
                    `      stdio: 'inherit',`,
                    `      env: Object.assign({}, process.env),`,
                    `    }).unref();`,
                    `    setTimeout(() => process.exit(0), 500);`,
                    `  });`,
                    `  s.listen(${Number(port)});`,
                    `}, 3000);`,
                ].join('\n'));
                spawn(process.execPath, [restartScript], { detached: true, stdio: 'ignore' }).unref();
            }
            process.exit(0);
            } catch (restartErr) {
                logger.error('[Update] Restart failed:', restartErr);
                selfUpdateInProgress = false;
            }
        }, 500);

    } catch (e) {
        logger.error('[Update] Self-update failed:', e);
        send('error', null, `Update failed: ${e.message}`);
        res.end();
        selfUpdateInProgress = false;
        if (tmpDir) fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
});

// Helper: rename, falling back to copy+remove when src and dest are on
// different volumes (Windows EXDEV — e.g. app on D:, os.tmpdir() on C:)
async function moveAcrossVolumes(src, dest) {
    try {
        await fs.rename(src, dest);
    } catch (err) {
        if (err && err.code === 'EXDEV') {
            await fs.cp(src, dest, { recursive: true, force: true });
            await fs.rm(src, { recursive: true, force: true });
            return;
        }
        throw err;
    }
}

// Helper: restore files from backup directory into app root (mirrors updater.cjs restoreBackupIntoRoot)
async function restoreBackup(backupDir, rootDir) {
    try { await fs.access(backupDir); } catch { return; }
    for (const entry of await fs.readdir(backupDir)) {
        const src = path.join(backupDir, entry);
        const dest = path.join(rootDir, entry);
        try {
            await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
            await moveAcrossVolumes(src, dest);
        } catch { /* best effort */ }
    }
}

// ─── Express error middleware — must be registered after all routes ─────────
app.use(expressErrorMiddleware);
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(500).json({ error: err?.message || 'internal server error' });
});

// ─────────────────────────────────────────────────────────────────────────────

async function getHttpsOptions() {

    const keyPath = path.join(sslPath, 'server.key');
    const certPath = path.join(sslPath, 'server.crt');

    try {
 
        await fs.access(keyPath);
        await fs.access(certPath);

        const [key, cert] = await Promise.all([
            fs.readFile(keyPath),
            fs.readFile(certPath)
        ]);
       
        return { key, cert };

    } catch (error) {
        if (error.code === 'ENOENT') {
            logger.info('[Server] No SSL certificate found, starting with HTTP');
        } else {
            logger.error('[Server] SSL setup errors:', error.message);
            console.log('[Server] Start the server with HTTP instead of HTTPS...');
        }
        return null;
    }
}

async function startServer() {
    try {
        recoverPendingImportSwap('Startup');
        kvBumpListEpoch();
        logger.info('[ListDelta] Bumped list epoch at startup');
        migrateAssetsToFilesystem();
        await migrateInlaysToFilesystem();
        await migrateChatsToRowsIfNeeded();
        // The chat marker can already exist on databases restored by older
        // Node-only versions, so independently inspect the steady-state stub
        // for folded optimized plugin storage before accepting clients.
        const bootDatabase = kvGet('database/database.bin');
        if (bootDatabase) await loadStrippedDatabase(bootDatabase, 'Migration');
        await migrateRemoteBlocksIfNeeded();
        const port = process.env.PORT || 6001;
        // HOST limits the bind address (e.g. 127.0.0.1 behind a reverse
        // proxy). Unset keeps the historical all-interfaces behavior.
        const host = process.env.HOST || undefined;
        const httpsOptions = await getHttpsOptions();
        let server;

        if (httpsOptions) {
            // HTTPS
            server = https.createServer(httpsOptions, app);
            setupProxyStreamWebSocket(server);
            server.listen(port, host, () => {
                console.log("[Server] HTTPS server is running.");
                console.log(`[Server] https://${host || 'localhost'}:${port}/`);
            });
        } else {
            // HTTP
            server = http.createServer(app);
            setupProxyStreamWebSocket(server);
            server.listen(port, host, () => {
                console.log("[Server] HTTP server is running.");
                console.log(`[Server] http://${host || 'localhost'}:${port}/`);
            });
        }
    } catch (error) {
        logger.error('[Server] Failed to start server :', error);
        process.exit(1);
    }
}

// Graceful shutdown: flush pending patches and checkpoint WAL before exit
for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, async () => {
        console.log(`[Server] Received ${sig}, flushing pending data...`);
        try { await flushPendingDb(); } catch (e) { logger.error('[Server] Flush error:', e); }
        try { checkpointWal('TRUNCATE'); } catch { /* non-fatal */ }
        process.exit(0);
    });
}

(async () => {
    try { kvCleanupOldDeletions(); }
    catch (error) { logger.warn('[ListDelta] Initial deletion cleanup failed:', error?.message || error); }

    // Proxy stream job garbage collection
    setInterval(() => {
        const now = Date.now();
        for (const [jobId, job] of proxyStreamJobs.entries()) {
            if (!job.done && now >= job.deadlineAt && !job.abortController.signal.aborted) {
                job.abortController.abort();
            }
            if (job.done && job.clients.size === 0 && job.cleanupAt > 0 && now >= job.cleanupAt) {
                cleanupJob(jobId);
                continue;
            }
            if (!job.done && now - job.updatedAt > Math.max(PROXY_STREAM_DEFAULT_TIMEOUT_MS, job.timeoutMs * 2)) {
                cleanupJob(jobId);
            }
        }
    }, PROXY_STREAM_GC_INTERVAL_MS);

    await startServer();

    chatBackupStore.reconcileChatBackups()
        .then((result) => {
            logger.info(
                `[ChatBackups] Startup reconcile complete: `
                + `${result.gzipped} gzip, ${result.bundlesCreated} bundle, `
                + `${result.budgetItemsRemoved} budget eviction(s)`
            );
        })
        .catch(error => logger.error('[ChatBackups] Startup reconcile failed:', error));

    // Periodically checkpoint WAL to reclaim disk space.
    // TRUNCATE (vs RESTART) shrinks the -wal file on disk, not just the writer
    // pointer — required for journal_size_limit to actually take effect.
    setInterval(() => {
        try { checkpointWal('TRUNCATE'); }
        catch { /* non-fatal */ }
    }, 5 * 60 * 1000); // every 5 minutes

    setInterval(() => {
        try { kvCleanupOldDeletions(); }
        catch { /* non-fatal */ }
    }, 60 * 60 * 1000); // every hour

})();
