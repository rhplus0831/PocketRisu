import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('src/lang', () => ({ language: {} }))
vi.mock('../alert', () => ({
    alertInput: vi.fn(),
    waitAlert: vi.fn(),
    notifyError: vi.fn(),
}))
vi.mock('./database.svelte', () => ({ normalizeChat: (chat: unknown) => chat }))
vi.mock('./risuSave', () => ({
    decodeRisuSave: vi.fn(),
    encodeRisuSaveLegacy: vi.fn(),
}))
vi.mock('./resourceCache', () => ({
    applyOwnedResourceCacheMutations: vi.fn(async () => undefined),
    getManifestHashes: vi.fn(),
    getVerifiedManifestSnapshot: vi.fn(),
    getVerifiedCachedBytes: vi.fn(),
    invalidateResourceCachePrefix: vi.fn(),
    isResourceCacheEnabled: () => false,
    isSha256Hex: () => false,
    persistResourceCacheManifests: vi.fn(),
    sha256Bytes: vi.fn(),
    sha256OwnedBytes: vi.fn(),
    settleBestEffortResourceCache: async <T>(operation: Promise<T>, fallback: T) => {
        try {
            return await operation
        } catch {
            return fallback
        }
    },
    storeBytes: vi.fn(),
    touchResourceCacheManifest: vi.fn(),
}))

import { ConflictError, NodeStorage } from './nodeStorage'
import { StorageError } from './storageError'

const fetchMock = vi.fn<typeof fetch>()

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    })
}

function importBusy(): Response {
    return jsonResponse({
        error: 'Import owns storage',
        code: 'IMPORT_IN_PROGRESS',
        retryAfter: 0,
        retryable: true,
        commitOutcome: 'not-committed',
        commitOutcomeUnknown: false,
    }, 503, { 'retry-after': '0' })
}

function retryableNotCommitted(retryAfter: string): Response {
    return jsonResponse({
        error: 'Temporarily unavailable',
        code: 'TEMPORARY_STORAGE_FAILURE',
        retryable: true,
        commitOutcome: 'not-committed',
        commitOutcomeUnknown: false,
    }, 503, { 'retry-after': retryAfter })
}

function readyStorage(): NodeStorage {
    const storage = new NodeStorage()
    storage.authChecked = true
    ;(storage as any).cachedJwt = { token: 'test-token', expiresAt: Date.now() + 60_000 }
    ;(NodeStorage as any).sessionInitialized = true
    return storage
}

const backupLateError = {
    type: 'error' as const,
    message: 'Backup import rolled back: 데이터',
    code: 'BACKUP_IMPORT_NOT_COMMITTED',
    retryable: true,
    commitOutcome: 'not-committed' as const,
    commitOutcomeUnknown: false,
    status: 500,
}

