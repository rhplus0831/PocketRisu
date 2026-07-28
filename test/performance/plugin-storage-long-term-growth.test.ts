import { createHash } from 'node:crypto'
import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { createClient, type RisuClient } from '../compat/helpers/client.js'
import { spawnServer } from '../compat/helpers/spawnServer.js'
import utilsPkg from '../../server/node/utils.cjs'
import {
  buildRealPluginStorageWorkload,
  REAL_PLUGIN_NAMES,
  REAL_PLUGIN_WORKLOAD_PERIODS,
  type PluginStorageOperation,
  type PluginStorageWorkload,
} from './helpers/plugin-storage-real-workloads.js'

const { decodeRisuSave, encodeRisuSaveLegacy } = utilsPkg as {
  decodeRisuSave: (value: Uint8Array) => Promise<Record<string, any>>
  encodeRisuSaveLegacy: (value: unknown) => Uint8Array
}

const DATABASE_KEY = 'database/database.bin'
const MANIFEST_KEY = 'plugin-storage/manifest.json'
const VALUE_PREFIX = 'pluginsave/'
const META_PREFIX = 'pluginsave-meta/'
const CHECKPOINT_PERIODS = new Set([10, 20, 30, REAL_PLUGIN_WORKLOAD_PERIODS])

interface DbStats {
  files: { db: number; wal: number; shm: number }
  sqlite: {
    pageSize: number
    pageCount: number
    freelistCount: number
    reclaimable: number
  }
  chunks: { count: number; bytes: number; orphanBytes: number; liveChunked: boolean }
  prefixes: Record<string, { totalSize: number; count: number }>
  kvRows: number
  kvTotalBytes: number
  backups: { kv: { count: number; totalSize: number } }
}

interface StorageMeasurement {
  period: number
  databaseLogicalBytes: number
  pluginValueBytes: number
  pluginMetaBytes: number
  manifestBytes: number
  pluginValueRows: number
  pluginMetaRows: number
  indexedPluginValueBytes: number
  indexedOwnerRows: number
  livePublicationBytes: number
  allocatedPageBytes: number
  reclaimablePageBytes: number
  dbFileBytes: number
  walFileBytes: number
  physicalFileBytes: number
  chunkBytes: number
  orphanChunkBytes: number
  snapshotCount: number
  snapshotLogicalBytes: number
  kvRows: number
}

interface ModeEvidence {
  mode: 'inline' | 'optimized'
  generation: string | null
  initial: StorageMeasurement
  checkpoints: StorageMeasurement[]
  final: StorageMeasurement
  compacted: StorageMeasurement
  requestBodyBytes: number
  valueDigest: string
  valueCount: number
  manifestValueCount: number
  manifestMetaCount: number
}

function storageKey(prefix: typeof VALUE_PREFIX | typeof META_PREFIX, rawKey: string): string {
  return `${prefix}${Buffer.from(rawKey, 'utf8').toString('base64url')}.json`
}

function rawKeyFromStorageKey(key: string): string {
  return Buffer.from(key.slice(VALUE_PREFIX.length, -'.json'.length), 'base64url')
    .toString('utf8')
}

function databasePathHex(): string {
  return Buffer.from(DATABASE_KEY, 'utf8').toString('hex')
}

function mapDigest(values: Map<string, unknown>): string {
  const hash = createHash('sha256')
  for (const [key, value] of [...values].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(String(Buffer.byteLength(key, 'utf8')))
    hash.update(':')
    hash.update(key)
    const body = JSON.stringify(value)
    hash.update(String(Buffer.byteLength(body, 'utf8')))
    hash.update(':')
    hash.update(body)
  }
  return hash.digest('hex')
}

function expectedJsonBytes(values: Map<string, unknown>): number {
  let total = 0
  for (const value of values.values()) total += Buffer.byteLength(JSON.stringify(value), 'utf8')
  return total
}

async function responseError(response: Response): Promise<string> {
  return `${response.status}: ${await response.text()}`
}

