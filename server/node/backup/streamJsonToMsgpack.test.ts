import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, test } from 'vitest'
import { Unpackr } from 'msgpackr'

const require = createRequire(import.meta.url)
const { streamJsonFileToMessagePack, validateJsonSource } = require('./streamJsonToMsgpack.cjs') as {
  streamJsonFileToMessagePack: (
    source: { filePath: string; size: number },
    writer: MemoryWriter,
    options?: { signal?: AbortSignal; shouldAbort?: () => boolean },
  ) => Promise<void>
  validateJsonSource: (
    source: { filePath: string; size: number },
  ) => Promise<{ type: string; length?: number; jsonSize?: number }>
}
const { pluginStorageViewerDisplaySizeFromMetadata } = require(
  '../plugin-storage/pluginStorageViewerFacets.cjs',
) as {
  pluginStorageViewerDisplaySizeFromMetadata: (
    metadata: { type: string; length?: number; jsonSize?: number },
  ) => number
}
const { serializeLosslessPluginStorageRow } = require('../plugin-storage/pluginStorageJson.cjs') as {
  serializeLosslessPluginStorageRow: (storageKey: string, value: unknown) => Buffer
}
const unpackr = new Unpackr({ int64AsType: 'number', useRecords: false })
const dirs: string[] = []

class MemoryWriter {
  position = 0
  buffer = Buffer.alloc(1024)

  async write(input: Uint8Array): Promise<void> {
    const bytes = Buffer.from(input)
    const needed = this.position + bytes.length
    if (needed > this.buffer.length) {
      const next = Buffer.alloc(Math.max(needed, this.buffer.length * 2))
      this.buffer.copy(next)
      this.buffer = next
    }
    bytes.copy(this.buffer, this.position)
    this.position = needed
  }

  async patch(position: number, input: Uint8Array): Promise<void> {
    Buffer.from(input).copy(this.buffer, position)
  }

  value(): Buffer {
    return this.buffer.subarray(0, this.position)
  }
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function transcode(
  json: string,
  options?: { signal?: AbortSignal; shouldAbort?: () => boolean },
): Promise<unknown> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stream-json-msgpack-'))
  dirs.push(dir)
  const filePath = path.join(dir, 'row.json')
  const bytes = Buffer.from(json, 'utf-8')
  await writeFile(filePath, bytes)
  const writer = new MemoryWriter()
  await streamJsonFileToMessagePack({ filePath, size: bytes.length }, writer, options)
  return unpackr.decode(writer.value())
}

async function transcodeBytes(bytes: Buffer): Promise<unknown> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stream-lossless-msgpack-'))
  dirs.push(dir)
  const filePath = path.join(dir, 'row.bin')
  await writeFile(filePath, bytes)
  const writer = new MemoryWriter()
  await streamJsonFileToMessagePack({ filePath, size: bytes.length }, writer)
  return unpackr.decode(writer.value())
}

async function displaySize(json: string): Promise<number> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'stream-json-display-size-'))
  dirs.push(dir)
  const filePath = path.join(dir, 'row.json')
  const bytes = Buffer.from(json, 'utf-8')
  await writeFile(filePath, bytes)
  return pluginStorageViewerDisplaySizeFromMetadata(await validateJsonSource({
    filePath,
    size: bytes.length,
  }))
}

describe('streaming JSON to MessagePack', () => {
  test('decodes lossless plugin rows while streaming transitions and backups', async () => {
    const sparse = new Array(3)
    sparse[1] = { path: undefined }
    const bytes = serializeLosslessPluginStorageRow(
      `pluginsave/${Buffer.from('codec').toString('base64url')}.json`,
      { root: undefined, sparse },
    )
    const decoded = await transcodeBytes(bytes) as any

    expect(Object.prototype.hasOwnProperty.call(decoded, 'root')).toBe(true)
    expect(decoded.root).toBeUndefined()
    // MessagePack has an undefined scalar but no sparse-array primitive. The
    // durable optimized codec retains holes; inline RisuSave uses undefined
    // elements for those positions during a mode transition.
    expect(decoded.sparse).toEqual([undefined, { path: undefined }, undefined])
  })

  test('matches JSON scalar, nested, duplicate-key, and numeric semantics', async () => {
    const json = '{"a":1,"a":2,"array":[true,false,null,-0,1.5e2],"nested":{"2":"b","1":"a"}}'
    const expected = JSON.parse(json)
    expected.array[3] = 0
    expect(await transcode(json)).toEqual(expected)
    expect(Object.is((await transcode('-0')) as number, -0)).toBe(false)
  })

  test('matches escaped UTF-8 and surrogate replacement semantics', async () => {
    const json = String.raw`["page-😀-edge","\ud83d\ude00","\ud800","\ud800\n","\ud800\u0041","\udc00","quote-\"-slash-\\-tab-\t"]`
    expect(await transcode(json)).toEqual([
      'page-😀-edge',
      '😀',
      '\ufffd',
      '\ufffd\n',
      '\ufffdA',
      '\ufffd',
      'quote-"-slash-\\-tab-\t',
    ])
  })

  test('streams a string whose escape crosses the 64 KiB input page', async () => {
    const json = `"${'x'.repeat(64 * 1024 - 2)}\\ud83d\\ude00-tail"`
    expect(await transcode(json)).toBe(JSON.parse(json))
  })

  test('derives exact viewer display sizes while streaming strict JSON', async () => {
    const rows = [
      String.raw`"한글\n\ud800"`,
      'null',
      '  { "escaped": "quote-\\\"-slash-\\\\", "lone": "\\ud800", "n": 1e2 }  ',
      String.raw`["😀","\ud83d\ude00","\u0000","\b"]`,
      String.raw`{"a":"discarded","a":1,"nested":{"\ud800":true,"\ud800":"last"}}`,
      String.raw`{"\ud800":true,"�":"last"}`,
      '-0',
    ]
    for (const row of rows) {
      const value = await transcode(row)
      const text = typeof value === 'string'
        ? value
        : value === null ? '' : JSON.stringify(value)
      expect(await displaySize(row), row).toBe(Buffer.byteLength(text, 'utf-8'))
    }
  })

  test('rejects malformed and non-finite plugin JSON numbers', async () => {
    await expect(transcode('{"x":01}')).rejects.toThrow()
    await expect(transcode('1e999')).rejects.toThrow()
  })

  test('converts long finite numeric lexemes without retaining the token', async () => {
    const lexeme = `1${'0'.repeat(2_000)}e-2000`
    expect(await transcode(lexeme)).toBe(1)
    expect(await transcode(`-${lexeme}`)).toBe(-1)
  })

  test('matches the ingress depth limit and always observes an AbortSignal', async () => {
    const atLimit = `${'['.repeat(1_024)}0${']'.repeat(1_024)}`
    await expect(transcode(atLimit)).resolves.toBeDefined()
    const beyondLimit = `[${atLimit}]`
    await expect(transcode(beyondLimit)).rejects.toThrow(/nesting/i)

    const controller = new AbortController()
    controller.abort(new Error('already disconnected'))
    await expect(transcode('{"still":"must abort"}', {
      signal: controller.signal,
      shouldAbort: () => false,
    })).rejects.toMatchObject({ code: 'BACKUP_STREAM_ABORTED' })
  })
})
