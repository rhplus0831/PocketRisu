import { afterAll, describe, expect, test } from 'vitest'
import path from 'node:path'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import Database from 'better-sqlite3'
import { Client as UndiciClient } from 'undici'
import utilsPkg from '../../server/node/utils.cjs'
import pluginStorageJsonPkg from '../../server/node/pluginStorageJson.cjs'
import { createClient, type RisuClient } from './helpers/client.js'
import { decodeRisuDat } from './helpers/normalize.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'

const { encodeRisuSaveLegacy } = utilsPkg as {
  encodeRisuSaveLegacy: (value: unknown) => Uint8Array
}
const {
  serializeLosslessPluginStorageRow,
  validatePluginStorageRow,
} = pluginStorageJsonPkg as {
  serializeLosslessPluginStorageRow: (storageKey: string, value: unknown) => Buffer
  validatePluginStorageRow: (storageKey: string, value: Uint8Array) => unknown
}

const DATABASE_KEY = 'database/database.bin'
const MANIFEST_KEY = 'plugin-storage/manifest.json'
const VALUE_PREFIX = 'pluginsave/'
const META_PREFIX = 'pluginsave-meta/'
const CHAT_MIGRATION_KEY = 'migration/chats-externalized'
const REMOTE_MIGRATION_KEY = 'migration/disable-remote-saving'
const CHARACTER_DEFAULTS_MIGRATION_KEY = 'migration/character-defaults-normalized'

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
    insert.run(CHARACTER_DEFAULTS_MIGRATION_KEY, Buffer.from('done'), now)
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

async function trackedServer(
  seed: Seed,
  env: Record<string, string> = {},
): Promise<ServerHandle> {
  const server = await spawnServer({
    seedSave: async saveDir => seedOptimizedPublication(saveDir, seed),
    env: {
      POCKETRISU_BACKUP_INTERVAL_MS: '3600000',
      ...env,
    },
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

function replaceSqliteRow(server: ServerHandle, key: string, value: Buffer): void {
  const sqlite = new Database(path.join(server.cwd, 'save', 'risuai.db'))
  try {
    sqlite.prepare('UPDATE kv SET value = ?, updated_at = ? WHERE key = ?')
      .run(value, Date.now(), key)
  } finally {
    sqlite.close()
  }
}

function readSqliteBytes(server: ServerHandle, key: string): Buffer | null {
  const sqlite = new Database(path.join(server.cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    const row = sqlite.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value: Buffer }
      | undefined
    return row ? Buffer.from(row.value) : null
  } finally {
    sqlite.close()
  }
}

async function inspectRecovery(client: RisuClient): Promise<{
  text: string
  body: Record<string, any>
}> {
  const response = await client.fetch('/api/plugin-storage/recovery')
  expect(response.status).toBe(200)
  const text = await response.text()
  return { text, body: JSON.parse(text) as Record<string, any> }
}

async function resolveRecovery(
  client: RisuClient,
  issue: Record<string, any>,
  action: 'use-inline' | 'delete',
  options: {
    sessionId?: string
    writerEpoch?: string
    userActive?: boolean
  } = {},
): Promise<{ response: Response, body: Record<string, any> }> {
  const response = await client.fetch('/api/plugin-storage/recovery/resolve', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-session-id': options.sessionId ?? 'plugin-storage-recovery-test',
      ...(options.writerEpoch ? { 'x-writer-epoch': options.writerEpoch } : {}),
      ...(options.userActive === false ? {} : { 'x-user-active': '1' }),
    },
    body: JSON.stringify({
      encodedKey: issue.encodedKey,
      token: issue.token,
      action,
    }),
  })
  return {
    response,
    body: await response.json() as Record<string, any>,
  }
}

async function registerSession(
  client: RisuClient,
  sessionId: string,
): Promise<string> {
  const response = await client.fetch('/api/session', {
    method: 'POST',
    headers: { 'x-session-id': sessionId },
  })
  expect(response.status).toBe(200)
  const body = await response.json() as { writerEpoch?: unknown }
  expect(typeof body.writerEpoch).toBe('string')
  expect(response.headers.get('x-writer-epoch')).toBe(body.writerEpoch)
  return body.writerEpoch as string
}

async function waitForFile(filePath: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await access(filePath)
      return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${filePath}`)
}

async function waitForSessionCount(
  server: ServerHandle,
  expected: number,
  timeoutMs = 10_000,
): Promise<void> {
  const sessionPath = path.join(server.cwd, 'save', '__sessions')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const sessions = JSON.parse(await readFile(sessionPath, 'utf8')) as unknown[]
      if (sessions.length >= expected) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${expected} registered HTTP sessions`)
}

