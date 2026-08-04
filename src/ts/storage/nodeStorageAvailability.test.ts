import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cache = vi.hoisted(() => ({
    enabled: true,
    getManifestHashes: vi.fn(),
    getVerifiedManifestSnapshot: vi.fn(),
    getVerifiedCachedBytes: vi.fn(),
    persistResourceCacheManifests: vi.fn(),
    sha256Bytes: vi.fn(),
    sha256OwnedBytes: vi.fn(),
    storeBytes: vi.fn(),
    storeOwnedBytesWithKnownHash: vi.fn(),
}))

const codec = vi.hoisted(() => ({
    encodeChatRowPayload: vi.fn(),
    prepareChatRowCheckpoint: vi.fn(),
}))

vi.mock('./payloadCodecClient', () => ({
    encodeChatRowPayload: codec.encodeChatRowPayload,
    prepareChatRowCheckpoint: codec.prepareChatRowCheckpoint,
}))

vi.mock('./resourceCache', () => ({
    RESOURCE_CACHE_MAX_ENTRIES: 32_768,
    RESOURCE_CACHE_MAX_STORED_BYTES: 64 * 1024 * 1024,
    RESOURCE_CACHE_MAX_VALUE_BYTES: 32 * 1024 * 1024,
    applyOwnedResourceCacheMutations: vi.fn(async () => undefined),
    getManifestHashes: cache.getManifestHashes,
    getVerifiedManifestSnapshot: cache.getVerifiedManifestSnapshot,
    getVerifiedCachedBytes: cache.getVerifiedCachedBytes,
    invalidateResourceCacheManifest: vi.fn(async () => undefined),
    invalidateResourceCachePrefix: vi.fn(async () => undefined),
    isResourceCacheEnabled: () => cache.enabled,
    isSha256Hex: (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value),
    persistResourceCacheManifests: cache.persistResourceCacheManifests,
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
    AUTHORITATIVE_STORAGE_JOB_TIMEOUT_MS,
    AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS,
    AUTHORITATIVE_STORAGE_PAYLOAD_MAX_TIMEOUT_MS,
    DB_CACHED_BOOT_MIN_RAW_BYTES,
    NodeStorage,
    authoritativeStoragePayloadTimeoutMs,
    parseDatabaseStorageCapabilities,
} = await import('./nodeStorage')
const { StorageError } = await import('./storageError')
const { decodeRisuSave, encodeRisuSaveLegacy } = await import('./risuSave')
const { encodeRawMsgpack } = await import('./rawMsgpack')

function encodeOwnedRawMsgpack(value: unknown): Uint8Array {
    return Uint8Array.from(encodeRawMsgpack(value))
}

const SMALL_PLUGIN_WRITE_TIMEOUT_MS = authoritativeStoragePayloadTimeoutMs(
    new TextEncoder().encode('{"value":1}').byteLength,
)

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
    ;(NodeStorage as any).pluginStorageCapabilities = {
        maxValueBytes: 128 * 1024 * 1024,
    }
    ;(NodeStorage as any).databaseStorageCapabilities = {
        rawBootRead: false,
        atomicCreate: false,
        optimizedPluginStorageBootReconcile: false,
        rawBootByteLength: null,
    }
    cache.enabled = true
    cache.getManifestHashes.mockResolvedValue([])
    cache.getVerifiedManifestSnapshot.mockResolvedValue(null)
    cache.getVerifiedCachedBytes.mockResolvedValue(null)
    cache.persistResourceCacheManifests.mockResolvedValue(undefined)
    cache.sha256Bytes.mockResolvedValue('a'.repeat(64))
    cache.sha256OwnedBytes.mockResolvedValue('a'.repeat(64))
    cache.storeBytes.mockResolvedValue(undefined)
    cache.storeOwnedBytesWithKnownHash.mockResolvedValue(undefined)
    codec.encodeChatRowPayload.mockImplementation(async (_chat: unknown, hash: boolean) => ({
        bytes: new Uint8Array([1, 2, 3]),
        hash: hash ? 'a'.repeat(64) : null,
    }))
    codec.prepareChatRowCheckpoint.mockImplementation(async (
        _previousChat: unknown,
        chat: unknown,
    ) => ({
        bytes: new Uint8Array([1, 2, 3]),
        hash: 'a'.repeat(64),
        patch: null,
        snapshot: structuredClone(chat),
    }))
    vi.mocked(encodeRisuSaveLegacy).mockReturnValue(new Uint8Array([1, 2, 3]))
})

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

