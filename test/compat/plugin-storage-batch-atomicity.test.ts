import { afterAll, describe, expect, test } from 'vitest'
import Database from 'better-sqlite3'
import path from 'node:path'
import { createClient, type RisuClient } from './helpers/client.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import utilsPkg from '../../server/node/utils.cjs'

const { encodeRisuSaveLegacy, decodeRisuSave } = utilsPkg as {
  encodeRisuSaveLegacy: (value: unknown) => Uint8Array
  decodeRisuSave: (value: Uint8Array) => Promise<any>
}

const servers: ServerHandle[] = []
afterAll(async () => Promise.allSettled(servers.map(server => server.cleanup())))

const keys = ['aa3/body-0', 'aa3/body-1', 'aa3/manifest']
const PLUGIN_STORAGE_BATCH_MAX_BODY_BYTES = 16 * 1024 * 1024
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/
const DATABASE_KEY = 'database/database.bin'
const MANIFEST_KEY = 'plugin-storage/manifest.json'
const RECOVERY_DIRTY_KEY = 'config/plugin-storage-recovery-dirty'
const STORAGE_GENERATION = 'aa3-selected-publication'
const valueKey = (key: string) => `pluginsave/${Buffer.from(key).toString('base64url')}.json`
const ownerKey = (key: string) => `pluginsave-meta/${Buffer.from(key).toString('base64url')}.json`
const activeManifest = {
  version: 1,
  generation: STORAGE_GENERATION,
  valueKeys: keys.map(valueKey),
  metaKeys: keys.map(ownerKey),
}