async function writeDatabase(
  client: RisuClient,
  database: Record<string, unknown>,
  cookie?: string,
): Promise<number> {
  const body = Buffer.from(encodeRisuSaveLegacy(database))
  const response = await client.fetch('/api/write', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': databasePathHex(),
      ...(cookie ? { cookie } : {}),
    },
    body: new Uint8Array(body),
  })
  if (!response.ok) throw new Error(`Database write failed: ${await responseError(response)}`)
  await response.arrayBuffer()
  return body.length
}

async function startWriterSession(client: RisuClient): Promise<string | undefined> {
  const response = await client.fetch('/api/session', { method: 'POST' })
  if (!response.ok) throw new Error(`Session setup failed: ${await responseError(response)}`)
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  await response.arrayBuffer()
  // Happy DOM applies Set-Cookie to its cookie jar but, like a browser, hides
  // that response header. Node environments expose it and can pass it through.
  return cookie
}

async function readDatabase(
  client: RisuClient,
  cookie?: string,
): Promise<Record<string, any>> {
  const response = await client.fetch('/api/read', {
    headers: {
      'file-path': databasePathHex(),
      ...(cookie ? { cookie } : {}),
    },
  })
  if (!response.ok) throw new Error(`Database read failed: ${await responseError(response)}`)
  return decodeRisuSave(new Uint8Array(await response.arrayBuffer()))
}

async function flushDatabase(client: RisuClient, cookie?: string): Promise<void> {
  const response = await client.fetch('/api/db/flush', {
    method: 'POST',
    headers: cookie ? { cookie } : {},
  })
  if (!response.ok) throw new Error(`Database flush failed: ${await responseError(response)}`)
  const result = await response.json() as { durable?: boolean }
  expect(result.durable).toBe(true)
}

async function waitForInitialSnapshot(cwd: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const sqlite = new Database(path.join(cwd, 'save', 'risuai.db'), { readonly: true })
    try {
      const row = sqlite.prepare(
        "SELECT COUNT(*) AS count FROM kv WHERE key LIKE 'database/dbbackup-%'",
      ).get() as { count: number }
      if (row.count >= 1) return
    } finally {
      sqlite.close()
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Initial recovery snapshot did not settle')
}

async function mutateOptimized(
  client: RisuClient,
  cookie: string | undefined,
  generation: string,
  operation: PluginStorageOperation,
): Promise<number> {
  const valueKey = storageKey(VALUE_PREFIX, operation.key)
  const body = operation.kind === 'set'
    ? Buffer.from(JSON.stringify(operation.value), 'utf8')
    : Buffer.alloc(0)
  const response = await client.fetch('/api/plugin-storage/mutate', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'file-path': Buffer.from(valueKey, 'utf8').toString('hex'),
      'x-plugin-storage-operation': operation.kind,
      'x-plugin-storage-generation': generation,
      'x-plugin-storage-owner': operation.kind === 'set'
        ? Buffer.from(operation.plugin, 'utf8').toString('base64url')
        : '',
      ...(cookie ? { cookie } : {}),
    },
    body: new Uint8Array(body),
  })
  if (!response.ok) {
    throw new Error(
      `Optimized ${operation.kind} failed for ${operation.plugin}/${operation.key}: `
      + await responseError(response),
    )
  }
  const acknowledgement = await response.json() as { outcome?: string }
  expect(acknowledgement.outcome).toBe('committed')
  return body.length
}

let statsReadSequence = 0

async function readStats(client: RisuClient): Promise<DbStats> {
  statsReadSequence += 1
  const response = await client.fetch(`/api/db/stats?growth-sample=${statsReadSequence}`)
  if (!response.ok) throw new Error(`Stats read failed: ${await responseError(response)}`)
  return response.json() as Promise<DbStats>
}

