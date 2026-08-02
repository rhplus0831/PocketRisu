import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { Unpackr } from 'msgpackr'
import utilsPkg from '../../server/node/utils.cjs'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'

const DB_PATH_HEX = Buffer.from('database/database.bin').toString('hex')
const GROUPS = ['root', 'characters', 'botPresets', 'modules', 'personas'] as const
const unpackr = new Unpackr({ int64AsType: 'number', useRecords: false })
const {
  calculateHash,
  decodeRisuSave,
  encodeRisuSaveLegacy,
  normalizeJSON,
} = utilsPkg as {
  calculateHash: (value: unknown) => number
  decodeRisuSave: (value: Uint8Array) => Promise<any>
  encodeRisuSaveLegacy: (value: unknown) => Uint8Array
  normalizeJSON: (value: unknown) => any
}

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
    expect(ordinary.headers.get('x-pocketrisu-test-db-cache')).toBe('miss')
    const ordinaryEtag = ordinary.headers.get('x-db-etag')
    expect(ordinaryEtag).toMatch(/^[0-9a-f]{32}$/)

    const missResponse = await cachedRead(emptyHashes())
    expect(missResponse.status).toBe(200)
    expect(missResponse.headers.get('x-pocketrisu-test-db-cache')).toBe('hit')
    const initiallyEncoded = Number(
      missResponse.headers.get('x-pocketrisu-test-db-segments-encoded'),
    )
    expect(initiallyEncoded).toBeGreaterThan(0)
    expect(missResponse.headers.get('x-pocketrisu-test-db-segments-reused')).toBe('0')
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
    expect(hitResponse.headers.get('x-pocketrisu-test-db-cache')).toBe('hit')
    expect(hitResponse.headers.get('x-pocketrisu-test-db-segments-encoded')).toBe('0')
    expect(Number(hitResponse.headers.get('x-pocketrisu-test-db-segments-reused')))
      .toBe(initiallyEncoded)
    expect(hitResponse.headers.get('x-db-etag')).toBe(ordinaryEtag)
    const hitEnvelope = unpackr.decode(new Uint8Array(await hitResponse.arrayBuffer())) as any
    expect(hitEnvelope.root).toEqual({ hash: fullHashes.root[0] })
    for (const group of GROUPS.slice(1)) {
      expect(hitEnvelope[group].map((segment: any) => segment.hash)).toEqual(fullHashes[group])
      expect(hitEnvelope[group].every((segment: any) => !('bytes' in segment))).toBe(true)
    }
  })

  test('seeds decoded reuse after an authoritative full write', async () => {
    const initial = await client.fetch('/api/read', {
      headers: { 'file-path': DB_PATH_HEX },
    })
    expect(initial.status).toBe(200)
    const bytes = new Uint8Array(await initial.arrayBuffer())

    const warm = await cachedRead(emptyHashes())
    expect(warm.status).toBe(200)
    expect(warm.headers.get('x-pocketrisu-test-db-cache')).toBe('hit')

    const written = await client.fetch('/api/write', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'file-path': DB_PATH_HEX,
      },
      body: bytes,
    })
    expect(written.status).toBe(200)
    const writeAcknowledgement = await written.json() as { etag?: string }
    expect(writeAcknowledgement.etag).toMatch(/^[0-9a-f]{32}$/)

    const warmAfterWrite = await cachedRead(emptyHashes())
    expect(warmAfterWrite.status).toBe(200)
    expect(warmAfterWrite.headers.get('x-pocketrisu-test-db-cache')).toBe('hit')
    expect(warmAfterWrite.headers.get('x-db-etag')).toBe(writeAcknowledgement.etag)
    expect(Number(warmAfterWrite.headers.get('x-pocketrisu-test-db-segments-encoded')))
      .toBeGreaterThan(0)
    expect(warmAfterWrite.headers.get('x-pocketrisu-test-db-segments-reused')).toBe('0')

    const warmAgain = await cachedRead(emptyHashes())
    expect(warmAgain.status).toBe(200)
    expect(warmAgain.headers.get('x-pocketrisu-test-db-cache')).toBe('hit')
    expect(warmAgain.headers.get('x-pocketrisu-test-db-segments-encoded')).toBe('0')
    expect(Number(warmAgain.headers.get('x-pocketrisu-test-db-segments-reused')))
      .toBeGreaterThan(0)
  })

  test('invalidates decoded reuse when SQLite changes without a timestamp change', async () => {
    const warm = await cachedRead(emptyHashes())
    expect(warm.status).toBe(200)
    expect(warm.headers.get('x-pocketrisu-test-db-cache')).toBe('hit')

    const sqlite = new Database(join(server.cwd, 'save', 'risuai.db'))
    const marker = `external-${Date.now()}`
    try {
      const selected = sqlite.prepare(`
        SELECT value, updated_at AS updatedAt
        FROM kv
        WHERE key = 'database/database.bin'
      `).get() as { value: Buffer, updatedAt: number }
      const externallyChanged = await decodeRisuSave(selected.value)
      externallyChanged.cacheRevisionProbe = marker
      const changed = sqlite.prepare(`
        UPDATE kv
        SET value = ?, updated_at = ?
        WHERE key = 'database/database.bin'
      `).run(Buffer.from(encodeRisuSaveLegacy(externallyChanged)), selected.updatedAt)
      expect(changed.changes).toBe(1)
    } finally {
      sqlite.close()
    }

    const coldAfterExternalWrite = await cachedRead(emptyHashes())
    expect(coldAfterExternalWrite.status).toBe(200)
    expect(coldAfterExternalWrite.headers.get('x-pocketrisu-test-db-cache')).toBe('miss')
    expect(Number(coldAfterExternalWrite.headers.get('x-pocketrisu-test-db-segments-encoded')))
      .toBeGreaterThan(0)
    expect(coldAfterExternalWrite.headers.get('x-pocketrisu-test-db-segments-reused')).toBe('0')

    const authoritative = await client.fetch('/api/read', {
      headers: { 'file-path': DB_PATH_HEX },
    })
    expect(authoritative.status).toBe(200)
    expect(await decodeRisuSave(new Uint8Array(await authoritative.arrayBuffer())))
      .toMatchObject({ cacheRevisionProbe: marker })
  })

  test('reuses unchanged segments across a copy-on-write patch revision', async () => {
    const authoritative = await client.fetch('/api/read', {
      headers: { 'file-path': DB_PATH_HEX },
    })
    expect(authoritative.status).toBe(200)
    const database = await decodeRisuSave(new Uint8Array(await authoritative.arrayBuffer()))

    const primed = await cachedRead(emptyHashes())
    expect(primed.status).toBe(200)
    const primedEnvelope = unpackr.decode(
      new Uint8Array(await primed.arrayBuffer()),
    ) as any
    const priorHashes = emptyHashes()
    priorHashes.root = [sha256(primedEnvelope.root.bytes)]
    for (const group of GROUPS.slice(1)) {
      priorHashes[group] = primedEnvelope[group].map((segment: any) => sha256(segment.bytes))
    }

    const changedName = `memoized-${Date.now()}`
    const patched = await client.fetch('/api/patch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'file-path': DB_PATH_HEX,
      },
      body: JSON.stringify({
        expectedHash: calculateHash(normalizeJSON(database)).toString(16),
        patch: [{ op: 'replace', path: '/characters/0/name', value: changedName }],
      }),
    })
    expect(patched.status).toBe(200)

    const afterPatch = await cachedRead(priorHashes)
    expect(afterPatch.status).toBe(200)
    expect(afterPatch.headers.get('x-pocketrisu-test-db-segments-encoded')).toBe('1')
    expect(Number(afterPatch.headers.get('x-pocketrisu-test-db-segments-reused')))
      .toBeGreaterThan(0)
    const afterEnvelope = unpackr.decode(
      new Uint8Array(await afterPatch.arrayBuffer()),
    ) as any
    expect(afterEnvelope.root).toEqual({ hash: priorHashes.root[0] })
    expect(afterEnvelope.characters[0]).toHaveProperty('bytes')
    expect(unpackr.decode(afterEnvelope.characters[0].bytes)).toMatchObject({ name: changedName })
  })

  test('negotiates generic KV reads while database.bin ignores the cache header', async () => {
    const key = 'cache-test/generic.json'
    const encodedKey = Buffer.from(key).toString('hex')
    const value = Buffer.from('{"unicode":"캐시","items":[1,2,3]}')
    const contentHash = sha256(value)

    const writeResponse = await client.fetch('/api/write', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'file-path': encodedKey,
      },
      body: new Uint8Array(value),
    })
    expect(writeResponse.status).toBe(200)
    await expect(writeResponse.json()).resolves.toMatchObject({ success: true })

    const ordinary = await client.fetch('/api/read', { headers: { 'file-path': encodedKey } })
    expect(ordinary.status).toBe(200)
    expect(ordinary.headers.get('x-content-hash')).toBeNull()
    expect(Buffer.from(await ordinary.arrayBuffer())).toEqual(value)

    const malformedInventory = await client.fetch('/api/read', {
      headers: { 'file-path': encodedKey, 'x-cached-hashes': 'not-a-hash' },
    })
    expect(malformedInventory.status).toBe(200)
    expect(malformedInventory.headers.get('x-content-hash')).toBeNull()
    expect(Buffer.from(await malformedInventory.arrayBuffer())).toEqual(value)

    const miss = await client.fetch('/api/read', {
      headers: { 'file-path': encodedKey, 'x-cached-hashes': '0'.repeat(64) },
    })
    expect(miss.status).toBe(200)
    expect(miss.headers.get('x-content-hash')).toBe(contentHash)
    expect(Buffer.from(await miss.arrayBuffer())).toEqual(value)

    const hit = await client.fetch('/api/read', {
      headers: { 'file-path': encodedKey, 'x-cached-hashes': contentHash },
    })
    expect(hit.status).toBe(204)
    expect(hit.headers.get('x-content-hash')).toBe(contentHash)
    expect((await hit.arrayBuffer()).byteLength).toBe(0)

    const fullDatabase = await client.fetch('/api/read', { headers: { 'file-path': DB_PATH_HEX } })
    expect(fullDatabase.status).toBe(200)
    const fullDatabaseBytes = Buffer.from(await fullDatabase.arrayBuffer())
    const databaseWithCacheHeader = await client.fetch('/api/read', {
      headers: {
        'file-path': DB_PATH_HEX,
        'x-cached-hashes': sha256(fullDatabaseBytes),
      },
    })
    expect(databaseWithCacheHeader.status).toBe(200)
    expect(databaseWithCacheHeader.headers.get('x-content-hash')).toBeNull()
    expect(Buffer.from(await databaseWithCacheHeader.arrayBuffer())).toEqual(fullDatabaseBytes)
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