function seed(saveDir: string): void {
  const db = new Database(path.join(saveDir, 'risuai.db'))
  db.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL)`)
  const insert = db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)')
  for (const [index, key] of keys.entries()) {
    insert.run(valueKey(key), Buffer.from(JSON.stringify({ generation: 'old', key })), 1)
    insert.run(ownerKey(key), Buffer.from(JSON.stringify(index === 1
      ? {
          plugin: 'AA3',
          updatedAt: 1,
          revision: 'not-a-storage-incarnation',
          generation: 'not-a-batch-generation',
        }
      : { plugin: 'AA3', updatedAt: 1 })), 1)
  }
  insert.run(valueKey('aa3/foreign'), Buffer.from('"quarantined-value"'), 1)
  insert.run(ownerKey('aa3/foreign'), Buffer.from(JSON.stringify({
    plugin: 'Foreign Plugin',
    updatedAt: 1,
  })), 1)
  insert.run(MANIFEST_KEY, Buffer.from(JSON.stringify(activeManifest)), 1)
  insert.run(DATABASE_KEY, Buffer.from(encodeRisuSaveLegacy({
    characters: [],
    optimizePluginMemory: true,
    pluginStorageGeneration: STORAGE_GENERATION,
    pluginCustomStorage: {},
  })), 1)
  db.close()
}

async function boot(failpoint = ''): Promise<{ server: ServerHandle; client: RisuClient }> {
  const server = await spawnServer({
    seedSave: async saveDir => seed(saveDir),
    env: failpoint ? { POCKETRISU_TEST_PLUGIN_BATCH_FAILPOINT: failpoint } : undefined,
  })
  servers.push(server)
  return { server, client: await createClient(server.port, server.password) }
}

function envelope(
  operations: unknown[],
  expectedManifest: typeof activeManifest = activeManifest,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    version: 1,
    generation: STORAGE_GENERATION,
    expectedManifest,
    operations,
  }))
}

function batchBody(expectedRevision?: string | null): Uint8Array {
  return envelope(keys.map(key => ({
      operation: 'set',
      key,
      value: Buffer.from(JSON.stringify({ generation: 'new', key })).toString('base64'),
      owner: 'AA3',
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    })))
}

function mixedRollbackBody(): Uint8Array {
  return envelope(keys.map((key, index) => index === 1
      ? { operation: 'remove', key }
      : {
          operation: 'set',
          key,
          value: Buffer.from(JSON.stringify({ generation: 'new', key })).toString('base64'),
          owner: 'AA3',
        }))
}

function countedBatchBody(
  count: number,
  expectedManifest: typeof activeManifest = activeManifest,
): Uint8Array {
  return envelope(Array.from({ length: count }, (_, index) => ({
      operation: 'set',
      key: `aa3/count-${index}`,
      value: Buffer.from(JSON.stringify({ index })).toString('base64'),
      owner: 'AA3',
    })), expectedManifest)
}

async function mutate(client: RisuClient, body = batchBody()): Promise<Response> {
  return client.fetch('/api/plugin-storage/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body,
  })
}

async function readState(client: RisuClient, key: string): Promise<any> {
  const response = await client.fetch('/api/plugin-storage/state', {
    headers: {
      'file-path': Buffer.from(valueKey(key), 'utf-8').toString('hex'),
      'x-plugin-storage-generation': STORAGE_GENERATION,
    },
  })
  expect(response.status).toBe(200)
  return response.json()
}

function readGeneration(cwd: string): 'old' | 'new' | 'torn' {
  const db = new Database(path.join(cwd, 'save', 'risuai.db'), { readonly: true })
  const get = db.prepare('SELECT value FROM kv WHERE key = ?')
  const generations = keys.map(key => {
    const row = get.get(valueKey(key)) as { value: Buffer }
    const owner = get.get(ownerKey(key)) as { value: Buffer } | undefined
    expect(owner, `owner for ${key}`).toBeTruthy()
    return JSON.parse(Buffer.from(row.value).toString()).generation
  })
  db.close()
  return generations.every(value => value === 'old')
    ? 'old'
    : generations.every(value => value === 'new') ? 'new' : 'torn'
}

describe('AA3 atomic plugin storage batch', () => {
  test('commits bodies, manifest, owners and one generation together', async () => {
    const { server, client } = await boot()
    const response = await mutate(client)
    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body).toMatchObject({ outcome: 'committed', operation: 'batch' })
    expect(body.generation).toMatch(UUID_V4_PATTERN)
    expect(body.requestHash).toMatch(/^[0-9a-f]{64}$/)
    expect(body.revisions).toHaveLength(keys.length)
    expect(body.revisions.map((row: any) => row.key)).toEqual(keys)
    expect(body.revisions.every((row: any) => REVISION_PATTERN.test(row.revision))).toBe(true)
    expect(new Set(body.revisions.map((row: any) => row.revision)).size).toBe(keys.length)
    expect(readGeneration(server.cwd)).toBe('new')

    const db = new Database(path.join(server.cwd, 'save', 'risuai.db'), { readonly: true })
    const read = db.prepare('SELECT value FROM kv WHERE key = ?')
    const owners = keys.map(key => JSON.parse(
      Buffer.from((read.get(ownerKey(key)) as { value: Buffer }).value).toString(),
    ))
    db.close()
    expect(new Set(owners.map(owner => owner.generation))).toEqual(new Set([body.generation]))
    expect(owners.every(owner => UUID_V4_PATTERN.test(owner.revision))).toBe(true)
    const sqlite = new Database(path.join(server.cwd, 'save', 'risuai.db'), { readonly: true })
    const readRow = sqlite.prepare('SELECT value FROM kv WHERE key = ?')
    const manifest = JSON.parse(Buffer.from(
      (readRow.get(MANIFEST_KEY) as { value: Buffer }).value,
    ).toString('utf-8'))
    expect(manifest).toEqual(activeManifest)
    const dirty = readRow.get(RECOVERY_DIRTY_KEY)
    const completedSnapshot = dirty ? undefined : sqlite.prepare(
      "SELECT value FROM kv WHERE key LIKE 'database/dbbackup-%' ORDER BY updated_at DESC LIMIT 1",
    ).get() as { value: Buffer } | undefined
    sqlite.close()
    if (dirty) {
      expect(dirty).toBeTruthy()
    } else {
      expect(completedSnapshot).toBeTruthy()
      const snapshot = await decodeRisuSave(new Uint8Array(completedSnapshot!.value))
      expect(snapshot.pluginCustomStorage).toMatchObject({
        [keys[0]]: { generation: 'new', key: keys[0] },
        [keys[1]]: { generation: 'new', key: keys[1] },
        [keys[2]]: { generation: 'new', key: keys[2] },
      })
    }
  })

  test.each([
    'before-transaction',
    ...keys.flatMap((_, index) => [
      `after-value:${index}`,
      `after-owner:${index}`,
      `after-operation:${index}`,
    ]),
    'after-manifest',
    'pre-commit',
  ])('%s failure rolls every set/remove value and owner back', async failpoint => {
    const { server, client } = await boot(failpoint)
    const response = await mutate(client, mixedRollbackBody())
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'not-committed',
      code: 'PLUGIN_STORAGE_BATCH_ROLLED_BACK',
    })
    expect(readGeneration(server.cwd)).toBe('old')
  })

  test('a verification-read failure reports unavailable after the whole batch commits', async () => {
    const { server, client } = await boot('verification-read')
    const response = await mutate(client)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'committed',
      operation: 'batch',
      verification: 'unavailable',
    })
    expect(readGeneration(server.cwd)).toBe('new')
  })

  test('a process restart exposes only the complete old or complete new generation', async () => {
    const { server, client } = await boot('after-owner:1')
    const rolledBack = await mutate(client, mixedRollbackBody())
    expect(rolledBack.status).toBe(500)
    expect(readGeneration(server.cwd)).toBe('old')

    await server.restart({ POCKETRISU_TEST_PLUGIN_BATCH_FAILPOINT: '' })
    expect(readGeneration(server.cwd)).toBe('old')
    const restartedClient = await createClient(server.port, server.password)
    const committed = await mutate(restartedClient)
    expect(committed.status).toBe(200)
    expect(readGeneration(server.cwd)).toBe('new')

    await server.restart({ POCKETRISU_TEST_PLUGIN_BATCH_FAILPOINT: '' })
    expect(readGeneration(server.cwd)).toBe('new')
    const state = await readState(
      await createClient(server.port, server.password),
      keys[0],
    )
    expect(state).toMatchObject({ missing: false })
    expect(state.revision).toMatch(REVISION_PATTERN)
    expect(state.generation).toMatch(UUID_V4_PATTERN)
  })

  test('stale CAS rejects before any write and reports current revisions', async () => {
    const { server, client } = await boot()
    const response = await mutate(client, batchBody(`sha256:${'0'.repeat(64)}`))
    expect(response.status).toBe(409)
    const body = await response.json() as any
    expect(body).toMatchObject({
      outcome: 'not-committed',
      code: 'PLUGIN_STORAGE_REVISION_CONFLICT',
    })
    expect(body.conflicts).toHaveLength(keys.length)
    expect(readGeneration(server.cwd)).toBe('old')
  })

  test('a stale BR2 manifest CAS rejects before any row write', async () => {
    const { server, client } = await boot()
    const response = await mutate(client, envelope([{
      operation: 'set',
      key: keys[0],
      value: Buffer.from('"must-not-commit"').toString('base64'),
      owner: 'AA3',
    }], {
      ...activeManifest,
      valueKeys: activeManifest.valueKeys.slice(1),
    }))
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'not-committed',
      code: 'PLUGIN_STORAGE_GENERATION_CONFLICT',
      retryable: true,
    })
    expect(readGeneration(server.cwd)).toBe('old')
  })

  test('versioned reads quarantine physical rows outside the exact manifest', async () => {
    const { client } = await boot()
    await expect(readState(client, 'aa3/foreign')).resolves.toEqual({
      success: true,
      missing: true,
      revision: null,
      generation: null,
    })
  })

  test('a missing-key CAS has one winner under concurrent batches', async () => {
    const { client } = await boot()
    const make = (generation: string) => envelope([{
        operation: 'set', key: 'aa3/new', owner: 'AA3', expectedRevision: null,
        value: Buffer.from(JSON.stringify({ generation })).toString('base64'),
      }])
    const responses = await Promise.all([
      mutate(client, make('first')),
      mutate(client, make('second')),
    ])
    expect(responses.map(response => response.status).sort()).toEqual([200, 409])
  })

  test('legacy and malformed owner incarnations have stable fallback revisions', async () => {
    const { client } = await boot()
    const legacyFirst = await readState(client, keys[0])
    const legacySecond = await readState(client, keys[0])
    const malformedFirst = await readState(client, keys[1])
    const malformedSecond = await readState(client, keys[1])

    expect(legacyFirst).toMatchObject({ missing: false, generation: null })
    expect(malformedFirst).toMatchObject({ missing: false, generation: null })
    expect(legacyFirst.revision).toMatch(REVISION_PATTERN)
    expect(malformedFirst.revision).toMatch(REVISION_PATTERN)
    expect(legacySecond.revision).toBe(legacyFirst.revision)
    expect(malformedSecond.revision).toBe(malformedFirst.revision)

    const response = await mutate(client, envelope([{
        operation: 'set',
        key: keys[1],
        value: Buffer.from(JSON.stringify({ generation: 'replaced' })).toString('base64'),
        owner: 'AA3',
        expectedRevision: malformedFirst.revision,
      }]))
    expect(response.status).toBe(200)
  })

  test('rewriting identical value bytes creates a new incarnation and revision', async () => {
    const { client } = await boot()
    const firstResponse = await mutate(client)
    const first = await firstResponse.json() as any
    const secondResponse = await mutate(client)
    const second = await secondResponse.json() as any

    expect(firstResponse.status).toBe(200)
    expect(secondResponse.status).toBe(200)
    expect(first.generation).toMatch(UUID_V4_PATTERN)
    expect(second.generation).toMatch(UUID_V4_PATTERN)
    expect(second.generation).not.toBe(first.generation)
    expect(second.revisions.map((row: any) => row.revision))
      .not.toEqual(first.revisions.map((row: any) => row.revision))
  })

  test('enforces the 0/1/128/129 operation boundaries', async () => {
    const { client } = await boot()
    expect((await mutate(client, new Uint8Array())).status).toBe(400)
    expect((await mutate(client, countedBatchBody(0))).status).toBe(400)
    expect((await mutate(client, countedBatchBody(1))).status).toBe(200)
    expect((await mutate(client, countedBatchBody(128, {
      ...activeManifest,
      valueKeys: [...activeManifest.valueKeys, valueKey('aa3/count-0')],
      metaKeys: [...activeManifest.metaKeys, ownerKey('aa3/count-0')],
    }))).status).toBe(200)
    expect((await mutate(client, countedBatchBody(129))).status).toBe(400)
  }, 20_000)

  test('accepts exactly 16 MiB and rejects the next byte', async () => {
    const { client } = await boot()
    const minimalBody = countedBatchBody(1)
    const exact = Buffer.alloc(PLUGIN_STORAGE_BATCH_MAX_BODY_BYTES, 0x20)
    exact.set(minimalBody)
    const oversized = Buffer.alloc(PLUGIN_STORAGE_BATCH_MAX_BODY_BYTES + 1, 0x20)
    oversized.set(minimalBody)

    expect((await mutate(client, exact)).status).toBe(200)
    expect((await mutate(client, oversized)).status).toBe(413)
  }, 30_000)

  test('acknowledgement loss cannot expose a durable prefix', async () => {
    const { server, client } = await boot('acknowledgement-loss')
    await expect(mutate(client)).rejects.toThrow()
    expect(readGeneration(server.cwd)).toBe('new')
  })
})
