import { beforeEach, describe, expect, test, vi } from 'vitest'

const cache = vi.hoisted(() => ({
    invalidateResourceCachePrefix: vi.fn(async () => undefined),
}))

vi.mock('src/lang', () => ({ language: {} }))
vi.mock('../alert', () => ({
    alertInput: vi.fn(),
    waitAlert: vi.fn(),
    notifyError: vi.fn(),
}))
vi.mock('./risuSave', () => ({
    decodeRisuSave: vi.fn(),
    encodeRisuSaveLegacy: vi.fn(),
}))
vi.mock('./database.svelte', () => ({ normalizeChat: (value: unknown) => value }))
vi.mock('./resourceCache', () => ({
    getManifestHashes: vi.fn(),
    getVerifiedManifestSnapshot: vi.fn(),
    getVerifiedCachedBytes: vi.fn(),
    invalidateResourceCachePrefix: cache.invalidateResourceCachePrefix,
    isResourceCacheEnabled: () => false,
    isSha256Hex: () => false,
    persistResourceCacheManifests: vi.fn(),
    sha256Bytes: vi.fn(),
    storeBytes: vi.fn(),
    touchResourceCacheManifest: vi.fn(),
}))

const { NodeStorage } = await import('./nodeStorage')
const { StorageError } = await import('./storageError')

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    })
}

function createStorage(result: Response | Error): InstanceType<typeof NodeStorage> {
    const storage = Object.create(NodeStorage.prototype) as InstanceType<typeof NodeStorage>
    vi.spyOn(storage as any, 'authFetch').mockImplementation(async () => {
        if (result instanceof Error) throw result
        return result
    })
    return storage
}

beforeEach(() => {
    cache.invalidateResourceCachePrefix.mockClear()
})

describe('NodeStorage atomic plugin clear outcomes', () => {
    test('returns committed only for the structured commit acknowledgement', async () => {
        const storage = createStorage(jsonResponse({
            success: true,
            commitOutcome: 'committed',
            commitOutcomeUnknown: false,
        }))

        await expect(storage.clearPluginSaveStorage()).resolves.toBe('committed')
        expect(cache.invalidateResourceCachePrefix.mock.calls).toEqual([
            ['kv:pluginsave/'],
            ['kv:pluginsave-meta/'],
        ])
    })

    test('preserves an explicit rolled-back result as not-committed', async () => {
        const storage = createStorage(jsonResponse({
            error: 'Plugin storage clear was not committed',
            code: 'PLUGIN_STORAGE_CLEAR_NOT_COMMITTED',
            retryAfter: 0,
            retryable: true,
            commitOutcome: 'not-committed',
            commitOutcomeUnknown: false,
        }, 500))

        const error = await storage.clearPluginSaveStorage().catch(value => value)
        expect(error).toBeInstanceOf(StorageError)
        expect(error).toMatchObject({
            status: 500,
            code: 'PLUGIN_STORAGE_CLEAR_NOT_COMMITTED',
            retryable: true,
            commitOutcomeUnknown: false,
            operation: 'remove',
        })
        expect(cache.invalidateResourceCachePrefix).not.toHaveBeenCalled()
    })

    test('classifies a definite pre-handler rejection as not-committed', async () => {
        const storage = createStorage(jsonResponse({ error: 'Session deactivated' }, 423))

        await expect(storage.clearPluginSaveStorage()).rejects.toMatchObject({
            status: 423,
            code: 'HTTP_423',
            retryable: false,
            commitOutcomeUnknown: false,
            operation: 'remove',
        })
    })

    test('reports a lost response as commit-outcome unknown without replaying it', async () => {
        const cause = new TypeError('fetch failed')
        const storage = createStorage(cause)
        const authFetch = vi.mocked((storage as any).authFetch)

        const error = await storage.clearPluginSaveStorage().catch(value => value)
        expect(error).toBeInstanceOf(StorageError)
        expect(error).toMatchObject({
            code: 'COMMIT_OUTCOME_UNKNOWN',
            retryable: false,
            commitOutcomeUnknown: true,
            operation: 'remove',
        })
        expect(error.cause).toBe(cause)
        expect(authFetch).toHaveBeenCalledOnce()
    })

    test('does not invent a rollback result for an unrecognized server response', async () => {
        const storage = createStorage(new Response('gateway failure', { status: 502 }))

        await expect(storage.clearPluginSaveStorage()).rejects.toMatchObject({
            status: 502,
            code: 'COMMIT_OUTCOME_UNKNOWN',
            retryable: false,
            commitOutcomeUnknown: true,
            operation: 'remove',
        })
    })

    test('rejects a malformed HTTP 200 envelope as commit-outcome unknown', async () => {
        const storage = createStorage(jsonResponse({ success: true }))

        await expect(storage.clearPluginSaveStorage()).rejects.toMatchObject({
            status: 200,
            code: 'COMMIT_OUTCOME_UNKNOWN',
            retryable: false,
            commitOutcomeUnknown: true,
            operation: 'remove',
        })
    })
})
