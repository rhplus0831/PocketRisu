import { afterEach, describe, expect, test, vi } from 'vitest'
import { StorageError } from '../../storage/storageError'
import {
    deserializeV3BridgeError,
    SandboxHost,
    serializeV3BridgeError,
    type V3BridgeErrorPayload,
} from './factory'

const cleanups: Array<() => void> = []

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
    document.body.replaceChildren()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

async function captureHostStartupCallError(thrown: unknown): Promise<V3BridgeErrorPayload | string> {
    if (typeof globalThis.ImageBitmap === 'undefined') {
        vi.stubGlobal('ImageBitmap', class ImageBitmap {})
    }
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const host = new SandboxHost({
        startupStorageCall: async () => { throw thrown },
    })
    cleanups.push(host.run(iframe, 'await risuai.startupStorageCall()'))

    const responses: any[] = []
    vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation((message: any) => {
        responses.push(message)
    })
    window.dispatchEvent(new MessageEvent('message', {
        source: iframe.contentWindow,
        data: {
            type: 'CALL_ROOT',
            reqId: 'startup-storage-request',
            method: 'startupStorageCall',
            args: [],
        },
    }))

    for (let attempt = 0; attempt < 20; attempt++) {
        const response = responses.find(item => (
            item?.type === 'RESPONSE' && item.reqId === 'startup-storage-request'
        ))
        if (response) return response.error
        await new Promise(resolve => setTimeout(resolve, 0))
    }
    throw new Error('Host did not return the startup storage error')
}

async function captureGuestHostGuestError(
    thrown: unknown,
): Promise<V3BridgeErrorPayload | string> {
    if (typeof globalThis.ImageBitmap === 'undefined') {
        vi.stubGlobal('ImageBitmap', class ImageBitmap {})
    }
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const host = new SandboxHost({
        invokeStartupCallback: async (callback: () => Promise<unknown>) => await callback(),
    })
    cleanups.push(host.run(iframe, 'await risuai.invokeStartupCallback(async () => {})'))

    const posted: any[] = []
    vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation((message: any) => {
        posted.push(message)
    })
    const source = iframe.contentWindow
    window.dispatchEvent(new MessageEvent('message', {
        source,
        data: {
            type: 'CALL_ROOT',
            reqId: 'guest-host-guest-root',
            method: 'invokeStartupCallback',
            args: [{ __type: 'CALLBACK_REF', id: 'startup-callback' }],
        },
    }))

    let callbackRequest: any
    for (let attempt = 0; attempt < 20; attempt++) {
        callbackRequest = posted.find(item => (
            item?.type === 'INVOKE_CALLBACK' && item.id === 'startup-callback'
        ))
        if (callbackRequest) break
        await new Promise(resolve => setTimeout(resolve, 0))
    }
    if (!callbackRequest) throw new Error('Host did not invoke the guest callback')

    window.dispatchEvent(new MessageEvent('message', {
        source,
        data: {
            type: 'CALLBACK_RETURN',
            reqId: callbackRequest.reqId,
            error: serializeV3BridgeError(thrown),
        },
    }))
    for (let attempt = 0; attempt < 20; attempt++) {
        const response = posted.find(item => (
            item?.type === 'RESPONSE' && item.reqId === 'guest-host-guest-root'
        ))
        if (response) return response.error
        await new Promise(resolve => setTimeout(resolve, 0))
    }
    throw new Error('Host did not return the guest callback error')
}

describe('V3 iframe error transport', () => {
    test('preserves structured plugin-storage failures for startup callers', () => {
        const source = new StorageError('Import owns storage', {
            status: 503,
            code: 'IMPORT_IN_PROGRESS',
            retryAfter: 5,
            retryable: true,
            commitOutcomeUnknown: false,
            operation: 'read',
        })

        const restored = deserializeV3BridgeError(serializeV3BridgeError(source)) as Error & {
            status: number
            code: string
            retryAfter: number
            retryable: boolean
            commitOutcomeUnknown: boolean
            operation: string
        }

        expect(restored).toMatchObject({
            name: 'StorageError',
            message: 'Import owns storage',
            status: 503,
            code: 'IMPORT_IN_PROGRESS',
            retryAfter: 5,
            retryable: true,
            commitOutcomeUnknown: false,
            operation: 'read',
        })
    })

    test('does not replace a thrown string with a generic host error', () => {
        const restored = deserializeV3BridgeError(serializeV3BridgeError('startup storage exploded'))
        expect(restored.message).toBe('startup storage exploded')
    })

    test('carries structured failures through the actual host RPC used at startup', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {})
        const payload = await captureHostStartupCallError(new StorageError('startup import collision', {
            status: 503,
            code: 'IMPORT_IN_PROGRESS',
            retryAfter: 5,
            retryable: true,
            commitOutcomeUnknown: false,
            operation: 'read',
        }))

        expect(deserializeV3BridgeError(payload)).toMatchObject({
            name: 'StorageError',
            message: 'startup import collision',
            status: 503,
            code: 'IMPORT_IN_PROGRESS',
            retryAfter: 5,
            retryable: true,
            commitOutcomeUnknown: false,
            operation: 'read',
        })
    })

    test('carries thrown-string messages through the actual startup host RPC', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {})
        const payload = await captureHostStartupCallError('literal startup failure')
        expect(deserializeV3BridgeError(payload).message).toBe('literal startup failure')
    })

    test('round-trips structured errors from guest callback through host and back to guest', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {})
        const payload = await captureGuestHostGuestError(new StorageError('guest storage callback failed', {
            status: 503,
            code: 'IMPORT_IN_PROGRESS',
            retryAfter: 5,
            retryable: true,
            commitOutcomeUnknown: false,
            operation: 'read',
        }))

        expect(deserializeV3BridgeError(payload)).toMatchObject({
            name: 'StorageError',
            message: 'guest storage callback failed',
            status: 503,
            code: 'IMPORT_IN_PROGRESS',
            retryAfter: 5,
            retryable: true,
            commitOutcomeUnknown: false,
            operation: 'read',
        })
    })

    test('accepts legacy string errors from either side of the bridge', () => {
        expect(deserializeV3BridgeError('legacy bridge failure').message)
            .toBe('legacy bridge failure')
    })
})
