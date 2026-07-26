import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createHash } from 'node:crypto'

const cache = vi.hoisted(() => ({
    invalidateResourceCacheManifest: vi.fn(async () => undefined),
    storeBytes: vi.fn(async () => 'hash'),
}))

vi.mock('src/lang', () => ({ language: {} }))
vi.mock('../alert', () => ({
    alertInput: vi.fn(),
    notifyError: vi.fn(),
    waitAlert: vi.fn(),
}))
vi.mock('./database.svelte', () => ({ normalizeChat: (value: unknown) => value }))
vi.mock('./risuSave', () => ({
    decodeRisuSave: vi.fn(),
    encodeRisuSaveLegacy: vi.fn(),
}))
vi.mock('./dbCachedRead', () => ({
    DB_CACHE_GROUPS: [],
    DB_CACHE_MAX_HASHES: 0,
    decodeAndAssembleCachedDbRead: vi.fn(),
}))
vi.mock('./resourceCache', () => ({
    getManifestHashes: vi.fn(async () => []),
    getVerifiedManifestSnapshot: vi.fn(async () => null),
    getVerifiedCachedBytes: vi.fn(async () => null),
    invalidateResourceCacheManifest: cache.invalidateResourceCacheManifest,
    isResourceCacheEnabled: vi.fn(() => true),
    isSha256Hex: vi.fn((value: unknown) => typeof value === 'string'),
    persistResourceCacheManifests: vi.fn(async () => undefined),
    sha256Bytes: vi.fn(async (bytes: Uint8Array) => {
        const { createHash } = await import('node:crypto')
        return createHash('sha256').update(bytes).digest('hex')
    }),
    storeBytes: cache.storeBytes,
    touchResourceCacheManifest: vi.fn(async () => undefined),
}))

const {
    AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS,
    NodeStorage,
} = await import('./nodeStorage')

const valueKey = 'pluginsave/YWE.json'
const valueBytes = new TextEncoder().encode('{"generation":"new"}')
const valueHash = createHash('sha256').update(valueBytes).digest('hex')

function response(
    body: unknown,
    status = 200,
    headers: Record<string, string> = {},
): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    })
}

function importBusy(retryAfter = '0'): Response {
    return response({
        success: false,
        outcome: 'not-committed',
        operation: 'set',
        code: 'IMPORT_IN_PROGRESS',
        error: 'endpoint rejected before commit',
        retryable: true,
    }, 503, { 'retry-after': retryAfter })
}

function committedSet(): Response {
    return response({
        success: true,
        outcome: 'committed',
        operation: 'set',
        verification: 'verified',
        hash: valueHash,
    })
}

function storageWithResponse(next: Response | Error): InstanceType<typeof NodeStorage> {
    const storage = new NodeStorage()
    ;(storage as any).authFetch = next instanceof Error
        ? vi.fn(async (
            _input: RequestInfo | URL,
            _init: RequestInit,
            _retry: boolean,
            outcome: { markRequestDispatched: () => void },
        ) => {
            outcome.markRequestDispatched()
            throw next
        })
        : vi.fn(async () => next)
    return storage
}

beforeEach(() => {
    cache.storeBytes.mockClear()
    cache.invalidateResourceCacheManifest.mockClear()
})

afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

