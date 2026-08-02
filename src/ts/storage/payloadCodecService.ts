import type {
    PayloadCodecOperation,
    PayloadCodecResult,
} from './payloadCodecOperations'
import { runPayloadCodecOperation } from './payloadCodecOperations'
import {
    deserializeCodecError,
    type PayloadCodecWorkerRequest,
    type PayloadCodecWorkerResponse,
} from './payloadCodecWorkerProtocol'
import type { StrictRisuSaveDatabase } from './strictRisuSaveCodec'

export const PAYLOAD_CODEC_WORKER_IDLE_MS = 60_000
const PAYLOAD_CODEC_WORKER_STARTUP_TIMEOUT_MS = 5_000

export class PayloadCodecWorkerUnavailableError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options)
        this.name = 'PayloadCodecWorkerUnavailableError'
    }
}

export interface PayloadCodecWorkerTransport {
    start(): Promise<void>
    execute(
        operation: PayloadCodecOperation,
        transfer?: Transferable[],
    ): Promise<PayloadCodecResult>
    terminate(): void
}

type PendingRequest = ReturnType<typeof Promise.withResolvers<PayloadCodecResult>>

export class BrowserPayloadCodecWorkerTransport implements PayloadCodecWorkerTransport {
    private readonly ready = Promise.withResolvers<void>()
    private readonly pending = new Map<number, PendingRequest>()
    private readonly startupTimer: ReturnType<typeof setTimeout>
    private nextId = 1
    private terminated = false

    constructor(
        private readonly worker: Worker,
        startupTimeoutMs = PAYLOAD_CODEC_WORKER_STARTUP_TIMEOUT_MS,
    ) {
        worker.addEventListener('message', this.onMessage)
        worker.addEventListener('error', this.onError)
        worker.addEventListener('messageerror', this.onMessageError)
        this.startupTimer = setTimeout(() => {
            this.fail(new PayloadCodecWorkerUnavailableError(
                'Codec worker did not become ready in time.',
            ))
        }, startupTimeoutMs)
    }

    start(): Promise<void> {
        return this.ready.promise
    }

    execute(
        operation: PayloadCodecOperation,
        transfer: Transferable[] = [],
    ): Promise<PayloadCodecResult> {
        if (this.terminated) {
            return Promise.reject(new PayloadCodecWorkerUnavailableError(
                'Codec worker is unavailable.',
            ))
        }
        const id = this.nextId++
        const deferred = Promise.withResolvers<PayloadCodecResult>()
        this.pending.set(id, deferred)
        const request: PayloadCodecWorkerRequest = { type: 'request', id, operation }
        try {
            this.worker.postMessage(request, transfer)
        } catch (error) {
            this.pending.delete(id)
            const unavailable = new PayloadCodecWorkerUnavailableError(
                'Codec worker request could not be posted.',
                { cause: error },
            )
            deferred.reject(unavailable)
            this.fail(unavailable)
        }
        return deferred.promise
    }

    terminate(): void {
        if (this.terminated) return
        this.terminated = true
        clearTimeout(this.startupTimer)
        this.removeListeners()
        this.worker.terminate()
        const error = new PayloadCodecWorkerUnavailableError('Codec worker was terminated.')
        this.ready.reject(error)
        for (const deferred of this.pending.values()) deferred.reject(error)
        this.pending.clear()
    }

    private readonly onMessage = (event: MessageEvent<PayloadCodecWorkerResponse>) => {
        const message = event.data
        if (message?.type === 'ready') {
            clearTimeout(this.startupTimer)
            this.ready.resolve()
            return
        }
        if (!message || (message.type !== 'result' && message.type !== 'error')) return
        const deferred = this.pending.get(message.id)
        if (!deferred) return
        this.pending.delete(message.id)
        if (message.type === 'result') deferred.resolve(message.result)
        else deferred.reject(deserializeCodecError(message.error))
    }

    private readonly onError = (event: ErrorEvent) => {
        this.fail(new PayloadCodecWorkerUnavailableError(
            event.message || 'Codec worker crashed.',
            event.error === undefined ? undefined : { cause: event.error },
        ))
    }

    private readonly onMessageError = () => {
        this.fail(new PayloadCodecWorkerUnavailableError(
            'Codec worker returned an unreadable message.',
        ))
    }

    private fail(error: PayloadCodecWorkerUnavailableError): void {
        if (this.terminated) return
        this.terminated = true
        clearTimeout(this.startupTimer)
        this.removeListeners()
        this.worker.terminate()
        this.ready.reject(error)
        for (const deferred of this.pending.values()) deferred.reject(error)
        this.pending.clear()
    }

    private removeListeners(): void {
        this.worker.removeEventListener('message', this.onMessage)
        this.worker.removeEventListener('error', this.onError)
        this.worker.removeEventListener('messageerror', this.onMessageError)
    }
}

export interface PayloadCodecServiceOptions {
    supportsWorker?: () => boolean
    createTransport?: () => PayloadCodecWorkerTransport
    fallback?: typeof runPayloadCodecOperation
    idleMs?: number
}

function defaultWorkerSupport(): boolean {
    try {
        return typeof globalThis.Worker === 'function'
    } catch {
        return false
    }
}

