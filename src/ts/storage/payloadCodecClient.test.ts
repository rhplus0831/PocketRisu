import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyPatch } from 'fast-json-patch'
import { encodeRisuSaveLegacy } from './legacyRisuSaveCodec'
import { runPayloadCodecOperation, type PayloadCodecOperation } from './payloadCodecOperations'
import {
    PayloadCodecService,
    type PayloadCodecWorkerTransport,
} from './payloadCodecService'

const risuSaveMocks = vi.hoisted(() => ({
    decodeAuthoritativeRisuSave: vi.fn(),
}))

vi.mock('./risuSave', () => ({
    decodeAuthoritativeRisuSave: risuSaveMocks.decodeAuthoritativeRisuSave,
    normalizeJSON: (value: unknown) => structuredClone(value),
}))

vi.mock('./database.svelte', () => ({
    createBotPresetTemplate: () => ({ id: 'default-preset', name: 'New Preset' }),
}))

const {
    decodeAuthoritativeRisuSaveWithCodecWorker,
    encodeChatRowPayload,
    prepareChatRowCheckpoint,
    setPayloadCodecServiceForTests,
} = await import('./payloadCodecClient')

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
    const bytes = new Uint8Array(
        header.byteLength + blocks.reduce((sum, value) => sum + value.byteLength, 0),
    )
    bytes.set(header)
    let offset = header.byteLength
    for (const value of blocks) {
        bytes.set(value, offset)
        offset += value.byteLength
    }
    return bytes
}

afterEach(() => {
    risuSaveMocks.decodeAuthoritativeRisuSave.mockReset()
    setPayloadCodecServiceForTests(null)
})

