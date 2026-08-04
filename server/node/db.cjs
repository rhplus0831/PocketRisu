'use strict';

const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { createChunkStore, createSnapshotReader } = require('./chunkStore.cjs');
const {
    createDatabaseRevisionTracker,
    createPluginStoragePublicationRevisionTracker,
} = require('./databaseRevision.cjs');
const {
    createPluginStorageOwnerScanner,
    validatePluginStorageRow,
} = require('./pluginStorageJson.cjs');
const {
    createPluginStorageViewerFacetSnapshot,
    createPluginStorageViewerFacetStore,
    pluginStorageViewerDisplaySize,
} = require('./pluginStorageViewerFacets.cjs');
const {
    PLUGIN_VALUE_MAX_BYTES,
    PLUGIN_STORAGE_MAX_BYTES,
    isPluginValueKey,
    assertPluginValueSize,
    assertPluginStorageTotal,
} = require('./pluginStorageLimits.cjs');

const saveDir = path.join(process.cwd(), 'save');
if (!fs.existsSync(saveDir)) {
    fs.mkdirSync(saveDir, { recursive: true });
}
const dbPath = path.join(saveDir, 'risuai.db');
const db = new Database(dbPath);

// Process-local invalidation token for derived views of optimized plugin
// values. It is deliberately monotonic rather than transactional: an outer
// transaction rollback may cause an unnecessary cache miss, but can never
// leave a stale derived result cached.
let pluginStorageMutationVersion = 0;

function notePluginStorageMutation(key) {
    if (isPluginValueKey(key)) pluginStorageMutationVersion += 1;
}

function getPluginStorageMutationVersion() {
    return pluginStorageMutationVersion;
}

// WAL mode: better concurrent read performance, single-writer
db.pragma('journal_mode = WAL');
// Start in the power-loss durable mode. server.cjs may apply an explicit
// operator-selected downgrade after it has loaded the persisted server setting,
// but missing/invalid settings and early startup migrations must stay safe.
db.pragma('synchronous = FULL');
db.pragma('cache_size = -64000');       // 64 MB (default 2 MB) — reduce disk I/O for large blobs
db.pragma('temp_store = MEMORY');       // keep temp tables in RAM
db.pragma('busy_timeout = 5000');       // wait up to 5 s on lock contention
db.pragma('mmap_size = 268435456');     // 256 MB memory-mapped I/O for faster reads
// Cap WAL file size after a reset checkpoint. Without this, a one-time spike
// (backup import, VACUUM, large asset upload) leaves the -wal file permanently
// at its peak size since RESTART/TRUNCATE rewind the writer but never shrink
// the file unless this limit is set.
db.pragma('journal_size_limit = 268435456');  // 256 MB

// ─── KV table (replaces /save/ hex files) ────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS kv (
    key        TEXT    PRIMARY KEY,
    value      BLOB    NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
  )
`);
const databaseRevisionTracker = createDatabaseRevisionTracker(db);
const pluginStoragePublicationRevisionTracker =
    createPluginStoragePublicationRevisionTracker(db);
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_kv_updated_at_key ON kv(updated_at, key);

  CREATE TABLE IF NOT EXISTS deleted_keys (
    key        TEXT    PRIMARY KEY,
    deleted_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_deleted_keys_at ON deleted_keys(deleted_at);

  CREATE TABLE IF NOT EXISTS sync_meta (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    list_epoch TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS plugin_storage_usage (
    id    INTEGER PRIMARY KEY CHECK (id = 1),
    bytes INTEGER NOT NULL CHECK (bytes >= 0)
  );

  CREATE TABLE IF NOT EXISTS plugin_storage_owners (
    storage_key TEXT PRIMARY KEY,
    owner       TEXT NOT NULL
  );

  -- Destructive replacement outcomes are operational metadata, not user data.
  -- Keeping them outside the KV table means a save-folder or snapshot replacement can
  -- publish its terminal outcome in the same SQLite transaction without that
  -- record being folded into backups or cleared by the replacement itself.
  CREATE TABLE IF NOT EXISTS replacement_operations (
    operation_id TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,
    state        TEXT NOT NULL CHECK (state IN ('running', 'committed', 'not-committed', 'unknown')),
    result_json  TEXT,
    error_json   TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );

  -- One-time storage migration state is operational metadata. Keeping the
  -- commit record outside kv binds it to the SQLite file without exposing it
  -- through backups or deleting it during a logical database replacement.
  CREATE TABLE IF NOT EXISTS storage_migrations (
    migration_id TEXT    PRIMARY KEY,
    version      INTEGER NOT NULL CHECK (version >= 1),
    completed_at INTEGER NOT NULL,
    source_count INTEGER NOT NULL CHECK (source_count >= 0)
  );
`);
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_replacement_operations_updated_at
    ON replacement_operations(updated_at)
`);
db.prepare(`INSERT OR IGNORE INTO sync_meta (id, list_epoch) VALUES (1, ?)`).run(crypto.randomUUID());
db.prepare(`INSERT OR IGNORE INTO plugin_storage_usage (id, bytes) VALUES (1, 0)`).run();

// Entity tables (characters, chats, settings, presets, modules) were used in
// a previous version. The tables are no longer created or used, but existing
// databases may still contain them. They are left in place (orphaned) to avoid
// destructive DDL on upgrade. clearEntities() handles cleanup during import.

// ─── Migration: /save/ hex files → kv table ──────────────────────────────────
const savePath = path.join(process.cwd(), 'save');
const migrationMarker = path.join(process.cwd(), 'save', '.migrated_to_sqlite');
const LEGACY_HEX_MIGRATION_ID = 'legacy-hex-files-to-sqlite';
const LEGACY_HEX_MIGRATION_VERSION = 1;
const stmtGetStorageMigration = db.prepare(`
  SELECT version, completed_at, source_count
  FROM storage_migrations
  WHERE migration_id = ?
