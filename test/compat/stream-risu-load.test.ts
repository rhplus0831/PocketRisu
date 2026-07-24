import { afterAll, describe, expect, test } from 'vitest'
import { deflateSync, gzipSync } from 'node:zlib'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Packr } from 'msgpackr'
import chatRowsPkg from '../../server/node/chatRows.cjs'
import streamRisuLoadPkg from '../../server/node/streamRisuLoad.cjs'
import streamRisuSavePkg from '../../server/node/streamRisuSave.cjs'
import utilsPkg from '../../server/node/utils.cjs'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient } from './helpers/client.js'
import { encodeBackup } from './helpers/encode.js'

const { createChatRowStore } = chatRowsPkg as any
const { scanMessagePackValue, walkRisuSave } = streamRisuLoadPkg as any
const { streamRisuSaveToFile } = streamRisuSavePkg as any
const {
  decodeRisuSave,
  encodeRisuSaveLegacy,
  magicStreamCompressedHeader,
} = utilsPkg as any

const packr = new Packr({ useRecords: false })
const tempDirs: string[] = []
const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
})

function makeStore() {
  const values = new Map<string, Buffer>()
  let nextId = 0
  const store = createChatRowStore({
    db: { transaction: (fn: () => unknown) => fn },
    kvGet: (key: string) => values.get(key) ?? null,
    kvSet: (key: string, value: Buffer) => values.set(key, Buffer.from(value)),
    kvDel: (key: string) => values.delete(key),
    kvList: (prefix: string) => [...values.keys()].filter(key => key.startsWith(prefix)),
    kvListWithSizes: (prefix: string) => [...values.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, size: value.length })),
    kvGetUpdatedAt: () => null,
    randomUUID: () => `deterministic-id-${++nextId}`,
  })
  return { store, values }
}

function fixtureDatabase() {
  const manyMapEntries = Object.fromEntries(
    Array.from({ length: 18 }, (_, index) => [`map-key-${index}`, { index, ok: true }]),
  )
  const numericWidths = [
    0, 127, 128, 255, 256, 65_535, 65_536, 4_294_967_296,
    -1, -32, -33, -128, -129, -32_768, -32_769, -4_294_967_296,
    1.25, Number.POSITIVE_INFINITY,
  ]
  const chats = [
    {
      name: 'missing id',
      folderId: 'missing-folder',
      message: Array.from({ length: 18 }, (_, index) => ({
        role: index % 2 ? 'char' : 'user',
        data: `메시지-${index}-世界`,
        nested: [index, null, undefined, { when: new Date('2024-01-02T03:04:05.000Z') }],
      })),
    },
    { id: 'duplicate', name: 'first duplicate', message: [] },
    { id: 'duplicate', name: 'second duplicate', message: [{ role: 'user', data: 'duplicate id' }] },
    { id: 'metadata-only', name: 'No payload', folderId: 'missing-folder' },
    null,
  ]

  return {
    ...manyMapEntries,
    botPresets: [{ id: 'stable-preset', name: 'Stable' }],
    optimizePluginMemory: false,
    unicode: { '유니코드 키': ['世界', null, undefined] },
    undefinedProperty: undefined,
    explicitNull: null,
    timestamp: new Date('2020-01-01T00:00:00.000Z'),
    numericWidths,
    stringWidths: ['x'.repeat(40), 'y'.repeat(300), 'z'.repeat(70_000)],
    binaryWidths: [Buffer.alloc(20, 1), Buffer.alloc(300, 2)],
    manyArrayElements: Array.from({ length: 18 }, (_, index) => ({ index })),
    pluginCustomStorage: { retained: { date: new Date('2023-03-04T05:06:07.000Z') } },
    characters: [
      // chats deliberately precedes chaId to prove the walker does not rely on
      // serializer field order when selecting the row key.
      { chats, chaId: 'main-character', name: '메인', chatFolders: [{ id: 'valid-folder' }] },
      { chaId: 'empty-character', name: 'Empty', chats: [] },
      { chaId: 'without-chats', name: 'No chats field' },
      { name: 'No chaId', chats: [{ name: 'retained inline', message: [{ data: 'inline' }] }] },
    ],
  }
}

async function decodedState(values: Map<string, Buffer>) {
  const keys = [...values.keys()]
    .filter(key => key === 'database/database.bin' || key.startsWith('chats/'))
    .sort()
  return Promise.all(keys.map(async key => [key, await decodeRisuSave(values.get(key)!)]))
}

