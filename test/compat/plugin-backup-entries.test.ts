import { afterAll, describe, expect, test } from 'vitest'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import Database from 'better-sqlite3'
import { Packr } from 'msgpackr'
import { zipSync } from 'fflate'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { decodeBackup } from './helpers/decode.js'
import { encodeBackup } from './helpers/encode.js'
import { decodeRisuDat } from './helpers/normalize.js'
import utilsPkg from '../../server/node/utils.cjs'
import pluginSaveKeysPkg from '../../server/node/pluginSaveKeys.cjs'

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const PLUGIN_TRANSITION_MAGIC = Buffer.from('PRISUT01', 'ascii')
const PLUGIN_TRANSITION_PREFIX_BYTES = 12
const PLUGIN_STORAGE_MANIFEST_KEY = 'plugin-storage/manifest.json'
const packr = new Packr({ useRecords: false })
const pluginTransitionPackr = new Packr({ structuredClone: true, useRecords: true })
const { decodeRisuSave } = utilsPkg as {
  decodeRisuSave: (value: Uint8Array) => Promise<any>
}
const { encodePluginSaveStorageKey } = pluginSaveKeysPkg as {
  encodePluginSaveStorageKey: (rawKey: string, prefix: string) => string
}
const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

function upstreamV190AcceptsRisuSaveHeader(bytes: Uint8Array): boolean {
  const legacyMagic = [0, 82, 73, 83, 85, 83, 65, 86, 69, 0]
  const blockMagic = [82, 73, 83, 85, 83, 65, 86, 69, 0]
  return (
    bytes.length >= legacyMagic.length + 1
    && legacyMagic.every((byte, index) => bytes[index] === byte)
    && (bytes[legacyMagic.length] === 7
      || bytes[legacyMagic.length] === 8
      || bytes[legacyMagic.length] === 9)
  ) || (
    bytes.length >= blockMagic.length
    && blockMagic.every((byte, index) => bytes[index] === byte)
  )
}

function pluginStorageKey(prefix: 'pluginsave/' | 'pluginsave-meta/', rawKey: string): string {
  // Some boundary tests intentionally construct an oversized legacy physical
  // row that the canonical writer must reject. Only malformed UTF-16 keys need
  // the new tagged codec; well-formed rows retain their historical encoding.
  return rawKey.isWellFormed()
    ? `${prefix}${Buffer.from(rawKey).toString('base64url')}.json`
    : encodePluginSaveStorageKey(rawKey, prefix)
}

async function commitBulkPluginStorageTransition(
  client: RisuClient,
  source: { optimized: boolean; generation: string | null; manifest: unknown },
  targetDatabase: Record<string, any>,
): Promise<Response> {
  const rows = targetDatabase.optimizePluginMemory === true
    ? [
        ...Object.entries(targetDatabase.pluginCustomStorage ?? {}).map(([rawKey, value]) => ({
          rawKey,
          storageKey: pluginStorageKey('pluginsave/', rawKey),
          value,
        })),
        ...Object.entries(targetDatabase.pluginStorageMeta ?? {}).map(([rawKey, value]) => ({
          rawKey,
          storageKey: pluginStorageKey('pluginsave-meta/', rawKey),
          value,
        })),
      ]
    : []
  const payloads = rows.map(({ value }) => Buffer.from(pluginTransitionPackr.encode(value)))
  const metadataBytes = Buffer.from(JSON.stringify({
    version: 1,
    transitionId: randomUUID(),
    source,
    targetOptimized: targetDatabase.optimizePluginMemory === true,
    targetGeneration: targetDatabase.pluginStorageGeneration,
    autoConvert: true,
    rows: rows.map(({ rawKey, storageKey }, index) => ({
      rawKey,
      storageKey,
      valueLength: payloads[index].length,
      valueHash: createHash('sha256').update(payloads[index]).digest('hex'),
    })),
  }), 'utf8')
  const prefix = Buffer.alloc(PLUGIN_TRANSITION_PREFIX_BYTES)
  PLUGIN_TRANSITION_MAGIC.copy(prefix)
  prefix.writeUInt32BE(metadataBytes.length, PLUGIN_TRANSITION_MAGIC.length)
  const body = Buffer.concat([prefix, metadataBytes, ...payloads])
  return client.fetch('/api/plugin-storage/transition/bulk', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-pocketrisu-plugin-storage-transition',
      'x-plugin-storage-transition-length': String(body.length),
    },
    body: new Uint8Array(body),
  })
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

async function mutatePluginValueResponse(
  client: RisuClient,
  generation: string,
  valueKey: string,
  value: Buffer,
  ownerRecord?: Buffer,
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'file-path': Buffer.from(valueKey, 'utf-8').toString('hex'),
    'x-plugin-storage-operation': 'set',
    'x-plugin-storage-generation': generation,
    'x-plugin-storage-owner': '',
  }
  if (ownerRecord) {
    headers['x-plugin-storage-owner-policy'] = 'record'
    headers['x-plugin-storage-owner-record'] = ownerRecord.toString('base64url')
  }
  return client.fetch('/api/plugin-storage/mutate', {
    method: 'POST',
    headers,
    body: new Uint8Array(value),
  })
}

async function mutatePluginValue(
  client: RisuClient,
  generation: string,
  valueKey: string,
  value: Buffer,
  ownerRecord?: Buffer,
): Promise<void> {
  const response = await mutatePluginValueResponse(
    client,
    generation,
    valueKey,
    value,
    ownerRecord,
  )
  expect(response.status).toBe(200)
  await response.text()
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

type PartialExportStatus = {
  state: string
  phase: string
  current: number
  total: number
  bytes: number
  error?: string
}

async function startPartialExport(client: RisuClient): Promise<string> {
  const response = await client.fetch('/api/backup/export/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'partial', jobId: randomUUID() }),
  })
  expect(response.status).toBe(202)
  const body = await response.json() as { jobId: string }
  expect(body.jobId).toMatch(/^[0-9a-f-]{36}$/)
  return body.jobId
}