`);
const stmtSetStorageMigration = db.prepare(`
  INSERT INTO storage_migrations (migration_id, version, completed_at, source_count)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(migration_id) DO UPDATE SET
    version = excluded.version,
    completed_at = excluded.completed_at,
    source_count = excluded.source_count
  WHERE storage_migrations.version <= excluded.version
`);

function isLegacyHexMigrationComplete() {
    const state = stmtGetStorageMigration.get(LEGACY_HEX_MIGRATION_ID);
    return Number(state?.version ?? 0) >= LEGACY_HEX_MIGRATION_VERSION;
}

function markLegacyHexMigrationComplete(sourceCount = 0) {
    const normalizedCount = Number.isSafeInteger(sourceCount) && sourceCount >= 0
        ? sourceCount
        : 0;
    stmtSetStorageMigration.run(
        LEGACY_HEX_MIGRATION_ID,
        LEGACY_HEX_MIGRATION_VERSION,
        Date.now(),
        normalizedCount,
    );
}

function fsyncDirectory(directory) {
    let fd;
    try {
        fd = fs.openSync(directory, 'r');
        fs.fsyncSync(fd);
    } catch (error) {
        // Directory fsync is unavailable on some supported filesystems. The
        // transactional SQLite completion row remains the authority there.
        if (!['EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(error?.code)) {
            throw error;
        }
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

function publishLegacyHexMigrationMarker() {
    const temporaryMarker = `${migrationMarker}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const bytes = Buffer.from(new Date().toISOString(), 'utf-8');
    let fd;
    try {
        fd = fs.openSync(temporaryMarker, 'wx', 0o600);
        let offset = 0;
        while (offset < bytes.length) {
            const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
            if (written <= 0) throw new Error('Legacy migration marker write made no progress');
            offset += written;
        }
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(temporaryMarker, migrationMarker);
        fsyncDirectory(savePath);
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch {}
        }
        try { fs.rmSync(temporaryMarker, { force: true }); } catch {}
    }
}

function ensureLegacyHexMigrationMarker() {
    if (fs.existsSync(migrationMarker)) return;
    try {
        publishLegacyHexMigrationMarker();
    } catch (error) {
        // The marker is a rollback/UI compatibility artifact. The completion
        // row committed with the migrated values is the source of truth.
        console.warn('[DB] Could not publish legacy migration marker:', error?.message || error);
    }
}

function migrateFromSaveDir() {
    if (!fs.existsSync(savePath)) return;
    if (isLegacyHexMigrationComplete()) {
        ensureLegacyHexMigrationMarker();
        return;
    }

    const hexRegex = /^[0-9a-fA-F]+$/;
    let files;
    try {
        files = fs.readdirSync(savePath);
    } catch {
        return;
    }

    const hexFiles = files.filter(f => hexRegex.test(f));
    const markerExists = fs.existsSync(migrationMarker);
    if (hexFiles.length === 0) {
        // Older versions and completed save-folder imports have only the
        // filesystem marker. Adopt it when no preserved sources can be checked;
        // future migrations will commit both state and data atomically.
        if (markerExists) {
            db.transaction(() => markLegacyHexMigrationComplete(0))();
        }
        return;
    }

    const exists = db.prepare(`SELECT 1 FROM kv WHERE key = ?`);
    const databaseHexName = Buffer.from(DB_BLOB_KEY, 'utf-8').toString('hex');
    const hasLegacyDatabase = hexFiles.some(file => file.toLowerCase() === databaseHexName);

    // A legacy marker without transactional state may predate the durable
    // migration protocol. The old import was one SQLite transaction, so the
    // authoritative database row proves that transaction committed. Adopt it
    // without resurrecting individual keys deliberately deleted since then.
    if (markerExists && (!hasLegacyDatabase || exists.get(DB_BLOB_KEY))) {
        db.transaction(() => markLegacyHexMigrationComplete(hexFiles.length))();
        console.log('[DB] Verified legacy migration marker against SQLite state.');
        return;
    }

    if (markerExists) {
        console.warn('[DB] Legacy migration marker has no matching SQLite database; recovering preserved files.');
    }
    console.log(`[DB] Migrating ${hexFiles.length} file(s) from /save/ to SQLite...`);

    const run = db.transaction(() => {
        for (let i = 0; i < hexFiles.length; i++) {
            if (i % 100 === 0 || i === hexFiles.length - 1) {
                console.log(`[DB] Migrating... ${i + 1}/${hexFiles.length}`);
            }
            const key = Buffer.from(hexFiles[i], 'hex').toString('utf-8');
            // SQLite is authoritative once a key has been imported.  In
            // particular, chunkStore.putValue() uses INSERT OR REPLACE, so a
            // stale legacy file must be skipped before entering that path.
            if (exists.get(key)) continue;
            // Every namespace uses the file-backed chunk gate. Unknown legacy
            // keys are just as entitled to a bounded migration as built-ins.
            chunkStore.putValueFromFile(key, path.join(savePath, hexFiles[i]), {
                updatedAt: kvMutationUpdatedAt(key),
            });
            stmtRemoveDeletion.run(key);
        }
        // This is the authoritative completion signal. A crash can expose
        // neither the migrated values nor this row, or both, but never a marker
        // that suppresses a rolled-back migration.
        markLegacyHexMigrationComplete(hexFiles.length);
    });
    run();

    ensureLegacyHexMigrationMarker();
    console.log(`[DB] Migration complete. ${hexFiles.length} files preserved in /save/.`);
    console.log(`[DB] To free disk space, remove migrated files via Settings > Clean Up Save Folder.`);
}

// Chunk-aware store for every logical KV namespace. Small values remain raw
// SQLite rows; large values use protected manifests. Built before
// migrateFromSaveDir so legacy values can stream into the same representation.
const DB_BLOB_KEY = 'database/database.bin';
const chunkThreshold = process.env.POCKETRISU_CHUNK_THRESHOLD
    ? Number(process.env.POCKETRISU_CHUNK_THRESHOLD)
    : undefined;
