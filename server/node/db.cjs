'use strict';

const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { createChunkStore, createSnapshotReader, isChunkableKey } = require('./chunkStore.cjs');
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

// WAL mode: better concurrent read performance, single-writer
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
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
db.exec(`
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
  )
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

function migrateFromSaveDir() {
    if (!fs.existsSync(savePath)) return;
    if (fs.existsSync(migrationMarker)) return;

    const hexRegex = /^[0-9a-fA-F]+$/;
    let files;
    try {
        files = fs.readdirSync(savePath);
    } catch {
        return;
    }

    const hexFiles = files.filter(f => hexRegex.test(f));
    if (hexFiles.length === 0) return;

    console.log(`[DB] Migrating ${hexFiles.length} file(s) from /save/ to SQLite...`);

    const insert = db.prepare(
        `INSERT OR IGNORE INTO kv (key, value, updated_at) VALUES (?, ?, ?)`
    );
    const exists = db.prepare(`SELECT 1 FROM kv WHERE key = ?`);
    const now = Date.now();

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
            const value = fs.readFileSync(path.join(savePath, hexFiles[i]));
            // Route every chunk-capable namespace through the same size gate so
            // oversized legacy values cannot hit SQLite's BLOB bind limit.
            if (isChunkableKey(key)) chunkStore.putValue(key, value);
            else insert.run(key, value, now);
            stmtRemoveDeletion.run(key);
        }
    });
    run();

    fs.writeFileSync(migrationMarker, new Date().toISOString(), 'utf-8');
    console.log(`[DB] Migration complete. ${hexFiles.length} files preserved in /save/.`);
    console.log(`[DB] To free disk space, remove migrated files via Settings > Clean Up Save Folder.`);
}

// Chunk-aware store for large database, snapshot, and chat values. Assets remain
// one raw row each. Built before migrateFromSaveDir so legacy values can chunk.
const DB_BLOB_KEY = 'database/database.bin';
const chunkThreshold = process.env.POCKETRISU_CHUNK_THRESHOLD
    ? Number(process.env.POCKETRISU_CHUNK_THRESHOLD)
    : undefined;
const chunkStore = createChunkStore(db, { threshold: chunkThreshold });

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
// Chunk-capable writes route through chunkStore; reads/deletes/sizes/copies are
// chunk-aware for every key. The statements below serve direct-row writes/lists.
const stmtKvSet    = db.prepare(`INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)`);
const stmtKvList   = db.prepare(`SELECT key FROM kv`);
const stmtKvPrefix = db.prepare(`SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\'`);
const stmtKvDelPrefix = db.prepare(`DELETE FROM kv WHERE key LIKE ? ESCAPE '\\'`);
const stmtManifestDelPrefix = db.prepare(`DELETE FROM manifest_chunks WHERE manifest_key LIKE ? ESCAPE '\\'`);
const stmtKvUpdatedAt = db.prepare(`SELECT updated_at FROM kv WHERE key = ?`);
const stmtRecordDeletion = db.prepare(`INSERT OR REPLACE INTO deleted_keys (key, deleted_at) VALUES (?, ?)`);
const stmtRemoveDeletion = db.prepare(`DELETE FROM deleted_keys WHERE key = ?`);
const stmtDeletedSince = db.prepare(`SELECT key FROM deleted_keys WHERE deleted_at >= ?`);
const stmtDeletedSincePrefix = db.prepare(`SELECT key FROM deleted_keys WHERE deleted_at >= ? AND key LIKE ? ESCAPE '\\'`);
const stmtModifiedSince = db.prepare(`SELECT key FROM kv WHERE updated_at >= ?`);
const stmtModifiedSincePrefix = db.prepare(`SELECT key FROM kv WHERE updated_at >= ? AND key LIKE ? ESCAPE '\\'`);
const stmtCleanupDeletions = db.prepare(`DELETE FROM deleted_keys WHERE deleted_at < ?`);
const stmtRecordDeletionBulk = db.prepare(
    `INSERT OR REPLACE INTO deleted_keys (key, deleted_at) SELECT key, ? FROM kv WHERE key LIKE ? ESCAPE '\\'`
);
const stmtGetListEpoch = db.prepare(`SELECT list_epoch FROM sync_meta WHERE id = 1`);
const stmtSetListEpoch = db.prepare(`UPDATE sync_meta SET list_epoch = ? WHERE id = 1`);
const stmtGetPluginStorageUsage = db.prepare(`SELECT bytes FROM plugin_storage_usage WHERE id = 1`);
const stmtSetPluginStorageUsage = db.prepare(`UPDATE plugin_storage_usage SET bytes = ? WHERE id = 1`);

