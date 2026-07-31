import { afterAll, describe, expect, test } from 'vitest'
import path from 'node:path'
import Database from 'better-sqlite3'
import utilsPkg from '../../server/node/utils.cjs'
import { createClient, type RisuClient } from './helpers/client.js'
import { decodeRisuDat } from './helpers/normalize.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'

const { encodeRisuSaveLegacy } = utilsPkg as {
  encodeRisuSaveLegacy: (value: unknown) => Uint8Array
}

const DATABASE_KEY = 'database/database.bin'
const MANIFEST_KEY = 'plugin-storage/manifest.json'
const VALUE_PREFIX = 'pluginsave/'
const META_PREFIX = 'pluginsave-meta/'
const CHAT_MIGRATION_KEY = 'migration/chats-externalized'
const REMOTE_MIGRATION_KEY = 'migration/disable-remote-saving'

const servers = new Set<ServerHandle>()

afterAll(async () => {
  await Promise.allSettled([...servers].map(server => server.cleanup()))
})

function encodeStorageKey(prefix: string, rawKey: string): string {
  return `${prefix}${Buffer.from(rawKey, 'utf8').toString('base64url')}.json`
}

function encodeDatabase(database: Record<string, unknown>): Buffer {
  return Buffer.from(encodeRisuSaveLegacy(database))
}

interface Seed {
  generation: string
  rows: Array<{ key: string, value: Buffer }>
  valueKeys: string[]
  metaKeys?: string[]
  databaseEncoding?: 'legacy' | 'block'
}

function encodeBlockDatabase(database: Record<string, unknown>): Buffer {
  const name = Buffer.from('root', 'utf8')
  const payload = Buffer.from(JSON.stringify(database), 'utf8')
  const length = Buffer.allocUnsafe(4)
  length.writeUInt32LE(payload.length)
  return Buffer.concat([
    Buffer.from('RISUSAVE\0', 'binary'),
    Buffer.from([1, 0, name.length]),
    name,
    length,
    payload,
  ])
}

function seedOptimizedPublication(saveDir: string, seed: Seed): void {
  const sqlite = new Database(path.join(saveDir, 'risuai.db'))
  sqlite.exec(`
    CREATE TABLE kv (
      key TEXT PRIMARY KEY,
      value BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE plugin_storage_usage (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      bytes INTEGER NOT NULL CHECK (bytes >= 0)
    );
  `)
  const insert = sqlite.prepare(
    'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
  )
  const now = Date.now()
  const database = {
    characters: [],
    optimizePluginMemory: true,
    pluginStorageGeneration: seed.generation,
    pluginCustomStorage: {},
  }
  const databaseBytes = seed.databaseEncoding === 'block'
    ? encodeBlockDatabase({
        ...database,
        botPresets: [{ id: 'boot-reconcile-preset' }],
        modules: [],
        plugins: [],
        personas: [],
      })
    : encodeDatabase(database)
  sqlite.transaction(() => {
    insert.run(DATABASE_KEY, databaseBytes, now)
    insert.run(CHAT_MIGRATION_KEY, Buffer.from('done'), now)
    insert.run(REMOTE_MIGRATION_KEY, Buffer.from('done'), now)
    insert.run(MANIFEST_KEY, Buffer.from(JSON.stringify({
      version: 2,
      generation: seed.generation,
      valueKeys: seed.valueKeys,
      metaKeys: seed.metaKeys ?? [],
    })), now)
    for (const row of seed.rows) insert.run(row.key, row.value, now)
    const usage = seed.rows.reduce(
      (sum, row) => sum + (row.key.startsWith(VALUE_PREFIX) ? row.value.length : 0),
      0,
    )
    sqlite.prepare('INSERT INTO plugin_storage_usage (id, bytes) VALUES (1, ?)')
      .run(usage)
  })()
  sqlite.close()
}

async function trackedServer(seed: Seed): Promise<ServerHandle> {
  const server = await spawnServer({
    seedSave: async saveDir => seedOptimizedPublication(saveDir, seed),
    env: { POCKETRISU_BACKUP_INTERVAL_MS: '3600000' },
  })
  servers.add(server)
  return server
}

async function disposeServer(server: ServerHandle): Promise<void> {
  servers.delete(server)
  await server.cleanup()
}

async function rawDatabase(client: RisuClient): Promise<{
  database: Record<string, any>
  etag: string
}> {
  const response = await client.fetch('/api/db/read-raw-for-boot')
  expect(response.status).toBe(200)
  const etag = response.headers.get('x-db-etag')
  expect(etag).toMatch(/^[0-9a-f]{32}$/)
  return {
    database: decodeRisuDat(Buffer.from(await response.arrayBuffer())) as Record<string, any>,
    etag: etag!,
  }
}

async function rawDatabaseEtag(client: RisuClient): Promise<string> {
  const response = await client.fetch('/api/db/read-raw-for-boot')
  expect(response.status).toBe(200)
  const etag = response.headers.get('x-db-etag')
  expect(etag).toMatch(/^[0-9a-f]{32}$/)
  await response.arrayBuffer()
  return etag!
}