const chunkStore = createChunkStore(db, { threshold: chunkThreshold });
const pluginStorageViewerFacets = createPluginStorageViewerFacetStore(db, {
    failpoint: process.env.NODE_ENV === 'test'
        ? String(process.env.POCKETRISU_TEST_PLUGIN_VIEWER_FACET_FAILPOINT ?? '').trim()
        : '',
});

// Test-only kvSet failure injection, parsed once at startup:
//   key:<exact-key> or prefix:<key-prefix>:<nth-write>
function parseKvSetFailpoint(raw) {
    if (!raw) return null;
    if (raw.startsWith('key:')) {
        const key = raw.slice('key:'.length);
        return key ? { type: 'key', key } : null;
    }
    if (raw.startsWith('prefix:')) {
        const value = raw.slice('prefix:'.length);
        const separator = value.lastIndexOf(':');
        if (separator <= 0) return null;
        const prefix = value.slice(0, separator);
        const nth = Number(value.slice(separator + 1));
        if (!Number.isInteger(nth) || nth < 1) return null;
        return { type: 'prefix', prefix, nth, seen: 0 };
    }
    return null;
}

const kvSetFailpoint = parseKvSetFailpoint(process.env.POCKETRISU_TEST_FAILPOINT);

// ─── KV operations ────────────────────────────────────────────────────────────
// All writes route through chunkStore; reads/deletes/sizes/copies are likewise
// chunk-aware for every key. Values below the threshold still use direct rows.
const stmtKvList   = db.prepare(`SELECT key FROM kv`);
const stmtKvPrefix = db.prepare(`SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\'`);
const stmtKvDelPrefix = db.prepare(`DELETE FROM kv WHERE key LIKE ? ESCAPE '\\'`);
const stmtManifestDelPrefix = db.prepare(`DELETE FROM manifest_chunks WHERE manifest_key LIKE ? ESCAPE '\\'`);
const stmtManifestMetaDelPrefix = db.prepare(`DELETE FROM chunk_manifest_meta WHERE manifest_key LIKE ? ESCAPE '\\'`);
const stmtManifestPublicationDelPrefix = db.prepare(`DELETE FROM chunk_manifest_publications WHERE manifest_key LIKE ? ESCAPE '\\'`);
const stmtManifestInventoryDelPrefix = db.prepare(`DELETE FROM chunk_manifest_inventory_revision WHERE manifest_key LIKE ? ESCAPE '\\'`);
const stmtKvUpdatedAt = db.prepare(`SELECT updated_at FROM kv WHERE key = ?`);
const stmtKvDeletedAt = db.prepare(`SELECT deleted_at FROM deleted_keys WHERE key = ?`);
const stmtRecordDeletion = db.prepare(`INSERT OR REPLACE INTO deleted_keys (key, deleted_at) VALUES (?, ?)`);
const stmtRemoveDeletion = db.prepare(`DELETE FROM deleted_keys WHERE key = ?`);
const stmtDeletedSince = db.prepare(`SELECT key FROM deleted_keys WHERE deleted_at >= ?`);
const stmtDeletedSincePrefix = db.prepare(`SELECT key FROM deleted_keys WHERE deleted_at >= ? AND key LIKE ? ESCAPE '\\'`);
const stmtModifiedSince = db.prepare(
    `SELECT key FROM kv INDEXED BY idx_kv_updated_at_key WHERE updated_at >= ?`,
);
const stmtModifiedSincePrefix = db.prepare(
    `SELECT key FROM kv INDEXED BY idx_kv_updated_at_key
     WHERE updated_at >= ? AND key LIKE ? ESCAPE '\\'`,
);
const stmtCleanupDeletions = db.prepare(`DELETE FROM deleted_keys WHERE deleted_at < ?`);
const stmtRecordDeletionBulk = db.prepare(
    `INSERT OR REPLACE INTO deleted_keys (key, deleted_at)
     SELECT key,
            CASE WHEN key LIKE 'coldstorage/%'
                       AND updated_at >= @deletedAt
                       AND updated_at < 9007199254740991
                 THEN updated_at + 1
                 ELSE @deletedAt
            END
       FROM kv WHERE key LIKE @pattern ESCAPE '\\'`
);
const stmtGetListEpoch = db.prepare(`SELECT list_epoch FROM sync_meta WHERE id = 1`);
const stmtSetListEpoch = db.prepare(`UPDATE sync_meta SET list_epoch = ? WHERE id = 1`);
const stmtGetPluginStorageUsage = db.prepare(`SELECT bytes FROM plugin_storage_usage WHERE id = 1`);
const stmtSetPluginStorageUsage = db.prepare(`UPDATE plugin_storage_usage SET bytes = ? WHERE id = 1`);
const stmtSetPluginStorageOwner = db.prepare(
    `INSERT OR REPLACE INTO plugin_storage_owners (storage_key, owner) VALUES (?, ?)`,
);
const stmtDeletePluginStorageOwner = db.prepare(
    `DELETE FROM plugin_storage_owners WHERE storage_key = ?`,
);
const stmtDeletePluginStorageOwnerPrefix = db.prepare(
    `DELETE FROM plugin_storage_owners WHERE storage_key LIKE ? ESCAPE '\\'`,
);

const DELETION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PLUGIN_STORAGE_META_PREFIX = 'pluginsave-meta/';

function pluginStorageOwnerFromBytes(key, value) {
    if (!key.startsWith(PLUGIN_STORAGE_META_PREFIX) || !Buffer.isBuffer(value)) return null;
    try {
        const text = value.toString('utf-8');
        if (!Buffer.from(text, 'utf-8').equals(value)) return null;
        const parsed = JSON.parse(text);
        return parsed
            && typeof parsed === 'object'
            && !Array.isArray(parsed)
            && typeof parsed.plugin === 'string'
            && parsed.plugin.length > 0
            && parsed.plugin.isWellFormed()
            ? parsed.plugin
            : null;
    } catch {
        return null;
    }
}

