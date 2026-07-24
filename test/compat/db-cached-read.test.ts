import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { Unpackr } from 'msgpackr'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'

const DB_PATH_HEX = Buffer.from('database/database.bin').toString('hex')
const GROUPS = ['root', 'characters', 'botPresets', 'modules', 'personas'] as const
const unpackr = new Unpackr({ int64AsType: 'number', useRecords: false })

let server: ServerHandle
let client: RisuClient

beforeAll(async () => {
  server = await spawnServer()
  client = await createClient(server.port, server.password)
  const imported = await client.importBackup(createSeedBackup())
  expect(imported.ok).toBe(true)
})

afterAll(async () => {
  await server?.cleanup()
})

const emptyHashes = () => Object.fromEntries(GROUPS.map(group => [group, []])) as Record<string, string[]>

async function cachedRead(hashes: Record<string, string[]>): Promise<Response> {
  return client.fetch('/api/db/read-cached', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cache: { version: 1, hashes } }),
  })
}

describe('cached database read route', () => {
  test('matches the ordinary read ETag and projects full misses then full hits', async () => {
    const ordinary = await client.fetch('/api/read', {
      headers: { 'file-path': DB_PATH_HEX },
    })
    expect(ordinary.status).toBe(200)
    const ordinaryEtag = ordinary.headers.get('x-db-etag')
    expect(ordinaryEtag).toMatch(/^[0-9a-f]{32}$/)

    const missResponse = await cachedRead(emptyHashes())
    expect(missResponse.status).toBe(200)
    expect(missResponse.headers.get('content-type')).toContain('application/octet-stream')
    expect(missResponse.headers.get('x-db-etag')).toBe(ordinaryEtag)
    const missEnvelope = unpackr.decode(new Uint8Array(await missResponse.arrayBuffer())) as any
    expect(missEnvelope.etag).toBe(ordinaryEtag)
    expect(missEnvelope.root).toHaveProperty('bytes')
    for (const group of GROUPS.slice(1)) {
      expect(missEnvelope[group].every((segment: any) => 'bytes' in segment)).toBe(true)
    }

    const fullHashes = emptyHashes()
    fullHashes.root = [sha256(missEnvelope.root.bytes)]
    for (const group of GROUPS.slice(1)) {
      fullHashes[group] = missEnvelope[group].map((segment: any) => sha256(segment.bytes))
    }
    const hitResponse = await cachedRead(fullHashes)
    expect(hitResponse.status).toBe(200)
    expect(hitResponse.headers.get('x-db-etag')).toBe(ordinaryEtag)
    const hitEnvelope = unpackr.decode(new Uint8Array(await hitResponse.arrayBuffer())) as any
    expect(hitEnvelope.root).toEqual({ hash: fullHashes.root[0] })
    for (const group of GROUPS.slice(1)) {
      expect(hitEnvelope[group].map((segment: any) => segment.hash)).toEqual(fullHashes[group])
      expect(hitEnvelope[group].every((segment: any) => !('bytes' in segment))).toBe(true)
    }
  })

  test('returns 400 for malformed and oversized inventories', async () => {
    const invalidJson = await client.fetch('/api/db/read-cached', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"cache":',
    })
    expect(invalidJson.status).toBe(400)

    const malformed = await client.fetch('/api/db/read-cached', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cache: { version: 1, hashes: { root: [] } } }),
    })
    expect(malformed.status).toBe(400)

    const hashes = emptyHashes()
    hashes.characters = Array(8193).fill('a'.repeat(64))
    const oversized = await cachedRead(hashes)
    expect(oversized.status).toBe(400)
  })
})

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
