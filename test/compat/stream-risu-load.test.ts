import { afterAll, describe, expect, test } from 'vitest'
import { deflateRawSync, deflateSync, gzipSync } from 'node:zlib'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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
const {
  decodeBoundedLegacyRisuSave,
  inspectRisuSaveSource,
  scanMessagePackValue,
  walkRisuSave,
} = streamRisuLoadPkg as any
const { streamRisuSaveToFile } = streamRisuSavePkg as any
const {
  decodeRisuSave,
  encodeRisuSaveLegacy,
  magicHeader,
  magicPluginStorageHeader,
  magicStreamCompressedHeader,
} = utilsPkg as any

const packr = new Packr({ useRecords: false })
const SPECIAL_PLUGIN_STORAGE_KEYS = [
  '__proto__', 'constructor', '\uD800', '�', '\uD801',
  'prototype', 'toString', 'hasOwnProperty', '',
] as const
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

function encodeRisuSaveBlock(
  type: number,
  name: string,
  value: unknown,
  compressed = false,
): Buffer {
  const json = Buffer.from(JSON.stringify(value), 'utf-8')
  const body = compressed ? gzipSync(json) : json
  return encodeRawRisuSaveBlock(type, name, body, compressed)
}

function encodeRawRisuSaveBlock(
  type: number,
  name: string,
  body: Buffer,
  compressed = false,
): Buffer {
  const nameBytes = Buffer.from(name, 'utf-8')
  const header = Buffer.alloc(3 + nameBytes.length + 4)
  header[0] = type
  header[1] = compressed ? 1 : 0
  header[2] = nameBytes.length
  nameBytes.copy(header, 3)
  header.writeUInt32LE(body.length, 3 + nameBytes.length)
  return Buffer.concat([header, body])
}

