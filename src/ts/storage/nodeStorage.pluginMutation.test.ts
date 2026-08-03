import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { Buffer as BrowserBuffer } from 'buffer'
import { Buffer as NodeBuffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const cache = vi.hoisted(() => ({
    enabled: true,
    applyOwnedResourceCacheMutations: vi.fn(async (
        _mutations: Array<
            | { type: 'set'; resourceKey: string; hash: string; ownedBytes: Uint8Array }
            | { type: 'remove'; resourceKey: string }
        >,
    ) => undefined),
    invalidateResourceCacheManifest: vi.fn(async () => undefined),
    storeBytes: vi.fn(async () => 'hash'),
    storeOwnedBytesWithKnownHash: vi.fn(async () => undefined),
    sha256OwnedBytes: vi.fn(async (bytes: Uint8Array) => {
        const { createHash } = await import('node:crypto')
        return createHash('sha256').update(bytes).digest('hex')
    }),
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
    RESOURCE_CACHE_MAX_ENTRIES: 32_768,
    RESOURCE_CACHE_MAX_STORED_BYTES: 64 * 1024 * 1024,
    RESOURCE_CACHE_MAX_VALUE_BYTES: 32 * 1024 * 1024,
    applyOwnedResourceCacheMutations: cache.applyOwnedResourceCacheMutations,
    getManifestHashes: vi.fn(async () => []),
    getVerifiedManifestSnapshot: vi.fn(async () => null),
    getVerifiedCachedBytes: vi.fn(async () => null),
    invalidateResourceCacheManifest: cache.invalidateResourceCacheManifest,
    isResourceCacheEnabled: vi.fn(() => cache.enabled),
    isSha256Hex: vi.fn((value: unknown) => typeof value === 'string'),
    persistResourceCacheManifests: vi.fn(async () => undefined),
    sha256Bytes: vi.fn(async (bytes: Uint8Array) => {
        const { createHash } = await import('node:crypto')
        return createHash('sha256').update(bytes).digest('hex')
    }),
    sha256OwnedBytes: cache.sha256OwnedBytes,
    settleBestEffortResourceCache: vi.fn((promise: Promise<unknown>) => promise),
    storeBytes: cache.storeBytes,
    storeOwnedBytesWithKnownHash: cache.storeOwnedBytesWithKnownHash,
    touchResourceCacheManifest: vi.fn(async () => undefined),
}))

// Load the browser transport as an older WebView would: without the modern
// String prototype method, so the viewer must use the portable Unicode helper.
const nativeIsWellFormedDescriptor = Object.getOwnPropertyDescriptor(
    String.prototype,
    'isWellFormed',
)
Reflect.deleteProperty(String.prototype, 'isWellFormed')

const {
    NodeStorage,
    authoritativeStoragePayloadTimeoutMs,
} = await import('./nodeStorage')
const {
    makeArchiveSafePluginSaveStorageKey,
    PLUGIN_SAVE_PREFIX,
} = await import('./pluginSaveKeyPolicy')

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

function batchImportBusy(retryAfter = '0'): Response {
    return response({
        success: false,
        outcome: 'not-committed',
        operation: 'batch',
        code: 'IMPORT_IN_PROGRESS',
        error: 'endpoint rejected before commit',
        retryable: true,
    }, 503, { 'retry-after': retryAfter })
}

function committedSet(manifestRevision?: string): Response {
    return response({
        success: true,
        outcome: 'committed',
        operation: 'set',
        verification: 'verified',
        hash: valueHash,
        ...(manifestRevision ? { manifestRevision } : {}),
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
    ;(NodeStorage as any).sessionInitialized = true
    ;(NodeStorage as any).pluginStorageCapabilities = {
        maxValueBytes: 128 * 1024 * 1024,
    }
    ;(NodeStorage as any).pluginStorageBatchCapabilities = null
    cache.enabled = true
    cache.sha256OwnedBytes.mockClear()
    cache.sha256OwnedBytes.mockImplementation(async (bytes: Uint8Array) => (
        createHash('sha256').update(bytes).digest('hex')
    ))
    cache.applyOwnedResourceCacheMutations.mockClear()
    cache.storeBytes.mockClear()
    cache.storeOwnedBytesWithKnownHash.mockClear()
    cache.invalidateResourceCacheManifest.mockClear()
})

afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

afterAll(() => {
    if (nativeIsWellFormedDescriptor) {
        Object.defineProperty(
            String.prototype,
            'isWellFormed',
            nativeIsWellFormedDescriptor,
        )
    }
})

describe('NodeStorage atomic plugin mutation cache publication', () => {
    test('returns a validated manifest revision echo and accepts an old server omission', async () => {
        const manifestRevision = `sha256:${'d'.repeat(64)}`
        const current = storageWithResponse(committedSet(manifestRevision))
        await expect(current.mutatePluginStorage({
            operation: 'set',
            valueKey,
            valueBytes,
            owner: 'Plugin',
        })).resolves.toMatchObject({ outcome: 'committed', manifestRevision })

        const legacy = storageWithResponse(committedSet())
        const legacyResult = await legacy.mutatePluginStorage({
            operation: 'set',
            valueKey,
            valueBytes,
            owner: 'Plugin',
        })
        expect(legacyResult).toMatchObject({ outcome: 'committed' })
        expect(legacyResult).not.toHaveProperty('manifestRevision')
    })

    test('returns a validated current publication from a generation conflict', async () => {
        const currentManifestRevision = `sha256:${'e'.repeat(64)}`
        const storage = storageWithResponse(response({
            success: false,
            outcome: 'not-committed',
            operation: 'remove',
            code: 'PLUGIN_STORAGE_GENERATION_CONFLICT',
            error: 'generation changed',
            retryable: true,
            currentGeneration: 'selected-generation',
            currentManifestRevision,
        }, 409))

        await expect(storage.mutatePluginStorage({
            operation: 'remove',
            valueKey,
            generation: 'selected-generation',
        })).resolves.toMatchObject({
            outcome: 'not-committed',
            currentGeneration: 'selected-generation',
            currentManifestRevision,
        })
    })
    test('encodes owner headers with the Buffer polyfill used by the browser app', async () => {
        vi.stubGlobal('Buffer', BrowserBuffer)
        const owner = '☸에로스 타워'
        const ownerRecordBytes = new TextEncoder().encode(JSON.stringify({
            plugin: owner,
            updatedAt: 7,
        }))
        const storage = storageWithResponse(committedSet())

        await expect(storage.mutatePluginStorage({
            operation: 'set',
            valueKey,
            valueBytes,
            owner,
            ownerRecordBytes,
        })).resolves.toMatchObject({ outcome: 'committed' })

        const init = (storage as any).authFetch.mock.calls[0][1] as RequestInit
        const headers = init.headers as Record<string, string>
        expect(headers['x-plugin-storage-owner'])
            .toBe(NodeBuffer.from(owner, 'utf8').toString('base64url'))
        expect(headers['x-plugin-storage-owner-record'])
            .toBe(NodeBuffer.from(ownerRecordBytes).toString('base64url'))
    })

    test.each([
        ['record', { ownerRecordBytes: new TextEncoder().encode('{"plugin":"Exact","updatedAt":7}') }],
        ['preserve', { preserveOwner: true }],
    ] as const)('transports the recovery owner %s policy through the hashed mutation', async (
        policy,
        recovery,
    ) => {
        const storage = storageWithResponse(committedSet())

        await expect(storage.mutatePluginStorage({
            operation: 'set',
            valueKey,
            valueBytes,
            ...recovery,
        })).resolves.toMatchObject({ outcome: 'committed' })

        const init = (storage as any).authFetch.mock.calls[0][1] as RequestInit
        const headers = init.headers as Record<string, string>
        expect(headers['x-plugin-storage-owner-policy']).toBe(policy)
        if (policy === 'record') {
            expect(Buffer.from(headers['x-plugin-storage-owner-record'], 'base64url').toString())
                .toBe('{"plugin":"Exact","updatedAt":7}')
        } else {
            expect(headers['x-plugin-storage-owner-record']).toBeUndefined()
        }
    })

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
            expect(cache.storeOwnedBytesWithKnownHash).not.toHaveBeenCalled()
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
        expect(cache.storeOwnedBytesWithKnownHash).not.toHaveBeenCalled()
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
        expect(cache.storeOwnedBytesWithKnownHash).toHaveBeenCalledWith(
            `kv:${valueKey}`,
            valueHash,
            expect.any(Uint8Array),
        )
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
        expect(cache.storeOwnedBytesWithKnownHash).not.toHaveBeenCalled()
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

        const init = (storage as any).authFetch.mock.calls[0][1] as RequestInit
        expect((init.headers as Record<string, string>)['x-plugin-storage-owner-policy'])
            .toBeUndefined()
        expect(cache.invalidateResourceCacheManifest).toHaveBeenCalledWith(`kv:${valueKey}`)
        expect(cache.storeOwnedBytesWithKnownHash).not.toHaveBeenCalled()
    })

    test('value-only remove sends one preserve-owner request and invalidates cache once', async () => {
        const storage = storageWithResponse(response({
            success: true,
            outcome: 'committed',
            operation: 'remove',
            verification: 'verified',
        }))

        await storage.mutatePluginStorage({
            operation: 'remove',
            valueKey,
            generation: 'selected-generation',
            preserveOwner: true,
        })

        expect((storage as any).authFetch).toHaveBeenCalledOnce()
        const init = (storage as any).authFetch.mock.calls[0][1] as RequestInit
        expect(init.body).toEqual(new Uint8Array())
        expect(init.headers).toMatchObject({
            'x-plugin-storage-generation': 'selected-generation',
            'x-plugin-storage-owner-policy': 'preserve',
        })
        expect(cache.invalidateResourceCacheManifest).toHaveBeenCalledOnce()
        expect(cache.invalidateResourceCacheManifest).toHaveBeenCalledWith(`kv:${valueKey}`)
        expect(cache.storeOwnedBytesWithKnownHash).not.toHaveBeenCalled()
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
            expect(cache.storeOwnedBytesWithKnownHash).not.toHaveBeenCalled()
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
        await vi.advanceTimersByTimeAsync(
            authoritativeStoragePayloadTimeoutMs(valueBytes.byteLength),
        )

        await expect(pending).resolves.toMatchObject({
            outcome: 'not-committed',
            code: 'STORAGE_TIMEOUT',
            retryable: true,
            commitOutcomeUnknown: false,
        })
        expect(fetchMock).not.toHaveBeenCalled()
    })

    test('starts the transport deadline after request hashing completes', async () => {
        vi.useFakeTimers()
        const preparationDelay = authoritativeStoragePayloadTimeoutMs(valueBytes.byteLength) + 1
        cache.sha256OwnedBytes.mockImplementation(() => new Promise(resolve => {
            setTimeout(() => resolve(valueHash), preparationDelay)
        }))
        const storage = storageWithResponse(committedSet())

        const pending = storage.mutatePluginStorage({
            operation: 'set',
            valueKey,
            valueBytes,
            owner: 'Plugin',
        })
        await vi.advanceTimersByTimeAsync(preparationDelay)

        await expect(pending).resolves.toMatchObject({
            outcome: 'committed',
            commitOutcomeUnknown: false,
        })
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
        expect(cache.storeOwnedBytesWithKnownHash).not.toHaveBeenCalled()
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
        expect(cache.storeOwnedBytesWithKnownHash).not.toHaveBeenCalled()
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
        ['malformed manifest revision', 200, {
            success: true,
            outcome: 'committed',
            operation: 'set',
            verification: 'verified',
            hash: valueHash,
            manifestRevision: `sha256:${'D'.repeat(64)}`,
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
            expect(cache.storeOwnedBytesWithKnownHash).not.toHaveBeenCalled()
            expect(cache.invalidateResourceCacheManifest).not.toHaveBeenCalled()
        },
    )
})

describe('NodeStorage AA3 batch acknowledgement', () => {
    const batchRequest = {
        generation: 'selected-generation',
        expectedManifest: {
            version: 1 as const,
            generation: 'selected-generation',
            valueKeys: [],
            metaKeys: [],
        },
        operations: [
            {
                operation: 'set' as const,
                key: 'aa3-body',
                valueBytes: new TextEncoder().encode('{"generation":"new"}'),
                owner: 'AA3',
                expectedRevision: null,
            },
            { operation: 'remove' as const, key: 'aa3-old' },
        ],
    }

    function committedBatch(init: RequestInit): Response {
        const bytes = init.body as Uint8Array
        const requestHash = createHash('sha256').update(bytes).digest('hex')
        const envelope = JSON.parse(new TextDecoder().decode(bytes)) as {
            operations: Array<{ operation: 'set' | 'remove'; key: string; value?: string }>
        }
        return response({
            success: true,
            outcome: 'committed',
            operation: 'batch',
            verification: 'verified',
            requestHash,
            generation: '123e4567-e89b-42d3-a456-426614174000',
            revisions: envelope.operations.map(operation => operation.operation === 'set'
                ? {
                    key: operation.key,
                    revision: `sha256:${'a'.repeat(64)}`,
                    valueHash: createHash('sha256')
                        .update(Buffer.from(operation.value!, 'base64'))
                        .digest('hex'),
                }
                : { key: operation.key, revision: null, valueHash: null }),
        })
    }

    test('negotiates framed limits before a direct first batch call', async () => {
        ;(NodeStorage as any).sessionInitialized = false
        const storage = new NodeStorage()
        storage.authChecked = true
        ;(storage as any).cachedJwt = {
            token: 'cached-token',
            expiresAt: Date.now() + 300_000,
        }
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            expect(String(input)).toBe('/api/session')
            return response({
                ok: true,
                capabilities: {
                    pluginStorageBatch: {
                        transport: 'framed-v1',
                        maxOperations: 128,
                        maxMetadataBytes: 4096,
                        maxValueBytes: 8,
                        maxPayloadBytes: 8,
                    },
                },
            })
        })
        vi.stubGlobal('fetch', fetchMock)
        const authFetch = vi.fn()
        ;(storage as any).authFetch = authFetch

        await expect(storage.batchPluginStorage(batchRequest)).resolves.toMatchObject({
            outcome: 'not-committed',
            code: 'PLUGIN_VALUE_TOO_LARGE',
            limit: 8,
            commitOutcomeUnknown: false,
        })
        expect(fetchMock).toHaveBeenCalledOnce()
        expect(authFetch).not.toHaveBeenCalled()
    })

    test('rejects a direct first mutation against the authenticated configured limit', async () => {
        ;(NodeStorage as any).sessionInitialized = false
        const storage = new NodeStorage()
        storage.authChecked = true
        ;(storage as any).cachedJwt = {
            token: 'cached-token',
            expiresAt: Date.now() + 300_000,
        }
        const fetchMock = vi.fn(async () => response({
            ok: true,
            capabilities: {
                pluginStorage: { maxValueBytes: 8 },
            },
        }))
        vi.stubGlobal('fetch', fetchMock)

        await expect(storage.mutatePluginStorage({
            operation: 'set',
            valueKey,
            valueBytes,
            owner: 'AA3',
        })).resolves.toMatchObject({
            outcome: 'not-committed',
            code: 'PLUGIN_VALUE_TOO_LARGE',
            limit: 8,
            actual: valueBytes.byteLength,
            commitOutcomeUnknown: false,
        })
        expect(fetchMock).toHaveBeenCalledOnce()
        expect(fetchMock).not.toHaveBeenCalledWith(
            '/api/plugin-storage/mutate',
            expect.anything(),
        )
    })

    test('replaces the fallback ceiling with a raised authenticated limit', async () => {
        ;(NodeStorage as any).sessionInitialized = false
        ;(NodeStorage as any).pluginStorageCapabilities = { maxValueBytes: 8 }
        const storage = new NodeStorage()
        storage.authChecked = true
        ;(storage as any).cachedJwt = {
            token: 'cached-token',
            expiresAt: Date.now() + 300_000,
        }
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            if (String(input) === '/api/session') {
                return response({
                    ok: true,
                    capabilities: {
                        pluginStorage: { maxValueBytes: 64 },
                    },
                })
            }
            if (String(input) === '/api/plugin-storage/mutate') return committedSet()
            throw new Error(`Unexpected request: ${String(input)}`)
        })
        vi.stubGlobal('fetch', fetchMock)

        await expect(storage.mutatePluginStorage({
            operation: 'set',
            valueKey,
            valueBytes,
            owner: 'AA3',
        })).resolves.toMatchObject({
            outcome: 'committed',
            hash: valueHash,
        })
        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(fetchMock).toHaveBeenCalledWith(
            '/api/plugin-storage/mutate',
            expect.anything(),
        )
    })

    test('uses negotiated framed transport and binds the acknowledgement to metadata hashes', async () => {
        ;(NodeStorage as any).pluginStorageBatchCapabilities = {
            transport: 'framed-v1',
            maxOperations: 128,
            maxMetadataBytes: 1024 * 1024,
            maxValueBytes: 128 * 1024 * 1024,
            maxPayloadBytes: 1024 * 1024 * 1024,
        }
        const storage = new NodeStorage()
        ;(storage as any).authFetch = vi.fn(async (
            _input: RequestInfo | URL,
            init: RequestInit,
        ) => {
            const framed = NodeBuffer.from(await (init.body as Blob).arrayBuffer())
            expect(framed.subarray(0, 8).toString('ascii')).toBe('PRISUB01')
            const metadataLength = framed.readUInt32BE(8)
            const metadataBytes = framed.subarray(12, 12 + metadataLength)
            const metadata = JSON.parse(metadataBytes.toString('utf8')) as {
                version: number
                operations: Array<{
                    operation: 'set' | 'remove'
                    key: string
                    valueLength?: number
                    valueHash?: string
                }>
            }
            expect(metadata.version).toBe(3)
            expect(metadata.operations[0]).toMatchObject({
                operation: 'set',
                valueLength: batchRequest.operations[0].valueBytes.byteLength,
                valueHash,
            })
            expect(framed.subarray(12 + metadataLength)).toEqual(NodeBuffer.from(
                batchRequest.operations[0].valueBytes,
            ))
            const requestHash = createHash('sha256').update(metadataBytes).digest('hex')
            return response({
                success: true,
                outcome: 'committed',
                operation: 'batch',
                verification: 'verified',
                requestHash,
                generation: '123e4567-e89b-42d3-a456-426614174000',
                revisions: metadata.operations.map(operation => operation.operation === 'set'
                    ? {
                        key: operation.key,
                        revision: `sha256:${'a'.repeat(64)}`,
                        valueHash: operation.valueHash,
                    }
                    : { key: operation.key, revision: null, valueHash: null }),
            })
        })

        await expect(storage.batchPluginStorage(batchRequest)).resolves.toMatchObject({
            outcome: 'committed',
            revisions: [{ valueHash }, { valueHash: null }],
        })
        const init = (storage as any).authFetch.mock.calls[0][1] as RequestInit
        expect(init.headers).toMatchObject({
            'content-type': 'application/x-pocketrisu-plugin-storage-batch',
            'x-plugin-storage-batch-stream': '1',
        })
        expect(cache.sha256OwnedBytes).toHaveBeenCalledTimes(2)
    })

    test('publishes cache only after an exact request-bound committed acknowledgement', async () => {
        const storage = new NodeStorage()
        ;(storage as any).authFetch = vi.fn(async (
            _input: RequestInfo | URL,
            init: RequestInit,
        ) => committedBatch(init))

        const result = await storage.batchPluginStorage(batchRequest)
        expect(result.outcome, JSON.stringify(result)).toBe('committed')
        expect(cache.storeBytes).not.toHaveBeenCalled()
        expect(cache.invalidateResourceCacheManifest).not.toHaveBeenCalled()
        expect(cache.applyOwnedResourceCacheMutations).toHaveBeenCalledOnce()
        expect(cache.applyOwnedResourceCacheMutations).toHaveBeenCalledWith([
            {
                type: 'set',
                resourceKey: 'kv:pluginsave/YWEzLWJvZHk.json',
                hash: valueHash,
                ownedBytes: expect.any(Uint8Array),
            },
            {
                type: 'remove',
                resourceKey: 'kv:pluginsave/YWEzLW9sZA.json',
            },
        ])
        const cachedSet = cache.applyOwnedResourceCacheMutations.mock.calls[0]![0][0]!
        expect(cachedSet.type).toBe('set')
        if (cachedSet.type === 'set') {
            expect(cachedSet.ownedBytes).not.toBe(batchRequest.operations[0].valueBytes)
        }
    })

    test('publishes cache keys with the Buffer polyfill used by the browser app', async () => {
        vi.stubGlobal('Buffer', BrowserBuffer)
        const storage = new NodeStorage()
        ;(storage as any).authFetch = vi.fn(async (
            _input: RequestInfo | URL,
            init: RequestInit,
        ) => committedBatch(init))

        await expect(storage.batchPluginStorage(batchRequest)).resolves.toMatchObject({
            outcome: 'committed',
        })
        expect(cache.applyOwnedResourceCacheMutations).toHaveBeenCalledWith([
            expect.objectContaining({ resourceKey: 'kv:pluginsave/YWEzLWJvZHk.json' }),
            expect.objectContaining({ resourceKey: 'kv:pluginsave/YWEzLW9sZA.json' }),
        ])
    })

    test('a one-SET rewrite refreshes cache after commit without an invalidation gap', async () => {
        const rewriteRequest = {
            ...batchRequest,
            operations: [batchRequest.operations[0]],
        }
        const storage = new NodeStorage()
        ;(storage as any).authFetch = vi.fn(async (
            _input: RequestInfo | URL,
            init: RequestInit,
        ) => {
            const requestHash = createHash('sha256')
                .update(init.body as Uint8Array)
                .digest('hex')
            return response({
                success: true,
                outcome: 'committed',
                operation: 'batch',
                verification: 'verified',
                requestHash,
                generation: '123e4567-e89b-42d3-a456-426614174000',
                revisions: [{
                    key: 'aa3-body',
                    revision: `sha256:${'d'.repeat(64)}`,
                    valueHash,
                }],
            })
        })

        await expect(storage.batchPluginStorage(rewriteRequest)).resolves.toMatchObject({
            outcome: 'committed',
            revisions: [{ key: 'aa3-body', valueHash }],
        })
        expect(cache.storeBytes).not.toHaveBeenCalled()
        expect(cache.applyOwnedResourceCacheMutations).toHaveBeenCalledOnce()
        expect(cache.applyOwnedResourceCacheMutations).toHaveBeenCalledWith([{
            type: 'set',
            resourceKey: 'kv:pluginsave/YWEzLWJvZHk.json',
            hash: valueHash,
            ownedBytes: expect.any(Uint8Array),
        }])
        const cachedSet = cache.applyOwnedResourceCacheMutations.mock.calls[0]![0][0]!
        expect(cachedSet.type).toBe('set')
        if (cachedSet.type === 'set') {
            expect(cachedSet.ownedBytes).not.toBe(rewriteRequest.operations[0].valueBytes)
        }
        expect(cache.invalidateResourceCacheManifest).not.toHaveBeenCalled()
    })

    test('malformed or lost acknowledgements stay unknown without value hashes or cache publication', async () => {
        const malformed = new NodeStorage()
        ;(malformed as any).authFetch = vi.fn(async () => response({
            success: true,
            outcome: 'committed',
            operation: 'batch',
            verification: 'verified',
            requestHash: '0'.repeat(64),
            generation: '123e4567-e89b-12d3-a456-426614174000',
            revisions: [],
        }))
        const malformedResult = await malformed.batchPluginStorage(batchRequest)
        expect(malformedResult).toMatchObject({
            outcome: 'unknown',
            commitOutcomeUnknown: true,
        })
        expect(malformedResult).not.toHaveProperty('revisions')
        expect(cache.storeBytes).not.toHaveBeenCalled()
        expect(cache.applyOwnedResourceCacheMutations).not.toHaveBeenCalled()

        const lost = new NodeStorage()
        ;(lost as any).authFetch = vi.fn(async (
            _input: RequestInfo | URL,
            _init: RequestInit,
            _retry: boolean,
            outcome: { markRequestDispatched: () => void },
        ) => {
            outcome.markRequestDispatched()
            throw new TypeError('connection lost')
        })
        const lostResult = await lost.batchPluginStorage(batchRequest)
        expect(lostResult).toMatchObject({
            outcome: 'unknown',
            commitOutcomeUnknown: true,
        })
        expect(lostResult).not.toHaveProperty('revisions')
        expect(cache.storeBytes).not.toHaveBeenCalled()
        expect(cache.applyOwnedResourceCacheMutations).not.toHaveBeenCalled()
    })

    test('donates a 128-row owned batch with one envelope hash and one cache publication', async () => {
        const operations = Array.from({ length: 128 }, (_, index) => ({
            operation: 'set' as const,
            key: `shard-${index}`,
            valueBytes: new TextEncoder().encode(JSON.stringify({ index })),
            ownedValueBytes: true as const,
            owner: 'PM4',
        }))
        const storage = new NodeStorage()
        ;(storage as any).authFetch = vi.fn(async (
            _input: RequestInfo | URL,
            init: RequestInit,
        ) => committedBatch(init))

        await expect(storage.batchPluginStorage({
            generation: 'selected-generation',
            expectedManifestRevision: `sha256:${'e'.repeat(64)}`,
            operations,
        })).resolves.toMatchObject({ outcome: 'committed' })

        expect(cache.sha256OwnedBytes).toHaveBeenCalledOnce()
        expect(cache.applyOwnedResourceCacheMutations).toHaveBeenCalledOnce()
        const published = cache.applyOwnedResourceCacheMutations.mock.calls[0]![0]
        expect(published).toHaveLength(128)
        published.forEach((mutation, index) => {
            expect(mutation.type).toBe('set')
            if (mutation.type === 'set') {
                expect(mutation.ownedBytes).toBe(operations[index]!.valueBytes)
            }
        })
        expect(cache.storeBytes).not.toHaveBeenCalled()
    })

    test('donates four 2 MiB values with one envelope hash and one cache publication', async () => {
        const operations = Array.from({ length: 4 }, (_, index) => ({
            operation: 'set' as const,
            key: `large-shard-${index}`,
            valueBytes: new Uint8Array(2 * 1024 * 1024).fill(index + 1),
            ownedValueBytes: true as const,
            owner: 'PM4',
        }))
        const storage = new NodeStorage()
        ;(storage as any).authFetch = vi.fn(async (
            _input: RequestInfo | URL,
            init: RequestInit,
        ) => committedBatch(init))

        await expect(storage.batchPluginStorage({
            generation: 'selected-generation',
            expectedManifestRevision: `sha256:${'e'.repeat(64)}`,
            operations,
        })).resolves.toMatchObject({ outcome: 'committed' })

        expect(cache.sha256OwnedBytes).toHaveBeenCalledOnce()
        expect(cache.applyOwnedResourceCacheMutations).toHaveBeenCalledOnce()
        const published = cache.applyOwnedResourceCacheMutations.mock.calls[0]![0]
        expect(published).toHaveLength(4)
        published.forEach((mutation, index) => {
            expect(mutation.type).toBe('set')
            if (mutation.type === 'set') {
                expect(mutation.ownedBytes).toBe(operations[index]!.valueBytes)
                expect(mutation.ownedBytes.byteLength).toBe(2 * 1024 * 1024)
            }
        })
        expect(cache.storeBytes).not.toHaveBeenCalled()
    })

    test('does no batch cache work when the disposable cache is disabled', async () => {
        cache.enabled = false
        const storage = new NodeStorage()
        ;(storage as any).authFetch = vi.fn(async (
            _input: RequestInfo | URL,
            init: RequestInit,
        ) => committedBatch(init))

        await expect(storage.batchPluginStorage(batchRequest)).resolves.toMatchObject({
            outcome: 'committed',
        })
        expect(cache.applyOwnedResourceCacheMutations).not.toHaveBeenCalled()
        expect(cache.storeBytes).not.toHaveBeenCalled()
    })

    test('an exact CAS conflict is known not committed and never retried', async () => {
        const storage = new NodeStorage()
        const authFetch = vi.fn(async (
            _input: RequestInfo | URL,
            _init?: RequestInit,
        ) => response({
            success: false,
            outcome: 'not-committed',
            operation: 'batch',
            error: 'stale',
            code: 'PLUGIN_STORAGE_REVISION_CONFLICT',
            retryable: false,
            conflicts: [{
                key: 'aa3-body',
                currentRevision: `sha256:${'b'.repeat(64)}`,
                currentGeneration: null,
            }],
        }, 409))
        ;(storage as any).authFetch = authFetch
        await expect(storage.batchPluginStorage(batchRequest)).resolves.toMatchObject({
            outcome: 'not-committed',
            code: 'PLUGIN_STORAGE_REVISION_CONFLICT',
        })
        expect(authFetch).toHaveBeenCalledOnce()
        expect(cache.storeBytes).not.toHaveBeenCalled()
    })

    test('retries only an exact import refusal and accepts the later request-bound commit', async () => {
        const storage = new NodeStorage()
        const authFetch = vi.fn()
            .mockResolvedValueOnce(batchImportBusy())
            .mockImplementationOnce(async (
                _input: RequestInfo | URL,
                init: RequestInit,
            ) => committedBatch(init))
        ;(storage as any).authFetch = authFetch

        await expect(storage.batchPluginStorage(batchRequest)).resolves.toMatchObject({
            outcome: 'committed',
            commitOutcomeUnknown: false,
        })
        expect(authFetch).toHaveBeenCalledTimes(2)
    })

    test('returns the third exact import refusal after exhausting the fixed retry bound', async () => {
        const storage = new NodeStorage()
        const authFetch = vi.fn()
            .mockResolvedValueOnce(batchImportBusy())
            .mockResolvedValueOnce(batchImportBusy())
            .mockResolvedValueOnce(batchImportBusy())
            .mockImplementationOnce(async (
                _input: RequestInfo | URL,
                init: RequestInit,
            ) => committedBatch(init))
        ;(storage as any).authFetch = authFetch

        await expect(storage.batchPluginStorage(batchRequest)).resolves.toMatchObject({
            outcome: 'not-committed',
            status: 503,
            code: 'IMPORT_IN_PROGRESS',
            retryAfter: 0,
            retryable: true,
            commitOutcomeUnknown: false,
        })
        expect(authFetch).toHaveBeenCalledTimes(3)
    })

    test('cancels an exact import retry delay without dispatching another batch', async () => {
        vi.useFakeTimers()
        const storage = new NodeStorage()
        const authFetch = vi.fn()
            .mockResolvedValueOnce(batchImportBusy('5'))
            .mockImplementationOnce(async (
                _input: RequestInfo | URL,
                init: RequestInit,
            ) => committedBatch(init))
        ;(storage as any).authFetch = authFetch
        const controller = new AbortController()

        const pending = storage.batchPluginStorage(batchRequest, controller.signal)
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

    test.each([
        ['malformed 503', 503, {
            success: false,
            outcome: 'not-committed',
            operation: 'batch',
            code: 'IMPORT_IN_PROGRESS',
            error: 'endpoint rejected before commit',
            retryable: true,
            injected: true,
        }],
        ['unknown 200 acknowledgement', 200, {
            success: true,
            outcome: 'committed',
            operation: 'batch',
        }],
    ] as const)('does not replay a %s', async (_name, status, body) => {
        const storage = new NodeStorage()
        const authFetch = vi.fn()
            .mockResolvedValueOnce(response(body, status))
            .mockImplementationOnce(async (
                _input: RequestInfo | URL,
                init: RequestInit,
            ) => committedBatch(init))
        ;(storage as any).authFetch = authFetch

        await expect(storage.batchPluginStorage(batchRequest)).resolves.toMatchObject({
            outcome: 'unknown',
            code: 'ACKNOWLEDGEMENT_UNKNOWN',
            commitOutcomeUnknown: true,
        })
        expect(authFetch).toHaveBeenCalledOnce()
        expect(cache.storeBytes).not.toHaveBeenCalled()
        expect(cache.invalidateResourceCacheManifest).not.toHaveBeenCalled()
    })

    test('abort before dispatch is known not committed; abort after dispatch is unknown', async () => {
        const before = new NodeStorage()
        const beforeFetch = vi.fn()
        ;(before as any).authFetch = beforeFetch
        const alreadyAborted = new AbortController()
        alreadyAborted.abort()
        await expect(before.batchPluginStorage(batchRequest, alreadyAborted.signal))
            .resolves.toMatchObject({
                outcome: 'not-committed',
                commitOutcomeUnknown: false,
            })
        expect(beforeFetch).not.toHaveBeenCalled()

        const after = new NodeStorage()
        ;(after as any).authFetch = vi.fn(async (
            _input: RequestInfo | URL,
            init: RequestInit,
            _retry: boolean,
            outcome: { markRequestDispatched: () => void },
        ) => {
            outcome.markRequestDispatched()
            await new Promise<never>((_resolve, reject) => {
                init.signal!.addEventListener('abort', () => reject(
                    new DOMException('aborted after dispatch', 'AbortError'),
                ), { once: true })
            })
        })
        const controller = new AbortController()
        const pending = after.batchPluginStorage(batchRequest, controller.signal)
        await vi.waitFor(() => expect((after as any).authFetch).toHaveBeenCalledOnce())
        controller.abort()
        await expect(pending).resolves.toMatchObject({
            outcome: 'unknown',
            commitOutcomeUnknown: true,
        })
    })
})

