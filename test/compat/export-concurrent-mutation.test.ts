import { afterAll, describe, expect, test } from 'vitest'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'

const MIB = 1024 * 1024
const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

function pluginStorageKey(rawKey: string): string {
  return `pluginsave/${Buffer.from(rawKey, 'utf-8').toString('base64url')}.json`
}

async function writeKv(client: RisuClient, key: string, value: Buffer): Promise<Response> {
  return client.fetch('/api/write', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': Buffer.from(key, 'utf-8').toString('hex'),
    },
    body: new Uint8Array(value),
  })
}

interface WalkedEntry {
  name: string
  declaredSize: number
  availableSize: number
  data: Buffer
}

/** Tolerant archive walker: reports declared vs actually available entry bytes. */
function walkArchive(buffer: Buffer): {
  entries: WalkedEntry[]
  truncated: boolean
  trailing: number
} {
  const entries: WalkedEntry[] = []
  let offset = 0
  while (offset + 4 <= buffer.length) {
    const nameLength = buffer.readUInt32LE(offset)
    if (offset + 4 + nameLength + 4 > buffer.length) {
      return { entries, truncated: true, trailing: buffer.length - offset }
    }
    const name = buffer.subarray(offset + 4, offset + 4 + nameLength).toString('utf-8')
    const declaredSize = buffer.readUInt32LE(offset + 4 + nameLength)
    const dataStart = offset + 4 + nameLength + 4
    const availableSize = Math.min(declaredSize, buffer.length - dataStart)
    entries.push({
      name,
      declaredSize,
      availableSize,
      data: buffer.subarray(dataStart, dataStart + availableSize),
    })
    if (availableSize < declaredSize) {
      return { entries, truncated: true, trailing: buffer.length - offset }
    }
    offset = dataStart + declaredSize
  }
  return { entries, truncated: offset !== buffer.length, trailing: buffer.length - offset }
}

function largeJson(fill: string): Buffer {
  return Buffer.from(`"${fill.repeat(8 * MIB - 2)}"`)
}

async function expectPointInTimeExport(initial: Buffer, replacement: Buffer): Promise<void> {
  const source = await spawnServer()
  servers.push(source)
  const client = await createClient(source.port, source.password)
  expect((await client.importBackup(createSeedBackup())).ok).toBe(true)

  const stallAsset = Buffer.alloc(8 * MIB, 0xab)
  for (let i = 0; i < 6; i++) {
    expect((await writeKv(client, `assets/stall-${i}.png`, stallAsset)).status).toBe(200)
  }

  const victimKey = pluginStorageKey('concurrent-export-victim')
  expect((await writeKv(client, victimKey, initial)).status).toBe(200)

  // Fetch resolves once headers arrive. Leave the body unread so the six
  // preceding assets fill socket buffers and stall the server on backpressure.
  const exportResponse = await client.fetch('/api/backup/export')
  expect(exportResponse.status).toBe(200)
  const contentLengthHeader = exportResponse.headers.get('content-length')
  expect(contentLengthHeader).toBeTruthy()
  const advertisedLength = Number(contentLengthHeader)
  expect(advertisedLength).toBeGreaterThan(0)

  await new Promise(resolve => setTimeout(resolve, 750))
  expect((await writeKv(client, victimKey, replacement)).status).toBe(200)

  const downloaded = Buffer.from(await exportResponse.arrayBuffer())
  expect(downloaded.length).toBe(advertisedLength)

  const walked = walkArchive(downloaded)
  expect(walked.truncated).toBe(false)
  expect(walked.trailing).toBe(0)

  const databaseEntry = walked.entries.find(entry => entry.name === 'database.risudat')
  expect(databaseEntry).toBeTruthy()
  expect(databaseEntry!.availableSize).toBe(databaseEntry!.declaredSize)

  const pluginEntry = walked.entries.find(entry => entry.name === victimKey)
  expect(pluginEntry).toBeTruthy()
  expect(pluginEntry!.availableSize).toBe(pluginEntry!.declaredSize)
  expect(pluginEntry!.data).toEqual(initial)

  const destination = await spawnServer()
  servers.push(destination)
  const destinationClient = await createClient(destination.port, destination.password)
  expect((await destinationClient.importBackup(downloaded)).ok).toBe(true)
}

describe('concurrent plugin write during /api/backup/export', () => {
  test('growing a plugin row preserves the original point-in-time archive', async () => {
    await expectPointInTimeExport(Buffer.from('1'), largeJson('a'))
  }, 120_000)

  test('shrinking a plugin row preserves the original point-in-time archive', async () => {
    await expectPointInTimeExport(largeJson('b'), Buffer.from('1'))
  }, 120_000)
})
