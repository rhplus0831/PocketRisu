import { afterAll, describe, expect, test } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createClient, type RisuClient } from './helpers/client.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import utilsPkg from '../../server/node/utils.cjs'

const { encodeRisuSaveLegacy } = utilsPkg as {
  encodeRisuSaveLegacy: (value: unknown) => Uint8Array
}

const servers: ServerHandle[] = []
afterAll(async () => Promise.allSettled(servers.map(server => server.cleanup())))

const GENERATION = 'ip1-publication'
const MANIFEST_KEY = 'plugin-storage/manifest.json'
const DATABASE_KEY = 'database/database.bin'
const FALLBACK_KEYS = ['config', 'credential', 'index', 'ledger', 'shard']
const ALL_KEYS = [...FALLBACK_KEYS, 'nullable']
const NULLABLE_ROW_GENERATION = '123e4567-e89b-42d3-a456-426614174000'
const valueKey = (key: string) => `pluginsave/${Buffer.from(key).toString('base64url')}.json`
const ownerKey = (key: string) => `pluginsave-meta/${Buffer.from(key).toString('base64url')}.json`
const manifest = {
  version: 1,
  generation: GENERATION,
  valueKeys: ALL_KEYS.map(valueKey).sort(),
  metaKeys: ALL_KEYS.map(ownerKey).sort(),
}

function seed(saveDir: string): void {
  const db = new Database(path.join(saveDir, 'risuai.db'))
  db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL)')
  const insert = db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)')
  for (const key of FALLBACK_KEYS) {
    insert.run(valueKey(key), Buffer.from(JSON.stringify({ durable: key, entries: ['old'] })), 1)
    insert.run(ownerKey(key), Buffer.from(JSON.stringify({ plugin: 'Existing', updatedAt: 1 })), 1)
  }
  insert.run(valueKey('nullable'), Buffer.from('null'), 1)
  insert.run(ownerKey('nullable'), Buffer.from(JSON.stringify({
    plugin: 'Existing',
    updatedAt: 1,
    revision: '223e4567-e89b-42d3-a456-426614174000',
    generation: NULLABLE_ROW_GENERATION,
  })), 1)
  insert.run(MANIFEST_KEY, Buffer.from(JSON.stringify(manifest)), 1)
  insert.run(DATABASE_KEY, Buffer.from(encodeRisuSaveLegacy({
    characters: [],
    optimizePluginMemory: true,
    pluginStorageGeneration: GENERATION,
    pluginCustomStorage: {},
  })), 1)
  db.close()
}

async function boot(): Promise<{ server: ServerHandle; client: RisuClient }> {
  const server = await spawnServer({
    seedSave: async saveDir => seed(saveDir),
    env: { POCKETRISU_TEST_PLUGIN_STATE_FAILPOINT: 'read' },
  })
  servers.push(server)
  return { server, client: await createClient(server.port, server.password) }
}

function state(client: RisuClient, key: string, generation = GENERATION): Promise<Response> {
  return client.fetch('/api/plugin-storage/state', {
    headers: {
      'file-path': Buffer.from(valueKey(key)).toString('hex'),
      'x-plugin-storage-generation': generation,
    },
  })
}

function rawState(client: RisuClient, key: string, generation = GENERATION): Promise<Response> {
  return client.fetch('/api/plugin-storage/state/raw', {
    headers: {
      'file-path': Buffer.from(valueKey(key)).toString('hex'),
      'x-plugin-storage-generation': generation,
    },
  })
}

function missingFallbackBatch(key: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    version: 1,
    generation: GENERATION,
    expectedManifest: manifest,
    operations: [{
      operation: 'set',
      key,
      value: Buffer.from(JSON.stringify(key === 'credential' ? '' : { entries: [] })).toString('base64'),
      owner: 'IP1',
      expectedRevision: null,
    }],
  }))
}

function readDurableValues(cwd: string): Record<string, unknown> {
  const db = new Database(path.join(cwd, 'save', 'risuai.db'), { readonly: true })
  const get = db.prepare('SELECT value FROM kv WHERE key = ?')
  const values = Object.fromEntries(FALLBACK_KEYS.map(key => [
    key,
    JSON.parse(Buffer.from((get.get(valueKey(key)) as { value: Buffer }).value).toString()),
  ]))
  db.close()
  return values
}

