import { afterAll, describe, expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import Database from 'better-sqlite3'
import utilsPkg from '../../server/node/utils.cjs'
import { createClient, type RisuClient } from './helpers/client.js'
import { decodeRisuDat } from './helpers/normalize.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { decodeBackup } from './helpers/decode.js'

const { encodeRisuSaveLegacy } = utilsPkg as {
  encodeRisuSaveLegacy: (value: unknown) => Uint8Array
}

const DATABASE_KEY = 'database/database.bin'
const MANIFEST_KEY = 'plugin-storage/manifest.json'
const VALUE_PREFIX = 'pluginsave/'
const META_PREFIX = 'pluginsave-meta/'
const CHAT_MIGRATION_KEY = 'migration/chats-externalized'
const REMOTE_MIGRATION_KEY = 'migration/disable-remote-saving'
const STAGE_FILE_PREFIX = '.plugin-transition-stage-'
const MAX_ENTRIES = 100_000

const servers = new Set<ServerHandle>()

afterAll(async () => {
  await Promise.allSettled([...servers].map(server => server.cleanup()))
})

function encodeStorageKey(prefix: typeof VALUE_PREFIX | typeof META_PREFIX, rawKey: string): string {
  return `${prefix}${Buffer.from(rawKey, 'utf8').toString('base64url')}.json`
}

function hexPath(key: string): string {
  return Buffer.from(key, 'utf8').toString('hex')
}

function exactJsonBytes(size: number, fill = 'x'): Buffer {
  if (size < 2) throw new Error('A JSON string needs at least two bytes')
  const value = Buffer.from(JSON.stringify(fill.repeat(size - 2)), 'utf8')
  if (value.length !== size) throw new Error(`Expected ${size} bytes, got ${value.length}`)
  return value
}

function encodeDatabase(database: Record<string, unknown>): Buffer {
  return Buffer.from(encodeRisuSaveLegacy(database))
}

interface Manifest {
  version: 1 | 2
  generation: string
  valueKeys: string[]
  metaKeys: string[]
}

interface SeedPublication {
  database: Record<string, unknown>
  rows?: Array<{ key: string, value: Buffer }>
  manifest?: Manifest | null
  chatRows?: Array<{ chaId: string, chatId: string, chat: unknown }>
}

function initializeSeedDatabase(saveDir: string): Database.Database {
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
  return sqlite
}

function seedPublication(saveDir: string, seed: SeedPublication): void {
  const sqlite = initializeSeedDatabase(saveDir)
  try {
    const insert = sqlite.prepare(
      'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
    )
    const now = Date.now()
    const rows = seed.rows ?? []
    sqlite.transaction(() => {
      insert.run(DATABASE_KEY, encodeDatabase(seed.database), now)
      insert.run(CHAT_MIGRATION_KEY, Buffer.from('done'), now)
      insert.run(REMOTE_MIGRATION_KEY, Buffer.from('done'), now)
      if (seed.manifest) {
        insert.run(MANIFEST_KEY, Buffer.from(JSON.stringify(seed.manifest)), now)
      }
      for (const row of rows) insert.run(row.key, row.value, now)
      for (const row of seed.chatRows ?? []) {
        insert.run(
          `chats/${encodeURIComponent(row.chaId)}/${encodeURIComponent(row.chatId)}`,
          encodeDatabase(row.chat as Record<string, unknown>),
          now,
        )
      }
      const usage = rows.reduce(
        (sum, row) => sum + (row.key.startsWith(VALUE_PREFIX) ? row.value.length : 0),
        0,
      )
      sqlite.prepare('INSERT INTO plugin_storage_usage (id, bytes) VALUES (1, ?)')
        .run(usage)
    })()
  } finally {
    sqlite.close()
  }
}

function seedSizedOptimizedPublication(
  saveDir: string,
  generation: string,
  sizes: number[],
  corruptLast = false,
): Manifest {
  const valueKeys = sizes.map((_, index) => encodeStorageKey(VALUE_PREFIX, `large/${index}`))
  const manifest: Manifest = { version: 1, generation, valueKeys, metaKeys: [] }
  const sqlite = initializeSeedDatabase(saveDir)
  try {
    const insert = sqlite.prepare(
      'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
    )
    const now = Date.now()
    sqlite.transaction(() => {
      insert.run(DATABASE_KEY, encodeDatabase({
        characters: [],
        optimizePluginMemory: true,
        pluginStorageGeneration: generation,
        pluginCustomStorage: {},
      }), now)
      insert.run(CHAT_MIGRATION_KEY, Buffer.from('done'), now)
      insert.run(REMOTE_MIGRATION_KEY, Buffer.from('done'), now)
      insert.run(MANIFEST_KEY, Buffer.from(JSON.stringify(manifest)), now)
      for (let index = 0; index < sizes.length; index++) {
        const value = corruptLast && index === sizes.length - 1
          ? Buffer.alloc(sizes[index], 0x78)
          : exactJsonBytes(sizes[index], String(index % 10))
        insert.run(valueKeys[index], value, now)
      }
      sqlite.prepare('INSERT INTO plugin_storage_usage (id, bytes) VALUES (1, ?)')
        .run(sizes.reduce((sum, size) => sum + size, 0))
    })()
  } finally {
    sqlite.close()
  }
  return manifest
}

async function trackedServer(options: Parameters<typeof spawnServer>[0] = {}): Promise<ServerHandle> {
  const server = await spawnServer(options)
  servers.add(server)
  return server
}

async function disposeServer(server: ServerHandle): Promise<void> {
  servers.delete(server)
  await server.cleanup()
}

async function readPublication(client: RisuClient): Promise<{
  database: Record<string, any>
  etag: string | null
}> {
  const response = await client.fetch('/api/read', {
    headers: { 'file-path': hexPath(DATABASE_KEY) },
  })
  expect(response.status).toBe(200)
  return {
    database: decodeRisuDat(Buffer.from(await response.arrayBuffer())) as Record<string, any>,
    etag: response.headers.get('x-db-etag'),
  }
}

function sourceOf(database: Record<string, any>, manifest: Manifest | null) {
  return {
    optimized: database.optimizePluginMemory === true,
    generation: database.pluginStorageGeneration ?? null,
    manifest,
  }
}

async function beginTransition(
  client: RisuClient,
  input: {
    transitionId?: string
    source: ReturnType<typeof sourceOf>
    targetOptimized: boolean
    rows: Array<{ storageKey: string, size: number, [key: string]: unknown }>
    expectedEtag?: string | null
    extra?: Record<string, unknown>
  },
): Promise<{ response: Response, transitionId: string, targetGeneration: string }> {
  const transitionId = input.transitionId ?? randomUUID()
  const targetGeneration = randomUUID()
  const response = await client.fetch('/api/plugin-storage/transition/stage/begin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version: 2,
      transitionId,
      source: input.source,
      targetOptimized: input.targetOptimized,
      targetGeneration,
      rows: input.rows,
      ...(input.expectedEtag ? { expectedEtag: input.expectedEtag } : {}),
      ...input.extra,
    }),
  })
  return { response, transitionId, targetGeneration }
}

