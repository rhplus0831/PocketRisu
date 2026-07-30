import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cache = vi.hoisted(() => ({
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
    isResourceCacheEnabled: () => false,
    isSha256Hex: (value: unknown) =>
        typeof value === 'string' && /^[0-9a-f]{64}$/.test(value),
    persistResourceCacheManifests: vi.fn(async () => undefined),
    sha256Bytes: cache.sha256Bytes,
    sha256OwnedBytes: cache.sha256OwnedBytes,
    settleBestEffortResourceCache: async <T>(operation: Promise<T>, fallback: T) => {
        try {
            return await operation
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
    AUTHORITATIVE_STORAGE_METADATA_TIMEOUT_MS,
    NodeStorage,
} = await import('./nodeStorage')
const { StorageError } = await import('./storageError')

const TRANSITION_ID = '123e4567-e89b-42d3-a456-426614174100'
const TARGET_GENERATION = '123e4567-e89b-42d3-a456-426614174101'

function readyStorage(): InstanceType<typeof NodeStorage> {
    const storage = new NodeStorage()
    storage.authChecked = true
    ;(NodeStorage as any).sessionInitialized = true
    vi.spyOn(storage, 'createAuth').mockResolvedValue('test-token')
    return storage
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    })
}

function transitionStatus(
    state: 'uploading' | 'ready' | 'committed' | 'aborted' | string,
    transitionId = TRANSITION_ID,
): Record<string, unknown> {
    return {
        success: true,
        transitionId,
        state,
        direction: 'externalize',
        targetGeneration: TARGET_GENERATION,
        rows: [],
        uploaded: 0,
        total: 0,
        totalBytes: 0,
        ...(state === 'committed' ? { etag: 'a'.repeat(32) } : {}),
    }
}

const unuploadedRow = {
    storageKey: 'pluginsave/YQ.json',
    size: 3,
    sha256: 'a'.repeat(64),
    uploaded: false,
}

function stalledAcknowledgement(): Response {
    const response = new Response(null, { status: 200 })
    vi.spyOn(response, 'json').mockImplementation(
        () => new Promise<never>(() => undefined),
    )
    return response
}

function expectCommitOutcomeUnknown(error: unknown): void {
    expect(error).toBeInstanceOf(StorageError)
    expect(error).toMatchObject({
        code: 'COMMIT_OUTCOME_UNKNOWN',
        commitOutcomeUnknown: true,
        retryable: false,
        operation: 'transition',
    })
    expect((error as Error).cause).toBeInstanceOf(AggregateError)
}

beforeEach(() => {
    vi.clearAllMocks()
    ;(NodeStorage as any).sessionInitialized = false
    ;(NodeStorage as any).sessionPending = null
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

describe('NodeStorage staged finalize ambiguity', () => {
    it('accepts only the exact missing-stage abort tombstone as definitive', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
            success: true,
            transitionId: TRANSITION_ID,
            state: 'aborted',
        })))
        const storage = readyStorage()

        await expect(storage.abortPluginStorageTransition(TRANSITION_ID)).resolves.toEqual({
            success: true,
            transitionId: TRANSITION_ID,
            state: 'aborted',
        })
    })

    it('resolves a lost abort acknowledgement through one idempotent tombstone retry', async () => {
        const fetchMock = vi.fn()
            .mockRejectedValueOnce(new TypeError('abort acknowledgement lost'))
            .mockResolvedValueOnce(jsonResponse({
                success: true,
                transitionId: TRANSITION_ID,
                state: 'aborted',
            }))
        vi.stubGlobal('fetch', fetchMock)
        const storage = readyStorage()

        await expect(storage.abortPluginStorageTransition(TRANSITION_ID)).resolves.toMatchObject({
            state: 'aborted',
        })
        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith('/abort'))).toBe(true)
    })

    it.each([
        ['extra status field', { ...transitionStatus('ready'), unexpected: true }],
        ['ready with an etag', { ...transitionStatus('ready'), etag: 'a'.repeat(32) }],
        ['aborted with an etag', { ...transitionStatus('aborted'), etag: 'a'.repeat(32) }],
        ['uploading with no outstanding row', transitionStatus('uploading')],
        ['uploading while internalizing', {
            ...transitionStatus('uploading'),
            direction: 'internalize',
            rows: [unuploadedRow],
            total: 1,
            totalBytes: 3,
        }],
        ['unuploaded row without an authoritative hash', {
            ...transitionStatus('uploading'),
            rows: [{ ...unuploadedRow, sha256: null }],
            total: 1,
            totalBytes: 3,
        }],
        ['committed with an unuploaded row', {
            ...transitionStatus('committed'),
            rows: [unuploadedRow],
            total: 1,
            totalBytes: 3,
        }],
    ])('rejects %s', async (_name, invalidStatus) => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(invalidStatus)))
        const storage = readyStorage()

        await expect(storage.getPluginStorageTransitionStatus(TRANSITION_ID))
            .rejects.toMatchObject({ code: 'STORAGE_RESPONSE_ERROR' })
    })

    it.each([
        ['wrong key', {
            storageKey: 'pluginsave/Yg.json', size: 3, sha256: 'a'.repeat(64), uploaded: true,
        }],
        ['wrong size', {
            storageKey: 'pluginsave/YQ.json', size: 4, sha256: 'a'.repeat(64), uploaded: true,
        }],
        ['wrong hash', {
            storageKey: 'pluginsave/YQ.json', size: 3, sha256: 'b'.repeat(64), uploaded: true,
        }],
        ['not uploaded', {
            storageKey: 'pluginsave/YQ.json', size: 3, sha256: 'a'.repeat(64), uploaded: false,
        }],
    ])('does not trust a staged upload acknowledgement with %s', async (_name, row) => {
        const status = {
            ...transitionStatus('ready'),
            rows: [row],
            uploaded: row.uploaded ? 1 : 0,
            total: 1,
            totalBytes: row.size,
        }
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(status)))
        const storage = readyStorage()

        await expect(storage.uploadPluginStorageTransitionRow(
            TRANSITION_ID,
            'pluginsave/YQ.json',
            new Uint8Array([34, 97, 34]),
        )).rejects.toMatchObject({
            code: 'COMMIT_OUTCOME_UNKNOWN',
            commitOutcomeUnknown: true,
        })
    })

    it('preserves ambiguity when both finalize and its status lookup time out', async () => {
        vi.useFakeTimers()
        const fetchMock = vi.fn((input: RequestInfo | URL) => {
            if (String(input).endsWith('/finalize')) {
                return Promise.resolve(stalledAcknowledgement())
            }
            if (String(input).endsWith('/status')) {
                return new Promise<Response>(() => undefined)
            }
            throw new Error(`Unexpected request: ${String(input)}`)
        })
        vi.stubGlobal('fetch', fetchMock)
        const storage = readyStorage()

        const result = storage.finalizePluginStorageTransition(TRANSITION_ID)
            .catch(error => error)
        await vi.advanceTimersByTimeAsync(AUTHORITATIVE_STORAGE_JOB_TIMEOUT_MS)
        await vi.advanceTimersByTimeAsync(AUTHORITATIVE_STORAGE_METADATA_TIMEOUT_MS)

        expectCommitOutcomeUnknown(await result)
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it.each([
        {
            name: 'network failure',
            statusResult: () => Promise.reject(new TypeError('status network unavailable')),
        },
        {
            name: 'structured 404 after receipt loss or restart',
            statusResult: () => Promise.resolve(jsonResponse({ error: 'Transition not found' }, 404)),
        },
        {
            name: 'deactivated writer session',
            statusResult: () => Promise.resolve(jsonResponse({ error: 'Session deactivated' }, 423)),
        },
        {
            name: 'malformed success body',
            statusResult: () => Promise.resolve(jsonResponse({ success: true })),
        },
        {
            name: 'mismatched transition id',
            statusResult: () => Promise.resolve(jsonResponse(transitionStatus(
                'committed',
                '123e4567-e89b-42d3-a456-426614174199',
            ))),
        },
        {
            name: 'unknown transition state',
            statusResult: () => Promise.resolve(jsonResponse(transitionStatus('future-state'))),
        },
    ])('preserves ambiguity when status has $name', async ({ statusResult }) => {
        vi.useFakeTimers()
        const fetchMock = vi.fn((input: RequestInfo | URL) => {
            if (String(input).endsWith('/finalize')) {
                return Promise.resolve(stalledAcknowledgement())
            }
            if (String(input).endsWith('/status')) return statusResult()
            throw new Error(`Unexpected request: ${String(input)}`)
        })
        vi.stubGlobal('fetch', fetchMock)
        const storage = readyStorage()

        const result = storage.finalizePluginStorageTransition(TRANSITION_ID)
            .catch(error => error)
        await vi.advanceTimersByTimeAsync(AUTHORITATIVE_STORAGE_JOB_TIMEOUT_MS)

        expectCommitOutcomeUnknown(await result)
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('resolves a generic finalize 500 through a committed status', async () => {
        const fetchMock = vi.fn((input: RequestInfo | URL) => {
            if (String(input).endsWith('/finalize')) {
                return Promise.resolve(jsonResponse({ error: 'post-commit receipt failed' }, 500))
            }
            if (String(input).endsWith('/status')) {
                return Promise.resolve(jsonResponse(transitionStatus('committed')))
            }
            throw new Error(`Unexpected request: ${String(input)}`)
        })
        vi.stubGlobal('fetch', fetchMock)
        const storage = readyStorage()

        await expect(storage.finalizePluginStorageTransition(TRANSITION_ID)).resolves.toMatchObject({
            transitionId: TRANSITION_ID,
            state: 'committed',
            etag: 'a'.repeat(32),
        })
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('keeps a generic finalize 500 ambiguous when status is unavailable', async () => {
        const fetchMock = vi.fn((input: RequestInfo | URL) => {
            if (String(input).endsWith('/finalize')) {
                return Promise.resolve(jsonResponse({ error: 'post-commit receipt failed' }, 500))
            }
            if (String(input).endsWith('/status')) {
                return Promise.resolve(jsonResponse({ error: 'Transition not found' }, 404))
            }
            throw new Error(`Unexpected request: ${String(input)}`)
        })
        vi.stubGlobal('fetch', fetchMock)
        const storage = readyStorage()

        const error = await storage.finalizePluginStorageTransition(TRANSITION_ID)
            .catch(cause => cause)

        expectCommitOutcomeUnknown(error)
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('classifies an authoritative ready status as definitively not committed', async () => {
        const fetchMock = vi.fn((input: RequestInfo | URL) => {
            if (String(input).endsWith('/finalize')) {
                return Promise.resolve(jsonResponse({ error: 'unknown finalize failure' }, 500))
            }
            if (String(input).endsWith('/status')) {
                return Promise.resolve(jsonResponse(transitionStatus('ready')))
            }
            throw new Error(`Unexpected request: ${String(input)}`)
        })
        vi.stubGlobal('fetch', fetchMock)
        const storage = readyStorage()

        const error = await storage.finalizePluginStorageTransition(TRANSITION_ID)
            .catch(cause => cause)

        expect(error).toBeInstanceOf(StorageError)
        expect(error).toMatchObject({
            code: 'PLUGIN_STORAGE_TRANSITION_NOT_COMMITTED',
            commitOutcomeUnknown: false,
            retryable: true,
            operation: 'transition',
        })
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })
})
