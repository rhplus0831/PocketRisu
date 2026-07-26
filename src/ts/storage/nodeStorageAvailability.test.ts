import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cache = vi.hoisted(() => ({
    enabled: true,
    getVerifiedManifestSnapshot: vi.fn(),
    getVerifiedCachedBytes: vi.fn(),
    sha256Bytes: vi.fn(),
    storeBytes: vi.fn(),
}))

vi.mock('./resourceCache', () => ({
    getManifestHashes: vi.fn(async () => []),
    getVerifiedManifestSnapshot: cache.getVerifiedManifestSnapshot,
    getVerifiedCachedBytes: cache.getVerifiedCachedBytes,
    invalidateResourceCachePrefix: vi.fn(async () => undefined),
    isResourceCacheEnabled: () => cache.enabled,
    isSha256Hex: (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value),
    persistResourceCacheManifests: vi.fn(async () => undefined),
    sha256Bytes: cache.sha256Bytes,
    settleBestEffortResourceCache: async <T>(operation: Promise<T>, fallback: T) => {
        try {
            return await Promise.race([
                operation,
                new Promise<T>(resolve => setTimeout(() => resolve(fallback), 2_000)),
            ])
        } catch {
            return fallback
        }
    },
    storeBytes: cache.storeBytes,
    touchResourceCacheManifest: vi.fn(async () => undefined),
}))

vi.mock('../alert', () => ({
    alertInput: vi.fn(),
    notifyError: vi.fn(),
    waitAlert: vi.fn(),
}))

vi.mock('src/lang', () => ({ language: {} }))

vi.mock('./database.svelte', () => ({
    normalizeChat: (chat: unknown) => chat,
}))

vi.mock('./risuSave', () => ({
    decodeRisuSave: vi.fn(),
    encodeRisuSaveLegacy: vi.fn(),
}))

const {
    AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS,
    NodeStorage,
} = await import('./nodeStorage')
const { StorageError } = await import('./storageError')

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
    cache.enabled = true
    cache.getVerifiedManifestSnapshot.mockResolvedValue(null)
    cache.getVerifiedCachedBytes.mockResolvedValue(null)
    cache.sha256Bytes.mockResolvedValue('a'.repeat(64))
    cache.storeBytes.mockResolvedValue(undefined)
})

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