describe('NodeStorage plugin error contract', () => {
    beforeEach(() => {
        fetchMock.mockReset()
        vi.stubGlobal('fetch', fetchMock)
        localStorage.clear()
        ;(NodeStorage as any).sessionInitialized = true
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    test('preserves the exact structured late upload error even after a done event', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))

        class FakeXmlHttpRequest {
            status = 200
            responseText = ''
            upload: Record<string, any> = {}
            onprogress: (() => void) | null = null
            onerror: (() => void) | null = null
            onload: (() => void) | null = null
            open() {}
            setRequestHeader() {}
            send() {
                this.upload.onload?.()
                const stream = [
                    '{"type":"heartbeat"}\n{"type":"done","ok":true,"assetsRestored":1}\n',
                    JSON.stringify(backupLateError).slice(0, 47),
                    JSON.stringify(backupLateError).slice(47),
                ]
                for (const chunk of stream) {
                    this.responseText += chunk
                    this.onprogress?.()
                }
                this.onload?.()
            }
        }
        vi.stubGlobal('XMLHttpRequest', FakeXmlHttpRequest)

        const error = await readyStorage().importBackup(new Blob(['archive'])).catch(value => value)
        expect(error).toBeInstanceOf(StorageError)
        expect(error).toMatchObject({
            message: backupLateError.message,
            status: 500,
            code: backupLateError.code,
            retryable: true,
            commitOutcome: 'not-committed',
            commitOutcomeUnknown: false,
            operation: 'write',
        })
    })

    test('preserves a split UTF-8 late server-restore error without a final newline', async () => {
        const encoded = new TextEncoder().encode(
            '{"type":"heartbeat"}\n' + JSON.stringify(backupLateError),
        )
        const messageBytes = new TextEncoder().encode('데')
        const splitAt = encoded.indexOf(messageBytes[0]) + 1
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoded.subarray(0, splitAt))
                controller.enqueue(encoded.subarray(splitAt, splitAt + 1))
                controller.enqueue(encoded.subarray(splitAt + 1))
                controller.close()
            },
        })
        fetchMock.mockResolvedValueOnce(new Response(body, {
            status: 200,
            headers: { 'content-type': 'application/x-ndjson' },
        }))

        const error = await readyStorage().restoreServerBackup('risu-backup-1.bin').catch(value => value)
        expect(error).toBeInstanceOf(StorageError)
        expect(error).toMatchObject({
            message: backupLateError.message,
            status: 500,
            code: backupLateError.code,
            retryable: true,
            commitOutcome: 'not-committed',
            commitOutcomeUnknown: false,
            operation: 'write',
        })
    })

    test('retries an explicitly retryable idempotent plugin write within a fixed bound', async () => {
        fetchMock
            .mockResolvedValueOnce(importBusy())
            .mockResolvedValueOnce(importBusy())
            .mockResolvedValueOnce(jsonResponse({ success: true }))

        await expect(readyStorage().setItem(
            'pluginsave/d3JpdGU.json',
            new TextEncoder().encode('{"ok":true}'),
        )).resolves.toBeUndefined()
        expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    test('retries an explicitly retryable plugin read and returns the committed value', async () => {
        fetchMock
            .mockResolvedValueOnce(importBusy())
            .mockResolvedValueOnce(new Response('{"generation":"committed"}', { status: 200 }))

        const value = await readyStorage().getItem('pluginsave/cmVhZA.json')
        expect(value.toString('utf-8')).toBe('{"generation":"committed"}')
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    test('preserves the same retry behavior for plugin key enumeration', async () => {
        fetchMock
            .mockResolvedValueOnce(importBusy())
            .mockResolvedValueOnce(jsonResponse({
                success: true,
                mode: 'full',
                content: ['pluginsave/b25l.json'],
                timestamp: 10,
                epoch: 'epoch-1',
            }))

        await expect(readyStorage().keys('pluginsave/'))
            .resolves.toEqual(['pluginsave/b25l.json'])
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    test('preserves the exhausted retry contract for plugin removes', async () => {
        fetchMock.mockImplementation(async () => importBusy())

        const failure = await readyStorage().removeItem('pluginsave/cmVtb3Zl.json')
            .then(() => null, error => error)

        expect(fetchMock).toHaveBeenCalledTimes(3)
        expect(failure).toBeInstanceOf(StorageError)
        expect(failure).toMatchObject({
            message: 'Import owns storage',
            status: 503,
            code: 'IMPORT_IN_PROGRESS',
            retryAfter: 0,
            retryable: true,
            commitOutcomeUnknown: false,
            operation: 'remove',
        })
    })

    test('does not replay a plugin mutation when the commit outcome is unknown', async () => {
        fetchMock.mockRejectedValueOnce('socket disappeared after upload')

        const failure = await readyStorage().setItem(
            'pluginsave/dW5rbm93bg.json',
            new Uint8Array([1, 2, 3]),
        ).then(() => null, error => error)

        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(failure).toBeInstanceOf(StorageError)
        expect(failure).toMatchObject({
            message: 'socket disappeared after upload',
            status: null,
            code: 'COMMIT_OUTCOME_UNKNOWN',
            retryable: false,
            commitOutcomeUnknown: true,
            operation: 'write',
        })
    })

    test('treats an ambiguous server-side mutation failure as commit-outcome unknown', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({
            error: 'response failed after storage work',
            retryable: true,
        }, 500))

        const failure = await readyStorage().removeItem('pluginsave/YW1iaWd1b3Vz.json')
            .then(() => null, error => error)

        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(failure).toMatchObject({
            status: 500,
            code: 'COMMIT_OUTCOME_UNKNOWN',
            retryable: true,
            commitOutcomeUnknown: true,
        })
    })

    test.each([500, 503])(
        'does not replay malformed HTTP %s JSON that omits the not-committed outcome',
        async (status) => {
            fetchMock.mockResolvedValue(jsonResponse({
                error: 'incomplete commit envelope',
                code: status === 503 ? 'IMPORT_IN_PROGRESS' : 'TEMPORARY_STORAGE_FAILURE',
                retryAfter: 0,
                retryable: true,
                commitOutcomeUnknown: false,
            }, status))

            const failure = await readyStorage().removeItem('pluginsave/bWFsZm9ybWVkLW91dGNvbWU.json')
                .then(() => null, error => error)

            expect(fetchMock).toHaveBeenCalledOnce()
            expect(failure).toBeInstanceOf(StorageError)
            expect(failure).toMatchObject({
                message: 'incomplete commit envelope',
                status,
                code: status === 503 ? 'IMPORT_IN_PROGRESS' : 'TEMPORARY_STORAGE_FAILURE',
                retryable: true,
                commitOutcomeUnknown: true,
                operation: 'remove',
            })
        },
    )

    test('turns a validation 400 into a structured non-ambiguous write error', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'invalid plugin value' }, 400))

        const failure = await readyStorage().setItem(
            'pluginsave/aW52YWxpZA.json',
            new Uint8Array([1]),
        ).then(() => null, error => error)

        expect(failure).toBeInstanceOf(StorageError)
        expect(failure).toMatchObject({
            message: 'invalid plugin value',
            status: 400,
            code: 'HTTP_400',
            retryable: false,
            commitOutcomeUnknown: false,
            operation: 'write',
        })
    })

    test.each([409, 500, 503])(
        'keeps a non-JSON HTTP %s mutation failure structured and conservative',
        async (status) => {
            fetchMock.mockResolvedValueOnce(new Response(`malformed ${status}`, { status }))

            const failure = await readyStorage().setItem(
                'pluginsave/bWFsZm9ybWVk.json',
                new Uint8Array([1]),
            ).then(() => null, error => error)

            expect(fetchMock).toHaveBeenCalledTimes(1)
            expect(failure).toBeInstanceOf(StorageError)
            expect(failure).not.toBeInstanceOf(ConflictError)
            expect(failure).toMatchObject({
                message: `malformed ${status}`,
                status,
                code: 'COMMIT_OUTCOME_UNKNOWN',
                retryable: false,
                commitOutcomeUnknown: true,
                operation: 'write',
            })
        },
    )

    test('does not classify a plugin 409 with conflict-shaped JSON as a database conflict', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({
            error: 'plugin generation conflict',
            currentEtag: 'a'.repeat(32),
            code: 'PLUGIN_CONFLICT',
        }, 409))

        const failure = await readyStorage().setItem(
            'pluginsave/Y29uZmxpY3Q.json',
            new Uint8Array([1]),
        ).then(() => null, error => error)

        expect(failure).toBeInstanceOf(StorageError)
        expect(failure).not.toBeInstanceOf(ConflictError)
        expect(failure).toMatchObject({
            status: 409,
            code: 'PLUGIN_CONFLICT',
            commitOutcomeUnknown: true,
        })
    })

    test('recognizes only a schema-valid database ETag conflict envelope', async () => {
        const currentEtag = '0123456789abcdef0123456789abcdef'
        fetchMock.mockResolvedValueOnce(jsonResponse({
            error: 'ETag mismatch - concurrent modification detected',
            currentEtag,
        }, 409))

        const failure = await readyStorage().setItem(
            'database/database.bin',
            new Uint8Array([1]),
            'old-etag',
        ).then(() => null, error => error)

        expect(failure).toBeInstanceOf(ConflictError)
        expect(failure).toMatchObject({
            message: 'ETag mismatch - concurrent modification detected',
            status: 409,
            code: 'STORAGE_CONFLICT',
            currentEtag,
            commitOutcomeUnknown: false,
        })
    })

    test('rejects malformed database 409 envelopes as structured ambiguous writes', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({
            error: 'not a valid conflict envelope',
            currentEtag: 'not-an-etag',
            code: 'ODD_CONFLICT',
            retryAfter: 7,
            retryable: true,
        }, 409))

        const failure = await readyStorage().setItem(
            'database/database.bin',
            new Uint8Array([1]),
            'old-etag',
        ).then(() => null, error => error)

        expect(failure).toBeInstanceOf(StorageError)
        expect(failure).not.toBeInstanceOf(ConflictError)
        expect(failure).toMatchObject({
            status: 409,
            code: 'ODD_CONFLICT',
            retryAfter: 7,
            retryable: true,
            commitOutcomeUnknown: true,
        })
    })

    test('bounds network retries for plugin reads but never replays an ambiguous mutation', async () => {
        fetchMock.mockRejectedValue(new Error('network unavailable'))

        const readFailure = await readyStorage().getItem('pluginsave/bmV0d29yay1yZWFk.json')
            .then(() => null, error => error)
        expect(fetchMock).toHaveBeenCalledTimes(3)
        expect(readFailure).toMatchObject({
            code: 'STORAGE_TRANSPORT_ERROR',
            retryable: true,
            commitOutcomeUnknown: false,
            operation: 'read',
        })

        fetchMock.mockClear()
        const writeFailure = await readyStorage().setItem(
            'pluginsave/bmV0d29yay13cml0ZQ.json',
            new Uint8Array([1]),
        ).then(() => null, error => error)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(writeFailure).toMatchObject({
            code: 'COMMIT_OUTCOME_UNKNOWN',
            retryable: false,
            commitOutcomeUnknown: true,
            operation: 'write',
        })
    })

    test('bounds network retries for plugin lists', async () => {
        fetchMock.mockRejectedValue(new Error('list network unavailable'))

        const failure = await readyStorage().keys('pluginsave/')
            .then(() => null, error => error)

        expect(fetchMock).toHaveBeenCalledTimes(3)
        expect(failure).toMatchObject({
            code: 'STORAGE_TRANSPORT_ERROR',
            retryable: true,
            commitOutcomeUnknown: false,
            operation: 'list',
        })
    })

    test('honors numeric Retry-After seconds', async () => {
        vi.useFakeTimers()
        fetchMock
            .mockResolvedValueOnce(retryableNotCommitted('2'))
            .mockResolvedValueOnce(jsonResponse({ success: true }))

        const pending = readyStorage().setItem(
            'pluginsave/cmV0cnktbnVtZXJpYw.json',
            new Uint8Array([1]),
        )
        await vi.advanceTimersByTimeAsync(0)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1_999)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1)
        await expect(pending).resolves.toBeUndefined()
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    test('honors HTTP-date Retry-After values', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-07-26T12:00:00.000Z'))
        const retryAt = new Date(Date.now() + 3_000).toUTCString()
        fetchMock
            .mockResolvedValueOnce(retryableNotCommitted(retryAt))
            .mockResolvedValueOnce(jsonResponse({ success: true }))

        const pending = readyStorage().setItem(
            'pluginsave/cmV0cnktZGF0ZQ.json',
            new Uint8Array([1]),
        )
        await vi.advanceTimersByTimeAsync(2_999)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1)
        await expect(pending).resolves.toBeUndefined()
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    test('caps oversized Retry-After delays at five seconds', async () => {
        vi.useFakeTimers()
        fetchMock
            .mockResolvedValueOnce(retryableNotCommitted('3600'))
            .mockResolvedValueOnce(jsonResponse({ success: true }))

        const pending = readyStorage().setItem(
            'pluginsave/cmV0cnktY2Fw.json',
            new Uint8Array([1]),
        )
        await vi.advanceTimersByTimeAsync(4_999)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1)
        await expect(pending).resolves.toBeUndefined()
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    test('aborting during Retry-After prevents a late mutation retry', async () => {
        vi.useFakeTimers()
        fetchMock
            .mockResolvedValueOnce(retryableNotCommitted('5'))
            .mockResolvedValueOnce(jsonResponse({ success: true }))
        const controller = new AbortController()

        const pending = readyStorage().setItem(
            'pluginsave/cmV0cnktYWJvcnQ.json',
            new Uint8Array([1]),
            undefined,
            controller.signal,
        ).catch(error => error)
        await vi.advanceTimersByTimeAsync(0)
        expect(fetchMock).toHaveBeenCalledOnce()

        controller.abort(new DOMException('cancel retry', 'AbortError'))
        await expect(pending).resolves.toMatchObject({
            code: 'STORAGE_TIMEOUT',
            retryable: true,
            commitOutcomeUnknown: false,
        })
        await vi.advanceTimersByTimeAsync(10_000)
        expect(fetchMock).toHaveBeenCalledOnce()
    })
})
