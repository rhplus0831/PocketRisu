import { afterAll, describe, expect, test, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import chatRowsPkg from '../../server/node/chat/chatRows.cjs'
import streamRisuLoadPkg from '../../server/node/backup/streamRisuLoad.cjs'
import streamRisuSavePkg from '../../server/node/backup/streamRisuSave.cjs'
import utilsPkg from '../../server/node/utils.cjs'

const { createChatRowStore } = chatRowsPkg as {
  createChatRowStore: (options: any) => {
    writeChatRow: (chaId: string, chatId: string, chat: unknown) => void
    readChatRow: (chaId: string, chatId: string) => Promise<any | null>
    assembleFullDb: (strippedDb: any) => Promise<any>
  }
}
const { streamRisuSaveToFile } = streamRisuSavePkg as {
  streamRisuSaveToFile: (options: {
    dbObj: Record<string, unknown>
    filePath: string
    readChatRow: (chaId: string, chatId: string) => Promise<any | null>
    pluginStorage?: {
      valueRows: Array<{ key: string; source: string }>
      metaRows: Array<{ key: string; source: string }>
      readRow?: (source: string) => unknown | Promise<unknown>
      rowSource?: (source: string) => { filePath: string; size: number }
    } | null
    shouldAbort?: () => boolean
  }) => Promise<{ filePath: string; size: number }>
}
const { walkRisuSave } = streamRisuLoadPkg as {
  walkRisuSave: (input: unknown, options: Record<string, unknown>) => Promise<any>
}
const { decodeRisuSave, encodeRisuSaveLegacy } = utilsPkg as {
  decodeRisuSave: (value: Uint8Array) => Promise<any>
  encodeRisuSaveLegacy: (value: unknown) => Uint8Array
}

const tempDirs: string[] = []
const SPECIAL_PLUGIN_STORAGE_KEYS = [
  '__proto__', 'constructor', '\uD800', '�', '\uD801',
  'prototype', 'toString', 'hasOwnProperty', '',
] as const

function specialRecord(prefix: string) {
  const record: Record<string, unknown> = {}
  for (const [index, key] of SPECIAL_PLUGIN_STORAGE_KEYS.entries()) {
    Object.defineProperty(record, key, {
      configurable: true,
      enumerable: true,
      value: { prefix, index },
      writable: true,
    })
  }
  return record
}

afterAll(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
})

function makeRowStore() {
  // The store's chat_row_metadata DDL, triggers, prepared statements, and
  // fail-closed writers need a real SQLite kv table, so the kv fakes are
  // backed by it rather than a Map.
  const sqlite = new Database(':memory:')
  sqlite.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB, updated_at INTEGER)')
  const getStmt = sqlite.prepare('SELECT value FROM kv WHERE key = ?')
  const setStmt = sqlite.prepare(
    'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  )
  const delStmt = sqlite.prepare('DELETE FROM kv WHERE key = ?')
  const keysStmt = sqlite.prepare('SELECT key, length(value) AS size FROM kv ORDER BY key')
  const listEntries = () => keysStmt.all() as Array<{ key: string; size: number }>
  const store = createChatRowStore({
    db: sqlite,
    kvGet: (key: string) => {
      const row = getStmt.get(key) as { value: Buffer } | undefined
      return row ? Buffer.from(row.value) : null
    },
    kvSet: (key: string, value: Buffer) => setStmt.run(key, Buffer.from(value)),
    kvDel: (key: string) => delStmt.run(key),
    kvList: (prefix: string) => listEntries()
      .map(({ key }) => key)
      .filter(key => key.startsWith(prefix)),
    kvListWithSizes: (prefix: string) => listEntries()
      .filter(({ key }) => key.startsWith(prefix)),
    kvGetUpdatedAt: () => null,
  })
  return store
}