function holdStorageQueueWithInlayWrite(
  client: RisuClient,
  sessionId: string,
  writerEpoch: string,
): Promise<Response> {
  const id = 'plugin-recovery-queue-holder'
  return client.fetch('/api/write', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': Buffer.from(`inlay/${id}`, 'utf8').toString('hex'),
      'x-session-id': sessionId,
      'x-writer-epoch': writerEpoch,
    },
    body: new Uint8Array(Buffer.from(JSON.stringify({
      data: 'data:image/png;base64,AA==',
      ext: 'png',
      name: `${id}.png`,
      type: 'image',
      width: 1,
      height: 1,
    }))),
  })
}

describe('server-side optimized plugin storage boot reconciliation', () => {
  test('accepts the cached-view ETag for a block-format database', async () => {
    const generation = '00000000-0000-4000-8000-000000000001'
    const valueKey = encodeStorageKey(VALUE_PREFIX, 'block-format')
    const expectedDatabase = {
      characters: [],
      optimizePluginMemory: true,
      pluginStorageGeneration: generation,
      pluginCustomStorage: {},
      botPresets: [{ id: 'boot-reconcile-preset' }],
      modules: [],
      plugins: [],
      personas: [],
    }
    const server = await trackedServer({
      generation,
      valueKeys: [valueKey],
      rows: [{ key: valueKey, value: Buffer.from(JSON.stringify({ valid: true })) }],
      databaseEncoding: 'block',
    })
    try {
      const client = await createClient(server.port, server.password)
      const cachedEtag = await cachedDatabaseEtag(client)
      const rawResponse = await client.fetch('/api/db/read-raw-for-boot')
      const rawBytes = Buffer.from(await rawResponse.arrayBuffer())
      const rawEtag = rawResponse.headers.get('x-db-etag')
      expect(rawBytes).toEqual(encodeBlockDatabase(expectedDatabase))
      expect(rawEtag).toBe('d82e545831d6663d4503bc4a04dedd4a')
      expect(cachedEtag).toBe('cf8a7fbc7834cb18ba8a67779828dd5a')
      expect(cachedEtag).not.toBe(rawEtag)

      const ordinaryResponse = await client.fetch('/api/read', {
        headers: { 'file-path': Buffer.from(DATABASE_KEY).toString('hex') },
      })
      expect(ordinaryResponse.headers.get('x-db-etag')).toBe(cachedEtag)
      expect(Buffer.from(await ordinaryResponse.arrayBuffer())).toEqual(
        encodeDatabase(expectedDatabase),
      )

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

  test('accepts a lossless optimized value without entering recovery mode', async () => {
    const generation = '11111111-1111-4111-8111-111111111112'
    const valueKey = encodeStorageKey(VALUE_PREFIX, 'pm_store')
    const marker = 'lossless-value-must-not-cross-the-boot-reconcile-response'
    const storedValue = {
      marker,
      optional: undefined,
      nested: [{ optional: undefined }],
    }
    const storedBytes = serializeLosslessPluginStorageRow(valueKey, storedValue)
    const server = await trackedServer({
      generation,
      valueKeys: [valueKey],
      rows: [{ key: valueKey, value: storedBytes }],
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
      expect(result.text).not.toContain(storedBytes.toString('base64'))
      expect(readSqliteBytes(server, valueKey)).toEqual(storedBytes)
      const decoded = validatePluginStorageRow(valueKey, storedBytes) as typeof storedValue
      expect(Object.hasOwn(decoded, 'optional')).toBe(true)
      expect(decoded.optional).toBeUndefined()
      expect(Object.hasOwn(decoded.nested[0], 'optional')).toBe(true)
      expect(decoded.nested[0].optional).toBeUndefined()
      const inspection = await inspectRecovery(client)
      expect(inspection.body).toMatchObject({
        success: true,
        mode: 'optimized',
        issues: [],
      })
      expect(inspection.text).not.toContain(marker)
      expect(inspection.text).not.toContain(storedBytes.toString('base64'))
    } finally {
      await disposeServer(server)
    }
  }, 30_000)

  test('copies a missing lossless inline value and clears the recovered copy', async () => {
    const generation = '11111111-1111-4111-8111-111111111113'
    const valueKey = encodeStorageKey(VALUE_PREFIX, 'pm_store')
    const inlineValue = {
      optional: undefined,
      nested: [{ optional: undefined }],
    }
    const server = await trackedServer({ generation, valueKeys: [], rows: [] })
    try {
      replaceDatabase(server, {
        characters: [],
        optimizePluginMemory: true,
        pluginStorageGeneration: generation,
        pluginCustomStorage: { pm_store: inlineValue },
      })
      const client = await createClient(server.port, server.password)
      const before = await rawDatabase(client)
      const result = await reconcile(client, before.etag)

      expect(result.response.status).toBe(200)
      expect(result.body).toMatchObject({
        success: true,
        direction: 'externalize',
        values: 1,
        meta: 0,
        issues: [],
        databaseChanged: true,
        storageChanged: true,
      })
      const storedBytes = readSqliteBytes(server, valueKey)
      expect(storedBytes?.subarray(0, 8).toString('ascii')).toBe('PRISUL01')
      const decoded = validatePluginStorageRow(valueKey, storedBytes!) as typeof inlineValue
      expect(Object.hasOwn(decoded, 'optional')).toBe(true)
      expect(decoded.optional).toBeUndefined()
      expect(Object.hasOwn(decoded.nested[0], 'optional')).toBe(true)
      expect(decoded.nested[0].optional).toBeUndefined()
      expect(readSqliteJson(server, MANIFEST_KEY)).toMatchObject({
        generation,
        valueKeys: [valueKey],
      })
      const after = await rawDatabase(client)
      expect(after.database.pluginCustomStorage).toEqual({})
      expect(after.database.pluginStorageMeta).toBeUndefined()
      expect(after.etag).toBe(result.body.etag)
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

  test('downloads exact corrupt bytes and replaces them only after explicit inline recovery', async () => {
    const generation = '55555555-5555-4555-8555-555555555555'
    const rawKey = 'recoverable-corrupt-row'
    const valueKey = encodeStorageKey(VALUE_PREFIX, rawKey)
    const corruptMarker = 'corrupt-external-copy-must-not-appear-in-inspection'
    const inlineMarker = 'selected-inline-copy-must-not-appear-in-inspection'
    const corrupt = Buffer.from(`{"secret":"${corruptMarker}"`)
    const server = await trackedServer({
      generation,
      valueKeys: [valueKey],
      rows: [{ key: valueKey, value: corrupt }],
    })
    try {
      replaceDatabase(server, {
        characters: [],
        optimizePluginMemory: true,
        pluginStorageGeneration: generation,
        pluginCustomStorage: { [rawKey]: { marker: inlineMarker } },
      })
      const client = await createClient(server.port, server.password)
      const inspection = await inspectRecovery(client)

      expect(inspection.body).toMatchObject({
        success: true,
        mode: 'optimized',
        issues: [{
          code: 'invalid-json',
          encodedKey: valueKey,
          kind: 'value',
          inlineAvailable: true,
          externalAvailable: true,
          externalSize: corrupt.length,
          actions: { download: true, useInline: true, delete: false },
        }],
      })
      expect(inspection.text).not.toContain(corruptMarker)
      expect(inspection.text).not.toContain(inlineMarker)

      const issue = inspection.body.issues[0] as Record<string, any>
      const query = new URLSearchParams({
        encodedKey: issue.encodedKey,
        token: issue.token,
      })
      const download = await client.fetch(`/api/plugin-storage/recovery/download?${query}`)
      expect(download.status).toBe(200)
      expect(download.headers.get('content-type')).toBe('application/octet-stream')
      expect(download.headers.get('x-content-sha256')).toMatch(/^[0-9a-f]{64}$/)
      expect(Buffer.from(await download.arrayBuffer())).toEqual(corrupt)

      const resolution = await resolveRecovery(client, issue, 'use-inline')
      expect(resolution.response.status).toBe(200)
      expect(resolution.body).toMatchObject({
        success: true,
        commitOutcome: 'committed',
        commitOutcomeUnknown: false,
        action: 'use-inline',
        encodedKey: valueKey,
      })
      expect(readSqliteJson(server, valueKey)).toEqual({ marker: inlineMarker })
      expect((await rawDatabase(client)).database.pluginCustomStorage)
        .toEqual({ [rawKey]: { marker: inlineMarker } })

      const beforeCleanup = await rawDatabase(client)
      const cleanup = await reconcile(client, beforeCleanup.etag)
      expect(cleanup.response.status).toBe(200)
      expect(cleanup.body).toMatchObject({
        issues: [],
        databaseChanged: true,
        storageChanged: false,
      })
      expect((await rawDatabase(client)).database.pluginCustomStorage).toEqual({})
    } finally {
      await disposeServer(server)
    }
  }, 30_000)

  test('rejects a stale writer epoch before resolving and accepts the current epoch', async () => {
    const generation = '56565656-5656-4656-8656-565656565656'
    const invalidEncodedKey = `${VALUE_PREFIX}stale+epoch.json`
    const original = Buffer.from(JSON.stringify({ stranded: 'stale-epoch-row' }))
    const server = await trackedServer({
      generation,
      valueKeys: [],
      rows: [{ key: invalidEncodedKey, value: original }],
    })
    try {
      const client = await createClient(server.port, server.password)
      const sessionId = 'plugin-storage-recovery-current-epoch'
      const writerEpoch = await registerSession(client, sessionId)
      const inspection = await inspectRecovery(client)
      const issue = inspection.body.issues.find(
        (candidate: Record<string, any>) => candidate.encodedKey === invalidEncodedKey,
      ) as Record<string, any>
      expect(issue).toMatchObject({
        code: 'invalid-encoded-key',
        actions: { delete: true },
      })

      const staleWriterEpoch = `${writerEpoch.slice(0, -1)}${writerEpoch.endsWith('0') ? '1' : '0'}`
      const rejected = await resolveRecovery(client, issue, 'delete', {
        sessionId,
        writerEpoch: staleWriterEpoch,
      })
      expect(rejected.response.status).toBe(423)
      expect(rejected.body).toEqual({
        error: 'Session deactivated',
        code: 'SESSION_DEACTIVATED',
        retryable: false,
        commitOutcome: 'not-committed',
        commitOutcomeUnknown: false,
      })
      expect(readSqliteBytes(server, invalidEncodedKey)).toEqual(original)

      const resolved = await resolveRecovery(client, issue, 'delete', {
        sessionId,
        writerEpoch,
      })
      expect(resolved.response.status, JSON.stringify(resolved.body)).toBe(200)
      expect(resolved.body).toMatchObject({
        success: true,
        commitOutcome: 'committed',
        commitOutcomeUnknown: false,
        action: 'delete',
        encodedKey: invalidEncodedKey,
      })
      expect(readSqliteBytes(server, invalidEncodedKey)).toBeNull()
    } finally {
      await disposeServer(server)
    }
  }, 30_000)

  test('rejects a queued recovery resolve when another session takes over', async () => {
    const generation = '57575757-5757-4757-8757-575757575757'
    const invalidEncodedKey = `${VALUE_PREFIX}queued+takeover.json`
    const original = Buffer.from(JSON.stringify({ stranded: 'queued-recovery-row' }))
    const gateName = 'plugin-recovery-queue-gate'
    const server = await trackedServer({
      generation,
      valueKeys: [],
      rows: [{ key: invalidEncodedKey, value: original }],
    }, {
      POCKETRISU_TEST_INLAY_PUBLISH_GATE_DIR: gateName,
      POCKETRISU_TEST_INLAY_PUBLISH_GATE_STAGE: 'before-payload-publish',
    })
    const gateDir = path.join(server.cwd, gateName)
    const releasePath = path.join(gateDir, 'release')
    const pipeline = new UndiciClient(`http://127.0.0.1:${server.port}`, { pipelining: 2 })
    let queueHolder: Promise<Response> | null = null
    try {
      const sessionA = 'plugin-recovery-queued-session-a'
      const sessionB = 'plugin-recovery-queued-session-b'
      const clientA = await createClient(server.port, server.password)
      const clientB = await createClient(server.port, server.password)
      const writerEpoch = await registerSession(clientA, sessionA)
      const inspection = await inspectRecovery(clientA)
      const issue = inspection.body.issues.find(
        (candidate: Record<string, any>) => candidate.encodedKey === invalidEncodedKey,
      ) as Record<string, any>
      expect(issue).toMatchObject({
        code: 'invalid-encoded-key',
        actions: { delete: true },
      })

      await mkdir(gateDir, { recursive: true })
      await writeFile(path.join(gateDir, 'hold'), 'hold')
      queueHolder = holdStorageQueueWithInlayWrite(clientA, sessionA, writerEpoch)
      await waitForFile(path.join(gateDir, 'entered'))

      const resolveBody = JSON.stringify({
        encodedKey: issue.encodedKey,
        token: issue.token,
        action: 'delete',
      })
      // One HTTP/1 pipeline fixes admission order without a timing race: A's
      // resolve reaches checkActiveSession before B's session boot is recorded.
      const queuedResolve = pipeline.request({
        path: '/api/plugin-storage/recovery/resolve',
        method: 'POST',
        idempotent: true,
        blocking: false,
        headers: {
          'risu-auth': clientA.token,
          'content-type': 'application/json',
          'x-session-id': sessionA,
          'x-writer-epoch': writerEpoch,
          'x-user-active': '1',
        },
        body: resolveBody,
      })
      let resolveSettled = false
      void queuedResolve.then(
        () => { resolveSettled = true },
        () => { resolveSettled = true },
      )
      const pipelinedBoot = pipeline.request({
        path: '/api/session',
        method: 'POST',
        idempotent: true,
        blocking: false,
        headers: {
          'risu-auth': clientB.token,
          'x-session-id': sessionB,
        },
        body: '',
      })
      void pipelinedBoot.catch(() => {})

      await waitForSessionCount(server, 2)
      expect(resolveSettled).toBe(false)

      const sessionFile = path.join(server.cwd, 'save', '__sessions')
      const sessionFileStat = await stat(sessionFile)
      while (Date.now() <= Math.ceil(sessionFileStat.mtimeMs)) {
        await new Promise(resolve => setTimeout(resolve, 1))
      }
      expect(await registerSession(clientB, sessionB)).toBe(writerEpoch)
      const takeover = await clientB.fetch('/api/plugin-storage/recovery/resolve', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-session-id': sessionB,
          'x-writer-epoch': writerEpoch,
          'x-user-active': '1',
        },
        body: '{}',
      })
      expect(takeover.status).toBe(400)
      await expect(takeover.json()).resolves.toMatchObject({
        code: 'INVALID_PLUGIN_STORAGE_RECOVERY_REQUEST',
        commitOutcome: 'not-committed',
      })
      expect(resolveSettled).toBe(false)

      await writeFile(releasePath, 'release')
      const holderResponse = await queueHolder
      expect(holderResponse.status).toBe(200)
      await holderResponse.arrayBuffer()

      const rejected = await queuedResolve
      expect(rejected.statusCode).toBe(423)
      await expect(rejected.body.json()).resolves.toEqual({
        error: 'Session deactivated',
        code: 'SESSION_DEACTIVATED',
        retryable: false,
        commitOutcome: 'not-committed',
        commitOutcomeUnknown: false,
      })
      const bootResponse = await pipelinedBoot
      expect(bootResponse.statusCode).toBe(200)
      await bootResponse.body.dump()
      expect(readSqliteBytes(server, invalidEncodedKey)).toEqual(original)
      await pipeline.close()
    } finally {
      await writeFile(releasePath, 'release').catch(() => {})
      await queueHolder?.then(response => response.arrayBuffer()).catch(() => {})
      await pipeline.destroy().catch(() => {})
      await disposeServer(server)
    }
  }, 60_000)

  test('rejects stale destructive tokens and deletes an unrecoverable value with its owner', async () => {
    const generation = '66666666-6666-4666-8666-666666666666'
    const rawKey = 'unrecoverable-corrupt-row'
    const valueKey = encodeStorageKey(VALUE_PREFIX, rawKey)
    const ownerKey = encodeStorageKey(META_PREFIX, rawKey)
    const firstCorrupt = Buffer.from('{"first":"unterminated"')
    const secondCorrupt = Buffer.from('{"second":"still-unterminated"')
    const server = await trackedServer({
      generation,
      valueKeys: [valueKey],
      metaKeys: [ownerKey],
      rows: [
        { key: valueKey, value: firstCorrupt },
        { key: ownerKey, value: Buffer.from(JSON.stringify('plugin-id')) },
      ],
    })
    try {
      const client = await createClient(server.port, server.password)
      const initial = await inspectRecovery(client)
      const staleIssue = initial.body.issues.find(
        (issue: Record<string, any>) => issue.encodedKey === valueKey,
      ) as Record<string, any>
      expect(staleIssue).toMatchObject({
        code: 'invalid-json',
        inlineAvailable: false,
        actions: { download: true, useInline: false, delete: true },
      })

      replaceSqliteRow(server, valueKey, secondCorrupt)
      const staleResolution = await resolveRecovery(client, staleIssue, 'delete')
      expect(staleResolution.response.status).toBe(409)
      expect(staleResolution.body).toMatchObject({
        success: false,
        commitOutcome: 'not-committed',
        commitOutcomeUnknown: false,
        code: 'PLUGIN_STORAGE_RECOVERY_STALE',
      })
      expect(readSqliteBytes(server, valueKey)).toEqual(secondCorrupt)
      expect(readSqliteJson(server, ownerKey)).toBe('plugin-id')

      const refreshed = await inspectRecovery(client)
      const currentIssue = refreshed.body.issues.find(
        (issue: Record<string, any>) => issue.encodedKey === valueKey,
      ) as Record<string, any>
      expect(currentIssue.token).not.toBe(staleIssue.token)
      const deletion = await resolveRecovery(client, currentIssue, 'delete')
      expect(deletion.response.status, JSON.stringify(deletion.body)).toBe(200)
      expect(deletion.body).toMatchObject({
        success: true,
        action: 'delete',
        encodedKey: valueKey,
      })
      expect(readSqliteBytes(server, valueKey)).toBeNull()
      expect(readSqliteBytes(server, ownerKey)).toBeNull()
      expect(readSqliteJson(server, MANIFEST_KEY)).toMatchObject({
        generation,
        valueKeys: [],
        metaKeys: [],
      })
      expect((await inspectRecovery(client)).body.issues).toEqual([])
    } finally {
      await disposeServer(server)
    }
  }, 30_000)

  test('deletes a quarantined invalid encoded row without changing the selected manifest', async () => {
    const generation = '77777777-7777-4777-8777-777777777777'
    const invalidEncodedKey = `${VALUE_PREFIX}not+canonical.json`
    const server = await trackedServer({
      generation,
      valueKeys: [],
      rows: [{
        key: invalidEncodedKey,
        value: Buffer.from(JSON.stringify({ stranded: true })),
      }],
    })
    try {
      const client = await createClient(server.port, server.password)
      const inspection = await inspectRecovery(client)
      const issue = inspection.body.issues.find(
        (candidate: Record<string, any>) => candidate.encodedKey === invalidEncodedKey,
      ) as Record<string, any>
      expect(issue).toMatchObject({
        code: 'invalid-encoded-key',
        actions: { download: true, useInline: false, delete: true },
      })

      const deletion = await resolveRecovery(client, issue, 'delete')
      expect(deletion.response.status, JSON.stringify(deletion.body)).toBe(200)
      expect(readSqliteBytes(server, invalidEncodedKey)).toBeNull()
      expect(readSqliteJson(server, MANIFEST_KEY)).toMatchObject({
        generation,
        valueKeys: [],
      })
      expect((await inspectRecovery(client)).body.issues).toEqual([])
    } finally {
      await disposeServer(server)
    }
  }, 30_000)
})
