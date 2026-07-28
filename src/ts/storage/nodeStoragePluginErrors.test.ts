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

import {
    ConflictError,
    NodeStorage,
    SAVE_FOLDER_IMPORT_TIMEOUT_MS,
} from './nodeStorage'
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

function expectCommitOutcomeUnknown(error: unknown) {
    expect(error).toBeInstanceOf(StorageError)
    expect(error).toMatchObject({
        status: null,
        code: 'COMMIT_OUTCOME_UNKNOWN',
        retryAfter: null,
        retryable: false,
        commitOutcome: 'unknown',
        commitOutcomeUnknown: true,
        operation: 'write',
    })
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

    test.each([
        ['malformed JSON', '{not-json}\n'],
        ['a malformed terminal schema', '{"type":"done","ok":true,"assetsRestored":"1"}\n'],
        ['an unknown event schema', '{"type":"mystery"}\n'],
        ['a blank NDJSON record', '{"type":"heartbeat"}\n\n'],
        ['EOF without a terminal event', '{"type":"heartbeat"}\n'],
    ])('classifies upload %s as commit-outcome unknown without replay', async (_label, responseText) => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
        let sendCalls = 0

        class FakeXmlHttpRequest {
            status = 200
            responseText = ''
            upload: Record<string, any> = {}
            onprogress: (() => void) | null = null
            onerror: (() => void) | null = null
            ontimeout: (() => void) | null = null
            onabort: (() => void) | null = null
            onload: (() => void) | null = null
            open() {}
            setRequestHeader() {}
            send() {
                sendCalls += 1
                this.upload.onload?.()
                this.responseText = responseText
                this.onprogress?.()
                this.onload?.()
            }
        }
        vi.stubGlobal('XMLHttpRequest', FakeXmlHttpRequest)

        const error = await readyStorage().importBackup(new Blob(['archive'])).catch(value => value)

        expectCommitOutcomeUnknown(error)
        expect(sendCalls).toBe(1)
        expect(fetchMock).toHaveBeenCalledOnce()
    })

    test.each(['error', 'timeout', 'abort'] as const)(
        'classifies upload XHR %s after dispatch as commit-outcome unknown without replay',
        async (eventName) => {
            fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
            let sendCalls = 0

            class FakeXmlHttpRequest {
                status = 0
                responseText = '{"type":"heartbeat"}\n'
                upload: Record<string, any> = {}
                onprogress: (() => void) | null = null
                onerror: (() => void) | null = null
                ontimeout: (() => void) | null = null
                onabort: (() => void) | null = null
                onload: (() => void) | null = null
                open() {}
                setRequestHeader() {}
                send() {
                    sendCalls += 1
                    this.upload.onload?.()
                    this.onprogress?.()
                    if (eventName === 'error') this.onerror?.()
                    if (eventName === 'timeout') this.ontimeout?.()
                    if (eventName === 'abort') this.onabort?.()
                }
            }
            vi.stubGlobal('XMLHttpRequest', FakeXmlHttpRequest)

            const error = await readyStorage().importBackup(new Blob(['archive'])).catch(value => value)

            expectCommitOutcomeUnknown(error)
            expect(sendCalls).toBe(1)
            expect(fetchMock).toHaveBeenCalledOnce()
        },
    )

    test.each(['error', 'timeout', 'abort'] as const)(
        'does not accept a parsed upload done event when XHR later reports %s',
        async (eventName) => {
            fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
            let sendCalls = 0

            class FakeXmlHttpRequest {
                status = 200
                responseText = '{"type":"done","ok":true,"assetsRestored":1}\n'
                upload: Record<string, any> = {}
                onprogress: (() => void) | null = null
                onerror: (() => void) | null = null
                ontimeout: (() => void) | null = null
                onabort: (() => void) | null = null
                onload: (() => void) | null = null
                open() {}
                setRequestHeader() {}
                send() {
                    sendCalls += 1
                    this.upload.onload?.()
                    this.onprogress?.()
                    if (eventName === 'error') this.onerror?.()
                    if (eventName === 'timeout') this.ontimeout?.()
                    if (eventName === 'abort') this.onabort?.()
                }
            }
            vi.stubGlobal('XMLHttpRequest', FakeXmlHttpRequest)

            const error = await readyStorage().importBackup(new Blob(['archive'])).catch(value => value)

            expectCommitOutcomeUnknown(error)
            expect(sendCalls).toBe(1)
            expect(fetchMock).toHaveBeenCalledOnce()
        },
    )

    test('classifies an XHR load with status zero as commit-outcome unknown after dispatch', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
        let sendCalls = 0

        class FakeXmlHttpRequest {
            status = 0
            responseText = '{"type":"done","ok":true,"assetsRestored":1}\n'
            upload: Record<string, any> = {}
            onprogress: (() => void) | null = null
            onerror: (() => void) | null = null
            ontimeout: (() => void) | null = null
            onabort: (() => void) | null = null
            onload: (() => void) | null = null
            open() {}
            setRequestHeader() {}
            send() {
                sendCalls += 1
                this.upload.onload?.()
                this.onprogress?.()
                this.onload?.()
            }
        }
        vi.stubGlobal('XMLHttpRequest', FakeXmlHttpRequest)

        const error = await readyStorage().importBackup(new Blob(['archive'])).catch(value => value)

        expectCommitOutcomeUnknown(error)
        expect(sendCalls).toBe(1)
        expect(fetchMock).toHaveBeenCalledOnce()
    })

    test('keeps a synchronous pre-dispatch upload failure definitively not committed', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))

        class FakeXmlHttpRequest {
            status = 0
            responseText = ''
            upload: Record<string, any> = {}
            onprogress: (() => void) | null = null
            onerror: (() => void) | null = null
            ontimeout: (() => void) | null = null
            onabort: (() => void) | null = null
            onload: (() => void) | null = null
            open() {}
            setRequestHeader() {}
            send() { throw new Error('local send rejected') }
        }
        vi.stubGlobal('XMLHttpRequest', FakeXmlHttpRequest)

        const error = await readyStorage().importBackup(new Blob(['archive'])).catch(value => value)

        expect(error).toBeInstanceOf(StorageError)
        expect(error).toMatchObject({
            code: 'STORAGE_TRANSPORT_ERROR',
            retryable: true,
            commitOutcome: 'not-committed',
            commitOutcomeUnknown: false,
            operation: 'write',
        })
    })

    test('keeps strict upload heartbeat/progress handling and accepts one exact terminal', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
        const progress = vi.fn()

        class FakeXmlHttpRequest {
            status = 200
            responseText = ''
            upload: Record<string, any> = {}
            onprogress: (() => void) | null = null
            onerror: (() => void) | null = null
            ontimeout: (() => void) | null = null
            onabort: (() => void) | null = null
            onload: (() => void) | null = null
            open() {}
            setRequestHeader() {}
            send() {
                this.upload.onload?.()
                this.responseText = [
                    '{"type":"heartbeat"}',
                    '{"type":"progress","bytes":4,"totalBytes":8}',
                    '{"type":"done","ok":true,"assetsRestored":2,"coldStorageFailed":0}',
                    '',
                ].join('\n')
                this.onprogress?.()
                this.onload?.()
            }
        }
        vi.stubGlobal('XMLHttpRequest', FakeXmlHttpRequest)

        await expect(readyStorage().importBackup(new Blob(['archive']), progress))
            .resolves.toEqual({
                type: 'done',
                ok: true,
                assetsRestored: 2,
                coldStorageFailed: 0,
            })
        expect(progress).toHaveBeenCalledWith(4, 8)
    })

    test.each([
        ['malformed JSON', '{not-json}\n'],
        ['a malformed terminal schema', '{"type":"done","ok":false,"assetsRestored":1}\n'],
        ['an unknown event schema', '{"type":"mystery"}\n'],
        ['a blank NDJSON record', '{"type":"heartbeat"}\n\n'],
        ['EOF without a terminal event', '{"type":"heartbeat"}\n'],
    ])('classifies server-file restore %s as commit-outcome unknown without replay', async (
        _label,
        responseText,
    ) => {
        fetchMock.mockResolvedValueOnce(new Response(responseText, {
            status: 200,
            headers: { 'content-type': 'application/x-ndjson' },
        }))

        const error = await readyStorage().restoreServerBackup('risu-backup-1.bin')
            .catch(value => value)

        expectCommitOutcomeUnknown(error)
        expect(fetchMock).toHaveBeenCalledOnce()
    })

    test('classifies server-file restore response-body loss as commit-outcome unknown', async () => {
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('{"type":"heartbeat"}\n'))
                controller.error(new Error('proxy response lost'))
            },
        })
        fetchMock.mockResolvedValueOnce(new Response(body, {
            status: 200,
            headers: { 'content-type': 'application/x-ndjson' },
        }))

        const error = await readyStorage().restoreServerBackup('risu-backup-1.bin')
            .catch(value => value)

        expectCommitOutcomeUnknown(error)
        expect(fetchMock).toHaveBeenCalledOnce()
    })

    test('normalizes an arbitrary StorageError from the restore reader as commit-outcome unknown', async () => {
        const streamFailure = new StorageError('proxy reader classified this incorrectly', {
            status: 502,
            code: 'UPSTREAM_BODY_FAILURE',
            retryable: true,
            commitOutcome: 'not-committed',
            commitOutcomeUnknown: false,
            operation: 'read',
        })
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('{"type":"heartbeat"}\n'))
                controller.error(streamFailure)
            },
        })
        fetchMock.mockResolvedValueOnce(new Response(body, {
            status: 200,
            headers: { 'content-type': 'application/x-ndjson' },
        }))

        const error = await readyStorage().restoreServerBackup('risu-backup-1.bin')
            .catch(value => value)

        expect(error).toBeInstanceOf(StorageError)
        expect(error).toMatchObject({
            status: 502,
            code: 'COMMIT_OUTCOME_UNKNOWN',
            retryAfter: null,
            retryable: false,
            commitOutcome: 'unknown',
            commitOutcomeUnknown: true,
            operation: 'write',
        })
        expect((error as Error).cause).toBe(streamFailure)
        expect(fetchMock).toHaveBeenCalledOnce()
    })

    test('classifies server-file restore transport loss after dispatch as commit-outcome unknown', async () => {
        fetchMock.mockRejectedValueOnce(new TypeError('connection reset'))

        const error = await readyStorage().restoreServerBackup('risu-backup-1.bin')
            .catch(value => value)

        expectCommitOutcomeUnknown(error)
        expect(fetchMock).toHaveBeenCalledOnce()
    })

    test('keeps strict server-file heartbeat/progress handling and accepts one exact terminal', async () => {
        const progress = vi.fn()
        fetchMock.mockResolvedValueOnce(new Response([
            '{"type":"heartbeat"}',
            '{"type":"progress","bytes":4,"totalBytes":8}',
            '{"type":"done","ok":true,"assetsRestored":2,"coldStorageFailed":0}',
            '',
        ].join('\n'), {
            status: 200,
            headers: { 'content-type': 'application/x-ndjson' },
        }))

        await expect(readyStorage().restoreServerBackup('risu-backup-1.bin', progress))
            .resolves.toEqual({
                type: 'done',
                ok: true,
                assetsRestored: 2,
                coldStorageFailed: 0,
            })
        expect(progress).toHaveBeenCalledWith(4, 8)
        expect(fetchMock).toHaveBeenCalledOnce()
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

    test('keeps a patch-conflict ETag provisional until authoritative state is installed', async () => {
        const acceptedEtag = '1'.repeat(32)
        const currentEtag = '2'.repeat(32)
        fetchMock.mockResolvedValueOnce(jsonResponse({
            error: 'Hash mismatch - data out of sync',
            code: 'DATABASE_PATCH_CONFLICT',
            currentEtag,
        }, 409))
        const storage = readyStorage()
        storage._lastDbEtag = acceptedEtag

        const result = await storage.patchItem('database/database.bin', {
            patch: [{ op: 'replace', path: '/username', value: 'local' }],
            expectedHash: 'stale-hash',
        })

        expect(result).toEqual({
            success: false,
            conflict: true,
            currentEtag,
            chatGuardRejected: false,
        })
        expect(storage._lastDbEtag).toBe(acceptedEtag)
    })

    test('does not promote the ETag from a chat-guard patch rejection', async () => {
        const acceptedEtag = '3'.repeat(32)
        const currentEtag = '4'.repeat(32)
        fetchMock.mockResolvedValueOnce(jsonResponse({
            error: 'Patch rejected: chat-internal field ops not allowed for lazy-loaded chats',
            code: 'CHAT_GUARD_REJECTED',
            chatGuardRejected: true,
            currentEtag,
        }, 409))
        const storage = readyStorage()
        storage._lastDbEtag = acceptedEtag

        const result = await storage.patchItem('database/database.bin', {
            patch: [{ op: 'remove', path: '/characters/0/chats/0/message' }],
            expectedHash: 'guard-baseline',
        })

        expect(result).toEqual({
            success: false,
            conflict: false,
            currentEtag,
            chatGuardRejected: true,
        })
        expect(storage._lastDbEtag).toBe(acceptedEtag)
    })

    test('reads a database conflict candidate without accepting its ETag', async () => {
        const acceptedEtag = '5'.repeat(32)
        const candidateEtag = '6'.repeat(32)
        const candidateBytes = new Uint8Array([9, 8, 7])
        fetchMock.mockResolvedValueOnce(new Response(candidateBytes, {
            status: 200,
            headers: { 'x-db-etag': candidateEtag },
        }))
        const storage = readyStorage()
        storage._lastDbEtag = acceptedEtag

        const candidate = await storage.readDatabaseCandidate()

        expect(candidate.etag).toBe(candidateEtag)
        expect(candidate.data).toEqual(Buffer.from(candidateBytes))
        expect(storage._lastDbEtag).toBe(acceptedEtag)
    })

    test('retains the accepted ETag when a conflict candidate body cannot be read', async () => {
        const acceptedEtag = '7'.repeat(32)
        const candidateEtag = '8'.repeat(32)
        const response = new Response(new Uint8Array([1]), {
            status: 200,
            headers: { 'x-db-etag': candidateEtag },
        })
        vi.spyOn(response, 'arrayBuffer').mockRejectedValue(new Error('body truncated'))
        fetchMock.mockResolvedValue(response)
        const storage = readyStorage()
        storage._lastDbEtag = acceptedEtag

        await expect(storage.readDatabaseCandidate()).rejects.toThrow('body truncated')
        expect(storage._lastDbEtag).toBe(acceptedEtag)
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

    test.each([
        ['committed', false, 'SAVE_FOLDER_IMPORT_POST_COMMIT_CLEANUP_FAILED'],
        ['not-committed', false, 'SAVE_FOLDER_IMPORT_NOT_COMMITTED'],
        ['unknown', true, 'SAVE_FOLDER_IMPORT_OUTCOME_UNKNOWN'],
    ] as const)(
        'preserves a save-folder direct-import %s outcome without replaying the POST',
        async (commitOutcome, commitOutcomeUnknown, code) => {
            fetchMock.mockResolvedValueOnce(jsonResponse({
                error: `direct import ${commitOutcome}`,
                code,
                retryable: commitOutcome === 'not-committed',
                commitOutcome,
                commitOutcomeUnknown,
            }, 500))

            const failure = await readyStorage().executeSaveFolderImport('/source')
                .then(() => null, error => error)

            expect(fetchMock).toHaveBeenCalledOnce()
            expect(failure).toBeInstanceOf(StorageError)
            expect(failure).toMatchObject({
                message: `direct import ${commitOutcome}`,
                status: 500,
                code,
                retryable: commitOutcome === 'not-committed',
                commitOutcome,
                commitOutcomeUnknown,
                operation: 'write',
            })
        },
    )

    test.each([
        ['committed', false],
        ['not-committed', true],
    ] as const)(
        'preserves an authoritative direct %s envelope whose server code is STORAGE_TIMEOUT',
        async (commitOutcome, retryable) => {
            fetchMock.mockResolvedValueOnce(jsonResponse({
                error: `server direct ${commitOutcome} timeout`,
                code: 'STORAGE_TIMEOUT',
                retryable,
                commitOutcome,
                commitOutcomeUnknown: false,
            }, 500))

            const failure = await readyStorage().executeSaveFolderImport('/source')
                .then(() => null, error => error)

            expect(fetchMock).toHaveBeenCalledOnce()
            expect(failure).toBeInstanceOf(StorageError)
            expect(failure).toMatchObject({
                message: `server direct ${commitOutcome} timeout`,
                status: 500,
                code: 'STORAGE_TIMEOUT',
                retryable,
                commitOutcome,
                commitOutcomeUnknown: false,
                operation: 'write',
            })
            expect((failure as Error).cause).toBeUndefined()
        },
    )

    test('turns the historical plain save-folder validation response into StorageError', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({
            error: 'Referenced REMOTE block missing is missing',
        }, 400))

        const failure = await readyStorage().executeSaveFolderImport('/source')
            .then(() => null, error => error)

        expect(fetchMock).toHaveBeenCalledOnce()
        expect(failure).toBeInstanceOf(StorageError)
        expect(failure).toMatchObject({
            message: 'Referenced REMOTE block missing is missing',
            status: 400,
            code: 'HTTP_400',
            retryable: false,
            commitOutcome: 'not-committed',
            commitOutcomeUnknown: false,
            operation: 'write',
        })
    })

    test('does not replay a direct save-folder import after its response is lost', async () => {
        fetchMock.mockRejectedValueOnce(new Error('socket closed after upload'))

        const failure = await readyStorage().executeSaveFolderImport('/source')
            .then(() => null, error => error)

        expect(fetchMock).toHaveBeenCalledOnce()
        expect(failure).toBeInstanceOf(StorageError)
        expect(failure).toMatchObject({
            message: 'socket closed after upload',
            code: 'COMMIT_OUTCOME_UNKNOWN',
            retryable: false,
            commitOutcome: 'unknown',
            commitOutcomeUnknown: true,
            operation: 'write',
        })
        expect((failure as Error).cause).toBeInstanceOf(StorageError)
        expect((failure as Error).cause).toMatchObject({
            code: 'COMMIT_OUTCOME_UNKNOWN',
            commitOutcomeUnknown: true,
            operation: 'write',
        })
    })

    test.each(['checkAuth', 'createAuth'] as const)(
        'classifies direct-import %s failure before dispatch as not committed',
        async (failurePoint) => {
            const storage = readyStorage()
            const cause = new DOMException(`${failurePoint} unavailable`, 'NotSupportedError')
            vi.spyOn(storage as any, failurePoint).mockRejectedValueOnce(cause)

            const failure = await storage.executeSaveFolderImport('/source')
                .then(() => null, error => error)

            expect(fetchMock).not.toHaveBeenCalled()
            expect(failure).toBeInstanceOf(StorageError)
            expect(failure).toMatchObject({
                message: `${failurePoint} unavailable`,
                status: null,
                code: 'SAVE_FOLDER_IMPORT_AUTH_FAILED',
                retryable: false,
                commitOutcome: 'not-committed',
                commitOutcomeUnknown: false,
                operation: 'write',
            })
            expect((failure as Error).cause).toBe(cause)
        },
    )

    test.each(['checkAuth', 'createAuth'] as const)(
        'bounds a never-resolving direct-import %s phase as not committed',
        async (failurePoint) => {
            vi.useFakeTimers()
            const storage = readyStorage()
            vi.spyOn(storage as any, failurePoint)
                .mockReturnValueOnce(new Promise(() => undefined))

            const pending = storage.executeSaveFolderImport('/source')
                .then(() => null, error => error)
            await vi.advanceTimersByTimeAsync(SAVE_FOLDER_IMPORT_TIMEOUT_MS)
            const failure = await pending

            expect(fetchMock).not.toHaveBeenCalled()
            expect(failure).toBeInstanceOf(StorageError)
            expect(failure).toMatchObject({
                message: 'Save-folder import timed out before mutation dispatch',
                status: null,
                code: 'SAVE_FOLDER_IMPORT_TIMEOUT',
                retryable: false,
                commitOutcome: 'not-committed',
                commitOutcomeUnknown: false,
                operation: 'write',
            })
            expect((failure as Error).cause).toBeInstanceOf(StorageError)
            expect((failure as Error).cause).toMatchObject({
                code: 'STORAGE_TIMEOUT',
                retryable: true,
                commitOutcomeUnknown: false,
                operation: 'write',
            })
            expect(vi.getTimerCount()).toBe(0)

            await vi.advanceTimersByTimeAsync(SAVE_FOLDER_IMPORT_TIMEOUT_MS)
            expect(fetchMock).not.toHaveBeenCalled()
        },
    )

    test('keeps a deadline immediately before direct dispatch not committed with no late request', async () => {
        vi.useFakeTimers()
        const storage = readyStorage()
        vi.spyOn(storage as any, 'createAuth').mockImplementationOnce(() => (
            new Promise(resolve => {
                setTimeout(() => resolve('late-token'), SAVE_FOLDER_IMPORT_TIMEOUT_MS + 1)
            })
        ))

        const pending = storage.executeSaveFolderImport('/source')
            .then(() => null, error => error)
        await vi.advanceTimersByTimeAsync(SAVE_FOLDER_IMPORT_TIMEOUT_MS)
        const failure = await pending

        expect(fetchMock).not.toHaveBeenCalled()
        expect(failure).toMatchObject({
            code: 'SAVE_FOLDER_IMPORT_TIMEOUT',
            retryable: false,
            commitOutcome: 'not-committed',
            commitOutcomeUnknown: false,
            operation: 'write',
        })
        expect((failure as Error).cause).toBeInstanceOf(StorageError)

        await vi.advanceTimersByTimeAsync(1)
        expect(fetchMock).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(0)
    })

    test('keeps a deadline immediately after direct dispatch unknown without replay', async () => {
        vi.useFakeTimers()
        const storage = readyStorage()
        vi.spyOn(storage as any, 'createAuth').mockImplementationOnce(() => (
            new Promise(resolve => {
                setTimeout(() => resolve('on-time-token'), SAVE_FOLDER_IMPORT_TIMEOUT_MS - 1)
            })
        ))
        fetchMock.mockImplementationOnce(() => new Promise(() => undefined))

        const pending = storage.executeSaveFolderImport('/source')
            .then(() => null, error => error)
        await vi.advanceTimersByTimeAsync(SAVE_FOLDER_IMPORT_TIMEOUT_MS - 1)
        expect(fetchMock).toHaveBeenCalledOnce()
        await vi.advanceTimersByTimeAsync(1)
        const failure = await pending

        expect(failure).toBeInstanceOf(StorageError)
        expect(failure).toMatchObject({
            status: null,
            code: 'COMMIT_OUTCOME_UNKNOWN',
            retryable: false,
            commitOutcome: 'unknown',
            commitOutcomeUnknown: true,
            operation: 'write',
        })
        expect((failure as Error).cause).toBeInstanceOf(StorageError)
        expect((failure as Error).cause).toMatchObject({
            code: 'COMMIT_OUTCOME_UNKNOWN',
            commitOutcomeUnknown: true,
            operation: 'write',
        })
        expect(vi.getTimerCount()).toBe(0)

        await vi.advanceTimersByTimeAsync(SAVE_FOLDER_IMPORT_TIMEOUT_MS)
        expect(fetchMock).toHaveBeenCalledOnce()
    })

    test('preserves a committed ZIP-import error and reports lost transport as unknown', async () => {
        let requests = 0
        class FakeXmlHttpRequest {
            status = 500
            responseText = JSON.stringify({
                error: 'ZIP import committed; cleanup failed',
                code: 'SAVE_FOLDER_IMPORT_POST_COMMIT_CLEANUP_FAILED',
                retryable: false,
                commitOutcome: 'committed',
                commitOutcomeUnknown: false,
            })
            upload: Record<string, any> = {}
            onerror: (() => void) | null = null
            onabort: (() => void) | null = null
            ontimeout: (() => void) | null = null
            onload: (() => void) | null = null
            open() {}
            setRequestHeader() {}
            send() {
                requests++
                this.onload?.()
            }
        }
        vi.stubGlobal('XMLHttpRequest', FakeXmlHttpRequest)

        const committed = await readyStorage().uploadSaveFolderZip(new Blob(['archive']))
            .then(() => null, error => error)
        expect(requests).toBe(1)
        expect(committed).toBeInstanceOf(StorageError)
        expect(committed).toMatchObject({
            message: 'ZIP import committed; cleanup failed',
            status: 500,
            code: 'SAVE_FOLDER_IMPORT_POST_COMMIT_CLEANUP_FAILED',
            retryable: false,
            commitOutcome: 'committed',
            commitOutcomeUnknown: false,
            operation: 'write',
        })

        class LostXmlHttpRequest extends FakeXmlHttpRequest {
            status = 0
            send() {
                requests++
                this.onerror?.()
            }
        }
        vi.stubGlobal('XMLHttpRequest', LostXmlHttpRequest)
        const unknown = await readyStorage().uploadSaveFolderZip(new Blob(['archive']))
            .then(() => null, error => error)
        expect(requests).toBe(2)
        expect(unknown).toBeInstanceOf(StorageError)
        expect(unknown).toMatchObject({
            code: 'COMMIT_OUTCOME_UNKNOWN',
            retryable: false,
            commitOutcome: 'unknown',
            commitOutcomeUnknown: true,
            operation: 'write',
        })
    })

    test.each([
        ['committed', false],
        ['not-committed', true],
    ] as const)(
        'preserves an authoritative ZIP %s envelope whose server code is STORAGE_TIMEOUT',
        async (commitOutcome, retryable) => {
            let requests = 0
            class AuthoritativeTimeoutXmlHttpRequest {
                status = 500
                responseText = JSON.stringify({
                    error: `server ZIP ${commitOutcome} timeout`,
                    code: 'STORAGE_TIMEOUT',
                    retryable,
                    commitOutcome,
                    commitOutcomeUnknown: false,
                })
                upload: Record<string, any> = {}
                onerror: (() => void) | null = null
                onabort: (() => void) | null = null
                ontimeout: (() => void) | null = null
                onload: (() => void) | null = null
                open() {}
                setRequestHeader() {}
                send() {
                    requests++
                    this.onload?.()
                }
            }
            vi.stubGlobal('XMLHttpRequest', AuthoritativeTimeoutXmlHttpRequest)

            const failure = await readyStorage().uploadSaveFolderZip(new Blob(['archive']))
                .then(() => null, error => error)

            expect(requests).toBe(1)
            expect(failure).toBeInstanceOf(StorageError)
            expect(failure).toMatchObject({
                message: `server ZIP ${commitOutcome} timeout`,
                status: 500,
                code: 'STORAGE_TIMEOUT',
                retryable,
                commitOutcome,
                commitOutcomeUnknown: false,
                operation: 'write',
            })
            expect((failure as Error).cause).toBeUndefined()
        },
    )

    test.each(['committed', 'not-committed'] as const)(
        'ignores exact-looking %s ZIP body when XHR status is zero',
        async (commitOutcome) => {
            let requests = 0
            class StatusZeroXmlHttpRequest {
                status = 0
                responseText = JSON.stringify({
                    error: `forged ${commitOutcome} outcome`,
                    code: 'FORGED_OUTCOME',
                    retryable: commitOutcome === 'not-committed',
                    commitOutcome,
                    commitOutcomeUnknown: false,
                })
                upload: Record<string, any> = {}
                onerror: (() => void) | null = null
                onabort: (() => void) | null = null
                ontimeout: (() => void) | null = null
                onload: (() => void) | null = null
                open() {}
                setRequestHeader() {}
                send() {
                    requests++
                    this.onload?.()
                }
            }
            vi.stubGlobal('XMLHttpRequest', StatusZeroXmlHttpRequest)

            const failure = await readyStorage().uploadSaveFolderZip(new Blob(['archive']))
                .then(() => null, error => error)

            expect(requests).toBe(1)
            expect(failure).toBeInstanceOf(StorageError)
            expect(failure).toMatchObject({
                message: 'Save-folder ZIP upload response was lost',
                status: null,
                code: 'COMMIT_OUTCOME_UNKNOWN',
                retryable: false,
                commitOutcome: 'unknown',
                commitOutcomeUnknown: true,
                operation: 'write',
            })
        },
    )

    test('wraps ZIP-import authentication failure as definitively not committed', async () => {
        const storage = readyStorage()
        const authFailure = new DOMException('auth signing unavailable', 'NotSupportedError')
        vi.spyOn(storage as any, 'createAuth').mockRejectedValueOnce(authFailure)

        const failure = await storage.uploadSaveFolderZip(new Blob(['archive']))
            .then(() => null, error => error)

        expect(failure).toBeInstanceOf(StorageError)
        expect(failure).toMatchObject({
            message: 'auth signing unavailable',
            code: 'SAVE_FOLDER_IMPORT_AUTH_FAILED',
            retryable: false,
            commitOutcome: 'not-committed',
            commitOutcomeUnknown: false,
            operation: 'write',
        })
    })

    test('bounds ZIP-import authentication and classifies its timeout as not committed', async () => {
        vi.useFakeTimers()
        const storage = readyStorage()
        vi.spyOn(storage as any, 'createAuth').mockReturnValueOnce(new Promise(() => undefined))
        const xhrConstructor = vi.fn()
        vi.stubGlobal('XMLHttpRequest', xhrConstructor)

        const pending = storage.uploadSaveFolderZip(new Blob(['archive']))
            .then(() => null, error => error)
        await vi.advanceTimersByTimeAsync(SAVE_FOLDER_IMPORT_TIMEOUT_MS)
        const failure = await pending

        expect(xhrConstructor).not.toHaveBeenCalled()
        expect(failure).toBeInstanceOf(StorageError)
        expect(failure).toMatchObject({
            message: 'Save-folder ZIP import timed out before mutation dispatch',
            code: 'SAVE_FOLDER_IMPORT_TIMEOUT',
            retryable: false,
            commitOutcome: 'not-committed',
            commitOutcomeUnknown: false,
            operation: 'write',
        })
    })

    test('bounds a dispatched ZIP import with no callbacks and cleans up its XHR', async () => {
        vi.useFakeTimers()
        let instance: SilentXmlHttpRequest | null = null
        class SilentXmlHttpRequest {
            status = 0
            responseText = ''
            upload: Record<string, any> = {}
            onerror: (() => void) | null = null
            onabort: (() => void) | null = null
            ontimeout: (() => void) | null = null
            onload: (() => void) | null = null
            timeoutAssignments: number[] = []
            abortCalls = 0
            sendCalls = 0
            private timeoutValue = 0
            constructor() {
                instance = this
            }
            get timeout() {
                return this.timeoutValue
            }
            set timeout(value: number) {
                this.timeoutValue = value
                this.timeoutAssignments.push(value)
            }
            open() {}
            setRequestHeader() {}
            send() {
                this.sendCalls++
            }
            abort() {
                this.abortCalls++
            }
        }
        vi.stubGlobal('XMLHttpRequest', SilentXmlHttpRequest)

        const pending = readyStorage().uploadSaveFolderZip(new Blob(['archive']))
            .then(() => null, error => error)
        await vi.advanceTimersByTimeAsync(SAVE_FOLDER_IMPORT_TIMEOUT_MS)
        const failure = await pending

        expect(failure).toBeInstanceOf(StorageError)
        expect(failure).toMatchObject({
            code: 'COMMIT_OUTCOME_UNKNOWN',
            retryable: false,
            commitOutcome: 'unknown',
            commitOutcomeUnknown: true,
            operation: 'write',
        })
        expect(instance).not.toBeNull()
        expect(instance!.sendCalls).toBe(1)
        expect(instance!.abortCalls).toBe(1)
        expect(instance!.timeoutAssignments).toEqual([
            SAVE_FOLDER_IMPORT_TIMEOUT_MS,
            0,
        ])
        expect(instance!.upload.onprogress).toBeNull()
        expect(instance!.onerror).toBeNull()
        expect(instance!.onabort).toBeNull()
        expect(instance!.ontimeout).toBeNull()
        expect(instance!.onload).toBeNull()

        await vi.advanceTimersByTimeAsync(SAVE_FOLDER_IMPORT_TIMEOUT_MS)
        expect(instance!.sendCalls).toBe(1)
        expect(instance!.abortCalls).toBe(1)
    })

    test.each([
        [
            'extra field',
            '{"error":"forged committed result","code":"FORGED","retryable":false,"commitOutcome":"committed","commitOutcomeUnknown":false,"extra":true}',
        ],
        [
            'missing field',
            '{"error":"forged committed result","code":"FORGED","commitOutcome":"committed","commitOutcomeUnknown":false}',
        ],
        [
            'wrong field type',
            '{"error":"forged committed result","code":"FORGED","retryable":"false","commitOutcome":"committed","commitOutcomeUnknown":false}',
        ],
        [
            'duplicate top-level field',
            '{"error":"first","error":"forged committed result","code":"FORGED","retryable":false,"commitOutcome":"committed","commitOutcomeUnknown":false}',
        ],
    ])(
        'treats a direct save-folder response with a %s as outcome unknown',
        async (_caseName, rawBody) => {
            fetchMock.mockResolvedValueOnce(new Response(rawBody, {
                status: 500,
                headers: { 'content-type': 'application/json' },
            }))

            const failure = await readyStorage().executeSaveFolderImport('/source')
                .then(() => null, error => error)

            expect(fetchMock).toHaveBeenCalledOnce()
            expect(failure).toBeInstanceOf(StorageError)
            expect(failure).toMatchObject({
                status: 500,
                code: 'COMMIT_OUTCOME_UNKNOWN',
                retryable: false,
                commitOutcome: 'unknown',
                commitOutcomeUnknown: true,
                operation: 'write',
            })
        },
    )

    test.each([
        [
            'failure envelope with an extra field',
            500,
            '{"error":"forged rollback","code":"FORGED","retryable":true,"commitOutcome":"not-committed","commitOutcomeUnknown":false,"extra":true}',
        ],
        [
            'success envelope with an extra field',
            200,
            '{"ok":true,"imported":1,"extra":true}',
        ],
        [
            'success envelope with a duplicate field',
            200,
            '{"ok":false,"ok":true,"imported":1}',
        ],
    ])(
        'treats a ZIP save-folder %s as outcome unknown',
        async (_caseName, status, responseText) => {
            let requests = 0
            class MalformedXmlHttpRequest {
                status = status
                responseText = responseText
                upload: Record<string, any> = {}
                onerror: (() => void) | null = null
                onabort: (() => void) | null = null
                ontimeout: (() => void) | null = null
                onload: (() => void) | null = null
                open() {}
                setRequestHeader() {}
                send() {
                    requests++
                    this.onload?.()
                }
            }
            vi.stubGlobal('XMLHttpRequest', MalformedXmlHttpRequest)

            const failure = await readyStorage().uploadSaveFolderZip(new Blob(['archive']))
                .then(() => null, error => error)

            expect(requests).toBe(1)
            expect(failure).toBeInstanceOf(StorageError)
            expect(failure).toMatchObject({
                status,
                code: 'COMMIT_OUTCOME_UNKNOWN',
                retryable: false,
                commitOutcome: 'unknown',
                commitOutcomeUnknown: true,
                operation: 'write',
            })
        },
    )

    test.each(['constructor', 'open', 'header', 'send'] as const)(
        'wraps synchronous XHR %s failure as not dispatched and never replays',
        async (failurePoint) => {
            let sendCalls = 0
            const thrown = new DOMException(`${failurePoint} failed`, 'InvalidStateError')
            class FailingXmlHttpRequest {
                status = 0
                responseText = ''
                upload: Record<string, any> = {}
                onerror: (() => void) | null = null
                onabort: (() => void) | null = null
                ontimeout: (() => void) | null = null
                onload: (() => void) | null = null
                constructor() {
                    if (failurePoint === 'constructor') throw thrown
                }
                open() {
                    if (failurePoint === 'open') throw thrown
                }
                setRequestHeader() {
                    if (failurePoint === 'header') throw thrown
                }
                send() {
                    sendCalls++
                    if (failurePoint === 'send') throw thrown
                }
            }
            vi.stubGlobal('XMLHttpRequest', FailingXmlHttpRequest)

            const failure = await readyStorage().uploadSaveFolderZip(new Blob(['archive']))
                .then(() => null, error => error)

            expect(sendCalls).toBe(failurePoint === 'send' ? 1 : 0)
            expect(failure).toBeInstanceOf(StorageError)
            expect(failure).toMatchObject({
                message: `${failurePoint} failed`,
                code: 'SAVE_FOLDER_IMPORT_NOT_DISPATCHED',
                retryable: false,
                commitOutcome: 'not-committed',
                commitOutcomeUnknown: false,
                operation: 'write',
            })
        },
    )
})
