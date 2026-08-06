'use strict';

const DATABASE_KEY = 'database/database.bin';
const PLUGIN_STORAGE_MANIFEST_KEY = 'plugin-storage/manifest.json';

/**
 * Install a transaction-bound, monotonic revision clock for the authoritative
 * database row. `kv.updated_at` is a wall-clock millisecond and can collide;
 * these triggers also observe direct SQL writers that bypass the JS wrappers.
 *
 * The clock is deliberately operational metadata rather than backup payload.
 * Deletes advance it as well, preventing a delete/recreate ABA from validating
 * a decoded graph that belonged to an earlier incarnation of the row.
 */
function createDatabaseRevisionTracker(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS database_row_revision (
            id       INTEGER PRIMARY KEY CHECK (id = 1),
            revision INTEGER NOT NULL CHECK (revision >= 0)
        );
        INSERT OR IGNORE INTO database_row_revision (id, revision) VALUES (1, 0);

        CREATE TRIGGER IF NOT EXISTS pocketrisu_database_revision_insert
        AFTER INSERT ON kv
        WHEN NEW.key = '${DATABASE_KEY}'
        BEGIN
            UPDATE database_row_revision SET revision = revision + 1 WHERE id = 1;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_database_revision_update
        AFTER UPDATE OF key, value ON kv
        WHEN OLD.key = '${DATABASE_KEY}' OR NEW.key = '${DATABASE_KEY}'
        BEGIN
            UPDATE database_row_revision SET revision = revision + 1 WHERE id = 1;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_database_revision_delete
        AFTER DELETE ON kv
        WHEN OLD.key = '${DATABASE_KEY}'
        BEGIN
            UPDATE database_row_revision SET revision = revision + 1 WHERE id = 1;
        END;
    `);

    const selectRevision = db.prepare(`
        SELECT revision
        FROM database_row_revision
        WHERE id = 1
          AND EXISTS (SELECT 1 FROM kv WHERE key = ?)
    `);

    function getRevision() {
        const row = selectRevision.get(DATABASE_KEY);
        return row ? row.revision : null;
    }

    return { getRevision };
}

/**
 * Track the two rows that select the live optimized-plugin publication. The
 * manifest can advance without replacing database.bin, while full writes and
 * transitions can replace database.bin (and its selected generation) without
 * an ordinary plugin mutation. One clock over both rows makes a parsed
 * manifest cache reusable only for the exact live publication boundary.
 */
function createPluginStoragePublicationRevisionTracker(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS plugin_storage_publication_revision (
            id       INTEGER PRIMARY KEY CHECK (id = 1),
            revision INTEGER NOT NULL CHECK (revision >= 0)
        );
        INSERT OR IGNORE INTO plugin_storage_publication_revision (id, revision)
        VALUES (1, 0);

        CREATE TRIGGER IF NOT EXISTS pocketrisu_plugin_publication_revision_insert
        AFTER INSERT ON kv
        WHEN NEW.key IN ('${DATABASE_KEY}', '${PLUGIN_STORAGE_MANIFEST_KEY}')
        BEGIN
            UPDATE plugin_storage_publication_revision
            SET revision = revision + 1 WHERE id = 1;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_plugin_publication_revision_update
        AFTER UPDATE OF key, value ON kv
        WHEN OLD.key IN ('${DATABASE_KEY}', '${PLUGIN_STORAGE_MANIFEST_KEY}')
          OR NEW.key IN ('${DATABASE_KEY}', '${PLUGIN_STORAGE_MANIFEST_KEY}')
        BEGIN
            UPDATE plugin_storage_publication_revision
            SET revision = revision + 1 WHERE id = 1;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_plugin_publication_revision_delete
        AFTER DELETE ON kv
        WHEN OLD.key IN ('${DATABASE_KEY}', '${PLUGIN_STORAGE_MANIFEST_KEY}')
        BEGIN
            UPDATE plugin_storage_publication_revision
            SET revision = revision + 1 WHERE id = 1;
        END;
    `);

    const selectRevision = db.prepare(`
        SELECT revision
        FROM plugin_storage_publication_revision
        WHERE id = 1
          AND EXISTS (SELECT 1 FROM kv WHERE key = ?)
    `);

    function getRevision() {
        const row = selectRevision.get(DATABASE_KEY);
        return row ? row.revision : null;
    }

    return { getRevision };
}

module.exports = {
    DATABASE_KEY,
    PLUGIN_STORAGE_MANIFEST_KEY,
    createDatabaseRevisionTracker,
    createPluginStoragePublicationRevisionTracker,
};
