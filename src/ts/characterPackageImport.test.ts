import { beforeEach, describe, expect, test, vi } from 'vitest'
import * as fflate from 'fflate'

const mocks = vi.hoisted(() => ({
    uuid: vi.fn(),
    saveChatToServer: vi.fn(),
}))

vi.mock('uuid', () => ({ v4: mocks.uuid }))
vi.mock('./alert', () => ({
    alertConfirm: vi.fn(),
    alertError: vi.fn(),
    alertStore: { set: vi.fn() },
    alertWait: vi.fn(),
    notifySuccess: vi.fn(),
}))
vi.mock('./characterCards', () => ({
    exportCharacterCard: vi.fn(),
    importCharacterProcess: vi.fn(),
}))
vi.mock('./globalApi.svelte', () => ({
    LocalWriter: class {},
    markCharacterDirty: vi.fn(),
    readImage: vi.fn(),
    checkCharOrder: vi.fn(),
}))
vi.mock('src/lang', () => ({
    language: { characterPackageProgressImportChats: 'Importing chats' },
}))
vi.mock('./storage/database.svelte', () => ({
    getCharacterInterchangeSnapshot: vi.fn(),
    getDatabase: vi.fn(() => ({ personas: [] })),
    setDatabase: vi.fn(),
    saveImage: vi.fn(),
    normalizeChat: (chat: any) => ({
        ...chat,
        message: Array.isArray(chat.message) ? chat.message : [],
        note: typeof chat.note === 'string' ? chat.note : '',
        name: typeof chat.name === 'string' ? chat.name : '',
        localLore: Array.isArray(chat.localLore) ? chat.localLore : [],
    }),
}))
vi.mock('./storage/chatStorage', () => ({
    saveChatToServer: mocks.saveChatToServer,
    chatToStub: (chat: any) => ({
        id: chat.id,
        name: chat.name,
        _stub: true,
        ...('folderId' in chat ? { folderId: chat.folderId } : {}),
    }),
    stubToPlaceholder: (stub: any) => ({
        id: stub.id,
        name: stub.name,
        folderId: stub.folderId,
        message: [],
        note: '',
        localLore: [],
        fmIndex: -1,
        _placeholder: true,
    }),
}))
vi.mock('./util', () => ({ selectFileByDom: vi.fn() }))
vi.mock('./characters', () => ({ createBlankChar: vi.fn() }))
vi.mock('./process/processzip', () => ({ CharXWriter: class {} }))
vi.mock('./process/files/inlays', () => ({
    getInlayAsset: vi.fn(),
    setInlayAsset: vi.fn(),
    getInlayInfosBatch: vi.fn(),
    reencodeImage: vi.fn(),
}))
vi.mock('./process/files/inlayMeta', () => ({
    getInlayMeta: vi.fn(),
    setInlayMeta: vi.fn(),
}))
vi.mock('./pngChunk', () => ({ PngChunk: {} }))

const { importChatsToCharacter } = await import('./characterPackage')

describe('streamed package chat row import', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    test('old whole-entry chats import in order through per-row storage', async () => {
        const transported = [
            {
                id: 'old-chat-a',
                name: 'A',
                folderId: 'folder-a',
                bindedPersona: 'old-persona',
                message: [{ role: 'user', data: 'one' }],
                note: '',
                localLore: [],
            },
            {
                id: 'old-chat-b',
                name: 'B',
                message: [{ role: 'char', data: 'two' }],
                note: 'note',
                localLore: [],
            },
        ]
        const folders = [{ id: 'folder-a', name: 'Imported', folded: false }]
        const chatsJson = JSON.stringify({
            type: 'risuAllChats',
            ver: 2,
            data: transported,
            folders,
        }, null, 2)
        const archive = fflate.zipSync({
            'chats/chats.json': [fflate.strToU8(chatsJson), { level: 6 }],
        })
        const existingChat = {
            id: 'existing-chat',
            name: 'Existing',
            message: [{ role: 'user', data: 'keep' }],
            note: '',
            localLore: [],
        }
        const target = {
            chaId: 'target-character',
            chats: [existingChat],
            chatFolders: [{ id: 'folder-a', name: 'Existing', folded: false }],
        } as any
        mocks.uuid
            .mockReturnValueOnce('remapped-folder')
            .mockReturnValueOnce('new-chat-a')
            .mockReturnValueOnce('new-chat-b')
        const savedRows: any[] = []
        mocks.saveChatToServer.mockImplementation(async (_chaId, _index, _id, chat) => {
            // Full imported rows are released toward storage before the target
            // character receives only their lightweight placeholders.
            expect(target.chats).toEqual([existingChat])
            savedRows.push(structuredClone(chat))
        })
        const progress = vi.fn()

        await expect(importChatsToCharacter(
            {
                type: 'risuCharacterPackage',
                version: 1,
                createdAt: '2025-01-02T03:04:05.000Z',
                character: { name: 'Old', file: '', isEmpty: true },
                chats: { count: 2, file: 'chats/chats.json' },
            },
            archive,
            target,
            { 'old-persona': 'new-persona' },
            progress,
            'append',
        )).resolves.toBe(2)

        expect(progress).toHaveBeenCalledOnce()
        expect(mocks.saveChatToServer.mock.calls.map(call => call.slice(0, 3))).toEqual([
            ['target-character', 0, 'new-chat-a'],
            ['target-character', 1, 'new-chat-b'],
        ])
        expect(savedRows).toMatchObject([
            {
                id: 'new-chat-a',
                folderId: 'remapped-folder',
                bindedPersona: 'new-persona',
                message: [{ role: 'user', data: 'one' }],
            },
            {
                id: 'new-chat-b',
                message: [{ role: 'char', data: 'two' }],
            },
        ])
        expect(target.chats.map((chat: any) => ({
            id: chat.id,
            placeholder: chat._placeholder ?? false,
        }))).toEqual([
            { id: 'new-chat-a', placeholder: true },
            { id: 'new-chat-b', placeholder: true },
            { id: 'existing-chat', placeholder: false },
        ])
        expect(target.chatFolders).toEqual([
            { id: 'remapped-folder', name: 'Imported', folded: false },
            { id: 'folder-a', name: 'Existing', folded: false },
        ])
    })
})
