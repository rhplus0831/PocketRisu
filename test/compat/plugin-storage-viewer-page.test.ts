import { afterAll, describe, expect, test } from 'vitest'
import Database from 'better-sqlite3'
import path from 'node:path'
import http from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createClient, type RisuClient } from './helpers/client.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { encodeBackup } from './helpers/encode.js'
import utilsPkg from '../../server/node/utils.cjs'
import pluginSaveKeysPkg from '../../server/node/pluginSaveKeys.cjs'

const { encodeRisuSaveLegacy } = utilsPkg as {
  encodeRisuSaveLegacy: (value: unknown) => Uint8Array
}
const { encodePluginSaveStorageKey } = pluginSaveKeysPkg as {
  encodePluginSaveStorageKey: (key: string, prefix: string) => string
}

const servers: ServerHandle[] = []
afterAll(async () => Promise.allSettled(servers.map(server => server.cleanup())))

const DATABASE_KEY = 'database/database.bin'
const MANIFEST_KEY = 'plugin-storage/manifest.json'
const GENERATION = 'pm3-viewer-generation'
const valueKey = (key: string) => encodePluginSaveStorageKey(key, 'pluginsave/')
const ownerKey = (key: string) => encodePluginSaveStorageKey(key, 'pluginsave-meta/')

function seedViewer(
  saveDir: string,
  count: number,
  options: {
    keys?: string[]
    bodyBytes?: number
    unknownIndices?: Set<number>
    emptyOwnerIndices?: Set<number>
  } = {},
): { keys: string[]; manifest: any } {
  const keys = options.keys ?? Array.from({ length: count }, (_, index) => (
    `key-${index.toString().padStart(5, '0')}`
  ))
  const ownedKeys = keys.filter((_key, index) => !options.unknownIndices?.has(index))
  const manifest = {
    version: 2,
    generation: GENERATION,
    valueKeys: keys.map(valueKey),
    metaKeys: ownedKeys.map(ownerKey),
  }
  const db = new Database(path.join(saveDir, 'risuai.db'))
  db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL)')
  const insert = db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)')
  db.transaction(() => {
    for (const [index, key] of keys.entries()) {
      insert.run(valueKey(key), Buffer.from(JSON.stringify({
        phase: 'old',
        index,
        ...(options.bodyBytes ? { body: 'x'.repeat(options.bodyBytes) } : {}),
      })), 1)
      if (!options.unknownIndices?.has(index)) {
        insert.run(ownerKey(key), Buffer.from(JSON.stringify({
          plugin: options.emptyOwnerIndices?.has(index) ? '' : `Owner ${index % 7}`,
          updatedAt: index,
        })), 1)
      }
    }
    insert.run(valueKey('foreign'), Buffer.from('"quarantined"'), 1)
    insert.run(ownerKey('foreign'), Buffer.from('{"plugin":"Foreign","updatedAt":1}'), 1)
    insert.run(MANIFEST_KEY, Buffer.from(JSON.stringify(manifest)), 1)
    insert.run(DATABASE_KEY, Buffer.from(encodeRisuSaveLegacy({
      characters: [],
      optimizePluginMemory: true,
      pluginStorageGeneration: GENERATION,
      pluginCustomStorage: {},
    })), 1)
  })()
  db.close()
  return { keys, manifest }
}

type ViewerResult = {
  meta: any
  entries: any[]
  done: any
}

async function readViewer(response: Response): Promise<ViewerResult> {
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('application/x-ndjson')
  const lines = (await response.text()).trim().split('\n').map(line => JSON.parse(line))
  expect(lines[0].event).toBe('meta')
  expect(lines.at(-1).event).toBe('done')
  return { meta: lines[0], entries: lines.slice(1, -1), done: lines.at(-1) }
}

async function viewer(client: RisuClient, suffix = ''): Promise<Response> {
  return client.fetch(`/api/plugin-storage/viewer-page${suffix}`, {
    headers: { 'x-plugin-storage-generation': GENERATION },
  })
}

