import { afterAll, describe, expect, test } from 'vitest'
import { createRequire } from 'node:module'
import { gzipSync } from 'node:zlib'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const {
  streamBackupRisuSaveToFile,
  readBlockRisuSaveTopLevelFields,
} = require('../../server/node/streamBackupRisuSave.cjs') as {
  streamBackupRisuSaveToFile: (options: Record<string, unknown>) => Promise<{
    filePath: string
    size: number
  }>
  readBlockRisuSaveTopLevelFields: (
    input: { filePath: string; size: number },
    keys: string[],
    options: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
}
const {
  decodeRisuSave,
  normalizeJSON,
  RisuSaveType,
} = require('../../server/node/utils.cjs') as {
  decodeRisuSave: (bytes: Uint8Array, options?: Record<string, unknown>) => Promise<any>
  normalizeJSON: (value: unknown) => any
  RisuSaveType: Record<string, number>
}

type Block = {
  type: number
  name: string
  json: string
  gzip?: boolean
}

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.splice(0).map(directory => rm(directory, {
    recursive: true,
    force: true,
  })))
})

function blockBytes(block: Block): Buffer {
  const name = Buffer.from(block.name, 'utf-8')
  const json = Buffer.from(block.json, 'utf-8')
  const body = block.gzip ? gzipSync(json) : json
  const header = Buffer.alloc(7 + name.length)
  header[0] = block.type
  header[1] = block.gzip ? 1 : 0
  header[2] = name.length
  name.copy(header, 3)
  header.writeUInt32LE(body.length, 3 + name.length)
  return Buffer.concat([header, body])
}

function encodeBlocks(blocks: Block[]): Buffer {
  return Buffer.concat([
    Buffer.from('RISUSAVE\0', 'utf-8'),
    ...blocks.map(blockBytes),
  ])
}

function stableDatabase(value: any): any {
  const copy = structuredClone(value)
  if (Array.isArray(copy?.botPresets)) {
    for (const preset of copy.botPresets) {
      if (preset?.id && preset.name === 'New Preset') preset.id = '<generated>'
    }
  }
  return copy
}

async function runTransform(
  blocks: Block[],
  remoteRows = new Map<string, Buffer>(),
  options: { readCount?: { value: number }; cleanupCount?: { value: number } } = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'block-backup-diff-'))
  dirs.push(directory)
  const authoritativeBlocks = blocks.some(block => block.type === RisuSaveType.ROOT)
    ? blocks
    : [{ type: RisuSaveType.ROOT, name: 'root', json: '{}' }, ...blocks]
  const inputBytes = encodeBlocks(authoritativeBlocks)
  const inputPath = path.join(directory, 'database.bin')
  const outputPath = path.join(directory, 'database.risudat')
  await writeFile(inputPath, inputBytes)
  const remotePaths = new Map<string, string>()
  for (const [name, bytes] of remoteRows) {
    const remotePath = path.join(directory, `remote-${name}.json`)
    await writeFile(remotePath, bytes)
    remotePaths.set(name, remotePath)
  }
  const source = { filePath: inputPath, size: inputBytes.length }
  const readRemoteRowSize = async (name: string) => remoteRows.get(name)?.length ?? null
  const readRemoteRowSource = async (name: string) => {
    const bytes = remoteRows.get(name)
    const filePath = remotePaths.get(name)
    if (!bytes || !filePath) return null
    if (options.readCount) options.readCount.value++
    return {
      filePath,
      size: bytes.length,
      cleanup: async () => {
        if (options.cleanupCount) options.cleanupCount.value++
      },
    }
  }
  const resolveRemote = async (name: string) => remoteRows.get(name) ?? null
  const expected = normalizeJSON(await decodeRisuSave(inputBytes, {
    strictBlockJson: true,
    resolveRemote,
  }))
  const result = await streamBackupRisuSaveToFile({
    databaseSource: source,
    filePath: outputPath,
    readChatRowSource: async () => null,
    readRemoteRowSize,
    readRemoteRowSource,
    shouldAbort: () => false,
    tempDir: directory,
  })
  const actual = normalizeJSON(await decodeRisuSave(await readFile(result.filePath)))
  return {
    actual: stableDatabase(actual),
    expected: stableDatabase(expected),
    source,
    directory,
    outputPath,
    readRemoteRowSize,
    readRemoteRowSource,
  }
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items]
  return items.flatMap((item, index) => permutations([
    ...items.slice(0, index),
    ...items.slice(index + 1),
  ]).map(rest => [item, ...rest]))
}