describe('payload codec client integration', () => {
    it('deletes exactly the three runtime-only fields from current inline row snapshots', async () => {
        setPayloadCodecServiceForTests(new PayloadCodecService({
            supportsWorker: () => false,
            idleMs: -1,
        }))
        const live = {
            id: 'chat-projection',
            name: 'projection',
            note: 'durable note',
            localLore: [{ key: 'durable', content: 'keep me' }],
            message: [{
                role: 'user',
                data: 'hello',
                otherUser: 'durable-message-field',
                isStreaming: 'nested-field-is-not-a-chat-runtime-flag',
            }],
            scriptstate: { count: 1 },
            hypaV3Data: { memory: 'durable' },
            supaMemory: { memory: 'durable' },
            suggestMessages: ['durable'],
            sdData: { legacy: 'ambiguous-and-preserved' },
            otherUser: 'preserved-top-level-unknown',
            isStreaming: false,
            activeStreamingDisplayOptimizationMode: 'streaming',
            _placeholder: true,
        }
        const original = structuredClone(live)
        const expected = structuredClone(live) as Record<string, unknown>
        delete expected.isStreaming
        delete expected.activeStreamingDisplayOptimizationMode
        delete expected._placeholder

        const encoded = await encodeChatRowPayload(live, false)
        const checkpoint = await prepareChatRowCheckpoint(null, live)

        expect(encoded).toEqual({ bytes: encodeRisuSaveLegacy(expected), hash: null })
        expect(checkpoint.bytes).toEqual(encodeRisuSaveLegacy(expected))
        expect(checkpoint.snapshot).toEqual(expected)
        for (const field of [
            'isStreaming',
            'activeStreamingDisplayOptimizationMode',
            '_placeholder',
        ]) {
            expect(Object.prototype.hasOwnProperty.call(checkpoint.snapshot, field)).toBe(false)
        }
        expect(live).toEqual(original)
    })

    it('snapshots a live proxy at the original synchronous encode point', async () => {
        setPayloadCodecServiceForTests(new PayloadCodecService({
            supportsWorker: () => false,
            idleMs: -1,
        }))
        const original = {
            id: 'chat',
            name: 'timing',
            note: '',
            localLore: [],
            message: [{ role: 'user', data: 'before' }],
        }
        const live = new Proxy(structuredClone(original), {})

        const encoded = encodeChatRowPayload(live, false)
        live.message[0].data = 'after'

        await expect(encoded).resolves.toMatchObject({
            bytes: encodeRisuSaveLegacy(original),
            hash: null,
        })
    })

    it('snapshots both checkpoint graphs before worker work and returns the acknowledged baseline', async () => {
        setPayloadCodecServiceForTests(new PayloadCodecService({
            supportsWorker: () => false,
            idleMs: -1,
        }))
        const previous = {
            id: 'chat',
            message: [{ role: 'user', data: 'previous' }],
        }
        const current = {
            id: 'chat',
            message: [{ role: 'user', data: 'current' }],
        }
        const previousLive = new Proxy(structuredClone(previous), {})
        const currentLive = new Proxy(structuredClone(current), {})

        const pending = prepareChatRowCheckpoint(previousLive, currentLive)
        previousLive.message[0].data = 'mutated too late'
        currentLive.message[0].data = 'mutated too late'

        await expect(pending).resolves.toMatchObject({
            bytes: encodeRisuSaveLegacy(current),
            patch: [{ op: 'replace', path: '/message/0', value: current.message[0] }],
            snapshot: current,
        })
    })

    it('keeps an old-format base exact, heals with a full row, then proves a byte-exact worker delta', async () => {
        const operations: PayloadCodecOperation[] = []
        const transport: PayloadCodecWorkerTransport = {
            start: async () => undefined,
            execute: async (operation: PayloadCodecOperation, transfer = []) => {
                const cloned = structuredClone(operation, { transfer })
                operations.push(structuredClone(cloned))
                return runPayloadCodecOperation(cloned)
            },
            terminate: vi.fn(),
        }
        setPayloadCodecServiceForTests(new PayloadCodecService({
            supportsWorker: () => true,
            createTransport: () => transport,
            idleMs: -1,
        }))
        const oldBase = {
            id: 'old-format-chat',
            name: 'transition',
            message: [{ role: 'char', data: 'old bytes' }],
            scriptstate: { durable: true },
            isStreaming: true,
            activeStreamingDisplayOptimizationMode: 'streaming',
            _placeholder: true,
        }
        const checkpointLive = {
            ...oldBase,
            message: [{ role: 'char', data: 'checkpoint' }],
        }

        const checkpoint = await prepareChatRowCheckpoint(oldBase, checkpointLive)

        expect(checkpoint.patch).toBeNull()
        expect(checkpoint.snapshot).toEqual({
            id: 'old-format-chat',
            name: 'transition',
            message: [{ role: 'char', data: 'checkpoint' }],
            scriptstate: { durable: true },
        })
        expect(oldBase).toMatchObject({
            isStreaming: true,
            activeStreamingDisplayOptimizationMode: 'streaming',
            _placeholder: true,
        })
        expect(operations[0]).toMatchObject({
            kind: 'prepare-chat-checkpoint',
            previousChat: oldBase,
            chat: checkpoint.snapshot,
        })

        const finalLive = {
            ...checkpointLive,
            message: [{ role: 'char', data: 'final' }],
            isStreaming: false,
            activeStreamingDisplayOptimizationMode: undefined,
            _placeholder: false,
        }
        const final = await prepareChatRowCheckpoint(checkpoint.snapshot, finalLive)

        expect(final.patch).toEqual([{
            op: 'replace',
            path: '/message/0',
            value: { role: 'char', data: 'final' },
        }])
        expect(final.snapshot).toEqual({
            id: 'old-format-chat',
            name: 'transition',
            message: [{ role: 'char', data: 'final' }],
            scriptstate: { durable: true },
        })
        expect(operations[1]).toMatchObject({
            kind: 'prepare-chat-checkpoint',
            previousChat: checkpoint.snapshot,
            chat: final.snapshot,
        })
        const replayed = applyPatch(
            structuredClone(checkpoint.snapshot),
            final.patch!,
            true,
            false,
            true,
        ).newDocument
        expect(encodeRisuSaveLegacy(replayed)).toEqual(final.bytes)
    })

    it('offloads eligible strict block databases and applies the same bot-preset default', async () => {
        const transport: PayloadCodecWorkerTransport = {
            start: async () => undefined,
            execute: async (operation: PayloadCodecOperation, transfer = []) => {
                const cloned = structuredClone(operation, { transfer })
                return runPayloadCodecOperation(cloned)
            },
            terminate: vi.fn(),
        }
        setPayloadCodecServiceForTests(new PayloadCodecService({
            supportsWorker: () => true,
            createTransport: () => transport,
            idleMs: -1,
        }))
        const bytes = save(block(1, 'root', { marker: 'offloaded' }))

        await expect(decodeAuthoritativeRisuSaveWithCodecWorker(bytes)).resolves.toMatchObject({
            marker: 'offloaded',
            botPresets: [{ id: 'default-preset', name: 'New Preset' }],
            botPresetsId: 0,
        })
        expect(risuSaveMocks.decodeAuthoritativeRisuSave).not.toHaveBeenCalled()
    })

    it('keeps historical REMOTE block databases on the storage-aware main-thread decoder', async () => {
        const createTransport = vi.fn(() => {
            throw new Error('worker must not be created for REMOTE blocks')
        })
        setPayloadCodecServiceForTests(new PayloadCodecService({
            supportsWorker: () => true,
            createTransport,
            idleMs: -1,
        }))
        const bytes = save(
            block(1, 'root', { marker: 'remote' }),
            block(6, 'remote-character', { v: 1, type: 2, name: 'character' }),
        )
        risuSaveMocks.decodeAuthoritativeRisuSave.mockResolvedValueOnce({ marker: 'main' })

        await expect(decodeAuthoritativeRisuSaveWithCodecWorker(bytes))
            .resolves.toEqual({ marker: 'main' })
        expect(risuSaveMocks.decodeAuthoritativeRisuSave).toHaveBeenCalledWith(bytes)
        expect(createTransport).not.toHaveBeenCalled()
    })
})
