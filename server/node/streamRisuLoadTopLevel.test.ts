import path from 'node:path'
import os from 'node:os'
import { gzipSync } from 'node:zlib'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, test } from 'vitest'
import { Packr } from 'msgpackr'

const require = createRequire(import.meta.url)
const { readRisuSaveTopLevelFields } = require('./streamRisuLoad.cjs') as {
  readRisuSaveTopLevelFields: (
    input: Buffer | { filePath: string; size?: number },
    requestedKeys: string[],
    options?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
}
const { magicStreamCompressedHeader } = require('./utils.cjs') as {
  magicStreamCompressedHeader: Uint8Array
}

const packr = new Packr({ useRecords: false })
const METADATA_LIMIT = 64 * 1024
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function mapHeader(count: number): Buffer {
  if (count <= 15) return Buffer.from([0x80 | count])
  const header = Buffer.alloc(3)
  header[0] = 0xde
  header.writeUInt16BE(count, 1)
  return header
}

function encoded(value: unknown): Buffer {
  return Buffer.from(packr.encode(value))
}

function encodedStringBytes(length: number, byte = 0x78): Buffer {
  if (length <= 0xff) {
    return Buffer.concat([Buffer.from([0xd9, length]), Buffer.alloc(length, byte)])
  }
  if (length <= 0xffff) {
    const header = Buffer.alloc(3)
    header[0] = 0xda
    header.writeUInt16BE(length, 1)
    return Buffer.concat([header, Buffer.alloc(length, byte)])
  }
  const header = Buffer.alloc(5)
  header[0] = 0xdb
  header.writeUInt32BE(length, 1)
  return Buffer.concat([header, Buffer.alloc(length, byte)])
}

function encodedMap(entries: Array<[Buffer, Buffer]>): Buffer {
  return Buffer.concat([
    mapHeader(entries.length),
    ...entries.flatMap(([key, value]) => [key, value]),
  ])
}

async function writeSource(bytes: Buffer, prefix: string): Promise<{
  dir: string
  filePath: string
  source: { filePath: string; size: number }
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  const filePath = path.join(dir, 'database.bin')
  await writeFile(filePath, bytes)
  return { dir, filePath, source: { filePath, size: bytes.length } }
}

describe('bounded legacy MessagePack top-level metadata preflight', () => {
  test('rejects an oversized root key before decoding it', async () => {
    const hugeKey = encodedStringBytes(8 * 1024 * 1024)
    const payload = encodedMap([[hugeKey, encoded(true)]])
    const { source } = await writeSource(payload, 'risu-top-field-key-')

    await expect(readRisuSaveTopLevelFields(source, ['optimizePluginMemory']))
      .rejects.toMatchObject({
        code: 'RISU_SAVE_METADATA_TOO_LARGE',
        status: 413,
        limit: METADATA_LIMIT,
        actual: hugeKey.length,
        retryable: false,
        commitOutcome: 'not-committed',
      })
  })

  test.each(['pluginStorageGeneration', 'optimizePluginMemory'])(
    'rejects an oversized requested %s descriptor and removes a decoded spool',
    async requestedKey => {
      const oversized = encodedStringBytes(METADATA_LIMIT)
      const payload = encodedMap([[encoded(requestedKey), oversized]])
      const compressed = Buffer.concat([
        Buffer.from(magicStreamCompressedHeader),
        gzipSync(payload),
      ])
      const { dir, filePath, source } = await writeSource(
        compressed,
        `risu-top-field-${requestedKey}-`,
      )
      const spoolDir = await mkdtemp(path.join(os.tmpdir(), 'risu-top-field-spool-'))
      dirs.push(spoolDir)
      let preparedPath = ''
      let preparedMode = 0

      await expect(readRisuSaveTopLevelFields(source, [requestedKey], {
        tempDir: spoolDir,
        diskHeadroomBytes: 0,
        availableDiskBytes: payload.length * 4,
        onDecodedSourcePrepared: async ({ filePath: decodedPath }: { filePath: string }) => {
          preparedPath = decodedPath
          preparedMode = (await stat(decodedPath)).mode & 0o777
        },
      })).rejects.toMatchObject({
        code: 'RISU_SAVE_METADATA_TOO_LARGE',
        status: 413,
        limit: METADATA_LIMIT,
        actual: oversized.length,
        retryable: false,
        commitOutcome: 'not-committed',
      })
      expect(path.dirname(preparedPath)).toBe(spoolDir)
      expect(path.basename(preparedPath)).toMatch(/^\.risu-stream-load-.*\.decoded-.*\.tmp$/)
      expect(preparedMode).toBe(0o600)
      expect((await stat(preparedPath).catch(() => null))).toBeNull()
      expect(await readdir(spoolDir)).toEqual([])
      expect(await readdir(dir)).toEqual([path.basename(filePath)])
    },
  )

  test('accepts the exact cap and cursor-skips an unrelated multi-megabyte value', async () => {
    const exact = encodedStringBytes(METADATA_LIMIT - 3)
    expect(exact).toHaveLength(METADATA_LIMIT)
    const payload = encodedMap([
      [encoded('unrelated'), encodedStringBytes(16 * 1024 * 1024)],
      [encoded('pluginStorageGeneration'), exact],
      [encoded('optimizePluginMemory'), encoded(true)],
    ])
    const { source } = await writeSource(payload, 'risu-top-field-skip-')

    await expect(readRisuSaveTopLevelFields(
      source,
      ['pluginStorageGeneration', 'optimizePluginMemory'],
    )).resolves.toEqual({
      pluginStorageGeneration: 'x'.repeat(METADATA_LIMIT - 3),
      optimizePluginMemory: true,
    })
  })

  test('polls cancellation while cursor-walking root fields and closes the source', async () => {
    const payload = encodedMap(Array.from({ length: 64 }, (_, index) => [
      encoded(`unrequested-${index}`),
      encoded(index),
    ]))
    const { dir, filePath, source } = await writeSource(payload, 'risu-top-field-abort-')
    let checks = 0

    await expect(readRisuSaveTopLevelFields(source, ['optimizePluginMemory'], {
      shouldAbort: () => ++checks >= 20,
    })).rejects.toMatchObject({
      name: 'AbortError',
      code: 'RISU_STREAM_ABORTED',
    })
    expect(checks).toBeGreaterThanOrEqual(20)
    expect(await readdir(dir)).toEqual([path.basename(filePath)])
  })
})
