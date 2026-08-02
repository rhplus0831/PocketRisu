import { describe, expect, test, vi } from 'vitest'

const forageStorageMocks = vi.hoisted(() => ({
    getItem: vi.fn(async () => null as Uint8Array | null),
}))

vi.mock('../globalApi.svelte', () => ({
    forageStorage: {
        getItem: forageStorageMocks.getItem,
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
    RisuSaveEncoder,
    RisuSavePatcher,
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

function databaseWithCharacter(chaId: string) {
    return {
        marker: `database-${chaId}`,
        characters: [{ chaId, name: chaId, chats: [] }],
        botPresets: [],
        modules: [],
        plugins: [],
        pluginCustomStorage: {},
    }
}

function noTrackedChanges(character: string[] = []) {
    return {
        character,
        chat: [],
        root: false,
        botPreset: false,
        modules: false,
        plugins: false,
        pluginCustomStorage: false,
    }
}

function retainEncodedBlock(encoded: ArrayBuffer, wantedName: string): Uint8Array {
    const bytes = Buffer.from(encoded)
    let offset = header.length
    while (offset < bytes.length) {
        const blockStart = offset
        const nameLength = bytes[offset + 2]
        const nameStart = offset + 3
        const nameEnd = nameStart + nameLength
        const name = bytes.subarray(nameStart, nameEnd).toString('utf-8')
        const bodyLength = bytes.readUInt32LE(nameEnd)
        const blockEnd = nameEnd + 4 + bodyLength
        if (name === wantedName) {
            return Buffer.concat([header, bytes.subarray(blockStart, blockEnd)])
        }
        offset = blockEnd
    }
    throw new Error(`Encoded block ${wantedName} was not found`)
}

describe('authoritative RisuSave block decoding', () => {
    test('parses each known JSON block exactly once', async () => {
        const directory = [
            'config',
            'character',
            'chat',
            'presets',
            'modules',
            'root-component',
            'plugins',
            'loadouts',
            'plugin-storage',
            'remote-character',
            'future',
        ]
        const bytes = save(
            block(1, 'root', { marker: 'parse-once', __directory: directory }),
            block(0, 'config', { ignored: true }),
            block(2, 'character', { chaId: 'character', chats: [] }),
            block(3, 'chat', { ignored: true }),
            block(4, 'presets', [{ id: 'preset' }]),
            block(5, 'modules', []),
            block(8, 'root-component', { key: 'componentMarker', data: 'present' }),
            block(9, 'plugins', []),
            block(10, 'loadouts', { ignored: true }),
            block(11, 'plugin-storage', {}),
            block(6, 'remote-character', {
                v: 1,
                type: 2,
                name: 'remote-character',
            }),
            rawBlock(200, 'future', Buffer.from([0xff, 0x00, 0x7f])),
        )
        forageStorageMocks.getItem.mockResolvedValueOnce(
            Buffer.from(JSON.stringify({ chaId: 'remote-character', chats: [] }), 'utf-8'),
        )
        const parse = vi.spyOn(JSON, 'parse')

        try {
            await expect(decodeAuthoritativeRisuSave(bytes)).resolves.toMatchObject({
                marker: 'parse-once',
                componentMarker: 'present',
                characters: [
                    { chaId: 'character', chats: [] },
                    { chaId: 'remote-character', chats: [] },
                ],
            })
            expect(parse).toHaveBeenCalledTimes(12)
        } finally {
            parse.mockRestore()
        }
    })

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

    test('never recovers authoritative blocks from the encoder cache', async () => {
        const chaId = 'strict-cached-character'
        const database = databaseWithCharacter(chaId)
        const encoder = new RisuSaveEncoder()
        await encoder.init(database as never)
        // set() writes the directory-bearing root used by normal persistence.
        await encoder.set(database as never, noTrackedChanges())
        const encoded = encoder.encode()
        expect(encoded).not.toBeNull()
        const rootOnly = retainEncodedBlock(encoded!, 'root')

        // Permissive decoding retains the legacy same-generation recovery path.
        await expect(decodeRisuSave(rootOnly)).resolves.toMatchObject({
            characters: [{ chaId }],
        })
        // Authoritative validation must be a function of the supplied bytes.
        await expect(decodeAuthoritativeRisuSave(rootOnly)).rejects.toMatchObject({
            code: 'RISU_SAVE_INVALID',
        })
    })

    test('evicts cached character JSON when its encoder block is deleted', async () => {
        const chaId = 'deleted-cached-character'
        const encoder = new RisuSaveEncoder()
        const database = databaseWithCharacter(chaId)
        await encoder.init(database as never)
        await encoder.set({ ...database, characters: [] } as never, noTrackedChanges([chaId]))

        const decoded = await decodeRisuSave(save(
            block(1, 'root', { __directory: [chaId] }),
        ))
        expect(decoded.characters ?? []).toEqual([])
    })

    test('clears recovery blocks when a new encoder generation starts', async () => {
        const chaId = 'previous-generation-character'
        const previousEncoder = new RisuSaveEncoder()
        await previousEncoder.init(databaseWithCharacter(chaId) as never)

        const nextEncoder = new RisuSaveEncoder()
        await nextEncoder.init({
            ...databaseWithCharacter('unused'),
            characters: [],
        } as never)

        const decoded = await decodeRisuSave(save(
            block(1, 'root', { __directory: [chaId] }),
        ))
        expect(decoded.characters ?? []).toEqual([])
    })

    test('cache false evicts an earlier block from the same generation', async () => {
        const chaId = 'cache-disabled-character'
        const encoder = new RisuSaveEncoder()
        await encoder.init(databaseWithCharacter(chaId) as never)
        await encoder.encodeRawBlock({
            compression: false,
            data: JSON.stringify({ chaId, name: 'must-not-recover', chats: [] }),
            type: 2,
            name: chaId,
            cache: false,
        })
        await encoder.set(databaseWithCharacter(chaId) as never, noTrackedChanges())

        const decoded = await decodeRisuSave(save(
            block(1, 'root', { __directory: [chaId] }),
        ))
        expect(decoded.characters ?? []).toEqual([])
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

    test('transfers the exact full-write baseline to a patcher without decoding its bytes', async () => {
        const database = {
            ...databaseWithCharacter('baseline-transfer-character'),
            botPresets: [{ id: 'preset-a', name: 'Preset A' }],
            username: 'wire-baseline',
        }
        const encoder = new RisuSaveEncoder()
        await encoder.init(database as never)
        await encoder.set(database as never, noTrackedChanges())
        const encoded = encoder.encode()
        expect(encoded).not.toBeNull()

        const transferred = encoder.takeNormalizedBaseline()
        const decoded = await decodeAuthoritativeRisuSave(new Uint8Array(encoded!))
        expect(transferred).toEqual(decoded)
        expect(() => encoder.takeNormalizedBaseline()).toThrow(
            'RisuSave encoder has no assembled normalized baseline',
        )

        const patcher = new RisuSavePatcher()
        await patcher.initNormalizedBaseline(transferred)
        const proposal = await patcher.set(decoded, noTrackedChanges())
        expect(proposal.patch).toEqual([])
    })
})