function makeFixture() {
  const store = makeRowStore()
  const stubs = Array.from({ length: 17 }, (_, index) => {
    const id = `row-chat-${index}`
    store.writeChatRow('row-backed-character', id, {
      id,
      name: `Stored name ${index}`,
      folderId: 'stored-folder',
      message: Array.from({ length: 17 }, (__, messageIndex) => ({
        role: messageIndex % 2 === 0 ? 'user' : 'char',
        data: `메시지 ${index}/${messageIndex}`,
        nested: {
          list: [messageIndex, null, undefined, { deep: `값-${messageIndex}` }],
          explicitUndefined: undefined,
        },
      })),
      localLore: [{ key: '世界', value: ['alpha', { beta: null }] }],
      undefinedProperty: undefined,
    })
    return {
      id,
      name: `Stub name ${index}`,
      _stub: true,
      lastDate: index,
      ...(index === 0 ? { folderId: undefined } : {}),
    }
  })

  const manyCharacterFields = Object.fromEntries(
    Array.from({ length: 17 }, (_, index) => [`character-field-${index}`, index]),
  )
  const manyTopLevelFields = Object.fromEntries(
    Array.from({ length: 17 }, (_, index) => [`setting-${index}`, { index, ok: true }]),
  )
  const strippedDb: Record<string, unknown> = {
    ...manyTopLevelFields,
    botPresets: [{ id: 'stable-preset', name: 'Stable' }],
    explicitUndefined: undefined,
    nullSetting: null,
    unicodeObject: { '유니코드 키': { '世界': ['nested', null, undefined] } },
    pluginCustomStorage: {
      inline: { retained: true },
      overlap: { source: 'inline' },
      explicitUndefined: undefined,
    },
    characters: [
      {
        ...manyCharacterFields,
        chaId: 'row-backed-character',
        name: 'Rows',
        undefinedCharacterField: undefined,
        chats: stubs,
      },
      {
        chaId: 'inline-character',
        name: 'No stubs',
        chats: [{
          id: 'inline-chat',
          name: 'Inline',
          message: [{ role: 'user', data: 'kept inline' }],
        }],
      },
      { chaId: 'empty-character', name: 'Empty chats', chats: [] },
      { name: 'No chaId', chats: [{ id: 'untouched', message: [{ data: 'inline' }] }] },
    ],
  }

  const pluginValues: Record<string, unknown> = Object.fromEntries(
    Array.from({ length: 17 }, (_, index) => [
      index === 16 ? '유니코드/키' : `plugin/key/${index}`,
      { index, nested: [null, { label: `value-${index}` }] },
    ]),
  )
  pluginValues.overlap = { source: 'external-row' }
  const pluginMeta: Record<string, unknown> = {
    ...Object.fromEntries(Array.from({ length: 16 }, (_, index) => [
      `plugin/key/${index}`,
      { plugin: `Plugin ${index}`, updatedAt: index },
    ])),
    '유니코드/키': { plugin: 'Unicode Plugin', updatedAt: 99 },
  }

  const rowPayloads = new Map<string, Buffer>()
  const toRows = (prefix: string, entries: Record<string, unknown>) => (
    Object.entries(entries).map(([key, value], index) => {
      const source = `${prefix}:${index}`
      rowPayloads.set(source, Buffer.from(JSON.stringify(value), 'utf-8'))
      return { key, source }
    })
  )
  const pluginStorage = {
    valueRows: toRows('value', pluginValues),
    metaRows: toRows('meta', pluginMeta),
    readRow: (source: string) => JSON.parse(rowPayloads.get(source)!.toString('utf-8')),
  }

  return { store, strippedDb, pluginStorage }
}