describe('NodeStorage AA3 versioned state response', () => {
    const publicationGeneration = 'selected-generation'
    const publicationRevision = `sha256:${'d'.repeat(64)}`
    const rowRevision = `sha256:${'c'.repeat(64)}`
    const rowGeneration = '123e4567-e89b-42d3-a456-426614174000'
    const binaryStateResponse = (
        bytes: Uint8Array | null,
        overrides: Record<string, string> = {},
    ) => new Response(
        bytes === null ? null : new Blob([bytes as unknown as BlobPart]),
        {
        status: bytes === null ? 204 : 200,
        headers: {
            'x-plugin-storage-missing': bytes === null ? '1' : '0',
            'x-plugin-storage-publication-generation': publicationGeneration,
            'x-plugin-storage-publication-revision': publicationRevision,
            ...(bytes === null ? {} : {
                'content-type': 'application/json',
                'content-length': String(bytes.byteLength),
                'x-plugin-storage-codec': 'json-v1',
                'x-plugin-storage-byte-length': String(bytes.byteLength),
                'x-plugin-storage-content-digest': `sha256:${valueHash}`,
                'x-plugin-storage-row-revision': rowRevision,
                'x-plugin-storage-row-generation': rowGeneration,
            }),
            ...overrides,
        },
        },
    )

    test('accepts exact missing and present binary state metadata', async () => {
        const missing = new NodeStorage()
        ;(missing as any).authFetch = vi.fn(async () => binaryStateResponse(null))
        await expect(missing.getPluginStorageState(valueKey)).resolves.toEqual({
            missing: true,
            valueBytes: null,
            revision: null,
            generation: null,
            publicationGeneration,
            publicationRevision,
            byteLength: 0,
            contentDigest: null,
            contentType: null,
            codec: null,
        })

        const present = new NodeStorage()
        ;(present as any).authFetch = vi.fn(async () => binaryStateResponse(valueBytes))
        await expect(present.getPluginStorageState(valueKey)).resolves.toEqual({
            missing: false,
            valueBytes,
            revision: rowRevision,
            generation: rowGeneration,
            publicationGeneration,
            publicationRevision,
            byteLength: valueBytes.byteLength,
            contentDigest: `sha256:${valueHash}`,
            contentType: 'application/json',
            codec: 'json-v1',
        })
        expect(cache.sha256OwnedBytes).toHaveBeenCalledOnce()
        expect((present as any).authFetch.mock.calls[0][0])
            .toBe('/api/plugin-storage/state/raw')
    })

    test('pins state reads to the selected BR2 publication generation', async () => {
        const storage = new NodeStorage()
        let receivedInit: RequestInit | undefined
        const authFetch = vi.fn(async (
            _input: RequestInfo | URL,
            init?: RequestInit,
        ) => {
            receivedInit = init
            return binaryStateResponse(null)
        })
        ;(storage as any).authFetch = authFetch

        await storage.getPluginStorageState(valueKey, {
            pluginStorageGeneration: 'selected-generation',
        })
        expect(receivedInit?.headers).toMatchObject({
            'x-plugin-storage-generation': 'selected-generation',
        })
    })

    test.each([
        ['missing value with row metadata', null, {
            'x-plugin-storage-row-revision': rowRevision,
        }],
        ['unpaired publication identity', null, {
            'x-plugin-storage-publication-revision': '',
        }],
        ['malformed publication revision', null, {
            'x-plugin-storage-publication-revision': 'not-a-revision',
        }],
        ['present value with missing row revision', valueBytes, {
            'x-plugin-storage-row-revision': '',
        }],
        ['noncanonical row generation UUID', valueBytes, {
            'x-plugin-storage-row-generation': '123e4567-e89b-12d3-a456-426614174000',
        }],
        ['incorrect byte length', valueBytes, {
            'content-length': String(valueBytes.byteLength + 1),
            'x-plugin-storage-byte-length': String(valueBytes.byteLength + 1),
        }],
        ['incorrect digest', valueBytes, {
            'x-plugin-storage-content-digest': `sha256:${'0'.repeat(64)}`,
        }],
        ['unsupported content type', valueBytes, {
            'content-type': 'application/octet-stream',
        }],
        ['unsupported codec', valueBytes, {
            'x-plugin-storage-codec': 'msgpack-v1',
        }],
    ] as const)('rejects %s', async (_name, bytes, headerOverrides) => {
        const storage = new NodeStorage()
        ;(storage as any).authFetch = vi.fn(async () => binaryStateResponse(
            bytes,
            headerOverrides,
        ))

        await expect(storage.getPluginStorageState(valueKey)).rejects.toMatchObject({
            code: 'STORAGE_RESPONSE_ERROR',
        })
    })

    test('rejects a missing publication identity on a pinned state read', async () => {
        const storage = new NodeStorage()
        ;(storage as any).authFetch = vi.fn(async () => new Response(null, {
            status: 204,
            headers: { 'x-plugin-storage-missing': '1' },
        }))

        await expect(storage.getPluginStorageState(valueKey, {
            pluginStorageGeneration: publicationGeneration,
        })).rejects.toMatchObject({ code: 'STORAGE_RESPONSE_ERROR' })
    })

    test('rejects a publication identity that differs from the selected generation', async () => {
        const storage = new NodeStorage()
        ;(storage as any).authFetch = vi.fn(async () => binaryStateResponse(null))

        await expect(storage.getPluginStorageState(valueKey, {
            pluginStorageGeneration: 'different-generation',
        })).rejects.toMatchObject({ code: 'STORAGE_RESPONSE_ERROR' })
    })

    test('contains no base64 conversion in the authoritative state read path', () => {
        const source = readFileSync('src/ts/storage/nodeStorage.ts', 'utf8')
        const start = source.indexOf('private async getPluginStorageStateAuthoritative')
        const end = source.indexOf('async getPluginStorageManifestSnapshot', start)
        expect(start).toBeGreaterThanOrEqual(0)
        expect(end).toBeGreaterThan(start)
        const implementation = source.slice(start, end)
        expect(implementation).toContain('/api/plugin-storage/state/raw')
        expect(implementation).not.toMatch(/base64/i)
        expect(implementation).not.toContain('.json()')
    })
})

