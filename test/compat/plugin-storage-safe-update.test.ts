import { afterAll, describe, expect, test } from 'vitest'
import Database from 'better-sqlite3'
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
  insert.run(ownerKey('nullable'), Buffer.from(JSON.stringify({ plugin: 'Existing', updatedAt: 1 })), 1)
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
    const nullableBody = await nullable.json() as any
    expect(nullableBody).toMatchObject({ missing: false })
    expect(Buffer.from(nullableBody.value, 'base64').toString()).toBe('null')
    expect(nullableBody.revision).toMatch(/^sha256:/)

    const missing = await state(client, 'actually-missing')
    expect(missing.status).toBe(200)
    await expect(missing.json()).resolves.toEqual({
      success: true,
      missing: true,
      revision: null,
      generation: null,
    })
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
})
