import { createHash, webcrypto } from 'node:crypto'
import path from 'node:path'
import Database from 'better-sqlite3'
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { createClient } from '../compat/helpers/client.js'
import { createSeedBackup } from '../compat/helpers/seed.js'
import { spawnServer, type ServerHandle } from '../compat/helpers/spawnServer.js'

// The harness exercises storage, not toast rendering. Avoid loading Sonner's
// compiled Svelte icon components in Vitest SSR while retaining alert.ts's real
// control flow and error normalization.
vi.mock('svelte-sonner', () => ({
  toast: {
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}))

// stores.svelte starts a UI-only module projection effect at import time. Its
// production implementation participates in a broad browser bootstrap cycle
// that is unrelated to storage and can hit an SSR temporal-dead-zone. Keep the
// projection empty so the real database/storage modules initialize normally.
vi.mock('../../src/ts/process/modules', () => ({
  moduleUpdate: vi.fn(),
  getModules: () => [],
  getModuleAssets: () => [],
  getModuleLorebooks: () => [],
  getModuleTriggers: () => [],
  getModuleRegexScripts: () => [],
  getModuleToggles: () => [],
  getModuleMcps: () => [],
  exportModuleLegacy: vi.fn(),
  readModule: vi.fn(),
}))

const MIB = 1024 * 1024
const ROW_BYTES = 7 * MIB
const ROW_COUNT = 8
const TOTAL_BYTES = ROW_BYTES * ROW_COUNT
const CHUNK_MARKER = Buffer.from('\x00RISUCHUNKED\x00', 'binary')
const VALUE_PREFIX = 'pluginsave/'
const MANIFEST_KEY = 'plugin-storage/manifest.json'
const MEMORY_SAMPLE_INTERVAL_MS = 10

interface MemoryPoint {
  heapUsed: number
  arrayBuffers: number
  external: number
  rss: number
}

interface MemoryPeak extends MemoryPoint {
  samples: number
}

interface RequestRecord {
  path: string
  headers: Headers
  status: number | null
}

interface ProgressRecord {
  completed: number
  completedBytes: number
  liveKeys: string[]
  optimized: boolean
  memory: MemoryPoint
}

const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

function encodedStorageKey(rawKey: string): string {
  const component = Buffer.from(rawKey, 'utf8').toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
  return `${VALUE_PREFIX}${component}.json`
}

function hexStorageKey(rawKey: string): string {
  return [...new TextEncoder().encode(rawKey)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

function memoryPoint(): MemoryPoint {
  const usage = process.memoryUsage()
  return {
    heapUsed: usage.heapUsed,
    arrayBuffers: usage.arrayBuffers,
    external: usage.external,
    rss: usage.rss,
  }
}

function emptyPeak(point = memoryPoint()): MemoryPeak {
  return { ...point, samples: 1 }
}

function addPeak(peak: MemoryPeak, point = memoryPoint()): void {
  peak.heapUsed = Math.max(peak.heapUsed, point.heapUsed)
  peak.arrayBuffers = Math.max(peak.arrayBuffers, point.arrayBuffers)
  peak.external = Math.max(peak.external, point.external)
  peak.rss = Math.max(peak.rss, point.rss)
  peak.samples += 1
}

function startMemorySampler(): { peak: MemoryPeak; stop: () => void } {
  const peak = emptyPeak()
  const timer = setInterval(() => addPeak(peak), MEMORY_SAMPLE_INTERVAL_MS)
  timer.unref?.()
  return {
    peak,
    stop: () => clearInterval(timer),
  }
}

function forceGcNow(): MemoryPoint {
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc
  if (typeof gc !== 'function') {
    throw new Error(
      'PM2 memory verification requires Node --expose-gc (Vitest worker execArgv included).',
    )
  }
  gc()
  gc()
  return memoryPoint()
}

async function settleGc(): Promise<MemoryPoint> {
  await new Promise<void>(resolve => setImmediate(resolve))
  forceGcNow()
  await new Promise<void>(resolve => setImmediate(resolve))
  return forceGcNow()
}

function delta(peak: number, baseline: number): number {
  return Math.max(0, peak - baseline)
}

function makeExactUnicodeValue(index: number): { row: string; payload: string } {
  const row = `unicode-row-${index.toString().padStart(2, '0')}`
  const tokens = ['한😀', '界🦊', '별🚀', '雪🐉', '달🎭', '海🧭', '숲🦉', '光🪐']
  const token = tokens[index % tokens.length]
  const encoder = new TextEncoder()
  const fixedBytes = encoder.encode(JSON.stringify({ row, payload: '' })).byteLength
  const available = ROW_BYTES - fixedBytes
  const tokenBytes = encoder.encode(token).byteLength
  const repeats = Math.floor(available / tokenBytes)
  const remainder = available - repeats * tokenBytes
  const value = {
    row,
    payload: token.repeat(repeats) + 'x'.repeat(remainder),
  }
  expect(encoder.encode(JSON.stringify(value)).byteLength).toBe(ROW_BYTES)
  return value
}

function valueDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

async function waitForCommittedSave(
  requestImmediateSave: (options: { forceFullWrite: true }) => Promise<{
    status: string
    error?: unknown
  }>,
): Promise<void> {
  const deadline = Date.now() + 30_000
  let lastOutcome: { status: string; error?: unknown } | null = null
  while (Date.now() < deadline) {
    lastOutcome = await requestImmediateSave({ forceFullWrite: true })
    if (lastOutcome.status === 'committed') return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Database save loop did not become ready: ${String(lastOutcome?.error)}`)
}

async function waitForCachedBytes(
  getStats: () => Promise<{ totalBytes: number }>,
  minimum: number,
): Promise<void> {
  const deadline = Date.now() + 20_000
  let lastBytes = 0
  while (Date.now() < deadline) {
    lastBytes = (await getStats()).totalBytes
    if (lastBytes >= minimum) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Resource-cache seed did not settle (expected ${minimum}, found ${lastBytes}).`)
}

function inspectExternalChunkLayout(server: ServerHandle, storageKeys: readonly string[]): void {
  const sqlite = new Database(path.join(server.cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    const selectValue = sqlite.prepare('SELECT value FROM kv WHERE key = ?')
    const countChunks = sqlite.prepare(
      'SELECT COUNT(*) AS count FROM manifest_chunks WHERE manifest_key = ?',
    )
    for (const storageKey of storageKeys) {
      const row = selectValue.get(storageKey) as { value: Buffer } | undefined
      expect(row).toBeDefined()
      expect([...row!.value]).toEqual([...CHUNK_MARKER])
      const chunkCount = countChunks.get(storageKey) as { count: number }
      expect(chunkCount.count).toBeGreaterThan(1)
    }
    const usage = sqlite.prepare(
      'SELECT bytes FROM plugin_storage_usage WHERE id = 1',
    ).get() as { bytes: number }
    expect(usage.bytes).toBe(TOTAL_BYTES)
  } finally {
    sqlite.close()
  }
}

function inspectInternalLayout(server: ServerHandle): void {
  const sqlite = new Database(path.join(server.cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    const externalRows = sqlite.prepare(
      "SELECT COUNT(*) AS count FROM kv WHERE key LIKE 'pluginsave/%' OR key LIKE 'pluginsave-meta/%'",
    ).get() as { count: number }
    expect(externalRows.count).toBe(0)
    expect(sqlite.prepare('SELECT 1 FROM kv WHERE key = ?').get(MANIFEST_KEY)).toBeUndefined()
  } finally {
    sqlite.close()
  }
}

function inspectDisabledSourceLayout(server: ServerHandle): void {
  const sqlite = new Database(path.join(server.cwd, 'save', 'risuai.db'), { readonly: true })
  try {
    expect(sqlite.prepare('SELECT 1 FROM kv WHERE key = ?').get(MANIFEST_KEY)).toBeUndefined()
    const externalRows = sqlite.prepare(
      "SELECT COUNT(*) AS count FROM kv WHERE key LIKE 'pluginsave/%' OR key LIKE 'pluginsave-meta/%'",
    ).get() as { count: number }
    expect(externalRows.count).toBe(0)
  } finally {
    sqlite.close()
  }
}

function assertBoundedMemory(
  cycle: string,
  direction: 'externalize' | 'internalize',
  baseline: MemoryPoint,
  peak: MemoryPeak,
  final: MemoryPoint,
): void {
  // Heap/RSS include Svelte, Vite and SQLite/native state, so their relative
  // ceilings intentionally leave more headroom. Happy DOM can defer reclaiming
  // completed Fetch request bodies under host contention; the sampler permits
  // at most two bounded-store generations for that adapter artifact, while the
  // forced-GC per-row checkpoints below enforce the production one-row shape.
  const retainedHeap = direction === 'internalize'
    ? Math.max(baseline.heapUsed, final.heapUsed)
    : baseline.heapUsed
  console.info('[PM2 transition memory]', JSON.stringify({
    cycle,
    direction,
    baseline,
    peak,
    final,
    deltas: {
      heapUsed: delta(peak.heapUsed, retainedHeap),
      arrayBuffers: delta(peak.arrayBuffers, baseline.arrayBuffers),
      external: delta(peak.external, baseline.external),
      rss: delta(peak.rss, baseline.rss),
    },
  }))
  const sampledArrayBufferLimit = direction === 'externalize'
    ? 2 * TOTAL_BYTES + 3 * ROW_BYTES + 24 * MIB
    : 5 * ROW_BYTES + 24 * MIB
  expect(delta(peak.arrayBuffers, baseline.arrayBuffers))
    .toBeLessThanOrEqual(sampledArrayBufferLimit)
  expect(delta(final.arrayBuffers, baseline.arrayBuffers)).toBeLessThanOrEqual(
    3 * ROW_BYTES + 8 * MIB,
  )
  expect(delta(peak.heapUsed, retainedHeap)).toBeLessThanOrEqual(
    5 * ROW_BYTES + 48 * MIB,
  )
  expect(delta(peak.rss, baseline.rss)).toBeLessThanOrEqual(
    TOTAL_BYTES + 10 * ROW_BYTES + 128 * MIB,
  )
}

function assertPerRowMemoryShape(
  direction: 'externalize' | 'internalize',
  baseline: MemoryPoint,
  progress: readonly ProgressRecord[],
): void {
  const checkpointArrayBufferDelta = Math.max(
    0,
    ...progress.map(entry => delta(entry.memory.arrayBuffers, baseline.arrayBuffers)),
  )
  expect(checkpointArrayBufferDelta).toBeLessThanOrEqual(3 * ROW_BYTES + 8 * MIB)
  if (direction === 'externalize') {
    // Seven source rows remain after the first acknowledgement. At least four
    // rows' worth of heap must become collectible before the eighth finishes.
    expect(progress[0].memory.heapUsed - progress.at(-1)!.memory.heapUsed)
      .toBeGreaterThanOrEqual(4 * ROW_BYTES)
  }
}

describe('PM2 production plugin-storage transition memory (real client and server)', () => {
  test('bounds an isolated 56 MiB Unicode transition cycle with PM1 chunks', async () => {
    expect(typeof (globalThis as typeof globalThis & { gc?: () => void }).gc).toBe('function')
    const cacheMode = process.env.POCKETRISU_PERF_RESOURCE_CACHE
    expect(['off', 'on']).toContain(cacheMode)
    const cacheEnabled = cacheMode === 'on'

    const server = await spawnServer({
      env: {
        // Keep the layout assertion independent of the production default while
        // exercising the same PM1 file-to-CDC implementation.
        POCKETRISU_CHUNK_THRESHOLD: String(MIB),
      },
    })
    servers.push(server)
    const baseUrl = `http://127.0.0.1:${server.port}`
    ;(window as Window & { happyDOM?: { setURL: (url: string) => void } })
      .happyDOM?.setURL(baseUrl)
    const rawClient = await createClient(server.port, server.password)
    expect((await rawClient.importBackup(createSeedBackup())).ok).toBe(true)

    const requestLog: RequestRecord[] = []
    const nativeFetch = globalThis.fetch.bind(globalThis)
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const resolved = raw.startsWith('/') ? `${baseUrl}${raw}` : input
      const url = new URL(typeof resolved === 'string' ? resolved : resolved.toString(), baseUrl)
      const record: RequestRecord = {
        path: url.pathname,
        headers: new Headers(init?.headers),
        status: null,
      }
      requestLog.push(record)
      // Happy DOM caches GETs by URL, while NodeStorage addresses distinct rows
      // through the file-path header on the shared /api/read endpoint. Its cache
      // implementation explicitly bypasses get/add for this request directive.
      const uncachedHeaders = new Headers(init?.headers)
      uncachedHeaders.set('cache-control', 'no-cache')
      const response = await nativeFetch(resolved, {
        ...init,
        headers: uncachedHeaders,
      })
      record.status = response.status
      return response
    })
    // Happy DOM exposes Crypto but omits SubtleCrypto. The production cache
    // capability gate requires SHA-256, which Node's standards-compatible Web
    // Crypto implementation supplies for this browser-side harness.
    vi.stubGlobal('crypto', webcrypto as unknown as Crypto)
    // Happy DOM deliberately omits IndexedDB. Use its standards-compatible
    // in-memory test implementation so production cache transactions, byte
    // retention, validators, and verified 204 selection all execute unchanged.
    vi.stubGlobal('indexedDB', indexedDB)
    vi.stubGlobal('IDBKeyRange', IDBKeyRange)

    try {
      // Import sequentially: these production modules intentionally have
      // browser bootstrap cycles, and concurrent SSR imports can run a Svelte
      // effect before the shared database binding finishes initialization.
      const { NodeStorage } = await import('../../src/ts/storage/nodeStorage')
      const { forageStorage, requestImmediateSave, saveDb } =
        await import('../../src/ts/globalApi.svelte')
      const { decodeRisuSave } = await import('../../src/ts/storage/risuSave')
      const { getDatabase, setDatabase } = await import('../../src/ts/storage/database.svelte')
      const {
        getPluginSaveStorageItem,
        transitionPluginStorageMode,
      } = await import('../../src/ts/plugins/pluginSaveStorage')
      const {
        getResourceCacheStats,
        isResourceCacheEnabled,
        isResourceCacheSupported,
        setResourceCacheEnabled,
      } = await import('../../src/ts/storage/resourceCache')
      const { readPersistentJson } = await import('../../src/ts/storage/persistentKv')

      const cacheCapabilityEvidence = {
        subtle: Boolean(globalThis.crypto?.subtle),
        indexedDB: typeof globalThis.indexedDB,
        localStorage: typeof globalThis.localStorage,
        windowCryptoMatches: globalThis.crypto === window.crypto,
      }
      expect(
        isResourceCacheSupported(),
        `Resource-cache harness capability mismatch: ${JSON.stringify(cacheCapabilityEvidence)}`,
      ).toBe(true)

      ;(NodeStorage as any).sessionInitialized = false
      ;(NodeStorage as any).sessionPending = null
      const storage = new NodeStorage()
      storage.authChecked = true
      ;(storage as any).cachedJwt = {
        token: rawClient.token,
        expiresAt: Date.now() + 5 * 60_000,
      }
      forageStorage.realStorage = storage

      const initialBytes = await forageStorage.getItem('database/database.bin')
      setDatabase(await decodeRisuSave(initialBytes))

      let saveLoopFailure: unknown = null
      void saveDb().catch(error => {
        saveLoopFailure = error
      })
      await waitForCommittedSave(requestImmediateSave)
      expect(saveLoopFailure).toBeNull()

      const db = getDatabase()
      db.optimizePluginMemory = false
      db.pluginCustomStorage = {}
      delete db.pluginStorageMeta
      const expectedDigests = new Map<string, string>()
      const rawKeys: string[] = []
      for (let index = 0; index < ROW_COUNT; index += 1) {
        const value = makeExactUnicodeValue(index)
        rawKeys.push(value.row)
        expectedDigests.set(value.row, valueDigest(value))
        db.pluginCustomStorage[value.row] = value
      }
      rawKeys.sort((left, right) => left.localeCompare(right))
      const storageKeys = rawKeys.map(encodedStorageKey)

      // Let the real reactive tracker mark the large plugin-storage block, then
      // establish the exact durable source and encoder baseline before measuring.
      await new Promise(resolve => setTimeout(resolve, 0))
      await waitForCommittedSave(requestImmediateSave)
      inspectDisabledSourceLayout(server)
      const manifestReadStart = requestLog.length
      const manifestBytes = await forageStorage.getItem(MANIFEST_KEY)
      const manifestReads = requestLog.slice(manifestReadStart).filter(entry => entry.path === '/api/read')
      expect(manifestReads).toHaveLength(1)
      expect(manifestReads[0].headers.get('file-path')).toBe(hexStorageKey(MANIFEST_KEY))
      expect(manifestBytes).toBeNull()
      expect(await readPersistentJson(MANIFEST_KEY)).toBeNull()
      await settleGc()

      const memoryEvidence: Record<string, unknown> = {}

      await setResourceCacheEnabled(cacheEnabled)
      expect(isResourceCacheEnabled()).toBe(cacheEnabled)
      if (cacheEnabled) expect(isResourceCacheSupported()).toBe(true)

        const cycleLabel = cacheEnabled ? 'cache-on' : 'cache-off'
        const externalProgress: ProgressRecord[] = []
        let externalStageBaseline: MemoryPoint | null = null
        const externalWholeBaseline = await settleGc()
        const externalSampler = startMemorySampler()
        const externalStartLog = requestLog.length
        const externalResult = await transitionPluginStorageMode(true, {
          onStart: () => {
            externalStageBaseline = forceGcNow()
          },
          onProgress: progress => {
            const liveKeys = Object.keys(getDatabase().pluginCustomStorage).sort()
            externalProgress.push({
              completed: progress.completed,
              completedBytes: progress.completedBytes ?? -1,
              liveKeys,
              optimized: getDatabase().optimizePluginMemory === true,
              memory: forceGcNow(),
            })
          },
        })
        externalSampler.stop()
        const externalFinal = await settleGc()

        expect(externalResult).toEqual({
          direction: 'externalize',
          values: ROW_COUNT,
          meta: 0,
        })
        expect(externalProgress).toHaveLength(ROW_COUNT)
        externalProgress.forEach((progress, index) => {
          expect(progress.completed).toBe(index + 1)
          expect(progress.completedBytes).toBe((index + 1) * ROW_BYTES)
          expect(progress.liveKeys).toEqual(rawKeys.slice(index + 1))
          expect(progress.optimized).toBe(false)
        })
        expect(getDatabase().optimizePluginMemory).toBe(true)
        expect(Object.keys(getDatabase().pluginCustomStorage)).toEqual([])
        expect(externalStageBaseline).not.toBeNull()
        assertBoundedMemory(
          cycleLabel,
          'externalize',
          externalStageBaseline!,
          externalSampler.peak,
          externalFinal,
        )
        assertPerRowMemoryShape('externalize', externalStageBaseline!, externalProgress)

        const externalRequests = requestLog.slice(externalStartLog)
        expect(externalRequests.filter(entry => (
          entry.path === '/api/plugin-storage/transition/stage/upload'
        ))).toHaveLength(ROW_COUNT)
        expect(externalRequests.some(entry => (
          entry.path === '/api/plugin-storage/transition'
        ))).toBe(false)
        inspectExternalChunkLayout(server, storageKeys)

        const cacheProbeStart = requestLog.length
        let probe = await getPluginSaveStorageItem(rawKeys[0])
        expect(valueDigest(probe)).toBe(expectedDigests.get(rawKeys[0]))
        probe = null
        if (cacheEnabled) {
          await waitForCachedBytes(getResourceCacheStats, ROW_BYTES)
        }
        await settleGc()
        probe = await getPluginSaveStorageItem(rawKeys[0])
        expect(valueDigest(probe)).toBe(expectedDigests.get(rawKeys[0]))
        probe = null
        const cacheProbeReads = requestLog.slice(cacheProbeStart).filter(entry => (
          entry.path === '/api/read'
          && Buffer.from(entry.headers.get('file-path') ?? '', 'hex').toString('utf8')
            .startsWith(VALUE_PREFIX)
        ))
        if (cacheEnabled) {
          expect(cacheProbeReads.some(entry => entry.headers.has('x-cached-hashes'))).toBe(true)
          expect(cacheProbeReads.some(entry => entry.status === 204)).toBe(true)
        } else {
          expect(cacheProbeReads.every(entry => !entry.headers.has('x-cached-hashes'))).toBe(true)
        }

        const internalProgress: ProgressRecord[] = []
        let internalStageBaseline: MemoryPoint | null = null
        const internalWholeBaseline = await settleGc()
        const internalSampler = startMemorySampler()
        const internalStartLog = requestLog.length
        const internalResult = await transitionPluginStorageMode(false, {
          onStart: () => {
            internalStageBaseline = forceGcNow()
          },
          onProgress: progress => {
            internalProgress.push({
              completed: progress.completed,
              completedBytes: progress.completedBytes ?? -1,
              liveKeys: Object.keys(getDatabase().pluginCustomStorage).sort(),
              optimized: getDatabase().optimizePluginMemory === true,
              memory: forceGcNow(),
            })
          },
        })
        internalSampler.stop()
        const internalFinal = await settleGc()

        expect(internalResult).toEqual({
          direction: 'internalize',
          values: ROW_COUNT,
          meta: 0,
        })
        expect(internalProgress).toHaveLength(ROW_COUNT)
        internalProgress.forEach((progress, index) => {
          expect(progress.completed).toBe(index + 1)
          expect(progress.completedBytes).toBe((index + 1) * ROW_BYTES)
          expect(progress.liveKeys).toEqual([])
          expect(progress.optimized).toBe(true)
        })
        expect(getDatabase().optimizePluginMemory).toBe(false)
        expect(Object.keys(getDatabase().pluginCustomStorage).sort()).toEqual(rawKeys)
        for (const rawKey of rawKeys) {
          expect(valueDigest(getDatabase().pluginCustomStorage[rawKey]))
            .toBe(expectedDigests.get(rawKey))
        }
        expect(internalStageBaseline).not.toBeNull()
        assertBoundedMemory(
          cycleLabel,
          'internalize',
          internalStageBaseline!,
          internalSampler.peak,
          internalFinal,
        )
        assertPerRowMemoryShape('internalize', internalStageBaseline!, internalProgress)

        const internalRequests = requestLog.slice(internalStartLog)
        const manifestSnapshots = internalRequests.filter(entry => (
          entry.path === '/api/plugin-storage/manifest'
        ))
        expect(manifestSnapshots).toHaveLength(1)
        expect(manifestSnapshots[0].headers.get('x-plugin-storage-generation'))
          .toBeTruthy()
        expect(manifestSnapshots[0].headers.get('x-plugin-storage-manifest-mode'))
          .toBeNull()
        expect(internalRequests.filter(entry => (
          entry.path === '/api/list'
          && ['pluginsave/', 'pluginsave-meta/'].includes(
            entry.headers.get('key-prefix') ?? '',
          )
        ))).toEqual([])
        expect(internalRequests.filter(entry => (
          entry.path === '/api/plugin-storage/transition/stage/row'
        ))).toHaveLength(ROW_COUNT)
        expect(internalRequests.some(entry => (
          entry.path === '/api/plugin-storage/transition'
        ))).toBe(false)
        const pluginReads = internalRequests.filter(entry => {
          if (entry.path !== '/api/read') return false
          return Buffer.from(entry.headers.get('file-path') ?? '', 'hex')
            .toString('utf8')
            .startsWith(VALUE_PREFIX)
        })
        expect(pluginReads).toEqual([])
        inspectInternalLayout(server)

        // PM2 keeps a fresh generation on the inline publication while the
        // external manifest is intentionally absent. Re-enabling must use the
        // inline source/list fallback rather than treating that generation as
        // permission to request a nonexistent PM4 manifest snapshot.
        const reexternalizeStart = requestLog.length
        await expect(transitionPluginStorageMode(true)).resolves.toEqual({
          direction: 'externalize',
          values: ROW_COUNT,
          meta: 0,
        })
        const reexternalizeRequests = requestLog.slice(reexternalizeStart)
        expect(reexternalizeRequests.filter(entry => (
          entry.path === '/api/plugin-storage/manifest'
        ))).toEqual([])
        const reexternalizeLists = reexternalizeRequests.filter(entry => (
          entry.path === '/api/list'
          && ['pluginsave/', 'pluginsave-meta/'].includes(
            entry.headers.get('key-prefix') ?? '',
          )
        ))
        expect(reexternalizeLists).toHaveLength(2)
        expect(new Set(reexternalizeLists.map(entry => (
          entry.headers.get('key-prefix')
        )))).toEqual(new Set(['pluginsave/', 'pluginsave-meta/']))
        expect(getDatabase().optimizePluginMemory).toBe(true)
        inspectExternalChunkLayout(server, storageKeys)

        memoryEvidence[cycleLabel] = {
          externalize: {
            wholeBaseline: externalWholeBaseline,
            stageBaseline: externalStageBaseline,
            peak: externalSampler.peak,
            final: externalFinal,
            checkpoints: externalProgress.map(({ completed, memory }) => ({ completed, ...memory })),
          },
          internalize: {
            wholeBaseline: internalWholeBaseline,
            stageBaseline: internalStageBaseline,
            peak: internalSampler.peak,
            final: internalFinal,
            checkpoints: internalProgress.map(({ completed, memory }) => ({ completed, ...memory })),
            ownershipSnapshotRequests: manifestSnapshots.length,
          },
          reexternalize: {
            manifestSnapshotRequests: 0,
            prefixListRequests: reexternalizeLists.length,
          },
        }
      expect(saveLoopFailure).toBeNull()
      expect(requestLog.some(entry => entry.path === '/api/plugin-storage/transition')).toBe(false)
      console.info('[PM2 memory evidence]', JSON.stringify({
        rowBytes: ROW_BYTES,
        rows: ROW_COUNT,
        totalBytes: TOTAL_BYTES,
        cycles: memoryEvidence,
      }))
    } finally {
      vi.unstubAllGlobals()
    }
  }, 600_000)
})