async function measureStorage(
  client: RisuClient,
  cwd: string,
  period: number,
): Promise<StorageMeasurement> {
  const stats = await readStats(client)
  const sqlite = new Database(path.join(cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    const aggregate = (prefix: string) => sqlite.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(value)), 0) AS bytes
      FROM kv WHERE key LIKE ?
    `).get(`${prefix}%`) as { count: number; bytes: number }
    const values = aggregate(VALUE_PREFIX)
    const meta = aggregate(META_PREFIX)
    const manifest = sqlite.prepare(
      'SELECT LENGTH(value) AS bytes FROM kv WHERE key = ?',
    ).get(MANIFEST_KEY) as { bytes: number } | undefined
    const usage = sqlite.prepare(
      'SELECT bytes FROM plugin_storage_usage WHERE id = 1',
    ).get() as { bytes: number }
    const owners = sqlite.prepare(
      'SELECT COUNT(*) AS count FROM plugin_storage_owners',
    ).get() as { count: number }
    const databaseLogicalBytes = stats.prefixes[DATABASE_KEY]?.totalSize ?? 0
    const manifestBytes = manifest?.bytes ?? 0
    return {
      period,
      databaseLogicalBytes,
      pluginValueBytes: values.bytes,
      pluginMetaBytes: meta.bytes,
      manifestBytes,
      pluginValueRows: values.count,
      pluginMetaRows: meta.count,
      indexedPluginValueBytes: usage.bytes,
      indexedOwnerRows: owners.count,
      livePublicationBytes: databaseLogicalBytes + values.bytes + meta.bytes + manifestBytes,
      allocatedPageBytes: stats.sqlite.pageCount * stats.sqlite.pageSize,
      reclaimablePageBytes: stats.sqlite.reclaimable,
      dbFileBytes: stats.files.db,
      walFileBytes: stats.files.wal,
      physicalFileBytes: stats.files.db + stats.files.wal + stats.files.shm,
      chunkBytes: stats.chunks.bytes,
      orphanChunkBytes: stats.chunks.orphanBytes,
      snapshotCount: stats.backups.kv.count,
      snapshotLogicalBytes: stats.backups.kv.totalSize,
      kvRows: stats.kvRows,
    }
  } finally {
    sqlite.close()
  }
}

function readOptimizedValues(cwd: string): Map<string, unknown> {
  const sqlite = new Database(path.join(cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    const rows = sqlite.prepare(
      "SELECT key, value FROM kv WHERE key LIKE 'pluginsave/%' ORDER BY key",
    ).all() as Array<{ key: string; value: Buffer }>
    return new Map(rows.map(row => [
      rawKeyFromStorageKey(row.key),
      JSON.parse(Buffer.from(row.value).toString('utf8')),
    ]))
  } finally {
    sqlite.close()
  }
}

async function readInlineValues(cwd: string): Promise<Map<string, unknown>> {
  const sqlite = new Database(path.join(cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    const row = sqlite.prepare('SELECT value FROM kv WHERE key = ?').get(DATABASE_KEY) as
      | { value: Buffer }
      | undefined
    if (!row) throw new Error('Inline database row is missing')
    const database = await decodeRisuSave(Buffer.from(row.value))
    return new Map(Object.entries(database.pluginCustomStorage ?? {}))
  } finally {
    sqlite.close()
  }
}

function readManifestCounts(cwd: string): { values: number; meta: number } {
  const sqlite = new Database(path.join(cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    const row = sqlite.prepare('SELECT value FROM kv WHERE key = ?').get(MANIFEST_KEY) as
      | { value: Buffer }
      | undefined
    if (!row) return { values: 0, meta: 0 }
    const manifest = JSON.parse(Buffer.from(row.value).toString('utf8')) as {
      valueKeys: string[]
      metaKeys: string[]
    }
    return { values: manifest.valueKeys.length, meta: manifest.metaKeys.length }
  } finally {
    sqlite.close()
  }
}

async function optimizeDatabase(client: RisuClient, cookie?: string): Promise<void> {
  const response = await client.fetch('/api/db/optimize', {
    method: 'POST',
    headers: cookie ? { cookie } : {},
  })
  if (!response.ok) throw new Error(`Database optimize failed: ${await responseError(response)}`)
  await response.arrayBuffer()
}

async function runWorkload(
  mode: ModeEvidence['mode'],
  workload: PluginStorageWorkload,
): Promise<ModeEvidence> {
  const server = await spawnServer({
    env: {
      // Hold the recovery snapshot population constant. This suite compares
      // live plugin publications; snapshot rotation has its own compat suites.
      POCKETRISU_BACKUP_INTERVAL_MS: '3600000',
    },
  })
  try {
    ;(window as Window & { happyDOM?: { setURL: (url: string) => void } })
      .happyDOM?.setURL(`http://127.0.0.1:${server.port}`)
    const client = await createClient(server.port, server.password)
    const bootstrapKey = '__plugin-growth-bootstrap__'
    const database: Record<string, any> = {
      characters: [],
      personas: [],
      plugins: [],
      optimizePluginMemory: mode === 'optimized',
      pluginCustomStorage: mode === 'optimized'
        ? { [bootstrapKey]: { initialized: true } }
        : {},
      ...(mode === 'optimized'
        ? {
            pluginStorageFolded: true,
            pluginStorageGeneration: 'plugin-growth-generation',
            pluginStorageMeta: {
              [bootstrapKey]: { plugin: 'Storage Growth Harness', updatedAt: 1 },
            },
          }
        : {}),
    }
    await writeDatabase(client, database)
    const cookie = await startWriterSession(client)
    const persistedDatabase = await readDatabase(client, cookie)
    const generation = typeof persistedDatabase.pluginStorageGeneration === 'string'
      ? persistedDatabase.pluginStorageGeneration
      : null
    if (mode === 'optimized') {
      expect(generation).toBe('plugin-growth-generation')
      await mutateOptimized(client, cookie, generation!, {
        kind: 'remove',
        plugin: 'Flashback Memory',
        key: bootstrapKey,
      })
    }
    await waitForInitialSnapshot(server.cwd)
    await flushDatabase(client, cookie)
    const initial = await measureStorage(client, server.cwd, 0)
    const checkpoints: StorageMeasurement[] = []
    const inlineValues = new Map<string, unknown>()
    const inlineMeta = new Map<string, Record<string, unknown>>()
    let requestBodyBytes = 0

    for (const period of workload.periods) {
      if (mode === 'optimized') {
        for (const operation of period.operations) {
          requestBodyBytes += await mutateOptimized(
            client,
            cookie,
            generation!,
            operation,
          )
        }
      } else {
        for (const operation of period.operations) {
          if (operation.kind === 'set') {
            inlineValues.set(operation.key, structuredClone(operation.value))
            inlineMeta.set(operation.key, {
              plugin: operation.plugin,
              updatedAt: period.period,
              revision: `revision-${period.period}-${operation.key}`,
              generation: `value-${period.period}-${operation.key}`,
            })
          } else {
            inlineValues.delete(operation.key)
            inlineMeta.delete(operation.key)
          }
        }
        database.pluginCustomStorage = Object.fromEntries(inlineValues)
        database.pluginStorageMeta = Object.fromEntries(inlineMeta)
        requestBodyBytes += await writeDatabase(client, database, cookie)
      }

      if (CHECKPOINT_PERIODS.has(period.period)) {
        await flushDatabase(client, cookie)
        checkpoints.push(await measureStorage(client, server.cwd, period.period))
      }
    }

    const final = checkpoints.at(-1)!
    const actualValues = mode === 'optimized'
      ? readOptimizedValues(server.cwd)
      : await readInlineValues(server.cwd)
    const manifestCounts = readManifestCounts(server.cwd)
    expect([...actualValues.keys()].sort()).toEqual([...workload.finalValues.keys()].sort())
    expect(mapDigest(actualValues)).toBe(mapDigest(workload.finalValues))

    await optimizeDatabase(client, cookie)
    const compacted = await measureStorage(client, server.cwd, REAL_PLUGIN_WORKLOAD_PERIODS)

    return {
      mode,
      generation,
      initial,
      checkpoints,
      final,
      compacted,
      requestBodyBytes,
      valueDigest: mapDigest(actualValues),
      valueCount: actualValues.size,
      manifestValueCount: manifestCounts.values,
      manifestMetaCount: manifestCounts.meta,
    }
  } finally {
    await server.cleanup()
  }
}