function normalizedPluginStorageOwner(owner) {
    return typeof owner === 'string'
        && owner.length > 0
        && owner.isWellFormed()
        ? owner
        : null;
}

function setPluginStorageOwnerIndex(key, owner) {
    if (!key.startsWith(PLUGIN_STORAGE_META_PREFIX)) return;
    const normalized = normalizedPluginStorageOwner(owner);
    if (normalized === null) stmtDeletePluginStorageOwner.run(key);
    else stmtSetPluginStorageOwner.run(key, normalized);
}

function pluginStorageOwnerFromFile(filePath) {
    const scanner = createPluginStorageOwnerScanner();
    const fd = fs.openSync(filePath, 'r');
    const page = Buffer.allocUnsafe(64 * 1024);
    try {
        let offset = 0;
        while (true) {
            const bytesRead = fs.readSync(fd, page, 0, page.length, offset);
            if (bytesRead === 0) break;
            scanner.push(page.subarray(0, bytesRead));
            offset += bytesRead;
        }
        return scanner.finish();
    } catch {
        return null;
    } finally {
        fs.closeSync(fd);
    }
}

function pluginStorageOwnerFromReader(reader, key) {
    const scanner = createPluginStorageOwnerScanner();
    try {
        const size = reader.kvSize(key);
        if (!Number.isSafeInteger(size) || size < 0) return null;
        for (let offset = 0; offset < size; offset += 64 * 1024) {
            scanner.push(reader.kvReadRange(
                key,
                offset,
                Math.min(64 * 1024, size - offset),
            ));
        }
        return scanner.finish();
    } catch {
        return null;
    }
}

function updatePluginStorageOwnerIndex(key, value) {
    if (!key.startsWith(PLUGIN_STORAGE_META_PREFIX)) return;
    setPluginStorageOwnerIndex(key, pluginStorageOwnerFromBytes(key, value));
}

function getPluginStorageUsage() {
    return stmtGetPluginStorageUsage.get().bytes;
}

function assertPluginWriteWithinLimits(key, nextSize, previousSize) {
    if (!isPluginValueKey(key)) return;
    // A legacy repository may already exceed a newly configured limit. Permit
    // strict size-decreasing repairs, but never allow it to grow further.
    if (nextSize > PLUGIN_VALUE_MAX_BYTES && nextSize >= previousSize) {
        assertPluginValueSize(nextSize);
    }
    const currentTotal = getPluginStorageUsage();
    const nextTotal = currentTotal - previousSize + nextSize;
    if (nextTotal > PLUGIN_STORAGE_MAX_BYTES && nextTotal >= currentTotal) {
        assertPluginStorageTotal(nextTotal);
    }
    return nextTotal;
}

function updatePluginStorageUsageForWrite(key, nextSize, previousSize) {
    if (!isPluginValueKey(key)) return;
    stmtSetPluginStorageUsage.run(getPluginStorageUsage() - previousSize + nextSize);
}

let activePluginStorageQuotaPlan = null;

/**
 * Validate a logical multi-row plugin mutation against its final state, then
 * suppress order-dependent intermediate quota checks while the enclosing
 * SQLite transaction applies exactly those changes.
 */
function withPluginStorageQuotaPlan(changes, operation) {
    if (activePluginStorageQuotaPlan) return operation();
    const planned = new Map();
    const pluginChanges = [];
    const requestedKeys = new Set();
    for (const change of changes) {
        if (!isPluginValueKey(change.key)) continue;
        if (requestedKeys.has(change.key)) {
            throw new Error(`Duplicate plugin quota plan key: ${change.key}`);
        }
        requestedKeys.add(change.key);
        pluginChanges.push(change);
    }
    const previousSizes = new Map(
        chunkStore.listValuesWithSizesForKeys([...requestedKeys])
            .map((entry) => [entry.key, entry.size]),
    );
    for (const change of pluginChanges) {
        const previousSize = previousSizes.get(change.key) ?? 0;
        const nextSize = change.size === null ? 0 : change.size;
        if (!Number.isSafeInteger(nextSize) || nextSize < 0) assertPluginValueSize(nextSize);
        if (nextSize > PLUGIN_VALUE_MAX_BYTES && nextSize >= previousSize) {
            assertPluginValueSize(nextSize);
        }
        planned.set(change.key, { previousSize, nextSize, consumed: false });
    }
    const currentTotal = getPluginStorageUsage();
    const finalTotal = [...planned.values()].reduce(
        (total, change) => total - change.previousSize + change.nextSize,
        currentTotal,
    );
    if (finalTotal > PLUGIN_STORAGE_MAX_BYTES && finalTotal >= currentTotal) {
        assertPluginStorageTotal(finalTotal);
    }
    const run = db.transaction(() => {
        activePluginStorageQuotaPlan = { planned, finalTotal };
        try {
            const result = operation();
            for (const [key, change] of planned) {
                if (!change.consumed) throw new Error(`Plugin quota plan did not mutate ${key}`);
            }
            stmtSetPluginStorageUsage.run(finalTotal);
            return result;
        } finally {
            activePluginStorageQuotaPlan = null;
        }
    });
    return run();
}

function consumePluginStorageQuotaPlan(key, nextSize) {
    if (!activePluginStorageQuotaPlan || !isPluginValueKey(key)) return false;
    const change = activePluginStorageQuotaPlan.planned.get(key);
    if (!change || change.consumed || change.nextSize !== nextSize) {
        throw new Error(`Plugin storage mutation did not match its quota plan for ${key}`);
    }
    change.consumed = true;
    return true;
}

