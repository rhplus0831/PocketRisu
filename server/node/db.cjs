'use strict';

const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { createChunkStore, createSnapshotReader, isChunkableKey } = require('./chunkStore.cjs');

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
  )
`);
db.prepare(`INSERT OR IGNORE INTO sync_meta (id, list_epoch) VALUES (1, ?)`).run(crypto.randomUUID());

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
    const now = Date.now();

    const run = db.transaction(() => {
        for (let i = 0; i < hexFiles.length; i++) {
            if (i % 100 === 0 || i === hexFiles.length - 1) {
                console.log(`[DB] Migrating... ${i + 1}/${hexFiles.length}`);
            }
            const key = Buffer.from(hexFiles[i], 'hex').toString('utf-8');
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

// ─── KV operations ────────────────────────────────────────────────────────────
// Chunk-capable writes route through chunkStore; reads/deletes/sizes/copies are
// chunk-aware for every key. The statements below serve direct-row writes/lists.
const stmtKvSet    = db.prepare(`INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)`);
const stmtKvList   = db.prepare(`SELECT key FROM kv`);
const stmtKvPrefix = db.prepare(`SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\'`);
const stmtKvPrefixSizes = db.prepare(`SELECT key, LENGTH(value) as size FROM kv WHERE key LIKE ? ESCAPE '\\'`);
const stmtKvDelPrefix = db.prepare(`DELETE FROM kv WHERE key LIKE ? ESCAPE '\\'`);
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

const DELETION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const runKvDel = db.transaction((key) => {
    chunkStore.dropValue(key);
    stmtRecordDeletion.run(key, Date.now());
});

const runKvDelPrefix = db.transaction((pattern) => {
    stmtRecordDeletionBulk.run(Date.now(), pattern);
    stmtKvDelPrefix.run(pattern);
});

function kvGet(key) {
    // Reassembles chunked values; returns raw value for everything else.
    return chunkStore.getValue(key);
}

function kvSet(key, value) {
    if (isChunkableKey(key)) {
        chunkStore.putValue(key, value);
    } else {
        stmtKvSet.run(key, value, Date.now());
    }
    // Deliberately a separate tiny indexed statement. If a reader or crash lands
    // between these statements, the key appears in both added and deleted; the
    // client merge gives added precedence, so it remains live.
    stmtRemoveDeletion.run(key);
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

function kvCopyValue(srcKey, dstKey) {
    // Chunked src copies only its manifest (chunks stay shared); raw src copies
    // the value. Used for snapshots — keeps them near-free and byte-identical.
    chunkStore.snapshotValue(srcKey, dstKey);
    if (stmtKvUpdatedAt.get(dstKey)) stmtRemoveDeletion.run(dstKey);
}

function kvDelPrefix(prefix) {
    const escaped = prefix.replace(/[\\%_]/g, '\\$&');
    const pattern = `${escaped}%`;
    // Capture the logical keys before deleting the source rows. Keeping both
    // operations in one transaction prevents a delta reader seeing half-state.
    runKvDelPrefix(pattern);
}

function kvList(prefix) {
    if (prefix) {
        const escaped = prefix.replace(/[\\%_]/g, '\\$&');
        return stmtKvPrefix.all(`${escaped}%`).map(r => r.key);
    }
    return stmtKvList.all().map(r => r.key);
}

function kvListWithSizes(prefix) {
    const escaped = prefix.replace(/[\\%_]/g, '\\$&');
    return stmtKvPrefixSizes.all(`${escaped}%`).map(r => ({ key: r.key, size: r.size }));
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

migrateFromSaveDir();

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
    kvGet, kvSet, kvDel, kvList, kvDelPrefix, kvListWithSizes, kvSize, kvGetUpdatedAt, kvCopyValue,
    kvClearDeletion, kvRecordDeletion, kvListModifiedSince, kvGetDeletedSince, kvCleanupOldDeletions,
    kvGetListEpoch, kvBumpListEpoch,
    createKvSnapshot,
    clearEntities,
    checkpointWal,
    gcChunks,
    reclaimableChunkBytes,
    isDbBlobChunked,
    snapshotFootprint,
};