function batchBody(keys: string[], manifest: any, phase: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    version: 1,
    generation: GENERATION,
    expectedManifest: manifest,
    operations: keys.map((key, index) => ({
      operation: 'set',
      key,
      value: Buffer.from(JSON.stringify({ phase, index })).toString('base64'),
      owner: `Owner ${index % 7}`,
    })),
  }))
}

function revisionBatchBody(
  manifestRevision: string,
  operations: Array<Record<string, unknown>>,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    version: 2,
    generation: GENERATION,
    expectedManifestRevision: manifestRevision,
    operations,
  }))
}

async function revisionBatch(
  client: RisuClient,
  manifestRevision: string,
  operations: Array<Record<string, unknown>>,
): Promise<Response> {
  return client.fetch('/api/plugin-storage/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: revisionBatchBody(manifestRevision, operations),
  })
}

async function mutate(
  client: RisuClient,
  keys: string[],
  manifest: any,
  phase = 'new',
): Promise<Response> {
  return client.fetch('/api/plugin-storage/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: batchBody(keys, manifest, phase),
  })
}

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function waitForJsonFile<T>(
  filePath: string,
  predicate: (value: T) => boolean,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      try {
        const value = JSON.parse(await readFile(filePath, 'utf-8')) as T
        if (predicate(value)) return value
      } catch {
        // The test-only state file is replaced frequently while requests queue.
      }
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for matching JSON in ${filePath}`)
}

describe('PM3 point-in-time plugin storage viewer page', () => {
  test('a real 10k-key publication reads one default 50-row page with deterministic bounds', async () => {
    const server = await spawnServer({
      seedSave: async saveDir => { seedViewer(saveDir, 10_000) },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)

    const result = await readViewer(await viewer(client, '?page=123'))

    expect(result.meta).toMatchObject({
      version: 1,
      generation: GENERATION,
      page: 123,
      pageSize: 50,
      pageCount: 200,
      total: 10_000,
    })
    expect(result.meta.totalBytes).toBe(
      Array.from({ length: 10_000 }, (_, index) => Buffer.byteLength(JSON.stringify({
        phase: 'old',
        index,
      }))).reduce((sum, size) => sum + size, 0),
    )
    expect(result.meta.manifestRevision).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(result.meta.databaseRevision).toMatch(/^[0-9a-f]{32}$/)
    expect(result.meta.ownerFacetTotal).toBe(10_000)
    expect(result.meta.unknownOwnerCount).toBe(0)
    expect(result.meta.ownerFacets).toEqual([
      { owner: 'Owner 0', count: 1429 },
      { owner: 'Owner 1', count: 1429 },
      { owner: 'Owner 2', count: 1429 },
      { owner: 'Owner 3', count: 1429 },
      { owner: 'Owner 4', count: 1428 },
      { owner: 'Owner 5', count: 1428 },
      { owner: 'Owner 6', count: 1428 },
    ])
    expect(result.entries).toHaveLength(50)
    expect(result.entries[0].key).toBe('key-06150')
    expect(result.entries.at(-1).key).toBe('key-06199')
    expect(result.entries.every(entry => entry.event === 'entry')).toBe(true)
    expect(result.done.pageToken).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(result.done.metrics).toEqual({
      manifestParses: 1,
      valueReads: 50,
      sizeValueReads: 10_000,
      ownerReads: 50,
      maxRowParses: 1,
    })

    const searched = await readViewer(await viewer(client, '?key=key-0999&pageSize=50'))
    expect(searched.meta.total).toBe(10)
    expect(searched.meta.totalBytes).toBe(result.meta.totalBytes)
    expect(searched.done.metrics.sizeValueReads).toBe(0)
    expect(searched.entries.map(entry => entry.key)).toEqual(
      Array.from({ length: 10 }, (_, index) => `key-0999${index}`),
    )

    const owned = await readViewer(await viewer(client, '?owner=Owner%206&page=28'))
    expect(owned.meta.total).toBe(1428)
    expect(owned.meta.pageCount).toBe(29)
    expect(owned.entries).toHaveLength(28)
    expect(owned.entries.every(entry => entry.owner === 'Owner 6')).toBe(true)
  }, 30_000)

  test('mixed numeric and Unicode keys use canonical record order without normalization', async () => {
    const keys = ['\u00e9', '10', '01', '\ue000', '2', 'e\u0301', '0', '\ud83d\ude00', '4294967295']
    const server = await spawnServer({
      seedSave: async saveDir => { seedViewer(saveDir, keys.length, { keys }) },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)

    const result = await readViewer(await viewer(client))
    expect(result.entries.map(entry => entry.key)).toEqual([
      '0', '2', '10', '01', '4294967295', 'e\u0301', '\u00e9', '\ud83d\ude00', '\ue000',
    ])
    expect(result.entries.map(entry => entry.key)).toContain('e\u0301')
    expect(result.entries.map(entry => entry.key)).toContain('\u00e9')
  })

  test('totalBytes uses logical UTF-8 value sizes, excludes foreign rows, and invalidates after writes', async () => {
    const keys = ['string', 'null', 'object']
    let seeded!: ReturnType<typeof seedViewer>
    const rawValues = [
      JSON.stringify('한글'),
      'null',
      '{  "value" : "é"  }',
    ]
    const server = await spawnServer({
      seedSave: async saveDir => {
        seeded = seedViewer(saveDir, keys.length, { keys })
        const db = new Database(path.join(saveDir, 'risuai.db'))
        const update = db.prepare('UPDATE kv SET value = ? WHERE key = ?')
        db.transaction(() => {
          keys.forEach((key, index) => update.run(Buffer.from(rawValues[index]), valueKey(key)))
        })()
        db.close()
      },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)

    const first = await readViewer(await viewer(client))
    const expected = rawValues.reduce((sum, raw) => {
      const value = JSON.parse(raw)
      const text = typeof value === 'string' ? value : value === null ? '' : JSON.stringify(value)
      return sum + Buffer.byteLength(text)
    }, 0)
    expect(first.meta.totalBytes).toBe(expected)
    expect(first.entries.reduce((sum, entry) => sum + entry.size, 0)).toBe(expected)
    expect(first.done.metrics.sizeValueReads).toBe(keys.length)

    const mutation = await mutate(client, [keys[0]], seeded.manifest, 'expanded-phase')
    expect(mutation.status).toBe(200)
    const second = await readViewer(await viewer(client))
    const replacementSize = Buffer.byteLength(JSON.stringify({
      phase: 'expanded-phase',
      index: 0,
    }))
    expect(second.meta.totalBytes).toBe(
      expected - Buffer.byteLength('한글') + replacementSize,
    )
    expect(second.done.metrics.sizeValueReads).toBe(0)
  })

  test('cold and indexed pages are response-identical and the cold page reuses backfill values', async () => {
    let gateDir = ''
    const server = await spawnServer({
      seedSave: async saveDir => {
        seedViewer(saveDir, 60)
        gateDir = path.join(path.dirname(saveDir), 'viewer-reuse')
        await mkdir(gateDir, { recursive: true })
      },
      env: { POCKETRISU_TEST_PLUGIN_VIEWER_GATE_DIR: 'viewer-reuse' },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)

    const cold = await readViewer(await viewer(client, '?page=1'))
    const coldCounters = JSON.parse(await readFile(
      path.join(gateDir, 'result.json'),
      'utf-8',
    ))
    expect(coldCounters).toMatchObject({ backfillPasses: 1, pageValueReuses: 10 })

    const indexed = await readViewer(await viewer(client, '?page=1'))
    expect(indexed.meta).toEqual(cold.meta)
    expect(indexed.entries).toEqual(cold.entries)
    expect(indexed.done.pageToken).toBe(cold.done.pageToken)
    expect(cold.done.metrics.sizeValueReads).toBe(60)
    expect(indexed.done.metrics.sizeValueReads).toBe(0)
  })

  test('concurrent cold viewers share one authoritative facet backfill', async () => {
    let gateDir = ''
    const server = await spawnServer({
      seedSave: async saveDir => {
        seedViewer(saveDir, 250)
        gateDir = path.join(path.dirname(saveDir), 'viewer-single-flight')
        await mkdir(gateDir, { recursive: true })
      },
      env: { POCKETRISU_TEST_PLUGIN_VIEWER_GATE_DIR: 'viewer-single-flight' },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)

    const results = await Promise.all(Array.from({ length: 8 }, async (_, index) => (
      readViewer(await viewer(client, `?page=${index % 5}`))
    )))
    expect(results.every(result => result.meta.total === 250)).toBe(true)
    const counters = JSON.parse(await readFile(path.join(gateDir, 'result.json'), 'utf-8'))
    expect(counters.backfillPasses).toBe(1)
  })

  test('missing and falsely-current facets fall back to authority and rebuild without quarantine', async () => {
    let seeded!: ReturnType<typeof seedViewer>
    const server = await spawnServer({
      seedSave: async saveDir => { seeded = seedViewer(saveDir, 4) },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const initial = await readViewer(await viewer(client))
    expect(initial.entries).toHaveLength(4)

    const sqlite = new Database(path.join(server.cwd, 'save', 'risuai.db'))
    sqlite.transaction(() => {
      sqlite.prepare(
        'DELETE FROM plugin_storage_viewer_value_facets WHERE storage_key = ?',
      ).run(valueKey(seeded.keys[0]))
      sqlite.prepare(
        'UPDATE plugin_storage_owners SET owner = ? WHERE storage_key = ?',
      ).run('Wrong owner', ownerKey(seeded.keys[0]))
      // Simulate an unverifiable maintenance tool falsely claiming the partial
      // derivative is current. Completeness must still force authority.
      sqlite.prepare(`
        UPDATE plugin_storage_viewer_facet_revision
           SET indexed_revision = source_revision
         WHERE id = 1
      `).run()
    })()
    sqlite.close()

    const rebuilt = await readViewer(await viewer(client))
    expect(rebuilt.done.metrics.sizeValueReads).toBe(4)
    expect(rebuilt.entries[0].owner).toBe('Owner 0')
    expect(rebuilt.meta.totalBytes).toBe(initial.meta.totalBytes)

    const verified = new Database(path.join(server.cwd, 'save', 'risuai.db'), { readonly: true })
    const facetKeys = verified.prepare(
      'SELECT storage_key FROM plugin_storage_viewer_value_facets ORDER BY storage_key',
    ).all().map((row: any) => row.storage_key)
    const ownerRows = verified.prepare(
      'SELECT storage_key, owner FROM plugin_storage_owners ORDER BY storage_key',
    ).all() as Array<{ storage_key: string; owner: string }>
    const revision = verified.prepare(`
      SELECT source_revision AS sourceRevision, indexed_revision AS indexedRevision
        FROM plugin_storage_viewer_facet_revision WHERE id = 1
    `).get() as { sourceRevision: number; indexedRevision: number }
    verified.close()
    expect(facetKeys).toEqual(seeded.keys.map(valueKey).sort())
    expect(facetKeys).not.toContain(valueKey('foreign'))
    expect(ownerRows.find(row => row.storage_key === ownerKey(seeded.keys[0]))?.owner)
      .toBe('Owner 0')
    expect(ownerRows.some(row => row.storage_key === ownerKey('foreign'))).toBe(false)
    expect(revision.indexedRevision).toBe(revision.sourceRevision)
  })

  test('batch set/remove updates display and owner facets in the publication transaction', async () => {
    const server = await spawnServer({ seedSave: async saveDir => { seedViewer(saveDir, 2) } })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const initial = await readViewer(await viewer(client))
    const replacement = { replaced: '한글' }
    const response = await revisionBatch(client, initial.meta.manifestRevision, [
      {
        operation: 'set',
        key: 'key-00000',
        value: Buffer.from(JSON.stringify(replacement)).toString('base64'),
        owner: 'Changed owner',
      },
      { operation: 'remove', key: 'key-00001' },
    ])
    expect(response.status, await response.clone().text()).toBe(200)

    const result = await readViewer(await viewer(client))
    expect(result.entries).toEqual([expect.objectContaining({
      key: 'key-00000',
      owner: 'Changed owner',
      text: JSON.stringify(replacement),
      size: Buffer.byteLength(JSON.stringify(replacement)),
    })])
    expect(result.done.metrics.sizeValueReads).toBe(0)

    const sqlite = new Database(path.join(server.cwd, 'save', 'risuai.db'), { readonly: true })
    const facets = sqlite.prepare(
      'SELECT storage_key, display_size FROM plugin_storage_viewer_value_facets ORDER BY storage_key',
    ).all() as Array<{ storage_key: string; display_size: number }>
    const owners = sqlite.prepare(
      'SELECT storage_key, owner FROM plugin_storage_owners ORDER BY storage_key',
    ).all() as Array<{ storage_key: string; owner: string }>
    sqlite.close()
    expect(facets).toEqual([{
      storage_key: valueKey('key-00000'),
      display_size: Buffer.byteLength(JSON.stringify(replacement)),
    }])
    expect(owners).toEqual([{
      storage_key: ownerKey('key-00000'),
      owner: 'Changed owner',
    }])
  })

  test('malformed legacy UTF-16 keys remain distinct and readable', async () => {
    const keys = ['\uD800', '�', '\uD801']
    const server = await spawnServer({
      seedSave: async saveDir => { seedViewer(saveDir, keys.length, { keys }) },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)

    const result = await readViewer(await viewer(client))
    expect(result.entries.map(entry => entry.key)).toEqual(['\uD800', '\uD801', '�'])
    expect(result.entries.map(entry => JSON.parse(entry.text).index)).toEqual([0, 2, 1])
  })

  test('NUL-bearing filter tuples cannot collide in canonical page tokens', async () => {
    const server = await spawnServer({
      seedSave: async saveDir => { seedViewer(saveDir, 1) },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)

    // Delimiter framing makes these tuples identical: a\0b\0c. Canonical
    // JSON keeps the key/owner string boundaries distinct.
    const first = await readViewer(await viewer(client, '?key=a%00b&owner=c'))
    const second = await readViewer(await viewer(client, '?key=a&owner=b%00c'))
    expect(first.meta.total).toBe(0)
    expect(second.meta.total).toBe(0)
    expect(first.done.pageToken).not.toBe(second.done.pageToken)
  })

  test('owner and unknown-owner counts remain authoritative across the whole filtered snapshot', async () => {
    const unknownIndices = new Set(Array.from({ length: 10 }, (_, index) => index * 10))
    const emptyOwnerIndices = new Set([99])
    const server = await spawnServer({
      seedSave: async saveDir => {
        seedViewer(saveDir, 100, { unknownIndices, emptyOwnerIndices })
      },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)

    const unknown = await readViewer(await viewer(client, '?unknownOwner=1&pageSize=3&page=3'))
    expect(unknown.meta).toMatchObject({
      total: 11,
      pageCount: 4,
      page: 3,
      unknownOwnerCount: 11,
      ownerFacetTotal: 100,
    })
    expect(unknown.entries.map(entry => entry.key)).toEqual(['key-00090', 'key-00099'])
    expect(unknown.meta.ownerFacets.reduce(
      (sum: number, facet: { count: number }) => sum + facet.count,
      0,
    )).toBe(89)
    expect(unknown.entries.every(entry => entry.owner === null)).toBe(true)
  })

  test('viewer revisions reject stale same-key edits and deletes, then permit a fresh edit', async () => {
    const server = await spawnServer({ seedSave: async saveDir => { seedViewer(saveDir, 1) } })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const initial = await readViewer(await viewer(client))
    const entry = initial.entries[0]
    expect(entry.revision).toMatch(/^sha256:[0-9a-f]{64}$/)

    expect((await revisionBatch(client, initial.meta.manifestRevision, [{
      operation: 'set',
      key: entry.key,
      value: Buffer.from('{"phase":"concurrent"}').toString('base64'),
      owner: entry.owner,
    }])).status).toBe(200)
    const sqlite = new Database(path.join(server.cwd, 'save', 'risuai.db'), { readonly: true })
    const readPair = () => ({
      value: Buffer.from((sqlite.prepare('SELECT value FROM kv WHERE key = ?')
        .get(valueKey(entry.key)) as { value: Buffer }).value),
      owner: Buffer.from((sqlite.prepare('SELECT value FROM kv WHERE key = ?')
        .get(ownerKey(entry.key)) as { value: Buffer }).value),
    })
    const concurrentPair = readPair()

    const staleSet = await revisionBatch(client, initial.meta.manifestRevision, [{
      operation: 'set',
      key: entry.key,
      value: Buffer.from('{"phase":"stale-overwrite"}').toString('base64'),
      owner: entry.owner,
      expectedRevision: entry.revision,
    }])
    expect(staleSet.status).toBe(409)
    expect(await staleSet.json()).toMatchObject({
      code: 'PLUGIN_STORAGE_REVISION_CONFLICT',
      outcome: 'not-committed',
      retryable: false,
    })
    expect(readPair()).toEqual(concurrentPair)

    const staleDelete = await revisionBatch(client, initial.meta.manifestRevision, [{
      operation: 'remove',
      key: entry.key,
      expectedRevision: entry.revision,
    }])
    expect(staleDelete.status).toBe(409)
    expect(await staleDelete.json()).toMatchObject({
      code: 'PLUGIN_STORAGE_REVISION_CONFLICT',
      outcome: 'not-committed',
      retryable: false,
    })
    expect(readPair()).toEqual(concurrentPair)

    const fresh = await readViewer(await viewer(client))
    expect(fresh.entries[0].revision).not.toBe(entry.revision)
    const freshSet = await revisionBatch(client, fresh.meta.manifestRevision, [{
      operation: 'set',
      key: entry.key,
      value: Buffer.from('{"phase":"fresh-edit"}').toString('base64'),
      owner: fresh.entries[0].owner,
      expectedRevision: fresh.entries[0].revision,
    }])
    expect(freshSet.status).toBe(200)
    expect(await freshSet.json()).toMatchObject({
      success: true,
      outcome: 'committed',
      verification: 'verified',
    })
    expect(JSON.parse(readPair().value.toString())).toEqual({ phase: 'fresh-edit' })
    sqlite.close()
  })

  test('a same-membership body update cannot tear a pinned page and is not blocked by it', async () => {
    let seeded!: ReturnType<typeof seedViewer>
    let gateDir = ''
    const server = await spawnServer({
      seedSave: async saveDir => {
        seeded = seedViewer(saveDir, 10_000)
        gateDir = path.join(path.dirname(saveDir), 'viewer-gate')
        await mkdir(gateDir, { recursive: true })
        await writeFile(path.join(gateDir, 'hold'), '')
      },
      env: { POCKETRISU_TEST_PLUGIN_VIEWER_GATE_DIR: 'viewer-gate' },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)

    const pinnedResponse = await viewer(client)
    await waitForFile(path.join(gateDir, 'entered'))
    const mutation = mutate(client, seeded.keys.slice(0, 50), seeded.manifest)
    const mutationStatus = await Promise.race([
      mutation.then(response => response.status),
      new Promise<number>(resolve => setTimeout(() => resolve(-1), 2_000)),
    ])
    expect(mutationStatus, 'viewer snapshot must not hold the PM4 mutation queue').toBe(200)
    await writeFile(path.join(gateDir, 'release'), '')

    const pinned = await readViewer(pinnedResponse)
    const phases = pinned.entries.map(entry => JSON.parse(entry.text).phase)
    expect(new Set(phases)).toEqual(new Set(['old']))

    const next = await readViewer(await viewer(client))
    const nextPhases = next.entries.map(entry => JSON.parse(entry.text).phase)
    expect(new Set(nextPhases)).toEqual(new Set(['new']))
    expect(pinned.done.pageToken).not.toBe(next.done.pageToken)
  }, 30_000)

  test('a real backpressured response disconnect stops later row reads and releases the snapshot', async () => {
    let seeded!: ReturnType<typeof seedViewer>
    let gateDir = ''
    const server = await spawnServer({
      seedSave: async saveDir => {
        seeded = seedViewer(saveDir, 50, { bodyBytes: 2 * 1024 * 1024 })
        gateDir = path.join(path.dirname(saveDir), 'viewer-backpressure')
        await mkdir(gateDir, { recursive: true })
      },
      env: { POCKETRISU_TEST_PLUGIN_VIEWER_GATE_DIR: 'viewer-backpressure' },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)

    const opened = new Promise<{ request: http.ClientRequest; response: http.IncomingMessage }>(
      (resolve, reject) => {
        const request = http.request({
          host: '127.0.0.1',
          port: server.port,
          path: '/api/plugin-storage/viewer-page',
          headers: {
            'risu-auth': client.token,
            'x-plugin-storage-generation': GENERATION,
          },
        }, response => resolve({ request, response }))
        request.once('error', reject)
        request.end()
      },
    )
    const { request, response } = await opened
    response.on('error', () => undefined)
    request.removeAllListeners('error')
    request.on('error', () => undefined)
    response.pause()
    await waitForFile(path.join(gateDir, 'backpressure.json'), 10_000)
    request.destroy()
    response.destroy()

    await waitForFile(path.join(gateDir, 'result.json'), 10_000)
    const metrics = JSON.parse(await readFile(path.join(gateDir, 'result.json'), 'utf-8'))
    expect(metrics.aborted).toBe(true)
    // Assembly now completes and releases the snapshot before response
    // backpressure. Disconnecting stops writes, not authoritative reads.
    expect(metrics.valueReads).toBe(50)
    expect(metrics.ownerReads).toBeLessThanOrEqual(metrics.valueReads)

    const mutation = await mutate(client, seeded.keys.slice(0, 1), seeded.manifest, 'after-backpressure')
    expect(mutation.status).toBe(200)
  }, 30_000)

  test('aborting the actual fetch closes the snapshot before any gated row read', async () => {
    let seeded!: ReturnType<typeof seedViewer>
    let gateDir = ''
    const server = await spawnServer({
      seedSave: async saveDir => {
        seeded = seedViewer(saveDir, 50)
        gateDir = path.join(path.dirname(saveDir), 'viewer-abort-gate')
        await mkdir(gateDir, { recursive: true })
        await writeFile(path.join(gateDir, 'hold'), '')
      },
      env: { POCKETRISU_TEST_PLUGIN_VIEWER_GATE_DIR: 'viewer-abort-gate' },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const controller = new AbortController()

    const response = await client.fetch('/api/plugin-storage/viewer-page', {
      headers: { 'x-plugin-storage-generation': GENERATION },
      signal: controller.signal,
    })
    await waitForFile(path.join(gateDir, 'entered'))
    const reader = response.body!.getReader()
    await reader.read()
    controller.abort(new DOMException('superseded page', 'AbortError'))
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
    await waitForFile(path.join(gateDir, 'result.json'))
    const metrics = JSON.parse(await readFile(path.join(gateDir, 'result.json'), 'utf-8'))
    expect(metrics).toMatchObject({ aborted: true, valueReads: 50, ownerReads: 50 })

    const mutation = await mutate(client, seeded.keys.slice(0, 1), seeded.manifest, 'after-abort')
    expect(mutation.status).toBe(200)
  }, 30_000)

  test('disconnect while an import owns the barrier cancels before that import releases', async () => {
    let gateRoot = ''
    const server = await spawnServer({
      seedSave: async saveDir => {
        seedViewer(saveDir, 1)
        gateRoot = path.dirname(saveDir)
        await mkdir(path.join(gateRoot, 'import-gate'), { recursive: true })
        await mkdir(path.join(gateRoot, 'viewer-import-abort'), { recursive: true })
        await writeFile(path.join(gateRoot, 'import-gate', 'hold'), '')
      },
      env: {
        RISU_STREAM_INGEST_MIN_BYTES: '1',
        POCKETRISU_BACKUP_IMPORT_TEST_GATE_DIR: 'import-gate',
        POCKETRISU_TEST_BACKUP_IMPORT_FAILPOINT: 'after-database-ingestion',
        POCKETRISU_TEST_PLUGIN_VIEWER_GATE_DIR: 'viewer-import-abort',
      },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const backup = encodeBackup([{
      name: 'database.risudat',
      data: Buffer.from(encodeRisuSaveLegacy({ characters: [] })),
    }])
    expect((await client.fetch('/api/backup/import/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ size: backup.byteLength }),
    })).status).toBe(200)
    const importing = client.fetch('/api/backup/import', {
      method: 'POST',
      headers: { 'content-type': 'application/x-risu-backup' },
      body: backup,
    })
    await waitForFile(path.join(gateRoot, 'import-gate', 'entered'), 10_000)

    const controller = new AbortController()
    const pendingViewer = client.fetch('/api/plugin-storage/viewer-page', {
      headers: { 'x-plugin-storage-generation': GENERATION },
      signal: controller.signal,
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    controller.abort(new DOMException('viewer superseded during import', 'AbortError'))
    await expect(pendingViewer).rejects.toMatchObject({ name: 'AbortError' })

    // The server-side waiter must finish while the import still owns the
    // barrier. Waiting for import release would keep an abandoned request and
    // its closures alive for the entire streamed import.
    const resultPath = path.join(gateRoot, 'viewer-import-abort', 'result.json')
    await waitForFile(resultPath, 2_000)
    expect(JSON.parse(await readFile(resultPath, 'utf-8'))).toMatchObject({
      aborted: true,
      valueReads: 0,
      ownerReads: 0,
    })

    await writeFile(path.join(gateRoot, 'import-gate', 'release'), '')
    const importResponse = await importing
    await importResponse.text()
    expect(importResponse.ok).toBe(false)
  }, 30_000)

  test('caps pinned viewer snapshots and queues excess requests', async () => {
    let gateDir = ''
    const server = await spawnServer({
      seedSave: async saveDir => {
        seedViewer(saveDir, 20)
        gateDir = path.join(path.dirname(saveDir), 'viewer-snapshot-cap')
        await mkdir(gateDir, { recursive: true })
        await writeFile(path.join(gateDir, 'snapshot-hold'), '')
      },
      env: {
        POCKETRISU_TEST_PLUGIN_VIEWER_GATE_DIR: 'viewer-snapshot-cap',
        POCKETRISU_TEST_PLUGIN_VIEWER_SNAPSHOT_CAP: '2',
      },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)

    const pending = Array.from({ length: 8 }, (_, index) => (
      viewer(client, `?page=${index % 2}`)
    ))
    const held = await waitForJsonFile<{
      active: number
      queued: number
      maxActive: number
      cap: number
    }>(
      path.join(gateDir, 'snapshot-state.json'),
      state => state.active === 2 && state.queued >= 1,
      10_000,
    )
    expect(held).toMatchObject({ active: 2, cap: 2, maxActive: 2 })
    await writeFile(path.join(gateDir, 'snapshot-release'), '')
    const results = await Promise.all(pending.map(async response => readViewer(await response)))
    expect(results).toHaveLength(8)
    const released = await waitForJsonFile<{ active: number; maxActive: number }>(
      path.join(gateDir, 'snapshot-state.json'),
      state => state.active === 0,
      10_000,
    )
    expect(released.maxActive).toBe(2)
  }, 30_000)

  test('rejects stale generations and page sizes above the hard maximum', async () => {
    const server = await spawnServer({ seedSave: async saveDir => { seedViewer(saveDir, 1) } })
    servers.push(server)
    const client = await createClient(server.port, server.password)

    expect((await client.fetch('/api/plugin-storage/viewer-page?pageSize=51', {
      headers: { 'x-plugin-storage-generation': GENERATION },
    })).status).toBe(400)
    expect((await client.fetch('/api/plugin-storage/viewer-page', {
      headers: { 'x-plugin-storage-generation': 'stale-generation' },
    })).status).toBe(409)
  })
})
