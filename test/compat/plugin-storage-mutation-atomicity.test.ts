import { afterAll, describe, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import {
  classifyPluginStorageMutationAcknowledgement,
  pluginStorageTransportOutcomeUnknown,
  publishPluginStorageMutationCache,
  type PluginStorageMutationResult,
} from '../../src/ts/storage/pluginStorageMutation.js'
import utilsPkg from '../../server/node/utils.cjs'
import pluginSaveKeysPkg from '../../server/node/plugin-storage/pluginSaveKeys.cjs'

const { encodeRisuSaveLegacy } = utilsPkg as {
  encodeRisuSaveLegacy: (value: unknown) => Uint8Array
}
const { encodePluginSaveStorageKey } = pluginSaveKeysPkg as {
  encodePluginSaveStorageKey: (rawKey: string, prefix: string) => string
}

const RAW_KEY = 'aa1/atomic-key'
const VALUE_KEY = `pluginsave/${Buffer.from(RAW_KEY, 'utf-8').toString('base64url')}.json`
const OWNER_KEY = `pluginsave-meta/${Buffer.from(RAW_KEY, 'utf-8').toString('base64url')}.json`
const OLD_VALUE = Buffer.from(JSON.stringify({ generation: 'old' }), 'utf-8')
const OLD_OWNER = Buffer.from(JSON.stringify({ plugin: 'Old Plugin', updatedAt: 1 }), 'utf-8')
const STORAGE_GENERATION = 'pm4-remove-parity-generation'
const MANIFEST_KEY = 'plugin-storage/manifest.json'
const DATABASE_KEY = 'database/database.bin'
const LONG_RAW_KEY = 'v'.repeat(756)
const LONG_VALUE_KEY = `pluginsave/${Buffer.from(LONG_RAW_KEY, 'utf-8').toString('base64url')}.json`
const LONG_OWNER_KEY = `pluginsave-meta/${Buffer.from(LONG_RAW_KEY, 'utf-8').toString('base64url')}.json`
const MALFORMED_RAW_KEY = '\uD800'
const MALFORMED_VALUE_KEY = encodePluginSaveStorageKey(MALFORMED_RAW_KEY, 'pluginsave/')
const MALFORMED_OWNER_KEY = encodePluginSaveStorageKey(MALFORMED_RAW_KEY, 'pluginsave-meta/')
const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

function seedRows(saveDir: string, includeValue = true, includeOwner = true): void {
  const database = new Database(path.join(saveDir, 'risuai.db'))
  try {
    database.exec(`
      CREATE TABLE kv (
        key TEXT PRIMARY KEY,
        value BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    const insert = database.prepare(
      'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
    )
    if (includeValue) insert.run(VALUE_KEY, OLD_VALUE, Date.now())
    if (includeOwner) insert.run(OWNER_KEY, OLD_OWNER, Date.now())
  } finally {
    database.close()
  }
}

function seedActivePublication(saveDir: string): void {
  const database = new Database(path.join(saveDir, 'risuai.db'))
  try {
    database.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL)`)
    const insert = database.prepare(
      'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
    )
    insert.run(VALUE_KEY, OLD_VALUE, 1)
    insert.run(OWNER_KEY, OLD_OWNER, 1)
    insert.run(MANIFEST_KEY, Buffer.from(JSON.stringify({
      version: 1,
      generation: STORAGE_GENERATION,
      valueKeys: [VALUE_KEY],
      metaKeys: [OWNER_KEY],
    })), 1)
    insert.run(DATABASE_KEY, Buffer.from(encodeRisuSaveLegacy({
      characters: [],
      optimizePluginMemory: true,
      pluginStorageGeneration: STORAGE_GENERATION,
      pluginCustomStorage: {},
    })), 1)
  } finally {
    database.close()
  }
}

function seedMalformedKeyPublication(saveDir: string): void {
  const database = new Database(path.join(saveDir, 'risuai.db'))
  try {
    database.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL)`)
    const insert = database.prepare(
      'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
    )
    insert.run(MALFORMED_VALUE_KEY, OLD_VALUE, 1)
    insert.run(MALFORMED_OWNER_KEY, OLD_OWNER, 1)
    insert.run(MANIFEST_KEY, Buffer.from(JSON.stringify({
      version: 2,
      generation: STORAGE_GENERATION,
      valueKeys: [MALFORMED_VALUE_KEY],
      metaKeys: [MALFORMED_OWNER_KEY],
    })), 1)
    insert.run(DATABASE_KEY, Buffer.from(encodeRisuSaveLegacy({
      characters: [],
      optimizePluginMemory: true,
      pluginStorageGeneration: STORAGE_GENERATION,
      pluginCustomStorage: {},
    })), 1)
  } finally {
    database.close()
  }
}

function orderedValueKey(rawKey: string): string {
  return `pluginsave/${Buffer.from(rawKey, 'utf-8').toString('base64url')}.json`
}

function seedOrderedLegacyPublication(saveDir: string): void {
  const orderedKeys = ['z', 'a'].map(orderedValueKey)
  const database = new Database(path.join(saveDir, 'risuai.db'))
  try {
    database.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL)`)
    const insert = database.prepare(
      'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
    )
    for (const [index, key] of orderedKeys.entries()) {
      insert.run(key, Buffer.from(JSON.stringify(index)), 1)
    }
    insert.run(MANIFEST_KEY, Buffer.from(JSON.stringify({
      version: 1,
      generation: STORAGE_GENERATION,
      valueKeys: orderedKeys,
      metaKeys: [],
    })), 1)
    insert.run(DATABASE_KEY, Buffer.from(encodeRisuSaveLegacy({
      characters: [],
      optimizePluginMemory: true,
      pluginStorageGeneration: STORAGE_GENERATION,
      pluginCustomStorage: {},
    })), 1)
  } finally {
    database.close()
  }
}