function kvMutationUpdatedAt(key) {
    const now = Date.now();
    if (!key.startsWith('coldstorage/')) return now;
    // The cold backup-size memo treats updated_at as a row token. Include the
    // deletion journal so delete/reinsert and same-millisecond rewrites advance.
    const previous = Math.max(
        stmtKvUpdatedAt.get(key)?.updated_at ?? -1,
        stmtKvDeletedAt.get(key)?.deleted_at ?? -1,
    );
    return Number.isSafeInteger(previous)
        && previous >= now
        && previous < Number.MAX_SAFE_INTEGER
        ? previous + 1
        : now;
}

const runKvSet = db.transaction((key, value, displaySizeProvided, providedDisplaySize) => {
    if (typeof key !== 'string') throw new TypeError('KV key must be a string');
    const facetsWereCurrent = pluginStorageViewerFacets.state().current;
    let displaySize = null;
    let facetsMaintained = true;
    if (isPluginValueKey(key)) {
        if (displaySizeProvided) displaySize = providedDisplaySize;
        else {
            try {
                displaySize = pluginStorageViewerDisplaySize(
                    validatePluginStorageRow(key, value),
                );
            } catch {
                // Low-level maintenance and pre-generation rows may be
                // quarantined invalid JSON. Preserve the authoritative bytes,
                // remove any stale derivative, and force a viewer rebuild.
                facetsMaintained = false;
            }
        }
    }
    const previousSize = isPluginValueKey(key) ? (chunkStore.sizeValue(key) ?? 0) : 0;
    const quotaPlanned = consumePluginStorageQuotaPlan(key, value.length);
    if (!quotaPlanned) assertPluginWriteWithinLimits(key, value.length, previousSize);
    chunkStore.putValue(key, value, { updatedAt: kvMutationUpdatedAt(key) });
    notePluginStorageMutation(key);
    if (!quotaPlanned) updatePluginStorageUsageForWrite(key, value.length, previousSize);
    updatePluginStorageOwnerIndex(key, value);
    if (displaySize !== null) pluginStorageViewerFacets.maintainValue(key, displaySize);
    else if (isPluginValueKey(key)) pluginStorageViewerFacets.removeValue(key);
    stmtRemoveDeletion.run(key);
    pluginStorageViewerFacets.finishMaintainedMutation(facetsWereCurrent, facetsMaintained);
});

const runKvSetFromFile = db.transaction((
    key,
    filePath,
    size,
    ownerProvided,
    providedOwner,
    displaySizeProvided,
    providedDisplaySize,
    chunkPlan,
) => {
    if (typeof key !== 'string') throw new TypeError('KV key must be a string');
    const facetsWereCurrent = pluginStorageViewerFacets.state().current;
    const previousSize = isPluginValueKey(key) ? (chunkStore.sizeValue(key) ?? 0) : 0;
    const quotaPlanned = consumePluginStorageQuotaPlan(key, size);
    if (!quotaPlanned) assertPluginWriteWithinLimits(key, size, previousSize);
    const writeResult = chunkStore.putValueFromFile(key, filePath, {
        chunkPlan,
        updatedAt: kvMutationUpdatedAt(key),
    });
    notePluginStorageMutation(key);
    if (!quotaPlanned) updatePluginStorageUsageForWrite(key, size, previousSize);
    if (key.startsWith(PLUGIN_STORAGE_META_PREFIX)) {
        setPluginStorageOwnerIndex(
            key,
            ownerProvided ? providedOwner : pluginStorageOwnerFromFile(filePath),
        );
    }
    let facetsMaintained = true;
    if (isPluginValueKey(key)) {
        if (displaySizeProvided) {
            pluginStorageViewerFacets.maintainValue(key, providedDisplaySize);
        } else {
            pluginStorageViewerFacets.removeValue(key);
            facetsMaintained = false;
        }
    }
    stmtRemoveDeletion.run(key);
    pluginStorageViewerFacets.finishMaintainedMutation(facetsWereCurrent, facetsMaintained);
    return writeResult;
});

const runKvDel = db.transaction((key) => {
    const facetsWereCurrent = pluginStorageViewerFacets.state().current;
    const previousSize = isPluginValueKey(key) ? (chunkStore.sizeValue(key) ?? 0) : 0;
    const quotaPlanned = consumePluginStorageQuotaPlan(key, 0);
    const deletedAt = kvMutationUpdatedAt(key);
    chunkStore.dropValue(key);
    notePluginStorageMutation(key);
    if (key.startsWith(PLUGIN_STORAGE_META_PREFIX)) stmtDeletePluginStorageOwner.run(key);
    if (isPluginValueKey(key)) pluginStorageViewerFacets.removeValue(key);
    if (!quotaPlanned && previousSize > 0) {
        stmtSetPluginStorageUsage.run(Math.max(0, getPluginStorageUsage() - previousSize));
    }
    stmtRecordDeletion.run(key, deletedAt);
    pluginStorageViewerFacets.finishMaintainedMutation(facetsWereCurrent);
});

const runKvDelPrefix = db.transaction((prefix, pattern) => {
    const facetsWereCurrent = pluginStorageViewerFacets.state().current;
    const prefixCanMatchPluginValues = prefix.startsWith('pluginsave/')
        || 'pluginsave/'.startsWith(prefix);
    const removedPluginBytes = prefixCanMatchPluginValues
        ? chunkStore.listValuesWithSizes(prefix.startsWith('pluginsave/') ? prefix : 'pluginsave/')
            .filter((entry) => entry.key.startsWith(prefix))
            .reduce((sum, entry) => sum + entry.size, 0)
        : 0;
    stmtRecordDeletionBulk.run({ deletedAt: Date.now(), pattern });
    stmtManifestPublicationDelPrefix.run(pattern);
    stmtManifestDelPrefix.run(pattern);
    stmtManifestMetaDelPrefix.run(pattern);
    stmtKvDelPrefix.run(pattern);
    stmtManifestInventoryDelPrefix.run(pattern);
    stmtDeletePluginStorageOwnerPrefix.run(pattern);
    pluginStorageViewerFacets.removeValuePrefix(prefix);
    if (prefixCanMatchPluginValues) pluginStorageMutationVersion += 1;
    if (removedPluginBytes > 0) {
        stmtSetPluginStorageUsage.run(Math.max(0, getPluginStorageUsage() - removedPluginBytes));
    }
    pluginStorageViewerFacets.finishMaintainedMutation(
        facetsWereCurrent || prefix.length === 0,
    );
});

