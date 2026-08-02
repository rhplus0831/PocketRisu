import { afterAll, describe, expect, test } from 'vitest'
import Database from 'better-sqlite3'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { createHash, randomUUID } from 'node:crypto'
import { Packr } from 'msgpackr'
import { createClient, type RisuClient } from './helpers/client.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { encodeBackup } from './helpers/encode.js'
import utilsPkg from '../../server/node/utils.cjs'
import pluginSaveKeysPkg from '../../server/node/pluginSaveKeys.cjs'

const { encodeRisuSaveLegacy, decodeRisuSave, magicCompressedHeader } = utilsPkg as {
  encodeRisuSaveLegacy: (value: unknown) => Uint8Array
  decodeRisuSave: (value: Uint8Array) => Promise<any>
  magicCompressedHeader: Uint8Array
}
const packr = new Packr({ useRecords: false })
const transitionPackr = new Packr({ structuredClone: true, useRecords: true })
const {
  encodePluginSaveStorageKey,
  PLUGIN_SAVE_PREFIX,
  PLUGIN_SAVE_META_PREFIX,
} = pluginSaveKeysPkg as {
  encodePluginSaveStorageKey: (rawKey: string, prefix: string) => string
  PLUGIN_SAVE_PREFIX: string
  PLUGIN_SAVE_META_PREFIX: string
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
const valueKey = (key: string) => encodePluginSaveStorageKey(key, PLUGIN_SAVE_PREFIX)
const ownerKey = (key: string) => encodePluginSaveStorageKey(key, PLUGIN_SAVE_META_PREFIX)
const activeManifest = {
  version: 2,
  generation: STORAGE_GENERATION,
  valueKeys: keys.map(valueKey),
  metaKeys: keys.map(ownerKey),
}

function seed(saveDir: string, omittedStorageKey?: string): void {
  const db = new Database(path.join(saveDir, 'risuai.db'))
  db.exec(`CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL)`)
  const insert = db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)')
  for (const [index, key] of keys.entries()) {
    if (valueKey(key) !== omittedStorageKey) {
      insert.run(valueKey(key), Buffer.from(JSON.stringify({ generation: 'old', key })), 1)
    }
    if (ownerKey(key) !== omittedStorageKey) insert.run(ownerKey(key), Buffer.from(JSON.stringify(index === 1
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

async function boot(
  failpoint = '',
  omittedStorageKey?: string,
): Promise<{ server: ServerHandle; client: RisuClient }> {
  const server = await spawnServer({
    seedSave: async saveDir => seed(saveDir, omittedStorageKey),
    env: failpoint ? { POCKETRISU_TEST_PLUGIN_BATCH_FAILPOINT: failpoint } : undefined,
  })
  servers.push(server)
  return { server, client: await createClient(server.port, server.password) }
}

function lateFailingDatabase(payloadBytes: number): Buffer {
  const gzipped = gzipSync(packr.encode({
    characters: [],
    importPadding: 'x'.repeat(payloadBytes),
  }), { level: 1 })
  gzipped[gzipped.length - 1] ^= 0xff
  return Buffer.concat([Buffer.from(magicCompressedHeader), gzipped])
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

function compactEnvelope(
  operations: unknown[],
  expectedManifestRevision: string,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    version: 2,
    generation: STORAGE_GENERATION,
    expectedManifestRevision,
    operations,
  }))
}

function framedCompactEnvelope(
  operations: Array<
    | {
        operation: 'set'
        key: string
        owner: string
        valueBytes: Uint8Array
        expectedRevision?: string | null
      }
    | { operation: 'remove'; key: string; expectedRevision?: string | null }
  >,
  expectedManifestRevision: string,
  valueHashOverride?: string,
): Uint8Array {
  const metadata = Buffer.from(JSON.stringify({
    version: 3,
    generation: STORAGE_GENERATION,
    expectedManifestRevision,
    operations: operations.map(operation => operation.operation === 'set'
      ? {
          operation: operation.operation,
          key: operation.key,
          owner: operation.owner,
          valueLength: operation.valueBytes.byteLength,
          valueHash: valueHashOverride
            ?? createHash('sha256').update(operation.valueBytes).digest('hex'),
          ...(Object.prototype.hasOwnProperty.call(operation, 'expectedRevision')
            ? { expectedRevision: operation.expectedRevision }
            : {}),
        }
      : {
          operation: operation.operation,
          key: operation.key,
          ...(Object.prototype.hasOwnProperty.call(operation, 'expectedRevision')
            ? { expectedRevision: operation.expectedRevision }
            : {}),
        }),
  }), 'utf8')
  const prefix = Buffer.alloc(12)
  prefix.write('PRISUB01', 0, 'ascii')
  prefix.writeUInt32BE(metadata.byteLength, 8)
  return new Uint8Array(Buffer.concat([
    prefix,
    metadata,
    ...operations
      .filter((operation): operation is Extract<typeof operation, { operation: 'set' }> => (
        operation.operation === 'set'
      ))
      .map(operation => Buffer.from(operation.valueBytes)),
  ]))
}

function bulkTransitionBody(metadata: Record<string, unknown>, payloads: Buffer[]): Uint8Array {
  const metadataBytes = Buffer.from(JSON.stringify(metadata), 'utf8')
  const prefix = Buffer.alloc(12)
  prefix.write('PRISUT01', 0, 'ascii')
  prefix.writeUInt32BE(metadataBytes.byteLength, 8)
  return new Uint8Array(Buffer.concat([prefix, metadataBytes, ...payloads]))
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

function rewriteBody(key: string, revision?: string): Uint8Array {
  return envelope([{
    operation: 'set',
    key,
    value: Buffer.from(JSON.stringify({ generation: 'old', key })).toString('base64'),
    owner: 'AA3',
    ...(revision === undefined ? {} : { expectedRevision: revision }),
  }])
}

function readPhysicalPair(cwd: string, key: string): { value: Buffer; owner: Buffer } {
  const db = new Database(path.join(cwd, 'save', 'risuai.db'), { readonly: true })
  const get = db.prepare('SELECT value FROM kv WHERE key = ?')
  const value = Buffer.from((get.get(valueKey(key)) as { value: Buffer }).value)
  const owner = Buffer.from((get.get(ownerKey(key)) as { value: Buffer }).value)
  db.close()
  return { value, owner }
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

async function mutateFramed(client: RisuClient, body: Uint8Array): Promise<Response> {
  return client.fetch('/api/plugin-storage/batch', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-pocketrisu-plugin-storage-batch',
      'x-plugin-storage-batch-stream': '1',
      'x-plugin-storage-batch-length': String(body.byteLength),
    },
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

async function readManifest(
  client: RisuClient,
  mode: 'snapshot' | 'state' = 'snapshot',
): Promise<any> {
  return readManifestForGeneration(client, STORAGE_GENERATION, mode)
}

async function readManifestForGeneration(
  client: RisuClient,
  generation: string,
  mode: 'snapshot' | 'state' = 'snapshot',
): Promise<any> {
  const response = await client.fetch('/api/plugin-storage/manifest', {
    headers: {
      'x-plugin-storage-generation': generation,
      'x-plugin-storage-manifest-mode': mode,
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
  test('the committed batch path performs no post-commit row or manifest rereads', () => {
    const source = readFileSync(
      new URL('../../server/node/server.cjs', import.meta.url),
      'utf-8',
    )
    const routeStart = source.indexOf("app.post('/api/plugin-storage/batch'")
    const routeEnd = source.indexOf('const PLUGIN_STORAGE_SIZE_PREFIXES', routeStart)
    expect(routeStart).toBeGreaterThanOrEqual(0)
    expect(routeEnd).toBeGreaterThan(routeStart)
    const route = source.slice(routeStart, routeEnd)
    const committedStart = route.indexOf('pluginStorageManifestCache.publishPrepared')
    expect(committedStart).toBeGreaterThanOrEqual(0)
    const afterCommit = route.slice(committedStart)
    expect(afterCommit).not.toMatch(/readPluginStorageState\(/)
    expect(afterCommit).not.toMatch(/readPluginStorageManifest\(/)
    expect(afterCommit).not.toMatch(/kvGet\(\s*operation\.ownerKey\s*\)/)
    expect(afterCommit).not.toMatch(/kvSize\(\s*operation\.valueKey\s*\)/)
  })

  test('bulk transitions discard the parsed manifest selected by the prior generation', async () => {
    const { client } = await boot()
    const before = await readManifest(client)
    const internalGeneration = randomUUID()
    const internalBody = bulkTransitionBody({
      version: 1,
      transitionId: randomUUID(),
      source: {
        optimized: true,
        generation: STORAGE_GENERATION,
        manifest: before.manifest,
      },
      targetOptimized: false,
      targetGeneration: internalGeneration,
      autoConvert: true,
      rows: [],
    }, [])
    const internal = await client.fetch('/api/plugin-storage/transition/bulk', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-pocketrisu-plugin-storage-transition',
        'x-plugin-storage-transition-length': String(internalBody.byteLength),
      },
      body: internalBody,
    })
    expect(internal.status, await internal.clone().text()).toBe(200)

    const databaseResponse = await client.fetch('/api/read', {
      headers: { 'file-path': Buffer.from(DATABASE_KEY).toString('hex') },
    })
    const inlineDatabase = await decodeRisuSave(
      new Uint8Array(await databaseResponse.arrayBuffer()),
    ) as any
    expect(inlineDatabase.optimizePluginMemory).toBe(false)
    expect(inlineDatabase.pluginStorageGeneration).toBe(internalGeneration)

    const rows = [
      ...Object.entries(inlineDatabase.pluginCustomStorage).map(([rawKey, value]) => ({
        rawKey,
        storageKey: valueKey(rawKey),
        value,
      })),
      ...Object.entries(inlineDatabase.pluginStorageMeta).map(([rawKey, value]) => ({
        rawKey,
        storageKey: ownerKey(rawKey),
        value,
      })),
    ].map(row => {
      const bytes = Buffer.from(transitionPackr.encode(row.value))
      return {
        bytes,
        descriptor: {
          rawKey: row.rawKey,
          storageKey: row.storageKey,
          valueLength: bytes.byteLength,
          valueHash: createHash('sha256').update(bytes).digest('hex'),
        },
      }
    })
    const externalGeneration = randomUUID()
    const externalBody = bulkTransitionBody({
      version: 1,
      transitionId: randomUUID(),
      source: { optimized: false, generation: internalGeneration, manifest: null },
      targetOptimized: true,
      targetGeneration: externalGeneration,
      autoConvert: true,
      rows: rows.map(row => row.descriptor),
    }, rows.map(row => row.bytes))
    const external = await client.fetch('/api/plugin-storage/transition/bulk', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-pocketrisu-plugin-storage-transition',
        'x-plugin-storage-transition-length': String(externalBody.byteLength),
      },
      body: externalBody,
    })
    expect(external.status, await external.clone().text()).toBe(200)
    const after = await readManifestForGeneration(client, externalGeneration)
    expect(after.manifest).toMatchObject({
      generation: externalGeneration,
      valueKeys: activeManifest.valueKeys,
      metaKeys: activeManifest.metaKeys,
    })
  }, 30_000)

  test('maps over-limit logical keys to fixed physical names and removes the mapping atomically', async () => {
    const { server, client } = await boot()
    const key = `aa3/${'long-key-'.repeat(600)}`
    const value = Buffer.from(JSON.stringify({ survives: true }))
    const before = await readManifest(client, 'state')
    const setResponse = await mutateFramed(client, framedCompactEnvelope([{
      operation: 'set',
      key,
      owner: 'AA3 long-key owner',
      valueBytes: value,
      expectedRevision: null,
    }], before.manifestRevision))
    expect(setResponse.status).toBe(200)
    const setBody = await setResponse.json() as any
    expect(setBody.revisions).toMatchObject([{ key, revision: expect.stringMatching(REVISION_PATTERN) }])

    const physicalValueKey = valueKey(key)
    const physicalOwnerKey = ownerKey(key)
    expect(Buffer.byteLength(physicalValueKey)).toBeLessThan(128)
    expect(Buffer.byteLength(physicalOwnerKey)).toBeLessThan(128)
    expect(physicalValueKey).toContain('/sha256-v1.')
    const snapshot = await readManifest(client)
    expect(snapshot.manifest).toMatchObject({
      version: 3,
      valueKeys: expect.arrayContaining([physicalValueKey]),
      metaKeys: expect.arrayContaining([physicalOwnerKey]),
      keyMappings: [[physicalValueKey.slice(PLUGIN_SAVE_PREFIX.length), key]],
    })
    await expect(readState(client, key)).resolves.toMatchObject({
      missing: false,
      revision: setBody.revisions[0].revision,
    })

    const viewerResponse = await client.fetch('/api/plugin-storage/viewer-page?page=0&pageSize=50', {
      headers: {
        accept: 'application/x-ndjson',
        'x-plugin-storage-generation': STORAGE_GENERATION,
      },
    })
    expect(viewerResponse.status).toBe(200)
    const viewerEvents = (await viewerResponse.text()).trim().split('\n').map(line => JSON.parse(line))
    expect(viewerEvents).toContainEqual(expect.objectContaining({
      event: 'entry',
      key,
      owner: 'AA3 long-key owner',
    }))

    const backup = await client.exportBackup()
    const destination = await spawnServer()
    servers.push(destination)
    const destinationClient = await createClient(destination.port, destination.password)
    expect((await destinationClient.importBackup(backup)).ok).toBe(true)
    await expect(readState(destinationClient, key)).resolves.toMatchObject({ missing: false })
    const restoredManifest = await readManifest(destinationClient)
    expect(restoredManifest.manifest).toMatchObject({
      version: 3,
      valueKeys: expect.arrayContaining([physicalValueKey]),
      metaKeys: expect.arrayContaining([physicalOwnerKey]),
      keyMappings: [[physicalValueKey.slice(PLUGIN_SAVE_PREFIX.length), key]],
    })

    const removeResponse = await mutateFramed(client, framedCompactEnvelope([{
      operation: 'remove',
      key,
      expectedRevision: setBody.revisions[0].revision,
    }], snapshot.manifestRevision))
    expect(removeResponse.status).toBe(200)
    await expect(readState(client, key)).resolves.toMatchObject({ missing: true })
    const after = await readManifest(client)
    expect(after.manifest.valueKeys).not.toContain(physicalValueKey)
    expect(after.manifest.metaKeys).not.toContain(physicalOwnerKey)
    expect(after.manifest.keyMappings ?? []).toEqual([])

    const db = new Database(path.join(server.cwd, 'save', 'risuai.db'), { readonly: true })
    const count = db.prepare('SELECT COUNT(*) AS count FROM kv WHERE key IN (?, ?)')
      .get(physicalValueKey, physicalOwnerKey) as { count: number }
    db.close()
    expect(count.count).toBe(0)
  })

  test('session negotiation advertises framed limits from server configuration', async () => {
    const { client } = await boot()
    const response = await client.fetch('/api/session', {
      method: 'POST',
      headers: { 'x-session-id': 'batch-capability-test' },
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      capabilities: {
        pluginStorage: {
          maxValueBytes: 128 * 1024 * 1024,
        },
        pluginStorageBatch: {
          transport: 'framed-v1',
          maxOperations: 128,
          maxMetadataBytes: 1024 * 1024,
          maxValueBytes: 128 * 1024 * 1024,
          maxPayloadBytes: 1024 * 1024 * 1024,
        },
      },
    })
  })

  test('streams and atomically commits a value above the legacy encoded ceiling', async () => {
    const { server, client } = await boot()
    const manifest = await readManifest(client, 'state')
    const key = 'aa3/large-streamed'
    const value = Buffer.from(JSON.stringify('x'.repeat(13 * 1024 * 1024 - 2)), 'utf8')
    expect(value.byteLength).toBe(13 * 1024 * 1024)
    const framed = framedCompactEnvelope([{
      operation: 'set',
      key,
      owner: 'AA3',
      valueBytes: value,
      expectedRevision: null,
    }], manifest.manifestRevision)

    const response = await mutateFramed(client, framed)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'committed',
      operation: 'batch',
      revisions: [{
        key,
        revision: expect.stringMatching(REVISION_PATTERN),
        valueHash: createHash('sha256').update(value).digest('hex'),
      }],
    })
    const read = await readState(client, key)
    expect(read.missing).toBe(false)
    expect(createHash('sha256').update(Buffer.from(read.value, 'base64')).digest('hex'))
      .toBe(createHash('sha256').update(value).digest('hex'))
    const spool = await readdir(path.join(server.cwd, 'save', '.spool'))
    expect(spool.filter(name => name.startsWith('.plugin-batch-value-'))).toEqual([])
  }, 90_000)

  test('rejects a corrupt framed value before publication and removes its stage', async () => {
    const { server, client } = await boot()
    const manifest = await readManifest(client, 'state')
    const key = 'aa3/corrupt-streamed'
    const value = Buffer.from('{"valid":true}', 'utf8')
    const framed = framedCompactEnvelope([{
      operation: 'set',
      key,
      owner: 'AA3',
      valueBytes: value,
      expectedRevision: null,
    }], manifest.manifestRevision, '0'.repeat(64))

    const response = await mutateFramed(client, framed)
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'not-committed',
      code: 'INVALID_PLUGIN_STORAGE_BATCH',
    })
    await expect(readState(client, key)).resolves.toMatchObject({ missing: true })
    const spool = await readdir(path.join(server.cwd, 'save', '.spool'))
    expect(spool.filter(name => name.startsWith('.plugin-batch-value-'))).toEqual([])
  })

  test('checks streamed revisions after staging and leaves no committed prefix or spool', async () => {
    const { server, client } = await boot()
    const manifest = await readManifest(client, 'state')
    const key = keys[0]
    const before = readPhysicalPair(server.cwd, key)
    const value = Buffer.from(JSON.stringify({ generation: 'must-not-commit', key }), 'utf8')
    const framed = framedCompactEnvelope([{
      operation: 'set',
      key,
      owner: 'AA3',
      valueBytes: value,
      expectedRevision: `sha256:${'0'.repeat(64)}`,
    }], manifest.manifestRevision)

    const response = await mutateFramed(client, framed)
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'not-committed',
      code: 'PLUGIN_STORAGE_REVISION_CONFLICT',
    })
    expect(readPhysicalPair(server.cwd, key)).toEqual(before)
    const spool = await readdir(path.join(server.cwd, 'save', '.spool'))
    expect(spool.filter(name => name.startsWith('.plugin-batch-value-'))).toEqual([])
  })

  test('rolls a staged file write back with its owner and manifest', async () => {
    const { server, client } = await boot('after-value:0')
    const manifest = await readManifest(client, 'state')
    const key = keys[0]
    const before = readPhysicalPair(server.cwd, key)
    const state = await readState(client, key)
    const framed = framedCompactEnvelope([{
      operation: 'set',
      key,
      owner: 'AA3',
      valueBytes: Buffer.from(JSON.stringify({ generation: 'must-roll-back', key }), 'utf8'),
      expectedRevision: state.revision,
    }], manifest.manifestRevision)

    const response = await mutateFramed(client, framed)
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'not-committed',
      code: 'PLUGIN_STORAGE_BATCH_ROLLED_BACK',
    })
    expect(readPhysicalPair(server.cwd, key)).toEqual(before)
    const spool = await readdir(path.join(server.cwd, 'save', '.spool'))
    expect(spool.filter(name => name.startsWith('.plugin-batch-value-'))).toEqual([])
  })

  test('staged status cannot consume a tentative matching import publication', async () => {
    const server = await spawnServer({
      seedSave: async saveDir => {
        seed(saveDir)
        const gateDir = path.join(path.dirname(saveDir), 'import-gate')
        await mkdir(gateDir, { recursive: true })
        await writeFile(path.join(gateDir, 'hold'), '')
      },
      env: {
        RISU_STREAM_INGEST_MIN_BYTES: '1',
        POCKETRISU_BACKUP_IMPORT_TEST_GATE_DIR: 'import-gate',
        POCKETRISU_TEST_BACKUP_IMPORT_FAILPOINT: 'after-database-ingestion',
      },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const transitionId = '123e4567-e89b-42d3-a456-426614174210'
    const targetGeneration = '123e4567-e89b-42d3-a456-426614174211'
    const beginResponse = await client.fetch('/api/plugin-storage/transition/stage/begin', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-plugin-storage-transition': transitionId,
      },
      body: JSON.stringify({
        version: 2,
        transitionId,
        source: {
          optimized: true,
          generation: STORAGE_GENERATION,
          manifest: activeManifest,
        },
        targetOptimized: false,
        targetGeneration,
        rows: [],
      }),
    })
    expect(beginResponse.status).toBe(200)
    const begin = await beginResponse.json() as any
    expect(begin.state).toBe('ready')
    expect(begin.rows.length).toBe(activeManifest.valueKeys.length + activeManifest.metaKeys.length)

    const backup = encodeBackup([{
      name: 'database.risudat',
      data: Buffer.from(encodeRisuSaveLegacy({
        characters: [],
        optimizePluginMemory: false,
        pluginStorageGeneration: targetGeneration,
        pluginCustomStorage: {},
      })),
    }])
    expect((await client.fetch('/api/backup/import/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ size: backup.byteLength }),
    })).status).toBe(200)
    const importing = client.fetch('/api/backup/import', {
      method: 'POST',
      headers: { 'content-type': 'application/x-risu-backup' },
      body: backup,
    })
    const enteredPath = path.join(server.cwd, 'import-gate', 'entered')
    const enteredDeadline = Date.now() + 10_000
    while (!existsSync(enteredPath) && Date.now() < enteredDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(existsSync(enteredPath)).toBe(true)

    const statusRead = client.fetch('/api/plugin-storage/transition/stage/status', {
      headers: { 'x-plugin-storage-transition': transitionId },
    })
    await expect(Promise.race([
      statusRead.then(() => 'settled'),
      new Promise(resolve => setTimeout(() => resolve('pending'), 150)),
    ])).resolves.toBe('pending')

    await writeFile(path.join(server.cwd, 'import-gate', 'release'), '')
    const importResponse = await importing
    await importResponse.text()
    expect(importResponse.ok).toBe(false)
    const statusResponse = await statusRead
    expect(statusResponse.status).toBe(200)
    const status = await statusResponse.json() as any
    expect(status.state).toBe('ready')
    expect(status.targetGeneration).toBe(targetGeneration)
    const rowResponse = await client.fetch('/api/plugin-storage/transition/stage/row', {
      headers: {
        'x-plugin-storage-transition': transitionId,
        'x-plugin-storage-key': begin.rows[0].storageKey,
      },
    })
    expect(rowResponse.status).toBe(200)
    await rowResponse.arrayBuffer()
  }, 120_000)

  test('versioned state and manifest reads wait for a streamed import rollback', async () => {
    const server = await spawnServer({
      seedSave: async saveDir => seed(saveDir),
      env: { RISU_STREAM_INGEST_MIN_BYTES: '1' },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const backup = encodeBackup([
      { name: 'database.risudat', data: lateFailingDatabase(64 * 1024) },
    ])
    let releaseUpload!: () => void
    const uploadGate = new Promise<void>(resolve => { releaseUpload = resolve })
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        controller.enqueue(new Uint8Array(backup))
        await uploadGate
        controller.close()
      },
    })

    expect((await client.fetch('/api/backup/import/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ size: backup.byteLength }),
    })).status).toBe(200)
    const importing = client.fetch('/api/backup/import', {
      method: 'POST',
      headers: { 'content-type': 'application/x-risu-backup' },
      body,
      // @ts-expect-error Node requires duplex for streaming request bodies.
      duplex: 'half',
    })
    await new Promise(resolve => setTimeout(resolve, 500))

    const reads = [
      client.fetch('/api/plugin-storage/manifest', {
        headers: {
          'x-plugin-storage-generation': STORAGE_GENERATION,
          'x-plugin-storage-manifest-mode': 'snapshot',
        },
      }),
      client.fetch('/api/plugin-storage/manifest', {
        headers: {
          'x-plugin-storage-generation': STORAGE_GENERATION,
          'x-plugin-storage-manifest-mode': 'state',
        },
      }),
      client.fetch('/api/plugin-storage/state', {
        headers: {
          'file-path': Buffer.from(valueKey(keys[0]), 'utf-8').toString('hex'),
          'x-plugin-storage-generation': STORAGE_GENERATION,
        },
      }),
      client.fetch('/api/read', {
        headers: {
          'file-path': Buffer.from(valueKey(keys[0]), 'utf-8').toString('hex'),
          'x-plugin-storage-generation': STORAGE_GENERATION,
        },
      }),
    ]
    await expect(Promise.race([
      Promise.all(reads).then(() => 'settled'),
      new Promise(resolve => setTimeout(() => resolve('pending'), 150)),
    ])).resolves.toBe('pending')

    releaseUpload()
    const importResponse = await importing
    await importResponse.text()
    expect(importResponse.ok).toBe(false)

    const [
      snapshotResponse,
      manifestStateResponse,
      valueStateResponse,
      ordinaryValueResponse,
    ] = await Promise.all(reads)
    expect(snapshotResponse.status).toBe(200)
    expect(manifestStateResponse.status).toBe(200)
    expect(valueStateResponse.status).toBe(200)
    expect(ordinaryValueResponse.status).toBe(200)
    const snapshot = await snapshotResponse.json() as any
    expect(snapshot.manifest).toEqual(activeManifest)
    expect(snapshot.valueKeys).toEqual(activeManifest.valueKeys)
    expect((await manifestStateResponse.json() as any).manifestRevision).toMatch(REVISION_PATTERN)
    const valueState = await valueStateResponse.json() as any
    expect(JSON.parse(Buffer.from(valueState.value, 'base64').toString())).toEqual({
      generation: 'old',
      key: keys[0],
    })
    expect(await ordinaryValueResponse.json()).toEqual({
      generation: 'old',
      key: keys[0],
    })
  }, 120_000)

  test('commits bodies, manifest, owners and one generation together', async () => {
    const { server, client } = await boot()
    const response = await mutate(client)
    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body).toMatchObject({ outcome: 'committed', operation: 'batch' })
    expect(Object.keys(body)).toEqual([
      'success',
      'outcome',
      'operation',
      'verification',
      'requestHash',
      'generation',
      'revisions',
    ])
    expect(body.verification).toBe('verified')
    expect(body.generation).toMatch(UUID_V4_PATTERN)
    expect(body.requestHash).toMatch(/^[0-9a-f]{64}$/)
    expect(body.revisions).toHaveLength(keys.length)
    expect(body.revisions.map((row: any) => row.key)).toEqual(keys)
    expect(body.revisions.every((row: any) => REVISION_PATTERN.test(row.revision))).toBe(true)
    expect(body.revisions.map((row: any) => row.valueHash)).toEqual(keys.map(key => (
      createHash('sha256')
        .update(Buffer.from(JSON.stringify({ generation: 'new', key })))
        .digest('hex')
    )))
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

  test('a destructive snapshot restore discards the cached old manifest publication', async () => {
    const snapshotKey = 'database/dbbackup-4300.bin'
    const restoredRawKey = 'aa3/restored-cache-publication'
    const server = await spawnServer({
      seedSave: async saveDir => {
        seed(saveDir)
        const db = new Database(path.join(saveDir, 'risuai.db'))
        db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(
          snapshotKey,
          Buffer.from(encodeRisuSaveLegacy({
            characters: [],
            optimizePluginMemory: true,
            pluginCustomStorage: {
              [restoredRawKey]: { restored: true },
            },
            pluginStorageMeta: {
              [restoredRawKey]: { plugin: 'Restored', updatedAt: 7 },
            },
          })),
          2,
        )
        db.close()
      },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)

    // Populate the process cache with the original selected manifest.
    expect((await readManifest(client)).manifest).toEqual(activeManifest)
    const restore = await client.fetch('/api/db/snapshots/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: snapshotKey }),
    })
    expect(restore.status, await restore.clone().text()).toBe(200)
    await expect(restore.json()).resolves.toMatchObject({
      ok: true,
      key: snapshotKey,
      commitOutcome: 'committed',
      commitOutcomeUnknown: false,
    })

    const databaseResponse = await client.fetch('/api/read', {
      headers: { 'file-path': Buffer.from(DATABASE_KEY).toString('hex') },
    })
    expect(databaseResponse.status).toBe(200)
    const restoredDatabase = await decodeRisuSave(
      new Uint8Array(await databaseResponse.arrayBuffer()),
    ) as any
    const restoredGeneration = restoredDatabase.pluginStorageGeneration
    expect(restoredGeneration).toEqual(expect.any(String))
    const restoredManifest = await readManifestForGeneration(client, restoredGeneration)
    expect(restoredManifest.manifest).toMatchObject({
      generation: restoredGeneration,
      valueKeys: [valueKey(restoredRawKey)],
      metaKeys: [ownerKey(restoredRawKey)],
    })
    expect(restoredManifest.manifest).not.toEqual(activeManifest)
  }, 30_000)

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

  test.each([
    'before-transaction',
    'after-value:0',
    'after-owner:0',
    'after-operation:0',
    'pre-commit',
    'after-manifest',
  ])('IP2 same-value rewrite at %s never exposes the old REMOVE midpoint', async failpoint => {
    const { server, client } = await boot(failpoint)
    const key = keys[0]
    const before = readPhysicalPair(server.cwd, key)
    const state = await readState(client, key)

    const response = await mutate(client, rewriteBody(key, state.revision))

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'not-committed',
      operation: 'batch',
      code: 'PLUGIN_STORAGE_BATCH_ROLLED_BACK',
      retryable: false,
    })
    const after = readPhysicalPair(server.cwd, key)
    expect(after.value).toEqual(before.value)
    expect(after.owner).toEqual(before.owner)
    await expect(readState(client, key)).resolves.toMatchObject({
      missing: false,
      value: before.value.toString('base64'),
      revision: state.revision,
    })
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

  test('one manifest snapshot reports only physically present manifest-owned rows', async () => {
    const missingValue = activeManifest.valueKeys[1]
    const { client } = await boot('', missingValue)
    const snapshot = await readManifest(client)
    expect(snapshot).toEqual({
      success: true,
      generation: STORAGE_GENERATION,
      manifestRevision: expect.stringMatching(REVISION_PATTERN),
      manifest: activeManifest,
      valueKeys: activeManifest.valueKeys.filter(key => key !== missingValue),
      metaKeys: activeManifest.metaKeys,
    })
    expect(snapshot.valueKeys).not.toContain(valueKey('aa3/foreign'))
    expect(snapshot.valueKeys).not.toContain(missingValue)
    expect(snapshot.metaKeys).not.toContain(ownerKey('aa3/foreign'))

    await expect(readManifest(client, 'state')).resolves.toEqual({
      success: true,
      generation: STORAGE_GENERATION,
      manifestRevision: snapshot.manifestRevision,
    })
  })

  test('compact manifest CAS commits with the current token and rejects a stale token', async () => {
    const { client } = await boot()
    const state = await readManifest(client, 'state')
    const operation = {
      operation: 'set',
      key: 'aa3/new-compact',
      value: Buffer.from(JSON.stringify({ generation: 'new', key: 'aa3/new-compact' })).toString('base64'),
      owner: 'AA3',
    }
    const committed = await mutate(client, compactEnvelope(
      [operation],
      state.manifestRevision,
    ))
    expect(committed.status).toBe(200)
    const committedBody = await committed.json() as any
    expect(committedBody.revisions).toEqual([{
      key: 'aa3/new-compact',
      revision: expect.stringMatching(REVISION_PATTERN),
      valueHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }])

    const stale = await mutate(client, compactEnvelope(
      [operation],
      state.manifestRevision,
    ))
    expect(stale.status).toBe(409)
    await expect(stale.json()).resolves.toMatchObject({
      outcome: 'not-committed',
      code: 'PLUGIN_STORAGE_GENERATION_CONFLICT',
    })
    await expect(readState(client, 'aa3/new-compact')).resolves.toMatchObject({ missing: false })
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

  test('IP2 acknowledgement loss keeps the same-value row present and exactly reconcilable', async () => {
    const { server, client } = await boot('acknowledgement-loss')
    const key = keys[0]
    const before = readPhysicalPair(server.cwd, key)
    const state = await readState(client, key)

    await expect(mutate(client, rewriteBody(key, state.revision))).rejects.toThrow()

    const after = readPhysicalPair(server.cwd, key)
    expect(after.value).toEqual(before.value)
    const reconciled = await readState(
      await createClient(server.port, server.password),
      key,
    )
    expect(reconciled).toMatchObject({
      missing: false,
      value: before.value.toString('base64'),
    })
    expect(reconciled.revision).not.toBe(state.revision)
  })
})
