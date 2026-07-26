import { afterAll, describe, expect, test } from 'vitest'
import path from 'node:path'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import Database from 'better-sqlite3'
import { Packr } from 'msgpackr'
import { zipSync } from 'fflate'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { decodeBackup } from './helpers/decode.js'
import { encodeBackup } from './helpers/encode.js'
import { decodeRisuDat } from './helpers/normalize.js'

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const PLUGIN_STORAGE_MANIFEST_KEY = 'plugin-storage/manifest.json'
const packr = new Packr({ useRecords: false })
const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

function pluginStorageKey(prefix: 'pluginsave/' | 'pluginsave-meta/', rawKey: string): string {
  return `${prefix}${Buffer.from(rawKey, 'utf-8').toString('base64url')}.json`
}

function encodeRisuDat(database: Record<string, unknown>): Buffer {
  return Buffer.concat([MAGIC_RAW, Buffer.from(packr.encode(database))])
}

function withDatabaseFields(
  backup: Buffer,
  fields: Record<string, unknown>,
): Buffer {
  return encodeBackup(decodeBackup(backup).map((entry) => {
    if (entry.name !== 'database.risudat') return entry
    const database = decodeRisuDat(entry.data)
    Object.assign(database, fields)
    return { ...entry, data: encodeRisuDat(database) }
  }))
}

async function writeKv(client: RisuClient, key: string, value: Buffer): Promise<void> {
  const response = await client.fetch('/api/write', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': Buffer.from(key, 'utf-8').toString('hex'),
    },
    body: new Uint8Array(value),
  })
  expect(response.status).toBe(200)
}

async function writeKvResponse(client: RisuClient, key: string, value: Buffer): Promise<Response> {
  return client.fetch('/api/write', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': Buffer.from(key, 'utf-8').toString('hex'),
    },
    body: new Uint8Array(value),
  })
}

async function importBackupResponse(client: RisuClient, data: Buffer): Promise<Response> {
  const prepared = await client.fetch('/api/backup/import/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ size: data.byteLength }),
  })
  expect(prepared.status).toBe(200)
  return client.fetch('/api/backup/import', {
    method: 'POST',
    headers: { 'content-type': 'application/x-risu-backup' },
    body: new Uint8Array(data),
  })
}

function readKvValue(cwd: string, key: string): Buffer | null {
  const database = new Database(path.join(cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    const row = database.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value: Buffer }
      | undefined
    return row ? Buffer.from(row.value) : null
  } finally {
    database.close()
  }
}

function writeFixtureKvValue(cwd: string, key: string, value: Buffer): void {
  const database = new Database(path.join(cwd, 'save', 'risuai.db'))
  try {
    database.prepare(`
      INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)
    `).run(key, value, Date.now())
  } finally {
    database.close()
  }
}