async function waitForPartialExport(
  client: RisuClient,
  jobId: string,
  predicate: (status: PartialExportStatus) => boolean,
  timeoutMs = 30_000,
): Promise<PartialExportStatus> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await client.fetch(`/api/backup/export/jobs/${jobId}`)
    expect(response.status).toBe(200)
    const status = await response.json() as PartialExportStatus
    if (predicate(status)) return status
    if (status.state === 'failed' || status.state === 'cancelled') {
      throw new Error(status.error || `Partial export ${status.state}`)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for partial export job ${jobId}`)
}

async function downloadPartialExport(client: RisuClient, jobId: string): Promise<Buffer> {
  await waitForPartialExport(client, jobId, status => status.state === 'ready')
  const response = await client.fetch(`/api/backup/export/jobs/${jobId}/download`)
  expect(response.status).toBe(200)
  const backup = Buffer.from(await response.arrayBuffer())
  expect(Number(response.headers.get('content-length'))).toBe(backup.length)
  return backup
}

async function waitForNoPartialExportSpools(cwd: string): Promise<void> {
  const spoolDir = path.join(cwd, 'save', '.partial-export-spool')
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const entries = await readdir(spoolDir).catch(() => [])
    if (!entries.some(entry => entry.startsWith('.partial-export-'))) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Partial export spool was not cleaned')
}

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await readFile(filePath)
      return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${filePath}`)
}

