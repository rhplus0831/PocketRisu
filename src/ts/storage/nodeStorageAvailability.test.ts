import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cache = vi.hoisted(() => ({
    enabled: true,
    getManifestHashes: vi.fn(),
    getVerifiedManifestSnapshot: vi.fn(),
    getVerifiedCachedBytes: vi.fn(),
    sha256Bytes: vi.fn(),
    sha256OwnedBytes: vi.fn(),
    storeBytes: vi.fn(),
    storeOwnedBytesWithKnownHash: vi.fn(),
}))

vi.mock('./resourceCache', () => ({
    applyOwnedResourceCacheMutations: vi.fn(async () => undefined),
    getManifestHashes: cache.getManifestHashes,
    getVerifiedManifestSnapshot: cache.getVerifiedManifestSnapshot,
    getVerifiedCachedBytes: cache.getVerifiedCachedBytes,
    invalidateResourceCacheManifest: vi.fn(async () => undefined),
    invalidateResourceCachePrefix: vi.fn(async () => undefined),
    isResourceCacheEnabled: () => cache.enabled,
    isSha256Hex: (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value),
    persistResourceCacheManifests: vi.fn(async () => undefined),
    sha256Bytes: cache.sha256Bytes,
    sha256OwnedBytes: cache.sha256OwnedBytes,
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
    storeOwnedBytesWithKnownHash: cache.storeOwnedBytesWithKnownHash,
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
    cache.getManifestHashes.mockResolvedValue([])
    cache.getVerifiedManifestSnapshot.mockResolvedValue(null)
    cache.getVerifiedCachedBytes.mockResolvedValue(null)
    cache.sha256Bytes.mockResolvedValue('a'.repeat(64))
    cache.sha256OwnedBytes.mockResolvedValue('a'.repeat(64))
    cache.storeBytes.mockResolvedValue(undefined)
    cache.storeOwnedBytesWithKnownHash.mockResolvedValue(undefined)
})

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

describe('NodeStorage availability bounds', () => {
    it('polls a partial export job past the generic 15 second read bound', async () => {
        vi.useFakeTimers()
        const startedAt = Date.now()
        const progress = vi.fn()
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input)
            if (url === '/api/backup/export/jobs' && init?.method === 'POST') {
                return new Response(JSON.stringify({ jobId: 'export-job', state: 'preparing' }), {
                    status: 202,
                    headers: { 'content-type': 'application/json' },
                })
            }
            if (url === '/api/backup/export/jobs/export-job') {
                const ready = Date.now() - startedAt > AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS
                return new Response(JSON.stringify({
                    state: ready ? 'ready' : 'preparing',
                    phase: ready ? 'ready' : 'folding-database',
                    current: ready ? 2 : 1,
                    total: 2,
                    bytes: 1024,
                }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                })
            }
            if (url === '/api/backup/export/jobs/export-job/download') {
                return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
            }
            throw new Error(`Unexpected request: ${url}`)
        })
        vi.stubGlobal('fetch', fetchMock)
        const storage = readyStorage()

        const exported = storage.exportBackup({
            scope: 'partial',
            onPreparationProgress: progress,
        })
        await vi.advanceTimersByTimeAsync(AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS + 1_000)

        await expect(exported).resolves.toBeInstanceOf(Response)
        expect(progress).toHaveBeenCalledWith(expect.objectContaining({
            phase: 'ready',
            current: 2,
        }))
        expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/download'))).toBe(true)
    })

    it('keeps the ordinary availability bound for a full export without a caller signal', async () => {
        vi.useFakeTimers()
        let requestSignal: AbortSignal | undefined
        vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
            requestSignal = init?.signal ?? undefined
            return new Promise<Response>(() => undefined)
        }))
        const storage = readyStorage()

        const exported = storage.exportBackup().catch(error => error)
        await vi.advanceTimersByTimeAsync(AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS)

        await expect(exported).resolves.toMatchObject({
            code: 'STORAGE_TIMEOUT',
            operation: 'read',
        })
        expect(requestSignal?.aborted).toBe(true)
    })

    it('bounds a stalled ready-download header when no caller signal is supplied', async () => {
        vi.useFakeTimers()
        let downloadSignal: AbortSignal | undefined
        const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input)
            if (url === '/api/backup/export/jobs' && init?.method === 'POST') {
                return Promise.resolve(new Response(JSON.stringify({
                    jobId: 'download-bound-job',
                    state: 'preparing',
                }), {
                    status: 202,
                    headers: { 'content-type': 'application/json' },
                }))
            }
            if (url === '/api/backup/export/jobs/download-bound-job' && init?.method === 'DELETE') {
                return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
                    status: 202,
                    headers: { 'content-type': 'application/json' },
                }))
            }
            if (url === '/api/backup/export/jobs/download-bound-job') {
                return Promise.resolve(new Response(JSON.stringify({
                    state: 'ready', phase: 'ready', current: 2, total: 2, bytes: 0,
                }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }))
            }
            if (url.endsWith('/download')) {
                downloadSignal = init?.signal ?? undefined
                return new Promise<Response>(() => undefined)
            }
            throw new Error(`Unexpected request: ${url}`)
        })
        vi.stubGlobal('fetch', fetchMock)
        const storage = readyStorage()

        const exported = storage.exportBackup({ scope: 'partial' }).catch(error => error)
        await vi.waitFor(() => expect(downloadSignal).toBeDefined())
        await vi.advanceTimersByTimeAsync(AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS)

        await expect(exported).resolves.toMatchObject({
            code: 'STORAGE_TIMEOUT',
            operation: 'read',
        })
        expect(downloadSignal?.aborted).toBe(true)
    })

    it('cancels a partial export job when the caller aborts preparation', async () => {
        const controller = new AbortController()
        let statusSignal: AbortSignal | undefined
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input)
            if (url === '/api/backup/export/jobs' && init?.method === 'POST') {
                return new Response(JSON.stringify({ jobId: 'cancel-job', state: 'preparing' }), {
                    status: 202,
                    headers: { 'content-type': 'application/json' },
                })
            }
            if (url === '/api/backup/export/jobs/cancel-job' && init?.method === 'DELETE') {
                return new Response(JSON.stringify({ ok: true }), {
                    status: 202,
                    headers: { 'content-type': 'application/json' },
                })
            }
            if (url === '/api/backup/export/jobs/cancel-job') {
                statusSignal = init?.signal ?? undefined
                return new Promise<Response>((_resolve, reject) => {
                    statusSignal?.addEventListener('abort', () => {
                        reject(new DOMException('cancelled', 'AbortError'))
                    }, { once: true })
                })
            }
            throw new Error(`Unexpected request: ${url}`)
        })
        vi.stubGlobal('fetch', fetchMock)
        const storage = readyStorage()

        const exported = storage.exportBackup({ scope: 'partial', signal: controller.signal })
        await vi.waitFor(() => expect(statusSignal).toBeDefined())
        controller.abort(new DOMException('cancelled', 'AbortError'))

        await expect(exported).rejects.toMatchObject({ name: 'AbortError' })
        expect(statusSignal?.aborted).toBe(true)
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
            '/api/backup/export/jobs/cancel-job',
            expect.objectContaining({ method: 'DELETE' }),
        ))
    })

    it('cancels by its client-chosen id when the create acknowledgement is lost', async () => {
        const controller = new AbortController()
        let requestedJobId = ''
        const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input)
            if (url === '/api/backup/export/jobs' && init?.method === 'POST') {
                requestedJobId = JSON.parse(String(init.body)).jobId
                return new Promise<Response>((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () => {
                        reject(new DOMException('lost create acknowledgement', 'AbortError'))
                    }, { once: true })
                })
            }
            if (url === `/api/backup/export/jobs/${requestedJobId}` && init?.method === 'DELETE') {
                return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
                    status: 202,
                    headers: { 'content-type': 'application/json' },
                }))
            }
            throw new Error(`Unexpected request: ${url}`)
        })
        vi.stubGlobal('fetch', fetchMock)
        const storage = readyStorage()

        const exported = storage.exportBackup({ scope: 'partial', signal: controller.signal })
        await vi.waitFor(() => expect(requestedJobId).toMatch(/^[0-9a-f-]{36}$/))
        controller.abort(new DOMException('cancelled', 'AbortError'))

        await expect(exported).rejects.toMatchObject({ name: 'AbortError' })
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
            `/api/backup/export/jobs/${requestedJobId}`,
            expect.objectContaining({ method: 'DELETE' }),
        ))
    })

    it('routes staged transition controls without an aggregate database envelope', async () => {
        const transitionId = '123e4567-e89b-42d3-a456-426614174000'
        const targetGeneration = '123e4567-e89b-42d3-a456-426614174001'
        const response = {
            success: true,
            transitionId,
            state: 'ready',
            direction: 'externalize',
            targetGeneration,
            rows: [{
                storageKey: 'pluginsave/YQ.json',
                size: 3,
                sha256: 'a'.repeat(64),
                uploaded: true,
            }],
            uploaded: 1,
            total: 1,
            totalBytes: 3,
        }
        const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => (
            String(input).endsWith('/row')
                ? new Response(new Uint8Array([34, 97, 34]), { status: 200 })
                : new Response(JSON.stringify(response), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                })
        ))
        vi.stubGlobal('fetch', fetchMock)
        const storage = readyStorage()
        const plan = {
            version: 2 as const,
            transitionId,
            source: { optimized: false, generation: null, manifest: null },
            targetOptimized: true,
            targetGeneration,
            rows: [{ storageKey: 'pluginsave/YQ.json', size: 3 }],
        }

        await storage.beginPluginStorageTransition(plan)
        await storage.uploadPluginStorageTransitionRow(
            transitionId,
            'pluginsave/YQ.json',
            new Uint8Array([34, 97, 34]),
        )
        await expect(storage.readPluginStorageTransitionRow(
            transitionId,
            'pluginsave/YQ.json',
        )).resolves.toEqual(Buffer.from('"a"'))
        await storage.getPluginStorageTransitionStatus(transitionId)
        await storage.finalizePluginStorageTransition(transitionId)
        await storage.abortPluginStorageTransition(transitionId)

        expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
            '/api/plugin-storage/transition/stage/begin',
            '/api/plugin-storage/transition/stage/upload',
            '/api/plugin-storage/transition/stage/row',
            '/api/plugin-storage/transition/stage/status',
            '/api/plugin-storage/transition/stage/finalize',
            '/api/plugin-storage/transition/stage/abort',
        ])
        const beginBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
        expect(beginBody).not.toHaveProperty('database')
        expect(fetchMock.mock.calls[1][1]?.body).toBeInstanceOf(Uint8Array)
    })

    it('routes large plugin values through the parser-free streaming endpoint', async () => {
        cache.enabled = false
        const requestBytes = new Uint8Array(1024 * 1024)
        const fetchMock = vi.fn(async (_input: string, _init: RequestInit) => new Response(JSON.stringify({
            success: true,
            outcome: 'committed',
            operation: 'set',
            verification: 'verified',
            hash: 'a'.repeat(64),
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }))
        vi.stubGlobal('fetch', fetchMock)
        const storage = readyStorage()

        await expect(storage.mutatePluginStorage({
            operation: 'set',
            valueKey: 'pluginsave/bGFyZ2U.json',
            valueBytes: requestBytes,
            ownedValueBytes: true,
            owner: 'Capacity Test',
        })).resolves.toMatchObject({ outcome: 'committed' })
        expect(fetchMock).toHaveBeenCalledOnce()
        const [path, init] = fetchMock.mock.calls[0]
        expect(path).toBe('/api/plugin-storage/mutate')
        expect(init).toMatchObject({ body: requestBytes, method: 'POST' })
        expect((init.headers as Headers).get('x-plugin-storage-stream')).toBe('1')
        expect(cache.sha256OwnedBytes).toHaveBeenCalledOnce()
        expect(cache.sha256Bytes).not.toHaveBeenCalled()
        expect(cache.storeOwnedBytesWithKnownHash).not.toHaveBeenCalled()
    }, 30_000)

    it('seeds a cache-enabled legacy value with the server hash and donated bytes', async () => {
        vi.useFakeTimers()
        cache.enabled = true
        const requestBytes = new Uint8Array(1024 * 1024)
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            hash: 'b'.repeat(64),
            size: requestBytes.byteLength,
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })))
        const storage = readyStorage()

        await storage.setItem('pluginsave/Y2FjaGVkLWxhcmdl.json', requestBytes)
        await vi.advanceTimersByTimeAsync(0)

        expect(cache.storeOwnedBytesWithKnownHash).toHaveBeenCalledWith(
            'kv:pluginsave/Y2FjaGVkLWxhcmdl.json',
            'b'.repeat(64),
            requestBytes,
        )
        expect(cache.sha256Bytes).not.toHaveBeenCalled()
    }, 15_000)

    it('preserves actionable plugin capacity errors after a definitive response', async () => {
        cache.enabled = false
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            error: 'Optimized plugin storage would exceed its aggregate limit.',
            code: 'PLUGIN_STORAGE_TOTAL_TOO_LARGE',
            retryable: false,
        }), {
            status: 413,
            headers: { 'content-type': 'application/json' },
        })))
        const storage = readyStorage()

        await expect(storage.setItem(
            'pluginsave/YQ.json',
            new TextEncoder().encode('{"value":1}'),
        )).rejects.toMatchObject({
            name: 'StorageError',
            status: 413,
            code: 'PLUGIN_STORAGE_TOTAL_TOO_LARGE',
            retryable: false,
            commitOutcomeUnknown: false,
            operation: 'write',
        })
    })

    it('falls through a stalled resource-cache read to the authoritative server', async () => {
        vi.useFakeTimers()
        cache.getManifestHashes.mockImplementation(
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
        cache.storeOwnedBytesWithKnownHash
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
        await new Promise(resolve => setTimeout(resolve, 0))

        expect(cache.storeOwnedBytesWithKnownHash).toHaveBeenCalledOnce()
        expect(cache.sha256Bytes).not.toHaveBeenCalled()

        await expect(storage.setItem(
            'pluginsave/beta.json',
            new TextEncoder().encode('{"value":2}'),
        )).resolves.toBeUndefined()
        await vi.waitFor(() => expect(cache.storeOwnedBytesWithKnownHash).toHaveBeenCalledTimes(2))
    })

    it('recovers cache seeding after a known-hash cache operation never settles', async () => {
        vi.useFakeTimers()
        cache.storeOwnedBytesWithKnownHash
            .mockImplementationOnce(() => new Promise<never>(() => undefined))
            .mockResolvedValueOnce(undefined)
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
        await vi.advanceTimersByTimeAsync(0)
        expect(cache.storeOwnedBytesWithKnownHash).toHaveBeenCalledOnce()
        expect(cache.sha256Bytes).not.toHaveBeenCalled()

        await storage.setItem(
            'pluginsave/beta.json',
            new TextEncoder().encode('{"value":2}'),
        )
        await vi.advanceTimersByTimeAsync(0)
        expect(cache.storeOwnedBytesWithKnownHash).toHaveBeenCalledTimes(2)
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

    it('resolves a stalled staged-finalize acknowledgement through status', async () => {
        vi.useFakeTimers()
        let requestSignal: AbortSignal | undefined
        const transitionId = '123e4567-e89b-42d3-a456-426614174010'
        const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input).endsWith('/finalize')) {
                requestSignal = init?.signal ?? undefined
                const response = new Response(null, { status: 200 })
                vi.spyOn(response, 'json').mockImplementation(
                    () => new Promise<never>(() => undefined),
                )
                return Promise.resolve(response)
            }
            if (String(input).endsWith('/status')) {
                return Promise.resolve(new Response(JSON.stringify({
                    success: true,
                    transitionId,
                    state: 'committed',
                    direction: 'externalize',
                    targetGeneration: '123e4567-e89b-42d3-a456-426614174011',
                    rows: [],
                    uploaded: 0,
                    total: 0,
                    totalBytes: 0,
                    etag: 'a'.repeat(32),
                }), { status: 200 }))
            }
            throw new Error(`Unexpected request: ${String(input)}`)
        })
        vi.stubGlobal('fetch', fetchMock)
        const storage = readyStorage()

        const pending = storage.finalizePluginStorageTransition(transitionId)
        await vi.advanceTimersByTimeAsync(AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS)
        const result = await pending

        expect(result.state).toBe('committed')
        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(requestSignal?.aborted).toBe(true)
        expect(cache.storeBytes).not.toHaveBeenCalled()
        expect(cache.storeOwnedBytesWithKnownHash).not.toHaveBeenCalled()
    })

    it('classifies a serialized ready status as definitively not committed', async () => {
        vi.useFakeTimers()
        const transitionId = '123e4567-e89b-42d3-a456-426614174012'
        vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
            if (String(input).endsWith('/finalize')) {
                const response = new Response(null, { status: 200 })
                vi.spyOn(response, 'json').mockImplementation(
                    () => new Promise<never>(() => undefined),
                )
                return Promise.resolve(response)
            }
            if (String(input).endsWith('/status')) {
                return Promise.resolve(new Response(JSON.stringify({
                    success: true,
                    transitionId,
                    state: 'ready',
                    direction: 'externalize',
                    targetGeneration: '123e4567-e89b-42d3-a456-426614174013',
                    rows: [],
                    uploaded: 0,
                    total: 0,
                    totalBytes: 0,
                }), { status: 200 }))
            }
            throw new Error(`Unexpected request: ${String(input)}`)
        }))
        const storage = readyStorage()

        const pending = storage.finalizePluginStorageTransition(transitionId)
            .catch(error => error)
        await vi.advanceTimersByTimeAsync(AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS)
        const error = await pending

        expect(error).toBeInstanceOf(StorageError)
        expect(error).toMatchObject({
            code: 'PLUGIN_STORAGE_TRANSITION_NOT_COMMITTED',
            commitOutcomeUnknown: false,
            retryable: true,
        })
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