async function cachedDatabaseEtag(client: RisuClient): Promise<string> {
  const response = await client.fetch('/api/db/read-cached', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      cache: {
        version: 1,
        hashes: {
          root: [],
          characters: [],
          botPresets: [],
          modules: [],
          personas: [],
        },
      },
    }),
  })
  expect(response.status).toBe(200)
  const etag = response.headers.get('x-db-etag')
  expect(etag).toMatch(/^[0-9a-f]{32}$/)
  await response.arrayBuffer()
  return etag!
}

async function reconcile(client: RisuClient, etag: string): Promise<{
  response: Response
  text: string
  body: Record<string, any>
}> {
  const response = await client.fetch('/api/plugin-storage/reconcile-boot', {
    method: 'POST',
    headers: { 'x-if-match': etag },
  })
  const text = await response.text()
  return { response, text, body: JSON.parse(text) as Record<string, any> }
}

function replaceDatabase(server: ServerHandle, database: Record<string, unknown>): void {
  const sqlite = new Database(path.join(server.cwd, 'save', 'risuai.db'))
  try {
    sqlite.prepare('UPDATE kv SET value = ?, updated_at = ? WHERE key = ?')
      .run(encodeDatabase(database), Date.now(), DATABASE_KEY)
  } finally {
    sqlite.close()
  }
}

function readSqliteJson(server: ServerHandle, key: string): unknown {
  const sqlite = new Database(path.join(server.cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    const row = sqlite.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value: Buffer }
      | undefined
    return row ? JSON.parse(Buffer.from(row.value).toString('utf8')) : null
  } finally {
    sqlite.close()
  }
}