describe('external plugin rows in backup archives', () => {
  test('runtime boundaries agree with Node backup export and import for long identifiers', async () => {
    const source = await spawnServer()
    servers.push(source)
    const sourceClient = await createClient(source.port, source.password)
    const seedGeneration = 'backup-boundary-generation'
    const seedEntries = decodeBackup(withDatabaseFields(createSeedBackup({ characterCount: 1 }), {
      optimizePluginMemory: true,
      pluginStorageGeneration: seedGeneration,
      pluginCustomStorage: {},
    }))
    seedEntries.push({
      name: PLUGIN_STORAGE_MANIFEST_KEY,
      data: Buffer.from(JSON.stringify({
        version: 1,
        generation: seedGeneration,
        valueKeys: [],
        metaKeys: [],
      })),
    })
    expect((await sourceClient.importBackup(encodeBackup(seedEntries))).ok).toBe(true)
    const activeDatabase = decodeRisuDat(readKvValue(source.cwd, 'database/database.bin')!)
    expect(activeDatabase.pluginStorageGeneration).toBe(seedGeneration)
    const activeGeneration = activeDatabase.pluginStorageGeneration as string

    const maxOwnedRawKey = 'o'.repeat(752)
    const maxValueOnlyRawKey = 'v'.repeat(756)
    const maxOwnedValueKey = pluginStorageKey('pluginsave/', maxOwnedRawKey)
    const maxOwnedMetaKey = pluginStorageKey('pluginsave-meta/', maxOwnedRawKey)
    const maxValueOnlyKey = pluginStorageKey('pluginsave/', maxValueOnlyRawKey)
    const maxOwnedValue = Buffer.from('{"long":"identifier"}')
    const maxOwnedMeta = Buffer.from('{"plugin":"Boundary","updatedAt":1}')
    const maxValueOnly = Buffer.from('"value-only-maximum"')
    expect(Buffer.byteLength(maxOwnedMetaKey, 'utf-8')).toBe(1024)
    expect(Buffer.byteLength(maxValueOnlyKey, 'utf-8')).toBe(1024)

    const genericWriteResponse = await writeKvResponse(
      sourceClient,
      maxOwnedValueKey,
      maxOwnedValue,
    )
    expect(genericWriteResponse.status).toBe(409)
    await genericWriteResponse.text()
    await mutatePluginValue(
      sourceClient,
      activeGeneration,
      maxOwnedValueKey,
      maxOwnedValue,
      maxOwnedMeta,
    )
    await mutatePluginValue(
      sourceClient,
      activeGeneration,
      maxValueOnlyKey,
      maxValueOnly,
    )

    const oversizedValueKey = pluginStorageKey('pluginsave/', 'x'.repeat(757))
    const oversizedMetaKey = pluginStorageKey('pluginsave-meta/', 'x'.repeat(753))
    const oversizedValueResponse = await mutatePluginValueResponse(
      sourceClient,
      activeGeneration,
      oversizedValueKey,
      Buffer.from('1'),
    )
    const oversizedMetaResponse = await mutatePluginValueResponse(
      sourceClient,
      activeGeneration,
      pluginStorageKey('pluginsave/', 'x'.repeat(753)),
      Buffer.from('1'),
      Buffer.from('{}'),
    )
    expect(oversizedValueResponse.status).toBe(400)
    expect(oversizedMetaResponse.status).toBe(400)
    expect(readKvValue(source.cwd, oversizedValueKey)).toBeNull()
    expect(readKvValue(source.cwd, oversizedMetaKey)).toBeNull()

    const nodeBackup = await sourceClient.exportBackup()
    const nodeEntries = entriesByName(nodeBackup)
    expect(nodeEntries.get(maxOwnedValueKey)).toEqual(maxOwnedValue)
    expect(nodeEntries.get(maxOwnedMetaKey)).toEqual(maxOwnedMeta)
    expect(nodeEntries.get(maxValueOnlyKey)).toEqual(maxValueOnly)

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
    expect((await client.importBackup(createSeedBackup({ characterCount: 0 }))).ok).toBe(true)
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
      optimizePluginMemory: false,
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
    // These are pre-BR2 legacy rows. Current servers reject new generic
    // pluginsave staging, so seed the historical fixture at rest.
    for (const [key, value] of [...valueRows, ...metaRows]) {
      writeFixtureKvValue(source.cwd, key, value)
    }
    const storageGeneration = randomUUID()
    const storageManifest = Buffer.from(JSON.stringify({
      version: 2,
      generation: storageGeneration,
      valueKeys: [...valueRows.keys()],
      metaKeys: [...metaRows.keys()],
    }))
    const sourceDatabase = decodeRisuDat(readKvValue(source.cwd, 'database/database.bin')!)
    const transitionResponse = await commitBulkPluginStorageTransition(
      sourceClient,
      { optimized: false, generation: null, manifest: null },
      {
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
      },
    )
    expect(transitionResponse.status, await transitionResponse.clone().text()).toBe(200)
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
    const upstreamDatabaseEntry = upstreamEntries.find(entry => entry.name === 'database.risudat')!
    expect(upstreamV190AcceptsRisuSaveHeader(upstreamDatabaseEntry.data)).toBe(true)
    const upstreamDatabase = decodeRisuDat(upstreamDatabaseEntry.data)
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

    const mainResponse = await sourceClient.fetch('/api/backup/export?target=main')
    expect(mainResponse.status).toBe(200)
    expect(mainResponse.headers.get('content-disposition')).toContain('-main.bin')
    const mainBackup = Buffer.from(await mainResponse.arrayBuffer())
    const mainEntries = decodeBackup(mainBackup)
    expect(mainEntries.some(entry => entry.name.startsWith('pluginsave/'))).toBe(false)
    expect(mainEntries.some(entry => entry.name.startsWith('pluginsave-meta/'))).toBe(false)
    expect(mainEntries.some(entry => entry.name === PLUGIN_STORAGE_MANIFEST_KEY)).toBe(false)
    const mainDatabaseEntry = mainEntries.find(entry => entry.name === 'database.risudat')!
    expect(mainDatabaseEntry.data[10]).toBe(7)
    const mainDatabase = decodeRisuDat(mainDatabaseEntry.data)
    expect(mainDatabase.pluginCustomStorage).toEqual(upstreamDatabase.pluginCustomStorage)
    expect(mainDatabase.pluginStorageMeta).toEqual(upstreamDatabase.pluginStorageMeta)
    expect(mainDatabase.pluginStorageGeneration).toBe(storageGeneration)

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
    writeFixtureKvValue(destination.cwd, staleKey, Buffer.from('"stale"'))

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

  test('partial export streams a high-cardinality store into an upstream-compatible archive', async () => {
    const source = await spawnServer()
    servers.push(source)
    const sourceClient = await createClient(source.port, source.password)
    const seed = withDatabaseFields(createSeedBackup({ characterCount: 1 }), {
      optimizePluginMemory: false,
      pluginCustomStorage: {},
      account: { token: 'must-not-enter-partial-backup' },
    })
    expect((await sourceClient.importBackup(seed)).ok).toBe(true)

    const rowCount = 1_000
    const values = Object.fromEntries(Array.from({ length: rowCount }, (_, index) => [
      `partial/${index}`,
      {
        index,
        body: 'x'.repeat(index === rowCount - 1 ? 4 * 1024 * 1024 : 1024),
      },
    ]))
    const sourceDatabase = decodeRisuDat(readKvValue(source.cwd, 'database/database.bin')!)
    const partialGeneration = randomUUID()
    const transition = await commitBulkPluginStorageTransition(
      sourceClient,
      { optimized: false, generation: null, manifest: null },
      {
        ...sourceDatabase,
        optimizePluginMemory: true,
        pluginStorageGeneration: partialGeneration,
        pluginCustomStorage: values,
      },
    )
    expect(transition.status, await transition.clone().text()).toBe(200)

    const jobId = await startPartialExport(sourceClient)
    const backup = await downloadPartialExport(sourceClient, jobId)
    const entries = decodeBackup(backup)
    expect(entries.map(entry => entry.name)).toEqual(['database.risudat'])
    const folded = decodeRisuDat(entries[0].data)
    expect(folded.account).toBeUndefined()
    expect(Object.keys(folded.pluginCustomStorage)).toHaveLength(rowCount)
    expect(folded.pluginCustomStorage['partial/999'].body).toHaveLength(4 * 1024 * 1024)

    const destination = await spawnServer()
    servers.push(destination)
    const destinationClient = await createClient(destination.port, destination.password)
    expect((await destinationClient.importBackup(backup)).ok).toBe(true)
    expect(JSON.parse(readKvValue(
      destination.cwd,
      pluginStorageKey('pluginsave/', 'partial/999'),
    )!.toString('utf-8')).body).toHaveLength(4 * 1024 * 1024)
  })

  test('partial export pins and round-trips large external own __proto__ escapes', async () => {
    const oldAsset = Buffer.from('PINNED-PROTO-ASSET')
    const newAsset = Buffer.from('MUTATE-PROTO-ASSET')
    expect(newAsset.length).toBe(oldAsset.length)
    const source = await spawnServer({
      env: { POCKETRISU_TEST_PARTIAL_EXPORT_DELAY_MS: '500' },
    })
    servers.push(source)
    const sourceClient = await createClient(source.port, source.password)
    const seedEntries = decodeBackup(createSeedBackup({ characterCount: 1 }))
    const databaseEntry = seedEntries.find(entry => entry.name === 'database.risudat')!
    const database = decodeRisuDat(databaseEntry.data)
    ;(database.characters as Array<Record<string, unknown>>)[0].image = 'assets/proto-selected.png'
    database.optimizePluginMemory = false
    database.pluginCustomStorage = {}
    database.account = { token: 'must-not-enter-partial-backup' }
    database.__pocketRisuPluginStorageEscapesV1 = {
      user: 'reserved-field-collision',
      nested: ['must', 'survive'],
      body: 'r'.repeat(5 * 1024 * 1024),
    }
    databaseEntry.data = encodeRisuDat(database)
    seedEntries.push({ name: 'proto-selected.png', data: oldAsset })
    expect((await sourceClient.importBackup(encodeBackup(seedEntries))).ok).toBe(true)

    const generation = randomUUID()
    const currentDatabase = decodeRisuDat(
      readKvValue(source.cwd, 'database/database.bin')!,
    )
    const pinnedProtoValue = {
      kind: 'pinned-value-proto',
      body: 'v'.repeat(3 * 1024 * 1024),
    }
    const pinnedProtoMeta = {
      plugin: 'Pinned Proto Owner',
      updatedAt: 2,
      body: 'm'.repeat(2 * 1024 * 1024),
    }
    const initialValues: Record<string, unknown> = {
      'ordinary/first': { version: 'pinned', body: 'ordinary-value' },
      constructor: { version: 'pinned-constructor' },
    }
    const initialMeta: Record<string, unknown> = {
      'ordinary/first': { plugin: 'Pinned Ordinary', updatedAt: 1 },
    }
    Object.defineProperty(initialValues, '__proto__', {
      configurable: true,
      enumerable: true,
      value: pinnedProtoValue,
      writable: true,
    })
    Object.defineProperty(initialMeta, '__proto__', {
      configurable: true,
      enumerable: true,
      value: pinnedProtoMeta,
      writable: true,
    })
    for (const [key, value] of [
      ['\uD800', { kind: 'pinned-high-surrogate-0' }],
      ['�', { kind: 'pinned-replacement-character' }],
      ['\uD801', { kind: 'pinned-high-surrogate-1' }],
    ] as const) {
      Object.defineProperty(initialValues, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      })
    }
    Object.defineProperty(initialMeta, '\uD800', {
      configurable: true,
      enumerable: true,
      value: { plugin: 'Malformed Key Owner', updatedAt: 4 },
      writable: true,
    })
    const transition = await commitBulkPluginStorageTransition(
      sourceClient,
      { optimized: false, generation: null, manifest: null },
      {
        ...currentDatabase,
        optimizePluginMemory: true,
        pluginStorageGeneration: generation,
        pluginCustomStorage: initialValues,
        pluginStorageMeta: initialMeta,
      },
    )
    expect(transition.status, await transition.clone().text()).toBe(200)
    await transition.text()

    const protoValueKey = pluginStorageKey('pluginsave/', '__proto__')
    const rawNegativeZeroProto = Buffer.from(
      `{"kind":"pinned-value-proto","negativeZero":-0,"body":"${'v'.repeat(3 * 1024 * 1024)}"}`,
    )
    const rawProtoMutation = await sourceClient.fetch('/api/plugin-storage/mutate', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'file-path': Buffer.from(protoValueKey, 'utf-8').toString('hex'),
        'x-plugin-storage-operation': 'set',
        'x-plugin-storage-generation': generation,
        'x-plugin-storage-owner-policy': 'preserve',
      },
      body: new Uint8Array(rawNegativeZeroProto),
    })
    expect(rawProtoMutation.status).toBe(200)
    await rawProtoMutation.text()

    const fullUpstreamResponse = await sourceClient.fetch('/api/backup/export?target=upstream')
    expect(fullUpstreamResponse.status).toBe(409)
    expect(fullUpstreamResponse.headers.get('content-disposition')).toBeNull()
    expect(fullUpstreamResponse.headers.get('x-risu-backup-target')).toBeNull()
    await expect(fullUpstreamResponse.json()).resolves.toMatchObject({
      code: 'BACKUP_UPSTREAM_UNSUPPORTED_PLUGIN_KEYS',
    })

    const mainResponse = await sourceClient.fetch('/api/backup/export?target=main')
    expect(mainResponse.status).toBe(409)
    expect(mainResponse.headers.get('content-disposition')).toBeNull()
    expect(mainResponse.headers.get('x-risu-backup-target')).toBeNull()
    await expect(mainResponse.json()).resolves.toMatchObject({
      code: 'BACKUP_MAIN_UNSUPPORTED_PLUGIN_KEYS',
    })

    const jobId = await startPartialExport(sourceClient)
    await waitForPartialExport(sourceClient, jobId, status => status.phase === 'assembling')
    await mutatePluginValue(
      sourceClient,
      generation,
      pluginStorageKey('pluginsave/', 'ordinary/first'),
      Buffer.from(JSON.stringify({ version: 'mutated', body: 'new-value' })),
    )
    await mutatePluginValue(
      sourceClient,
      generation,
      protoValueKey,
      Buffer.from(JSON.stringify({ kind: 'mutated-value-proto', body: 'new' })),
      Buffer.from(JSON.stringify({ plugin: 'Mutated Proto Owner', updatedAt: 3 })),
    )
    await writeKv(sourceClient, 'assets/proto-selected.png', newAsset)

    const backup = await downloadPartialExport(sourceClient, jobId)
    const archive = entriesByName(backup)
    expect(archive.get('proto-selected.png')).toEqual(oldAsset)
    expect(archive.get('proto-selected.png')).not.toEqual(newAsset)
    const folded = await decodeRisuSave(archive.get('database.risudat')!)
    expect(folded.account).toBeUndefined()
    expect(Object.keys(folded.pluginCustomStorage)).toEqual([
      'ordinary/first',
      'constructor',
      '__proto__',
      '\uD800',
      '�',
      '\uD801',
    ])
    expect(Object.keys(folded.pluginStorageMeta)).toEqual([
      'ordinary/first',
      '__proto__',
      '\uD800',
    ])
    expect(Object.hasOwn(folded.pluginCustomStorage, '__proto__')).toBe(true)
    expect(Object.hasOwn(folded.pluginStorageMeta, '__proto__')).toBe(true)
    expect(folded.pluginCustomStorage['ordinary/first']).toEqual({
      version: 'pinned',
      body: 'ordinary-value',
    })
    expect(folded.pluginCustomStorage.__proto__.kind).toBe('pinned-value-proto')
    expect(folded.pluginCustomStorage.__proto__.body).toHaveLength(3 * 1024 * 1024)
    expect(Object.is(folded.pluginCustomStorage.__proto__.negativeZero, -0)).toBe(false)
    expect(folded.pluginStorageMeta.__proto__.plugin).toBe('Pinned Proto Owner')
    expect(folded.pluginStorageMeta.__proto__.body).toHaveLength(2 * 1024 * 1024)
    expect(folded.pluginCustomStorage['\uD800'].kind).toBe('pinned-high-surrogate-0')
    expect(folded.pluginCustomStorage['�'].kind).toBe('pinned-replacement-character')
    expect(folded.pluginCustomStorage['\uD801'].kind).toBe('pinned-high-surrogate-1')
    expect(folded.pluginStorageMeta['\uD800'].plugin).toBe('Malformed Key Owner')
    expect(folded.__pocketRisuPluginStorageEscapesV1).toMatchObject({
      user: 'reserved-field-collision',
      nested: ['must', 'survive'],
    })
    expect(folded.__pocketRisuPluginStorageEscapesV1.body).toHaveLength(5 * 1024 * 1024)

    const destination = await spawnServer()
    servers.push(destination)
    const destinationClient = await createClient(destination.port, destination.password)
    expect((await destinationClient.importBackup(backup)).ok).toBe(true)
    const restoredOrdinary = JSON.parse(readKvValue(
      destination.cwd,
      pluginStorageKey('pluginsave/', 'ordinary/first'),
    )!.toString('utf-8'))
    const restoredProto = JSON.parse(readKvValue(
      destination.cwd,
      protoValueKey,
    )!.toString('utf-8'))
    const restoredProtoMeta = JSON.parse(readKvValue(
      destination.cwd,
      pluginStorageKey('pluginsave-meta/', '__proto__'),
    )!.toString('utf-8'))
    const restoredMalformed = JSON.parse(readKvValue(
      destination.cwd,
      pluginStorageKey('pluginsave/', '\uD800'),
    )!.toString('utf-8'))
    const restoredReplacement = JSON.parse(readKvValue(
      destination.cwd,
      pluginStorageKey('pluginsave/', '�'),
    )!.toString('utf-8'))
    const restoredSecondMalformed = JSON.parse(readKvValue(
      destination.cwd,
      pluginStorageKey('pluginsave/', '\uD801'),
    )!.toString('utf-8'))
    const restoredMalformedMeta = JSON.parse(readKvValue(
      destination.cwd,
      pluginStorageKey('pluginsave-meta/', '\uD800'),
    )!.toString('utf-8'))
    expect(restoredOrdinary).toEqual({ version: 'pinned', body: 'ordinary-value' })
    expect(restoredProto.kind).toBe('pinned-value-proto')
    expect(restoredProto.body).toHaveLength(3 * 1024 * 1024)
    expect(Object.is(restoredProto.negativeZero, -0)).toBe(false)
    expect(restoredProtoMeta.plugin).toBe('Pinned Proto Owner')
    expect(restoredProtoMeta.body).toHaveLength(2 * 1024 * 1024)
    expect(restoredMalformed).toEqual({ kind: 'pinned-high-surrogate-0' })
    expect(restoredReplacement).toEqual({ kind: 'pinned-replacement-character' })
    expect(restoredSecondMalformed).toEqual({ kind: 'pinned-high-surrogate-1' })
    expect(restoredMalformedMeta.plugin).toBe('Malformed Key Owner')
    const restoredDatabase = decodeRisuDat(
      readKvValue(destination.cwd, 'database/database.bin')!,
    )
    expect(restoredDatabase.pluginCustomStorage).toEqual({})
    expect(restoredDatabase.__pocketRisuPluginStorageEscapesV1).toMatchObject({
      user: 'reserved-field-collision',
      nested: ['must', 'survive'],
    })
    expect(restoredDatabase.__pocketRisuPluginStorageEscapesV1.body)
      .toHaveLength(5 * 1024 * 1024)
    expect(await readFile(path.join(
      destination.cwd,
      'save',
      'assets',
      'proto-selected.png',
    ))).toEqual(oldAsset)
    await waitForNoPartialExportSpools(source.cwd)
    await waitForNoPartialExportSpools(destination.cwd)
  })

  test('partial export pins selected filesystem assets before equal-size replacement', async () => {
    const oldBytes = Buffer.from('OLD-PROFILE-BYTES')
    const newBytes = Buffer.from('NEW-PROFILE-BYTES')
    expect(newBytes.length).toBe(oldBytes.length)
    const source = await spawnServer({
      env: { POCKETRISU_TEST_PARTIAL_EXPORT_DELAY_MS: '500' },
    })
    servers.push(source)
    const client = await createClient(source.port, source.password)
    const seedEntries = decodeBackup(createSeedBackup({ characterCount: 1 }))
    const databaseEntry = seedEntries.find(entry => entry.name === 'database.risudat')!
    const database = decodeRisuDat(databaseEntry.data)
    ;(database.characters as Array<Record<string, unknown>>)[0].image = 'assets/profile.png'
    database.account = { token: 'must-not-enter-partial-backup' }
    databaseEntry.data = encodeRisuDat(database)
    seedEntries.push({ name: 'profile.png', data: oldBytes })
    expect((await client.importBackup(encodeBackup(seedEntries))).ok).toBe(true)

    const jobId = await startPartialExport(client)
    await waitForPartialExport(client, jobId, status => status.phase === 'assembling')
    await writeKv(client, 'assets/profile.png', newBytes)

    const archive = entriesByName(await downloadPartialExport(client, jobId))
    expect(archive.get('profile.png')).toEqual(oldBytes)
    expect(archive.get('profile.png')).not.toEqual(newBytes)
    const folded = decodeRisuDat(archive.get('database.risudat')!)
    expect(folded.account).toBeUndefined()
    await waitForNoPartialExportSpools(source.cwd)
  })

  test('partial export preserves a rewritten legacy hash-shaped profile asset', async () => {
    const source = await spawnServer()
    servers.push(source)
    const client = await createClient(source.port, source.password)
    const legacyName = `${'0'.repeat(64)}.png`
    const legacyKey = `assets/${legacyName}`
    const importedBytes = Buffer.from('historical profile bytes')
    const rewrittenBytes = Buffer.from('rewritten profile bytes')
    const seedEntries = decodeBackup(createSeedBackup({ characterCount: 1 }))
    const databaseEntry = seedEntries.find(entry => entry.name === 'database.risudat')!
    const database = decodeRisuDat(databaseEntry.data)
    ;(database.characters as Array<Record<string, unknown>>)[0].image = legacyKey
    databaseEntry.data = encodeRisuDat(database)
    seedEntries.push({ name: legacyName, data: importedBytes })
    expect((await client.importBackup(encodeBackup(seedEntries))).ok).toBe(true)
    await writeKv(client, legacyKey, rewrittenBytes)

    const jobId = await startPartialExport(client)
    const archive = entriesByName(await downloadPartialExport(client, jobId))
    expect(archive.get(legacyName)).toEqual(rewrittenBytes)
    const folded = decodeRisuDat(archive.get('database.risudat')!)
    expect((folded.characters as Array<Record<string, unknown>>)[0].image).toBe(legacyKey)
    await waitForNoPartialExportSpools(source.cwd)
  })

  test('partial export creation returns promptly while real preparation exceeds 15 seconds', async () => {
    const source = await spawnServer({
      env: { POCKETRISU_TEST_PARTIAL_EXPORT_DELAY_MS: '15250' },
    })
    servers.push(source)
    const client = await createClient(source.port, source.password)
    expect((await client.importBackup(createSeedBackup())).ok).toBe(true)

    const before = Date.now()
    const jobId = await startPartialExport(client)
    expect(Date.now() - before).toBeLessThan(2_000)
    const status = await waitForPartialExport(
      client,
      jobId,
      current => current.state === 'ready',
      25_000,
    )
    expect(Date.now() - before).toBeGreaterThan(15_000)
    expect(status.phase).toBe('ready')
    expect(decodeBackup(await downloadPartialExport(client, jobId))).toHaveLength(1)
  }, 30_000)

  test('cancelling preparation cleans private spools and restart sweeps exact orphans', async () => {
    const source = await spawnServer({
      env: { POCKETRISU_TEST_PARTIAL_EXPORT_DELAY_MS: '30000' },
    })
    servers.push(source)
    const client = await createClient(source.port, source.password)
    expect((await client.importBackup(createSeedBackup())).ok).toBe(true)

    const jobId = await startPartialExport(client)
    await waitForPartialExport(client, jobId, status => status.phase === 'assembling')
    const cancel = await client.fetch(`/api/backup/export/jobs/${jobId}`, { method: 'DELETE' })
    expect(cancel.status).toBe(202)
    await cancel.text()
    await waitForNoPartialExportSpools(source.cwd)

    const spoolDir = path.join(source.cwd, 'save', '.partial-export-spool')
    const orphan = path.join(spoolDir, '.partial-export-orphan')
    await mkdir(orphan, { recursive: true })
    await writeFile(path.join(orphan, 'partial-backup.bin.tmp'), 'orphan')
    await writeFile(path.join(spoolDir, 'unrelated.keep'), 'keep')
    await source.restart({ POCKETRISU_TEST_PARTIAL_EXPORT_DELAY_MS: '0' })
    const afterRestart = await readdir(spoolDir)
    expect(afterRestart).not.toContain('.partial-export-orphan')
    expect(afterRestart).toContain('unrelated.keep')
  }, 30_000)

  test('cancelling preparation behind a held import cleans before import release', async () => {
    let gateRoot = ''
    const source = await spawnServer({
      seedSave: async saveDir => {
        gateRoot = path.dirname(saveDir)
        await mkdir(path.join(gateRoot, 'import-gate'), { recursive: true })
        await writeFile(path.join(gateRoot, 'import-gate', 'hold'), '')
      },
      env: {
        RISU_STREAM_INGEST_MIN_BYTES: '1',
        POCKETRISU_BACKUP_IMPORT_TEST_GATE_DIR: 'import-gate',
        POCKETRISU_TEST_BACKUP_IMPORT_FAILPOINT: 'after-database-ingestion',
      },
    })
    servers.push(source)
    const client = await createClient(source.port, source.password)
    const backup = createSeedBackup()
    expect((await client.fetch('/api/backup/import/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ size: backup.byteLength }),
    })).status).toBe(200)
    const importing = client.fetch('/api/backup/import', {
      method: 'POST',
      headers: { 'content-type': 'application/x-risu-backup' },
      body: new Uint8Array(backup),
    })
    const releasePath = path.join(gateRoot, 'import-gate', 'release')

    let firstJobId = ''
    let replacementJobId = ''
    try {
      await waitForFile(path.join(gateRoot, 'import-gate', 'entered'), 10_000)

      firstJobId = await startPartialExport(client)
      await waitForPartialExport(client, firstJobId, status => status.phase === 'snapshot')
      const cancel = await client.fetch(`/api/backup/export/jobs/${firstJobId}`, {
        method: 'DELETE',
      })
      expect(cancel.status).toBe(202)
      await cancel.text()

      // Cancellation must wake the barrier waiter and run its normal artifact
      // cleanup while the import still owns its raw SQLite transaction.
      await waitForNoPartialExportSpools(source.cwd)
      const cancelled = await client.fetch(`/api/backup/export/jobs/${firstJobId}`)
      expect(cancelled.status).toBe(404)
      await cancelled.text()

      // The cancelled preparation must also release the sole export admission
      // without waiting for the import or leaving a private directory behind.
      replacementJobId = await startPartialExport(client)
      await waitForPartialExport(client, replacementJobId, status => status.phase === 'snapshot')
      const replacementCancel = await client.fetch(
        `/api/backup/export/jobs/${replacementJobId}`,
        { method: 'DELETE' },
      )
      expect(replacementCancel.status).toBe(202)
      await replacementCancel.text()
      await waitForNoPartialExportSpools(source.cwd)
    } finally {
      await writeFile(releasePath, '')
      const importResponse = await importing
      await importResponse.text()
      expect(importResponse.ok).toBe(false)
    }

    // Releasing the import must not let either abandoned preparation run late
    // and resurrect a public job or recreate its private artifacts.
    for (const jobId of [firstJobId, replacementJobId]) {
      const status = await client.fetch(`/api/backup/export/jobs/${jobId}`)
      expect(status.status).toBe(404)
      await status.text()
    }
    await waitForNoPartialExportSpools(source.cwd)
  }, 30_000)

  test('job identity is idempotent, single-owner, and survives writer-session displacement', async () => {
    const source = await spawnServer({
      env: { POCKETRISU_TEST_PARTIAL_EXPORT_DELAY_MS: '30000' },
    })
    servers.push(source)
    const client = await createClient(source.port, source.password)
    expect((await client.importBackup(createSeedBackup())).ok).toBe(true)
    const jobId = randomUUID()
    const create = (id: string) => client.fetch('/api/backup/export/jobs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-session-id': 'export-owner',
      },
      body: JSON.stringify({ scope: 'partial', jobId: id }),
    })

    const [first, duplicate] = await Promise.all([create(jobId), create(jobId)])
    expect(first.status).toBe(202)
    expect(duplicate.status).toBe(202)
    await expect(first.json()).resolves.toMatchObject({ jobId })
    await expect(duplicate.json()).resolves.toMatchObject({ jobId })
    const secondId = await create(randomUUID())
    expect(secondId.status).toBe(409)
    await secondId.text()

    const displace = await client.fetch('/api/session', {
      method: 'POST',
      headers: { 'x-session-id': 'different-writer' },
    })
    expect(displace.status).toBe(200)
    await displace.text()
    const ownerHeaders = { 'x-session-id': 'export-owner' }
    const status = await client.fetch(`/api/backup/export/jobs/${jobId}`, {
      headers: ownerHeaders,
    })
    expect(status.status).toBe(200)
    await status.text()
    const cancel = await client.fetch(`/api/backup/export/jobs/${jobId}`, {
      method: 'DELETE',
      headers: ownerHeaders,
    })
    expect(cancel.status).toBe(202)
    await cancel.text()
    await waitForNoPartialExportSpools(source.cwd)

    const concurrentIds = [randomUUID(), randomUUID()]
    const concurrent = await Promise.all(concurrentIds.map(id => create(id)))
    expect(concurrent.map(response => response.status).sort()).toEqual([202, 409])
    const admittedIndex = concurrent.findIndex(response => response.status === 202)
    await Promise.all(concurrent.map(response => response.text()))
    const admittedId = concurrentIds[admittedIndex]
    const finalCancel = await client.fetch(`/api/backup/export/jobs/${admittedId}`, {
      method: 'DELETE',
      headers: ownerHeaders,
    })
    expect(finalCancel.status).toBe(202)
    await finalCancel.text()
    await waitForNoPartialExportSpools(source.cwd)
  }, 30_000)

  test('a cancellation arriving before delayed create admission leaves a tombstone', async () => {
    const source = await spawnServer({
      env: { POCKETRISU_TEST_PARTIAL_EXPORT_CREATE_DELAY_MS: '400' },
    })
    servers.push(source)
    const client = await createClient(source.port, source.password)
    expect((await client.importBackup(createSeedBackup())).ok).toBe(true)
    const jobId = randomUUID()
    const ownerHeaders = {
      'content-type': 'application/json',
      'x-session-id': 'delayed-create-owner',
    }

    const create = client.fetch('/api/backup/export/jobs', {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ scope: 'partial', jobId }),
    })
    // The test-only gate holds the POST after validation but before admission,
    // deterministically putting DELETE on the problematic side of the race.
    await new Promise(resolve => setTimeout(resolve, 100))
    const cancel = await client.fetch(`/api/backup/export/jobs/${jobId}`, {
      method: 'DELETE',
      headers: { 'x-session-id': 'delayed-create-owner' },
    })
    expect(cancel.status).toBe(202)
    await expect(cancel.json()).resolves.toMatchObject({ state: 'cancelled' })

    const createResult = await create
    expect(createResult.status).toBe(409)
    await expect(createResult.json()).resolves.toMatchObject({ state: 'cancelled' })
    const status = await client.fetch(`/api/backup/export/jobs/${jobId}`, {
      headers: { 'x-session-id': 'delayed-create-owner' },
    })
    expect(status.status).toBe(404)
    await status.text()
    await waitForNoPartialExportSpools(source.cwd)

    // The owner/id-scoped tombstone must not consume global admission.
    const nextJobId = randomUUID()
    const next = await client.fetch('/api/backup/export/jobs', {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ scope: 'partial', jobId: nextJobId }),
    })
    expect(next.status).toBe(202)
    await next.text()
    const nextCancel = await client.fetch(`/api/backup/export/jobs/${nextJobId}`, {
      method: 'DELETE',
      headers: { 'x-session-id': 'delayed-create-owner' },
    })
    expect(nextCancel.status).toBe(202)
    await nextCancel.text()
    await waitForNoPartialExportSpools(source.cwd)
  })

  test('download disconnect destroys the one-shot private archive', async () => {
    const source = await spawnServer()
    servers.push(source)
    const client = await createClient(source.port, source.password)
    const seedEntries = decodeBackup(createSeedBackup({ characterCount: 1 }))
    const databaseEntry = seedEntries.find(entry => entry.name === 'database.risudat')!
    const database = decodeRisuDat(databaseEntry.data)
    ;(database.characters as Array<Record<string, unknown>>)[0].image = 'assets/disconnect.png'
    databaseEntry.data = encodeRisuDat(database)
    expect((await client.importBackup(encodeBackup(seedEntries))).ok).toBe(true)
    await writeKv(client, 'assets/disconnect.png', Buffer.alloc(16 * 1024 * 1024, 0x5a))

    const jobId = await startPartialExport(client)
    await waitForPartialExport(client, jobId, status => status.state === 'ready')
    const controller = new AbortController()
    const response = await client.fetch(`/api/backup/export/jobs/${jobId}/download`, {
      signal: controller.signal,
    })
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(first.value?.byteLength).toBeGreaterThan(0)
    controller.abort()
    await reader.cancel().catch(() => {})

    await waitForNoPartialExportSpools(source.cwd)
    const stillHealthy = await client.fetch('/api/backup/export/jobs/not-a-job')
    expect(stillHealthy.status).toBe(404)
  }, 30_000)

  test('TTL abort destroys a stalled download and releases admission and spools', async () => {
    const source = await spawnServer({
      env: {
        POCKETRISU_TEST_PARTIAL_EXPORT_TTL_MS: '500',
        POCKETRISU_TEST_PARTIAL_EXPORT_GC_INTERVAL_MS: '25',
        POCKETRISU_TEST_PARTIAL_EXPORT_STALL_DOWNLOAD: '1',
      },
    })
    servers.push(source)
    const client = await createClient(source.port, source.password)
    const seedEntries = decodeBackup(createSeedBackup({ characterCount: 1 }))
    const databaseEntry = seedEntries.find(entry => entry.name === 'database.risudat')!
    const database = decodeRisuDat(databaseEntry.data)
    ;(database.characters as Array<Record<string, unknown>>)[0].image = 'assets/ttl-stall.png'
    databaseEntry.data = encodeRisuDat(database)
    expect((await client.importBackup(encodeBackup(seedEntries))).ok).toBe(true)
    await writeKv(client, 'assets/ttl-stall.png', Buffer.alloc(1024 * 1024, 0x71))

    const jobId = await startPartialExport(client)
    await waitForPartialExport(client, jobId, status => status.state === 'ready')
    const stalled = await new Promise<{
      response: IncomingMessage
      closed: Promise<void>
      firstBytes: number
    }>((resolve, reject) => {
      const request = httpRequest({
        hostname: '127.0.0.1',
        port: source.port,
        path: `/api/backup/export/jobs/${jobId}/download`,
        method: 'GET',
        headers: { 'risu-auth': client.token },
      })
      request.once('error', reject)
      request.once('response', (response) => {
        const closed = new Promise<void>((closeResolve) => {
          response.once('aborted', closeResolve)
          response.once('close', closeResolve)
        })
        response.once('error', reject)
        response.once('data', (chunk: Buffer) => {
          response.pause()
          resolve({ response, closed, firstBytes: chunk.length })
        })
      })
      request.end()
    })
    expect(stalled.response.statusCode).toBe(200)
    expect(stalled.firstBytes).toBeGreaterThan(0)
    await Promise.race([
      stalled.closed,
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error('TTL did not terminate the stalled export download')),
        5_000,
      )),
    ])
    await waitForNoPartialExportSpools(source.cwd)
    const expired = await client.fetch(`/api/backup/export/jobs/${jobId}`)
    expect(expired.status).toBe(404)
    await expired.text()

    const replacementId = await startPartialExport(client)
    const replacementCancel = await client.fetch(
      `/api/backup/export/jobs/${replacementId}`,
      { method: 'DELETE' },
    )
    expect(replacementCancel.status).toBe(202)
    await replacementCancel.text()
    await waitForNoPartialExportSpools(source.cwd)
  }, 30_000)

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
    writeFixtureKvValue(server.cwd, staleValueKey, Buffer.from('1'))
    writeFixtureKvValue(server.cwd, staleMetaKey, Buffer.from('{}'))

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
    // Preserve a historical pre-BR2 physical publication for the rollback
    // assertion. Generic plugin-row staging is intentionally rejected now.
    writeFixtureKvValue(server.cwd, oldValueKey, oldValue)
    writeFixtureKvValue(server.cwd, oldMetaKey, oldMeta)

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