describe('block RisuSave backup transformer differential', () => {
  test('matches ROOT truthiness, duplicate collapse, component overwrite, and planning order', async () => {
    const blocks: Block[] = [
      {
        type: RisuSaveType.ROOT,
        name: 'root-1',
        json: '{"theme":"first","zero":0,"no":false,"nil":null,"empty":"",'
          + '"dup":"discarded","dup":"inside-last","characters":[{"chaId":"root-char","chats":[]}],'
          + '"optimizePluginMemory":true,"pluginStorageGeneration":"g1"}',
      },
      {
        type: RisuSaveType.ROOT,
        name: 'root-2',
        json: JSON.stringify({
          theme: 'second',
          zero: 2,
          no: 3,
          nil: 4,
          empty: 'later',
          dup: 'too-late',
          optimizePluginMemory: false,
          pluginStorageGeneration: 'g2',
        }),
        gzip: true,
      },
      {
        type: RisuSaveType.ROOT_COMPONENT,
        name: 'component',
        json: '{"data":"component","key":"theme"}',
      },
      {
        type: RisuSaveType.ROOT,
        name: 'root-3',
        json: JSON.stringify({ theme: 'third' }),
      },
      {
        type: RisuSaveType.CHARACTER_WITH_CHAT,
        name: 'block-char',
        json: JSON.stringify({ chaId: 'block-char', chats: [] }),
      },
    ]
    const transformed = await runTransform(blocks)
    expect(transformed.actual).toEqual(transformed.expected)
    expect(transformed.actual).toMatchObject({
      theme: 'component',
      zero: 2,
      no: 3,
      nil: 4,
      empty: 'later',
      dup: 'inside-last',
      optimizePluginMemory: true,
      pluginStorageGeneration: 'g1',
      characters: [
        { chaId: 'root-char', chats: [] },
        { chaId: 'block-char', chats: [] },
      ],
    })
    await expect(readBlockRisuSaveTopLevelFields(
      transformed.source,
      ['optimizePluginMemory', 'pluginStorageGeneration'],
      {
        tempDir: transformed.directory,
        readRemoteRowSize: transformed.readRemoteRowSize,
        readRemoteRowSource: transformed.readRemoteRowSource,
      },
    )).resolves.toEqual({
      optimizePluginMemory: true,
      pluginStorageGeneration: 'g1',
    })
  })

  test('matches all ROOT/type/component permutations under raw and gzip layouts', async () => {
    const logical: Block[] = [
      {
        type: RisuSaveType.ROOT,
        name: 'a',
        json: JSON.stringify({ x: 'first', replace: 0, botPresets: [{ id: 'root', name: 'root' }] }),
      },
      {
        type: RisuSaveType.ROOT,
        name: 'b',
        json: JSON.stringify({ x: 'second', replace: 2 }),
      },
      {
        type: RisuSaveType.ROOT_COMPONENT,
        name: 'component',
        json: '{"data":"component","key":"x"}',
      },
      {
        type: RisuSaveType.BOTPRESET,
        name: 'preset',
        json: JSON.stringify([{ id: 'block', name: 'block' }]),
      },
    ]
    for (const order of permutations(logical)) {
      for (const gzip of [false, true]) {
        const transformed = await runTransform(order.map(block => ({ ...block, gzip })))
        expect(transformed.actual).toEqual(transformed.expected)
      }
    }
  }, 30_000)

  test('preserves character replacement/append order and appended REMOTEs', async () => {
    const remoteRows = new Map([
      ['remote-char', Buffer.from(JSON.stringify({
        chaId: 'remote-char',
        chats: [],
      }))],
    ])
    const readCount = { value: 0 }
    const cleanupCount = { value: 0 }
    const transformed = await runTransform([
      {
        type: RisuSaveType.CHARACTER_WITH_CHAT,
        name: 'first',
        json: JSON.stringify({ chaId: 'first', chats: [] }),
      },
      {
        type: RisuSaveType.REMOTE,
        name: 'pointer-1',
        json: JSON.stringify({ v: 1, type: RisuSaveType.CHARACTER_WITH_CHAT, name: 'remote-char' }),
      },
      {
        type: RisuSaveType.REMOTE,
        name: 'pointer-2',
        json: JSON.stringify({ v: 1, type: RisuSaveType.CHARACTER_WITH_CHAT, name: 'remote-char' }),
        gzip: true,
      },
      {
        type: RisuSaveType.ROOT_COMPONENT,
        name: 'replace',
        json: '{"data":[{"chaId":"component","chats":[]}],"key":"characters"}',
      },
      {
        type: RisuSaveType.CHARACTER_WITHOUT_CHAT,
        name: 'last-physical',
        json: JSON.stringify({ chaId: 'last-physical', chats: [] }),
      },
    ], remoteRows, { readCount, cleanupCount })
    expect(transformed.actual).toEqual(transformed.expected)
    expect(transformed.actual.characters.map((entry: { chaId: string }) => entry.chaId)).toEqual([
      'component',
      'last-physical',
      'remote-char',
      'remote-char',
    ])
    expect(readCount.value).toBe(1)
    expect(cleanupCount.value).toBe(1)
  })

  test.each([false, true])('accepts last-wins ROOT_COMPONENT duplicates and data-before-key (gzip=%s)', async gzip => {
    const transformed = await runTransform([{
      type: RisuSaveType.ROOT_COMPONENT,
      name: 'duplicates',
      json: '{"key":"old","data":"old","data":"new","key":"theme"}',
      gzip,
    }])
    expect(transformed.actual).toEqual(transformed.expected)
    expect(transformed.actual.theme).toBe('new')
  })

  test.each([false, true])('crosses 64 KiB pages and converts an unbounded finite number (gzip=%s)', async gzip => {
    const padding = 'p'.repeat(65_520)
    const longFinite = `1${'0'.repeat(2_000)}e-2000`
    const transformed = await runTransform([{
      type: RisuSaveType.ROOT,
      name: 'boundary',
      json: `{"padding":"${padding}","emoji":"\\uD83D\\uDE00","long":${longFinite}}`,
      gzip,
    }])
    expect(transformed.actual).toEqual(transformed.expected)
    expect(transformed.actual).toMatchObject({ emoji: '😀', long: 1 })
  })

  test.each([
    { name: 'config', type: RisuSaveType.CONFIG, json: '{' },
    { name: 'chat', type: RisuSaveType.CHAT, json: 'NaN' },
    {
      name: 'missing-directory-entry',
      type: RisuSaveType.ROOT,
      json: JSON.stringify({ __directory: ['missing-character'] }),
    },
    {
      name: 'unknown-remote',
      type: RisuSaveType.REMOTE,
      json: JSON.stringify({ v: 1, type: 255, name: 'unknown' }),
    },
  ])('rejects strict malformed/unknown block $name and cleans all output', async failing => {
    const directory = await mkdtemp(path.join(tmpdir(), 'block-backup-invalid-'))
    dirs.push(directory)
    const bytes = encodeBlocks([failing])
    const inputPath = path.join(directory, 'database.bin')
    const outputPath = path.join(directory, 'database.risudat')
    await writeFile(inputPath, bytes)
    await expect(streamBackupRisuSaveToFile({
      databaseSource: { filePath: inputPath, size: bytes.length },
      filePath: outputPath,
      readChatRowSource: async () => null,
      readRemoteRowSize: async () => null,
      readRemoteRowSource: async () => null,
      shouldAbort: () => false,
      tempDir: directory,
    })).rejects.toThrow()
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readFile(inputPath)).equals(bytes)).toBe(true)
  })

  test('cleans cached REMOTE sources when nested expansion fails', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'block-backup-remote-cleanup-'))
    dirs.push(directory)
    const input = encodeBlocks([{
      type: RisuSaveType.REMOTE,
      name: 'outer',
      json: JSON.stringify({ v: 1, type: RisuSaveType.REMOTE, name: 'bad-pointer' }),
    }])
    const inputPath = path.join(directory, 'database.bin')
    const outputPath = path.join(directory, 'database.risudat')
    const remotePath = path.join(directory, 'bad-pointer.json')
    const remote = Buffer.from(JSON.stringify({ v: 1, type: 255, name: 'unknown' }))
    await writeFile(inputPath, input)
    await writeFile(remotePath, remote)
    let cleanupCount = 0
    await expect(streamBackupRisuSaveToFile({
      databaseSource: { filePath: inputPath, size: input.length },
      filePath: outputPath,
      readChatRowSource: async () => null,
      readRemoteRowSize: async () => remote.length,
      readRemoteRowSource: async () => ({
        filePath: remotePath,
        size: remote.length,
        cleanup: async () => { cleanupCount++ },
      }),
      shouldAbort: () => false,
      tempDir: directory,
    })).rejects.toThrow(/REMOTE/i)
    expect(cleanupCount).toBe(1)
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('charges REMOTE bytes/count before source spooling', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'block-backup-remote-bounds-'))
    dirs.push(directory)
    const pointer = (name: string): Block => ({
      type: RisuSaveType.REMOTE,
      name,
      json: JSON.stringify({ v: 1, type: RisuSaveType.CHARACTER_WITH_CHAT, name }),
    })
    const input = encodeBlocks([pointer('a'), pointer('b')])
    const inputPath = path.join(directory, 'database.bin')
    const remotePath = path.join(directory, 'character.json')
    const remote = Buffer.from(JSON.stringify({ chaId: 'remote', chats: [] }))
    await writeFile(inputPath, input)
    await writeFile(remotePath, remote)
    let reads = 0
    const common = {
      databaseSource: { filePath: inputPath, size: input.length },
      readChatRowSource: async () => null,
      readRemoteRowSize: async () => remote.length,
      readRemoteRowSource: async () => {
        reads++
        return { filePath: remotePath, size: remote.length }
      },
      shouldAbort: () => false,
      tempDir: directory,
    }
    await expect(streamBackupRisuSaveToFile({
      ...common,
      filePath: path.join(directory, 'bytes.risudat'),
      maxDecodedBytes: Buffer.byteLength(pointer('a').json) + remote.length - 1,
    })).rejects.toThrow(/decode limit/i)
    expect(reads).toBe(0)

    await expect(streamBackupRisuSaveToFile({
      ...common,
      filePath: path.join(directory, 'count.risudat'),
      maxRemoteCount: 1,
    })).rejects.toThrow(/inventory/i)
    // The first source was attempted, but no second source can be spooled.
    expect(reads).toBe(1)
  })
})
