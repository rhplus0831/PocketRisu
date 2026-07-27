import path from 'node:path'
import { readdir } from 'node:fs/promises'
import { gzipSync, gunzipSync } from 'node:zlib'
import Database from 'better-sqlite3'
import { afterAll, describe, expect, test } from 'vitest'
import { createClient, type RisuClient } from './helpers/client.js'
import { encodeBackup } from './helpers/encode.js'
import { createSeedBackup } from './helpers/seed.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'

const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

function pluginStorageKey(rawKey: string): string {
  return `pluginsave/${Buffer.from(rawKey, 'utf-8').toString('base64url')}.json`
}

async function waitForNoFullExportPins(cwd: string, timeoutMs = 10_000): Promise<void> {
  const spoolDir = path.join(cwd, 'save', '.partial-export-spool')
  const deadline = Date.now() + timeoutMs
  let last: string[] = []
  while (Date.now() < deadline) {
    last = await readdir(spoolDir).catch(() => [])
    if (!last.some(name => name.startsWith('.full-export-'))) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Full export pins remain: ${last.join(', ')}`)
}

async function backupFiles(server: ServerHandle): Promise<string[]> {
  return (await readdir(path.join(server.cwd, 'backups')).catch(() => []))
    .filter(name => name.endsWith('.bin') || name.startsWith('.risu-backup-save-'))
    .sort()
}

async function expectBothRoutesRejectWithoutPublication(
  server: ServerHandle,
  client: RisuClient,
): Promise<void> {
  const before = await backupFiles(server)
  const download = await client.fetch('/api/backup/export')
  expect(download.status).toBeGreaterThanOrEqual(400)
  expect(download.headers.get('content-disposition')).toBeNull()
  expect(download.headers.get('x-risu-backup-assets')).toBeNull()
  await download.arrayBuffer()
  await waitForNoFullExportPins(server.cwd)

  const save = await client.fetch('/api/backup/server/save', { method: 'POST' })
  expect(save.status).toBeGreaterThanOrEqual(400)
  expect(save.headers.get('content-type')).not.toContain('application/x-ndjson')
  await save.arrayBuffer()
  await waitForNoFullExportPins(server.cwd)
  expect(await backupFiles(server)).toEqual(before)
  expect((await client.fetch('/api/backup/server/list')).status).toBe(200)
}

describe('full export corruption rejection', () => {
  test('gzip cold rows reject corrupt CRC, truncation, and wrong ISIZE on both routes', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    expect((await client.importBackup(createSeedBackup())).ok).toBe(true)

    const storageKey = 'coldstorage/corrupt-gzip'
    const plain = Buffer.from(JSON.stringify({ payload: 'x'.repeat(256 * 1024) }))
    const valid = gzipSync(plain)
    const crc = Buffer.from(valid)
    crc[crc.length - 8] ^= 0xff
    const truncated = Buffer.concat([valid.subarray(0, -9), valid.subarray(-8)])
    const wrongSize = Buffer.from(valid)
    wrongSize.writeUInt32LE((plain.length + 1) >>> 0, wrongSize.length - 4)
    for (const value of [crc, truncated, wrongSize]) {
      expect(() => gunzipSync(value)).toThrow()
      const sqlite = new Database(path.join(server.cwd, 'save', 'risuai.db'))
      sqlite.prepare(
        'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
      ).run(storageKey, value, Date.now())
      sqlite.close()
      await expectBothRoutesRejectWithoutPublication(server, client)
    }

    const sqlite = new Database(path.join(server.cwd, 'save', 'risuai.db'))
    sqlite.prepare(
      'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
    ).run(storageKey, valid, Date.now())
    sqlite.close()
    const healthy = await client.fetch('/api/backup/export')
    expect(healthy.status).toBe(200)
    await healthy.arrayBuffer()
    await waitForNoFullExportPins(server.cwd)
  }, 60_000)

  test('chunk publication corruption never publishes a response or server archive', async () => {
    const server = await spawnServer({ env: { POCKETRISU_CHUNK_THRESHOLD: '1024' } })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const generation = 'corruption-matrix-generation'
    const key = pluginStorageKey('corruption-matrix-value')
    const value = Buffer.from(JSON.stringify({ payload: 'v'.repeat(256 * 1024) }))
    const manifest = Buffer.from(JSON.stringify({
      version: 1,
      generation,
      valueKeys: [key],
      metaKeys: [],
    }))
    const seed = Buffer.concat([
      createSeedBackup({
        databaseFields: {
          optimizePluginMemory: true,
          pluginStorageGeneration: generation,
          pluginCustomStorage: {},
        },
      }),
      encodeBackup([
        { name: key, data: value },
        { name: 'plugin-storage/manifest.json', data: manifest },
      ]),
    ])

    const corruptions: Array<(sqlite: Database.Database) => void> = [
      sqlite => {
        sqlite.prepare('DELETE FROM manifest_chunks WHERE manifest_key = ? AND seq = 1').run(key)
      },
      sqlite => {
        const row = sqlite.prepare(
          'SELECT hash FROM manifest_chunks WHERE manifest_key = ? AND seq = 0',
        ).get(key) as { hash: string }
        sqlite.prepare('DELETE FROM chunks WHERE hash = ?').run(row.hash)
      },
      sqlite => {
        const rows = sqlite.prepare(
          'SELECT seq, hash FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq LIMIT 2',
        ).all(key) as Array<{ seq: number; hash: string }>
        sqlite.prepare('UPDATE manifest_chunks SET hash = ? WHERE manifest_key = ? AND seq = ?')
          .run(rows[0].hash, key, rows[1].seq)
        const total = sqlite.prepare(
          `SELECT SUM(LENGTH(c.data)) AS size FROM manifest_chunks m
           JOIN chunks c ON c.hash = m.hash WHERE m.manifest_key = ?`,
        ).get(key) as { size: number }
        sqlite.prepare('UPDATE chunk_manifest_meta SET logical_size = ? WHERE manifest_key = ?')
          .run(total.size, key)
      },
      sqlite => {
        const rows = sqlite.prepare(
          'SELECT seq, hash FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq LIMIT 2',
        ).all(key) as Array<{ seq: number; hash: string }>
        sqlite.prepare('UPDATE manifest_chunks SET hash = ? WHERE manifest_key = ? AND seq = ?')
          .run(rows[1].hash, key, rows[0].seq)
        sqlite.prepare('UPDATE manifest_chunks SET hash = ? WHERE manifest_key = ? AND seq = ?')
          .run(rows[0].hash, key, rows[1].seq)
      },
      sqlite => {
        const row = sqlite.prepare(
          'SELECT hash FROM manifest_chunks WHERE manifest_key = ? AND seq = 0',
        ).get(key) as { hash: string }
        const stored = sqlite.prepare('SELECT data FROM chunks WHERE hash = ?')
          .get(row.hash) as { data: Buffer }
        const changed = Buffer.from(stored.data)
        changed[0] ^= 0xff
        sqlite.prepare('UPDATE chunks SET data = ? WHERE hash = ?').run(changed, row.hash)
      },
      sqlite => {
        sqlite.prepare(
          'UPDATE chunk_manifest_meta SET logical_size = logical_size + 1 WHERE manifest_key = ?',
        ).run(key)
      },
      sqlite => {
        sqlite.prepare(
          'UPDATE chunk_manifest_meta SET logical_sha256 = ? WHERE manifest_key = ?',
        ).run('0'.repeat(64), key)
      },
    ]

    expect((await client.importBackup(seed)).ok).toBe(true)
    const pristineDb = new Database(path.join(server.cwd, 'save', 'risuai.db'))
    const pristineManifest = pristineDb.prepare(
      'SELECT seq, hash FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq',
    ).all(key) as Array<{ seq: number; hash: string }>
    const pristineMeta = pristineDb.prepare(
      `SELECT chunk_count, logical_size, logical_sha256
       FROM chunk_manifest_meta WHERE manifest_key = ?`,
    ).get(key) as { chunk_count: number; logical_size: number; logical_sha256: string }
    const pristineChunks = pristineManifest.map(({ hash }) => ({
      hash,
      data: Buffer.from((pristineDb.prepare('SELECT data FROM chunks WHERE hash = ?')
        .get(hash) as { data: Buffer }).data),
    }))
    pristineDb.close()

    for (const corrupt of corruptions) {
      const sqlite = new Database(path.join(server.cwd, 'save', 'risuai.db'))
      sqlite.transaction(() => corrupt(sqlite))()
      sqlite.close()
      await expectBothRoutesRejectWithoutPublication(server, client)

      const restore = new Database(path.join(server.cwd, 'save', 'risuai.db'))
      restore.transaction(() => {
        restore.prepare('DELETE FROM manifest_chunks WHERE manifest_key = ?').run(key)
        restore.prepare('DELETE FROM chunk_manifest_meta WHERE manifest_key = ?').run(key)
        restore.prepare('DELETE FROM chunk_manifest_publications WHERE manifest_key = ?').run(key)
        const insertChunk = restore.prepare('INSERT OR REPLACE INTO chunks (hash, data) VALUES (?, ?)')
        for (const chunk of pristineChunks) insertChunk.run(chunk.hash, chunk.data)
        const insertManifest = restore.prepare(
          'INSERT INTO manifest_chunks (manifest_key, seq, hash) VALUES (?, ?, ?)',
        )
        for (const row of pristineManifest) insertManifest.run(key, row.seq, row.hash)
        restore.prepare(
          `INSERT INTO chunk_manifest_meta
           (manifest_key, chunk_count, logical_size, logical_sha256) VALUES (?, ?, ?, ?)`,
        ).run(
          key,
          pristineMeta.chunk_count,
          pristineMeta.logical_size,
          pristineMeta.logical_sha256,
        )
        restore.prepare(
          'INSERT INTO chunk_manifest_publications (manifest_key) VALUES (?)',
        ).run(key)
      })()
      restore.close()
    }

    const healthy = await client.fetch('/api/backup/export')
    expect(healthy.status).toBe(200)
    await healthy.arrayBuffer()
    await waitForNoFullExportPins(server.cwd)
  }, 120_000)
})