function encodeBlockRisuSave(database: Record<string, unknown>): Buffer {
  const { characters = [], pluginCustomStorage = {}, ...root } = database
  return Buffer.concat([
    Buffer.from('RISUSAVE\0', 'binary'),
    encodeRisuSaveBlock(1, 'root', root, true),
    ...((characters as unknown[]) ?? []).map((character, index) => (
      encodeRisuSaveBlock(2, `character-${index}`, character, index % 2 === 0)
    )),
    encodeRisuSaveBlock(11, 'plugin-storage', pluginCustomStorage, true),
  ])
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
    const rawDeflateCompressed = Buffer.concat([
      Buffer.from((utilsPkg as any).magicCompressedHeader),
      deflateRawSync(packr.encode(database)),
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
      { name: 'raw-deflate-compressed', oldBytes: rawDeflateCompressed, streamingSource: rawDeflateCompressed },
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

  test('externalizes escaped special plugin keys in their original order', async () => {
    const pluginCustomStorage: Record<string, unknown> = {}
    const pluginStorageMeta: Record<string, unknown> = {}
    for (const [index, key] of SPECIAL_PLUGIN_STORAGE_KEYS.entries()) {
      Object.defineProperty(pluginCustomStorage, key, {
        configurable: true,
        enumerable: true,
        value: { index },
        writable: true,
      })
      Object.defineProperty(pluginStorageMeta, key, {
        configurable: true,
        enumerable: true,
        value: { plugin: `Plugin ${index}`, updatedAt: index },
        writable: true,
      })
    }
    const entries: Array<{ field: string; key: string; value: unknown }> = []
    const walked = await walkRisuSave(encodeRisuSaveLegacy({
      botPresets: [{ id: 'stable-preset' }],
      characters: [],
      optimizePluginMemory: true,
      pluginCustomStorage,
      pluginStorageMeta,
    }), {
      externalizePluginStorage: true,
      onPluginStorageEntry: (entry: { field: string; key: string; value: unknown }) => {
        entries.push(entry)
      },
    })

    expect(entries.filter(entry => entry.field === 'pluginCustomStorage').map(entry => entry.key))
      .toEqual(SPECIAL_PLUGIN_STORAGE_KEYS)
    expect(entries.filter(entry => entry.field === 'pluginStorageMeta').map(entry => entry.key))
      .toEqual(SPECIAL_PLUGIN_STORAGE_KEYS)
    expect(walked.remainder.pluginCustomStorage).toEqual({})
    expect(walked.remainder.pluginStorageMeta).toBeUndefined()
  })

  test.each([
    ['optimized', { optimizePluginMemory: true }],
    ['folded', { optimizePluginMemory: false, pluginStorageFolded: true }],
  ] as const)(
    'strict-validates and canonicalizes every %s plugin record before the empty gate',
    async (_mode, activeFields) => {
      const walk = (fields: Record<string, unknown>) => walkRisuSave(
        encodeRisuSaveLegacy({
          characters: [],
          ...activeFields,
          ...fields,
        }),
        {
          externalizePluginStorage: true,
          onPluginStorageEntry: () => undefined,
          onPluginStorageFolded: () => undefined,
        },
      )

      for (const fields of [
        {},
        { pluginCustomStorage: null },
        { pluginCustomStorage: {} },
        { pluginCustomStorage: {}, pluginStorageMeta: {} },
      ]) {
        const walked = await walk(fields)
        expect(walked.remainder.pluginCustomStorage).toEqual({})
        expect(walked.remainder.pluginStorageMeta).toBeUndefined()
      }

      for (const pluginCustomStorage of [[], 0, false, 'primitive']) {
        await expect(walk({ pluginCustomStorage })).rejects.toMatchObject({
          code: 'INVALID_PLUGIN_STORAGE_ROW',
          encodedKey: 'pluginsave/',
          message: 'Invalid plugin storage JSON row',
        })
      }
      for (const pluginStorageMeta of [null, [], 0, false, 'primitive']) {
        await expect(walk({ pluginCustomStorage: {}, pluginStorageMeta }))
          .rejects.toMatchObject({
            code: 'INVALID_PLUGIN_STORAGE_ROW',
            encodedKey: 'pluginsave-meta/',
            message: 'Invalid plugin storage JSON row',
          })
      }
    },
  )

  test.each([
    ['optimized', { optimizePluginMemory: true }],
    ['folded', { optimizePluginMemory: false, pluginStorageFolded: true }],
  ] as const)('canonicalizes streamed %s row values before callbacks', async (_mode, activeFields) => {
    const entries: Array<{ field: string; key: string; value: unknown }> = []
    await walkRisuSave(encodeRisuSaveLegacy({
      characters: [],
      ...activeFields,
      pluginCustomStorage: { row: [-0, { finite: 1 }] },
    }), {
      externalizePluginStorage: true,
      onPluginStorageEntry: (entry: { field: string; key: string; value: unknown }) => {
        entries.push(entry)
      },
      onPluginStorageFolded: () => undefined,
    })

    expect(entries).toEqual([{
      field: 'pluginCustomStorage',
      key: 'row',
      value: [0, { finite: 1 }],
    }])
  })

  test('does not interpret a valid sidecar-shaped user field on an unmarked stream', async () => {
    const validCollision = [
      'PocketRisu.plugin-storage-escapes',
      1,
      null,
      [['pluginCustomStorage', 0, [1, '"forged"']]],
    ]
    const database: Record<string, unknown> = {
      botPresets: [{ id: 'stable-preset' }],
      characters: [],
      optimizePluginMemory: false,
      pluginCustomStorage: { safe: 'external' },
    }
    Object.defineProperty(database, '__pocketRisuPluginStorageEscapesV1', {
      configurable: true,
      enumerable: true,
      value: validCollision,
      writable: true,
    })
    const raw = Buffer.concat([Buffer.from(magicHeader), packr.encode(database)])

    const walked = await walkRisuSave(raw)

    expect(walked.remainder.__pocketRisuPluginStorageEscapesV1).toEqual(validCollision)
    expect(walked.remainder.pluginCustomStorage.safe).toBe('external')
    expect(Object.hasOwn(walked.remainder.pluginCustomStorage, '__proto__')).toBe(false)
  })

  test('restores a marked v1 __proto__ sidecar written by older PocketRisu builds', async () => {
    const database: Record<string, unknown> = {
      characters: [],
      optimizePluginMemory: false,
      pluginCustomStorage: { before: 'before', after: 'after' },
      __pocketRisuPluginStorageEscapesV1: [
        'PocketRisu.plugin-storage-escapes',
        1,
        null,
        [['pluginCustomStorage', 1, [1, '"legacy-proto"']]],
      ],
    }
    const raw = Buffer.concat([
      Buffer.from(magicPluginStorageHeader),
      packr.encode(database),
    ])

    const walked = await walkRisuSave(raw)

    expect(Object.keys(walked.remainder.pluginCustomStorage)).toEqual([
      'before', '__proto__', 'after',
    ])
    expect(walked.remainder.pluginCustomStorage.__proto__).toBe('legacy-proto')
    expect(Object.hasOwn(walked.remainder, '__pocketRisuPluginStorageEscapesV1')).toBe(false)
  })

  test('rejects a truncated raw spool', async () => {
    const raw = Buffer.from(encodeRisuSaveLegacy(fixtureDatabase()))
    const tempDir = await mkdtemp(path.join(tmpdir(), 'risu-stream-truncated-'))
    tempDirs.push(tempDir)
    const filePath = path.join(tempDir, 'truncated.risudat.tmp')
    await writeFile(filePath, raw.subarray(0, raw.length - 7))
    await expect(walkRisuSave({ filePath })).rejects.toThrow(/Truncated MessagePack payload/)
  })

  test('cursor-walks actual headerless and old-prefix MessagePack fixtures', async () => {
    const database = fixtureDatabase()
    const payload = Buffer.from(packr.encode(database))
    const fixtures = [
      { name: 'headerless', bytes: payload },
      { name: 'old-six-byte-prefix', bytes: Buffer.concat([Buffer.from('\0\0RISU', 'binary'), payload]) },
    ]

    for (const fixture of fixtures) {
      const inspection = await inspectRisuSaveSource(fixture.bytes)
      expect(inspection, fixture.name).toMatchObject({ format: 'raw', supported: true })
      const walked = await walkRisuSave(fixture.bytes, { inspection })
      expect(walked.remainder, fixture.name).toEqual(
        (await walkRisuSave(encodeRisuSaveLegacy(database))).remainder,
      )
    }
  })

  test.each([
    ['gzip-v8', (payload: Buffer) => Buffer.concat([
      Buffer.from((utilsPkg as any).magicCompressedHeader),
      gzipSync(payload),
    ])],
    ['zlib-v8', (payload: Buffer) => Buffer.concat([
      Buffer.from((utilsPkg as any).magicCompressedHeader),
      deflateSync(payload),
    ])],
    ['stream-gzip-v9', (payload: Buffer) => Buffer.concat([
      Buffer.from(magicStreamCompressedHeader),
      gzipSync(payload),
    ])],
  ] as const)('meters %s decoded output at the exact byte boundary', async (_name, wrap) => {
    const payload = Buffer.from(packr.encode({ characters: [], exact: 'boundary' }))
    const bytes = wrap(payload)
    const tempDir = await mkdtemp(path.join(tmpdir(), 'risu-stream-boundary-'))
    tempDirs.push(tempDir)
    const filePath = path.join(tempDir, 'source.risudat.tmp')
    await writeFile(filePath, bytes)
    const observed: number[] = []

    await expect(walkRisuSave({ filePath }, {
      maxDecodedBytes: payload.length,
      diskHeadroomBytes: 0,
      availableDiskBytes: payload.length,
      onDecodedChunk: ({ bytes: chunkBytes }: { bytes: number }) => observed.push(chunkBytes),
    })).resolves.toMatchObject({ remainder: { characters: [], exact: 'boundary' } })
    expect(Math.max(...observed)).toBeLessThanOrEqual(64 * 1024)
    expect(await readdir(tempDir)).toEqual(['source.risudat.tmp'])

    await expect(walkRisuSave({ filePath }, {
      maxDecodedBytes: payload.length - 1,
      diskHeadroomBytes: 0,
      availableDiskBytes: payload.length * 2,
    })).rejects.toMatchObject({
      code: 'RISU_SAVE_DECODED_TOO_LARGE',
      limit: payload.length - 1,
      retryable: false,
      commitOutcome: 'not-committed',
      commitOutcomeUnknown: false,
    })
    expect(await readdir(tempDir)).toEqual(['source.risudat.tmp'])
  })

  test('stops a compressed expansion bomb within one 64 KiB output chunk', async () => {
    const payload = Buffer.from(packr.encode({
      characters: [],
      padding: 'A'.repeat(8 * 1024 * 1024),
    }))
    const bytes = Buffer.concat([
      Buffer.from((utilsPkg as any).magicCompressedHeader),
      gzipSync(payload),
    ])
    const tempDir = await mkdtemp(path.join(tmpdir(), 'risu-stream-bomb-'))
    tempDirs.push(tempDir)
    const filePath = path.join(tempDir, 'bomb.risudat.tmp')
    await writeFile(filePath, bytes)
    let observed = 0

    let failure: any
    try {
      await walkRisuSave({ filePath }, {
        maxDecodedBytes: 128 * 1024,
        diskHeadroomBytes: 0,
        availableDiskBytes: 16 * 1024 * 1024,
        onDecodedChunk: ({ total }: { total: number }) => { observed = total },
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({
      code: 'RISU_SAVE_DECODED_TOO_LARGE',
      limit: 128 * 1024,
      retryable: false,
    })
    expect(failure.actual).toBeLessThanOrEqual(192 * 1024)
    expect(observed).toBeLessThanOrEqual(128 * 1024)
    expect(await readdir(tempDir)).toEqual(['bomb.risudat.tmp'])
  })

  test('accepts exact decode disk headroom and rejects one byte less', async () => {
    const payload = Buffer.from(packr.encode({ characters: [], disk: 'boundary' }))
    const bytes = Buffer.concat([
      Buffer.from((utilsPkg as any).magicCompressedHeader),
      gzipSync(payload),
    ])
    const headroom = 4096

    await expect(walkRisuSave(bytes, {
      maxDecodedBytes: payload.length * 2,
      diskHeadroomBytes: headroom,
      availableDiskBytes: payload.length + headroom,
    })).resolves.toMatchObject({ remainder: { characters: [], disk: 'boundary' } })

    await expect(walkRisuSave(bytes, {
      maxDecodedBytes: payload.length * 2,
      diskHeadroomBytes: headroom,
      availableDiskBytes: payload.length + headroom - 1,
    })).rejects.toMatchObject({
      code: 'RISU_SAVE_DECODE_DISK_HEADROOM',
      limit: payload.length - 1,
      retryable: false,
      commitOutcome: 'not-committed',
      commitOutcomeUnknown: false,
    })
  })

  test('AbortSignal cancels during real gzip decompression and removes decoded spools', async () => {
    const payload = Buffer.from(packr.encode({
      characters: [],
      padding: 'abort-me-'.repeat(512 * 1024),
    }))
    const bytes = Buffer.concat([
      Buffer.from((utilsPkg as any).magicCompressedHeader),
      gzipSync(payload),
    ])
    const tempDir = await mkdtemp(path.join(tmpdir(), 'risu-stream-abort-'))
    tempDirs.push(tempDir)
    const filePath = path.join(tempDir, 'abort.risudat.tmp')
    await writeFile(filePath, bytes)
    const controller = new AbortController()

    await expect(walkRisuSave({ filePath }, {
      signal: controller.signal,
      diskHeadroomBytes: 0,
      onDecodedChunk: () => controller.abort(new Error('disconnect mid-decompress')),
    })).rejects.toMatchObject({
      name: 'AbortError',
      code: 'RISU_STREAM_ABORTED',
    })
    expect(await readdir(tempDir)).toEqual(['abort.risudat.tmp'])
  })

  test('bounds real block, REMOTE, compressed JSON, and raw-deflate compatibility fixtures', async () => {
    const database = {
      characters: [{ chaId: 'block-char', chats: [], name: 'Block Character' }],
      optimizePluginMemory: false,
      pluginCustomStorage: { block: { works: true } },
    }
    const blockBytes = encodeBlockRisuSave(database)
    const blockInspection = await inspectRisuSaveSource(blockBytes)
    expect(blockInspection).toMatchObject({ format: 'risusave', supported: false })
    await expect(decodeBoundedLegacyRisuSave(blockBytes, {
      inspection: blockInspection,
      maxLegacyBytes: blockBytes.length,
      maxDecodedBytes: 1024 * 1024,
      diskHeadroomBytes: 0,
      availableDiskBytes: 1024 * 1024,
    })).resolves.toMatchObject(database)
    await expect(decodeBoundedLegacyRisuSave(blockBytes, {
      inspection: blockInspection,
      maxLegacyBytes: blockBytes.length - 1,
      maxDecodedBytes: 1024 * 1024,
      diskHeadroomBytes: 0,
      availableDiskBytes: 1024 * 1024,
    })).rejects.toMatchObject({
      code: 'RISU_SAVE_LEGACY_TOO_LARGE',
      limit: blockBytes.length - 1,
      actual: blockBytes.length,
      retryable: false,
      commitOutcome: 'not-committed',
      commitOutcomeUnknown: false,
    })

    const remoteBytes = Buffer.concat([
      Buffer.from('RISUSAVE\0', 'binary'),
      encodeRisuSaveBlock(1, 'root', { optimizePluginMemory: false }, true),
      encodeRisuSaveBlock(6, 'remote-char', {
        v: 1,
        type: 2,
        name: 'remote-char',
      }),
    ])
    await expect(decodeBoundedLegacyRisuSave(remoteBytes, {
      inspection: await inspectRisuSaveSource(remoteBytes),
      maxLegacyBytes: 1024 * 1024,
      maxDecodedBytes: 1024 * 1024,
      diskHeadroomBytes: 0,
      availableDiskBytes: 1024 * 1024,
      resolveRemoteSize: async (name: string) => name === 'remote-char'
        ? Buffer.byteLength(JSON.stringify({
          chaId: 'remote-char',
          name: 'Resolved Remote',
          chats: [],
        }))
        : null,
      resolveRemote: async (name: string) => name === 'remote-char'
        ? Buffer.from(JSON.stringify({
          chaId: 'remote-char',
          name: 'Resolved Remote',
          chats: [],
        }))
        : null,
    })).resolves.toMatchObject({
      characters: [{ chaId: 'remote-char', name: 'Resolved Remote', chats: [] }],
    })

    const json = Buffer.from(JSON.stringify(database), 'utf-8')
    for (const [name, bytes] of [
      ['zlib-json', deflateSync(json)],
      ['raw-deflate-json', deflateRawSync(json)],
    ] as const) {
      const inspection = await inspectRisuSaveSource(bytes)
      await expect(decodeBoundedLegacyRisuSave(bytes, {
        inspection,
        maxLegacyBytes: json.length,
        maxDecodedBytes: json.length,
        diskHeadroomBytes: 0,
        availableDiskBytes: json.length,
      }), name).resolves.toEqual(database)
    }
  })

  test('strict bounded block restore rejects partial JSON and aborts the second expansion pass', async () => {
    const malformedInline = Buffer.concat([
      Buffer.from('RISUSAVE\0', 'binary'),
      encodeRisuSaveBlock(1, 'root', { marker: 'root-survives-direct-compat' }),
      encodeRawRisuSaveBlock(2, 'character', Buffer.from('{"chaId":')),
    ])
    await expect(decodeRisuSave(malformedInline)).resolves.toMatchObject({
      marker: 'root-survives-direct-compat',
      characters: [],
    })
    await expect(decodeBoundedLegacyRisuSave(malformedInline, {
      maxLegacyBytes: 1024 * 1024,
      maxDecodedBytes: 1024 * 1024,
    })).rejects.toMatchObject({
      code: 'RISU_SAVE_INVALID',
      status: 400,
      commitOutcome: 'not-committed',
      commitOutcomeUnknown: false,
    })

    const missingDirectoryBlock = Buffer.concat([
      Buffer.from('RISUSAVE\0', 'binary'),
      encodeRisuSaveBlock(1, 'root', {
        marker: 'directory-survives-direct-compat',
        __directory: ['missing-character'],
      }),
    ])
    await expect(decodeRisuSave(missingDirectoryBlock)).resolves.toMatchObject({
      marker: 'directory-survives-direct-compat',
      characters: [],
    })
    await expect(decodeBoundedLegacyRisuSave(missingDirectoryBlock, {
      maxLegacyBytes: 1024 * 1024,
      maxDecodedBytes: 1024 * 1024,
    })).rejects.toMatchObject({
      code: 'RISU_SAVE_INVALID',
      status: 400,
      commitOutcome: 'not-committed',
      commitOutcomeUnknown: false,
    })

    const remoteSource = Buffer.concat([
      Buffer.from('RISUSAVE\0', 'binary'),
      encodeRisuSaveBlock(1, 'root', { marker: 'remote-source' }),
      encodeRisuSaveBlock(6, 'remote-character', {
        v: 1,
        type: 2,
        name: 'remote-character',
      }),
    ])
    const malformedRemote = Buffer.from('{"chaId":')
    await expect(decodeBoundedLegacyRisuSave(remoteSource, {
      maxLegacyBytes: 1024 * 1024,
      maxDecodedBytes: 1024 * 1024,
      resolveRemoteSize: async () => malformedRemote.length,
      resolveRemote: async () => malformedRemote,
    })).rejects.toMatchObject({
      code: 'RISU_SAVE_INVALID',
      status: 400,
      commitOutcome: 'not-committed',
      commitOutcomeUnknown: false,
    })

    const unsupportedRemote = Buffer.concat([
      Buffer.from('RISUSAVE\0', 'binary'),
      encodeRisuSaveBlock(1, 'root', {}),
      encodeRisuSaveBlock(6, 'unknown-target', { v: 1, type: 255, name: 'unknown-target' }),
    ])
    await expect(decodeBoundedLegacyRisuSave(unsupportedRemote, {
      maxLegacyBytes: 1024 * 1024,
      maxDecodedBytes: 1024 * 1024,
      resolveRemoteSize: async () => 2,
      resolveRemote: async () => Buffer.from('{}'),
    })).rejects.toMatchObject({
      code: 'RISU_SAVE_INVALID',
      status: 400,
    })

    const compressed = encodeBlockRisuSave({
      characters: [{ chaId: 'never-decoded', chats: [] }],
      padding: 'bounded-cancel-'.repeat(16 * 1024),
    })
    const controller = new AbortController()
    let secondPassStarted = 0
    await expect(decodeBoundedLegacyRisuSave(compressed, {
      maxLegacyBytes: 1024 * 1024,
      maxDecodedBytes: 1024 * 1024,
      diskHeadroomBytes: 0,
      availableDiskBytes: 1024 * 1024,
      signal: controller.signal,
      onCompressedBlockDecode: () => {
        secondPassStarted++
      },
      onCompressedBlockDecodedChunk: () => {
        controller.abort(new Error('disconnect during strict block expansion'))
      },
    })).rejects.toMatchObject({
      name: 'AbortError',
      code: 'RISU_STREAM_ABORTED',
    })
    expect(secondPassStarted).toBe(1)
  })

  test('bounds nested REMOTEs before materialization, detects cycles, and caches duplicates', async () => {
    const remotePointer = (name: string, type: number) => Buffer.from(JSON.stringify({
      v: 1,
      type,
      name,
    }))
    const character = Buffer.from(JSON.stringify({
      chaId: 'nested-char',
      name: 'Nested Remote',
      chats: [],
    }))
    const sourceWithPointers = (...names: string[]) => Buffer.concat([
      Buffer.from('RISUSAVE\0', 'binary'),
      encodeRisuSaveBlock(1, 'root', { optimizePluginMemory: false }),
      ...names.map((name, index) => encodeRisuSaveBlock(6, `pointer-${index}`, {
        v: 1,
        type: 6,
        name,
      })),
    ])

    const nestedSource = sourceWithPointers('remote-a')
    const nestedValues = new Map<string, Buffer>([
      ['remote-a', remotePointer('remote-b', 2)],
      ['remote-b', character],
    ])
    const sizeCalls: string[] = []
    const readCalls: string[] = []
    await expect(decodeBoundedLegacyRisuSave(nestedSource, {
      maxLegacyBytes: 1024 * 1024,
      maxDecodedBytes: 1024 * 1024,
      resolveRemoteSize: async (name: string) => {
        sizeCalls.push(name)
        return nestedValues.get(name)?.length ?? null
      },
      resolveRemote: async (name: string) => {
        readCalls.push(name)
        return nestedValues.get(name) ?? null
      },
    })).resolves.toMatchObject({
      characters: [{ chaId: 'nested-char', name: 'Nested Remote' }],
    })
    expect(sizeCalls).toEqual(['remote-a', 'remote-b'])
    expect(readCalls).toEqual(['remote-a', 'remote-b'])

    const duplicateSource = Buffer.concat([
      Buffer.from('RISUSAVE\0', 'binary'),
      encodeRisuSaveBlock(1, 'root', { optimizePluginMemory: false }),
      encodeRisuSaveBlock(6, 'pointer-0', { v: 1, type: 2, name: 'remote-b' }),
      encodeRisuSaveBlock(6, 'pointer-1', { v: 1, type: 2, name: 'remote-b' }),
    ])
    let duplicateSizeCalls = 0
    let duplicateReadCalls = 0
    const duplicateResult = await decodeBoundedLegacyRisuSave(duplicateSource, {
      maxLegacyBytes: 1024 * 1024,
      maxDecodedBytes: 1024 * 1024,
      resolveRemoteSize: async () => {
        duplicateSizeCalls++
        return character.length
      },
      resolveRemote: async () => {
        duplicateReadCalls++
        return character
      },
    })
    expect(duplicateResult.characters).toHaveLength(2)
    expect(duplicateSizeCalls).toBe(1)
    expect(duplicateReadCalls).toBe(1)

    const cycleValues = new Map<string, Buffer>([
      ['remote-a', remotePointer('remote-b', 6)],
      ['remote-b', remotePointer('remote-a', 6)],
    ])
    await expect(decodeBoundedLegacyRisuSave(nestedSource, {
      maxLegacyBytes: 1024 * 1024,
      maxDecodedBytes: 1024 * 1024,
      resolveRemoteSize: async (name: string) => cycleValues.get(name)?.length ?? null,
      resolveRemote: async (name: string) => cycleValues.get(name) ?? null,
    })).rejects.toMatchObject({
      code: 'RISU_SAVE_INVALID',
      status: 400,
      commitOutcome: 'not-committed',
      commitOutcomeUnknown: false,
    })

    const depthValues = new Map<string, Buffer>()
    for (let index = 0; index < 34; index++) {
      depthValues.set(
        `remote-${index}`,
        remotePointer(`remote-${index + 1}`, index === 33 ? 2 : 6),
      )
    }
    const depthSource = sourceWithPointers('remote-0')
    await expect(decodeBoundedLegacyRisuSave(depthSource, {
      maxLegacyBytes: 1024 * 1024,
      maxDecodedBytes: 1024 * 1024,
      resolveRemoteSize: async (name: string) => depthValues.get(name)?.length ?? null,
      resolveRemote: async (name: string) => depthValues.get(name) ?? null,
    })).rejects.toMatchObject({
      code: 'RISU_SAVE_INVALID',
      status: 400,
      message: expect.stringMatching(/nesting exceeds 32 levels/),
    })

    const nestedOversizeReads: string[] = []
    await expect(decodeBoundedLegacyRisuSave(nestedSource, {
      maxLegacyBytes: 1024 * 1024,
      maxDecodedBytes: 256,
      resolveRemoteSize: async (name: string) => name === 'remote-a'
        ? remotePointer('remote-b', 2).length
        : 1024,
      resolveRemote: async (name: string) => {
        nestedOversizeReads.push(name)
        return name === 'remote-a' ? remotePointer('remote-b', 2) : Buffer.alloc(1024)
      },
    })).rejects.toMatchObject({
      code: 'RISU_SAVE_LEGACY_TOO_LARGE',
      status: 413,
      commitOutcome: 'not-committed',
      commitOutcomeUnknown: false,
    })
    expect(nestedOversizeReads).toEqual(['remote-a'])
  })

  test('classifies supported cursor truncation as definitive invalid input', async () => {
    const valid = Buffer.from(encodeRisuSaveLegacy({ characters: [], marker: 'valid' }))
    await expect(walkRisuSave(valid.subarray(0, -1))).rejects.toMatchObject({
      code: 'RISU_SAVE_INVALID',
      status: 400,
      retryable: false,
      commitOutcome: 'not-committed',
      commitOutcomeUnknown: false,
    })
  })

  test('rejects corrupt gzip without leaving a decoded temp file', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'risu-stream-corrupt-'))
    tempDirs.push(tempDir)
    const filePath = path.join(tempDir, 'corrupt.risudat.tmp')
    await writeFile(filePath, Buffer.concat([
      Buffer.from((utilsPkg as any).magicCompressedHeader),
      Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef]),
    ]))
    await expect(walkRisuSave({ filePath })).rejects.toMatchObject({
      message: expect.stringMatching(/Failed to decompress streaming Risu save/),
      code: 'RISU_SAVE_INVALID',
      retryable: false,
      commitOutcome: 'not-committed',
      commitOutcomeUnknown: false,
    })
    await expect((await import('node:fs/promises')).readdir(tempDir).then(files => files.sort()))
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