const skipDuplicateCacheRun = process.env.POCKETRISU_PERF_RESOURCE_CACHE === 'on'

describe.skipIf(skipDuplicateCacheRun)(
  'long-term real-plugin storage growth (real SQLite server)',
  () => {
    test('preserves each analyzed plugin\'s distinguishing persistence shape', () => {
      const workload = buildRealPluginStorageWorkload()
      const operations = workload.periods.flatMap(period => period.operations)
      const keysFor = (plugin: typeof REAL_PLUGIN_NAMES[number]) => operations
        .filter(operation => operation.plugin === plugin)
        .map(operation => operation.key)

      const flashbackKeys = keysFor('Flashback Memory')
      expect(flashbackKeys.some(key => key.includes(':records:commit:'))).toBe(true)
      expect(flashbackKeys).toContain('vector_rag_memory:scope_registry:v2')
      expect(workload.summaryByPlugin['Flashback Memory'].removes).toBeGreaterThan(0)

      const wygLoreKeys = new Set(keysFor('WygLore Leaf'))
      expect([...wygLoreKeys].filter(key => key.includes(':units:b')).length)
        .toBeGreaterThanOrEqual(32 * 4)
      expect([...wygLoreKeys].some(key => key.endsWith(':embeddings'))).toBe(true)

      const provider110Keys = new Set(keysFor('Provider Manager 1.10.0'))
      expect([
        'pm_store',
        'pm_thinking_history_records',
        'pm_request_logs',
        'pm_batch_jobs',
        'pm_gemini_explicit_caches',
      ].every(key => provider110Keys.has(key))).toBe(true)

      const provider135Keys = keysFor('Cupcake Provider Manager 1.35.11')
      expect(provider135Keys).toContain('cpm_perf_manifest')
      expect(provider135Keys.some(key => key.startsWith('cpm_perf_chunk_'))).toBe(true)
      expect(provider135Keys).toContain('cpm_aux_routing_logs')

      const risuAgentKeys = keysFor('Risu Agents')
      expect(risuAgentKeys.some(key => key.includes(':snapshot:'))).toBe(true)
      expect(risuAgentKeys.some(key => key.startsWith('risu_agents_run_body_v1:'))).toBe(true)
      expect(workload.summaryByPlugin['Risu Agents'].removes).toBe(0)

      const yumiKeys = keysFor('Yumi Translator')
      expect(yumiKeys).toContain('yumi_tr_prompt_presets')
      expect(yumiKeys).toContain('yumi_tr_character_overrides')
      expect(yumiKeys).toContain('yumi_tr_update_dismissed_version')
      expect(workload.finalValues.has('yumi_tr_update_dismissed_version')).toBe(false)
    })

    test('replays all six plugin persistence shapes with optimization off and on', async () => {
      const workload = buildRealPluginStorageWorkload()
      for (const plugin of REAL_PLUGIN_NAMES) {
        expect(workload.summaryByPlugin[plugin].sets).toBeGreaterThan(0)
        expect(workload.summaryByPlugin[plugin].distinctKeys).toBeGreaterThan(1)
      }
      expect(workload.summaryByPlugin['Flashback Memory'].removes).toBeGreaterThan(0)
      expect(workload.summaryByPlugin['Provider Manager 1.10.0'].removes).toBeGreaterThan(0)
      expect(workload.summaryByPlugin['Cupcake Provider Manager 1.35.11'].removes)
        .toBeGreaterThan(0)
      expect(workload.summaryByPlugin['Risu Agents'].distinctKeys).toBeGreaterThan(50)

      const inline = await runWorkload('inline', workload)
      const optimized = await runWorkload('optimized', workload)
      const expectedBytes = expectedJsonBytes(workload.finalValues)
      const inlineDatabaseGrowth = inline.final.databaseLogicalBytes
        - inline.initial.databaseLogicalBytes
      const optimizedDatabaseGrowth = optimized.final.databaseLogicalBytes
        - optimized.initial.databaseLogicalBytes

      expect(inline.valueDigest).toBe(optimized.valueDigest)
      expect(inline.valueCount).toBe(workload.finalValues.size)
      expect(optimized.valueCount).toBe(workload.finalValues.size)
      expect(inline.final.pluginValueRows).toBe(0)
      expect(inline.final.pluginMetaRows).toBe(0)
      expect(inline.manifestValueCount).toBe(0)
      expect(inline.manifestMetaCount).toBe(0)
      expect(optimized.final.pluginValueRows).toBe(workload.finalValues.size)
      expect(optimized.final.pluginMetaRows).toBe(workload.finalValues.size)
      expect(optimized.manifestValueCount).toBe(workload.finalValues.size)
      expect(optimized.manifestMetaCount).toBe(workload.finalValues.size)
      expect(optimized.final.pluginValueBytes).toBe(expectedBytes)
      expect(optimized.final.indexedPluginValueBytes).toBe(expectedBytes)
      expect(optimized.final.indexedOwnerRows).toBe(workload.finalValues.size)

      // This is the optimization's central storage contract: plugin growth is
      // removed from the monolithic database row and remains in exact live rows.
      expect(inlineDatabaseGrowth).toBeGreaterThan(expectedBytes / 2)
      expect(optimizedDatabaseGrowth).toBeLessThanOrEqual(64)
      expect(optimizedDatabaseGrowth).toBeLessThan(inlineDatabaseGrowth * 0.01)
      expect(new Set(optimized.checkpoints.map(point => point.databaseLogicalBytes)).size)
        .toBe(1)
      expect(inline.checkpoints.every(point => point.snapshotCount === inline.initial.snapshotCount))
        .toBe(true)
      expect(optimized.checkpoints.every(
        point => point.snapshotCount === optimized.initial.snapshotCount,
      )).toBe(true)
      expect(optimized.final.livePublicationBytes).toBeGreaterThanOrEqual(expectedBytes)
      expect(optimized.final.livePublicationBytes)
        .toBeLessThan(inline.final.livePublicationBytes * 1.1)
      expect(optimized.requestBodyBytes).toBeLessThan(inline.requestBodyBytes * 0.75)
      expect(optimized.final.physicalFileBytes)
        .toBeLessThan(inline.final.physicalFileBytes * 1.1)

      // VACUUM/checkpoint evidence must describe the live publication rather
      // than stale WAL allocation, and optimization must not leak logical rows.
      expect(inline.compacted.walFileBytes).toBe(0)
      expect(optimized.compacted.walFileBytes).toBe(0)
      expect(inline.compacted.reclaimablePageBytes).toBe(0)
      expect(optimized.compacted.reclaimablePageBytes).toBe(0)
      expect(optimized.compacted.pluginValueRows).toBe(workload.finalValues.size)
      expect(optimized.compacted.pluginValueBytes).toBe(expectedBytes)
      expect(optimized.compacted.physicalFileBytes)
        .toBeLessThan(inline.compacted.physicalFileBytes * 1.4)

      console.info('[Plugin storage long-term growth evidence]', JSON.stringify({
        periods: REAL_PLUGIN_WORKLOAD_PERIODS,
        finalKeys: workload.finalValues.size,
        expectedPluginJsonBytes: expectedBytes,
        workloadSummary: workload.summaryByPlugin,
        comparison: {
          inlineDatabaseGrowth,
          optimizedDatabaseGrowth,
          inlineFinalLivePublicationBytes: inline.final.livePublicationBytes,
          optimizedFinalLivePublicationBytes: optimized.final.livePublicationBytes,
          inlineFinalPhysicalFileBytes: inline.final.physicalFileBytes,
          optimizedFinalPhysicalFileBytes: optimized.final.physicalFileBytes,
          inlineCompactedFileBytes: inline.compacted.physicalFileBytes,
          optimizedCompactedFileBytes: optimized.compacted.physicalFileBytes,
          inlineRequestBodyBytes: inline.requestBodyBytes,
          optimizedRequestBodyBytes: optimized.requestBodyBytes,
        },
        checkpoints: {
          inline: inline.checkpoints,
          optimized: optimized.checkpoints,
        },
      }))
    }, 600_000)
  },
)
