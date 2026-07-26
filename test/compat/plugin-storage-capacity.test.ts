import { afterAll, describe, expect, test } from 'vitest'
import { readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import Database from 'better-sqlite3'
import { createClient, type RisuClient } from './helpers/client.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'

const CHUNK_MARKER = Buffer.from('\x00RISUCHUNKED\x00', 'binary')
const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

async function boot(limits: { value: number; total: number }) {
  const server = await spawnServer({
    env: {
      POCKETRISU_CHUNK_THRESHOLD: '1024',
      POCKETRISU_PLUGIN_VALUE_MAX_BYTES: String(limits.value),
      POCKETRISU_PLUGIN_STORAGE_MAX_BYTES: String(limits.total),
    },
  })
  servers.push(server)
  return { server, client: await createClient(server.port, server.password) }
}

function storageKey(raw: string): string {
  return `pluginsave/${Buffer.from(raw, 'utf8').toString('base64url')}.json`
}

function exactJsonBytes(size: number, fill = 'x'): Uint8Array {
  if (size < 2) throw new Error('JSON string size must be at least two bytes')
  const bytes = Buffer.from(JSON.stringify(fill.repeat(size - 2)), 'utf8')
  expect(bytes.byteLength).toBe(size)
  return new Uint8Array(bytes)
}

async function streamWrite(client: RisuClient, key: string, body: Uint8Array): Promise<Response> {
  return client.fetch('/api/plugin-storage/mutate', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': Buffer.from(key, 'utf8').toString('hex'),
      'x-plugin-storage-operation': 'set',
      'x-plugin-storage-owner': Buffer.from('Capacity Test', 'utf8').toString('base64url'),
      'x-plugin-storage-stream': '1',
    },
    body,
  })
}

async function readValue(client: RisuClient, key: string): Promise<Buffer> {
  const response = await client.fetch('/api/read', {
    headers: { 'file-path': Buffer.from(key, 'utf8').toString('hex') },
  })
  expect(response.status).toBe(200)
  return Buffer.from(await response.arrayBuffer())
}