async function uploadRow(
  client: RisuClient,
  transitionId: string,
  storageKey: string,
  value: Buffer,
): Promise<Response> {
  return client.fetch('/api/plugin-storage/transition/stage/upload', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-plugin-storage-transition': transitionId,
      'x-plugin-storage-key': storageKey,
    },
    body: new Uint8Array(value),
  })
}

async function finalize(client: RisuClient, transitionId: string): Promise<Response> {
  return client.fetch('/api/plugin-storage/transition/stage/finalize', {
    method: 'POST',
    headers: { 'x-plugin-storage-transition': transitionId },
  })
}

async function abort(client: RisuClient, transitionId: string): Promise<Response> {
  return client.fetch('/api/plugin-storage/transition/stage/abort', {
    method: 'POST',
    headers: { 'x-plugin-storage-transition': transitionId },
  })
}

function stageDir(server: ServerHandle): string {
  return path.join(server.cwd, 'save', '.plugin-transition-staging')
}

function readSqliteValue(server: ServerHandle, key: string): Buffer | null {
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

function readPluginUsage(server: ServerHandle): number {
  const sqlite = new Database(path.join(server.cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    return (sqlite.prepare('SELECT bytes FROM plugin_storage_usage WHERE id = 1')
      .get() as { bytes: number }).bytes
  } finally {
    sqlite.close()
  }
}

async function disconnectAfterSendingBegin(
  server: ServerHandle,
  client: RisuClient,
  plan: Record<string, unknown>,
): Promise<void> {
  const body = Buffer.from(JSON.stringify(plan))
  await new Promise<void>((resolve) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port: server.port,
      path: '/api/plugin-storage/transition/stage/begin',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(body.length),
        'risu-auth': client.token,
      },
    })
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    request.on('error', finish)
    request.on('close', finish)
    request.end(body, () => request.destroy())
    setTimeout(() => {
      request.destroy()
      finish()
    }, 1_000)
  })
}