function kvGet(key) {
    // Reassembles chunked values; returns raw value for everything else.
    return chunkStore.getValue(key);
}

function kvGetAsync(key) {
    // The SQLite implementation remains synchronous. This Promise boundary is
    // solely where concurrent async callers can share one identical read.
    return chunkStore.getValueAsync(key);
}

function kvWriteToFile(key, filePath, options) {
    return chunkStore.writeValueToFile(key, filePath, options);
}

function kvIterate(key, options) {
    return chunkStore.iterateValue(key, options);
}

function checkKvSetFailpoint(key) {
    if (kvSetFailpoint) {
        if (kvSetFailpoint.type === 'key' && key === kvSetFailpoint.key) {
            throw new Error(`Injected kvSet failure for key ${key}`);
        }
        if (kvSetFailpoint.type === 'prefix' && key.startsWith(kvSetFailpoint.prefix)) {
            kvSetFailpoint.seen++;
            if (kvSetFailpoint.seen === kvSetFailpoint.nth) {
                throw new Error(`Injected kvSet failure for ${key} at prefix write ${kvSetFailpoint.nth}`);
            }
        }
    }
}

function kvSet(key, value, options = {}) {
    checkKvSetFailpoint(key);
    const displaySizeProvided = Object.prototype.hasOwnProperty.call(
        options,
        'pluginStorageDisplaySize',
    );
    runKvSet(
        key,
        value,
        displaySizeProvided,
        displaySizeProvided ? options.pluginStorageDisplaySize : null,
    );
}

function kvSetFromFile(key, filePath, options = {}) {
    checkKvSetFailpoint(key);
    const size = fs.statSync(filePath).size;
    const ownerProvided = Object.prototype.hasOwnProperty.call(
        options,
        'pluginStorageOwner',
    );
    const displaySizeProvided = Object.prototype.hasOwnProperty.call(
        options,
        'pluginStorageDisplaySize',
    );
    return runKvSetFromFile(
        key,
        filePath,
        size,
        ownerProvided,
        ownerProvided ? options.pluginStorageOwner : null,
        displaySizeProvided,
        displaySizeProvided ? options.pluginStorageDisplaySize : null,
        options.chunkPlan ?? null,
    );
}

function kvDel(key) {
    // Route through the chunk store so a chunked key (the DB blob or a chunked
    // snapshot, e.g. a rotated dbbackup-*) also drops its manifest — otherwise
    // its chunks stay referenced and GC can never reclaim them. For non-chunked
    // keys the manifest delete is a no-op, so this is safe and atomic for all.
    // Record even when the row does not exist: filesystem-backed logical keys
    // have no kv row, but callers still use this public wrapper to delete them.
    runKvDel(key);
}

function kvSize(key) {
    // Logical (reassembled) size for chunked values; raw length otherwise.
    return chunkStore.sizeValue(key);
}

function kvGetUpdatedAt(key) {
    const row = stmtKvUpdatedAt.get(key);
    return row ? row.updated_at : null;
}

function kvGetDatabaseRevision() {
    return databaseRevisionTracker.getRevision();
}

function kvGetPluginStoragePublicationRevision() {
    return pluginStoragePublicationRevisionTracker.getRevision();
}

/**
 * Capture the operational identities that bound an automatic database
 * snapshot. The payload is intentionally metadata-only: large logical values
 * are represented by trigger-backed clocks or row mutation tokens, never by
 * reading their bodies into one Buffer.
 */
function captureSnapshotSourceToken(connection, logicalDatabaseSize) {
    const databaseRevision = connection.prepare(`
        SELECT revision FROM database_row_revision WHERE id = 1
    `).get()?.revision ?? null;
    const databaseInventoryRevision = connection.prepare(`
        SELECT source_revision AS sourceRevision
          FROM chunk_manifest_inventory_revision
         WHERE manifest_key = 'database/database.bin'
    `).get()?.sourceRevision ?? null;
    const pluginPublicationRevision = connection.prepare(`
        SELECT revision FROM plugin_storage_publication_revision WHERE id = 1
    `).get()?.revision ?? null;
    const pluginFacetRevision = connection.prepare(`
        SELECT source_revision AS sourceRevision,
               indexed_revision AS indexedRevision
          FROM plugin_storage_viewer_facet_revision
         WHERE id = 1
    `).get() ?? {};
    const pluginUsageBytes = connection.prepare(`
        SELECT bytes FROM plugin_storage_usage WHERE id = 1
    `).get()?.bytes ?? null;
    const recoveryDirty = connection.prepare(`
        SELECT value
          FROM kv
         WHERE key = 'config/plugin-storage-recovery-dirty'
    `).get()?.value ?? null;

    let chatRows;
    try {
        chatRows = connection.prepare(`
            SELECT rows.key AS key,
                   metadata.row_token AS rowToken,
                   inventory.source_revision AS inventoryRevision
              FROM kv AS rows
              LEFT JOIN chat_row_metadata AS metadata
                ON metadata.row_key = rows.key
              LEFT JOIN chunk_manifest_inventory_revision AS inventory
                ON inventory.manifest_key = rows.key
             WHERE rows.key LIKE 'chats/%'
             ORDER BY rows.key
        `).all();
    } catch (error) {
        // db.cjs can be exercised directly before createChatRowStore() installs
        // its rebuildable derivative. Production snapshot capture happens only
        // after that store exists. Preserve a useful read-only fallback for
        // lower-level callers without inventing a second chat revision clock.
        if (!String(error?.message ?? '').includes('no such table: chat_row_metadata')) {
            throw error;
        }
        chatRows = connection.prepare(`
            SELECT rows.key AS key,
                   NULL AS rowToken,
                   inventory.source_revision AS inventoryRevision
              FROM kv AS rows
              LEFT JOIN chunk_manifest_inventory_revision AS inventory
                ON inventory.manifest_key = rows.key
             WHERE rows.key LIKE 'chats/%'
             ORDER BY rows.key
        `).all();
    }

    return {
        databaseRevision,
        databaseInventoryRevision,
        databaseSize: logicalDatabaseSize,
        chatRows,
        pluginPublicationRevision,
        pluginFacetSourceRevision: pluginFacetRevision.sourceRevision ?? null,
        pluginFacetIndexedRevision: pluginFacetRevision.indexedRevision ?? null,
        pluginUsageBytes,
        recoveryDirtyToken: Buffer.isBuffer(recoveryDirty)
            ? recoveryDirty.toString('base64url')
            : null,
    };
}