describe('NodeStorage availability bounds', () => {
    it('falls through a stalled resource-cache read to the authoritative server', async () => {
        vi.useFakeTimers()
        cache.getVerifiedManifestSnapshot.mockImplementation(
            () => new Promise<never>(() => undefined),
        )
        const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
        }))
        vi.stubGlobal('fetch', fetchMock)
        const storage = readyStorage()

        const read = storage.getItemCached('pluginsave/alpha.json')
        await vi.advanceTimersByTimeAsync(1_999)
        expect(fetchMock).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)

        await expect(read).resolves.toEqual(Buffer.from([1, 2, 3]))
        expect(fetchMock).toHaveBeenCalledWith('/api/read', expect.objectContaining({
            method: 'GET',
            signal: expect.any(AbortSignal),
        }))
    })

    it('does not await best-effort cache seeding after an acknowledged write', async () => {
        cache.storeBytes
            .mockImplementationOnce(() => new Promise<never>(() => undefined))
            .mockResolvedValueOnce(undefined)
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            hash: 'a'.repeat(64),
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })))
        const storage = readyStorage()

        await expect(storage.setItem(
            'pluginsave/alpha.json',
            new TextEncoder().encode('{"value":1}'),
        )).resolves.toBeUndefined()
        await Promise.resolve()

        expect(cache.storeBytes).toHaveBeenCalledOnce()

        await expect(storage.setItem(
            'pluginsave/beta.json',
            new TextEncoder().encode('{"value":2}'),
        )).resolves.toBeUndefined()
        await vi.waitFor(() => expect(cache.storeBytes).toHaveBeenCalledTimes(2))
    })

    it('recovers cache seeding after a hash operation never settles', async () => {
        vi.useFakeTimers()
        cache.sha256Bytes
            .mockImplementationOnce(() => new Promise<never>(() => undefined))
            .mockResolvedValueOnce('a'.repeat(64))
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            hash: 'a'.repeat(64),
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })))
        const storage = readyStorage()

        await storage.setItem(
            'pluginsave/alpha.json',
            new TextEncoder().encode('{"value":1}'),
        )
        await vi.advanceTimersByTimeAsync(2_000)
        expect(cache.storeBytes).not.toHaveBeenCalled()

        await storage.setItem(
            'pluginsave/beta.json',
            new TextEncoder().encode('{"value":2}'),
        )
        await vi.advanceTimersByTimeAsync(0)
        expect(cache.storeBytes).toHaveBeenCalledOnce()
    })

    it('aborts a stalled write and reports an unknown commit outcome', async () => {
        vi.useFakeTimers()
        let requestSignal: AbortSignal | undefined
        vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
            requestSignal = init?.signal ?? undefined
            return new Promise<Response>(() => undefined)
        }))
        const storage = readyStorage()

        const result = storage.setItem(
            'pluginsave/alpha.json',
            new TextEncoder().encode('{"value":1}'),
        ).catch(error => error)
        await vi.advanceTimersByTimeAsync(AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS)
        const error = await result

        expect(error).toBeInstanceOf(StorageError)
        expect(error).toMatchObject({
            code: 'COMMIT_OUTCOME_UNKNOWN',
            commitOutcomeUnknown: true,
            operation: 'write',
        })
        expect(requestSignal?.aborted).toBe(true)
    })

    it('reports a safe timeout when authentication stalls before dispatch and then recovers', async () => {
        vi.useFakeTimers()
        cache.enabled = false
        let authSignal: AbortSignal | undefined
        const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input) === '/api/test_auth') {
                authSignal = init?.signal ?? undefined
                return new Promise<Response>(() => undefined)
            }
            throw new Error(`Unexpected request: ${String(input)}`)
        })
        vi.stubGlobal('fetch', fetchMock)
        const storage = new NodeStorage()

        const result = storage.setItem(
            'pluginsave/alpha.json',
            new TextEncoder().encode('{"value":1}'),
        ).catch(error => error)
        await vi.advanceTimersByTimeAsync(AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS)
        const error = await result

        expect(error).toBeInstanceOf(StorageError)
        expect(error).toMatchObject({
            code: 'STORAGE_TIMEOUT',
            commitOutcomeUnknown: false,
            retryable: true,
            operation: 'write',
        })
        expect(authSignal?.aborted).toBe(true)
        expect(fetchMock).not.toHaveBeenCalledWith('/api/write', expect.anything())

        fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
            if (String(input) === '/api/test_auth') {
                return new Response(JSON.stringify({ status: 'ok', token: 'recovered-token' }))
            }
            if (String(input) === '/api/session') return new Response(null, { status: 200 })
            if (String(input) === '/api/write') {
                return new Response(JSON.stringify({ hash: 'a'.repeat(64) }), { status: 200 })
            }
            throw new Error(`Unexpected request: ${String(input)}`)
        })
        await expect(storage.setItem(
            'pluginsave/alpha.json',
            new TextEncoder().encode('{"value":2}'),
        )).resolves.toBeUndefined()
    })

    it('evicts an aborted refresh promise so a later write can recover', async () => {
        vi.useFakeTimers()
        cache.enabled = false
        const storage = new NodeStorage()
        storage.authChecked = true
        ;(NodeStorage as any).sessionInitialized = true
        let refreshSignal: AbortSignal | undefined
        const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input) === '/api/token/refresh') {
                refreshSignal = init?.signal ?? undefined
                return new Promise<Response>(() => undefined)
            }
            throw new Error(`Unexpected request: ${String(input)}`)
        })
        vi.stubGlobal('fetch', fetchMock)

        const result = storage.setItem(
            'pluginsave/alpha.json',
            new TextEncoder().encode('{"value":1}'),
        ).catch(error => error)
        await vi.advanceTimersByTimeAsync(AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS)
        await expect(result).resolves.toMatchObject({
            code: 'STORAGE_TIMEOUT',
            commitOutcomeUnknown: false,
        })
        expect(refreshSignal?.aborted).toBe(true)

        fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
            if (String(input) === '/api/token/refresh') {
                return new Response(JSON.stringify({ token: 'recovered-token' }), { status: 200 })
            }
            if (String(input) === '/api/write') {
                return new Response(JSON.stringify({ hash: 'a'.repeat(64) }), { status: 200 })
            }
            throw new Error(`Unexpected request: ${String(input)}`)
        })
        await expect(storage.setItem(
            'pluginsave/alpha.json',
            new TextEncoder().encode('{"value":2}'),
        )).resolves.toBeUndefined()
    })

    it('evicts an aborted session promise so a later write can recover', async () => {
        vi.useFakeTimers()
        cache.enabled = false
        const storage = new NodeStorage()
        storage.authChecked = true
        ;(storage as any).cachedJwt = {
            token: 'cached-token',
            expiresAt: Date.now() + 300_000,
        }
        let sessionSignal: AbortSignal | undefined
        const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input) === '/api/session') {
                sessionSignal = init?.signal ?? undefined
                return new Promise<Response>(() => undefined)
            }
            throw new Error(`Unexpected request: ${String(input)}`)
        })
        vi.stubGlobal('fetch', fetchMock)

        const result = storage.setItem(
            'pluginsave/alpha.json',
            new TextEncoder().encode('{"value":1}'),
        ).catch(error => error)
        await vi.advanceTimersByTimeAsync(AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS)
        await expect(result).resolves.toMatchObject({
            code: 'STORAGE_TIMEOUT',
            commitOutcomeUnknown: false,
        })
        expect(sessionSignal?.aborted).toBe(true)

        fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
            if (String(input) === '/api/session') return new Response(null, { status: 200 })
            if (String(input) === '/api/write') {
                return new Response(JSON.stringify({ hash: 'a'.repeat(64) }), { status: 200 })
            }
            throw new Error(`Unexpected request: ${String(input)}`)
        })
        await expect(storage.setItem(
            'pluginsave/alpha.json',
            new TextEncoder().encode('{"value":2}'),
        )).resolves.toBeUndefined()
    })

    it('treats a stalled body after a definitive success response as safely retryable', async () => {
        vi.useFakeTimers()
        let requestSignal: AbortSignal | undefined
        vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
            requestSignal = init?.signal ?? undefined
            const response = new Response(null, { status: 200 })
            vi.spyOn(response, 'json').mockImplementation(
                () => new Promise<never>(() => undefined),
            )
            return Promise.resolve(response)
        }))
        const storage = readyStorage()

        const result = storage.setItem(
            'pluginsave/alpha.json',
            new TextEncoder().encode('{"value":1}'),
        ).catch(error => error)
        await vi.advanceTimersByTimeAsync(AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS)
        const error = await result

        expect(error).toBeInstanceOf(StorageError)
        expect(error).toMatchObject({
            code: 'STORAGE_TIMEOUT',
            commitOutcomeUnknown: false,
            retryable: true,
            operation: 'write',
        })
        expect(requestSignal?.aborted).toBe(true)
    })

    it('clears mutation ambiguity before a definitive conflict body stalls', async () => {
        vi.useFakeTimers()
        let requestSignal: AbortSignal | undefined
        vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
            requestSignal = init?.signal ?? undefined
            return Promise.resolve(new Response(new ReadableStream(), { status: 409 }))
        }))
        const storage = readyStorage()

        const result = storage.setItem(
            'pluginsave/alpha.json',
            new TextEncoder().encode('{"value":1}'),
        ).catch(error => error)
        await vi.advanceTimersByTimeAsync(AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS)
        const error = await result

        expect(error).toBeInstanceOf(StorageError)
        expect(error).toMatchObject({
            code: 'STORAGE_TIMEOUT',
            commitOutcomeUnknown: false,
            retryable: true,
            operation: 'write',
        })
        expect(requestSignal?.aborted).toBe(true)
    })

    it('clears mutation ambiguity while an authentication retry is pending', async () => {
        vi.useFakeTimers()
        let retryAuthSignal: AbortSignal | undefined
        const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input) === '/api/write') {
                return Promise.resolve(new Response(JSON.stringify({
                    error: 'Token Expired',
                }), {
                    status: 401,
                    headers: { 'content-type': 'application/json' },
                }))
            }
            if (String(input) === '/api/test_auth') {
                retryAuthSignal = init?.signal ?? undefined
                return new Promise<Response>(() => undefined)
            }
            throw new Error(`Unexpected request: ${String(input)}`)
        })
        vi.stubGlobal('fetch', fetchMock)
        const storage = readyStorage()

        const result = storage.setItem(
            'pluginsave/alpha.json',
            new TextEncoder().encode('{"value":1}'),
        ).catch(error => error)
        await vi.advanceTimersByTimeAsync(AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS)
        const error = await result

        expect(error).toBeInstanceOf(StorageError)
        expect(error).toMatchObject({
            code: 'STORAGE_TIMEOUT',
            commitOutcomeUnknown: false,
            retryable: true,
            operation: 'write',
        })
        expect(retryAuthSignal?.aborted).toBe(true)
        expect(fetchMock.mock.calls.filter(([input]) => String(input) === '/api/write'))
            .toHaveLength(1)
    })
})
