import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeRisuSaveLegacy } from './legacyRisuSaveCodec'
import { runPayloadCodecOperation, type PayloadCodecOperation } from './payloadCodecOperations'
import {
    PayloadCodecService,
    PayloadCodecWorkerUnavailableError,
    type PayloadCodecWorkerTransport,
} from './payloadCodecService'
import {
    deserializeCodecError,
    serializeCodecError,
} from './payloadCodecWorkerProtocol'
import { sha256OwnedBytes } from './payloadHash'
import {
    decodeStrictRisuSaveBlocks,
    RisuSaveBlockIntegrityError,
} from './strictRisuSaveCodec'

function rawBlock(type: number, name: string, body: Uint8Array): Uint8Array {
    const nameBytes = new TextEncoder().encode(name)
    const bytes = new Uint8Array(7 + nameBytes.byteLength + body.byteLength)
    bytes[0] = type
    bytes[1] = 0
    bytes[2] = nameBytes.byteLength
    bytes.set(nameBytes, 3)
    new DataView(bytes.buffer).setUint32(3 + nameBytes.byteLength, body.byteLength, true)
    bytes.set(body, 7 + nameBytes.byteLength)
    return bytes
}

function block(type: number, name: string, value: unknown): Uint8Array {
    return rawBlock(type, name, new TextEncoder().encode(JSON.stringify(value)))
}

function save(...blocks: Uint8Array[]): Uint8Array {
    const header = new TextEncoder().encode('RISUSAVE\0')
    const length = header.byteLength + blocks.reduce((total, value) => total + value.byteLength, 0)
    const bytes = new Uint8Array(length)
    bytes.set(header)
    let offset = header.byteLength
    for (const value of blocks) {
        bytes.set(value, offset)
        offset += value.byteLength
    }
    return bytes
}

class ShimWorkerTransport implements PayloadCodecWorkerTransport {
    readonly transfers: number[] = []
    readonly detachedWorkerResults: number[] = []
    terminated = false

    async start(): Promise<void> {}

    async execute(operation: PayloadCodecOperation, transfer: Transferable[] = []) {
        this.transfers.push(transfer.length)
        const workerOperation = structuredClone(operation, { transfer })
        try {
            const workerResult = await runPayloadCodecOperation(workerOperation)
            if (workerResult.kind !== 'encode-chat') return structuredClone(workerResult)
            const byteLength = workerResult.bytes.byteLength
            const mainResult = structuredClone(workerResult, {
                transfer: [workerResult.bytes.buffer],
            })
            this.detachedWorkerResults.push(workerResult.bytes.byteLength)
            expect(byteLength).toBeGreaterThan(0)
            return mainResult
        } catch (error) {
            throw deserializeCodecError(serializeCodecError(error))
        }
    }

    terminate(): void {
        this.terminated = true
    }
}

function representativeChat(name: string) {
    return {
        id: `chat-${name}`,
        name,
        note: 'persistent note',
        localLore: [{ key: 'lore', content: 'remember this', insertorder: 1 }],
        message: [
            { role: 'user', data: 'hello', chatId: 'message-1', time: 1 },
            {
                role: 'char',
                data: 'world',
                chatId: 'message-2',
                generationInfo: { model: 'test-model', inputTokens: 12, outputTokens: 4 },
                swipes: ['world', 'alternate'],
            },
        ],
        scriptstate: { count: 2, enabled: true },
        modules: ['module-a'],
    }
}

afterEach(() => {
    vi.useRealTimers()
})