describe('IP1 safe plugin storage read/update integration', () => {
  test('failed GET fallbacks CAS-conflict for configuration, credentials, indexes, ledgers, and shards', async () => {
    const { server, client } = await boot()

    for (const key of FALLBACK_KEYS) {
      const failedRead = await state(client, key)
      expect(failedRead.status).toBe(503)
      await expect(failedRead.json()).resolves.toMatchObject({
        code: 'TEMPORARY_STORAGE_FAILURE',
        retryable: true,
      })

      // Even a plugin that incorrectly derives an empty value from this
      // failure cannot overwrite the row when it uses the missing-state CAS.
      const fallbackWrite = await client.fetch('/api/plugin-storage/batch', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: missingFallbackBatch(key),
      })
      expect(fallbackWrite.status).toBe(409)
      await expect(fallbackWrite.json()).resolves.toMatchObject({
        outcome: 'not-committed',
        code: 'PLUGIN_STORAGE_REVISION_CONFLICT',
        conflicts: [{ key, currentRevision: expect.stringMatching(/^sha256:/) }],
      })
    }

    expect(readDurableValues(server.cwd)).toEqual(Object.fromEntries(
      FALLBACK_KEYS.map(key => [key, { durable: key, entries: ['old'] }]),
    ))
  })

  test('the server state contract distinguishes missing from stored JSON null', async () => {
    const { server } = await boot()
    await server.restart({ POCKETRISU_TEST_PLUGIN_STATE_FAILPOINT: '' })
    const client = await createClient(server.port, server.password)

    const nullable = await state(client, 'nullable')
    expect(nullable.status).toBe(200)
    expect(nullable.headers.get('x-plugin-storage-publication-generation')).toBe(GENERATION)
    expect(nullable.headers.get('x-plugin-storage-publication-revision')).toBe(
      `sha256:${createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}`,
    )
    const nullableBody = await nullable.json() as any
    expect(nullableBody).toMatchObject({ missing: false })
    expect(Buffer.from(nullableBody.value, 'base64').toString()).toBe('null')
    expect(nullableBody.revision).toMatch(/^sha256:/)

    const rawNullable = await rawState(client, 'nullable')
    expect(rawNullable.status).toBe(200)
    const rawBytes = Buffer.from(await rawNullable.arrayBuffer())
    expect(rawBytes).toEqual(Buffer.from(nullableBody.value, 'base64'))
    expect(rawBytes.toString()).toBe('null')
    expect(rawNullable.headers.get('content-type')).toBe('application/json')
    expect(rawNullable.headers.get('x-plugin-storage-codec')).toBe('json-v1')
    expect(rawNullable.headers.get('x-plugin-storage-byte-length')).toBe('4')
    expect(rawNullable.headers.get('content-length')).toBe('4')
    expect(rawNullable.headers.get('x-plugin-storage-content-digest')).toBe(
      `sha256:${createHash('sha256').update(rawBytes).digest('hex')}`,
    )
    expect(rawNullable.headers.get('x-plugin-storage-row-revision'))
      .toBe(nullableBody.revision)
    expect(rawNullable.headers.get('x-plugin-storage-row-generation'))
      .toBe(NULLABLE_ROW_GENERATION)
    expect(rawNullable.headers.get('x-plugin-storage-publication-generation'))
      .toBe(GENERATION)
    expect(rawNullable.headers.get('x-plugin-storage-publication-revision')).toBe(
      `sha256:${createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}`,
    )

    const missing = await state(client, 'actually-missing')
    expect(missing.status).toBe(200)
    expect(missing.headers.get('x-plugin-storage-publication-generation')).toBe(GENERATION)
    expect(missing.headers.get('x-plugin-storage-publication-revision')).toMatch(/^sha256:/)
    await expect(missing.json()).resolves.toEqual({
      success: true,
      missing: true,
      revision: null,
      generation: null,
    })

    const rawMissing = await rawState(client, 'actually-missing')
    expect(rawMissing.status).toBe(204)
    expect((await rawMissing.arrayBuffer()).byteLength).toBe(0)
    expect(rawMissing.headers.get('x-plugin-storage-missing')).toBe('1')
    expect(rawMissing.headers.get('x-plugin-storage-publication-generation'))
      .toBe(GENERATION)
    expect(rawMissing.headers.get('x-plugin-storage-publication-revision')).toMatch(/^sha256:/)
    expect(rawMissing.headers.get('x-plugin-storage-row-revision')).toBeNull()
    expect(rawMissing.headers.get('x-plugin-storage-codec')).toBeNull()
  })

  test('binary and JSON state reads have byte-identical refusal envelopes', async () => {
    const { server, client } = await boot()

    const failedJson = await state(client, 'config')
    const failedRaw = await rawState(client, 'config')
    expect(failedRaw.status).toBe(failedJson.status)
    expect(await failedRaw.text()).toBe(await failedJson.text())

    await server.restart({ POCKETRISU_TEST_PLUGIN_STATE_FAILPOINT: '' })
    const current = await createClient(server.port, server.password)
    for (const headers of [
      { 'file-path': 'not-hex', 'x-plugin-storage-generation': GENERATION },
      {
        'file-path': Buffer.from(valueKey('config')).toString('hex'),
        'x-plugin-storage-generation': `${GENERATION}-stale`,
      },
    ]) {
      const [json, raw] = await Promise.all([
        current.fetch('/api/plugin-storage/state', { headers }),
        current.fetch('/api/plugin-storage/state/raw', { headers }),
      ])
      expect(raw.status).toBe(json.status)
      expect(await raw.text()).toBe(await json.text())
    }
  })

  test('direct SQLite generation and manifest replacement invalidates the parsed cache', async () => {
    const { server } = await boot()
    await server.restart({ POCKETRISU_TEST_PLUGIN_STATE_FAILPOINT: '' })
    const firstClient = await createClient(server.port, server.password)
    expect((await state(firstClient, 'config')).status).toBe(200)

    const nextGeneration = `${GENERATION}-external`
    const nextManifest = { ...manifest, generation: nextGeneration }
    const db = new Database(path.join(server.cwd, 'save', 'risuai.db'))
    try {
      db.transaction(() => {
        db.prepare('UPDATE kv SET value = ? WHERE key = ?').run(
          Buffer.from(JSON.stringify(nextManifest)),
          MANIFEST_KEY,
        )
        db.prepare('UPDATE kv SET value = ? WHERE key = ?').run(
          Buffer.from(encodeRisuSaveLegacy({
            characters: [],
            optimizePluginMemory: true,
            pluginStorageGeneration: nextGeneration,
            pluginCustomStorage: {},
          })),
          DATABASE_KEY,
        )
      })()
    } finally {
      db.close()
    }

    // A fresh session pins the externally published generation. Reusing the
    // prior parsed manifest would make this request conflict instead.
    const nextClient = await createClient(server.port, server.password)
    const response = await state(nextClient, 'config', nextGeneration)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      missing: false,
      revision: expect.stringMatching(/^sha256:/),
    })
  })

  test('bounds session read pins and makes an evicted session re-pin like a fresh session', async () => {
    const statsName = 'plugin-read-session-stats.json'
    const server = await spawnServer({
      seedSave: async saveDir => seed(saveDir),
      env: { POCKETRISU_TEST_PLUGIN_READ_STATE_STATS_PATH: statsName },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const databasePath = Buffer.from(DATABASE_KEY).toString('hex')
    const rowPath = Buffer.from(valueKey('config')).toString('hex')
    const readDatabase = async (sessionId: string) => {
      const response = await client.fetch('/api/read', {
        headers: { 'file-path': databasePath, 'x-session-id': sessionId },
      })
      expect(response.status).toBe(200)
      await response.arrayBuffer()
    }

    await readDatabase('evicted-session')
    for (let index = 0; index < 50; index++) await readDatabase(`churn-${index}`)

    const stats = JSON.parse(await readFile(path.join(server.cwd, statsName), 'utf8')) as any
    expect(stats).toMatchObject({ maxEntries: 50, size: 50, evictions: 1 })
    expect(stats.keys).not.toContain('evicted-session')

    const freshEquivalent = await client.fetch('/api/read', {
      headers: { 'file-path': rowPath, 'x-session-id': 'evicted-session' },
    })
    expect(freshEquivalent.status).toBe(409)
    await expect(freshEquivalent.json()).resolves.toEqual({
      error: 'Read database.bin before reading authoritative plugin storage rows',
    })

    await readDatabase('evicted-session')
    const repinned = await client.fetch('/api/read', {
      headers: { 'file-path': rowPath, 'x-session-id': 'evicted-session' },
    })
    expect(repinned.status).toBe(200)
    expect(Buffer.from(await repinned.arrayBuffer())).toEqual(
      Buffer.from(JSON.stringify({ durable: 'config', entries: ['old'] })),
    )
  })
})
