import { describe, expect, test, vi } from 'vitest'

vi.mock('../globalApi.svelte', () => ({
    forageStorage: {
        getItem: vi.fn(async () => null),
    },
}))
vi.mock('./database.svelte', () => ({
    createBotPresetTemplate: () => ({ id: 'default-preset', name: 'New Preset' }),
    getDatabase: () => ({}),
}))
vi.mock('./chatStorage', () => ({
    chatToStub: (character: unknown) => character,
}))

const {
    decodeAuthoritativeRisuSave,
    decodeRisuSave,
} = await import('./risuSave')

const header = Buffer.from('RISUSAVE\0', 'binary')

function block(type: number, name: string, value: unknown): Buffer {
    return rawBlock(type, name, Buffer.from(JSON.stringify(value), 'utf-8'))
}

function rawBlock(type: number, name: string, body: Buffer): Buffer {
    const nameBytes = Buffer.from(name, 'utf-8')
    const prefix = Buffer.alloc(7 + nameBytes.length)
    prefix[0] = type
    prefix[1] = 0
    prefix[2] = nameBytes.length
    nameBytes.copy(prefix, 3)
    prefix.writeUInt32LE(body.length, 3 + nameBytes.length)
    return Buffer.concat([prefix, body])
}

function save(...blocks: Buffer[]): Uint8Array {
    return Buffer.concat([header, ...blocks])
}

describe('authoritative RisuSave block decoding', () => {
    test('accepts historical roots without a directory', async () => {
        await expect(decodeAuthoritativeRisuSave(save(
            block(1, 'root', { marker: 'historical' }),
        ))).resolves.toMatchObject({ marker: 'historical' })
    })

    test('accepts complete directories and ignores complete unknown future blocks', async () => {
        await expect(decodeAuthoritativeRisuSave(save(
            block(1, 'root', {
                marker: 'complete',
                __directory: ['character', 'future'],
            }),
            block(2, 'character', { chaId: 'character', name: 'Character', chats: [] }),
            rawBlock(200, 'future', Buffer.from([0xff, 0x00, 0x7f])),
        ))).resolves.toMatchObject({
            marker: 'complete',
            characters: [{ chaId: 'character', name: 'Character', chats: [] }],
        })
    })

    test('keeps permissive decoding available but rejects malformed known blocks authoritatively', async () => {
        const bytes = save(
            block(1, 'root', { marker: 'salvage-only' }),
            rawBlock(2, 'character', Buffer.from('{"chaId":', 'utf-8')),
        )

        await expect(decodeRisuSave(bytes)).resolves.toMatchObject({
            marker: 'salvage-only',
            characters: [],
        })
        await expect(decodeAuthoritativeRisuSave(bytes)).rejects.toMatchObject({
            code: 'RISU_SAVE_INVALID',
        })
    })

    test('rejects directories whose declared blocks cannot be recovered', async () => {
        await expect(decodeAuthoritativeRisuSave(save(
            block(1, 'root', {
                marker: 'partial',
                __directory: ['missing-character'],
            }),
        ))).rejects.toMatchObject({ code: 'RISU_SAVE_INVALID' })
    })

    test('rejects truncated framing instead of publishing blocks parsed before it', async () => {
        const bytes = save(
            block(1, 'root', { marker: 'partial' }),
            Buffer.from([2, 0, 9]),
        )

        await expect(decodeRisuSave(bytes)).resolves.toMatchObject({ marker: 'partial' })
        await expect(decodeAuthoritativeRisuSave(bytes)).rejects.toMatchObject({
            code: 'RISU_SAVE_INVALID',
        })
    })

    test('requires an object root block in authoritative mode', async () => {
        await expect(decodeAuthoritativeRisuSave(save(
            block(1, 'root', ['not', 'a', 'database']),
        ))).rejects.toMatchObject({ code: 'RISU_SAVE_INVALID' })

        await expect(decodeAuthoritativeRisuSave(save(
            block(2, 'character', { chaId: 'orphan', chats: [] }),
        ))).rejects.toMatchObject({ code: 'RISU_SAVE_INVALID' })
    })
})
