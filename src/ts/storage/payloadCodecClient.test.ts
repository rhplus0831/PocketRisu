import { afterEach, describe, expect, it, vi } from 'vitest'
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
