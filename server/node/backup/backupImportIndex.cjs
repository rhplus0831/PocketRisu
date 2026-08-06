'use strict';

const fs = require('fs');
const Database = require('better-sqlite3');

const DEFAULT_BATCH_SIZE = 4096;

/**
 * Disk-backed metadata for one backup restore.
 *
 * Large archives must not retain every entry name or inlay ordering record in
 * the Node heap.  This private SQLite file is created inside the restore's
 * already-private spool directory and is deleted with that directory.
 */
function createBackupImportIndex(filePath, { batchSize = DEFAULT_BATCH_SIZE } = {}) {
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
        throw new TypeError('Backup import index batch size must be a positive safe integer');
    }

    const db = new Database(filePath);
    db.pragma('journal_mode = DELETE');
    db.pragma('synchronous = OFF');
    db.pragma('temp_store = FILE');
    db.exec(`
        CREATE TABLE entries (
            name TEXT PRIMARY KEY
        ) WITHOUT ROWID;
        CREATE TABLE inlays (
            id TEXT PRIMARY KEY,
            imported INTEGER NOT NULL DEFAULT 0 CHECK (imported IN (0, 1)),
            sidecar INTEGER NOT NULL DEFAULT 0 CHECK (sidecar IN (0, 1)),
            explicit_json TEXT,
            legacy_json TEXT
        ) WITHOUT ROWID;
    `);

    const insertEntry = db.prepare('INSERT OR IGNORE INTO entries (name) VALUES (?)');
    const ensureInlay = db.prepare('INSERT OR IGNORE INTO inlays (id) VALUES (?)');
    const markImported = db.prepare('UPDATE inlays SET imported = 1 WHERE id = ?');
    const markSidecar = db.prepare(
        'UPDATE inlays SET sidecar = 1, explicit_json = ? WHERE id = ?',
    );
    const setLegacy = db.prepare('UPDATE inlays SET legacy_json = ? WHERE id = ?');
    const getInlay = db.prepare(`
        SELECT imported, sidecar, explicit_json AS explicitJson, legacy_json AS legacyJson
        FROM inlays WHERE id = ?
    `);
    const pendingLegacy = db.prepare(`
        SELECT id, legacy_json AS legacyJson
        FROM inlays
        WHERE imported = 1 AND sidecar = 0 AND legacy_json IS NOT NULL
        ORDER BY id
    `);

    let transactionOpen = false;
    let operations = 0;
    let count = 0;
    let closed = false;

    const begin = () => {
        if (!transactionOpen) {
            db.exec('BEGIN');
            transactionOpen = true;
        }
    };
    const flush = () => {
        if (!transactionOpen) return;
        db.exec('COMMIT');
        transactionOpen = false;
        operations = 0;
    };
    const mutate = (operation) => {
        if (closed) throw new Error('Backup import index is closed');
        begin();
        const result = operation();
        operations++;
        if (operations >= batchSize) flush();
        return result;
    };
    const withInlay = (id, operation) => mutate(() => {
        ensureInlay.run(id);
        return operation();
    });

    return {
        addEntry(name) {
            const inserted = mutate(() => insertEntry.run(name).changes === 1);
            if (inserted) count++;
            return inserted;
        },
        get count() {
            return count;
        },
        markInlayImported(id) {
            withInlay(id, () => markImported.run(id));
        },
        markInlaySidecar(id, info) {
            withInlay(id, () => markSidecar.run(JSON.stringify(info), id));
        },
        setLegacyInlayInfo(id, info) {
            withInlay(id, () => setLegacy.run(JSON.stringify(info), id));
        },
        getInlay(id) {
            if (closed) throw new Error('Backup import index is closed');
            const row = getInlay.get(id);
            if (!row) return null;
            return {
                imported: row.imported === 1,
                sidecar: row.sidecar === 1,
                explicit: row.explicitJson === null ? null : JSON.parse(row.explicitJson),
                legacy: row.legacyJson === null ? null : JSON.parse(row.legacyJson),
            };
        },
        *legacyInlaysMissingSidecars() {
            if (closed) throw new Error('Backup import index is closed');
            for (const row of pendingLegacy.iterate()) {
                yield { id: row.id, info: JSON.parse(row.legacyJson) };
            }
        },
        flush,
        close() {
            if (closed) return;
            flush();
            db.close();
            closed = true;
        },
        destroy() {
            if (!closed) {
                try { flush(); } catch {}
                try { db.close(); } catch {}
                closed = true;
            }
            try { fs.unlinkSync(filePath); } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
            }
            for (const suffix of ['-journal', '-wal', '-shm']) {
                try { fs.unlinkSync(`${filePath}${suffix}`); } catch (error) {
                    if (error?.code !== 'ENOENT') throw error;
                }
            }
        },
    };
}

module.exports = {
    DEFAULT_BATCH_SIZE,
    createBackupImportIndex,
};
