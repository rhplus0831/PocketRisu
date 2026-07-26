import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cache = vi.hoisted(() => ({ enabled: false }))

vi.mock('./resourceCache', () => ({
    getManifestHashes: vi.fn(async () => []),
    getVerifiedManifestSnapshot: vi.fn(async () => null),
    getVerifiedCachedBytes: vi.fn(async () => null),
    invalidateResourceCachePrefix: vi.fn(async () => undefined),
    invalidateResourceCacheManifest: vi.fn(async () => undefined),
    isResourceCacheEnabled: () => cache.enabled,
    isSha256Hex: (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value),
    persistResourceCacheManifests: vi.fn(async () => undefined),
    sha256Bytes: vi.fn(async () => 'a'.repeat(64)),
    settleBestEffortResourceCache: async <T>(operation: Promise<T>, fallback: T) => {
        try { return await operation } catch { return fallback }
    },
    storeBytes: vi.fn(async () => undefined),
    touchResourceCacheManifest: vi.fn(async () => undefined),
}))

vi.mock('../alert', () => ({
    alertInput: vi.fn(),
    notifyError: vi.fn(),
    waitAlert: vi.fn(),
}))

vi.mock('src/lang', () => ({ language: {} }))
vi.mock('./database.svelte', () => ({ normalizeChat: (chat: unknown) => chat }))
vi.mock('./risuSave', () => ({
    decodeRisuSave: vi.fn(),
    encodeRisuSaveLegacy: vi.fn(),
}))

const { NodeStorage } = await import('./nodeStorage')
const { StorageError } = await import('./storageError')
const resourceCache = await import('./resourceCache')

function readyStorage(): InstanceType<typeof NodeStorage> {
    const storage = new NodeStorage()
    storage.authChecked = true
    ;(NodeStorage as any).sessionInitialized = true
    vi.spyOn(storage, 'createAuth').mockResolvedValue('test-token')
    return storage
}

beforeEach(() => {
    vi.clearAllMocks()
    ;(NodeStorage as any).sessionInitialized = false
    ;(NodeStorage as any).sessionPending = null
    cache.enabled = false
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('NodeStorage boot snapshot recovery', () => {
    it('reads corrupt live bytes without asking the server to decode them', async () => {
        const corrupt = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            expect(String(input)).toBe('/api/db/read-raw-for-boot')
            return new Response(corrupt, {
                status: 200,
                headers: { 'x-db-etag': 'b'.repeat(32) },
            })
        })
        vi.stubGlobal('fetch', fetchMock)
        const storage = readyStorage()

        const result = await storage.readDatabaseForBoot()

        expect(result).toEqual({ kind: 'bytes', bytes: Buffer.from(corrupt) })
        expect(storage._lastDbEtag).toBe('b'.repeat(32))
        expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('accepts only the complete committed restore acknowledgement', async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            expect(String(input)).toBe('/api/db/snapshots/restore')
            expect(init).toMatchObject({
                method: 'POST',
                body: JSON.stringify({ key: 'database/dbbackup-123.bin' }),
            })
            return new Response(JSON.stringify({
                ok: true,
                commitOutcome: 'committed',
                commitOutcomeUnknown: false,
            }), { status: 200, headers: { 'content-type': 'application/json' } })
        })
        vi.stubGlobal('fetch', fetchMock)
        const storage = readyStorage()
        storage._lastDbEtag = 'stale-etag'

        await expect(storage.restoreInternalSnapshotForBoot(
            'database/dbbackup-123.bin',
        )).resolves.toBe('committed')

        expect(storage._lastDbEtag).toBeNull()
        expect(resourceCache.invalidateResourceCacheManifest).toHaveBeenCalledTimes(5)
    })

    it('keeps a truncated success acknowledgement commit-unknown', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            ok: true,
            commitOutcome: 'committed',
        }), { status: 200, headers: { 'content-type': 'application/json' } })))

        await expect(readyStorage().restoreInternalSnapshotForBoot(
            'database/dbbackup-456.bin',
        )).rejects.toMatchObject({
            code: 'COMMIT_OUTCOME_UNKNOWN',
            commitOutcomeUnknown: true,
            operation: 'transition',
        } satisfies Partial<InstanceType<typeof StorageError>>)
    })

    it('keeps a transport loss after restore dispatch commit-unknown', async () => {
        const fetchMock = vi.fn(async () => {
            throw new TypeError('socket closed before acknowledgement')
        })
        vi.stubGlobal('fetch', fetchMock)

        await expect(readyStorage().restoreInternalSnapshotForBoot(
            'database/dbbackup-789.bin',
        )).rejects.toMatchObject({
            code: 'COMMIT_OUTCOME_UNKNOWN',
            commitOutcomeUnknown: true,
            retryable: false,
            operation: 'transition',
        } satisfies Partial<InstanceType<typeof StorageError>>)
        expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('rejects malformed snapshot names before dispatch', async () => {
        const fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)

        await expect(readyStorage().restoreInternalSnapshotForBoot(
            'database/dbbackup-123.bin/../../database.bin',
        )).rejects.toThrow('Invalid internal snapshot key')
        expect(fetchMock).not.toHaveBeenCalled()
    })
})