function listKvKeys(cwd: string, prefix: string): string[] {
  const database = new Database(path.join(cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    return (database.prepare('SELECT key FROM kv WHERE key LIKE ? ORDER BY key').all(`${prefix}%`) as
      Array<{ key: string }>).map(row => row.key)
  } finally {
    database.close()
  }
}

function expectExternalPluginRows(
  cwd: string,
  prefix: 'pluginsave/' | 'pluginsave-meta/',
  values: Record<string, unknown>,
): void {
  for (const [rawKey, value] of Object.entries(values)) {
    const row = readKvValue(cwd, pluginStorageKey(prefix, rawKey))
    expect(row).toEqual(Buffer.from(JSON.stringify(value), 'utf-8'))
    expect(JSON.parse(row!.toString('utf-8'))).toEqual(value)
  }
}

function entriesByName(backup: Buffer): Map<string, Buffer> {
  return new Map(decodeBackup(backup).map(entry => [entry.name, entry.data]))
}

describe('external plugin rows in backup archives', () => {
  test('runtime boundaries agree with Node backup export and import for long identifiers', async () => {
    const source = await spawnServer()
    servers.push(source)
    const sourceClient = await createClient(source.port, source.password)
    const seed = withDatabaseFields(createSeedBackup({ characterCount: 1 }), {
      optimizePluginMemory: true,
      pluginCustomStorage: {},
    })
    expect((await sourceClient.importBackup(seed)).ok).toBe(true)

    const maxOwnedRawKey = 'o'.repeat(752)
    const maxValueOnlyRawKey = 'v'.repeat(756)
    const maxOwnedValueKey = pluginStorageKey('pluginsave/', maxOwnedRawKey)
    const maxOwnedMetaKey = pluginStorageKey('pluginsave-meta/', maxOwnedRawKey)
    const maxValueOnlyKey = pluginStorageKey('pluginsave/', maxValueOnlyRawKey)
    expect(Buffer.byteLength(maxOwnedMetaKey, 'utf-8')).toBe(1024)
    expect(Buffer.byteLength(maxValueOnlyKey, 'utf-8')).toBe(1024)

    await writeKv(sourceClient, maxOwnedValueKey, Buffer.from('{"long":"identifier"}'))
    await writeKv(sourceClient, maxOwnedMetaKey, Buffer.from('{"plugin":"Boundary","updatedAt":1}'))
    await writeKv(sourceClient, maxValueOnlyKey, Buffer.from('"value-only-maximum"'))

    const oversizedValueKey = pluginStorageKey('pluginsave/', 'x'.repeat(757))
    const oversizedMetaKey = pluginStorageKey('pluginsave-meta/', 'x'.repeat(753))
    const oversizedValueResponse = await writeKvResponse(
      sourceClient,
      oversizedValueKey,
      Buffer.from('1'),
    )
    const oversizedMetaResponse = await writeKvResponse(
      sourceClient,
      oversizedMetaKey,
      Buffer.from('{}'),
    )
    expect(oversizedValueResponse.status).toBe(400)
    expect(oversizedMetaResponse.status).toBe(400)
    expect(readKvValue(source.cwd, oversizedValueKey)).toBeNull()
    expect(readKvValue(source.cwd, oversizedMetaKey)).toBeNull()

    const nodeBackup = await sourceClient.exportBackup()
    const nodeEntries = entriesByName(nodeBackup)
    expect(nodeEntries.get(maxOwnedValueKey)).toEqual(Buffer.from('{"long":"identifier"}'))
    expect(nodeEntries.get(maxOwnedMetaKey)).toEqual(Buffer.from('{"plugin":"Boundary","updatedAt":1}'))
    expect(nodeEntries.get(maxValueOnlyKey)).toEqual(Buffer.from('"value-only-maximum"'))

    const destination = await spawnServer()
    servers.push(destination)
    const destinationClient = await createClient(destination.port, destination.password)
    expect((await destinationClient.importBackup(nodeBackup)).ok).toBe(true)
    expect(readKvValue(destination.cwd, maxOwnedValueKey)).toEqual(Buffer.from('{"long":"identifier"}'))
    expect(readKvValue(destination.cwd, maxOwnedMetaKey)).toEqual(Buffer.from('{"plugin":"Boundary","updatedAt":1}'))
    expect(readKvValue(destination.cwd, maxValueOnlyKey)).toEqual(Buffer.from('"value-only-maximum"'))
  })

  test('exports quarantine an unowned oversized physical row', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const oversizedKey = pluginStorageKey('pluginsave-meta/', 'legacy'.repeat(126))
    expect(Buffer.byteLength(oversizedKey, 'utf-8')).toBeGreaterThan(1024)

    const sqlite = new Database(path.join(server.cwd, 'save', 'risuai.db'))
    try {
      sqlite.prepare(
        'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
      ).run(oversizedKey, Buffer.from('{}'), Date.now())
    } finally {
      sqlite.close()
    }

    const exportResponse = await client.fetch('/api/backup/export')
    expect(exportResponse.status).toBe(200)
    const exported = entriesByName(Buffer.from(await exportResponse.arrayBuffer()))
    expect(exported.has(oversizedKey)).toBe(false)

    const backupsPath = path.join(server.cwd, 'backups')
    const saveResponse = await client.fetch('/api/backup/server/save', { method: 'POST' })
    expect(saveResponse.status).toBe(200)
    await saveResponse.text()
    expect((await readdir(backupsPath)).length).toBeGreaterThan(0)
  })

  test('Node-only exports and server saves stream rows, upstream folds them, and import restores bytes', async () => {
    const source = await spawnServer()
    servers.push(source)
    const sourceClient = await createClient(source.port, source.password)
    const seed = withDatabaseFields(createSeedBackup({ characterCount: 1 }), {
      optimizePluginMemory: true,
      pluginCustomStorage: {},
    })
    expect((await sourceClient.importBackup(seed)).ok).toBe(true)

    const valueRows = new Map<string, Buffer>([
      [pluginStorageKey('pluginsave/', 'plain/key'), Buffer.from('{"value":1}')],
      [pluginStorageKey('pluginsave/', '유니코드 키'), Buffer.from('["alpha",2]')],
    ])
    const metaRows = new Map<string, Buffer>([
      [pluginStorageKey('pluginsave-meta/', 'plain/key'), Buffer.from('{"plugin":"Plugin A","updatedAt":10}')],
      [pluginStorageKey('pluginsave-meta/', '유니코드 키'), Buffer.from('{"plugin":"Plugin B","updatedAt":20}')],
    ])
    for (const [key, value] of [...valueRows, ...metaRows]) {
      await writeKv(sourceClient, key, value)
    }
    const storageGeneration = 'node-backup-generation'
    const storageManifest = Buffer.from(JSON.stringify({
      version: 1,
      generation: storageGeneration,
      valueKeys: [...valueRows.keys()],
      metaKeys: [...metaRows.keys()],
    }))
    const sourceDatabase = decodeRisuDat(readKvValue(source.cwd, 'database/database.bin')!)
    const transitionResponse = await sourceClient.fetch('/api/plugin-storage/transition', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(encodeRisuDat({
        version: 1,
        source: { optimized: true, generation: null, manifest: null },
        database: encodeRisuDat({
          ...sourceDatabase,
          optimizePluginMemory: true,
          pluginStorageGeneration: storageGeneration,
          pluginCustomStorage: Object.fromEntries(
            [...valueRows].map(([key, value]) => [
              Buffer.from(key.slice('pluginsave/'.length, -'.json'.length), 'base64url')
                .toString('utf-8'),
              JSON.parse(value.toString('utf-8')),
            ]),
          ),
          pluginStorageMeta: Object.fromEntries(
            [...metaRows].map(([key, value]) => [
              Buffer.from(key.slice('pluginsave-meta/'.length, -'.json'.length), 'base64url')
                .toString('utf-8'),
              JSON.parse(value.toString('utf-8')),
            ]),
          ),
        }),
      })),
    })
    expect(transitionResponse.status).toBe(200)
    expect(readKvValue(source.cwd, PLUGIN_STORAGE_MANIFEST_KEY)).toEqual(storageManifest)
    const foreignValueKey = pluginStorageKey('pluginsave/', 'foreign-row')
    const foreignMetaKey = pluginStorageKey('pluginsave-meta/', 'foreign-row')
    // These simulate pre-fix/untrusted physical leftovers. Generated
    // publications now reserve the entire generic pluginsave namespace, so a
    // live client cannot create unlisted rows through /api/write anymore.
    writeFixtureKvValue(source.cwd, foreignValueKey, Buffer.from('"quarantined"'))
    writeFixtureKvValue(source.cwd, foreignMetaKey, Buffer.from('{"plugin":"Foreign"}'))

    const nodeResponse = await sourceClient.fetch('/api/backup/export')
    expect(nodeResponse.status).toBe(200)
    const declaredLength = Number(nodeResponse.headers.get('content-length'))
    const nodeBackup = Buffer.from(await nodeResponse.arrayBuffer())
    expect(declaredLength).toBe(nodeBackup.length)

    const nodeEntries = entriesByName(nodeBackup)
    for (const [key, value] of [...valueRows, ...metaRows]) {
      expect(nodeEntries.get(key)).toEqual(value)
    }
    expect(nodeEntries.get(PLUGIN_STORAGE_MANIFEST_KEY)).toEqual(storageManifest)
    expect(nodeEntries.has(foreignValueKey)).toBe(false)
    expect(nodeEntries.has(foreignMetaKey)).toBe(false)
    const nodeDatabase = decodeRisuDat(nodeEntries.get('database.risudat')!)
    expect(nodeDatabase.pluginCustomStorage).toEqual({})
    expect(nodeDatabase.pluginStorageMeta).toBeUndefined()
    expect(nodeDatabase.pluginStorageGeneration).toBe(storageGeneration)

    const upstreamResponse = await sourceClient.fetch('/api/backup/export?target=upstream')
    expect(upstreamResponse.status).toBe(200)
    const upstreamBackup = Buffer.from(await upstreamResponse.arrayBuffer())
    expect(Number(upstreamResponse.headers.get('content-length'))).toBe(upstreamBackup.length)
    const upstreamEntries = decodeBackup(upstreamBackup)
    expect(upstreamEntries.some(entry => entry.name.startsWith('pluginsave/'))).toBe(false)
    expect(upstreamEntries.some(entry => entry.name.startsWith('pluginsave-meta/'))).toBe(false)
    expect(upstreamEntries.some(entry => entry.name === PLUGIN_STORAGE_MANIFEST_KEY)).toBe(false)
    const upstreamDatabase = decodeRisuDat(
      upstreamEntries.find(entry => entry.name === 'database.risudat')!.data,
    )
    expect(upstreamDatabase.pluginCustomStorage).toEqual({
      'plain/key': { value: 1 },
      '유니코드 키': ['alpha', 2],
    })
    expect(upstreamDatabase.pluginStorageMeta).toEqual({
      'plain/key': { plugin: 'Plugin A', updatedAt: 10 },
      '유니코드 키': { plugin: 'Plugin B', updatedAt: 20 },
    })
    expect(upstreamDatabase.pluginCustomStorage['foreign-row']).toBeUndefined()
    expect(upstreamDatabase.pluginStorageGeneration).toBe(storageGeneration)

    const upstreamDestination = await spawnServer()
    servers.push(upstreamDestination)
    const upstreamDestinationClient = await createClient(
      upstreamDestination.port,
      upstreamDestination.password,
    )
    expect((await upstreamDestinationClient.importBackup(upstreamBackup)).ok).toBe(true)
    expectExternalPluginRows(upstreamDestination.cwd, 'pluginsave/', {
      'plain/key': { value: 1 },
      '유니코드 키': ['alpha', 2],
    })
    expectExternalPluginRows(upstreamDestination.cwd, 'pluginsave-meta/', {
      'plain/key': { plugin: 'Plugin A', updatedAt: 10 },
      '유니코드 키': { plugin: 'Plugin B', updatedAt: 20 },
    })
    const upstreamStoredDatabase = decodeRisuDat(
      readKvValue(upstreamDestination.cwd, 'database/database.bin')!,
    )
    expect(upstreamStoredDatabase.pluginCustomStorage).toEqual({})
    expect(upstreamStoredDatabase.pluginStorageMeta).toBeUndefined()

    const saveResponse = await sourceClient.fetch('/api/backup/server/save', { method: 'POST' })
    expect(saveResponse.status).toBe(200)
    const saveEvents = (await saveResponse.text())
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
    const done = saveEvents.find(event => event.type === 'done') as
      | { filename: string; size: number }
      | undefined
    const finalProgress = [...saveEvents].reverse().find(event => event.type === 'progress') as
      | { current: number; total: number; bytes: number; totalBytes: number }
      | undefined
    expect(done).toBeTruthy()
    expect(finalProgress).toBeTruthy()
    const downloadResponse = await sourceClient.fetch(`/api/backup/server/download/${done!.filename}`)
    expect(downloadResponse.status).toBe(200)
    const savedBackup = Buffer.from(await downloadResponse.arrayBuffer())
    expect(done!.size).toBe(savedBackup.length)
    expect(finalProgress).toMatchObject({
      current: finalProgress!.total,
      bytes: savedBackup.length,
      totalBytes: savedBackup.length,
    })
    const savedEntries = entriesByName(savedBackup)
    for (const [key, value] of [...valueRows, ...metaRows]) {
      expect(savedEntries.get(key)).toEqual(value)
    }
    expect(decodeRisuDat(savedEntries.get('database.risudat')!).pluginCustomStorage).toEqual({})

    const destination = await spawnServer()
    servers.push(destination)
    const destinationClient = await createClient(destination.port, destination.password)
    expect((await destinationClient.importBackup(createSeedBackup({
      databaseFields: {
        optimizePluginMemory: true,
        pluginCustomStorage: {},
      },
    }))).ok).toBe(true)
    const staleKey = pluginStorageKey('pluginsave/', 'stale')
    await writeKv(destinationClient, staleKey, Buffer.from('"stale"'))

    expect((await destinationClient.importBackup(nodeBackup)).ok).toBe(true)
    expect(readKvValue(destination.cwd, staleKey)).toBeNull()
    for (const [key, value] of [...valueRows, ...metaRows]) {
      expect(readKvValue(destination.cwd, key)).toEqual(value)
    }
    expect(readKvValue(destination.cwd, PLUGIN_STORAGE_MANIFEST_KEY))
      .toEqual(storageManifest)
    const storedDatabase = decodeRisuDat(readKvValue(destination.cwd, 'database/database.bin')!)
    expect(storedDatabase.pluginCustomStorage).toEqual({})
    expect(storedDatabase.pluginStorageMeta).toBeUndefined()
    expect(storedDatabase.pluginStorageGeneration).toBe(storageGeneration)
  })

  test('legacy optimized backups externalize folded plugin storage and clear stale rows', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    expect((await client.importBackup(createSeedBackup({
      databaseFields: {
        optimizePluginMemory: true,
        pluginCustomStorage: {},
      },
    }))).ok).toBe(true)
    const staleValueKey = pluginStorageKey('pluginsave/', 'stale')
    const staleMetaKey = pluginStorageKey('pluginsave-meta/', 'stale')
    await writeKv(client, staleValueKey, Buffer.from('1'))
    await writeKv(client, staleMetaKey, Buffer.from('{}'))

    const legacyValues = {
      'legacy/key': { nested: ['value'], enabled: true },
      '유니코드 키': ['alpha', 2],
    }
    const legacyMeta = {
      'legacy/key': { plugin: 'Legacy Plugin', updatedAt: 123 },
      '유니코드 키': { plugin: 'Unicode Plugin', updatedAt: 456 },
    }
    const legacyBackup = withDatabaseFields(createSeedBackup(), {
      optimizePluginMemory: true,
      pluginCustomStorage: legacyValues,
      pluginStorageMeta: legacyMeta,
    })
    expect((await client.importBackup(legacyBackup)).ok).toBe(true)

    expect(readKvValue(server.cwd, staleValueKey)).toBeNull()
    expect(readKvValue(server.cwd, staleMetaKey)).toBeNull()
    expectExternalPluginRows(server.cwd, 'pluginsave/', legacyValues)
    expectExternalPluginRows(server.cwd, 'pluginsave-meta/', legacyMeta)
    const storedDatabase = decodeRisuDat(readKvValue(server.cwd, 'database/database.bin')!)
    expect(storedDatabase.pluginCustomStorage).toEqual({})
    expect(storedDatabase.pluginStorageMeta).toBeUndefined()
    expect((storedDatabase.characters as Array<any>)[0].chats[0]).toMatchObject({
      id: 'chat-0-0',
      _stub: true,
    })
    expect((storedDatabase.characters as Array<any>)[0].chats[0].message).toBeUndefined()

    const exported = await client.exportBackup()
    const exportedEntries = decodeBackup(exported)
    expect(exportedEntries.some(entry => entry.name.startsWith('pluginsave/'))).toBe(true)
    expect(exportedEntries.some(entry => entry.name.startsWith('pluginsave-meta/'))).toBe(true)
    const exportedDatabase = decodeRisuDat(
      exportedEntries.find(entry => entry.name === 'database.risudat')!.data,
    )
    expect(exportedDatabase.pluginCustomStorage).toEqual({})
    expect(exportedDatabase.pluginStorageMeta).toBeUndefined()
  })

  test('legacy inline-mode backups retain folded plugin storage and create no rows', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const legacyValues = { inline: { nested: ['value'] } }
    const legacyMeta = { inline: { plugin: 'Inline Plugin', updatedAt: 123 } }
    const legacyBackup = withDatabaseFields(createSeedBackup(), {
      optimizePluginMemory: false,
      pluginCustomStorage: legacyValues,
      pluginStorageMeta: legacyMeta,
    })

    expect((await client.importBackup(legacyBackup)).ok).toBe(true)

    expect(listKvKeys(server.cwd, 'pluginsave/')).toEqual([])
    expect(listKvKeys(server.cwd, 'pluginsave-meta/')).toEqual([])
    const storedDatabase = decodeRisuDat(readKvValue(server.cwd, 'database/database.bin')!)
    expect(storedDatabase.pluginCustomStorage).toEqual(legacyValues)
    expect(storedDatabase.pluginStorageMeta).toEqual(legacyMeta)
  })

  test('backup import rejects non-canonical plugin row names', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const invalidBackup = Buffer.concat([
      createSeedBackup(),
      encodeBackup([{
        name: 'pluginsave/YQ==.json',
        data: Buffer.from('1'),
      }]),
    ])

    const result = await client.importBackup(invalidBackup)
    expect(result.ok).not.toBe(true)
    expect(result.error).toBe('Invalid plugin storage JSON row')
    expect(result.error).not.toContain('YQ==')
    expect(readKvValue(server.cwd, 'database/database.bin')).toBeNull()
  })

  test('invalid small folded databases roll back backup and save-folder replacements', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const oldDatabase = encodeRisuDat({
      characters: [],
      optimizePluginMemory: true,
      pluginCustomStorage: {},
      durableMarker: 'old-database',
    })
    const oldValueKey = pluginStorageKey('pluginsave/', 'old-value')
    const oldMetaKey = pluginStorageKey('pluginsave-meta/', 'old-value')
    const oldValue = Buffer.from('{"durable":"old-value"}')
    const oldMeta = Buffer.from('{"plugin":"Old Plugin","updatedAt":1}')
    await writeKv(client, 'database/database.bin', oldDatabase)
    await writeKv(client, oldValueKey, oldValue)
    await writeKv(client, oldMetaKey, oldMeta)

    const persistedOldDatabase = readKvValue(server.cwd, 'database/database.bin')
    const invalidDatabase = encodeRisuDat({
      characters: [],
      optimizePluginMemory: true,
      pluginStorageFolded: true,
      // Non-stream snapshotOptimizedPluginStorageFields rejects an array even
      // when it is empty; the streaming path must have identical semantics.
      pluginCustomStorage: [],
    })
    const diagnostic = {
      error: 'Invalid plugin storage JSON row',
      code: 'INVALID_PLUGIN_STORAGE_ROW',
      encodedKey: 'pluginsave/',
    }
    const assertOldState = () => {
      expect(readKvValue(server.cwd, 'database/database.bin')).toEqual(persistedOldDatabase)
      expect(readKvValue(server.cwd, oldValueKey)).toEqual(oldValue)
      expect(readKvValue(server.cwd, oldMetaKey)).toEqual(oldMeta)
    }

    const backupResponse = await importBackupResponse(client, encodeBackup([{
      name: 'database.risudat',
      data: invalidDatabase,
    }]))
    expect(backupResponse.status).toBe(400)
    await expect(backupResponse.json()).resolves.toEqual(diagnostic)
    assertOldState()

    const sourceDir = path.join(server.cwd, 'invalid-small-folded-save')
    const databaseHexName = Buffer.from('database/database.bin', 'utf-8').toString('hex')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(path.join(sourceDir, databaseHexName), invalidDatabase)
    const folderResponse = await client.fetch('/api/migrate/save-folder/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: sourceDir }),
    })
    expect(folderResponse.status).toBe(400)
    await expect(folderResponse.json()).resolves.toEqual(diagnostic)
    assertOldState()
  })

  test('save-folder scan, directory import, and ZIP upload preserve external plugin rows', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const databaseValue = decodeBackup(withDatabaseFields(createSeedBackup(), {
      pluginCustomStorage: {},
    })).find(entry => entry.name === 'database.risudat')!.data
    const hexName = (key: string) => Buffer.from(key, 'utf-8').toString('hex')

    const directoryValueKey = pluginStorageKey('pluginsave/', 'directory')
    const directoryMetaKey = pluginStorageKey('pluginsave-meta/', 'directory')
    const directoryValue = Buffer.from('{"from":"directory"}')
    const directoryMeta = Buffer.from('{"plugin":"Directory","updatedAt":1}')
    const sourceDir = path.join(server.cwd, 'plugin-save-source')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(path.join(sourceDir, hexName('database/database.bin')), databaseValue)
    await writeFile(path.join(sourceDir, hexName(directoryValueKey)), directoryValue)
    await writeFile(path.join(sourceDir, hexName(directoryMetaKey)), directoryMeta)

    const scanResponse = await client.fetch('/api/migrate/save-folder/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: sourceDir }),
    })
    expect(scanResponse.status).toBe(200)
    expect(await scanResponse.json()).toMatchObject({ count: 3, hasDatabase: true })

    const directoryResponse = await client.fetch('/api/migrate/save-folder/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: sourceDir }),
    })
    expect(directoryResponse.status).toBe(200)
    expect(readKvValue(server.cwd, directoryValueKey)).toEqual(directoryValue)
    expect(readKvValue(server.cwd, directoryMetaKey)).toEqual(directoryMeta)

    const zipValueKey = pluginStorageKey('pluginsave/', 'zip')
    const zipMetaKey = pluginStorageKey('pluginsave-meta/', 'zip')
    const zipValue = Buffer.from('{"from":"zip"}')
    const zipMeta = Buffer.from('{"plugin":"Zip","updatedAt":2}')
    const zip = Buffer.from(zipSync({
      [hexName('database/database.bin')]: new Uint8Array(databaseValue),
      [hexName(zipValueKey)]: new Uint8Array(zipValue),
      [hexName(zipMetaKey)]: new Uint8Array(zipMeta),
    }))
    const uploadResponse = await client.fetch('/api/migrate/save-folder/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/zip' },
      body: new Uint8Array(zip),
    })
    expect(uploadResponse.status).toBe(200)
    expect(readKvValue(server.cwd, directoryValueKey)).toBeNull()
    expect(readKvValue(server.cwd, directoryMetaKey)).toBeNull()
    expect(readKvValue(server.cwd, zipValueKey)).toEqual(zipValue)
    expect(readKvValue(server.cwd, zipMetaKey)).toEqual(zipMeta)
  })

  test('save-folder import externalizes a folded optimized monolith', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const legacyValues = { 'save-folder/key': { from: 'directory', count: 3 } }
    const legacyMeta = {
      'save-folder/key': { plugin: 'Save Folder Plugin', updatedAt: 789 },
    }
    const databaseValue = decodeBackup(withDatabaseFields(createSeedBackup(), {
      optimizePluginMemory: true,
      pluginCustomStorage: legacyValues,
      pluginStorageMeta: legacyMeta,
    })).find(entry => entry.name === 'database.risudat')!.data
    const sourceDir = path.join(server.cwd, 'folded-plugin-save-source')
    const databaseHexName = Buffer.from('database/database.bin', 'utf-8').toString('hex')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(path.join(sourceDir, databaseHexName), databaseValue)

    const response = await client.fetch('/api/migrate/save-folder/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: sourceDir }),
    })
    expect(response.status).toBe(200)
    expectExternalPluginRows(server.cwd, 'pluginsave/', legacyValues)
    expectExternalPluginRows(server.cwd, 'pluginsave-meta/', legacyMeta)
    const storedDatabase = decodeRisuDat(readKvValue(server.cwd, 'database/database.bin')!)
    expect(storedDatabase.pluginCustomStorage).toEqual({})
    expect(storedDatabase.pluginStorageMeta).toBeUndefined()
  })

  test('/api/write externalizes folded optimized plugin storage defensively', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const legacyValues = { 'write/key': { from: 'full-write' } }
    const legacyMeta = { 'write/key': { plugin: 'Write Plugin', updatedAt: 654 } }
    const databaseValue = decodeBackup(withDatabaseFields(createSeedBackup(), {
      optimizePluginMemory: true,
      pluginCustomStorage: legacyValues,
      pluginStorageMeta: legacyMeta,
    })).find(entry => entry.name === 'database.risudat')!.data

    await writeKv(client, 'database/database.bin', databaseValue)

    expectExternalPluginRows(server.cwd, 'pluginsave/', legacyValues)
    expectExternalPluginRows(server.cwd, 'pluginsave-meta/', legacyMeta)
    const storedDatabase = decodeRisuDat(readKvValue(server.cwd, 'database/database.bin')!)
    expect(storedDatabase.pluginCustomStorage).toEqual({})
    expect(storedDatabase.pluginStorageMeta).toBeUndefined()
  })

  test('boot externalizes folded optimized plugin storage seeded directly in SQLite', async () => {
    const legacyValues = { 'boot/key': { nested: ['boot'], enabled: true } }
    const legacyMeta = { 'boot/key': { plugin: 'Boot Plugin', updatedAt: 987 } }
    const databaseValue = decodeBackup(withDatabaseFields(createSeedBackup(), {
      optimizePluginMemory: true,
      pluginCustomStorage: legacyValues,
      pluginStorageMeta: legacyMeta,
    })).find(entry => entry.name === 'database.risudat')!.data

    const server = await spawnServer({
      seedSave: async (saveDir) => {
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
          ).run('database/database.bin', databaseValue, Date.now())
          database.prepare(
            'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
          ).run(
            pluginStorageKey('pluginsave/', 'boot/key'),
            Buffer.from(JSON.stringify({ stale: true }), 'utf-8'),
            Date.now(),
          )
          database.prepare(
            'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
          ).run(
            pluginStorageKey('pluginsave-meta/', 'boot/key'),
            Buffer.from(JSON.stringify({ plugin: 'Stale Plugin', updatedAt: 1 }), 'utf-8'),
            Date.now(),
          )
        } finally {
          database.close()
        }
      },
    })
    servers.push(server)

    expectExternalPluginRows(server.cwd, 'pluginsave/', legacyValues)
    expectExternalPluginRows(server.cwd, 'pluginsave-meta/', legacyMeta)
    const storedDatabase = decodeRisuDat(readKvValue(server.cwd, 'database/database.bin')!)
    expect(storedDatabase.pluginCustomStorage).toEqual({})
    expect(storedDatabase.pluginStorageMeta).toBeUndefined()
  })
})