describe('NodeStorage plugin manifest snapshots', () => {
    const generation = 'selected-generation'
    const manifestRevision = `sha256:${'d'.repeat(64)}`
    const manifest = {
        version: 1,
        generation,
        valueKeys: ['pluginsave/YQ.json', 'pluginsave/Yg.json'],
        metaKeys: ['pluginsave-meta/YQ.json'],
    }

    test('reads a compact manifest CAS state in one request', async () => {
        const storage = storageWithResponse(response({
            success: true,
            generation,
            manifestRevision,
        }))

        await expect(storage.getPluginStorageManifestState(generation)).resolves.toEqual({
            generation,
            manifestRevision,
        })
        expect((storage as any).authFetch).toHaveBeenCalledOnce()
        expect((storage as any).authFetch.mock.calls[0][0]).toBe('/api/plugin-storage/manifest')
        expect((storage as any).authFetch.mock.calls[0][1].headers).toMatchObject({
            'x-plugin-storage-generation': generation,
            'x-plugin-storage-manifest-mode': 'state',
        })
    })

    test('accepts only physically present manifest-owned snapshot rows', async () => {
        const storage = storageWithResponse(response({
            success: true,
            generation,
            manifestRevision,
            manifest,
            valueKeys: ['pluginsave/YQ.json'],
            metaKeys: ['pluginsave-meta/YQ.json'],
        }))

        await expect(storage.getPluginStorageManifestSnapshot(generation)).resolves.toEqual({
            generation,
            manifestRevision,
            manifest,
            valueKeys: ['pluginsave/YQ.json'],
            metaKeys: ['pluginsave-meta/YQ.json'],
        })
    })

    test('rejects foreign rows and malformed compact revisions', async () => {
        const foreign = storageWithResponse(response({
            success: true,
            generation,
            manifestRevision,
            manifest,
            valueKeys: ['pluginsave/Zm9yZWlnbg.json'],
            metaKeys: [],
        }))
        await expect(foreign.getPluginStorageManifestSnapshot(generation)).rejects.toMatchObject({
            code: 'STORAGE_RESPONSE_ERROR',
        })

        const malformed = storageWithResponse(response({
            success: true,
            generation,
            manifestRevision: 'D'.repeat(64),
        }))
        await expect(malformed.getPluginStorageManifestState(generation)).rejects.toMatchObject({
            code: 'STORAGE_RESPONSE_ERROR',
        })
    })

    test('accepts exact mapped manifests and rejects unreferenced mappings', async () => {
        const rawKey = 'mapped-key-'.repeat(300)
        const mappedValueKey = makeArchiveSafePluginSaveStorageKey(PLUGIN_SAVE_PREFIX, rawKey)
        const component = mappedValueKey.slice(PLUGIN_SAVE_PREFIX.length)
        const mappedManifest = {
            version: 3,
            generation,
            valueKeys: [mappedValueKey],
            metaKeys: [],
            keyMappings: [[component, rawKey]],
        }
        const valid = storageWithResponse(response({
            success: true,
            generation,
            manifestRevision,
            manifest: mappedManifest,
            valueKeys: [mappedValueKey],
            metaKeys: [],
        }))
        await expect(valid.getPluginStorageManifestSnapshot(generation)).resolves.toMatchObject({
            manifest: mappedManifest,
        })

        const invalid = storageWithResponse(response({
            success: true,
            generation,
            manifestRevision,
            manifest: {
                ...mappedManifest,
                keyMappings: [
                    [component, rawKey],
                    [`sha256-v1.${'0'.repeat(64)}.json`, 'unreferenced'],
                ],
            },
            valueKeys: [mappedValueKey],
            metaKeys: [],
        }))
        await expect(invalid.getPluginStorageManifestSnapshot(generation)).rejects.toMatchObject({
            code: 'STORAGE_RESPONSE_ERROR',
        })
    })

    test.each([
        ['padded alias', 'pluginsave/YQ==.json'],
        ['invalid UTF-8', 'pluginsave/_w.json'],
        ['wrong suffix', 'pluginsave/YQ.json.extra'],
    ])('rejects a %s in manifest snapshots', async (_label, invalidKey) => {
        const invalidManifest = {
            ...manifest,
            valueKeys: [invalidKey],
        }
        const storage = storageWithResponse(response({
            success: true,
            generation,
            manifestRevision,
            manifest: invalidManifest,
            valueKeys: [invalidKey],
            metaKeys: [],
        }))

        await expect(storage.getPluginStorageManifestSnapshot(generation)).rejects.toMatchObject({
            code: 'STORAGE_RESPONSE_ERROR',
        })
    })
})