function readManifest(cwd: string): any {
  const database = new Database(path.join(cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    const row = database.prepare('SELECT value FROM kv WHERE key = ?').get(MANIFEST_KEY) as {
      value: Buffer
    }
    return JSON.parse(Buffer.from(row.value).toString('utf-8'))
  } finally {
    database.close()
  }
}

function readManifestBytes(cwd: string): Buffer {
  const database = new Database(path.join(cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    const row = database.prepare('SELECT value FROM kv WHERE key = ?').get(MANIFEST_KEY) as {
      value: Buffer
    }
    return Buffer.from(row.value)
  } finally {
    database.close()
  }
}

async function boot(
  pluginFailpoint?:
    | 'owner-write'
    | 'owner-remove'
    | 'pre-commit'
    | 'verification-read'
    | 'acknowledgement-loss',
  kvFailpoint?: string,
  seed: (saveDir: string) => void = seedRows,
  facetFailpoint = '',
): Promise<{ server: ServerHandle; client: RisuClient }> {
  const server = await spawnServer({
    env: {
      ...(pluginFailpoint
        ? { POCKETRISU_TEST_PLUGIN_MUTATION_FAILPOINT: pluginFailpoint }
        : {}),
      ...(kvFailpoint ? { POCKETRISU_TEST_FAILPOINT: kvFailpoint } : {}),
      ...(facetFailpoint
        ? { POCKETRISU_TEST_PLUGIN_VIEWER_FACET_FAILPOINT: facetFailpoint }
        : {}),
    },
    seedSave: seed,
  })
  servers.push(server)
  return { server, client: await createClient(server.port, server.password) }
}

function readRows(cwd: string): { value: Buffer | null; owner: Buffer | null } {
  const database = new Database(path.join(cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    const read = database.prepare('SELECT value FROM kv WHERE key = ?')
    const value = read.get(VALUE_KEY) as { value: Buffer } | undefined
    const owner = read.get(OWNER_KEY) as { value: Buffer } | undefined
    return {
      value: value ? Buffer.from(value.value) : null,
      owner: owner ? Buffer.from(owner.value) : null,
    }
  } finally {
    database.close()
  }
}

function readFacets(cwd: string): { displaySize: number | null; owner: string | null } {
  const database = new Database(path.join(cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    const display = database.prepare(
      'SELECT display_size FROM plugin_storage_viewer_value_facets WHERE storage_key = ?',
    ).get(VALUE_KEY) as { display_size: number } | undefined
    const owner = database.prepare(
      'SELECT owner FROM plugin_storage_owners WHERE storage_key = ?',
    ).get(OWNER_KEY) as { owner: string } | undefined
    return {
      displaySize: display?.display_size ?? null,
      owner: owner?.owner ?? null,
    }
  } finally {
    database.close()
  }
}

async function mutate(
  client: RisuClient,
  operation: 'set' | 'remove',
  value: unknown = { generation: 'new' },
  owner = 'New Plugin',
): Promise<Response> {
  return client.fetch('/api/plugin-storage/mutate', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': Buffer.from(VALUE_KEY, 'utf-8').toString('hex'),
      'x-plugin-storage-operation': operation,
      'x-plugin-storage-owner': Buffer.from(owner, 'utf-8').toString('base64url'),
    },
    body: operation === 'set'
      ? new Uint8Array(Buffer.from(JSON.stringify(value), 'utf-8'))
      : new Uint8Array(),
  })
}

async function mutateRaw(
  client: RisuClient,
  body: Uint8Array,
  owner = 'New Plugin',
): Promise<Response> {
  return client.fetch('/api/plugin-storage/mutate', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': Buffer.from(VALUE_KEY, 'utf-8').toString('hex'),
      'x-plugin-storage-operation': 'set',
      'x-plugin-storage-owner': Buffer.from(owner, 'utf-8').toString('base64url'),
    },
    body,
  })
}