function kvGetSnapshotSourceToken() {
    return captureSnapshotSourceToken(db, kvSize('database/database.bin'));
}

const runKvCopyValue = db.transaction((srcKey, dstKey) => {
    const sourceSize = chunkStore.sizeValue(srcKey);
    if (sourceSize === null) return;
    const previousSize = isPluginValueKey(dstKey) ? (chunkStore.sizeValue(dstKey) ?? 0) : 0;
    assertPluginWriteWithinLimits(dstKey, sourceSize, previousSize);
    // Chunked src copies only its manifest (chunks stay shared); raw src copies
    // the value. Used for snapshots — keeps them near-free and byte-identical.
    chunkStore.snapshotValue(srcKey, dstKey, { updatedAt: kvMutationUpdatedAt(dstKey) });
    notePluginStorageMutation(dstKey);
    updatePluginStorageUsageForWrite(dstKey, sourceSize, previousSize);
    if (stmtKvUpdatedAt.get(dstKey)) stmtRemoveDeletion.run(dstKey);
});

function kvCopyValue(srcKey, dstKey) {
    runKvCopyValue(srcKey, dstKey);
}

function kvDelPrefix(prefix) {
    const escaped = prefix.replace(/[\\%_]/g, '\\$&');
    const pattern = `${escaped}%`;
    // Capture the logical keys before deleting the source rows. Keeping both
    // operations in one transaction prevents a delta reader seeing half-state.
    runKvDelPrefix(prefix, pattern);
}

function kvList(prefix) {
    if (prefix) {
        const escaped = prefix.replace(/[\\%_]/g, '\\$&');
        return stmtKvPrefix.all(`${escaped}%`).map(r => r.key);
    }
    return stmtKvList.all().map(r => r.key);
}

function kvListWithSizes(prefix) {
    return chunkStore.listValuesWithSizes(prefix);
}

function kvListSelectedWithSizes(keys) {
    return chunkStore.listValuesWithSizesForKeys(keys);
}

function kvClearDeletion(key) {
    stmtRemoveDeletion.run(key);
}

function kvRecordDeletion(key) {
    stmtRecordDeletion.run(key, Date.now());
}

function kvListModifiedSince(since, prefix) {
    if (prefix) {
        const escaped = prefix.replace(/[\\%_]/g, '\\$&');
        return stmtModifiedSincePrefix.all(since, `${escaped}%`).map((row) => row.key);
    }
    return stmtModifiedSince.all(since).map((row) => row.key);
}

function kvGetDeletedSince(since, prefix) {
    if (prefix) {
        const escaped = prefix.replace(/[\\%_]/g, '\\$&');
        return stmtDeletedSincePrefix.all(since, `${escaped}%`).map((row) => row.key);
    }
    return stmtDeletedSince.all(since).map((row) => row.key);
}

function kvCleanupOldDeletions() {
    return stmtCleanupDeletions.run(Date.now() - DELETION_RETENTION_MS).changes;
}

function kvGetListEpoch() {
    return stmtGetListEpoch.get().list_epoch;
}

function kvBumpListEpoch() {
    const epoch = crypto.randomUUID();
    stmtSetListEpoch.run(epoch);
    return epoch;
}

function createKvSnapshot() {
    const snapshotDb = new Database(dbPath, { readonly: true });
    let transactionOpen = false;
    let closed = false;
    try {
        snapshotDb.pragma('busy_timeout = 5000');
        snapshotDb.exec('BEGIN');
        transactionOpen = true;
        snapshotDb.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
        const reader = createSnapshotReader(snapshotDb, {
            // Snapshot connections remain read-only. They may consume a proof
            // established by this process for the exact pinned source revision,
            // but createSnapshotReader never writes verification state.
            contentVerificationMemo: chunkStore.contentVerificationMemo,
        });
        const viewerFacets = createPluginStorageViewerFacetSnapshot(snapshotDb);
        let selectChatRowMetadata = null;
        let selectChatRowOperations = null;
        try {
            selectChatRowMetadata = snapshotDb.prepare(`
              SELECT row_token, content_sha256, content_size, cold_storage,
                     message_count, log_supported, log_count, log_bytes
                FROM chat_row_metadata
               WHERE row_key = ?
            `);
            selectChatRowOperations = snapshotDb.prepare(`
              SELECT sequence, format, content_type, base_sha256, result_sha256,
                     result_size, patch_json, patch_bytes, created_at
                FROM chat_row_operations
               WHERE row_key = ?
               ORDER BY sequence
            `);
        } catch (error) {
            // Lower-level db tests may pin a snapshot before the chat store has
            // installed its rebuildable derivative tables. Production creates
            // the store before any snapshot endpoint becomes reachable.
            if (!String(error?.message ?? '').includes('no such table')) throw error;
        }
        return {
            ...reader,
            ...viewerFacets,
            kvGetSnapshotSourceToken() {
                return captureSnapshotSourceToken(
                    snapshotDb,
                    reader.kvSize('database/database.bin'),
                );
            },
            kvListPluginStorageOwnerFacets(storageKeys) {
                return viewerFacets.viewerOwnerFacets(storageKeys);
            },
            kvListPluginStorageOwnerKeys(storageKeys, owner = null) {
                return viewerFacets.viewerOwnerKeys(storageKeys, owner);
            },
            kvGetPluginStorageOwner(storageKey) {
                return viewerFacets.viewerOwner(storageKey);
            },
            chatRowMetadata(rowKey) {
                return selectChatRowMetadata?.get(rowKey) ?? null;
            },
            chatRowOperationEntries(rowKey) {
                return selectChatRowOperations?.all(rowKey) ?? [];
            },
            close() {
                if (closed) return;
                closed = true;
                try {
                    if (transactionOpen) snapshotDb.exec('ROLLBACK');
                } catch {}
                transactionOpen = false;
                try { snapshotDb.close(); } catch {}
            },
        };
    } catch (error) {
        try {
            if (transactionOpen) snapshotDb.exec('ROLLBACK');
        } catch {}
        try { snapshotDb.close(); } catch {}
        throw error;
    }
}