const DELETION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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
    for (const change of changes) {
        if (!isPluginValueKey(change.key)) continue;
        if (planned.has(change.key)) throw new Error(`Duplicate plugin quota plan key: ${change.key}`);
        const previousSize = chunkStore.sizeValue(change.key) ?? 0;
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

const runKvSet = db.transaction((key, value) => {
    const previousSize = isPluginValueKey(key) ? (chunkStore.sizeValue(key) ?? 0) : 0;
    const quotaPlanned = consumePluginStorageQuotaPlan(key, value.length);
    if (!quotaPlanned) assertPluginWriteWithinLimits(key, value.length, previousSize);
    if (isChunkableKey(key)) chunkStore.putValue(key, value);
    else stmtKvSet.run(key, value, Date.now());
    if (!quotaPlanned) updatePluginStorageUsageForWrite(key, value.length, previousSize);
    stmtRemoveDeletion.run(key);
});

const runKvSetFromFile = db.transaction((key, filePath, size) => {
    const previousSize = isPluginValueKey(key) ? (chunkStore.sizeValue(key) ?? 0) : 0;
    const quotaPlanned = consumePluginStorageQuotaPlan(key, size);
    if (!quotaPlanned) assertPluginWriteWithinLimits(key, size, previousSize);
    if (isChunkableKey(key)) chunkStore.putValueFromFile(key, filePath);
    else stmtKvSet.run(key, fs.readFileSync(filePath), Date.now());
    if (!quotaPlanned) updatePluginStorageUsageForWrite(key, size, previousSize);
    stmtRemoveDeletion.run(key);
});

const runKvDel = db.transaction((key) => {
    const previousSize = isPluginValueKey(key) ? (chunkStore.sizeValue(key) ?? 0) : 0;
    const quotaPlanned = consumePluginStorageQuotaPlan(key, 0);
    chunkStore.dropValue(key);
    if (!quotaPlanned && previousSize > 0) {
        stmtSetPluginStorageUsage.run(Math.max(0, getPluginStorageUsage() - previousSize));
    }
    stmtRecordDeletion.run(key, Date.now());
});

const runKvDelPrefix = db.transaction((prefix, pattern) => {
    const prefixCanMatchPluginValues = prefix.startsWith('pluginsave/')
        || 'pluginsave/'.startsWith(prefix);
    const removedPluginBytes = prefixCanMatchPluginValues
        ? chunkStore.listValuesWithSizes(prefix.startsWith('pluginsave/') ? prefix : 'pluginsave/')
            .filter((entry) => entry.key.startsWith(prefix))
            .reduce((sum, entry) => sum + entry.size, 0)
        : 0;
    stmtRecordDeletionBulk.run(Date.now(), pattern);
    stmtManifestDelPrefix.run(pattern);
    stmtKvDelPrefix.run(pattern);
    if (removedPluginBytes > 0) {
        stmtSetPluginStorageUsage.run(Math.max(0, getPluginStorageUsage() - removedPluginBytes));
    }
});

function kvGet(key) {
    // Reassembles chunked values; returns raw value for everything else.
    return chunkStore.getValue(key);
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

function kvSet(key, value) {
    checkKvSetFailpoint(key);
    runKvSet(key, value);
}

function kvSetFromFile(key, filePath) {
    checkKvSetFailpoint(key);
    const size = fs.statSync(filePath).size;
    runKvSetFromFile(key, filePath, size);
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

const runKvCopyValue = db.transaction((srcKey, dstKey) => {
    const sourceSize = chunkStore.sizeValue(srcKey);
    if (sourceSize === null) return;
    const previousSize = isPluginValueKey(dstKey) ? (chunkStore.sizeValue(dstKey) ?? 0) : 0;
    assertPluginWriteWithinLimits(dstKey, sourceSize, previousSize);
    // Chunked src copies only its manifest (chunks stay shared); raw src copies
    // the value. Used for snapshots — keeps them near-free and byte-identical.
    chunkStore.snapshotValue(srcKey, dstKey);
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
        const reader = createSnapshotReader(snapshotDb);
        return {
            ...reader,
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

// The counter is an optimization, not an authority. Rebuild it on every boot
// so older servers, interrupted upgrades, and direct maintenance cannot leave
// quota accounting stale.
reconcilePluginStorageUsage();
migrateFromSaveDir();
reconcilePluginStorageUsage();

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
    kvGet, kvSet, kvSetFromFile, kvDel, kvList, kvDelPrefix, kvListWithSizes, kvSize, kvGetUpdatedAt, kvCopyValue,
    kvClearDeletion, kvRecordDeletion, kvListModifiedSince, kvGetDeletedSince, kvCleanupOldDeletions,
    kvGetListEpoch, kvBumpListEpoch,
    createKvSnapshot,
    clearEntities,
    checkpointWal,
    gcChunks,
    reclaimableChunkBytes,
    isDbBlobChunked,
    snapshotFootprint,
    getPluginStorageUsage,
    reconcilePluginStorageUsage,
    withPluginStorageQuotaPlan,
};