async function mutateStreamedRaw(
  client: RisuClient,
  body: Uint8Array,
  owner = 'New Plugin',
): Promise<Response> {
  return client.fetch('/api/plugin-storage/mutate', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': Buffer.from(VALUE_KEY, 'utf-8').toString('hex'),
      'x-plugin-storage-operation': 'set',
      'x-plugin-storage-owner': Buffer.from(owner, 'utf-8').toString('base64url'),
      'x-plugin-storage-stream': '1',
    },
    body,
  })
}

async function restorePair(
  client: RisuClient,
  value: Uint8Array,
  ownerRecord?: Uint8Array,
): Promise<Response> {
  return client.fetch('/api/plugin-storage/mutate', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': Buffer.from(VALUE_KEY, 'utf-8').toString('hex'),
      'x-plugin-storage-operation': 'set',
      'x-plugin-storage-owner': '',
      'x-plugin-storage-owner-policy': ownerRecord ? 'record' : 'preserve',
      ...(ownerRecord
        ? { 'x-plugin-storage-owner-record': Buffer.from(ownerRecord).toString('base64url') }
        : {}),
    },
    body: value,
  })
}

async function mutateWithClientOutcome(
  client: RisuClient,
  operation: 'set' | 'remove',
  value: unknown = { generation: 'new' },
  owner = 'New Plugin',
): Promise<PluginStorageMutationResult> {
  try {
    const response = await mutate(client, operation, value, owner)
    let body: unknown = null
    try {
      body = await response.json()
    } catch {}
    return classifyPluginStorageMutationAcknowledgement(
      response.status,
      body,
      operation,
    )
  } catch (error) {
    return pluginStorageTransportOutcomeUnknown(operation, error)
  }
}

