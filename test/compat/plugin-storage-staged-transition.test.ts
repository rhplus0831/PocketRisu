import { afterAll, describe, expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import path from 'node:path'
import { createClient } from './helpers/client.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createSeedBackup } from './helpers/seed.js'
import { decodeRisuDat } from './helpers/normalize.js'

const servers: ServerHandle[] = []
const DATABASE_KEY = 'database/database.bin'
const MANIFEST_KEY = 'plugin-storage/manifest.json'

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

function encodedKey(prefix: 'pluginsave/' | 'pluginsave-meta/', rawKey: string): string {
  return `${prefix}${Buffer.from(rawKey, 'utf8').toString('base64url')}.json`
}

function filePathHeader(key: string): string {
  return Buffer.from(key, 'utf8').toString('hex')
}

describe('staged plugin storage transitions (real server)', () => {
  test('keeps uploads invisible, atomically externalizes, then server-streams internalization', async () => {
    const server = await spawnServer({ env: { POCKETRISU_CHUNK_THRESHOLD: '1024' } })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const rawKey = '한글/row'
    const valueKey = encodedKey('pluginsave/', rawKey)
    const inlineValue = { payload: 'x'.repeat(4_000) }
    const value = Buffer.from(JSON.stringify(inlineValue), 'utf8')
    expect((await client.importBackup(createSeedBackup({
      databaseFields: {
        optimizePluginMemory: false,
        pluginCustomStorage: { [rawKey]: inlineValue },
      },
    }))).ok).toBe(true)
    const externalId = randomUUID()
    const externalGeneration = randomUUID()
    const externalPlan = {
      version: 2,
      transitionId: externalId,
      source: { optimized: false, generation: null, manifest: null },
      targetOptimized: true,
      targetGeneration: externalGeneration,
      rows: [{ storageKey: valueKey, size: value.length }],
    }
    const begin = await client.fetch('/api/plugin-storage/transition/stage/begin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(externalPlan),
    })
    expect(begin.status).toBe(200)
    expect((await begin.json() as any).state).toBe('uploading')

    const upload = await client.fetch('/api/plugin-storage/transition/stage/upload', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-plugin-storage-transition': externalId,
        'x-plugin-storage-key': valueKey,
      },
      body: new Uint8Array(value),
    })
    expect(upload.status).toBe(200)
    expect((await upload.json() as any).state).toBe('ready')

    const sqlite = new Database(path.join(server.cwd, 'save', 'risuai.db'), { readonly: true })
    expect(sqlite.prepare('SELECT 1 FROM kv WHERE key = ?').get(valueKey)).toBeUndefined()
    expect(sqlite.prepare('SELECT 1 FROM kv WHERE key = ?').get(MANIFEST_KEY)).toBeUndefined()
    sqlite.close()
    const inventoryBefore = await client.fetch('/api/storage/list-sizes', {
      headers: { 'key-prefix': 'pluginsave/' },
    })
    expect((await inventoryBefore.json() as any).content).toEqual([])

    const finalize = await client.fetch('/api/plugin-storage/transition/stage/finalize', {
      method: 'POST',
      headers: { 'x-plugin-storage-transition': externalId },
    })
    expect(finalize.status).toBe(200)
    expect((await finalize.json() as any).state).toBe('committed')

    const status = await client.fetch('/api/plugin-storage/transition/stage/status', {
      headers: { 'x-plugin-storage-transition': externalId },
    })
    expect((await status.json() as any).state).toBe('committed')
    const valueRead = await client.fetch('/api/read', {
      headers: {
        'file-path': filePathHeader(valueKey),
        'x-plugin-storage-generation': externalGeneration,
      },
    })
    expect(Buffer.from(await valueRead.arrayBuffer())).toEqual(value)

    const internalId = randomUUID()
    const internalGeneration = randomUUID()
    const internalBegin = await client.fetch('/api/plugin-storage/transition/stage/begin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        transitionId: internalId,
        source: {
          optimized: true,
          generation: externalGeneration,
          manifest: {
            version: 1,
            generation: externalGeneration,
            valueKeys: [valueKey],
            metaKeys: [],
          },
        },
        targetOptimized: false,
        targetGeneration: internalGeneration,
        rows: [],
      }),
    })
    expect(internalBegin.status).toBe(200)
    const internalState = await internalBegin.json() as any
    expect(internalState.state).toBe('ready')
    expect(internalState.rows).toHaveLength(1)
    const stagedRead = await client.fetch('/api/plugin-storage/transition/stage/row', {
      headers: {
        'x-plugin-storage-transition': internalId,
        'x-plugin-storage-key': valueKey,
      },
    })
    expect(Buffer.from(await stagedRead.arrayBuffer())).toEqual(value)

    const internalFinalize = await client.fetch('/api/plugin-storage/transition/stage/finalize', {
      method: 'POST',
      headers: { 'x-plugin-storage-transition': internalId },
    })
    expect(internalFinalize.status).toBe(200)
    expect((await internalFinalize.json() as any).state).toBe('committed')

    const databaseResponse = await client.fetch('/api/read', {
      headers: { 'file-path': filePathHeader(DATABASE_KEY) },
    })
    const database = decodeRisuDat(Buffer.from(await databaseResponse.arrayBuffer()))
    expect(database.optimizePluginMemory).toBe(false)
    expect(database.pluginStorageGeneration).toBe(internalGeneration)
    expect(database.pluginCustomStorage[rawKey]).toEqual({ payload: 'x'.repeat(4_000) })

    const finalSqlite = new Database(path.join(server.cwd, 'save', 'risuai.db'), { readonly: true })
    expect(finalSqlite.prepare('SELECT 1 FROM kv WHERE key = ?').get(valueKey)).toBeUndefined()
    expect(finalSqlite.prepare('SELECT 1 FROM kv WHERE key = ?').get(MANIFEST_KEY)).toBeUndefined()
    expect(finalSqlite.prepare('SELECT 1 FROM kv WHERE key = ?')
      .get('config/plugin-storage-recovery-dirty')).toBeDefined()
    finalSqlite.close()
  }, 30_000)

  test('aborts a partial stage idempotently without changing publication', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const transitionId = randomUUID()
    const valueKey = encodedKey('pluginsave/', 'cancelled')
    const value = Buffer.from('"not-live"')
    expect((await client.importBackup(createSeedBackup({
      databaseFields: {
        optimizePluginMemory: false,
        pluginCustomStorage: { cancelled: 'not-live' },
      },
    }))).ok).toBe(true)
    const begin = await client.fetch('/api/plugin-storage/transition/stage/begin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        transitionId,
        source: { optimized: false, generation: null, manifest: null },
        targetOptimized: true,
        targetGeneration: randomUUID(),
        rows: [{ storageKey: valueKey, size: value.length }],
      }),
    })
    expect(begin.status).toBe(200)
    const upload = await client.fetch('/api/plugin-storage/transition/stage/upload', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-plugin-storage-transition': transitionId,
        'x-plugin-storage-key': valueKey,
      },
      body: new Uint8Array(value),
    })
    expect(upload.status).toBe(200)
    for (let attempt = 0; attempt < 2; attempt++) {
      const abort = await client.fetch('/api/plugin-storage/transition/stage/abort', {
        method: 'POST',
        headers: { 'x-plugin-storage-transition': transitionId },
      })
      expect(abort.status).toBe(200)
      expect((await abort.json() as any).state).toBe('aborted')
    }
    const finalize = await client.fetch('/api/plugin-storage/transition/stage/finalize', {
      method: 'POST',
      headers: { 'x-plugin-storage-transition': transitionId },
    })
    expect(finalize.status).toBe(409)
    const sqlite = new Database(path.join(server.cwd, 'save', 'risuai.db'), { readonly: true })
    expect(sqlite.prepare('SELECT 1 FROM kv WHERE key = ?').get(valueKey)).toBeUndefined()
    expect(sqlite.prepare('SELECT 1 FROM kv WHERE key = ?').get(MANIFEST_KEY)).toBeUndefined()
    sqlite.close()
  }, 30_000)

  test('rolls back finalize failpoints and resolves lost acknowledgement after restart', async () => {
    const server = await spawnServer({
      env: { POCKETRISU_PLUGIN_STORAGE_TEST_FAILPOINTS: '1' },
    })
    servers.push(server)
    let client = await createClient(server.port, server.password)
    const transitionId = randomUUID()
    const targetGeneration = randomUUID()
    const valueKey = encodedKey('pluginsave/', 'atomic')
    const value = Buffer.from('true')
    expect((await client.importBackup(createSeedBackup({
      databaseFields: {
        optimizePluginMemory: false,
        pluginCustomStorage: { atomic: true },
      },
    }))).ok).toBe(true)
    const beginResponse = await client.fetch('/api/plugin-storage/transition/stage/begin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        transitionId,
        source: { optimized: false, generation: null, manifest: null },
        targetOptimized: true,
        targetGeneration,
        rows: [{ storageKey: valueKey, size: value.length }],
      }),
    })
    const beginBody = await beginResponse.text()
    expect(beginResponse.status, beginBody).toBe(200)
    expect((await client.fetch('/api/plugin-storage/transition/stage/upload', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-plugin-storage-transition': transitionId,
        'x-plugin-storage-key': valueKey,
      },
      body: new Uint8Array(value),
    })).status).toBe(200)

    const failed = await client.fetch('/api/plugin-storage/transition/stage/finalize', {
      method: 'POST',
      headers: {
        'x-plugin-storage-transition': transitionId,
        'x-plugin-storage-failpoint': 'after-manifest',
      },
    })
    expect(failed.status).toBe(500)
    let sqlite = new Database(path.join(server.cwd, 'save', 'risuai.db'), { readonly: true })
    expect(sqlite.prepare('SELECT 1 FROM kv WHERE key = ?').get(valueKey)).toBeUndefined()
    expect(sqlite.prepare('SELECT 1 FROM kv WHERE key = ?').get(MANIFEST_KEY)).toBeUndefined()
    sqlite.close()

    await expect(client.fetch('/api/plugin-storage/transition/stage/finalize', {
      method: 'POST',
      headers: {
        'x-plugin-storage-transition': transitionId,
        'x-plugin-storage-failpoint': 'acknowledgement-loss',
      },
    })).rejects.toThrow()
    await server.restart({ POCKETRISU_PLUGIN_STORAGE_TEST_FAILPOINTS: '1' })
    client = await createClient(server.port, server.password)
    const status = await client.fetch('/api/plugin-storage/transition/stage/status', {
      headers: { 'x-plugin-storage-transition': transitionId },
    })
    expect(status.status).toBe(200)
    expect((await status.json() as any).state).toBe('committed')
    sqlite = new Database(path.join(server.cwd, 'save', 'risuai.db'), { readonly: true })
    expect(sqlite.prepare('SELECT 1 FROM kv WHERE key = ?').get(valueKey)).toBeDefined()
    expect(sqlite.prepare('SELECT 1 FROM kv WHERE key = ?').get(MANIFEST_KEY)).toBeDefined()
    const dirty = sqlite.prepare('SELECT 1 FROM kv WHERE key = ?')
      .get('config/plugin-storage-recovery-dirty')
    const recoverySnapshot = sqlite.prepare(
      "SELECT 1 FROM kv WHERE key LIKE 'database/dbbackup-%' LIMIT 1",
    ).get()
    expect(Boolean(dirty || recoverySnapshot)).toBe(true)
    sqlite.close()
  }, 30_000)
})