function reconcilePluginStorageUsage() {
    const bytes = chunkStore.listValuesWithSizes('pluginsave/')
        .reduce((sum, entry) => sum + entry.size, 0);
    if (!Number.isSafeInteger(bytes)) {
        throw new Error('Optimized plugin storage usage exceeds the safe integer range.');
    }
    stmtSetPluginStorageUsage.run(bytes);
    return bytes;
}

function reconcilePluginStorageOwners() {
    // A better-sqlite3 connection cannot write while one of its own iterators
    // is active. Use short-lived read connections so boot can rebuild the
    // derived index without retaining every owner body in an `.all()` array.
    const ownerKeys = new Database(dbPath, { readonly: true });
    const ownerValues = new Database(dbPath, { readonly: true });
    ownerValues.exec('BEGIN');
    const rows = ownerKeys.prepare(
        `SELECT key FROM kv WHERE key LIKE 'pluginsave-meta/%'`,
    );
    const reader = createSnapshotReader(ownerValues, {
        contentVerificationMemo: chunkStore.contentVerificationMemo,
    });
    const facetsWereCurrent = pluginStorageViewerFacets.state().current;
    const reconcile = db.transaction(() => {
        db.prepare('DELETE FROM plugin_storage_owners').run();
        for (const row of rows.iterate()) {
            setPluginStorageOwnerIndex(
                row.key,
                pluginStorageOwnerFromReader(reader, row.key),
            );
        }
        pluginStorageViewerFacets.finishMaintainedMutation(facetsWereCurrent);
    });
    try {
        reconcile();
    } finally {
        try { ownerValues.exec('ROLLBACK'); } catch {}
        ownerValues.close();
        ownerKeys.close();
    }
}

function rebuildPluginStorageViewerFacets(expectedSourceRevision, valueFacets, owners) {
    return pluginStorageViewerFacets.replaceAll(
        expectedSourceRevision,
        valueFacets,
        owners,
    );
}

// The counter is an optimization, not an authority. Rebuild it on every boot
// so older servers, interrupted upgrades, and direct maintenance cannot leave
// quota accounting stale.
reconcilePluginStorageUsage();
migrateFromSaveDir();
reconcilePluginStorageUsage();
reconcilePluginStorageOwners();

function checkpointWal(mode = 'TRUNCATE') {
    return db.pragma(`wal_checkpoint(${mode})`);
}

// Reclaim chunks no longer referenced by any manifest (live blob + snapshots).
// Returns the number deleted. Caller should run it serialized with saves (e.g.
// inside the storage queue) and before VACUUM so freed pages get compacted.
function gcChunks() {
    return chunkStore.gc();
}

// Bytes the next gc() would reclaim (true orphans + chunks held only by stale
// manifests). Drives the Optimize button so self-healable leaks can be cleared.
function reclaimableChunkBytes() {
    return chunkStore.reclaimableBytes();
}

// Whether the live DB blob is actually stored chunked right now (marker-backed),
// not merely that a manifest row exists.
function isDbBlobChunked() {
    return chunkStore.isChunkedKey(DB_BLOB_KEY);
}

// Bytes deleting this snapshot would free: its raw row, or chunks referenced by
// its manifest and no other manifest.
function snapshotFootprint(key) {
    return chunkStore.snapshotCostExclusive(key);
}

function snapshotFootprints(prefix) {
    return chunkStore.listSnapshotCostsExclusive(prefix);
}

function clearEntities() {
    // Entity tables may still exist from previous versions — clear them during backup import
    try {
        db.exec(`DELETE FROM characters; DELETE FROM chats; DELETE FROM settings; DELETE FROM presets; DELETE FROM modules`);
    } catch {
        // Tables may not exist — ignore
    }
}

module.exports = {
    db,
    // KV
    kvGet, kvGetAsync, kvIterate, kvWriteToFile, kvSet, kvSetFromFile, kvDel, kvList, kvDelPrefix, kvListWithSizes, kvListSelectedWithSizes, kvSize, kvGetUpdatedAt, kvGetDatabaseRevision, kvGetPluginStoragePublicationRevision, kvGetSnapshotSourceToken, kvCopyValue,
    kvClearDeletion, kvRecordDeletion, kvListModifiedSince, kvGetDeletedSince, kvCleanupOldDeletions,
    kvGetListEpoch, kvBumpListEpoch,
    createKvSnapshot,
    rebuildPluginStorageViewerFacets,
    clearEntities,
    checkpointWal,
    gcChunks,
    reclaimableChunkBytes,
    isDbBlobChunked,
    snapshotFootprint,
    snapshotFootprints,
    getPluginStorageUsage,
    getPluginStorageMutationVersion,
    reconcilePluginStorageUsage,
    withPluginStorageQuotaPlan,
    isLegacyHexMigrationComplete,
    markLegacyHexMigrationComplete,
    publishLegacyHexMigrationMarker,
};
