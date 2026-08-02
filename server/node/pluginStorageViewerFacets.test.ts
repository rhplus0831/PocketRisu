import { createRequire } from 'node:module'
import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const {
  createPluginStorageViewerFacetStore,
  pluginStorageViewerDisplaySize,
} = require('./pluginStorageViewerFacets.cjs') as {
  createPluginStorageViewerFacetStore: (db: Database.Database) => {
    state: () => {
      sourceRevision: number
      indexedRevision: number | null
      current: boolean
    }
    replaceAll: (
      expectedSourceRevision: number,
      values: Array<{ storageKey: string; displaySize: number }>,
      owners: Array<{ storageKey: string; owner: string }>,
    ) => { published: boolean; state: { sourceRevision: number; current: boolean } }
  }
  pluginStorageViewerDisplaySize: (value: unknown) => number
}

function createDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE kv (
      key TEXT PRIMARY KEY,
      value BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE plugin_storage_owners (
      storage_key TEXT PRIMARY KEY,
      owner TEXT NOT NULL
    );
    CREATE TABLE chunks (hash TEXT PRIMARY KEY, data BLOB NOT NULL);
    CREATE TABLE manifest_chunks (
      manifest_key TEXT NOT NULL,
      seq INTEGER NOT NULL,
      hash TEXT NOT NULL,
      PRIMARY KEY (manifest_key, seq)
    );
    CREATE TABLE chunk_manifest_meta (
      manifest_key TEXT PRIMARY KEY,
      chunk_count INTEGER NOT NULL,
      logical_size INTEGER NOT NULL,
      logical_sha256 TEXT NOT NULL
    );
    CREATE TABLE chunk_manifest_publications (manifest_key TEXT PRIMARY KEY);
  `)
  return db
}

describe('plugin storage viewer facets', () => {
  test('uses the exact existing viewer display semantics', () => {
    expect(pluginStorageViewerDisplaySize('한글')).toBe(Buffer.byteLength('한글'))
    expect(pluginStorageViewerDisplaySize(null)).toBe(0)
    expect(pluginStorageViewerDisplaySize({ spaced: 'é' }))
      .toBe(Buffer.byteLength(JSON.stringify({ spaced: 'é' })))
  })

  test('marks direct source or facet changes stale and compare-publishes a rebuild', () => {
    const db = createDb()
    try {
      const facets = createPluginStorageViewerFacetStore(db)
      expect(facets.state()).toMatchObject({
        sourceRevision: 0,
        indexedRevision: null,
        current: false,
      })

      const first = facets.replaceAll(0, [
        { storageKey: 'pluginsave/a.json', displaySize: 7 },
      ], [
        { storageKey: 'pluginsave-meta/a.json', owner: 'Owner A' },
      ])
      expect(first).toMatchObject({ published: true, state: { current: true } })

      db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(
        'database/database.bin',
        Buffer.from('unrelated-save'),
        1,
      )
      expect(facets.state()).toMatchObject({
        sourceRevision: first.state.sourceRevision,
        current: true,
      })

      db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(
        'pluginsave/a.json',
        Buffer.from('{"b":2}'),
        1,
      )
      const stale = facets.state()
      expect(stale.current).toBe(false)
      expect(facets.replaceAll(first.state.sourceRevision, [], []).published).toBe(false)

      const rebuilt = facets.replaceAll(stale.sourceRevision, [
        { storageKey: 'pluginsave/a.json', displaySize: 7 },
      ], [])
      expect(rebuilt).toMatchObject({ published: true, state: { current: true } })

      db.prepare(
        'DELETE FROM plugin_storage_viewer_value_facets WHERE storage_key = ?',
      ).run('pluginsave/a.json')
      expect(facets.state().current).toBe(false)
    } finally {
      db.close()
    }
  })
})
