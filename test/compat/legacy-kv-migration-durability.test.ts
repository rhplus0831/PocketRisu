import { afterAll, describe, expect, test } from 'vitest'
import path from 'node:path'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import Database from 'better-sqlite3'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { decodeBackup } from './helpers/decode.js'

const DB_KEY = 'database/database.bin'
const EXTRA_KEY = 'legacy/migration-boundary'
const MIGRATION_ID = 'legacy-hex-files-to-sqlite'
const MARKER_NAME = '.migrated_to_sqlite'

const servers: ServerHandle[] = []
afterAll(async () => { await Promise.allSettled(servers.map(server => server.cleanup())) })

function hexName(key: string): string {
  return Buffer.from(key, 'utf-8').toString('hex')
}

function seedDatabaseBlob(note: string): Buffer {
  const entry = decodeBackup(createSeedBackup({
    databaseFields: { globalNote: note },
  })).find(candidate => candidate.name === 'database.risudat')
  if (!entry) throw new Error('seed backup has no database.risudat')
  return entry.data
}

function createEmptyLegacyTarget(saveDir: string): void {
  const sqlite = new Database(path.join(saveDir, 'risuai.db'))
  try {
    sqlite.exec(`
      CREATE TABLE kv (
        key        TEXT    PRIMARY KEY,
        value      BLOB    NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
  } finally {
    sqlite.close()
  }
}

function readMigrationState(server: ServerHandle): {
  version: number
  source_count: number
} | undefined {
  const sqlite = new Database(path.join(server.cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    return sqlite.prepare(`
      SELECT version, source_count
      FROM storage_migrations
      WHERE migration_id = ?
    `).get(MIGRATION_ID) as { version: number; source_count: number } | undefined
  } finally {
    sqlite.close()
  }
}

async function readKey(client: RisuClient, key: string): Promise<Response> {
  return client.fetch('/api/read', {
    headers: { 'file-path': hexName(key) },
  })
}

describe('legacy hex-file migration durability', () => {
  test('recovers when the filesystem marker outlived the SQLite transaction', async () => {
    const database = seedDatabaseBlob('recovered-marker-drift')
    const extraValue = Buffer.from('preserved legacy value')
    const server = await spawnServer({
      seedSave: async saveDir => {
        // This is the post-power-loss state from the audit: the marker reached
        // disk, the WAL transaction did not, and the original files survived.
        createEmptyLegacyTarget(saveDir)
        await writeFile(path.join(saveDir, hexName(DB_KEY)), database)
        await writeFile(path.join(saveDir, hexName(EXTRA_KEY)), extraValue)
        await writeFile(path.join(saveDir, MARKER_NAME), 'legacy marker')
      },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)

    const databaseRead = await readKey(client, DB_KEY)
    expect(databaseRead.status).toBe(200)
    await databaseRead.arrayBuffer()
    const extraRead = await readKey(client, EXTRA_KEY)
    expect(extraRead.status).toBe(200)
    expect(Buffer.from(await extraRead.arrayBuffer())).toEqual(extraValue)
    expect(readMigrationState(server)).toEqual({ version: 1, source_count: 2 })

    expect(await readFile(path.join(server.cwd, 'save', hexName(DB_KEY)))).toEqual(database)
    expect(await readFile(path.join(server.cwd, 'save', MARKER_NAME), 'utf-8')).not.toBe('')
    expect((await readdir(path.join(server.cwd, 'save'))).filter(name => (
      name.startsWith(`${MARKER_NAME}.`) && name.endsWith('.tmp')
    ))).toEqual([])
  })

  test('transactional completion survives marker loss without resurrecting deleted keys', async () => {
    const extraValue = Buffer.from('migrate only once')
    const server = await spawnServer({
      seedSave: async saveDir => {
        await writeFile(path.join(saveDir, hexName(DB_KEY)), seedDatabaseBlob('one-shot-migration'))
        await writeFile(path.join(saveDir, hexName(EXTRA_KEY)), extraValue)
      },
    })
    servers.push(server)
    let client = await createClient(server.port, server.password)

    expect(readMigrationState(server)).toEqual({ version: 1, source_count: 2 })
    const remove = await client.fetch('/api/remove', {
      headers: { 'file-path': hexName(EXTRA_KEY) },
    })
    expect(remove.status).toBe(200)
    await remove.arrayBuffer()
    const removedRead = await readKey(client, EXTRA_KEY)
    expect(removedRead.status).toBe(200)
    expect((await removedRead.arrayBuffer()).byteLength).toBe(0)

    // This is the other transaction/marker boundary: SQLite completion exists,
    // but marker publication was lost. Restart must repair only the marker.
    const markerPath = path.join(server.cwd, 'save', MARKER_NAME)
    await rm(markerPath, { force: true })
    await server.restart()
    client = await createClient(server.port, server.password)

    const restartedRead = await readKey(client, EXTRA_KEY)
    expect(restartedRead.status).toBe(200)
    expect((await restartedRead.arrayBuffer()).byteLength).toBe(0)
    expect(await readFile(path.join(server.cwd, 'save', hexName(EXTRA_KEY)))).toEqual(extraValue)
    expect(await readFile(markerPath, 'utf-8')).not.toBe('')
    expect(readMigrationState(server)).toEqual({ version: 1, source_count: 2 })
  })
})