describe('staged plugin transition verifier boundaries (real server)', () => {
  test('binds exact value and metadata rows and rejects every descriptor substitution', async () => {
    const rawKey = 'exact/value-and-meta'
    const valueKey = encodeStorageKey(VALUE_PREFIX, rawKey)
    const metaKey = encodeStorageKey(META_PREFIX, rawKey)
    const value = Buffer.from('{"a":1}')
    const alteredSameSize = Buffer.from('{"b":1}')
    const meta = Buffer.from(JSON.stringify({ plugin: 'Exact owner', updatedAt: 1 }))
    const database = {
      characters: [],
      optimizePluginMemory: false,
      pluginCustomStorage: { [rawKey]: JSON.parse(value.toString('utf8')) },
      pluginStorageMeta: { [rawKey]: JSON.parse(meta.toString('utf8')) },
    }
    const server = await trackedServer({
      seedSave: async saveDir => seedPublication(saveDir, { database }),
    })
    const client = await createClient(server.port, server.password)
    const live = await readPublication(client)
    const source = sourceOf(live.database, null)
    const exactRows = [
      { storageKey: valueKey, size: value.length },
      { storageKey: metaKey, size: meta.length },
    ]
    const substitutedValueKey = encodeStorageKey(VALUE_PREFIX, 'same-size-substitute')

    const rejectedPlans = [
      exactRows.slice(0, 1),
      [...exactRows, { storageKey: encodeStorageKey(VALUE_PREFIX, 'extra'), size: 1 }],
      [
        { storageKey: substitutedValueKey, size: value.length },
        exactRows[1],
      ],
      [
        { storageKey: metaKey, size: value.length },
        { storageKey: valueKey, size: meta.length },
      ],
    ]
    for (const rows of rejectedPlans) {
      const result = await beginTransition(client, {
        source,
        targetOptimized: true,
        rows,
        expectedEtag: live.etag,
      })
      expect(result.response.status).toBe(409)
      await expect(result.response.json()).resolves.toMatchObject({
        code: 'PLUGIN_STORAGE_CHANGED',
      })
    }

    const begun = await beginTransition(client, {
      source,
      targetOptimized: true,
      rows: exactRows,
      expectedEtag: live.etag,
    })
    expect(begun.response.status).toBe(200)
    await expect(begun.response.json()).resolves.toMatchObject({
      state: 'uploading',
      total: 2,
      totalBytes: value.length + meta.length,
    })

    const altered = await uploadRow(client, begun.transitionId, valueKey, alteredSameSize)
    expect(altered.status).toBe(409)
    await expect(altered.json()).resolves.toMatchObject({ code: 'PLUGIN_STORAGE_CHANGED' })
    expect((await uploadRow(client, begun.transitionId, valueKey, value)).status).toBe(200)
    expect((await uploadRow(client, begun.transitionId, metaKey, meta)).status).toBe(200)
    expect((await finalize(client, begun.transitionId)).status).toBe(200)

    const committed = await readPublication(client)
    expect(committed.database.optimizePluginMemory).toBe(true)
    expect(committed.database.pluginCustomStorage).toEqual({})
    expect(committed.database.pluginStorageMeta).toBeUndefined()
    expect(readSqliteValue(server, valueKey)).toEqual(value)
    expect(readSqliteValue(server, metaKey)).toEqual(meta)
    expect(JSON.parse(readSqliteValue(server, MANIFEST_KEY)!.toString('utf8'))).toEqual({
      version: 2,
      generation: begun.targetGeneration,
      valueKeys: [valueKey],
      metaKeys: [metaKey],
    })
  }, 30_000)

  test('partial export pins the live source and ignores private staged rows', async () => {
    const rawKey = 'private-stage/source'
    const valueKey = encodeStorageKey(VALUE_PREFIX, rawKey)
    const value = Buffer.from(JSON.stringify({ source: 'live-inline' }))
    const database = {
      characters: [],
      optimizePluginMemory: false,
      pluginCustomStorage: { [rawKey]: JSON.parse(value.toString('utf8')) },
      account: { token: 'must-not-enter-partial-backup' },
    }
    const server = await trackedServer({
      seedSave: async saveDir => seedPublication(saveDir, { database }),
    })
    const client = await createClient(server.port, server.password)
    const live = await readPublication(client)
    const begun = await beginTransition(client, {
      source: sourceOf(live.database, null),
      targetOptimized: true,
      rows: [{ storageKey: valueKey, size: value.length }],
      expectedEtag: live.etag,
    })
    expect(begun.response.status).toBe(200)
    expect((await uploadRow(client, begun.transitionId, valueKey, value)).status).toBe(200)
    expect(readSqliteValue(server, valueKey)).toBeNull()
    expect((await readdir(stageDir(server))).some(name => name.endsWith('.row'))).toBe(true)

    const create = await client.fetch('/api/backup/export/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'partial', jobId: randomUUID() }),
    })
    expect(create.status).toBe(202)
    const { jobId } = await create.json() as { jobId: string }
    let state = 'preparing'
    for (let attempt = 0; attempt < 200 && state === 'preparing'; attempt++) {
      const status = await client.fetch(`/api/backup/export/jobs/${jobId}`)
      expect(status.status).toBe(200)
      state = ((await status.json()) as { state: string }).state
      if (state === 'preparing') await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(state).toBe('ready')
    const response = await client.fetch(`/api/backup/export/jobs/${jobId}/download`)
    expect(response.status).toBe(200)
    const entries = decodeBackup(Buffer.from(await response.arrayBuffer()))
    expect(entries.map(entry => entry.name)).toEqual(['database.risudat'])
    const exported = decodeRisuDat(entries[0].data)
    expect(exported.account).toBeUndefined()
    expect(exported.optimizePluginMemory).toBe(false)
    expect(exported.pluginCustomStorage).toEqual({
      [rawKey]: { source: 'live-inline' },
    })
    expect(readSqliteValue(server, valueKey)).toBeNull()
    expect((await readdir(stageDir(server))).some(name => name.endsWith('.row'))).toBe(true)
    expect((await abort(client, begun.transitionId)).status).toBe(200)
  }, 30_000)

  test('rejects malicious begin envelopes and row descriptors before staging', async () => {
    const rawKey = 'strict-plan'
    const valueKey = encodeStorageKey(VALUE_PREFIX, rawKey)
    const value = Buffer.from('{"strict":true}')
    const database = {
      characters: [],
      optimizePluginMemory: false,
      pluginCustomStorage: { [rawKey]: { strict: true } },
    }
    const server = await trackedServer({
      seedSave: async saveDir => seedPublication(saveDir, { database }),
    })
    const client = await createClient(server.port, server.password)
    const live = await readPublication(client)
    const source = sourceOf(live.database, null)
    const exactRow = { storageKey: valueKey, size: value.length }

    const aggregateEnvelope = await beginTransition(client, {
      source,
      targetOptimized: true,
      rows: [exactRow],
      expectedEtag: live.etag,
      extra: { database: 'forbidden aggregate database envelope' },
    })
    if (aggregateEnvelope.response.ok) await abort(client, aggregateEnvelope.transitionId)
    expect(aggregateEnvelope.response.status).toBe(400)

    const payloadDescriptor = await beginTransition(client, {
      source,
      targetOptimized: true,
      rows: [{ ...exactRow, value: { forged: true } }],
      expectedEtag: live.etag,
    })
    if (payloadDescriptor.response.ok) await abort(client, payloadDescriptor.transitionId)
    expect(payloadDescriptor.response.status).toBe(409)
    await expect(payloadDescriptor.response.json()).resolves.toMatchObject({
      code: 'PLUGIN_STORAGE_CHANGED',
    })

    const wrongSource = await beginTransition(client, {
      source: { ...source, generation: randomUUID() },
      targetOptimized: true,
      rows: [exactRow],
      expectedEtag: live.etag,
    })
    expect(wrongSource.response.status).toBe(409)

    const sameMode = await beginTransition(client, {
      source,
      targetOptimized: false,
      rows: [],
      expectedEtag: live.etag,
    })
    expect(sameMode.response.status).toBe(400)
    expect(await readdir(stageDir(server))).toEqual([])
  }, 30_000)

  test('internalizes legal optimized rows above the former row and aggregate inline limits', async () => {
    const exactGeneration = randomUUID()
    const exactManifest: Manifest = {
      version: 1,
      generation: exactGeneration,
      valueKeys: [0, 1].map(index => encodeStorageKey(VALUE_PREFIX, `large/${index}`)),
      metaKeys: [],
    }
    const exactServer = await trackedServer({
      seedSave: async saveDir => {
        seedSizedOptimizedPublication(
          saveDir,
          exactGeneration,
          [40 * 1024 * 1024, 25 * 1024 * 1024],
        )
      },
    })
    try {
      const client = await createClient(exactServer.port, exactServer.password)
      const live = await readPublication(client)
      const begun = await beginTransition(client, {
        source: sourceOf(live.database, exactManifest),
        targetOptimized: false,
        rows: [],
        expectedEtag: live.etag,
      })
      expect(begun.response.status).toBe(200)
      await expect(begun.response.json()).resolves.toMatchObject({
        state: 'ready',
        total: 2,
        totalBytes: 65 * 1024 * 1024,
      })
      const files = await readdir(stageDir(exactServer))
      const rowFiles = files.filter(name => name.endsWith('.row'))
      expect(rowFiles).toHaveLength(2)
      for (const rowFile of rowFiles) {
        expect((await stat(path.join(stageDir(exactServer), rowFile))).mode & 0o777).toBe(0o600)
      }
      expect((await finalize(client, begun.transitionId)).status).toBe(200)
      const committed = await readPublication(client)
      expect(committed.database.optimizePluginMemory).toBe(false)
      expect(committed.database.pluginCustomStorage['large/0']).toHaveLength(40 * 1024 * 1024 - 2)
      expect(committed.database.pluginCustomStorage['large/1']).toHaveLength(25 * 1024 * 1024 - 2)
      expect(readSqliteValue(exactServer, exactManifest.valueKeys[0])).toBeNull()
      expect(readSqliteValue(exactServer, exactManifest.valueKeys[1])).toBeNull()
      expect(readPluginUsage(exactServer)).toBe(0)
    } finally {
      await disposeServer(exactServer)
    }
  }, 120_000)

  test('accepts 100000 exact inline descriptors and rejects authoritative entry 100001', async () => {
    const makeDatabaseAndRows = (count: number) => {
      // The legacy msgpack writer intentionally uses the fast 16-bit map path.
      // Split the protocol-wide ceiling across the two independent storage
      // maps so the fixture itself remains a valid Risu save.
      const valueCount = Math.ceil(count / 2)
      const pluginCustomStorage: Record<string, number> = {}
      const pluginStorageMeta: Record<string, number> = {}
      const rows: Array<{ storageKey: string, size: number }> = []
      for (let index = 0; index < count; index++) {
        const rawKey = `entry/${index}`
        const prefix = index < valueCount ? VALUE_PREFIX : META_PREFIX
        const target = index < valueCount ? pluginCustomStorage : pluginStorageMeta
        target[rawKey] = index % 10
        rows.push({ storageKey: encodeStorageKey(prefix, rawKey), size: 1 })
      }
      return {
        database: {
          characters: [],
          optimizePluginMemory: false,
          pluginCustomStorage,
          pluginStorageMeta,
        },
        rows,
      }
    }

    const exact = makeDatabaseAndRows(MAX_ENTRIES)
    const exactServer = await trackedServer({
      seedSave: async saveDir => seedPublication(saveDir, { database: exact.database }),
    })
    try {
      const client = await createClient(exactServer.port, exactServer.password)
      const live = await readPublication(client)
      const begun = await beginTransition(client, {
        source: sourceOf(live.database, null),
        targetOptimized: true,
        rows: exact.rows,
        expectedEtag: live.etag,
      })
      expect(begun.response.status).toBe(200)
      await expect(begun.response.json()).resolves.toMatchObject({
        state: 'uploading',
        total: MAX_ENTRIES,
        totalBytes: MAX_ENTRIES,
      })
      expect((await abort(client, begun.transitionId)).status).toBe(200)
    } finally {
      await disposeServer(exactServer)
    }

    const oversized = makeDatabaseAndRows(MAX_ENTRIES + 1)
    const oversizedServer = await trackedServer({
      seedSave: async saveDir => seedPublication(saveDir, { database: oversized.database }),
    })
    try {
      const client = await createClient(oversizedServer.port, oversizedServer.password)
      const live = await readPublication(client)
      const begun = await beginTransition(client, {
        source: sourceOf(live.database, null),
        targetOptimized: true,
        rows: [],
        expectedEtag: live.etag,
      })
      expect(begun.response.status).toBe(413)
      await expect(begun.response.json()).resolves.toMatchObject({
        code: 'PLUGIN_STORAGE_SIZE_LIMIT',
        limit: MAX_ENTRIES,
        actual: MAX_ENTRIES + 1,
      })
      expect(await readdir(stageDir(oversizedServer))).toEqual([])
    } finally {
      await disposeServer(oversizedServer)
    }
  }, 120_000)

  test('accepts exact transition disk headroom and rejects one byte less', async () => {
    const rawKey = 'disk-boundary'
    const valueKey = encodeStorageKey(VALUE_PREFIX, rawKey)
    const value = exactJsonBytes(1024)
    const database = {
      characters: [],
      optimizePluginMemory: false,
      pluginCustomStorage: { [rawKey]: value.toString('utf8').slice(1, -1) },
    }
    const databaseBytes = encodeDatabase(database)
    const required = value.length * 3 + databaseBytes.length * 2
    const run = async (available: number) => {
      const server = await trackedServer({
        env: {
          POCKETRISU_PLUGIN_STORAGE_TEST_FAILPOINTS: '1',
          POCKETRISU_PLUGIN_TRANSITION_TEST_AVAILABLE_BYTES: String(available),
        },
        seedSave: async saveDir => seedPublication(saveDir, { database }),
      })
      const client = await createClient(server.port, server.password)
      const live = await readPublication(client)
      const begun = await beginTransition(client, {
        source: sourceOf(live.database, null),
        targetOptimized: true,
        rows: [{ storageKey: valueKey, size: value.length }],
        expectedEtag: live.etag,
      })
      return { server, client, begun }
    }

    const exact = await run(required)
    try {
      expect(exact.begun.response.status).toBe(200)
      expect((await abort(exact.client, exact.begun.transitionId)).status).toBe(200)
    } finally {
      await disposeServer(exact.server)
    }

    const short = await run(required - 1)
    try {
      expect(short.begun.response.status).toBe(413)
      await expect(short.begun.response.json()).resolves.toMatchObject({
        code: 'PLUGIN_STORAGE_DISK_LIMIT',
        limit: required - 1,
        actual: required,
      })
      expect(await readdir(stageDir(short.server))).toEqual([])
    } finally {
      await disposeServer(short.server)
    }
  }, 30_000)

  test('enforces PM1 per-row and aggregate quotas only at atomic staged publication', async () => {
    const run = async (sizes: number[], valueLimit: number, totalLimit: number) => {
      const pluginCustomStorage: Record<string, string> = {}
      const rows = sizes.map((size, index) => {
        const rawKey = `quota/${index}`
        pluginCustomStorage[rawKey] = exactJsonBytes(size, String(index % 10)).toString('utf8').slice(1, -1)
        return {
          storageKey: encodeStorageKey(VALUE_PREFIX, rawKey),
          value: exactJsonBytes(size, String(index % 10)),
        }
      })
      const database = { characters: [], optimizePluginMemory: false, pluginCustomStorage }
      const server = await trackedServer({
        env: {
          POCKETRISU_PLUGIN_VALUE_MAX_BYTES: String(valueLimit),
          POCKETRISU_PLUGIN_STORAGE_MAX_BYTES: String(totalLimit),
        },
        seedSave: async saveDir => seedPublication(saveDir, { database }),
      })
      const client = await createClient(server.port, server.password)
      const live = await readPublication(client)
      const begun = await beginTransition(client, {
        source: sourceOf(live.database, null),
        targetOptimized: true,
        rows: rows.map(row => ({ storageKey: row.storageKey, size: row.value.length })),
        expectedEtag: live.etag,
      })
      expect(begun.response.status).toBe(200)
      await begun.response.arrayBuffer()
      for (const row of rows) {
        expect((await uploadRow(client, begun.transitionId, row.storageKey, row.value)).status)
          .toBe(200)
      }
      return { server, client, begun }
    }

    const exact = await run([40, 60], 60, 100)
    try {
      expect((await finalize(exact.client, exact.begun.transitionId)).status).toBe(200)
      expect(readPluginUsage(exact.server)).toBe(100)
    } finally {
      await disposeServer(exact.server)
    }

    const aggregate = await run([40, 61], 61, 100)
    try {
      const response = await finalize(aggregate.client, aggregate.begun.transitionId)
      expect(response.status).toBe(413)
      await expect(response.json()).resolves.toMatchObject({
        code: 'PLUGIN_STORAGE_TOTAL_TOO_LARGE',
        limit: 100,
        actual: 101,
      })
      expect(readPluginUsage(aggregate.server)).toBe(0)
      expect(readSqliteValue(aggregate.server, MANIFEST_KEY)).toBeNull()
      expect((await abort(aggregate.client, aggregate.begun.transitionId)).status).toBe(200)
    } finally {
      await disposeServer(aggregate.server)
    }

    const perRow = await run([62], 61, 1000)
    try {
      const response = await finalize(perRow.client, perRow.begun.transitionId)
      expect(response.status).toBe(413)
      await expect(response.json()).resolves.toMatchObject({
        code: 'PLUGIN_VALUE_TOO_LARGE',
        limit: 61,
        actual: 62,
      })
      expect(readPluginUsage(perRow.server)).toBe(0)
      expect(readSqliteValue(perRow.server, MANIFEST_KEY)).toBeNull()
      expect((await abort(perRow.client, perRow.begun.transitionId)).status).toBe(200)
    } finally {
      await disposeServer(perRow.server)
    }
  }, 60_000)

  test('cleans partial failed internal begins and resumes a disconnected begin without temp files', async () => {
    const failedGeneration = randomUUID()
    const failedManifest: Manifest = {
      version: 1,
      generation: failedGeneration,
      valueKeys: [0, 1].map(index => encodeStorageKey(VALUE_PREFIX, `large/${index}`)),
      metaKeys: [],
    }
    const failedServer = await trackedServer({
      seedSave: async saveDir => {
        seedSizedOptimizedPublication(saveDir, failedGeneration, [32, 32], true)
      },
    })
    try {
      const client = await createClient(failedServer.port, failedServer.password)
      const live = await readPublication(client)
      const begun = await beginTransition(client, {
        source: sourceOf(live.database, failedManifest),
        targetOptimized: false,
        rows: [],
        expectedEtag: live.etag,
      })
      expect(begun.response.status).toBe(400)
      await begun.response.arrayBuffer()
      expect(await readdir(stageDir(failedServer))).toEqual([])
    } finally {
      await disposeServer(failedServer)
    }

    const disconnectedGeneration = randomUUID()
    const sizes = Array.from({ length: 32 }, () => 1024)
    const disconnectedManifest: Manifest = {
      version: 1,
      generation: disconnectedGeneration,
      valueKeys: sizes.map((_, index) => encodeStorageKey(VALUE_PREFIX, `large/${index}`)),
      metaKeys: [],
    }
    const disconnectedServer = await trackedServer({
      seedSave: async saveDir => {
        seedSizedOptimizedPublication(saveDir, disconnectedGeneration, sizes)
      },
    })
    try {
      const client = await createClient(disconnectedServer.port, disconnectedServer.password)
      const live = await readPublication(client)
      const transitionId = randomUUID()
      const targetGeneration = randomUUID()
      const plan = {
        version: 2,
        transitionId,
        source: sourceOf(live.database, disconnectedManifest),
        targetOptimized: false,
        targetGeneration,
        rows: [],
        expectedEtag: live.etag,
      }
      await disconnectAfterSendingBegin(disconnectedServer, client, plan)

      const retried = await client.fetch('/api/plugin-storage/transition/stage/begin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(plan),
      })
      expect(retried.status).toBe(200)
      await expect(retried.json()).resolves.toMatchObject({ state: 'ready', total: sizes.length })
      const files = await readdir(stageDir(disconnectedServer))
      expect(files.some(name => name.endsWith('.tmp'))).toBe(false)
      expect(files.filter(name => name.endsWith('.row'))).toHaveLength(sizes.length)
      expect((await abort(client, transitionId)).status).toBe(200)
    } finally {
      await disposeServer(disconnectedServer)
    }
  }, 60_000)

  test('sweeps active-stage row temps and receipts on restart', async () => {
    const values = [Buffer.from('"first"'), Buffer.from('"second"')]
    const rawKeys = ['restart/first', 'restart/second']
    const rows = rawKeys.map((rawKey, index) => ({
      storageKey: encodeStorageKey(VALUE_PREFIX, rawKey),
      value: values[index],
    }))
    const database = {
      characters: [],
      optimizePluginMemory: false,
      pluginCustomStorage: Object.fromEntries(rawKeys.map((key, index) => [
        key,
        JSON.parse(values[index].toString('utf8')),
      ])),
    }
    const server = await trackedServer({
      seedSave: async saveDir => seedPublication(saveDir, { database }),
    })
    let client = await createClient(server.port, server.password)
    const live = await readPublication(client)
    const begun = await beginTransition(client, {
      source: sourceOf(live.database, null),
      targetOptimized: true,
      rows: rows.map(row => ({ storageKey: row.storageKey, size: row.value.length })),
      expectedEtag: live.etag,
    })
    expect(begun.response.status).toBe(200)
    await begun.response.arrayBuffer()
    expect((await uploadRow(client, begun.transitionId, rows[0].storageKey, rows[0].value)).status)
      .toBe(200)
    const fakeTemp = `${STAGE_FILE_PREFIX}${begun.transitionId}-0.row.crash.tmp`
    await writeFile(path.join(stageDir(server), fakeTemp), Buffer.from('orphan'))

    await server.restart()
    client = await createClient(server.port, server.password)
    const status = await client.fetch('/api/plugin-storage/transition/stage/status', {
      headers: { 'x-plugin-storage-transition': begun.transitionId },
    })
    expect(status.status).toBe(404)
    expect(await readdir(stageDir(server))).toEqual([])
    expect(readSqliteValue(server, rows[0].storageKey)).toBeNull()
    expect(readSqliteValue(server, MANIFEST_KEY)).toBeNull()
  }, 30_000)

  test('rejects a ready stage after snapshot restore replaces its authoritative source', async () => {
    const rawKey = 'restore/source-binding'
    const valueKey = encodeStorageKey(VALUE_PREFIX, rawKey)
    const currentValue = Buffer.from('{"version":"current"}')
    const snapshotKey = 'database/dbbackup-123456789.bin'
    const currentDatabase = {
      characters: [],
      optimizePluginMemory: false,
      pluginCustomStorage: { [rawKey]: { version: 'current' } },
    }
    const snapshotDatabase = {
      characters: [],
      optimizePluginMemory: false,
      pluginCustomStorage: { [rawKey]: { version: 'snapshot' } },
    }
    const server = await trackedServer({
      seedSave: async saveDir => seedPublication(saveDir, {
        database: currentDatabase,
        rows: [{ key: snapshotKey, value: encodeDatabase(snapshotDatabase) }],
      }),
    })
    const client = await createClient(server.port, server.password)
    const live = await readPublication(client)
    const begun = await beginTransition(client, {
      source: sourceOf(live.database, null),
      targetOptimized: true,
      rows: [{ storageKey: valueKey, size: currentValue.length }],
      expectedEtag: live.etag,
    })
    expect(begun.response.status).toBe(200)
    await begun.response.arrayBuffer()
    expect((await uploadRow(client, begun.transitionId, valueKey, currentValue)).status).toBe(200)

    const restore = await client.fetch('/api/db/snapshots/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: snapshotKey }),
    })
    expect(restore.status).toBe(200)
    await expect(restore.json()).resolves.toMatchObject({
      ok: true,
      key: snapshotKey,
      commitOutcome: 'committed',
      commitOutcomeUnknown: false,
    })

    const rejected = await finalize(client, begun.transitionId)
    expect(rejected.status).toBe(409)
    await expect(rejected.json()).resolves.toMatchObject({
      error: 'Database changed during transition',
    })
    const after = await readPublication(client)
    expect(after.database).toMatchObject(snapshotDatabase)
    expect((await abort(client, begun.transitionId)).status).toBe(200)
  }, 30_000)

  test('preserves stubs and authoritative chat rows in both transition directions', async () => {
    const chaId = 'staged-chat-character'
    const chatId = 'staged-chat'
    const rawKey = 'chat-safe-plugin'
    const valueKey = encodeStorageKey(VALUE_PREFIX, rawKey)
    const value = Buffer.from('{"chatSafe":true}')
    const stub = { id: chatId, name: 'Chat stub', _stub: true, lastDate: 123 }
    const fullChat = {
      id: chatId,
      name: 'Full chat row',
      message: [{ role: 'user', data: 'must survive both transitions' }],
      localLore: [],
    }
    const database = {
      characters: [{ chaId, name: 'Stub holder', chats: [stub] }],
      optimizePluginMemory: false,
      pluginCustomStorage: { [rawKey]: { chatSafe: true } },
    }
    const server = await trackedServer({
      seedSave: async saveDir => seedPublication(saveDir, {
        database,
        chatRows: [{ chaId, chatId, chat: fullChat }],
      }),
    })
    const client = await createClient(server.port, server.password)

    const assertChatState = async (optimized: boolean) => {
      const live = await readPublication(client)
      expect(live.database.optimizePluginMemory).toBe(optimized)
      expect(live.database.characters[0].chats[0]).toEqual(stub)
      expect(live.database.characters[0].chats[0]).not.toHaveProperty('message')
      const chat = await client.fetch(`/api/chat-content/${chaId}/0`, {
        headers: { 'x-chat-id': chatId },
      })
      expect(chat.status).toBe(200)
      expect(decodeRisuDat(Buffer.from(await chat.arrayBuffer()))).toEqual(fullChat)
      return live
    }

    const before = await assertChatState(false)
    const external = await beginTransition(client, {
      source: sourceOf(before.database, null),
      targetOptimized: true,
      rows: [{ storageKey: valueKey, size: value.length }],
      expectedEtag: before.etag,
    })
    expect(external.response.status).toBe(200)
    await external.response.arrayBuffer()
    expect((await uploadRow(client, external.transitionId, valueKey, value)).status).toBe(200)
    expect((await finalize(client, external.transitionId)).status).toBe(200)

    const externalManifest: Manifest = {
      version: 2,
      generation: external.targetGeneration,
      valueKeys: [valueKey],
      metaKeys: [],
    }
    const optimized = await assertChatState(true)
    const internal = await beginTransition(client, {
      source: sourceOf(optimized.database, externalManifest),
      targetOptimized: false,
      rows: [],
      expectedEtag: optimized.etag,
    })
    expect(internal.response.status).toBe(200)
    await internal.response.arrayBuffer()
    expect((await finalize(client, internal.transitionId)).status).toBe(200)
    await assertChatState(false)
  }, 30_000)
})