describe('PayloadCodecService', () => {
    it('produces byte-exact chat rows and hashes through worker and fallback paths', async () => {
        const chat = representativeChat('parity')
        const expectedBytes = encodeRisuSaveLegacy(chat)
        const expectedHash = await sha256OwnedBytes(expectedBytes)
        const shim = new ShimWorkerTransport()
        const workerService = new PayloadCodecService({
            supportsWorker: () => true,
            createTransport: () => shim,
            idleMs: -1,
        })
        const fallbackService = new PayloadCodecService({
            supportsWorker: () => false,
            idleMs: -1,
        })

        const worker = await workerService.encodeChat(chat, true)
        const fallback = await fallbackService.encodeChat(chat, true)

        expect(worker.bytes).toEqual(expectedBytes)
        expect(fallback.bytes).toEqual(expectedBytes)
        expect(worker.hash).toBe(expectedHash)
        expect(fallback.hash).toBe(expectedHash)
        expect(shim.transfers).toEqual([0])
        expect(shim.detachedWorkerResults).toEqual([0])
    })

    it('prepares an exact whole-message delta in the codec worker path', async () => {
        const previous = representativeChat('checkpoint')
        const current = structuredClone(previous)
        current.message[1].data = 'streamed edit'
        current.message.push({
            role: 'char',
            data: 'new message',
            chatId: 'message-3',
            generationInfo: { model: 'test-model', inputTokens: 2, outputTokens: 1 },
            swipes: ['new message'],
        })
        const expectedBytes = encodeRisuSaveLegacy(current)
        const expectedHash = await sha256OwnedBytes(expectedBytes)
        const service = new PayloadCodecService({ supportsWorker: () => false, idleMs: -1 })

        await expect(service.prepareChatCheckpoint(previous, current)).resolves.toEqual({
            bytes: expectedBytes,
            hash: expectedHash,
            patch: [
                { op: 'replace', path: '/message/1', value: current.message[1] },
                { op: 'add', path: '/message/-', value: current.message[2] },
            ],
        })
    })

    it('falls back when JSON equality cannot prove byte-exact MessagePack replay', async () => {
        const previous = {
            id: 'chat',
            message: [{ role: 'user', data: 'same' }],
        }
        const reordered = {
            id: 'chat',
            message: [{ data: 'same', role: 'user' }],
        }
        const changedTopLevel = {
            ...previous,
            name: 'not representable by the chat delta subset',
        }
        const service = new PayloadCodecService({ supportsWorker: () => false, idleMs: -1 })

        await expect(service.prepareChatCheckpoint(previous, reordered))
            .resolves.toMatchObject({ patch: null })
        await expect(service.prepareChatCheckpoint(previous, changedTopLevel))
            .resolves.toMatchObject({ patch: null })
    })

    it('transfers an owned strict block copy while retaining crash-retry bytes', async () => {
        const bytes = save(
            block(1, 'root', { marker: 'worker', __directory: ['character'] }),
            block(2, 'character', { chaId: 'character', chats: [] }),
        )
        const original = Uint8Array.from(bytes)
        const shim = new ShimWorkerTransport()
        const service = new PayloadCodecService({
            supportsWorker: () => true,
            createTransport: () => shim,
            idleMs: -1,
        })
        const fallbackService = new PayloadCodecService({
            supportsWorker: () => false,
            idleMs: -1,
        })

        const decoded = await service.decodeStrictBlock(bytes)
        const fallbackDecoded = await fallbackService.decodeStrictBlock(bytes)

        expect(decoded).toEqual(await decodeStrictRisuSaveBlocks(original))
        expect(decoded).toEqual(fallbackDecoded)
        expect(bytes).toEqual(original)
        expect(bytes.byteLength).toBeGreaterThan(0)
        expect(shim.transfers).toEqual([1])
    })

    it('preserves strict block refusal type, code, message, and cause across the boundary', async () => {
        const bytes = save(
            block(1, 'root', { marker: 'bad' }),
            rawBlock(2, 'character', new TextEncoder().encode('{"chaId":')),
        )
        const directError = await decodeStrictRisuSaveBlocks(bytes).catch(error => error)
        const service = new PayloadCodecService({
            supportsWorker: () => true,
            createTransport: () => new ShimWorkerTransport(),
            idleMs: -1,
        })
        const workerError = await service.decodeStrictBlock(bytes).catch(error => error)

        expect(directError).toBeInstanceOf(RisuSaveBlockIntegrityError)
        expect(workerError).toBeInstanceOf(RisuSaveBlockIntegrityError)
        expect(workerError).toMatchObject({
            code: 'RISU_SAVE_INVALID',
            name: directError.name,
            message: directError.message,
        })
        expect((workerError as Error).cause).toMatchObject({
            name: ((directError as Error).cause as Error | undefined)?.name,
        })
    })

    it('uses the shared fallback without constructing a worker when feature detection fails', async () => {
        const createTransport = vi.fn()
        const fallback = vi.fn(runPayloadCodecOperation)
        const service = new PayloadCodecService({
            supportsWorker: () => false,
            createTransport,
            fallback,
            idleMs: -1,
        })

        const result = await service.encodeChat(representativeChat('unsupported'), false)

        expect(result.bytes).toEqual(encodeRisuSaveLegacy(representativeChat('unsupported')))
        expect(createTransport).not.toHaveBeenCalled()
        expect(fallback).toHaveBeenCalledOnce()
    })

    it('treats a throwing worker feature probe as unsupported', async () => {
        const createTransport = vi.fn()
        const fallback = vi.fn(runPayloadCodecOperation)
        const service = new PayloadCodecService({
            supportsWorker: () => { throw new Error('blocked global') },
            createTransport,
            fallback,
            idleMs: -1,
        })

        await expect(service.encodeChat(representativeChat('blocked'), false))
            .resolves.toMatchObject({ hash: null })
        expect(createTransport).not.toHaveBeenCalled()
        expect(fallback).toHaveBeenCalledOnce()
    })

    it('degrades startup failure to the shared fallback and does not retry worker startup', async () => {
        const createTransport = vi.fn((): PayloadCodecWorkerTransport => ({
            start: async () => { throw new Error('CSP blocked worker startup') },
            execute: vi.fn(),
            terminate: vi.fn(),
        }))
        const fallback = vi.fn(runPayloadCodecOperation)
        const service = new PayloadCodecService({
            supportsWorker: () => true,
            createTransport,
            fallback,
            idleMs: -1,
        })

        await service.encodeChat(representativeChat('first'), false)
        await service.encodeChat(representativeChat('second'), false)

        expect(createTransport).toHaveBeenCalledOnce()
        expect(fallback).toHaveBeenCalledTimes(2)
    })

    it('falls back once on a mid-operation crash and keeps queued checkpoint encodes ordered', async () => {
        const crashed = Promise.withResolvers<never>()
        const execute = vi.fn(() => crashed.promise)
        const transport: PayloadCodecWorkerTransport = {
            start: async () => undefined,
            execute,
            terminate: vi.fn(),
        }
        const fallbackOrder: string[] = []
        const fallback = vi.fn(async (operation: PayloadCodecOperation) => {
            if (operation.kind === 'encode-chat') {
                fallbackOrder.push((operation.chat as { name: string }).name)
            }
            return runPayloadCodecOperation(operation)
        })
        const service = new PayloadCodecService({
            supportsWorker: () => true,
            createTransport: () => transport,
            fallback,
            idleMs: -1,
        })

        const first = service.encodeChat(representativeChat('checkpoint-1'), false)
        const second = service.encodeChat(representativeChat('checkpoint-2'), false)
        await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
        crashed.reject(new PayloadCodecWorkerUnavailableError('worker crashed'))

        await expect(first).resolves.toMatchObject({ hash: null })
        await expect(second).resolves.toMatchObject({ hash: null })
        expect(execute).toHaveBeenCalledOnce()
        expect(fallbackOrder).toEqual(['checkpoint-1', 'checkpoint-2'])
        expect(transport.terminate).toHaveBeenCalledOnce()
    })

    it('terminates the single worker after idle and lazily starts one replacement', async () => {
        vi.useFakeTimers()
        const transports: ShimWorkerTransport[] = []
        const service = new PayloadCodecService({
            supportsWorker: () => true,
            createTransport: () => {
                const transport = new ShimWorkerTransport()
                transports.push(transport)
                return transport
            },
            idleMs: 100,
        })

        await service.encodeChat(representativeChat('before-idle'), false)
        expect(transports).toHaveLength(1)
        await vi.advanceTimersByTimeAsync(100)
        expect(transports[0].terminated).toBe(true)
        await service.encodeChat(representativeChat('after-idle'), false)
        expect(transports).toHaveLength(2)
    })
})