describe('NodeStorage plugin viewer pages', () => {
    const generation = 'viewer-generation'
    const revision = `sha256:${'a'.repeat(64)}`
    const databaseRevision = 'b'.repeat(32)

    function viewerEvents(
        count = 50,
        keyQuery = '',
        ownerQuery?: string,
        unknownOwner = false,
        keys?: readonly string[],
    ): string[] {
        const ownerFacets = [{ owner: 'Owner', count: 5_000 }]
        const unknownOwnerCount = 5_000
        const pageTokenEntries: string[][] = []
        const lines = [JSON.stringify({
            event: 'meta',
            version: 1,
            generation,
            manifestRevision: revision,
            databaseRevision,
            page: 2,
            pageSize: 50,
            pageCount: 200,
            total: 10_000,
            totalBytes: 123_456,
            ownerFacets,
            unknownOwnerCount,
            ownerFacetTotal: 10_000,
        })]
        for (let index = 0; index < count; index++) {
            const text = JSON.stringify({ index, body: '한글' })
            const entryRevision = `sha256:${index.toString(16).padStart(64, '0')}`
            const key = keys?.[index] ?? `key-${index.toString().padStart(5, '0')}`
            const owner = index % 2 === 0 ? 'Owner' : null
            const size = new TextEncoder().encode(text).byteLength
            const contentHash = `sha256:${createHash('sha256').update(JSON.stringify([
                key,
                owner,
                text,
                size,
                'object',
                entryRevision,
            ])).digest('hex')}`
            pageTokenEntries.push([key, contentHash])
            lines.push(JSON.stringify({
                event: 'entry',
                key,
                owner,
                text,
                size,
                valueType: 'object',
                revision: entryRevision,
                contentHash,
            }))
        }
        const pageTokenMaterial = JSON.stringify([
            'pocketrisu-plugin-storage-viewer-page-v2',
            generation,
            revision,
            databaseRevision,
            2,
            50,
            keyQuery,
            ownerQuery ?? null,
            unknownOwner,
            ownerFacets.map(facet => [facet.owner, facet.count]),
            unknownOwnerCount,
            pageTokenEntries,
        ])
        lines.push(JSON.stringify({
            event: 'done',
            pageToken: `sha256:${createHash('sha256').update(pageTokenMaterial).digest('hex')}`,
            metrics: {
                manifestParses: 1,
                valueReads: count,
                sizeValueReads: 10_000,
                ownerReads: Math.ceil(count / 2),
                maxRowParses: count > 0 ? 1 : 0,
            },
        }))
        return lines
    }

    test('validates viewer filters and rows without native String.isWellFormed', async () => {
        expect(String.prototype.isWellFormed).toBeUndefined()

        const storage = storageWithResponse(new Response(`${viewerEvents().join('\n')}\n`))
        await expect(storage.getPluginStorageViewerPage(
            generation,
            { page: 2, pageSize: 50 },
        )).resolves.toMatchObject({
            total: 10_000,
            totalBytes: 123_456,
            ownerFacets: [{ owner: 'Owner', count: 5_000 }],
        })

        await expect(storage.getPluginStorageViewerPage(
            generation,
            { page: 2, pageSize: 50, ownerQuery: '\uD800' },
        )).rejects.toThrow('Plugin storage viewer owner filter is invalid')
    })

    test('streams one bounded 10k-key page from one request with fragmented UTF-8', async () => {
        const bytes = new TextEncoder().encode(`${viewerEvents(50, 'key-').join('\n')}\n`)
        const chunks: Uint8Array[] = []
        for (let offset = 0; offset < bytes.length; offset += 7) {
            chunks.push(bytes.slice(offset, Math.min(bytes.length, offset + 7)))
        }
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                const chunk = chunks.shift()
                if (chunk) controller.enqueue(chunk)
                else controller.close()
            },
        })
        const storage = storageWithResponse(new Response(body, {
            status: 200,
            headers: { 'content-type': 'application/x-ndjson' },
        }))
        const progress: Array<[number, number]> = []

        const result = await storage.getPluginStorageViewerPage(
            generation,
            { page: 2, pageSize: 50, keyQuery: 'key-' },
            undefined,
            (completed, total) => progress.push([completed, total]),
        )

        expect(result.entries).toHaveLength(50)
        expect(result.total).toBe(10_000)
        expect(result.metrics).toEqual({
            manifestParses: 1,
            valueReads: 50,
            sizeValueReads: 10_000,
            ownerReads: 25,
            maxRowParses: 1,
        })
        expect(progress.at(-1)).toEqual([50, 50])
        expect((storage as any).authFetch).toHaveBeenCalledOnce()
        const [url, init] = (storage as any).authFetch.mock.calls[0]
        expect(url).toContain('/api/plugin-storage/viewer-page?')
        expect(url).toContain('page=2')
        expect(url).toContain('pageSize=50')
        expect(url).toContain('key=key-')
        expect(init.headers['x-plugin-storage-generation']).toBe(generation)
    })

    test('preserves distinct malformed legacy UTF-16 keys in authoritative pages', async () => {
        const keys = [
            ...Array.from({ length: 47 }, (_, index) => `key-${index.toString().padStart(5, '0')}`),
            '\uD800', '\uD801', '�',
        ]
        const storage = storageWithResponse(new Response(
            `${viewerEvents(keys.length, '', undefined, false, keys).join('\n')}\n`,
        ))

        const result = await storage.getPluginStorageViewerPage(
            generation,
            { page: 2, pageSize: 50 },
        )

        expect(result.entries.map(entry => entry.key)).toEqual(keys)
        expect(result.entries.slice(-3).map(entry => entry.key)).toEqual(['\uD800', '\uD801', '�'])
    })

    test('an actual abort cancels a pending body read and returns no partial page', async () => {
        let cancelReason: unknown
        let release!: () => void
        const held = new Promise<void>(resolve => { release = resolve })
        const encoder = new TextEncoder()
        let sentMeta = false
        const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
                if (!sentMeta) {
                    sentMeta = true
                    controller.enqueue(encoder.encode(`${viewerEvents(0)[0]}\n`))
                    return
                }
                await held
            },
            cancel(reason) {
                cancelReason = reason
                release()
            },
        })
        const storage = storageWithResponse(new Response(body, { status: 200 }))
        const controller = new AbortController()
        const pending = storage.getPluginStorageViewerPage(
            generation,
            { page: 2, pageSize: 50 },
            controller.signal,
        )
        await vi.waitFor(() => expect(sentMeta).toBe(true))
        controller.abort(new DOMException('superseded page', 'AbortError'))

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
        await vi.waitFor(() => expect(cancelReason).toBeTruthy())
    })

    test.each([
        ['entry content', 1],
        ['page token', 51],
    ])('an abort during post-EOF %s hashing prevents later hashes and return', async (
        _label,
        heldCall,
    ) => {
        let release!: () => void
        const held = new Promise<void>(resolve => { release = resolve })
        let calls = 0
        cache.sha256OwnedBytes.mockImplementation(async (bytes: Uint8Array) => {
            calls += 1
            if (calls === heldCall) await held
            return createHash('sha256').update(bytes).digest('hex')
        })
        const storage = storageWithResponse(new Response(`${viewerEvents().join('\n')}\n`))
        const controller = new AbortController()
        const pending = storage.getPluginStorageViewerPage(
            generation,
            { page: 2, pageSize: 50 },
            controller.signal,
        )
        await vi.waitFor(() => expect(calls).toBe(heldCall))

        controller.abort(new DOMException('superseded during hashing', 'AbortError'))
        release()

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
        expect(calls).toBe(heldCall)
    })

    test('rejects a completed page whose read metrics exceed the page bound', async () => {
        const lines = viewerEvents()
        const done = JSON.parse(lines.at(-1)!)
        done.metrics.valueReads = 51
        lines[lines.length - 1] = JSON.stringify(done)
        const storage = storageWithResponse(new Response(`${lines.join('\n')}\n`))

        await expect(storage.getPluginStorageViewerPage(
            generation,
            { page: 2, pageSize: 50 },
        )).rejects.toMatchObject({ code: 'STORAGE_RESPONSE_ERROR' })
    })

    test.each([
        ['a blank NDJSON record', (lines: string[]) => lines.splice(1, 0, '')],
        ['an extra meta property', (lines: string[]) => {
            const meta = JSON.parse(lines[0]); meta.extra = true; lines[0] = JSON.stringify(meta)
        }],
        ['a negative total byte count', (lines: string[]) => {
            const meta = JSON.parse(lines[0]); meta.totalBytes = -1; lines[0] = JSON.stringify(meta)
        }],
        ['an extra entry property', (lines: string[]) => {
            const entry = JSON.parse(lines[1]); entry.extra = true; lines[1] = JSON.stringify(entry)
        }],
        ['an extra done property', (lines: string[]) => {
            const done = JSON.parse(lines.at(-1)!); done.extra = true; lines[lines.length - 1] = JSON.stringify(done)
        }],
        ['a forged content hash', (lines: string[]) => {
            const entry = JSON.parse(lines[1]); entry.contentHash = `sha256:${'f'.repeat(64)}`; lines[1] = JSON.stringify(entry)
        }],
        ['noncanonical numeric entry order', (lines: string[]) => {
            const first = JSON.parse(lines[1]); first.key = '10'; lines[1] = JSON.stringify(first)
            const second = JSON.parse(lines[2]); second.key = '2'; lines[2] = JSON.stringify(second)
        }],
        ['a negative metric', (lines: string[]) => {
            const done = JSON.parse(lines.at(-1)!); done.metrics.ownerReads = -1; lines[lines.length - 1] = JSON.stringify(done)
        }],
        ['a negative size-read metric', (lines: string[]) => {
            const done = JSON.parse(lines.at(-1)!); done.metrics.sizeValueReads = -1; lines[lines.length - 1] = JSON.stringify(done)
        }],
        ['noncanonical facet order', (lines: string[]) => {
            const meta = JSON.parse(lines[0]);
            meta.ownerFacets = [{ owner: 'z', count: 2_500 }, { owner: 'a', count: 2_500 }]
            lines[0] = JSON.stringify(meta)
        }],
        ['a forged page token', (lines: string[]) => {
            const done = JSON.parse(lines.at(-1)!); done.pageToken = `sha256:${'f'.repeat(64)}`; lines[lines.length - 1] = JSON.stringify(done)
        }],
    ])('rejects %s', async (_label, mutate) => {
        const lines = viewerEvents()
        mutate(lines)
        const storage = storageWithResponse(new Response(`${lines.join('\n')}\n`))
        await expect(storage.getPluginStorageViewerPage(
            generation,
            { page: 2, pageSize: 50 },
        )).rejects.toMatchObject({ code: 'STORAGE_RESPONSE_ERROR' })
    })
})