describe('database storage capability parsing', () => {
    it.each([
        ['absent field', {}, null],
        ['explicit null', { rawBootByteLength: null }, null],
        ['negative number', { rawBootByteLength: -1 }, null],
        ['non-integer number', { rawBootByteLength: 1.5 }, null],
        ['non-finite number', { rawBootByteLength: Number.POSITIVE_INFINITY }, null],
        ['wrong type', { rawBootByteLength: '1024' }, null],
        ['zero', { rawBootByteLength: 0 }, 0],
        ['valid number', { rawBootByteLength: 1024 }, 1024],
    ])('handles a %s', (_label, value, expected) => {
        expect(parseDatabaseStorageCapabilities(value).rawBootByteLength).toBe(expected)
    })

    it('uses legacy defaults when the database capability object is absent', () => {
        expect(parseDatabaseStorageCapabilities(undefined)).toMatchObject({
            rawBootRead: false,
            atomicCreate: false,
            optimizedPluginStorageBootReconcile: false,
            rawBootByteLength: null,
        })
    })
})

describe('NodeStorage availability bounds', () => {
    it('bypasses cache inventory verification below the raw byte threshold', async () => {
        cache.getVerifiedManifestSnapshot.mockRejectedValue(
            new Error('cache inventory must not be touched'),
        )
        const authoritativeBytes = new Uint8Array([8, 4, 6])
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            if (String(input) === '/api/db/read-raw-for-boot') {
                return new Response(authoritativeBytes as unknown as BodyInit, {
                    status: 200,
                    headers: { 'x-db-etag': 'a'.repeat(32) },
                })
            }
            throw new Error(`Unexpected request: ${String(input)}`)
        })
        vi.stubGlobal('fetch', fetchMock)
        ;(NodeStorage as any).databaseStorageCapabilities = {
            rawBootRead: true,
            atomicCreate: true,
            optimizedPluginStorageBootReconcile: true,
            rawBootByteLength: DB_CACHED_BOOT_MIN_RAW_BYTES - 1,
        }

        await expect(readyStorage().readDatabaseForBoot()).resolves.toEqual({
            kind: 'bytes',
            bytes: Buffer.from(authoritativeBytes),
        })
        expect(cache.getVerifiedManifestSnapshot).not.toHaveBeenCalled()
        expect(cache.persistResourceCacheManifests).not.toHaveBeenCalled()
        expect(fetchMock).toHaveBeenCalledOnce()
        expect(fetchMock).toHaveBeenCalledWith(
            '/api/db/read-raw-for-boot',
            expect.objectContaining({ method: 'GET' }),
        )
    })

    it.each([
        ['at the threshold', DB_CACHED_BOOT_MIN_RAW_BYTES],
        ['above the threshold', DB_CACHED_BOOT_MIN_RAW_BYTES + 1],
        ['without a size hint', null],
    ])('keeps the cached boot path %s', async (_label, rawBootByteLength) => {
        cache.getVerifiedManifestSnapshot.mockResolvedValue({
            hashes: [],
            bytesByHash: new Map(),
        })
        const etag = 'f'.repeat(32)
        const encodedEnvelope = encodeOwnedRawMsgpack({
            version: 1,
            etag,
            root: { bytes: encodeOwnedRawMsgpack({ name: 'threshold-cached-boot' }) },
            characters: [],
            botPresets: [],
            modules: [],
            personas: [],
        })
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            if (String(input) === '/api/db/read-cached') {
                return new Response(encodedEnvelope as unknown as BodyInit, {
                    status: 200,
                    headers: { 'x-db-etag': etag },
                })
            }
            throw new Error(`Unexpected request: ${String(input)}`)
        })
        vi.stubGlobal('fetch', fetchMock)
        ;(NodeStorage as any).databaseStorageCapabilities = {
            rawBootRead: true,
            atomicCreate: true,
            optimizedPluginStorageBootReconcile: true,
            rawBootByteLength,
        }

        await expect(readyStorage().readDatabaseForBoot()).resolves.toEqual({
            kind: 'decoded',
            database: {
                name: 'threshold-cached-boot',
                characters: [],
                botPresets: [],
                modules: [],
                personas: [],
            },
        })
        expect(cache.getVerifiedManifestSnapshot).toHaveBeenCalledTimes(5)
        expect(fetchMock).toHaveBeenCalledOnce()
        expect(fetchMock).toHaveBeenCalledWith(
            '/api/db/read-cached',
            expect.objectContaining({ method: 'POST' }),
        )
    })

    it('returns a verified cached database without awaiting best-effort persistence', async () => {
        const persistence = Promise.withResolvers<void>()
        cache.getVerifiedManifestSnapshot.mockResolvedValue({
            hashes: [],
            bytesByHash: new Map(),
        })
        cache.persistResourceCacheManifests.mockReturnValueOnce(persistence.promise)
        const etag = 'b'.repeat(32)
        const encodedEnvelope = encodeOwnedRawMsgpack({
            version: 1,
            etag,
            root: { bytes: encodeOwnedRawMsgpack({ name: 'cached-boot' }) },
            characters: [],
            botPresets: [],
            modules: [],
            personas: [],
        })
        vi.stubGlobal('fetch', vi.fn(async () => new Response(encodedEnvelope as unknown as BodyInit, {
            status: 200,
            headers: {
                'content-type': 'application/octet-stream',
                'x-db-etag': etag,
            },
        })))
        ;(NodeStorage as any).databaseStorageCapabilities = {
            rawBootRead: true,
            atomicCreate: true,
            optimizedPluginStorageBootReconcile: true,
            rawBootByteLength: null,
        }
        const storage = readyStorage()
        let result: Awaited<ReturnType<typeof storage.readDatabaseForBoot>> | undefined
        let failure: unknown

        try {
            void storage.readDatabaseForBoot().then(
                value => { result = value },
                error => { failure = error },
            )
            await vi.waitFor(() => {
                expect(failure).toBeUndefined()
                expect(result).toEqual({
                    kind: 'decoded',
                    database: {
                        name: 'cached-boot',
                        characters: [],
                        botPresets: [],
                        modules: [],
                        personas: [],
                    },
                })
                expect(cache.persistResourceCacheManifests).toHaveBeenCalledOnce()
            })
        } finally {
            persistence.resolve()
        }
    })

    it('falls back to the authoritative raw boot read before publishing an invalid cache envelope', async () => {
        cache.getVerifiedManifestSnapshot.mockResolvedValue({
            hashes: [],
            bytesByHash: new Map(),
        })
        const etag = 'c'.repeat(32)
        const malformedEnvelope = encodeOwnedRawMsgpack({
            version: 1,
            etag,
            // Array groups belong outside the root in this protocol.
            root: { bytes: encodeOwnedRawMsgpack({ characters: [] }) },
            characters: [],
            botPresets: [],
            modules: [],
            personas: [],
        })
        const authoritativeBytes = new Uint8Array([9, 8, 7])
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            if (String(input) === '/api/db/read-cached') {
                return new Response(malformedEnvelope as unknown as BodyInit, {
                    status: 200,
                    headers: { 'x-db-etag': etag },
                })
            }
            if (String(input) === '/api/db/read-raw-for-boot') {
                return new Response(authoritativeBytes as unknown as BodyInit, {
                    status: 200,
                    headers: { 'x-db-etag': 'd'.repeat(32) },
                })
            }
            throw new Error(`Unexpected request: ${String(input)}`)
        })
        vi.stubGlobal('fetch', fetchMock)
        ;(NodeStorage as any).databaseStorageCapabilities = {
            rawBootRead: true,
            atomicCreate: true,
            optimizedPluginStorageBootReconcile: true,
        }

        await expect(readyStorage().readDatabaseForBoot()).resolves.toEqual({
            kind: 'bytes',
            bytes: Buffer.from(authoritativeBytes),
        })
        expect(fetchMock).toHaveBeenCalledWith(
            '/api/db/read-raw-for-boot',
            expect.objectContaining({ method: 'GET' }),
        )
        expect(cache.persistResourceCacheManifests).not.toHaveBeenCalled()
    })

    it('uses the authoritative raw boot path when the server bypasses an oversized root', async () => {
        cache.getVerifiedManifestSnapshot.mockResolvedValue({
            hashes: [],
            bytesByHash: new Map(),
        })
        const authoritativeBytes = new Uint8Array([6, 5, 4])
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            if (String(input) === '/api/db/read-cached') {
                return new Response(JSON.stringify({
                    error: 'Database root exceeds the segmented cache value limit',
                    code: 'DATABASE_CACHE_ROOT_TOO_LARGE',
                }), {
                    status: 413,
                    headers: {
                        'content-type': 'application/json',
                        'x-pocketrisu-db-cache-bypass': 'oversized-root',
                    },
                })
            }
            if (String(input) === '/api/db/read-raw-for-boot') {
                return new Response(authoritativeBytes as unknown as BodyInit, {
                    status: 200,
                    headers: { 'x-db-etag': 'e'.repeat(32) },
                })
            }
            throw new Error(`Unexpected request: ${String(input)}`)
        })
        vi.stubGlobal('fetch', fetchMock)
        ;(NodeStorage as any).databaseStorageCapabilities = {
            rawBootRead: true,
            atomicCreate: true,
            optimizedPluginStorageBootReconcile: true,
        }

        await expect(readyStorage().readDatabaseForBoot()).resolves.toEqual({
            kind: 'bytes',
            bytes: Buffer.from(authoritativeBytes),
        })
        expect(fetchMock).toHaveBeenCalledWith(
            '/api/db/read-raw-for-boot',
            expect.objectContaining({ method: 'GET' }),
        )
        expect(cache.persistResourceCacheManifests).not.toHaveBeenCalled()
    })

    it('assigns legal large payloads a bounded transfer budget', () => {
        const timeoutMs = authoritativeStoragePayloadTimeoutMs(128 * 1024 * 1024)

        expect(timeoutMs).toBeGreaterThan(20_001)
        expect(timeoutMs).toBeLessThanOrEqual(AUTHORITATIVE_STORAGE_PAYLOAD_MAX_TIMEOUT_MS)
        expect(authoritativeStoragePayloadTimeoutMs(undefined))
            .toBe(AUTHORITATIVE_STORAGE_PAYLOAD_MAX_TIMEOUT_MS)
    })

    it('requests the dedicated main-compatible export target', async () => {
        const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
        }))
        vi.stubGlobal('fetch', fetchMock)
        const storage = readyStorage()

        await expect(storage.exportBackup({ target: 'main' })).resolves.toBeInstanceOf(Response)

        expect(fetchMock).toHaveBeenCalledWith(
            '/api/backup/export?target=main',
            expect.objectContaining({ headers: expect.any(Headers) }),
        )
    })

    it('surfaces a main-target compatibility rejection from the server', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            error: 'plugin keys are not representable by main',
        }), {
            status: 409,
            headers: { 'content-type': 'application/json' },
        })))
        const storage = readyStorage()

        await expect(storage.exportBackup({ target: 'main' })).rejects.toThrow(
            'plugin keys are not representable by main',
        )
    })

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

    it('bounds a stalled full export at the long-job ceiling', async () => {
        vi.useFakeTimers()
        let requestSignal: AbortSignal | undefined
        vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
            requestSignal = init?.signal ?? undefined
            return new Promise<Response>(() => undefined)
        }))
        const storage = readyStorage()

        const exported = storage.exportBackup().catch(error => error)
        await vi.advanceTimersByTimeAsync(AUTHORITATIVE_STORAGE_JOB_TIMEOUT_MS)

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
        await vi.advanceTimersByTimeAsync(AUTHORITATIVE_STORAGE_PAYLOAD_MAX_TIMEOUT_MS)

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
                rawKey: 'a',
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
            rows: [{ storageKey: 'pluginsave/YQ.json', rawKey: 'a', size: 3 }],
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

    it('keeps a valid storage write pending beyond 20,001ms', async () => {
        vi.useFakeTimers()
        let requestSignal: AbortSignal | undefined
        vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
            requestSignal = init?.signal ?? undefined
            return new Promise<Response>(resolve => {
                setTimeout(() => resolve(new Response(JSON.stringify({
                    hash: 'a'.repeat(64),
                }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                })), 20_002)
            })
        }))
        const storage = readyStorage()
        let settled = false

        const pending = storage.setItem(
            'pluginsave/alpha.json',
            new TextEncoder().encode('{"value":1}'),
        ).finally(() => { settled = true })
        await vi.advanceTimersByTimeAsync(20_001)

        expect(settled).toBe(false)
        expect(requestSignal?.aborted).toBe(false)

        await vi.advanceTimersByTimeAsync(1)
        await expect(pending).resolves.toBeUndefined()
        expect(requestSignal?.aborted).toBe(false)
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
        await vi.advanceTimersByTimeAsync(SMALL_PLUGIN_WRITE_TIMEOUT_MS)
        const error = await result

        expect(error).toBeInstanceOf(StorageError)
        expect(error).toMatchObject({
            code: 'COMMIT_OUTCOME_UNKNOWN',
            commitOutcomeUnknown: true,
            operation: 'write',
        })
        expect(requestSignal?.aborted).toBe(true)
    })

    it('classifies a timed-out chat save as commit-outcome unknown', async () => {
        vi.useFakeTimers()
        cache.enabled = false
        const encoded = new Uint8Array([1, 2, 3])
        vi.mocked(encodeRisuSaveLegacy).mockReturnValue(encoded)
        let requestSignal: AbortSignal | undefined
        vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
            requestSignal = init?.signal ?? undefined
            return new Promise<Response>(() => undefined)
        }))
        const storage = readyStorage()

        const result = storage.saveChatContent('character', 0, 'chat', {})
            .catch(error => error)
        await vi.advanceTimersByTimeAsync(
            authoritativeStoragePayloadTimeoutMs(encoded.byteLength),
        )

        await expect(result).resolves.toMatchObject({
            code: 'COMMIT_OUTCOME_UNKNOWN',
            commitOutcomeUnknown: true,
            retryable: false,
            operation: 'write',
        })
        expect(requestSignal?.aborted).toBe(true)
    })

    it('accepts the original PocketRisu chat-save acknowledgement without a hash', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            success: true,
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })))
        const storage = readyStorage()

        await expect(storage.saveChatContent('character', 0, 'chat', {}))
            .resolves.toBeUndefined()
        expect(cache.storeBytes).not.toHaveBeenCalled()
        expect(cache.storeOwnedBytesWithKnownHash).not.toHaveBeenCalled()
    })

    it('donates the exact encoded chat bytes only after a matching acknowledgement hash', async () => {
        const encoded = new Uint8Array([7, 8, 9])
        const hash = 'b'.repeat(64)
        codec.prepareChatRowCheckpoint.mockResolvedValueOnce({
            bytes: encoded,
            hash,
            patch: null,
            snapshot: { name: 'checkpoint' },
        })
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            success: true,
            hash,
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })))
        const storage = readyStorage()

        await storage.saveChatContent('character', 0, 'chat', { name: 'checkpoint' })

        expect(codec.prepareChatRowCheckpoint).toHaveBeenCalledWith(
            null,
            { name: 'checkpoint' },
        )
        expect(cache.storeOwnedBytesWithKnownHash).toHaveBeenCalledWith(
            'chat:character/chat',
            hash,
            encoded,
        )
        expect(cache.storeBytes).not.toHaveBeenCalled()
    })

    it('uploads a delta only after an exact base acknowledgement and verifies its logical hash', async () => {
        cache.enabled = false
        const baseHash = 'a'.repeat(64)
        const resultHash = 'b'.repeat(64)
        const base = { message: [{ data: 'base' }] }
        const result = { message: [{ data: 'edited' }] }
        codec.prepareChatRowCheckpoint
            .mockResolvedValueOnce({
                bytes: new Uint8Array(2_048),
                hash: baseHash,
                patch: null,
                snapshot: base,
            })
            .mockResolvedValueOnce({
                bytes: new Uint8Array(2_048),
                hash: resultHash,
                patch: [{ op: 'replace', path: '/message/0', value: result.message[0] }],
                snapshot: result,
            })
        const requests: RequestInit[] = []
        vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            requests.push(init ?? {})
            const hash = requests.length === 1 ? baseHash : resultHash
            return new Response(JSON.stringify({ success: true, hash }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        }))
        const storage = readyStorage()

        await storage.saveChatContent('character', 0, 'chat', base)
        await storage.saveChatContent('character', 0, 'chat', result)

        expect(requests).toHaveLength(2)
        expect(new Headers(requests[1].headers).get('content-type'))
            .toBe('application/vnd.pocketrisu.chat-delta+json')
        expect(JSON.parse(requests[1].body as string)).toEqual({
            version: 1,
            baseHash,
            resultHash,
            resultSize: 2_048,
            patch: [{ op: 'replace', path: '/message/0', value: result.message[0] }],
        })
        expect(codec.prepareChatRowCheckpoint).toHaveBeenNthCalledWith(2, base, result)
    })

    it('never pairs a projected acknowledged base with the hash of old-format bytes', async () => {
        cache.enabled = false
        const oldHash = '1'.repeat(64)
        const firstHash = '2'.repeat(64)
        const secondHash = '3'.repeat(64)
        const oldBytes = new Uint8Array([9, 8, 7])
        const oldBase = {
            id: 'chat',
            message: [{ data: 'old-format' }],
            isStreaming: true,
            activeStreamingDisplayOptimizationMode: 'streaming',
        }
        const firstLive = {
            ...oldBase,
            message: [{ data: 'checkpoint' }],
            isStreaming: false,
        }
        const firstProjected = {
            id: 'chat',
            message: [{ data: 'checkpoint' }],
        }
        const secondLive = {
            ...firstLive,
            message: [{ data: 'final' }],
        }
        const secondProjected = {
            id: 'chat',
            message: [{ data: 'final' }],
        }
        cache.sha256Bytes.mockResolvedValueOnce(oldHash)
        vi.mocked(decodeRisuSave).mockResolvedValueOnce(structuredClone(oldBase) as any)
        codec.prepareChatRowCheckpoint
            .mockResolvedValueOnce({
                bytes: new Uint8Array(2_048),
                hash: firstHash,
                patch: null,
                snapshot: firstProjected,
            })
            .mockResolvedValueOnce({
                bytes: new Uint8Array(2_048),
                hash: secondHash,
                patch: [{
                    op: 'replace',
                    path: '/message/0',
                    value: secondProjected.message[0],
                }],
                snapshot: secondProjected,
            })
        const posts: RequestInit[] = []
        vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            if (!init?.method || init.method === 'GET') {
                return new Response(oldBytes as unknown as BodyInit, {
                    status: 200,
                    headers: { 'x-content-hash': oldHash },
                })
            }
            posts.push(init)
            const hash = posts.length === 1 ? firstHash : secondHash
            return new Response(JSON.stringify({ success: true, hash }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        }))
        const storage = readyStorage()
        const acknowledgementKey = JSON.stringify(['character', 'chat'])

        await expect(storage.fetchChatContent('character', 0, 'chat'))
            .resolves.toEqual(oldBase)
        expect((storage as any).acknowledgedChatRows.get(acknowledgementKey)).toEqual({
            hash: oldHash,
            chat: oldBase,
        })

        await storage.saveChatContent('character', 0, 'chat', firstLive)
        expect(codec.prepareChatRowCheckpoint).toHaveBeenNthCalledWith(1, oldBase, firstLive)
        expect(new Headers(posts[0].headers).get('content-type'))
            .toBe('application/octet-stream')
        expect((storage as any).acknowledgedChatRows.get(acknowledgementKey)).toEqual({
            hash: firstHash,
            chat: firstProjected,
        })

        await storage.saveChatContent('character', 0, 'chat', secondLive)
        expect(codec.prepareChatRowCheckpoint).toHaveBeenNthCalledWith(
            2,
            firstProjected,
            secondLive,
        )
        expect(new Headers(posts[1].headers).get('content-type'))
            .toBe('application/vnd.pocketrisu.chat-delta+json')
        expect(JSON.parse(posts[1].body as string)).toMatchObject({
            baseHash: firstHash,
            resultHash: secondHash,
        })
        expect((storage as any).acknowledgedChatRows.get(acknowledgementKey)).toEqual({
            hash: secondHash,
            chat: secondProjected,
        })
    })

    it('retries the prepared full row after a definitive delta refusal', async () => {
        cache.enabled = false
        const baseHash = 'a'.repeat(64)
        const resultHash = 'b'.repeat(64)
        const base = { message: [{ data: 'base' }] }
        const result = { message: [{ data: 'edited' }] }
        const fullBytes = new Uint8Array(2_048)
        codec.prepareChatRowCheckpoint
            .mockResolvedValueOnce({
                bytes: fullBytes,
                hash: baseHash,
                patch: null,
                snapshot: base,
            })
            .mockResolvedValueOnce({
                bytes: fullBytes,
                hash: resultHash,
                patch: [{ op: 'replace', path: '/message/0', value: result.message[0] }],
                snapshot: result,
            })
        const requests: RequestInit[] = []
        vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            requests.push(init ?? {})
            if (requests.length === 1) {
                return new Response(JSON.stringify({ success: true, hash: baseHash }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                })
            }
            if (requests.length === 2) {
                return new Response(JSON.stringify({
                    success: false,
                    error: 'stale base',
                    code: 'CHAT_DELTA_BASE_MISMATCH',
                    retryable: false,
                    commitOutcome: 'not-committed',
                    commitOutcomeUnknown: false,
                }), {
                    status: 409,
                    headers: { 'content-type': 'application/json' },
                })
            }
            return new Response(JSON.stringify({ success: true, hash: resultHash }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        }))
        const storage = readyStorage()

        await storage.saveChatContent('character', 0, 'chat', base)
        await storage.saveChatContent('character', 0, 'chat', result)

        expect(requests).toHaveLength(3)
        expect(new Headers(requests[1].headers).get('content-type'))
            .toBe('application/vnd.pocketrisu.chat-delta+json')
        expect(new Headers(requests[2].headers).get('content-type'))
            .toBe('application/octet-stream')
        expect(requests[2].body).toBe(fullBytes)
    })

    it('retries the full row when a successful delta acknowledgement has the wrong digest', async () => {
        cache.enabled = false
        const baseHash = 'a'.repeat(64)
        const resultHash = 'b'.repeat(64)
        const base = { message: [{ data: 'base' }] }
        const result = { message: [{ data: 'result' }] }
        const bytes = new Uint8Array(2_048)
        codec.prepareChatRowCheckpoint
            .mockResolvedValueOnce({ bytes, hash: baseHash, patch: null, snapshot: base })
            .mockResolvedValueOnce({
                bytes,
                hash: resultHash,
                patch: [{ op: 'replace', path: '/message/0', value: result.message[0] }],
                snapshot: result,
            })
        const requests: RequestInit[] = []
        vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            requests.push(init ?? {})
            const hash = requests.length === 1
                ? baseHash
                : requests.length === 2
                    ? 'c'.repeat(64)
                    : resultHash
            return new Response(JSON.stringify({ success: true, hash }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        }))
        const storage = readyStorage()

        await storage.saveChatContent('character', 0, 'chat', base)
        await storage.saveChatContent('character', 0, 'chat', result)

        expect(requests).toHaveLength(3)
        expect(new Headers(requests[1].headers).get('content-type'))
            .toBe('application/vnd.pocketrisu.chat-delta+json')
        expect(new Headers(requests[2].headers).get('content-type'))
            .toBe('application/octet-stream')
    })

    it('classifies a timed-out bulk asset write as commit-outcome unknown', async () => {
        vi.useFakeTimers()
        const value = new Uint8Array([1, 2, 3])
        const requestBody = JSON.stringify([{
            key: 'assets/example',
            value: Buffer.from(value).toString('base64'),
        }])
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)))
        const storage = readyStorage()

        const result = storage.setItems([{ key: 'assets/example', value }])
            .catch(error => error)
        await vi.advanceTimersByTimeAsync(authoritativeStoragePayloadTimeoutMs(
            new TextEncoder().encode(requestBody).byteLength,
        ))

        await expect(result).resolves.toMatchObject({
            code: 'COMMIT_OUTCOME_UNKNOWN',
            commitOutcomeUnknown: true,
            retryable: false,
            operation: 'write',
        })
    })

    it('classifies a timed-out cleanup as commit-outcome unknown', async () => {
        vi.useFakeTimers()
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)))
        const storage = readyStorage()

        const result = storage.executeCleanup().catch(error => error)
        await vi.advanceTimersByTimeAsync(AUTHORITATIVE_STORAGE_JOB_TIMEOUT_MS)

        await expect(result).resolves.toMatchObject({
            code: 'COMMIT_OUTCOME_UNKNOWN',
            commitOutcomeUnknown: true,
            retryable: false,
            operation: 'remove',
        })
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
        await vi.advanceTimersByTimeAsync(SMALL_PLUGIN_WRITE_TIMEOUT_MS)
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
        await vi.advanceTimersByTimeAsync(SMALL_PLUGIN_WRITE_TIMEOUT_MS)
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
        await vi.advanceTimersByTimeAsync(SMALL_PLUGIN_WRITE_TIMEOUT_MS)
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
        await vi.advanceTimersByTimeAsync(SMALL_PLUGIN_WRITE_TIMEOUT_MS)
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
        await vi.advanceTimersByTimeAsync(AUTHORITATIVE_STORAGE_JOB_TIMEOUT_MS)
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
        await vi.advanceTimersByTimeAsync(AUTHORITATIVE_STORAGE_JOB_TIMEOUT_MS)
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
        await vi.advanceTimersByTimeAsync(SMALL_PLUGIN_WRITE_TIMEOUT_MS)
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
        await vi.advanceTimersByTimeAsync(SMALL_PLUGIN_WRITE_TIMEOUT_MS)
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