function createBrowserTransport(): PayloadCodecWorkerTransport {
    const worker = new Worker(new URL('./payloadCodec.worker.ts', import.meta.url), {
        type: 'module',
        name: 'pocketrisu-payload-codec',
    })
    return new BrowserPayloadCodecWorkerTransport(worker)
}

export class PayloadCodecService {
    private readonly supportsWorker: () => boolean
    private readonly createTransport: () => PayloadCodecWorkerTransport
    private readonly fallback: typeof runPayloadCodecOperation
    private readonly idleMs: number
    private transport: PayloadCodecWorkerTransport | null = null
    private disabled = false
    private idleTimer: ReturnType<typeof setTimeout> | undefined
    private operationChain: Promise<void> = Promise.resolve()

    constructor(options: PayloadCodecServiceOptions = {}) {
        this.supportsWorker = options.supportsWorker ?? defaultWorkerSupport
        this.createTransport = options.createTransport ?? createBrowserTransport
        this.fallback = options.fallback ?? runPayloadCodecOperation
        this.idleMs = options.idleMs ?? PAYLOAD_CODEC_WORKER_IDLE_MS
    }

    encodeChat(chat: unknown, hash: boolean): Promise<{
        bytes: Uint8Array
        hash: string | null
    }> {
        const operation: PayloadCodecOperation = { kind: 'encode-chat', chat, hash }
        return this.enqueue(async () => {
            const result = await this.executeWithFallback(operation)
            if (result.kind !== 'encode-chat') throw new Error('Unexpected codec worker result')
            return { bytes: result.bytes, hash: result.hash }
        })
    }

    prepareChatCheckpoint(previousChat: unknown | null, chat: unknown): Promise<{
        bytes: Uint8Array
        hash: string | null
        patch: import('./chatDelta').ChatDeltaOperation[] | null
    }> {
        const operation: PayloadCodecOperation = {
            kind: 'prepare-chat-checkpoint',
            previousChat,
            chat,
        }
        return this.enqueue(async () => {
            const result = await this.executeWithFallback(operation)
            if (result.kind !== 'prepare-chat-checkpoint') {
                throw new Error('Unexpected codec worker result')
            }
            return { bytes: result.bytes, hash: result.hash, patch: result.patch }
        })
    }

    decodeStrictBlock(bytes: Uint8Array): Promise<StrictRisuSaveDatabase> {
        const fallbackOperation: PayloadCodecOperation = {
            kind: 'decode-strict-block',
            bytes,
        }
        return this.enqueue(async () => {
            const result = await this.executeWithFallback(
                fallbackOperation,
                () => {
                    // Keep the caller's original solely as crash-retry material.
                    // This exact copy becomes worker-owned and is detached here.
                    const workerBytes = Uint8Array.from(bytes)
                    return {
                        operation: {
                            kind: 'decode-strict-block',
                            bytes: workerBytes,
                        } satisfies PayloadCodecOperation,
                        transfer: [workerBytes.buffer],
                    }
                },
            )
            if (result.kind !== 'decode-strict-block') {
                throw new Error('Unexpected codec worker result')
            }
            return result.database
        })
    }

    dispose(): void {
        if (this.idleTimer) clearTimeout(this.idleTimer)
        this.idleTimer = undefined
        this.transport?.terminate()
        this.transport = null
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.operationChain.then(operation, operation)
        this.operationChain = result.then(() => undefined, () => undefined)
        return result
    }

    private async executeWithFallback(
        fallbackOperation: PayloadCodecOperation,
        prepareWorkerOperation?: () => {
            operation: PayloadCodecOperation
            transfer: Transferable[]
        },
    ): Promise<PayloadCodecResult> {
        const transport = await this.getTransport()
        if (!transport) return this.fallback(fallbackOperation)
        const prepared = prepareWorkerOperation?.() ?? {
            operation: fallbackOperation,
            transfer: [],
        }
        if (this.idleTimer) clearTimeout(this.idleTimer)
        this.idleTimer = undefined
        try {
            return await transport.execute(prepared.operation, prepared.transfer)
        } catch (error) {
            if (!(error instanceof PayloadCodecWorkerUnavailableError)) throw error
            this.disableWorker(transport)
            return this.fallback(fallbackOperation)
        } finally {
            this.scheduleIdleTermination()
        }
    }

    private async getTransport(): Promise<PayloadCodecWorkerTransport | null> {
        if (this.disabled) return null
        try {
            if (!this.supportsWorker()) return null
        } catch {
            this.disabled = true
            return null
        }
        if (this.transport) return this.transport
        let transport: PayloadCodecWorkerTransport
        try {
            transport = this.createTransport()
            await transport.start()
        } catch (error) {
            this.disabled = true
            try {
                transport?.terminate()
            } catch {
                // Startup failure already selected the shared fallback.
            }
            return null
        }
        this.transport = transport
        return transport
    }

    private disableWorker(transport: PayloadCodecWorkerTransport): void {
        if (this.transport === transport) this.transport = null
        this.disabled = true
        try {
            transport.terminate()
        } catch {
            // Codec work is pure; the retained input still falls back below.
        }
    }

    private scheduleIdleTermination(): void {
        if (!this.transport || this.disabled || this.idleMs < 0) return
        if (this.idleTimer) clearTimeout(this.idleTimer)
        this.idleTimer = setTimeout(() => {
            this.idleTimer = undefined
            this.transport?.terminate()
            this.transport = null
        }, this.idleMs)
    }
}
