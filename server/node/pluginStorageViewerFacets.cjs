'use strict';

const PLUGIN_VALUE_PREFIX = 'pluginsave/';
const PLUGIN_META_PREFIX = 'pluginsave-meta/';

function pluginStorageViewerValueText(value) {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    return JSON.stringify(value);
}

function pluginStorageViewerDisplaySize(value) {
    return Buffer.byteLength(pluginStorageViewerValueText(value), 'utf-8');
}

function pluginStorageViewerDisplaySizeFromMetadata(metadata) {
    const size = metadata?.type === 'string'
        ? metadata.length
        : metadata?.type === 'null'
            ? 0
            : metadata?.jsonSize;
    if (!Number.isSafeInteger(size) || size < 0) {
        throw new RangeError('Plugin storage viewer display size is invalid');
    }
    return size;
}

function createPluginStorageViewerFacetStore(db, { failpoint = '' } = {}) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS plugin_storage_viewer_value_facets (
            storage_key  TEXT PRIMARY KEY,
            display_size INTEGER NOT NULL CHECK (display_size >= 0)
        );

        CREATE TABLE IF NOT EXISTS plugin_storage_viewer_facet_revision (
            id               INTEGER PRIMARY KEY CHECK (id = 1),
            source_revision  INTEGER NOT NULL CHECK (source_revision >= 0),
            indexed_revision INTEGER
        );

        INSERT OR IGNORE INTO plugin_storage_viewer_facet_revision
            (id, source_revision, indexed_revision)
        VALUES (1, 0, NULL);

        CREATE TRIGGER IF NOT EXISTS pocketrisu_plugin_viewer_kv_insert
        AFTER INSERT ON kv
        WHEN NEW.key = 'plugin-storage/manifest.json'
          OR NEW.key LIKE '${PLUGIN_VALUE_PREFIX}%'
          OR NEW.key LIKE '${PLUGIN_META_PREFIX}%'
        BEGIN
            UPDATE plugin_storage_viewer_facet_revision
               SET source_revision = source_revision + 1 WHERE id = 1;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_plugin_viewer_kv_update
        AFTER UPDATE OF key, value ON kv
        WHEN OLD.key = 'plugin-storage/manifest.json'
          OR NEW.key = 'plugin-storage/manifest.json'
          OR OLD.key LIKE '${PLUGIN_VALUE_PREFIX}%'
          OR NEW.key LIKE '${PLUGIN_VALUE_PREFIX}%'
          OR OLD.key LIKE '${PLUGIN_META_PREFIX}%'
          OR NEW.key LIKE '${PLUGIN_META_PREFIX}%'
        BEGIN
            UPDATE plugin_storage_viewer_facet_revision
               SET source_revision = source_revision + 1 WHERE id = 1;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_plugin_viewer_kv_delete
        AFTER DELETE ON kv
        WHEN OLD.key = 'plugin-storage/manifest.json'
          OR OLD.key LIKE '${PLUGIN_VALUE_PREFIX}%'
          OR OLD.key LIKE '${PLUGIN_META_PREFIX}%'
        BEGIN
            UPDATE plugin_storage_viewer_facet_revision
               SET source_revision = source_revision + 1 WHERE id = 1;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_plugin_viewer_manifest_insert
        AFTER INSERT ON manifest_chunks
        WHEN NEW.manifest_key LIKE '${PLUGIN_VALUE_PREFIX}%'
          OR NEW.manifest_key LIKE '${PLUGIN_META_PREFIX}%'
        BEGIN
            UPDATE plugin_storage_viewer_facet_revision
               SET source_revision = source_revision + 1 WHERE id = 1;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_plugin_viewer_manifest_update
        AFTER UPDATE ON manifest_chunks
        WHEN OLD.manifest_key LIKE '${PLUGIN_VALUE_PREFIX}%'
          OR NEW.manifest_key LIKE '${PLUGIN_VALUE_PREFIX}%'
          OR OLD.manifest_key LIKE '${PLUGIN_META_PREFIX}%'
          OR NEW.manifest_key LIKE '${PLUGIN_META_PREFIX}%'
        BEGIN
            UPDATE plugin_storage_viewer_facet_revision
               SET source_revision = source_revision + 1 WHERE id = 1;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_plugin_viewer_manifest_delete
        AFTER DELETE ON manifest_chunks
        WHEN OLD.manifest_key LIKE '${PLUGIN_VALUE_PREFIX}%'
          OR OLD.manifest_key LIKE '${PLUGIN_META_PREFIX}%'
        BEGIN
            UPDATE plugin_storage_viewer_facet_revision
               SET source_revision = source_revision + 1 WHERE id = 1;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_plugin_viewer_manifest_meta_insert
        AFTER INSERT ON chunk_manifest_meta
        WHEN NEW.manifest_key LIKE '${PLUGIN_VALUE_PREFIX}%'
          OR NEW.manifest_key LIKE '${PLUGIN_META_PREFIX}%'
        BEGIN
            UPDATE plugin_storage_viewer_facet_revision
               SET source_revision = source_revision + 1 WHERE id = 1;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_plugin_viewer_manifest_meta_update
        AFTER UPDATE ON chunk_manifest_meta
        WHEN OLD.manifest_key LIKE '${PLUGIN_VALUE_PREFIX}%'
          OR NEW.manifest_key LIKE '${PLUGIN_VALUE_PREFIX}%'
          OR OLD.manifest_key LIKE '${PLUGIN_META_PREFIX}%'
          OR NEW.manifest_key LIKE '${PLUGIN_META_PREFIX}%'
        BEGIN
            UPDATE plugin_storage_viewer_facet_revision
               SET source_revision = source_revision + 1 WHERE id = 1;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_plugin_viewer_manifest_meta_delete
        AFTER DELETE ON chunk_manifest_meta
        WHEN OLD.manifest_key LIKE '${PLUGIN_VALUE_PREFIX}%'
          OR OLD.manifest_key LIKE '${PLUGIN_META_PREFIX}%'
        BEGIN
            UPDATE plugin_storage_viewer_facet_revision
               SET source_revision = source_revision + 1 WHERE id = 1;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_plugin_viewer_manifest_publication_insert
        AFTER INSERT ON chunk_manifest_publications
        WHEN NEW.manifest_key LIKE '${PLUGIN_VALUE_PREFIX}%'
          OR NEW.manifest_key LIKE '${PLUGIN_META_PREFIX}%'
        BEGIN
            UPDATE plugin_storage_viewer_facet_revision
               SET source_revision = source_revision + 1 WHERE id = 1;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_plugin_viewer_manifest_publication_update
        AFTER UPDATE ON chunk_manifest_publications
        WHEN OLD.manifest_key LIKE '${PLUGIN_VALUE_PREFIX}%'
          OR NEW.manifest_key LIKE '${PLUGIN_VALUE_PREFIX}%'
          OR OLD.manifest_key LIKE '${PLUGIN_META_PREFIX}%'
          OR NEW.manifest_key LIKE '${PLUGIN_META_PREFIX}%'
        BEGIN
            UPDATE plugin_storage_viewer_facet_revision
               SET source_revision = source_revision + 1 WHERE id = 1;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_plugin_viewer_manifest_publication_delete
        AFTER DELETE ON chunk_manifest_publications
        WHEN OLD.manifest_key LIKE '${PLUGIN_VALUE_PREFIX}%'
          OR OLD.manifest_key LIKE '${PLUGIN_META_PREFIX}%'
        BEGIN
            UPDATE plugin_storage_viewer_facet_revision
               SET source_revision = source_revision + 1 WHERE id = 1;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_plugin_viewer_chunk_update
        AFTER UPDATE ON chunks
        WHEN EXISTS (
            SELECT 1 FROM manifest_chunks
             WHERE (hash = OLD.hash OR hash = NEW.hash)
               AND (manifest_key LIKE '${PLUGIN_VALUE_PREFIX}%'
                    OR manifest_key LIKE '${PLUGIN_META_PREFIX}%')
        )
        BEGIN
            UPDATE plugin_storage_viewer_facet_revision
               SET source_revision = source_revision + 1 WHERE id = 1;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_plugin_viewer_chunk_delete
        AFTER DELETE ON chunks
        WHEN EXISTS (
            SELECT 1 FROM manifest_chunks
             WHERE hash = OLD.hash
               AND (manifest_key LIKE '${PLUGIN_VALUE_PREFIX}%'
                    OR manifest_key LIKE '${PLUGIN_META_PREFIX}%')
        )
        BEGIN
            UPDATE plugin_storage_viewer_facet_revision
               SET source_revision = source_revision + 1 WHERE id = 1;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_plugin_viewer_owner_insert
        AFTER INSERT ON plugin_storage_owners
        BEGIN
            UPDATE plugin_storage_viewer_facet_revision
               SET source_revision = source_revision + 1 WHERE id = 1;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_plugin_viewer_owner_update
        AFTER UPDATE ON plugin_storage_owners
        BEGIN
            UPDATE plugin_storage_viewer_facet_revision
               SET source_revision = source_revision + 1 WHERE id = 1;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_plugin_viewer_owner_delete
        AFTER DELETE ON plugin_storage_owners
        BEGIN
            UPDATE plugin_storage_viewer_facet_revision
               SET source_revision = source_revision + 1 WHERE id = 1;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_plugin_viewer_value_facet_insert
        AFTER INSERT ON plugin_storage_viewer_value_facets
        BEGIN
            UPDATE plugin_storage_viewer_facet_revision
               SET source_revision = source_revision + 1 WHERE id = 1;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_plugin_viewer_value_facet_update
        AFTER UPDATE ON plugin_storage_viewer_value_facets
        BEGIN
            UPDATE plugin_storage_viewer_facet_revision
               SET source_revision = source_revision + 1 WHERE id = 1;
        END;

        CREATE TRIGGER IF NOT EXISTS pocketrisu_plugin_viewer_value_facet_delete
        AFTER DELETE ON plugin_storage_viewer_value_facets
        BEGIN
            UPDATE plugin_storage_viewer_facet_revision
               SET source_revision = source_revision + 1 WHERE id = 1;
        END;
    `);

    const getState = db.prepare(`
        SELECT source_revision AS sourceRevision,
               indexed_revision AS indexedRevision
          FROM plugin_storage_viewer_facet_revision
         WHERE id = 1
    `);
    const setValueFacet = db.prepare(`
        INSERT INTO plugin_storage_viewer_value_facets (storage_key, display_size)
        VALUES (?, ?)
        ON CONFLICT(storage_key) DO UPDATE SET display_size = excluded.display_size
    `);
    const deleteValueFacet = db.prepare(
        'DELETE FROM plugin_storage_viewer_value_facets WHERE storage_key = ?',
    );
    const deleteValueFacetPrefix = db.prepare(`
        DELETE FROM plugin_storage_viewer_value_facets
         WHERE storage_key LIKE ? ESCAPE '\\'
    `);
    const deleteAllValueFacets = db.prepare('DELETE FROM plugin_storage_viewer_value_facets');
    const deleteAllOwners = db.prepare('DELETE FROM plugin_storage_owners');
    const setOwner = db.prepare(`
        INSERT INTO plugin_storage_owners (storage_key, owner)
        VALUES (?, ?)
        ON CONFLICT(storage_key) DO UPDATE SET owner = excluded.owner
    `);
    const markCurrent = db.prepare(`
        UPDATE plugin_storage_viewer_facet_revision
           SET indexed_revision = source_revision
         WHERE id = 1
    `);

    function state() {
        const row = getState.get();
        return {
            sourceRevision: row?.sourceRevision ?? null,
            indexedRevision: row?.indexedRevision ?? null,
            current: Number.isSafeInteger(row?.sourceRevision)
                && row.sourceRevision === row.indexedRevision,
        };
    }

    function assertDisplaySize(displaySize) {
        if (!Number.isSafeInteger(displaySize) || displaySize < 0) {
            throw new RangeError('Plugin storage viewer display size is invalid');
        }
    }

    function maintainValue(storageKey, displaySize) {
        assertDisplaySize(displaySize);
        if (failpoint === 'value-write') {
            throw new Error('Injected plugin storage viewer facet write failure');
        }
        setValueFacet.run(storageKey, displaySize);
    }

    function removeValue(storageKey) {
        deleteValueFacet.run(storageKey);
    }

    function removeValuePrefix(prefix) {
        const escaped = prefix.replace(/[\\%_]/g, '\\$&');
        deleteValueFacetPrefix.run(`${escaped}%`);
    }

    function finishMaintainedMutation(wasCurrent, maintained = true) {
        if (wasCurrent && maintained) markCurrent.run();
    }

    const replaceAll = db.transaction((expectedSourceRevision, valueFacets, owners) => {
        const before = state();
        if (before.sourceRevision !== expectedSourceRevision) {
            return { published: false, state: before };
        }
        deleteAllValueFacets.run();
        deleteAllOwners.run();
        for (const facet of valueFacets) {
            if (typeof facet?.storageKey !== 'string') {
                throw new TypeError('Plugin storage viewer facet key is invalid');
            }
            assertDisplaySize(facet.displaySize);
            setValueFacet.run(facet.storageKey, facet.displaySize);
        }
        for (const facet of owners) {
            if (typeof facet?.storageKey !== 'string'
                || typeof facet.owner !== 'string'
                || facet.owner.length === 0
                || !facet.owner.isWellFormed()) {
                throw new TypeError('Plugin storage viewer owner facet is invalid');
            }
            setOwner.run(facet.storageKey, facet.owner);
        }
        markCurrent.run();
        return { published: true, state: state() };
    });

    return {
        state,
        maintainValue,
        removeValue,
        removeValuePrefix,
        finishMaintainedMutation,
        replaceAll,
    };
}

function createPluginStorageViewerFacetSnapshot(snapshotDb) {
    const getState = snapshotDb.prepare(`
        SELECT source_revision AS sourceRevision,
               indexed_revision AS indexedRevision
          FROM plugin_storage_viewer_facet_revision
         WHERE id = 1
    `);
    const listValueFacets = snapshotDb.prepare(`
        WITH requested(storage_key) AS (
            SELECT value FROM json_each(?)
        )
        SELECT facets.storage_key AS storageKey,
               facets.display_size AS displaySize
          FROM plugin_storage_viewer_value_facets AS facets
          JOIN requested ON requested.storage_key = facets.storage_key
    `);
    const summarizeValueFacets = snapshotDb.prepare(`
        WITH requested(storage_key) AS (
            SELECT value FROM json_each(?)
        )
        SELECT COUNT(facets.storage_key) AS count,
               COALESCE(SUM(facets.display_size), 0) AS totalBytes
          FROM requested
          LEFT JOIN plugin_storage_viewer_value_facets AS facets
            ON facets.storage_key = requested.storage_key
    `);
    const listOwnerFacets = snapshotDb.prepare(`
        WITH requested(storage_key) AS (
            SELECT value FROM json_each(?)
        )
        SELECT owners.owner AS owner, COUNT(*) AS count
          FROM plugin_storage_owners AS owners
          JOIN requested ON requested.storage_key = owners.storage_key
         GROUP BY owners.owner
         ORDER BY owners.owner
    `);
    const listOwnerKeys = snapshotDb.prepare(`
        WITH requested(storage_key) AS (
            SELECT value FROM json_each(?)
        )
        SELECT owners.storage_key AS storageKey
          FROM plugin_storage_owners AS owners
          JOIN requested ON requested.storage_key = owners.storage_key
         WHERE (? IS NULL OR owners.owner = ?)
    `);
    const getOwner = snapshotDb.prepare(
        'SELECT owner FROM plugin_storage_owners WHERE storage_key = ?',
    );
    return {
        viewerFacetState() {
            const row = getState.get();
            return {
                sourceRevision: row?.sourceRevision ?? null,
                indexedRevision: row?.indexedRevision ?? null,
                current: Number.isSafeInteger(row?.sourceRevision)
                    && row.sourceRevision === row.indexedRevision,
            };
        },
        viewerValueFacets(storageKeys) {
            if (storageKeys.length === 0) return [];
            return listValueFacets.all(JSON.stringify(storageKeys));
        },
        viewerValueFacetSummary(storageKeys) {
            if (storageKeys.length === 0) return { count: 0, totalBytes: 0 };
            return summarizeValueFacets.get(JSON.stringify(storageKeys));
        },
        viewerOwnerFacets(storageKeys) {
            if (storageKeys.length === 0) return [];
            return listOwnerFacets.all(JSON.stringify(storageKeys));
        },
        viewerOwnerKeys(storageKeys, owner = null) {
            if (storageKeys.length === 0) return [];
            return listOwnerKeys
                .all(JSON.stringify(storageKeys), owner, owner)
                .map((row) => row.storageKey);
        },
        viewerOwner(storageKey) {
            return getOwner.get(storageKey)?.owner ?? null;
        },
    };
}

module.exports = {
    createPluginStorageViewerFacetSnapshot,
    createPluginStorageViewerFacetStore,
    pluginStorageViewerDisplaySize,
    pluginStorageViewerDisplaySizeFromMetadata,
    pluginStorageViewerValueText,
};
