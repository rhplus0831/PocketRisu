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
    renameSync,
    writeFileSync,
    readdirSync,
    unlinkSync,
    openSync,
    closeSync,
    fsyncSync,
    createReadStream,
    createWriteStream,
} = fsSync;
const fs = require('fs/promises')
const nodeCrypto = require('crypto')
const { createSessionLock } = require('./session-lock.cjs')
const zlib = require('zlib')
const v8 = require('v8')
const rateLimit = require('express-rate-limit')
const { WebSocketServer } = require('ws')
const { fetch: undiciFetch } = require('undici')
const WRITER_EPOCH_HEADER = 'x-writer-epoch'
const sessionLock = createSessionLock()
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
const { kvGet, kvGetAsync, kvWriteToFile, kvSet, kvSetFromFile, kvDel, kvList,
        kvDelPrefix, kvListWithSizes, kvListSelectedWithSizes, kvSize, kvGetUpdatedAt, kvGetDatabaseRevision, kvGetPluginStoragePublicationRevision, kvCopyValue, clearEntities, checkpointWal,
        kvClearDeletion, kvRecordDeletion, kvListModifiedSince, kvGetDeletedSince, kvCleanupOldDeletions,
        kvGetListEpoch, kvBumpListEpoch,
        gcChunks, reclaimableChunkBytes, isDbBlobChunked, snapshotFootprints, createKvSnapshot,
        kvGetSnapshotSourceToken,
        rebuildPluginStorageViewerFacets, reconcilePluginStorageUsage,
        getPluginStorageMutationVersion, withPluginStorageQuotaPlan,
        isLegacyHexMigrationComplete, markLegacyHexMigrationComplete,
        publishLegacyHexMigrationMarker,
        db: sqliteDb } = require('./db.cjs');
const { CHUNK_MARKER } = require('./chunkStore.cjs');
const { buildListResponse } = require('./listDelta.cjs');
const {
    assetDir,
    migrationMarkerPath: assetMigrationMarker,
    legacyHashIdentityMarkerPath,
    createAssetStore,
    ensureAssetDir,
    isSafeAssetName,
    portableAssetNameKey,
    isPortableAssetName,
    assetPathFor,
    isLegacyHashAsset,
    markLegacyHashAsset,
    clearLegacyHashAsset,
    reconcileLegacyHashAssetIdentity,
    writeAssetFile,
    writeAssetFileIfChanged,
    writeAssetFileFromFile,
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
    collectReferencedAssetKeys,
    createAssetGcCandidateStore,
    planAssetGc,
} = require('./assetGc.cjs');
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
const { createRequestLogs } = require('./request-logs.cjs');
const { createRequestTracer, isRequestTracingEnabled } = require('./request-trace.cjs');
const { applyPatchAtomic } = require('./atomicJsonPatch.cjs');
const { createGenerationMemo } = require('./generationMemo.cjs');
const { openStageRowDownload } = require('./stageRowDownload.cjs');
const { createRevisionBoundCache } = require('./revisionBoundCache.cjs');
const { createPluginStorageManifestCache } = require('./pluginStorageManifestCache.cjs');
const {
    DbCachePersistenceGuardError,
    commitPreparedDbCachePersistence,
    findStubFlagLossChats,
    persistDbCacheGenerationSync,
    prepareDbCachePersistence,
    runEmergencyDbFlush,
} = require('./dbCachePersistence.cjs');
const {
    decodeRisuSave,
    decodeAuthoritativeRisuSave,
    encodeRisuSaveLegacy,
    calculateHash,
    normalizeJSON,
    hasRemoteBlocks,
    magicHeader,
    magicRisuSaveHeader,
    parseCachedHashesHeader,
    sha256Hex,
} = require('./utils.cjs');
const {
    computeBufferEtag,
    parseDbCacheInventory,
    prepareDatabaseReadPayload,
    encodeCachedDbReadEnvelope,
    createDatabaseSegmentMemo,
} = require('./dbCachedRead.cjs');
const {
    createChatRowStore,
    chatRowKey,
    parseChatRowKey,
    hasChatPayloads,
    isCanonicalRawChatRow,
    findDuplicateChaIds,
    findDuplicateChatIds,
    validateDatabaseShape,
} = require('./chatRows.cjs');
const {
    CHARACTER_DEFAULTS_MARKER_KEY,
    CHARACTER_DEFAULTS_MARKER_VALUE,
    applyDatabaseCharacterDefaults,
} = require('./characterDefaults.cjs');
const {
    CHAT_DELTA_CONTENT_TYPE,
    ChatDeltaValidationError,
} = require('./chatDelta.cjs');
const { streamRisuSaveToFile } = require('./streamRisuSave.cjs');
const {
    MCP_TOOL_CALL_CACHE_PREFIX,
    mcpToolCallStorageKey,
    parseMcpToolCallSnapshotKey,
    parseMcpToolCallStorageKey,
    scanMcpToolCallIdsFromFile,
} = require('./mcpToolCallRecovery.cjs');
const { validateJsonSource } = require('./streamJsonToMsgpack.cjs');
const {
    pluginStorageViewerDisplaySize,
    pluginStorageViewerDisplaySizeFromMetadata,
    pluginStorageViewerValueText,
} = require('./pluginStorageViewerFacets.cjs');
const {
    convertBlockRisuSaveToMessagePack,
    readBlockRisuSaveTopLevelFields,
    streamBackupRisuSaveToFile,
} = require('./streamBackupRisuSave.cjs');
const {
    RisuSavePreparationError,
    configuredMaxDecodedBytes,
    decodeBoundedLegacyRisuSave,
    inspectRisuSaveSource,
    readRisuSaveTopLevelFields,
    shouldStreamRisuSave,
    walkRisuSave,
} = require('./streamRisuLoad.cjs');

async function readBackupRisuSaveTopLevelFields(input, requestedKeys, options = {}) {
    const inspection = await inspectRisuSaveSource(input);
    if (inspection.format === 'risusave') {
        return readBlockRisuSaveTopLevelFields(input, requestedKeys, options);
    }
    return readRisuSaveTopLevelFields(input, requestedKeys, {
        ...options,
        inspection,
    });
}

function risuSavePreparationRefusal(error) {
    if (error?.risuSavePreparationLimit === true) {
        return {
            status: error.status ?? 413,
            body: {
                error: error.message,
                code: error.code,
                limit: error.limit,
                actual: error.actual,
                retryable: false,
                commitOutcome: 'not-committed',
                commitOutcomeUnknown: false,
            },
        };
    }
    return null;
}
const {
    IMPORT_IO_PAGE_BYTES,
    SAVE_FOLDER_IMPORT_STAGE_PREFIX,
    ImportIngressError,
    finiteByteLimit,
    importSizeError,
    importFormatError,
    importErrorPayload,
    assertImportSize,
    throwIfAborted: throwIfImportAborted,
    createImportAbortTracker,
    spoolAsyncIterable,
    copyFileToSpool,
    readFileToBufferBounded,
    validateJsonFileStreaming,
    inspectZipFile,
    extractZipEntries,
} = require('./importSpool.cjs');
const {
    assertProxyTargetAllowed,
    isProxyTargetBlockedError,
    resolveHubProxyTarget,
} = require('./proxyTarget.cjs');
const {
    BACKUP_ENTRY_NAME_MAX_BYTES,
    PLUGIN_SAVE_PREFIX,
    PLUGIN_SAVE_META_PREFIX,
    PLUGIN_STORAGE_FOLDED_MARKER,
    assertArchiveSafePluginSaveStorageKey,
    PLUGIN_STORAGE_GENERATION_FIELD,
    PLUGIN_STORAGE_MANIFEST_KEY,
    createPluginStorageManifest,
    parsePluginStorageManifest,
    decodePluginSaveStorageKey,
    decodeManifestPluginSaveStorageKey,
    encodePluginSaveStorageKey,
    isHashedPluginSaveStorageKey,
    mergePluginStorageKeyMappings,
    pluginSaveStorageKeyMappingComponent,
    pluginStorageManifestMappingMap,
} = require('./pluginSaveKeys.cjs');
const {
    assertBackupEntryNameWithinLimit,
    encodeBackupEntryHeader,
    backupEntrySize,
    preflightBackupEntries,
} = require('./backupEntryFormat.cjs');
const { createBackupImportIndex } = require('./backupImportIndex.cjs');
const {
    PluginStorageValidationError,
    PLUGIN_STORAGE_JSON_CODEC,
    PLUGIN_STORAGE_LOSSLESS_CODEC,
    PLUGIN_STORAGE_LOSSLESS_MAGIC,
    assertPluginStorageRow,
    convertCompatiblePluginStorageJson,
    createPluginStorageOwnerScanner,
    decodeValidatedPluginStorageKey,
    encodeValidatedPluginStorageKey,
    isPluginStorageValidationError,
    parsePluginStorageJsonBuffer,
    pluginStorageCodecForBuffer,
    serializeLosslessPluginStorageRow,
    serializePluginStorageRow,
    snapshotPluginStorageRecord,
    validatePluginStorageRow,
} = require('./pluginStorageJson.cjs');
const {
    PLUGIN_VALUE_MAX_BYTES,
    PLUGIN_STORAGE_MAX_BYTES,
    PluginStorageLimitError,
} = require('./pluginStorageLimits.cjs');
const {
    BUFFERED_INGRESS_POLICY,
    createBufferedIngressLimits,
    createInFlightByteBudget,
    createRoutePolicyResolver,
    createBufferedIngressMiddleware,
    isStreamedIngress,
    sendClientUpgradeRequired,
} = require('./bufferedIngress.cjs');
const {
    ADMITTED_INGRESS_SPOOL,
    ADMITTED_INGRESS_SPOOL_PREFIX,
    ADMITTED_WRITE_STAGE_PREFIX,
    createAdmittedIngressSpoolMiddleware,
    disposeAdmittedIngressSpool,
    isAdmittedSpoolPressureError,
    sendRetryableSpoolRefusal,
} = require('./admittedIngressSpool.cjs');
const { prepareFileChunkPlan } = require('./chunkPlan.cjs');
const { readClientBuildStamp } = require('./buildStamp.cjs');
const {
    CHAT_BACKUP_DIRNAME,
    createChatBackupStore,
    migrateLegacyChatBackups,
    resolveChatBackupDir,
    resolveChatBackupMaxBytes,
    resolveChatBackupMaxUncompressedBytes,
    isDestructiveBackupReason,
} = require('./chatBackups.cjs');
const { spawn, execSync } = require('child_process');
const os = require('os');
const { Readable, Transform } = require('stream');
const { addExtension, Unpackr } = require('msgpackr');

function fatalFlushPendingDatabase() {
    try {
        return runEmergencyDbFlush({
            log: message => console.error(message),
            isImportInProgress: () => importInProgress || importBarrier.isHeld(),
            isInTransaction: () => sqliteDb.inTransaction,
            hasPendingWork: () => Boolean(
                saveTimers[DB_HEX_KEY] || dbPersistRetryPending
            ),
            peekCachedDb: () => peekDbCacheValue(DB_HEX_KEY),
            getCacheMetadata: () => dbCache.metadata(DB_HEX_KEY),
            kvGetDatabaseRevision,
            persist: ({ cachedDb, cacheMetadata }) => persistDbCacheGenerationSync({
                ...dbCachePersistenceOptions({
                    filePath: DB_HEX_KEY,
                    decodedKey: DB_BLOB_KEY,
                    generation: dbDerivedValueMemo.generation(DB_HEX_KEY),
                    cachedDb,
                    cacheMetadata,
                }),
                chatRowsToDelete: [],
            }),
        });
    } catch (error) {
        try {
            console.error(
                `[FatalFlush] failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        } catch {}
        return { status: 'failed', error };
    }
}

// Install process-level error handlers before any other init so early crashes get logged.
installProcessHandlers({ onFatalExit: fatalFlushPendingDatabase });
const expectedClientBuild = readClientBuildStamp({ log: logger });
if (expectedClientBuild) {
    logger.info(
        `[Build] Client build admission enabled for ${expectedClientBuild.version} (${expectedClientBuild.stamp})`,
    );
}

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
const HOSTED_PROXY_STREAM_BLOCKED_ERROR = 'PROXY_TARGET_BLOCKED: Local proxy stream jobs are disabled in hosted mode';
const ASSET_GC_DEFAULT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const ASSET_GC_DEFAULT_START_DELAY_MS = 30 * 1000;
const ASSET_GC_DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

function nonNegativeDurationEnv(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const ASSET_GC_GRACE_MS = nonNegativeDurationEnv(
    'POCKETRISU_ASSET_GC_GRACE_MS',
    ASSET_GC_DEFAULT_GRACE_MS,
);
const ASSET_GC_START_DELAY_MS = nonNegativeDurationEnv(
    'POCKETRISU_ASSET_GC_START_DELAY_MS',
    ASSET_GC_DEFAULT_START_DELAY_MS,
);
const ASSET_GC_INTERVAL_MS = Math.max(1_000, nonNegativeDurationEnv(
    'POCKETRISU_ASSET_GC_INTERVAL_MS',
    ASSET_GC_DEFAULT_INTERVAL_MS,
));
const ASSET_GC_AUTO_ENABLED = process.env.POCKETRISU_ASSET_GC_AUTO === '1'
    || (process.env.NODE_ENV !== 'test' && process.env.POCKETRISU_ASSET_GC_AUTO !== '0');
const assetGcCandidateStore = createAssetGcCandidateStore(sqliteDb);

function proxyTargetBlockedReason(error) {
    if (error?.code === 'PROXY_TARGET_BLOCKED' && typeof error.message === 'string') {
        return error.message;
    }
    return 'Internal or non-public proxy targets are not allowed';
}

function handleProxyTargetBlocked(res, logPrefix, error) {
    if (!isProxyTargetBlockedError(error)) return false;
    const reason = proxyTargetBlockedReason(error);
    logger.warn(`[${logPrefix}] PROXY_TARGET_BLOCKED: ${reason}`);
    if (!res.headersSent) {
        res.status(403).send({ error: `PROXY_TARGET_BLOCKED: ${reason}` });
    } else {
        res.end();
    }
    return true;
}

function fetchProxyTarget(target, options) {
    if (target.dispatcher) {
        return undiciFetch(target.url, { ...options, dispatcher: target.dispatcher });
    }
    return fetch(target.url, options);
}

const dbDerivedValueMemo = createGenerationMemo();
const dbSegmentMemo = createDatabaseSegmentMemo();
let preserveDbSegmentMemoOnCacheMutation = false;
// Atomic JSON patches preserve untouched object identities. Reuse only those
// branch hashes across the explicitly marked copy-on-write cache handoff.
let preserveDbHashMemoOnCacheMutation = false;
let dbCompositionalHashMemo = new WeakMap();
const DB_BLOB_KEY = 'database/database.bin';
const DB_HEX_KEY = Buffer.from(DB_BLOB_KEY, 'utf-8').toString('hex');
const rawBootByteLengthStatement = (() => {
    try {
        return sqliteDb.prepare('SELECT LENGTH(value) AS byte_length FROM kv WHERE key = ?');
    } catch {
        return null;
    }
})();

function readRawBootByteLengthHint() {
    try {
        const byteLength = rawBootByteLengthStatement?.get(DB_BLOB_KEY)?.byte_length;
        if (!Number.isSafeInteger(byteLength) || byteLength < 0) return null;
        if (byteLength !== CHUNK_MARKER.length || !isDbBlobChunked()) return byteLength;
        const logicalByteLength = kvSize(DB_BLOB_KEY);
        return Number.isSafeInteger(logicalByteLength) && logicalByteLength >= 0
            ? logicalByteLength
            : null;
    } catch {
        return null;
    }
}
// A successful patch needs the same canonical bytes twice: immediately for its
// ETag and later for the debounced write. Keep exactly one generation-bound
// copy, then release it on persist completion or any cache invalidation.
const DB_CANONICAL_ENCODING_MEMO_NAME = 'canonical-encoding';
const DB_CANONICAL_ENCODING_TEST_STATS_PATH = process.env.NODE_ENV === 'test'
    ? String(process.env.POCKETRISU_TEST_DB_CANONICAL_ENCODING_STATS_PATH ?? '').trim() || null
    : null;
const dbCanonicalEncodingTestStats = {
    fullEncodes: 0,
    retained: false,
    retainedGeneration: null,
    retainedRevision: null,
    releases: {},
};
const DB_CACHE_MAX_ENTRIES = 8;
const DB_CACHE_MAX_ESTIMATED_BYTES = 1024 * 1024 * 1024;
const DB_CACHE_MAX_ENTRY_ESTIMATED_BYTES = 512 * 1024 * 1024;
const DB_CACHE_HEAP_PRESSURE_RATIO = 0.80;
const DB_CACHE_HEAP_LIMIT = v8.getHeapStatistics().heap_size_limit;

// In-memory database cache for patch-based sync. Entries store the STRIPPED
// (stubs-only) view and are reusable only for the exact SQLite row revision.
// Clean entries are LRU/size/heap-pressure evictable; acknowledged dirty patch
// state is pinned until persistence succeeds or an explicit invalidation wins.
const dbCache = createRevisionBoundCache({
    maxEntries: DB_CACHE_MAX_ENTRIES,
    maxEstimatedBytes: DB_CACHE_MAX_ESTIMATED_BYTES,
    maxEntryEstimatedBytes: DB_CACHE_MAX_ENTRY_ESTIMATED_BYTES,
    isUnderMemoryPressure: () => (
        process.memoryUsage().heapUsed >= DB_CACHE_HEAP_LIMIT * DB_CACHE_HEAP_PRESSURE_RATIO
    ),
    onMutation: (filePath, reason) => {
        releaseDbCacheCanonicalEncoding(filePath, `cache-${reason}`);
        if (reason === 'replace') dbDerivedValueMemo.bump(filePath);
        else dbDerivedValueMemo.deleteKey(filePath);
        if (filePath === DB_HEX_KEY && !preserveDbHashMemoOnCacheMutation) {
            dbCompositionalHashMemo = new WeakMap();
        }
        if (filePath === DB_HEX_KEY && !preserveDbSegmentMemoOnCacheMutation) {
            dbSegmentMemo.clear();
        }
    },
});
const pluginStorageManifestCache = createPluginStorageManifestCache({
    getRevision: kvGetPluginStoragePublicationRevision,
    readState: () => readPluginStorageManifestStateUncached(kvGet),
});

class DatabaseCacheRevisionConflict extends Error {
    constructor() {
        super('The authoritative database changed outside the decoded cache lifecycle');
        this.name = 'DatabaseCacheRevisionConflict';
        this.code = 'DATABASE_CACHE_REVISION_CONFLICT';
    }
}

let dbCachePruneScheduled = false;
let saveTimers = {};
let dbPersistRetryPending = false;
const pendingChatRowDeletions = new Set();
const SAVE_INTERVAL = 5000;

const chatRowStore = createChatRowStore({
    db: sqliteDb,
    kvGet,
    kvGetAsync,
    kvSet,
    kvSetFromFile,
    kvDel,
    kvList,
    kvListWithSizes,
    kvWriteToFile,
    kvSize,
    kvGetUpdatedAt,
    chatDeltaCompactMaxOperations: Number.isSafeInteger(Number(
        process.env.POCKETRISU_CHAT_DELTA_COMPACT_MAX_OPERATIONS,
    )) && Number(process.env.POCKETRISU_CHAT_DELTA_COMPACT_MAX_OPERATIONS) > 0
        ? Number(process.env.POCKETRISU_CHAT_DELTA_COMPACT_MAX_OPERATIONS)
        : 64,
    chatDeltaCompactMaxBytes: Number.isSafeInteger(Number(
        process.env.POCKETRISU_CHAT_DELTA_COMPACT_MAX_BYTES,
    )) && Number(process.env.POCKETRISU_CHAT_DELTA_COMPACT_MAX_BYTES) > 0
        ? Number(process.env.POCKETRISU_CHAT_DELTA_COMPACT_MAX_BYTES)
        : 1024 * 1024,
    chatDeltaCompactionFailpoint: process.env.NODE_ENV === 'test'
        && process.env.POCKETRISU_TEST_CHAT_DELTA_COMPACTION_FAILPOINT
        ? (stage) => {
            if (stage === process.env.POCKETRISU_TEST_CHAT_DELTA_COMPACTION_FAILPOINT) {
                throw new Error(`Injected chat delta compaction failure at ${stage}`);
            }
        }
        : null,
});

// ETag for database.bin
let dbEtag = null;

function computeDatabaseEtagFromObject(databaseObject) {
    return computeBufferEtag(Buffer.from(encodeRisuSaveLegacy(databaseObject)));
}

function publishDbCanonicalEncodingTestStats() {
    if (!DB_CANONICAL_ENCODING_TEST_STATS_PATH) return;
    const statsPath = path.resolve(process.cwd(), DB_CANONICAL_ENCODING_TEST_STATS_PATH);
    writeFileSync(statsPath, JSON.stringify(dbCanonicalEncodingTestStats), 'utf-8');
}

function noteDbCanonicalEncodingRetained(generation, revision) {
    if (!DB_CANONICAL_ENCODING_TEST_STATS_PATH) return;
    dbCanonicalEncodingTestStats.fullEncodes += 1;
    dbCanonicalEncodingTestStats.retained = true;
    dbCanonicalEncodingTestStats.retainedGeneration = generation;
    dbCanonicalEncodingTestStats.retainedRevision = revision;
    publishDbCanonicalEncodingTestStats();
}

function releaseDbCacheCanonicalEncoding(
    filePath,
    reason,
    expectedGeneration = undefined,
) {
    const released = dbDerivedValueMemo.deleteValue(
        filePath,
        DB_CANONICAL_ENCODING_MEMO_NAME,
        expectedGeneration,
    );
    if (!released || !DB_CANONICAL_ENCODING_TEST_STATS_PATH) return released;
    dbCanonicalEncodingTestStats.retained = false;
    dbCanonicalEncodingTestStats.retainedGeneration = null;
    dbCanonicalEncodingTestStats.retainedRevision = null;
    dbCanonicalEncodingTestStats.releases[reason]
        = (dbCanonicalEncodingTestStats.releases[reason] ?? 0) + 1;
    publishDbCanonicalEncodingTestStats();
    return true;
}

function retainDbCacheCanonicalEncoding(filePath) {
    const databaseObject = peekDbCacheValue(filePath);
    const metadata = dbCache.metadata(filePath);
    const generation = dbDerivedValueMemo.generation(filePath);
    if (!databaseObject || !metadata) {
        throw new DatabaseCacheRevisionConflict();
    }
    const retained = dbDerivedValueMemo.getOrCompute(
        filePath,
        DB_CANONICAL_ENCODING_MEMO_NAME,
        () => {
            const value = {
                bytes: Buffer.from(encodeRisuSaveLegacy(databaseObject)),
                databaseObject,
                generation,
                revision: metadata.revision,
            };
            noteDbCanonicalEncodingRetained(generation, metadata.revision);
            return value;
        },
    );
    if (retained.databaseObject !== databaseObject
        || retained.generation !== generation
        || retained.revision !== metadata.revision) {
        releaseDbCacheCanonicalEncoding(filePath, 'binding-conflict', generation);
        throw new DatabaseCacheRevisionConflict();
    }
    return retained;
}

// Keep every cache replacement/eviction behind these helpers: derived values
// are valid only for the exact mutation generation in which they were built.
function scheduleDbCachePrune() {
    if (dbCachePruneScheduled) return;
    dbCachePruneScheduled = true;
    setImmediate(() => {
        dbCachePruneScheduled = false;
        dbCache.prune();
    });
}

function getDbCacheValue(filePath) {
    const value = dbCache.get(filePath);
    if (value !== undefined) scheduleDbCachePrune();
    return value;
}

function getCurrentDatabaseCacheValue(filePath, { allowDirty = false } = {}) {
    const revision = kvGetDatabaseRevision();
    const retained = dbCache.metadata(filePath);
    if (retained?.dirty && retained.revision !== revision) {
        releaseDbCacheCanonicalEncoding(filePath, 'external-revision-conflict');
        throw new DatabaseCacheRevisionConflict();
    }
    const value = dbCache.getForRevision(filePath, revision, { allowDirty });
    if (value !== undefined) scheduleDbCachePrune();
    return value;
}

function peekDbCacheValue(filePath) {
    return dbCache.peek(filePath);
}

function replaceDbCacheValue(filePath, value, metadata = {}) {
    const preserveSegmentMemo = filePath === DB_HEX_KEY
        && metadata.preserveSegmentMemo === true;
    const preserveHashMemo = filePath === DB_HEX_KEY
        && metadata.preserveHashMemo === true;
    if (filePath === DB_HEX_KEY && !preserveSegmentMemo) dbSegmentMemo.clear();
    if (preserveSegmentMemo) dbSegmentMemo.preserveForNextRevision();
    const previousPreserve = preserveDbSegmentMemoOnCacheMutation;
    const previousHashPreserve = preserveDbHashMemoOnCacheMutation;
    preserveDbSegmentMemoOnCacheMutation = preserveSegmentMemo;
    preserveDbHashMemoOnCacheMutation = preserveHashMemo;
    try {
        dbCache.set(filePath, value, metadata);
    } finally {
        preserveDbSegmentMemoOnCacheMutation = previousPreserve;
        preserveDbHashMemoOnCacheMutation = previousHashPreserve;
    }
    scheduleDbCachePrune();
}

function markDbCacheClean(filePath, metadata = {}) {
    dbCache.markClean(filePath, metadata);
    scheduleDbCachePrune();
}

function deleteDbCacheValue(filePath) {
    dbCache.delete(filePath);
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
        () => calculateHash(
            peekDbCacheValue(filePath),
            filePath === DB_HEX_KEY ? dbCompositionalHashMemo : undefined,
        ).toString(16),
    );
}

function getDbCacheEtag(filePath, { retainCanonicalEncoding = false } = {}) {
    const canonicalEncoding = retainCanonicalEncoding
        ? retainDbCacheCanonicalEncoding(filePath)
        : null;
    return dbDerivedValueMemo.getOrCompute(
        filePath,
        'etag',
        () => canonicalEncoding
            ? computeBufferEtag(canonicalEncoding.bytes)
            : computeDatabaseEtagFromObject(peekDbCacheValue(filePath)),
    );
}

function seedDbCacheEtag(filePath, etag) {
    dbDerivedValueMemo.seed(filePath, 'etag', etag);
}

const STORAGE_QUEUE_DIAG_ENABLED = process.env.POCKETRISU_QUEUE_DIAG === 'true';
const STORAGE_QUEUE_DIAG_SAMPLE_LIMIT = 512;
const storageQueueDiagByLabel = STORAGE_QUEUE_DIAG_ENABLED ? new Map() : null;

function recordStorageQueueDiag(label, waitMs, holdMs) {
    let stats = storageQueueDiagByLabel.get(label);
    if (!stats) {
        stats = {
            count: 0,
            waitTotalMs: 0,
            waitMaxMs: 0,
            holdTotalMs: 0,
            holdMaxMs: 0,
            samples: [],
        };
        storageQueueDiagByLabel.set(label, stats);
    }
    stats.count++;
    stats.waitTotalMs += waitMs;
    stats.waitMaxMs = Math.max(stats.waitMaxMs, waitMs);
    stats.holdTotalMs += holdMs;
    stats.holdMaxMs = Math.max(stats.holdMaxMs, holdMs);
    const sample = { waitMs, holdMs };
    if (stats.samples.length < STORAGE_QUEUE_DIAG_SAMPLE_LIMIT) {
        stats.samples.push(sample);
    } else {
        const replacement = Math.floor(Math.random() * stats.count);
        if (replacement < STORAGE_QUEUE_DIAG_SAMPLE_LIMIT) {
            stats.samples[replacement] = sample;
        }
    }
}

function storageQueueDiagPercentile(sortedValues, percentile) {
    if (sortedValues.length === 0) return 0;
    const index = Math.min(
        sortedValues.length - 1,
        Math.max(0, Math.ceil(sortedValues.length * percentile) - 1),
    );
    return sortedValues[index];
}

function storageQueueDiagSnapshot() {
    const labels = Object.create(null);
    for (const [label, stats] of [...storageQueueDiagByLabel.entries()]
        .sort(([left], [right]) => left.localeCompare(right))) {
        const waitSample = stats.samples.map(sample => sample.waitMs).sort((a, b) => a - b);
        const holdSample = stats.samples.map(sample => sample.holdMs).sort((a, b) => a - b);
        labels[label] = {
            count: stats.count,
            sampleCount: stats.samples.length,
            waitMs: {
                total: stats.waitTotalMs,
                max: stats.waitMaxMs,
                p50: storageQueueDiagPercentile(waitSample, 0.5),
                p95: storageQueueDiagPercentile(waitSample, 0.95),
            },
            holdMs: {
                total: stats.holdTotalMs,
                max: stats.holdMaxMs,
                p50: storageQueueDiagPercentile(holdSample, 0.5),
                p95: storageQueueDiagPercentile(holdSample, 0.95),
            },
        };
    }
    return {
        enabled: true,
        sampleLimit: STORAGE_QUEUE_DIAG_SAMPLE_LIMIT,
        labels,
    };
}

function logStorageQueueDiagSummary() {
    const { labels } = storageQueueDiagSnapshot();
    for (const [label, stats] of Object.entries(labels)) {
        const wait = stats.waitMs;
        const hold = stats.holdMs;
        console.log(
            `[QueueDiag] ${label} count=${stats.count} `
            + `wait_ms(total=${wait.total.toFixed(3)},max=${wait.max.toFixed(3)},p50=${wait.p50.toFixed(3)},p95=${wait.p95.toFixed(3)}) `
            + `hold_ms(total=${hold.total.toFixed(3)},max=${hold.max.toFixed(3)},p50=${hold.p50.toFixed(3)},p95=${hold.p95.toFixed(3)})`,
        );
    }
}

let storageOperationQueue = Promise.resolve();
function queueStorageOperation(operation, label = 'unlabeled') {
    // Preserve the original callback and promise chain when diagnostics are off.
    if (!STORAGE_QUEUE_DIAG_ENABLED) {
        const operationRun = storageOperationQueue.then(operation, operation);
        storageOperationQueue = operationRun.catch(() => {});
        return operationRun;
    }
    const enqueuedAt = performance.now();
    const diagLabel = typeof label === 'string' && label.length > 0 ? label : 'unlabeled';
    const timedOperation = async (value) => {
        const startedAt = performance.now();
        try {
            return await operation(value);
        } finally {
            recordStorageQueueDiag(
                diagLabel,
                startedAt - enqueuedAt,
                performance.now() - startedAt,
            );
        }
    };
    const operationRun = storageOperationQueue.then(timedOperation, timedOperation);
    storageOperationQueue = operationRun.catch(() => {});
    return operationRun;
}

let importInProgress = false;
const IMPORT_BARRIER_DRAIN_TEST_GATE_DIR = process.env.NODE_ENV === 'test'
    ? String(process.env.POCKETRISU_IMPORT_BARRIER_DRAIN_TEST_GATE_DIR ?? '').trim() || null
    : null;
let importBarrierAcquireFailures = process.env.NODE_ENV === 'test'
    ? Math.max(0, Number.parseInt(process.env.POCKETRISU_TEST_IMPORT_BARRIER_ACQUIRE_FAILURES ?? '0', 10) || 0)
    : 0;

async function drainStorageMutationsForImport() {
    await queueStorageOperation(async () => {
        if (!IMPORT_BARRIER_DRAIN_TEST_GATE_DIR) return;
        const holdPath = path.join(IMPORT_BARRIER_DRAIN_TEST_GATE_DIR, 'hold');
        if (!existsSync(holdPath)) return;
        await fs.mkdir(IMPORT_BARRIER_DRAIN_TEST_GATE_DIR, { recursive: true });
        await fs.writeFile(path.join(IMPORT_BARRIER_DRAIN_TEST_GATE_DIR, 'entered'), 'draining', 'utf-8');
        const releasePath = path.join(IMPORT_BARRIER_DRAIN_TEST_GATE_DIR, 'release');
        // This queue boundary must finish even if the importing peer leaves;
        // abandoning it would let a later transaction overtake older writes.
        while (existsSync(holdPath) && !existsSync(releasePath)) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    });
    if (importBarrierAcquireFailures > 0) {
        importBarrierAcquireFailures--;
        throw new ImportIngressError('Import barrier acquisition failed before publication', {
            code: 'IMPORT_BARRIER_ACQUIRE_FAILED',
            statusCode: 500,
            retryable: true,
        });
    }
}
// Imports keep one raw transaction open across streamed decompression, msgpack
// walking and directory swaps. The barrier drains this queue before an import
// begins, so mutations either land entirely before BEGIN or are refused —
// never acknowledged and then discarded by the import's ROLLBACK.
const importBarrier = createImportBarrier({
    drainMutations: drainStorageMutationsForImport,
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
function queueStorageMutation(operation, label = 'unlabeled') {
    return queueStorageOperation(() => {
        if (importBarrier.isHeld()) throw new ImportInProgressError();
        return operation();
    }, label);
}

// ─── SQLite durability policy ───────────────────────────────────────────────
// The database module opens in FULL so early migrations and invalid/missing
// configuration fail safe. Self-hosted administrators can explicitly trade a
// bounded power-loss window for fewer commit-time fsyncs; hub mode is always
// server-admin managed through POCKETRISU_SQLITE_DURABILITY_MODE.
const SQLITE_DURABILITY_CONFIG_KEY = 'config/sqlite-durability-mode';
const SQLITE_DURABILITY_ENV_KEY = 'POCKETRISU_SQLITE_DURABILITY_MODE';
const SQLITE_MAINTENANCE_CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;
const SQLITE_CHECKPOINT_RETRY_MS = 10 * 1000;
const SQLITE_FOREGROUND_CHECKPOINT_RETRY_MS = 25;
const SQLITE_FOREGROUND_CHECKPOINT_DEADLINE_MS = 3 * 1000;
const SQLITE_DURABILITY_PROFILES = Object.freeze({
    durable: Object.freeze({
        synchronous: 'FULL',
        checkpointIntervalMs: null,
        powerLossWindowMs: 0,
    }),
    balanced: Object.freeze({
        synchronous: 'NORMAL',
        checkpointIntervalMs: 60 * 1000,
        powerLossWindowMs: 60 * 1000,
    }),
    performance: Object.freeze({
        synchronous: 'NORMAL',
        checkpointIntervalMs: 5 * 60 * 1000,
        powerLossWindowMs: 5 * 60 * 1000,
    }),
});

function normalizeSqliteDurabilityMode(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(SQLITE_DURABILITY_PROFILES, normalized)
        ? normalized
        : null;
}

const sqliteDurabilityEnvRaw = String(process.env[SQLITE_DURABILITY_ENV_KEY] ?? '').trim();
const sqliteDurabilityEnvMode = normalizeSqliteDurabilityMode(sqliteDurabilityEnvRaw);
const sqliteDurabilityManaged = HUB_HOSTING_MODE || sqliteDurabilityEnvRaw.length > 0;

function readPersistedSqliteDurabilityMode() {
    try {
        const raw = kvGet(SQLITE_DURABILITY_CONFIG_KEY);
        return raw ? normalizeSqliteDurabilityMode(Buffer.from(raw).toString('utf-8')) : null;
    } catch {
        return null;
    }
}

let sqliteDurabilityMode = sqliteDurabilityManaged
    ? (sqliteDurabilityEnvMode || 'durable')
    : (readPersistedSqliteDurabilityMode() || 'durable');
let sqliteDurabilityTimer = null;
let sqliteDurabilitySchedulerStarted = false;
let lastWalCheckpointAttempt = null;
let lastSuccessfulWalCheckpointAt = null;
let lastMaintenanceWalCheckpointAt = Date.now();

if (sqliteDurabilityEnvRaw && !sqliteDurabilityEnvMode) {
    logger.warn(
        `[SQLite] Invalid ${SQLITE_DURABILITY_ENV_KEY}=${JSON.stringify(sqliteDurabilityEnvRaw)}; `
        + 'using durable mode',
    );
}

function sqliteDurabilityProfile() {
    return SQLITE_DURABILITY_PROFILES[sqliteDurabilityMode];
}

function applySqliteDurabilityMode() {
    sqliteDb.pragma(`synchronous = ${sqliteDurabilityProfile().synchronous}`);
}

function normalizeWalCheckpointResult(rawResult, mode, reason) {
    const row = Array.isArray(rawResult) && rawResult[0] ? rawResult[0] : {};
    const busy = Number(row.busy ?? 1);
    const result = {
        mode,
        reason,
        complete: busy === 0,
        busy,
        logFrames: Number(row.log ?? -1),
        checkpointedFrames: Number(row.checkpointed ?? -1),
        attemptedAt: Date.now(),
    };
    lastWalCheckpointAttempt = result;
    if (result.complete) {
        lastSuccessfulWalCheckpointAt = result.attemptedAt;
        if (mode === 'TRUNCATE') lastMaintenanceWalCheckpointAt = result.attemptedAt;
    }
    return result;
}

function runTrackedWalCheckpoint(mode, reason) {
    return normalizeWalCheckpointResult(checkpointWal(mode), mode, reason);
}

function runTrackedWalCheckpointWithoutBusyWait(mode, reason) {
    const busyTimeout = Number(sqliteDb.pragma('busy_timeout', { simple: true }));
    sqliteDb.pragma('busy_timeout = 0');
    try {
        return runTrackedWalCheckpoint(mode, reason);
    } finally {
        sqliteDb.pragma(`busy_timeout = ${busyTimeout}`);
    }
}

async function runTrackedWalCheckpointWithBusyRetry(mode, reason, {
    deadlineMs = SQLITE_FOREGROUND_CHECKPOINT_DEADLINE_MS,
} = {}) {
    const deadline = Date.now() + deadlineMs;
    let checkpoint;
    for (;;) {
        // The connection normally waits up to five seconds inside a busy
        // checkpoint. Foreground retries need the async deadline to remain in
        // control, so each synchronous attempt temporarily disables that wait
        // and restores it before yielding to any other work.
        checkpoint = runTrackedWalCheckpointWithoutBusyWait(mode, reason);
        if (checkpoint.complete) return checkpoint;
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) return checkpoint;
        await new Promise((resolve) => setTimeout(
            resolve,
            Math.min(SQLITE_FOREGROUND_CHECKPOINT_RETRY_MS, remainingMs),
        ));
    }
}

function sqliteDurabilityState() {
    const profile = sqliteDurabilityProfile();
    return {
        mode: sqliteDurabilityMode,
        managed: sqliteDurabilityManaged,
        managedBy: sqliteDurabilityManaged
            ? (sqliteDurabilityEnvRaw ? 'environment' : 'hub')
            : null,
        synchronous: profile.synchronous,
        checkpointIntervalMs: profile.checkpointIntervalMs,
        maintenanceCheckpointIntervalMs: SQLITE_MAINTENANCE_CHECKPOINT_INTERVAL_MS,
        powerLossWindowMs: profile.powerLossWindowMs,
        lastSuccessfulCheckpointAt: lastSuccessfulWalCheckpointAt,
        lastCheckpoint: lastWalCheckpointAttempt,
    };
}

function sqliteCheckpointDelay(intervalMs) {
    if (!HUB_HOSTING_MODE) return intervalMs;
    // Stagger independently hosted tenant processes so a shared volume does not
    // receive a synchronized flush burst every minute.
    return Math.max(1000, Math.round(intervalMs * (0.9 + Math.random() * 0.2)));
}

function scheduleSqliteDurabilityCheckpoint(delayMs = null) {
    if (!sqliteDurabilitySchedulerStarted) return;
    if (sqliteDurabilityTimer) clearTimeout(sqliteDurabilityTimer);
    const profile = sqliteDurabilityProfile();
    const interval = profile.checkpointIntervalMs
        ?? SQLITE_MAINTENANCE_CHECKPOINT_INTERVAL_MS;
    sqliteDurabilityTimer = setTimeout(async () => {
        sqliteDurabilityTimer = null;
        let retry = false;
        try {
            const now = Date.now();
            const mode = now - lastMaintenanceWalCheckpointAt
                >= SQLITE_MAINTENANCE_CHECKPOINT_INTERVAL_MS
                ? 'TRUNCATE'
                : profile.synchronous === 'NORMAL' ? 'FULL' : 'TRUNCATE';
            const result = await queueStorageMutation(() => (
                runTrackedWalCheckpoint(mode, 'scheduled')
            ));
            retry = !result.complete;
            if (!result.complete) {
                logger.warn(`[SQLite] Scheduled ${mode} checkpoint was busy; retrying`);
            }
        } catch (error) {
            retry = true;
            if (!isImportInProgressError(error)) {
                logger.warn('[SQLite] Scheduled durability checkpoint failed:', error?.message || error);
            }
        } finally {
            scheduleSqliteDurabilityCheckpoint(
                retry ? SQLITE_CHECKPOINT_RETRY_MS : null,
            );
        }
    }, sqliteCheckpointDelay(delayMs ?? interval));
    sqliteDurabilityTimer.unref?.();
}

function startSqliteDurabilityCheckpointScheduler() {
    sqliteDurabilitySchedulerStarted = true;
    lastMaintenanceWalCheckpointAt = Date.now();
    scheduleSqliteDurabilityCheckpoint();
}

function rescheduleSqliteDurabilityCheckpoint() {
    if (sqliteDurabilitySchedulerStarted) scheduleSqliteDurabilityCheckpoint();
}

// db.cjs deliberately started in FULL. This is the only startup point that may
// downgrade it, and only after an explicit valid persisted/admin choice exists.
applySqliteDurabilityMode();

// Imports hold a raw transaction outside the storage queue. Wait before
// entering the queue, then re-check from inside it: if an import won the race,
// retry after that holder releases. If the read wins, the import's queue drain
// stays behind it and cannot open its transaction until the read completes.
function throwIfSignalAborted(signal) {
    if (!signal?.aborted) return;
    if (signal.reason !== undefined) throw signal.reason;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
}

async function queueStorageReadAfterImports(operation, signal = null) {
    while (true) {
        throwIfSignalAborted(signal);
        await importBarrier.waitUntilIdle(signal);
        throwIfSignalAborted(signal);
        const attempt = await queueStorageOperation(async () => {
            throwIfSignalAborted(signal);
            if (importBarrier.isHeld()) return { retry: true };
            return { retry: false, value: await operation() };
        });
        if (!attempt.retry) return attempt.value;
    }
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
        retryAfter: 5,
        retryable: true,
        commitOutcome: 'not-committed',
        commitOutcomeUnknown: false,
    });
}

// Test-only boundaries for the optimized plugin clear. Kept at route level so
// production deletion primitives cannot accidentally acquire a failpoint.
const pluginStorageClearFailpoint = process.env.NODE_ENV === 'test'
    ? String(process.env.POCKETRISU_TEST_PLUGIN_CLEAR_FAILPOINT ?? '')
    : '';

// Test-only boundaries for the AA1 transaction contract. These are scoped to
// the narrow plugin mutation endpoint so ordinary KV fault-injection remains
// unchanged: owner-write | owner-remove | pre-commit | verification-read |
// acknowledgement-loss.
const pluginStorageMutationFailpoint = process.env.NODE_ENV === 'test'
    ? String(process.env.POCKETRISU_TEST_PLUGIN_MUTATION_FAILPOINT ?? '').trim()
    : '';

// Test-only recovery transaction/acknowledgement boundaries. Both are after
// snapshot validation; before-commit must roll back every publication row,
// while response simulates an acknowledgement lost after COMMIT.
const snapshotRestoreFailpoint = process.env.NODE_ENV === 'test'
    ? String(process.env.POCKETRISU_TEST_SNAPSHOT_RESTORE_FAILPOINT ?? '').trim()
    : '';
const pluginStorageOwnershipReadFailpoint = process.env.NODE_ENV === 'test'
    ? String(process.env.POCKETRISU_TEST_PLUGIN_OWNERSHIP_READ_FAILPOINT ?? '').trim()
    : '';
const pluginStorageOwnershipStatsPath = process.env.NODE_ENV === 'test'
    ? String(process.env.POCKETRISU_TEST_PLUGIN_OWNERSHIP_STATS_PATH ?? '').trim()
    : '';
// Test-only REMOTE resolver boundaries. These live at the restore-route adapter
// so production KV primitives never gain failure behavior.
const snapshotRestoreRemoteFailpoint = process.env.NODE_ENV === 'test'
    ? String(process.env.POCKETRISU_TEST_SNAPSHOT_REMOTE_FAILPOINT ?? '').trim()
    : '';
const SNAPSHOT_RESTORE_TEST_GATE_DIR = process.env.NODE_ENV === 'test'
    ? String(process.env.POCKETRISU_SNAPSHOT_RESTORE_TEST_GATE_DIR ?? '').trim() || null
    : null;
const SNAPSHOT_RESTORE_DECODE_TEST_GATE_DIR = process.env.NODE_ENV === 'test'
    ? String(process.env.POCKETRISU_SNAPSHOT_RESTORE_DECODE_TEST_GATE_DIR ?? '').trim() || null
    : null;
const BACKUP_IMPORT_TEST_GATE_DIR = process.env.NODE_ENV === 'test'
    ? String(process.env.POCKETRISU_BACKUP_IMPORT_TEST_GATE_DIR ?? '').trim() || null
    : null;
const backupImportFailpoint = process.env.NODE_ENV === 'test'
    ? String(process.env.POCKETRISU_TEST_BACKUP_IMPORT_FAILPOINT ?? '').trim()
    : '';
const saveFolderImportFailpoint = process.env.NODE_ENV === 'test'
    ? String(process.env.POCKETRISU_TEST_SAVE_FOLDER_IMPORT_FAILPOINT ?? '').trim()
    : '';

function hasSaveFolderImportFailpoint(name) {
    return saveFolderImportFailpoint
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
        .includes(name);
}

function throwIfStreamingRestoreAborted(shouldAbort) {
    if (typeof shouldAbort !== 'function' || !shouldAbort()) return;
    const error = new Error('Streaming Risu load cancelled');
    error.code = 'RISU_STREAM_ABORTED';
    throw error;
}

async function waitAtSnapshotRestoreTestGate(shouldAbort) {
    if (!SNAPSHOT_RESTORE_TEST_GATE_DIR) return;
    const holdPath = path.join(SNAPSHOT_RESTORE_TEST_GATE_DIR, 'hold');
    if (!existsSync(holdPath)) return;
    await fs.mkdir(SNAPSHOT_RESTORE_TEST_GATE_DIR, { recursive: true });
    await fs.writeFile(
        path.join(SNAPSHOT_RESTORE_TEST_GATE_DIR, 'entered'),
        'before-folded-delete',
        'utf-8',
    );
    const releasePath = path.join(SNAPSHOT_RESTORE_TEST_GATE_DIR, 'release');
    while (existsSync(holdPath) && !existsSync(releasePath)) {
        throwIfStreamingRestoreAborted(shouldAbort);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throwIfStreamingRestoreAborted(shouldAbort);
}

let snapshotRestoreDecodeGateEntered = false;
async function waitAtSnapshotRestoreDecodeTestGate(signal) {
    if (!SNAPSHOT_RESTORE_DECODE_TEST_GATE_DIR || snapshotRestoreDecodeGateEntered) return;
    const holdPath = path.join(SNAPSHOT_RESTORE_DECODE_TEST_GATE_DIR, 'hold');
    if (!existsSync(holdPath)) return;
    snapshotRestoreDecodeGateEntered = true;
    await fs.mkdir(SNAPSHOT_RESTORE_DECODE_TEST_GATE_DIR, { recursive: true });
    await fs.writeFile(
        path.join(SNAPSHOT_RESTORE_DECODE_TEST_GATE_DIR, 'entered'),
        'during-decompression',
        'utf-8',
    );
    const releasePath = path.join(SNAPSHOT_RESTORE_DECODE_TEST_GATE_DIR, 'release');
    while (!signal?.aborted && existsSync(holdPath) && !existsSync(releasePath)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

async function waitAtBackupImportTestGate(signal = null) {
    if (!BACKUP_IMPORT_TEST_GATE_DIR) return;
    const holdPath = path.join(BACKUP_IMPORT_TEST_GATE_DIR, 'hold');
    if (!existsSync(holdPath)) return;
    await fs.mkdir(BACKUP_IMPORT_TEST_GATE_DIR, { recursive: true });
    await fs.writeFile(
        path.join(BACKUP_IMPORT_TEST_GATE_DIR, 'entered'),
        'after-database-ingestion',
        'utf-8',
    );
    const releasePath = path.join(BACKUP_IMPORT_TEST_GATE_DIR, 'release');
    while (!signal?.aborted && existsSync(holdPath) && !existsSync(releasePath)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throwIfImportAborted(signal);
}

function hitPluginStorageMutationFailpoint(boundary) {
    if (pluginStorageMutationFailpoint === boundary) {
        throw new Error(`Injected plugin storage mutation failure at ${boundary}`);
    }
}

const PLUGIN_STORAGE_BATCH_MAX_OPERATIONS = 128;
const PLUGIN_STORAGE_BATCH_MAX_BODY_BYTES = 16 * 1024 * 1024;
const PLUGIN_STORAGE_BATCH_STREAM_MAGIC = Buffer.from('PRISUB01', 'ascii');
const PLUGIN_STORAGE_BATCH_STREAM_PREFIX_BYTES = 12;
const PLUGIN_STORAGE_BATCH_STREAM_MAX_METADATA_BYTES = 1024 * 1024;
const PLUGIN_STORAGE_BATCH_STREAM_MAX_PAYLOAD_BYTES = Math.max(
    PLUGIN_VALUE_MAX_BYTES,
    PLUGIN_STORAGE_MAX_BYTES,
);
const PLUGIN_STORAGE_TRANSITION_STREAM_MAGIC = Buffer.from('PRISUT01', 'ascii');
const PLUGIN_STORAGE_TRANSITION_STREAM_PREFIX_BYTES = 12;
const PLUGIN_STORAGE_TRANSITION_STREAM_MAX_ENTRIES = 100_000;
const PLUGIN_STORAGE_TRANSITION_STREAM_MAX_METADATA_BYTES = 64 * 1024 * 1024;
const PLUGIN_STORAGE_TRANSITION_STREAM_MAX_PAYLOAD_BYTES = Math.max(
    PLUGIN_VALUE_MAX_BYTES,
    PLUGIN_STORAGE_MAX_BYTES,
);
const PLUGIN_STORAGE_REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/;
const PLUGIN_STORAGE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const pluginStorageBatchFailpoint = process.env.NODE_ENV === 'test'
    ? String(process.env.POCKETRISU_TEST_PLUGIN_BATCH_FAILPOINT ?? '').trim()
    : '';
const pluginStorageBatchAcknowledgementDelayMs = process.env.NODE_ENV === 'test'
    ? Math.max(0, Number.parseInt(
        process.env.POCKETRISU_TEST_PLUGIN_BATCH_ACK_DELAY_MS ?? '0',
        10,
    ) || 0)
    : 0;

// Test-only authoritative read failure used by the IP1 integration contract.
// It is intentionally scoped to the versioned state endpoint.
const pluginStorageStateFailpoint = process.env.NODE_ENV === 'test'
    ? String(process.env.POCKETRISU_TEST_PLUGIN_STATE_FAILPOINT ?? '').trim()
    : '';
const pluginStorageViewerTestGateDir = process.env.NODE_ENV === 'test'
    ? String(process.env.POCKETRISU_TEST_PLUGIN_VIEWER_GATE_DIR ?? '').trim()
    : '';

function hitPluginStorageBatchFailpoint(boundary) {
    if (pluginStorageBatchFailpoint === boundary) {
        throw new Error(`Injected plugin storage batch failure at ${boundary}`);
    }
}

async function waitAtPluginStorageViewerTestGate(isClosed) {
    if (!pluginStorageViewerTestGateDir) return;
    const holdPath = path.join(pluginStorageViewerTestGateDir, 'hold');
    if (!existsSync(holdPath)) return;
    await fs.mkdir(pluginStorageViewerTestGateDir, { recursive: true });
    await fs.writeFile(
        path.join(pluginStorageViewerTestGateDir, 'entered'),
        'snapshot-pinned',
        'utf-8',
    );
    const releasePath = path.join(pluginStorageViewerTestGateDir, 'release');
    while (!isClosed() && existsSync(holdPath) && !existsSync(releasePath)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

async function reportPluginStorageViewerTestProgress(metrics, fileName = 'progress.json') {
    if (!pluginStorageViewerTestGateDir) return;
    await fs.mkdir(pluginStorageViewerTestGateDir, { recursive: true });
    await fs.writeFile(
        path.join(pluginStorageViewerTestGateDir, fileName),
        JSON.stringify(metrics),
        'utf-8',
    );
}

function parsePluginStorageOwnerRecord(bytes) {
    if (!bytes) return null;
    try {
        const text = bytes.toString('utf-8');
        if (!Buffer.from(text, 'utf-8').equals(bytes)) return null;
        const value = JSON.parse(text);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
        return null;
    }
}

function isCanonicalPluginStorageOwnerRecord(owner, bytes) {
    if (!owner || !bytes) return false;
    const keys = Object.keys(owner);
    if (keys.length !== 4
        || keys[0] !== 'plugin'
        || keys[1] !== 'updatedAt'
        || keys[2] !== 'revision'
        || keys[3] !== 'generation'
        || typeof owner.plugin !== 'string'
        || owner.plugin.length === 0
        || !owner.plugin.isWellFormed()
        || !Number.isSafeInteger(owner.updatedAt)
        || owner.updatedAt < 0
        || typeof owner.revision !== 'string'
        || !PLUGIN_STORAGE_UUID_PATTERN.test(owner.revision)
        || typeof owner.generation !== 'string'
        || !PLUGIN_STORAGE_UUID_PATTERN.test(owner.generation)) return false;
    return Buffer.from(JSON.stringify(owner), 'utf-8').equals(bytes);
}

/**
 * Opaque CAS revision for one logical value+owner pair. Including the stored
 * owner incarnation makes a same-value remove/recreate distinguishable while
 * still giving historical rows (without revision metadata) a stable token.
 */
function pluginStorageRevisionDigest(ownerBytes) {
    const owner = parsePluginStorageOwnerRecord(ownerBytes);
    const incarnation = isCanonicalPluginStorageOwnerRecord(owner, ownerBytes)
        ? owner.revision
        : `legacy:${ownerBytes ? sha256Hex(ownerBytes) : 'unowned'}`;
    const digest = nodeCrypto.createHash('sha256');
    digest.update('pocketrisu-plugin-storage-v1\0', 'utf-8');
    digest.update(incarnation, 'utf-8');
    digest.update('\0', 'utf-8');
    return digest;
}

function pluginStorageRevision(valueBytes, ownerBytes) {
    if (!valueBytes) return null;
    const digest = pluginStorageRevisionDigest(ownerBytes);
    digest.update(valueBytes);
    return `sha256:${digest.digest('hex')}`;
}

async function pluginStorageRevisionFromFile(filePath, ownerBytes) {
    const digest = pluginStorageRevisionDigest(ownerBytes);
    for await (const chunk of createReadStream(filePath)) digest.update(chunk);
    return `sha256:${digest.digest('hex')}`;
}

const MAX_PLUGIN_STORAGE_ARRAY_INDEX = 0xffff_ffff;

function pluginStorageArrayIndex(key) {
    const index = Number(key);
    return Number.isInteger(index)
        && index >= 0
        && index < MAX_PLUGIN_STORAGE_ARRAY_INDEX
        && String(index) === key
        ? index
        : null;
}

function comparePluginStorageRecordKeys(left, right) {
    const leftIndex = pluginStorageArrayIndex(left);
    const rightIndex = pluginStorageArrayIndex(right);
    if (leftIndex !== null || rightIndex !== null) {
        if (leftIndex === null) return 1;
        if (rightIndex === null) return -1;
        return leftIndex - rightIndex;
    }
    return left < right ? -1 : left > right ? 1 : 0;
}

async function readPluginStorageState(valueKey, ownerKey) {
    const [valueBytes, ownerBytes] = await Promise.all([
        kvGetAsync(valueKey),
        kvGetAsync(ownerKey),
    ]);
    const owner = parsePluginStorageOwnerRecord(ownerBytes);
    return {
        valueBytes,
        ownerBytes,
        revision: pluginStorageRevision(valueBytes, ownerBytes),
        generation: valueBytes !== null
            && isCanonicalPluginStorageOwnerRecord(owner, ownerBytes)
            ? owner.generation
            : null,
    };
}

// Captures run inside the endpoint's storage operation. Reconcile enters the
// same queue through runStorageOperation, so neither can observe half-written
// backup state or race a chat-row overwrite.
const chatBackupStore = createChatBackupStore({
    getChatBackupsRoot: () => chatBackupsDir,
    logger,
    inspectChatRow: (chaId, chatId) => (
        chatRowStore.inspectChatRowForBackup(chaId, chatId)
    ),
    readChatRowRaw: (chaId, chatId) => chatRowStore.readChatRowRaw(chaId, chatId),
    repairChatRowMetadata: (rowState, coldStorage, messageCount) => (
        chatRowStore.repairChatRowMetadata(rowState, coldStorage, messageCount)
    ),
    readChatRowRawWithMetadata: (chaId, chatId) => (
        chatRowStore.readChatRowRawWithMetadata(chaId, chatId)
    ),
    streamChatRowRawToFile: (chaId, chatId, filePath) => (
        chatRowStore.streamChatRowRawToFile(chaId, chatId, filePath)
    ),
    getByteBudget: () => resolveChatBackupMaxBytes({ kvGet }),
    getUncompressedByteBudget: () => resolveChatBackupMaxUncompressedBytes({ kvGet }),
    runStorageOperation: queueStorageOperation,
});

const DB_CACHE_TEST_DIAGNOSTICS = process.env.NODE_ENV === 'test';
const CHAT_EXTERNALIZATION_MARKER_KEY = 'migration/chats-externalized';
const CHAT_EXTERNALIZATION_MARKER_VALUE = Buffer.from('done', 'utf-8');
const CHAT_ORPHAN_GRACE_MS = 60 * 60 * 1000;

// ─── Persist failure tracking (Stage 1 visibility) ───────────────────────────
// Debounced failures surface on the next patch; structural-patch failures
// surface on the current response. Cleared on the next successful persist.
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
// A plugin publication can commit after an ordinary database/chat snapshot has
// consumed the cooldown. Keep that later recovery obligation durable so a
// restart cannot lose the deferred snapshot. The marker is replaced inside the
// same SQLite transaction as each logical plugin mutation/transition, then
// cleared atomically with the snapshot that folded that exact-or-later state.
const PLUGIN_RECOVERY_SNAPSHOT_DIRTY_KEY = 'config/plugin-storage-recovery-dirty';
const PLUGIN_RECOVERY_SNAPSHOT_TEST_GATE_DIR
    = process.env.POCKETRISU_PLUGIN_RECOVERY_SNAPSHOT_TEST_GATE_DIR || null;
const SNAPSHOT_ASSEMBLY_TEST_GATE_DIR
    = process.env.POCKETRISU_SNAPSHOT_ASSEMBLY_TEST_GATE_DIR || null;
const SNAPSHOT_SOURCE_TOKEN_MAX_RETRIES = 2;
const SNAPSHOT_TEST_STATS_PATH = process.env.NODE_ENV === 'test'
    ? String(process.env.POCKETRISU_TEST_SNAPSHOT_STATS_PATH ?? '').trim() || null
    : null;
const snapshotTestStats = {
    metadataProbes: 0,
    databaseBodySpools: 0,
    assemblies: 0,
    tokenMismatches: 0,
    publications: 0,
};
const PLUGIN_RECOVERY_SNAPSHOT_RETRY_MS = Math.min(
    5000,
    Math.max(100, Number.isFinite(BACKUP_INTERVAL_MS) ? BACKUP_INTERVAL_MS : 1000),
);
let lastBackupTime = null;
let backupCreationInFlight = false;
let pluginRecoverySnapshotTimer = null;
let pluginRecoverySnapshotRun = null;
let deferredBackupPending = false;

function publishSnapshotTestStats() {
    if (!SNAPSHOT_TEST_STATS_PATH) return;
    const statsPath = path.resolve(process.cwd(), SNAPSHOT_TEST_STATS_PATH);
    writeFileSync(statsPath, JSON.stringify(snapshotTestStats), 'utf-8');
}

function newPluginRecoverySnapshotToken() {
    return Buffer.from(nodeCrypto.randomUUID(), 'utf-8');
}

function markPluginRecoverySnapshotDirty(token) {
    kvSet(PLUGIN_RECOVERY_SNAPSHOT_DIRTY_KEY, token);
}

function clearCapturedPluginRecoverySnapshotDirty(capturedToken) {
    if (!capturedToken) return;
    const currentToken = kvGet(PLUGIN_RECOVERY_SNAPSHOT_DIRTY_KEY);
    if (currentToken?.equals(capturedToken)) {
        kvDel(PLUGIN_RECOVERY_SNAPSHOT_DIRTY_KEY);
    }
}

async function waitAtSnapshotTestGate(gateDir, state) {
    if (!gateDir) return;
    const holdPath = path.join(gateDir, 'hold');
    if (!existsSync(holdPath)) return;
    await fs.mkdir(gateDir, { recursive: true });
    await fs.writeFile(
        path.join(gateDir, 'entered'),
        state,
        'utf-8',
    );
    const releasePath = path.join(gateDir, 'release');
    while (existsSync(holdPath) && !existsSync(releasePath)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

async function waitAtPluginRecoverySnapshotTestGate() {
    return waitAtSnapshotTestGate(
        PLUGIN_RECOVERY_SNAPSHOT_TEST_GATE_DIR,
        'before-publication',
    );
}

async function waitAtSnapshotAssemblyTestGate() {
    return waitAtSnapshotTestGate(SNAPSHOT_ASSEMBLY_TEST_GATE_DIR, 'assembling-pinned-source');
}

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
        const costs = new Map(
            snapshotFootprints(DB_BACKUP_PREFIX).map((entry) => [entry.key, entry.size]),
        );
        const totalBytes = keys.reduce((sum, key) => sum + (costs.get(key) ?? 0), 0);
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
    const footprints = snapshotFootprints(DB_BACKUP_PREFIX);
    return {
        count: footprints.length,
        bytes: footprints.reduce((sum, entry) => sum + entry.size, 0),
        logicalBytes: footprints.reduce((sum, entry) => sum + entry.logicalSize, 0),
    };
}

function warnAndPreserveMissingChatRow(source, chaId, chatId) {
    // The referenced payload is already lost. Recovery-oriented backups keep
    // the remaining database usable by retaining its metadata-only stub.
    logger.warn(
        `[${source}] Missing referenced chat row ${chaId}/${chatId}; preserving bare stub`
    );
}

function snapshotSourceTokensEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function runAutomaticSnapshotStoragePhase(storageAlreadyExclusive, operation, label) {
    return storageAlreadyExclusive ? operation() : queueStorageMutation(operation, label);
}

async function captureAutomaticSnapshotSource(storageAlreadyExclusive) {
    return runAutomaticSnapshotStoragePhase(storageAlreadyExclusive, async () => {
        await flushPendingDb({ scheduleSnapshot: false });
        if (dbPersistRetryPending) return null;

        const snapshot = createKvSnapshot();
        try {
            const sourceToken = snapshot.kvGetSnapshotSourceToken();
            snapshotTestStats.metadataProbes += 1;
            publishSnapshotTestStats();
            if (!Number.isSafeInteger(sourceToken.databaseSize)
                || sourceToken.databaseSize <= 0) {
                snapshot.close();
                return null;
            }
            return { snapshot, sourceToken };
        } catch (error) {
            snapshot.close();
            throw error;
        }
    }, 'snapshot-capture');
}

async function assembleAutomaticSnapshotSource(captured) {
    const { snapshot } = captured;
    const spoolRow = (key) => spoolBackupSnapshotRow(snapshot, key);
    const spoolChatRow = (key) => spoolLogicalChatSnapshotRow(snapshot, key);
    let assemblyGateReached = false;
    const databaseSource = await spoolBackupSnapshotRow(snapshot, DB_BLOB_KEY, {
        onChunk: async () => {
            if (assemblyGateReached) return;
            assemblyGateReached = true;
            await waitAtSnapshotAssemblyTestGate();
        },
    });
    if (!databaseSource) return null;
    snapshotTestStats.databaseBodySpools += 1;
    publishSnapshotTestStats();

    const finalPath = path.join(
        databaseSpoolDir,
        `${DATABASE_SPOOL_FILE_PREFIX}${process.pid}-${nodeCrypto.randomUUID()}`,
    );
    const filePath = `${finalPath}.tmp`;
    try {
        const databaseState = await readBackupRisuSaveTopLevelFields(
            databaseSource,
            ['optimizePluginMemory', PLUGIN_STORAGE_GENERATION_FIELD],
            {
                tempDir: databaseSpoolDir,
                readRemoteRowSize: (name) => snapshot.kvSize(
                    `remotes/${name}.local.bin`,
                ),
                readRemoteRowSource: (name) => spoolRow(
                    `remotes/${name}.local.bin`,
                ),
            },
        );
        const ownedPluginStorage = resolveOwnedPluginStorageRows(databaseState, snapshot);
        const pluginStorage = {
            valueRows: ownedPluginStorage.valueRows,
            metaRows: ownedPluginStorage.metaRows,
            readRowSource: spoolRow,
        };
        const mcpToolCalls = {
            rows: listMcpToolCallBackupEntries(snapshot).map((entry) => ({
                key: parseMcpToolCallStorageKey(entry.key).suffix,
                source: entry.key,
            })),
            readRowSource: spoolRow,
        };
        const result = await streamBackupRisuSaveToFile({
            databaseSource,
            filePath,
            readChatRowSource: (chaId, chatId) => spoolChatRow(
                chatRowKey(chaId, chatId),
            ),
            readRemoteRowSource: (name) => spoolRow(
                `remotes/${name}.local.bin`,
            ),
            readRemoteRowSize: (name) => snapshot.kvSize(
                `remotes/${name}.local.bin`,
            ),
            pluginStorage,
            mcpToolCalls,
            markPluginStorageFolded: true,
            canonicalJsonEncoding: true,
            tempDir: databaseSpoolDir,
            onMissingChatRow: (chaId, chatId) => {
                warnAndPreserveMissingChatRow('Snapshot', chaId, chatId);
            },
        });
        snapshotTestStats.assemblies += 1;
        publishSnapshotTestStats();
        return result;
    } catch (error) {
        await fs.unlink(filePath).catch(() => {});
        throw error;
    } finally {
        await databaseSource.cleanup();
    }
}

async function publishAutomaticSnapshot(
    captured,
    backupDbSpool,
    backupKey,
    storageAlreadyExclusive,
) {
    return runAutomaticSnapshotStoragePhase(storageAlreadyExclusive, () => {
        const currentToken = kvGetSnapshotSourceToken();
        if (!snapshotSourceTokensEqual(captured.sourceToken, currentToken)) {
            snapshotTestStats.tokenMismatches += 1;
            publishSnapshotTestStats();
            return { published: false, mismatch: true };
        }
        sqliteDb.transaction(() => {
            kvSetFromFile(backupKey, backupDbSpool.filePath);
            clearCapturedPluginRecoverySnapshotDirty(
                captured.sourceToken.recoveryDirtyToken
                    ? Buffer.from(captured.sourceToken.recoveryDirtyToken, 'base64url')
                    : null,
            );
        })();
        lastBackupTime = Date.now();
        trimSnapshotsToLimits();
        snapshotTestStats.publications += 1;
        publishSnapshotTestStats();
        return { published: true, mismatch: false };
    }, 'snapshot-publish');
}

async function publishAutomaticSnapshotAfterImports(
    captured,
    backupDbSpool,
    backupKey,
    storageAlreadyExclusive,
) {
    for (;;) {
        try {
            return await publishAutomaticSnapshot(
                captured,
                backupDbSpool,
                backupKey,
                storageAlreadyExclusive,
            );
        } catch (error) {
            if (storageAlreadyExclusive || !isImportInProgressError(error)) throw error;
            // The pinned assembly remains private. Let the destructive
            // replacement finish, then compare its committed source token with
            // the captured one instead of publishing or silently abandoning
            // the consistency proof.
            await importBarrier.waitUntilIdle();
        }
    }
}

async function createBackupAndRotate({ storageAlreadyExclusive = false } = {}) {
    const now = Date.now();
    if (lastBackupTime && now - lastBackupTime < BACKUP_INTERVAL_MS) {
        return {
            created: false,
            retryAfterMs: BACKUP_INTERVAL_MS - (now - lastBackupTime),
        };
    }
    if (backupCreationInFlight) {
        return { created: false, retryAfterMs: 50, reschedule: true };
    }

    backupCreationInFlight = true;
    try {
        for (let attempt = 0; attempt < SNAPSHOT_SOURCE_TOKEN_MAX_RETRIES; attempt++) {
            let captured = null;
            let backupDbSpool = null;
            try {
                captured = await captureAutomaticSnapshotSource(storageAlreadyExclusive);
                if (!captured) {
                    return { created: false, retryAfterMs: PLUGIN_RECOVERY_SNAPSHOT_RETRY_MS };
                }
                backupDbSpool = await assembleAutomaticSnapshotSource(captured);
                captured.snapshot.close();
                captured.snapshot = null;
                if (!backupDbSpool) {
                    return { created: false, retryAfterMs: PLUGIN_RECOVERY_SNAPSHOT_RETRY_MS };
                }

                // Test-only gate after the pinned source has been fully consumed
                // and before publication re-enters the mutation queue.
                await waitAtPluginRecoverySnapshotTestGate();
                const backupKey = `${DB_BACKUP_PREFIX}${(Date.now() / 100).toFixed()}.bin`;
                const publication = await publishAutomaticSnapshotAfterImports(
                    captured,
                    backupDbSpool,
                    backupKey,
                    storageAlreadyExclusive,
                );
                if (publication.published) {
                    return { created: true, retryAfterMs: 0 };
                }
                if (attempt + 1 >= SNAPSHOT_SOURCE_TOKEN_MAX_RETRIES) {
                    return { created: false, retryAfterMs: 50, reschedule: true };
                }
            } finally {
                captured?.snapshot?.close();
                if (backupDbSpool) {
                    await fs.unlink(backupDbSpool.filePath).catch(() => {});
                }
            }
        }
        return { created: false, retryAfterMs: 50, reschedule: true };
    } catch (error) {
        if (!isImportInProgressError(error)) {
            logger.error(
                `[Snapshot] Failed to create database snapshot using spool ${databaseSpoolDir}:`,
                error,
            );
        }
        return {
            created: false,
            retryAfterMs: PLUGIN_RECOVERY_SNAPSHOT_RETRY_MS,
            reschedule: isImportInProgressError(error),
        };
    } finally {
        backupCreationInFlight = false;
    }
}

function pluginRecoverySnapshotDelay(extraDelayMs = 0) {
    const cooldownDelay = lastBackupTime
        ? Math.max(0, BACKUP_INTERVAL_MS - (Date.now() - lastBackupTime))
        : 0;
    return Math.max(0, cooldownDelay, extraDelayMs);
}

function schedulePluginRecoverySnapshot(extraDelayMs = 0) {
    if (!kvGet(PLUGIN_RECOVERY_SNAPSHOT_DIRTY_KEY)) return;
    if (pluginRecoverySnapshotTimer || pluginRecoverySnapshotRun) return;
    pluginRecoverySnapshotTimer = setTimeout(() => {
        pluginRecoverySnapshotTimer = null;
        let retryAfterMs = 0;
        pluginRecoverySnapshotRun = (async () => {
            try {
                if (!kvGet(PLUGIN_RECOVERY_SNAPSHOT_DIRTY_KEY)) return;
                const result = await createBackupAndRotate();
                retryAfterMs = result?.retryAfterMs ?? PLUGIN_RECOVERY_SNAPSHOT_RETRY_MS;
            } catch (error) {
                retryAfterMs = PLUGIN_RECOVERY_SNAPSHOT_RETRY_MS;
                if (isImportInProgressError(error)) {
                    // Do not spin while an import owns the SQLite connection.
                    // Its replacement state is the next safe recovery point.
                    await importBarrier.waitUntilIdle();
                } else {
                    logger.error('[Plugin storage] Deferred recovery snapshot failed:', error);
                }
            } finally {
                pluginRecoverySnapshotRun = null;
                if (kvGet(PLUGIN_RECOVERY_SNAPSHOT_DIRTY_KEY)) {
                    schedulePluginRecoverySnapshot(retryAfterMs);
                }
            }
        })();
    }, pluginRecoverySnapshotDelay(extraDelayMs));
    pluginRecoverySnapshotTimer.unref?.();
}

function scheduleBackupAndRotate() {
    if (deferredBackupPending) return;
    deferredBackupPending = true;
    setImmediate(async () => {
        try {
            while (true) {
                await importBarrier.waitUntilIdle();
                const result = await createBackupAndRotate();
                if (!result?.reschedule) break;
                await new Promise((resolve) => setTimeout(
                    resolve,
                    Math.max(10, result.retryAfterMs ?? 50),
                ));
            }
        } catch (error) {
            logger.warn('[Snapshot] Deferred snapshot scheduling failed:', error);
        } finally {
            deferredBackupPending = false;
        }
    });
}

async function flushPendingDb({ scheduleSnapshot = true } = {}) {
    let persisted = false;
    if (saveTimers[DB_HEX_KEY] || dbPersistRetryPending) {
        if (saveTimers[DB_HEX_KEY]) clearTimeout(saveTimers[DB_HEX_KEY]);
        delete saveTimers[DB_HEX_KEY];
        if (peekDbCacheValue(DB_HEX_KEY)) {
            try {
                await persistDbCache(DB_HEX_KEY, 'database/database.bin');
                dbPersistRetryPending = false;
                clearPersistFailure();
                persisted = true;
                if (scheduleSnapshot) scheduleBackupAndRotate();
            } catch (error) {
                // Retain an actionable pending state after consuming the timer.
                // A plugin recovery retry must reattempt this database persist,
                // never snapshot dbCache and clear its token over stale live bytes.
                dbPersistRetryPending = Boolean(peekDbCacheValue(DB_HEX_KEY));
                throw error;
            }
        } else {
            // Integrity guards deliberately invalidate malformed cache state.
            // That state is superseded by authoritative live bytes, not retryable.
            dbPersistRetryPending = false;
        }
    }
    return persisted;
}

function invalidateDbCache() {
    invalidateDbCacheEntry(DB_HEX_KEY);
    pluginStorageManifestCache.clear('database-publication-invalidation');
    dbPersistRetryPending = false;
    pendingChatRowDeletions.clear();
    dbEtag = null;
}

function invalidateAllDbCaches() {
    const filePaths = new Set([...dbCache.keys(), ...Object.keys(saveTimers)]);
    filePaths.add(DB_HEX_KEY);
    for (const filePath of filePaths) invalidateDbCacheEntry(filePath);
    pluginStorageManifestCache.clear('destructive-publication-invalidation');
    dbPersistRetryPending = false;
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

async function decodeAuthoritativeDatabase(raw, options = {}) {
    return decodeAuthoritativeRisuSave(raw, {
        resolveRemote: async (name) => {
            const value = kvGet(`remotes/${name}.local.bin`);
            return value || null;
        },
        ...options,
    });
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

    const dbObj = await decodeAuthoritativeDatabase(raw);

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

/**
 * Prove that the live monolith is decodable before any ordinary boot
 * migration is allowed to publish markers, backups, or rewritten rows.
 *
 * This deliberately has no storage writes. REMOTE-backed legacy databases
 * are resolved from their existing rows so a valid pre-migration source does
 * not get mistaken for corruption, while optimized plugin JSON receives the
 * same strict validation used by ingest.
 */
async function preflightBootDatabase(raw) {
    const decoded = await decodeAuthoritativeDatabase(raw);
    const normalized = normalizeJSON(decoded);
    validateDatabaseShape(normalized);
    snapshotOptimizedPluginStorageFields(decoded);
}

async function ingestDatabase(raw, {
    createBackup = false,
    skipLiveRemoteMigration = false,
} = {}) {
    const migration = skipLiveRemoteMigration
        ? { ran: false }
        : await migrateRemoteBlocksIfNeeded();
    const source = migration.ran ? kvGet('database/database.bin') : raw;
    if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
        const inspection = await inspectRisuSaveSource(source);
        if (await shouldStreamRisuSave(source, { inspection })) {
            const result = await ingestDatabaseStreaming(source, { inspection });
            if (createBackup) {
                await createBackupAndRotate({ storageAlreadyExclusive: importInProgress });
            }
            return result;
        }
    }
    const decoded = Buffer.isBuffer(source) || source instanceof Uint8Array
        ? await decodeAuthoritativeDatabase(source)
        : source;
    const dbObj = normalizeJSON(decoded);
    validateDatabaseShape(dbObj);
    const strictPluginStorage = snapshotOptimizedPluginStorageFields(decoded);
    if (strictPluginStorage) {
        dbObj.pluginCustomStorage = strictPluginStorage.values;
        if (strictPluginStorage.hasMeta) dbObj.pluginStorageMeta = strictPluginStorage.meta;
    }

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
    if (createBackup) {
        await createBackupAndRotate({ storageAlreadyExclusive: importInProgress });
    }
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

async function ingestDatabaseStreaming(source, {
    inspection = null,
    shouldAbort,
    signal,
    maxDecodedBytes,
    diskHeadroomBytes,
    availableDiskBytes,
    onDecodedChunk,
} = {}) {
    const streamedPluginValueKeys = new Set();
    const streamedPluginMetaKeys = new Set();
    const streamedPluginRawKeys = new Set();
    let foldedPluginStorage = false;
    const result = await chatRowStore.ingestStreamingDatabase(source, {
        inspection: inspection ?? await inspectRisuSaveSource(source),
        tempDir: savePath,
        shouldAbort,
        signal,
        maxDecodedBytes,
        diskHeadroomBytes,
        availableDiskBytes,
        onDecodedChunk,
        onPluginStorageFolded: async () => {
            foldedPluginStorage = true;
            // The marker is decoded before the walker emits any target rows.
            // Prove the current publication only at that point: an unmarked
            // import must not read large live ownership bodies at all. The
            // async proof releases each decoded row before yielding, remains
            // cancellable, and completes before a same-key target can replace
            // the old bytes that established deletion authority.
            const priorOwnership = await proveStrictPluginStorageOwnershipBoundary({
                shouldAbort,
            });
            await waitAtSnapshotRestoreTestGate(shouldAbort);
            throwIfStreamingRestoreAborted(shouldAbort);
            deleteOwnedPluginStorageRows(priorOwnership);
        },
        onPluginStorageEntry: ({ field, key, value }) => {
            const prefix = field === 'pluginStorageMeta'
                ? PLUGIN_SAVE_META_PREFIX
                : PLUGIN_SAVE_PREFIX;
            const storageKey = encodeValidatedPluginStorageKey(key, prefix);
            kvSet(storageKey, serializePluginStorageRow(storageKey, value));
            (prefix === PLUGIN_SAVE_META_PREFIX
                ? streamedPluginMetaKeys
                : streamedPluginValueKeys).add(storageKey);
            streamedPluginRawKeys.add(key);
        },
        onPluginStorageComplete: ({ dbObj, pluginStats }) => {
            if (!foldedPluginStorage && !pluginStats?.changed) return;
            const generation = foldedPluginStorage
                && typeof dbObj[PLUGIN_STORAGE_GENERATION_FIELD] === 'string'
                && dbObj[PLUGIN_STORAGE_GENERATION_FIELD].length > 0
                ? dbObj[PLUGIN_STORAGE_GENERATION_FIELD]
                : nodeCrypto.randomUUID();
            dbObj[PLUGIN_STORAGE_GENERATION_FIELD] = generation;
            writePluginStorageManifest(createPluginStorageManifest(
                generation,
                streamedPluginValueKeys,
                streamedPluginMetaKeys,
                mergePluginStorageKeyMappings(
                    null,
                    streamedPluginRawKeys,
                    streamedPluginValueKeys,
                    streamedPluginMetaKeys,
                ),
            ));
        },
        onMcpToolCallsFolded: () => {
            kvDelPrefix(MCP_TOOL_CALL_CACHE_PREFIX);
        },
        onMcpToolCallEntry: ({ key, callId, value }) => {
            if (!parseMcpToolCallStorageKey(key)) {
                throw new TypeError(`Invalid remembered MCP tool-call key: ${key}`);
            }
            kvSet(key, serializeMcpToolCallPayload(key, callId, value));
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

function normalizeDecodedDatabaseForRead(rawDecoded) {
    const decoded = normalizeJSON(rawDecoded);
    validateDatabaseShape(decoded);
    const strictPluginStorage = snapshotOptimizedPluginStorageFields(rawDecoded);
    if (strictPluginStorage) {
        decoded.pluginCustomStorage = strictPluginStorage.values;
        if (strictPluginStorage.hasMeta) decoded.pluginStorageMeta = strictPluginStorage.meta;
    }
    return decoded;
}

async function loadStrippedDatabase(raw, source) {
    const inspection = await inspectRisuSaveSource(raw);
    if (kvGet(CHAT_EXTERNALIZATION_MARKER_KEY) === null
        && await shouldStreamRisuSave(raw, { inspection })) {
        logger.warn(`[${source}] Large supported database.bin found; externalizing through the streaming ingest path`);
        return (await ingestDatabaseStreaming(raw, { inspection })).strippedDb;
    }
    const rawDecoded = await decodeAuthoritativeDatabase(raw);
    const decoded = normalizeDecodedDatabaseForRead(rawDecoded);
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

async function prepareLiveDatabaseRead(source, { includeFullBlob = true } = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const selectedRevision = kvGetDatabaseRevision();
        if (selectedRevision === null) {
            const retained = dbCache.metadata(DB_HEX_KEY);
            if (retained?.dirty) throw new DatabaseCacheRevisionConflict();
            dbCache.getForRevision(DB_HEX_KEY, null);
            dbEtag = null;
            return null;
        }

        let cacheStatus = 'hit';
        let strippedDatabase = dbCache.getForRevision(DB_HEX_KEY, selectedRevision);
        if (strippedDatabase) scheduleDbCachePrune();
        if (!strippedDatabase) {
            const retained = dbCache.metadata(DB_HEX_KEY);
            if (retained?.dirty) {
                throw new Error('Cannot replace acknowledged dirty database cache state during a read');
            }

            const raw = await kvGetAsync(DB_BLOB_KEY);
            if (raw === null) continue;
            // The storage queue remains held across the async single-flight read.
            // If defensive migration or an out-of-process writer changes the row
            // during later decoding, retry against the newly authoritative revision.
            if (kvGetDatabaseRevision() !== selectedRevision) continue;
            strippedDatabase = await loadStrippedDatabase(raw, source);
            if (kvGetDatabaseRevision() !== selectedRevision) continue;
            replaceDbCacheValue(DB_HEX_KEY, strippedDatabase, {
                revision: selectedRevision,
                estimatedBytes: raw.length,
                dirty: false,
            });
            cacheStatus = 'miss';
        }

        let fullBlob;
        let etag;
        if (includeFullBlob) {
            const prepared = prepareDatabaseReadPayload(strippedDatabase);
            fullBlob = prepared.fullBlob;
            etag = prepared.etag;
            if (dbCache.has(DB_HEX_KEY)) seedDbCacheEtag(DB_HEX_KEY, etag);
        } else if (dbCache.has(DB_HEX_KEY)) {
            etag = getDbCacheEtag(DB_HEX_KEY);
        } else {
            etag = computeDatabaseEtagFromObject(strippedDatabase);
        }
        dbEtag = etag;
        return { strippedDatabase, fullBlob, etag, cacheStatus, revision: selectedRevision };
    }
    throw new Error('Database changed repeatedly while preparing an authoritative read');
}

async function loadPatchCache(filePath, decodedKey) {
    if (decodedKey !== DB_BLOB_KEY) {
        const cached = getDbCacheValue(filePath);
        if (cached) return cached;
        const fileContent = kvGet(decodedKey);
        const decoded = fileContent
            ? normalizeJSON(await decodeRisuSave(fileContent))
            : {};
        replaceDbCacheValue(filePath, decoded, {
            revision: null,
            estimatedBytes: fileContent?.length ?? 0,
            dirty: false,
        });
        return decoded;
    }

    for (let attempt = 0; attempt < 3; attempt++) {
        const revision = kvGetDatabaseRevision();
        const retained = dbCache.metadata(filePath);
        if (retained?.dirty) {
            if (retained.revision !== revision) {
                releaseDbCacheCanonicalEncoding(filePath, 'external-revision-conflict');
                throw new DatabaseCacheRevisionConflict();
            }
            return peekDbCacheValue(filePath);
        }
        const cached = dbCache.getForRevision(filePath, revision);
        if (cached) {
            scheduleDbCachePrune();
            return cached;
        }

        const fileContent = kvGet(decodedKey);
        if (fileContent === null) {
            if (kvGetDatabaseRevision() !== revision) continue;
            const empty = {};
            replaceDbCacheValue(filePath, empty, {
                revision: null,
                estimatedBytes: 0,
                dirty: false,
            });
            return empty;
        }
        if (kvGetDatabaseRevision() !== revision) continue;
        const decoded = await loadStrippedDatabase(fileContent, 'Patch');
        if (kvGetDatabaseRevision() !== revision) continue;
        replaceDbCacheValue(filePath, decoded, {
            revision,
            estimatedBytes: fileContent.length,
            dirty: false,
        });
        return decoded;
    }
    throw new Error('Database changed repeatedly while preparing a patch');
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

async function migrateCharacterDefaultsIfNeeded() {
    if (kvGet(CHARACTER_DEFAULTS_MARKER_KEY) !== null) return;
    const raw = kvGet('database/database.bin');
    if (!raw) {
        kvSet(CHARACTER_DEFAULTS_MARKER_KEY, CHARACTER_DEFAULTS_MARKER_VALUE);
        logger.info('[Migration] Character-defaults marker initialized (no database present)');
        return;
    }

    const rawDecoded = await decodeAuthoritativeDatabase(raw);
    const strictPluginStorage = snapshotOptimizedPluginStorageFields(rawDecoded);
    const decoded = normalizeJSON(rawDecoded);
    validateDatabaseShape(decoded);
    if (strictPluginStorage) {
        decoded.pluginCustomStorage = strictPluginStorage.values;
        if (strictPluginStorage.hasMeta) decoded.pluginStorageMeta = strictPluginStorage.meta;
    }
    applyDatabaseCharacterDefaults(decoded, nodeCrypto.randomUUID);
    const reEncoded = Buffer.from(encodeRisuSaveLegacy(decoded));
    const backupKey = `migration-backup/pre-character-defaults-${Date.now()}.bin`;

    sqliteDb.transaction(() => {
        kvCopyValue('database/database.bin', backupKey);
        kvSet('database/database.bin', reEncoded);
        kvSet(CHARACTER_DEFAULTS_MARKER_KEY, CHARACTER_DEFAULTS_MARKER_VALUE);
    })();

    // The authoritative re-encode can change RisuSave framing, raw ETag, and
    // stored size while preserving the logical database. Readers revalidate
    // those byte-derived values on their next request.
    invalidateDbCache();
    dbEtag = null;
    logger.info(`[Migration] Character defaults persisted; safety backup at ${backupKey}`);
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

function duplicateChatIdSample(duplicates) {
    return duplicates.slice(0, 3).map(duplicate => {
        const characterLabel = duplicate.chaId ?? `character[${duplicate.characterIndex}]`;
        return `${characterLabel}/${duplicate.chatId}`;
    }).join(', ');
}

function diffReferencedChatRowKeys(oldStrippedDb, newStrippedDb) {
    const oldKeys = chatRowStore.referencedChatRowKeys(oldStrippedDb);
    const newKeys = chatRowStore.referencedChatRowKeys(newStrippedDb);
    let changed = oldKeys.size !== newKeys.size;
    for (const key of oldKeys) {
        if (!newKeys.has(key)) changed = true;
    }
    for (const key of newKeys) {
        if (!oldKeys.has(key)) changed = true;
    }
    return { changed, newKeys, oldKeys };
}

function trackPendingChatRowDeletions({ oldKeys, newKeys }) {
    for (const key of oldKeys) {
        if (!newKeys.has(key)) pendingChatRowDeletions.add(key);
    }
    for (const key of newKeys) {
        pendingChatRowDeletions.delete(key);
    }
}

async function captureChatDeletionPreImages(chatRowKeys) {
    for (const key of chatRowKeys) {
        const identity = chatRowStore.parseChatRowKey(key);
        if (!identity) {
            throw new Error(`Could not decode pending chat-row deletion key: ${key}`);
        }
        const result = await chatBackupStore.captureChatPreImage({
            ...identity,
            reason: 'delete-chat',
            force: true,
            required: true,
        });
        if (result !== 'captured' && result !== 'skipped-no-row') {
            throw new Error(
                `Required chat deletion pre-image was not captured for ${identity.chaId}/${identity.chatId}: ${result}`
            );
        }
    }
}

/**
 * Persist the stubs-only patch cache.
 */
async function persistDbCache(filePath, decodedKey) {
    const generation = dbDerivedValueMemo.generation(filePath);
    let succeeded = false;
    try {
        await persistDbCacheGeneration(filePath, decodedKey, generation);
        succeeded = true;
    } finally {
        if (decodedKey === DB_BLOB_KEY) {
            releaseDbCacheCanonicalEncoding(
                filePath,
                succeeded ? 'persist-success' : 'persist-error',
                generation,
            );
        }
    }
}

function dbCachePersistenceOptions({
    filePath,
    decodedKey,
    generation,
    cachedDb,
    cacheMetadata,
}) {
    const assertCurrent = () => {
        if (decodedKey !== DB_BLOB_KEY) return;
        if (cacheMetadata?.revision !== kvGetDatabaseRevision()
            || dbDerivedValueMemo.generation(filePath) !== generation
            || peekDbCacheValue(filePath) !== cachedDb
            || dbCache.metadata(filePath)?.revision !== cacheMetadata?.revision) {
            throw new DatabaseCacheRevisionConflict();
        }
    };
    return {
        cachedDb,
        decodedKey,
        assertCurrent,
        findDuplicateChatIds,
        preparePluginStorageExternalization,
        retainCanonicalEncoding: () => retainDbCacheCanonicalEncoding(filePath),
        encodeRisuSaveLegacy,
        sqliteDb,
        writePluginStorageRows,
        writePluginStorageManifest,
        kvSet,
        kvDel,
        kvGetDatabaseRevision,
    };
}

function handleDbCachePersistenceGuard(error) {
    if (!(error instanceof DbCachePersistenceGuardError)) return;
    recordPersistFailure(error, error.guard === 'stub-flag-loss'
        ? 'persistDbCache:stub-flag-loss'
        : 'persistDbCache:duplicate-chat-ids');
    invalidateDbCache();
}

async function persistDbCacheGeneration(filePath, decodedKey, generation) {
    const cachedDb = peekDbCacheValue(filePath);
    if (!cachedDb) return;
    const cacheMetadata = dbCache.metadata(filePath);
    const persistenceOptions = dbCachePersistenceOptions({
        filePath,
        decodedKey,
        generation,
        cachedDb,
        cacheMetadata,
    });
    let prepared;
    try {
        prepared = prepareDbCachePersistence(persistenceOptions);
    } catch (error) {
        handleDbCachePersistenceGuard(error);
        throw error;
    }
    const referencedChatRows = decodedKey === 'database/database.bin'
        ? chatRowStore.referencedChatRowKeys(prepared.strippedDb)
        : new Set();
    const chatRowsToDelete = decodedKey === 'database/database.bin'
        ? [...pendingChatRowDeletions].filter(key => !referencedChatRows.has(key))
        : [];
    await captureChatDeletionPreImages(chatRowsToDelete);
    const committed = commitPreparedDbCachePersistence({
        ...persistenceOptions,
        prepared,
        chatRowsToDelete,
    });
    if (decodedKey === 'database/database.bin') {
        replaceDbCacheValue(filePath, committed.strippedDb, {
            revision: committed.committedRevision,
            estimatedBytes: committed.data.length,
            dirty: false,
            preserveSegmentMemo: true,
        });
        pendingChatRowDeletions.clear();
    }
}

function shouldCompress(req, res) {
    // Proxy/hub-proxy: pass through external responses without compression.
    // Original upstream server has no compression middleware at all,
    // so proxy responses were never compressed in the first place.
    const url = req.originalUrl || req.url;
    if (url.startsWith('/proxy')
        || url.startsWith('/hub-proxy')
        || url.startsWith('/api/backup/export')
        || url.startsWith('/api/backup/server/download/')
        || url.startsWith('/api/plugin-storage/state/raw')) {
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
if (isRequestTracingEnabled()) {
    console.warn(
        '[RequestTrace] Request tracing is active because TRACE_REQUEST_FOR_DEBUG=true. '
        + 'Trace files may contain sensitive data and request tracing is not recommended '
        + 'outside debugging sessions.',
    );
    const requestTracer = createRequestTracer({
        traceDir: path.join(process.cwd(), 'save', 'trace'),
        maxTraces: 500,
        isStreamingRequest: req => Boolean(req[ADMITTED_INGRESS_SPOOL])
            || isStreamedIngress(req),
        onError: (context, error) => logger.warn(
            `[RequestTrace] Failed while ${context}: ${error?.stack || error}`,
        ),
    });
    app.use(requestTracer.middleware);
}
// Vite 산출물은 해시 파일명이므로 /assets는 장기 캐시 안전
app.use('/assets', express.static(path.join(process.cwd(), 'dist/assets'), {
    maxAge: '1y',
    immutable: true,
}));
app.use(express.static(path.join(process.cwd(), 'dist'), {index: false, maxAge: 0}));
const bufferedIngressLimits = createBufferedIngressLimits({
    pluginValueMaxBytes: PLUGIN_VALUE_MAX_BYTES,
    pluginStorageMaxBytes: PLUGIN_STORAGE_MAX_BYTES,
    pluginBatchMaxBytes: PLUGIN_STORAGE_BATCH_MAX_BODY_BYTES,
});
const bufferedIngressBudget = createInFlightByteBudget(bufferedIngressLimits.global);
app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
        res.setHeader(WRITER_EPOCH_HEADER, sessionLock.epoch());
    }
    next();
});
app.use(createBufferedIngressMiddleware({
    resolvePolicy: createRoutePolicyResolver(bufferedIngressLimits),
    budget: bufferedIngressBudget,
    authenticate: (req, res, allowExpired) => checkAuth(
        req,
        res,
        false,
        { allowExpired },
    ),
    authenticateCookie: (req, res) => checkSessionCookieAuth(req, res),
    writerState: (req) => sessionLock.peek(
        typeof req.headers['x-session-id'] === 'string'
            ? req.headers['x-session-id']
            : '',
        typeof req.headers[WRITER_EPOCH_HEADER] === 'string'
            ? req.headers[WRITER_EPOCH_HEADER]
            : '',
    ),
    expectedClientBuild,
}));
app.use(createAdmittedIngressSpoolMiddleware({
    policySymbol: BUFFERED_INGRESS_POLICY,
    spoolDir: () => databaseSpoolDir,
    disabled: process.env.NODE_ENV === 'test'
        && process.env.POCKETRISU_TEST_DISABLE_ADMITTED_SPOOL === '1',
    globalBudgetBytes: bufferedIngressLimits.global,
}));
app.use((req, res, next) => {
    if (req.path === '/api/db/read-cached') return next();
    if (req[ADMITTED_INGRESS_SPOOL]) return next();
    const policy = req[BUFFERED_INGRESS_POLICY];
    const parser = express.json({
        type: ['application/json', CHAT_DELTA_CONTENT_TYPE],
        limit: policy?.bodyKind === 'json'
            ? policy.maxBytes
            : bufferedIngressLimits.json,
    });
    return parser(req, res, next);
});
app.use((req, res, next) => {
    // These endpoints consume the request stream directly and must never be
    // pre-buffered by the generic octet-stream parser.
    if (req[ADMITTED_INGRESS_SPOOL]) return next();
    if (isStreamedIngress(req)) return next();
    const isPluginStorageBatch = req.path === '/api/plugin-storage/batch';
    const isBufferedPluginMutationSet = req.path === '/api/plugin-storage/mutate'
        && req.headers['x-plugin-storage-operation'] === 'set';
    const isPluginManifestMutation = req.path === '/api/plugin-storage/mutate'
        && req.headers['x-plugin-storage-operation'] === undefined;
    let pluginLegacyWrite = false;
    if (req.path === '/api/write') {
        const encodedPath = req.headers['file-path'];
        if (typeof encodedPath === 'string' && /^[0-9a-fA-F]+$/.test(encodedPath)) {
            pluginLegacyWrite = Buffer.from(encodedPath, 'hex')
                .toString('utf-8')
                .startsWith(PLUGIN_SAVE_PREFIX);
        }
    }
    const admissionPolicy = req[BUFFERED_INGRESS_POLICY];
    const parser = express.raw({
        type: 'application/octet-stream',
        limit: admissionPolicy?.bodyKind === 'raw'
            ? admissionPolicy.maxBytes
            : isPluginStorageBatch
            ? PLUGIN_STORAGE_BATCH_MAX_BODY_BYTES
            : (pluginLegacyWrite || isBufferedPluginMutationSet)
                ? PLUGIN_VALUE_MAX_BYTES
                : isPluginManifestMutation
                    ? PLUGIN_STORAGE_MAX_BYTES
                : '2gb',
    });
    return parser(req, res, (error) => {
        if (!error) return next();
        const tooLarge = error.type === 'entity.too.large';
        if (pluginLegacyWrite && tooLarge) {
            return res.status(413).json({
                error: `Plugin value exceeds the ${PLUGIN_VALUE_MAX_BYTES}-byte per-value limit. Split the value into smaller records.`,
                code: 'PLUGIN_VALUE_TOO_LARGE',
                limit: PLUGIN_VALUE_MAX_BYTES,
                retryable: false,
                commitOutcome: 'not-committed',
                commitOutcomeUnknown: false,
            });
        }
        if (isBufferedPluginMutationSet && tooLarge) {
            return res.status(413).json({
                success: false,
                outcome: 'not-committed',
                operation: 'set',
                error: `Plugin value exceeds the ${PLUGIN_VALUE_MAX_BYTES}-byte per-value limit. Split the value into smaller records.`,
                code: 'PLUGIN_VALUE_TOO_LARGE',
                limit: PLUGIN_VALUE_MAX_BYTES,
                actual: Number(req.headers['content-length']) || PLUGIN_VALUE_MAX_BYTES + 1,
                retryable: false,
            });
        }
        if (!isPluginStorageBatch) return next(error);
        return res.status(tooLarge ? 413 : 400).json({
            success: false,
            outcome: 'not-committed',
            operation: 'batch',
            error: tooLarge
                ? 'Plugin storage batch body exceeds the 16 MiB limit.'
                : 'Plugin storage batch body could not be read.',
            code: 'INVALID_PLUGIN_STORAGE_BATCH',
            retryable: false,
        });
    });
});
app.use((req, res, next) => {
    const policy = req[BUFFERED_INGRESS_POLICY];
    return express.text({
        limit: policy?.bodyKind === 'text'
            ? policy.maxBytes
            : bufferedIngressLimits.json,
    })(req, res, next);
});
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
const BACKUP_IMPORT_SPOOL_FILE_PREFIX = '.backup-import-';
const BACKUP_ENTRY_STAGE_PREFIX = '.backup-entry-stage-';
const PARTIAL_EXPORT_JOB_PREFIX = '.partial-export-';
const FULL_EXPORT_PIN_PREFIX = '.full-export-';
const SERVER_BACKUP_TEMP_PREFIX = '.risu-backup-save-';
const DRAFT_PREFIX = 'drafts/';
const configuredPartialExportJobTtlMs = Number(
    process.env.NODE_ENV === 'test'
        ? process.env.POCKETRISU_TEST_PARTIAL_EXPORT_TTL_MS
        : NaN,
);
const PARTIAL_EXPORT_JOB_TTL_MS = Number.isSafeInteger(configuredPartialExportJobTtlMs)
    && configuredPartialExportJobTtlMs >= 100
    ? configuredPartialExportJobTtlMs
    : 15 * 60 * 1000;
const configuredPartialExportGcIntervalMs = Number(
    process.env.NODE_ENV === 'test'
        ? process.env.POCKETRISU_TEST_PARTIAL_EXPORT_GC_INTERVAL_MS
        : NaN,
);
const PARTIAL_EXPORT_GC_INTERVAL_MS = Number.isSafeInteger(configuredPartialExportGcIntervalMs)
    && configuredPartialExportGcIntervalMs >= 10
    ? configuredPartialExportGcIntervalMs
    : 60 * 1000;
// A client can time out its create POST and send DELETE before the POST reaches
// admission. Remember that exact owner/id cancellation for a bounded window so
// the delayed create cannot resurrect a job after cleanup appeared to succeed.
const PARTIAL_EXPORT_CANCELLATION_TTL_MS = 15 * 60 * 1000;
const PARTIAL_EXPORT_MAX_CANCELLATION_TOMBSTONES = 256;
// This is a single-user server and each job can hold a WAL snapshot plus two
// archive-sized spools. Serial admission makes the statfs preflight an actual
// reservation instead of letting concurrent jobs all spend the same bytes.
const PARTIAL_EXPORT_MAX_ACTIVE_JOBS = 1;
const PLUGIN_VALUE_SPOOL_FILE_PREFIX = '.plugin-value-';
const PLUGIN_BATCH_VALUE_SPOOL_FILE_PREFIX = '.plugin-batch-value-';
const PLUGIN_RECOVERY_DOWNLOAD_SPOOL_FILE_PREFIX = '.plugin-recovery-download-';
const PLUGIN_TRANSITION_STAGE_PREFIX = '.plugin-transition-stage-';
const PLUGIN_TRANSITION_STAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// A mode transition must accept every row that optimized storage itself can
// legally publish. Preserve the historical 32 MiB staging floor when an
// operator configures a smaller publication quota; the atomic finalize step
// remains authoritative for that quota.
const PLUGIN_TRANSITION_MAX_ROW_BYTES = Math.max(
    32 * 1024 * 1024,
    PLUGIN_VALUE_MAX_BYTES,
);
// POCKETRISU_SPOOL_DIR may relocate temporary database assembly. The default
// remains on the writable save volume and is independent of server backups.
const configuredDatabaseSpoolDir = String(process.env.POCKETRISU_SPOOL_DIR ?? '').trim();
const databaseSpoolDir = configuredDatabaseSpoolDir
    ? path.resolve(configuredDatabaseSpoolDir)
    : path.join(savePath, '.spool');
// Filesystem asset pins stay on the save volume so an export can take one
// coherent SQLite/filesystem cut without relying on cross-device links.
const partialExportSpoolDir = path.join(savePath, '.partial-export-spool');
let databaseSpoolReady = true;
const pluginTransitionStageDir = path.join(savePath, '.plugin-transition-staging');
try {
    mkdirSync(databaseSpoolDir, { recursive: true });
    mkdirSync(partialExportSpoolDir, { recursive: true, mode: 0o700 });
    mkdirSync(pluginTransitionStageDir, { recursive: true, mode: 0o700 });
} catch (error) {
    databaseSpoolReady = false;
    logger.error(`[Backup] Could not create database spool directory ${databaseSpoolDir}:`, error);
}
try {
    for (const entry of readdirSync(partialExportSpoolDir, { withFileTypes: true })) {
        if (!entry.name.startsWith(PARTIAL_EXPORT_JOB_PREFIX)
            && !entry.name.startsWith(FULL_EXPORT_PIN_PREFIX)) continue;
        fsSync.rmSync(path.join(partialExportSpoolDir, entry.name), {
            recursive: true,
            force: true,
        });
    }
} catch (error) {
    logger.warn('[Backup] Could not sweep partial export spool directory:', error);
}
if (databaseSpoolReady) {
    try {
        for (const entry of readdirSync(databaseSpoolDir, { withFileTypes: true })) {
            if (
                entry.name.startsWith(PARTIAL_EXPORT_JOB_PREFIX)
                && entry.name !== path.basename(partialExportSpoolDir)
            ) {
                try {
                    fsSync.rmSync(path.join(databaseSpoolDir, entry.name), {
                        recursive: true,
                        force: true,
                    });
                } catch (error) {
                    logger.warn(`[Backup] Could not remove orphaned partial export ${entry.name}:`, error);
                }
                continue;
            }
            if (entry.isDirectory() && entry.name.startsWith(SAVE_FOLDER_IMPORT_STAGE_PREFIX)) {
                try {
                    fsSync.rmSync(path.join(databaseSpoolDir, entry.name), {
                        recursive: true,
                        force: true,
                    });
                } catch (error) {
                    logger.warn(`[Backup] Could not remove orphaned save-folder import ${entry.name}:`, error);
                }
                continue;
            }
            if (entry.isDirectory() && entry.name.startsWith(BACKUP_ENTRY_STAGE_PREFIX)) {
                try {
                    fsSync.rmSync(path.join(databaseSpoolDir, entry.name), {
                        recursive: true,
                        force: true,
                    });
                } catch (error) {
                    logger.warn(`[Backup] Could not remove orphaned backup-entry stage ${entry.name}:`, error);
                }
                continue;
            }
            if (!entry.isFile() || !(
                entry.name.startsWith(DATABASE_SPOOL_FILE_PREFIX)
                || entry.name.startsWith(BACKUP_IMPORT_SPOOL_FILE_PREFIX)
                || entry.name.startsWith(PLUGIN_VALUE_SPOOL_FILE_PREFIX)
                || entry.name.startsWith(PLUGIN_BATCH_VALUE_SPOOL_FILE_PREFIX)
                || entry.name.startsWith(PLUGIN_RECOVERY_DOWNLOAD_SPOOL_FILE_PREFIX)
                || entry.name.startsWith(ADMITTED_INGRESS_SPOOL_PREFIX)
            )) continue;
            try {
                unlinkSync(path.join(databaseSpoolDir, entry.name));
            } catch (error) {
                logger.warn(`[Backup] Could not remove orphaned spool file ${entry.name}:`, error);
            }
        }
        for (const entry of readdirSync(databaseSpoolDir, { withFileTypes: true })) {
            if (!entry.isDirectory() || !entry.name.startsWith(ADMITTED_WRITE_STAGE_PREFIX)) {
                continue;
            }
            try {
                fsSync.rmSync(path.join(databaseSpoolDir, entry.name), {
                    recursive: true,
                    force: true,
                });
            } catch (error) {
                logger.warn(`[Backup] Could not remove orphaned admitted-write stage ${entry.name}:`, error);
            }
        }
    } catch (error) {
        logger.warn(`[Backup] Could not sweep database spool directory ${databaseSpoolDir}:`, error);
    }
}

function pluginTransitionStageMetaPath(transitionId) {
    if (!PLUGIN_STORAGE_UUID_PATTERN.test(transitionId)) {
        throw new TypeError('Plugin transition id must be a canonical UUID');
    }
    return path.join(
        pluginTransitionStageDir,
        `${PLUGIN_TRANSITION_STAGE_PREFIX}${transitionId}.json`,
    );
}

function pluginTransitionStageRowPath(transitionId, index) {
    if (!Number.isSafeInteger(index) || index < 0 || index > 100_000) {
        throw new TypeError('Invalid plugin transition row index');
    }
    return path.join(
        pluginTransitionStageDir,
        `${PLUGIN_TRANSITION_STAGE_PREFIX}${transitionId}-${index}.row`,
    );
}

function readPluginTransitionStage(transitionId) {
    try {
        const value = JSON.parse(readFileSync(
            pluginTransitionStageMetaPath(transitionId),
            'utf-8',
        ));
        if (value?.version !== 1 || value.transitionId !== transitionId) return null;
        return value;
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

function writePluginTransitionStage(stage) {
    const metaPath = pluginTransitionStageMetaPath(stage.transitionId);
    const temporaryPath = `${metaPath}.${process.pid}.${nodeCrypto.randomUUID()}.tmp`;
    try {
        writeFileSync(temporaryPath, JSON.stringify(stage), { encoding: 'utf-8', flag: 'wx' });
        const fileDescriptor = openSync(temporaryPath, 'r');
        try {
            fsyncSync(fileDescriptor);
        } finally {
            closeSync(fileDescriptor);
        }
        renameSync(temporaryPath, metaPath);
        fsyncPluginTransitionStageDirectory();
    } catch (error) {
        try { unlinkSync(temporaryPath); } catch {}
        throw error;
    }
}

function fsyncPluginTransitionStageDirectory() {
    // POSIX requires the containing directory to be synced for a newly
    // created or renamed entry to survive power loss. Some platforms reject
    // opening directories; the row/receipt file itself is still synced there.
    let directoryDescriptor = null;
    try {
        directoryDescriptor = openSync(pluginTransitionStageDir, 'r');
        fsyncSync(directoryDescriptor);
    } catch {}
    finally {
        if (directoryDescriptor !== null) closeSync(directoryDescriptor);
    }
}

function pluginTransitionStageBelongsToRequest(stage, req) {
    if (!stage) return false;
    const requestSessionId = typeof req.headers['x-session-id'] === 'string'
        ? req.headers['x-session-id']
        : null;
    return stage.sessionId === requestSessionId;
}

function removePluginTransitionStage(stage) {
    if (!stage) return;
    const prefix = `${PLUGIN_TRANSITION_STAGE_PREFIX}${stage.transitionId}`;
    for (const entry of readdirSync(pluginTransitionStageDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
        const suffix = entry.name.slice(prefix.length);
        if (suffix !== '.json' && !suffix.startsWith('-') && !suffix.startsWith('.json.')) continue;
        try { unlinkSync(path.join(pluginTransitionStageDir, entry.name)); } catch {}
    }
    fsyncPluginTransitionStageDirectory();
}

function removePluginTransitionStageRows(stage) {
    if (!stage) return;
    const prefix = `${PLUGIN_TRANSITION_STAGE_PREFIX}${stage.transitionId}-`;
    for (const entry of readdirSync(pluginTransitionStageDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
        try { unlinkSync(path.join(pluginTransitionStageDir, entry.name)); } catch {}
    }
    fsyncPluginTransitionStageDirectory();
}

async function findActivePluginTransition(req, excludeTransitionId = null) {
    const requestSessionId = typeof req.headers['x-session-id'] === 'string'
        ? req.headers['x-session-id']
        : null;
    for (const entry of readdirSync(pluginTransitionStageDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const match = entry.name.match(
            /^\.plugin-transition-stage-([0-9a-f-]{36})\.json$/,
        );
        if (!match || match[1] === excludeTransitionId) continue;
        const stage = await refreshPluginTransitionStageState(
            readPluginTransitionStage(match[1]),
        );
        if (!stage || (stage.state !== 'uploading' && stage.state !== 'ready')) continue;
        // A page reload creates a new writer session. Once that session owns
        // the server lock, an unpublished stage from the displaced page can
        // no longer be finalized and must not block recovery forever.
        if (stage.sessionId !== requestSessionId) {
            removePluginTransitionStage(stage);
            continue;
        }
        return stage;
    }
    return null;
}

function sweepStalePluginTransitionStages() {
    if (!databaseSpoolReady) return;
    try {
        const now = Date.now();
        for (const entry of readdirSync(pluginTransitionStageDir, { withFileTypes: true })) {
            if (!entry.isFile()
                || !entry.name.startsWith(PLUGIN_TRANSITION_STAGE_PREFIX)
                || !entry.name.endsWith('.json')) continue;
            const match = entry.name.match(
                /^\.plugin-transition-stage-([0-9a-f-]{36})\.json$/,
            );
            if (!match || !PLUGIN_STORAGE_UUID_PATTERN.test(match[1])) continue;
            const stage = readPluginTransitionStage(match[1]);
            if (!stage
                || stage.state === 'aborted'
                || now - Number(stage.updatedAt ?? stage.createdAt ?? 0)
                    > PLUGIN_TRANSITION_STAGE_MAX_AGE_MS) {
                removePluginTransitionStage(stage ?? { transitionId: match[1], rows: [] });
            }
        }
        for (const entry of readdirSync(pluginTransitionStageDir, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.startsWith(PLUGIN_TRANSITION_STAGE_PREFIX)) continue;
            if (entry.name.endsWith('.json')) continue;
            const match = entry.name.match(
                /^\.plugin-transition-stage-([0-9a-f-]{36})-/,
            );
            const stage = match && PLUGIN_STORAGE_UUID_PATTERN.test(match[1])
                ? readPluginTransitionStage(match[1])
                : null;
            if (!stage || stage.state === 'committed' || stage.state === 'aborted') {
                try { unlinkSync(path.join(pluginTransitionStageDir, entry.name)); } catch {}
            }
        }
    } catch (error) {
        logger.warn('[PluginStorageTransition] Could not sweep stale stages:', error);
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
function sweepServerBackupTemps(directory) {
    try {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.startsWith(SERVER_BACKUP_TEMP_PREFIX)) continue;
            try {
                unlinkSync(path.join(directory, entry.name));
            } catch (error) {
                logger.warn(`[Backup] Could not remove orphaned server backup temp ${entry.name}:`, error);
            }
        }
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            logger.warn(`[Backup] Could not sweep server backup directory ${directory}:`, error);
        }
    }
}
sweepServerBackupTemps(backupsDir);
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
const INLAY_TEMP_PREFIX = '.inlay-publish-'
const INLAY_TEMP_NAME_PATTERN = /^\.inlay-publish-\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-(?:payload|sidecar)$/i
const inlayPublishFailpoint = process.env.NODE_ENV === 'test'
    ? String(process.env.POCKETRISU_TEST_INLAY_PUBLISH_FAILPOINT ?? '').trim()
    : ''
const inlayPublishTestGateDir = process.env.NODE_ENV === 'test'
    ? String(process.env.POCKETRISU_TEST_INLAY_PUBLISH_GATE_DIR ?? '').trim() || null
    : null
const inlayPublishTestGateStage = process.env.NODE_ENV === 'test'
    ? String(process.env.POCKETRISU_TEST_INLAY_PUBLISH_GATE_STAGE ?? '').trim()
    : ''
const IMPORT_JOURNAL_PATH = path.join(savePath, 'import_journal.json')
const IMPORT_JOURNAL_MARKER_KEY = 'import_journal/marker'
const hexRegex = /^[0-9a-fA-F]+$/;
const DEFAULT_BACKUP_IMPORT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
// Large restore is an explicit, authenticated recovery action.  Keep ordinary
// API callers behind the conservative soft limits while allowing the UI (after
// its destructive-restore confirmations) and trusted server backups to use all
// safely representable space that the disk preflight can admit.
const DEFAULT_LARGE_RESTORE_MAX_BYTES = Math.floor(Number.MAX_SAFE_INTEGER / 2);
const DEFAULT_LEGACY_DATABASE_IMPORT_MAX_BYTES = 64 * 1024 * 1024;
const BACKUP_IMPORT_MAX_BYTES = finiteByteLimit(
    process.env.RISU_BACKUP_IMPORT_MAX_BYTES,
    DEFAULT_BACKUP_IMPORT_MAX_BYTES,
);
const LEGACY_DATABASE_IMPORT_MAX_BYTES = finiteByteLimit(
    process.env.RISU_LEGACY_DATABASE_IMPORT_MAX_BYTES,
    DEFAULT_LEGACY_DATABASE_IMPORT_MAX_BYTES,
    { max: BACKUP_IMPORT_MAX_BYTES },
);
const SAVE_FOLDER_IMPORT_MAX_ENTRIES = finiteByteLimit(
    process.env.RISU_SAVE_FOLDER_IMPORT_MAX_ENTRIES,
    100_000,
    { max: 1_000_000 },
);
const BACKUP_IMPORT_MAX_ENTRIES = finiteByteLimit(
    process.env.RISU_BACKUP_IMPORT_MAX_ENTRIES,
    100_000,
    { max: 1_000_000 },
);
const LARGE_RESTORE_MAX_BYTES = finiteByteLimit(
    process.env.RISU_LARGE_RESTORE_MAX_BYTES,
    DEFAULT_LARGE_RESTORE_MAX_BYTES,
    { max: DEFAULT_LARGE_RESTORE_MAX_BYTES },
);
const LARGE_RESTORE_MAX_ENTRIES = finiteByteLimit(
    process.env.RISU_LARGE_RESTORE_MAX_ENTRIES,
    Number.MAX_SAFE_INTEGER,
);
const IMPORT_BUFFERED_ENTRY_MAX_BYTES = finiteByteLimit(
    process.env.RISU_IMPORT_BUFFERED_ENTRY_MAX_BYTES,
    32 * 1024 * 1024,
    { max: BACKUP_IMPORT_MAX_BYTES },
);
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
const REPLACEMENT_OPERATION_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REPLACEMENT_OPERATION_RETENTION_MS = Math.max(
    60_000,
    Number(process.env.POCKETRISU_REPLACEMENT_OPERATION_RETENTION_MS ?? 24 * 60 * 60 * 1000)
        || 24 * 60 * 60 * 1000,
);

const insertReplacementOperation = sqliteDb.prepare(`
    INSERT INTO replacement_operations (
        operation_id, kind, state, result_json, error_json, created_at, updated_at
    ) VALUES (?, ?, 'running', NULL, NULL, ?, ?)
`);
const updateReplacementOperation = sqliteDb.prepare(`
    UPDATE replacement_operations
    SET state = ?, result_json = ?, error_json = ?, updated_at = ?
    WHERE operation_id = ?
`);
const readReplacementOperation = sqliteDb.prepare(`
    SELECT operation_id, kind, state, result_json, error_json, created_at, updated_at
    FROM replacement_operations
    WHERE operation_id = ?
`);
const deleteExpiredReplacementOperations = sqliteDb.prepare(`
    DELETE FROM replacement_operations
    WHERE state != 'running' AND updated_at < ?
`);

// A running record is committed before destructive work begins. Every actual
// publication writes `committed` inside its data transaction, so a process
// restart can safely classify any leftover running record as not committed.
sqliteDb.prepare(`
    UPDATE replacement_operations
    SET state = 'not-committed',
        error_json = ?,
        updated_at = ?
    WHERE state = 'running'
`).run(JSON.stringify({
    message: 'The server restarted before the replacement committed.',
    code: 'REPLACEMENT_INTERRUPTED',
    retryable: true,
}), Date.now());
deleteExpiredReplacementOperations.run(Date.now() - REPLACEMENT_OPERATION_RETENTION_MS);

function replacementOperationId(req) {
    const value = req.headers['x-risu-replacement-id'];
    return typeof value === 'string' && REPLACEMENT_OPERATION_ID_REGEX.test(value)
        ? value
        : null;
}

function registerReplacementOperation(req, kind) {
    const operationId = replacementOperationId(req);
    if (!operationId) {
        const error = new Error('A canonical replacement operation ID is required');
        error.code = 'INVALID_REPLACEMENT_OPERATION_ID';
        error.statusCode = 400;
        throw error;
    }
    const now = Date.now();
    deleteExpiredReplacementOperations.run(now - REPLACEMENT_OPERATION_RETENTION_MS);
    try {
        insertReplacementOperation.run(operationId, kind, now, now);
    } catch (error) {
        if (error?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
            || error?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            const conflict = new Error('Replacement operation ID already exists');
            conflict.code = 'REPLACEMENT_OPERATION_EXISTS';
            conflict.statusCode = 409;
            throw conflict;
        }
        throw error;
    }
    return operationId;
}

function setReplacementOperationOutcome(operationId, state, { result = null, error = null } = {}) {
    if (!operationId) return;
    updateReplacementOperation.run(
        state,
        result === null ? null : JSON.stringify(result),
        error === null ? null : JSON.stringify(error),
        Date.now(),
        operationId,
    );
}

function replacementErrorRecord(error, fallbackCode) {
    const annotated = authoritativeImportErrorPayload(error, fallbackCode);
    return annotated ?? {
        message: String(error?.message ?? 'Replacement failed'),
        code: String(error?.code ?? fallbackCode),
        retryable: false,
    };
}

function finalizeReplacementOperationError(operationId, error, fallbackCode) {
    if (!operationId) return;
    const existing = readReplacementOperation.get(operationId);
    if (!existing || existing.state === 'committed') return;
    const annotated = authoritativeImportErrorPayload(error, fallbackCode);
    const state = annotated?.commitOutcome === 'unknown'
        ? 'unknown'
        : annotated?.commitOutcome === 'committed'
            ? 'committed'
            : 'not-committed';
    setReplacementOperationOutcome(operationId, state, {
        error: replacementErrorRecord(error, fallbackCode),
    });
}

function parseReplacementOperationRow(row) {
    if (!row) return null;
    let result = null;
    let error = null;
    try { result = row.result_json === null ? null : JSON.parse(row.result_json); } catch {}
    try { error = row.error_json === null ? null : JSON.parse(row.error_json); } catch {}
    return {
        operationId: row.operation_id,
        kind: row.kind,
        state: row.state,
        result,
        error,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function beginReplacementNdjson(res) {
    res.setHeader('content-type', 'application/x-ndjson');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders();
    res.write('{"type":"heartbeat"}\n');
    return setInterval(() => {
        if (!res.writableEnded && !res.destroyed) res.write('{"type":"heartbeat"}\n');
    }, BACKUP_NDJSON_HEARTBEAT_MS);
}

function sendReplacementProgress(res, phase) {
    if (!res.writableEnded && !res.destroyed) {
        res.write(`${JSON.stringify({ type: 'progress', phase })}\n`);
    }
}

function sendReplacementDone(res, operationId, result) {
    if (res.writableEnded || res.destroyed) return;
    res.write(`${JSON.stringify({
        type: 'done',
        operationId,
        commitOutcome: 'committed',
        commitOutcomeUnknown: false,
        ...result,
    })}\n`);
    res.end();
}

function importDiskSpaceError(required, available) {
    const error = new ImportIngressError('Insufficient disk space for import staging', {
        code: 'IMPORT_DISK_SPACE',
        statusCode: 507,
        limit: available,
        actual: required,
    });
    error.available = available;
    error.required = required;
    return error;
}

function authoritativeImportErrorPayload(error, fallbackCode) {
    if (!error || typeof error !== 'object') return null;
    const claimedOutcome = error.commitOutcome;
    const claimedUnknown = error.commitOutcomeUnknown;
    const commitOutcome = claimedUnknown === true || claimedOutcome === 'unknown'
        ? 'unknown'
        : claimedOutcome === 'not-committed' || claimedOutcome === 'committed'
            ? claimedOutcome
            : null;
    if (commitOutcome === null
        || typeof claimedUnknown !== 'boolean'
        || claimedUnknown !== (commitOutcome === 'unknown')) return null;
    return {
        error: String(error.message ?? 'Import failed'),
        code: typeof error.code === 'string' && error.code.length > 0
            ? error.code
            : fallbackCode,
        retryable: error.retryable === true,
        commitOutcome,
        commitOutcomeUnknown: commitOutcome === 'unknown',
    };
}

function sendImportIngressError(res, error, {
    ndjson = false,
    fallbackCode = 'BACKUP_IMPORT_FAILED',
    includeAnnotatedOutcome = false,
} = {}) {
    const payload = importErrorPayload(error)
        ?? (includeAnnotatedOutcome
            ? authoritativeImportErrorPayload(error, fallbackCode)
            : null)
        ?? (
        error?.risuSavePreparationLimit === true
        || error?.risuSavePreparationInvalid === true
        || error instanceof PluginStorageLimitError
            ? {
                error: error.message,
                code: error.code,
                ...(error.limit === undefined ? {} : { limit: error.limit }),
                ...(error.actual === undefined ? {} : { actual: error.actual }),
                retryable: false,
                commitOutcome: error.commitOutcome ?? 'not-committed',
                commitOutcomeUnknown: error.commitOutcomeUnknown ?? false,
            }
            : null
    );
    if (!payload) return false;
    // A disconnected importer has no response channel left. Treat its
    // structured cancellation as handled rather than handing it to Express,
    // which can only produce a secondary socket-write failure.
    if (res.destroyed) return true;
    if (error.available !== undefined) payload.available = error.available;
    if (error.required !== undefined) payload.required = error.required;
    if (ndjson && res.headersSent) {
        if (!res.writableEnded && !res.destroyed) {
            res.write(`${JSON.stringify(importNdjsonErrorEvent(error, payload))}\n`);
            res.end();
        }
        return true;
    }
    if (!res.headersSent) res.status(error.statusCode ?? error.status ?? 400).json(payload);
    return true;
}

function importNdjsonErrorEvent(error, payload = null, fallbackCode = 'BACKUP_IMPORT_FAILED') {
    const claimedOutcome = payload?.commitOutcome ?? error?.commitOutcome;
    const claimedUnknown = payload?.commitOutcomeUnknown ?? error?.commitOutcomeUnknown;
    const commitOutcome = claimedUnknown === true || claimedOutcome === 'unknown'
        ? 'unknown'
        : claimedOutcome === 'not-committed' || claimedOutcome === 'committed'
            ? claimedOutcome
            : 'unknown';
    return {
        type: 'error',
        message: String(payload?.message ?? payload?.error ?? error?.message ?? 'Backup import failed'),
        code: String(payload?.code ?? error?.code ?? fallbackCode),
        retryable: payload?.retryable === true || error?.retryable === true,
        commitOutcome,
        commitOutcomeUnknown: commitOutcome === 'unknown',
        status: Number(error?.statusCode ?? error?.status ?? payload?.status ?? 500),
    };
}

function importContentLength(req, label) {
    const raw = req.headers['content-length'];
    if (raw === undefined) return null;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) {
        throw importFormatError(`${label} has an invalid Content-Length`, 'INVALID_IMPORT_SIZE');
    }
    return value;
}

function requestConfirmsLargeRestore(req) {
    return req.headers['x-risu-large-restore'] === '1';
}

function backupImportLimits({ allowLargeRestore = false } = {}) {
    return allowLargeRestore
        ? {
            maxBytes: LARGE_RESTORE_MAX_BYTES,
            maxEntries: LARGE_RESTORE_MAX_ENTRIES,
            // Remaining compatibility-only buffered rows are admitted under
            // the explicit recovery ceiling.  Current exported assets, raw
            // inlays, cold storage, plugin values, and remote rows all use
            // file-backed paths below and do not allocate this amount.
            bufferedEntryMaxBytes: LARGE_RESTORE_MAX_BYTES,
        }
        : {
            maxBytes: BACKUP_IMPORT_MAX_BYTES,
            maxEntries: BACKUP_IMPORT_MAX_ENTRIES,
            bufferedEntryMaxBytes: IMPORT_BUFFERED_ENTRY_MAX_BYTES,
        };
}

async function assertImportDiskSpace(sourceBytes, targetPath = databaseSpoolDir) {
    const required = sourceBytes * BACKUP_DISK_HEADROOM;
    if (!Number.isSafeInteger(required)) {
        throw importFormatError('Import disk requirement is not a safe byte count', 'INVALID_IMPORT_SIZE');
    }
    const disk = await checkDiskSpace(required, targetPath);
    if (!disk.ok) throw importDiskSpaceError(required, disk.available);
    return disk;
}

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

const MAX_INLAY_DELETE_BATCH = 1000;
const INLAY_REFERENCE_PATTERN = /\{\{(?:inlay|inlayed|inlayeddata)::(.+?)\}\}/g;

function addInlayReferencesFromText(text, refCounts) {
    if (typeof text !== 'string') return;
    const regex = new RegExp(INLAY_REFERENCE_PATTERN.source, 'g');
    let match;
    while ((match = regex.exec(text)) !== null) {
        const id = match[1];
        refCounts.set(id, (refCounts.get(id) ?? 0) + 1);
    }
}

function addInlayReferencesFromChat(chat, refCounts) {
    if (!Array.isArray(chat?.message)) return 0;
    let totalMessages = 0;
    for (const message of chat.message) {
        if (!message || typeof message !== 'object') continue;
        totalMessages++;
        addInlayReferencesFromText(message.data, refCounts);
        if (Array.isArray(message.swipes)) {
            for (const swipe of message.swipes) {
                addInlayReferencesFromText(swipe, refCounts);
            }
        }
    }
    return totalMessages;
}

/**
 * Count references from server-authoritative chat rows. This deliberately scans
 * every physical chat row, including a recently staged row whose stub has not
 * committed yet. Being conservative can temporarily retain an orphan, while
 * omitting that row could permanently delete media from a newly created chat.
 */
async function scanAuthoritativeInlayReferences() {
    const refCounts = new Map();
    let totalMessages = 0;

    for (const key of chatRowStore.listAllChatRowKeys()) {
        const identity = chatRowStore.parseChatRowKey(key);
        if (!identity) continue;
        const chat = await chatRowStore.readChatRow(identity.chaId, identity.chatId);
        if (!chat) continue;
        if (isColdStorageChat(chat) && !restoreColdStorageChat(chat)) {
            throw new Error(`Cannot verify inlay references in cold-storage chat ${key}`);
        }
        totalMessages += addInlayReferencesFromChat(chat, refCounts);
    }

    return {
        scannedAt: Date.now(),
        totalMessages,
        refCounts: Object.fromEntries([...refCounts.entries()].sort(([left], [right]) => (
            left.localeCompare(right)
        ))),
    };
}

function validateInlayDeleteRequest(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    if (!Array.isArray(body.ids)
        || body.ids.length === 0
        || body.ids.length > MAX_INLAY_DELETE_BATCH) return null;
    const ids = [...new Set(body.ids)];
    if (ids.length === 0 || ids.some((id) => !isSafeInlayId(id))) return null;

    const clientProtected = body.clientProtectedIds ?? [];
    if (!Array.isArray(clientProtected)
        || clientProtected.length > MAX_INLAY_DELETE_BATCH
        || clientProtected.some((id) => typeof id !== 'string')) return null;
    const requested = new Set(ids);
    return {
        ids,
        clientProtectedIds: new Set(clientProtected.filter((id) => requested.has(id))),
    };
}

async function deleteUnreferencedInlays(ids, clientProtectedIds = new Set()) {
    const scan = await scanAuthoritativeInlayReferences();
    const referencedIds = ids.filter((id) => (
        clientProtectedIds.has(id) || (scan.refCounts[id] ?? 0) > 0
    ));
    const referenced = new Set(referencedIds);
    const removedIds = [];

    for (const id of ids) {
        if (referenced.has(id)) continue;
        await deleteInlayFile(id);
        kvDel(`inlay/${id}`);
        kvDel(`inlay_thumb/${id}`);
        kvDel(`inlay_info/${id}`);
        kvDel(`inlay_meta/${id}`);
        removedIds.push(id);
    }

    return { removedIds, referencedIds, scannedAt: scan.scannedAt };
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

async function fsyncInlayDirectory() {
    let directoryHandle;
    try {
        directoryHandle = await fs.open(inlayDir, 'r');
        await directoryHandle.sync();
    } catch {
        // Some platforms do not allow directory handles to be opened or synced.
        // The staged file itself is still synced before every atomic rename.
    } finally {
        await directoryHandle?.close().catch(() => {});
    }
}

function fsyncInlayDirectorySync() {
    let directoryDescriptor;
    try {
        directoryDescriptor = openSync(inlayDir, 'r');
        fsyncSync(directoryDescriptor);
    } catch {
        // Directory fsync is unavailable on some platforms.
    } finally {
        if (directoryDescriptor !== undefined) {
            try { closeSync(directoryDescriptor); } catch {}
        }
    }
}

function newInlayTempPath(label) {
    const tempPath = path.join(
        inlayDir,
        `${INLAY_TEMP_PREFIX}${process.pid}-${nodeCrypto.randomUUID()}-${label}`,
    );
    assertInsideInlayDir(tempPath);
    return tempPath;
}

function isInlayTemporaryFileName(name) {
    return typeof name === 'string' && INLAY_TEMP_NAME_PATTERN.test(name);
}

async function writeDurableInlayTempFile(filePath, value) {
    let handle;
    try {
        handle = await fs.open(filePath, 'wx', 0o600);
        await handle.writeFile(value);
        await handle.sync();
    } finally {
        await handle?.close().catch(() => {});
    }
}

async function copyDurableInlayTempFile(sourcePath, filePath) {
    let source;
    let destination;
    try {
        source = await fs.open(sourcePath, 'r');
        const stat = await source.stat();
        if (!stat.isFile()) throw new Error('Inlay spool source must be a regular file');
        destination = await fs.open(filePath, 'wx', 0o600);
        const page = Buffer.allocUnsafe(256 * 1024);
        let position = 0;
        while (position < stat.size) {
            const length = Math.min(page.length, stat.size - position);
            const result = await source.read(page, 0, length, position);
            if (result.bytesRead !== length) throw new Error('Inlay spool changed during publication');
            let written = 0;
            while (written < length) {
                const output = await destination.write(page, written, length - written);
                if (output.bytesWritten <= 0) {
                    throw new Error('Inlay spool publication made no progress');
                }
                written += output.bytesWritten;
            }
            position += length;
        }
        await destination.sync();
    } finally {
        await source?.close().catch(() => {});
        await destination?.close().catch(() => {});
    }
}

function writeDurableInlayTempFileSync(filePath, value) {
    let descriptor;
    try {
        descriptor = openSync(filePath, 'wx', 0o600);
        writeFileSync(descriptor, value);
        fsyncSync(descriptor);
    } finally {
        if (descriptor !== undefined) {
            try { closeSync(descriptor); } catch {}
        }
    }
}

async function reachInlayPublishTestBoundary(stage, id) {
    if (inlayPublishFailpoint === stage) {
        throw new Error(`Injected inlay publication failure at ${stage}`);
    }
    if (!inlayPublishTestGateDir || inlayPublishTestGateStage !== stage) return;
    const holdPath = path.join(inlayPublishTestGateDir, 'hold');
    if (!existsSync(holdPath)) return;
    await fs.mkdir(inlayPublishTestGateDir, { recursive: true });
    await fs.writeFile(
        path.join(inlayPublishTestGateDir, 'entered'),
        JSON.stringify({ stage, id }),
        'utf-8',
    );
    const releasePath = path.join(inlayPublishTestGateDir, 'release');
    while (existsSync(holdPath) && !existsSync(releasePath)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

function inlaySidecarValue(id, info) {
    return Buffer.from(JSON.stringify({
        ext: normalizeInlayExt(info?.ext),
        name: typeof info?.name === 'string' ? info.name : id,
        type: typeof info?.type === 'string' ? info.type : 'image',
        height: typeof info?.height === 'number' ? info.height : undefined,
        width: typeof info?.width === 'number' ? info.width : undefined,
    }));
}

async function reconcileInterruptedInlayPublications() {
    await ensureInlayDir();
    const entries = await fs.readdir(inlayDir, { withFileTypes: true });
    let removedTemporaryFile = false;
    for (const entry of entries) {
        if (!entry.isFile() || !isInlayTemporaryFileName(entry.name)) continue;
        await fs.unlink(path.join(inlayDir, entry.name)).catch((error) => {
            if (error?.code !== 'ENOENT') throw error;
        });
        removedTemporaryFile = true;
    }
    if (removedTemporaryFile) await fsyncInlayDirectory();
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
    const temporaryPath = newInlayTempPath('sidecar');
    try {
        await writeDurableInlayTempFile(temporaryPath, inlaySidecarValue(id, info));
        await fs.rename(temporaryPath, getInlaySidecarPath(id));
        await fsyncInlayDirectory();
    } finally {
        await fs.unlink(temporaryPath).catch(() => {});
    }
}

function writeInlaySidecarSync(id, info) {
    ensureInlayDirSync();
    const temporaryPath = newInlayTempPath('sidecar');
    try {
        writeDurableInlayTempFileSync(temporaryPath, inlaySidecarValue(id, info));
        renameSync(temporaryPath, getInlaySidecarPath(id));
        fsyncInlayDirectorySync();
    } finally {
        try { unlinkSync(temporaryPath); } catch {}
    }
}

async function writeInlayFile(id, ext, buffer, info = null) {
    await ensureInlayDir();
    const normalizedExt = normalizeInlayExt(ext);
    const destinationPath = getInlayFilePath(id, normalizedExt);
    const sidecarPath = getInlaySidecarPath(id);
    const previousPath = await resolveInlayFilePath(id);
    const payloadTemporaryPath = newInlayTempPath('payload');
    const sidecarTemporaryPath = newInlayTempPath('sidecar');
    const sidecarValue = inlaySidecarValue(id, {
        ...(info || {}),
        ext: normalizedExt,
    });
    let payloadPublished = false;
    let sidecarPublished = false;
    try {
        // Stage and sync both files before changing any reader-visible path.
        // ENOSPC and encoding/write failures therefore leave the old inlay
        // completely untouched.
        await writeDurableInlayTempFile(payloadTemporaryPath, Buffer.from(buffer));
        await writeDurableInlayTempFile(sidecarTemporaryPath, sidecarValue);
        await reachInlayPublishTestBoundary('before-payload-publish', id);

        // Publish the payload first while the prior sidecar and prior-extension
        // payload remain authoritative. The sidecar rename below is the commit
        // point for extension-changing replacements.
        await fs.rename(payloadTemporaryPath, destinationPath);
        payloadPublished = true;
        await fsyncInlayDirectory();
        await reachInlayPublishTestBoundary('after-payload-publish', id);

        await fs.rename(sidecarTemporaryPath, sidecarPath);
        sidecarPublished = true;
        await fsyncInlayDirectory();

        // Only a committed sidecar can make the prior extension obsolete.
        // Failures here retain an extra recoverable copy rather than removing
        // the only valid one.
        if (previousPath && previousPath !== destinationPath) {
            try {
                await fs.unlink(previousPath);
                await fsyncInlayDirectory();
            } catch (error) {
                if (error?.code !== 'ENOENT') {
                    logger.warn(`[InlayFS] Failed to remove obsolete payload for ${id}:`, error?.message || error);
                }
            }
        }
    } catch (error) {
        // If an extension-changing replacement did not reach its sidecar commit
        // point, roll back its newly visible orphan. The prior sidecar-selected
        // source remains untouched. Same-extension rename is already atomic and
        // therefore still leaves one complete payload.
        if (payloadPublished && !sidecarPublished && previousPath !== destinationPath) {
            try {
                await fs.unlink(destinationPath);
                await fsyncInlayDirectory();
            } catch (rollbackError) {
                if (rollbackError?.code !== 'ENOENT') {
                    logger.warn(
                        `[InlayFS] Failed to roll back unpublished payload for ${id}:`,
                        rollbackError?.message || rollbackError,
                    );
                }
            }
        }
        throw error;
    } finally {
        await fs.unlink(payloadTemporaryPath).catch(() => {});
        await fs.unlink(sidecarTemporaryPath).catch(() => {});
    }
    kvClearDeletion(`inlay/${id}`);
}

async function writeInlayFileFromFile(id, ext, sourcePath, info = null) {
    await ensureInlayDir();
    const normalizedExt = normalizeInlayExt(ext);
    const destinationPath = getInlayFilePath(id, normalizedExt);
    const sidecarPath = getInlaySidecarPath(id);
    const previousPath = await resolveInlayFilePath(id);
    const payloadTemporaryPath = newInlayTempPath('payload');
    const sidecarTemporaryPath = newInlayTempPath('sidecar');
    const sidecarValue = inlaySidecarValue(id, {
        ...(info || {}),
        ext: normalizedExt,
    });
    let payloadPublished = false;
    let sidecarPublished = false;
    try {
        await copyDurableInlayTempFile(sourcePath, payloadTemporaryPath);
        await writeDurableInlayTempFile(sidecarTemporaryPath, sidecarValue);
        await reachInlayPublishTestBoundary('before-payload-publish', id);
        await fs.rename(payloadTemporaryPath, destinationPath);
        payloadPublished = true;
        await fsyncInlayDirectory();
        await reachInlayPublishTestBoundary('after-payload-publish', id);
        await fs.rename(sidecarTemporaryPath, sidecarPath);
        sidecarPublished = true;
        await fsyncInlayDirectory();
        if (previousPath && previousPath !== destinationPath) {
            try {
                await fs.unlink(previousPath);
                await fsyncInlayDirectory();
            } catch (error) {
                if (error?.code !== 'ENOENT') {
                    logger.warn(`[InlayFS] Failed to remove obsolete payload for ${id}:`, error?.message || error);
                }
            }
        }
    } catch (error) {
        if (payloadPublished && !sidecarPublished && previousPath !== destinationPath) {
            try {
                await fs.unlink(destinationPath);
                await fsyncInlayDirectory();
            } catch (rollbackError) {
                if (rollbackError?.code !== 'ENOENT') {
                    logger.warn(
                        `[InlayFS] Failed to roll back unpublished payload for ${id}:`,
                        rollbackError?.message || rollbackError,
                    );
                }
            }
        }
        throw error;
    } finally {
        await fs.unlink(payloadTemporaryPath).catch(() => {});
        await fs.unlink(sidecarTemporaryPath).catch(() => {});
    }
    kvClearDeletion(`inlay/${id}`);
}

function writeInlayFileSync(id, ext, buffer, info = null) {
    ensureInlayDirSync();
    const normalizedExt = normalizeInlayExt(ext);
    const destinationPath = getInlayFilePath(id, normalizedExt);
    const sidecarPath = getInlaySidecarPath(id);
    const previousPath = resolveInlayFilePathSync(id);
    const payloadTemporaryPath = newInlayTempPath('payload');
    const sidecarTemporaryPath = newInlayTempPath('sidecar');
    const sidecarValue = inlaySidecarValue(id, {
        ...(info || {}),
        ext: normalizedExt,
    });
    let payloadPublished = false;
    let sidecarPublished = false;
    try {
        writeDurableInlayTempFileSync(payloadTemporaryPath, Buffer.from(buffer));
        writeDurableInlayTempFileSync(sidecarTemporaryPath, sidecarValue);
        renameSync(payloadTemporaryPath, destinationPath);
        payloadPublished = true;
        fsyncInlayDirectorySync();
        renameSync(sidecarTemporaryPath, sidecarPath);
        sidecarPublished = true;
        fsyncInlayDirectorySync();
        if (previousPath && previousPath !== destinationPath) {
            try {
                unlinkSync(previousPath);
                fsyncInlayDirectorySync();
            } catch (error) {
                if (error?.code !== 'ENOENT') {
                    logger.warn(`[InlayFS] Failed to remove obsolete payload for ${id}:`, error?.message || error);
                }
            }
        }
    } catch (error) {
        if (payloadPublished && !sidecarPublished && previousPath !== destinationPath) {
            try {
                unlinkSync(destinationPath);
                fsyncInlayDirectorySync();
            } catch (rollbackError) {
                if (rollbackError?.code !== 'ENOENT') {
                    logger.warn(
                        `[InlayFS] Failed to roll back unpublished payload for ${id}:`,
                        rollbackError?.message || rollbackError,
                    );
                }
            }
        }
        throw error;
    } finally {
        try { unlinkSync(payloadTemporaryPath); } catch {}
        try { unlinkSync(sidecarTemporaryPath); } catch {}
    }
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
            !isInlayTemporaryFileName(entry.name) &&
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
    await reconcileInterruptedInlayPublications();
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

function verifyAssetHashForWrite(key, value) {
    const verification = verifyAssetHash(key, value);
    const name = assetNameForKey(key);
    const legacyHashMismatch = !verification.ok
        && name !== null
        && isLegacyHashAsset(name);
    return { ...verification, legacyHashMismatch };
}

function writeAssetValue(key, value, options = {}) {
    const { skipIfUnchanged = false, legacyHashMismatch = false } = options;
    const name = assetNameForKey(key);
    if (name !== null && isSafeAssetName(name)) {
        if (legacyHashMismatch) markLegacyHashAsset(name);
        let wrote = true;
        if (skipIfUnchanged) {
            wrote = writeAssetFileIfChanged(name, value);
        } else {
            writeAssetFile(name, value);
        }
        const verification = verifyAssetHash(key, value);
        if (verification.ok) clearLegacyHashAsset(name);
        // A crash between the file rename and this delete is harmless: reads
        // prefer the file, and the startup migration removes the duplicate.
        kvDel(key);
        // kvDel records logical removals automatically, but this delete only
        // removes the shadow kv row; the freshly written file remains live.
        kvClearDeletion(key);
        assetGcCandidateStore.remove(key);
        return wrote;
    }
    kvSet(key, value);
    assetGcCandidateStore.remove(key);
    return true;
}

function deleteAssetValue(key) {
    const name = assetNameForKey(key);
    if (name !== null && isSafeAssetName(name)) {
        deleteAssetFile(name);
    }
    kvDel(key);
    assetGcCandidateStore.remove(key);
}

function listAssetEntriesWithSizes(reader = { kvListWithSizes, kvGetUpdatedAt }) {
    const entries = new Map();
    for (const file of listAssetFiles()) {
        entries.set(`assets/${file.name}`, {
            key: `assets/${file.name}`,
            size: file.size,
            mtimeMs: file.mtimeMs,
            source: 'fs',
            legacyHash: isLegacyHashAsset(file.name),
        });
    }
    for (const row of reader.kvListWithSizes('assets/')) {
        if (!entries.has(row.key)) {
            entries.set(row.key, {
                key: row.key,
                size: row.size,
                mtimeMs: typeof reader.kvGetUpdatedAt === 'function'
                    ? reader.kvGetUpdatedAt(row.key)
                    : null,
                source: 'kv',
                legacyHash: false,
            });
        }
    }
    return [...entries.values()].sort((a, b) => a.key.localeCompare(b.key));
}

const assetImportStagingDir = path.join(savePath, 'assets_import_staging');
const assetImportBackupDir = path.join(savePath, 'assets_import_backup');
const DEMOTED_PORTABLE_ASSET_NAME = Symbol('demoted-portable-asset-name');

async function prepareAssetImportStage() {
    recoverPendingImportSwap('Asset import preparation');
    await fs.rm(assetImportStagingDir, { recursive: true, force: true });
    await fs.rm(assetImportBackupDir, { recursive: true, force: true });
    const store = createAssetStore({ assetDir: assetImportStagingDir });
    store.ensureAssetDir();
    writeFileSync(store.migrationMarkerPath, new Date().toISOString(), 'utf-8');
    store.reconcileLegacyHashAssetIdentity({ discover: true });
    return { store, stagedPortableNames: new Map() };
}

function warnImportedAssetHashVerification(key, verification, source) {
    if (!verification.ok) {
        logger.warn(
            `[AssetFS] ${source} hash mismatch for ${key}: `
            + `expected=${verification.claimed} actual=${verification.actual}; importing verbatim`
        );
    }
}

function warnImportedAssetHashMismatch(key, value, source) {
    const verification = verifyAssetHash(key, value);
    warnImportedAssetHashVerification(key, verification, source);
    return verification;
}

async function writeImportedAssetFromFile(
    assetStage,
    key,
    source,
    signal,
    label,
    { maxBytes = BACKUP_IMPORT_MAX_BYTES } = {},
) {
    const sourceLabel = label || 'Legacy import';
    const name = assetNameForKey(key);
    if (name === null || !isSafeAssetName(name)) {
        kvSetFromFile(key, source.filePath);
        logger.warn(`[AssetFS] ${sourceLabel} retained unsafe asset key ${key} in SQLite`);
        return 'kv';
    }
    if (!isPortableAssetName(name)) {
        kvSetFromFile(key, source.filePath);
        logger.warn(`[AssetFS] ${sourceLabel} retained non-portable asset key ${key} in SQLite`);
        return 'kv';
    }

    const portableKey = portableAssetNameKey(name);
    const stagedName = assetStage.stagedPortableNames.get(portableKey);
    if (stagedName === DEMOTED_PORTABLE_ASSET_NAME) {
        kvSetFromFile(key, source.filePath);
        return 'kv';
    }
    if (stagedName !== undefined && stagedName !== name) {
        const stagedKey = `assets/${stagedName}`;
        kvSetFromFile(stagedKey, assetStage.store.assetPathFor(stagedName));
        assetStage.store.deleteAssetFile(stagedName);
        assetStage.stagedPortableNames.set(portableKey, DEMOTED_PORTABLE_ASSET_NAME);
        kvSetFromFile(key, source.filePath);
        logger.warn(
            `[AssetFS] ${sourceLabel} retained colliding asset keys ${stagedKey} and ${key} in SQLite`,
        );
        return 'kv';
    }

    await copyFileToSpool(source.filePath, assetStage.store.assetPathFor(name), {
        maxBytes,
        signal,
    });
    const verification = assetStage.store.verifyStoredAssetHash(name);
    warnImportedAssetHashVerification(key, verification, sourceLabel);
    if (!verification.ok) assetStage.store.markLegacyHashAsset(name);
    kvClearDeletion(key);
    if (stagedName === undefined) {
        assetStage.stagedPortableNames.set(portableKey, name);
    }
    return 'fs';
}

async function validateAndImportPluginValueFile(
    key,
    source,
    signal,
    { maxBytes = BACKUP_IMPORT_MAX_BYTES } = {},
) {
    if (isHashedPluginSaveStorageKey(key, PLUGIN_SAVE_PREFIX)) {
        assertArchiveSafePluginSaveStorageKey(key);
    } else {
        decodeValidatedPluginStorageKey(key, PLUGIN_SAVE_PREFIX);
    }
    const valueMaxBytes = Math.min(maxBytes, PLUGIN_VALUE_MAX_BYTES);
    let displayMetadata;
    try {
        if (source.size > valueMaxBytes) {
            throw new PluginStorageLimitError(
                `Plugin storage value exceeds the ${valueMaxBytes}-byte import limit.`,
                {
                    code: 'PLUGIN_VALUE_TOO_LARGE',
                    limit: valueMaxBytes,
                    actual: source.size,
                },
            );
        }
        const prefixHandle = await fs.open(source.filePath, 'r');
        let prefix;
        try {
            prefix = Buffer.alloc(Math.min(PLUGIN_STORAGE_LOSSLESS_MAGIC.length, source.size));
            const read = await prefixHandle.read(prefix, 0, prefix.length, 0);
            if (read.bytesRead !== prefix.length) {
                throw new PluginStorageValidationError(key);
            }
        } finally {
            await prefixHandle.close();
        }
        if (pluginStorageCodecForBuffer(prefix) !== PLUGIN_STORAGE_LOSSLESS_CODEC) {
            await validateJsonFileStreaming(source.filePath, {
                size: source.size,
                maxBytes: valueMaxBytes,
                signal,
            });
        }
        displayMetadata = await validateJsonSource({
            filePath: source.filePath,
            size: source.size,
        }, { signal });
    } catch (error) {
        if (error?.code === 'INVALID_PLUGIN_STORAGE_ROW') {
            throw new PluginStorageValidationError(key);
        }
        throw error;
    }
    throwIfImportAborted(signal);
    kvSetFromFile(key, source.filePath, {
        pluginStorageDisplaySize: pluginStorageViewerDisplaySizeFromMetadata(
            displayMetadata,
        ),
    });
}

async function validateAndImportPluginMetadataFile(
    key,
    source,
    signal,
    { maxBytes = BACKUP_IMPORT_MAX_BYTES } = {},
) {
    if (isHashedPluginSaveStorageKey(key, PLUGIN_SAVE_META_PREFIX)) {
        assertArchiveSafePluginSaveStorageKey(key);
    } else {
        decodeValidatedPluginStorageKey(key, PLUGIN_SAVE_META_PREFIX);
    }
    const ownerScanner = createPluginStorageOwnerScanner();
    await validateJsonFileStreaming(source.filePath, {
        size: source.size,
        maxBytes,
        signal,
        onPage: (page) => ownerScanner.push(page),
    });
    throwIfImportAborted(signal);
    kvSetFromFile(key, source.filePath, {
        pluginStorageOwner: ownerScanner.finish(),
    });
}

async function importOpaqueRowFromFile(key, source, signal) {
    throwIfImportAborted(signal);
    kvSetFromFile(key, source.filePath);
}

async function importColdStorageFromFile(
    storageKey,
    source,
    signal,
    label,
    { maxBytes, bufferedEntryMaxBytes },
) {
    const handle = await fs.open(source.filePath, 'r');
    let gzip = false;
    try {
        const header = Buffer.alloc(2);
        const { bytesRead } = await handle.read(header, 0, 2, 0);
        gzip = bytesRead === 2 && header[0] === 0x1f && header[1] === 0x8b;
    } finally {
        await handle.close();
    }

    // Historical third-party archives sometimes put already-compressed bytes
    // in a .json entry. Preserve that compatibility path; current PocketRisu
    // exports are plain JSON and take the fully streaming path below.
    if (gzip) {
        const data = await readFileToBufferBounded(source.filePath, {
            size: source.size,
            maxBytes: Math.min(bufferedEntryMaxBytes, maxBytes),
            label,
            code: 'IMPORT_BUFFERED_ENTRY_LIMIT',
            signal,
        });
        const storageValue = encodeColdStorageCanonicalBuffer(
            parseColdStorageJsonBuffer(data, label, { allowPlainJson: true }).coldData,
        );
        kvSet(storageKey, storageValue);
        return;
    }

    await validateJsonFileStreaming(source.filePath, {
        size: source.size,
        maxBytes,
        signal,
    });
    const compressedPath = `${source.filePath}.cold.gz`;
    try {
        await pipeline(
            createReadStream(source.filePath, { highWaterMark: IMPORT_IO_PAGE_BYTES }),
            zlib.createGzip({ chunkSize: IMPORT_IO_PAGE_BYTES }),
            createWriteStream(compressedPath, { flags: 'wx', mode: 0o600 }),
            signal ? { signal } : {},
        );
        kvSetFromFile(storageKey, compressedPath);
    } finally {
        await fs.unlink(compressedPath).catch(() => {});
    }
}

function migrateAssetsToFilesystem() {
    ensureAssetDir();
    let migratedRows = false;
    if (!existsSync(assetMigrationMarker)) {
        const keys = kvList('assets/');
        if (keys.length > 0) {
            console.log(`[AssetFS] Migrating ${keys.length} asset row(s) to ${assetDir}...`);
        }
        const result = migrateAssetRowsToFilesystem({
            keys,
            existingAssetNames: listAssetFiles().map((entry) => entry.name),
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
                portableAssetNameKey,
                isPortableAssetName,
                writeAssetFileIfChanged,
            },
            onSkipped: ({ key, reason }) => {
                const description = reason === 'collision'
                    ? 'its portable filename collides with another asset'
                    : 'its filename is not portable';
                logger.warn(`[AssetFS] Startup migration retained ${key} in SQLite because ${description}`);
            },
            onProgress: ({ index, total, migrated }) => {
                if (migrated % 100 === 0 || index === total - 1) {
                    console.log(`[AssetFS] Migrating... ${index + 1}/${total}`);
                }
            },
        });
        writeFileSync(assetMigrationMarker, new Date().toISOString(), 'utf-8');
        migratedRows = result.migrated > 0;
        if (keys.length > 0) {
            console.log(
                `[AssetFS] Migration complete. ${result.migrated} moved, `
                + `${result.skippedUnsafe} unsafe, `
                + `${result.skippedNonPortable} non-portable, and `
                + `${result.skippedCollision} colliding name(s) kept in SQLite.`
            );
        }
    }

    const discoverLegacyIdentity = migratedRows || !existsSync(legacyHashIdentityMarkerPath);
    const identity = reconcileLegacyHashAssetIdentity({ discover: discoverLegacyIdentity });
    if (identity.marked > 0 || identity.cleared > 0) {
        logger.info(
            `[AssetFS] Legacy hash identity reconciliation: ${identity.marked} marked, `
            + `${identity.cleared} stale marker(s) cleared.`,
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

function checkSessionCookieAuth(req, res) {
    const token = parseSessionCookie(req)
    if (token && (sessions.get(token) ?? 0) > Date.now()) return true
    res.status(401).end()
    return false
}

function sessionAuthMiddleware(req, res, next) {
    if (checkSessionCookieAuth(req, res)) next()
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

async function checkDiskSpace(requiredBytes, targetPath = path.join(process.cwd(), 'save')) {
    if (process.env.NODE_ENV === 'test'
        && process.env.POCKETRISU_TEST_IMPORT_AVAILABLE_BYTES !== undefined) {
        const available = Number(process.env.POCKETRISU_TEST_IMPORT_AVAILABLE_BYTES);
        if (Number.isSafeInteger(available) && available >= 0) {
            return { ok: available >= requiredBytes, available };
        }
    }
    if (process.env.POCKETRISU_PLUGIN_STORAGE_TEST_FAILPOINTS === '1'
        && process.env.POCKETRISU_PLUGIN_TRANSITION_TEST_AVAILABLE_BYTES !== undefined) {
        const available = Number(
            process.env.POCKETRISU_PLUGIN_TRANSITION_TEST_AVAILABLE_BYTES,
        );
        if (Number.isSafeInteger(available) && available >= 0) {
            return { ok: available >= requiredBytes, available };
        }
    }
    try {
        const stats = await fs.statfs(targetPath);
        const availableBytes = stats.bavail * stats.bsize;
        return { ok: availableBytes >= requiredBytes, available: availableBytes };
    } catch {
        // statfs unavailable on this platform — skip check
        return { ok: true, available: -1 };
    }
}

// ── Active writer session (single-writer lock) ────────────────────────────────
// Mirrors the BroadcastChannel-based tab lock on the server side so that the
// same protection extends across devices. Page loads register without stealing
// the lock; a recent user gesture allows a freshly booted session to take over.
const { createBoundedSessionState } = require('./boundedSessionState.cjs');
const PLUGIN_STORAGE_READ_SESSION_MAX_ENTRIES = 50;
const pluginStorageReadStateStatsPath = process.env.NODE_ENV === 'test'
    ? String(process.env.POCKETRISU_TEST_PLUGIN_READ_STATE_STATS_PATH ?? '').trim() || null
    : null;
let pluginStorageReadStateBySession;

function publishPluginStorageReadStateStats() {
    if (!pluginStorageReadStateStatsPath || !pluginStorageReadStateBySession) return;
    writeFileSync(
        path.resolve(process.cwd(), pluginStorageReadStateStatsPath),
        JSON.stringify(pluginStorageReadStateBySession.stats()),
        'utf-8',
    );
}

pluginStorageReadStateBySession = createBoundedSessionState({
    maxEntries: PLUGIN_STORAGE_READ_SESSION_MAX_ENTRIES,
    onEvict: publishPluginStorageReadStateStats,
});

function rememberSessionPluginStorageState(req, dbObj) {
    const clientSessionId = req.headers['x-session-id'];
    if (typeof clientSessionId !== 'string' || clientSessionId.length === 0) return;
    pluginStorageReadStateBySession.set(clientSessionId, {
        optimized: dbObj?.optimizePluginMemory === true,
        generation: pluginStorageGeneration(dbObj),
    });
    publishPluginStorageReadStateStats();
}

function sessionPluginStorageReadState(req) {
    const clientSessionId = req.headers['x-session-id'];
    return typeof clientSessionId === 'string'
        ? pluginStorageReadStateBySession.get(clientSessionId) ?? null
        : null;
}

function captureActiveSessionWriteRequest(req) {
    const clientSessionId = req.headers['x-session-id']
    const clientWriterEpoch = req.headers[WRITER_EPOCH_HEADER]
    return {
        sessionId: typeof clientSessionId === 'string' ? clientSessionId : '',
        userActive: req.headers['x-user-active'] === '1',
        writerEpoch: typeof clientWriterEpoch === 'string' ? clientWriterEpoch : '',
    }
}

function checkActiveSessionWrite(writeRequest, res) {
    const result = sessionLock.checkWrite(
        writeRequest.sessionId,
        writeRequest.userActive,
        writeRequest.writerEpoch,
    )
    if (result.tookOver) {
        console.log('[Session] Write lock taken over by a freshly-booted session')
    }
    if (result.ok) return true
    res.status(423).json({
        error: 'Session deactivated',
        code: 'SESSION_DEACTIVATED',
        retryable: false,
        commitOutcome: 'not-committed',
        commitOutcomeUnknown: false,
    })
    return false
}

function checkActiveSession(req, res) {
    return checkActiveSessionWrite(captureActiveSessionWriteRequest(req), res)
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

function decodeAndCanonicalizeHexPath(filePath) {
    const pathBytes = Buffer.from(filePath, 'hex');
    return {
        canonicalPath: pathBytes.toString('hex'),
        decodedKey: pathBytes.toString('utf-8'),
    };
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

            if (HUB_HOSTING_MODE) {
                const body = JSON.stringify({ error: HOSTED_PROXY_STREAM_BLOCKED_ERROR });
                socket.write([
                    'HTTP/1.1 403 Forbidden',
                    'Connection: close',
                    'Content-Type: application/json; charset=utf-8',
                    `Content-Length: ${Buffer.byteLength(body)}`,
                    '',
                    body,
                ].join('\r\n'));
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

function encodeBackupEntry(name, data) {
    return Buffer.concat([encodeBackupEntryHeader(name, data.length), data]);
}

async function writeWithBackpressure(
    writable,
    chunk,
    isClosed = () => false,
    onBackpressure = null,
) {
    if (isClosed()) return false;
    if (writable.write(chunk)) return true;
    return new Promise((resolve, reject) => {
        let settled = false;
        let drained = false;
        let reported = !onBackpressure;
        function cleanup() {
            writable.removeListener('drain', onDrain);
            writable.removeListener('error', onError);
            writable.removeListener('close', onClose);
        }
        function settle(value, error = null) {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error);
            else resolve(value);
        }
        function maybeResolve() {
            if (drained && reported) settle(true);
        }
        function onDrain() {
            drained = true;
            maybeResolve();
        }
        function onError(error) {
            settle(false, error);
        }
        function onClose() {
            if (isClosed()) settle(false);
            else settle(false, new Error('Backup destination closed before draining'));
        }
        writable.once('drain', onDrain);
        writable.once('error', onError);
        writable.once('close', onClose);
        if (isClosed()) {
            onClose();
            return;
        }
        if (onBackpressure) {
            Promise.resolve()
                .then(onBackpressure)
                .then(() => {
                    reported = true;
                    if (isClosed()) onClose();
                    else maybeResolve();
                }, onError);
        }
    });
}

async function streamFileToWritable(filePath, writable, isClosed = () => false) {
    const input = createReadStream(filePath, { highWaterMark: IMPORT_IO_PAGE_BYTES });
    try {
        for await (const chunk of input) {
            if (!await writeWithBackpressure(writable, chunk, isClosed)) return false;
        }
        return !isClosed();
    } finally {
        input.destroy();
    }
}

async function writePinnedBackupEntry(writable, entry, isClosed) {
    if (!await writeWithBackpressure(
        writable,
        encodeBackupEntryHeader(entry.backupName, entry.size),
        isClosed,
    )) return false;
    if (entry.kind !== 'file') {
        throw new Error(`Backup entry was not pinned to a private file: ${entry.backupName}`);
    }
    return streamFileToWritable(entry.sourcePath, writable, isClosed);
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

// Upstream backups can use flat coldstorage_<uuid>.json entry names. Restrict
// that compatibility form to UUIDs so similarly named assets remain assets.
const COLD_STORAGE_FLAT_NAME_RE = /^coldstorage_([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:\.json)?$/;

function normalizeColdStorageStorageKey(nameOrKey) {
    let key = nameOrKey;
    if (key.startsWith('coldstorage/')) {
        key = key.slice('coldstorage/'.length);
    } else {
        const flat = COLD_STORAGE_FLAT_NAME_RE.exec(key);
        if (flat) key = flat[1];
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

function snapshotOptimizedPluginStorageFields(dbObj) {
    if (!dbObj || (
        dbObj.optimizePluginMemory !== true
        && dbObj[PLUGIN_STORAGE_FOLDED_MARKER] !== true
    )) return null;
    return {
        values: snapshotPluginStorageRecord(
            dbObj.pluginCustomStorage ?? {},
            'pluginCustomStorage',
            PLUGIN_SAVE_PREFIX
        ),
        meta: Object.prototype.hasOwnProperty.call(dbObj, 'pluginStorageMeta')
            ? snapshotPluginStorageRecord(
                dbObj.pluginStorageMeta,
                'pluginStorageMeta',
                PLUGIN_SAVE_META_PREFIX
            )
            : {},
        hasMeta: Object.prototype.hasOwnProperty.call(dbObj, 'pluginStorageMeta'),
    };
}

function pluginStorageValidationDiagnostic(error) {
    if (!isPluginStorageValidationError(error)) return null;
    const encodedKey = typeof error.encodedKey === 'string'
        && (error.encodedKey.startsWith(PLUGIN_SAVE_PREFIX)
            || error.encodedKey.startsWith(PLUGIN_SAVE_META_PREFIX))
        ? error.encodedKey
        : PLUGIN_SAVE_PREFIX;
    return {
        error: 'Invalid plugin storage JSON row',
        code: 'INVALID_PLUGIN_STORAGE_ROW',
        encodedKey,
    };
}

function logPluginStorageValidationFailure(context, error) {
    const diagnostic = pluginStorageValidationDiagnostic(error);
    if (!diagnostic) return null;
    logger.warn(`${context}: ${diagnostic.encodedKey}`);
    return diagnostic;
}

function preparePluginStorageExternalization(dbObj) {
    const hasMarkerField = Boolean(dbObj)
        && Object.prototype.hasOwnProperty.call(dbObj, PLUGIN_STORAGE_FOLDED_MARKER);
    const strictFields = snapshotOptimizedPluginStorageFields(dbObj);
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
                manifest: null,
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
            manifest: null,
        };
    }

    const valueEntries = Object.entries(strictFields.values);
    const metaEntries = Object.entries(strictFields.meta);
    const rows = [];
    for (const [rawKey, value] of valueEntries) {
        const storageKey = encodeValidatedPluginStorageKey(rawKey, PLUGIN_SAVE_PREFIX);
        rows.push({
            storageKey,
            value: serializePluginStorageRow(storageKey, value),
        });
    }
    for (const [rawKey, value] of metaEntries) {
        const storageKey = encodeValidatedPluginStorageKey(rawKey, PLUGIN_SAVE_META_PREFIX);
        rows.push({
            storageKey,
            value: serializePluginStorageRow(storageKey, value),
        });
    }
    const exactFoldedSet = dbObj[PLUGIN_STORAGE_FOLDED_MARKER] === true;
    const generation = exactFoldedSet
        && typeof dbObj[PLUGIN_STORAGE_GENERATION_FIELD] === 'string'
        && dbObj[PLUGIN_STORAGE_GENERATION_FIELD].length > 0
        ? dbObj[PLUGIN_STORAGE_GENERATION_FIELD]
        : nodeCrypto.randomUUID();
    const strippedDb = {
        ...dbObj,
        [PLUGIN_STORAGE_GENERATION_FIELD]: generation,
        pluginCustomStorage: {},
    };
    delete strippedDb.pluginStorageMeta;
    delete strippedDb[PLUGIN_STORAGE_FOLDED_MARKER];
    // A folded marker is already exact. Unmarked inline data is an import or
    // defensive monolith and starts a fresh generation rather than unioning
    // rows left by the previously selected database.
    const activeValueKeys = new Set();
    const activeMetaKeys = new Set();
    for (const row of rows) {
        if (row.storageKey.startsWith(PLUGIN_SAVE_META_PREFIX)) {
            activeMetaKeys.add(row.storageKey);
        } else {
            activeValueKeys.add(row.storageKey);
        }
    }
    return {
        strippedDb,
        rows,
        changed: true,
        externalized: true,
        clearExisting: dbObj[PLUGIN_STORAGE_FOLDED_MARKER] === true,
        values: valueEntries.length,
        meta: metaEntries.length,
        manifest: createPluginStorageManifest(
            generation,
            activeValueKeys,
            activeMetaKeys,
            mergePluginStorageKeyMappings(
                null,
                [
                    ...valueEntries.map(([rawKey]) => rawKey),
                    ...metaEntries.map(([rawKey]) => rawKey),
                ],
                activeValueKeys,
                activeMetaKeys,
            ),
        ),
    };
}

function writePluginStorageRows(rows) {
    for (const row of rows) {
        validatePluginStorageRow(row.storageKey, row.value);
        kvSet(row.storageKey, row.value);
    }
}

function writePluginStorageManifest(manifest) {
    if (!manifest) return null;
    const bytes = Buffer.from(JSON.stringify(manifest), 'utf-8');
    kvSet(PLUGIN_STORAGE_MANIFEST_KEY, bytes);
    return bytes;
}

function pluginStorageManifestEquals(left, right) {
    if (left === null || right === null) return left === right;
    if (left.version !== right.version || left.generation !== right.generation) return false;
    if (left.version === 2 || left.version === 3) {
        const sameOrder = (a, b) => a.length === b.length
            && a.every((key, index) => key === b[index]);
        return sameOrder(left.valueKeys, right.valueKeys)
            && sameOrder(left.metaKeys, right.metaKeys)
            && (left.version !== 3 || (
                sameOrder(
                    left.keyMappings.map(entry => JSON.stringify(entry)),
                    right.keyMappings.map(entry => JSON.stringify(entry)),
                )
            ));
    }
    const sameKeys = (a, b) => {
        if (a.length !== b.length) return false;
        const rightKeys = new Set(b);
        return rightKeys.size === b.length
            && new Set(a).size === a.length
            && a.every(key => rightKeys.has(key));
    };
    return sameKeys(left.valueKeys, right.valueKeys)
        && sameKeys(left.metaKeys, right.metaKeys);
}

function normalizePluginStorageManifestRequest(value, fieldName, { nullable = false } = {}) {
    if (value === null && nullable) return null;
    const manifest = parsePluginStorageManifest(value);
    if (!manifest) throw new TypeError(`${fieldName} is not a valid plugin storage manifest`);
    return manifest;
}

function readPluginStorageManifestStateUncached(readValue = kvGet) {
    const raw = readValue(PLUGIN_STORAGE_MANIFEST_KEY);
    if (!raw) return { manifest: null, present: false, valid: true, revision: null };
    try {
        const manifest = parsePluginStorageManifest(JSON.parse(raw.toString('utf-8')));
        return {
            manifest,
            present: true,
            valid: manifest !== null,
            revision: manifest ? `sha256:${sha256Hex(raw)}` : null,
        };
    } catch {
        return { manifest: null, present: true, valid: false, revision: null };
    }
}

function readPluginStorageManifestState(readValue) {
    if (readValue !== undefined) {
        return readPluginStorageManifestStateUncached(readValue);
    }
    return pluginStorageManifestCache.read().state;
}

function readStrictPluginStorageOwnershipManifest(readValue = kvGet) {
    const raw = readValue(PLUGIN_STORAGE_MANIFEST_KEY);
    if (!raw) return { manifest: null, valueKeys: [], metaKeys: [] };

    let parsed;
    try {
        const bytes = Buffer.isBuffer(raw)
            ? raw
            : ArrayBuffer.isView(raw)
                ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
                : Buffer.from(raw);
        parsed = JSON.parse(bytes.toString('utf-8'));
    } catch {
        throw new TypeError('The live plugin storage manifest is malformed');
    }
    const manifest = parsePluginStorageManifest(parsed);
    if (!manifest) {
        throw new TypeError('The live plugin storage manifest is invalid');
    }
    // parsePluginStorageManifest canonicalizes duplicate entries for ordinary
    // reads. Destructive replacement needs a stronger ownership proof: a
    // duplicate declaration is ambiguous input, not permission to delete.
    if (manifest.valueKeys.length !== parsed.valueKeys.length
        || manifest.metaKeys.length !== parsed.metaKeys.length
        || (manifest.version === 3
            && manifest.keyMappings.length !== parsed.keyMappings.length)) {
        throw new TypeError('The live plugin storage manifest contains duplicate entries');
    }

    return {
        manifest,
        valueKeys: manifest.valueKeys,
        metaKeys: manifest.metaKeys,
    };
}

function validateStrictPluginStorageOwnershipRow(storageKey, readValue) {
    // Keep the byte body and its parsed JSON inside this narrow call. The
    // assertion validates row JSON without constructing another deep snapshot,
    // and neither representation is retained by the manifest proof.
    if (pluginStorageOwnershipReadFailpoint === 'any'
        || pluginStorageOwnershipReadFailpoint === storageKey) {
        throw new Error('Injected live plugin ownership body read failure');
    }
    const value = readValue(storageKey);
    if (!value) {
        throw new TypeError('The live plugin storage manifest references a missing row');
    }
    assertPluginStorageRow(storageKey, value);
    return value.byteLength ?? value.length ?? 0;
}

function readStrictPluginStorageOwnershipBoundary(readValue = kvGet) {
    const ownership = readStrictPluginStorageOwnershipManifest(readValue);
    for (const keys of [ownership.valueKeys, ownership.metaKeys]) {
        for (const storageKey of keys) {
            validateStrictPluginStorageOwnershipRow(storageKey, readValue);
        }
    }
    return ownership;
}

async function proveStrictPluginStorageOwnershipBoundary({
    readValue = kvGet,
    shouldAbort,
} = {}) {
    const stats = pluginStorageOwnershipStatsPath
        ? {
            activeRows: 0,
            completed: false,
            largestRowBytes: 0,
            maxActiveRows: 0,
            maxPostGcHeapGrowth: 0,
            rowsRead: 0,
        }
        : null;
    if (stats && typeof global.gc === 'function') global.gc();
    const baselineHeapUsed = stats ? process.memoryUsage().heapUsed : 0;
    throwIfStreamingRestoreAborted(shouldAbort);
    const ownership = readStrictPluginStorageOwnershipManifest(readValue);
    try {
        for (const keys of [ownership.valueKeys, ownership.metaKeys]) {
            for (const storageKey of keys) {
                throwIfStreamingRestoreAborted(shouldAbort);
                if (stats) {
                    stats.activeRows += 1;
                    stats.maxActiveRows = Math.max(stats.maxActiveRows, stats.activeRows);
                }
                let rowBytes = 0;
                try {
                    rowBytes = validateStrictPluginStorageOwnershipRow(storageKey, readValue);
                } finally {
                    if (stats) stats.activeRows -= 1;
                }
                if (stats) {
                    stats.rowsRead += 1;
                    stats.largestRowBytes = Math.max(stats.largestRowBytes, rowBytes);
                }
                // Give disconnect/AbortSignal state and GC a chance to settle
                // after every row. At this point the row-local Buffer, decoded
                // string, and parsed value are out of scope and no aggregate
                // body exists.
                await new Promise((resolve) => setImmediate(resolve));
                if (stats && typeof global.gc === 'function') {
                    global.gc();
                    stats.maxPostGcHeapGrowth = Math.max(
                        stats.maxPostGcHeapGrowth,
                        Math.max(0, process.memoryUsage().heapUsed - baselineHeapUsed),
                    );
                }
            }
        }
        throwIfStreamingRestoreAborted(shouldAbort);
        if (stats) stats.completed = true;
        return ownership;
    } finally {
        if (stats) {
            writeFileSync(pluginStorageOwnershipStatsPath, JSON.stringify(stats), 'utf-8');
        }
    }
}

function deleteOwnedPluginStorageRows(ownership) {
    for (const storageKey of ownership.valueKeys) kvDel(storageKey);
    for (const storageKey of ownership.metaKeys) kvDel(storageKey);
}

function pluginStorageGeneration(dbObj) {
    return typeof dbObj?.[PLUGIN_STORAGE_GENERATION_FIELD] === 'string'
        && dbObj[PLUGIN_STORAGE_GENERATION_FIELD].length > 0
        ? dbObj[PLUGIN_STORAGE_GENERATION_FIELD]
        : null;
}

function canonicalPluginStorageRowPrefix(storageKey) {
    const prefix = typeof storageKey === 'string' && storageKey.startsWith(PLUGIN_SAVE_META_PREFIX)
        ? PLUGIN_SAVE_META_PREFIX
        : typeof storageKey === 'string' && storageKey.startsWith(PLUGIN_SAVE_PREFIX)
            ? PLUGIN_SAVE_PREFIX
            : null;
    if (!prefix) return null;
    try {
        if (isHashedPluginSaveStorageKey(storageKey, prefix)) {
            assertArchiveSafePluginSaveStorageKey(storageKey);
        } else {
            decodePluginSaveStorageKey(storageKey, prefix);
        }
        return prefix;
    } catch {
        return null;
    }
}

async function readLivePluginStoragePublication() {
    await flushPendingDb();
    const prepared = await prepareLiveDatabaseRead('PluginStoragePublication', {
        includeFullBlob: false,
    });
    const dbObj = prepared?.strippedDatabase ?? null;
    const manifestEntry = pluginStorageManifestCache.read();
    return {
        dbObj,
        generation: pluginStorageGeneration(dbObj),
        manifestState: manifestEntry.state,
        manifestEntry,
    };
}

function pluginStorageBootRecoveryIssue(code, encodedKey) {
    return { code, encodedKey };
}

function serializeOptimizedPluginStorageRow(storageKey, prefix, value) {
    try {
        return serializePluginStorageRow(storageKey, value);
    } catch (error) {
        if (prefix !== PLUGIN_SAVE_PREFIX) throw error;
        return serializeLosslessPluginStorageRow(storageKey, value);
    }
}

function canonicalizeOptimizedPluginStorageRow(storageKey, prefix, bytes) {
    const codec = pluginStorageCodecForBuffer(bytes);
    if (prefix === PLUGIN_SAVE_META_PREFIX
        && codec === PLUGIN_STORAGE_LOSSLESS_CODEC) {
        throw new TypeError('Plugin storage metadata requires strict JSON');
    }
    const parsed = parsePluginStorageJsonBuffer(bytes, storageKey);
    return serializeOptimizedPluginStorageRow(storageKey, prefix, parsed);
}

function collectOptimizedBootInlineEntries(dbObj, field, prefix, issues) {
    const source = dbObj?.[field] ?? {};
    if (source === null || typeof source !== 'object' || Array.isArray(source)) {
        issues.push(pluginStorageBootRecoveryIssue('unsupported-json', prefix));
        return { entries: [], storageKeys: new Set(), valid: false };
    }
    const prototype = Reflect.getPrototypeOf(source);
    if (prototype !== Object.prototype && prototype !== null) {
        issues.push(pluginStorageBootRecoveryIssue('unsupported-json', prefix));
        return { entries: [], storageKeys: new Set(), valid: false };
    }

    const entries = [];
    const storageKeys = new Set();
    for (const rawKey of Reflect.ownKeys(source)) {
        if (typeof rawKey !== 'string') {
            issues.push(pluginStorageBootRecoveryIssue('unsupported-json', prefix));
            continue;
        }
        let storageKey;
        try {
            storageKey = encodePluginSaveStorageKey(rawKey, prefix);
        } catch {
            issues.push(pluginStorageBootRecoveryIssue('invalid-encoded-key', prefix));
            continue;
        }
        storageKeys.add(storageKey);
        const descriptor = Reflect.getOwnPropertyDescriptor(source, rawKey);
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
            issues.push(pluginStorageBootRecoveryIssue('unsupported-json', storageKey));
            continue;
        }
        try {
            const canonical = serializeOptimizedPluginStorageRow(
                storageKey,
                prefix,
                descriptor.value,
            );
            entries.push({
                rawKey,
                storageKey,
                prefix,
                value: descriptor.value,
                canonicalHash: sha256Hex(canonical),
            });
        } catch {
            issues.push(pluginStorageBootRecoveryIssue('unsupported-json', storageKey));
        }
    }
    return { entries, storageKeys, valid: true };
}

function decodeOptimizedBootStorageKey(storageKey, prefix, manifest) {
    const rawKey = isHashedPluginSaveStorageKey(storageKey, prefix)
        ? manifest
            ? decodeManifestPluginSaveStorageKey(manifest, storageKey, prefix)
            : null
        : decodePluginSaveStorageKey(storageKey, prefix);
    if (rawKey === null || encodePluginSaveStorageKey(rawKey, prefix) !== storageKey) {
        throw new TypeError('Plugin storage key is not canonical');
    }
    return rawKey;
}

async function inspectOptimizedBootExternalRows({
    prefix,
    listed,
    inlineStorageKeys,
    generation,
    manifest,
    issues,
}) {
    // Only duplicate hashes survive an iteration. Clean optimized databases
    // normally have no inline keys, so the retained map stays empty even when
    // the publication contains many large rows.
    const duplicateHashes = new Map();
    const ownedKeys = generation && manifest?.generation === generation
        ? new Set(prefix === PLUGIN_SAVE_META_PREFIX ? manifest.metaKeys : manifest.valueKeys)
        : null;
    for (const storageKey of listed) {
        let duplicateHash = null;
        try {
            decodeOptimizedBootStorageKey(storageKey, prefix, manifest);
            if (generation && (!ownedKeys || !ownedKeys.has(storageKey))) {
                // Generation-bound browser reads deliberately make undeclared
                // physical rows look absent. Preserve that recovery diagnostic
                // without transferring or parsing the quarantined body.
                issues.push(pluginStorageBootRecoveryIssue('read-failed', storageKey));
            } else {
                let bytes;
                let readFailed = false;
                try {
                    bytes = await kvGetAsync(storageKey);
                } catch {
                    issues.push(pluginStorageBootRecoveryIssue('read-failed', storageKey));
                    readFailed = true;
                }
                if (!readFailed && !bytes) {
                    issues.push(pluginStorageBootRecoveryIssue('read-failed', storageKey));
                } else if (bytes) {
                    try {
                        const canonical = canonicalizeOptimizedPluginStorageRow(
                            storageKey,
                            prefix,
                            bytes,
                        );
                        duplicateHash = inlineStorageKeys.has(storageKey)
                            ? sha256Hex(canonical)
                            : null;
                    } catch (error) {
                        issues.push(pluginStorageBootRecoveryIssue(
                            error instanceof SyntaxError ? 'invalid-json' : 'unsupported-json',
                            storageKey,
                        ));
                    }
                }
            }
        } catch {
            issues.push(pluginStorageBootRecoveryIssue('invalid-encoded-key', storageKey));
        }
        if (duplicateHash) duplicateHashes.set(storageKey, duplicateHash);
        // The row Buffer, decoded string, parsed value and canonical bytes are
        // all out of scope here. Yield so V8 can reclaim them before the next
        // potentially large record is read.
        await new Promise(resolve => setImmediate(resolve));
    }
    return duplicateHashes;
}

function nextOptimizedBootRecoveryManifest(manifest, generation, entries) {
    if (!generation) return null;
    if (!manifest || manifest.generation !== generation) {
        throw new Error('The selected plugin storage generation has no matching manifest');
    }
    const valueKeys = new Set(manifest.valueKeys);
    const metaKeys = new Set(manifest.metaKeys);
    for (const entry of entries) {
        if (entry.storageKey.startsWith(PLUGIN_SAVE_META_PREFIX)) {
            metaKeys.add(entry.storageKey);
        } else {
            valueKeys.add(entry.storageKey);
        }
    }
    return createPluginStorageManifest(
        generation,
        valueKeys,
        metaKeys,
        mergePluginStorageKeyMappings(
            manifest,
            entries.map(entry => entry.rawKey),
            valueKeys,
            metaKeys,
        ),
    );
}

function publishOptimizedBootRecoveryRows(entries, generation, manifest) {
    const prepared = entries.map(entry => ({
        ...entry,
        bytes: serializeOptimizedPluginStorageRow(
            entry.storageKey,
            entry.prefix,
            entry.value,
        ),
    }));
    const nextManifest = nextOptimizedBootRecoveryManifest(manifest, generation, prepared);
    const recoverySnapshotToken = newPluginRecoverySnapshotToken();
    withPluginStorageQuotaPlan(
        prepared
            .filter(entry => entry.storageKey.startsWith(PLUGIN_SAVE_PREFIX))
            .map(entry => ({ key: entry.storageKey, size: entry.bytes.length })),
        () => {
            for (const entry of prepared) kvSet(entry.storageKey, entry.bytes);
            if (nextManifest) writePluginStorageManifest(nextManifest);
            markPluginRecoverySnapshotDirty(recoverySnapshotToken);
        },
    );
    return nextManifest ?? manifest;
}

async function persistOptimizedBootInlineCleanup(req, liveDb) {
    if (!databaseSpoolReady) {
        throw new Error('The database spool is unavailable');
    }
    const targetDb = {
        ...liveDb,
        pluginCustomStorage: {},
    };
    delete targetDb.pluginStorageMeta;
    const spoolPath = path.join(
        databaseSpoolDir,
        `${DATABASE_SPOOL_FILE_PREFIX}plugin-boot-${process.pid}-${nodeCrypto.randomUUID()}.tmp`,
    );
    let spool = null;
    try {
        spool = await streamRisuSaveToFile({
            dbObj: targetDb,
            filePath: spoolPath,
            readChatRow: async () => null,
            foldChatRows: false,
        });
        const resultEtag = await computeFileEtag(spool.filePath);
        const recoverySnapshotToken = newPluginRecoverySnapshotToken();
        sqliteDb.transaction(() => {
            kvSetFromFile('database/database.bin', spool.filePath);
            markPluginRecoverySnapshotDirty(recoverySnapshotToken);
        })();
        invalidateDbCache();
        dbEtag = resultEtag;
        rememberSessionPluginStorageState(req, targetDb);
        return { etag: resultEtag, databaseChanged: true };
    } finally {
        if (spool) await fs.unlink(spool.filePath).catch(() => {});
        else await fs.unlink(spoolPath).catch(() => {});
    }
}

/**
 * Reconcile only the optimized-mode boot case. External row bodies are parsed
 * and released one at a time on the server; none are returned to the browser.
 * Inline mode retains the legacy client recovery path because its final state
 * necessarily contains the complete plugin map in browser memory.
 */
async function reconcileOptimizedPluginStorageForBoot(req, expectedEtag) {
    let copiedRows = false;
    const result = await queueStorageMutation(async () => {
        await flushPendingDb();
        const rawDatabase = kvGet('database/database.bin');
        if (!rawDatabase) {
            const error = new Error('Database not found');
            error.pluginStorageBootStatus = 409;
            throw error;
        }
        // Derive both accepted boot tokens from the bytes selected inside this
        // queued operation. Cache-off boot receives the raw-row token, while
        // cache-enabled boot receives the legacy-encoded normalized-view token.
        // Accepting either equivalent representation preserves the fence while
        // still detecting an out-of-process change to the selected database.
        const rawEtag = computeBufferEtag(rawDatabase);
        const liveDb = await decodeAuthoritativeDatabase(rawDatabase);
        const canonicalEtag = expectedEtag === rawEtag
            ? null
            : prepareDatabaseReadPayload(
                normalizeDecodedDatabaseForRead(liveDb),
            ).etag;
        if (expectedEtag !== rawEtag && expectedEtag !== canonicalEtag) {
            // Raw boot reloads do not populate the process-local cache token;
            // leave it aligned with the current raw row until that reload or a
            // cached read establishes its own equivalent representation.
            dbEtag = rawEtag;
            const error = new Error('Database changed before plugin storage reconciliation');
            error.pluginStorageBootStatus = 409;
            error.currentEtag = rawEtag;
            throw error;
        }
        // Subsequent ordinary saves must use the same representation that the
        // active client proved, rather than switching token domains mid-boot.
        dbEtag = expectedEtag;

        if (liveDb?.optimizePluginMemory !== true) {
            return {
                direction: 'none',
                values: 0,
                meta: 0,
                issues: [],
                etag: expectedEtag,
                databaseChanged: false,
                storageChanged: false,
            };
        }

        const issues = [];
        const inlineValues = collectOptimizedBootInlineEntries(
            liveDb,
            'pluginCustomStorage',
            PLUGIN_SAVE_PREFIX,
            issues,
        );
        const inlineMeta = collectOptimizedBootInlineEntries(
            liveDb,
            'pluginStorageMeta',
            PLUGIN_SAVE_META_PREFIX,
            issues,
        );
        let listedValues;
        let listedMeta;
        try {
            listedValues = kvList(PLUGIN_SAVE_PREFIX);
        } catch {
            listedValues = null;
            issues.push(pluginStorageBootRecoveryIssue('list-failed', PLUGIN_SAVE_PREFIX));
        }
        try {
            listedMeta = kvList(PLUGIN_SAVE_META_PREFIX);
        } catch {
            listedMeta = null;
            issues.push(pluginStorageBootRecoveryIssue('list-failed', PLUGIN_SAVE_META_PREFIX));
        }

        const generation = pluginStorageGeneration(liveDb);
        let manifest = null;
        if (generation) {
            const rawManifest = kvGet(PLUGIN_STORAGE_MANIFEST_KEY);
            if (rawManifest) {
                try {
                    const parsed = JSON.parse(rawManifest.toString('utf-8'));
                    const normalized = parsePluginStorageManifest(parsed);
                    if (normalized?.generation === generation) manifest = normalized;
                } catch {
                    issues.push(pluginStorageBootRecoveryIssue(
                        'invalid-json',
                        PLUGIN_STORAGE_MANIFEST_KEY,
                    ));
                }
            }
        }

        const externalValues = await inspectOptimizedBootExternalRows({
            prefix: PLUGIN_SAVE_PREFIX,
            listed: listedValues ?? [],
            inlineStorageKeys: inlineValues.storageKeys,
            generation,
            manifest,
            issues,
        });
        const externalMeta = await inspectOptimizedBootExternalRows({
            prefix: PLUGIN_SAVE_META_PREFIX,
            listed: listedMeta ?? [],
            inlineStorageKeys: inlineMeta.storageKeys,
            generation,
            manifest,
            issues,
        });

        for (const [inline, external] of [
            [inlineValues, externalValues],
            [inlineMeta, externalMeta],
        ]) {
            for (const entry of inline.entries) {
                const duplicate = external.get(entry.storageKey);
                if (duplicate && duplicate !== entry.canonicalHash) {
                    issues.push(pluginStorageBootRecoveryIssue(
                        'conflicting-copies',
                        entry.storageKey,
                    ));
                }
            }
        }

        let valueCopies = 0;
        let metaCopies = 0;
        const listedValueSet = listedValues === null ? null : new Set(listedValues);
        const listedMetaSet = listedMeta === null ? null : new Set(listedMeta);
        const inlineMetaByRawKey = new Map(
            inlineMeta.entries.map(entry => [entry.rawKey, entry]),
        );
        const pairedMetaKeys = new Set();
        let currentManifest = manifest;

        if (listedValueSet) {
            for (const entry of inlineValues.entries) {
                if (listedValueSet.has(entry.storageKey)) continue;
                const metaEntry = inlineMetaByRawKey.get(entry.rawKey);
                if (metaEntry && listedMetaSet?.has(metaEntry.storageKey)) {
                    const external = externalMeta.get(metaEntry.storageKey);
                    if (!external || external !== metaEntry.canonicalHash) continue;
                }
                if (metaEntry) pairedMetaKeys.add(metaEntry.storageKey);
                try {
                    currentManifest = publishOptimizedBootRecoveryRows(
                        [entry, ...(metaEntry ? [metaEntry] : [])],
                        generation,
                        currentManifest,
                    );
                    copiedRows = true;
                    valueCopies += 1;
                    if (metaEntry && !listedMetaSet?.has(metaEntry.storageKey)) metaCopies += 1;
                } catch {
                    issues.push(pluginStorageBootRecoveryIssue('write-failed', entry.storageKey));
                }
            }
        }

        if (listedMetaSet) {
            for (const entry of inlineMeta.entries) {
                if (pairedMetaKeys.has(entry.storageKey) || listedMetaSet.has(entry.storageKey)) {
                    continue;
                }
                try {
                    currentManifest = publishOptimizedBootRecoveryRows(
                        [entry],
                        generation,
                        currentManifest,
                    );
                    copiedRows = true;
                    metaCopies += 1;
                } catch {
                    issues.push(pluginStorageBootRecoveryIssue('write-failed', entry.storageKey));
                }
            }
        }

        const inlineTotal = inlineValues.entries.length + inlineMeta.entries.length;
        let cleanup = {
            etag: expectedEtag,
            databaseChanged: false,
        };
        if (inlineTotal > 0 && issues.length === 0) {
            try {
                cleanup = await persistOptimizedBootInlineCleanup(req, liveDb);
            } catch {
                issues.push(pluginStorageBootRecoveryIssue(
                    'persist-failed',
                    'database/database.bin',
                ));
            }
        }

        return {
            direction: inlineTotal > 0 || issues.length > 0 ? 'externalize' : 'none',
            values: valueCopies,
            meta: metaCopies,
            issues,
            etag: cleanup.etag,
            databaseChanged: cleanup.databaseChanged,
            storageChanged: copiedRows,
        };
    }, 'plugin-boot-reconcile');
    if (copiedRows || result.databaseChanged) schedulePluginRecoverySnapshot();
    return result;
}

const pluginStorageRecoveryManagementSecret = nodeCrypto.randomBytes(32);

function pluginStorageRecoveryManagementKind(encodedKey) {
    if (encodedKey === PLUGIN_STORAGE_MANIFEST_KEY) return 'manifest';
    if (encodedKey.startsWith(PLUGIN_SAVE_META_PREFIX)) return 'metadata';
    if (encodedKey.startsWith(PLUGIN_SAVE_PREFIX)) return 'value';
    return 'storage';
}

function pluginStorageRecoveryManagementToken(context, issue) {
    return nodeCrypto.createHmac('sha256', pluginStorageRecoveryManagementSecret)
        .update(JSON.stringify([
            issue.code,
            issue.encodedKey,
            sessionLock.epoch(),
            context.databaseRevision,
            context.generation ?? '',
            context.manifestRevision ?? '',
            issue.externalHash ?? '',
            issue.inlineEntry?.canonicalHash ?? '',
            issue.externalAvailable === true,
            issue.inlineEntry !== null,
            issue.owned === true,
            issue.canUseInline === true,
            issue.canDelete === true,
        ]))
        .digest('base64url');
}

function publicPluginStorageRecoveryManagementIssue(context, issue) {
    return {
        code: issue.code,
        encodedKey: issue.encodedKey,
        kind: pluginStorageRecoveryManagementKind(issue.encodedKey),
        inlineAvailable: issue.inlineEntry !== null,
        externalAvailable: issue.externalAvailable === true,
        externalSize: Number.isSafeInteger(issue.externalSize) ? issue.externalSize : null,
        actions: {
            download: issue.externalAvailable === true,
            useInline: issue.canUseInline === true,
            delete: issue.canDelete === true,
        },
        token: pluginStorageRecoveryManagementToken(context, issue),
    };
}

function internalPluginStorageRecoveryManagementIssue(code, encodedKey, overrides = {}) {
    return {
        code,
        encodedKey,
        rawKey: null,
        prefix: null,
        inlineEntry: null,
        externalAvailable: false,
        externalSize: null,
        externalHash: null,
        owned: false,
        canUseInline: false,
        canDelete: false,
        ...overrides,
    };
}

/**
 * Rebuild an encoded-key-only recovery management view from the live optimized
 * publication. Values remain server-side; the returned action token binds the
 * database row, manifest, inline candidate, and exact external bytes.
 */
async function inspectOptimizedPluginStorageRecoveryManagement() {
    await flushPendingDb();
    const rawDatabase = kvGet('database/database.bin');
    if (!rawDatabase) throw new Error('Database not found');
    const liveDb = await decodeAuthoritativeDatabase(rawDatabase);
    const databaseRevision = sha256Hex(rawDatabase);
    if (liveDb?.optimizePluginMemory !== true) {
        return {
            mode: 'inline',
            checkedAt: Date.now(),
            context: {
                databaseRevision,
                generation: null,
                manifestRevision: null,
            },
            issues: [],
            liveDb,
            manifestEntry: null,
        };
    }

    const collectionIssues = [];
    const inlineValues = collectOptimizedBootInlineEntries(
        liveDb,
        'pluginCustomStorage',
        PLUGIN_SAVE_PREFIX,
        collectionIssues,
    );
    const inlineMeta = collectOptimizedBootInlineEntries(
        liveDb,
        'pluginStorageMeta',
        PLUGIN_SAVE_META_PREFIX,
        collectionIssues,
    );
    const inlineValueByStorageKey = new Map(
        inlineValues.entries.map(entry => [entry.storageKey, entry]),
    );
    const inlineMetaByStorageKey = new Map(
        inlineMeta.entries.map(entry => [entry.storageKey, entry]),
    );
    const generation = pluginStorageGeneration(liveDb);
    const manifestBytes = kvGet(PLUGIN_STORAGE_MANIFEST_KEY);
    const manifestEntry = pluginStorageManifestCache.read();
    const manifestState = manifestEntry.state;
    const manifest = generation
        && manifestState.valid === true
        && manifestState.manifest?.generation === generation
        ? manifestState.manifest
        : null;
    const context = {
        databaseRevision,
        generation,
        manifestRevision: Buffer.isBuffer(manifestBytes) ? sha256Hex(manifestBytes) : null,
    };
    const canMutatePublication = generation === null || manifest !== null;
    const issues = collectionIssues.map(issue => internalPluginStorageRecoveryManagementIssue(
        issue.code,
        issue.encodedKey,
    ));

    if (manifestState.present && manifestState.valid !== true) {
        issues.push(internalPluginStorageRecoveryManagementIssue(
            'invalid-json',
            PLUGIN_STORAGE_MANIFEST_KEY,
            {
                externalAvailable: Buffer.isBuffer(manifestBytes),
                externalSize: Buffer.isBuffer(manifestBytes) ? manifestBytes.length : null,
                externalHash: Buffer.isBuffer(manifestBytes) ? sha256Hex(manifestBytes) : null,
            },
        ));
    }

    const scanPrefix = async (prefix, listed, inlineByStorageKey) => {
        const ownedKeys = generation && manifest
            ? new Set(prefix === PLUGIN_SAVE_META_PREFIX ? manifest.metaKeys : manifest.valueKeys)
            : null;
        for (const encodedKey of listed) {
            let rawKey = null;
            try {
                rawKey = decodeOptimizedBootStorageKey(encodedKey, prefix, manifest);
            } catch {
                const inlineEntry = inlineByStorageKey.get(encodedKey) ?? null;
                rawKey = inlineEntry?.rawKey ?? null;
                const externalBytes = kvGet(encodedKey);
                issues.push(internalPluginStorageRecoveryManagementIssue(
                    'invalid-encoded-key',
                    encodedKey,
                    {
                        rawKey,
                        prefix,
                        inlineEntry,
                        externalAvailable: Buffer.isBuffer(externalBytes),
                        externalSize: Buffer.isBuffer(externalBytes) ? externalBytes.length : null,
                        externalHash: Buffer.isBuffer(externalBytes) ? sha256Hex(externalBytes) : null,
                        owned: ownedKeys?.has(encodedKey) === true,
                        canUseInline: inlineEntry !== null && canMutatePublication,
                        canDelete: Buffer.isBuffer(externalBytes)
                            && inlineEntry === null
                            && canMutatePublication,
                    },
                ));
                continue;
            }

            const inlineEntry = inlineByStorageKey.get(encodedKey) ?? null;
            let externalBytes = null;
            try {
                externalBytes = await kvGetAsync(encodedKey);
            } catch {
                issues.push(internalPluginStorageRecoveryManagementIssue(
                    'read-failed',
                    encodedKey,
                    { rawKey, prefix, inlineEntry },
                ));
                continue;
            }
            if (!Buffer.isBuffer(externalBytes)) {
                issues.push(internalPluginStorageRecoveryManagementIssue(
                    'read-failed',
                    encodedKey,
                    { rawKey, prefix, inlineEntry },
                ));
                continue;
            }

            const externalHash = sha256Hex(externalBytes);
            const owned = generation === null || ownedKeys?.has(encodedKey) === true;
            const common = {
                rawKey,
                prefix,
                inlineEntry,
                externalAvailable: true,
                externalSize: externalBytes.length,
                externalHash,
                owned,
            };
            if (generation && !owned) {
                issues.push(internalPluginStorageRecoveryManagementIssue(
                    'read-failed',
                    encodedKey,
                    {
                        ...common,
                        canUseInline: inlineEntry !== null && canMutatePublication,
                        canDelete: inlineEntry === null && canMutatePublication,
                    },
                ));
                continue;
            }

            let canonicalHash = null;
            try {
                canonicalHash = sha256Hex(canonicalizeOptimizedPluginStorageRow(
                    encodedKey,
                    prefix,
                    externalBytes,
                ));
            } catch (error) {
                issues.push(internalPluginStorageRecoveryManagementIssue(
                    error instanceof SyntaxError ? 'invalid-json' : 'unsupported-json',
                    encodedKey,
                    {
                        ...common,
                        canUseInline: inlineEntry !== null && canMutatePublication,
                        canDelete: inlineEntry === null && canMutatePublication,
                    },
                ));
                continue;
            }
            if (inlineEntry && canonicalHash !== inlineEntry.canonicalHash) {
                issues.push(internalPluginStorageRecoveryManagementIssue(
                    'conflicting-copies',
                    encodedKey,
                    {
                        ...common,
                        canUseInline: canMutatePublication,
                    },
                ));
            }
        }
    };

    let listedValues = [];
    let listedMeta = [];
    try {
        listedValues = kvList(PLUGIN_SAVE_PREFIX);
    } catch {
        issues.push(internalPluginStorageRecoveryManagementIssue('list-failed', PLUGIN_SAVE_PREFIX));
    }
    try {
        listedMeta = kvList(PLUGIN_SAVE_META_PREFIX);
    } catch {
        issues.push(internalPluginStorageRecoveryManagementIssue('list-failed', PLUGIN_SAVE_META_PREFIX));
    }
    await scanPrefix(PLUGIN_SAVE_PREFIX, listedValues, inlineValueByStorageKey);
    await scanPrefix(PLUGIN_SAVE_META_PREFIX, listedMeta, inlineMetaByStorageKey);

    // Deleting a value also removes its ownership sidecar. Do not offer that
    // action while a recoverable inline owner copy would be discarded with it.
    for (const issue of issues) {
        if (!issue.canDelete || issue.prefix !== PLUGIN_SAVE_PREFIX || issue.rawKey === null) continue;
        const inlineMetaKey = encodePluginSaveStorageKey(issue.rawKey, PLUGIN_SAVE_META_PREFIX);
        if (inlineMetaByStorageKey.has(inlineMetaKey)) issue.canDelete = false;
    }

    return {
        mode: 'optimized',
        checkedAt: Date.now(),
        context,
        issues,
        liveDb,
        manifestEntry,
    };
}

function publicOptimizedPluginStorageRecoveryManagementInspection(inspection) {
    return {
        success: true,
        mode: inspection.mode,
        checkedAt: inspection.checkedAt,
        issues: inspection.issues.map(issue => (
            publicPluginStorageRecoveryManagementIssue(inspection.context, issue)
        )),
    };
}

function findOptimizedPluginStorageRecoveryManagementIssue(inspection, encodedKey, token) {
    return inspection.issues.find(issue => (
        issue.encodedKey === encodedKey
        && pluginStorageRecoveryManagementToken(inspection.context, issue) === token
    )) ?? null;
}

function preparePluginStorageRecoveryManifestUpdate(inspection, changes) {
    if (inspection.context.generation === null) return null;
    return pluginStorageManifestCache.prepareUpdate(inspection.manifestEntry, changes);
}

function pluginStorageRecoveryProofChanged() {
    const error = new Error('Plugin storage recovery proof changed');
    error.pluginStorageRecoveryStale = true;
    return error;
}

function assertPluginStorageRecoveryProofCurrent(inspection, issue) {
    try {
        const databaseBytes = kvGet('database/database.bin');
        if (!Buffer.isBuffer(databaseBytes)
            || sha256Hex(databaseBytes) !== inspection.context.databaseRevision) {
            throw pluginStorageRecoveryProofChanged();
        }
        const manifestBytes = kvGet(PLUGIN_STORAGE_MANIFEST_KEY);
        const manifestRevision = Buffer.isBuffer(manifestBytes)
            ? sha256Hex(manifestBytes)
            : null;
        if (manifestRevision !== inspection.context.manifestRevision) {
            throw pluginStorageRecoveryProofChanged();
        }
        const externalBytes = kvGet(issue.encodedKey);
        if (!Buffer.isBuffer(externalBytes)
            || externalBytes.length !== issue.externalSize
            || sha256Hex(externalBytes) !== issue.externalHash) {
            throw pluginStorageRecoveryProofChanged();
        }
    } catch (error) {
        if (error?.pluginStorageRecoveryStale) throw error;
        throw pluginStorageRecoveryProofChanged();
    }
}

function resolveOptimizedPluginStorageRecoveryIssue(inspection, issue, action) {
    let manifestUpdate = null;
    let committedManifestBytes = null;
    let committedPublicationRevision = null;
    const recoverySnapshotToken = newPluginRecoverySnapshotToken();
    sqliteDb.transaction(() => {
        assertPluginStorageRecoveryProofCurrent(inspection, issue);
        // Suspicious rows may have been restored or edited outside the ordinary
        // mutation API. Repair derived quota accounting inside the same write
        // transaction that revalidates and resolves the selected row.
        reconcilePluginStorageUsage();

        if (action === 'use-inline') {
            if (!issue.canUseInline || !issue.inlineEntry || issue.rawKey === null || !issue.prefix) {
                throw new TypeError('The inline recovery action is unavailable.');
            }
            const rowBytes = serializePluginStorageRow(issue.encodedKey, issue.inlineEntry.value);
            if (inspection.context.generation && !issue.owned) {
                manifestUpdate = preparePluginStorageRecoveryManifestUpdate(inspection, {
                    valueAdds: issue.prefix === PLUGIN_SAVE_PREFIX ? [issue.encodedKey] : [],
                    metaAdds: issue.prefix === PLUGIN_SAVE_META_PREFIX ? [issue.encodedKey] : [],
                    rawKeys: [issue.rawKey],
                });
            }
            withPluginStorageQuotaPlan(
                issue.prefix === PLUGIN_SAVE_PREFIX
                    ? [{ key: issue.encodedKey, size: rowBytes.length }]
                    : [],
                () => {
                    kvSet(issue.encodedKey, rowBytes);
                    if (manifestUpdate) {
                        committedManifestBytes = writePluginStorageManifest(manifestUpdate.manifest);
                    }
                    markPluginRecoverySnapshotDirty(recoverySnapshotToken);
                    committedPublicationRevision = kvGetPluginStoragePublicationRevision();
                },
            );
        } else if (action === 'delete') {
            if (!issue.canDelete || !issue.externalAvailable) {
                throw new TypeError('The delete recovery action is unavailable.');
            }
            const valueDeletes = [];
            const metaDeletes = [];
            const deleteKeys = [issue.encodedKey];
            if (issue.prefix === PLUGIN_SAVE_PREFIX) {
                valueDeletes.push(issue.encodedKey);
                if (issue.rawKey !== null) {
                    const ownerKey = encodePluginSaveStorageKey(issue.rawKey, PLUGIN_SAVE_META_PREFIX);
                    metaDeletes.push(ownerKey);
                    if (kvSize(ownerKey) !== null) deleteKeys.push(ownerKey);
                }
            } else if (issue.prefix === PLUGIN_SAVE_META_PREFIX) {
                metaDeletes.push(issue.encodedKey);
            }
            if (inspection.context.generation) {
                manifestUpdate = preparePluginStorageRecoveryManifestUpdate(inspection, {
                    valueDeletes,
                    metaDeletes,
                });
            }
            withPluginStorageQuotaPlan(
                deleteKeys
                    .filter(key => key.startsWith(PLUGIN_SAVE_PREFIX))
                    .map(key => ({ key, size: null })),
                () => {
                    for (const key of deleteKeys) kvDel(key);
                    if (manifestUpdate) {
                        committedManifestBytes = writePluginStorageManifest(manifestUpdate.manifest);
                    }
                    markPluginRecoverySnapshotDirty(recoverySnapshotToken);
                    committedPublicationRevision = kvGetPluginStoragePublicationRevision();
                },
            );
        } else {
            throw new TypeError('Unknown plugin storage recovery action.');
        }
    })();

    if (manifestUpdate) {
        pluginStorageManifestCache.publishPrepared(manifestUpdate, {
            revision: committedPublicationRevision,
            manifestRevision: `sha256:${sha256Hex(committedManifestBytes)}`,
        });
    }
    schedulePluginRecoverySnapshot();
}

function pluginStorageNamespaceConflict(message) {
    const error = new Error(message);
    error.pluginStorageNamespaceConflict = true;
    return error;
}

function assertGenericPluginStorageMutationAllowed(storageKey, publication) {
    if (storageKey === 'database/database.bin') {
        const hasPublishedPluginStorage = publication.generation
            || publication.manifestState.present
            || (publication.dbObj?.optimizePluginMemory === true && (
                kvList(PLUGIN_SAVE_PREFIX).length > 0
                || kvList(PLUGIN_SAVE_META_PREFIX).length > 0
            ));
        if (hasPublishedPluginStorage) {
            throw pluginStorageNamespaceConflict(
                'database.bin cannot be removed while it selects a plugin storage publication',
            );
        }
        return;
    }
    if (storageKey === PLUGIN_STORAGE_MANIFEST_KEY) {
        throw pluginStorageNamespaceConflict(
            'The plugin storage manifest can only be changed by an atomic plugin storage transaction',
        );
    }
    const prefix = canonicalPluginStorageRowPrefix(storageKey);
    if (!prefix) return;

    const { dbObj, generation, manifestState } = publication;
    // As soon as a generation or manifest exists, the whole canonical row
    // namespace is reserved. Unlisted physical names are quarantined, not an
    // alternate generic-write channel into a future publication.
    if (generation || manifestState.present) {
        throw pluginStorageNamespaceConflict(
            'The generated plugin storage namespace can only be changed atomically',
        );
    }

    throw pluginStorageNamespaceConflict(
        dbObj?.optimizePluginMemory === true
            ? 'Legacy plugin storage must be adopted before rows can be changed atomically'
            : 'The generated plugin storage namespace is not writable in the selected mode',
    );
}

function assertGenericDatabasePluginPublicationAllowed(
    livePublication,
    incomingDb,
    pluginExternalization,
) {
    const liveDb = livePublication.dbObj;
    const liveGeneration = livePublication.generation;
    const incomingGeneration = pluginStorageGeneration(incomingDb);
    const manifestState = livePublication.manifestState;
    const touchesPublication = pluginExternalization.rows.length > 0
        || pluginExternalization.manifest !== null
        || pluginExternalization.clearExisting === true;
    const hasPhysicalRows = kvList(PLUGIN_SAVE_PREFIX).length > 0
        || kvList(PLUGIN_SAVE_META_PREFIX).length > 0;

    if (!liveDb) {
        if (manifestState.present || (hasPhysicalRows && (
            incomingDb?.optimizePluginMemory !== true
            || incomingGeneration !== null
            || touchesPublication
        ))) {
            throw pluginStorageNamespaceConflict(
                'Existing plugin storage rows must be adopted as an unchanged legacy publication',
            );
        }
        return;
    }

    if (liveGeneration || manifestState.present) {
        if (
            incomingDb?.optimizePluginMemory !== (liveDb.optimizePluginMemory === true)
            || incomingGeneration !== liveGeneration
            || touchesPublication
        ) {
            throw pluginStorageNamespaceConflict(
                'Plugin storage mode, generation, rows, and manifest must be changed atomically',
            );
        }
        return;
    }

    if (liveDb.optimizePluginMemory === true && hasPhysicalRows && (
        incomingDb?.optimizePluginMemory !== true
        || incomingGeneration !== null
        || touchesPublication
    )) {
        throw pluginStorageNamespaceConflict(
            'Legacy plugin storage must be adopted by an atomic plugin storage transition',
        );
    }
}

async function readGenerationBoundPluginStorageRow(req, storageKey) {
    const explicitGeneration = req.headers['x-plugin-storage-generation'];
    if (explicitGeneration !== undefined
        && (typeof explicitGeneration !== 'string' || explicitGeneration.length === 0)) {
        throw new TypeError('x-plugin-storage-generation must be a non-empty string');
    }
    const pinnedState = sessionPluginStorageReadState(req);
    if (typeof explicitGeneration === 'string' && pinnedState && (
        pinnedState.optimized !== true
        || pinnedState.generation !== explicitGeneration
    )) {
        throw pluginStorageNamespaceConflict(
            'The requested plugin storage generation does not match this session database',
        );
    }
    const expectedState = typeof explicitGeneration === 'string'
        ? { optimized: true, generation: explicitGeneration }
        : pinnedState;

    return queueStorageReadAfterImports(async () => {
        const publication = await readLivePluginStoragePublication();
        const { dbObj, generation, manifestState } = publication;
        const prefix = canonicalPluginStorageRowPrefix(storageKey);
        if (!prefix) throw new TypeError('Invalid plugin storage row key');

        const activeManifest = generation
            && dbObj?.optimizePluginMemory === true
            && manifestState.valid
            && manifestState.manifest?.generation === generation
            ? manifestState.manifest
            : null;
        const legacyPublication = !generation
            && dbObj?.optimizePluginMemory === true
            && !manifestState.present;

        if (!expectedState) {
            if (activeManifest || legacyPublication) {
                throw pluginStorageNamespaceConflict(
                    'Read database.bin before reading authoritative plugin storage rows',
                );
            }
            return kvGetAsync(storageKey);
        }
        if (
            expectedState.optimized !== (dbObj?.optimizePluginMemory === true)
            || expectedState.generation !== generation
        ) {
            throw pluginStorageNamespaceConflict(
                'Plugin storage generation changed before the row could be read',
            );
        }

        if (generation) {
            if (!activeManifest) {
                throw pluginStorageNamespaceConflict(
                    'The selected plugin storage generation has no matching manifest',
                );
            }
            const ownedKeys = prefix === PLUGIN_SAVE_META_PREFIX
                ? activeManifest.metaKeys
                : activeManifest.valueKeys;
            // Exact ownership is also enforced at the read boundary. A foreign
            // physical row must look absent even if a caller guesses its name.
            return ownedKeys.includes(storageKey) ? kvGetAsync(storageKey) : null;
        }
        if (!legacyPublication) {
            throw pluginStorageNamespaceConflict(
                'The legacy plugin storage publication changed before the row could be read',
            );
        }
        return kvGetAsync(storageKey);
    });
}

function assertPluginStorageSource(source, liveDb, manifestState) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
        throw new TypeError('source must be an object');
    }
    if (typeof source.optimized !== 'boolean') {
        throw new TypeError('source.optimized must be a boolean');
    }
    const expectedGeneration = source.generation === null
        ? null
        : typeof source.generation === 'string' && source.generation.length > 0
            ? source.generation
            : undefined;
    if (expectedGeneration === undefined) {
        throw new TypeError('source.generation must be null or a non-empty string');
    }
    const expectedManifest = normalizePluginStorageManifestRequest(
        source.manifest,
        'source.manifest',
        { nullable: true },
    );
    const liveOptimized = liveDb?.optimizePluginMemory === true;
    const liveGeneration = pluginStorageGeneration(liveDb);
    if (
        liveOptimized !== source.optimized
        || liveGeneration !== expectedGeneration
        || !manifestState.valid
        || !pluginStorageManifestEquals(manifestState.manifest, expectedManifest)
    ) {
        const error = new Error('Plugin storage state changed while the operation was being prepared');
        error.pluginStorageConflict = true;
        throw error;
    }
}

function resolveOwnedPluginStorageKeys(dbObj, reader = { kvGet, kvList }) {
    if (dbObj?.optimizePluginMemory !== true) {
        return { valueKeys: [], metaKeys: [] };
    }

    const generation = pluginStorageGeneration(dbObj);
    if (generation) {
        const ownership = readStrictPluginStorageOwnershipManifest(reader.kvGet);
        if (!ownership.manifest) {
            throw new TypeError(
                'The selected plugin storage generation has no authoritative manifest',
            );
        }
        if (ownership.manifest.generation !== generation) {
            throw new TypeError(
                'The selected plugin storage generation does not match its manifest',
            );
        }
        const physicalValues = new Set(reader.kvList(PLUGIN_SAVE_PREFIX));
        const physicalMeta = new Set(reader.kvList(PLUGIN_SAVE_META_PREFIX));
        for (const storageKey of ownership.valueKeys) {
            if (!physicalValues.has(storageKey)) {
                throw new TypeError(
                    `The plugin storage manifest references a missing row: ${storageKey}`,
                );
            }
        }
        for (const storageKey of ownership.metaKeys) {
            if (!physicalMeta.has(storageKey)) {
                throw new TypeError(
                    `The plugin storage manifest references a missing row: ${storageKey}`,
                );
            }
        }
        return {
            valueKeys: ownership.valueKeys,
            metaKeys: ownership.metaKeys,
            manifest: ownership.manifest,
        };
    }

    const manifestState = readPluginStorageManifestState(reader.kvGet);
    if (manifestState.present) {
        throw new TypeError(
            'Legacy optimized plugin storage cannot select a generated manifest',
        );
    }
    return {
        valueKeys: reader.kvList(PLUGIN_SAVE_PREFIX),
        metaKeys: reader.kvList(PLUGIN_SAVE_META_PREFIX),
        manifest: null,
    };
}

function maybeFailPluginStorageTransaction(req, boundary) {
    if (process.env.POCKETRISU_PLUGIN_STORAGE_TEST_FAILPOINTS !== '1') return;
    if (req.headers['x-plugin-storage-failpoint'] === boundary) {
        throw new Error(`Injected plugin storage failure at ${boundary}`);
    }
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

    // A folded source proves its own exact target set, but it does not prove
    // that every physical row in the shared prefix belongs to the publication
    // being replaced. Delete only the rows named by a strict, complete live
    // ownership boundary; foreign/quarantined rows remain untouched.
    const priorOwnership = prepared.clearExisting
        ? readStrictPluginStorageOwnershipBoundary()
        : null;
    const writeRows = sqliteDb.transaction(() => {
        if (prepared.clearExisting) {
            deleteOwnedPluginStorageRows(priorOwnership);
        }
        writePluginStorageRows(prepared.rows);
        writePluginStorageManifest(prepared.manifest);
    });
    writeRows();

    if (prepared.externalized) {
        dbObj.pluginCustomStorage = {};
        delete dbObj.pluginStorageMeta;
        dbObj[PLUGIN_STORAGE_GENERATION_FIELD]
            = prepared.strippedDb[PLUGIN_STORAGE_GENERATION_FIELD];
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
        throw new PluginStorageValidationError(storageKey);
    }
    return validatePluginStorageRow(storageKey, value);
}

function readPluginStorageManifest(readValue) {
    return readPluginStorageManifestState(readValue).manifest;
}

function resolveOwnedPluginStorageRows(dbObj, reader) {
    const { valueKeys, metaKeys, manifest } = resolveOwnedPluginStorageKeys(dbObj, reader);

    return {
        valueRows: valueKeys.map((storageKey) => ({
            key: manifest
                ? decodeManifestPluginSaveStorageKey(manifest, storageKey, PLUGIN_SAVE_PREFIX)
                : decodeValidatedPluginStorageKey(storageKey, PLUGIN_SAVE_PREFIX),
            source: storageKey,
        })),
        metaRows: metaKeys.map((storageKey) => ({
            key: manifest
                ? decodeManifestPluginSaveStorageKey(manifest, storageKey, PLUGIN_SAVE_META_PREFIX)
                : decodeValidatedPluginStorageKey(storageKey, PLUGIN_SAVE_META_PREFIX),
            source: storageKey,
        })),
        readRow: (storageKey) => parsePluginSaveJson(storageKey, reader.kvGet),
    };
}

function collectDatabaseAssetReferences(
    dbObj,
    assetEntries,
    reader = { kvGet, kvList },
) {
    const knownAssetKeys = new Set(assetEntries.map((entry) => entry.key));
    const referencedKeys = collectReferencedAssetKeys(dbObj, knownAssetKeys);
    const pluginStorage = resolveOwnedPluginStorageRows(dbObj, reader);
    // Optimized values stay external precisely so large stores do not inflate
    // database.bin. Decode and release one authoritative manifest row at a time.
    for (const row of pluginStorage.valueRows) {
        collectReferencedAssetKeys(
            pluginStorage.readRow(row.source),
            knownAssetKeys,
            referencedKeys,
        );
    }
    return referencedKeys;
}

async function runServerAssetCleanup({ now = Date.now(), source = 'manual' } = {}) {
    return queueStorageMutation(async () => {
        await flushPendingDb();
        const raw = kvGet(DB_BLOB_KEY);
        if (!raw) {
            return {
                ok: true,
                skipped: true,
                reason: 'database-missing',
                source,
                graceMs: ASSET_GC_GRACE_MS,
                assets: 0,
                referenced: 0,
                marked: 0,
                retainedByGrace: 0,
                deleted: 0,
                candidatesCleared: 0,
            };
        }

        // Any decode, manifest, ownership, or plugin-row validation failure
        // escapes before the candidate table or an asset is changed.
        const dbObj = await loadStrippedDatabase(raw, 'AssetGC');
        const assetEntries = listAssetEntriesWithSizes();
        const referencedKeys = collectDatabaseAssetReferences(dbObj, assetEntries);
        const candidates = assetGcCandidateStore.list();
        const plan = planAssetGc({
            assets: assetEntries,
            referencedKeys,
            candidates,
            now,
            graceMs: ASSET_GC_GRACE_MS,
        });

        let candidatesCleared = 0;
        for (const key of plan.clear) {
            if (assetGcCandidateStore.remove(key)) candidatesCleared++;
        }
        for (const candidate of plan.mark) {
            assetGcCandidateStore.mark(
                candidate.key,
                candidate.firstUnreferencedAt,
                candidate.identity,
            );
        }
        let deleted = 0;
        for (const key of plan.remove) {
            deleteAssetValue(key);
            deleted++;
        }

        const result = {
            ok: true,
            skipped: false,
            source,
            graceMs: ASSET_GC_GRACE_MS,
            assets: assetEntries.length,
            referenced: referencedKeys.size,
            marked: plan.mark.length,
            retainedByGrace: plan.retainedByGrace,
            deleted,
            candidatesCleared,
        };
        logger.info(
            `[AssetGC] ${source}: ${result.referenced}/${result.assets} referenced, `
            + `${result.marked} newly marked, ${result.retainedByGrace} in grace, `
            + `${result.deleted} deleted`,
        );
        return result;
    }, 'asset-gc');
}

let assetGcTimer = null;
function scheduleServerAssetCleanup(delayMs = ASSET_GC_START_DELAY_MS) {
    if (!ASSET_GC_AUTO_ENABLED || assetGcTimer) return;
    assetGcTimer = setTimeout(async () => {
        assetGcTimer = null;
        try {
            await runServerAssetCleanup({ source: 'scheduled' });
        } catch (error) {
            logger.error('[AssetGC] Scheduled cleanup failed closed:', error);
        } finally {
            scheduleServerAssetCleanup(ASSET_GC_INTERVAL_MS);
        }
    }, delayMs);
    assetGcTimer.unref?.();
}

/**
 * Spool an assembled legacy database to disk. Chat and optional plugin rows
 * are decoded and encoded one at a time; strippedDb is never mutated.
 */
async function spoolSelfContainedBackupDatabase(
    strippedDb,
    {
        foldPluginStorage = false,
        foldMcpToolCalls = false,
        markPluginStorageFolded = false,
        shouldAbort = () => false,
        reader = { kvGet, kvList, kvListWithSizes },
        onMissingChatRow,
    } = {}
) {
    const finalPath = path.join(
        databaseSpoolDir,
        `${DATABASE_SPOOL_FILE_PREFIX}${process.pid}-${nodeCrypto.randomUUID()}`
    );
    const filePath = finalPath + '.tmp';
    const pluginStorage = foldPluginStorage
        ? resolveOwnedPluginStorageRows(strippedDb, reader)
        : null;
    const mcpToolCalls = foldMcpToolCalls
        ? mcpToolCallSnapshotStorage(reader)
        : null;

    try {
        return await streamRisuSaveToFile({
            dbObj: strippedDb,
            filePath,
            readChatRow: async (chaId, chatId) => {
                const value = chatRowStore.materializeChatRowBytesFromReader(
                    reader,
                    chatRowKey(chaId, chatId),
                );
                return value === null ? null : decodeRisuSave(value);
            },
            pluginStorage,
            mcpToolCalls,
            markPluginStorageFolded,
            shouldAbort,
            onMissingChatRow,
        });
    } catch (error) {
        await fs.unlink(filePath).catch(() => {});
        throw error;
    }
}

async function spoolBackupSnapshotRow(snapshot, key, {
    signal,
    shouldAbort,
    onChunk,
} = {}) {
    const size = snapshot.kvSize(key);
    if (!Number.isSafeInteger(size) || size < 0) return null;
    const rowPath = path.join(
        databaseSpoolDir,
        `${DATABASE_SPOOL_FILE_PREFIX}${process.pid}-${nodeCrypto.randomUUID()}.row`,
    );
    try {
        const result = await snapshot.kvWriteToFile(key, rowPath, {
            signal,
            shouldAbort,
            onChunk,
        });
        if (!result || result.size !== size) {
            throw new Error(`Snapshot row changed while spooling: ${key}`);
        }
        return {
            filePath: rowPath,
            size,
            cleanup: () => fs.unlink(rowPath).catch(() => {}),
        };
    } catch (error) {
        await fs.unlink(rowPath).catch(() => {});
        throw error;
    }
}

async function spoolLogicalChatSnapshotRow(snapshot, key, options = {}) {
    const metadata = typeof snapshot.chatRowMetadata === 'function'
        ? snapshot.chatRowMetadata(key)
        : null;
    if (!metadata || metadata.log_count === 0) {
        return spoolBackupSnapshotRow(snapshot, key, options);
    }
    if (options.signal?.aborted || options.shouldAbort?.()) {
        throw new DOMException('Snapshot chat-row spool was aborted', 'AbortError');
    }
    const bytes = chatRowStore.materializeChatRowBytesFromReader(snapshot, key);
    if (bytes === null) return null;
    if (bytes.length !== metadata.content_size) {
        throw new Error(`Snapshot logical chat-row size mismatch: ${key}`);
    }
    const rowPath = path.join(
        databaseSpoolDir,
        `${DATABASE_SPOOL_FILE_PREFIX}${process.pid}-${nodeCrypto.randomUUID()}.row`,
    );
    try {
        await fs.writeFile(rowPath, bytes, { flag: 'wx', mode: 0o600 });
        return {
            filePath: rowPath,
            size: bytes.length,
            cleanup: () => fs.unlink(rowPath).catch(() => {}),
        };
    } catch (error) {
        await fs.unlink(rowPath).catch(() => {});
        throw error;
    }
}

function listLogicalChatRowsWithSizes(reader) {
    return reader.kvListWithSizes('chats/').map((entry) => {
        const metadata = typeof reader.chatRowMetadata === 'function'
            ? reader.chatRowMetadata(entry.key)
            : null;
        const logicalSize = metadata?.log_count > 0
            ? metadata.content_size
            : entry.size;
        if (!Number.isSafeInteger(logicalSize) || logicalSize < 0) {
            throw new Error(`Chat row has an invalid logical size: ${entry.key}`);
        }
        return { ...entry, size: logicalSize };
    });
}

function canStreamImportedDatabase(inspection) {
    return inspection.supported || inspection.format === 'risusave';
}

/**
 * Convert block-oriented RISUSAVE databases to the canonical streaming input
 * on disk, then feed them through the same chat/plugin externalization path as
 * ordinary MessagePack imports. REMOTE payloads are spooled from the rows that
 * the enclosing replacement transaction has already staged, so neither the
 * database nor a large remote character has to be assembled in memory.
 */
async function ingestImportedDatabaseStreaming(
    databaseSource,
    inspection,
    { signal = null } = {},
) {
    if (inspection.format !== 'risusave') {
        return ingestDatabaseStreaming(databaseSource, {
            inspection,
            shouldAbort: () => signal?.aborted === true,
            signal,
        });
    }

    const convertedPath = path.join(
        databaseSpoolDir,
        `${DATABASE_SPOOL_FILE_PREFIX}block-import-${process.pid}-${nodeCrypto.randomUUID()}.tmp`,
    );
    const liveReader = { kvSize, kvWriteToFile };
    let converted = null;
    try {
        try {
            converted = await convertBlockRisuSaveToMessagePack(
                databaseSource,
                convertedPath,
                {
                    readRemoteRowSize: (name) => kvSize(`remotes/${name}.local.bin`),
                    readRemoteRowSource: (name) => spoolBackupSnapshotRow(
                        liveReader,
                        `remotes/${name}.local.bin`,
                        {
                            signal,
                            shouldAbort: () => signal?.aborted === true,
                        },
                    ),
                    maxDecodedBytes: configuredMaxDecodedBytes(),
                    shouldAbort: () => signal?.aborted === true,
                    signal,
                    throwIfAborted: () => throwIfImportAborted(signal),
                },
            );
        } catch (error) {
            if (signal?.aborted
                || error?.risuSavePreparationInvalid === true
                || error?.risuSavePreparationLimit === true
                || error?.name === 'AbortError'
                || error?.syscall
                || error?.code === 'KV_CHUNK_CORRUPT') {
                throw error;
            }
            throw new RisuSavePreparationError(
                String(error?.message ?? 'Invalid RisuSave block database'),
                { cause: error },
            );
        }
        return await ingestDatabaseStreaming(converted, {
            shouldAbort: () => signal?.aborted === true,
            signal,
            maxDecodedBytes: configuredMaxDecodedBytes(),
        });
    } finally {
        await converted?.cleanup?.();
        // The converter removes incomplete outputs itself. This catches a
        // process-local failure before it has returned its cleanup handle.
        await fs.unlink(convertedPath).catch(() => {});
    }
}

/**
 * Chat rows are always assembled into database.risudat. Migration targets
 * (upstream and main rollback) also fold external plugin rows into that
 * database; Node-only exports keep them as independent archive entries so
 * large plugin stores are never monolithized.
 */
async function buildSelfContainedBackupDatabase({
    foldPluginStorage = true,
    shouldAbort = () => false,
    onMissingChatRow,
    snapshot: externalSnapshot = null,
    databaseSource = null,
    databaseState = null,
    signal = null,
    onDatabaseLoaded,
    omitAccount = false,
} = {}) {
    let snapshot = externalSnapshot;
    let ownsSnapshot = false;
    try {
        if (!snapshot) {
            snapshot = await queueStorageOperation(async () => {
                await flushPendingDb();
                return createKvSnapshot();
            }, 'snapshot-capture');
            ownsSnapshot = true;
        }
        if (databaseSource) {
            const finalPath = path.join(
                databaseSpoolDir,
                `${DATABASE_SPOOL_FILE_PREFIX}${process.pid}-${nodeCrypto.randomUUID()}`,
            );
            const filePath = finalPath + '.tmp';
            const spoolSnapshotRow = (key) => spoolBackupSnapshotRow(snapshot, key, {
                signal,
                shouldAbort,
            });
            const spoolSnapshotChatRow = (key) => spoolLogicalChatSnapshotRow(
                snapshot,
                key,
                { signal, shouldAbort },
            );
            const pluginStorage = foldPluginStorage
                ? resolveOwnedPluginStorageRows(databaseState ?? {}, snapshot)
                : null;
            try {
                return await streamBackupRisuSaveToFile({
                    databaseSource,
                    filePath,
                    readChatRowSource: (chaId, chatId) => spoolSnapshotChatRow(
                        chatRowKey(chaId, chatId),
                    ),
                    readRemoteRowSource: (name) => spoolSnapshotRow(
                        `remotes/${name}.local.bin`,
                    ),
                    readRemoteRowSize: (name) => snapshot.kvSize(
                        `remotes/${name}.local.bin`,
                    ),
                    pluginStorage: pluginStorage
                        ? {
                            valueRows: pluginStorage.valueRows,
                            metaRows: pluginStorage.metaRows,
                            readRowSource: spoolSnapshotRow,
                        }
                        : null,
                    shouldAbort,
                    signal,
                    tempDir: databaseSpoolDir,
                    onMissingChatRow,
                });
            } catch (error) {
                await fs.unlink(filePath).catch(() => {});
                throw error;
            }
        }
        let strippedDb;
        const raw = snapshot.kvGet('database/database.bin');
        if (!raw) return null;
        strippedDb = await loadStrippedDatabase(raw, 'Backup');
        const backupDatabase = omitAccount
            ? { ...strippedDb, account: undefined }
            : strippedDb;
        onDatabaseLoaded?.(backupDatabase);
        return await spoolSelfContainedBackupDatabase(backupDatabase, {
            foldPluginStorage,
            shouldAbort,
            reader: snapshot,
            onMissingChatRow,
        });
    } finally {
        if (ownsSnapshot) snapshot?.close();
    }
}

async function requireTargetCompatibleBackupDatabase(databaseSpool, target) {
    if (target !== 'main' && target !== 'upstream') {
        throw new Error(`Unsupported backup compatibility target: ${target}`);
    }
    if (!databaseSpool?.filePath || databaseSpool.size < magicHeader.length) {
        const error = new Error(target === 'main'
            ? 'The main-compatible database export is incomplete'
            : 'The upstream-compatible database export is incomplete');
        error.code = target === 'main'
            ? 'BACKUP_MAIN_DATABASE_INCOMPLETE'
            : 'BACKUP_UPSTREAM_DATABASE_INCOMPLETE';
        error.statusCode = 500;
        throw error;
    }

    const handle = await fs.open(databaseSpool.filePath, 'r');
    try {
        const header = Buffer.alloc(magicHeader.length);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        if (bytesRead === header.length && header.equals(Buffer.from(magicHeader))) return;
    } finally {
        await handle.close();
    }

    // PocketRisu's escape envelope uses version byte 10, which the main rollback
    // branch predates. Upstream recognizes only legacy bytes 7/8/9 and RISUSAVE\0
    // block headers; byte 10 falls through to raw msgpack and decodes as garbage.
    // Re-encoding as 7/8/9 is not faithful: upstream's msgpackr renames __proto__
    // to __proto_ on decode, and ill-formed Unicode keys cannot round-trip via UTF-8.
    const error = new Error(target === 'main'
        ? 'Cannot export for main because plugin storage contains keys that its save format cannot represent. '
            + 'Rename or remove __proto__ and ill-formed Unicode plugin keys, then retry.'
        : 'Cannot export for upstream RisuAI because plugin storage contains keys that its save format cannot represent. '
            + 'Rename or remove __proto__ and ill-formed Unicode plugin keys, then retry.');
    error.code = target === 'main'
        ? 'BACKUP_MAIN_UNSUPPORTED_PLUGIN_KEYS'
        : 'BACKUP_UPSTREAM_UNSUPPORTED_PLUGIN_KEYS';
    error.statusCode = 409;
    throw error;
}

async function listPluginBackupEntries(
    reader = { kvGet, kvList, kvListWithSizes },
    databaseState = null,
) {
    let dbObj = databaseState;
    if (!dbObj) {
        const rawDatabase = reader.kvGet('database/database.bin');
        if (!rawDatabase) return [];
        dbObj = await decodeAuthoritativeRisuSave(rawDatabase, {
            resolveRemote: async (name) => reader.kvGet(`remotes/${name}.local.bin`) || null,
        });
    }
    const owned = resolveOwnedPluginStorageKeys(dbObj, reader);
    const sizes = new Map([
        ...reader.kvListWithSizes(PLUGIN_SAVE_PREFIX),
        ...reader.kvListWithSizes(PLUGIN_SAVE_META_PREFIX),
    ].map(entry => [entry.key, entry.size]));
    const rows = [...owned.valueKeys, ...owned.metaKeys].map((key) => {
        // Export and import use the same validator. This catches legacy or
        // manually inserted rows before an archive is published.
        resolveBackupStorageKey(key);
        const size = sizes.get(key);
        if (!Number.isSafeInteger(size) || size < 0) {
            throw new Error(`Owned plugin storage row is unavailable: ${key}`);
        }
        return {
            kind: 'kv-source',
            key,
            backupName: key,
            sortKey: key,
            size,
        };
    });
    const manifestState = readPluginStorageManifestState(reader.kvGet);
    const generation = pluginStorageGeneration(dbObj);
    const manifestSize = reader.kvListWithSizes(PLUGIN_STORAGE_MANIFEST_KEY)
        .find(entry => entry.key === PLUGIN_STORAGE_MANIFEST_KEY)?.size;
    if (dbObj.optimizePluginMemory === true && generation) {
        if (!manifestState.valid
            || manifestState.manifest?.generation !== generation
            || !Number.isSafeInteger(manifestSize)
            || manifestSize < 0) {
            throw new TypeError(
                'The selected plugin storage manifest is not physically available',
            );
        }
        rows.push({
            kind: 'kv-source',
            key: PLUGIN_STORAGE_MANIFEST_KEY,
            backupName: PLUGIN_STORAGE_MANIFEST_KEY,
            sortKey: PLUGIN_STORAGE_MANIFEST_KEY,
            size: manifestSize,
        });
    }
    return rows;
}

function listMcpToolCallBackupEntries(reader, kind = 'kv-source') {
    return reader.kvListWithSizes(MCP_TOOL_CALL_CACHE_PREFIX)
        .filter((entry) => parseMcpToolCallStorageKey(entry.key) !== null)
        .map((entry) => ({
            kind,
            key: entry.key,
            backupName: entry.key,
            sortKey: entry.key,
            size: entry.size,
            mcpToolCall: true,
        }));
}

function draftStorageKey(chaId, chatId) {
    return `${DRAFT_PREFIX}${chaId}/${chatId}`;
}

function referencedDraftStorageKeys(database) {
    const keys = new Set();
    for (const character of database?.characters ?? []) {
        if (typeof character?.chaId !== 'string' || character.chaId.length === 0
            || !Array.isArray(character.chats)) continue;
        for (const chat of character.chats) {
            if (typeof chat?.id !== 'string' || chat.id.length === 0) continue;
            keys.add(draftStorageKey(character.chaId, chat.id));
        }
    }
    return keys;
}

function referencedDraftStorageKeysFromChatRows(reader) {
    const keys = new Set();
    for (const entry of reader.kvListWithSizes('chats/')) {
        const parsed = parseChatRowKey(entry.key);
        if (!parsed?.chaId || !parsed.chatId) continue;
        keys.add(draftStorageKey(parsed.chaId, parsed.chatId));
    }
    return keys;
}

function listDraftBackupEntries(
    reader,
    { database = null, kind = 'kv-source' } = {},
) {
    const referenced = database
        ? referencedDraftStorageKeys(database)
        : referencedDraftStorageKeysFromChatRows(reader);
    return reader.kvListWithSizes(DRAFT_PREFIX)
        .filter((entry) => referenced.has(entry.key))
        .map((entry) => ({
            kind,
            key: entry.key,
            backupName: entry.key,
            sortKey: entry.key,
            size: entry.size,
        }));
}

async function restoreImportedDraftEntries(entries, database, { signal = null } = {}) {
    const referenced = referencedDraftStorageKeys(database);
    let restored = 0;
    for (const entry of entries) {
        throwIfImportAborted(signal);
        if (!referenced.has(entry.key)) continue;
        await importOpaqueRowFromFile(entry.key, entry, signal);
        restored++;
    }
    return restored;
}

function mcpToolCallSnapshotStorage(reader) {
    const rows = listMcpToolCallBackupEntries(reader).map((entry) => ({
        key: parseMcpToolCallStorageKey(entry.key).suffix,
        source: entry.key,
    }));
    return {
        rows,
        readRow: (storageKey) => {
            const value = reader.kvGet(storageKey);
            if (!value) throw new Error(`Remembered MCP tool-call row is unavailable: ${storageKey}`);
            try {
                return JSON.parse(value.toString('utf8'));
            } catch (cause) {
                throw new Error(`Remembered MCP tool-call row is invalid: ${storageKey}`, { cause });
            }
        },
    };
}

function serializeMcpToolCallPayload(storageKey, callId, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || !value.call || typeof value.call !== 'object' || Array.isArray(value.call)
        || value.call.id !== callId
        || typeof value.call.name !== 'string'
        || !Array.isArray(value.response)) {
        throw new TypeError(`Invalid remembered MCP tool-call payload: ${storageKey}`);
    }
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
        throw new TypeError(`Invalid remembered MCP tool-call payload: ${storageKey}`);
    }
    return Buffer.from(serialized, 'utf8');
}

function missingMcpToolCallBackupRowError(callId) {
    const error = new Error(`Backup cannot resolve remembered MCP tool call ${callId}`);
    error.code = 'BACKUP_MISSING_MCP_TOOL_CALL_ROW';
    error.statusCode = 500;
    return error;
}

async function selectReferencedMcpToolCallEntries(entries, databaseSpool, shouldAbort) {
    const candidates = new Map(
        entries.filter((entry) => entry.mcpToolCall === true)
            .map((entry) => [entry.key, entry]),
    );
    if (candidates.size === 0) {
        const referenced = await scanMcpToolCallIdsFromFile(databaseSpool.filePath, { shouldAbort });
        if (referenced.size > 0) {
            throw missingMcpToolCallBackupRowError(referenced.values().next().value);
        }
        return entries;
    }
    const referenced = await scanMcpToolCallIdsFromFile(databaseSpool.filePath, { shouldAbort });
    const selectedKeys = new Set();
    for (const callId of referenced) {
        const storageKey = mcpToolCallStorageKey(callId);
        if (!storageKey || !candidates.has(storageKey)) {
            throw missingMcpToolCallBackupRowError(callId);
        }
        selectedKeys.add(storageKey);
    }
    return entries.filter((entry) => entry.mcpToolCall !== true || selectedKeys.has(entry.key));
}

// Full downloads and server-side saves can each retain a SQLite WAL snapshot,
// a database assembly spool, and a private copy of every filesystem asset.
// Keep admission bounded so concurrent requests cannot all reserve the same
// free space reported by statfs.
const FULL_EXPORT_MAX_ACTIVE_PINS = 2;
const activeFullExportPins = new Set();
const fullExportReservedBytesByVolume = new Map();

function createBackupExportAbortTracker(req, res) {
    const controller = new AbortController();
    const socket = req.socket;
    const abort = () => {
        if (controller.signal.aborted || res.writableFinished) return;
        const error = new Error('Backup export client disconnected');
        error.name = 'AbortError';
        controller.abort(error);
    };
    req.once('aborted', abort);
    socket?.once('close', abort);
    socket?.once('error', abort);
    res.once('error', abort);
    res.once('close', abort);
    const disconnectPoll = setInterval(() => {
        if (req.aborted || socket?.destroyed || res.destroyed) abort();
    }, 25);
    disconnectPoll.unref?.();
    if (req.aborted || socket?.destroyed || res.destroyed) abort();
    return {
        signal: controller.signal,
        cleanup() {
            clearInterval(disconnectPoll);
            req.removeListener('aborted', abort);
            socket?.removeListener('close', abort);
            socket?.removeListener('error', abort);
            res.removeListener('error', abort);
            res.removeListener('close', abort);
        },
    };
}

function backupExportCapacityError() {
    const error = new Error('Too many full backup exports are active');
    error.code = 'BACKUP_EXPORT_CAPACITY';
    error.statusCode = 503;
    return error;
}

function backupExportErrorPayload(error) {
    return {
        error: error.message,
        code: error.code,
        ...(error.required === undefined ? {} : { required: error.required }),
        ...(error.available === undefined ? {} : { available: error.available }),
        ...(error.reserved === undefined ? {} : { reserved: error.reserved }),
        ...(error.roles === undefined ? {} : { roles: error.roles }),
    };
}

function throwIfBackupExportAborted(signal) {
    throwIfSignalAborted(signal);
}

function samePinnedSourceStat(actual, planned) {
    return actual.isFile()
        && actual.size === planned.size
        && actual.dev === planned.dev
        && actual.ino === planned.ino
        && actual.mtimeMs === planned.mtimeMs
        && actual.ctimeMs === planned.ctimeMs;
}

async function hashBackupExportFile(entry, signal) {
    const source = await fs.open(entry.sourcePath, 'r');
    try {
        const before = await source.stat();
        if (!samePinnedSourceStat(before, entry.sourceStat)) {
            throw new Error(`Backup source changed before hashing: ${entry.backupName}`);
        }
        const digest = nodeCrypto.createHash('sha256');
        const page = Buffer.allocUnsafe(IMPORT_IO_PAGE_BYTES);
        let offset = 0;
        while (offset < before.size) {
            throwIfBackupExportAborted(signal);
            const length = Math.min(page.length, before.size - offset);
            const { bytesRead } = await source.read(page, 0, length, offset);
            if (bytesRead <= 0) break;
            digest.update(page.subarray(0, bytesRead));
            offset += bytesRead;
        }
        const after = await source.stat();
        if (offset !== before.size || !samePinnedSourceStat(after, entry.sourceStat)) {
            throw new Error(`Backup source changed while hashing: ${entry.backupName}`);
        }
        return digest.digest('hex');
    } finally {
        await source.close().catch(() => {});
    }
}

async function copyBackupExportFile(entry, destination, signal) {
    const source = await fs.open(entry.sourcePath, 'r');
    let output = null;
    try {
        const before = await source.stat();
        if (!samePinnedSourceStat(before, entry.sourceStat)) {
            throw new Error(`Backup source changed before pinning: ${entry.backupName}`);
        }
        output = await fs.open(destination, 'wx', 0o600);
        const page = Buffer.allocUnsafe(IMPORT_IO_PAGE_BYTES);
        const digest = nodeCrypto.createHash('sha256');
        const pageDelayMs = process.env.NODE_ENV === 'test'
            ? Math.max(0, Number(process.env.POCKETRISU_TEST_FULL_EXPORT_FILE_PAGE_DELAY_MS) || 0)
            : 0;
        let offset = 0;
        while (offset < before.size) {
            throwIfBackupExportAborted(signal);
            const length = Math.min(page.length, before.size - offset);
            const { bytesRead } = await source.read(page, 0, length, offset);
            if (bytesRead === 0) break;
            const chunk = page.subarray(0, bytesRead);
            let written = 0;
            while (written < bytesRead) {
                throwIfBackupExportAborted(signal);
                const result = await output.write(
                    chunk,
                    written,
                    bytesRead - written,
                    offset + written,
                );
                written += result.bytesWritten;
            }
            digest.update(chunk);
            offset += bytesRead;
            if (pageDelayMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, pageDelayMs));
            }
        }
        const after = await source.stat();
        const pathAfter = await fs.stat(entry.sourcePath).catch(() => null);
        if (offset !== before.size || !samePinnedSourceStat(after, entry.sourceStat)
            || !pathAfter || !samePinnedSourceStat(pathAfter, entry.sourceStat)) {
            throw new Error(`Backup source changed while pinning: ${entry.backupName}`);
        }
        const pinnedHash = digest.digest('hex');
        const stableHash = await hashBackupExportFile(entry, signal);
        if (pinnedHash !== stableHash) {
            throw new Error(`Backup source content changed while pinning: ${entry.backupName}`);
        }
        await output.sync();
        await output.close();
        output = null;
        return {
            kind: 'file',
            sourcePath: destination,
            backupName: entry.backupName,
            sortKey: entry.sortKey,
            size: offset,
        };
    } finally {
        await output?.close().catch(() => {});
        await source.close().catch(() => {});
    }
}

async function planFullBackupFilesystemEntries(snapshot, target) {
    const entries = [];
    for (const asset of listAssetEntriesWithSizes(snapshot)) {
        const backupName = path.basename(asset.key);
        if (asset.source === 'fs') {
            const sourcePath = assetPathFor(assetNameForKey(asset.key));
            const sourceStat = await fs.stat(sourcePath);
            entries.push({
                kind: 'source-file',
                sourcePath,
                sourceStat,
                backupName,
                sortKey: asset.key,
                size: sourceStat.size,
            });
        } else {
            // Preserve the source chosen at the cut. A filesystem file created
            // after this point must never shadow the pinned SQLite row.
            entries.push({
                kind: 'kv-source',
                key: asset.key,
                backupName,
                sortKey: asset.key,
                size: asset.size,
            });
        }
    }
    // Original upstream cannot import PocketRisu's slash-named inlay entries.
    // The PocketRisu main rollback target can, so retain them there.
    if (target === 'upstream') return entries;

    for (const inlay of await listInlayFiles()) {
        const sourceStat = await fs.stat(inlay.filePath);
        entries.push({
            kind: 'source-file',
            sourcePath: inlay.filePath,
            sourceStat,
            backupName: `inlay/${inlay.id}.${inlay.ext}`,
            sortKey: `inlay/${inlay.id}`,
            size: sourceStat.size,
        });
        const sidecarPath = getInlaySidecarPath(inlay.id);
        try {
            const sidecarStat = await fs.stat(sidecarPath);
            entries.push({
                kind: 'source-file',
                sourcePath: sidecarPath,
                sourceStat: sidecarStat,
                backupName: `inlay_sidecar/${inlay.id}`,
                sortKey: `inlay_sidecar/${inlay.id}`,
                size: sidecarStat.size,
            });
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
    return entries;
}

function planFullBackupColdStorageEntries(snapshot) {
    const sizes = new Map(
        snapshot.kvListWithSizes('coldstorage/').map((entry) => [entry.key, entry.size]),
    );
    const canonicalKeys = Array.from(new Set(
        [...sizes.keys()].map((key) => normalizeColdStorageStorageKey(key)),
    )).sort((a, b) => a.localeCompare(b));
    return canonicalKeys.map((canonicalKey) => {
        const legacyKey = `${canonicalKey}.json`;
        const key = sizes.has(canonicalKey) ? canonicalKey : legacyKey;
        const sourceSize = sizes.get(key);
        if (!Number.isSafeInteger(sourceSize) || sourceSize < 0) {
            throw new Error(`Cold storage row is unavailable: ${canonicalKey}`);
        }
        const header = sourceSize >= 2 ? snapshot.kvReadRange(key, 0, 2) : Buffer.alloc(0);
        const compressed = header?.[0] === 0x1f && header?.[1] === 0x8b;
        let size = sourceSize;
        if (compressed) {
            if (sourceSize < 18) {
                throw new Error(`Cold storage gzip row is truncated: ${canonicalKey}`);
            }
            const footer = snapshot.kvReadRange(key, sourceSize - 4, 4);
            size = footer.readUInt32LE(0);
            if (size > BACKUP_IMPORT_MAX_BYTES) {
                const error = new Error(`Cold storage row exceeds the backup export limit: ${canonicalKey}`);
                error.code = 'BACKUP_EXPORT_COLD_LIMIT';
                error.statusCode = 413;
                throw error;
            }
        }
        return {
            kind: 'cold-source',
            key,
            compressed,
            sourceSize,
            backupName: toColdStorageBackupName(canonicalKey),
            sortKey: toColdStorageBackupName(canonicalKey),
            size,
            // A gzip transform briefly owns both its exact source spool and
            // exact expanded output. Plain rows need only their final pin.
            peakPinBytes: compressed ? sourceSize + size : size,
        };
    });
}

function fullExportTestDiskValue(role, suffix) {
    if (process.env.NODE_ENV !== 'test') return null;
    const value = process.env[`POCKETRISU_TEST_FULL_EXPORT_${role}_${suffix}`];
    return typeof value === 'string' && value.length > 0 ? value : null;
}

async function resolveFullExportVolume(targetPath, role) {
    const testVolume = fullExportTestDiskValue(role, 'VOLUME');
    const testAvailableRaw = fullExportTestDiskValue(role, 'AVAILABLE_BYTES');
    const testAvailable = testAvailableRaw === null ? NaN : Number(testAvailableRaw);
    let key;
    if (testVolume) {
        key = `test:${testVolume}`;
    } else {
        const stat = await fs.stat(targetPath);
        key = `dev:${stat.dev}`;
    }
    let available;
    if (Number.isSafeInteger(testAvailable) && testAvailable >= 0) {
        available = testAvailable;
    } else {
        try {
            const statfs = await fs.statfs(targetPath);
            available = statfs.bavail * statfs.bsize;
        } catch {
            available = -1;
        }
    }
    return { key, available, targetPath, role };
}

async function reserveFullExportDisk(token, requirements) {
    const resolved = await Promise.all(requirements.map(async (requirement) => ({
        ...await resolveFullExportVolume(requirement.targetPath, requirement.role),
        bytes: requirement.bytes,
    })));
    const byVolume = new Map();
    for (const entry of resolved) {
        if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
            throw new Error('Full backup disk reservation is not a safe byte count');
        }
        const current = byVolume.get(entry.key) ?? {
            key: entry.key,
            bytes: 0,
            available: entry.available,
            roles: [],
            roleBytes: new Map(),
        };
        current.bytes += entry.bytes;
        if (!Number.isSafeInteger(current.bytes)) {
            throw new Error('Full backup disk reservation exceeds the safe integer range');
        }
        if (current.available < 0) current.available = entry.available;
        else if (entry.available >= 0) current.available = Math.min(current.available, entry.available);
        current.roles.push(entry.role);
        current.roleBytes.set(
            entry.role,
            (current.roleBytes.get(entry.role) ?? 0) + entry.bytes,
        );
        byVolume.set(entry.key, current);
    }

    // JavaScript runs this check-and-charge synchronously after all stat calls,
    // so two cuts cannot both spend the same free-space observation.
    for (const entry of byVolume.values()) {
        const existing = fullExportReservedBytesByVolume.get(entry.key) ?? null;
        const reserved = existing?.reserved ?? 0;
        let capacity = existing?.capacity ?? entry.available;
        // statfs already reflects private bytes written by older reservations.
        // Add their whole reservation back before tightening the original
        // capacity, otherwise those bytes are charged once as used space and a
        // second time as reserved space. External consumption can still lower
        // the active ledger conservatively.
        if (entry.available >= 0) {
            const observedCapacity = entry.available + reserved;
            capacity = capacity < 0 ? observedCapacity : Math.min(capacity, observedCapacity);
        }
        entry.capacity = capacity;
        if (capacity >= 0 && capacity - reserved < entry.bytes) {
            const error = new Error(
                `Insufficient disk space for full backup ${entry.roles.join('+')} reservation`,
            );
            error.code = 'BACKUP_EXPORT_DISK_SPACE';
            error.statusCode = 507;
            error.required = entry.bytes;
            error.available = entry.available;
            error.reserved = reserved;
            error.volume = entry.key;
            error.roles = entry.roles;
            throw error;
        }
    }
    for (const entry of byVolume.values()) {
        const existing = fullExportReservedBytesByVolume.get(entry.key);
        fullExportReservedBytesByVolume.set(entry.key, {
            capacity: entry.capacity,
            reserved: (existing?.reserved ?? 0) + entry.bytes,
        });
    }
    return { token, volumes: [...byVolume.values()] };
}

function markFullExportReservationConsumed(reservation, role, bytes) {
    if (!reservation || !Number.isSafeInteger(bytes) || bytes < 0) {
        throw new Error('Invalid committed full backup reservation size');
    }
    const entry = reservation.volumes.find((volume) => volume.roleBytes?.has(role));
    const reservedForRole = entry?.roleBytes?.get(role) ?? -1;
    if (!entry || bytes > reservedForRole) {
        throw new Error(`Committed ${role} bytes exceed the full backup reservation`);
    }
    const ledger = fullExportReservedBytesByVolume.get(entry.key);
    if (ledger?.capacity >= 0) {
        ledger.capacity = Math.max(0, ledger.capacity - bytes);
    }
    entry.committedBytes = (entry.committedBytes ?? 0) + bytes;
}

function releaseFullExportDiskReservation(reservation) {
    if (!reservation) return;
    for (const entry of reservation.volumes) {
        const existing = fullExportReservedBytesByVolume.get(entry.key);
        const remaining = Math.max(
            0,
            (existing?.reserved ?? 0) - entry.bytes,
        );
        if (remaining === 0) fullExportReservedBytesByVolume.delete(entry.key);
        else fullExportReservedBytesByVolume.set(entry.key, {
            capacity: existing.capacity,
            reserved: remaining,
        });
    }
    reservation.volumes = [];
}

async function waitAtFullExportAfterPinTestGate(signal) {
    if (process.env.NODE_ENV !== 'test') return;
    const configured = String(
        process.env.POCKETRISU_TEST_FULL_EXPORT_AFTER_PIN_GATE_DIR ?? '',
    ).trim();
    if (!configured) return;
    const gateDir = path.resolve(configured);
    const holdPath = path.join(gateDir, 'hold');
    if (!existsSync(holdPath)) return;
    await fs.mkdir(gateDir, { recursive: true });
    await fs.writeFile(path.join(gateDir, 'entered'), 'pinned', 'utf-8');
    const releasePath = path.join(gateDir, 'release');
    while (existsSync(holdPath) && !existsSync(releasePath)) {
        throwIfBackupExportAborted(signal);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throwIfBackupExportAborted(signal);
}

async function waitAtFullExportDuringPinTestGate(signal) {
    if (process.env.NODE_ENV !== 'test') return;
    const configured = String(
        process.env.POCKETRISU_TEST_FULL_EXPORT_DURING_PIN_GATE_DIR ?? '',
    ).trim();
    if (!configured) return;
    const gateDir = path.resolve(configured);
    const holdPath = path.join(gateDir, 'hold');
    if (!existsSync(holdPath)) return;
    await fs.mkdir(gateDir, { recursive: true });
    await fs.writeFile(path.join(gateDir, 'entered'), 'pinning', 'utf-8');
    const releasePath = path.join(gateDir, 'release');
    while (existsSync(holdPath) && !existsSync(releasePath)) {
        throwIfBackupExportAborted(signal);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throwIfBackupExportAborted(signal);
}

async function waitAtServerBackupBeforePublishTestGate(signal) {
    if (process.env.NODE_ENV !== 'test') return;
    const configured = String(
        process.env.POCKETRISU_TEST_SERVER_BACKUP_BEFORE_PUBLISH_GATE_DIR ?? '',
    ).trim();
    if (!configured) return;
    const gateDir = path.resolve(configured);
    const holdPath = path.join(gateDir, 'hold');
    if (!existsSync(holdPath)) return;
    await fs.mkdir(gateDir, { recursive: true });
    await fs.writeFile(path.join(gateDir, 'entered'), 'ready-to-publish', 'utf-8');
    const releasePath = path.join(gateDir, 'release');
    while (existsSync(holdPath) && !existsSync(releasePath)) {
        throwIfBackupExportAborted(signal);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throwIfBackupExportAborted(signal);
}

async function expandPinnedColdStorage(sourcePath, destination, expectedSize, signal) {
    const input = createReadStream(sourcePath, { highWaterMark: IMPORT_IO_PAGE_BYTES });
    const gunzip = zlib.createGunzip({ chunkSize: IMPORT_IO_PAGE_BYTES });
    const inputFinished = finished(input);
    inputFinished.catch(() => {});
    const output = await fs.open(destination, 'wx', 0o600);
    const forwardInputError = (error) => gunzip.destroy(error);
    input.once('error', forwardInputError);
    const abort = () => {
        const reason = signal?.reason instanceof Error ? signal.reason : new Error('Backup export cancelled');
        input.destroy(reason);
        gunzip.destroy(reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
    let size = 0;
    try {
        throwIfBackupExportAborted(signal);
        input.pipe(gunzip);
        for await (const chunk of gunzip) {
            for (let offset = 0; offset < chunk.length; offset += IMPORT_IO_PAGE_BYTES) {
                throwIfBackupExportAborted(signal);
                const page = chunk.subarray(
                    offset,
                    Math.min(chunk.length, offset + IMPORT_IO_PAGE_BYTES),
                );
                if (size + page.length > expectedSize) {
                    throw new Error('Cold storage gzip expanded beyond its declared size');
                }
                let written = 0;
                while (written < page.length) {
                    const result = await output.write(
                        page,
                        written,
                        page.length - written,
                        size + written,
                    );
                    if (result.bytesWritten <= 0) {
                        throw new Error('Cold storage pin write made no progress');
                    }
                    written += result.bytesWritten;
                }
                size += page.length;
            }
        }
        if (size !== expectedSize) {
            throw new Error('Cold storage gzip length does not match its declared size');
        }
        await output.sync();
        await output.close();
        return { size };
    } catch (error) {
        input.destroy();
        gunzip.destroy();
        try { await output.close(); } catch {}
        await fs.unlink(destination).catch(() => {});
        throw error;
    } finally {
        signal?.removeEventListener('abort', abort);
        await inputFinished.catch(() => {});
    }
}

async function validatePinnedColdStorage(destination, entry, signal) {
    try {
        if (entry.size <= 8 * 1024 * 1024) {
            await validateJsonFileStreaming(destination, {
                size: entry.size,
                maxBytes: BACKUP_IMPORT_MAX_BYTES,
                signal,
            });
        } else {
            await new Promise((resolve, reject) => {
                throwIfBackupExportAborted(signal);
                const worker = spawn(process.execPath, [
                    path.join(__dirname, 'jsonValidateWorker.cjs'),
                    destination,
                    String(entry.size),
                    String(BACKUP_IMPORT_MAX_BYTES),
                ], {
                    stdio: 'ignore',
                    windowsHide: true,
                });
                let settled = false;
                const finishWorker = (operation, value) => {
                    if (settled) return;
                    settled = true;
                    signal?.removeEventListener('abort', abortWorker);
                    operation(value);
                };
                const abortWorker = () => {
                    worker.kill('SIGTERM');
                    finishWorker(
                        reject,
                        signal?.reason instanceof Error
                            ? signal.reason
                            : new Error('Backup export cancelled'),
                    );
                };
                signal?.addEventListener('abort', abortWorker, { once: true });
                worker.once('error', (error) => finishWorker(reject, error));
                worker.once('exit', (code, signalName) => {
                    if (code === 0) finishWorker(resolve);
                    else {
                        const error = new Error(
                            signalName
                                ? `Cold storage JSON validator exited on ${signalName}`
                                : 'Invalid plugin storage JSON row',
                        );
                        error.code = code === 2
                            ? 'INVALID_PLUGIN_STORAGE_ROW'
                            : 'COLD_STORAGE_VALIDATOR_FAILED';
                        finishWorker(reject, error);
                    }
                });
                if (signal?.aborted) abortWorker();
            });
        }
    } catch (error) {
        if (error?.code !== 'INVALID_PLUGIN_STORAGE_ROW') throw error;
        const invalid = new Error(`Invalid cold storage JSON row: ${entry.backupName}`);
        invalid.code = 'INVALID_COLD_STORAGE_ROW';
        invalid.statusCode = 400;
        throw invalid;
    }
}

function fullExportSnapshotSpoolOptions(signal) {
    const delayMs = process.env.NODE_ENV === 'test'
        ? Math.max(0, Number(process.env.POCKETRISU_TEST_FULL_EXPORT_PAGE_DELAY_MS) || 0)
        : 0;
    return {
        signal,
        onChunk: delayMs > 0
            ? () => new Promise((resolve) => setTimeout(resolve, delayMs))
            : undefined,
    };
}

async function pinFullBackupSnapshotEntry(snapshot, entry, destination, signal) {
    if (entry.kind === 'kv-source') {
        const spool = await snapshot.kvWriteToFile(
            entry.key,
            destination,
            fullExportSnapshotSpoolOptions(signal),
        );
        if (!spool || spool.size !== entry.size) {
            throw new Error(`Snapshot row changed while pinning: ${entry.backupName}`);
        }
        return { ...entry, kind: 'file', sourcePath: destination };
    }
    if (entry.kind !== 'cold-source') {
        throw new Error(`Unsupported full backup pin source: ${entry.kind}`);
    }
    if (!entry.compressed) {
        const spool = await snapshot.kvWriteToFile(
            entry.key,
            destination,
            fullExportSnapshotSpoolOptions(signal),
        );
        if (!spool || spool.size !== entry.size) {
            throw new Error(`Cold storage row changed while pinning: ${entry.backupName}`);
        }
        await validatePinnedColdStorage(destination, entry, signal);
        return { ...entry, kind: 'file', sourcePath: destination };
    }
    const rawPath = `${destination}.gz`;
    try {
        const raw = await snapshot.kvWriteToFile(
            entry.key,
            rawPath,
            fullExportSnapshotSpoolOptions(signal),
        );
        if (!raw || raw.size !== entry.sourceSize) {
            throw new Error(`Cold storage gzip changed while pinning: ${entry.backupName}`);
        }
        await expandPinnedColdStorage(rawPath, destination, entry.size, signal);
        await validatePinnedColdStorage(destination, entry, signal);
        return { ...entry, kind: 'file', sourcePath: destination };
    } finally {
        await fs.unlink(rawPath).catch(() => {});
    }
}

function estimateFullBackupDatabaseAssemblyBytes(reader, key, physicalSize) {
    if (physicalSize < magicRisuSaveHeader.length) return physicalSize;
    const prefix = reader.kvReadRange(key, 0, magicRisuSaveHeader.length);
    if (!prefix?.equals(Buffer.from(magicRisuSaveHeader))) return physicalSize;
    let offset = magicRisuSaveHeader.length;
    let decodedBytes = 0;
    let blocks = 0;
    while (offset < physicalSize) {
        if (++blocks > 1_000_000 || offset + 7 > physicalSize) {
            throw new Error('Invalid or excessive RisuSave block inventory');
        }
        const header = reader.kvReadRange(key, offset, 3);
        const compression = header[1];
        const nameLength = header[2];
        if (compression !== 0 && compression !== 1) {
            throw new Error('Invalid RisuSave block compression flag');
        }
        offset += 3;
        if (offset + nameLength + 4 > physicalSize) {
            throw new Error('Truncated RisuSave block name');
        }
        offset += nameLength;
        const length = reader.kvReadRange(key, offset, 4).readUInt32LE(0);
        offset += 4;
        if (offset + length > physicalSize) throw new Error('Truncated RisuSave block body');
        let decodedSize = length;
        if (compression === 1) {
            if (length < 18) throw new Error('Truncated gzip RisuSave block');
            decodedSize = reader.kvReadRange(key, offset + length - 4, 4).readUInt32LE(0);
        }
        decodedBytes += decodedSize;
        if (!Number.isSafeInteger(decodedBytes)
            || decodedBytes > 4 * 1024 * 1024 * 1024) {
            throw new Error('RisuSave blocks exceed the bounded decode limit');
        }
        offset += length;
    }
    return decodedBytes;
}

function fullBackupDatabaseUnavailableError(cause = null) {
    const error = new Error('The authoritative live database is unavailable for backup', {
        ...(cause ? { cause } : {}),
    });
    error.code = 'BACKUP_DATABASE_UNAVAILABLE';
    error.statusCode = 500;
    return error;
}

async function validateFullBackupDatabase(snapshot, key, size, signal) {
    if (!Number.isSafeInteger(size) || size <= 0) {
        throw fullBackupDatabaseUnavailableError();
    }
    const validationPath = path.join(
        databaseSpoolDir,
        `${DATABASE_SPOOL_FILE_PREFIX}full-export-validation-${process.pid}-${nodeCrypto.randomUUID()}.tmp`,
    );
    try {
        const validationSpool = await snapshot.kvWriteToFile(
            key,
            validationPath,
            fullExportSnapshotSpoolOptions(signal),
        );
        if (!validationSpool || validationSpool.size !== size) {
            throw new Error('Snapshot database changed while validating');
        }
        const databaseSource = { filePath: validationPath, size };
        return await readBackupRisuSaveTopLevelFields(
            databaseSource,
            ['optimizePluginMemory', PLUGIN_STORAGE_GENERATION_FIELD],
            {
                tempDir: databaseSpoolDir,
                signal,
                shouldAbort: () => signal?.aborted,
                readRemoteRowSize: (name) => snapshot.kvSize(
                    `remotes/${name}.local.bin`,
                ),
                readRemoteRowSource: (name) => spoolBackupSnapshotRow(
                    snapshot,
                    `remotes/${name}.local.bin`,
                    {
                        signal,
                        shouldAbort: () => signal?.aborted,
                    },
                ),
            },
        );
    } catch (cause) {
        if (signal?.aborted || cause?.name === 'AbortError'
            || cause?.code === 'RISU_STREAM_ABORTED') {
            throw cause;
        }
        if (cause?.code === 'BACKUP_DATABASE_UNAVAILABLE') throw cause;
        throw fullBackupDatabaseUnavailableError(cause);
    } finally {
        await fs.unlink(validationPath).catch(() => {});
    }
}

async function pinFullBackupState({ target, signal, archiveTargetPath = null }) {
    throwIfBackupExportAborted(signal);
    if (activeFullExportPins.size >= FULL_EXPORT_MAX_ACTIVE_PINS) {
        throw backupExportCapacityError();
    }
    const token = nodeCrypto.randomUUID();
    activeFullExportPins.add(token);
    let snapshot = null;
    let pinDir = null;
    let reservation = null;
    try {
        return await queueStorageReadAfterImports(async () => {
            throwIfBackupExportAborted(signal);
            await flushPendingDb();
            throwIfBackupExportAborted(signal);
            snapshot = createKvSnapshot();

            const databaseKey = 'database/database.bin';
            let databaseSize;
            let databaseState;
            let databaseAssemblyBytes;
            try {
                databaseSize = snapshot.kvSize(databaseKey);
                databaseState = await validateFullBackupDatabase(
                    snapshot,
                    databaseKey,
                    databaseSize,
                    signal,
                );
                databaseAssemblyBytes = estimateFullBackupDatabaseAssemblyBytes(
                    snapshot,
                    databaseKey,
                    databaseSize,
                );
            } catch (cause) {
                if (signal?.aborted || cause?.name === 'AbortError'
                    || cause?.code === 'RISU_STREAM_ABORTED'
                    || cause?.code === 'BACKUP_DATABASE_UNAVAILABLE') {
                    throw cause;
                }
                throw fullBackupDatabaseUnavailableError(cause);
            }
            const filesystemEntries = await planFullBackupFilesystemEntries(snapshot, target);
            const includeInlays = target !== 'upstream';
            const includeServeOnlyRows = target === 'nodeonly';
            const foldPluginStorage = target !== 'nodeonly';
            const baseSnapshotEntries = [
                ...planFullBackupColdStorageEntries(snapshot),
                ...(includeInlays ? snapshot.kvListWithSizes('inlay_meta/').map((entry) => ({
                    kind: 'kv-source',
                    key: entry.key,
                    backupName: entry.key,
                    sortKey: entry.key,
                    size: entry.size,
                })) : []),
                ...(includeServeOnlyRows ? listMcpToolCallBackupEntries(snapshot) : []),
                ...(includeServeOnlyRows ? listDraftBackupEntries(snapshot) : []),
            ];
            // Admission is deliberately conservative: reserve every physical
            // plugin candidate before decoding the tiny ownership metadata
            // from the pinned database file. Only owned rows are published.
            const pluginCandidates = foldPluginStorage ? [] : [
                ...snapshot.kvListWithSizes(PLUGIN_SAVE_PREFIX),
                ...snapshot.kvListWithSizes(PLUGIN_SAVE_META_PREFIX),
                ...snapshot.kvListWithSizes(PLUGIN_STORAGE_MANIFEST_KEY),
            ].map((entry) => ({
                kind: 'kv-source',
                key: entry.key,
                backupName: entry.key,
                sortKey: entry.key,
                size: entry.size,
            }));
            const reservationEntries = [
                ...filesystemEntries,
                ...baseSnapshotEntries,
                ...pluginCandidates,
            ];
            // Plugin candidates deliberately include quarantined physical rows
            // that may not belong to the selected publication. Reserve their
            // bytes conservatively, but enforce archive limits only after the
            // authoritative manifest selects actual backup entries.
            preflightBackupEntries([
                { backupName: 'database.risudat', size: databaseSize },
                ...filesystemEntries,
                ...baseSnapshotEntries,
            ]);

            const pinPayloadBytes = reservationEntries.reduce(
                (sum, entry) => sum + (
                    entry.kind === 'cold-source' ? entry.peakPinBytes : entry.size
                ),
                databaseSize,
            );
            const remoteCandidates = snapshot.kvListWithSizes('remotes/');
            if (remoteCandidates.length > 1_000_000) {
                throw new Error('RisuSave REMOTE inventory exceeds the bounded limit');
            }
            const assemblyRows = [
                ...listLogicalChatRowsWithSizes(snapshot),
                ...(foldPluginStorage ? snapshot.kvListWithSizes(PLUGIN_SAVE_PREFIX) : []),
                ...(foldPluginStorage ? snapshot.kvListWithSizes(PLUGIN_SAVE_META_PREFIX) : []),
                // REMOTE rows are not archive entries. They are private source
                // spools used while rebuilding database.risudat, so reserve
                // every physical candidate conservatively before resolving
                // the bounded pointer graph.
                ...remoteCandidates,
            ];
            const assemblyBytes = assemblyRows.reduce(
                (sum, entry) => sum + entry.size + Buffer.byteLength(entry.key, 'utf-8'),
                databaseAssemblyBytes,
            );
            const pinRequired = pinPayloadBytes * BACKUP_DISK_HEADROOM + 16 * 1024 * 1024;
            // The source-to-source assembler may simultaneously retain one
            // complete intermediate database (or one row pin) and the growing
            // final database spool. Reserve both before either is created.
            const assemblyRequired = assemblyBytes * 2 * BACKUP_DISK_HEADROOM
                + 16 * 1024 * 1024;
            const archivePayloadUpperBound = archiveTargetPath === null
                ? 0
                : reservationEntries.reduce(
                    (sum, entry) => sum
                        + 8
                        + Buffer.byteLength(entry.backupName, 'utf-8')
                        + entry.size,
                    8 + Buffer.byteLength('database.risudat', 'utf-8') + assemblyRequired,
                );
            const archiveRequired = archiveTargetPath === null
                ? 0
                : archivePayloadUpperBound * BACKUP_DISK_HEADROOM + 16 * 1024 * 1024;
            if (!Number.isSafeInteger(pinRequired)
                || !Number.isSafeInteger(assemblyRequired)
                || !Number.isSafeInteger(archiveRequired)) {
                throw new Error('Full backup export size exceeds the safe integer range');
            }
            const requirements = [
                { targetPath: partialExportSpoolDir, role: 'PIN', bytes: pinRequired },
                { targetPath: databaseSpoolDir, role: 'DATABASE', bytes: assemblyRequired },
            ];
            if (archiveTargetPath !== null) {
                requirements.push({
                    targetPath: archiveTargetPath,
                    role: 'ARCHIVE',
                    bytes: archiveRequired,
                });
            }
            reservation = await reserveFullExportDisk(token, requirements);

            pinDir = path.join(
                partialExportSpoolDir,
                `${FULL_EXPORT_PIN_PREFIX}${process.pid}-${token}`,
            );
            await fs.mkdir(pinDir, { recursive: false, mode: 0o700 });
            await waitAtFullExportDuringPinTestGate(signal);
            const databaseSourcePath = path.join(pinDir, 'database.pin');
            const databasePin = await snapshot.kvWriteToFile(
                databaseKey,
                databaseSourcePath,
                fullExportSnapshotSpoolOptions(signal),
            );
            if (!databasePin || databasePin.size !== databaseSize) {
                throw fullBackupDatabaseUnavailableError(
                    new Error('Snapshot database changed while pinning'),
                );
            }
            const databaseSource = { filePath: databaseSourcePath, size: databaseSize };
            const snapshotEntries = [
                ...baseSnapshotEntries,
                ...(includeServeOnlyRows
                    ? await listPluginBackupEntries(snapshot, databaseState)
                    : []),
            ];
            const plannedEntries = [...filesystemEntries, ...snapshotEntries]
                .sort((a, b) => a.sortKey.localeCompare(b.sortKey));
            preflightBackupEntries(plannedEntries);
            const pinnedEntries = [];
            let index = 0;
            for (const entry of plannedEntries) {
                throwIfBackupExportAborted(signal);
                if (entry.kind !== 'source-file') {
                    const destination = path.join(pinDir, `${String(index).padStart(8, '0')}.pin`);
                    pinnedEntries.push(await pinFullBackupSnapshotEntry(
                        snapshot,
                        entry,
                        destination,
                        signal,
                    ));
                    index++;
                    continue;
                }
                const destination = path.join(pinDir, `${String(index).padStart(8, '0')}.pin`);
                pinnedEntries.push(await copyBackupExportFile(entry, destination, signal));
                index++;
            }
            preflightBackupEntries([
                ...pinnedEntries,
                { backupName: 'database.risudat', size: databaseSource.size },
            ]);
            return {
                token,
                snapshot,
                databaseSource,
                databaseState,
                pinDir,
                entries: pinnedEntries,
                reservation,
                archiveReservedBytes: archiveRequired,
            };
        }, signal);
    } catch (error) {
        try { snapshot?.close(); } catch {}
        if (pinDir) await fs.rm(pinDir, { recursive: true, force: true }).catch(() => {});
        releaseFullExportDiskReservation(reservation);
        activeFullExportPins.delete(token);
        throw error;
    }
}

async function cleanupFullBackupState(state) {
    if (!state) return;
    try { state.snapshot?.close(); } catch {}
    await fs.rm(state.pinDir, { recursive: true, force: true }).catch(() => {});
    releaseFullExportDiskReservation(state.reservation);
    activeFullExportPins.delete(state.token);
}

function partialBackupAssetKeys(database) {
    const keys = new Set();
    const addPng = (key) => {
        if (typeof key === 'string' && key.endsWith('.png')) keys.add(key);
    };
    for (const character of database?.characters ?? []) addPng(character?.image);
    addPng(database?.userIcon);
    for (const persona of database?.personas ?? []) addPng(persona?.icon);
    addPng(database?.customBackground);
    for (const item of database?.characterOrder ?? []) {
        if (item && typeof item === 'object') {
            addPng(item.img);
            addPng(item.imgFile);
        }
    }
    for (const preset of database?.botPresets ?? []) addPng(preset?.image);
    return keys;
}

function listPartialBackupAssetEntries(database, reader) {
    const requested = partialBackupAssetKeys(database);
    const available = new Map(
        listAssetEntriesWithSizes(reader).map(entry => [entry.key, entry]),
    );
    const entries = [];
    let missing = 0;
    for (const key of requested) {
        const entry = available.get(key);
        if (!entry) {
            missing++;
            continue;
        }
        entries.push({
            kind: 'asset',
            key: entry.key,
            backupName: path.basename(entry.key),
            sortKey: entry.key,
            size: entry.size,
            source: entry.source,
            legacyHash: entry.legacyHash,
        });
    }
    entries.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    return { entries, missing };
}

const partialExportJobs = new Map();
const partialExportCancellationTombstones = new Map();

function partialExportOwner(req) {
    const sessionId = req.headers['x-session-id'];
    return typeof sessionId === 'string' ? sessionId : '';
}

function partialExportCancellationKey(owner, jobId) {
    return JSON.stringify([owner, jobId]);
}

function prunePartialExportCancellationTombstones(now = Date.now()) {
    for (const [key, expiresAt] of partialExportCancellationTombstones) {
        if (expiresAt <= now) partialExportCancellationTombstones.delete(key);
    }
}

function recordPartialExportCancellation(owner, jobId) {
    const now = Date.now();
    prunePartialExportCancellationTombstones(now);
    const key = partialExportCancellationKey(owner, jobId);
    partialExportCancellationTombstones.delete(key);
    while (partialExportCancellationTombstones.size
        >= PARTIAL_EXPORT_MAX_CANCELLATION_TOMBSTONES) {
        partialExportCancellationTombstones.delete(
            partialExportCancellationTombstones.keys().next().value,
        );
    }
    partialExportCancellationTombstones.set(
        key,
        now + PARTIAL_EXPORT_CANCELLATION_TTL_MS,
    );
}

function wasPartialExportCancelled(owner, jobId) {
    prunePartialExportCancellationTombstones();
    return partialExportCancellationTombstones.has(
        partialExportCancellationKey(owner, jobId),
    );
}

function partialExportJobForRequest(req, res) {
    const job = partialExportJobs.get(req.params.jobId);
    if (!job || job.owner !== partialExportOwner(req)) {
        res.status(404).json({ error: 'Partial export job not found' });
        return null;
    }
    return job;
}

function throwIfPartialExportCancelled(job) {
    if (job.abortController.signal.aborted) {
        const error = new Error('Partial export was cancelled');
        error.name = 'AbortError';
        throw error;
    }
}

async function cleanupPartialExportArtifacts(job) {
    try { job.snapshot?.close(); } catch {}
    job.snapshot = null;
    if (job.databaseSpool?.filePath) {
        await fs.unlink(job.databaseSpool.filePath).catch(() => {});
    }
    job.databaseSpool = null;
    await fs.rm(job.spoolDir, { recursive: true, force: true }).catch(() => {});
}

async function cleanupPartialExportJob(job) {
    if (job.cleaned) return;
    job.cleaned = true;
    partialExportJobs.delete(job.id);
    job.abortController.abort();
    await cleanupPartialExportArtifacts(job);
}

async function copyPartialExportAsset(job, entry, destination) {
    const sourceName = assetNameForKey(entry.key);
    if (!sourceName || !isSafeAssetName(sourceName)) {
        throw new Error(`Invalid partial export asset: ${entry.key}`);
    }
    const source = await fs.open(assetPathFor(sourceName), 'r');
    let output;
    try {
        const before = await source.stat();
        if (!before.isFile() || before.size !== entry.size) {
            throw new Error(`Partial export asset changed before it could be pinned: ${entry.key}`);
        }
        output = await fs.open(destination, 'wx', 0o600);
        const hash = nodeCrypto.createHash('sha256');
        const buffer = Buffer.allocUnsafe(256 * 1024);
        let offset = 0;
        while (true) {
            throwIfPartialExportCancelled(job);
            const { bytesRead } = await source.read(buffer, 0, buffer.length, offset);
            if (bytesRead === 0) break;
            const chunk = buffer.subarray(0, bytesRead);
            hash.update(chunk);
            let written = 0;
            while (written < bytesRead) {
                const result = await output.write(chunk, written, bytesRead - written, offset + written);
                written += result.bytesWritten;
            }
            offset += bytesRead;
            job.progress.bytes += bytesRead;
        }
        const after = await source.stat();
        if (
            offset !== before.size
            || after.size !== before.size
            || after.dev !== before.dev
            || after.ino !== before.ino
            || after.mtimeMs !== before.mtimeMs
        ) {
            throw new Error(`Partial export asset changed while it was being pinned: ${entry.key}`);
        }
        await output.sync();
        await output.close();
        output = null;
        const digest = hash.digest('hex');
        const verification = sourceName.match(/^([0-9a-f]{64})\.[A-Za-z0-9]{1,10}$/);
        if (verification && verification[1] !== digest && !entry.legacyHash) {
            throw new Error(`Partial export asset hash mismatch: ${entry.key}`);
        }
        return {
            kind: 'file',
            sourcePath: destination,
            backupName: entry.backupName,
            sortKey: entry.sortKey,
            size: offset,
            sha256: digest,
        };
    } finally {
        await output?.close().catch(() => {});
        await source.close().catch(() => {});
    }
}

async function pinPartialExportState(job) {
    return queueStorageReadAfterImports(async () => {
        throwIfPartialExportCancelled(job);
        await flushPendingDb();
        const snapshot = createKvSnapshot();
        job.snapshot = snapshot;
        try {
            const raw = snapshot.kvGet('database/database.bin');
            if (!raw) throw new Error('No database is available to export');
            const strippedDb = await loadStrippedDatabase(raw, 'Partial Backup');
            const database = { ...strippedDb, account: undefined };
            const selected = listPartialBackupAssetEntries(database, snapshot);
            const mcpToolCalls = listMcpToolCallBackupEntries(snapshot, 'kv');
            const drafts = listDraftBackupEntries(snapshot, { database, kind: 'kv' });
            const selectedEntries = [...selected.entries, ...mcpToolCalls, ...drafts]
                .sort((left, right) => left.sortKey.localeCompare(right.sortKey));
            preflightBackupEntries([
                { backupName: 'database.risudat', size: raw.length },
                ...selectedEntries,
            ]);
            const assemblyBytes = [
                ...listLogicalChatRowsWithSizes(snapshot),
                ...snapshot.kvListWithSizes(PLUGIN_SAVE_PREFIX),
                ...snapshot.kvListWithSizes(PLUGIN_SAVE_META_PREFIX),
            ].reduce(
                (sum, entry) => sum + entry.size + Buffer.byteLength(entry.key, 'utf-8'),
                raw.length,
            );
            const selectedEntryBytes = selectedEntries.reduce(
                (sum, entry) => sum + entry.size,
                0,
            );
            const requiredBytes = (
                (assemblyBytes + selectedEntryBytes) * BACKUP_DISK_HEADROOM
                + 16 * 1024 * 1024
            );
            if (!Number.isSafeInteger(requiredBytes)) {
                throw new Error('Partial export size exceeds the safe integer range');
            }
            const disk = await checkDiskSpace(requiredBytes);
            if (!disk.ok) {
                const error = new Error(
                    `Insufficient disk space for partial export (requires ${requiredBytes} bytes)`,
                );
                error.code = 'ENOSPC';
                throw error;
            }
            const databaseSpoolDisk = await checkDiskSpace(
                assemblyBytes + 8 * 1024 * 1024,
                databaseSpoolDir,
            );
            if (!databaseSpoolDisk.ok) {
                const error = new Error(
                    'Insufficient disk space on the configured database spool volume',
                );
                error.code = 'ENOSPC';
                throw error;
            }
            job.missingAssets = selected.missing;
            job.progress.phase = 'pinning-assets';
            job.progress.total = selectedEntries.length + 2;

            const pinnedEntries = [];
            let pinIndex = 0;
            for (const entry of selectedEntries) {
                throwIfPartialExportCancelled(job);
                if (entry.source === 'fs') {
                    const destination = path.join(job.pinDir, `${String(pinIndex).padStart(8, '0')}.asset`);
                    pinnedEntries.push(await copyPartialExportAsset(job, entry, destination));
                    pinIndex++;
                } else {
                    // Preserve the source selected at the snapshot boundary.
                    // A later filesystem file must never shadow this KV row.
                    pinnedEntries.push({ ...entry, kind: 'kv' });
                }
                job.progress.current++;
            }
            preflightBackupEntries(pinnedEntries);
            return { snapshot, database, entries: pinnedEntries };
        } catch (error) {
            snapshot.close();
            job.snapshot = null;
            throw error;
        }
    }, job.abortController.signal);
}

async function writePartialExportArchive(job, database, entries) {
    job.progress.phase = 'folding-database';
    job.databaseSpool = await spoolSelfContainedBackupDatabase(database, {
        foldPluginStorage: true,
        shouldAbort: () => job.abortController.signal.aborted,
        reader: job.snapshot,
        onMissingChatRow: (chaId, chatId) => {
            warnAndPreserveMissingChatRow('Partial Backup Export', chaId, chatId);
        },
    });
    throwIfPartialExportCancelled(job);
    const selectedEntries = await selectReferencedMcpToolCallEntries(
        entries,
        job.databaseSpool,
        () => job.abortController.signal.aborted,
    );
    preflightBackupEntries([
        ...selectedEntries,
        { backupName: 'database.risudat', size: job.databaseSpool.size },
    ]);
    job.progress.total = selectedEntries.length + 2;
    job.progress.current = selectedEntries.length;

    const output = createWriteStream(job.archiveTempPath, { flags: 'wx', mode: 0o600 });
    try {
        for (const entry of selectedEntries) {
            throwIfPartialExportCancelled(job);
            if (!await writeWithBackpressure(
                output,
                encodeBackupEntryHeader(entry.backupName, entry.size),
                () => job.abortController.signal.aborted,
            )) throwIfPartialExportCancelled(job);
            if (entry.kind === 'file') {
                if (!await streamFileToWritable(
                    entry.sourcePath,
                    output,
                    () => job.abortController.signal.aborted,
                )) throwIfPartialExportCancelled(job);
            } else {
                const value = job.snapshot.kvGet(entry.key);
                if (value === null || value.length !== entry.size) {
                    throw new Error(`Pinned partial export row is unavailable: ${entry.key}`);
                }
                if (!await writeWithBackpressure(
                    output,
                    value,
                    () => job.abortController.signal.aborted,
                )) throwIfPartialExportCancelled(job);
            }
        }

        job.progress.current++;
        if (!await writeWithBackpressure(
            output,
            encodeBackupEntryHeader('database.risudat', job.databaseSpool.size),
            () => job.abortController.signal.aborted,
        )) throwIfPartialExportCancelled(job);
        if (!await streamFileToWritable(
            job.databaseSpool.filePath,
            output,
            () => job.abortController.signal.aborted,
        )) throwIfPartialExportCancelled(job);
        job.progress.current++;
        output.end();
        await finished(output);
        await fs.rename(job.archiveTempPath, job.archivePath);
    } catch (error) {
        output.destroy();
        await finished(output).catch(() => {});
        throw error;
    }
}

async function preparePartialExportJob(job) {
    try {
        job.progress.phase = 'snapshot';
        const pinned = await pinPartialExportState(job);
        job.progress.phase = 'assembling';

        const testDelay = process.env.NODE_ENV === 'test'
            ? Number(process.env.POCKETRISU_TEST_PARTIAL_EXPORT_DELAY_MS ?? 0)
            : 0;
        if (Number.isFinite(testDelay) && testDelay > 0) {
            throwIfPartialExportCancelled(job);
            await new Promise((resolve, reject) => {
                const timer = setTimeout(resolve, testDelay);
                job.abortController.signal.addEventListener('abort', () => {
                    clearTimeout(timer);
                    reject(Object.assign(new Error('Partial export was cancelled'), { name: 'AbortError' }));
                }, { once: true });
            });
        }

        await writePartialExportArchive(job, pinned.database, pinned.entries);
        throwIfPartialExportCancelled(job);
        const stat = await fs.stat(job.archivePath);
        job.size = stat.size;
        job.state = 'ready';
        job.progress.phase = 'ready';
        job.expiresAt = Date.now() + PARTIAL_EXPORT_JOB_TTL_MS;
        try { job.snapshot?.close(); } catch {}
        job.snapshot = null;
        if (job.databaseSpool?.filePath) {
            await fs.unlink(job.databaseSpool.filePath).catch(() => {});
        }
        job.databaseSpool = null;
        await fs.rm(job.pinDir, { recursive: true, force: true }).catch(() => {});
    } catch (error) {
        if (!job.abortController.signal.aborted) {
            logger.error('[Partial Backup Export] Preparation failed:', error);
            job.state = 'failed';
            job.error = error?.message || String(error);
            job.progress.phase = 'failed';
            job.expiresAt = Date.now() + PARTIAL_EXPORT_JOB_TTL_MS;
            await cleanupPartialExportArtifacts(job);
        } else {
            job.state = 'cancelled';
            await cleanupPartialExportJob(job);
        }
    }
}

function resolveBackupStorageKey(name) {
    assertBackupEntryNameWithinLimit(name);

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

    if (name === PLUGIN_STORAGE_MANIFEST_KEY) {
        return PLUGIN_STORAGE_MANIFEST_KEY;
    }

    if (name.startsWith(MCP_TOOL_CALL_CACHE_PREFIX)) {
        if (!parseMcpToolCallStorageKey(name)) {
            throw new Error(`Invalid remembered MCP tool-call entry name: ${name}`);
        }
        return name;
    }

    if (name.startsWith(DRAFT_PREFIX)) {
        if (name.length === DRAFT_PREFIX.length || name.includes('\0')) {
            throw new Error(`Invalid composer draft entry name: ${name}`);
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
        if (isHashedPluginSaveStorageKey(name, prefix)) {
            assertArchiveSafePluginSaveStorageKey(name);
        } else {
            decodeValidatedPluginStorageKey(name, prefix);
        }
        return name;
    }

    // Upstream backups transport cold storage as coldstorage/<uuid>.json.
    // Normalize back to the runtime KV key: coldstorage/<uuid>.
    if (name.startsWith('coldstorage/') || COLD_STORAGE_FLAT_NAME_RE.test(name)) {
        return normalizeColdStorageStorageKey(name);
    }

    if (isInvalidBackupPathSegment(name) || name !== path.basename(name)) {
        throw new Error(`Invalid asset backup entry name: ${name}`);
    }

    return `assets/${name}`;
}

// ─── Shared backup import logic ─────────────────────────────────────────────
// Accepts any async iterable of Buffer chunks (HTTP request body, file stream, etc.)
async function importBackupFromSource(dataSource, {
    maxBytes = BACKUP_IMPORT_MAX_BYTES,
    maxEntries = BACKUP_IMPORT_MAX_ENTRIES,
    bufferedEntryMaxBytes = IMPORT_BUFFERED_ENTRY_MAX_BYTES,
    totalBytes = 0,
    onProgress = null,
    signal = null,
} = {}) {
    maxBytes = finiteByteLimit(maxBytes, BACKUP_IMPORT_MAX_BYTES);
    maxEntries = finiteByteLimit(maxEntries, BACKUP_IMPORT_MAX_ENTRIES);
    bufferedEntryMaxBytes = finiteByteLimit(
        bufferedEntryMaxBytes,
        IMPORT_BUFFERED_ENTRY_MAX_BYTES,
        { max: maxBytes },
    );
    if (totalBytes > 0) assertImportSize(totalBytes, maxBytes, 'Backup archive');
    throwIfImportAborted(signal);
    recoverPendingImportSwap('Backup import preparation');
    let hasDatabase = false;
    let databaseSpool = null;
    let activeEntryWriteStream = null;
    let activeEntryWriteFinished = null;
    let databaseIngestion = null;
    let backupEntryStageDir = null;
    let entryIndex = null;
    let backupEntryIndex = 0;
    const deferredDraftEntries = [];
    let assetsRestored = 0;
    let bytesReceived = 0;
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
    async function writeStagingInlayFileFromSource(id, ext, source, info) {
        const normalizedExt = normalizeInlayExt(ext);
        await copyFileToSpool(
            source.filePath,
            stagingInlayFilePath(id, normalizedExt),
            { maxBytes, signal },
        );
        writeStagingSidecarSync(id, { ...(info || {}), ext: normalizedExt });
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

    async function importStagedEntry(name, source) {
        const inlayRaw = parseInlayBackupName(name);
        const inlaySidecar = parseInlaySidecarBackupName(name);
        const readBuffered = () => readFileToBufferBounded(source.filePath, {
            size: source.size,
            maxBytes: Math.min(bufferedEntryMaxBytes, maxBytes),
            label: `Backup entry ${name}`,
            code: 'IMPORT_BUFFERED_ENTRY_LIMIT',
            signal,
        });

        if (inlayRaw) {
            const before = entryIndex.getInlay(inlayRaw.id);
            entryIndex.markInlayImported(inlayRaw.id);
            if (inlayRaw.ext) {
                await writeStagingInlayFileFromSource(
                    inlayRaw.id,
                    inlayRaw.ext,
                    source,
                    before?.legacy || { ext: inlayRaw.ext, name: inlayRaw.id, type: 'image' },
                );
            } else {
                const data = await readBuffered();
                if (data.length > 0 && data[0] === 0x7b) {
                    const parsed = JSON.parse(data.toString('utf-8'));
                    const type = typeof parsed?.type === 'string' ? parsed.type : 'image';
                    const ext = normalizeInlayExt(parsed?.ext);
                    const buffer = type === 'signature'
                        ? Buffer.from(typeof parsed?.data === 'string' ? parsed.data : '', 'utf-8')
                        : decodeDataUri(parsed?.data).buffer;
                    writeStagingInlayFileSync(inlayRaw.id, ext, buffer, before?.legacy || {
                        ext,
                        name: typeof parsed?.name === 'string' ? parsed.name : inlayRaw.id,
                        type,
                        height: typeof parsed?.height === 'number' ? parsed.height : undefined,
                        width: typeof parsed?.width === 'number' ? parsed.width : undefined,
                    });
                } else {
                    writeStagingInlayFileSync(inlayRaw.id, 'bin', data, before?.legacy || {
                        ext: 'bin',
                        name: inlayRaw.id,
                        type: 'image',
                    });
                }
            }
            const after = entryIndex.getInlay(inlayRaw.id);
            if (after?.explicit) {
                writeStagingSidecarSync(inlayRaw.id, after.explicit);
            } else if (!after?.sidecar && after?.legacy) {
                writeStagingSidecarSync(inlayRaw.id, after.legacy);
            }
            kvClearDeletion(`inlay/${inlayRaw.id}`);
            assetsRestored += 1;
        } else if (inlaySidecar) {
            const data = await readBuffered();
            const parsed = JSON.parse(data.toString('utf-8'));
            entryIndex.markInlaySidecar(inlaySidecar.id, parsed);
            writeStagingSidecarSync(inlaySidecar.id, parsed);
        } else if (name.startsWith('inlay_info/')) {
            const data = await readBuffered();
            const id = name.slice('inlay_info/'.length);
            if (!isSafeInlayId(id)) {
                throw new Error(`Invalid legacy inlay info entry name: ${name}`);
            }
            const parsed = JSON.parse(data.toString('utf-8'));
            const info = {
                ext: normalizeInlayExt(parsed?.ext),
                name: typeof parsed?.name === 'string' ? parsed.name : id,
                type: typeof parsed?.type === 'string' ? parsed.type : 'image',
                height: typeof parsed?.height === 'number' ? parsed.height : undefined,
                width: typeof parsed?.width === 'number' ? parsed.width : undefined,
            };
            entryIndex.setLegacyInlayInfo(id, info);
            const state = entryIndex.getInlay(id);
            if (state?.imported && !state.sidecar) {
                writeStagingSidecarSync(id, info);
            }
        } else if (name.startsWith('inlay_thumb/')) {
            // Skip deprecated thumbnail entries from legacy backups.
        } else {
            const storageKey = resolveBackupStorageKey(name);
            if (storageKey.startsWith('assets/')) {
                await writeImportedAssetFromFile(
                    assetStage,
                    storageKey,
                    source,
                    signal,
                    'Backup import',
                    { maxBytes },
                );
            } else if (storageKey.startsWith(PLUGIN_SAVE_PREFIX)) {
                await validateAndImportPluginValueFile(
                    storageKey,
                    source,
                    signal,
                    { maxBytes },
                );
            } else if (storageKey.startsWith('coldstorage/')) {
                await importColdStorageFromFile(
                    storageKey,
                    source,
                    signal,
                    `Backup entry ${name}`,
                    { maxBytes, bufferedEntryMaxBytes },
                );
            } else if (storageKey.startsWith(PLUGIN_SAVE_META_PREFIX)) {
                await validateAndImportPluginMetadataFile(
                    storageKey,
                    source,
                    signal,
                    { maxBytes },
                );
            } else if (storageKey === PLUGIN_STORAGE_MANIFEST_KEY) {
                await importOpaqueRowFromFile(storageKey, source, signal);
            } else if (storageKey.startsWith(DRAFT_PREFIX)) {
                deferredDraftEntries.push({ key: storageKey, ...source });
                return { retainSource: true };
            } else {
                await importOpaqueRowFromFile(
                    storageKey,
                    source,
                    signal,
                );
            }
            assetsRestored += 1;
        }
    }

    throwIfImportAborted(signal);
    await flushPendingDb({ scheduleSnapshot: false });
    throwIfImportAborted(signal);
    await createBackupAndRotate({ storageAlreadyExclusive: true });
    throwIfImportAborted(signal);
    backupEntryStageDir = path.join(
        databaseSpoolDir,
        `${BACKUP_ENTRY_STAGE_PREFIX}${process.pid}-${nodeCrypto.randomUUID()}`,
    );
    await fs.mkdir(backupEntryStageDir, { recursive: false, mode: 0o700 });
    entryIndex = createBackupImportIndex(path.join(backupEntryStageDir, 'index.sqlite'));

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
        kvDelPrefix(MCP_TOOL_CALL_CACHE_PREFIX);
        // Chat rows are per-database payloads and are never carried as backup
        // entries; imported database.risudat recreates them before commit.
        for (const key of chatRowStore.listAllChatRowKeys()) kvDel(key);
        // Plugin rows belong to the imported database. New Node-only backups
        // repopulate them as entries below; legacy/upstream backups keep their
        // values folded in database.risudat. Either way, stale rows must go.
        kvDelPrefix(PLUGIN_SAVE_PREFIX);
        kvDelPrefix(PLUGIN_SAVE_META_PREFIX);
        kvDel(PLUGIN_STORAGE_MANIFEST_KEY);
        // Drafts are graph-owned backup rows. Clear the prior dataset now, then
        // restore only entries whose character/chat IDs survive normalization.
        kvDelPrefix(DRAFT_PREFIX);
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
        kvDel(CHARACTER_DEFAULTS_MARKER_KEY);
        clearEntities();

        let pending = Buffer.alloc(0);
        let currentEntry = null;
        for await (const sourceChunk of dataSource) {
            throwIfImportAborted(signal);
            const sourceBuffer = Buffer.isBuffer(sourceChunk)
                ? sourceChunk
                : Buffer.from(sourceChunk);
            for (let pageOffset = 0; pageOffset < sourceBuffer.length; pageOffset += IMPORT_IO_PAGE_BYTES) {
                throwIfImportAborted(signal);
                const chunk = sourceBuffer.subarray(
                    pageOffset,
                    Math.min(sourceBuffer.length, pageOffset + IMPORT_IO_PAGE_BYTES),
                );
                const nextBytesReceived = bytesReceived + chunk.length;
                assertImportSize(nextBytesReceived, maxBytes, 'Backup archive');
                bytesReceived = nextBytesReceived;
                if (onProgress) onProgress(bytesReceived, totalBytes);

                let buffer = pending.length > 0
                    ? Buffer.concat([pending, chunk])
                    : chunk;
                pending = Buffer.alloc(0);

                while (buffer.length > 0) {
                    if (!currentEntry) {
                        if (buffer.length < 4) {
                            pending = Buffer.from(buffer);
                            break;
                        }
                        const nameLength = buffer.readUInt32LE(0);
                        if (nameLength > BACKUP_ENTRY_NAME_MAX_BYTES) {
                            throw importFormatError(
                                `Backup entry name exceeds ${BACKUP_ENTRY_NAME_MAX_BYTES} bytes`,
                                'INVALID_BACKUP_ENTRY_NAME',
                            );
                        }
                        const headerLength = 4 + nameLength + 4;
                        if (buffer.length < headerLength) {
                            pending = Buffer.from(buffer);
                            break;
                        }

                        const name = buffer.subarray(4, 4 + nameLength).toString('utf-8');
                        const dataLength = buffer.readUInt32LE(4 + nameLength);
                        assertImportSize(dataLength, maxBytes, `Backup entry ${name}`);
                        buffer = buffer.subarray(headerLength);

                        if (!entryIndex.addEntry(name)) {
                            throw importFormatError(`Duplicate backup entry: ${name}`, 'DUPLICATE_BACKUP_ENTRY');
                        }
                        if (entryIndex.count > maxEntries) {
                            throw importSizeError(
                                'Backup entry count',
                                maxEntries,
                                entryIndex.count,
                                'IMPORT_ENTRY_COUNT_LIMIT',
                            );
                        }
                        if (name === 'encryption.risudat') {
                            throw importFormatError(
                                'Encrypted risuai.xyz account backups cannot be imported. Re-export the backup without account encryption and try again.',
                                'ENCRYPTED_BACKUP_UNSUPPORTED',
                            );
                        }

                        let filePath;
                        if (name === 'database.risudat') {
                            filePath = path.join(
                                databaseSpoolDir,
                                `${DATABASE_SPOOL_FILE_PREFIX}backup-import-${process.pid}-${nodeCrypto.randomUUID()}.tmp`,
                            );
                            databaseSpool = { filePath, size: dataLength };
                        } else {
                            filePath = path.join(
                                backupEntryStageDir,
                                `${String(backupEntryIndex++).padStart(8, '0')}.row`,
                            );
                        }
                        const writeStream = createWriteStream(filePath, {
                            flags: 'wx',
                            mode: 0o600,
                            highWaterMark: IMPORT_IO_PAGE_BYTES,
                        });
                        const writeFinished = finished(writeStream);
                        writeFinished.catch(() => {});
                        activeEntryWriteStream = writeStream;
                        activeEntryWriteFinished = writeFinished;
                        currentEntry = {
                            name,
                            remaining: dataLength,
                            filePath,
                            size: dataLength,
                            writeStream,
                            writeFinished,
                        };
                    }

                    const take = Math.min(currentEntry.remaining, buffer.length);
                    if (take > 0) {
                        const piece = buffer.subarray(0, take);
                        if (!await writeWithBackpressure(currentEntry.writeStream, piece)) {
                            throw new Error('Entry spool closed during backup import');
                        }
                        currentEntry.remaining -= take;
                        buffer = buffer.subarray(take);
                    }

                    if (currentEntry.remaining === 0) {
                        currentEntry.writeStream.end();
                        await currentEntry.writeFinished;
                        activeEntryWriteStream = null;
                        activeEntryWriteFinished = null;
                        if (currentEntry.name === 'database.risudat') {
                            hasDatabase = true;
                        } else {
                            const importResult = await importStagedEntry(currentEntry.name, {
                                filePath: currentEntry.filePath,
                                size: currentEntry.size,
                            });
                            if (!importResult?.retainSource) {
                                await fs.unlink(currentEntry.filePath).catch(() => {});
                            }
                        }
                        currentEntry = null;
                    }
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
        throwIfImportAborted(signal);
        const databaseInspection = await inspectRisuSaveSource(databaseSource);
        if (canStreamImportedDatabase(databaseInspection)) {
            databaseIngestion = await ingestImportedDatabaseStreaming(
                databaseSource,
                databaseInspection,
                { signal },
            );
            // Canonical streaming saves have no REMOTE blocks; block saves
            // have already resolved them into the converted database.
            markRemoteMigrationDone();
        } else {
            assertImportSize(
                databaseSpool.size,
                LEGACY_DATABASE_IMPORT_MAX_BYTES,
                'Legacy database',
                'LEGACY_DATABASE_IMPORT_LIMIT',
            );
            const decoded = await decodeBoundedLegacyRisuSave(databaseSource, {
                inspection: databaseInspection,
                tempDir: databaseSpoolDir,
                maxLegacyBytes: LEGACY_DATABASE_IMPORT_MAX_BYTES,
                shouldAbort: () => signal?.aborted === true,
                signal,
                resolveRemoteSize: async (name) => kvSize(`remotes/${name}.local.bin`),
                resolveRemote: async (name) => kvGet(`remotes/${name}.local.bin`),
            });
            databaseIngestion = await ingestDatabase(decoded, {
                skipLiveRemoteMigration: true,
            });
            markRemoteMigrationDone();
        }
        await restoreImportedDraftEntries(
            deferredDraftEntries,
            databaseIngestion?.strippedDb,
            { signal },
        );
        // Deterministically hold the hardest reader race in compatibility
        // tests: the candidate database is visible inside SQLite's uncommitted
        // replacement transaction, but the import has not published it.
        await waitAtBackupImportTestGate(signal);
        throwIfImportAborted(signal);
        if (backupImportFailpoint === 'after-database-ingestion') {
            throw new ImportIngressError('Backup import was rolled back before publication', {
                code: 'BACKUP_IMPORT_NOT_COMMITTED',
                statusCode: 500,
                retryable: true,
            });
        }
        for (const { id, info } of entryIndex.legacyInlaysMissingSidecars()) {
            writeStagingSidecarSync(id, info);
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
        throwIfImportAborted(signal);
        sqliteDb.exec('COMMIT');
        transactionCommitted = true;

        applySqliteDurabilityMode();
        runTrackedWalCheckpoint('TRUNCATE', 'backup-import-commit');
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
            if (error instanceof ImportIngressError && !rollbackSucceeded) {
                error.commitOutcome = 'unknown';
                error.commitOutcomeUnknown = true;
                error.statusCode = 500;
            }
            if (rollbackSucceeded && error && typeof error === 'object') {
                error.commitOutcome = 'not-committed';
                error.commitOutcomeUnknown = false;
            }
        } else if (error && typeof error === 'object') {
            error.commitOutcome = 'committed';
            error.commitOutcomeUnknown = false;
        }
        throw error;
    } finally {
        applySqliteDurabilityMode();
        if (activeEntryWriteStream) {
            activeEntryWriteStream.destroy();
            await activeEntryWriteFinished?.catch(() => {});
        }
        if (databaseSpool) {
            await fs.unlink(databaseSpool.filePath).catch(() => {});
        }
        try { entryIndex?.destroy(); } catch (error) {
            logger.warn('[Backup Import] Failed to remove entry index:', error);
        }
        if (backupEntryStageDir) {
            await fs.rm(backupEntryStageDir, { recursive: true, force: true }).catch(() => {});
        }
    }

    invalidateAllDbCaches();

    const coldStorageFailed = databaseIngestion?.stats.failed || 0;

    try {
        runTrackedWalCheckpoint('TRUNCATE', 'backup-import-cleanup');
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
        head.innerHTML = `<script>globalThis.__NODE__ = true; globalThis.__PATCH_SYNC__ = ${enablePatchSync}; globalThis.__ALLOW_INSECURE_CONTEXT__ = ${allowInsecureContext}; globalThis.__PLUGIN_STORAGE_DIAG__ = ${isRequestTracingEnabled()}</script>` + head.innerHTML
        
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
        const proxyTarget = assertProxyTargetAllowed(urlParam, {
            enforceInternalBlock: HUB_HOSTING_MODE,
        });
        originalResponse = await fetchProxyTarget(proxyTarget, {
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
        if (handleProxyTargetBlocked(res, 'Proxy', err)) {
            return;
        }
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
        const proxyTarget = assertProxyTargetAllowed(urlParam, {
            enforceInternalBlock: HUB_HOSTING_MODE,
        });
        originalResponse = await fetchProxyTarget(proxyTarget, {
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
        if (handleProxyTargetBlocked(res, 'Proxy', err)) {
            return;
        }
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
        const externalURL = resolveHubProxyTarget({
            pathHeader: req.headers['x-risu-node-path'],
            originalUrl: req.originalUrl,
            hubURL,
        });
        
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
        
        
        const proxyTarget = assertProxyTargetAllowed(externalURL, {
            enforceInternalBlock: HUB_HOSTING_MODE,
        });
        const response = await fetchProxyTarget(proxyTarget, {
            method: req.method,
            headers: headersToSend,
            body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
            redirect: 'manual',
            duplex: 'half'
        });

        let redirectResponse;
        if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
            const redirectTarget = assertProxyTargetAllowed(response.headers.get('location'), {
                enforceInternalBlock: HUB_HOSTING_MODE,
            });
            const newHeaders = { ...headersToSend };
            redirectResponse = await fetchProxyTarget(redirectTarget, {
                method: req.method,
                headers: newHeaders,
                body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
                redirect: 'manual',
                duplex: 'half'
            });
        }
        
        for (const [key, value] of response.headers.entries()) {
            // Skip encoding-related headers to prevent double decoding
            if (excludedHeaders.includes(key.toLowerCase())) {
                continue;
            }
            res.setHeader(key, value);
        }
        res.status(response.status);

        if (redirectResponse) {
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
        if (handleProxyTargetBlocked(res, 'Hub Proxy', error)) {
            return;
        }
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
    if (HUB_HOSTING_MODE) {
        res.status(403).send({ error: HOSTED_PROXY_STREAM_BLOCKED_ERROR });
        return;
    }
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

// Durable model-preset relay. Provider bytes are streamed to the client and
// journaled so an interrupted tab can resume or recover the response.
const { createModelJobs } = require('./model-jobs.cjs');
const modelJobs = createModelJobs({ saveDir: savePath, logger });
modelJobs.registerRoutes(app, { auth: checkProxyAuth });

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

// Side-effect-free state check used when a tab returns to the foreground.
app.get('/api/session/lock-status', async (req, res) => {
    if (!await checkAuth(req, res)) return
    const id = req.headers['x-session-id']
    const clientWriterEpoch = req.headers[WRITER_EPOCH_HEADER]
    res.json({
        state: sessionLock.peek(
            typeof id === 'string' ? id : '',
            typeof clientWriterEpoch === 'string' ? clientWriterEpoch : '',
        ),
        writerEpoch: sessionLock.epoch(),
    })
})

// ── Session cookie issuance (F-0) ──────────────────────────────────────────
// Called once after JWT auth succeeds. Issues a long-lived cookie so that
// <img src="/api/asset/..."> requests can be authenticated without JS.
app.post('/api/session', async (req, res) => {
    if (!await checkAuth(req, res)) return
    const clientSessionId = req.headers['x-session-id']
    if (typeof clientSessionId === 'string') {
        sessionLock.register(clientSessionId)
        console.log('[Session] Session boot registered')
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
    res.json({
        ok: true,
        build: expectedClientBuild,
        writerEpoch: sessionLock.epoch(),
        capabilities: {
            pluginStorage: {
                maxValueBytes: PLUGIN_VALUE_MAX_BYTES,
            },
            pluginStorageBatch: {
                transport: 'framed-v1',
                maxOperations: PLUGIN_STORAGE_BATCH_MAX_OPERATIONS,
                maxMetadataBytes: PLUGIN_STORAGE_BATCH_STREAM_MAX_METADATA_BYTES,
                maxValueBytes: PLUGIN_VALUE_MAX_BYTES,
                maxPayloadBytes: PLUGIN_STORAGE_BATCH_STREAM_MAX_PAYLOAD_BYTES,
            },
            pluginStorageTransition: {
                transport: 'framed-v1',
                maxEntries: PLUGIN_STORAGE_TRANSITION_STREAM_MAX_ENTRIES,
                maxMetadataBytes: PLUGIN_STORAGE_TRANSITION_STREAM_MAX_METADATA_BYTES,
                maxValueBytes: PLUGIN_TRANSITION_MAX_ROW_BYTES,
                maxPayloadBytes: PLUGIN_STORAGE_TRANSITION_STREAM_MAX_PAYLOAD_BYTES,
            },
            database: {
                rawBootRead: true,
                atomicCreate: true,
                optimizedPluginStorageBootReconcile: true,
                rawBootByteLength: readRawBootByteLengthHint(),
            },
        },
    })
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
        const { decodedKey: key } = decodeAndCanonicalizeHexPath(filePath);
        if (key === 'database/database.bin') {
            let prepared;
            try {
                prepared = await queueStorageReadAfterImports(async () => {
                    await flushPendingDb();
                    return prepareLiveDatabaseRead('Read');
                });
            } catch (error) {
                logger.error('[Read] Failed to load database.bin', error);
                return next(error);
            }
            if (!prepared) return res.send();
            rememberSessionPluginStorageState(req, prepared.strippedDatabase);
            if (req.headers['if-none-match'] === prepared.etag) {
                return res.status(304).end();
            }
            res.setHeader('x-db-etag', prepared.etag);
            if (DB_CACHE_TEST_DIAGNOSTICS) {
                res.setHeader('x-pocketrisu-test-db-cache', prepared.cacheStatus);
            }
            res.setHeader('Content-Type', 'application/octet-stream');
            res.send(prepared.fullBlob);
            return;
        }
        // Imports hold an open transaction on the server's only SQLite
        // connection while clearing and repopulating plugin rows. Waiting at
        // the last async boundary before kvGet ensures reads observe either the
        // pre-import commit or the post-import commit/rollback, never the
        // transaction's transient contents.
        await importBarrier.waitUntilIdle();
        let value = null;
        if (key.startsWith('inlay/')) {
            value = await readInlayAssetPayload(key.slice('inlay/'.length));
        } else if (key.startsWith('inlay_info/')) {
            value = await readInlayInfoPayload(key.slice('inlay_info/'.length));
        } else if (key.startsWith('assets/')) {
            value = readAssetValue(key);
        }
        if (value === null && !key.startsWith('assets/')) {
            if (canonicalPluginStorageRowPrefix(key)) {
                try {
                    value = await readGenerationBoundPluginStorageRow(req, key);
                } catch (error) {
                    if (error?.pluginStorageNamespaceConflict) {
                        return res.status(409).json({ error: error.message });
                    }
                    throw error;
                }
            } else {
                value = await kvGetAsync(key);
            }
        }
        if(value === null){
            res.send();
        } else {
            const cachedHashes = parseCachedHashesHeader(req.headers['x-cached-hashes']);
            if (cachedHashes.length > 0) {
                const contentHash = sha256Hex(value);
                res.setHeader('x-content-hash', contentHash);
                if (cachedHashes.includes(contentHash)) {
                    return res.status(204).end();
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
        let selected;
        try {
            selected = await queueStorageReadAfterImports(async () => {
                await flushPendingDb();
                const prepared = await prepareLiveDatabaseRead('ReadCached', {
                    includeFullBlob: false,
                });
                if (!prepared) return null;
                return {
                    prepared,
                    cachedRead: dbSegmentMemo.build(
                        prepared.strippedDatabase,
                        inventory,
                        prepared.etag,
                        prepared.revision,
                    ),
                };
            });
        } catch (error) {
            logger.error('[ReadCached] Failed to load database.bin', error);
            return next(error);
        }
        if (!selected) return res.status(404).json({ error: 'Database not found' });
        const { prepared, cachedRead } = selected;
        rememberSessionPluginStorageState(req, prepared.strippedDatabase);
        if (DB_CACHE_TEST_DIAGNOSTICS) {
            res.setHeader(
                'x-pocketrisu-test-db-segments-encoded',
                String(cachedRead.stats.encodedSegments),
            );
            res.setHeader(
                'x-pocketrisu-test-db-segments-reused',
                String(cachedRead.stats.reusedSegments),
            );
        }
        if (cachedRead.kind === 'raw-boot') {
            res.setHeader('x-pocketrisu-db-cache-bypass', cachedRead.reason);
            return res.status(413).json({
                error: 'Database root exceeds the segmented cache value limit',
                code: 'DATABASE_CACHE_ROOT_TOO_LARGE',
            });
        }
        res.setHeader('x-db-etag', prepared.etag);
        if (DB_CACHE_TEST_DIAGNOSTICS) {
            res.setHeader('x-pocketrisu-test-db-cache', prepared.cacheStatus);
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.send(encodeCachedDbReadEnvelope(cachedRead.envelope));
    } catch (error) {
        next(error);
    }
});

// Bootstrap needs one decode-free path to the authoritative monolith. The
// ordinary database read intentionally normalizes/externalizes its payload;
// when those bytes are corrupt that normalization fails before the browser can
// select an internal recovery snapshot. This endpoint performs no publication
// work and remains behind auth plus the import read barrier.
app.get('/api/db/read-raw-for-boot', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        const raw = await queueStorageReadAfterImports(async () => {
            await flushPendingDb();
            return kvGetAsync('database/database.bin');
        });
        // A missing endpoint is also a 404. Use an explicit successful empty
        // response so newer clients never confuse version skew with a fresh
        // installation and overwrite an older server's database.
        if (raw === null) return res.status(204).end();
        res.setHeader('x-db-etag', computeBufferEtag(raw));
        res.setHeader('Content-Type', 'application/octet-stream');
        res.send(raw);
    } catch (error) {
        next(error);
    }
});

// Fresh initialization must never use the generic replacement endpoint. The
// queue linearizes this check with every other storage mutation, and the
// transaction makes creation a single create-only publication.
app.post('/api/db/create-if-absent', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    let shouldCreateBackup = false;
    try {
        const result = await queueStorageMutation(async () => {
            await flushPendingDb();
            const existing = kvGet('database/database.bin');
            if (existing !== null) {
                return {
                    created: false,
                    currentEtag: computeBufferEtag(existing),
                };
            }

            const database = {};
            const encoded = Buffer.from(encodeRisuSaveLegacy(database));
            const created = sqliteDb.transaction(() => {
                // Keep the condition inside the transaction as defense in depth
                // if this route is ever reused outside queueStorageMutation().
                if (kvGet('database/database.bin') !== null) return false;
                kvSet('database/database.bin', encoded);
                return true;
            })();
            if (!created) {
                const committed = kvGet('database/database.bin');
                return {
                    created: false,
                    currentEtag: committed === null ? null : computeBufferEtag(committed),
                };
            }

            invalidateDbCache();
            replaceDbCacheValue(DB_HEX_KEY, database, {
                revision: kvGetDatabaseRevision(),
                estimatedBytes: encoded.length,
                dirty: false,
            });
            dbEtag = computeBufferEtag(encoded);
            seedDbCacheEtag(DB_HEX_KEY, dbEtag);
            rememberSessionPluginStorageState(req, database);
            shouldCreateBackup = true;
            return { created: true, etag: dbEtag };
        });

        if (!result.created) {
            return res.status(409).json({
                success: false,
                created: false,
                error: 'Database already exists',
                code: 'DATABASE_ALREADY_EXISTS',
                currentEtag: result.currentEtag,
                retryable: false,
                commitOutcome: 'not-committed',
                commitOutcomeUnknown: false,
            });
        }
        res.status(201).json({
            success: true,
            created: true,
            etag: result.etag,
            commitOutcome: 'committed',
            commitOutcomeUnknown: false,
        });
        if (shouldCreateBackup) scheduleBackupAndRotate();
    } catch (error) {
        if (isImportInProgressError(error)) return sendImportBusy(res);
        next(error);
    }
});

/**
 * Clear optimized plugin save values and their owner sidecars as one logical
 * mutation. The namespace is intentionally fixed server-side: this is the
 * narrow clear primitive, not a caller-controlled batch or prefix API.
 */
app.post('/api/plugin-storage/clear', async (req, res) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;

    try {
        await queueStorageMutation(async () => {
            if (pluginStorageClearFailpoint === 'pre-transaction') {
                throw new Error('Injected plugin storage clear failure before transaction');
            }
            const publication = await readLivePluginStoragePublication();
            const { dbObj, generation, manifestState } = publication;
            const pinnedState = sessionPluginStorageReadState(req);
            const activeManifest = generation
                && dbObj?.optimizePluginMemory === true
                && manifestState.valid
                && manifestState.manifest?.generation === generation
                ? manifestState.manifest
                : null;
            const legacyPublication = !generation
                && dbObj?.optimizePluginMemory === true
                && !manifestState.present;
            if (
                (!activeManifest && !legacyPublication)
                || (pinnedState && (
                    pinnedState.optimized !== true
                    || pinnedState.generation !== generation
                ))
            ) {
                throw pluginStorageNamespaceConflict(
                    'Plugin storage generation changed before clear committed',
                );
            }
            const nextManifest = activeManifest
                ? createPluginStorageManifest(generation, [], [])
                : null;
            const recoverySnapshotToken = newPluginRecoverySnapshotToken();
            sqliteDb.transaction(() => {
                kvDelPrefix(PLUGIN_SAVE_PREFIX);
                if (pluginStorageClearFailpoint === 'transaction') {
                    throw new Error('Injected plugin storage clear transaction failure');
                }
                kvDelPrefix(PLUGIN_SAVE_META_PREFIX);
                writePluginStorageManifest(nextManifest);
                markPluginRecoverySnapshotDirty(recoverySnapshotToken);
            })();
        });
    } catch (error) {
        if (isImportInProgressError(error)) return sendImportBusy(res);
        if (error?.pluginStorageNamespaceConflict) {
            return res.status(409).json({
                error: error.message,
                code: 'PLUGIN_STORAGE_GENERATION_CONFLICT',
                commitOutcome: 'not-committed',
                commitOutcomeUnknown: false,
            });
        }
        logger.error('[PluginStorage] Atomic clear rolled back:', error);
        return res.status(500).json({
            error: 'Plugin storage clear was not committed',
            code: 'PLUGIN_STORAGE_CLEAR_NOT_COMMITTED',
            retryAfter: 0,
            retryable: true,
            commitOutcome: 'not-committed',
            commitOutcomeUnknown: false,
        });
    }

    // This is a known commit even if the response is lost below.
    schedulePluginRecoverySnapshot();

    // A response lost after this point cannot prove whether the transaction
    // committed. The client labels that outcome unknown and may safely retry
    // because clearing this fixed namespace is idempotent.
    if (pluginStorageClearFailpoint === 'response') {
        res.destroy();
        return;
    }
    res.json({
        success: true,
        commitOutcome: 'committed',
        commitOutcomeUnknown: false,
    });
});

app.get('/api/inlays/references', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        const result = await queueStorageMutation(() => scanAuthoritativeInlayReferences());
        res.json(result);
    } catch (error) {
        if (isImportInProgressError(error)) return sendImportBusy(res);
        next(error);
    }
});

app.post('/api/inlays/delete-unreferenced', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    const request = validateInlayDeleteRequest(req.body);
    if (!request) {
        return res.status(400).json({
            success: false,
            error: `ids must contain 1-${MAX_INLAY_DELETE_BATCH} safe inlay IDs`,
            code: 'INVALID_INLAY_DELETE_REQUEST',
            commitOutcome: 'not-committed',
            commitOutcomeUnknown: false,
        });
    }
    try {
        const result = await queueStorageMutation(() => deleteUnreferencedInlays(
            request.ids,
            request.clientProtectedIds,
        ));
        res.json({
            success: true,
            ...result,
            commitOutcome: 'committed',
            commitOutcomeUnknown: false,
        });
    } catch (error) {
        if (isImportInProgressError(error)) return sendImportBusy(res);
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
            const { decodedKey: key } = decodeAndCanonicalizeHexPath(filePath);
            if (key === 'database/database.bin'
                || key === PLUGIN_STORAGE_MANIFEST_KEY
                || canonicalPluginStorageRowPrefix(key)) {
                try {
                    assertGenericPluginStorageMutationAllowed(
                        key,
                        await readLivePluginStoragePublication(),
                    );
                } catch (error) {
                    if (error?.pluginStorageNamespaceConflict) {
                        return res.status(409).json({ error: error.message });
                    }
                    throw error;
                }
            }
            if (key.startsWith('inlay/')) {
                const id = key.slice('inlay/'.length)
                if (!isSafeInlayId(id)) {
                    return res.status(400).json({ error: 'Invalid inlay ID' });
                }
                const result = await deleteUnreferencedInlays([id]);
                if (result.referencedIds.length > 0) {
                    return res.status(409).json({
                        success: false,
                        error: 'The inlay is still referenced by a stored chat message',
                        code: 'INLAY_REFERENCED',
                        referencedIds: result.referencedIds,
                        commitOutcome: 'not-committed',
                        commitOutcomeUnknown: false,
                    });
                }
                return res.send({ success: true });
            }
            if (key.startsWith('inlay_info/')) {
                const id = key.slice('inlay_info/'.length);
                const scan = await scanAuthoritativeInlayReferences();
                if ((scan.refCounts[id] ?? 0) > 0) {
                    return res.status(409).json({
                        success: false,
                        error: 'The inlay is still referenced by a stored chat message',
                        code: 'INLAY_REFERENCED',
                        commitOutcome: 'not-committed',
                        commitOutcomeUnknown: false,
                    });
                }
                await fs.unlink(getInlaySidecarPath(id)).catch(() => {});
            }
            if (key.startsWith('inlay_meta/')) {
                const id = key.slice('inlay_meta/'.length);
                const scan = await scanAuthoritativeInlayReferences();
                if ((scan.refCounts[id] ?? 0) > 0) {
                    return res.status(409).json({
                        success: false,
                        error: 'The inlay is still referenced by a stored chat message',
                        code: 'INLAY_REFERENCED',
                        commitOutcome: 'not-committed',
                        commitOutcomeUnknown: false,
                    });
                }
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

const PLUGIN_STORAGE_JSON_CONTENT_TYPE = 'application/json';
const PLUGIN_STORAGE_LOSSLESS_CONTENT_TYPE = 'application/octet-stream';

async function readAuthoritativePluginStorageState(req, valueKey, requestedGeneration) {
    const ownerKey = `${PLUGIN_SAVE_META_PREFIX}${valueKey.slice(PLUGIN_SAVE_PREFIX.length)}`;
    return await queueStorageReadAfterImports(async () => {
        const publication = await readLivePluginStoragePublication();
        const { dbObj, generation, manifestState } = publication;
        const pinnedState = sessionPluginStorageReadState(req);
        const expectedState = requestedGeneration !== undefined
            ? { optimized: true, generation: requestedGeneration }
            : pinnedState;
        const activeManifest = generation
            && dbObj?.optimizePluginMemory === true
            && manifestState.valid
            && manifestState.manifest?.generation === generation
            ? manifestState.manifest
            : null;
        const legacyPublication = !generation
            && dbObj?.optimizePluginMemory === true
            && !manifestState.present;

        if (!expectedState) {
            if (activeManifest || legacyPublication) {
                throw pluginStorageNamespaceConflict(
                    'Read database.bin before reading authoritative plugin storage state',
                );
            }
            return {
                state: await readPluginStorageState(valueKey, ownerKey),
                publicationGeneration: null,
                publicationRevision: null,
            };
        }
        if (
            expectedState.optimized !== (dbObj?.optimizePluginMemory === true)
            || expectedState.generation !== generation
            || (requestedGeneration !== undefined && pinnedState && (
                pinnedState.optimized !== true
                || pinnedState.generation !== requestedGeneration
            ))
        ) {
            throw pluginStorageNamespaceConflict(
                'Plugin storage generation changed before the state could be read',
            );
        }
        if (generation) {
            if (!activeManifest) {
                throw pluginStorageNamespaceConflict(
                    'The selected plugin storage generation has no matching manifest',
                );
            }
            if (isHashedPluginSaveStorageKey(valueKey, PLUGIN_SAVE_PREFIX)
                && (activeManifest.valueKeys.includes(valueKey)
                    || activeManifest.metaKeys.includes(ownerKey))) {
                decodeManifestPluginSaveStorageKey(
                    activeManifest,
                    valueKey,
                    PLUGIN_SAVE_PREFIX,
                );
            }
            const [valueBytes, ownerBytes] = await Promise.all([
                activeManifest.valueKeys.includes(valueKey)
                    ? kvGetAsync(valueKey)
                    : null,
                activeManifest.metaKeys.includes(ownerKey)
                    ? kvGetAsync(ownerKey)
                    : null,
            ]);
            const owner = parsePluginStorageOwnerRecord(ownerBytes);
            return {
                state: {
                    valueBytes,
                    ownerBytes,
                    revision: pluginStorageRevision(valueBytes, ownerBytes),
                    generation: valueBytes !== null
                        && isCanonicalPluginStorageOwnerRecord(owner, ownerBytes)
                        ? owner.generation
                        : null,
                },
                publicationGeneration: generation,
                publicationRevision: manifestState.revision,
            };
        }
        if (!legacyPublication) {
            throw pluginStorageNamespaceConflict(
                'The legacy plugin storage publication changed before the state could be read',
            );
        }
        return {
            state: await readPluginStorageState(valueKey, ownerKey),
            publicationGeneration: null,
            publicationRevision: null,
        };
    });
}

function handlePluginStorageStateRead({ binary }) {
    return async (req, res, next) => {
        if (!await checkAuth(req, res)) return;
        const firstHeader = (value) => Array.isArray(value) ? value[0] : value;
        const filePath = firstHeader(req.headers['file-path']);
        const requestedGeneration = firstHeader(req.headers['x-plugin-storage-generation']);
        if (typeof filePath !== 'string' || !isHex(filePath)) {
            return res.status(400).json({
                success: false,
                error: 'A valid value row path is required.',
                code: 'INVALID_PLUGIN_STORAGE_STATE_READ',
            });
        }
        if (requestedGeneration !== undefined
            && (typeof requestedGeneration !== 'string' || requestedGeneration.length === 0)) {
            return res.status(400).json({
                success: false,
                error: 'Plugin storage generation must be a non-empty string.',
                code: 'INVALID_PLUGIN_STORAGE_STATE_READ',
            });
        }

        if (pluginStorageStateFailpoint === 'read') {
            res.setHeader('Retry-After', '0');
            return res.status(503).json({
                success: false,
                error: 'Injected plugin storage state read failure.',
                code: 'TEMPORARY_STORAGE_FAILURE',
                retryAfter: 0,
                retryable: true,
            });
        }

        try {
            const { decodedKey: valueKey } = decodeAndCanonicalizeHexPath(filePath);
            if (isHashedPluginSaveStorageKey(valueKey, PLUGIN_SAVE_PREFIX)) {
                assertArchiveSafePluginSaveStorageKey(valueKey);
            } else {
                decodePluginSaveStorageKey(valueKey, PLUGIN_SAVE_PREFIX);
            }
            const publication = await readAuthoritativePluginStorageState(
                req,
                valueKey,
                requestedGeneration,
            );
            const { state } = publication;
            if (publication.publicationGeneration !== null) {
                res.setHeader(
                    'x-plugin-storage-publication-generation',
                    publication.publicationGeneration,
                );
            }
            if (publication.publicationRevision !== null) {
                res.setHeader(
                    'x-plugin-storage-publication-revision',
                    publication.publicationRevision,
                );
            }
            if (binary) {
                res.setHeader(
                    'x-plugin-storage-missing',
                    state.valueBytes === null ? '1' : '0',
                );
                if (state.valueBytes === null) return res.status(204).end();

                const codec = pluginStorageCodecForBuffer(state.valueBytes);
                res.setHeader(
                    'Content-Type',
                    codec === PLUGIN_STORAGE_LOSSLESS_CODEC
                        ? PLUGIN_STORAGE_LOSSLESS_CONTENT_TYPE
                        : PLUGIN_STORAGE_JSON_CONTENT_TYPE,
                );
                res.setHeader('Content-Length', String(state.valueBytes.byteLength));
                res.setHeader('x-plugin-storage-codec', codec);
                res.setHeader(
                    'x-plugin-storage-byte-length',
                    String(state.valueBytes.byteLength),
                );
                res.setHeader(
                    'x-plugin-storage-content-digest',
                    `sha256:${sha256Hex(state.valueBytes)}`,
                );
                res.setHeader('x-plugin-storage-row-revision', state.revision);
                if (state.generation !== null) {
                    res.setHeader('x-plugin-storage-row-generation', state.generation);
                }
                return res.status(200).end(state.valueBytes);
            }
            return res.json({
                success: true,
                missing: state.valueBytes === null,
                value: state.valueBytes?.toString('base64'),
                revision: state.revision,
                generation: state.generation,
            });
        } catch (error) {
            if (error?.pluginStorageNamespaceConflict) {
                return res.status(409).json({
                    success: false,
                    error: error.message,
                    code: 'PLUGIN_STORAGE_GENERATION_CONFLICT',
                });
            }
            if (error instanceof RangeError || error?.message?.includes('plugin storage key')) {
                return res.status(400).json({
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                    code: 'INVALID_PLUGIN_STORAGE_STATE_READ',
                });
            }
            next(error);
        }
    };
}

/** Retained byte-compatible JSON/base64 read for stale-client recovery. */
app.get('/api/plugin-storage/state', handlePluginStorageStateRead({ binary: false }));
/** Current client read: exact stored row bytes with extensible codec/identity headers. */
app.get('/api/plugin-storage/state/raw', handlePluginStorageStateRead({ binary: true }));

// Lightweight capacity preflight for operations that temporarily need both
// the external plugin rows and a newly-expanded database blob on the save
// volume. Unlike /api/db/stats this does not scan repository contents.
app.get('/api/storage/capacity', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        await importBarrier.waitUntilIdle();
        if (HUB_HOSTING_MODE) return res.send({ success: true, freeBytes: null });
        const capacity = await checkDiskSpace(0);
        res.send({
            success: true,
            freeBytes: Number.isSafeInteger(capacity.available) && capacity.available >= 0
                ? capacity.available
                : null,
        });
    } catch (error) {
        next(error);
    }
});

/**
 * Read the active publication manifest and its physically present row set in
 * one generation-bound snapshot. Clients use this instead of issuing two list
 * requests plus a separate manifest read for every batch or enumeration.
 */
// Quota usage counts physical JSON bytes (including quarantined rows), while
// the viewer reports UTF-8 bytes of each decoded logical value. Cache that
// exact aggregate until a low-level plugin-value mutation invalidates it.
let pluginStorageViewerTotalSizeCache = null;
const PLUGIN_STORAGE_VIEWER_SNAPSHOT_CAP = process.env.NODE_ENV === 'test'
    ? Math.max(1, Math.min(8, Number.parseInt(
        process.env.POCKETRISU_TEST_PLUGIN_VIEWER_SNAPSHOT_CAP ?? '2',
        10,
    ) || 2))
    : 2;
let pluginStorageViewerActiveSnapshots = 0;
let pluginStorageViewerMaxActiveSnapshots = 0;
const pluginStorageViewerSnapshotWaiters = [];
const pluginStorageViewerBackfills = new Map();
const pluginStorageViewerTestCounters = {
    backfillPasses: 0,
    pageValueReuses: 0,
};

async function reportPluginStorageViewerSnapshotState() {
    if (!pluginStorageViewerTestGateDir) return;
    await reportPluginStorageViewerTestProgress({
        active: pluginStorageViewerActiveSnapshots,
        queued: pluginStorageViewerSnapshotWaiters.length,
        maxActive: pluginStorageViewerMaxActiveSnapshots,
        cap: PLUGIN_STORAGE_VIEWER_SNAPSHOT_CAP,
        ...pluginStorageViewerTestCounters,
    }, 'snapshot-state.json');
}

function releasePluginStorageViewerSnapshotSlot() {
    pluginStorageViewerActiveSnapshots = Math.max(0, pluginStorageViewerActiveSnapshots - 1);
    while (pluginStorageViewerSnapshotWaiters.length > 0) {
        const waiter = pluginStorageViewerSnapshotWaiters.shift();
        if (waiter.signal?.aborted) continue;
        waiter.signal?.removeEventListener('abort', waiter.onAbort);
        pluginStorageViewerActiveSnapshots += 1;
        pluginStorageViewerMaxActiveSnapshots = Math.max(
            pluginStorageViewerMaxActiveSnapshots,
            pluginStorageViewerActiveSnapshots,
        );
        waiter.resolve(releasePluginStorageViewerSnapshotSlot);
        break;
    }
    reportPluginStorageViewerSnapshotState().catch(() => {});
}

function acquirePluginStorageViewerSnapshotSlot(signal) {
    throwIfSignalAborted(signal);
    if (pluginStorageViewerActiveSnapshots < PLUGIN_STORAGE_VIEWER_SNAPSHOT_CAP) {
        pluginStorageViewerActiveSnapshots += 1;
        pluginStorageViewerMaxActiveSnapshots = Math.max(
            pluginStorageViewerMaxActiveSnapshots,
            pluginStorageViewerActiveSnapshots,
        );
        reportPluginStorageViewerSnapshotState().catch(() => {});
        return Promise.resolve(releasePluginStorageViewerSnapshotSlot);
    }
    return new Promise((resolve, reject) => {
        const waiter = {
            signal,
            resolve,
            reject,
            onAbort: null,
        };
        waiter.onAbort = () => {
            const index = pluginStorageViewerSnapshotWaiters.indexOf(waiter);
            if (index >= 0) pluginStorageViewerSnapshotWaiters.splice(index, 1);
            reject(signal.reason instanceof Error
                ? signal.reason
                : new DOMException('Plugin storage viewer cancelled', 'AbortError'));
            reportPluginStorageViewerSnapshotState().catch(() => {});
        };
        signal?.addEventListener('abort', waiter.onAbort, { once: true });
        pluginStorageViewerSnapshotWaiters.push(waiter);
        reportPluginStorageViewerSnapshotState().catch(() => {});
    });
}

async function waitAtPluginStorageViewerSnapshotTestGate(isClosed) {
    if (!pluginStorageViewerTestGateDir) return;
    const holdPath = path.join(pluginStorageViewerTestGateDir, 'snapshot-hold');
    if (!existsSync(holdPath)) return;
    await fs.mkdir(pluginStorageViewerTestGateDir, { recursive: true });
    await fs.writeFile(
        path.join(pluginStorageViewerTestGateDir, 'snapshot-entered'),
        'snapshot-pinned',
        'utf-8',
    );
    await reportPluginStorageViewerSnapshotState();
    const releasePath = path.join(pluginStorageViewerTestGateDir, 'snapshot-release');
    while (!isClosed() && existsSync(holdPath) && !existsSync(releasePath)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

function closePluginStorageViewerContext(context) {
    if (!context || context.closed) return;
    context.closed = true;
    context.snapshot?.close();
    context.releaseSnapshotSlot?.();
}

function pluginStorageViewerParseOne(metrics, operation) {
    metrics.activeRowParses += 1;
    metrics.maxRowParses = Math.max(metrics.maxRowParses, metrics.activeRowParses);
    try {
        return operation();
    } finally {
        metrics.activeRowParses -= 1;
    }
}

function pluginStorageViewerOwner(record) {
    return record
        && typeof record.plugin === 'string'
        && record.plugin.length > 0
        && record.plugin.isWellFormed()
        ? record.plugin
        : null;
}

function selectPluginStorageViewerRows(context, options, ownerByStorageKey = null) {
    const normalizedQuery = options.keyQuery.toLowerCase();
    const keyMatchedValues = context.authoritativeValues
        .filter(({ key }) => !normalizedQuery || key.toLowerCase().includes(normalizedQuery))
        .sort((left, right) => comparePluginStorageRecordKeys(left.key, right.key));
    const candidateOwnerStorageKeys = keyMatchedValues
        .map(({ key }) => encodePluginSaveStorageKey(key, PLUGIN_SAVE_META_PREFIX))
        .filter((storageKey) => (
            context.manifestMeta.has(storageKey) && context.physicalMeta.has(storageKey)
        ));
    let ownerFacets;
    let matchingOwnerStorageKeys = null;
    if (ownerByStorageKey) {
        const counts = new Map();
        for (const storageKey of candidateOwnerStorageKeys) {
            const owner = ownerByStorageKey.get(storageKey);
            if (owner !== undefined) counts.set(owner, (counts.get(owner) ?? 0) + 1);
        }
        ownerFacets = [...counts]
            .map(([owner, count]) => ({ owner, count }))
            .sort((left, right) => left.owner < right.owner ? -1 : left.owner > right.owner ? 1 : 0);
        if (options.ownerQueryValue !== undefined || options.unknownOwner) {
            matchingOwnerStorageKeys = new Set(candidateOwnerStorageKeys.filter((storageKey) => {
                const owner = ownerByStorageKey.get(storageKey);
                return options.ownerQueryValue !== undefined
                    ? owner === options.ownerQuery
                    : owner !== undefined;
            }));
        }
    } else {
        ownerFacets = context.snapshot.viewerOwnerFacets(candidateOwnerStorageKeys)
            .sort((left, right) => left.owner < right.owner ? -1 : left.owner > right.owner ? 1 : 0);
        if (options.ownerQueryValue !== undefined || options.unknownOwner) {
            matchingOwnerStorageKeys = new Set(context.snapshot.viewerOwnerKeys(
                candidateOwnerStorageKeys,
                options.ownerQueryValue !== undefined ? options.ownerQuery : null,
            ));
        }
    }
    const knownOwnerCount = ownerFacets.reduce((sum, facet) => sum + facet.count, 0);
    const unknownOwnerCount = keyMatchedValues.length - knownOwnerCount;
    const ownedValues = keyMatchedValues.filter(({ key }) => {
        const ownerStorageKey = encodePluginSaveStorageKey(key, PLUGIN_SAVE_META_PREFIX);
        if (options.unknownOwner) return !matchingOwnerStorageKeys.has(ownerStorageKey);
        if (options.ownerQueryValue !== undefined) {
            return matchingOwnerStorageKeys.has(ownerStorageKey);
        }
        return true;
    });
    const total = ownedValues.length;
    const pageCount = Math.max(1, Math.ceil(total / options.pageSize));
    const boundedPage = Math.min(options.page, pageCount - 1);
    const pageRows = ownedValues.slice(
        boundedPage * options.pageSize,
        Math.min(total, (boundedPage + 1) * options.pageSize),
    );
    return {
        ownerFacets,
        unknownOwnerCount,
        ownerFacetTotal: keyMatchedValues.length,
        total,
        pageCount,
        boundedPage,
        pageRows,
    };
}

function pluginStorageViewerEntry(context, descriptor, valueBytes, value, ownerBytes) {
    const ownerRecord = ownerBytes === null
        ? null
        : pluginStorageViewerParseOne(
            context.metrics,
            () => parsePluginStorageOwnerRecord(ownerBytes),
        );
    const owner = pluginStorageViewerOwner(ownerRecord);
    const text = pluginStorageViewerValueText(value);
    const valueType = value === null
        ? 'object'
        : value === undefined || text === ''
            ? 'empty'
            : Array.isArray(value)
                ? 'array'
                : typeof value;
    const codec = pluginStorageCodecForBuffer(valueBytes);
    const editor = codec === PLUGIN_STORAGE_JSON_CODEC
        ? {
            codec,
            kind: typeof value === 'string' ? 'string' : 'json',
            // JSON-v1 is already the canonical faithful representation. The
            // display text deliberately remains unchanged for facets/search.
            text: typeof value === 'string'
                ? JSON.stringify(value)
                : value === null ? 'null' : text,
        }
        : { codec, kind: 'readonly', text: null };
    const revision = pluginStorageRevision(valueBytes, ownerBytes);
    const size = Buffer.byteLength(text, 'utf-8');
    const contentHash = `sha256:${sha256Hex(Buffer.from(JSON.stringify([
        descriptor.key,
        owner,
        text,
        size,
        valueType,
        editor.codec,
        editor.kind,
        editor.text,
        revision,
    ]), 'utf-8'))}`;
    return {
        event: 'entry',
        key: descriptor.key,
        owner,
        text,
        size,
        valueType,
        editor,
        revision,
        contentHash,
    };
}

async function assemblePluginStorageViewerEntries(
    context,
    pageRows,
    isClosed,
    reusedValues = new Map(),
) {
    const entries = [];
    for (const descriptor of pageRows) {
        await new Promise((resolve) => setImmediate(resolve));
        throwIfSignalAborted(context.signal);
        if (isClosed()) throw context.signal.reason;
        let retained = reusedValues.get(descriptor.storageKey);
        if (!retained) {
            const valueBytes = context.snapshot.kvGet(descriptor.storageKey);
            context.metrics.valueReads += 1;
            if (valueBytes === null) {
                throw pluginStorageNamespaceConflict(
                    'A plugin storage viewer row disappeared from its pinned snapshot',
                );
            }
            retained = {
                valueBytes,
                value: pluginStorageViewerParseOne(
                    context.metrics,
                    () => validatePluginStorageRow(descriptor.storageKey, valueBytes),
                ),
            };
        }
        const ownerStorageKey = encodePluginSaveStorageKey(
            descriptor.key,
            PLUGIN_SAVE_META_PREFIX,
        );
        let ownerBytes = null;
        if (context.manifestMeta.has(ownerStorageKey)
            && context.physicalMeta.has(ownerStorageKey)) {
            ownerBytes = context.snapshot.kvGet(ownerStorageKey);
            context.metrics.ownerReads += 1;
        }
        entries.push(pluginStorageViewerEntry(
            context,
            descriptor,
            retained.valueBytes,
            retained.value,
            ownerBytes,
        ));
        await reportPluginStorageViewerTestProgress(context.metrics);
    }
    return entries;
}

function finalizePluginStorageViewerAssembly(context, options, selection, totalBytes, entries) {
    const pageTokenEntries = entries.map((entry) => [entry.key, entry.contentHash]);
    const pageTokenMaterial = JSON.stringify([
        'pocketrisu-plugin-storage-viewer-page-v3',
        context.generation,
        context.manifestState.revision,
        context.databaseRevision,
        selection.boundedPage,
        options.pageSize,
        options.keyQuery,
        options.ownerQueryValue === undefined ? null : options.ownerQuery,
        options.unknownOwner,
        selection.ownerFacets.map((facet) => [facet.owner, facet.count]),
        selection.unknownOwnerCount,
        pageTokenEntries,
    ]);
    return {
        meta: {
            event: 'meta',
            version: 2,
            generation: context.generation,
            manifestRevision: context.manifestState.revision,
            databaseRevision: context.databaseRevision,
            page: selection.boundedPage,
            pageSize: options.pageSize,
            pageCount: selection.pageCount,
            total: selection.total,
            totalBytes,
            ownerFacets: selection.ownerFacets,
            unknownOwnerCount: selection.unknownOwnerCount,
            ownerFacetTotal: selection.ownerFacetTotal,
        },
        entries,
        done: {
            event: 'done',
            pageToken: `sha256:${sha256Hex(Buffer.from(pageTokenMaterial, 'utf-8'))}`,
            metrics: {
                manifestParses: context.metrics.manifestParses,
                valueReads: context.metrics.valueReads,
                sizeValueReads: context.metrics.sizeValueReads,
                ownerReads: context.metrics.ownerReads,
                maxRowParses: context.metrics.maxRowParses,
            },
        },
    };
}

async function pinPluginStorageViewerContext(req, requestedGeneration, signal, isClosed, metrics) {
    const releaseSnapshotSlot = await acquirePluginStorageViewerSnapshotSlot(signal);
    let snapshot = null;
    try {
        const pinned = await queueStorageReadAfterImports(async () => {
            await flushPendingDb();
            throwIfSignalAborted(signal);
            return {
                snapshot: createKvSnapshot(),
                mutationVersion: getPluginStorageMutationVersion(),
            };
        }, signal);
        snapshot = pinned.snapshot;
        await waitAtPluginStorageViewerSnapshotTestGate(isClosed);
        throwIfSignalAborted(signal);
        const rawDatabase = snapshot.kvGet('database/database.bin');
        const dbObj = rawDatabase ? await decodeAuthoritativeRisuSave(rawDatabase, {
            resolveRemote: async (name) => snapshot.kvGet(`remotes/${name}.local.bin`) || null,
        }) : null;
        const generation = pluginStorageGeneration(dbObj);
        const manifestState = readPluginStorageManifestState(snapshot.kvGet);
        metrics.manifestParses = 1;
        const pinnedState = sessionPluginStorageReadState(req);
        const activeManifest = generation
            && dbObj?.optimizePluginMemory === true
            && manifestState.valid
            && manifestState.manifest?.generation === generation
            ? manifestState.manifest
            : null;
        if (generation !== requestedGeneration
            || !activeManifest
            || (pinnedState && (
                pinnedState.optimized !== true
                || pinnedState.generation !== requestedGeneration
            ))) {
            throw pluginStorageNamespaceConflict(
                'Plugin storage generation changed before the viewer page could be read',
            );
        }
        const physicalValues = new Set(snapshot.kvList(PLUGIN_SAVE_PREFIX));
        const physicalMeta = new Set(snapshot.kvList(PLUGIN_SAVE_META_PREFIX));
        const authoritativeValues = activeManifest.valueKeys
            .filter((storageKey) => physicalValues.has(storageKey))
            .map((storageKey) => ({
                storageKey,
                key: decodeManifestPluginSaveStorageKey(
                    activeManifest,
                    storageKey,
                    PLUGIN_SAVE_PREFIX,
                ),
            }));
        return {
            snapshot,
            releaseSnapshotSlot,
            closed: false,
            signal,
            metrics,
            mutationVersion: pinned.mutationVersion,
            rawDatabase,
            databaseRevision: computeBufferEtag(rawDatabase),
            generation,
            manifestState,
            activeManifest,
            authoritativeValues,
            physicalMeta,
            manifestMeta: new Set(activeManifest.metaKeys),
            facetState: snapshot.viewerFacetState(),
        };
    } catch (error) {
        snapshot?.close();
        releaseSnapshotSlot();
        throw error;
    }
}

function pluginStorageViewerTotalCacheMatches(context) {
    const cached = pluginStorageViewerTotalSizeCache;
    return cached
        && cached.generation === context.generation
        && cached.manifestRevision === context.manifestState.revision
        && cached.mutationVersion === context.mutationVersion
        && cached.sourceRevision === context.facetState.sourceRevision;
}

async function assemblePluginStorageViewerFromFacets(context, options, isClosed) {
    if (!context.facetState.current) return null;
    const storageKeys = context.authoritativeValues.map((row) => row.storageKey);
    const summary = context.snapshot.viewerValueFacetSummary(storageKeys);
    if (summary.count !== storageKeys.length
        || !Number.isSafeInteger(summary.totalBytes)
        || summary.totalBytes < 0) return null;
    const totalBytes = pluginStorageViewerTotalCacheMatches(context)
        ? pluginStorageViewerTotalSizeCache.totalBytes
        : summary.totalBytes;
    if (!pluginStorageViewerTotalCacheMatches(context)) {
        pluginStorageViewerTotalSizeCache = {
            generation: context.generation,
            manifestRevision: context.manifestState.revision,
            mutationVersion: context.mutationVersion,
            sourceRevision: context.facetState.sourceRevision,
            totalBytes,
        };
    }
    const selection = selectPluginStorageViewerRows(context, options);
    const entries = await assemblePluginStorageViewerEntries(
        context,
        selection.pageRows,
        isClosed,
    );
    const pageFacets = new Map(context.snapshot.viewerValueFacets(
        selection.pageRows.map((row) => row.storageKey),
    ).map((facet) => [facet.storageKey, facet.displaySize]));
    if (entries.some((entry, index) => (
        pageFacets.get(selection.pageRows[index].storageKey) !== entry.size
    ))) return null;
    return finalizePluginStorageViewerAssembly(
        context,
        options,
        selection,
        totalBytes,
        entries,
    );
}

async function backfillPluginStorageViewerFacets(context, options, isClosed) {
    pluginStorageViewerTestCounters.backfillPasses += 1;
    await reportPluginStorageViewerSnapshotState();
    const ownerByStorageKey = new Map();
    const rebuiltOwners = [];
    for (const storageKey of context.activeManifest.metaKeys) {
        if (!context.physicalMeta.has(storageKey)) continue;
        await new Promise((resolve) => setImmediate(resolve));
        throwIfSignalAborted(context.signal);
        if (isClosed()) throw context.signal.reason;
        const bytes = context.snapshot.kvGet(storageKey);
        const owner = pluginStorageViewerOwner(parsePluginStorageOwnerRecord(bytes));
        if (owner !== null) {
            ownerByStorageKey.set(storageKey, owner);
            rebuiltOwners.push({ storageKey, owner });
        }
    }
    const selection = selectPluginStorageViewerRows(context, options, ownerByStorageKey);
    const pageKeys = new Set(selection.pageRows.map((row) => row.storageKey));
    const reusedValues = new Map();
    const rebuiltValues = [];
    let totalBytes = 0;
    for (const descriptor of context.authoritativeValues) {
        await new Promise((resolve) => setImmediate(resolve));
        throwIfSignalAborted(context.signal);
        if (isClosed()) throw context.signal.reason;
        const valueBytes = context.snapshot.kvGet(descriptor.storageKey);
        context.metrics.sizeValueReads += 1;
        if (valueBytes === null) {
            throw pluginStorageNamespaceConflict(
                'A plugin storage viewer size row disappeared from its pinned snapshot',
            );
        }
        const value = pluginStorageViewerParseOne(
            context.metrics,
            () => validatePluginStorageRow(descriptor.storageKey, valueBytes),
        );
        const displaySize = pluginStorageViewerDisplaySize(value);
        totalBytes += displaySize;
        if (!Number.isSafeInteger(totalBytes)) {
            throw new RangeError('Plugin storage viewer total size exceeds the safe integer range');
        }
        rebuiltValues.push({ storageKey: descriptor.storageKey, displaySize });
        if (pageKeys.has(descriptor.storageKey)) {
            reusedValues.set(descriptor.storageKey, { valueBytes, value });
            context.metrics.valueReads += 1;
            pluginStorageViewerTestCounters.pageValueReuses += 1;
        }
    }
    let publication = null;
    try {
        publication = rebuildPluginStorageViewerFacets(
            context.facetState.sourceRevision,
            rebuiltValues,
            rebuiltOwners,
        );
    } catch (error) {
        logger.warn('[PluginStorage] Viewer facet rebuild was not published:', error);
    }
    if (publication?.published
        && getPluginStorageMutationVersion() === context.mutationVersion) {
        pluginStorageViewerTotalSizeCache = {
            generation: context.generation,
            manifestRevision: context.manifestState.revision,
            mutationVersion: context.mutationVersion,
            sourceRevision: publication.state.sourceRevision,
            totalBytes,
        };
    }
    const entries = await assemblePluginStorageViewerEntries(
        context,
        selection.pageRows,
        isClosed,
        reusedValues,
    );
    await reportPluginStorageViewerSnapshotState();
    return finalizePluginStorageViewerAssembly(
        context,
        options,
        selection,
        totalBytes,
        entries,
    );
}

async function handlePluginStorageViewerPage(req, res, next) {
    if (!await checkAuth(req, res)) return;
    const firstHeader = (value) => Array.isArray(value) ? value[0] : value;
    const requestedGeneration = firstHeader(req.headers['x-plugin-storage-generation']);
    const pageText = Array.isArray(req.query.page) ? req.query.page[0] : req.query.page;
    const pageSizeText = Array.isArray(req.query.pageSize)
        ? req.query.pageSize[0]
        : req.query.pageSize;
    const keyQueryValue = Array.isArray(req.query.key) ? req.query.key[0] : req.query.key;
    const ownerQueryValue = Array.isArray(req.query.owner) ? req.query.owner[0] : req.query.owner;
    const unknownOwnerValue = Array.isArray(req.query.unknownOwner)
        ? req.query.unknownOwner[0]
        : req.query.unknownOwner;
    const page = pageText === undefined || pageText === '' ? 0 : Number(pageText);
    const pageSize = pageSizeText === undefined || pageSizeText === '' ? 50 : Number(pageSizeText);
    const keyQuery = keyQueryValue === undefined ? '' : String(keyQueryValue).trim();
    const ownerQuery = ownerQueryValue === undefined ? '' : String(ownerQueryValue);
    const unknownOwner = unknownOwnerValue === '1';
    if (typeof requestedGeneration !== 'string' || requestedGeneration.length === 0
        || !Number.isSafeInteger(page) || page < 0
        || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50
        || keyQuery.length > 1024 || !keyQuery.isWellFormed()
        || ownerQuery.length > 1024 || !ownerQuery.isWellFormed()
        || (ownerQueryValue !== undefined && ownerQuery.length === 0)
        || (unknownOwnerValue !== undefined && unknownOwnerValue !== '1')
        || (unknownOwner && ownerQueryValue !== undefined)) {
        return res.status(400).json({
            success: false,
            error: 'Plugin storage viewer requires a generation, a non-negative page, and a page size from 1 to 50.',
            code: 'INVALID_PLUGIN_STORAGE_VIEWER_PAGE',
        });
    }

    const options = {
        page,
        pageSize,
        keyQuery,
        ownerQuery,
        ownerQueryValue,
        unknownOwner,
    };
    const metrics = {
        manifestParses: 0,
        valueReads: 0,
        sizeValueReads: 0,
        ownerReads: 0,
        maxRowParses: 0,
        activeRowParses: 0,
    };
    let context = null;
    let completed = false;
    let closed = false;
    const requestAbort = new AbortController();
    const isClosed = () => closed || req.aborted || res.destroyed;
    const onClose = () => {
        if (!completed) {
            closed = true;
            requestAbort.abort(new DOMException('Plugin storage viewer closed', 'AbortError'));
        }
    };
    req.once('aborted', onClose);
    res.once('close', onClose);
    try {
        let assembly = null;
        for (let attempt = 0; attempt < 4 && !assembly; attempt++) {
            context = await pinPluginStorageViewerContext(
                req,
                requestedGeneration,
                requestAbort.signal,
                isClosed,
                metrics,
            );
            assembly = await assemblePluginStorageViewerFromFacets(
                context,
                options,
                isClosed,
            );
            if (assembly) {
                closePluginStorageViewerContext(context);
                context = null;
                break;
            }

            const backfillKey = JSON.stringify([
                context.generation,
                context.manifestState.revision,
                context.databaseRevision,
                context.facetState.sourceRevision,
                context.mutationVersion,
            ]);
            const existing = pluginStorageViewerBackfills.get(backfillKey);
            if (existing) {
                closePluginStorageViewerContext(context);
                context = null;
                try {
                    await existing;
                } catch (error) {
                    if (isClosed()) return;
                    if (attempt === 3) throw error;
                }
                continue;
            }

            const backfillContext = context;
            context = null;
            const backfill = backfillPluginStorageViewerFacets(
                backfillContext,
                options,
                isClosed,
            ).finally(() => {
                closePluginStorageViewerContext(backfillContext);
                if (pluginStorageViewerBackfills.get(backfillKey) === backfill) {
                    pluginStorageViewerBackfills.delete(backfillKey);
                }
            });
            pluginStorageViewerBackfills.set(backfillKey, backfill);
            assembly = await backfill;
        }
        if (!assembly) {
            throw new Error('Plugin storage viewer facets could not be verified');
        }
        if (isClosed()) return;

        res.status(200);
        res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.setHeader('x-accel-buffering', 'no');
        res.flushHeaders();
        if (!await writeWithBackpressure(
            res,
            `${JSON.stringify(assembly.meta)}\n`,
            isClosed,
        )) return;

        await waitAtPluginStorageViewerTestGate(isClosed);
        for (const entry of assembly.entries) {
            if (isClosed()) return;
            if (!await writeWithBackpressure(
                res,
                `${JSON.stringify(entry)}\n`,
                isClosed,
                () => reportPluginStorageViewerTestProgress(
                    metrics,
                    'backpressure.json',
                ),
            )) return;
        }
        if (isClosed()) return;
        if (!await writeWithBackpressure(
            res,
            `${JSON.stringify(assembly.done)}\n`,
            isClosed,
        )) return;
        completed = true;
        res.end();
    } catch (error) {
        if (isClosed()) return;
        if (error?.pluginStorageNamespaceConflict && !res.headersSent) {
            return res.status(409).json({
                success: false,
                error: error.message,
                code: 'PLUGIN_STORAGE_GENERATION_CONFLICT',
            });
        }
        if (res.headersSent) {
            try {
                res.write(`${JSON.stringify({
                    event: 'error',
                    message: error instanceof Error ? error.message : String(error),
                })}\n`);
                res.end();
            } catch {}
            return;
        }
        next(error);
    } finally {
        req.removeListener('aborted', onClose);
        res.removeListener('close', onClose);
        closePluginStorageViewerContext(context);
        if (pluginStorageViewerTestGateDir) {
            try {
                // Temp-then-rename: this write races the test's read (the
                // response has already ended), so the file must never be
                // observable half-written.
                const gateResultPath = path.join(pluginStorageViewerTestGateDir, 'result.json');
                await fs.writeFile(
                    `${gateResultPath}.tmp`,
                    JSON.stringify({
                        manifestParses: metrics.manifestParses,
                        valueReads: metrics.valueReads,
                        sizeValueReads: metrics.sizeValueReads,
                        ownerReads: metrics.ownerReads,
                        maxRowParses: metrics.maxRowParses,
                        ...pluginStorageViewerTestCounters,
                        aborted: !completed,
                    }),
                    'utf-8',
                );
                await fs.rename(`${gateResultPath}.tmp`, gateResultPath);
            } catch {}
        }
    }
}

app.get('/api/plugin-storage/viewer-page', handlePluginStorageViewerPage);

app.get('/api/plugin-storage/manifest', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    const firstHeader = (value) => Array.isArray(value) ? value[0] : value;
    const requestedGeneration = firstHeader(req.headers['x-plugin-storage-generation']);
    const requestedMode = firstHeader(req.headers['x-plugin-storage-manifest-mode']) ?? 'snapshot';
    if (requestedGeneration !== undefined
        && (typeof requestedGeneration !== 'string' || requestedGeneration.length === 0)) {
        return res.status(400).json({
            success: false,
            error: 'Plugin storage generation must be a non-empty string.',
            code: 'INVALID_PLUGIN_STORAGE_MANIFEST_READ',
        });
    }
    if (requestedMode !== 'snapshot' && requestedMode !== 'state') {
        return res.status(400).json({
            success: false,
            error: 'Plugin storage manifest mode must be snapshot or state.',
            code: 'INVALID_PLUGIN_STORAGE_MANIFEST_READ',
        });
    }
    if (requestedMode === 'state') {
        res.set('Cache-Control', 'no-store');
    }

    try {
        const snapshot = await queueStorageReadAfterImports(async () => {
            const publication = await readLivePluginStoragePublication();
            const { dbObj, generation, manifestState } = publication;
            const pinnedState = sessionPluginStorageReadState(req);
            const expectedState = requestedGeneration !== undefined
                ? { optimized: true, generation: requestedGeneration }
                : pinnedState;
            const activeManifest = generation
                && dbObj?.optimizePluginMemory === true
                && manifestState.valid
                && manifestState.manifest?.generation === generation
                ? manifestState.manifest
                : null;
            if (!expectedState
                || expectedState.optimized !== true
                || expectedState.generation !== generation
                || !activeManifest
                || (requestedGeneration !== undefined && pinnedState && (
                    pinnedState.optimized !== true
                    || pinnedState.generation !== requestedGeneration
                ))) {
                throw pluginStorageNamespaceConflict(
                    'Plugin storage generation changed before the manifest could be read',
                );
            }

            const manifestRevision = manifestState.revision;
            if (requestedMode === 'state') {
                return { generation, manifestRevision };
            }
            const physicalValues = new Set(kvList(PLUGIN_SAVE_PREFIX));
            const physicalMeta = new Set(kvList(PLUGIN_SAVE_META_PREFIX));
            return {
                generation,
                manifestRevision,
                manifest: activeManifest,
                valueKeys: activeManifest.valueKeys.filter(key => physicalValues.has(key)),
                metaKeys: activeManifest.metaKeys.filter(key => physicalMeta.has(key)),
            };
        });
        return res.json({ success: true, ...snapshot });
    } catch (error) {
        if (error?.pluginStorageNamespaceConflict) {
            return res.status(409).json({
                success: false,
                error: error.message,
                code: 'PLUGIN_STORAGE_GENERATION_CONFLICT',
            });
        }
        next(error);
    }
});

app.post('/api/plugin-storage/reconcile-boot', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    const expectedEtag = req.headers['x-if-match'];
    if (typeof expectedEtag !== 'string' || !/^[0-9a-f]{32}$/.test(expectedEtag)) {
        return res.status(400).json({
            success: false,
            commitOutcome: 'not-committed',
            commitOutcomeUnknown: false,
            code: 'INVALID_DATABASE_ETAG',
            error: 'Optimized plugin storage boot reconciliation requires a database ETag.',
            retryable: false,
        });
    }
    try {
        const result = await reconcileOptimizedPluginStorageForBoot(req, expectedEtag);
        return res.json({
            success: true,
            commitOutcome: 'committed',
            commitOutcomeUnknown: false,
            ...result,
        });
    } catch (error) {
        if (error?.pluginStorageBootStatus === 409) {
            return res.status(409).json({
                success: false,
                commitOutcome: 'not-committed',
                commitOutcomeUnknown: false,
                code: 'PLUGIN_STORAGE_BOOT_CONFLICT',
                error: error.message,
                currentEtag: error.currentEtag ?? null,
                retryable: true,
            });
        }
        if (isImportInProgressError(error)) {
            res.setHeader('Retry-After', '5');
            return res.status(503).json({
                success: false,
                commitOutcome: 'not-committed',
                commitOutcomeUnknown: false,
                code: 'IMPORT_IN_PROGRESS',
                error: 'An import is in progress; retry reconciliation after it completes.',
                retryable: true,
            });
        }
        next(error);
    }
});

app.get('/api/plugin-storage/recovery', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        const inspection = await queueStorageReadAfterImports(
            () => inspectOptimizedPluginStorageRecoveryManagement(),
        );
        res.setHeader('Cache-Control', 'no-store');
        return res.json(publicOptimizedPluginStorageRecoveryManagementInspection(inspection));
    } catch (error) {
        next(error);
    }
});

app.get('/api/plugin-storage/recovery/download', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    const encodedKey = req.query.encodedKey;
    const token = req.query.token;
    if (typeof encodedKey !== 'string' || encodedKey.length === 0
        || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
        return res.status(400).json({
            success: false,
            code: 'INVALID_PLUGIN_STORAGE_RECOVERY_REQUEST',
            error: 'A recovery issue key and token are required.',
            retryable: false,
        });
    }
    if (!databaseSpoolReady) {
        return res.status(503).json({
            success: false,
            code: 'PLUGIN_STORAGE_RECOVERY_DOWNLOAD_UNAVAILABLE',
            error: 'The recovery download spool is unavailable.',
            retryable: true,
        });
    }

    const spoolPath = path.join(
        databaseSpoolDir,
        `${PLUGIN_RECOVERY_DOWNLOAD_SPOOL_FILE_PREFIX}${process.pid}-${nodeCrypto.randomUUID()}.bin`,
    );
    const requestAbort = new AbortController();
    const abortDownload = () => {
        if (!res.writableFinished && !requestAbort.signal.aborted) {
            requestAbort.abort(new DOMException(
                'Plugin storage recovery download closed',
                'AbortError',
            ));
        }
    };
    req.once('aborted', abortDownload);
    res.once('close', abortDownload);
    let prepared = null;
    try {
        prepared = await queueStorageReadAfterImports(async () => {
            const inspection = await inspectOptimizedPluginStorageRecoveryManagement();
            const issue = findOptimizedPluginStorageRecoveryManagementIssue(
                inspection,
                encodedKey,
                token,
            );
            if (!issue || !issue.externalAvailable) return null;
            const digest = nodeCrypto.createHash('sha256');
            const row = await kvWriteToFile(encodedKey, spoolPath, {
                signal: requestAbort.signal,
                onBytes: bytes => digest.update(bytes),
            });
            if (!row || row.size !== issue.externalSize
                || digest.digest('hex') !== issue.externalHash) {
                await fs.unlink(spoolPath).catch(() => {});
                return null;
            }
            await fs.chmod(spoolPath, 0o600);
            return {
                size: row.size,
                sha256: issue.externalHash,
                filename: `plugin-storage-recovery-${sha256Hex(Buffer.from(encodedKey, 'utf-8')).slice(0, 12)}.bin`,
            };
        }, requestAbort.signal);
        if (!prepared) {
            return res.status(409).json({
                success: false,
                code: 'PLUGIN_STORAGE_RECOVERY_STALE',
                error: 'The affected row changed; refresh recovery details before downloading it.',
                retryable: true,
            });
        }
        res.status(200);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(prepared.size));
        res.setHeader('Content-Disposition', `attachment; filename="${prepared.filename}"`);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Content-SHA256', prepared.sha256);
        await pipeline(createReadStream(spoolPath), res);
    } catch (error) {
        if (!res.headersSent) next(error);
        else if (!res.destroyed) res.destroy(error);
    } finally {
        req.removeListener('aborted', abortDownload);
        res.removeListener('close', abortDownload);
        await fs.unlink(spoolPath).catch(() => {});
    }
});

app.post('/api/plugin-storage/recovery/resolve', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    const writeRequest = captureActiveSessionWriteRequest(req);
    if (!checkActiveSessionWrite(writeRequest, res)) return;
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).length !== 3
        || Object.keys(body).some(key => !['encodedKey', 'token', 'action'].includes(key))
        || typeof body.encodedKey !== 'string' || body.encodedKey.length === 0
        || typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.token)
        || (body.action !== 'use-inline' && body.action !== 'delete')) {
        return res.status(400).json({
            success: false,
            commitOutcome: 'not-committed',
            commitOutcomeUnknown: false,
            code: 'INVALID_PLUGIN_STORAGE_RECOVERY_REQUEST',
            error: 'The recovery resolution request is invalid.',
            retryable: false,
        });
    }

    try {
        const result = await queueStorageMutation(async () => {
            const inspection = await inspectOptimizedPluginStorageRecoveryManagement();
            const issue = findOptimizedPluginStorageRecoveryManagementIssue(
                inspection,
                body.encodedKey,
                body.token,
            );
            if (!issue) return { stale: true };
            if ((body.action === 'use-inline' && !issue.canUseInline)
                || (body.action === 'delete' && !issue.canDelete)) {
                return { unavailable: true };
            }
            // Inspection yields; recheck the admitted writer after its last await.
            if (!checkActiveSessionWrite(writeRequest, res)) {
                return { sessionDeactivated: true };
            }
            try {
                resolveOptimizedPluginStorageRecoveryIssue(inspection, issue, body.action);
            } catch (error) {
                if (error?.pluginStorageRecoveryStale) return { stale: true };
                throw error;
            }
            return { committed: true };
        });
        if (result.sessionDeactivated) return;
        if (result.stale) {
            return res.status(409).json({
                success: false,
                commitOutcome: 'not-committed',
                commitOutcomeUnknown: false,
                code: 'PLUGIN_STORAGE_RECOVERY_STALE',
                error: 'The affected row changed; refresh recovery details before continuing.',
                retryable: true,
            });
        }
        if (result.unavailable) {
            return res.status(409).json({
                success: false,
                commitOutcome: 'not-committed',
                commitOutcomeUnknown: false,
                code: 'PLUGIN_STORAGE_RECOVERY_ACTION_UNAVAILABLE',
                error: 'That recovery action is no longer available.',
                retryable: true,
            });
        }
        return res.json({
            success: true,
            commitOutcome: 'committed',
            commitOutcomeUnknown: false,
            action: body.action,
            encodedKey: body.encodedKey,
        });
    } catch (error) {
        if (isImportInProgressError(error)) return sendImportBusy(res);
        logger.warn('[PluginStorageRecovery] Recovery action rolled back:', error);
        return res.status(500).json({
            success: false,
            commitOutcome: 'not-committed',
            commitOutcomeUnknown: false,
            code: 'PLUGIN_STORAGE_RECOVERY_ROLLED_BACK',
            error: 'The recovery action rolled back without changing plugin storage.',
            retryable: false,
        });
    }
});

function parsePluginStorageBatchEnvelope(body, { streamed = false } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).length !== 4
        || Object.keys(body).some(key => ![
            'version', 'generation', 'expectedManifest',
            'expectedManifestRevision', 'operations',
        ].includes(key))
        || (streamed ? body.version !== 3 : (body.version !== 1 && body.version !== 2))
        || typeof body.generation !== 'string'
        || body.generation.length === 0
        || !Array.isArray(body.operations)
        || body.operations.length < 1
        || body.operations.length > PLUGIN_STORAGE_BATCH_MAX_OPERATIONS) {
        throw new Error(`Plugin storage batch requires 1-${PLUGIN_STORAGE_BATCH_MAX_OPERATIONS} operations.`);
    }

    let expectedManifest;
    let expectedManifestRevision;
    if (body.version === 1 || (body.version === 3 && body.expectedManifest !== undefined)) {
        if (!body.expectedManifest || body.expectedManifestRevision !== undefined
            || typeof body.expectedManifest !== 'object'
            || Array.isArray(body.expectedManifest)
            || Object.keys(body.expectedManifest).length
                !== (body.expectedManifest.version === 3 ? 5 : 4)
            || Object.keys(body.expectedManifest).some(key => ![
                'version', 'generation', 'valueKeys', 'metaKeys', 'keyMappings',
            ].includes(key))) {
            throw new Error('Plugin storage batch requires an exact expectedManifest.');
        }
        expectedManifest = normalizePluginStorageManifestRequest(
            body.expectedManifest,
            'expectedManifest',
        );
        if (expectedManifest.generation !== body.generation
            || expectedManifest.valueKeys.length !== body.expectedManifest.valueKeys.length
            || expectedManifest.metaKeys.length !== body.expectedManifest.metaKeys.length
            || (expectedManifest.version === 3
                && expectedManifest.keyMappings.length
                    !== body.expectedManifest.keyMappings.length)) {
            throw new Error('Plugin storage batch expectedManifest is not canonical.');
        }
    } else {
        if (body.expectedManifest !== undefined
            || typeof body.expectedManifestRevision !== 'string'
            || !PLUGIN_STORAGE_REVISION_PATTERN.test(body.expectedManifestRevision)) {
            throw new Error('Plugin storage batch requires an exact manifest revision.');
        }
        expectedManifestRevision = body.expectedManifestRevision;
    }

    const seen = new Set();
    const operations = body.operations.map((input, index) => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
            throw new Error(`Plugin storage batch operation ${index} must be an object.`);
        }
        const allowed = streamed
            ? new Set([
                'operation', 'key', 'valueLength', 'valueHash',
                'owner', 'expectedRevision',
            ])
            : new Set(['operation', 'key', 'value', 'owner', 'expectedRevision']);
        if (Object.keys(input).some(key => !allowed.has(key))) {
            throw new Error(`Plugin storage batch operation ${index} has unsupported fields.`);
        }
        if (input.operation !== 'set' && input.operation !== 'remove') {
            throw new Error(`Plugin storage batch operation ${index} must be set or remove.`);
        }
        if (typeof input.key !== 'string') {
            throw new Error(`Plugin storage batch operation ${index} requires a string key.`);
        }
        const valueKey = encodePluginSaveStorageKey(input.key, PLUGIN_SAVE_PREFIX);
        const ownerKey = encodePluginSaveStorageKey(input.key, PLUGIN_SAVE_META_PREFIX);
        if (seen.has(valueKey)) throw new Error(`Duplicate plugin storage key at operation ${index}.`);
        seen.add(valueKey);

        const hasExpectedRevision = Object.prototype.hasOwnProperty.call(input, 'expectedRevision');
        if (hasExpectedRevision
            && input.expectedRevision !== null
            && (typeof input.expectedRevision !== 'string'
                || !PLUGIN_STORAGE_REVISION_PATTERN.test(input.expectedRevision))) {
            throw new Error(`Plugin storage operation ${index} has an invalid expectedRevision.`);
        }

        if (input.operation === 'remove') {
            if (Object.keys(input).some(key => ![
                'operation', 'key', 'expectedRevision',
            ].includes(key))) {
                throw new Error(`Remove operation ${index} cannot include value or owner data.`);
            }
            return {
                operation: 'remove',
                rawKey: input.key,
                valueKey,
                ownerKey,
                hasExpectedRevision,
                expectedRevision: input.expectedRevision,
            };
        }

        let valueBytes = null;
        let valueSize;
        let valueHash;
        let valueDisplaySize = null;
        if (streamed) {
            if (!Number.isSafeInteger(input.valueLength) || input.valueLength < 1) {
                throw new Error(`Set operation ${index} requires a positive valueLength.`);
            }
            if (input.valueLength > PLUGIN_VALUE_MAX_BYTES) {
                throw new PluginStorageLimitError(
                    `Plugin value is ${input.valueLength} bytes; the per-value limit is ${PLUGIN_VALUE_MAX_BYTES} bytes. Split the value into smaller records.`,
                    {
                        code: 'PLUGIN_VALUE_TOO_LARGE',
                        limit: PLUGIN_VALUE_MAX_BYTES,
                        actual: input.valueLength,
                    },
                );
            }
            if (typeof input.valueHash !== 'string' || !/^[0-9a-f]{64}$/.test(input.valueHash)) {
                throw new Error(`Set operation ${index} requires a SHA-256 valueHash.`);
            }
            valueSize = input.valueLength;
            valueHash = input.valueHash;
        } else {
            if (typeof input.value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.value)) {
                throw new Error(`Set operation ${index} requires canonical base64 value bytes.`);
            }
            valueBytes = Buffer.from(input.value, 'base64');
            if (valueBytes.length === 0 || valueBytes.toString('base64') !== input.value) {
                throw new Error(`Set operation ${index} requires canonical non-empty value bytes.`);
            }
            const valueText = valueBytes.toString('utf-8');
            if (!Buffer.from(valueText, 'utf-8').equals(valueBytes)) {
                throw new Error(`Set operation ${index} value must be valid UTF-8 JSON.`);
            }
            valueDisplaySize = pluginStorageViewerDisplaySize(
                validatePluginStorageRow(valueKey, valueBytes),
            );
            valueSize = valueBytes.length;
            valueHash = sha256Hex(valueBytes);
        }
        if (typeof input.owner !== 'string' || !input.owner.isWellFormed()) {
            throw new Error(`Set operation ${index} requires a well-formed owner string.`);
        }
        return {
            operation: 'set',
            rawKey: input.key,
            valueKey,
            ownerKey,
            valueBytes,
            valueFilePath: null,
            valueSize,
            valueHash,
            valueDisplaySize,
            owner: input.owner,
            hasExpectedRevision,
            expectedRevision: input.expectedRevision,
        };
    });

    return {
        requestedGeneration: body.generation,
        expectedManifest,
        expectedManifestRevision,
        operations,
    };
}

function createPluginStorageBatchRequestReader(req) {
    const iterator = req[Symbol.asyncIterator]();
    let current = Buffer.alloc(0);
    let offset = 0;
    let ended = false;

    async function nextSlice(maxBytes) {
        while (offset >= current.length) {
            if (ended) return null;
            const result = await iterator.next();
            if (result.done) {
                ended = true;
                return null;
            }
            current = Buffer.isBuffer(result.value)
                ? result.value
                : Buffer.from(result.value);
            offset = 0;
            if (current.length === 0) continue;
        }
        const length = Math.min(maxBytes, current.length - offset);
        const slice = current.subarray(offset, offset + length);
        offset += length;
        return slice;
    }

    return {
        async readBuffer(length) {
            const result = Buffer.allocUnsafe(length);
            let written = 0;
            while (written < length) {
                const slice = await nextSlice(length - written);
                if (!slice) throw new Error('Streamed plugin storage batch was truncated.');
                slice.copy(result, written);
                written += slice.length;
            }
            return result;
        },
        async writeFile(length, filePath, digest) {
            const handle = await fs.open(filePath, 'wx', 0o600);
            let written = 0;
            try {
                while (written < length) {
                    const slice = await nextSlice(length - written);
                    if (!slice) throw new Error('Streamed plugin storage batch value was truncated.');
                    let sliceOffset = 0;
                    while (sliceOffset < slice.length) {
                        const result = await handle.write(
                            slice,
                            sliceOffset,
                            slice.length - sliceOffset,
                            written + sliceOffset,
                        );
                        if (result.bytesWritten <= 0) {
                            throw new Error('Streamed plugin storage batch value could not be staged.');
                        }
                        sliceOffset += result.bytesWritten;
                    }
                    digest.update(slice);
                    written += slice.length;
                }
            } finally {
                await handle.close();
            }
        },
        async assertEnd() {
            if (await nextSlice(1)) {
                throw new Error('Streamed plugin storage batch contains trailing bytes.');
            }
        },
    };
}

async function receiveStreamedPluginStorageBatch(req, res) {
    if (!databaseSpoolReady) {
        const error = new Error('The server upload spool is unavailable; check the save volume permissions.');
        error.code = 'PLUGIN_STORAGE_SPOOL_UNAVAILABLE';
        error.status = 503;
        error.retryable = true;
        throw error;
    }
    const declaredText = Array.isArray(req.headers['x-plugin-storage-batch-length'])
        ? req.headers['x-plugin-storage-batch-length'][0]
        : req.headers['x-plugin-storage-batch-length'];
    const declaredLength = typeof declaredText === 'string' ? Number(declaredText) : NaN;
    const contentLength = Number(req.headers['content-length']);
    const maximumLength = PLUGIN_STORAGE_BATCH_STREAM_PREFIX_BYTES
        + PLUGIN_STORAGE_BATCH_STREAM_MAX_METADATA_BYTES
        + PLUGIN_STORAGE_BATCH_STREAM_MAX_PAYLOAD_BYTES;
    if (!Number.isSafeInteger(declaredLength) || declaredLength <= 0
        || declaredLength > maximumLength
        || (Number.isSafeInteger(contentLength) && contentLength !== declaredLength)) {
        const error = new Error('Streamed plugin storage batch requires an exact bounded length.');
        error.code = 'PLUGIN_STORAGE_BATCH_TOO_LARGE';
        error.status = declaredLength > maximumLength ? 413 : 400;
        error.limit = maximumLength;
        error.actual = declaredLength;
        throw error;
    }

    const stagedPaths = [];
    try {
        const reader = createPluginStorageBatchRequestReader(req);
        const prefix = await reader.readBuffer(PLUGIN_STORAGE_BATCH_STREAM_PREFIX_BYTES);
        if (!prefix.subarray(0, PLUGIN_STORAGE_BATCH_STREAM_MAGIC.length)
            .equals(PLUGIN_STORAGE_BATCH_STREAM_MAGIC)) {
            throw new Error('Streamed plugin storage batch has an invalid magic header.');
        }
        const metadataLength = prefix.readUInt32BE(PLUGIN_STORAGE_BATCH_STREAM_MAGIC.length);
        if (metadataLength < 1 || metadataLength > PLUGIN_STORAGE_BATCH_STREAM_MAX_METADATA_BYTES) {
            const error = new Error('Streamed plugin storage batch metadata exceeds its limit.');
            error.code = 'PLUGIN_STORAGE_BATCH_METADATA_TOO_LARGE';
            error.status = 413;
            error.limit = PLUGIN_STORAGE_BATCH_STREAM_MAX_METADATA_BYTES;
            error.actual = metadataLength;
            throw error;
        }
        const metadataBytes = await reader.readBuffer(metadataLength);
        const metadataText = metadataBytes.toString('utf-8');
        if (!Buffer.from(metadataText, 'utf-8').equals(metadataBytes)) {
            throw new Error('Streamed plugin storage batch metadata must be UTF-8 JSON.');
        }
        const body = JSON.parse(metadataText);
        if (!Buffer.from(JSON.stringify(body), 'utf-8').equals(metadataBytes)) {
            throw new Error('Streamed plugin storage batch metadata must use canonical JSON framing.');
        }
        const parsed = parsePluginStorageBatchEnvelope(body, { streamed: true });
        const payloadBytes = parsed.operations.reduce(
            (total, operation) => total + (operation.operation === 'set' ? operation.valueSize : 0),
            0,
        );
        if (!Number.isSafeInteger(payloadBytes)
            || payloadBytes > PLUGIN_STORAGE_BATCH_STREAM_MAX_PAYLOAD_BYTES) {
            const error = new Error('Streamed plugin storage batch values exceed the payload limit.');
            error.code = 'PLUGIN_STORAGE_BATCH_TOO_LARGE';
            error.status = 413;
            error.limit = PLUGIN_STORAGE_BATCH_STREAM_MAX_PAYLOAD_BYTES;
            error.actual = payloadBytes;
            throw error;
        }
        const expectedLength = PLUGIN_STORAGE_BATCH_STREAM_PREFIX_BYTES
            + metadataLength
            + payloadBytes;
        if (expectedLength !== declaredLength) {
            throw new Error('Streamed plugin storage batch length does not match its metadata.');
        }

        for (let index = 0; index < parsed.operations.length; index++) {
            const operation = parsed.operations[index];
            if (operation.operation !== 'set') continue;
            const valueFilePath = path.join(
                databaseSpoolDir,
                `${PLUGIN_BATCH_VALUE_SPOOL_FILE_PREFIX}${nodeCrypto.randomUUID()}.${index}.upload`,
            );
            stagedPaths.push(valueFilePath);
            const digest = nodeCrypto.createHash('sha256');
            await reader.writeFile(operation.valueSize, valueFilePath, digest);
            if (digest.digest('hex') !== operation.valueHash) {
                throw new Error(`Streamed plugin storage batch value ${index} failed its hash check.`);
            }
            try {
                const displayMetadata = await validateJsonSource({
                    filePath: valueFilePath,
                    size: operation.valueSize,
                }, {
                    shouldAbort: () => req.aborted || res.destroyed,
                });
                operation.valueDisplaySize = pluginStorageViewerDisplaySizeFromMetadata(
                    displayMetadata,
                );
            } catch {
                throw new PluginStorageValidationError(operation.valueKey);
            }
            operation.valueFilePath = valueFilePath;
        }
        await reader.assertEnd();
        return {
            ...parsed,
            requestHash: sha256Hex(metadataBytes),
            stagedPaths,
        };
    } catch (error) {
        for (const filePath of stagedPaths) {
            try { unlinkSync(filePath); } catch {}
        }
        throw error;
    }
}

/**
 * Atomically mutate a bounded set of optimized plugin values. Every CAS is
 * checked before the first write, and every value plus owner sidecar is
 * applied inside the same SQLite writer transaction.
 */
app.post('/api/plugin-storage/batch', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;

    const reject = (status, error, code = 'INVALID_PLUGIN_STORAGE_BATCH') => res.status(status).json({
        success: false,
        outcome: 'not-committed',
        operation: 'batch',
        error,
        code,
        retryable: false,
    });

    let operations;
    let requestHash;
    let requestedGeneration;
    let expectedManifest;
    let expectedManifestRevision;
    let stagedPaths = [];
    try {
        const streamHeader = Array.isArray(req.headers['x-plugin-storage-batch-stream'])
            ? req.headers['x-plugin-storage-batch-stream'][0]
            : req.headers['x-plugin-storage-batch-stream'];
        if (streamHeader !== undefined && streamHeader !== '1') {
            throw new Error('x-plugin-storage-batch-stream must be 1 when present.');
        }
        let parsed;
        if (streamHeader === '1') {
            parsed = await receiveStreamedPluginStorageBatch(req, res);
            stagedPaths = parsed.stagedPaths;
        } else {
            if (!Buffer.isBuffer(req.body)) throw new Error('A JSON batch body is required.');
            if (req.body.length > PLUGIN_STORAGE_BATCH_MAX_BODY_BYTES) {
                return reject(413, 'Plugin storage batch body exceeds the 16 MiB limit.');
            }
            requestHash = sha256Hex(req.body);
            const text = req.body.toString('utf-8');
            if (!Buffer.from(text, 'utf-8').equals(req.body)) {
                throw new Error('Plugin storage batch must be valid UTF-8 JSON.');
            }
            parsed = parsePluginStorageBatchEnvelope(JSON.parse(text));
        }
        operations = parsed.operations;
        requestHash = parsed.requestHash ?? requestHash;
        requestedGeneration = parsed.requestedGeneration;
        expectedManifest = parsed.expectedManifest;
        expectedManifestRevision = parsed.expectedManifestRevision;
    } catch (error) {
        if (error instanceof PluginStorageLimitError) {
            return sendPluginStorageMutationLimitError(res, 'batch', error);
        }
        if (error?.status === 503 && error?.code === 'PLUGIN_STORAGE_SPOOL_UNAVAILABLE') {
            return res.status(503).json({
                success: false,
                outcome: 'not-committed',
                operation: 'batch',
                error: error.message,
                code: error.code,
                retryable: true,
            });
        }
        if (error?.status === 413) {
            return res.status(413).json({
                success: false,
                outcome: 'not-committed',
                operation: 'batch',
                error: error instanceof Error ? error.message : String(error),
                code: error.code ?? 'INVALID_PLUGIN_STORAGE_BATCH',
                limit: error.limit,
                actual: error.actual,
                retryable: false,
            });
        }
        return reject(error?.status ?? 400, error instanceof Error ? error.message : String(error));
    }

    let cleanedStage = false;
    const cleanupStage = () => {
        if (cleanedStage) return;
        cleanedStage = true;
        for (const filePath of stagedPaths) {
            try { unlinkSync(filePath); } catch {}
        }
    };
    res.once('finish', cleanupStage);
    res.once('close', cleanupStage);

    class PluginStorageRevisionConflict extends Error {
        constructor(conflicts) {
            super('One or more plugin storage revisions no longer match.');
            this.conflicts = conflicts;
        }
    }

    try {
        await queueStorageMutation(async () => {
            let generation;
            let committedRevisions;
            let nextManifest;
            let manifestUpdate;
            let committedManifestBytes;
            let committedPublicationRevision;
            try {
                const publication = await readLivePluginStoragePublication();
                const {
                    dbObj,
                    generation: liveGeneration,
                    manifestState,
                    manifestEntry,
                } = publication;
                const pinnedState = sessionPluginStorageReadState(req);
                const activeManifest = liveGeneration
                    && dbObj?.optimizePluginMemory === true
                    && manifestState.valid
                    && manifestState.manifest?.generation === liveGeneration
                    ? manifestState.manifest
                    : null;
                if (!activeManifest
                    || requestedGeneration !== liveGeneration
                    || (expectedManifest
                        ? !pluginStorageManifestEquals(activeManifest, expectedManifest)
                        : manifestState.revision !== expectedManifestRevision)
                    || (pinnedState && (
                        pinnedState.optimized !== true
                        || pinnedState.generation !== requestedGeneration
                    ))) {
                    return res.status(409).json({
                        success: false,
                        outcome: 'not-committed',
                        operation: 'batch',
                        error: 'Plugin storage generation or manifest changed before the batch committed.',
                        code: 'PLUGIN_STORAGE_GENERATION_CONFLICT',
                        retryable: true,
                        ...(activeManifest && manifestState.revision
                            ? {
                                currentGeneration: liveGeneration,
                                currentManifestRevision: manifestState.revision,
                            }
                            : {}),
                    });
                }

                const valueAdds = [];
                const valueDeletes = [];
                const metaAdds = [];
                const metaDeletes = [];
                for (const operation of operations) {
                    if (operation.operation === 'set') {
                        valueAdds.push(operation.valueKey);
                        if (operation.owner) metaAdds.push(operation.ownerKey);
                        else metaDeletes.push(operation.ownerKey);
                    } else {
                        valueDeletes.push(operation.valueKey);
                        metaDeletes.push(operation.ownerKey);
                    }
                }
                manifestUpdate = pluginStorageManifestCache.prepareUpdate(manifestEntry, {
                    valueAdds,
                    valueDeletes,
                    metaAdds,
                    metaDeletes,
                    rawKeys: operations.map(operation => operation.rawKey),
                });
                nextManifest = manifestUpdate.manifest;
                const readActiveState = (operation) => {
                    const valueBytes = manifestEntry.valueKeys.has(operation.valueKey)
                        ? kvGet(operation.valueKey)
                        : null;
                    const ownerBytes = manifestEntry.metaKeys.has(operation.ownerKey)
                        ? kvGet(operation.ownerKey)
                        : null;
                    const owner = parsePluginStorageOwnerRecord(ownerBytes);
                    return {
                        valueBytes,
                        ownerBytes,
                        revision: pluginStorageRevision(valueBytes, ownerBytes),
                        generation: valueBytes !== null
                            && isCanonicalPluginStorageOwnerRecord(owner, ownerBytes)
                            ? owner.generation
                            : null,
                    };
                };
                const recoverySnapshotToken = newPluginRecoverySnapshotToken();
                generation = nodeCrypto.randomUUID();
                const updatedAt = Date.now();
                for (const operation of operations) {
                    if (operation.operation !== 'set') continue;
                    operation.committedOwnerBytes = operation.owner
                        ? Buffer.from(JSON.stringify({
                            plugin: operation.owner,
                            updatedAt,
                            revision: nodeCrypto.randomUUID(),
                            generation,
                        }), 'utf-8')
                        : null;
                    operation.committedRevision = operation.valueFilePath
                        ? await pluginStorageRevisionFromFile(
                            operation.valueFilePath,
                            operation.committedOwnerBytes,
                        )
                        : pluginStorageRevision(
                            operation.valueBytes,
                            operation.committedOwnerBytes,
                        );
                }
                hitPluginStorageBatchFailpoint('before-transaction');
                withPluginStorageQuotaPlan(operations.map(operation => ({
                    key: operation.valueKey,
                    size: operation.operation === 'set' ? operation.valueSize : null,
                })), () => {
                    const conflicts = [];
                    for (const operation of operations) {
                        if (!operation.hasExpectedRevision) continue;
                        const current = readActiveState(operation);
                        if (current.revision !== operation.expectedRevision) {
                            conflicts.push({
                                key: operation.rawKey,
                                currentRevision: current.revision,
                                currentGeneration: current.generation,
                            });
                        }
                    }
                    if (conflicts.length > 0) throw new PluginStorageRevisionConflict(conflicts);

                    for (let index = 0; index < operations.length; index++) {
                        const operation = operations[index];
                        if (operation.operation === 'set') {
                            if (operation.valueFilePath) {
                                kvSetFromFile(operation.valueKey, operation.valueFilePath, {
                                    pluginStorageDisplaySize: operation.valueDisplaySize,
                                });
                            } else {
                                kvSet(operation.valueKey, operation.valueBytes, {
                                    pluginStorageDisplaySize: operation.valueDisplaySize,
                                });
                            }
                            hitPluginStorageBatchFailpoint(`after-value:${index}`);
                            if (operation.owner) {
                                kvSet(operation.ownerKey, operation.committedOwnerBytes);
                            } else {
                                kvDel(operation.ownerKey);
                            }
                            hitPluginStorageBatchFailpoint(`after-owner:${index}`);
                        } else {
                            kvDel(operation.valueKey);
                            hitPluginStorageBatchFailpoint(`after-value:${index}`);
                            kvDel(operation.ownerKey);
                            hitPluginStorageBatchFailpoint(`after-owner:${index}`);
                        }
                        hitPluginStorageBatchFailpoint(`after-operation:${index}`);
                    }
                    hitPluginStorageBatchFailpoint('pre-commit');
                    committedManifestBytes = writePluginStorageManifest(nextManifest);
                    hitPluginStorageBatchFailpoint('after-manifest');
                    markPluginRecoverySnapshotDirty(recoverySnapshotToken);
                    committedPublicationRevision =
                        kvGetPluginStoragePublicationRevision();
                    committedRevisions = operations.map(operation => ({
                        key: operation.rawKey,
                        revision: operation.operation === 'set'
                            ? operation.committedRevision
                            : null,
                        valueHash: operation.operation === 'set'
                            ? operation.valueHash
                            : null,
                    }));
                });
            } catch (error) {
                if (error instanceof PluginStorageRevisionConflict) {
                    return res.status(409).json({
                        success: false,
                        outcome: 'not-committed',
                        operation: 'batch',
                        error: error.message,
                        code: 'PLUGIN_STORAGE_REVISION_CONFLICT',
                        retryable: false,
                        conflicts: error.conflicts,
                    });
                }
                if (error instanceof PluginStorageLimitError) {
                    return sendPluginStorageMutationLimitError(res, 'batch', error);
                }
                logger.warn('[PluginStorageBatch] Transaction rolled back:', error);
                return res.status(500).json({
                    success: false,
                    outcome: 'not-committed',
                    operation: 'batch',
                    error: 'Plugin storage batch transaction rolled back.',
                    code: 'PLUGIN_STORAGE_BATCH_ROLLED_BACK',
                    retryable: false,
                });
            }

            const committedManifestRevision = `sha256:${sha256Hex(committedManifestBytes)}`;
            pluginStorageManifestCache.publishPrepared(manifestUpdate, {
                revision: committedPublicationRevision,
                manifestRevision: committedManifestRevision,
            });

            // Establish the deferred BR1 recovery obligation from the known
            // commit boundary before acknowledgement loss.
            schedulePluginRecoverySnapshot();

            if (pluginStorageBatchFailpoint === 'acknowledgement-loss') {
                res.socket?.destroy();
                return;
            }

            let verification = 'verified';
            try {
                // Retain the acknowledgement-downgrade failpoint without
                // re-reading any committed row or manifest bytes.
                hitPluginStorageBatchFailpoint('verification-read');
            } catch (error) {
                verification = 'unavailable';
                logger.warn('[PluginStorageBatch] Post-commit verification unavailable:', error);
            }

            const acknowledgement = {
                success: true,
                outcome: 'committed',
                operation: 'batch',
                verification,
                requestHash,
                generation,
                revisions: committedRevisions,
                manifestRevision: committedManifestRevision,
            };
            if (pluginStorageBatchFailpoint === 'acknowledgement-delay') {
                const acknowledgementTimer = setTimeout(() => {
                    if (!res.headersSent && !res.destroyed) res.json(acknowledgement);
                }, pluginStorageBatchAcknowledgementDelayMs);
                acknowledgementTimer.unref?.();
                return;
            }
            return res.json(acknowledgement);
        });
    } catch (error) {
        if (isImportInProgressError(error)) {
            res.setHeader('Retry-After', '5');
            return res.status(503).json({
                success: false,
                outcome: 'not-committed',
                operation: 'batch',
                error: 'An import is in progress; retry this batch after it completes',
                code: 'IMPORT_IN_PROGRESS',
                retryable: true,
            });
        }
        next(error);
    }
});

const PLUGIN_STORAGE_SIZE_PREFIXES = new Set([
    PLUGIN_SAVE_PREFIX,
    PLUGIN_SAVE_META_PREFIX,
]);

// Logical sizes let clients reject an unsafe transition before a large or
// malformed row is downloaded. Restrict this inventory to plugin storage so
// the endpoint cannot become an arbitrary repository-inspection primitive.
app.get('/api/storage/list-sizes', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        const rawPrefix = Array.isArray(req.headers['key-prefix'])
            ? req.headers['key-prefix'][0]
            : req.headers['key-prefix'];
        if (!PLUGIN_STORAGE_SIZE_PREFIXES.has(rawPrefix)) {
            return res.status(400).send({ error: 'Unsupported storage size prefix' });
        }
        await importBarrier.waitUntilIdle();
        // The chunk-aware inventory reports authoritative logical sizes without
        // loading or reassembling plugin value bodies.
        const content = kvListWithSizes(rawPrefix);
        if (content.some((entry) => (
            typeof entry.key !== 'string'
            || !entry.key.startsWith(rawPrefix)
            || !Number.isSafeInteger(entry.size)
            || entry.size < 0
        ))) {
            throw new Error('Invalid logical plugin storage size');
        }
        res.send({ success: true, content });
    } catch (error) {
        next(error);
    }
});

/**
 * One logical V3 save mutation. The value row and its ownership sidecar share
 * one synchronous SQLite writer transaction. Empty owner means deliberately
 * unowned (delete stale metadata). Owned removes delete the matching sidecar;
 * value-only removes preserve it byte-exact for inline/optimized parity.
 */
function sendPluginStorageMutationLimitError(res, operation, error) {
    return res.status(error.status || 413).json({
        success: false,
        outcome: 'not-committed',
        operation,
        error: error.message,
        code: error.code,
        limit: error.limit,
        actual: error.actual,
        retryable: false,
    });
}

app.post('/api/plugin-storage/mutate', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;

    const firstHeader = (value) => Array.isArray(value) ? value[0] : value;
    const filePath = firstHeader(req.headers['file-path']);
    const operation = firstHeader(req.headers['x-plugin-storage-operation']);
    const requestedGeneration = firstHeader(req.headers['x-plugin-storage-generation']);
    const ownerHeader = firstHeader(req.headers['x-plugin-storage-owner']) ?? '';
    const ownerPolicyHeader = firstHeader(req.headers['x-plugin-storage-owner-policy']) ?? '';
    const ownerRecordHeader = firstHeader(req.headers['x-plugin-storage-owner-record']);
    const streamHeader = firstHeader(req.headers['x-plugin-storage-stream']);
    const reject = (error, code = 'INVALID_PLUGIN_STORAGE_MUTATION') => res.status(400).json({
        success: false,
        outcome: 'not-committed',
        operation: operation === 'remove' ? 'remove' : 'set',
        error,
        code,
        retryable: false,
    });

    // BR2 batch/CAS publications share this endpoint with AA1's exact
    // value+owner acknowledgement protocol. Dispatch by the canonical AA1
    // operation header so only one route owns the namespace and writer queue.
    if (operation === undefined) {
        return handlePluginStorageManifestMutation(req, res, next);
    }

    if (operation !== 'set' && operation !== 'remove') {
        return reject('Plugin storage operation must be set or remove.');
    }
    if (streamHeader !== undefined && streamHeader !== '1') {
        return reject('x-plugin-storage-stream must be 1 when present.');
    }
    const streamingSet = operation === 'set' && streamHeader === '1';
    if (operation === 'remove' && streamHeader !== undefined) {
        return reject('Remove mutations cannot stream a value body.');
    }
    if (requestedGeneration !== undefined
        && (typeof requestedGeneration !== 'string' || requestedGeneration.length === 0)) {
        return reject('Plugin storage generation must be a non-empty string.');
    }
    if (typeof filePath !== 'string' || !isHex(filePath)) {
        return reject('A valid value row path is required.');
    }

    let valueKey;
    let ownerKey;
    let owner = '';
    let ownerPolicy = 'replace';
    let ownerRecordBytes = null;
    let valueBytes = null;
    let valueFilePath = null;
    let valueHash = null;
    let valueSize = 0;
    let valueDisplaySize = null;
    try {
        ({ decodedKey: valueKey } = decodeAndCanonicalizeHexPath(filePath));
        const hashedValueKey = isHashedPluginSaveStorageKey(valueKey, PLUGIN_SAVE_PREFIX);
        const rawKey = hashedValueKey
            ? null
            : decodePluginSaveStorageKey(valueKey, PLUGIN_SAVE_PREFIX);
        const unrestrictedOwnerKey = `${PLUGIN_SAVE_META_PREFIX}${valueKey.slice(PLUGIN_SAVE_PREFIX.length)}`;

        if (operation === 'set') {
            if (!['', 'preserve', 'record'].includes(ownerPolicyHeader)) {
                throw new Error('Invalid plugin owner mutation policy.');
            }
            ownerPolicy = ownerPolicyHeader || 'replace';
            if (typeof ownerHeader !== 'string' || !/^[A-Za-z0-9_-]*$/.test(ownerHeader)) {
                throw new Error('Plugin owner must use canonical base64url encoding.');
            }
            owner = Buffer.from(ownerHeader, 'base64url').toString('utf-8');
            if (Buffer.from(owner, 'utf-8').toString('base64url') !== ownerHeader) {
                throw new Error('Plugin owner must use canonical UTF-8 base64url encoding.');
            }
            if (ownerPolicy === 'record') {
                if (ownerHeader !== '' || typeof ownerRecordHeader !== 'string'
                    || !/^[A-Za-z0-9_-]+$/.test(ownerRecordHeader)) {
                    throw new Error('An exact owner record is required.');
                }
                ownerKey = unrestrictedOwnerKey;
                ownerRecordBytes = Buffer.from(ownerRecordHeader, 'base64url');
                if (ownerRecordBytes.toString('base64url') !== ownerRecordHeader) {
                    throw new Error('Plugin owner record must use canonical base64url encoding.');
                }
                validatePluginStorageRow(ownerKey, ownerRecordBytes);
            } else if (ownerPolicy === 'preserve') {
                if (ownerHeader !== '' || ownerRecordHeader !== undefined) {
                    throw new Error('Preserved ownership cannot include replacement data.');
                }
                ownerKey = unrestrictedOwnerKey;
            } else {
                if (ownerRecordHeader !== undefined) {
                    throw new Error('Unexpected plugin owner record.');
                }
                ownerKey = unrestrictedOwnerKey;
            }
            if (!streamingSet) {
                if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
                    throw new Error('A set mutation requires JSON value bytes.');
                }
                // express.raw already owns an exact Buffer for this request.
                // Retain it through validation, hashing, and the transaction
                // instead of allocating another full-value defensive copy.
                valueBytes = req.body;
                valueSize = valueBytes.length;
                valueHash = sha256Hex(valueBytes);
                // Match every other optimized plugin row ingress boundary.
                valueDisplaySize = pluginStorageViewerDisplaySize(
                    validatePluginStorageRow(valueKey, valueBytes),
                );
            }
        } else {
            if (!['', 'preserve'].includes(ownerPolicyHeader)
                || ownerRecordHeader !== undefined) {
                throw new Error('Remove mutations accept only the preserve owner policy.');
            }
            ownerPolicy = ownerPolicyHeader || 'replace';
            // BR4 permits a few value-only keys whose corresponding metadata
            // name is too long for an archive. Derive the unrestricted name so
            // owned removal can clean it and value-only removal can preserve it.
            ownerKey = unrestrictedOwnerKey;
        }
    } catch (error) {
        return reject(error instanceof Error ? error.message : String(error));
    }

    if (streamingSet) {
        const rawLength = firstHeader(req.headers['content-length']);
        const expectedLength = typeof rawLength === 'string' ? Number(rawLength) : NaN;
        if (!Number.isSafeInteger(expectedLength) || expectedLength <= 0) {
            return reject('Streaming plugin mutations require an exact positive Content-Length.');
        }
        if (expectedLength > PLUGIN_VALUE_MAX_BYTES) {
            return sendPluginStorageMutationLimitError(res, operation, new PluginStorageLimitError(
                `Plugin value is ${expectedLength} bytes; the per-value limit is ${PLUGIN_VALUE_MAX_BYTES} bytes. Split the value into smaller records.`,
                { code: 'PLUGIN_VALUE_TOO_LARGE', limit: PLUGIN_VALUE_MAX_BYTES, actual: expectedLength },
            ));
        }
        if (!databaseSpoolReady) {
            return res.status(503).json({
                success: false,
                outcome: 'not-committed',
                operation,
                error: 'The server upload spool is unavailable; check the save volume permissions.',
                code: 'PLUGIN_STORAGE_SPOOL_UNAVAILABLE',
                retryable: true,
            });
        }
        valueFilePath = path.join(
            databaseSpoolDir,
            `${PLUGIN_VALUE_SPOOL_FILE_PREFIX}${nodeCrypto.randomUUID()}.upload`,
        );
        let received = 0;
        const digest = nodeCrypto.createHash('sha256');
        const meter = new Transform({
            transform(chunk, _encoding, callback) {
                received += chunk.length;
                if (received > PLUGIN_VALUE_MAX_BYTES) {
                    return callback(new PluginStorageLimitError(
                        `Plugin value exceeded the ${PLUGIN_VALUE_MAX_BYTES}-byte per-value limit while uploading. Split the value into smaller records.`,
                        { code: 'PLUGIN_VALUE_TOO_LARGE', limit: PLUGIN_VALUE_MAX_BYTES, actual: received },
                    ));
                }
                digest.update(chunk);
                callback(null, chunk);
            },
        });
        try {
            await pipeline(req, meter, createWriteStream(valueFilePath, { flags: 'wx' }));
            if (received !== expectedLength) {
                try { unlinkSync(valueFilePath); } catch {}
                valueFilePath = null;
                return reject(
                    `Plugin value length mismatch: expected ${expectedLength} bytes but received ${received}.`,
                    'PLUGIN_VALUE_LENGTH_MISMATCH',
                );
            }
            valueSize = received;
            valueHash = digest.digest('hex');
            // Strict validation stays outside the authoritative mutation queue.
            // The subsequent SQLite commit reads chunks directly from the spool.
            try {
                const displayMetadata = await validateJsonSource({
                    filePath: valueFilePath,
                    size: valueSize,
                }, {
                    shouldAbort: () => req.aborted || res.destroyed,
                });
                valueDisplaySize = pluginStorageViewerDisplaySizeFromMetadata(
                    displayMetadata,
                );
            } catch {
                // Preserve the single-row mutation diagnostic instead of
                // exposing parser-specific streaming errors to the client.
                throw new PluginStorageValidationError(valueKey);
            }
        } catch (error) {
            try { if (valueFilePath) unlinkSync(valueFilePath); } catch {}
            valueFilePath = null;
            if (error instanceof PluginStorageLimitError) {
                return sendPluginStorageMutationLimitError(res, operation, error);
            }
            const diagnostic = logPluginStorageValidationFailure(
                '[PluginStorage] Rejected invalid streamed row',
                error,
            );
            if (diagnostic) return res.status(400).json({
                success: false,
                outcome: 'not-committed',
                operation,
                ...diagnostic,
                retryable: false,
            });
            return next(error);
        }
    }

    try {
        await queueStorageMutation(async () => {
            const publication = await readLivePluginStoragePublication();
            const liveGeneration = publication.generation;
            const activeManifest = liveGeneration
                && publication.dbObj?.optimizePluginMemory === true
                && publication.manifestState.valid
                && publication.manifestState.manifest?.generation === liveGeneration
                ? publication.manifestState.manifest
                : null;
            const pinnedState = sessionPluginStorageReadState(req);
            if (
                (requestedGeneration !== undefined && (
                    requestedGeneration !== liveGeneration
                    || !activeManifest
                    || (pinnedState && (
                        pinnedState.optimized !== true
                        || pinnedState.generation !== requestedGeneration
                    ))
                ))
                || (liveGeneration && requestedGeneration === undefined)
            ) {
                return res.status(409).json({
                    success: false,
                    outcome: 'not-committed',
                    operation,
                    error: 'Plugin storage generation changed before the mutation committed.',
                    code: 'PLUGIN_STORAGE_GENERATION_CONFLICT',
                    retryable: true,
                    ...(activeManifest && publication.manifestState.revision
                        ? {
                            currentGeneration: liveGeneration,
                            currentManifestRevision: publication.manifestState.revision,
                        }
                        : {}),
                });
            }
            if (isHashedPluginSaveStorageKey(valueKey, PLUGIN_SAVE_PREFIX)) {
                if (!activeManifest) {
                    return res.status(409).json({
                        success: false,
                        outcome: 'not-committed',
                        operation,
                        error: 'A hashed plugin storage key requires an active mapped manifest.',
                        code: 'PLUGIN_STORAGE_GENERATION_CONFLICT',
                        retryable: true,
                        ...(activeManifest && publication.manifestState.revision
                            ? {
                                currentGeneration: liveGeneration,
                                currentManifestRevision: publication.manifestState.revision,
                            }
                            : {}),
                    });
                }
                decodeManifestPluginSaveStorageKey(
                    activeManifest,
                    valueKey,
                    PLUGIN_SAVE_PREFIX,
                );
            }
            let manifestUpdate = null;
            if (activeManifest) {
                const valueAdds = operation === 'set' ? [valueKey] : [];
                const valueDeletes = operation === 'remove' ? [valueKey] : [];
                const metaAdds = [];
                const metaDeletes = [];
                if ((operation === 'remove' && ownerPolicy !== 'preserve')
                    || (ownerPolicy === 'replace' && !owner)) {
                    metaDeletes.push(ownerKey);
                } else if (operation === 'set' && ownerPolicy !== 'preserve') {
                    metaAdds.push(ownerKey);
                }
                manifestUpdate = pluginStorageManifestCache.prepareUpdate(
                    publication.manifestEntry,
                    { valueAdds, valueDeletes, metaAdds, metaDeletes },
                );
            }
            const nextManifest = manifestUpdate?.manifest ?? null;
            const previousManifestRevision = manifestUpdate
                ? publication.manifestState.revision
                : null;
            const recoverySnapshotToken = newPluginRecoverySnapshotToken();
            let committedManifestBytes = null;
            let committedPublicationRevision = null;
            try {
                sqliteDb.transaction(() => {
                    if (operation === 'set') {
                        if (valueFilePath) {
                            kvSetFromFile(valueKey, valueFilePath, {
                                pluginStorageDisplaySize: valueDisplaySize,
                            });
                        }
                        else {
                            kvSet(valueKey, valueBytes, {
                                pluginStorageDisplaySize: valueDisplaySize,
                            });
                        }
                        hitPluginStorageMutationFailpoint('owner-write');
                        if (ownerPolicy === 'record') {
                            kvSet(ownerKey, ownerRecordBytes);
                        } else if (ownerPolicy === 'preserve') {
                            // Boot recovery has no inline owner for this key;
                            // retain any historical external sidecar byte-exact.
                        } else if (owner) {
                            kvSet(ownerKey, Buffer.from(JSON.stringify({
                                plugin: owner,
                                updatedAt: Date.now(),
                                revision: nodeCrypto.randomUUID(),
                                generation: nodeCrypto.randomUUID(),
                            }), 'utf-8'));
                        } else {
                            kvDel(ownerKey);
                        }
                    } else {
                        kvDel(valueKey);
                        hitPluginStorageMutationFailpoint('owner-remove');
                        if (ownerPolicy !== 'preserve') kvDel(ownerKey);
                    }
                    maybeFailPluginStorageTransaction(req, 'after-row');
                    committedManifestBytes = writePluginStorageManifest(nextManifest);
                    maybeFailPluginStorageTransaction(req, 'after-manifest');
                    hitPluginStorageMutationFailpoint('pre-commit');
                    markPluginRecoverySnapshotDirty(recoverySnapshotToken);
                    committedPublicationRevision =
                        kvGetPluginStoragePublicationRevision();
                })();
            } catch (error) {
                logger.warn('[PluginStorageMutation] Transaction rolled back:', error);
                if (error instanceof PluginStorageLimitError) {
                    return sendPluginStorageMutationLimitError(res, operation, error);
                }
                return res.status(500).json({
                    success: false,
                    outcome: 'not-committed',
                    operation,
                    error: 'Plugin storage transaction rolled back.',
                    code: 'PLUGIN_STORAGE_TRANSACTION_ROLLED_BACK',
                    retryable: false,
                });
            }

            const committedManifestRevision = manifestUpdate
                ? `sha256:${sha256Hex(committedManifestBytes)}`
                : null;
            if (manifestUpdate) {
                pluginStorageManifestCache.publishPrepared(manifestUpdate, {
                    revision: committedPublicationRevision,
                    manifestRevision: committedManifestRevision,
                });
            }

            // Schedule from the known-commit boundary before a deliberately
            // lost acknowledgement can return control.
            schedulePluginRecoverySnapshot();

            if (pluginStorageMutationFailpoint === 'acknowledgement-loss') {
                // The transaction is durably committed, but the client receives
                // no schema-valid response and must report outcome unknown.
                res.socket?.destroy();
                return;
            }

            let verification = 'verified';
            try {
                // Retain the acknowledgement-downgrade failpoint without
                // re-reading any committed row or manifest bytes.
                hitPluginStorageMutationFailpoint('verification-read');
            } catch (error) {
                // The writer transaction has already returned successfully.
                // Never reject a known committed primary mutation because a
                // test-only acknowledgement diagnostic failed.
                verification = 'unavailable';
                logger.warn('[PluginStorageMutation] Post-commit verification unavailable:', error);
            }

            return res.json({
                success: true,
                outcome: 'committed',
                operation,
                verification,
                hash: operation === 'set' ? valueHash : undefined,
                ...(committedManifestRevision
                    ? {
                        manifestRevision: committedManifestRevision,
                        previousManifestRevision,
                    }
                    : {}),
            });
        });
    } catch (error) {
        if (isImportInProgressError(error)) {
            res.setHeader('Retry-After', '5');
            return res.status(503).json({
                success: false,
                outcome: 'not-committed',
                operation,
                error: 'An import is in progress; retry this write after it completes',
                code: 'IMPORT_IN_PROGRESS',
                retryable: true,
            });
        }
        next(error);
    } finally {
        try { if (valueFilePath) unlinkSync(valueFilePath); } catch {}
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

async function handlePluginStorageManifestMutation(req, res, next) {
    try {
        const inspection = await inspectRisuSaveSource(req.body);
        const plan = inspection.format === 'raw'
            ? await decodeRisuSave(req.body)
            : await decodeBoundedLegacyRisuSave(req.body, {
                inspection,
                tempDir: databaseSpoolDir,
                maxLegacyBytes: LEGACY_DATABASE_IMPORT_MAX_BYTES,
            });
        await queueStorageMutation(async () => {
            await flushPendingDb();
            const rawDatabase = kvGet('database/database.bin');
            if (!rawDatabase) return res.status(409).json({ error: 'Database not found' });
            const liveDb = await decodeAuthoritativeDatabase(rawDatabase);
            const generation = typeof plan?.generation === 'string' && plan.generation.length > 0
                ? plan.generation
                : null;
            const expectedManifest = normalizePluginStorageManifestRequest(
                plan?.expectedManifest,
                'expectedManifest',
            );
            const nextManifest = normalizePluginStorageManifestRequest(
                plan?.nextManifest,
                'nextManifest',
            );
            const manifestState = readPluginStorageManifestState();
            if (
                plan?.version !== 1
                || !generation
                || liveDb?.optimizePluginMemory !== true
                || pluginStorageGeneration(liveDb) !== generation
                || !manifestState.valid
                || !pluginStorageManifestEquals(manifestState.manifest, expectedManifest)
                || expectedManifest.generation !== generation
                || nextManifest.generation !== generation
            ) {
                return res.status(409).json({
                    error: 'Plugin storage state changed while the mutation was being prepared',
                });
            }

            const writes = Array.isArray(plan.writes) ? plan.writes : null;
            const deletes = Array.isArray(plan.deletes) ? plan.deletes : null;
            if (!writes || !deletes) {
                return res.status(400).json({ error: 'writes and deletes must be arrays' });
            }
            const nextValueKeys = new Set(expectedManifest.valueKeys);
            const nextMetaKeys = new Set(expectedManifest.metaKeys);
            const seen = new Set();
            const classify = (storageKey) => {
                if (typeof storageKey !== 'string') throw new TypeError('storage key must be a string');
                const prefix = storageKey.startsWith(PLUGIN_SAVE_META_PREFIX)
                    ? PLUGIN_SAVE_META_PREFIX
                    : storageKey.startsWith(PLUGIN_SAVE_PREFIX)
                        ? PLUGIN_SAVE_PREFIX
                        : null;
                if (!prefix) throw new TypeError(`Invalid plugin storage key: ${storageKey}`);
                const mappingManifest = nextManifest.valueKeys.includes(storageKey)
                    || nextManifest.metaKeys.includes(storageKey)
                    ? nextManifest
                    : expectedManifest;
                decodeManifestPluginSaveStorageKey(mappingManifest, storageKey, prefix);
                if (seen.has(storageKey)) throw new TypeError(`Duplicate plugin storage mutation: ${storageKey}`);
                seen.add(storageKey);
                return prefix === PLUGIN_SAVE_META_PREFIX ? nextMetaKeys : nextValueKeys;
            };
            const preparedWrites = writes.map((write) => {
                const keys = classify(write?.storageKey);
                if (!(write?.valueBytes instanceof Uint8Array)) {
                    throw new TypeError('Plugin storage writes require valueBytes');
                }
                const value = Buffer.from(write.valueBytes);
                validatePluginStorageRow(write.storageKey, value);
                keys.add(write.storageKey);
                return { storageKey: write.storageKey, value };
            });
            const preparedDeletes = deletes.map((storageKey) => {
                const keys = classify(storageKey);
                keys.delete(storageKey);
                return storageKey;
            });
            const derivedManifest = createPluginStorageManifest(
                generation,
                nextValueKeys,
                nextMetaKeys,
                nextManifest.version === 3 ? nextManifest.keyMappings : [],
            );
            if (!pluginStorageManifestEquals(derivedManifest, nextManifest)) {
                return res.status(400).json({
                    error: 'nextManifest does not exactly match the requested row mutations',
                });
            }

            const recoverySnapshotToken = newPluginRecoverySnapshotToken();
            withPluginStorageQuotaPlan([
                ...preparedWrites
                    .filter(write => write.storageKey.startsWith(PLUGIN_SAVE_PREFIX))
                    .map(write => ({ key: write.storageKey, size: write.value.length })),
                ...preparedDeletes
                    .filter(storageKey => storageKey.startsWith(PLUGIN_SAVE_PREFIX))
                    .map(key => ({ key, size: null })),
            ], () => {
                for (const write of preparedWrites) {
                    kvSet(write.storageKey, write.value);
                    maybeFailPluginStorageTransaction(req, 'after-row');
                }
                for (const storageKey of preparedDeletes) {
                    kvDel(storageKey);
                    maybeFailPluginStorageTransaction(req, 'after-row');
                }
                writePluginStorageManifest(nextManifest);
                maybeFailPluginStorageTransaction(req, 'after-manifest');
                markPluginRecoverySnapshotDirty(recoverySnapshotToken);
            });
            schedulePluginRecoverySnapshot();
            res.json({ success: true });
        });
    } catch (error) {
        if (isImportInProgressError(error)) {
            res.setHeader('Retry-After', '5');
            return res.status(503).json({
                success: false,
                commitOutcome: 'not-committed',
                commitOutcomeUnknown: false,
                error: 'An import is in progress; retry this mutation after it completes',
                code: 'IMPORT_IN_PROGRESS',
                retryable: true,
            });
        }
        const refusal = risuSavePreparationRefusal(error);
        if (refusal) return res.status(refusal.status).json(refusal.body);
        next(error);
    }
}

function pluginTransitionStageResponse(stage) {
    return {
        success: true,
        transitionId: stage.transitionId,
        state: stage.state,
        direction: stage.targetOptimized ? 'externalize' : 'internalize',
        targetGeneration: stage.targetGeneration,
        rows: stage.rows.map(row => ({
            storageKey: row.storageKey,
            rawKey: row.rawKey,
            size: row.size,
            sha256: row.sha256 ?? null,
            uploaded: row.uploaded === true,
        })),
        uploaded: stage.rows.filter(row => row.uploaded === true).length,
        total: stage.rows.length,
        totalBytes: stage.rows.reduce((sum, row) => sum + row.size, 0),
        etag: stage.resultEtag ?? undefined,
    };
}

function pluginTransitionDesiredManifest(stage) {
    if (!stage.targetOptimized) return null;
    return createPluginStorageManifest(
        stage.targetGeneration,
        stage.rows
            .filter(row => row.storageKey.startsWith(PLUGIN_SAVE_PREFIX))
            .map(row => row.storageKey),
        stage.rows
            .filter(row => row.storageKey.startsWith(PLUGIN_SAVE_META_PREFIX))
            .map(row => row.storageKey),
        mergePluginStorageKeyMappings(
            null,
            stage.rows.map(row => row.rawKey),
            stage.rows
                .filter(row => row.storageKey.startsWith(PLUGIN_SAVE_PREFIX))
                .map(row => row.storageKey),
            stage.rows
                .filter(row => row.storageKey.startsWith(PLUGIN_SAVE_META_PREFIX))
                .map(row => row.storageKey),
        ),
    );
}

async function refreshPluginTransitionStageState(stage) {
    if (!stage || stage.state === 'committed' || stage.state === 'aborted') return stage;
    const rawDatabase = kvGet('database/database.bin');
    if (!rawDatabase) return stage;
    const dbObj = await decodeAuthoritativeDatabase(rawDatabase);
    const manifest = readPluginStorageManifestState().manifest;
    if (
        (dbObj?.optimizePluginMemory === true) === stage.targetOptimized
        && pluginStorageGeneration(dbObj) === stage.targetGeneration
        && pluginStorageManifestEquals(manifest, pluginTransitionDesiredManifest(stage))
    ) {
        stage.state = 'committed';
        stage.resultEtag = computeBufferEtag(rawDatabase);
        stage.updatedAt = Date.now();
        writePluginTransitionStage(stage);
        removePluginTransitionStageRows(stage);
    }
    return stage;
}

/**
 * A process can exit after the SQLite publication commits but before its
 * private receipt is rewritten. Keep fresh ready/uploading receipts until the
 * live database passes boot preflight, then resolve them against authoritative
 * state. Unpublished stages are removed before the server begins accepting
 * clients on a healthy boot; recovery-mode startup leaves private receipts
 * untouched until the database is repaired.
 */
async function reconcilePluginTransitionStagesAtStartup() {
    if (!databaseSpoolReady) return;
    // Keep the early module load read-only with respect to private transition
    // receipts. Startup calls this only after database preflight, so corrupt
    // recovery boots cannot discard a staged authoritative source.
    sweepStalePluginTransitionStages();
    for (const entry of readdirSync(pluginTransitionStageDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const match = entry.name.match(
            /^\.plugin-transition-stage-([0-9a-f-]{36})\.json$/,
        );
        if (!match || !PLUGIN_STORAGE_UUID_PATTERN.test(match[1])) continue;
        let stage = readPluginTransitionStage(match[1]);
        if (!stage || stage.state === 'aborted') {
            removePluginTransitionStage(stage ?? { transitionId: match[1], rows: [] });
            continue;
        }
        if (stage.state !== 'committed') {
            stage = await refreshPluginTransitionStageState(stage);
        }
        if (stage?.state !== 'committed') removePluginTransitionStage(stage);
    }
}

function normalizedPluginTransitionRows(rows) {
    if (!Array.isArray(rows) || rows.length > 100_000) {
        throw new TypeError('Plugin transition rows must be a bounded array');
    }
    const seen = new Set();
    let total = 0;
    return rows.map((row, index) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
            throw new TypeError('Invalid plugin transition row descriptor');
        }
        const rowKeys = Object.keys(row).sort();
        const hasRawKey = Object.hasOwn(row, 'rawKey');
        if ((hasRawKey
            && (rowKeys.length !== 3
                || rowKeys[0] !== 'rawKey'
                || rowKeys[1] !== 'size'
                || rowKeys[2] !== 'storageKey'))
            || (!hasRawKey
                && (rowKeys.length !== 2
                    || rowKeys[0] !== 'size'
                    || rowKeys[1] !== 'storageKey'))) {
            throw new TypeError('Transition row descriptors require rawKey, storageKey, and size');
        }
        const storageKey = row.storageKey;
        const prefix = canonicalPluginStorageRowPrefix(storageKey);
        let rawKey = row.rawKey;
        if (prefix && !hasRawKey) {
            try {
                rawKey = decodePluginSaveStorageKey(storageKey, prefix);
            } catch {
                rawKey = null;
            }
        }
        if (!prefix || typeof rawKey !== 'string'
            || encodePluginSaveStorageKey(rawKey, prefix) !== storageKey
            || seen.has(storageKey)) {
            throw new TypeError('Plugin transition row keys must be unique and canonical');
        }
        seen.add(storageKey);
        const size = row.size;
        if (!Number.isSafeInteger(size) || size <= 0 || size > PLUGIN_TRANSITION_MAX_ROW_BYTES) {
            throw new PluginStorageLimitError(
                `Plugin transition row exceeds the ${PLUGIN_TRANSITION_MAX_ROW_BYTES}-byte transition limit.`,
                {
                    code: 'PLUGIN_STORAGE_SIZE_LIMIT',
                    limit: PLUGIN_TRANSITION_MAX_ROW_BYTES,
                    actual: size,
                },
            );
        }
        total += size;
        if (!Number.isSafeInteger(total)) {
            throw new TypeError('Plugin transition size exceeds the safe integer range');
        }
        return {
            index,
            storageKey,
            rawKey,
            size,
            sha256: null,
            stagedSha256: null,
            uploaded: false,
        };
    });
}

function authoritativeInlinePluginTransitionRows(liveDb) {
    const rows = [];
    const seen = new Set();
    const appendRecord = (record, prefix) => {
        if (record === undefined) return;
        if (record === null || typeof record !== 'object' || Array.isArray(record)) {
            throw new PluginStorageValidationError(prefix);
        }
        const prototype = Reflect.getPrototypeOf(record);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new PluginStorageValidationError(prefix);
        }
        for (const rawKey of Reflect.ownKeys(record)) {
            if (typeof rawKey !== 'string') throw new PluginStorageValidationError(prefix);
            const storageKey = encodeValidatedPluginStorageKey(rawKey, prefix);
            if (seen.has(storageKey)) throw new PluginStorageValidationError(storageKey);
            const descriptor = Reflect.getOwnPropertyDescriptor(record, rawKey);
            if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
                throw new PluginStorageValidationError(storageKey);
            }
            const value = serializePluginStorageRow(storageKey, descriptor.value);
            if (value.length > PLUGIN_TRANSITION_MAX_ROW_BYTES) {
                throw new PluginStorageLimitError(
                    `Plugin transition row exceeds the ${PLUGIN_TRANSITION_MAX_ROW_BYTES}-byte transition limit.`,
                    {
                        code: 'PLUGIN_STORAGE_SIZE_LIMIT',
                        limit: PLUGIN_TRANSITION_MAX_ROW_BYTES,
                        actual: value.length,
                    },
                );
            }
            seen.add(storageKey);
            rows.push({
                storageKey,
                rawKey,
                size: value.length,
                sha256: sha256Hex(value),
                stagedSha256: null,
                displaySize: prefix === PLUGIN_SAVE_PREFIX
                    ? pluginStorageViewerDisplaySize(descriptor.value)
                    : null,
                uploaded: false,
            });
            if (rows.length > 100_000) {
                throw new PluginStorageLimitError(
                    'Plugin storage exceeds the 100000-entry transition limit.',
                    { code: 'PLUGIN_STORAGE_SIZE_LIMIT', limit: 100_000, actual: rows.length },
                );
            }
        }
    };
    appendRecord(liveDb?.pluginCustomStorage, PLUGIN_SAVE_PREFIX);
    appendRecord(liveDb?.pluginStorageMeta, PLUGIN_SAVE_META_PREFIX);
    return rows.map((row, index) => ({ ...row, index }));
}

function assertDeclaredTransitionRowsMatch(declaredRows, authoritativeRows) {
    const mismatch = () => {
        const error = new Error('Transition rows must exactly match authoritative inline storage');
        error.pluginTransitionPlanMismatch = true;
        return error;
    };
    if (!Array.isArray(declaredRows) || declaredRows.length !== authoritativeRows.length) {
        throw mismatch();
    }
    let declared;
    try {
        declared = normalizedPluginTransitionRows(declaredRows);
    } catch {
        throw mismatch();
    }
    const declaredByKey = new Map(declared.map(row => [row.storageKey, row]));
    for (const row of authoritativeRows) {
        const candidate = declaredByKey.get(row.storageKey);
        if (!candidate || candidate.size !== row.size || candidate.rawKey !== row.rawKey) {
            throw mismatch();
        }
    }
}

function assertInlineTransitionSourceHashes(liveDb, sourceRowHashes) {
    const currentRows = authoritativeInlinePluginTransitionRows(liveDb);
    const expected = new Map(
        sourceRowHashes
            .filter(row => row.backend === 'inline')
            .map(row => [row.storageKey, row]),
    );
    if (currentRows.length !== expected.size) {
        throw new Error('Inline plugin storage changed during transition');
    }
    for (const row of currentRows) {
        const source = expected.get(row.storageKey);
        if (!source || source.size !== row.size || source.sha256 !== row.sha256) {
            throw new Error('Inline plugin storage changed during transition');
        }
    }
}

async function computeFileEtag(filePath) {
    const hash = nodeCrypto.createHash('md5');
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    return hash.digest('hex');
}

async function computeFileSha256(filePath) {
    const hash = nodeCrypto.createHash('sha256');
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    return hash.digest('hex');
}

async function spoolPluginTransitionKvRow(storageKey, destinationPath, options = {}) {
    const expectedSize = kvSize(storageKey);
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
        throw new PluginStorageValidationError(storageKey);
    }
    if (expectedSize > PLUGIN_TRANSITION_MAX_ROW_BYTES) {
        throw new PluginStorageLimitError(
            'Plugin storage contains a row outside the configured value limit.',
            {
                code: 'PLUGIN_STORAGE_SIZE_LIMIT',
                limit: PLUGIN_TRANSITION_MAX_ROW_BYTES,
                actual: expectedSize,
            },
        );
    }
    const digest = nodeCrypto.createHash('sha256');
    const result = await kvWriteToFile(storageKey, destinationPath, {
        shouldAbort: options.shouldAbort,
        onBytes: (bytes) => digest.update(bytes),
    });
    if (!result || result.size !== expectedSize) {
        throw new PluginStorageValidationError(storageKey);
    }
    await fs.chmod(destinationPath, 0o600);
    let displaySize = null;
    if (options.validateJson !== false) {
        try {
            const displayMetadata = await validateJsonSource({
                filePath: destinationPath,
                size: result.size,
            }, {
                shouldAbort: options.shouldAbort,
            });
            if (storageKey.startsWith(PLUGIN_SAVE_PREFIX)) {
                displaySize = pluginStorageViewerDisplaySizeFromMetadata(displayMetadata);
            }
        } catch {
            throw new PluginStorageValidationError(storageKey);
        }
    }
    const sha256 = digest.digest('hex');
    return { size: result.size, sha256, displaySize };
}

async function writeDurablePluginTransitionStageRow(storageKey, filePath, shouldAbort) {
    const temporaryPath = `${filePath}.${nodeCrypto.randomUUID()}.tmp`;
    try {
        const result = await spoolPluginTransitionKvRow(storageKey, temporaryPath, {
            shouldAbort,
            validateJson: true,
        });
        const fileDescriptor = openSync(temporaryPath, 'r');
        try {
            fsyncSync(fileDescriptor);
        } finally {
            closeSync(fileDescriptor);
        }
        renameSync(temporaryPath, filePath);
        fsyncPluginTransitionStageDirectory();
        return result;
    } catch (error) {
        try { unlinkSync(temporaryPath); } catch {}
        fsyncPluginTransitionStageDirectory();
        throw error;
    }
}

async function pluginTransitionKvRowMatches(storageKey, expected, shouldAbort) {
    const temporaryPath = path.join(
        pluginTransitionStageDir,
        `${PLUGIN_TRANSITION_STAGE_PREFIX}${nodeCrypto.randomUUID()}.verify.tmp`,
    );
    try {
        const actual = await spoolPluginTransitionKvRow(storageKey, temporaryPath, {
            shouldAbort,
            validateJson: false,
        });
        return actual.size === expected.size && actual.sha256 === expected.sha256;
    } finally {
        try { unlinkSync(temporaryPath); } catch {}
    }
}

async function assertInternalTransitionBounds(liveDb, sourceKeys) {
    const ownedValueRaw = new Set(sourceKeys.valueKeys.map(
        key => sourceKeys.manifest
            ? decodeManifestPluginSaveStorageKey(sourceKeys.manifest, key, PLUGIN_SAVE_PREFIX)
            : decodeValidatedPluginStorageKey(key, PLUGIN_SAVE_PREFIX),
    ));
    const ownedMetaRaw = new Set(sourceKeys.metaKeys.map(
        key => sourceKeys.manifest
            ? decodeManifestPluginSaveStorageKey(sourceKeys.manifest, key, PLUGIN_SAVE_META_PREFIX)
            : decodeValidatedPluginStorageKey(key, PLUGIN_SAVE_META_PREFIX),
    ));
    let entries = sourceKeys.valueKeys.length + sourceKeys.metaKeys.length;
    let bytes = 0;
    const addSize = size => {
        if (!Number.isSafeInteger(size) || size < 0 || size > PLUGIN_TRANSITION_MAX_ROW_BYTES) {
            throw new PluginStorageLimitError(
                'Plugin storage contains a row outside the transition limit.',
                {
                    code: 'PLUGIN_STORAGE_SIZE_LIMIT',
                    limit: PLUGIN_TRANSITION_MAX_ROW_BYTES,
                    actual: size,
                },
            );
        }
        bytes += size;
        if (!Number.isSafeInteger(bytes)) {
            throw new PluginStorageLimitError(
                'Plugin storage size exceeds the safe transition range.',
                {
                    code: 'PLUGIN_STORAGE_SIZE_LIMIT',
                    limit: Number.MAX_SAFE_INTEGER,
                    actual: bytes,
                },
            );
        }
    };
    const selectedSizes = new Map(
        kvListSelectedWithSizes([...sourceKeys.valueKeys, ...sourceKeys.metaKeys])
            .map((entry) => [entry.key, entry.size]),
    );
    for (const key of sourceKeys.valueKeys) addSize(selectedSizes.get(key));
    for (const key of sourceKeys.metaKeys) addSize(selectedSizes.get(key));
    const accountInline = (record, prefix, externalKeys) => {
        for (const [rawKey, value] of Object.entries(record ?? {})) {
            const storageKey = encodeValidatedPluginStorageKey(rawKey, prefix);
            if (externalKeys.has(rawKey)) continue;
            const rowBytes = serializePluginStorageRow(storageKey, value);
            entries++;
            addSize(rowBytes.length);
        }
    };
    accountInline(liveDb.pluginCustomStorage, PLUGIN_SAVE_PREFIX, ownedValueRaw);
    accountInline(liveDb.pluginStorageMeta, PLUGIN_SAVE_META_PREFIX, ownedMetaRaw);
    if (entries > 100_000) {
        throw new PluginStorageLimitError(
            'Plugin storage exceeds the 100000-entry internalization limit.',
            { code: 'PLUGIN_STORAGE_SIZE_LIMIT', limit: 100_000, actual: entries },
        );
    }
    const currentDbBytes = kvSize('database/database.bin') ?? 0;
    const required = bytes * 3 + currentDbBytes * 2;
    if (!Number.isSafeInteger(required)) {
        throw new PluginStorageLimitError(
            'Plugin storage transition disk requirement is too large.',
            { code: 'PLUGIN_STORAGE_DISK_LIMIT', limit: Number.MAX_SAFE_INTEGER, actual: required },
        );
    }
    const disk = await checkDiskSpace(required);
    if (!disk.ok) {
        throw new PluginStorageLimitError(
            `Plugin storage transition requires ${required} free bytes.`,
            { code: 'PLUGIN_STORAGE_DISK_LIMIT', limit: disk.available, actual: required },
        );
    }
    return { entries, bytes };
}

app.post('/api/plugin-storage/transition/stage/begin', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    try {
        const plan = req.body;
        const planKeys = plan && typeof plan === 'object' && !Array.isArray(plan)
            ? Object.keys(plan)
            : [];
        const allowedPlanKeys = new Set([
            'version',
            'transitionId',
            'source',
            'targetOptimized',
            'targetGeneration',
            'rows',
            'expectedEtag',
        ]);
        const requiredPlanKeys = [
            'version',
            'transitionId',
            'source',
            'targetOptimized',
            'targetGeneration',
            'rows',
        ];
        const sourceKeys = plan?.source && typeof plan.source === 'object'
            && !Array.isArray(plan.source)
            ? Object.keys(plan.source).sort()
            : [];
        const sourceShapeValid = sourceKeys.length === 3
            && sourceKeys[0] === 'generation'
            && sourceKeys[1] === 'manifest'
            && sourceKeys[2] === 'optimized';
        const manifest = plan?.source?.manifest;
        const manifestShapeValid = manifest === null
            || parsePluginStorageManifest(manifest) !== null;
        if (plan?.version !== 2
            || !PLUGIN_STORAGE_UUID_PATTERN.test(plan.transitionId)
            || !PLUGIN_STORAGE_UUID_PATTERN.test(plan.targetGeneration)
            || typeof plan.targetOptimized !== 'boolean'
            || planKeys.some(key => !allowedPlanKeys.has(key))
            || requiredPlanKeys.some(key => !planKeys.includes(key))
            || !sourceShapeValid
            || typeof plan.source.optimized !== 'boolean'
            || !(plan.source.generation === null || typeof plan.source.generation === 'string')
            || !manifestShapeValid
            || !Array.isArray(plan.rows)
            || (plan.expectedEtag !== undefined && typeof plan.expectedEtag !== 'string')) {
            return res.status(400).json({ error: 'Invalid staged plugin transition plan' });
        }
        await queueStorageMutation(async () => {
            await flushPendingDb();
            const rawDatabase = kvGet('database/database.bin');
            if (!rawDatabase) return res.status(409).json({ error: 'Database not found' });
            const currentEtag = dbEtag ?? computeBufferEtag(rawDatabase);
            dbEtag = currentEtag;
            const requestHash = sha256Hex(Buffer.from(JSON.stringify(plan), 'utf-8'));
            let existing = readPluginTransitionStage(plan.transitionId);
            if (existing) {
                if (!pluginTransitionStageBelongsToRequest(existing, req)) {
                    return res.status(404).json({ error: 'Transition not found' });
                }
                existing = await refreshPluginTransitionStageState(existing);
                if (existing.requestHash !== requestHash) {
                    return res.status(409).json({ error: 'Transition id is already bound to another plan' });
                }
                return res.json(pluginTransitionStageResponse(existing));
            }
            const activeStage = await findActivePluginTransition(req, plan.transitionId);
            if (activeStage) {
                return res.status(409).json({
                    error: 'Another plugin storage transition is already active',
                });
            }
            const liveDb = await decodeAuthoritativeDatabase(rawDatabase);
            const manifestState = readPluginStorageManifestState();
            try {
                assertPluginStorageSource(plan.source, liveDb, manifestState);
            } catch (error) {
                if (error?.pluginStorageConflict) {
                    return res.status(409).json({ error: error.message, currentEtag });
                }
                throw error;
            }
            if (plan.expectedEtag && plan.expectedEtag !== currentEtag) {
                return res.status(409).json({ error: 'ETag mismatch', currentEtag });
            }
            if (
                plan.targetOptimized === (liveDb?.optimizePluginMemory === true)
                || plan.targetGeneration === pluginStorageGeneration(liveDb)
            ) {
                return res.status(400).json({ error: 'Transition target must use a fresh mode generation' });
            }
            const sourceKeys = resolveOwnedPluginStorageKeys(liveDb);
            let rows;
            if (plan.targetOptimized) {
                rows = authoritativeInlinePluginTransitionRows(liveDb);
                try {
                    assertDeclaredTransitionRowsMatch(plan.rows, rows);
                } catch (error) {
                    if (error?.pluginTransitionPlanMismatch) {
                        return res.status(409).json({
                            error: error.message,
                            code: 'PLUGIN_STORAGE_CHANGED',
                        });
                    }
                    throw error;
                }
                const stagedBytes = rows.reduce((sum, row) => sum + row.size, 0);
                const required = stagedBytes * 3 + (kvSize('database/database.bin') ?? 0) * 2;
                if (!Number.isSafeInteger(required)) {
                    throw new PluginStorageLimitError(
                        'Plugin transition disk requirement is too large.',
                        {
                            code: 'PLUGIN_STORAGE_DISK_LIMIT',
                            limit: Number.MAX_SAFE_INTEGER,
                            actual: required,
                        },
                    );
                }
                const disk = await checkDiskSpace(required);
                if (!disk.ok) {
                    throw new PluginStorageLimitError(
                        `Plugin transition requires ${required} free bytes.`,
                        {
                            code: 'PLUGIN_STORAGE_DISK_LIMIT',
                            limit: disk.available,
                            actual: required,
                        },
                    );
                }
            } else {
                if (Array.isArray(plan.rows) && plan.rows.length > 0) {
                    return res.status(400).json({ error: 'Internalization rows are server-derived' });
                }
                await assertInternalTransitionBounds(liveDb, sourceKeys);
                rows = [];
                try {
                    for (const storageKey of [...sourceKeys.valueKeys, ...sourceKeys.metaKeys]) {
                        if (req.aborted || res.destroyed) {
                            throw new Error('Plugin transition begin disconnected');
                        }
                        const index = rows.length;
                        const prefix = storageKey.startsWith(PLUGIN_SAVE_META_PREFIX)
                            ? PLUGIN_SAVE_META_PREFIX
                            : PLUGIN_SAVE_PREFIX;
                        const rawKey = sourceKeys.manifest
                            ? decodeManifestPluginSaveStorageKey(
                                sourceKeys.manifest,
                                storageKey,
                                prefix,
                            )
                            : decodeValidatedPluginStorageKey(storageKey, prefix);
                        const filePath = pluginTransitionStageRowPath(plan.transitionId, index);
                        const staged = await writeDurablePluginTransitionStageRow(
                            storageKey,
                            filePath,
                            () => req.aborted || res.destroyed,
                        );
                        rows.push({
                            index,
                            storageKey,
                            rawKey,
                            size: staged.size,
                            sha256: staged.sha256,
                            stagedSha256: staged.sha256,
                            displaySize: staged.displaySize,
                            uploaded: true,
                        });
                    }
                } catch (error) {
                    for (const row of rows) {
                        try {
                            unlinkSync(pluginTransitionStageRowPath(plan.transitionId, row.index));
                        } catch {}
                    }
                    fsyncPluginTransitionStageDirectory();
                    throw error;
                }
            }
            const stage = {
                version: 1,
                transitionId: plan.transitionId,
                sessionId: typeof req.headers['x-session-id'] === 'string'
                    ? req.headers['x-session-id']
                    : null,
                requestHash,
                source: plan.source,
                sourceEtag: currentEtag,
                sourceRowHashes: rows.map(row => ({
                    storageKey: row.storageKey,
                    size: row.size,
                    sha256: row.sha256,
                    backend: plan.targetOptimized ? 'inline' : 'kv',
                })),
                targetOptimized: plan.targetOptimized,
                targetGeneration: plan.targetGeneration,
                rows,
                state: rows.every(row => row.uploaded) ? 'ready' : 'uploading',
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
            try {
                writePluginTransitionStage(stage);
            } catch (error) {
                removePluginTransitionStage(stage);
                throw error;
            }
            res.json(pluginTransitionStageResponse(stage));
        });
    } catch (error) {
        next(error);
    }
});

app.post('/api/plugin-storage/transition/stage/upload', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    let temporaryPath = null;
    try {
        const transitionId = req.headers['x-plugin-storage-transition'];
        const storageKey = req.headers['x-plugin-storage-key'];
        if (typeof transitionId !== 'string' || typeof storageKey !== 'string') {
            return res.status(400).json({ error: 'Transition id and storage key are required' });
        }
        const stage = readPluginTransitionStage(transitionId);
        if (!pluginTransitionStageBelongsToRequest(stage, req) || stage.state === 'aborted') {
            return res.status(404).json({ error: 'Transition not found' });
        }
        if (stage.state === 'committed') return res.json(pluginTransitionStageResponse(stage));
        if (!stage.targetOptimized) return res.status(409).json({ error: 'Internalization does not accept uploads' });
        const row = stage.rows.find(entry => entry.storageKey === storageKey);
        if (!row) return res.status(400).json({ error: 'Unexpected transition row' });
        const declaredLength = Number(req.headers['content-length']);
        if (!Number.isSafeInteger(declaredLength) || declaredLength !== row.size) {
            return res.status(400).json({ error: 'Transition row length mismatch' });
        }
        temporaryPath = `${pluginTransitionStageRowPath(transitionId, row.index)}.${nodeCrypto.randomUUID()}.tmp`;
        let received = 0;
        const digest = nodeCrypto.createHash('sha256');
        const meter = new Transform({
            transform(chunk, _encoding, callback) {
                received += chunk.length;
                if (received > row.size || received > PLUGIN_TRANSITION_MAX_ROW_BYTES) {
                    return callback(new Error('Transition row exceeded its declared size'));
                }
                digest.update(chunk);
                callback(null, chunk);
            },
        });
        await pipeline(req, meter, createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }));
        if (received !== row.size) throw new Error('Transition row length mismatch');
        const fileDescriptor = openSync(temporaryPath, 'r');
        try {
            fsyncSync(fileDescriptor);
        } finally {
            closeSync(fileDescriptor);
        }
        const hash = digest.digest('hex');
        let displaySize = null;
        try {
            const displayMetadata = await validateJsonSource({
                filePath: temporaryPath,
                size: received,
            }, {
                shouldAbort: () => req.aborted || res.destroyed,
            });
            if (storageKey.startsWith(PLUGIN_SAVE_PREFIX)) {
                displaySize = pluginStorageViewerDisplaySizeFromMetadata(displayMetadata);
            }
        } catch {
            throw new PluginStorageValidationError(storageKey);
        }
        await queueStorageMutation(async () => {
            const current = readPluginTransitionStage(transitionId);
            if (!pluginTransitionStageBelongsToRequest(current, req) || current.state === 'aborted') {
                return res.status(404).json({ error: 'Transition not found' });
            }
            const currentRow = current.rows.find(entry => entry.storageKey === storageKey);
            if (hash !== currentRow.sha256) {
                return res.status(409).json({
                    error: 'Transition row does not match the authoritative source',
                    code: 'PLUGIN_STORAGE_CHANGED',
                });
            }
            if (currentRow.uploaded) {
                if (currentRow.sha256 !== hash || currentRow.size !== received) {
                    return res.status(409).json({ error: 'Conflicting transition row retry' });
                }
                try { unlinkSync(temporaryPath); } catch {}
                temporaryPath = null;
                return res.json(pluginTransitionStageResponse(current));
            }
            renameSync(temporaryPath, pluginTransitionStageRowPath(transitionId, currentRow.index));
            fsyncPluginTransitionStageDirectory();
            temporaryPath = null;
            currentRow.uploaded = true;
            currentRow.stagedSha256 = hash;
            currentRow.displaySize = displaySize;
            current.state = current.rows.every(entry => entry.uploaded) ? 'ready' : 'uploading';
            current.updatedAt = Date.now();
            writePluginTransitionStage(current);
            res.json(pluginTransitionStageResponse(current));
        });
    } catch (error) {
        next(error);
    } finally {
        try { if (temporaryPath) unlinkSync(temporaryPath); } catch {}
    }
});

app.get('/api/plugin-storage/transition/stage/row', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    let download = null;
    try {
        const transitionId = req.headers['x-plugin-storage-transition'];
        const storageKey = req.headers['x-plugin-storage-key'];
        if (typeof transitionId !== 'string' || typeof storageKey !== 'string') {
            return res.status(400).json({ error: 'Transition id and storage key are required' });
        }
        const stage = readPluginTransitionStage(transitionId);
        const row = stage?.rows?.find(entry => entry.storageKey === storageKey);
        if (!pluginTransitionStageBelongsToRequest(stage, req)
            || !row?.uploaded
            || stage.state === 'aborted') return res.status(404).end();
        if (!/^[0-9a-f]{64}$/.test(row.sha256)
            || row.stagedSha256 !== row.sha256) {
            return res.status(409).json({ error: 'Staged transition row failed verification' });
        }
        const filePath = pluginTransitionStageRowPath(transitionId, row.index);
        download = await openStageRowDownload(filePath, row.size);
        if (!download) {
            return res.status(409).json({ error: 'Staged transition row failed verification' });
        }
        res.setHeader('content-type', 'application/octet-stream');
        res.setHeader('content-length', row.size);
        await pipeline(download.stream, res);
    } catch (error) {
        next(error);
    } finally {
        await download?.close().catch(() => {});
    }
});

app.get('/api/plugin-storage/transition/stage/status', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    try {
        const transitionId = req.headers['x-plugin-storage-transition'];
        if (typeof transitionId !== 'string') return res.status(400).json({ error: 'Transition id required' });
        await queueStorageReadAfterImports(async () => {
            const stage = await refreshPluginTransitionStageState(
                readPluginTransitionStage(transitionId),
            );
            if (!pluginTransitionStageBelongsToRequest(stage, req)) {
                return res.status(404).json({ error: 'Transition not found' });
            }
            res.json(pluginTransitionStageResponse(stage));
        });
    } catch (error) {
        next(error);
    }
});

app.post('/api/plugin-storage/transition/stage/abort', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    try {
        const transitionId = req.headers['x-plugin-storage-transition'];
        if (typeof transitionId !== 'string') return res.status(400).json({ error: 'Transition id required' });
        await queueStorageMutation(async () => {
            const stage = await refreshPluginTransitionStageState(
                readPluginTransitionStage(transitionId),
            );
            if (!stage) return res.json({ success: true, state: 'aborted', transitionId });
            if (!pluginTransitionStageBelongsToRequest(stage, req)) {
                return res.status(404).json({ error: 'Transition not found' });
            }
            if (stage.state === 'committed') return res.json(pluginTransitionStageResponse(stage));
            stage.state = 'aborted';
            stage.updatedAt = Date.now();
            writePluginTransitionStage(stage);
            removePluginTransitionStageRows(stage);
            res.json(pluginTransitionStageResponse(stage));
        });
    } catch (error) {
        next(error);
    }
});

app.post('/api/plugin-storage/transition/stage/finalize', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    let databaseSpool = null;
    try {
        const transitionId = req.headers['x-plugin-storage-transition'];
        if (typeof transitionId !== 'string') return res.status(400).json({ error: 'Transition id required' });
        await queueStorageMutation(async () => {
            let stage = await refreshPluginTransitionStageState(
                readPluginTransitionStage(transitionId),
            );
            if (!pluginTransitionStageBelongsToRequest(stage, req)) {
                return res.status(404).json({ error: 'Transition not found' });
            }
            if (stage.state === 'committed') return res.json(pluginTransitionStageResponse(stage));
            if (stage.state !== 'ready' || stage.rows.some(row => !row.uploaded)) {
                return res.status(409).json({ error: 'Transition rows are incomplete' });
            }
            await flushPendingDb();
            const rawDatabase = kvGet('database/database.bin');
            if (!rawDatabase) return res.status(409).json({ error: 'Database not found' });
            const liveDb = await decodeAuthoritativeDatabase(rawDatabase);
            const manifestState = readPluginStorageManifestState();
            try {
                assertPluginStorageSource(stage.source, liveDb, manifestState);
            } catch (error) {
                if (error?.pluginStorageConflict) {
                    return res.status(409).json({ error: error.message, currentEtag: dbEtag });
                }
                throw error;
            }
            const currentEtag = dbEtag ?? computeBufferEtag(rawDatabase);
            if (currentEtag !== stage.sourceEtag) {
                return res.status(409).json({ error: 'Database changed during transition', currentEtag });
            }
            if (stage.targetOptimized) {
                try {
                    assertInlineTransitionSourceHashes(liveDb, stage.sourceRowHashes);
                } catch {
                    return res.status(409).json({ error: 'Inline plugin storage changed during transition' });
                }
            } else {
                for (const sourceRow of stage.sourceRowHashes) {
                    let matches = false;
                    try {
                        matches = await pluginTransitionKvRowMatches(
                            sourceRow.storageKey,
                            sourceRow,
                            () => req.aborted || res.destroyed,
                        );
                    } catch {}
                    if (!matches) {
                        return res.status(409).json({ error: 'Plugin row changed during transition' });
                    }
                }
            }
            const sourceKeys = resolveOwnedPluginStorageKeys(liveDb);
            if (!stage.targetOptimized) await assertInternalTransitionBounds(liveDb, sourceKeys);
            const targetDb = {
                ...liveDb,
                optimizePluginMemory: stage.targetOptimized,
                [PLUGIN_STORAGE_GENERATION_FIELD]: stage.targetGeneration,
            };
            delete targetDb[PLUGIN_STORAGE_FOLDED_MARKER];
            let pluginStorage = null;
            if (stage.targetOptimized) {
                targetDb.pluginCustomStorage = {};
                delete targetDb.pluginStorageMeta;
            } else {
                pluginStorage = {
                    valueRows: stage.rows
                        .filter(row => row.storageKey.startsWith(PLUGIN_SAVE_PREFIX))
                        .map(row => ({
                            key: row.rawKey,
                            source: row.index,
                        })),
                    metaRows: stage.rows
                        .filter(row => row.storageKey.startsWith(PLUGIN_SAVE_META_PREFIX))
                        .map(row => ({
                            key: row.rawKey,
                            source: row.index,
                        })),
                    rowSource: index => {
                        const row = stage.rows[index];
                        return {
                            filePath: pluginTransitionStageRowPath(transitionId, index),
                            size: row.size,
                        };
                    },
                };
            }
            const spoolPath = path.join(
                databaseSpoolDir,
                `${DATABASE_SPOOL_FILE_PREFIX}${process.pid}-${nodeCrypto.randomUUID()}.transition`,
            );
            databaseSpool = await streamRisuSaveToFile({
                dbObj: targetDb,
                filePath: spoolPath,
                readChatRow: async () => null,
                foldChatRows: false,
                pluginStorage,
            });
            const resultEtag = await computeFileEtag(databaseSpool.filePath);
            const targetManifest = pluginTransitionDesiredManifest(stage);
            const targetKeys = new Set([
                ...(targetManifest?.valueKeys ?? []),
                ...(targetManifest?.metaKeys ?? []),
            ]);
            const quotaChanges = new Map(
                sourceKeys.valueKeys.map(key => [key, { key, size: null }]),
            );
            if (stage.targetOptimized) {
                for (const row of stage.rows) {
                    if (row.storageKey.startsWith(PLUGIN_SAVE_PREFIX)) {
                        quotaChanges.set(row.storageKey, { key: row.storageKey, size: row.size });
                    }
                }
            }
            const recoverySnapshotToken = newPluginRecoverySnapshotToken();
            for (const row of stage.rows) {
                const filePath = pluginTransitionStageRowPath(transitionId, row.index);
                const stat = await fs.stat(filePath);
                if (!stat.isFile()
                    || stat.size !== row.size
                    || await computeFileSha256(filePath) !== row.sha256) {
                    return res.status(409).json({ error: 'Staged transition row changed' });
                }
            }
            withPluginStorageQuotaPlan([...quotaChanges.values()], () => {
                if (stage.targetOptimized) {
                    for (const row of stage.rows) {
                        kvSetFromFile(
                            row.storageKey,
                            pluginTransitionStageRowPath(transitionId, row.index),
                            row.storageKey.startsWith(PLUGIN_SAVE_PREFIX)
                                ? { pluginStorageDisplaySize: row.displaySize }
                                : {},
                        );
                        maybeFailPluginStorageTransaction(req, 'after-row');
                    }
                }
                for (const storageKey of [...sourceKeys.valueKeys, ...sourceKeys.metaKeys]) {
                    if (targetKeys.has(storageKey)) continue;
                    kvDel(storageKey);
                    maybeFailPluginStorageTransaction(req, 'after-row');
                }
                if (targetManifest) writePluginStorageManifest(targetManifest);
                else kvDel(PLUGIN_STORAGE_MANIFEST_KEY);
                maybeFailPluginStorageTransaction(req, 'after-manifest');
                kvSetFromFile('database/database.bin', databaseSpool.filePath);
                maybeFailPluginStorageTransaction(req, 'after-database');
                markPluginRecoverySnapshotDirty(recoverySnapshotToken);
            });
            invalidateDbCache();
            dbEtag = resultEtag;
            rememberSessionPluginStorageState(req, targetDb);
            schedulePluginRecoverySnapshot();
            // Exercise the hardest acknowledgement window: publication is
            // durable but the private receipt still says ready. Status (or
            // startup reconciliation after a crash) must infer the commit
            // from the authoritative mode/generation/manifest tuple.
            if (req.headers['x-plugin-storage-failpoint'] === 'acknowledgement-loss') {
                res.socket?.destroy();
                return;
            }
            stage.state = 'committed';
            stage.resultEtag = resultEtag;
            stage.updatedAt = Date.now();
            writePluginTransitionStage(stage);
            removePluginTransitionStageRows(stage);
            res.json(pluginTransitionStageResponse(stage));
        });
    } catch (error) {
        if (isImportInProgressError(error)) return sendImportBusy(res);
        next(error);
    } finally {
        if (databaseSpool) await fs.unlink(databaseSpool.filePath).catch(() => {});
    }
});

class PluginStorageTransitionRequestError extends Error {
    constructor(status, message, code = 'PLUGIN_STORAGE_CHANGED') {
        super(message);
        this.name = 'PluginStorageTransitionRequestError';
        this.status = status;
        this.code = code;
    }
}

/**
 * Commit a ready private stage without owning the HTTP response. The bulk
 * transition route and the staged finalize route share the same publication
 * invariants; this helper lets the bulk route complete in its one request.
 */
async function commitReadyPluginStorageTransition(stage, req) {
    let databaseSpool = null;
    try {
        await flushPendingDb();
        const rawDatabase = kvGet('database/database.bin');
        if (!rawDatabase) {
            throw new PluginStorageTransitionRequestError(409, 'Database not found');
        }
        const liveDb = await decodeAuthoritativeDatabase(rawDatabase);
        const manifestState = readPluginStorageManifestState();
        try {
            assertPluginStorageSource(stage.source, liveDb, manifestState);
        } catch (error) {
            if (error?.pluginStorageConflict) {
                throw new PluginStorageTransitionRequestError(409, error.message);
            }
            throw error;
        }
        const currentEtag = dbEtag ?? computeBufferEtag(rawDatabase);
        dbEtag = currentEtag;
        if (currentEtag !== stage.sourceEtag) {
            throw new PluginStorageTransitionRequestError(
                409,
                'Database changed during transition',
            );
        }
        if (stage.targetOptimized) {
            if (stage.sourceKind !== 'client-inline-snapshot') {
                try {
                    assertInlineTransitionSourceHashes(liveDb, stage.sourceRowHashes);
                } catch {
                    throw new PluginStorageTransitionRequestError(
                        409,
                        'Inline plugin storage changed during transition',
                    );
                }
            }
        } else {
            for (const sourceRow of stage.sourceRowHashes) {
                let matches = false;
                try {
                    matches = await pluginTransitionKvRowMatches(
                        sourceRow.storageKey,
                        sourceRow,
                        () => req.aborted,
                    );
                } catch {}
                if (!matches) {
                    throw new PluginStorageTransitionRequestError(
                        409,
                        'Plugin row changed during transition',
                    );
                }
            }
        }

        const sourceKeys = resolveOwnedPluginStorageKeys(liveDb);
        if (!stage.targetOptimized) await assertInternalTransitionBounds(liveDb, sourceKeys);
        const targetDb = {
            ...liveDb,
            optimizePluginMemory: stage.targetOptimized,
            [PLUGIN_STORAGE_GENERATION_FIELD]: stage.targetGeneration,
        };
        delete targetDb[PLUGIN_STORAGE_FOLDED_MARKER];
        let pluginStorage = null;
        if (stage.targetOptimized) {
            targetDb.pluginCustomStorage = {};
            delete targetDb.pluginStorageMeta;
        } else {
            pluginStorage = {
                valueRows: stage.rows
                    .filter(row => row.storageKey.startsWith(PLUGIN_SAVE_PREFIX))
                    .map(row => ({ key: row.rawKey, source: row.index })),
                metaRows: stage.rows
                    .filter(row => row.storageKey.startsWith(PLUGIN_SAVE_META_PREFIX))
                    .map(row => ({ key: row.rawKey, source: row.index })),
                rowSource: index => {
                    const row = stage.rows[index];
                    return {
                        filePath: pluginTransitionStageRowPath(stage.transitionId, index),
                        size: row.size,
                    };
                },
            };
        }

        const spoolPath = path.join(
            databaseSpoolDir,
            `${DATABASE_SPOOL_FILE_PREFIX}${process.pid}-${nodeCrypto.randomUUID()}.transition`,
        );
        databaseSpool = await streamRisuSaveToFile({
            dbObj: targetDb,
            filePath: spoolPath,
            readChatRow: async () => null,
            foldChatRows: false,
            pluginStorage,
        });
        const resultEtag = await computeFileEtag(databaseSpool.filePath);
        const targetManifest = pluginTransitionDesiredManifest(stage);
        const targetKeys = new Set([
            ...(targetManifest?.valueKeys ?? []),
            ...(targetManifest?.metaKeys ?? []),
        ]);
        const quotaChanges = new Map(
            sourceKeys.valueKeys.map(key => [key, { key, size: null }]),
        );
        if (stage.targetOptimized) {
            for (const row of stage.rows) {
                if (row.storageKey.startsWith(PLUGIN_SAVE_PREFIX)) {
                    quotaChanges.set(row.storageKey, {
                        key: row.storageKey,
                        size: row.size,
                    });
                }
            }
        }
        const recoverySnapshotToken = newPluginRecoverySnapshotToken();
        for (const row of stage.rows) {
            const filePath = pluginTransitionStageRowPath(stage.transitionId, row.index);
            const stat = await fs.stat(filePath);
            if (!stat.isFile()
                || stat.size !== row.size
                || await computeFileSha256(filePath) !== row.sha256) {
                throw new PluginStorageTransitionRequestError(
                    409,
                    'Staged transition row changed',
                );
            }
        }
        withPluginStorageQuotaPlan([...quotaChanges.values()], () => {
            if (stage.targetOptimized) {
                for (const row of stage.rows) {
                    kvSetFromFile(
                        row.storageKey,
                        pluginTransitionStageRowPath(stage.transitionId, row.index),
                        row.storageKey.startsWith(PLUGIN_SAVE_PREFIX)
                            ? { pluginStorageDisplaySize: row.displaySize }
                            : {},
                    );
                    maybeFailPluginStorageTransaction(req, 'after-row');
                }
            }
            for (const storageKey of [...sourceKeys.valueKeys, ...sourceKeys.metaKeys]) {
                if (targetKeys.has(storageKey)) continue;
                kvDel(storageKey);
                maybeFailPluginStorageTransaction(req, 'after-row');
            }
            if (targetManifest) writePluginStorageManifest(targetManifest);
            else kvDel(PLUGIN_STORAGE_MANIFEST_KEY);
            maybeFailPluginStorageTransaction(req, 'after-manifest');
            kvSetFromFile('database/database.bin', databaseSpool.filePath);
            maybeFailPluginStorageTransaction(req, 'after-database');
            markPluginRecoverySnapshotDirty(recoverySnapshotToken);
        });
        invalidateDbCache();
        dbEtag = resultEtag;
        rememberSessionPluginStorageState(req, targetDb);
        schedulePluginRecoverySnapshot();
        stage.state = 'committed';
        stage.resultEtag = resultEtag;
        stage.updatedAt = Date.now();
        writePluginTransitionStage(stage);
        removePluginTransitionStageRows(stage);
        return {
            ...pluginTransitionStageResponse(stage),
            values: stage.rows.filter(row => row.storageKey.startsWith(PLUGIN_SAVE_PREFIX)).length,
            meta: stage.rows.filter(row => row.storageKey.startsWith(PLUGIN_SAVE_META_PREFIX)).length,
        };
    } finally {
        if (databaseSpool) await fs.unlink(databaseSpool.filePath).catch(() => {});
    }
}

function writeDurablePluginTransitionRowBuffer(transitionId, index, bytes) {
    const filePath = pluginTransitionStageRowPath(transitionId, index);
    const temporaryPath = `${filePath}.${nodeCrypto.randomUUID()}.tmp`;
    try {
        writeFileSync(temporaryPath, bytes, { flag: 'wx', mode: 0o600 });
        const fileDescriptor = openSync(temporaryPath, 'r');
        try {
            fsyncSync(fileDescriptor);
        } finally {
            closeSync(fileDescriptor);
        }
        renameSync(temporaryPath, filePath);
        fsyncPluginTransitionStageDirectory();
    } catch (error) {
        try { unlinkSync(temporaryPath); } catch {}
        throw error;
    }
}

class UnsupportedPluginStorageTransitionValue {
    constructor() {
        this.kind = 'function';
    }
}

addExtension({
    type: 63,
    unpack: bytes => {
        if (bytes.length !== 1 || bytes[0] !== 1) {
            throw new TypeError('Invalid plugin transition function marker');
        }
        return new UnsupportedPluginStorageTransitionValue();
    },
});

const richPluginTransitionUnpackr = new Unpackr({
    structuredClone: true,
    useRecords: true,
});

async function receiveBulkPluginStorageTransition(req) {
    if (!databaseSpoolReady) {
        const error = new PluginStorageTransitionRequestError(
            503,
            'The server transition spool is unavailable; check the save volume permissions.',
            'PLUGIN_STORAGE_SPOOL_UNAVAILABLE',
        );
        error.retryable = true;
        throw error;
    }
    const declaredText = Array.isArray(req.headers['x-plugin-storage-transition-length'])
        ? req.headers['x-plugin-storage-transition-length'][0]
        : req.headers['x-plugin-storage-transition-length'];
    const declaredLength = typeof declaredText === 'string' ? Number(declaredText) : NaN;
    const contentLength = Number(req.headers['content-length']);
    const maximumLength = PLUGIN_STORAGE_TRANSITION_STREAM_PREFIX_BYTES
        + PLUGIN_STORAGE_TRANSITION_STREAM_MAX_METADATA_BYTES
        + PLUGIN_STORAGE_TRANSITION_STREAM_MAX_PAYLOAD_BYTES;
    if (!Number.isSafeInteger(declaredLength) || declaredLength <= 0
        || declaredLength > maximumLength
        || (Number.isSafeInteger(contentLength) && contentLength !== declaredLength)) {
        throw new PluginStorageTransitionRequestError(
            declaredLength > maximumLength ? 413 : 400,
            'Bulk plugin transition requires an exact bounded length.',
            'PLUGIN_STORAGE_SIZE_LIMIT',
        );
    }

    const reader = createPluginStorageBatchRequestReader(req);
    const prefix = await reader.readBuffer(PLUGIN_STORAGE_TRANSITION_STREAM_PREFIX_BYTES);
    if (!prefix.subarray(0, PLUGIN_STORAGE_TRANSITION_STREAM_MAGIC.length)
        .equals(PLUGIN_STORAGE_TRANSITION_STREAM_MAGIC)) {
        throw new PluginStorageTransitionRequestError(400, 'Invalid bulk transition magic header');
    }
    const metadataLength = prefix.readUInt32BE(PLUGIN_STORAGE_TRANSITION_STREAM_MAGIC.length);
    if (metadataLength < 1
        || metadataLength > PLUGIN_STORAGE_TRANSITION_STREAM_MAX_METADATA_BYTES) {
        throw new PluginStorageTransitionRequestError(
            413,
            'Bulk transition metadata exceeds its limit.',
            'PLUGIN_STORAGE_SIZE_LIMIT',
        );
    }
    const metadataBytes = await reader.readBuffer(metadataLength);
    const metadataText = metadataBytes.toString('utf-8');
    if (!Buffer.from(metadataText, 'utf-8').equals(metadataBytes)) {
        throw new PluginStorageTransitionRequestError(400, 'Bulk transition metadata must be UTF-8 JSON');
    }
    let metadata;
    try {
        metadata = JSON.parse(metadataText);
    } catch {
        throw new PluginStorageTransitionRequestError(
            400,
            'Bulk transition metadata must be valid JSON',
        );
    }
    if (!Buffer.from(JSON.stringify(metadata), 'utf-8').equals(metadataBytes)) {
        throw new PluginStorageTransitionRequestError(400, 'Bulk transition metadata must be canonical JSON');
    }
    const allowedKeys = new Set([
        'version',
        'transitionId',
        'source',
        'targetOptimized',
        'targetGeneration',
        'expectedEtag',
        'autoConvert',
        'rows',
    ]);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
        || Object.keys(metadata).some(key => !allowedKeys.has(key))
        || metadata.version !== 1
        || !PLUGIN_STORAGE_UUID_PATTERN.test(metadata.transitionId)
        || !PLUGIN_STORAGE_UUID_PATTERN.test(metadata.targetGeneration)
        || typeof metadata.targetOptimized !== 'boolean'
        || typeof metadata.autoConvert !== 'boolean'
        || (metadata.expectedEtag !== undefined
            && (typeof metadata.expectedEtag !== 'string'
                || !/^[0-9a-f]{32}$/.test(metadata.expectedEtag)))
        || !Array.isArray(metadata.rows)
        || metadata.rows.length > PLUGIN_STORAGE_TRANSITION_STREAM_MAX_ENTRIES
        || (!metadata.targetOptimized && metadata.rows.length !== 0)) {
        throw new PluginStorageTransitionRequestError(400, 'Invalid bulk plugin transition metadata');
    }
    const parsedManifest = metadata.source?.manifest === null
        ? null
        : parsePluginStorageManifest(metadata.source?.manifest);
    if (!metadata.source || typeof metadata.source !== 'object'
        || Array.isArray(metadata.source)
        || typeof metadata.source.optimized !== 'boolean'
        || !(metadata.source.generation === null
            || typeof metadata.source.generation === 'string')
        || (metadata.source.manifest !== null && parsedManifest === null)
        || metadata.targetOptimized === metadata.source.optimized) {
        throw new PluginStorageTransitionRequestError(400, 'Invalid bulk transition source');
    }
    if (readPluginTransitionStage(metadata.transitionId)) {
        throw new PluginStorageTransitionRequestError(
            409,
            'Transition id is already active',
        );
    }

    let payloadBytes = 0;
    const descriptors = metadata.rows.map((row, index) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)
            || Object.keys(row).length !== 4
            || typeof row.rawKey !== 'string'
            || typeof row.storageKey !== 'string'
            || !Number.isSafeInteger(row.valueLength)
            || row.valueLength < 1
            || row.valueLength > PLUGIN_TRANSITION_MAX_ROW_BYTES
            || typeof row.valueHash !== 'string'
            || !/^[0-9a-f]{64}$/.test(row.valueHash)) {
            throw new PluginStorageTransitionRequestError(400, `Invalid bulk transition row ${index}`);
        }
        const prefixForRow = row.storageKey.startsWith(PLUGIN_SAVE_META_PREFIX)
            ? PLUGIN_SAVE_META_PREFIX
            : row.storageKey.startsWith(PLUGIN_SAVE_PREFIX)
                ? PLUGIN_SAVE_PREFIX
                : null;
        if (!prefixForRow
            || encodePluginSaveStorageKey(row.rawKey, prefixForRow) !== row.storageKey) {
            throw new PluginStorageTransitionRequestError(400, `Invalid bulk transition key ${index}`);
        }
        payloadBytes += row.valueLength;
        if (!Number.isSafeInteger(payloadBytes)
            || payloadBytes > PLUGIN_STORAGE_TRANSITION_STREAM_MAX_PAYLOAD_BYTES) {
            throw new PluginStorageTransitionRequestError(
                413,
                'Bulk transition payload exceeds its limit.',
                'PLUGIN_STORAGE_TOTAL_TOO_LARGE',
            );
        }
        return { ...row, index, prefix: prefixForRow };
    });
    if (new Set(descriptors.map(row => row.storageKey)).size !== descriptors.length) {
        throw new PluginStorageTransitionRequestError(400, 'Bulk transition keys must be unique');
    }
    const expectedLength = PLUGIN_STORAGE_TRANSITION_STREAM_PREFIX_BYTES
        + metadataLength
        + payloadBytes;
    if (expectedLength !== declaredLength) {
        throw new PluginStorageTransitionRequestError(400, 'Bulk transition length does not match metadata');
    }

    const rows = [];
    try {
        for (const descriptor of descriptors) {
            const encoded = await reader.readBuffer(descriptor.valueLength);
            if (sha256Hex(encoded) !== descriptor.valueHash) {
                throw new PluginStorageTransitionRequestError(400, 'Bulk transition row failed its hash check');
            }
            let richValue;
            try {
                richValue = richPluginTransitionUnpackr.decode(encoded);
            } catch {
                throw new PluginStorageTransitionRequestError(
                    400,
                    'Bulk transition row is not valid structured-clone MessagePack.',
                    'PLUGIN_STORAGE_VALUE_UNSUPPORTED',
                );
            }
            let jsonBytes;
            let jsonValue = richValue;
            try {
                jsonBytes = serializePluginStorageRow(descriptor.storageKey, jsonValue);
            } catch (strictError) {
                if (!metadata.autoConvert || descriptor.prefix === PLUGIN_SAVE_META_PREFIX) {
                    throw strictError;
                }
                try {
                    jsonValue = convertCompatiblePluginStorageJson(richValue);
                    try {
                        jsonBytes = serializePluginStorageRow(descriptor.storageKey, jsonValue);
                    } catch {
                        jsonBytes = serializeLosslessPluginStorageRow(
                            descriptor.storageKey,
                            jsonValue,
                        );
                    }
                } catch {
                    throw strictError;
                }
            }
            if (jsonBytes.length > PLUGIN_TRANSITION_MAX_ROW_BYTES) {
                throw new PluginStorageLimitError(
                    `Plugin transition row exceeds the ${PLUGIN_TRANSITION_MAX_ROW_BYTES}-byte transition limit.`,
                    {
                        code: 'PLUGIN_VALUE_TOO_LARGE',
                        limit: PLUGIN_TRANSITION_MAX_ROW_BYTES,
                        actual: jsonBytes.length,
                    },
                );
            }
            writeDurablePluginTransitionRowBuffer(
                metadata.transitionId,
                descriptor.index,
                jsonBytes,
            );
            const stagedSha256 = sha256Hex(jsonBytes);
            rows.push({
                index: descriptor.index,
                storageKey: descriptor.storageKey,
                rawKey: descriptor.rawKey,
                size: jsonBytes.length,
                sha256: stagedSha256,
                stagedSha256,
                displaySize: descriptor.prefix === PLUGIN_SAVE_PREFIX
                    ? pluginStorageViewerDisplaySize(jsonValue)
                    : null,
                uploaded: true,
            });
        }
        await reader.assertEnd();
        return {
            metadata: {
                ...metadata,
                source: {
                    ...metadata.source,
                    manifest: parsedManifest,
                },
            },
            metadataBytes,
            rows,
        };
    } catch (error) {
        removePluginTransitionStage({ transitionId: metadata.transitionId, rows });
        if (isPluginStorageValidationError(error)) {
            throw new PluginStorageTransitionRequestError(
                400,
                'Some existing plugin data cannot be moved into optimized storage because it is not JSON-compatible. Turn optimization off and update or reset the affected plugin, or ask its developer to store only null, booleans, finite numbers, strings, dense arrays, and plain objects.',
                'PLUGIN_STORAGE_VALUE_UNSUPPORTED',
            );
        }
        throw error;
    }
}

app.post('/api/plugin-storage/transition/bulk', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    let received;
    let stage = null;
    try {
        received = await receiveBulkPluginStorageTransition(req);
        const plan = received.metadata;
        await queueStorageMutation(async () => {
            await flushPendingDb();
            const rawDatabase = kvGet('database/database.bin');
            if (!rawDatabase) {
                throw new PluginStorageTransitionRequestError(409, 'Database not found');
            }
            const currentEtag = dbEtag ?? computeBufferEtag(rawDatabase);
            dbEtag = currentEtag;
            const liveDb = await decodeAuthoritativeDatabase(rawDatabase);
            const manifestState = readPluginStorageManifestState();
            try {
                assertPluginStorageSource(plan.source, liveDb, manifestState);
            } catch (error) {
                if (error?.pluginStorageConflict) {
                    throw new PluginStorageTransitionRequestError(409, error.message);
                }
                throw error;
            }
            if (plan.expectedEtag && plan.expectedEtag !== currentEtag) {
                throw new PluginStorageTransitionRequestError(409, 'ETag mismatch');
            }
            if (plan.targetGeneration === pluginStorageGeneration(liveDb)) {
                throw new PluginStorageTransitionRequestError(
                    400,
                    'Transition target must use a fresh generation',
                );
            }
            const existing = await refreshPluginTransitionStageState(
                readPluginTransitionStage(plan.transitionId),
            );
            if (existing) {
                if (!pluginTransitionStageBelongsToRequest(existing, req)) {
                    throw new PluginStorageTransitionRequestError(404, 'Transition not found');
                }
                if (existing.state === 'committed') {
                    removePluginTransitionStageRows(existing);
                    return res.json({
                        ...pluginTransitionStageResponse(existing),
                        values: existing.rows.filter(row => row.storageKey.startsWith(PLUGIN_SAVE_PREFIX)).length,
                        meta: existing.rows.filter(row => row.storageKey.startsWith(PLUGIN_SAVE_META_PREFIX)).length,
                    });
                }
                throw new PluginStorageTransitionRequestError(409, 'Transition id is already active');
            }
            const activeStage = await findActivePluginTransition(req, plan.transitionId);
            if (activeStage) {
                throw new PluginStorageTransitionRequestError(
                    409,
                    'Another plugin storage transition is already active',
                );
            }

            let rows = received.rows;
            let sourceRowHashes;
            if (plan.targetOptimized) {
                const totalConvertedBytes = rows.reduce((sum, row) => sum + row.size, 0);
                const required = totalConvertedBytes * 3 + (kvSize('database/database.bin') ?? 0) * 2;
                if (!Number.isSafeInteger(required)) {
                    throw new PluginStorageLimitError(
                        'Plugin transition disk requirement is too large.',
                        {
                            code: 'PLUGIN_STORAGE_DISK_LIMIT',
                            limit: Number.MAX_SAFE_INTEGER,
                            actual: required,
                        },
                    );
                }
                const disk = await checkDiskSpace(required);
                if (!disk.ok) {
                    throw new PluginStorageLimitError(
                        `Plugin transition requires ${required} free bytes.`,
                        {
                            code: 'PLUGIN_STORAGE_DISK_LIMIT',
                            limit: disk.available,
                            actual: required,
                        },
                    );
                }
                sourceRowHashes = rows.map(row => ({
                    storageKey: row.storageKey,
                    size: row.size,
                    sha256: row.sha256,
                    backend: 'bulk',
                }));
            } else {
                const sourceKeys = resolveOwnedPluginStorageKeys(liveDb);
                await assertInternalTransitionBounds(liveDb, sourceKeys);
                rows = [];
                for (const storageKey of [...sourceKeys.valueKeys, ...sourceKeys.metaKeys]) {
                    const index = rows.length;
                    const prefixForRow = storageKey.startsWith(PLUGIN_SAVE_META_PREFIX)
                        ? PLUGIN_SAVE_META_PREFIX
                        : PLUGIN_SAVE_PREFIX;
                    const rawKey = sourceKeys.manifest
                        ? decodeManifestPluginSaveStorageKey(
                            sourceKeys.manifest,
                            storageKey,
                            prefixForRow,
                        )
                        : decodeValidatedPluginStorageKey(storageKey, prefixForRow);
                    const staged = await writeDurablePluginTransitionStageRow(
                        storageKey,
                        pluginTransitionStageRowPath(plan.transitionId, index),
                        () => req.aborted,
                    );
                    rows.push({
                        index,
                        storageKey,
                        rawKey,
                        size: staged.size,
                        sha256: staged.sha256,
                        stagedSha256: staged.sha256,
                        displaySize: staged.displaySize,
                        uploaded: true,
                    });
                }
                sourceRowHashes = rows.map(row => ({
                    storageKey: row.storageKey,
                    size: row.size,
                    sha256: row.sha256,
                    backend: 'kv',
                }));
            }
            stage = {
                version: 1,
                transitionId: plan.transitionId,
                sessionId: typeof req.headers['x-session-id'] === 'string'
                    ? req.headers['x-session-id']
                    : null,
                requestHash: sha256Hex(received.metadataBytes),
                source: plan.source,
                sourceEtag: currentEtag,
                sourceKind: plan.targetOptimized ? 'client-inline-snapshot' : 'server-optimized',
                sourceRowHashes,
                targetOptimized: plan.targetOptimized,
                targetGeneration: plan.targetGeneration,
                rows,
                state: 'ready',
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
            writePluginTransitionStage(stage);
            const result = await commitReadyPluginStorageTransition(stage, req);
            if (req.headers['x-plugin-storage-failpoint'] === 'acknowledgement-loss') {
                res.socket?.destroy();
                return;
            }
            res.json(result);
        });
    } catch (error) {
        if (stage?.state !== 'committed') {
            removePluginTransitionStage(stage ?? (
                received?.metadata?.transitionId
                    ? { transitionId: received.metadata.transitionId, rows: received.rows }
                    : null
            ));
        } else removePluginTransitionStageRows(stage);
        if (isImportInProgressError(error)) return sendImportBusy(res);
        if (error instanceof PluginStorageTransitionRequestError) {
            return res.status(error.status).json({
                success: false,
                outcome: 'not-committed',
                operation: 'transition',
                error: error.message,
                code: error.code,
                retryable: error.retryable === true,
            });
        }
        if (error instanceof PluginStorageLimitError) {
            return res.status(error.status || 413).json({
                success: false,
                outcome: 'not-committed',
                operation: 'transition',
                error: error.message,
                code: error.code,
                limit: error.limit,
                actual: error.actual,
                retryable: false,
            });
        }
        next(error);
    }
});

app.post('/api/plugin-storage/transition', async (req, res) => {
    if (!await checkAuth(req, res)) return;
    return sendClientUpgradeRequired(
        res,
        req[BUFFERED_INGRESS_POLICY] ?? { responseKind: 'generic' },
        expectedClientBuild,
        'This plugin storage transition protocol is retired. Reload to continue.',
    );
});

// Provider request history and token-usage statistics use their own rotated DB;
// this deliberately coexists with logs.cjs system logging and redaction.
const requestLogs = createRequestLogs({ saveDir: savePath });
requestLogs.registerRoutes(app, { auth: checkAuth, activeSession: checkActiveSession });

async function writePrivateAdmittedStageFile(filePath, value) {
    const handle = await fs.open(filePath, 'wx', 0o600);
    try {
        await handle.writeFile(value);
        await handle.sync();
    } finally {
        await handle.close();
    }
    return { filePath, size: (await fs.stat(filePath)).size };
}

async function prepareChunkPlanWithFallback(filePath, label) {
    try {
        return await prepareFileChunkPlan(filePath, {
            forceFailure: process.env.NODE_ENV === 'test'
                && process.env.POCKETRISU_TEST_CHUNK_WORKER_FAIL === '1',
        });
    } catch (error) {
        logger.warn(
            `[ChunkPlan] ${label} worker preparation failed; using synchronous file publication:`,
            error?.message || error,
        );
        return null;
    }
}

async function hashFile(filePath, algorithm) {
    const digest = nodeCrypto.createHash(algorithm);
    for await (const chunk of createReadStream(filePath)) digest.update(chunk);
    return digest.digest('hex');
}

async function waitAtAdmittedWritePublishTestGate(kind) {
    if (process.env.NODE_ENV !== 'test') return;
    const gateDir = String(process.env.POCKETRISU_TEST_ADMITTED_WRITE_GATE_DIR ?? '').trim();
    if (!gateDir) return;
    const holdPath = path.join(gateDir, 'hold');
    if (!existsSync(holdPath)) return;
    await fs.mkdir(gateDir, { recursive: true });
    await fs.writeFile(path.join(gateDir, 'entered'), kind, 'utf-8');
    const releasePath = path.join(gateDir, 'release');
    while (existsSync(holdPath) && !existsSync(releasePath)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

async function decodeDatabaseSpoolForWrite(spool, stageDir, chatRows) {
    const source = { filePath: spool.filePath, size: spool.size };
    const inspection = await inspectRisuSaveSource(source);
    if (!inspection.supported) {
        // Preserve legacy/block/unknown compatibility only under the same
        // finite in-memory ceiling used by imports/restores. Headerless
        // compressed fallbacks still expand to a 64 KiB-paged private file
        // before the bounded compatibility decoder materializes them.
        return decodeBoundedLegacyRisuSave(source, {
            inspection,
            tempDir: databaseSpoolDir,
            maxLegacyBytes: LEGACY_DATABASE_IMPORT_MAX_BYTES,
            resolveRemoteSize: async (name) => kvSize(`remotes/${name}.local.bin`),
            resolveRemote: async (name) => kvGet(`remotes/${name}.local.bin`),
        });
    }
    const streamedPluginValues = Object.create(null);
    const streamedPluginMeta = Object.create(null);
    const walked = await walkRisuSave(source, {
        inspection,
        tempDir: databaseSpoolDir,
        externalizePluginStorage: true,
        onPluginStorageFolded: async () => {},
        onPluginStorageEntry: async ({ field, key, value }) => {
            Object.defineProperty(
                field === 'pluginStorageMeta' ? streamedPluginMeta : streamedPluginValues,
                key,
                { configurable: true, enumerable: true, value, writable: true },
            );
        },
        onMissingChatId: () => nodeCrypto.randomUUID(),
        retainCharacterChats: () => false,
        onChat: async ({ character, chat, externalizable }) => {
            if (!externalizable || !Array.isArray(chat?.message)) return chat;
            const payload = { ...chat };
            if (payload._stub === true) delete payload._stub;
            const index = chatRows.length;
            const filePath = path.join(stageDir, `chat-${index}.bin`);
            const bytes = Buffer.from(encodeRisuSaveLegacy(payload));
            await writePrivateAdmittedStageFile(filePath, bytes);
            chatRows.push({
                chaId: character.chaId,
                chatId: payload.id,
                filePath,
                coldStorage: isColdStorageChat(payload),
                messageCount: payload.message.length,
                logSupported: true,
            });
            return chatRowStore.chatToStub(payload);
        },
    });
    if (walked.pluginStats.changed) {
        walked.remainder.pluginCustomStorage = streamedPluginValues;
        if (walked.pluginStats.hasMetaField) {
            walked.remainder.pluginStorageMeta = streamedPluginMeta;
        }
    }
    if (walked.pluginStats.markerPresent) {
        walked.remainder[PLUGIN_STORAGE_FOLDED_MARKER] = walked.pluginStats.folded;
    }
    return walked.remainder;
}

async function prepareSpooledDatabaseWrite(spool) {
    const stageDir = await fs.mkdtemp(path.join(databaseSpoolDir, ADMITTED_WRITE_STAGE_PREFIX));
    const chatRows = [];
    try {
        const incomingDb = await decodeDatabaseSpoolForWrite(spool, stageDir, chatRows);
        const losses = findStubFlagLossChats(incomingDb);
        if (losses.length > 0) {
            const sample = losses.slice(0, 3)
                .map(loss => `${loss.chaId}/${loss.chatId ?? loss.chatIndex}`).join(', ');
            const error = new Error(
                `write aborted: ${losses.length} chat(s) lost _stub flag without upgrade — `
                + `would silently strip messages on disk. sample=[${sample}]`,
            );
            recordPersistFailure(error, '/api/write:stub-flag-loss');
            logger.error(`[Write] ${error.message}`);
            return {
                stageDir,
                refusal: { status: 500, body: { error: 'Write aborted: chat data integrity check failed' } },
            };
        }
        const duplicateChaIds = findDuplicateChaIds(incomingDb);
        if (duplicateChaIds.length > 0) {
            const sample = duplicateChaIds.slice(0, 3).join(', ');
            const error = new Error(
                `write aborted: ${duplicateChaIds.length} duplicate chaId value(s) — `
                + `would collapse distinct chat rows. sample=[${sample}]`,
            );
            recordPersistFailure(error, '/api/write:duplicate-cha-ids');
            logger.error(`[Write] ${error.message}`);
            return {
                stageDir,
                refusal: { status: 500, body: { error: 'Write aborted: chat data integrity check failed' } },
            };
        }
        const duplicateChatIds = findDuplicateChatIds(incomingDb);
        if (duplicateChatIds.length > 0) {
            const error = new Error(
                `write aborted: ${duplicateChatIds.length} duplicate chat id(s) — `
                + `would alias authoritative rows. sample=[${duplicateChatIdSample(duplicateChatIds)}]`,
            );
            recordPersistFailure(error, '/api/write:duplicate-chat-ids');
            logger.error(`[Write] ${error.message}`);
            return {
                stageDir,
                refusal: { status: 500, body: { error: 'Write aborted: chat data integrity check failed' } },
            };
        }

        const pluginExternalization = preparePluginStorageExternalization(incomingDb);
        const strippedDb = pluginExternalization.strippedDb;
        const normalizedDatabase = normalizeDecodedDatabaseForRead(strippedDb);
        const pluginRows = [];
        for (let index = 0; index < pluginExternalization.rows.length; index++) {
            const row = pluginExternalization.rows[index];
            const filePath = path.join(stageDir, `plugin-${index}.json`);
            await writePrivateAdmittedStageFile(filePath, row.value);
            const validated = validatePluginStorageRow(row.storageKey, row.value);
            pluginRows.push({
                storageKey: row.storageKey,
                filePath,
                displaySize: row.storageKey.startsWith(PLUGIN_SAVE_PREFIX)
                    ? pluginStorageViewerDisplaySize(validated)
                    : null,
            });
        }
        pluginExternalization.rows = pluginRows;

        const changed = chatRows.length > 0 || pluginExternalization.changed;
        let persistedPath = spool.filePath;
        let persistedSize = spool.size;
        if (changed) {
            persistedPath = path.join(stageDir, 'database.bin');
            const streamed = await streamRisuSaveToFile({
                dbObj: strippedDb,
                filePath: persistedPath,
                readChatRow: async () => null,
                foldChatRows: false,
            });
            persistedSize = streamed.size;
        }

        const planned = await Promise.all([
            prepareChunkPlanWithFallback(persistedPath, 'database write'),
            ...chatRows.map(row => prepareChunkPlanWithFallback(row.filePath, 'database chat row')),
            ...pluginRows.map(row => prepareChunkPlanWithFallback(row.filePath, 'database plugin row')),
        ]);
        const databasePlan = planned[0];
        for (let index = 0; index < chatRows.length; index++) {
            chatRows[index].chunkPlan = planned[index + 1];
        }
        for (let index = 0; index < pluginRows.length; index++) {
            pluginRows[index].chunkPlan = planned[index + 1 + chatRows.length];
        }
        const etag = databasePlan?.md5 ?? await hashFile(persistedPath, 'md5');
        return {
            stageDir,
            incomingDb,
            strippedDb,
            normalizedDatabase,
            chatRows,
            pluginExternalization,
            persistedPath,
            persistedSize,
            databasePlan,
            etag,
        };
    } catch (error) {
        if (isAdmittedSpoolPressureError(error)) {
            error.admittedWriteStageDir = stageDir;
            throw error;
        }
        const diagnostic = logPluginStorageValidationFailure(
            '[PluginStorage] Rejected invalid folded database row',
            error,
        );
        if (diagnostic) return { stageDir, refusal: { status: 400, body: diagnostic } };
        if (error instanceof PluginStorageLimitError) {
            error.admittedWriteStageDir = stageDir;
            throw error;
        }
        const preparationRefusal = risuSavePreparationRefusal(error);
        if (preparationRefusal) {
            return { stageDir, refusal: preparationRefusal };
        }
        logger.error('[Write] Failed to externalize database payloads:', error.message);
        if (error?.pluginStorageNamespaceConflict) {
            return { stageDir, refusal: { status: 409, body: { error: error.message } } };
        }
        return { stageDir, refusal: { status: 500, body: { error: 'Database write failed' } } };
    }
}

function writePreparedPluginStorageRows(rows) {
    for (const row of rows) {
        kvSetFromFile(row.storageKey, row.filePath, {
            chunkPlan: row.chunkPlan,
            ...(row.displaySize === null
                ? {}
                : { pluginStorageDisplaySize: row.displaySize }),
        });
    }
}

async function prepareSpooledChatWrite(spool) {
    let stageDir = null;
    try {
        let chatData;
        let logSupported = false;
        if (spool.bodyKind === 'raw') {
            const source = { filePath: spool.filePath, size: spool.size };
            try {
                const inspection = await inspectRisuSaveSource(source);
                logSupported = inspection.format === 'raw';
                chatData = inspection.supported
                    ? (await walkRisuSave(source, { inspection, tempDir: databaseSpoolDir })).remainder
                    : await decodeBoundedLegacyRisuSave(source, {
                        inspection,
                        tempDir: databaseSpoolDir,
                        maxLegacyBytes: LEGACY_DATABASE_IMPORT_MAX_BYTES,
                    });
            } catch (error) {
                if (error?.risuSavePreparationLimit === true) throw error;
                return { refusal: { status: 400, body: { error: 'Invalid binary chat data' } } };
            }
        } else {
            chatData = JSON.parse(await fs.readFile(spool.filePath, 'utf-8'));
        }
        if (!chatData) return { chatData };
        if (chatData._stub === true && !Array.isArray(chatData.message)) {
            return {
                refusal: { status: 400, body: { error: 'Bare chat stubs cannot be stored as chat content' } },
            };
        }
        let filePath = spool.filePath;
        if (spool.bodyKind !== 'raw' || chatData._stub === true) {
            if (chatData._stub === true) {
                chatData = { ...chatData };
                delete chatData._stub;
            }
            stageDir = await fs.mkdtemp(path.join(databaseSpoolDir, ADMITTED_WRITE_STAGE_PREFIX));
            filePath = path.join(stageDir, 'chat.bin');
            await writePrivateAdmittedStageFile(
                filePath,
                Buffer.from(encodeRisuSaveLegacy(chatData)),
            );
            logSupported = true;
        }
        const chunkPlan = await prepareChunkPlanWithFallback(filePath, 'chat write');
        return {
            chatData,
            filePath,
            stageDir,
            chunkPlan,
            contentHash: chunkPlan?.sha256 ?? null,
            coldStorage: isColdStorageChat(chatData),
            messageCount: Array.isArray(chatData.message) ? chatData.message.length : 0,
            logSupported,
        };
    } catch (error) {
        error.admittedWriteStageDir = stageDir;
        throw error;
    }
}

function verifyAssetHashFromDigest(key, digest) {
    const match = typeof key === 'string'
        ? key.match(/^assets\/([0-9a-f]{64})\.[A-Za-z0-9]{1,10}$/)
        : null;
    return match
        ? { claimed: match[1], actual: digest, ok: match[1] === digest }
        : { claimed: null, actual: null, ok: true };
}

function writeAssetValueFromSpool(key, spool, verification) {
    const name = assetNameForKey(key);
    if (name !== null && isSafeAssetName(name)) {
        if (verification.legacyHashMismatch) markLegacyHashAsset(name);
        const wrote = writeAssetFileFromFile(name, spool.filePath, {
            skipIfUnchanged: verification.claimed !== null,
        });
        if (verification.ok) clearLegacyHashAsset(name);
        kvDel(key);
        kvClearDeletion(key);
        assetGcCandidateStore.remove(key);
        return wrote;
    }
    kvSetFromFile(key, spool.filePath, { chunkPlan: spool.chunkPlan });
    assetGcCandidateStore.remove(key);
    return true;
}

async function prepareSpooledGenericKvWrite(key, spool) {
    let stageDir = null;
    let parsedInlay = null;
    let inlayPayloadPath = null;
    let parsedInlayInfo = null;
    try {
        if (key.startsWith(PLUGIN_SAVE_PREFIX) || key.startsWith(PLUGIN_SAVE_META_PREFIX)) {
            validatePluginStorageRow(key, await fs.readFile(spool.filePath));
        }
        if (key.startsWith('inlay/')) {
            const id = key.slice('inlay/'.length);
            parsedInlay = JSON.parse(await fs.readFile(spool.filePath, 'utf-8'));
            const type = typeof parsedInlay?.type === 'string' ? parsedInlay.type : 'image';
            const payload = type === 'signature'
                ? Buffer.from(typeof parsedInlay?.data === 'string' ? parsedInlay.data : '', 'utf-8')
                : decodeDataUri(parsedInlay?.data).buffer;
            stageDir = await fs.mkdtemp(path.join(databaseSpoolDir, ADMITTED_WRITE_STAGE_PREFIX));
            inlayPayloadPath = path.join(stageDir, 'inlay-payload');
            await writePrivateAdmittedStageFile(inlayPayloadPath, payload);
        } else if (key.startsWith('inlay_info/')) {
            parsedInlayInfo = JSON.parse(await fs.readFile(spool.filePath, 'utf-8'));
        }
        const chunkPlan = key.startsWith('inlay/') || key.startsWith('inlay_info/')
            ? null
            : await prepareChunkPlanWithFallback(spool.filePath, `KV write ${key}`);
        return {
            stageDir,
            chunkPlan,
            parsedInlay,
            inlayPayloadPath,
            parsedInlayInfo,
        };
    } catch (error) {
        error.admittedWriteStageDir = stageDir;
        throw error;
    }
}

async function handleSpooledKvWrite(req, res, next, {
    filePath,
    key,
    spool,
}) {
    let prepared = null;
    let shouldCreateBackup = false;
    try {
        if (key.startsWith(PLUGIN_SAVE_PREFIX) || key.startsWith(PLUGIN_SAVE_META_PREFIX)) {
            try {
                assertArchiveSafePluginSaveStorageKey(key);
            } catch (error) {
                return res.status(400).json({
                    error: error?.message || 'Invalid plugin storage key',
                    code: 'invalid_plugin_storage_key',
                });
            }
        }
        try {
            prepared = key === 'database/database.bin'
                ? await prepareSpooledDatabaseWrite(spool)
                : await prepareSpooledGenericKvWrite(key, spool);
        } catch (error) {
            prepared = {
                stageDir: error?.admittedWriteStageDir ?? null,
                preparationError: error,
            };
        }
        if (!prepared.refusal && !prepared.preparationError) {
            await waitAtAdmittedWritePublishTestGate(
                key === 'database/database.bin' ? 'database' : 'kv',
            );
        }

        await queueStorageMutation(async () => {
            const protectsPluginPublication = key === 'database/database.bin'
                || key === PLUGIN_STORAGE_MANIFEST_KEY
                || canonicalPluginStorageRowPrefix(key);
            const livePluginPublication = protectsPluginPublication
                ? await readLivePluginStoragePublication()
                : null;
            if (prepared.preparationError) throw prepared.preparationError;
            if (prepared.refusal) {
                return res.status(prepared.refusal.status).json(prepared.refusal.body);
            }
            if (key !== 'database/database.bin' && protectsPluginPublication) {
                try {
                    assertGenericPluginStorageMutationAllowed(key, livePluginPublication);
                } catch (error) {
                    if (error?.pluginStorageNamespaceConflict) {
                        return res.status(409).json({ error: error.message });
                    }
                    throw error;
                }
            }
            if (key === 'database/database.bin') {
                const ifMatch = req.headers['x-if-match'];
                if (ifMatch && dbEtag && ifMatch !== dbEtag) {
                    return res.status(409).send({
                        error: 'ETag mismatch - concurrent modification detected',
                        currentEtag: dbEtag,
                    });
                }

                const previousStrippedDb = getCurrentDatabaseCacheValue(filePath)
                    || getCurrentDatabaseCacheValue(DB_HEX_KEY)
                    || null;
                try {
                    assertGenericDatabasePluginPublicationAllowed(
                        livePluginPublication,
                        prepared.incomingDb,
                        prepared.pluginExternalization,
                    );
                } catch (error) {
                    if (error?.pluginStorageNamespaceConflict) {
                        return res.status(409).json({ error: error.message });
                    }
                    throw error;
                }
                const chatRowsToDelete = previousStrippedDb
                    ? chatRowStore.removedChatRowKeys(previousStrippedDb, prepared.strippedDb)
                    : [];
                await captureChatDeletionPreImages(chatRowsToDelete);
                let committedDatabaseRevision = null;
                sqliteDb.transaction(() => {
                    writePreparedPluginStorageRows(prepared.pluginExternalization.rows);
                    writePluginStorageManifest(prepared.pluginExternalization.manifest);
                    for (const row of prepared.chatRows) {
                        chatRowStore.writeChatRowFromFile(row.chaId, row.chatId, row.filePath, {
                            contentHash: row.chunkPlan?.sha256 ?? null,
                            chunkPlan: row.chunkPlan,
                            coldStorage: row.coldStorage,
                            messageCount: row.messageCount,
                            logSupported: row.logSupported,
                        });
                    }
                    kvSetFromFile(key, prepared.persistedPath, {
                        chunkPlan: prepared.databasePlan,
                    });
                    if (previousStrippedDb) {
                        chatRowStore.deleteRemovedChatRows(
                            previousStrippedDb,
                            prepared.strippedDb,
                        );
                    }
                    committedDatabaseRevision = kvGetDatabaseRevision();
                })();

                invalidateDbCache();
                replaceDbCacheValue(filePath, prepared.normalizedDatabase, {
                    revision: committedDatabaseRevision,
                    estimatedBytes: prepared.persistedSize,
                    dirty: false,
                });
                dbEtag = prepared.etag;
                seedDbCacheEtag(filePath, dbEtag);
                rememberSessionPluginStorageState(req, prepared.normalizedDatabase);
                shouldCreateBackup = true;
                return res.send({ success: true, etag: dbEtag, hash: undefined });
            }

            let writeResult = null;
            if (key.startsWith('inlay/')) {
                const id = key.slice('inlay/'.length);
                const parsed = prepared.parsedInlay;
                const type = typeof parsed?.type === 'string' ? parsed.type : 'image';
                const ext = normalizeInlayExt(parsed?.ext);
                await writeInlayFileFromFile(id, ext, prepared.inlayPayloadPath, {
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
                const id = key.slice('inlay_info/'.length);
                await writeInlaySidecar(id, prepared.parsedInlayInfo);
                kvDel(key);
            } else if (key.startsWith('assets/')) {
                const digest = prepared.chunkPlan?.sha256
                    ?? await hashFile(spool.filePath, 'sha256');
                const baseVerification = verifyAssetHashFromDigest(key, digest);
                const assetVerification = {
                    ...baseVerification,
                    legacyHashMismatch: !baseVerification.ok
                        && isLegacyHashAsset(key.slice('assets/'.length)),
                };
                if (!assetVerification.ok && !assetVerification.legacyHashMismatch) {
                    return res.status(400).json({
                        error: 'asset content does not match its SHA-256 name',
                        key,
                        expected: assetVerification.claimed,
                        actual: assetVerification.actual,
                    });
                }
                writeAssetValueFromSpool(key, {
                    ...spool,
                    chunkPlan: prepared.chunkPlan,
                }, assetVerification);
            } else {
                writeResult = kvSetFromFile(key, spool.filePath, {
                    chunkPlan: prepared.chunkPlan,
                });
            }

            if (dbCache.has(filePath) || saveTimers[filePath]) {
                invalidateDbCacheEntry(filePath);
            }
            return res.send({
                success: true,
                etag: undefined,
                hash: key.startsWith(PLUGIN_SAVE_PREFIX)
                    ? (prepared.chunkPlan?.sha256 ?? writeResult?.sha256)
                    : undefined,
            });
        }, 'api-write-publish');
        if (shouldCreateBackup) scheduleBackupAndRotate();
    } catch (error) {
        if (isImportInProgressError(error)) return sendImportBusy(res);
        const preparationRefusal = risuSavePreparationRefusal(error);
        if (error === prepared?.preparationError && preparationRefusal) {
            return res.status(preparationRefusal.status).json(preparationRefusal.body);
        }
        if (error === prepared?.preparationError
            && isAdmittedSpoolPressureError(error)) {
            return sendRetryableSpoolRefusal(
                res,
                req[BUFFERED_INGRESS_POLICY],
                bufferedIngressLimits.global,
                spool.size,
            );
        }
        const diagnostic = logPluginStorageValidationFailure(
            '[PluginStorage] Rejected invalid row write',
            error,
        );
        if (diagnostic) return res.status(400).json(diagnostic);
        next(error);
    } finally {
        if (prepared?.stageDir) {
            await fs.rm(prepared.stageDir, { recursive: true, force: true }).catch(() => {});
        }
        await disposeAdmittedIngressSpool(req);
    }
}

app.post('/api/write', async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    if (!checkActiveSession(req, res)) return;
    const rawFilePath = req.headers['file-path'];
    const admittedSpool = req[ADMITTED_INGRESS_SPOOL] ?? null;
    const fileContent = admittedSpool ?? req.body;
    if (!rawFilePath || !fileContent) {
        res.status(400).send({ error:'File path required' });
        return;
    }
    if(!isHex(rawFilePath)){
        res.status(400).send({ error:'Invaild Path' });
        return;
    }
    const {
        canonicalPath: filePath,
        decodedKey: key,
    } = decodeAndCanonicalizeHexPath(rawFilePath);
    if (admittedSpool) {
        return handleSpooledKvWrite(req, res, next, {
            filePath,
            key,
            spool: admittedSpool,
        });
    }
    let shouldCreateBackup = false;
    try {
        await queueStorageMutation(async () => {
            const protectsPluginPublication = key === 'database/database.bin'
                || key === PLUGIN_STORAGE_MANIFEST_KEY
                || canonicalPluginStorageRowPrefix(key);
            const livePluginPublication = protectsPluginPublication
                ? await readLivePluginStoragePublication()
                : null;
            let persistedDatabaseContent = fileContent;
            let validatedStrippedDatabase = null;
            let committedDatabaseRevision = null;
            if (
                key.startsWith(PLUGIN_SAVE_PREFIX)
                || key.startsWith(PLUGIN_SAVE_META_PREFIX)
            ) {
                try {
                    // The generic KV API historically permits noncanonical
                    // short keys in these namespaces. Preserve that contract,
                    // but never admit a name the backup parser cannot frame.
                    assertArchiveSafePluginSaveStorageKey(key);
                } catch (error) {
                    res.status(400).json({
                        error: error?.message || 'Invalid plugin storage key',
                        code: 'invalid_plugin_storage_key',
                    });
                    return;
                }
            }
            const assetVerification = key.startsWith('assets/')
                ? verifyAssetHashForWrite(key, fileContent)
                : null;
            if (assetVerification
                && !assetVerification.ok
                && !assetVerification.legacyHashMismatch) {
                res.status(400).json({
                    error: 'asset content does not match its SHA-256 name',
                    key,
                    expected: assetVerification.claimed,
                    actual: assetVerification.actual,
                });
                return;
            }
            if (key.startsWith(PLUGIN_SAVE_PREFIX)
                || key.startsWith(PLUGIN_SAVE_META_PREFIX)) {
                try {
                    validatePluginStorageRow(key, fileContent);
                } catch (error) {
                    const diagnostic = logPluginStorageValidationFailure(
                        '[PluginStorage] Rejected invalid row write',
                        error
                    ) ?? {
                        error: 'Invalid plugin storage JSON row',
                        code: 'INVALID_PLUGIN_STORAGE_ROW',
                        encodedKey: key.startsWith(PLUGIN_SAVE_META_PREFIX)
                            ? PLUGIN_SAVE_META_PREFIX
                            : PLUGIN_SAVE_PREFIX,
                    };
                    res.status(400).json(diagnostic);
                    return;
                }
            }
            if (key !== 'database/database.bin' && protectsPluginPublication) {
                try {
                    assertGenericPluginStorageMutationAllowed(key, livePluginPublication);
                } catch (error) {
                    if (error?.pluginStorageNamespaceConflict) {
                        return res.status(409).json({ error: error.message });
                    }
                    throw error;
                }
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
                    const previousStrippedDb = getCurrentDatabaseCacheValue(filePath)
                        || getCurrentDatabaseCacheValue(DB_HEX_KEY)
                        || null;
                    const incomingInspection = await inspectRisuSaveSource(fileContent);
                    const incomingDb = incomingInspection.format === 'raw'
                        ? await decodeAuthoritativeDatabase(fileContent)
                        : await decodeBoundedLegacyRisuSave(fileContent, {
                            inspection: incomingInspection,
                            tempDir: databaseSpoolDir,
                            maxLegacyBytes: LEGACY_DATABASE_IMPORT_MAX_BYTES,
                            resolveRemoteSize: async (name) => kvSize(`remotes/${name}.local.bin`),
                            resolveRemote: async (name) => kvGet(`remotes/${name}.local.bin`),
                        });

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

                    const duplicateChatIds = findDuplicateChatIds(incomingDb);
                    if (duplicateChatIds.length > 0) {
                        const err = new Error(
                            `write aborted: ${duplicateChatIds.length} duplicate chat id(s) — `
                            + `would alias authoritative rows. sample=[${duplicateChatIdSample(duplicateChatIds)}]`
                        );
                        recordPersistFailure(err, '/api/write:duplicate-chat-ids');
                        logger.error(`[Write] ${err.message}`);
                        res.status(500).json({ error: 'Write aborted: chat data integrity check failed' });
                        return;
                    }

                    const splitDatabase = chatRowStore.splitFullDb(incomingDb);
                    const chatRows = splitDatabase.chatEntries.map(entry => ({
                        ...entry,
                        value: Buffer.from(encodeRisuSaveLegacy(entry.chat)),
                        coldStorage: isColdStorageChat(entry.chat),
                        messageCount: Array.isArray(entry.chat?.message)
                            ? entry.chat.message.length
                            : 0,
                    }));
                    const pluginExternalization = preparePluginStorageExternalization(
                        splitDatabase.strippedDb
                    );
                    assertGenericDatabasePluginPublicationAllowed(
                        livePluginPublication,
                        splitDatabase.strippedDb,
                        pluginExternalization,
                    );
                    const strippedDb = pluginExternalization.strippedDb;
                    // Full writes already paid for authoritative decoding and
                    // validation. Retain the same normalized stubs-only graph
                    // for the exact committed revision instead of decoding the
                    // persisted bytes again here and once more on the next patch.
                    validatedStrippedDatabase = normalizeDecodedDatabaseForRead(strippedDb);
                    if (chatRows.length > 0 || pluginExternalization.changed) {
                        persistedDatabaseContent = Buffer.from(encodeRisuSaveLegacy(strippedDb));
                    }
                    const chatRowsToDelete = previousStrippedDb
                        ? chatRowStore.removedChatRowKeys(previousStrippedDb, strippedDb)
                        : [];
                    await captureChatDeletionPreImages(chatRowsToDelete);

                    // Must stay synchronous: every external row and the stub graph
                    // commit or roll back together with database.bin.
                    sqliteDb.transaction(() => {
                        writePluginStorageRows(pluginExternalization.rows);
                        writePluginStorageManifest(pluginExternalization.manifest);
                        for (const row of chatRows) {
                            chatRowStore.writeChatRowRaw(row.chaId, row.chatId, row.value, {
                                coldStorage: row.coldStorage,
                                messageCount: row.messageCount,
                                logSupported: true,
                            });
                        }
                        kvSet(key, persistedDatabaseContent);
                        if (previousStrippedDb) {
                            chatRowStore.deleteRemovedChatRows(previousStrippedDb, strippedDb);
                        }
                        committedDatabaseRevision = kvGetDatabaseRevision();
                    })();
                } catch (e) {
                    const diagnostic = logPluginStorageValidationFailure(
                        '[PluginStorage] Rejected invalid folded database row',
                        e
                    );
                    if (diagnostic) {
                        res.status(400).json(diagnostic);
                        return;
                    }
                    if (e instanceof PluginStorageLimitError) throw e;
                    const preparationRefusal = risuSavePreparationRefusal(e);
                    if (preparationRefusal) {
                        res.status(preparationRefusal.status).json(preparationRefusal.body);
                        return;
                    }
                    logger.error('[Write] Failed to externalize database payloads:', e.message);
                    if (e?.pluginStorageNamespaceConflict) {
                        res.status(409).json({ error: e.message });
                        return;
                    }
                    res.status(500).json({ error: 'Database write failed' });
                    return;
                }
            } else if (key.startsWith('assets/')) {
                writeAssetValue(key, fileContent, {
                    skipIfUnchanged: assetVerification.claimed !== null,
                    legacyHashMismatch: assetVerification.legacyHashMismatch,
                });
            } else {
                kvSet(key, fileContent);
            }

            // Update ETag and invalidate cache after database.bin write. The
            // snapshot is queued only after this user-visible mutation returns.
            if (key === 'database/database.bin') {
                invalidateDbCache();
                replaceDbCacheValue(filePath, validatedStrippedDatabase, {
                    revision: committedDatabaseRevision,
                    estimatedBytes: persistedDatabaseContent.length,
                    dirty: false,
                });
                // ETag based on stripped version (what client sees)
                dbEtag = computeBufferEtag(persistedDatabaseContent);
                seedDbCacheEtag(filePath, dbEtag);
                rememberSessionPluginStorageState(req, validatedStrippedDatabase);
                shouldCreateBackup = true;
            } else if (dbCache.has(filePath) || saveTimers[filePath]) {
                // A full write supersedes any cached/debounced patch state for
                // the same non-database key.
                invalidateDbCacheEntry(filePath);
            }

            res.send({
                success: true,
                etag: key === 'database/database.bin' ? dbEtag : undefined,
                hash: key.startsWith(PLUGIN_SAVE_PREFIX) ? sha256Hex(fileContent) : undefined,
            });
        }, 'api-write-publish');
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
            // A background automatic snapshot can hold a pinned WAL reader
            // below the current end after the write that triggered it has
            // already acknowledged. Assembly does not need this queue and
            // closes the pin before publication re-enters it, so bounded async
            // retries converge without deadlocking the queued flush.
            const checkpoint = await runTrackedWalCheckpointWithBusyRetry(
                'FULL',
                'explicit-flush',
            );
            if (!checkpoint.complete) {
                return res.status(503).send({
                    success: false,
                    durable: false,
                    outcome: 'unknown',
                    retryable: true,
                    error: 'SQLite durability checkpoint is busy; retry the flush',
                    checkpoint,
                    etag: dbEtag ?? undefined,
                });
            }
            res.send({
                success: true,
                durable: true,
                checkpoint,
                etag: dbEtag ?? undefined
            });
        });
    } catch (error) {
        if (isImportInProgressError(error)) return sendImportBusy(res);
        next(error);
    }
});

// ─── Patch sync endpoint ──────────────────────────────────────────────────────
const INLINE_PLUGIN_STORAGE_PATCH_ROOTS = [
    'pluginCustomStorage',
    'pluginStorageMeta',
];
const PLUGIN_STORAGE_CONTROL_PATCH_ROOTS = [
    'optimizePluginMemory',
    PLUGIN_STORAGE_GENERATION_FIELD,
    PLUGIN_STORAGE_FOLDED_MARKER,
];

function pluginStoragePatchPointerKind(pointer) {
    // Preserve the existing whole-document guard. The slash form is retained
    // for compatibility with the original predicate even though RFC 6901 uses
    // the empty string for the document root.
    if (pointer === '' || pointer === '/') return 'document';
    if (typeof pointer !== 'string') return null;
    if (INLINE_PLUGIN_STORAGE_PATCH_ROOTS.some((root) => (
        pointer === `/${root}` || pointer.startsWith(`/${root}/`)
    ))) return 'inline-record';
    if (PLUGIN_STORAGE_CONTROL_PATCH_ROOTS.some((root) => (
        pointer === `/${root}` || pointer.startsWith(`/${root}/`)
    ))) return 'control';
    return null;
}

function patchReferencesPluginStoragePointerKinds(patch, kinds) {
    if (!Array.isArray(patch)) return false;
    return patch.some((operation) => (
        operation && typeof operation === 'object' && (
            kinds.has(pluginStoragePatchPointerKind(operation.path))
            || kinds.has(pluginStoragePatchPointerKind(operation.from))
        )
    ));
}

function patchTouchesPluginStoragePublication(patch) {
    return patchReferencesPluginStoragePointerKinds(
        patch,
        new Set(['document', 'inline-record', 'control']),
    );
}

function patchTouchesPluginStoragePublicationControl(patch) {
    return patchReferencesPluginStoragePointerKinds(
        patch,
        new Set(['document', 'control']),
    );
}

function publicationAllowsInlinePluginStoragePatch(publication) {
    // A completed optimized -> inline transition retains a fresh generation as
    // its mode epoch, so generation presence alone does not imply external rows.
    return Boolean(publication.dbObj)
        && publication.dbObj.optimizePluginMemory !== true
        && publication.dbObj[PLUGIN_STORAGE_FOLDED_MARKER] !== true
        && publication.manifestState.present === false;
}

app.post('/api/patch', async (req, res, next) => {
    if (!enablePatchSync) {
        res.status(404).send({ error: 'Patch sync is not enabled' });
        return;
    }
    if(!await checkAuth(req, res)){
        return;
    }
    if (!checkActiveSession(req, res)) return;
    const rawFilePath = req.headers['file-path'];
    const patch = req.body.patch;
    const expectedHash = req.body.expectedHash;

    if (!rawFilePath || !patch || !expectedHash) {
        res.status(400).send({ error: 'File path, patch, and expected hash required' });
        return;
    }
    if (!isHex(rawFilePath)) {
        res.status(400).send({ error: 'Invaild Path' });
        return;
    }
    const {
        canonicalPath: filePath,
        decodedKey,
    } = decodeAndCanonicalizeHexPath(rawFilePath);

    try {
        await queueStorageMutation(async () => {
            // Manifest rows, optimized rows, mode controls, and whole-document
            // replacements must never reach dbCache or the eager externalizer.
            // Inline value/owner maps are different: database.bin is their sole
            // authority, so retain the original PocketRisu patch behavior only
            // after proving the live server publication is currently inline.
            let rejectPluginStoragePatch = decodedKey === PLUGIN_STORAGE_MANIFEST_KEY
                || Boolean(canonicalPluginStorageRowPrefix(decodedKey));
            if (
                !rejectPluginStoragePatch
                && decodedKey === 'database/database.bin'
                && patchTouchesPluginStoragePublication(patch)
            ) {
                if (patchTouchesPluginStoragePublicationControl(patch)) {
                    rejectPluginStoragePatch = true;
                } else {
                    const livePublication = await readLivePluginStoragePublication();
                    rejectPluginStoragePatch = !publicationAllowsInlinePluginStoragePatch(
                        livePublication,
                    );
                }
            }
            if (rejectPluginStoragePatch) {
                return res.status(409).json({
                    error: 'Patch rejected: plugin storage publication must be changed atomically',
                    code: 'PLUGIN_STORAGE_PUBLICATION_GUARD',
                });
            }

            // For database.bin, reuse is valid only while the authoritative
            // SQLite row revision still matches the decoded stubs-only graph.
            const cachedDb = await loadPatchCache(filePath, decodedKey);
            if (decodedKey === DB_BLOB_KEY
                && dbCache.metadata(filePath)?.revision !== kvGetDatabaseRevision()) {
                releaseDbCacheCanonicalEncoding(filePath, 'external-revision-conflict');
                throw new DatabaseCacheRevisionConflict();
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
                    code: 'DATABASE_PATCH_CONFLICT',
                    currentEtag
                });
                return;
            }

            // Only patch-path ancestors are copied. Until the complete sequence
            // succeeds, every object reachable from dbCache remains untouched.
            const result = applyPatchAtomic(cachedDb, patch);
            const snapshot = result.newDocument;
            let preserveSegmentMemo = false;
            let structuralDatabasePatch = false;
            if (decodedKey === 'database/database.bin') {
                const duplicateChatIds = findDuplicateChatIds(snapshot);
                if (duplicateChatIds.length > 0) {
                    logger.warn(
                        `[Patch] Rejected ${duplicateChatIds.length} duplicate chat id(s): `
                        + duplicateChatIdSample(duplicateChatIds)
                    );
                    let currentEtag;
                    try {
                        currentEtag = getDbCacheEtag(filePath);
                        dbEtag = currentEtag;
                    } catch {}
                    res.status(409).send({
                        error: 'Patch rejected: duplicate chat ids would alias authoritative rows',
                        code: 'DUPLICATE_CHAT_IDS',
                        currentEtag,
                    });
                    return;
                }
                // Detection must remain pure and precede in-place normalizations:
                // untouched patch subtrees can still be shared with cachedDb.
                const payloadChatCount = chatRowStore.countPayloadChats(snapshot);
                if (payloadChatCount > 0) {
                    logger.warn(
                        `[Patch] Rejected ${payloadChatCount} whole-chat payload(s)`
                    );
                    let currentEtag;
                    try {
                        currentEtag = getDbCacheEtag(filePath);
                        dbEtag = currentEtag;
                    } catch {}
                    res.status(422).send({
                        error: 'Patch rejected: whole-chat payloads must be written through /api/chat-content',
                        code: 'CHAT_PAYLOAD_PATCH_UNSUPPORTED',
                        retryable: false,
                        commitOutcome: 'not-committed',
                        commitOutcomeUnknown: false,
                        currentEtag,
                    });
                    return;
                }
                // Keep dbCache and the ETag on the same optimized stub shape
                // that the debounced persist will write.
                const chatRowReferenceDiff = diffReferencedChatRowKeys(cachedDb, snapshot);
                structuralDatabasePatch = chatRowReferenceDiff.changed;
                const externalized = externalizePluginStorageIfNeeded(snapshot);
                preserveSegmentMemo = true;
                trackPendingChatRowDeletions(chatRowReferenceDiff);
                // A patch with no mutating op (empty, or test-only) returns the
                // cached object itself, so replaceDbCacheValue sees no identity
                // change and skips the generation bump. Plugin externalization
                // edits in place, so bump explicitly when it actually changed
                // something — otherwise the memoized hash/ETag would keep
                // describing the pre-normalization shape.
                if (snapshot === cachedDb && externalized.changed) {
                    dbCompositionalHashMemo = new WeakMap();
                    dbDerivedValueMemo.bump(filePath);
                }
            }
            replaceDbCacheValue(filePath, snapshot, {
                dirty: true,
                preserveHashMemo: snapshot !== cachedDb,
                preserveSegmentMemo,
            });

            // Update ETag after successful patch (based on stripped version).
            if (decodedKey === 'database/database.bin') {
                dbEtag = getDbCacheEtag(filePath, { retainCanonicalEncoding: true });
            }

            let durable = false;
            if (structuralDatabasePatch) {
                if (saveTimers[filePath]) clearTimeout(saveTimers[filePath]);
                delete saveTimers[filePath];
                try {
                    await persistDbCache(filePath, decodedKey);
                    dbPersistRetryPending = false;
                    clearPersistFailure();
                    scheduleBackupAndRotate();
                    durable = true;
                } catch (error) {
                    dbPersistRetryPending = Boolean(peekDbCacheValue(filePath));
                    logger.error(`[Patch] Error saving ${decodedKey}:`, error);
                    recordPersistFailure(error, `patch:${decodedKey}`);
                }
            } else {
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
                                dbPersistRetryPending = false;
                            } else {
                                const data = Buffer.from(encodeRisuSaveLegacy(peekDbCacheValue(filePath)));
                                try {
                                    kvSet(decodedKey, data);
                                } catch (err) {
                                    if (err && typeof err === 'object') {
                                        try { err.attemptedSize = data.length; } catch {}
                                    }
                                    throw err;
                                }
                                markDbCacheClean(filePath, { estimatedBytes: data.length });
                            }
                            // Persist succeeded — clear before backup so a backup-only
                            // failure isn't attributed to data loss.
                            clearPersistFailure();
                            if (decodedKey === 'database/database.bin') scheduleBackupAndRotate();
                        } catch (error) {
                            if (decodedKey === 'database/database.bin') {
                                // persistDbCache may intentionally invalidate a
                                // malformed cache. Only retained cache state can be
                                // retried; otherwise the live database supersedes it.
                                dbPersistRetryPending = Boolean(peekDbCacheValue(filePath));
                            }
                            logger.error(`[Patch] Error saving ${decodedKey}:`, error);
                            recordPersistFailure(error, `patch:${decodedKey}`);
                        } finally {
                            if (saveTimers[filePath] === saveTimer) delete saveTimers[filePath];
                        }
                    }, 'patch-persist').catch((error) => {
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
            }

            const responsePayload = {
                success: true,
                appliedOperations: result.length,
                etag: decodedKey === 'database/database.bin' ? dbEtag : undefined,
                durable,
            };
            const persistWarning = currentPersistWarning();
            if (persistWarning) {
                responsePayload.persistWarning = persistWarning;
            }
            res.send(responsePayload);
        });
    } catch (error) {
        if (isImportInProgressError(error)) return sendImportBusy(res);
        if (error instanceof DatabaseCacheRevisionConflict) {
            return res.status(409).json({
                error: error.message,
                code: error.code,
                retryable: false,
            });
        }
        const diagnostic = logPluginStorageValidationFailure(
            '[PluginStorage] Rejected invalid patched database row',
            error
        );
        if (diagnostic) {
            res.status(400).json(diagnostic);
            return;
        }
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
                ? verifyAssetHashForWrite(key, buffer)
                : null;
            return { key, buffer, verification };
        });
        const mismatches = decodedEntries
            .filter((entry) => entry.verification
                && !entry.verification.ok
                && !entry.verification.legacyHashMismatch)
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
        await queueStorageMutation(async () => {
            const protectedEntries = decodedEntries.filter(({ key }) => (
                key === 'database/database.bin'
                || key === PLUGIN_STORAGE_MANIFEST_KEY
                || canonicalPluginStorageRowPrefix(key)
            ));
            if (protectedEntries.length > 0) {
                const publication = await readLivePluginStoragePublication();
                const seenPluginKeys = new Set();
                try {
                    for (const { key } of protectedEntries) {
                        if (key === 'database/database.bin') {
                            throw pluginStorageNamespaceConflict(
                                'database.bin cannot be changed through the bulk asset endpoint',
                            );
                        }
                        if (seenPluginKeys.has(key)) {
                            throw pluginStorageNamespaceConflict(
                                'A bulk write cannot repeat a plugin storage row',
                            );
                        }
                        seenPluginKeys.add(key);
                        assertGenericPluginStorageMutationAllowed(key, publication);
                    }
                } catch (error) {
                    if (error?.pluginStorageNamespaceConflict) {
                        return res.status(409).json({ error: error.message });
                    }
                    throw error;
                }
            }
            for(let i = 0; i < decodedEntries.length; i += BULK_BATCH){
                const batch = decodedEntries.slice(i, i + BULK_BATCH);
                const writeBatch = sqliteDb.transaction(() => {
                    for(const { key, buffer, verification } of batch){
                        if (typeof key === 'string' && key.startsWith('assets/')) {
                            writeAssetValue(key, buffer, {
                                skipIfUnchanged: verification.claimed !== null,
                                legacyHashMismatch: verification.legacyHashMismatch,
                            });
                        } else {
                            kvSet(key, buffer);
                        }
                    }
                });
                writeBatch();
            }
        });
        if (res.headersSent) return;
        res.json({ success: true, count: entries.length });
    } catch(error){
        if (isImportInProgressError(error)) return sendImportBusy(res);
        next(error);
    }
});

app.post('/api/backup/export/jobs', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        if (req.body?.scope !== 'partial') {
            res.status(400).json({ error: 'Only partial export jobs are supported' });
            return;
        }
        const owner = partialExportOwner(req);
        const requestedId = req.body?.jobId;
        if (typeof requestedId !== 'string' || !PLUGIN_STORAGE_UUID_PATTERN.test(requestedId)) {
            res.status(400).json({ error: 'Partial export jobId must be a canonical UUID' });
            return;
        }
        const testCreateDelay = process.env.NODE_ENV === 'test'
            ? Number(process.env.POCKETRISU_TEST_PARTIAL_EXPORT_CREATE_DELAY_MS ?? 0)
            : 0;
        if (Number.isFinite(testCreateDelay) && testCreateDelay > 0) {
            await new Promise(resolve => setTimeout(resolve, testCreateDelay));
        }
        if (wasPartialExportCancelled(owner, requestedId)) {
            res.status(409).json({
                error: 'Partial export job was cancelled before creation',
                state: 'cancelled',
            });
            return;
        }
        const existingById = partialExportJobs.get(requestedId);
        if (existingById) {
            if (existingById.owner !== owner) {
                res.status(409).json({ error: 'Partial export jobId is already in use' });
                return;
            }
            res.status(202).json({ jobId: existingById.id, state: existingById.state });
            return;
        }
        const existingForOwner = [...partialExportJobs.values()].find(job => job.owner === owner);
        if (existingForOwner) {
            res.status(409).json({
                error: 'A partial export job is already active for this session',
                jobId: existingForOwner.id,
                state: existingForOwner.state,
            });
            return;
        }
        if (partialExportJobs.size >= PARTIAL_EXPORT_MAX_ACTIVE_JOBS) {
            res.status(429).json({
                error: 'Too many partial export jobs are active',
                retryable: true,
            });
            return;
        }
        const id = requestedId;
        const spoolDir = path.join(partialExportSpoolDir, `${PARTIAL_EXPORT_JOB_PREFIX}${id}`);
        const pinDir = path.join(spoolDir, 'assets');
        const job = {
            id,
            owner,
            state: 'creating',
            createdAt: Date.now(),
            expiresAt: Date.now() + PARTIAL_EXPORT_JOB_TTL_MS,
            abortController: new AbortController(),
            spoolDir,
            pinDir,
            archiveTempPath: path.join(spoolDir, 'partial-backup.bin.tmp'),
            archivePath: path.join(spoolDir, 'partial-backup.bin'),
            filename: `risu-backup-${Date.now()}-partial.bin`,
            snapshot: null,
            databaseSpool: null,
            missingAssets: 0,
            size: 0,
            error: null,
            cleaned: false,
            progress: { phase: 'queued', current: 0, total: 0, bytes: 0 },
        };
        // Reserve identity, owner admission, and the sole disk budget before
        // the first await. Duplicate creates, concurrent creates, and DELETE
        // now observe this job even while its directory is being created.
        partialExportJobs.set(id, job);
        try {
            await fs.mkdir(pinDir, { recursive: true, mode: 0o700 });
        } catch (error) {
            await cleanupPartialExportJob(job);
            throw error;
        }
        if (job.cleaned || job.abortController.signal.aborted) {
            await cleanupPartialExportArtifacts(job);
            if (!res.headersSent) {
                res.status(409).json({ error: 'Partial export job was cancelled during creation' });
            }
            return;
        }
        job.state = 'preparing';
        res.status(202).json({ jobId: id, state: job.state });
        job.preparation = Promise.resolve().then(() => preparePartialExportJob(job));
    } catch (error) {
        next(error);
    }
});

app.get('/api/backup/export/jobs/:jobId', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        const job = partialExportJobForRequest(req, res);
        if (!job) return;
        res.setHeader('cache-control', 'no-store');
        res.json({
            jobId: job.id,
            state: job.state,
            phase: job.progress.phase,
            current: job.progress.current,
            total: job.progress.total,
            bytes: job.progress.bytes,
            size: job.state === 'ready' ? job.size : undefined,
            missingAssets: job.missingAssets,
            error: job.state === 'failed' ? job.error : undefined,
        });
    } catch (error) {
        next(error);
    }
});

app.delete('/api/backup/export/jobs/:jobId', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        const id = req.params.jobId;
        if (!PLUGIN_STORAGE_UUID_PATTERN.test(id)) {
            res.status(404).json({ error: 'Partial export job not found' });
            return;
        }
        const owner = partialExportOwner(req);
        const job = partialExportJobs.get(id);
        if (job && job.owner !== owner) {
            res.status(404).json({ error: 'Partial export job not found' });
            return;
        }
        recordPartialExportCancellation(owner, id);
        if (!job) {
            res.status(202).json({ ok: true, state: 'cancelled' });
            return;
        }
        job.state = 'cancelled';
        job.abortController.abort();
        partialExportJobs.delete(job.id);
        if (!job.preparation || job.progress.phase === 'ready' || job.progress.phase === 'failed') {
            await cleanupPartialExportJob(job);
        }
        res.status(202).json({ ok: true, state: 'cancelled' });
    } catch (error) {
        next(error);
    }
});

app.get('/api/backup/export/jobs/:jobId/download', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    let job;
    let closed = false;
    let consuming = false;
    let onJobAbort = null;
    try {
        job = partialExportJobForRequest(req, res);
        if (!job) return;
        if (job.state !== 'ready') {
            res.status(409).json({ error: 'Partial export is not ready', state: job.state });
            return;
        }
        consuming = true;
        job.state = 'streaming';
        job.progress.phase = 'streaming';
        res.once('close', () => { closed = true; });
        onJobAbort = () => {
            closed = true;
            if (!res.destroyed) res.destroy();
        };
        job.abortController.signal.addEventListener('abort', onJobAbort, { once: true });
        res.setHeader('cache-control', 'no-store');
        res.setHeader('content-type', 'application/octet-stream');
        res.setHeader('content-disposition', `attachment; filename="${job.filename}"`);
        res.setHeader('content-length', job.size);
        res.setHeader('x-risu-backup-assets', Math.max(0, job.progress.total - 2));
        res.setHeader('x-risu-backup-missing-assets', job.missingAssets);
        if (process.env.NODE_ENV === 'test'
            && process.env.POCKETRISU_TEST_PARTIAL_EXPORT_STALL_DOWNLOAD === '1') {
            // Deterministically hold a response after headers and a real
            // archive chunk have entered the streaming path. TTL must wake
            // this wait by aborting the job and destroying the response.
            const archive = await fs.open(job.archivePath, 'r');
            try {
                const firstChunk = Buffer.allocUnsafe(Math.min(job.size, 64 * 1024));
                const { bytesRead } = await archive.read(firstChunk, 0, firstChunk.length, 0);
                if (bytesRead > 0) {
                    await writeWithBackpressure(
                        res,
                        firstChunk.subarray(0, bytesRead),
                        () => closed || job.abortController.signal.aborted,
                    );
                }
            } finally {
                await archive.close();
            }
            if (!job.abortController.signal.aborted) {
                await new Promise(resolve => {
                    job.abortController.signal.addEventListener('abort', resolve, { once: true });
                });
            }
            return;
        }
        if (!await streamFileToWritable(
            job.archivePath,
            res,
            () => closed || job.abortController.signal.aborted,
        )) return;
        if (!closed) res.end();
    } catch (error) {
        if (!closed && !res.headersSent) next(error);
        else if (!closed) res.destroy(error);
    } finally {
        if (job && onJobAbort) {
            job.abortController.signal.removeEventListener('abort', onJobAbort);
        }
        if (job && consuming) await cleanupPartialExportJob(job);
    }
});

app.get('/api/backup/export', async (req, res, next) => {
    if(!await checkAuth(req, res)){ return; }
    if (req.query.scope === 'partial') {
        res.status(409).json({
            error: 'Partial exports use the cancellable export-job protocol',
            code: 'PARTIAL_EXPORT_JOB_REQUIRED',
            create: '/api/backup/export/jobs',
        });
        return;
    }
    const abortTracker = createBackupExportAbortTracker(req, res);
    let backupDbSpool = null;
    let pinnedState = null;
    const shouldAbort = () => abortTracker.signal.aborted || res.destroyed;
    try {
        const requestedTarget = req.query.target;
        if (requestedTarget !== undefined
            && requestedTarget !== 'nodeonly'
            && requestedTarget !== 'upstream'
            && requestedTarget !== 'main') {
            res.status(400).json({
                error: 'Unsupported backup export target',
                code: 'BACKUP_EXPORT_TARGET_INVALID',
            });
            return;
        }
        // upstream excludes slash-named PocketRisu namespaces its importer
        // rejects. main is a separate downgrade contract: it folds optimized
        // plugin rows and omits serve-only drafts/MCP rows, while retaining the
        // inlay namespaces that the PocketRisu main importer understands.
        const target = requestedTarget ?? 'nodeonly';
        const foldPluginStorage = target !== 'nodeonly';
        pinnedState = await pinFullBackupState({
            target,
            signal: abortTracker.signal,
        });
        await waitAtFullExportAfterPinTestGate(abortTracker.signal);
        throwIfBackupExportAborted(abortTracker.signal);
        backupDbSpool = await buildSelfContainedBackupDatabase({
            foldPluginStorage,
            shouldAbort,
            snapshot: pinnedState.snapshot,
            databaseSource: pinnedState.databaseSource,
            databaseState: pinnedState.databaseState,
            signal: abortTracker.signal,
        });
        if (target === 'main' || target === 'upstream') {
            await requireTargetCompatibleBackupDatabase(backupDbSpool, target);
        }
        throwIfBackupExportAborted(abortTracker.signal);
        const namespacedEntries = target === 'nodeonly'
            ? await selectReferencedMcpToolCallEntries(
                pinnedState.entries,
                backupDbSpool,
                shouldAbort,
            )
            : pinnedState.entries;
        const dbSize = backupDbSpool?.size ?? 0;
        preflightBackupEntries([
            ...namespacedEntries,
            ...(dbSize ? [{ backupName: 'database.risudat', size: dbSize }] : []),
        ]);
        const totalBytes = namespacedEntries.reduce((sum, entry) => {
            return sum + backupEntrySize(entry.backupName, entry.size);
        }, 0) + (dbSize ? backupEntrySize('database.risudat', dbSize) : 0);

        const filenameSuffix = target === 'nodeonly' ? '' : `-${target}`;
        res.setHeader('content-type', 'application/octet-stream');
        res.setHeader('content-disposition', `attachment; filename="risu-backup-${Date.now()}${filenameSuffix}.bin"`);
        res.setHeader('content-length', totalBytes);
        res.setHeader('x-risu-backup-assets', namespacedEntries.length);
        res.setHeader('x-risu-backup-target', target);
        if (target === 'main') {
            res.setHeader('x-risu-backup-omitted', 'drafts,remembered-mcp-tool-calls');
        }

        for (const entry of namespacedEntries) {
            throwIfBackupExportAborted(abortTracker.signal);
            if (!await writePinnedBackupEntry(
                res,
                entry,
                shouldAbort,
            )) break;
        }

        if (!shouldAbort() && dbSize && backupDbSpool) {
            const header = encodeBackupEntryHeader('database.risudat', dbSize);
            if (await writeWithBackpressure(res, header, shouldAbort)) {
                await streamFileToWritable(backupDbSpool.filePath, res, shouldAbort);
            }
        }
        if (!shouldAbort()) res.end();
    } catch (error) {
        if (abortTracker.signal.aborted || res.destroyed) {
            return;
        } else if (error?.code === 'BACKUP_MISSING_CHAT_ROW') {
            logger.error('[Backup Export] Failed:', error);
            res.status(500).json({ error: error.message, code: error.code });
        } else if (!res.headersSent && error?.statusCode) {
            res.status(error.statusCode).json(backupExportErrorPayload(error));
        } else {
            next(error);
        }
    } finally {
        abortTracker.cleanup();
        if (backupDbSpool) {
            await fs.unlink(backupDbSpool.filePath).catch(() => {});
        }
        await cleanupFullBackupState(pinnedState);
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
        if (!Number.isSafeInteger(size) || size < 0) {
            throw importFormatError('Backup has an invalid byte length', 'INVALID_IMPORT_SIZE');
        }
        const limits = backupImportLimits({
            allowLargeRestore: req.body?.allowLargeRestore === true,
        });
        assertImportSize(size, limits.maxBytes, 'Backup archive');

        if (size > 0) {
            await assertImportDiskSpace(size);
        }

        res.json({ ok: true });
    } catch (error) {
        if (!sendImportIngressError(res, error)) next(error);
    }
});

app.post('/api/backup/import', async (req, res, next) => {
    if(!await checkAuth(req, res)){ return; }
    if (!checkActiveSession(req, res)) return;
    const abortTracker = createImportAbortTracker(req, res);
    let ownsImportSlot = false;
    let releaseImportBarrier = null;
    let prevRequestTimeout;
    let wantsNdjson = false;
    let heartbeatTimer = null;
    let uploadSpool = null;
    let uploadStream = null;
    const limits = backupImportLimits({
        allowLargeRestore: requestConfirmsLargeRestore(req),
    });

    try {
        if (importInProgress) {
            res.status(409).json({ error: 'Another import is already in progress' });
            return;
        }
        importInProgress = true;
        ownsImportSlot = true;
        releaseImportBarrier = await importBarrier.acquire(abortTracker.signal);
        throwIfImportAborted(abortTracker.signal);

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

        const contentLength = importContentLength(req, 'Backup archive');
        if (contentLength !== null) {
            assertImportSize(contentLength, limits.maxBytes, 'Backup archive');
            await assertImportDiskSpace(contentLength);
        }

        const uploadPath = path.join(
            databaseSpoolDir,
            `${BACKUP_IMPORT_SPOOL_FILE_PREFIX}${process.pid}-${nodeCrypto.randomUUID()}.tmp`,
        );
        uploadSpool = await spoolAsyncIterable(req, uploadPath, {
            maxBytes: limits.maxBytes,
            expectedBytes: contentLength,
            signal: abortTracker.signal,
        });
        await assertImportDiskSpace(uploadSpool.size);
        throwIfImportAborted(abortTracker.signal);
        uploadStream = createReadStream(uploadSpool.filePath, {
            highWaterMark: IMPORT_IO_PAGE_BYTES,
        });

        if (wantsNdjson) {
            res.setHeader('content-type', 'application/x-ndjson');
            res.setHeader('cache-control', 'no-cache, no-transform');
            // Disable nginx response buffering so progress events flush immediately.
            res.setHeader('x-accel-buffering', 'no');
            res.flushHeaders();
            // The upload was deliberately validated before response headers so
            // cap violations can remain literal HTTP 413 responses. Emit one
            // immediate keepalive when the post-validation NDJSON phase starts.
            res.write('{"type":"heartbeat"}\n');

            // Periodic keepalive — covers the post-stream phase (commit,
            // inlay dir swap, cold storage migration) where onProgress is silent.
            heartbeatTimer = setInterval(() => {
                if (!res.writableEnded) res.write('{"type":"heartbeat"}\n');
            }, BACKUP_NDJSON_HEARTBEAT_MS);

            let lastProgressWrite = 0;
            const totalBytes = uploadSpool.size;
            const result = await importBackupFromSource(uploadStream, {
                ...limits,
                totalBytes,
                signal: abortTracker.signal,
                onProgress: (received, total) => {
                    const now = Date.now();
                    if (now - lastProgressWrite < 200) return;
                    lastProgressWrite = now;
                    res.write(JSON.stringify({ type: 'progress', bytes: received, totalBytes: total }) + '\n');
                },
            });
            uploadStream.destroy();
            uploadStream = null;
            await fs.unlink(uploadSpool.filePath).catch(() => {});
            uploadSpool = null;
            res.write(JSON.stringify({
                type: 'done',
                ok: true,
                assetsRestored: result.assetsRestored,
                coldStorageFailed: result.coldStorageFailed,
            }) + '\n');
            res.end();
        } else {
            const result = await importBackupFromSource(uploadStream, {
                ...limits,
                totalBytes: uploadSpool.size,
                signal: abortTracker.signal,
            });
            uploadStream.destroy();
            uploadStream = null;
            await fs.unlink(uploadSpool.filePath).catch(() => {});
            uploadSpool = null;
            res.json({
                ok: true,
                assetsRestored: result.assetsRestored,
                coldStorageFailed: result.coldStorageFailed,
            });
        }
    } catch (error) {
        const diagnostic = logPluginStorageValidationFailure(
            '[PluginStorage] Rejected invalid backup import row',
            error
        );
        if (sendImportIngressError(res, error, { ndjson: wantsNdjson })) {
            // Structured ingress failures always report their publication outcome.
        } else if (wantsNdjson && res.headersSent) {
            try {
                res.write(JSON.stringify(importNdjsonErrorEvent(error, diagnostic)) + '\n');
                res.end();
            } catch (_) {}
        } else if (diagnostic) {
            res.status(400).json(diagnostic);
        } else {
            next(error);
        }
    } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        abortTracker.cleanup();
        uploadStream?.destroy();
        if (uploadSpool) await fs.unlink(uploadSpool.filePath).catch(() => {});
        releaseImportBarrier?.();
        if (ownsImportSlot) importInProgress = false;
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
    const abortTracker = createBackupExportAbortTracker(req, res);
    const destinationDir = path.resolve(backupsDir);
    let backupDbSpool = null;
    let pinnedState = null;
    const shouldAbort = () => abortTracker.signal.aborted || res.destroyed;
    try {
        pinnedState = await pinFullBackupState({
            target: 'nodeonly',
            signal: abortTracker.signal,
            archiveTargetPath: destinationDir,
        });
        await waitAtFullExportAfterPinTestGate(abortTracker.signal);
        throwIfBackupExportAborted(abortTracker.signal);
        backupDbSpool = await buildSelfContainedBackupDatabase({
            foldPluginStorage: false,
            shouldAbort,
            snapshot: pinnedState.snapshot,
            databaseSource: pinnedState.databaseSource,
            databaseState: pinnedState.databaseState,
            signal: abortTracker.signal,
        });
        throwIfBackupExportAborted(abortTracker.signal);

        const namespacedEntries = await selectReferencedMcpToolCallEntries(
            pinnedState.entries,
            backupDbSpool,
            shouldAbort,
        );
        preflightBackupEntries([
            ...namespacedEntries,
            ...(backupDbSpool
                ? [{ backupName: 'database.risudat', size: backupDbSpool.size }]
                : []),
        ]);
        const totalEntries = namespacedEntries.length + 1; // +1 for database
        const totalBytes = namespacedEntries.reduce(
            (sum, entry) => sum + backupEntrySize(entry.backupName, entry.size),
            0,
        ) + (backupDbSpool
            ? backupEntrySize('database.risudat', backupDbSpool.size)
            : 0);
        if (totalBytes > pinnedState.archiveReservedBytes) {
            throw new Error('Server backup archive exceeds its admitted disk reservation');
        }

        // Stream progress as NDJSON
        res.setHeader('content-type', 'application/x-ndjson');
        res.flushHeaders();

        const tmpPath = path.join(
            destinationDir,
            `${SERVER_BACKUP_TEMP_PREFIX}${process.pid}-${pinnedState.token}.tmp`,
        );
        const writeStream = createWriteStream(tmpPath, {
            flags: 'wx',
            mode: 0o600,
            flush: true,
        });
        const writeStreamFinished = finished(writeStream);
        writeStreamFinished.catch(() => {});
        const abortLocalWrite = () => {
            const reason = abortTracker.signal.reason instanceof Error
                ? abortTracker.signal.reason
                : new Error('Server backup save cancelled');
            writeStream.destroy(reason);
        };
        abortTracker.signal.addEventListener('abort', abortLocalWrite, { once: true });

        let finalPath = null;
        let filename = null;
        let responseComplete = false;

        try {
            let written = 0;
            let bytesWritten = 0;
            for (const entry of namespacedEntries) {
                throwIfBackupExportAborted(abortTracker.signal);
                if (!await writePinnedBackupEntry(
                    writeStream,
                    entry,
                    shouldAbort,
                )) break;
                bytesWritten += backupEntrySize(entry.backupName, entry.size);
                written++;
                if (written % 50 === 0 || written === namespacedEntries.length) {
                    if (!await writeWithBackpressure(
                        res,
                        JSON.stringify({ type: 'progress', current: written, total: totalEntries, bytes: bytesWritten, totalBytes }) + '\n',
                        shouldAbort,
                    )) throw new Error('Client disconnected during backup save');
                }
            }
            throwIfBackupExportAborted(abortTracker.signal);
            if (backupDbSpool) {
                const header = encodeBackupEntryHeader('database.risudat', backupDbSpool.size);
                if (!await writeWithBackpressure(writeStream, header, shouldAbort)) {
                    throw new Error('Client disconnected during backup save');
                }
                if (!await streamFileToWritable(backupDbSpool.filePath, writeStream, shouldAbort)) {
                    throw new Error('Client disconnected during backup save');
                }
                bytesWritten += header.length + backupDbSpool.size;
            }
            if (!await writeWithBackpressure(
                res,
                JSON.stringify({ type: 'progress', current: totalEntries, total: totalEntries, bytes: bytesWritten, totalBytes }) + '\n',
                shouldAbort,
            )) throw new Error('Client disconnected during backup save');
            writeStream.end();
            await writeStreamFinished;
            await waitAtServerBackupBeforePublishTestGate(abortTracker.signal);
            throwIfBackupExportAborted(abortTracker.signal);
            const tempStat = await fs.stat(tmpPath);
            if (tempStat.size !== totalBytes) {
                throw new Error('Server backup temp file length does not match its plan');
            }

            // Hard-link publication is atomic and never replaces an existing
            // backup. Numeric suffix probing preserves the public filename
            // contract while making same-millisecond saves collision-safe.
            const timestamp = Date.now();
            for (let attempt = 0; attempt < 10_000; attempt++) {
                throwIfBackupExportAborted(abortTracker.signal);
                filename = `risu-backup-${timestamp + attempt}.bin`;
                finalPath = path.join(destinationDir, filename);
                try {
                    await fs.link(tmpPath, finalPath);
                    break;
                } catch (error) {
                    if (error?.code !== 'EEXIST') throw error;
                    finalPath = null;
                    filename = null;
                }
            }
            if (!finalPath || !filename) {
                throw new Error('Could not allocate a unique server backup filename');
            }
            throwIfBackupExportAborted(abortTracker.signal);
            await fs.unlink(tmpPath);

            const stat = await fs.stat(finalPath);
            console.log(`[Server Backup] Saved: ${filename} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
            if (!await writeWithBackpressure(
                res,
                JSON.stringify({ type: 'done', ok: true, filename, size: stat.size }) + '\n',
                shouldAbort,
            )) throw new Error('Client disconnected before backup publication acknowledgement');
            res.end();
            await finished(res);
            responseComplete = true;
            markFullExportReservationConsumed(
                pinnedState.reservation,
                'ARCHIVE',
                stat.size,
            );
        } catch (innerError) {
            writeStream.destroy();
            await writeStreamFinished.catch(() => {});
            await fs.unlink(tmpPath).catch(() => {});
            if (!responseComplete && finalPath) {
                await fs.unlink(finalPath).catch(() => {});
            }
            throw innerError;
        } finally {
            abortTracker.signal.removeEventListener('abort', abortLocalWrite);
        }
    } catch (error) {
        if (abortTracker.signal.aborted || res.destroyed) {
            return;
        } else if (!res.headersSent && error?.code === 'BACKUP_MISSING_CHAT_ROW') {
            res.status(500).json({ error: error.message, code: error.code });
        } else if (!res.headersSent && error?.statusCode) {
            res.status(error.statusCode).json(backupExportErrorPayload(error));
        } else if (!res.headersSent) {
            next(error);
        } else {
            res.write(JSON.stringify({ type: 'error', message: error.message }) + '\n');
            res.end();
        }
    } finally {
        abortTracker.cleanup();
        if (backupDbSpool) {
            await fs.unlink(backupDbSpool.filePath).catch(() => {});
        }
        await cleanupFullBackupState(pinnedState);
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

    const abortTracker = createImportAbortTracker(req, res);
    let ownsImportSlot = false;
    let releaseImportBarrier = null;
    let heartbeatTimer = null;
    let restoreStream = null;

    try {
        if (importInProgress) {
            res.status(409).json({ error: 'Another import is already in progress' });
            return;
        }
        importInProgress = true;
        ownsImportSlot = true;
        releaseImportBarrier = await importBarrier.acquire(abortTracker.signal);
        throwIfImportAborted(abortTracker.signal);

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

        const limits = backupImportLimits({ allowLargeRestore: true });
        assertImportSize(fileStat.size, limits.maxBytes, 'Server backup');

        await assertImportDiskSpace(fileStat.size);

        res.setHeader('content-type', 'application/x-ndjson');
        res.setHeader('cache-control', 'no-cache, no-transform');
        res.setHeader('x-accel-buffering', 'no');
        res.flushHeaders();
        res.write('{"type":"heartbeat"}\n');
        heartbeatTimer = setInterval(() => {
            if (!res.writableEnded && !res.destroyed) res.write('{"type":"heartbeat"}\n');
        }, BACKUP_NDJSON_HEARTBEAT_MS);

        let lastProgressWrite = 0;
        const { createReadStream } = require('fs');
        restoreStream = createReadStream(filePath, { highWaterMark: IMPORT_IO_PAGE_BYTES });
        const result = await importBackupFromSource(restoreStream, {
            ...limits,
            totalBytes: fileStat.size,
            signal: abortTracker.signal,
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
        const diagnostic = logPluginStorageValidationFailure(
            '[PluginStorage] Rejected invalid server-backup row',
            error
        );
        if (sendImportIngressError(res, error, { ndjson: true })) {
            // Structured import failures include a stable publication outcome.
        } else if (!res.headersSent) {
            if (diagnostic) res.status(400).json(diagnostic);
            else next(error);
        } else {
            res.write(JSON.stringify(importNdjsonErrorEvent(error, diagnostic)) + '\n');
            res.end();
        }
    } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        abortTracker.cleanup();
        restoreStream?.destroy();
        releaseImportBarrier?.();
        if (ownsImportSlot) importInProgress = false;
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
        await importBarrier.waitUntilIdle();
        const result = await (async () => {
            const chaId = req.params.chaId;
            const chatIndex = parseInt(req.params.chatIndex, 10);
            const expectedChatId = req.headers['x-chat-id'];
            let chatId = expectedChatId;
            let row = chatId
                ? await chatRowStore.readChatRowRawWithMetadataAsync(chaId, chatId)
                : null;

            // Header-less legacy callers resolve index→id through the stripped DB.
            // A failed id lookup also keeps the historical shifted-index 409 check.
            let fallbackCacheStatus = null;
            if (!row) {
                let strippedDb = getCurrentDatabaseCacheValue(
                    DB_HEX_KEY,
                    { allowDirty: true },
                );
                if (strippedDb) {
                    fallbackCacheStatus = 'hit';
                } else {
                    const prepared = await queueStorageReadAfterImports(async () => {
                        await flushPendingDb();
                        return prepareLiveDatabaseRead('ChatContentFallback', {
                            includeFullBlob: false,
                        });
                    });
                    if (!prepared) return { status: 404, error: 'Database not found' };
                    strippedDb = prepared.strippedDatabase;
                    fallbackCacheStatus = prepared.cacheStatus;
                }
                const char = strippedDb.characters?.find(c => c?.chaId === chaId);
                const stub = char?.chats?.[chatIndex];
                if (!stub) return { status: 404, error: 'Chat not found' };
                if (expectedChatId && stub.id !== expectedChatId) {
                    return { status: 409, error: 'Chat ID mismatch — index may have shifted' };
                }
                chatId = stub.id;
                if (!chatId) return { status: 404, error: 'Chat not found' };
                row = await chatRowStore.readChatRowRawWithMetadataAsync(chaId, chatId);
            }
            if (!row) return { status: 404, error: 'Chat not found' };

            let encoded = row.bytes;
            let contentHash = row.contentHash;
            // A matching warm derivative is the fast path: raw bytes already
            // selected for the response require no decode or second store read.
            // Missing/mismatched metadata falls back to the row body once and
            // repairs the derivative only if the row's mutation token is still
            // current after the asynchronous decode.
            if (row.coldStorage !== false) {
                const chat = await decodeRisuSave(row.bytes);
                const needsRehydration = isColdStorageChat(chat);
                if (!importBarrier.isHeld()) {
                    chatRowStore.repairChatRowMetadata(
                        row,
                        needsRehydration,
                        Array.isArray(chat?.message) ? chat.message.length : 0,
                    );
                }
                if (needsRehydration) {
                    if (!restoreColdStorageChat(chat)) {
                        return { status: 500, error: 'Cold storage restore failed' };
                    }
                    encoded = Buffer.from(encodeRisuSaveLegacy(chat));
                    // Cache-fill only, so it can be skipped rather than gated: an
                    // import that claimed the barrier will replace this dataset.
                    const storedHash = importBarrier.isHeld()
                        ? null
                        : chatRowStore.writeChatRowIfUnchanged(chaId, chatId, row, chat);
                    contentHash = storedHash ?? sha256Hex(encoded);
                }
            }
            return { status: 200, encoded, contentHash, fallbackCacheStatus };
        })();
        if (result.error) return res.status(result.status).json({ error: result.error });
        const { encoded, contentHash, fallbackCacheStatus } = result;
        if (DB_CACHE_TEST_DIAGNOSTICS && fallbackCacheStatus) {
            res.setHeader('x-pocketrisu-test-db-cache', fallbackCacheStatus);
        }
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
const pendingChatDeltaCompactions = new Set();

function sendChatDeltaRefusal(res, result, status = 409) {
    const code = result?.code ?? 'CHAT_DELTA_CONFLICT';
    const messages = {
        CHAT_DELTA_BASE_MISSING: 'The chat row has no base for this delta.',
        CHAT_DELTA_BASE_UNAVAILABLE: 'The chat row does not support exact delta replay.',
        CHAT_DELTA_BASE_MISMATCH: 'The chat row changed since the acknowledged base.',
        CHAT_DELTA_LOG_CONFLICT: 'The chat operation log is not appendable.',
    };
    return res.status(status).json({
        success: false,
        error: messages[code] ?? result?.message ?? 'The chat delta was refused.',
        code,
        retryable: false,
        commitOutcome: 'not-committed',
        commitOutcomeUnknown: false,
        ...(result?.currentHash ? { currentHash: result.currentHash } : {}),
    });
}

const CHAT_ROW_BASE_HASH_HEADER = 'x-chat-base-hash';

function checkChatRowBasePrecondition(req, res, chaId, chatId) {
    const expectedBaseHash = req.headers[CHAT_ROW_BASE_HASH_HEADER];
    if (expectedBaseHash === undefined) return true;
    if (typeof expectedBaseHash !== 'string'
        || !/^[0-9a-f]{64}$/.test(expectedBaseHash)) {
        res.status(400).json({
            success: false,
            error: 'The full chat row base hash is invalid.',
            code: 'CHAT_ROW_BASE_INVALID',
            retryable: false,
            commitOutcome: 'not-committed',
            commitOutcomeUnknown: false,
        });
        return false;
    }

    const currentRow = chatRowStore.readChatRowRawWithMetadata(chaId, chatId);
    if (currentRow?.contentHash === expectedBaseHash) return true;
    res.status(409).json({
        success: false,
        error: 'The chat row changed since the acknowledged base.',
        code: 'CHAT_ROW_BASE_MISMATCH',
        retryable: false,
        commitOutcome: 'not-committed',
        commitOutcomeUnknown: false,
        ...(currentRow?.contentHash ? { currentHash: currentRow.contentHash } : {}),
    });
    return false;
}

function scheduleChatDeltaCompaction(chaId, chatId) {
    const key = chatRowKey(chaId, chatId);
    if (pendingChatDeltaCompactions.has(key)) return;
    pendingChatDeltaCompactions.add(key);
    setImmediate(() => {
        queueStorageMutation(
            () => chatRowStore.compactChatRow(chaId, chatId),
            'chat-log-compact',
        )
            .catch(error => {
                logger.error(`[ChatDelta] Compaction failed for ${key}:`, error);
            })
            .finally(() => pendingChatDeltaCompactions.delete(key));
    });
}

async function captureChatContentPreImage(req, res, chaId, chatId) {
    const reason = req.headers['x-chat-backup-reason'];
    if (!isDestructiveBackupReason(reason)) {
        await chatBackupStore.captureChatPreImage({ chaId, chatId, reason });
        return true;
    }

    try {
        await chatBackupStore.captureChatPreImage({
            chaId,
            chatId,
            reason,
            force: true,
            required: true,
        });
        return true;
    } catch (error) {
        res.status(500).json({
            success: false,
            commitOutcome: 'not-committed',
            commitOutcomeUnknown: false,
            code: 'CHAT_PREIMAGE_CAPTURE_FAILED',
            error: error?.message || String(error),
            retryable: true,
        });
        return false;
    }
}

async function handleChatDeltaWrite(req, res, next) {
    let shouldCreateBackup = false;
    let shouldCompact = false;
    try {
        await queueStorageMutation(async () => {
            const chaId = req.params.chaId;
            const expectedChatId = req.headers['x-chat-id'];
            if (!expectedChatId || typeof expectedChatId !== 'string') {
                return res.status(400).json({
                    error: 'Chat delta and x-chat-id required',
                    code: 'CHAT_DELTA_INVALID',
                    retryable: false,
                    commitOutcome: 'not-committed',
                    commitOutcomeUnknown: false,
                });
            }
            let inspection;
            try {
                inspection = chatRowStore.inspectChatDelta(
                    chaId,
                    expectedChatId,
                    req.body,
                    { maxResultBytes: bufferedIngressLimits.chat },
                );
            } catch (error) {
                if (error instanceof ChatDeltaValidationError) {
                    return sendChatDeltaRefusal(res, error, error.status ?? 400);
                }
                throw error;
            }
            if (!inspection.applied) return sendChatDeltaRefusal(res, inspection);

            // As on a full-row write, capture the exact prior logical bytes
            // after queue admission and immediately before the atomic append.
            if (!await captureChatContentPreImage(req, res, chaId, expectedChatId)) return;
            let result;
            try {
                result = chatRowStore.appendChatDelta(
                    chaId,
                    expectedChatId,
                    req.body,
                    { maxResultBytes: bufferedIngressLimits.chat },
                );
            } catch (error) {
                if (error instanceof ChatDeltaValidationError) {
                    return sendChatDeltaRefusal(res, error, error.status ?? 400);
                }
                throw error;
            }
            if (!result.applied) return sendChatDeltaRefusal(res, result);
            shouldCreateBackup = true;
            shouldCompact = result.shouldCompact;
            res.json({
                success: true,
                hash: result.hash,
                size: result.size,
                log: { count: result.logCount, bytes: result.logBytes },
            });
        }, 'chat-preimage+write');
        if (shouldCreateBackup) scheduleBackupAndRotate();
        if (shouldCompact) {
            scheduleChatDeltaCompaction(req.params.chaId, req.headers['x-chat-id']);
        }
    } catch (error) {
        if (isImportInProgressError(error)) return sendImportBusy(res);
        next(error);
    }
}

async function handleSpooledChatWrite(req, res, next, spool) {
    let prepared;
    let shouldCreateBackup = false;
    try {
        try {
            prepared = await prepareSpooledChatWrite(spool);
        } catch (error) {
            prepared = {
                stageDir: error?.admittedWriteStageDir ?? null,
                preparationError: error,
            };
        }
        // Express historically parsed JSON before the authoritative session
        // transition. Raw bodies were opaque and reached that transition
        // before binary decode. Preserve that distinction on the spool path.
        if (spool.bodyKind === 'json') {
            if (prepared.preparationError) throw prepared.preparationError;
            if (!checkActiveSession(req, res)) return;
        }
        if (!prepared.refusal && !prepared.preparationError) {
            await waitAtAdmittedWritePublishTestGate('chat');
        }
        await queueStorageMutation(async () => {
            if (prepared.preparationError) throw prepared.preparationError;
            if (prepared.refusal) {
                return res.status(prepared.refusal.status).json(prepared.refusal.body);
            }
            const chaId = req.params.chaId;
            const expectedChatId = req.headers['x-chat-id'];
            if (!prepared.chatData || !expectedChatId) {
                return res.status(400).json({ error: 'Chat data and x-chat-id required' });
            }
            if (!checkChatRowBasePrecondition(req, res, chaId, expectedChatId)) return;
            // Keep the exact old ordering: the prior authoritative row is
            // captured after queue admission and immediately before publish.
            if (!await captureChatContentPreImage(req, res, chaId, expectedChatId)) return;
            const hash = chatRowStore.writeChatRowFromFile(
                chaId,
                expectedChatId,
                prepared.filePath,
                {
                    coldStorage: prepared.coldStorage,
                    messageCount: prepared.messageCount,
                    logSupported: prepared.logSupported,
                    contentHash: prepared.contentHash,
                    chunkPlan: prepared.chunkPlan,
                },
            );
            shouldCreateBackup = true;
            res.json({ success: true, hash });
        }, 'chat-preimage+write');
        if (shouldCreateBackup) scheduleBackupAndRotate();
    } catch (error) {
        if (isImportInProgressError(error)) return sendImportBusy(res);
        const preparationRefusal = risuSavePreparationRefusal(error);
        if (error === prepared?.preparationError && preparationRefusal) {
            return res.status(preparationRefusal.status).json(preparationRefusal.body);
        }
        if (error === prepared?.preparationError
            && isAdmittedSpoolPressureError(error)) {
            return sendRetryableSpoolRefusal(
                res,
                req[BUFFERED_INGRESS_POLICY],
                bufferedIngressLimits.global,
                spool.size,
            );
        }
        next(error);
    } finally {
        if (prepared?.stageDir) {
            await fs.rm(prepared.stageDir, { recursive: true, force: true }).catch(() => {});
        }
        await disposeAdmittedIngressSpool(req);
    }
}

app.post('/api/chat-content/:chaId/:chatIndex', async (req, res, next) => {
    if (!await checkAuth(req, res)) { return; }
    const contentType = String(req.headers['content-type'] ?? '')
        .split(';', 1)[0]
        .trim()
        .toLowerCase();
    if (contentType === CHAT_DELTA_CONTENT_TYPE) {
        if (!checkActiveSession(req, res)) return;
        return handleChatDeltaWrite(req, res, next);
    }
    const admittedSpool = req[ADMITTED_INGRESS_SPOOL] ?? null;
    if (admittedSpool) {
        if (admittedSpool.bodyKind !== 'json' && !checkActiveSession(req, res)) return;
        return handleSpooledChatWrite(req, res, next, admittedSpool);
    }
    if (!checkActiveSession(req, res)) return;
    let shouldCreateBackup = false;
    try {
        await queueStorageMutation(async () => {
            const chaId = req.params.chaId;
            const expectedChatId = req.headers['x-chat-id'];
            let chatData;
            const isRawBinary = Buffer.isBuffer(req.body);
            if (isRawBinary) {
                // Binary msgpack body (application/octet-stream)
                try {
                    const inspection = await inspectRisuSaveSource(req.body);
                    chatData = inspection.format === 'raw'
                        ? await decodeRisuSave(req.body)
                        : await decodeBoundedLegacyRisuSave(req.body, {
                            inspection,
                            tempDir: databaseSpoolDir,
                            maxLegacyBytes: LEGACY_DATABASE_IMPORT_MAX_BYTES,
                        });
                } catch (e) {
                    const refusal = risuSavePreparationRefusal(e);
                    if (refusal) return res.status(refusal.status).json(refusal.body);
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

            if (!checkChatRowBasePrecondition(req, res, chaId, expectedChatId)) return;

            // This must remain immediately before the row write: every version
            // is the exact state the incoming save was about to replace.
            if (!await captureChatContentPreImage(req, res, chaId, expectedChatId)) return;
            let hash;
            if (isRawBinary && !healedHybrid) {
                hash = chatRowStore.writeChatRowRawOwned(chaId, expectedChatId, req.body, {
                    coldStorage: isColdStorageChat(chatData),
                    messageCount: Array.isArray(chatData.message) ? chatData.message.length : 0,
                    logSupported: isCanonicalRawChatRow(req.body),
                });
            } else {
                hash = chatRowStore.writeChatRow(chaId, expectedChatId, chatData);
            }
            // The authoritative row is already durable. Keep full recovery
            // snapshot assembly outside the response-critical mutation so a
            // large store cannot turn this acknowledgement into a timeout.
            shouldCreateBackup = true;
            res.json({ success: true, hash });
        }, 'chat-preimage+write');
        if (shouldCreateBackup) scheduleBackupAndRotate();
    } catch (error) {
        if (isImportInProgressError(error)) return sendImportBusy(res);
        next(error);
    }
});

// ── Save-folder migration endpoints ──────────────────────────────────────────
function decodeCanonicalHexStorageKey(filename) {
    if (typeof filename !== 'string'
        || filename.length === 0
        || filename.length % 2 !== 0
        || !hexRegex.test(filename)) return null;
    const bytes = Buffer.from(filename, 'hex');
    const key = bytes.toString('utf8');
    if (key.length === 0
        || Buffer.from(key, 'utf8').toString('hex') !== filename.toLowerCase()) return null;
    return key;
}

function scanHexFilesInDir(dirPath) {
    let files;
    try {
        files = readdirSync(dirPath);
    } catch {
        return { hexFiles: [], count: 0, totalSize: 0, hasDatabase: false };
    }
    const hexFiles = files.filter(f => decodeCanonicalHexStorageKey(f) !== null);
    let totalSize = 0;
    let hasDatabase = false;
    for (const f of hexFiles) {
        try {
            const stat = fsSync.lstatSync(path.join(dirPath, f));
            if (!stat.isFile() || stat.isSymbolicLink()) continue;
            const nextSize = totalSize + stat.size;
            if (!Number.isSafeInteger(nextSize)) continue;
            totalSize = nextSize;
            if (decodeCanonicalHexStorageKey(f) === DB_BLOB_KEY) hasDatabase = true;
        } catch { /* scan reports only accessible regular files */ }
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
    kvDel(PLUGIN_STORAGE_MANIFEST_KEY);
    kvDelPrefix(MCP_TOOL_CALL_CACHE_PREFIX);
    for (const key of chatRowStore.listAllChatRowKeys()) kvDel(key);
    // Draft rows belong to the imported chat graph. Matching rows from a legacy
    // save folder are restored only after the database has normalized its IDs.
    kvDelPrefix(DRAFT_PREFIX);
    // Drop the previous user's remote payloads. The new save folder usually
    // brings its own remotes/<id>.local.bin files (INSERT OR REPLACE), but if
    // the imported character ids reuse names from the prior user without
    // shipping a matching payload, the migration's resolveRemote would silently
    // stitch in stale cross-user data. Wiping here ensures only payloads
    // that arrived in this import survive.
    kvDelPrefix('remotes/');
    // Cold-storage rows belong to the previous user's chat graph too.
    kvDelPrefix('coldstorage/');
    // Clear remote-block migration marker — newly imported database.bin may
    // contain REMOTE blocks (it usually does, since save-folder imports
    // preserve upstream's split-character format) and we want the migration
    // to re-evaluate against the new contents during post-import ingest.
    kvDel(REMOTE_MIGRATION_MARKER_KEY);
    kvDel(CHAT_EXTERNALIZATION_MARKER_KEY);
    kvDel(CHARACTER_DEFAULTS_MARKER_KEY);
    clearEntities();
}

async function importLegacySaveEntries(
    sources,
    missingDatabaseMessage,
    { signal = null, operationId = null } = {},
) {
    throwIfImportAborted(signal);
    recoverPendingImportSwap('Save-folder import preparation');
    if (sources.length === 0) return { imported: 0 };
    const databaseEntry = sources.find((entry) => entry.key === DB_BLOB_KEY);
    if (!databaseEntry) {
        throw new Error(missingDatabaseMessage);
    }
    const databaseSource = {
        filePath: databaseEntry.filePath,
        size: databaseEntry.size,
    };
    const databaseInspection = await inspectRisuSaveSource(databaseSource);
    const streamDatabase = canStreamImportedDatabase(databaseInspection);
    if (!streamDatabase) {
        assertImportSize(
            databaseEntry.size,
            LEGACY_DATABASE_IMPORT_MAX_BYTES,
            'Legacy database',
            'LEGACY_DATABASE_IMPORT_LIMIT',
        );
    }
    throwIfImportAborted(signal);
    await flushPendingDb({ scheduleSnapshot: false });
    throwIfImportAborted(signal);
    await createBackupAndRotate({ storageAlreadyExclusive: true });
    throwIfImportAborted(signal);
    invalidateAllDbCaches();
    const existingAssetKeys = listAssetEntriesWithSizes()
        .filter((entry) => entry.source === 'fs')
        .map((entry) => entry.key);
    const assetStage = await prepareAssetImportStage();
    let assetSwap = null;
    let databaseIngestion = null;
    const deferredDraftEntries = [];
    let journal = null;
    let transactionCommitted = false;

    try {
        sqliteDb.exec('BEGIN');
        for (const key of existingAssetKeys) kvRecordDeletion(key);
        clearExistingData();
        for (const source of sources) {
            throwIfImportAborted(signal);
            const { key } = source;
            if (key === DB_BLOB_KEY && streamDatabase) continue;
            if (key === DB_BLOB_KEY) continue;
            if (key.startsWith(DRAFT_PREFIX)) {
                deferredDraftEntries.push(source);
                continue;
            }
            if (key.startsWith('assets/')) {
                await writeImportedAssetFromFile(
                    assetStage,
                    key,
                    source,
                    signal,
                );
                continue;
            }
            if (key.startsWith(PLUGIN_SAVE_PREFIX)) {
                await validateAndImportPluginValueFile(
                    key,
                    source,
                    signal,
                );
                continue;
            }
            if (key.startsWith(PLUGIN_SAVE_META_PREFIX)) {
                await validateAndImportPluginMetadataFile(
                    key,
                    source,
                    signal,
                );
            } else if (key === PLUGIN_STORAGE_MANIFEST_KEY) {
                await importOpaqueRowFromFile(key, source, signal);
            } else {
                await importOpaqueRowFromFile(
                    key,
                    source,
                    signal,
                );
            }
        }

        if (streamDatabase) {
            databaseIngestion = await ingestImportedDatabaseStreaming(
                databaseSource,
                databaseInspection,
                { signal },
            );
            markRemoteMigrationDone();
        } else {
            const decoded = await decodeBoundedLegacyRisuSave(databaseSource, {
                inspection: databaseInspection,
                tempDir: databaseSpoolDir,
                maxLegacyBytes: LEGACY_DATABASE_IMPORT_MAX_BYTES,
                shouldAbort: () => signal?.aborted === true,
                signal,
                resolveRemoteSize: async (name) => kvSize(`remotes/${name}.local.bin`),
                resolveRemote: async (name) => kvGet(`remotes/${name}.local.bin`),
            });
            databaseIngestion = await ingestDatabase(decoded, {
                skipLiveRemoteMigration: true,
            });
            markRemoteMigrationDone();
        }

        await restoreImportedDraftEntries(
            deferredDraftEntries,
            databaseIngestion?.strippedDb,
            { signal },
        );

        throwIfImportAborted(signal);
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
        throwIfImportAborted(signal);
        if (hasSaveFolderImportFailpoint('after-asset-swap')) {
            throw new ImportIngressError('Save-folder import was rolled back before publication', {
                code: 'SAVE_FOLDER_IMPORT_NOT_COMMITTED',
                statusCode: 500,
                retryable: true,
            });
        }
        // Bind the legacy-file migration completion signal to the same SQLite
        // commit as every imported row. The filesystem marker published after
        // commit is retained only for rollback and UI compatibility.
        markLegacyHexMigrationComplete(sources.length);
        setReplacementOperationOutcome(operationId, 'committed', {
            result: { ok: true, imported: sources.length },
        });
        sqliteDb.exec('COMMIT');
        transactionCommitted = true;

        runTrackedWalCheckpoint('TRUNCATE', 'save-folder-import');
        journal = { ...journal, phase: 'committed' };
        writeImportJournal(IMPORT_JOURNAL_PATH, journal);
        if (hasSaveFolderImportFailpoint('post-commit-cleanup')) {
            const failure = new Error('Injected save-folder cleanup failure after commit');
            failure.code = 'SAVE_FOLDER_IMPORT_POST_COMMIT_CLEANUP_FAILED';
            throw failure;
        }
        assetSwap.finalize();
        kvDel(IMPORT_JOURNAL_MARKER_KEY);
        clearImportJournal(IMPORT_JOURNAL_PATH);
        if (hasSaveFolderImportFailpoint('migration-marker')) {
            const failure = new Error('Injected save-folder migration-marker failure after commit');
            failure.code = 'SAVE_FOLDER_IMPORT_MIGRATION_MARKER_FAILED';
            throw failure;
        }
        publishLegacyHexMigrationMarker();
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
                try {
                    if (hasSaveFolderImportFailpoint('rollback-cleanup')) {
                        throw new Error('Injected save-folder asset rollback failure');
                    }
                    assetSwap.rollback();
                } catch (rollbackError) {
                    rollbackSucceeded = false;
                    logger.error('[Save-folder Import] Failed to restore previous asset directory:', rollbackError);
                }
            } else {
                try {
                    if (hasSaveFolderImportFailpoint('rollback-cleanup')) {
                        throw new Error('Injected save-folder staging cleanup failure');
                    }
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
            if (!rollbackSucceeded && error && typeof error === 'object') {
                error.message = 'Save-folder import outcome is unknown because rollback recovery failed';
                error.code = 'SAVE_FOLDER_IMPORT_OUTCOME_UNKNOWN';
                error.commitOutcome = 'unknown';
                error.commitOutcomeUnknown = true;
                error.statusCode = 500;
                error.retryable = false;
            }
            if (rollbackSucceeded && error && typeof error === 'object') {
                error.commitOutcome = 'not-committed';
                error.commitOutcomeUnknown = false;
            }
        } else if (error && typeof error === 'object') {
            error.commitOutcome = 'committed';
            error.commitOutcomeUnknown = false;
            error.statusCode = 500;
            error.retryable = false;
        }
        throw error;
    }

    return { imported: sources.length };
}

function createSaveFolderImportStage() {
    const stageDir = path.join(
        databaseSpoolDir,
        `${SAVE_FOLDER_IMPORT_STAGE_PREFIX}${process.pid}-${nodeCrypto.randomUUID()}`,
    );
    mkdirSync(stageDir, { recursive: false, mode: 0o700 });
    return stageDir;
}

async function stageHexFilesFromDir(dirPath, stageDir, { signal = null } = {}) {
    const keys = new Set();
    const sources = [];
    let stagedBytes = 0;
    const directory = await fs.opendir(dirPath);
    try {
        for await (const entry of directory) {
            throwIfImportAborted(signal);
            const key = decodeCanonicalHexStorageKey(entry.name);
            if (key === null) continue;
            const nextCount = sources.length + 1;
            if (nextCount > SAVE_FOLDER_IMPORT_MAX_ENTRIES) {
                throw importSizeError(
                    'Save-folder entry count',
                    SAVE_FOLDER_IMPORT_MAX_ENTRIES,
                    nextCount,
                    'IMPORT_ENTRY_COUNT_LIMIT',
                );
            }
            if (!entry.isFile()) {
                throw importFormatError(`Save-folder entry is not a regular file: ${entry.name}`, 'INVALID_SAVE_FOLDER_ENTRY');
            }
            if (keys.has(key)) {
                throw importFormatError(`Duplicate save-folder entry: ${key}`, 'DUPLICATE_SAVE_FOLDER_ENTRY');
            }
            keys.add(key);
            const sourcePath = path.join(dirPath, entry.name);
            const stat = await fs.lstat(sourcePath);
            if (!stat.isFile() || stat.isSymbolicLink()) {
                throw importFormatError(`Save-folder entry is not a regular file: ${entry.name}`, 'INVALID_SAVE_FOLDER_ENTRY');
            }
            const nextBytes = stagedBytes + stat.size;
            assertImportSize(nextBytes, BACKUP_IMPORT_MAX_BYTES, 'Save folder');
            const destination = path.join(stageDir, `${String(sources.length).padStart(8, '0')}.row`);
            const staged = await copyFileToSpool(sourcePath, destination, {
                maxBytes: BACKUP_IMPORT_MAX_BYTES,
                signal,
            });
            const actualNextBytes = stagedBytes + staged.size;
            assertImportSize(actualNextBytes, BACKUP_IMPORT_MAX_BYTES, 'Save folder');
            stagedBytes = actualNextBytes;
            sources.push({ key, filePath: staged.filePath, size: staged.size });
        }
    } finally {
        await directory.close().catch((error) => {
            if (error?.code !== 'ERR_DIR_CLOSED') throw error;
        });
    }
    if (sources.length === 0) return [];
    if (!keys.has(DB_BLOB_KEY)) {
        throw importFormatError(
            'Save folder does not contain database/database.bin',
            'SAVE_FOLDER_DATABASE_MISSING',
        );
    }
    await assertImportDiskSpace(stagedBytes);
    return sources;
}

async function importHexFilesFromDir(dirPath, options = {}) {
    const stageDir = createSaveFolderImportStage();
    try {
        const sources = await stageHexFilesFromDir(dirPath, stageDir, options);
        if (sources.length === 0) return { imported: 0 };
        return await importLegacySaveEntries(
            sources,
            'Save folder does not contain database/database.bin',
            options,
        );
    } finally {
        await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
    }
}

function sendSaveFolderImportFailure(res, error, diagnostic, { ndjson = false } = {}) {
    const annotated = authoritativeImportErrorPayload(
        error,
        'SAVE_FOLDER_IMPORT_FAILED',
    );
    // A committed or unknown transaction outcome always outranks legacy
    // validation response shapes. Those shapes are safe only after a known
    // rollback; otherwise they would falsely invite the client to replay a
    // replacement whose publication could not be recovered conclusively.
    const preserveLegacyValidation = annotated === null
        || annotated.commitOutcome === 'not-committed';
    if (!ndjson && preserveLegacyValidation && diagnostic && !res.headersSent) {
        res.status(400).json(diagnostic);
        return true;
    }
    if (!ndjson
        && preserveLegacyValidation
        && error?.risuSavePreparationInvalid === true
        && !res.headersSent) {
        res.status(400).json({ error: error.message });
        return true;
    }
    return sendImportIngressError(res, error, {
        ndjson,
        fallbackCode: 'SAVE_FOLDER_IMPORT_FAILED',
        includeAnnotatedOutcome: true,
    });
}

app.get('/api/replacement-operations/:operationId', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        const operationId = req.params.operationId;
        if (!REPLACEMENT_OPERATION_ID_REGEX.test(operationId)) {
            return res.status(400).json({ error: 'Invalid replacement operation ID' });
        }
        const operation = parseReplacementOperationRow(
            readReplacementOperation.get(operationId),
        );
        if (!operation) {
            return res.status(404).json({ error: 'Replacement operation not found' });
        }
        res.setHeader('cache-control', 'no-store');
        res.json(operation);
    } catch (error) {
        next(error);
    }
});

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
    const abortTracker = createImportAbortTracker(req, res);
    let ownsImportSlot = false;
    let releaseImportBarrier = null;
    let operationId = null;
    let heartbeatTimer = null;
    const wantsNdjson = String(req.headers.accept ?? '').includes('application/x-ndjson');
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
        if (importInProgress) {
            res.status(409).json({ error: 'Another import is already in progress' });
            return;
        }
        importInProgress = true;
        ownsImportSlot = true;
        if (wantsNdjson) {
            operationId = registerReplacementOperation(req, 'save-folder-directory');
            heartbeatTimer = beginReplacementNdjson(res);
            sendReplacementProgress(res, 'queued');
        }
        releaseImportBarrier = await importBarrier.acquire(abortTracker.signal);
        throwIfImportAborted(abortTracker.signal);
        if (wantsNdjson) sendReplacementProgress(res, 'staging');

        const result = await importHexFilesFromDir(resolved, {
            signal: abortTracker.signal,
            operationId,
        });
        if (operationId
            && readReplacementOperation.get(operationId)?.state === 'running') {
            setReplacementOperationOutcome(operationId, 'committed', {
                result: { ok: true, imported: result.imported },
            });
        }
        if (wantsNdjson) {
            sendReplacementDone(res, operationId, { ok: true, imported: result.imported });
        } else {
            res.json({ ok: true, imported: result.imported });
        }
    } catch (error) {
        finalizeReplacementOperationError(
            operationId,
            error,
            'SAVE_FOLDER_IMPORT_FAILED',
        );
        const diagnostic = logPluginStorageValidationFailure(
            '[PluginStorage] Rejected invalid save-folder row',
            error
        );
        if (!sendSaveFolderImportFailure(res, error, diagnostic, { ndjson: wantsNdjson })) {
            if (wantsNdjson && res.headersSent) {
                if (!res.writableEnded && !res.destroyed) {
                    res.write(`${JSON.stringify(importNdjsonErrorEvent(
                        error,
                        diagnostic,
                        'SAVE_FOLDER_IMPORT_FAILED',
                    ))}\n`);
                    res.end();
                }
                return;
            }
            res.status(400).json(diagnostic ?? { error: error.message || 'Import failed' });
        }
    } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        abortTracker.cleanup();
        releaseImportBarrier?.();
        if (ownsImportSlot) importInProgress = false;
    }
});

app.post('/api/migrate/save-folder/upload', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    const abortTracker = createImportAbortTracker(req, res);
    let ownsImportSlot = false;
    let releaseImportBarrier = null;
    let prevRequestTimeout;
    let stageDir = null;
    let operationId = null;
    let heartbeatTimer = null;
    const wantsNdjson = String(req.headers.accept ?? '').includes('application/x-ndjson');

    try {
        const contentType = String(req.headers['content-type'] ?? '');
        if (contentType
            && !contentType.includes('application/zip')
            && !contentType.includes('application/octet-stream')) {
            res.status(415).json({ error: 'Unsupported save-folder archive content-type' });
            return;
        }
        const contentLength = importContentLength(req, 'Save-folder ZIP');
        if (contentLength !== null) {
            assertImportSize(contentLength, BACKUP_IMPORT_MAX_BYTES, 'Save-folder ZIP');
            await assertImportDiskSpace(contentLength);
        }
        if (importInProgress) {
            res.status(409).json({ error: 'Another import is already in progress' });
            return;
        }
        importInProgress = true;
        ownsImportSlot = true;
        if (wantsNdjson) {
            operationId = registerReplacementOperation(req, 'save-folder-zip');
            heartbeatTimer = beginReplacementNdjson(res);
            sendReplacementProgress(res, 'queued');
        }
        releaseImportBarrier = await importBarrier.acquire(abortTracker.signal);
        throwIfImportAborted(abortTracker.signal);

        req.socket.setTimeout(0);
        req.socket.setKeepAlive(true);
        prevRequestTimeout = req.socket.server?.requestTimeout;
        if (req.socket.server) req.socket.server.requestTimeout = 0;

        stageDir = createSaveFolderImportStage();
        if (wantsNdjson) sendReplacementProgress(res, 'uploading');
        const zipPath = path.join(stageDir, 'upload.zip');
        const zipSpool = await spoolAsyncIterable(req, zipPath, {
            maxBytes: BACKUP_IMPORT_MAX_BYTES,
            expectedBytes: contentLength,
            signal: abortTracker.signal,
        });
        await assertImportDiskSpace(zipSpool.size);
        if (wantsNdjson) sendReplacementProgress(res, 'inspecting');
        const inventory = await inspectZipFile(zipSpool.filePath, {
            acceptEntry: (entryPath) => {
                const basename = path.posix.basename(entryPath.replaceAll('\\', '/'));
                const key = decodeCanonicalHexStorageKey(basename);
                return key === null ? null : { key };
            },
            maxEntries: SAVE_FOLDER_IMPORT_MAX_ENTRIES,
            maxExpandedBytes: BACKUP_IMPORT_MAX_BYTES,
            signal: abortTracker.signal,
        });
        if (inventory.entries.length === 0) {
            throw importFormatError('No compatible hex files found in ZIP', 'SAVE_FOLDER_ENTRIES_MISSING');
        }
        if (!inventory.entries.some((entry) => entry.key === DB_BLOB_KEY)) {
            throw importFormatError(
                'Data does not contain database/database.bin',
                'SAVE_FOLDER_DATABASE_MISSING',
            );
        }
        await assertImportDiskSpace(inventory.expandedBytes);
        if (wantsNdjson) sendReplacementProgress(res, 'extracting');
        const sources = await extractZipEntries(
            inventory,
            path.join(stageDir, 'rows'),
            { signal: abortTracker.signal },
        );
        throwIfImportAborted(abortTracker.signal);
        const result = await importLegacySaveEntries(
            sources,
            'Data does not contain database/database.bin',
            { signal: abortTracker.signal, operationId },
        );
        if (operationId
            && readReplacementOperation.get(operationId)?.state === 'running') {
            setReplacementOperationOutcome(operationId, 'committed', {
                result: { ok: true, imported: result.imported },
            });
        }
        await fs.rm(stageDir, { recursive: true, force: true });
        stageDir = null;
        if (wantsNdjson) {
            sendReplacementDone(res, operationId, { ok: true, imported: result.imported });
        } else {
            res.json({ ok: true, imported: result.imported });
        }
    } catch (error) {
        finalizeReplacementOperationError(
            operationId,
            error,
            'SAVE_FOLDER_IMPORT_FAILED',
        );
        const diagnostic = logPluginStorageValidationFailure(
            '[PluginStorage] Rejected invalid uploaded save-folder row',
            error
        );
        if (!sendSaveFolderImportFailure(res, error, diagnostic, { ndjson: wantsNdjson })) {
            if (wantsNdjson && res.headersSent) {
                if (!res.writableEnded && !res.destroyed) {
                    res.write(`${JSON.stringify(importNdjsonErrorEvent(
                        error,
                        diagnostic,
                        'SAVE_FOLDER_IMPORT_FAILED',
                    ))}\n`);
                    res.end();
                }
                return;
            }
            if (!res.headersSent) {
                res.status(400).json(diagnostic ?? { error: error.message || 'Import failed' });
            }
        }
    } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        abortTracker.cleanup();
        if (stageDir) await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
        releaseImportBarrier?.();
        if (ownsImportSlot) importInProgress = false;
        if (req.socket.server && prevRequestTimeout !== undefined) {
            req.socket.server.requestTimeout = prevRequestTimeout;
        }
    }
});

app.post('/api/migrate/save-folder/cleanup/scan', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    try {
        if (!isLegacyHexMigrationComplete()) {
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
        if (!isLegacyHexMigrationComplete()) {
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

const DB_BACKUP_PREFIX = 'database/dbbackup-';
const INTERNAL_SNAPSHOT_KEY_PATTERN = /^database\/dbbackup-(0|[1-9]\d*)\.bin$/;
const ASSET_PREFIXES = ['assets/', 'remotes/', 'inlay/', 'inlay_thumb/', 'inlay_meta/', 'inlay_info/', 'coldstorage/'];

app.post('/api/assets/cleanup', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    try {
        res.json(await runServerAssetCleanup({ source: 'endpoint' }));
    } catch (error) {
        if (isImportInProgressError(error)) return sendImportBusy(res);
        next(error);
    }
});

function parseInternalSnapshotKey(key) {
    if (typeof key !== 'string') return null;
    const match = INTERNAL_SNAPSHOT_KEY_PATTERN.exec(key);
    if (!match) return null;
    const snapshotTimestamp = Number(match[1]);
    const timestamp = snapshotTimestamp * 100;
    if (!Number.isSafeInteger(snapshotTimestamp) || snapshotTimestamp < 0
        || !Number.isSafeInteger(timestamp) || timestamp < 0) return null;
    return { key, timestamp };
}

function internalSnapshotMetadata(key) {
    const parsed = parseInternalSnapshotKey(key);
    if (!parsed) return null;
    let size = null;
    try {
        size = kvSize(key);
    } catch (error) {
        // Discovery must retain an exact corrupt candidate so boot recovery can
        // submit it to the definitive restore boundary, then try an older key.
        if (error?.code !== 'KV_CHUNK_CORRUPT') throw error;
    }
    if (size !== null && (!Number.isSafeInteger(size) || size < 0)) return null;
    return { ...parsed, size };
}

function listInternalSnapshotMetadata() {
    const keys = kvList(DB_BACKUP_PREFIX);
    try {
        const sizes = new Map(
            kvListWithSizes(DB_BACKUP_PREFIX).map((entry) => [entry.key, entry.size]),
        );
        return keys.map((key) => {
            const parsed = parseInternalSnapshotKey(key);
            if (!parsed) return null;
            const size = sizes.get(key);
            return Number.isSafeInteger(size) && size >= 0 ? { ...parsed, size } : null;
        });
    } catch (error) {
        if (error?.code !== 'KV_CHUNK_CORRUPT') throw error;
        // Discovery must still retain each corrupt candidate with size:null so
        // boot recovery can try it and continue to an older snapshot. The rare
        // damaged-state path deliberately falls back to the per-key verifier.
        return keys.map(internalSnapshotMetadata);
    }
}

function statsBasename(s) {
    if (!s) return '';
    return String(s).replace(/\\/g, '/').split('/').pop();
}

// Storage statistics and the destructive collector share one reachability
// implementation, including inline and active-generation optimized plugin data.
function buildReachableAssetBasenameSet(dbObj) {
    const assetEntries = listAssetEntriesWithSizes();
    return new Set([...collectDatabaseAssetReferences(dbObj, assetEntries)]
        .map((key) => statsBasename(key)));
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

const coldStorageBackupSizeMemo = new Map();

function estimateColdStorageBackupSize() {
    const storedRows = kvListWithSizes('coldstorage/');
    const storedSizeByKey = new Map(storedRows.map((row) => [row.key, row.size]));
    const canonicalKeys = Array.from(new Set(
        storedRows.map((row) => normalizeColdStorageStorageKey(row.key)),
    )).sort((a, b) => a.localeCompare(b));
    const liveCanonicalKeys = new Set(canonicalKeys);
    for (const key of coldStorageBackupSizeMemo.keys()) {
        if (!liveCanonicalKeys.has(key)) coldStorageBackupSizeMemo.delete(key);
    }

    let size = 0;
    let recomputed = 0;
    for (const canonicalKey of canonicalKeys) {
        const legacyKey = `${canonicalKey}.json`;
        const storageKey = storedSizeByKey.has(canonicalKey) ? canonicalKey : legacyKey;
        const storedSize = storedSizeByKey.get(storageKey);
        const updatedAt = kvGetUpdatedAt(storageKey);
        const signalIsUsable = Number.isSafeInteger(updatedAt)
            && updatedAt >= 0
            && Number.isSafeInteger(storedSize)
            && storedSize >= 0;
        const memo = signalIsUsable ? coldStorageBackupSizeMemo.get(canonicalKey) : null;
        if (memo
            && memo.storageKey === storageKey
            && memo.updatedAt === updatedAt
            && memo.storedSize === storedSize) {
            size += memo.outputSize;
            continue;
        }

        const entry = readColdStorageJsonEntry(canonicalKey, {
            migrateLegacy: true,
            allowPlainJsonFallback: true,
        });
        if (!entry) {
            throw new Error(`[ColdStorage] missing cold storage entry while exporting: ${canonicalKey}`);
        }
        // Backup output is the re-stringified JSON, not the stored gzip payload.
        const outputSize = Buffer.from(JSON.stringify(entry.coldData), 'utf-8').length;
        size += outputSize;
        recomputed++;

        let finalStorageKey = storageKey;
        let finalStoredSize = storedSize;
        let finalUpdatedAt = updatedAt;
        if (entry.storageKey !== entry.canonicalKey || entry.format !== 'gzip') {
            finalStorageKey = entry.canonicalKey;
            finalStoredSize = kvSize(finalStorageKey);
            finalUpdatedAt = kvGetUpdatedAt(finalStorageKey);
        }
        if (Number.isSafeInteger(finalUpdatedAt)
            && finalUpdatedAt >= 0
            && Number.isSafeInteger(finalStoredSize)
            && finalStoredSize >= 0) {
            coldStorageBackupSizeMemo.set(canonicalKey, {
                storageKey: finalStorageKey,
                updatedAt: finalUpdatedAt,
                storedSize: finalStoredSize,
                outputSize,
            });
        } else {
            coldStorageBackupSizeMemo.delete(canonicalKey);
        }
    }
    return { size, recomputed };
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
    for (const it of listDraftBackupEntries(sizeReader)) total += it.size;
    for (const it of listAssetEntriesWithSizes(sizeReader)) total += it.size;
    for (const it of sizeReader.kvListWithSizes('inlay_meta/')) total += it.size;
    let coldRowsRecomputed;
    if (reader) {
        const coldEntries = listColdStorageBackupEntries({ reader, migrateLegacy: false });
        for (const entry of coldEntries) total += entry.size;
        coldRowsRecomputed = coldEntries.length;
    } else {
        const coldEstimate = estimateColdStorageBackupSize();
        total += coldEstimate.size;
        coldRowsRecomputed = coldEstimate.recomputed;
    }
    total += await sumInlayFsBytes();
    return { size: total, coldRowsRecomputed };
}

if (STORAGE_QUEUE_DIAG_ENABLED) {
    app.get('/api/debug/queue-diag', async (req, res) => {
        if (!await checkAuth(req, res)) return;
        res.json(storageQueueDiagSnapshot());
    });
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
        const synchronous = sqliteDb.pragma('synchronous', { simple: true });
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
        const backupEntries = kvListWithSizes(DB_BACKUP_PREFIX);
        const backupKeys = backupEntries.map((entry) => entry.key);
        let backupTotal = 0;
        let backupOldest = null, backupNewest = null;
        for (const entry of backupEntries) {
            const k = entry.key;
            backupTotal += entry.size;
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
        const chatSizes = kvListWithSizes('chats/');
        const chatSizeByKey = new Map(chatSizes.map((entry) => [entry.key, entry.size]));
        for (const key of chatKeys) {
            const metadata = chatRowStore.metadataForKey(key);
            chatTotal += metadata?.logCount > 0
                ? metadata.contentSize
                : (chatSizeByKey.get(key) || 0);
        }
        for (const entry of chatSizes) chatKvRowSize += entry.size;
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

        // Optimized plugin storage is one physical category made up of value
        // rows, owner sidecars, and the publication manifest. Keep its logical
        // payload total separate from its SQLite footprint: chunked rows leave
        // only a small marker in kv and store their bodies in chunks.
        const pluginStorageEntries = [
            ...kvListWithSizes(PLUGIN_SAVE_PREFIX),
            ...kvListWithSizes(PLUGIN_SAVE_META_PREFIX),
            ...kvListSelectedWithSizes([PLUGIN_STORAGE_MANIFEST_KEY]),
        ];
        const pluginStorageTotalSize = pluginStorageEntries
            .reduce((total, entry) => total + entry.size, 0);
        const pluginStorageKv = sqliteDb.prepare(
            `SELECT COUNT(*) AS c, COALESCE(SUM(LENGTH(value)), 0) AS b
             FROM kv
             WHERE key LIKE 'pluginsave/%'
                OR key LIKE 'pluginsave-meta/%'
                OR key = @manifestKey`
        ).get({ manifestKey: PLUGIN_STORAGE_MANIFEST_KEY });
        // Attribute a shared chunk to chats first so dashboard categories stay
        // disjoint. Chunks shared with database snapshots but not chats belong
        // to plugin storage; every remaining chunk stays in the database slice.
        const pluginStorageChunkBytes = sqliteDb.prepare(
            `SELECT COALESCE(SUM(LENGTH(data)), 0) AS b
             FROM chunks
             WHERE hash IN (
                 SELECT hash FROM manifest_chunks
                 WHERE manifest_key LIKE 'pluginsave/%'
                    OR manifest_key LIKE 'pluginsave-meta/%'
                    OR manifest_key = @manifestKey
             )
               AND hash NOT IN (
                 SELECT hash FROM manifest_chunks WHERE manifest_key LIKE 'chats/%'
             )`
        ).get({ manifestKey: PLUGIN_STORAGE_MANIFEST_KEY }).b;
        const pluginStorage = {
            count: pluginStorageKv.c,
            totalSize: pluginStorageTotalSize,
            kvRowSize: pluginStorageKv.b,
            chunkBytes: pluginStorageChunkBytes,
            physicalSize: pluginStorageKv.b + pluginStorageChunkBytes,
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
        const stripped = getCurrentDatabaseCacheValue(DB_HEX_KEY, { allowDirty: true });
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
            const uncleanable = buildReachableAssetBasenameSet(stripped);
            for (const it of listAssetEntriesWithSizes()) {
                if (!uncleanable.has(statsBasename(it.key))) {
                    orphan.count++;
                    orphan.totalSize += it.size;
                }
            }
            orphan.available = true;
        }

        let estimatedBackupSize;
        let coldRowsRecomputed = 0;
        if (!HUB_HOSTING_MODE) {
            const estimate = await estimateServerBackupSize();
            estimatedBackupSize = estimate.size;
            coldRowsRecomputed = estimate.coldRowsRecomputed;
        }
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

        if (DB_CACHE_TEST_DIAGNOSTICS) {
            res.setHeader(
                'x-pocketrisu-test-cold-rows-recomputed',
                String(coldRowsRecomputed),
            );
        }
        res.json({
            hubHosting: HUB_HOSTING_MODE,
            files,
            disk,
            ...(backupDisk ? { backupDisk } : {}),
            sqlite: { pageSize, pageCount, freelistCount, reclaimable, journalMode, synchronous, autoVacuum },
            chunks: { count: chunkStat.c, bytes: chunkStat.b, orphanBytes: orphanChunkBytes, liveChunked },
            prefixes,
            pluginStorage,
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
        const prepared = await queueStorageReadAfterImports(async () => {
            await flushPendingDb();
            return prepareLiveDatabaseRead('StatsCharacters', {
                includeFullBlob: false,
            });
        });
        if (!prepared) {
            res.json({ characters: [], orphan: { count: 0, totalSize: 0 }, chatBytesNote: 'estimate' });
            return;
        }
        const dbObj = prepared.strippedDatabase;

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

        const uncleanable = buildReachableAssetBasenameSet(dbObj);
        let orphanCount = 0, orphanTotal = 0;
        for (const it of listAssetEntriesWithSizes()) {
            if (!uncleanable.has(statsBasename(it.key))) {
                orphanCount++;
                orphanTotal += it.size;
            }
        }

        characters.sort((a, b) => b.totalBytes - a.totalBytes);
        if (DB_CACHE_TEST_DIAGNOSTICS) {
            res.setHeader('x-pocketrisu-test-db-cache', prepared.cacheStatus);
        }
        res.json({
            characters,
            orphan: { count: orphanCount, totalSize: orphanTotal },
            chatBytesNote: 'JSON.stringify estimate; on-disk msgpack ~0.6×',
            etag: prepared.etag,
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
        const prepared = await queueStorageReadAfterImports(async () => {
            await flushPendingDb();
            return prepareLiveDatabaseRead('StatsModules', {
                includeFullBlob: false,
            });
        });
        if (!prepared) {
            res.json({ modules: [] });
            return;
        }
        const dbObj = prepared.strippedDatabase;
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
        if (DB_CACHE_TEST_DIAGNOSTICS) {
            res.setHeader('x-pocketrisu-test-db-cache', prepared.cacheStatus);
        }
        res.json({ modules, etag: prepared.etag });
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
                ? getCurrentDatabaseCacheValue(DB_HEX_KEY)
                    || await loadStrippedDatabase(rawDb, 'Optimize')
                : { characters: [] };
            const chatSweep = await chatRowStore.sweepOrphanChatRows(strippedDb, {
                graceMs: CHAT_ORPHAN_GRACE_MS,
                capturePreImage: identity => chatBackupStore.captureChatPreImage({
                    ...identity,
                    reason: 'orphan-sweep',
                    force: true,
                    required: true,
                }),
                onPreImageCaptureFailure: (identity, error) => {
                    logger.warn(
                        `[Optimize] Skipping orphan chat row ${identity.chaId}/${identity.chatId}; `
                        + `required pre-image capture failed: ${error?.message || error}`
                    );
                },
            });
            logger.info(
                `[Optimize] Chat row sweep deleted ${chatSweep.deleted} orphan row(s); `
                + `skipped ${chatSweep.skippedRecent} recent row(s) and `
                + `${chatSweep.skippedPreImage} row(s) without a captured pre-image`
            );
            // Reclaim chunks orphaned by edits/snapshot rotation before VACUUM, so
            // their pages get compacted in the same pass. Serialized with saves by
            // the surrounding queueStorageOperation.
            let gcDeleted = 0;
            try { gcDeleted = gcChunks(); } catch (e) { logger.warn('[Optimize] chunk gc failed:', e?.message || e); }
            try { runTrackedWalCheckpoint('TRUNCATE', 'optimize-before-vacuum'); } catch (e) { logger.warn('[Optimize] checkpoint failed:', e?.message || e); }
            sqliteDb.exec('VACUUM');
            // VACUUM streams the whole DB through the WAL; without this checkpoint the
            // -wal file stays inflated until the next 5-min background TRUNCATE.
            try { runTrackedWalCheckpoint('TRUNCATE', 'optimize-after-vacuum'); } catch (e) { logger.warn('[Optimize] post-VACUUM checkpoint failed:', e?.message || e); }
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
                orphanChatRowsSkippedPreImage: chatSweep.skippedPreImage,
            };
        });
        res.json(result);
    } catch (err) {
        if (isImportInProgressError(err)) return sendImportBusy(res);
        next(err);
    }
});

app.get('/api/db/durability', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    try {
        res.json(sqliteDurabilityState());
    } catch (err) { next(err); }
});

app.put('/api/db/durability', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    if (sqliteDurabilityManaged) {
        return res.status(403).json({
            error: 'SQLite durability is managed by the server administrator',
            ...sqliteDurabilityState(),
        });
    }
    const nextMode = normalizeSqliteDurabilityMode(req.body?.mode);
    if (!nextMode) {
        return res.status(400).json({
            error: 'mode must be one of: durable, balanced, performance',
        });
    }
    try {
        await queueStorageMutation(() => {
            const previousMode = sqliteDurabilityMode;
            // Persist the operator choice through a FULL commit before applying
            // a requested downgrade. This also makes every earlier NORMAL-mode
            // transaction durable before the endpoint acknowledges the change.
            sqliteDb.pragma('synchronous = FULL');
            try {
                kvSet(SQLITE_DURABILITY_CONFIG_KEY, Buffer.from(nextMode, 'utf-8'));
                sqliteDurabilityMode = nextMode;
                applySqliteDurabilityMode();
            } catch (error) {
                sqliteDurabilityMode = previousMode;
                applySqliteDurabilityMode();
                throw error;
            }
        });
        rescheduleSqliteDurabilityCheckpoint();
        res.json(sqliteDurabilityState());
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
            const checkpoint = runTrackedWalCheckpoint('TRUNCATE', 'manual-cleanup');
            const elapsed = Date.now() - t0;
            const postWalSize = statSafe(walFilePath)?.size ?? 0;
            return {
                ok: checkpoint.complete,
                checkpoint,
                elapsedMs: elapsed,
                preWalSize,
                postWalSize,
                reclaimed: Math.max(0, preWalSize - postWalSize),
            };
        });
        if (!result.ok) return res.status(503).json(result);
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
        const out = await queueStorageReadAfterImports(() => listInternalSnapshotMetadata()
            .filter(Boolean)
            .sort((a, b) => b.timestamp - a.timestamp || b.key.localeCompare(a.key)));
        res.json({ snapshots: out });
    } catch (err) { next(err); }
});

app.delete('/api/db/snapshots', async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    try {
        const key = typeof req.query?.key === 'string' ? req.query.key : '';
        // Require the complete canonical name — a prefix sibling must never be
        // deletable through this endpoint.
        if (!parseInternalSnapshotKey(key)) {
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
    let restoreCommitted = false;
    let restoreSpool = null;
    let restorePublicationStarted = false;
    let closed = false;
    let releaseImportBarrier = null;
    let operationId = null;
    let heartbeatTimer = null;
    const wantsNdjson = String(req.headers.accept ?? '').includes('application/x-ndjson');
    const restoreAbortController = new AbortController();
    const restoreSocket = req.socket;
    const abortRestoreOnDisconnect = () => {
        // `close` also follows a normal completed response.  Only an unfinished
        // response represents the peer disappearing while spooling/publishing.
        if (res.writableEnded) return;
        closed = true;
        if (!restoreCommitted && !restoreAbortController.signal.aborted) {
            restoreAbortController.abort(new Error('Snapshot restore client disconnected'));
        }
    };
    const throwIfRestoreAborted = () => {
        if (!restoreAbortController.signal.aborted) return;
        const error = new Error('Snapshot restore client disconnected');
        error.code = 'KV_STREAM_ABORTED';
        throw error;
    };
    req.once('aborted', abortRestoreOnDisconnect);
    restoreSocket?.once('close', abortRestoreOnDisconnect);
    res.once('close', abortRestoreOnDisconnect);
    // Authentication and session validation both yield before this lifecycle
    // tracker is installed. Seed cancellation from the current stream/socket
    // state so a disconnect observed during either await cannot be lost before
    // the restore enters (or waits for) the import barrier.
    if (req.aborted
        || (req.destroyed && !req.complete)
        || res.destroyed
        || restoreSocket?.destroyed) {
        abortRestoreOnDisconnect();
    }
    try {
        const key = typeof req.body?.key === 'string' ? req.body.key : '';
        if (!parseInternalSnapshotKey(key)) {
            return res.status(400).json({
                error: 'Invalid snapshot key',
                retryable: false,
                commitOutcome: 'not-committed',
                commitOutcomeUnknown: false,
            });
        }
        if (wantsNdjson) {
            operationId = registerReplacementOperation(req, 'internal-snapshot');
            heartbeatTimer = beginReplacementNdjson(res);
            sendReplacementProgress(res, 'queued');
        }
        // Acquire before entering the storage queue: acquire() drains that same
        // queue, so holding a slot while waiting for it would deadlock.
        // The disconnect signal must participate in this wait. Otherwise an
        // abandoned restore remains queued behind a long-running import until
        // that holder releases, retaining its request lifecycle unnecessarily.
        releaseImportBarrier = await importBarrier.acquire(restoreAbortController.signal);
        throwIfRestoreAborted();
        if (wantsNdjson) sendReplacementProgress(res, 'spooling');
        let snapshotFound = true;
        let committedPublication = null;
        {
            await queueStorageOperation(async () => {
                throwIfRestoreAborted();
                // Drain any pending debounced persist first — same pattern as
                // /api/db/optimize. Without this, an in-flight save could land
                // after kvCopyValue and overwrite the restored snapshot.
                await flushPendingDb();
                throwIfRestoreAborted();
                // Read only after the import barrier is held. The importer uses
                // this same SQLite connection, so an earlier cursor could observe
                // its uncommitted snapshot rows and publish transient state. Spool
                // one persisted chunk at a time instead of assembling the value.
                const restorePath = path.join(
                    databaseSpoolDir,
                    `${DATABASE_SPOOL_FILE_PREFIX}snapshot-restore-${process.pid}-${nodeCrypto.randomUUID()}.tmp`,
                );
                restoreSpool = await kvWriteToFile(key, restorePath, {
                    signal: restoreAbortController.signal,
                });
                if (!restoreSpool) {
                    snapshotFound = false;
                    return;
                }
                const source = {
                    filePath: restoreSpool.filePath,
                    size: restoreSpool.size,
                };
                const inspection = await inspectRisuSaveSource(source);
                throwIfRestoreAborted();
                if (wantsNdjson) sendReplacementProgress(res, 'publishing');
                let restoreTransactionOpen = false;
                try {
                    // Keep the live monolith, external plugin rows, ownership
                    // sidecars, chat rows, and migration markers in one rollback
                    // boundary. Both ingest paths join an existing transaction.
                    // The spool and inspection both yield.  Re-check the real
                    // socket-derived AbortSignal immediately before opening the
                    // publication transaction, and again before COMMIT.
                    throwIfRestoreAborted();
                    sqliteDb.exec('BEGIN');
                    restorePublicationStarted = true;
                    restoreTransactionOpen = true;
                    let ingestion;
                    if (inspection.supported) {
                        // Every supported snapshot ingests from the bounded file
                        // cursor. This avoids kvGet()/Buffer.concat() even below
                        // the general import streaming threshold.
                        kvDel(REMOTE_MIGRATION_MARKER_KEY);
                        invalidateAllDbCaches();
                        ingestion = await ingestDatabaseStreaming(source, {
                            inspection,
                            shouldAbort: () => restoreAbortController.signal.aborted,
                            signal: restoreAbortController.signal,
                            onDecodedChunk: () => waitAtSnapshotRestoreDecodeTestGate(
                                restoreAbortController.signal,
                            ),
                        });
                        markRemoteMigrationDone();
                    } else {
                        // Compatibility formats that cannot be cursor-walked
                        // safely are decoded only below an explicit finite cap.
                        // Compressed legacy inputs still expand through the same
                        // disk-backed output meter and AbortSignal as canonical
                        // gzip/zlib, so no fallback performs an unbounded read or
                        // synchronous expansion bomb.
                        kvDel(REMOTE_MIGRATION_MARKER_KEY);
                        invalidateAllDbCaches();
                        const decoded = await decodeBoundedLegacyRisuSave(source, {
                            inspection,
                            tempDir: savePath,
                            shouldAbort: () => restoreAbortController.signal.aborted,
                            signal: restoreAbortController.signal,
                            onDecodedChunk: () => waitAtSnapshotRestoreDecodeTestGate(
                                restoreAbortController.signal,
                            ),
                            // Check the logical value length from chunk metadata
                            // before kvGet is allowed to concatenate its chunks.
                            resolveRemoteSize: async (name) => {
                                if (snapshotRestoreRemoteFailpoint === 'size') {
                                    throw new Error('Injected REMOTE size read failure');
                                }
                                return kvSize(`remotes/${name}.local.bin`);
                            },
                            resolveRemote: async (name) => {
                                if (snapshotRestoreRemoteFailpoint === 'body') {
                                    throw new Error('Injected REMOTE body read failure');
                                }
                                return kvGet(`remotes/${name}.local.bin`);
                            },
                        });
                        // `decoded` is the requested snapshot. Running the live
                        // REMOTE migration here would replace it with the current
                        // database.bin after the marker was cleared.
                        ingestion = await ingestDatabase(decoded, {
                            skipLiveRemoteMigration: true,
                        });
                        markRemoteMigrationDone();
                    }
                    if (ingestion) {
                        const strippedBytes = Buffer.from(encodeRisuSaveLegacy(ingestion.strippedDb));
                        committedPublication = {
                            strippedBytes,
                            strippedDb: ingestion.strippedDb,
                        };
                    }
                    // A restore can replace a broad logical database state. Force every
                    // browser list cache to take one full snapshot after it completes.
                    kvBumpListEpoch();
                    if (snapshotRestoreFailpoint === 'before-commit') {
                        throw new Error('Injected snapshot restore failure before commit');
                    }
                    throwIfRestoreAborted();
                    setReplacementOperationOutcome(operationId, 'committed', {
                        result: { ok: true, key },
                    });
                    sqliteDb.exec('COMMIT');
                    restoreTransactionOpen = false;
                    restoreCommitted = true;
                } catch (error) {
                    if (restoreTransactionOpen) {
                        try { sqliteDb.exec('ROLLBACK'); } catch (rollbackError) {
                            logger.error('[Snapshot Restore] Failed to roll back SQLite transaction:', rollbackError);
                        }
                    }
                    // The cache and ETag may have been derived from tentative rows.
                    invalidateAllDbCaches();
                    dbEtag = null;
                    throw error;
                }
            });
        }
        if (!snapshotFound) {
            if (closed) return;
            if (wantsNdjson) {
                const error = new Error('Snapshot not found');
                error.code = 'SNAPSHOT_NOT_FOUND';
                error.statusCode = 404;
                error.retryable = false;
                error.commitOutcome = 'not-committed';
                error.commitOutcomeUnknown = false;
                throw error;
            }
            return res.status(404).json({
                error: 'Snapshot not found',
                retryable: false,
                commitOutcome: 'not-committed',
                commitOutcomeUnknown: false,
            });
        }
        if (committedPublication) {
            dbEtag = computeBufferEtag(committedPublication.strippedBytes);
            try {
                rememberSessionPluginStorageState(req, committedPublication.strippedDb);
            } catch (error) {
                // Session pinning is disposable process state. The SQLite
                // publication has committed; a pin failure must not turn its
                // acknowledgement into a false rollback report.
                logger.error('[Snapshot Restore] Failed to refresh session read state:', error);
            }
        }
        if (closed) return;
        if (snapshotRestoreFailpoint === 'response') {
            res.destroy();
            return;
        }
        if (wantsNdjson) {
            sendReplacementDone(res, operationId, { ok: true, key });
        } else {
            res.json({
                ok: true,
                key,
                commitOutcome: 'committed',
                commitOutcomeUnknown: false,
            });
        }
    } catch (err) {
        const diagnostic = pluginStorageValidationDiagnostic(err);
        if (err && typeof err === 'object') {
            if (restoreCommitted) {
                err.commitOutcome = 'committed';
                err.commitOutcomeUnknown = false;
                err.retryable = false;
            } else if (err.commitOutcome !== 'unknown') {
                err.commitOutcome = 'not-committed';
                err.commitOutcomeUnknown = false;
            }
        }
        finalizeReplacementOperationError(
            operationId,
            err,
            'SNAPSHOT_RESTORE_NOT_COMMITTED',
        );
        if (wantsNdjson && res.headersSent && !closed) {
            if (!res.writableEnded && !res.destroyed) {
                res.write(`${JSON.stringify(importNdjsonErrorEvent(
                    err,
                    diagnostic ? {
                        ...diagnostic,
                        status: 400,
                        retryable: false,
                        commitOutcome: 'not-committed',
                        commitOutcomeUnknown: false,
                    } : null,
                    restoreCommitted
                        ? 'SNAPSHOT_RESTORE_COMMIT_FAILED'
                        : 'SNAPSHOT_RESTORE_NOT_COMMITTED',
                ))}\n`);
                res.end();
            }
            return;
        }
        if (restoreCommitted) {
            logger.error('[Snapshot Restore] Commit succeeded but acknowledgement failed:', err);
            if (closed) return;
            if (!res.headersSent) {
                res.status(500).json({
                    error: 'Snapshot restore committed, but acknowledgement failed',
                    code: 'SNAPSHOT_RESTORE_COMMIT_UNKNOWN',
                    retryable: false,
                    commitOutcome: 'unknown',
                    commitOutcomeUnknown: true,
                });
            } else {
                res.destroy();
            }
            return;
        }
        if (closed) {
            logger.warn(restorePublicationStarted
                ? '[Snapshot Restore] Client disconnected before commit; transaction was rolled back'
                : '[Snapshot Restore] Client disconnected before publication; partial spool was discarded');
            return;
        }
        if (diagnostic) return res.status(400).json({
            ...diagnostic,
            retryable: false,
            commitOutcome: 'not-committed',
            commitOutcomeUnknown: false,
        });
        if (isImportInProgressError(err)) return sendImportBusy(res);
        if (err?.risuSavePreparationInvalid === true) {
            return res.status(400).json({
                error: err.message,
                code: err.code,
                retryable: false,
                commitOutcome: 'not-committed',
                commitOutcomeUnknown: false,
            });
        }
        if (err?.risuSavePreparationLimit === true) {
            return res.status(413).json({
                error: err.message,
                code: err.code,
                limit: err.limit,
                actual: err.actual,
                retryable: false,
                commitOutcome: 'not-committed',
                commitOutcomeUnknown: false,
            });
        }
        if (err instanceof PluginStorageLimitError) {
            return res.status(413).json({
                error: err.message,
                code: err.code,
                limit: err.limit,
                actual: err.actual,
                retryable: false,
                commitOutcome: 'not-committed',
                commitOutcomeUnknown: false,
            });
        }
        logger.error('[Snapshot Restore] Transaction was not committed:', err);
        res.status(500).json({
            error: 'Snapshot restore was not committed',
            code: 'SNAPSHOT_RESTORE_NOT_COMMITTED',
            retryAfter: 0,
            retryable: true,
            commitOutcome: 'not-committed',
            commitOutcomeUnknown: false,
        });
    } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        releaseImportBarrier?.();
        req.off('aborted', abortRestoreOnDisconnect);
        restoreSocket?.off('close', abortRestoreOnDisconnect);
        res.off('close', abortRestoreOnDisconnect);
        if (restoreSpool?.filePath) {
            await fs.unlink(restoreSpool.filePath).catch(() => {});
        }
    }
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
        sweepServerBackupTemps(backupsDir);
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

async function waitAtInlayCompressionBeforeCommitTestGate() {
    if (process.env.NODE_ENV !== 'test') return;
    const configured = String(
        process.env.POCKETRISU_TEST_INLAY_COMPRESS_BEFORE_COMMIT_GATE_DIR ?? '',
    ).trim();
    if (!configured) return;
    const gateDir = path.resolve(configured);
    const holdPath = path.join(gateDir, 'hold');
    if (!existsSync(holdPath)) return;
    await fs.mkdir(gateDir, { recursive: true });
    await fs.writeFile(path.join(gateDir, 'entered'), 'converted', 'utf-8');
    const releasePath = path.join(gateDir, 'release');
    while (existsSync(holdPath) && !existsSync(releasePath)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

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
                const source = await fs.open(entry.filePath, 'r');
                let sourceStat;
                let original;
                try {
                    sourceStat = await source.stat();
                    original = await source.readFile();
                    const afterRead = await source.stat();
                    if (!samePinnedSourceStat(afterRead, sourceStat)) {
                        throw new Error('Inlay changed while preparing compression');
                    }
                } finally {
                    await source.close().catch(() => {});
                }
                const img = vips.Image.newFromBuffer(original)
                let webpBuf
                try {
                    const out = img.writeToBuffer('.webp', { Q: quality })
                    webpBuf = Buffer.from(out);
                } finally {
                    img.delete()
                }

                if (webpBuf.length < original.length) {
                    await waitAtInlayCompressionBeforeCommitTestGate();
                    const published = await queueStorageMutation(async () => {
                        const currentPath = await resolveInlayFilePath(entry.id);
                        if (currentPath !== entry.filePath) return false;
                        const currentStat = await fs.stat(currentPath).catch(() => null);
                        if (!currentStat || !samePinnedSourceStat(currentStat, sourceStat)) {
                            return false;
                        }
                        const sidecar = await readInlaySidecar(entry.id);
                        const info = sidecar || {};
                        try {
                            await writeInlayFile(
                                entry.id,
                                'webp',
                                webpBuf,
                                { ...info, ext: 'webp' },
                            );
                        } catch (cause) {
                            const publicationError = new Error(
                                `Failed to publish compressed inlay ${entry.id}: ${cause?.message || cause}`,
                                { cause },
                            );
                            publicationError.code = 'INLAY_PUBLICATION_FAILED';
                            publicationError.inlayId = entry.id;
                            throw publicationError;
                        }
                        kvDel(`inlay_thumb/${entry.id}`);
                        return true;
                    });
                    if (published) {
                        const saved = original.length - webpBuf.length;
                        totalSaved += saved;
                        compressed++;
                    } else {
                        skipped++;
                    }
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
                if (entryError?.code === 'INLAY_PUBLICATION_FAILED') {
                    send({
                        type: 'error',
                        code: entryError.code,
                        id: entryError.inlayId,
                        message: entryError.message,
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
            try {
                const persisted = await queueStorageMutation(
                    () => flushPendingDb({ scheduleSnapshot: false }),
                );
                if (persisted) await createBackupAndRotate();
            } catch {}
            try {
                await runTrackedWalCheckpointWithBusyRetry('TRUNCATE', 'self-update');
            } catch {}

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
    const diagnostic = logPluginStorageValidationFailure(
        '[PluginStorage] Rejected invalid ingested row',
        err
    );
    if (diagnostic) {
        res.status(400).json(diagnostic);
        return;
    }
    if (err instanceof PluginStorageLimitError) {
        return res.status(413).json({
            error: err.message,
            code: err.code,
            limit: err.limit,
            actual: err.actual,
            retryable: false,
            commitOutcome: 'not-committed',
            commitOutcomeUnknown: false,
        });
    }
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
        let bootDatabaseValidated = true;
        try {
            // Migration helpers are intentionally mutation-heavy: they publish
            // completion markers, safety backups, external rows, and rewritten
            // live bytes. Validate first so a corrupt monolith enters recovery
            // mode without changing even the list epoch.
            const bootDatabase = kvGet('database/database.bin');
            if (bootDatabase) await preflightBootDatabase(bootDatabase);
        } catch (error) {
            bootDatabaseValidated = false;
            // A damaged live monolith must not make every recovery API
            // unreachable. Preserve it and every physical plugin row byte-for-
            // byte; authenticated bootstrap can now inspect internal snapshots
            // and publish a selected one through /api/db/snapshots/restore.
            invalidateDbCache();
            dbEtag = null;
            const diagnostic = pluginStorageValidationDiagnostic(error);
            logger.error(
                '[BootRecovery] Live database could not be normalized; '
                + 'starting in snapshot-recovery mode without changing storage'
                + (diagnostic
                    ? ` (${diagnostic.code}: ${diagnostic.encodedKey})`
                    : ` (${error?.name || 'decode error'})`),
            );
        }
        if (bootDatabaseValidated) {
            kvBumpListEpoch();
            logger.info('[ListDelta] Bumped list epoch at startup');
            migrateAssetsToFilesystem();
            await migrateInlaysToFilesystem();
            await migrateChatsToRowsIfNeeded();
            await migrateCharacterDefaultsIfNeeded();
            // The chat marker can already exist on databases restored by older
            // Node-only versions, so independently inspect the steady-state stub
            // for folded optimized plugin storage before accepting clients.
            const bootDatabase = kvGet('database/database.bin');
            if (bootDatabase) await loadStrippedDatabase(bootDatabase, 'Migration');
            await migrateRemoteBlocksIfNeeded();
            // Private transition stages are ordinary migration state. Reconcile
            // them only after the authoritative live database has passed the
            // same read-only preflight, so a corrupt boot remains byte-exact.
            await reconcilePluginTransitionStagesAtStartup();
        }
        // A prior process may have exited while the snapshot cooldown was
        // deferring an already-committed plugin publication.
        schedulePluginRecoverySnapshot();
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
        if (!logPluginStorageValidationFailure(
            '[PluginStorage] Rejected invalid row during startup',
            error
        )) {
            logger.error('[Server] Failed to start server :', error);
        }
        process.exit(1);
    }
}

// Graceful shutdown: flush pending patches and checkpoint WAL before exit
for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, async () => {
        console.log(`[Server] Received ${sig}, flushing pending data...`);
        try {
            const persisted = await queueStorageMutation(
                () => flushPendingDb({ scheduleSnapshot: false }),
            );
            if (persisted) await createBackupAndRotate();
        } catch (e) { logger.error('[Server] Flush error:', e); }
        try {
            await runTrackedWalCheckpointWithBusyRetry('TRUNCATE', 'graceful-shutdown');
        } catch { /* non-fatal */ }
        if (sig === 'SIGTERM' && STORAGE_QUEUE_DIAG_ENABLED) {
            logStorageQueueDiagSummary();
        }
        try { modelJobs.close(); } catch (e) { logger.error('[ModelJobs] Close error:', e); }
        try { requestLogs.close(); } catch (e) { logger.error('[RequestLogs] Close error:', e); }
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
        for (const job of partialExportJobs.values()) {
            if (now < job.expiresAt) continue;
            job.state = 'cancelled';
            job.abortController.abort();
            partialExportJobs.delete(job.id);
            if (!job.preparation || job.progress.phase === 'ready' || job.progress.phase === 'failed') {
                cleanupPartialExportJob(job).catch(error => {
                    logger.warn('[Partial Backup Export] TTL cleanup failed:', error);
                });
            }
        }
        prunePartialExportCancellationTombstones(now);
    }, Math.min(PROXY_STREAM_GC_INTERVAL_MS, PARTIAL_EXPORT_GC_INTERVAL_MS));

    await startServer();
    startSqliteDurabilityCheckpointScheduler();
    scheduleServerAssetCleanup();

    chatBackupStore.reconcileChatBackups()
        .then((result) => {
            logger.info(
                `[ChatBackups] Startup reconcile complete: `
                + `${result.framesCreated} frame(s), `
                + `${result.legacyBundlesMigrated} legacy bundle migration(s), `
                + `${result.budgetItemsRemoved} budget eviction(s)`
            );
        })
        .catch(error => logger.error('[ChatBackups] Startup reconcile failed:', error));

    setInterval(() => {
        try { kvCleanupOldDeletions(); }
        catch { /* non-fatal */ }
    }, 60 * 60 * 1000); // every hour

})();
