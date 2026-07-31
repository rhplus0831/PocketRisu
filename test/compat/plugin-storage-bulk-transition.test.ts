import { afterAll, describe, expect, test } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { addExtension, Packr } from 'msgpackr'
import { createClient } from './helpers/client.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createSeedBackup } from './helpers/seed.js'
import { decodeRisuDat } from './helpers/normalize.js'
import pluginSaveKeysPkg from '../../server/node/pluginSaveKeys.cjs'

const { encodePluginSaveStorageKey } = pluginSaveKeysPkg as {
  encodePluginSaveStorageKey: (rawKey: string, prefix: string) => string
}

const servers: ServerHandle[] = []
addExtension({
  Class: Function,
  type: 63,
  pack: () => Buffer.from([1]),
})
const packr = new Packr({ structuredClone: true, useRecords: true })
const MAGIC = Buffer.from('PRISUT01', 'ascii')
const PREFIX_BYTES = 12

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

function filePathHeader(key: string): string {
  return Buffer.from(key, 'utf8').toString('hex')
}

function bulkBody(metadata: Record<string, unknown>, payloads: Buffer[]): Buffer {
  const metadataBytes = Buffer.from(JSON.stringify(metadata), 'utf8')
  const prefix = Buffer.alloc(PREFIX_BYTES)
  MAGIC.copy(prefix)
  prefix.writeUInt32BE(metadataBytes.length, MAGIC.length)
  return Buffer.concat([prefix, metadataBytes, ...payloads])
}

function row(rawKey: string, prefix: 'pluginsave/' | 'pluginsave-meta/', value: unknown) {
  const bytes = Buffer.from(packr.encode(value))
  return {
    bytes,
    descriptor: {
      rawKey,
      storageKey: encodePluginSaveStorageKey(rawKey, prefix),
      valueLength: bytes.length,
      valueHash: createHash('sha256').update(bytes).digest('hex'),
    },
  }
}