describe('NodeStorage atomic plugin mutation cache publication', () => {
    test.each(['owner-write', 'primary-write'])(
        '%s rollback leaves the previous value cache untouched',
        async () => {
            const storage = storageWithResponse(response({
                success: false,
                outcome: 'not-committed',
                operation: 'set',
                code: 'PLUGIN_STORAGE_TRANSACTION_ROLLED_BACK',
                error: 'Plugin storage transaction rolled back.',
                retryable: false,
            }, 500))

            await expect(storage.mutatePluginStorage({
                operation: 'set',
                valueKey,
                valueBytes,
                owner: 'Plugin',
            })).resolves.toMatchObject({ outcome: 'not-committed' })
            expect(cache.storeBytes).not.toHaveBeenCalled()
            expect(cache.invalidateResourceCacheManifest).not.toHaveBeenCalled()
        },
    )

    test('owner-remove rollback leaves the existing cache manifest untouched', async () => {
        const storage = storageWithResponse(response({
            success: false,
            outcome: 'not-committed',
            operation: 'remove',
            code: 'PLUGIN_STORAGE_TRANSACTION_ROLLED_BACK',
            error: 'Plugin storage transaction rolled back.',
            retryable: false,
        }, 500))

        await expect(storage.mutatePluginStorage({
            operation: 'remove',
            valueKey,
        })).resolves.toMatchObject({ outcome: 'not-committed' })
        expect(cache.storeBytes).not.toHaveBeenCalled()
        expect(cache.invalidateResourceCacheManifest).not.toHaveBeenCalled()
    })

    test('verification-read failure publishes the known committed value bytes', async () => {
        const storage = storageWithResponse(response({
            success: true,
            outcome: 'committed',
            operation: 'set',
            verification: 'unavailable',
            hash: valueHash,
        }))

        await expect(storage.mutatePluginStorage({
            operation: 'set',
            valueKey,
            valueBytes,
            owner: 'Plugin',
        })).resolves.toMatchObject({
            outcome: 'committed',
            verification: 'unavailable',
        })
        expect(cache.storeBytes).toHaveBeenCalledWith(`kv:${valueKey}`, valueBytes)
        expect(cache.invalidateResourceCacheManifest).not.toHaveBeenCalled()
    })

    test('wrong-but-valid committed set hash is unknown and cannot publish cache', async () => {
        const storage = storageWithResponse(response({
            success: true,
            outcome: 'committed',
            operation: 'set',
            verification: 'verified',
            hash: 'f'.repeat(64),
        }))

        await expect(storage.mutatePluginStorage({
            operation: 'set',
            valueKey,
            valueBytes,
            owner: 'Plugin',
        })).resolves.toMatchObject({
            outcome: 'unknown',
            code: 'ACKNOWLEDGEMENT_UNKNOWN',
        })
        expect(cache.storeBytes).not.toHaveBeenCalled()
        expect(cache.invalidateResourceCacheManifest).not.toHaveBeenCalled()
    })

    test('known committed remove invalidates the value manifest', async () => {
        const storage = storageWithResponse(response({
            success: true,
            outcome: 'committed',
            operation: 'remove',
            verification: 'verified',
        }))

        await storage.mutatePluginStorage({ operation: 'remove', valueKey })

        expect(cache.invalidateResourceCacheManifest).toHaveBeenCalledWith(`kv:${valueKey}`)
        expect(cache.storeBytes).not.toHaveBeenCalled()
    })

    test.each([
        [400, 'INVALID_PLUGIN_STORAGE_MUTATION', false],
        [500, 'PLUGIN_STORAGE_TRANSACTION_ROLLED_BACK', false],
    ] as const)(
        'trusts explicit %i/%s not-committed acknowledgement',
        async (status, code, retryable) => {
            const storage = storageWithResponse(response({
                success: false,
                outcome: 'not-committed',
                operation: 'set',
                code,
                error: 'endpoint rejected before commit',
                retryable,
            }, status))

            await expect(storage.mutatePluginStorage({
                operation: 'set',
                valueKey,
                valueBytes,
                owner: 'Plugin',
            })).resolves.toMatchObject({
                outcome: 'not-committed',
                code,
                retryable,
            })
            expect(cache.storeBytes).not.toHaveBeenCalled()
            expect(cache.invalidateResourceCacheManifest).not.toHaveBeenCalled()
        },
    )

    test('retries an exact import refusal and returns the later committed acknowledgement', async () => {
        const storage = new NodeStorage()
        const authFetch = vi.fn()
            .mockResolvedValueOnce(importBusy())
            .mockResolvedValueOnce(committedSet())
        ;(storage as any).authFetch = authFetch

        await expect(storage.mutatePluginStorage({
            operation: 'set',
            valueKey,
            valueBytes,
            owner: 'Plugin',
        })).resolves.toMatchObject({ outcome: 'committed' })
        expect(authFetch).toHaveBeenCalledTimes(2)
    })

    test('returns the structured import refusal after exhausting the fixed retry bound', async () => {
        const storage = new NodeStorage()
        const authFetch = vi.fn()
            .mockResolvedValueOnce(importBusy())
            .mockResolvedValueOnce(importBusy())
            .mockResolvedValueOnce(importBusy())
        ;(storage as any).authFetch = authFetch

        await expect(storage.mutatePluginStorage({
            operation: 'set',
            valueKey,
            valueBytes,
            owner: 'Plugin',
        })).resolves.toMatchObject({
            outcome: 'not-committed',
            status: 503,
            code: 'IMPORT_IN_PROGRESS',
            retryAfter: 0,
            retryable: true,
            commitOutcomeUnknown: false,
        })
        expect(authFetch).toHaveBeenCalledTimes(3)
    })

    test('cancels an import retry delay without launching a late attempt', async () => {
        vi.useFakeTimers()
        const storage = new NodeStorage()
        const authFetch = vi.fn()
            .mockResolvedValueOnce(importBusy('5'))
            .mockResolvedValueOnce(committedSet())
        ;(storage as any).authFetch = authFetch
        const controller = new AbortController()

        const pending = storage.mutatePluginStorage({
            operation: 'set',
            valueKey,
            valueBytes,
            owner: 'Plugin',
        }, controller.signal)
        await vi.advanceTimersByTimeAsync(0)
        expect(authFetch).toHaveBeenCalledOnce()

        controller.abort()
        await expect(pending).resolves.toMatchObject({
            outcome: 'not-committed',
            commitOutcomeUnknown: false,
        })
        await vi.advanceTimersByTimeAsync(10_000)
        expect(authFetch).toHaveBeenCalledOnce()
    })

    test('never retries a malformed 503 acknowledgement whose outcome is unknown', async () => {
        const storage = new NodeStorage()
        const authFetch = vi.fn()
            .mockResolvedValueOnce(response({ error: 'proxy body' }, 503))
            .mockResolvedValueOnce(committedSet())
        ;(storage as any).authFetch = authFetch

        await expect(storage.mutatePluginStorage({
            operation: 'set',
            valueKey,
            valueBytes,
            owner: 'Plugin',
        })).resolves.toMatchObject({
            outcome: 'unknown',
            code: 'ACKNOWLEDGEMENT_UNKNOWN',
        })
        expect(authFetch).toHaveBeenCalledOnce()
    })

    test('classifies an initial auth failure before dispatch as known not committed', async () => {
        const storage = new NodeStorage()
        const fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)
        ;(storage as any).checkAuth = vi.fn(async () => {
            throw new Error('initial auth unavailable')
        })

        await expect(storage.mutatePluginStorage({
            operation: 'set',
            valueKey,
            valueBytes,
            owner: 'Plugin',
        })).resolves.toMatchObject({
            outcome: 'not-committed',
            code: 'STORAGE_TRANSPORT_ERROR',
            retryable: true,
            commitOutcomeUnknown: false,
        })
        expect(fetchMock).not.toHaveBeenCalled()
    })

    test('classifies an auth-refresh failure after a definitive 401 as known not committed', async () => {
        const storage = new NodeStorage()
        const checkAuth = vi.fn()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('refresh unavailable'))
        ;(storage as any).checkAuth = checkAuth
        vi.spyOn(storage, 'createAuth').mockResolvedValue('test-token')
        const fetchMock = vi.fn(async () => response({ error: 'Token Expired' }, 401))
        vi.stubGlobal('fetch', fetchMock)

        await expect(storage.mutatePluginStorage({
            operation: 'set',
            valueKey,
            valueBytes,
            owner: 'Plugin',
        })).resolves.toMatchObject({
            outcome: 'not-committed',
            code: 'STORAGE_TRANSPORT_ERROR',
            commitOutcomeUnknown: false,
        })
        expect(fetchMock).toHaveBeenCalledOnce()
        expect(checkAuth).toHaveBeenCalledTimes(2)
    })

    test('bounds a stalled pre-dispatch auth check as known not committed', async () => {
        vi.useFakeTimers()
        const storage = new NodeStorage()
        const fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)
        ;(storage as any).checkAuth = vi.fn(() => new Promise<never>(() => undefined))

        const pending = storage.mutatePluginStorage({
            operation: 'set',
            valueKey,
            valueBytes,
            owner: 'Plugin',
        })
        await vi.advanceTimersByTimeAsync(AUTHORITATIVE_STORAGE_IO_TIMEOUT_MS)

        await expect(pending).resolves.toMatchObject({
            outcome: 'not-committed',
            code: 'STORAGE_TIMEOUT',
            retryable: true,
            commitOutcomeUnknown: false,
        })
        expect(fetchMock).not.toHaveBeenCalled()
    })

    test('transport loss reports unknown and does not speculate about cache state', async () => {
        const storage = storageWithResponse(new Error('connection reset'))

        await expect(storage.mutatePluginStorage({
            operation: 'set',
            valueKey,
            valueBytes,
            owner: 'Plugin',
        })).resolves.toMatchObject({
            outcome: 'unknown',
            code: 'COMMIT_OUTCOME_UNKNOWN',
            commitOutcomeUnknown: true,
        })
        expect(cache.storeBytes).not.toHaveBeenCalled()
        expect(cache.invalidateResourceCacheManifest).not.toHaveBeenCalled()
    })

    test('remove transport loss reports unknown and retains the cache manifest', async () => {
        const storage = storageWithResponse(new Error('connection reset'))

        await expect(storage.mutatePluginStorage({
            operation: 'remove',
            valueKey,
        })).resolves.toMatchObject({
            outcome: 'unknown',
            code: 'COMMIT_OUTCOME_UNKNOWN',
            commitOutcomeUnknown: true,
        })
        expect(cache.storeBytes).not.toHaveBeenCalled()
        expect(cache.invalidateResourceCacheManifest).not.toHaveBeenCalled()
    })

    test.each([
        ['missing 2xx', 200, null],
        ['malformed 2xx', 200, { success: true }],
        ['missing 4xx', 400, null],
        ['malformed 4xx', 400, { error: 'proxy body' }],
        ['missing 5xx', 500, null],
        ['malformed 5xx', 500, '<html>upstream failure</html>'],
        ['proxy 408', 408, {
            success: false,
            outcome: 'not-committed',
            operation: 'set',
            code: 'INVALID_PLUGIN_STORAGE_MUTATION',
            error: 'timeout',
            retryable: false,
        }],
        ['proxy 499', 499, {
            success: false,
            outcome: 'not-committed',
            operation: 'set',
            code: 'PLUGIN_STORAGE_TRANSACTION_ROLLED_BACK',
            error: 'client closed request',
            retryable: false,
        }],
        ['500 committed contradiction', 500, {
            success: true,
            outcome: 'committed',
            operation: 'set',
            verification: 'verified',
            hash: valueHash,
        }],
        ['200 not-committed contradiction', 200, {
            success: false,
            outcome: 'not-committed',
            operation: 'set',
            code: 'PLUGIN_STORAGE_TRANSACTION_ROLLED_BACK',
            error: 'rolled back',
            retryable: false,
        }],
        ['extra committed field', 200, {
            success: true,
            outcome: 'committed',
            operation: 'set',
            verification: 'verified',
            hash: valueHash,
            injected: true,
        }],
    ] as const)(
        '%s acknowledgement is unknown and cannot publish cache state',
        async (_name, status, body) => {
            const storage = storageWithResponse(response(body, status))

            await expect(storage.mutatePluginStorage({
                operation: 'set',
                valueKey,
                valueBytes,
                owner: 'Plugin',
            })).resolves.toMatchObject({
                outcome: 'unknown',
                code: 'ACKNOWLEDGEMENT_UNKNOWN',
            })
            expect(cache.storeBytes).not.toHaveBeenCalled()
            expect(cache.invalidateResourceCacheManifest).not.toHaveBeenCalled()
        },
    )
})
