import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import revisionPkg from './databaseRevision.cjs'

const {
    DATABASE_KEY,
    PLUGIN_STORAGE_MANIFEST_KEY,
    createDatabaseRevisionTracker,
    createPluginStoragePublicationRevisionTracker,
} = revisionPkg as {
    DATABASE_KEY: string
    PLUGIN_STORAGE_MANIFEST_KEY: string
    createDatabaseRevisionTracker: (db: Database.Database) => {
        getRevision: () => number | null
    }
    createPluginStoragePublicationRevisionTracker: (db: Database.Database) => {
        getRevision: () => number | null
    }
}

function setup() {
    const db = new Database(':memory:')
    db.exec(`
        CREATE TABLE kv (
            key TEXT PRIMARY KEY,
            value BLOB NOT NULL,
            updated_at INTEGER NOT NULL
        )
    `)
    return { db, tracker: createDatabaseRevisionTracker(db) }
}

describe('authoritative database row revision', () => {
    it('advances for insert, update, rename, replace, delete, and recreate without ABA', () => {
        const { db, tracker } = setup()
        const insert = db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)')
        const update = db.prepare('UPDATE kv SET value = ?, updated_at = ? WHERE key = ?')
        const replace = db.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)')

        expect(tracker.getRevision()).toBeNull()
        insert.run(DATABASE_KEY, Buffer.from('one'), 1000)
        const inserted = tracker.getRevision()
        expect(inserted).toBeTypeOf('number')

        update.run(Buffer.from('two'), 1000, DATABASE_KEY)
        const updated = tracker.getRevision()
        expect(updated).toBeGreaterThan(inserted!)

        db.prepare('UPDATE kv SET key = ? WHERE key = ?').run('renamed-away', DATABASE_KEY)
        expect(tracker.getRevision()).toBeNull()
        db.prepare('UPDATE kv SET key = ? WHERE key = ?').run(DATABASE_KEY, 'renamed-away')
        const renamed = tracker.getRevision()
        expect(renamed).toBeGreaterThan(updated!)

        replace.run(DATABASE_KEY, Buffer.from('three'), 1000)
        const replaced = tracker.getRevision()
        expect(replaced).toBeGreaterThan(renamed!)

        db.prepare('DELETE FROM kv WHERE key = ?').run(DATABASE_KEY)
        expect(tracker.getRevision()).toBeNull()

        insert.run(DATABASE_KEY, Buffer.from('four'), 1000)
        expect(tracker.getRevision()).toBeGreaterThan(replaced!)
        db.close()
    })

    it('rolls the revision back with the database mutation', () => {
        const { db, tracker } = setup()
        db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)')
            .run(DATABASE_KEY, Buffer.from('before'), 1000)
        const before = tracker.getRevision()

        expect(() => db.transaction(() => {
            db.prepare('UPDATE kv SET value = ? WHERE key = ?')
                .run(Buffer.from('rolled-back'), DATABASE_KEY)
            expect(tracker.getRevision()).toBeGreaterThan(before!)
            throw new Error('rollback')
        })()).toThrow('rollback')

        expect(tracker.getRevision()).toBe(before)
        expect(db.prepare('SELECT value FROM kv WHERE key = ?').get(DATABASE_KEY))
            .toMatchObject({ value: Buffer.from('before') })
        db.close()
    })

    it('ignores unrelated KV mutations', () => {
        const { db, tracker } = setup()
        const write = db.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)')
        write.run('assets/example', Buffer.from('asset'), 1000)
        expect(tracker.getRevision()).toBeNull()
        write.run(DATABASE_KEY, Buffer.from('database'), 1000)
        const revision = tracker.getRevision()
        write.run('assets/example', Buffer.from('changed'), 1000)
        expect(tracker.getRevision()).toBe(revision)
        db.close()
    })
})

describe('optimized plugin publication revision', () => {
    function setupPublication() {
        const db = new Database(':memory:')
        db.exec(`
            CREATE TABLE kv (
                key TEXT PRIMARY KEY,
                value BLOB NOT NULL,
                updated_at INTEGER NOT NULL
            )
        `)
        return { db, tracker: createPluginStoragePublicationRevisionTracker(db) }
    }

    it('advances for direct manifest changes and database generation/full writes', () => {
        const { db, tracker } = setupPublication()
        const write = db.prepare(
            'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
        )

        expect(tracker.getRevision()).toBeNull()
        write.run(DATABASE_KEY, Buffer.from('generation-a'), 1)
        const initial = tracker.getRevision()!
        write.run(PLUGIN_STORAGE_MANIFEST_KEY, Buffer.from('manifest-a'), 1)
        const manifested = tracker.getRevision()!
        expect(manifested).toBeGreaterThan(initial)

        // These SQL writes deliberately bypass every server KV wrapper.
        db.prepare('UPDATE kv SET value = ? WHERE key = ?')
            .run(Buffer.from('manifest-b'), PLUGIN_STORAGE_MANIFEST_KEY)
        const externalManifest = tracker.getRevision()!
        expect(externalManifest).toBeGreaterThan(manifested)
        db.prepare('UPDATE kv SET value = ? WHERE key = ?')
            .run(Buffer.from('generation-b'), DATABASE_KEY)
        expect(tracker.getRevision()).toBeGreaterThan(externalManifest)
        db.close()
    })

    it('invalidates transitions and destructive replacements without observing unrelated rows', () => {
        const { db, tracker } = setupPublication()
        const write = db.prepare(
            'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
        )
        write.run(DATABASE_KEY, Buffer.from('optimized'), 1)
        write.run(PLUGIN_STORAGE_MANIFEST_KEY, Buffer.from('manifest'), 1)
        const beforeAsset = tracker.getRevision()
        write.run('assets/unrelated', Buffer.from('asset'), 1)
        expect(tracker.getRevision()).toBe(beforeAsset)

        // Internalization deletes the exact manifest and replaces the selected
        // database generation in one transaction.
        db.transaction(() => {
            db.prepare('DELETE FROM kv WHERE key = ?').run(PLUGIN_STORAGE_MANIFEST_KEY)
            db.prepare('UPDATE kv SET value = ? WHERE key = ?')
                .run(Buffer.from('inline'), DATABASE_KEY)
        })()
        const transitioned = tracker.getRevision()!
        expect(transitioned).toBeGreaterThan(beforeAsset!)

        // Imports/restores clear and recreate the authoritative KV set.
        db.transaction(() => {
            db.prepare('DELETE FROM kv').run()
            write.run(DATABASE_KEY, Buffer.from('restored-generation'), 2)
            write.run(PLUGIN_STORAGE_MANIFEST_KEY, Buffer.from('restored-manifest'), 2)
        })()
        expect(tracker.getRevision()).toBeGreaterThan(transitioned)
        db.close()
    })

    it('rolls back the publication revision with a failed replacement', () => {
        const { db, tracker } = setupPublication()
        const write = db.prepare(
            'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
        )
        write.run(DATABASE_KEY, Buffer.from('database'), 1)
        write.run(PLUGIN_STORAGE_MANIFEST_KEY, Buffer.from('manifest'), 1)
        const before = tracker.getRevision()

        expect(() => db.transaction(() => {
            db.prepare('DELETE FROM kv').run()
            expect(tracker.getRevision()).toBeNull()
            throw new Error('rollback replacement')
        })()).toThrow('rollback replacement')

        expect(tracker.getRevision()).toBe(before)
        db.close()
    })
})