describe('disk-backed streaming Risu ingest', () => {
  test('skips every standard MessagePack marker, including 32-bit collections and extensions', async () => {
    const values = [
      Buffer.from([0x00]), Buffer.from([0xff]),
      Buffer.from([0xc0]), Buffer.from([0xc2]), Buffer.from([0xc3]),
      Buffer.from([0xcc, 1]), Buffer.from([0xcd, 0, 1]),
      Buffer.from([0xce, 0, 0, 0, 1]), Buffer.from([0xcf, 0, 0, 0, 0, 0, 0, 0, 1]),
      Buffer.from([0xd0, 0]), Buffer.from([0xd1, 0, 0]),
      Buffer.from([0xd2, 0, 0, 0, 0]), Buffer.from([0xd3, 0, 0, 0, 0, 0, 0, 0, 0]),
      Buffer.from([0xca, 0, 0, 0, 0]), Buffer.from([0xcb, 0, 0, 0, 0, 0, 0, 0, 0]),
      Buffer.from([0xa1, 0x61]),
      Buffer.from([0xd9, 1, 0x61]), Buffer.from([0xda, 0, 1, 0x61]),
      Buffer.from([0xdb, 0, 0, 0, 1, 0x61]),
      Buffer.from([0xc4, 1, 1]), Buffer.from([0xc5, 0, 1, 1]),
      Buffer.from([0xc6, 0, 0, 0, 1, 1]),
      Buffer.from([0x91, 0xc0]), Buffer.from([0xdc, 0, 1, 0xc0]),
      Buffer.from([0xdd, 0, 0, 0, 1, 0xc0]),
      Buffer.from([0x81, 0xc0, 0xc0]), Buffer.from([0xde, 0, 1, 0xc0, 0xc0]),
      Buffer.from([0xdf, 0, 0, 0, 1, 0xc0, 0xc0]),
      Buffer.from([0xd4, 1, 0]), Buffer.from([0xd5, 1, 0, 0]),
      Buffer.from([0xd6, 1, 0, 0, 0, 0]),
      Buffer.from([0xd7, 1, 0, 0, 0, 0, 0, 0, 0, 0]),
      Buffer.from([0xd8, 1, ...Array(16).fill(0)]),
      Buffer.from([0xc7, 1, 1, 0]), Buffer.from([0xc8, 0, 1, 1, 0]),
      Buffer.from([0xc9, 0, 0, 0, 1, 1, 0]),
    ]
    const payload = Buffer.concat([
      Buffer.from([0xdd, 0, 0, 0, values.length]),
      ...values,
    ])
    expect(await scanMessagePackValue(payload)).toBe(payload.length)
    await expect(scanMessagePackValue(payload.subarray(0, -1))).rejects.toThrow(/Truncated/)
  })

  test('matches in-memory ingest for raw, gzip, stream-gzip, and file-spooled saves', async () => {
    const database = fixtureDatabase()
    const raw = Buffer.from(encodeRisuSaveLegacy(database))
    const compressed = Buffer.from(encodeRisuSaveLegacy(database, 'compression'))
    const zlibCompressed = Buffer.concat([
      Buffer.from((utilsPkg as any).magicCompressedHeader),
      deflateSync(packr.encode(database)),
    ])
    const streamCompressed = Buffer.concat([
      Buffer.from(magicStreamCompressedHeader),
      gzipSync(packr.encode(database)),
    ])

    const tempDir = await mkdtemp(path.join(tmpdir(), 'risu-stream-load-'))
    tempDirs.push(tempDir)
    const streamedPath = path.join(tempDir, 'database-streamed.risudat.tmp')
    await streamRisuSaveToFile({
      dbObj: database,
      filePath: streamedPath,
      readChatRow: async () => null,
    })

    const variants: Array<{ name: string; oldBytes: Buffer; streamingSource: any }> = [
      { name: 'raw', oldBytes: raw, streamingSource: raw },
      { name: 'compressed', oldBytes: compressed, streamingSource: compressed },
      { name: 'zlib-compressed', oldBytes: zlibCompressed, streamingSource: zlibCompressed },
      { name: 'stream-compressed', oldBytes: streamCompressed, streamingSource: streamCompressed },
      { name: 'file-spooled', oldBytes: await readFile(streamedPath), streamingSource: { filePath: streamedPath } },
    ]

    for (const variant of variants) {
      const legacy = makeStore()
      const streaming = makeStore()
      const oldResult = await legacy.store.ingestFullDatabase(variant.oldBytes)
      const newResult = await streaming.store.ingestStreamingDatabase(variant.streamingSource)

      expect(newResult.strippedDb, variant.name).toEqual(oldResult.strippedDb)
      expect(newResult.stats, variant.name).toEqual(oldResult.stats)
      expect(await decodedState(streaming.values), variant.name)
        .toEqual(await decodedState(legacy.values))
    }
  })

  test('rejects a truncated raw spool', async () => {
    const raw = Buffer.from(encodeRisuSaveLegacy(fixtureDatabase()))
    const tempDir = await mkdtemp(path.join(tmpdir(), 'risu-stream-truncated-'))
    tempDirs.push(tempDir)
    const filePath = path.join(tempDir, 'truncated.risudat.tmp')
    await writeFile(filePath, raw.subarray(0, raw.length - 7))
    await expect(walkRisuSave({ filePath })).rejects.toThrow(/Truncated MessagePack payload/)
  })

  test('rejects corrupt gzip without leaving a decoded temp file', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'risu-stream-corrupt-'))
    tempDirs.push(tempDir)
    const filePath = path.join(tempDir, 'corrupt.risudat.tmp')
    await writeFile(filePath, Buffer.concat([
      Buffer.from((utilsPkg as any).magicCompressedHeader),
      Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef]),
    ]))
    await expect(walkRisuSave({ filePath })).rejects.toThrow(/Failed to decompress streaming Risu save/)
    expect((await import('node:fs/promises')).readdir(tempDir).then(files => files.sort()))
      .resolves.toEqual(['corrupt.risudat.tmp'])
  })

  test('backup import clearly rejects encrypted risuai.xyz account backups', async () => {
    const server = await spawnServer({ env: { RISU_STREAM_INGEST_MIN_BYTES: '1' } })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const backup = encodeBackup([
      { name: 'encryption.risudat', data: Buffer.from('{"encrypted":true}') },
      { name: 'database.risudat', data: Buffer.from(encodeRisuSaveLegacy(fixtureDatabase())) },
    ])
    const response = await client.fetch('/api/backup/import', {
      method: 'POST',
      headers: { 'content-type': 'application/x-risu-backup' },
      body: new Uint8Array(backup),
    })
    const text = await response.text()
    expect(response.ok).toBe(false)
    expect(text).toContain('Encrypted risuai.xyz account backups cannot be imported')
    expect(text).toContain('Re-export')
  })
})
