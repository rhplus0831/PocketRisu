import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    PLUGIN_BRIDGE_INITIALIZATION_TIMEOUT_MS,
    PLUGIN_BRIDGE_REQUEST_TIMEOUT_MS,
    SandboxHost,
    createV3BridgeRequestRegistry,
    deserializeV3BridgeError,
} from './factory'

function createRegistry(overrides: Partial<Parameters<typeof createV3BridgeRequestRegistry>[0]> = {}) {
    const send = vi.fn()
    const registry = createV3BridgeRequestRegistry({
        requestTimeoutMs: PLUGIN_BRIDGE_REQUEST_TIMEOUT_MS,
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
    it('uses generation-unique monotonic IDs and rejects stale timeout responses', async () => {
        vi.useFakeTimers()
        const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
        const { registry, send } = createRegistry()

        const first = registry.sendRequest('CALL_ROOT', {
            method: '_getPluginStorage',
            args: ['first'],
        }).catch(error => error)
        const firstId = send.mock.calls[0][0].reqId
        await vi.advanceTimersByTimeAsync(PLUGIN_BRIDGE_REQUEST_TIMEOUT_MS)
        await expect(first).resolves.toMatchObject({ code: 'STORAGE_TIMEOUT' })

        const second = registry.sendRequest('CALL_ROOT', {
            method: '_getPluginStorage',
            args: ['second'],
        })
        const secondRequest = send.mock.calls.find(
            ([message]) => message.type === 'CALL_ROOT' && message.args?.[0] === 'second',
        )?.[0]
        expect(secondRequest.reqId).not.toBe(firstId)
        expect(registry.handleResponse({
            type: 'RESPONSE',
            reqId: firstId,
            result: 'stale',
        })).toBe(false)
        expect(registry.pendingCount()).toBe(1)

        expect(registry.handleResponse({
            type: 'RESPONSE',
            reqId: secondRequest.reqId,
            result: 'current',
        })).toBe(true)
        await expect(second).resolves.toBe('current')
        randomSpy.mockRestore()
    })

    it('cancels a timed-out safe-local mutation and ignores a late response', async () => {
        vi.useFakeTimers()
        const { registry, send } = createRegistry()

        const result = registry.sendRequest('CALL_ROOT', {
            method: '_setSafeLocalStorage',
            args: ['key', 'value'],
        }).catch(error => error)
        expect(registry.pendingCount()).toBe(1)

        await vi.advanceTimersByTimeAsync(PLUGIN_BRIDGE_REQUEST_TIMEOUT_MS)
        const error = await result
        expect(error).toMatchObject({
            name: 'StorageError',
            code: 'COMMIT_OUTCOME_UNKNOWN',
            retryable: false,
            commitOutcomeUnknown: true,
            operation: 'write',
        })
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

    it('classifies remote SafeLocalStorage mutations as unknown after timeout', async () => {
        vi.useFakeTimers()
        const { registry, send } = createRegistry()

        const result = registry.sendRequest('CALL_INSTANCE', {
            id: 'safe-local-ref',
            method: 'removeItem',
            args: ['key'],
        }).catch(error => error)
        await vi.advanceTimersByTimeAsync(PLUGIN_BRIDGE_REQUEST_TIMEOUT_MS)

        await expect(result).resolves.toMatchObject({
            code: 'COMMIT_OUTCOME_UNKNOWN',
            commitOutcomeUnknown: true,
            operation: 'remove',
        })
        expect(send.mock.calls.at(-1)?.[0]?.type).toBe('CANCEL_REQUEST')
        expect(registry.pendingCount()).toBe(0)
    })

    it('cleans up immediately when argument serialization throws', async () => {
        vi.useFakeTimers()
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

        await vi.advanceTimersByTimeAsync(PLUGIN_BRIDGE_REQUEST_TIMEOUT_MS)
        expect(send).not.toHaveBeenCalled()
    })

    it('cleans up immediately when postMessage throws', async () => {
        vi.useFakeTimers()
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

        await vi.advanceTimersByTimeAsync(PLUGIN_BRIDGE_REQUEST_TIMEOUT_MS)
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

    it('terminates and rejects a guest whose initialization never settles', async () => {
        vi.useFakeTimers()
        const iframe = document.createElement('iframe')
        document.body.appendChild(iframe)
        const host = new SandboxHost({})
        let settled = false
        const startup = host.run(iframe, 'await new Promise(() => {});')
            .then(() => null, error => error)
            .finally(() => { settled = true })

        await vi.advanceTimersByTimeAsync(PLUGIN_BRIDGE_INITIALIZATION_TIMEOUT_MS - 1)
        expect(settled).toBe(false)
        expect(iframe.isConnected).toBe(true)

        await vi.advanceTimersByTimeAsync(1)
        await expect(startup).resolves.toMatchObject({
            name: 'PluginInitializationTimeoutError',
            code: 'PLUGIN_INITIALIZATION_TIMEOUT',
            retryable: false,
            commitOutcomeUnknown: false,
            operation: 'initialization',
        })
        expect(iframe.isConnected).toBe(true)
        host.terminate()
        expect(iframe.isConnected).toBe(false)
    })
})