describe('server-side optimized plugin storage boot reconciliation', () => {
  test('accepts the cached-view ETag for a block-format database', async () => {
    const generation = '00000000-0000-4000-8000-000000000001'
    const valueKey = encodeStorageKey(VALUE_PREFIX, 'block-format')
    const server = await trackedServer({
      generation,
      valueKeys: [valueKey],
      rows: [{ key: valueKey, value: Buffer.from(JSON.stringify({ valid: true })) }],
      databaseEncoding: 'block',
    })
    try {
      const client = await createClient(server.port, server.password)
      const cachedEtag = await cachedDatabaseEtag(client)
      const rawEtag = await rawDatabaseEtag(client)
      expect(cachedEtag).not.toBe(rawEtag)

      const result = await reconcile(client, cachedEtag)

      expect(result.response.status).toBe(200)
      expect(result.body).toMatchObject({
        success: true,
        direction: 'none',
        values: 0,
        meta: 0,
        issues: [],
        etag: cachedEtag,
        databaseChanged: false,
        storageChanged: false,
      })

      const write = await client.fetch('/api/write', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'file-path': Buffer.from(DATABASE_KEY).toString('hex'),
          'x-if-match': cachedEtag,
        },
        body: encodeDatabase({
          characters: [],
          botPresets: [{ id: 'boot-reconcile-preset' }],
          modules: [],
          plugins: [],
          personas: [],
          optimizePluginMemory: true,
          pluginStorageGeneration: generation,
          pluginCustomStorage: {},
          savedAfterReconcile: true,
        }),
      })
      expect(write.status).toBe(200)
    } finally {
      await disposeServer(server)
    }
  }, 30_000)

  test('rejects a stale cached-view ETag after a real database change', async () => {
    const generation = '00000000-0000-4000-8000-000000000002'
    const valueKey = encodeStorageKey(VALUE_PREFIX, 'stale-cache-view')
    const storedValue = { remains: 'unchanged' }
    const server = await trackedServer({
      generation,
      valueKeys: [valueKey],
      rows: [{ key: valueKey, value: Buffer.from(JSON.stringify(storedValue)) }],
      databaseEncoding: 'block',
    })
    try {
      const client = await createClient(server.port, server.password)
      const staleEtag = await cachedDatabaseEtag(client)
      replaceDatabase(server, {
        characters: [],
        botPresets: [{ id: 'boot-reconcile-preset' }],
        modules: [],
        plugins: [],
        personas: [],
        optimizePluginMemory: true,
        pluginStorageGeneration: generation,
        pluginCustomStorage: {},
        changedAfterBootRead: true,
      })
      const current = await rawDatabase(client)

      const result = await reconcile(client, staleEtag)

      expect(result.response.status).toBe(409)
      expect(result.body).toMatchObject({
        success: false,
        commitOutcome: 'not-committed',
        commitOutcomeUnknown: false,
        code: 'PLUGIN_STORAGE_BOOT_CONFLICT',
        currentEtag: current.etag,
        retryable: true,
      })
      expect(readSqliteJson(server, valueKey)).toEqual(storedValue)
    } finally {
      await disposeServer(server)
    }
  }, 30_000)

  test('validates a clean publication without returning value bodies', async () => {
    const generation = '11111111-1111-4111-8111-111111111111'
    const valueKey = encodeStorageKey(VALUE_PREFIX, 'large/clean')
    const marker = 'must-not-cross-the-boot-reconcile-response'
    const server = await trackedServer({
      generation,
      valueKeys: [valueKey],
      rows: [{ key: valueKey, value: Buffer.from(JSON.stringify({ marker })) }],
    })
    try {
      const client = await createClient(server.port, server.password)
      const before = await rawDatabase(client)
      const result = await reconcile(client, before.etag)

      expect(result.response.status).toBe(200)
      expect(result.body).toMatchObject({
        success: true,
        direction: 'none',
        values: 0,
        meta: 0,
        issues: [],
        databaseChanged: false,
        storageChanged: false,
      })
      expect(result.text).not.toContain(marker)
      expect(result.text).not.toContain(Buffer.from(JSON.stringify({ marker })).toString('base64'))
    } finally {
      await disposeServer(server)
    }
  }, 30_000)

  test('copies a missing inline value and atomically clears the recovered inline map', async () => {
    const generation = '22222222-2222-4222-8222-222222222222'
    const existingKey = encodeStorageKey(VALUE_PREFIX, 'existing')
    const recoveredKey = encodeStorageKey(VALUE_PREFIX, 'recovered')
    const server = await trackedServer({
      generation,
      valueKeys: [existingKey],
      rows: [{ key: existingKey, value: Buffer.from(JSON.stringify({ existing: true })) }],
    })
    try {
      replaceDatabase(server, {
        characters: [],
        optimizePluginMemory: true,
        pluginStorageGeneration: generation,
        pluginCustomStorage: { recovered: { durable: true } },
      })
      const client = await createClient(server.port, server.password)
      const before = await rawDatabase(client)
      const result = await reconcile(client, before.etag)

      expect(result.response.status).toBe(200)
      expect(result.body).toMatchObject({
        direction: 'externalize',
        values: 1,
        meta: 0,
        issues: [],
        databaseChanged: true,
        storageChanged: true,
      })
      expect(readSqliteJson(server, recoveredKey)).toEqual({ durable: true })
      expect(readSqliteJson(server, MANIFEST_KEY)).toMatchObject({
        generation,
        valueKeys: [existingKey, recoveredKey],
      })
      const after = await rawDatabase(client)
      expect(after.database.pluginCustomStorage).toEqual({})
      expect(after.database.pluginStorageMeta).toBeUndefined()
      expect(after.etag).toBe(result.body.etag)
    } finally {
      await disposeServer(server)
    }
  }, 30_000)

  test('reports a conflicting duplicate without overwriting or clearing either copy', async () => {
    const generation = '33333333-3333-4333-8333-333333333333'
    const valueKey = encodeStorageKey(VALUE_PREFIX, 'conflict')
    const externalMarker = 'external-copy-must-remain-private'
    const inlineMarker = 'inline-copy-must-remain-private'
    const server = await trackedServer({
      generation,
      valueKeys: [valueKey],
      rows: [{
        key: valueKey,
        value: Buffer.from(JSON.stringify({ marker: externalMarker })),
      }],
    })
    try {
      replaceDatabase(server, {
        characters: [],
        optimizePluginMemory: true,
        pluginStorageGeneration: generation,
        pluginCustomStorage: { conflict: { marker: inlineMarker } },
      })
      const client = await createClient(server.port, server.password)
      const before = await rawDatabase(client)
      const result = await reconcile(client, before.etag)

      expect(result.response.status).toBe(200)
      expect(result.body).toMatchObject({
        direction: 'externalize',
        values: 0,
        databaseChanged: false,
        storageChanged: false,
        issues: [{ code: 'conflicting-copies', encodedKey: valueKey }],
      })
      expect(result.text).not.toContain(externalMarker)
      expect(result.text).not.toContain(inlineMarker)
      expect(readSqliteJson(server, valueKey)).toEqual({ marker: externalMarker })
      expect((await rawDatabase(client)).database.pluginCustomStorage)
        .toEqual({ conflict: { marker: inlineMarker } })
    } finally {
      await disposeServer(server)
    }
  }, 30_000)

  test('isolates invalid external JSON without returning its body', async () => {
    const generation = '44444444-4444-4444-8444-444444444444'
    const valueKey = encodeStorageKey(VALUE_PREFIX, 'corrupt')
    const corrupt = Buffer.from('{"secret":"unterminated"')
    const server = await trackedServer({
      generation,
      valueKeys: [valueKey],
      rows: [{ key: valueKey, value: corrupt }],
    })
    try {
      const client = await createClient(server.port, server.password)
      const before = await rawDatabase(client)
      const result = await reconcile(client, before.etag)

      expect(result.response.status).toBe(200)
      expect(result.body).toMatchObject({
        direction: 'externalize',
        values: 0,
        databaseChanged: false,
        issues: [{ code: 'invalid-json', encodedKey: valueKey }],
      })
      expect(result.text).not.toContain('unterminated')
      expect(result.text).not.toContain(corrupt.toString('base64'))
    } finally {
      await disposeServer(server)
    }
  }, 30_000)
})
