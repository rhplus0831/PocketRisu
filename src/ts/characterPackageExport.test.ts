import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    alertConfirm: vi.fn(async () => true),
    alertError: vi.fn(),
    alertSet: vi.fn(),
    getCharacterInterchangeSnapshot: vi.fn(),
    streamCharacterChats: vi.fn(),
    localWriterInit: vi.fn(async () => undefined),
    zipWrite: vi.fn<(
        path: string,
        data: Uint8Array | string,
        level?: number,
    ) => Promise<void>>(async () => undefined),
    zipEnd: vi.fn(async () => undefined),
    getInlayAsset: vi.fn(),
    getInlayInfosBatch: vi.fn(),
    getInlayMeta: vi.fn(),
    getInlayMetasBatch: vi.fn(),
}))

vi.mock('./alert', () => ({
    alertConfirm: mocks.alertConfirm,
    alertError: mocks.alertError,
    alertStore: { set: mocks.alertSet },
    alertWait: vi.fn(),
    notifySuccess: vi.fn(),
}))
vi.mock('./characterCards', () => ({
    exportCharacterCard: vi.fn(),
    importCharacterProcess: vi.fn(),
}))
vi.mock('./globalApi.svelte', () => ({
    LocalWriter: class {
        init = mocks.localWriterInit
    },
    markCharacterDirty: vi.fn(),
    readImage: vi.fn(),
    checkCharOrder: vi.fn(),
}))
vi.mock('src/lang', () => ({
    language: new Proxy({}, { get: (_target, key) => String(key) }),
}))
vi.mock('./storage/database.svelte', () => ({
    getCharacterInterchangeSnapshot: mocks.getCharacterInterchangeSnapshot,
    getDatabase: vi.fn(() => ({ personas: [] })),
    setDatabase: vi.fn(),
    saveImage: vi.fn(),
    normalizeChat: vi.fn(),
}))
vi.mock('./storage/chatStorage', () => ({
    saveChatToServer: vi.fn(),
    chatToStub: vi.fn(),
    stubToPlaceholder: vi.fn(),
}))
vi.mock('./storage/interchangeChatStream', () => ({
    MissingInterchangeChatError: class extends Error {},
    streamCharacterChats: mocks.streamCharacterChats,
}))
vi.mock('./util', () => ({ selectFileByDom: vi.fn() }))
vi.mock('./characters', () => ({ createBlankChar: vi.fn() }))
vi.mock('./process/processzip', () => ({
    CharXWriter: class {
        write = mocks.zipWrite
        end = mocks.zipEnd
    },
}))
vi.mock('./process/files/inlays', () => ({
    getInlayAsset: mocks.getInlayAsset,
    setInlayAsset: vi.fn(),
    getInlayInfosBatch: mocks.getInlayInfosBatch,
    reencodeImage: vi.fn(),
}))
vi.mock('./process/files/inlayMeta', () => ({
    getInlayMeta: mocks.getInlayMeta,
    getInlayMetasBatch: mocks.getInlayMetasBatch,
    setInlayMeta: vi.fn(),
}))
vi.mock('./pngChunk', () => ({ PngChunk: {} }))

const { exportCharacterPackage } = await import('./characterPackage')

describe('character package inlay export', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.alertConfirm.mockResolvedValue(true)
        mocks.getCharacterInterchangeSnapshot.mockReturnValue({
            character: {
                name: 'Batch Test',
                chaId: 'character-id',
                chats: [],
                chatFolders: [],
            },
            chats: [{ index: 0, id: 'chat-id' }],
        })
        mocks.streamCharacterChats.mockImplementation(async function* () {
            yield {
                id: 'chat-id',
                message: [{ data: '{{inlay::first}} and {{inlayed::second}} then {{inlay::first}}' }],
            }
        })
        mocks.getInlayInfosBatch.mockResolvedValue({
            first: { width: 10, height: 20 },
            second: { width: 30, height: 40 },
        })
        mocks.getInlayMetasBatch.mockResolvedValue({
            first: { createdAt: 1, updatedAt: 2, charId: 'character-id', chatId: 'chat-id' },
            second: { createdAt: 3, updatedAt: 4 },
        })
        mocks.getInlayAsset.mockImplementation(async (id: string) => ({
            name: `${id}-name`,
            ext: 'png',
            type: 'image',
            data: 'AQI=',
        }))
    })

    it('reads all metadata in one batch and never calls the scalar metadata reader', async () => {
        await exportCharacterPackage(0, {
            includeCharacter: false,
            includeChats: false,
            includePersona: false,
            includeInlays: true,
        })

        expect(mocks.getInlayInfosBatch).toHaveBeenCalledOnce()
        expect(mocks.getInlayInfosBatch).toHaveBeenCalledWith(['first', 'second'])
        expect(mocks.getInlayMetasBatch).toHaveBeenCalledOnce()
        expect(mocks.getInlayMetasBatch).toHaveBeenCalledWith(['first', 'second'])
        expect(mocks.getInlayMeta).not.toHaveBeenCalled()
        const metaCall = mocks.zipWrite.mock.calls.find(([path]) => path === 'inlays/meta.json')
        expect(metaCall).toBeDefined()
        expect(typeof metaCall![1]).toBe('string')
        expect(JSON.parse(metaCall![1] as string)).toEqual({
            first: {
                name: 'first-name',
                ext: 'png',
                type: 'image',
                width: 10,
                height: 20,
                createdAt: 1,
                updatedAt: 2,
                charId: 'character-id',
                chatId: 'chat-id',
            },
            second: {
                name: 'second-name',
                ext: 'png',
                type: 'image',
                width: 30,
                height: 40,
                createdAt: 3,
                updatedAt: 4,
            },
        })
        expect(mocks.alertError).not.toHaveBeenCalled()
        expect(mocks.zipEnd).toHaveBeenCalledOnce()
    })
})