describe('disk-backed streaming Risu save encoding', () => {
  test('decodes like full in-memory assembly with and without folded plugin rows', async () => {
    const { store, strippedDb, pluginStorage } = makeFixture()
    const untouched = structuredClone(strippedDb)
    const tempDir = await mkdtemp(path.join(tmpdir(), 'risu-stream-save-'))
    tempDirs.push(tempDir)

    for (const foldPluginStorage of [false, true]) {
      const filePath = path.join(tempDir, `database-${foldPluginStorage}.risudat.tmp`)
      const spool = await streamRisuSaveToFile({
        dbObj: strippedDb,
        filePath,
        readChatRow: (chaId, chatId) => store.readChatRow(chaId, chatId),
        pluginStorage: foldPluginStorage ? pluginStorage : null,
      })
      const streamedBytes = await readFile(filePath)
      expect(spool.size).toBe(streamedBytes.length)

      const assembled = await store.assembleFullDb(strippedDb)
      if (foldPluginStorage) {
        assembled.pluginCustomStorage = { ...(assembled.pluginCustomStorage ?? {}) }
        for (const row of pluginStorage.valueRows) {
          assembled.pluginCustomStorage[row.key] = pluginStorage.readRow(row.source)
        }
        assembled.pluginStorageMeta = { ...(assembled.pluginStorageMeta ?? {}) }
        for (const row of pluginStorage.metaRows) {
          assembled.pluginStorageMeta[row.key] = pluginStorage.readRow(row.source)
        }
      }

      expect(await decodeRisuSave(streamedBytes)).toEqual(
        await decodeRisuSave(encodeRisuSaveLegacy(assembled)),
      )
      expect(strippedDb).toEqual(untouched)
    }
  })

  test('preserves special plugin keys, their order, and a protocol-field collision', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'risu-stream-save-special-'))
    tempDirs.push(tempDir)
    const filePath = path.join(tempDir, 'database-special.risudat.tmp')
    const reservedCollision = [
      'PocketRisu.plugin-storage-escapes',
      1,
      null,
      [['pluginCustomStorage', 0, [1, '"user-collision"']]],
    ]
    const dbObj: Record<string, unknown> = {
      botPresets: [{ id: 'stable-preset', name: 'Stable' }],
      characters: [],
      pluginCustomStorage: specialRecord('value'),
      pluginStorageMeta: specialRecord('meta'),
    }
    Object.defineProperty(dbObj, '__pocketRisuPluginStorageEscapesV1', {
      configurable: true,
      enumerable: true,
      value: reservedCollision,
      writable: true,
    })

    await streamRisuSaveToFile({ dbObj, filePath, readChatRow: async () => null })
    const bytes = await readFile(filePath)
    expect(bytes[10]).toBe(10)
    const decoded = await decodeRisuSave(bytes)
    expect(Object.keys(decoded.pluginCustomStorage)).toEqual(SPECIAL_PLUGIN_STORAGE_KEYS)
    expect(Object.keys(decoded.pluginStorageMeta)).toEqual(SPECIAL_PLUGIN_STORAGE_KEYS)
    expect(decoded.__pocketRisuPluginStorageEscapesV1).toEqual(reservedCollision)
    for (const key of SPECIAL_PLUGIN_STORAGE_KEYS) {
      expect(Object.hasOwn(decoded.pluginCustomStorage, key)).toBe(true)
      expect(Object.hasOwn(decoded.pluginStorageMeta, key)).toBe(true)
    }
  })

  test('folds high-cardinality and large plugin bodies with one row in flight', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'risu-stream-save-bounded-'))
    tempDirs.push(tempDir)
    const filePath = path.join(tempDir, 'database-bounded.risudat.tmp')
    const rowCount = 2_500
    const valueRows = Array.from({ length: rowCount }, (_, index) => ({
      key: `record/${index.toString().padStart(5, '0')}`,
      source: `row-${index}`,
    }))
    let activeReads = 0
    let maxActiveReads = 0
    let completedReads = 0

    await streamRisuSaveToFile({
      dbObj: { optimizePluginMemory: true, characters: [], pluginCustomStorage: {} },
      filePath,
      readChatRow: async () => null,
      pluginStorage: {
        valueRows,
        metaRows: [],
        readRow: async (source: string) => {
          activeReads++
          maxActiveReads = Math.max(maxActiveReads, activeReads)
          await Promise.resolve()
          const index = Number(source.slice('row-'.length))
          const result = {
            index,
            body: 'x'.repeat(index === rowCount - 1 ? 4 * 1024 * 1024 : 1024),
          }
          completedReads++
          activeReads--
          return result
        },
      },
    })

    expect(completedReads).toBe(rowCount)
    expect(maxActiveReads).toBe(1)
    expect((await stat(filePath)).size).toBeGreaterThan(6 * 1024 * 1024)
    const decoded = await decodeRisuSave(await readFile(filePath))
    expect(Object.keys(decoded.pluginCustomStorage)).toHaveLength(rowCount)
    const lastKey = `record/${(rowCount - 1).toString().padStart(5, '0')}`
    expect(decoded.pluginCustomStorage[lastKey].body).toHaveLength(4 * 1024 * 1024)
  })

  test('streams staged JSON row files directly into ordinary and escaped plugin values', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'risu-stream-save-row-source-'))
    tempDirs.push(tempDir)
    const filePath = path.join(tempDir, 'database-row-source.risudat.tmp')
    const ordinaryPath = path.join(tempDir, 'ordinary.json')
    const protoPath = path.join(tempDir, 'proto.json')
    const ordinaryBytes = Buffer.from(JSON.stringify({
      body: 'o'.repeat(3 * 1024 * 1024),
      nested: ['streamed', true, 42],
    }))
    const protoBytes = Buffer.from(JSON.stringify({
      body: 'p'.repeat(2 * 1024 * 1024),
      exact: '__proto__',
    }))
    await writeFile(ordinaryPath, ordinaryBytes)
    await writeFile(protoPath, protoBytes)
    const sources = new Map([
      ['ordinary', { filePath: ordinaryPath, size: ordinaryBytes.length }],
      ['proto', { filePath: protoPath, size: protoBytes.length }],
    ])
    const readRow = vi.fn(() => {
      throw new Error('file-backed plugin rows must not use readRow')
    })

    await streamRisuSaveToFile({
      dbObj: { optimizePluginMemory: true, characters: [], pluginCustomStorage: {} },
      filePath,
      readChatRow: async () => null,
      pluginStorage: {
        valueRows: [
          { key: 'large', source: 'ordinary' },
          { key: '__proto__', source: 'proto' },
        ],
        metaRows: [],
        readRow,
        rowSource: (source: string) => sources.get(source)!,
      },
    })

    expect(readRow).not.toHaveBeenCalled()
    const decoded = await decodeRisuSave(await readFile(filePath))
    expect(decoded.pluginCustomStorage.large.nested).toEqual(['streamed', true, 42])
    expect(decoded.pluginCustomStorage.large.body).toHaveLength(3 * 1024 * 1024)
    expect(Object.hasOwn(decoded.pluginCustomStorage, '__proto__')).toBe(true)
    expect(decoded.pluginCustomStorage.__proto__).toEqual({
      body: 'p'.repeat(2 * 1024 * 1024),
      exact: '__proto__',
    })
  })

  test('defers multi-megabyte external __proto__ rows and streams their exact escape entries', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'risu-stream-save-proto-'))
    tempDirs.push(tempDir)
    const filePath = path.join(tempDir, 'database-proto.risudat.tmp')
    const valueSize = 3 * 1024 * 1024
    const metaSize = 2 * 1024 * 1024
    const reads: string[] = []
    let activeReads = 0
    let maxActiveReads = 0
    let sizeBeforeSecondEscapeRead = 0
    const reservedCollision = { user: 'retained', nested: ['not', 'a', 'sidecar'] }
    const dbObj: Record<string, unknown> = {
      botPresets: [{ id: 'stable-preset', name: 'Stable' }],
      characters: [],
      optimizePluginMemory: true,
      pluginCustomStorage: {},
      pluginStorageMeta: {},
    }
    Object.defineProperty(dbObj, '__pocketRisuPluginStorageEscapesV1', {
      configurable: true,
      enumerable: true,
      value: reservedCollision,
      writable: true,
    })

    const pluginStorage = {
      valueRows: [
        { key: '__proto__', source: 'value-proto-superseded' },
        { key: 'constructor', source: 'value-constructor' },
        { key: '__proto_\0/../', source: 'value-lookalike' },
        { key: '', source: 'value-empty' },
        { key: '10', source: 'value-ten' },
        { key: '2', source: 'value-two' },
        { key: 'hasOwnProperty', source: 'value-has-own' },
        {
          key: '__pocketRisuPluginStorageEscapesV1',
          source: 'value-reserved-lookalike',
        },
        { key: '__proto__', source: 'value-proto' },
      ],
      metaRows: [
        { key: 'prototype', source: 'meta-prototype' },
        { key: '__proto__', source: 'meta-proto' },
        { key: 'toString', source: 'meta-to-string' },
      ],
      readRow: async (source: string) => {
        activeReads++
        maxActiveReads = Math.max(maxActiveReads, activeReads)
        reads.push(source)
        if (source === 'meta-proto') {
          sizeBeforeSecondEscapeRead = (await stat(filePath)).size
        }
        await Promise.resolve()
        const value = source === 'value-proto'
          ? { kind: source, body: 'v'.repeat(valueSize) }
          : source === 'meta-proto'
            ? { kind: source, body: 'm'.repeat(metaSize) }
            : { kind: source }
        activeReads--
        return value
      },
    }

    await streamRisuSaveToFile({
      dbObj,
      filePath,
      readChatRow: async () => null,
      pluginStorage,
    })

    expect(maxActiveReads).toBe(1)
    expect(sizeBeforeSecondEscapeRead).toBeGreaterThan(valueSize)
    expect(reads).toEqual([
      'value-two',
      'value-ten',
      'value-constructor',
      'value-lookalike',
      'value-empty',
      'value-has-own',
      'value-reserved-lookalike',
      'meta-prototype',
      'meta-to-string',
      'value-proto',
      'meta-proto',
    ])

    const bytes = await readFile(filePath)
    expect(bytes[10]).toBe(10)
    const decoded = await decodeRisuSave(bytes)
    expect(Object.keys(decoded.pluginCustomStorage)).toEqual([
      '2',
      '10',
      '__proto__',
      'constructor',
      '__proto_\0/../',
      '',
      'hasOwnProperty',
      '__pocketRisuPluginStorageEscapesV1',
    ])
    expect(Object.keys(decoded.pluginStorageMeta)).toEqual([
      'prototype', '__proto__', 'toString',
    ])
    expect(Object.hasOwn(decoded.pluginCustomStorage, '__proto__')).toBe(true)
    expect(Object.hasOwn(decoded.pluginStorageMeta, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(decoded.pluginCustomStorage)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(decoded.pluginStorageMeta)).toBe(Object.prototype)
    expect((Object.prototype as any).kind).toBeUndefined()
    expect(decoded.pluginCustomStorage.__proto__.kind).toBe('value-proto')
    expect(decoded.pluginCustomStorage.__proto__.body).toHaveLength(valueSize)
    expect(decoded.pluginStorageMeta.__proto__.kind).toBe('meta-proto')
    expect(decoded.pluginStorageMeta.__proto__.body).toHaveLength(metaSize)
    expect(decoded.__pocketRisuPluginStorageEscapesV1).toEqual(reservedCollision)

    const imported: Array<{ field: string; key: string; value: any }> = []
    const walked = await walkRisuSave({ filePath }, {
      externalizePluginStorage: true,
      onPluginStorageEntry: (entry: { field: string; key: string; value: any }) => {
        imported.push(entry)
      },
    })
    expect(imported.map(entry => [entry.field, entry.key])).toEqual([
      ['pluginCustomStorage', '2'],
      ['pluginCustomStorage', '10'],
      ['pluginCustomStorage', '__proto__'],
      ['pluginCustomStorage', 'constructor'],
      ['pluginCustomStorage', '__proto_\0/../'],
      ['pluginCustomStorage', ''],
      ['pluginCustomStorage', 'hasOwnProperty'],
      ['pluginCustomStorage', '__pocketRisuPluginStorageEscapesV1'],
      ['pluginStorageMeta', 'prototype'],
      ['pluginStorageMeta', '__proto__'],
      ['pluginStorageMeta', 'toString'],
    ])
    expect(imported[2].value.body).toHaveLength(valueSize)
    expect(imported[9].value.body).toHaveLength(metaSize)
    expect(walked.remainder.__pocketRisuPluginStorageEscapesV1)
      .toEqual(reservedCollision)
  })

  test('cleans multi-megabyte proto spools after cancellation, row failure, or invalid descriptors', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'risu-stream-save-proto-fail-'))
    tempDirs.push(tempDir)
    const rows = {
      valueRows: [
        { key: 'ordinary', source: 'ordinary' },
        { key: '__proto__', source: 'value-proto' },
      ],
      metaRows: [{ key: '__proto__', source: 'meta-proto' }],
    }
    const makeLargeRow = (source: string) => ({
      source,
      body: (source === 'value-proto' ? 'v' : 'm').repeat(2 * 1024 * 1024),
    })

    const cancelledPath = path.join(tempDir, 'cancelled.risudat.tmp')
    let cancel = false
    const cancelledReads: string[] = []
    await expect(streamRisuSaveToFile({
      dbObj: { optimizePluginMemory: true, characters: [], pluginCustomStorage: {} },
      filePath: cancelledPath,
      readChatRow: async () => null,
      pluginStorage: {
        ...rows,
        readRow: (source: string) => {
          cancelledReads.push(source)
          if (source === 'ordinary') cancel = true
          return source === 'ordinary' ? { source } : makeLargeRow(source)
        },
      },
      shouldAbort: () => cancel,
    } as any)).rejects.toMatchObject({ code: 'BACKUP_STREAM_ABORTED' })
    expect(cancelledReads).toEqual(['ordinary'])
    await expect(stat(cancelledPath)).rejects.toMatchObject({ code: 'ENOENT' })

    const failedPath = path.join(tempDir, 'failed.risudat.tmp')
    const failedReads: string[] = []
    await expect(streamRisuSaveToFile({
      dbObj: { optimizePluginMemory: true, characters: [], pluginCustomStorage: {} },
      filePath: failedPath,
      readChatRow: async () => null,
      pluginStorage: {
        ...rows,
        readRow: async (source: string) => {
          failedReads.push(source)
          if (source === 'meta-proto') {
            expect((await stat(failedPath)).size).toBeGreaterThan(2 * 1024 * 1024)
            throw new Error('injected metadata row read failure')
          }
          return source === 'ordinary' ? { source } : makeLargeRow(source)
        },
      },
    } as any)).rejects.toThrow('injected metadata row read failure')
    expect(failedReads).toEqual(['ordinary', 'value-proto', 'meta-proto'])
    await expect(stat(failedPath)).rejects.toMatchObject({ code: 'ENOENT' })

    const invalidPath = path.join(tempDir, 'invalid.risudat.tmp')
    await expect(streamRisuSaveToFile({
      dbObj: { optimizePluginMemory: true, characters: [], pluginCustomStorage: {} },
      filePath: invalidPath,
      readChatRow: async () => null,
      pluginStorage: {
        valueRows: [{ key: { toString: () => '__proto__' }, source: 'malicious' }],
        metaRows: [],
        readRow: () => makeLargeRow('value-proto'),
      },
    } as any)).rejects.toThrow('Invalid plugin storage row descriptor')
    await expect(stat(invalidPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('cancellation removes an incomplete folded database spool', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'risu-stream-save-cancel-'))
    tempDirs.push(tempDir)
    const filePath = path.join(tempDir, 'database-cancelled.risudat.tmp')
    let reads = 0
    await expect(streamRisuSaveToFile({
      dbObj: { optimizePluginMemory: true, characters: [], pluginCustomStorage: {} },
      filePath,
      readChatRow: async () => null,
      pluginStorage: {
        valueRows: Array.from({ length: 100 }, (_, index) => ({
          key: `row-${index}`,
          source: `row-${index}`,
        })),
        metaRows: [],
        readRow: () => ({ body: 'x'.repeat(256 * 1024), index: reads++ }),
      },
      shouldAbort: () => reads >= 4,
    } as any)).rejects.toMatchObject({ code: 'BACKUP_STREAM_ABORTED' })
    await expect(stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(reads).toBeLessThan(100)
  })
})
