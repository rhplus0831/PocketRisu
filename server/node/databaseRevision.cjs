'use strict';

const DATABASE_KEY = 'database/database.bin';

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

module.exports = {
    DATABASE_KEY,
    createDatabaseRevisionTracker,
};
