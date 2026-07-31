import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    SandboxHost,
    createV3BridgeRequestRegistry,
    deserializeV3BridgeError,
} from './factory'

const FORMER_BRIDGE_DEADLINE_MS = 30 * 60_000

function createRegistry(overrides: Partial<Parameters<typeof createV3BridgeRequestRegistry>[0]> = {}) {
    const send = vi.fn()
    const registry = createV3BridgeRequestRegistry({
        serializeArgs: args => args,
        collectTransferables: () => [],
        send,
        deserializeError: deserializeV3BridgeError,
        deserializeResult: value => value,
        ...overrides,
    })
    return { registry, send }
}

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.replaceChildren()
})

describe('V3 bridge request availability', () => {
    it('keeps root and instance requests pending beyond the former deadline', async () => {
        vi.useFakeTimers()
        const { registry, send } = createRegistry()

        const root = registry.sendRequest('CALL_ROOT', {
            method: '_getPluginStorage',
            args: ['first'],
        })
        const instance = registry.sendRequest('CALL_INSTANCE', {
            id: 'remote-ref',
            method: 'getItem',
            args: ['second'],
        })
        const [rootRequest, instanceRequest] = send.mock.calls.map(([message]) => message)
        expect(instanceRequest.reqId).not.toBe(rootRequest.reqId)

        await vi.advanceTimersByTimeAsync(FORMER_BRIDGE_DEADLINE_MS + 1)
        expect(registry.pendingCount()).toBe(2)
        expect(send.mock.calls.some(([message]) => message.type === 'CANCEL_REQUEST')).toBe(false)

        expect(registry.handleResponse({
            type: 'RESPONSE',
            reqId: rootRequest.reqId,
            result: 'late-root',
        })).toBe(true)
        expect(registry.pendingCount()).toBe(1)
        expect(registry.handleResponse({
            type: 'RESPONSE',
            reqId: instanceRequest.reqId,
            result: 'late-instance',
        })).toBe(true)
        await expect(root).resolves.toBe('late-root')
        await expect(instance).resolves.toBe('late-instance')
        expect(registry.handleResponse({
            type: 'RESPONSE',
            reqId: rootRequest.reqId,
            result: 'stale',
        })).toBe(false)
    })

    it('cancels pending work only when its lifecycle ends', async () => {
        const { registry, send } = createRegistry()
        const cancellation = new Error('Plugin bridge terminated.')

        const result = registry.sendRequest('CALL_ROOT', {
            method: '_setSafeLocalStorage',
            args: ['key', 'value'],
        }).catch(error => error)
        expect(registry.pendingCount()).toBe(1)

        registry.cancelAll(cancellation)
        await expect(result).resolves.toBe(cancellation)
        expect(registry.pendingCount()).toBe(0)

        const request = send.mock.calls[0][0]
        expect(send.mock.calls[1][0]).toEqual({
            type: 'CANCEL_REQUEST',
            reqId: request.reqId,
        })
        expect(registry.handleResponse({
            type: 'RESPONSE',
            reqId: request.reqId,
            result: 'late-success',
        })).toBe(false)
    })

    it('preserves a structured storage deadline instead of replacing it', async () => {
        vi.useFakeTimers()
        const { registry, send } = createRegistry()

        const result = registry.sendRequest('CALL_INSTANCE', {
            id: 'safe-local-ref',
            method: 'removeItem',
            args: ['key'],
        }).catch(error => error)
        const request = send.mock.calls[0][0]

        await vi.advanceTimersByTimeAsync(FORMER_BRIDGE_DEADLINE_MS + 1)
        expect(registry.pendingCount()).toBe(1)
        expect(send).toHaveBeenCalledOnce()

        registry.handleResponse({
            type: 'RESPONSE',
            reqId: request.reqId,
            error: {
                __type: 'ERROR',
                name: 'StorageError',
                message: 'Plugin storage update timed out.',
                code: 'STORAGE_TIMEOUT',
                retryable: true,
                commitOutcomeUnknown: false,
                operation: 'update',
            },
        })

        await expect(result).resolves.toMatchObject({
            code: 'STORAGE_TIMEOUT',
            commitOutcomeUnknown: false,
            operation: 'update',
        })
        expect(registry.pendingCount()).toBe(0)
    })

    it('cleans up immediately when argument serialization throws', async () => {
        const serializationError = new DOMException('not cloneable', 'DataCloneError')
        const { registry, send } = createRegistry({
            serializeArgs: () => { throw serializationError },
        })

        await expect(registry.sendRequest('CALL_ROOT', {
            method: '_getPluginStorage',
            args: [{}],
        })).rejects.toBe(serializationError)
        expect(registry.pendingCount()).toBe(0)
        expect(send).not.toHaveBeenCalled()
    })

    it('cleans up immediately when postMessage throws', async () => {
        const postMessageError = new DOMException('detached frame', 'InvalidStateError')
        const throwingSend = vi.fn(() => { throw postMessageError })
        const { registry } = createRegistry({
            send: throwingSend,
        })

        await expect(registry.sendRequest('CALL_ROOT', {
            method: '_getPluginStorage',
            args: ['key'],
        })).rejects.toBe(postMessageError)
        expect(registry.pendingCount()).toBe(0)
        expect(throwingSend).toHaveBeenCalledOnce()
    })

    it('cleans up a successful request before resolving it', async () => {
        const { registry, send } = createRegistry()
        const result = registry.sendRequest('CALL_ROOT', {
            method: '_getPluginStorage',
            args: ['key'],
        })
        const reqId = send.mock.calls[0][0].reqId

        expect(registry.handleResponse({ type: 'RESPONSE', reqId, result: 42 })).toBe(true)
        expect(registry.pendingCount()).toBe(0)
        await expect(result).resolves.toBe(42)
        expect(registry.handleResponse({ type: 'RESPONSE', reqId, result: 43 })).toBe(false)
    })

    it('aborts supported host work when the guest cancels its request', async () => {
        vi.stubGlobal('ImageBitmap', class ImageBitmap {})
        let requestSignal: AbortSignal | undefined
        const api = {
            _setSafeLocalStorage: vi.fn((_key: string, _value: string, signal: AbortSignal) => {
                requestSignal = signal
                return new Promise<never>((_resolve, reject) => {
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
                })
            }),
        }
        const iframe = document.createElement('iframe')
        document.body.appendChild(iframe)
        const host = new SandboxHost(api)
        const startup = host.run(iframe, '').catch(() => undefined)
        const source = iframe.contentWindow!

        window.dispatchEvent(new MessageEvent('message', {
            source,
            origin: 'null',
            data: {
                type: 'CALL_ROOT',
                reqId: 'request-1',
                method: '_setSafeLocalStorage',
                args: ['key', 'value'],
            },
        }))
        await vi.waitFor(() => expect(requestSignal).toBeDefined())

        window.dispatchEvent(new MessageEvent('message', {
            source,
            origin: 'null',
            data: { type: 'CANCEL_REQUEST', reqId: 'request-1' },
        }))
        expect(requestSignal?.aborted).toBe(true)
        await Promise.resolve()

        host.terminate()
        await startup
    })

    it.each([
        { method: 'runLLMModel', args: [{ mode: 'main', messages: [] }] },
        { method: 'sendChat', args: ['hello'] },
    ])('injects lifecycle cancellation into $method', async ({ method, args }) => {
        vi.stubGlobal('ImageBitmap', class ImageBitmap {})
        let requestSignal: AbortSignal | undefined
        const api = {
            [method]: vi.fn((...receivedArgs: unknown[]) => {
                requestSignal = receivedArgs.at(-1) as AbortSignal
                return new Promise<never>((_resolve, reject) => {
                    requestSignal!.addEventListener(
                        'abort',
                        () => reject(requestSignal!.reason),
                        { once: true },
                    )
                })
            }),
        }
        const iframe = document.createElement('iframe')
        document.body.appendChild(iframe)
        const host = new SandboxHost(api)
        const startup = host.run(iframe, '').catch(() => undefined)
        const source = iframe.contentWindow!
        const reqId = `${method}-request`

        window.dispatchEvent(new MessageEvent('message', {
            source,
            origin: 'null',
            data: { type: 'CALL_ROOT', reqId, method, args },
        }))
        await vi.waitFor(() => expect(requestSignal).toBeInstanceOf(AbortSignal))

        window.dispatchEvent(new MessageEvent('message', {
            source,
            origin: 'null',
            data: { type: 'CANCEL_REQUEST', reqId },
        }))
        expect(requestSignal?.aborted).toBe(true)

        host.terminate()
        await startup
    })

    it('appends cancellation after the optional getDatabase argument', async () => {
        vi.stubGlobal('ImageBitmap', class ImageBitmap {})
        let receivedIncludeOnly: unknown = 'not-called'
        let requestSignal: AbortSignal | undefined
        const api = {
            getDatabase: vi.fn((includeOnly: unknown, signal: AbortSignal) => {
                receivedIncludeOnly = includeOnly
                requestSignal = signal
                return new Promise<never>((_resolve, reject) => {
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
                })
            }),
        }
        const iframe = document.createElement('iframe')
        document.body.appendChild(iframe)
        const host = new SandboxHost(api)
        const startup = host.run(iframe, '').catch(() => undefined)
        const source = iframe.contentWindow!

        window.dispatchEvent(new MessageEvent('message', {
            source,
            origin: 'null',
            data: {
                type: 'CALL_ROOT',
                reqId: 'database-request',
                method: 'getDatabase',
                args: [],
            },
        }))
        await vi.waitFor(() => expect(requestSignal).toBeDefined())
        expect(receivedIncludeOnly).toBeUndefined()

        window.dispatchEvent(new MessageEvent('message', {
            source,
            origin: 'null',
            data: { type: 'CANCEL_REQUEST', reqId: 'database-request' },
        }))
        expect(requestSignal?.aborted).toBe(true)
        host.terminate()
        await startup
    })

    it('keeps slow initialization alive until explicit teardown', async () => {
        vi.useFakeTimers()
        const iframe = document.createElement('iframe')
        document.body.appendChild(iframe)
        const host = new SandboxHost({})
        let settled = false
        const startup = host.run(iframe, 'await new Promise(() => {});')
            .then(() => null, error => error)
            .finally(() => { settled = true })

        await vi.advanceTimersByTimeAsync(FORMER_BRIDGE_DEADLINE_MS + 1)
        expect(settled).toBe(false)
        expect(iframe.isConnected).toBe(true)

        host.terminate()
        await expect(startup).resolves.toBeInstanceOf(Error)
        expect(iframe.isConnected).toBe(false)
    })
})