describe('bulk plugin storage transitions (real server)', () => {
  test('converts and externalizes in one request, then internalizes without per-row reads', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    expect((await client.importBackup(createSeedBackup({
      databaseFields: {
        optimizePluginMemory: false,
        pluginCustomStorage: {},
      },
    }))).ok).toBe(true)

    const sparse = new Array(3)
    sparse[1] = Number.NaN
    const value = row('rich', 'pluginsave/', {
      date: new Date('2026-01-02T03:04:05.000Z'),
      map: new Map([[1n, new Set(['a', 'b'])]]),
      bigint: -42n,
      missing: undefined,
      sparse,
    })
    const owner = row('rich', 'pluginsave-meta/', {
      plugin: 'Bulk transition test',
      updatedAt: 1,
    })
    const externalId = randomUUID()
    const externalGeneration = randomUUID()
    const externalBody = bulkBody({
      version: 1,
      transitionId: externalId,
      source: { optimized: false, generation: null, manifest: null },
      targetOptimized: true,
      targetGeneration: externalGeneration,
      autoConvert: true,
      rows: [value.descriptor, owner.descriptor],
    }, [value.bytes, owner.bytes])
    const external = await client.fetch('/api/plugin-storage/transition/bulk', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-pocketrisu-plugin-storage-transition',
        'x-plugin-storage-transition-length': String(externalBody.length),
      },
      body: new Uint8Array(externalBody),
    })
    expect(external.status, await external.clone().text()).toBe(200)
    expect(await external.json()).toMatchObject({
      success: true,
      state: 'committed',
      direction: 'externalize',
      targetGeneration: externalGeneration,
      values: 1,
      meta: 1,
    })

    const valueResponse = await client.fetch('/api/read', {
      headers: {
        'file-path': filePathHeader(value.descriptor.storageKey),
        'x-plugin-storage-generation': externalGeneration,
      },
    })
    expect(valueResponse.status).toBe(200)
    expect(JSON.parse(Buffer.from(await valueResponse.arrayBuffer()).toString('utf8'))).toEqual({
      date: '2026-01-02T03:04:05.000Z',
      map: [['1', ['a', 'b']]],
      bigint: '-42',
      missing: null,
      sparse: [null, null, null],
    })

    const manifestResponse = await client.fetch('/api/plugin-storage/manifest', {
      headers: { 'x-plugin-storage-generation': externalGeneration },
    })
    const manifest = (await manifestResponse.json() as any).manifest
    const internalId = randomUUID()
    const internalGeneration = randomUUID()
    const internalBody = bulkBody({
      version: 1,
      transitionId: internalId,
      source: {
        optimized: true,
        generation: externalGeneration,
        manifest,
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
        'x-plugin-storage-transition-length': String(internalBody.length),
      },
      body: new Uint8Array(internalBody),
    })
    expect(internal.status, await internal.clone().text()).toBe(200)
    expect(await internal.json()).toMatchObject({
      success: true,
      state: 'committed',
      direction: 'internalize',
      targetGeneration: internalGeneration,
      values: 1,
      meta: 1,
    })

    const databaseResponse = await client.fetch('/api/read', {
      headers: { 'file-path': filePathHeader('database/database.bin') },
    })
    const database = decodeRisuDat(Buffer.from(await databaseResponse.arrayBuffer())) as any
    expect(database.optimizePluginMemory).toBe(false)
    expect(database.pluginStorageGeneration).toBe(internalGeneration)
    expect(database.pluginCustomStorage.rich).toEqual({
      date: '2026-01-02T03:04:05.000Z',
      map: [['1', ['a', 'b']]],
      bigint: '-42',
      missing: null,
      sparse: [null, null, null],
    })
    expect(database.pluginStorageMeta.rich).toMatchObject({
      plugin: 'Bulk transition test',
    })

    const rejected = row('still-rich', 'pluginsave/', new Map([['key', 'value']]))
    const rejectedBody = bulkBody({
      version: 1,
      transitionId: randomUUID(),
      source: {
        optimized: false,
        generation: internalGeneration,
        manifest: null,
      },
      targetOptimized: true,
      targetGeneration: randomUUID(),
      autoConvert: false,
      rows: [rejected.descriptor],
    }, [rejected.bytes])
    const rejectedResponse = await client.fetch('/api/plugin-storage/transition/bulk', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-pocketrisu-plugin-storage-transition',
        'x-plugin-storage-transition-length': String(rejectedBody.length),
      },
      body: new Uint8Array(rejectedBody),
    })
    expect(rejectedResponse.status).toBe(400)
    expect(await rejectedResponse.json()).toMatchObject({
      success: false,
      outcome: 'not-committed',
      code: 'PLUGIN_STORAGE_VALUE_UNSUPPORTED',
    })
    const unchangedResponse = await client.fetch('/api/read', {
      headers: { 'file-path': filePathHeader('database/database.bin') },
    })
    const unchanged = decodeRisuDat(Buffer.from(await unchangedResponse.arrayBuffer())) as any
    expect(unchanged.optimizePluginMemory).toBe(false)
    expect(unchanged.pluginStorageGeneration).toBe(internalGeneration)
    expect(unchanged.pluginCustomStorage).toEqual(database.pluginCustomStorage)

    const functionRow = row('function', 'pluginsave/', {
      callback: () => 'must not become null',
    })
    const functionBody = bulkBody({
      version: 1,
      transitionId: randomUUID(),
      source: {
        optimized: false,
        generation: internalGeneration,
        manifest: null,
      },
      targetOptimized: true,
      targetGeneration: randomUUID(),
      autoConvert: true,
      rows: [functionRow.descriptor],
    }, [functionRow.bytes])
    const functionResponse = await client.fetch('/api/plugin-storage/transition/bulk', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-pocketrisu-plugin-storage-transition',
        'x-plugin-storage-transition-length': String(functionBody.length),
      },
      body: new Uint8Array(functionBody),
    })
    expect(functionResponse.status).toBe(400)
    expect(await functionResponse.json()).toMatchObject({
      success: false,
      outcome: 'not-committed',
      code: 'PLUGIN_STORAGE_VALUE_UNSUPPORTED',
    })
  }, 30_000)
})