describe('atomic optimized plugin value and owner acknowledgement', () => {
  test('the streamed single-row route validates the spool without materializing it', () => {
    const source = readFileSync(
      new URL('../../server/node/server.cjs', import.meta.url),
      'utf-8',
    )
    const routeStart = source.indexOf("app.post('/api/plugin-storage/mutate'")
    const routeEnd = source.indexOf('// ─── /api/logs', routeStart)
    expect(routeStart).toBeGreaterThanOrEqual(0)
    expect(routeEnd).toBeGreaterThan(routeStart)

    const route = source.slice(routeStart, routeEnd)
    expect(route).toMatch(
      /await validateJsonSource\(\{\s*filePath: valueFilePath,\s*size: valueSize,\s*\}/,
    )
    expect(route).not.toMatch(/readFileSync\(\s*valueFilePath\s*\)/)
    expect(route).not.toMatch(
      /validatePluginStorageRow\(\s*valueKey,\s*readFileSync\(\s*valueFilePath\s*\)\s*\)/,
    )

    const committedStart = route.indexOf('pluginStorageManifestCache.publishPrepared')
    expect(committedStart).toBeGreaterThanOrEqual(0)
    const afterCommit = route.slice(committedStart)
    expect(afterCommit).not.toMatch(/kvGet\(\s*valueKey\s*\)/)
    expect(afterCommit).not.toMatch(/kvGet\(\s*ownerKey\s*\)/)
    expect(afterCommit).not.toMatch(/kvSize\(\s*valueKey\s*\)/)
    expect(afterCommit).not.toMatch(/readPluginStorageManifest\(/)
  })

  test('a buffered generation-bound set keeps the exact acknowledgement and publication bytes', async () => {
    const { server, client } = await boot(undefined, undefined, seedActivePublication)
    const value = Buffer.from('{"generation":"bounded-cache","order":[3,1,2]}', 'utf-8')
    const previousManifestRevision = `sha256:${createHash('sha256')
      .update(readManifestBytes(server.cwd)).digest('hex')}`
    const response = await client.fetch('/api/plugin-storage/mutate', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'file-path': Buffer.from(VALUE_KEY, 'utf-8').toString('hex'),
        'x-plugin-storage-operation': 'set',
        'x-plugin-storage-owner': Buffer.from('New Plugin').toString('base64url'),
        'x-plugin-storage-generation': STORAGE_GENERATION,
      },
      body: value,
    })

    expect(response.status).toBe(200)
    const manifestRevision = `sha256:${createHash('sha256')
      .update(readManifestBytes(server.cwd)).digest('hex')}`
    await expect(response.json()).resolves.toEqual({
      success: true,
      outcome: 'committed',
      operation: 'set',
      verification: 'verified',
      hash: createHash('sha256').update(value).digest('hex'),
      manifestRevision,
      previousManifestRevision,
    })
    expect(readRows(server.cwd).value).toEqual(value)
    expect(readFacets(server.cwd)).toEqual({
      displaySize: Buffer.byteLength(JSON.stringify(JSON.parse(value.toString('utf-8')))),
      owner: 'New Plugin',
    })
    expect(readManifest(server.cwd)).toEqual({
      version: 2,
      generation: STORAGE_GENERATION,
      valueKeys: [VALUE_KEY],
      metaKeys: [OWNER_KEY],
    })
  })

  test('a generation conflict echoes the current valid optimized publication', async () => {
    const { server, client } = await boot(undefined, undefined, seedActivePublication)
    const response = await client.fetch('/api/plugin-storage/mutate', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'file-path': Buffer.from(VALUE_KEY, 'utf-8').toString('hex'),
        'x-plugin-storage-operation': 'remove',
        'x-plugin-storage-generation': `${STORAGE_GENERATION}-stale`,
      },
      body: new Uint8Array(),
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'not-committed',
      code: 'PLUGIN_STORAGE_GENERATION_CONFLICT',
      currentGeneration: STORAGE_GENERATION,
      currentManifestRevision: `sha256:${createHash('sha256')
        .update(readManifestBytes(server.cwd)).digest('hex')}`,
    })
  })

  test('a valid streamed single-row set commits the original spool bytes', async () => {
    const { server, client } = await boot()
    const value = Buffer.from(
      '{"generation":"streamed","escapedLoneSurrogate":"\\ud800","nested":[1,2]}',
      'utf-8',
    )

    const response = await mutateStreamedRaw(client, value)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      success: true,
      outcome: 'committed',
      operation: 'set',
      verification: 'verified',
      hash: createHash('sha256').update(value).digest('hex'),
    })
    const rows = readRows(server.cwd)
    expect(rows.value).toEqual(value)
    expect(JSON.parse(rows.owner!.toString('utf-8'))).toMatchObject({
      plugin: 'New Plugin',
      updatedAt: expect.any(Number),
    })
    expect(readdirSync(server.spoolDir).filter(
      name => name.startsWith('.plugin-value-'),
    )).toEqual([])
  })

  test('a streamed plugin set recovers after its custom spool root is repaired', async () => {
    const spoolPath = path.join('save', 'repairable-plugin-spool')
    const server = await spawnServer({
      env: { POCKETRISU_SPOOL_DIR: spoolPath },
      seedSave: saveDir => {
        seedRows(saveDir)
        writeFileSync(path.join(saveDir, 'repairable-plugin-spool'), 'blocked')
      },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const value = Buffer.from('{"recovered":true}', 'utf8')

    const unavailable = await mutateStreamedRaw(client, value)
    expect(unavailable.status).toBe(503)
    await expect(unavailable.json()).resolves.toMatchObject({
      code: 'PLUGIN_STORAGE_SPOOL_UNAVAILABLE',
      retryable: true,
    })

    const absoluteRoot = path.join(server.cwd, spoolPath)
    rmSync(absoluteRoot)
    mkdirSync(absoluteRoot)
    const recovered = await mutateStreamedRaw(client, value)
    expect(recovered.status).toBe(200)
    expect(readRows(server.cwd).value).toEqual(value)
    expect(readdirSync(server.spoolDir).filter(
      name => name.startsWith('.plugin-value-'),
    )).toEqual([])
  })

  test.each([
    ['malformed JSON', Buffer.from('{"unfinished":', 'utf-8')],
    ['ill-formed UTF-8', Buffer.from([0x22, 0xed, 0xa0, 0x80, 0x22])],
  ])('a streamed single-row set refuses %s with the exact prior response', async (_name, value) => {
    const { server, client } = await boot()

    const response = await mutateStreamedRaw(client, value)

    expect(response.status).toBe(400)
    expect(await response.text()).toBe(JSON.stringify({
      success: false,
      outcome: 'not-committed',
      operation: 'set',
      error: 'Invalid plugin storage JSON row',
      code: 'INVALID_PLUGIN_STORAGE_ROW',
      encodedKey: VALUE_KEY,
      retryable: false,
    }))
    expect(readRows(server.cwd)).toEqual({ value: OLD_VALUE, owner: OLD_OWNER })
    expect(readdirSync(server.spoolDir).filter(
      name => name.startsWith('.plugin-value-'),
    )).toEqual([])
  })

  test('mutates a tagged historical malformed key without colliding with valid Unicode', async () => {
    const { server, client } = await boot(undefined, undefined, seedMalformedKeyPublication)
    expect(MALFORMED_VALUE_KEY).not.toBe(encodePluginSaveStorageKey('�', 'pluginsave/'))

    const nextValue = { generation: 'malformed-key-update' }
    const response = await client.fetch('/api/plugin-storage/mutate', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'file-path': Buffer.from(MALFORMED_VALUE_KEY, 'utf-8').toString('hex'),
        'x-plugin-storage-operation': 'set',
        'x-plugin-storage-owner': Buffer.from('Legacy Recovery Plugin').toString('base64url'),
        'x-plugin-storage-generation': STORAGE_GENERATION,
      },
      body: Buffer.from(JSON.stringify(nextValue)),
    })

    expect(response.status, await response.clone().text()).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'committed',
      operation: 'set',
    })
    const sqlite = new Database(path.join(server.cwd, 'save', 'risuai.db'), { readonly: true })
    try {
      const read = sqlite.prepare('SELECT value FROM kv WHERE key = ?')
      const value = read.get(MALFORMED_VALUE_KEY) as { value: Buffer }
      const owner = read.get(MALFORMED_OWNER_KEY) as { value: Buffer }
      expect(JSON.parse(Buffer.from(value.value).toString('utf-8'))).toEqual(nextValue)
      expect(JSON.parse(Buffer.from(owner.value).toString('utf-8'))).toMatchObject({
        plugin: 'Legacy Recovery Plugin',
      })
    } finally {
      sqlite.close()
    }
  })

  test('upgrades a legacy manifest and preserves update versus delete-reinsert order', async () => {
    const { server, client } = await boot(undefined, undefined, seedOrderedLegacyPublication)
    const write = async (rawKey: string, operation: 'set' | 'remove') => {
      const key = orderedValueKey(rawKey)
      const response = await client.fetch('/api/plugin-storage/mutate', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'file-path': Buffer.from(key, 'utf-8').toString('hex'),
          'x-plugin-storage-operation': operation,
          'x-plugin-storage-generation': STORAGE_GENERATION,
          'x-plugin-storage-owner-policy': 'preserve',
        },
        body: operation === 'set'
          ? new Uint8Array(Buffer.from(JSON.stringify(rawKey)))
          : new Uint8Array(),
      })
      expect(response.status).toBe(200)
    }
    const zKey = orderedValueKey('z')
    const aKey = orderedValueKey('a')
    const bKey = orderedValueKey('b')

    await write('z', 'set')
    expect(readManifest(server.cwd)).toMatchObject({
      version: 2,
      valueKeys: [zKey, aKey],
    })
    await write('b', 'set')
    expect(readManifest(server.cwd).valueKeys).toEqual([zKey, aKey, bKey])
    await write('z', 'remove')
    await write('z', 'set')
    expect(readManifest(server.cwd).valueKeys).toEqual([aKey, bKey, zKey])
  })

  test('generation-bound value-only remove preserves owner bytes and meta manifest membership', async () => {
    const { server, client } = await boot(undefined, undefined, seedActivePublication)
    const response = await client.fetch('/api/plugin-storage/mutate', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'file-path': Buffer.from(VALUE_KEY, 'utf-8').toString('hex'),
        'x-plugin-storage-operation': 'remove',
        'x-plugin-storage-generation': STORAGE_GENERATION,
        'x-plugin-storage-owner-policy': 'preserve',
      },
      body: new Uint8Array(),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'committed',
      operation: 'remove',
      verification: 'verified',
    })
    expect(readRows(server.cwd)).toEqual({ value: null, owner: OLD_OWNER })
    expect(readFacets(server.cwd)).toEqual({ displaySize: null, owner: 'Old Plugin' })
    const database = new Database(path.join(server.cwd, 'save', 'risuai.db'), { readonly: true })
    try {
      const row = database.prepare('SELECT value FROM kv WHERE key = ?').get(MANIFEST_KEY) as {
        value: Buffer
      }
      expect(JSON.parse(Buffer.from(row.value).toString('utf-8'))).toEqual({
        version: 2,
        generation: STORAGE_GENERATION,
        valueKeys: [],
        metaKeys: [OWNER_KEY],
      })
    } finally {
      database.close()
    }
  })

  test('recovery atomically restores an exact sidecar or preserves the existing bytes', async () => {
    const { server, client } = await boot()
    const exactOwner = Buffer.from(JSON.stringify({ plugin: 'Snapshot', updatedAt: 7 }))
    const firstValue = Buffer.from(JSON.stringify({ generation: 'recovered' }))

    const restored = await restorePair(client, firstValue, exactOwner)
    expect(restored.status).toBe(200)
    expect(readRows(server.cwd)).toEqual({ value: firstValue, owner: exactOwner })

    const secondValue = Buffer.from(JSON.stringify({ generation: 'preserved' }))
    const preserved = await restorePair(client, secondValue)
    expect(preserved.status).toBe(200)
    expect(readRows(server.cwd)).toEqual({ value: secondValue, owner: exactOwner })
  })

  test('remove accepts a BR4-valid value-only key whose metadata name is oversized', async () => {
    const { server, client } = await boot(undefined, undefined, (saveDir) => {
      const database = new Database(path.join(saveDir, 'risuai.db'))
      try {
        database.exec(`
          CREATE TABLE kv (
            key TEXT PRIMARY KEY,
            value BLOB NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `)
        database.prepare(
          'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
        ).run(LONG_VALUE_KEY, OLD_VALUE, Date.now())
      } finally {
        database.close()
      }
    })

    const response = await client.fetch('/api/plugin-storage/mutate', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'file-path': Buffer.from(LONG_VALUE_KEY, 'utf-8').toString('hex'),
        'x-plugin-storage-operation': 'remove',
      },
      body: new Uint8Array(),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'committed',
      operation: 'remove',
    })
    const database = new Database(path.join(server.cwd, 'save', 'risuai.db'), {
      readonly: true,
    })
    try {
      const read = database.prepare('SELECT value FROM kv WHERE key = ?')
      expect(read.get(LONG_VALUE_KEY)).toBeUndefined()
      expect(read.get(LONG_OWNER_KEY)).toBeUndefined()
    } finally {
      database.close()
    }
  })

  test('strict JSON rejection leaves the prior value and owner byte-exact', async () => {
    const { server, client } = await boot()

    const response = await mutateRaw(client, Buffer.from('1e400', 'utf-8'))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      success: false,
      outcome: 'not-committed',
      operation: 'set',
      error: 'Invalid plugin storage JSON row',
      code: 'INVALID_PLUGIN_STORAGE_MUTATION',
      retryable: false,
    })
    expect(readRows(server.cwd)).toEqual({ value: OLD_VALUE, owner: OLD_OWNER })
  })

  test('owner-write failure rolls the primary value back and reports not-committed', async () => {
    const { server, client } = await boot('owner-write')

    const response = await mutate(client, 'set')

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'not-committed',
      operation: 'set',
      code: 'PLUGIN_STORAGE_TRANSACTION_ROLLED_BACK',
    })
    expect(readRows(server.cwd)).toEqual({ value: OLD_VALUE, owner: OLD_OWNER })
  })

  test('a primary write failure is surfaced and leaves the complete old state', async () => {
    const { server, client } = await boot(undefined, `key:${VALUE_KEY}`)

    const response = await mutate(client, 'set')

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'not-committed',
      operation: 'set',
    })
    expect(readRows(server.cwd)).toEqual({ value: OLD_VALUE, owner: OLD_OWNER })
  })

  test('a display-facet write failure rolls the value, owner, and facet back atomically', async () => {
    const { server, client } = await boot(
      undefined,
      undefined,
      seedRows,
      'value-write',
    )

    const response = await mutate(client, 'set', { generation: 'facet-failure' })

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'not-committed',
      operation: 'set',
      code: 'PLUGIN_STORAGE_TRANSACTION_ROLLED_BACK',
    })
    expect(readRows(server.cwd)).toEqual({ value: OLD_VALUE, owner: OLD_OWNER })
    const sqlite = new Database(path.join(server.cwd, 'save', 'risuai.db'), { readonly: true })
    try {
      expect(sqlite.prepare(
        'SELECT display_size FROM plugin_storage_viewer_value_facets WHERE storage_key = ?',
      ).get(VALUE_KEY)).toBeUndefined()
    } finally {
      sqlite.close()
    }
  })

  test('owner-remove failure rolls the primary removal back', async () => {
    const { server, client } = await boot('owner-remove')

    const response = await mutate(client, 'remove')

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'not-committed',
      operation: 'remove',
    })
    expect(readRows(server.cwd)).toEqual({ value: OLD_VALUE, owner: OLD_OWNER })
  })

  test.each(['set', 'remove'] as const)(
    'pre-commit failure after both %s row mutations rolls the transaction back',
    async (operation) => {
      const { server, client } = await boot('pre-commit')

      const response = await mutate(client, operation)

      expect(response.status).toBe(500)
      await expect(response.json()).resolves.toMatchObject({
        outcome: 'not-committed',
        operation,
        code: 'PLUGIN_STORAGE_TRANSACTION_ROLLED_BACK',
      })
      expect(readRows(server.cwd)).toEqual({ value: OLD_VALUE, owner: OLD_OWNER })
    },
  )

  test('post-commit verification failure still acknowledges the complete new state', async () => {
    const { server, client } = await boot('verification-read')
    const newValue = { generation: 'new', nested: [1, 2] }

    const response = await mutate(client, 'set', newValue)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'committed',
      operation: 'set',
      verification: 'unavailable',
    })
    const rows = readRows(server.cwd)
    expect(JSON.parse(rows.value!.toString('utf-8'))).toEqual(newValue)
    expect(JSON.parse(rows.owner!.toString('utf-8'))).toMatchObject({
      plugin: 'New Plugin',
      updatedAt: expect.any(Number),
    })
  })

  test('empty owner removes stale metadata and remove cleans an owner orphan', async () => {
    const { server, client } = await boot()

    const setResponse = await mutate(client, 'set', { generation: 'unowned' }, '')
    expect(setResponse.status).toBe(200)
    await expect(setResponse.json()).resolves.toMatchObject({ outcome: 'committed' })
    let rows = readRows(server.cwd)
    expect(JSON.parse(rows.value!.toString('utf-8'))).toEqual({ generation: 'unowned' })
    expect(rows.owner).toBeNull()

    const database = new Database(path.join(server.cwd, 'save', 'risuai.db'))
    try {
      database.prepare('DELETE FROM kv WHERE key = ?').run(VALUE_KEY)
      database.prepare(
        'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
      ).run(OWNER_KEY, OLD_OWNER, Date.now())
    } finally {
      database.close()
    }

    const removeResponse = await mutate(client, 'remove')
    expect(removeResponse.status).toBe(200)
    await expect(removeResponse.json()).resolves.toMatchObject({ outcome: 'committed' })
    rows = readRows(server.cwd)
    expect(rows).toEqual({ value: null, owner: null })
  })

  test('post-commit acknowledgement loss leaves complete new state and no trusted response', async () => {
    const { server, client } = await boot('acknowledgement-loss')
    const newValue = { generation: 'committed-without-ack' }

    await expect(mutateWithClientOutcome(client, 'set', newValue)).resolves.toMatchObject({
      outcome: 'unknown',
      operation: 'set',
      code: 'TRANSPORT_OUTCOME_UNKNOWN',
    })

    const rows = readRows(server.cwd)
    expect(JSON.parse(rows.value!.toString('utf-8'))).toEqual(newValue)
    expect(JSON.parse(rows.owner!.toString('utf-8'))).toMatchObject({
      plugin: 'New Plugin',
      updatedAt: expect.any(Number),
    })
  })

  test('post-commit remove acknowledgement loss deletes both rows without cache publication', async () => {
    const { server, client } = await boot('acknowledgement-loss')

    const result = await mutateWithClientOutcome(client, 'remove')
    expect(result).toMatchObject({
      outcome: 'unknown',
      operation: 'remove',
      code: 'TRANSPORT_OUTCOME_UNKNOWN',
    })
    expect(readRows(server.cwd)).toEqual({ value: null, owner: null })

    const cacheActions: string[] = []
    await publishPluginStorageMutationCache({
      operation: 'remove',
      valueKey: VALUE_KEY,
    }, result, {
      enabled: true,
      storeValue: async () => { cacheActions.push('store') },
      invalidateValue: async () => { cacheActions.push('invalidate') },
    })
    expect(cacheActions).toEqual([])
  })
})