describe('optimized plugin large-value capacity (real server)', () => {
  test('keeps an authoritative SQLite plugin value over a stale legacy file on restart', async () => {
    const key = storageKey('migration-authority')
    const authoritative = Buffer.from(JSON.stringify({ source: 'sqlite', data: 'a'.repeat(6_000) }))
    const stale = Buffer.from(JSON.stringify({ source: 'legacy', data: 'b'.repeat(6_000) }))
    const server = await spawnServer({
      env: {
        POCKETRISU_CHUNK_THRESHOLD: '1024',
        POCKETRISU_PLUGIN_VALUE_MAX_BYTES: '16384',
        POCKETRISU_PLUGIN_STORAGE_MAX_BYTES: '65536',
      },
      seedSave: async (saveDir) => {
        const sqlite = new Database(path.join(saveDir, 'risuai.db'))
        sqlite.exec(`
          CREATE TABLE kv (
            key        TEXT    PRIMARY KEY,
            value      BLOB    NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `)
        sqlite.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)')
          .run(key, authoritative, Date.now())
        sqlite.close()
        await writeFile(path.join(saveDir, Buffer.from(key, 'utf8').toString('hex')), stale)
      },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)

    expect(await readValue(client, key)).toEqual(authoritative)

    const sqlite = new Database(path.join(server.cwd, 'save', 'risuai.db'), { readonly: true })
    const row = sqlite.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: Buffer }
    const manifestCount = sqlite.prepare(
      'SELECT COUNT(*) n FROM manifest_chunks WHERE manifest_key = ?',
    ).get(key) as { n: number }
    sqlite.close()
    expect(Buffer.from(row.value)).toEqual(authoritative)
    expect(manifestCount.n).toBe(0)
  })

  test('streams vectors/media and chunks large rows without changing logical reads', async () => {
    const { server, client } = await boot({ value: 16_384, total: 65_536 })
    const rows = new Map<string, Uint8Array>([
      [storageKey('vector'), exactJsonBytes(6_000, '1')],
      [storageKey('media'), exactJsonBytes(7_000, 'm')],
    ])
    for (let index = 0; index < 20; index++) {
      rows.set(storageKey(`record/${index}`), exactJsonBytes(600, String(index % 10)))
    }

    for (const [key, value] of rows) {
      const response = await streamWrite(client, key, value)
      expect(response.status).toBe(200)
      const result = await response.json() as { hash: string; outcome: string }
      expect(result.hash).toMatch(/^[0-9a-f]{64}$/)
      expect(result.outcome).toBe('committed')
    }

    for (const [key, value] of rows) {
      expect(await readValue(client, key)).toEqual(Buffer.from(value))
    }

    const sqlite = new Database(path.join(server.cwd, 'save', 'risuai.db'), { readonly: true })
    const layout = sqlite.prepare(
      "SELECT key, value FROM kv WHERE key LIKE 'pluginsave/%' ORDER BY key",
    ).all() as Array<{ key: string; value: Buffer }>
    const largeKeys = new Set([storageKey('vector'), storageKey('media')])
    expect(layout.filter(row => largeKeys.has(row.key)).every(row => Buffer.from(row.value).equals(CHUNK_MARKER)))
      .toBe(true)
    const manifestCount = sqlite.prepare(
      "SELECT COUNT(*) n FROM manifest_chunks WHERE manifest_key LIKE 'pluginsave/%'",
    ).get() as { n: number }
    expect(manifestCount.n).toBeGreaterThan(0)
    sqlite.close()

  })

  test('enforces per-value and aggregate limits atomically on streaming and legacy writes', async () => {
    const { server, client } = await boot({ value: 8_192, total: 12_000 })
    const seedKey = storageKey('seed')
    const unicodeAtLimit = Buffer.from(JSON.stringify('😀'.repeat(2_047) + 'xx'), 'utf8')
    expect(unicodeAtLimit.byteLength).toBe(8_192)
    expect((await streamWrite(client, seedKey, new Uint8Array(unicodeAtLimit))).status).toBe(200)
    expect(await readValue(client, seedKey)).toEqual(unicodeAtLimit)
    // Replacing subtracts the prior logical size before enforcing aggregate
    // capacity, so shrinking the same row to 7,000 bytes must remain possible.
    expect((await streamWrite(client, seedKey, exactJsonBytes(7_000))).status).toBe(200)

    const candidates = [storageKey('candidate/a'), storageKey('candidate/b')]
    const results = await Promise.all(candidates.map(key =>
      streamWrite(client, key, exactJsonBytes(5_000)).then(async response => ({
        status: response.status,
        body: await response.json() as any,
      })),
    ))
    expect(results.map(result => result.status).sort()).toEqual([200, 413])
    expect(results.find(result => result.status === 413)?.body).toMatchObject({
      code: 'PLUGIN_STORAGE_TOTAL_TOO_LARGE',
      limit: 12_000,
      actual: 17_000,
      retryable: false,
    })

    const oversizedKey = storageKey('oversized')
    const unicodeOverLimit = Buffer.from(JSON.stringify('😀'.repeat(2_047) + 'xxx'), 'utf8')
    expect(unicodeOverLimit.byteLength).toBe(8_193)
    const oversized = await streamWrite(client, oversizedKey, new Uint8Array(unicodeOverLimit))
    expect(oversized.status).toBe(413)
    await expect(oversized.json()).resolves.toMatchObject({
      code: 'PLUGIN_VALUE_TOO_LARGE',
      limit: 8_192,
      actual: 8_193,
      retryable: false,
    })

    const legacy = await client.fetch('/api/write', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'file-path': Buffer.from(storageKey('legacy-oversized'), 'utf8').toString('hex'),
      },
      body: exactJsonBytes(8_193),
    })
    expect(legacy.status).toBe(413)
    await expect(legacy.json()).resolves.toMatchObject({ code: 'PLUGIN_VALUE_TOO_LARGE' })

    const sqlite = new Database(path.join(server.cwd, 'save', 'risuai.db'), { readonly: true })
    const logicalTotal = sqlite.prepare('SELECT bytes FROM plugin_storage_usage WHERE id = 1').get() as { bytes: number }
    const storedCandidates = sqlite.prepare(
      "SELECT COUNT(*) n FROM kv WHERE key IN (?, ?)",
    ).get(...candidates) as { n: number }
    sqlite.close()
    expect(logicalTotal.bytes).toBe(12_000)
    expect(storedCandidates.n).toBe(1)
    expect(await readValue(client, seedKey)).toEqual(Buffer.from(exactJsonBytes(7_000)))

    const spoolEntries = await readdir(path.join(server.cwd, 'save', '.spool'))
    expect(spoolEntries.filter(name => name.startsWith('.plugin-value-'))).toEqual([])
  })
})
