import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
vi.mock('./resourceCache', () => ({
    RESOURCE_CACHE_MAX_ENTRIES: 32_768,
    RESOURCE_CACHE_MAX_STORED_BYTES: 64 * 1024 * 1024,
    RESOURCE_CACHE_MAX_VALUE_BYTES: 32 * 1024 * 1024,
    applyOwnedResourceCacheMutations: vi.fn(async () => undefined),
    getManifestHashes: vi.fn(async () => []),
    getVerifiedManifestSnapshot: vi.fn(async () => null),
    getVerifiedCachedBytes: vi.fn(async () => null),
    invalidateResourceCachePrefix: vi.fn(async () => undefined),
    invalidateResourceCacheManifest: vi.fn(async () => undefined),
    isResourceCacheEnabled: vi.fn(() => false),
    isSha256Hex: vi.fn(() => true),
    persistResourceCacheManifests: vi.fn(async () => undefined),
    sha256Bytes: vi.fn(async () => 'a'.repeat(64)),
    sha256OwnedBytes: vi.fn(async () => 'a'.repeat(64)),
    settleBestEffortResourceCache: async <T>(operation: Promise<T>, fallback: T) => {
        try { return await operation } catch { return fallback }
    },
    storeBytes: vi.fn(async () => undefined),
    storeOwnedBytesWithKnownHash: vi.fn(async () => undefined),
    touchResourceCacheManifest: vi.fn(async () => undefined),
}))

const { NodeStorage } = await import('./nodeStorage')
const {
    clientBuildStamp,
    resetClientBuildHandshakeForTests,
} = await import('./clientBuildHandshake')

describe('NodeStorage client build headers', () => {
    beforeEach(() => {
        ;(NodeStorage as any).sessionInitialized = false
        ;(NodeStorage as any).sessionPending = null
        resetClientBuildHandshakeForTests()
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        resetClientBuildHandshakeForTests()
    })

    it('attaches the stamp to session registration and authenticated mutations', async () => {
        const requests: Array<{ path: string; headers: Headers }> = []
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const path = String(input)
            requests.push({ path, headers: new Headers(init?.headers) })
            if (path === '/api/session') {
                return new Response(JSON.stringify({
                    ok: true,
                    build: { version: '1.9.0', stamp: clientBuildStamp },
                    writerEpoch: 'writer-epoch-one',
                    capabilities: {},
                }), {
                    status: 200,
                    headers: {
                        'content-type': 'application/json',
                        'x-writer-epoch': 'writer-epoch-one',
                    },
                })
            }
            return new Response(JSON.stringify({ success: true }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        })
        vi.stubGlobal('fetch', fetchMock)

        const storage = new NodeStorage()
        storage.authChecked = true
        ;(storage as any).cachedJwt = {
            token: 'cached-token',
            expiresAt: Date.now() + 300_000,
        }

        await (storage as any).initSession()
        await (storage as any).authFetch('/api/write', {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: new Uint8Array([1]),
        })

        expect(requests.map(request => request.path)).toEqual(['/api/session', '/api/write'])
        for (const request of requests) {
            expect(request.headers.get('x-session-id')).toBeTruthy()
            expect(request.headers.get('x-client-build')).toBe(clientBuildStamp)
        }
        expect(requests[0].headers.get('x-writer-epoch')).toBeNull()
        expect(requests[1].headers.get('x-writer-epoch')).toBe('writer-epoch-one')
    })

    it('detects a changed epoch on foreground status despite the initialized-session short circuit', async () => {
        const reload = vi.fn()
        vi.stubGlobal('location', { reload })
        const requests: Array<{ path: string; headers: Headers }> = []
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const path = String(input)
            requests.push({ path, headers: new Headers(init?.headers) })
            if (path === '/api/session') {
                return new Response(JSON.stringify({
                    ok: true,
                    build: { version: '1.9.0', stamp: clientBuildStamp },
                    writerEpoch: 'writer-epoch-before-restart',
                    capabilities: {},
                }), {
                    status: 200,
                    headers: {
                        'content-type': 'application/json',
                        'x-writer-epoch': 'writer-epoch-before-restart',
                    },
                })
            }
            return new Response(JSON.stringify({
                state: 'stale',
                writerEpoch: 'writer-epoch-after-restart',
            }), {
                status: 200,
                headers: {
                    'content-type': 'application/json',
                    'x-writer-epoch': 'writer-epoch-after-restart',
                },
            })
        }))

        const storage = new NodeStorage()
        storage.authChecked = true
        ;(storage as any).cachedJwt = {
            token: 'cached-token',
            expiresAt: Date.now() + 300_000,
        }

        await (storage as any).initSession()
        await expect(storage.getWriterLockState()).resolves.toBe('unknown')

        expect(requests.map(request => request.path)).toEqual([
            '/api/session',
            '/api/session/lock-status',
        ])
        expect(requests[1].headers.get('x-writer-epoch'))
            .toBe('writer-epoch-before-restart')
        expect(reload).toHaveBeenCalledOnce()
    })
})
