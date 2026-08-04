import { beforeEach, describe, expect, test, vi } from 'vitest'
import * as fflate from 'fflate'

const mocks = vi.hoisted(() => ({
    uuid: vi.fn(),
    saveChatToServer: vi.fn(),
    alertConfirm: vi.fn(),
    alertError: vi.fn(),
    notifySuccess: vi.fn(),
    selectFileByDom: vi.fn(),
    getDatabase: vi.fn(),
    setDatabase: vi.fn(),
    createBlankChar: vi.fn(),
    markCharacterDirty: vi.fn(),
}))

vi.mock('uuid', () => ({ v4: mocks.uuid }))
vi.mock('./alert', () => ({
    alertConfirm: mocks.alertConfirm,
    alertError: mocks.alertError,
    alertStore: { set: vi.fn() },
    alertWait: vi.fn(),
    notifySuccess: mocks.notifySuccess,
}))
vi.mock('./characterCards', () => ({
    exportCharacterCard: vi.fn(),
    importCharacterProcess: vi.fn(),
}))
vi.mock('./globalApi.svelte', () => ({
    LocalWriter: class {},
    markCharacterDirty: mocks.markCharacterDirty,
    readImage: vi.fn(),
    checkCharOrder: vi.fn(),
}))
vi.mock('src/lang', () => ({
    language: {
        characterPackageProgressImportChats: 'Importing chats',
        characterPackageProgressImportChar: 'Importing character',
        characterPackageProgressReading: 'Reading package',
        characterPackageImportSummary: 'Package Contents',
        characterPackageCharacter: 'Character',
        characterPackageChats: 'Chats',
        characterPackageChatCount: '',
        characterPackageEmpty: 'empty shell',
        characterPackageEmptyWarning: 'Character data is empty. Import anyway?',
        characterPackageImport: 'Import Character Package',
        characterPackageImportToChar: 'Import Package to Character',
        characterPackageImportSuccess: 'Character package imported successfully.',
    },
}))
vi.mock('./storage/database.svelte', () => ({
    getCharacterInterchangeSnapshot: vi.fn(),
    getDatabase: mocks.getDatabase,
    setDatabase: mocks.setDatabase,
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
vi.mock('./util', () => ({ selectFileByDom: mocks.selectFileByDom }))
vi.mock('./characters', () => ({ createBlankChar: mocks.createBlankChar }))
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

const {
    importCharacterPackage,
    importChatsToCharacter,
    importPackageToCharacter,
} = await import('./characterPackage')

function buildPackageFile(
    manifest: Record<string, unknown>,
    chatEntry?: { file: string, rows: unknown[] },
): File {
    const entries: Record<string, Uint8Array> = {
        'manifest.json': fflate.strToU8(JSON.stringify(manifest)),
    }
    if (chatEntry) {
        entries[chatEntry.file] = fflate.strToU8(JSON.stringify({
            type: 'risuAllChats',
            ver: 2,
            data: chatEntry.rows,
            folders: [],
        }))
    }
    const archive = fflate.zipSync(entries)
    return new File([archive as unknown as BlobPart], 'package.zip', { type: 'application/zip' })
}

function baseManifest(): Record<string, unknown> {
    return {
        type: 'risuCharacterPackage',
        version: 1,
        createdAt: '2026-08-04T00:00:00.000Z',
        character: { name: 'Fixture', file: '', isEmpty: true },
    }
}

describe('streamed package chat row import', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.alertConfirm.mockResolvedValue(true)
        mocks.saveChatToServer.mockResolvedValue(undefined)
        mocks.getDatabase.mockReturnValue({ characters: [], personas: [] })
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
        )).resolves.toEqual({ status: 'imported', count: 2 })

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

    test('append import reports a missing declared chats entry as failure', async () => {
        const target = {
            chaId: 'target-character',
            name: 'Fixture',
            chats: [{ id: 'existing-chat', name: 'Existing', message: [] }],
        } as any
        const db = { characters: [target], personas: [] }
        mocks.getDatabase.mockReturnValue(db)
        mocks.selectFileByDom.mockResolvedValue([buildPackageFile({
            ...baseManifest(),
            chats: { count: 1, file: 'chats/missing.json' },
        })])

        await importPackageToCharacter(0)

        expect(mocks.alertError).toHaveBeenCalledOnce()
        expect((mocks.alertError.mock.calls[0][0] as Error).message).toContain('is missing from the package')
        expect(mocks.notifySuccess).not.toHaveBeenCalled()
        expect(mocks.saveChatToServer).not.toHaveBeenCalled()
        expect(mocks.markCharacterDirty).not.toHaveBeenCalled()
        expect(target.chats).toEqual([{ id: 'existing-chat', name: 'Existing', message: [] }])
    })

    test('new-character import fails before writes when the chat entry is shorter than declared', async () => {
        const db = { characters: [] as any[], personas: [] }
        const blankCharacter = { chaId: 'new-character', name: '', chats: [] }
        mocks.getDatabase.mockReturnValue(db)
        mocks.createBlankChar.mockReturnValue(blankCharacter)
        mocks.selectFileByDom.mockResolvedValue([buildPackageFile({
            ...baseManifest(),
            chats: { count: 2, file: 'chats/chats.json' },
        }, {
            file: 'chats/chats.json',
            rows: [{ id: 'only-chat', name: 'Only', message: [] }],
        })])

        await importCharacterPackage()

        expect(mocks.alertError).toHaveBeenCalledOnce()
        expect((mocks.alertError.mock.calls[0][0] as Error).message)
            .toContain('contains 1 chat rows, but the manifest declares 2')
        expect(mocks.notifySuccess).not.toHaveBeenCalled()
        expect(mocks.saveChatToServer).not.toHaveBeenCalled()
        expect(mocks.markCharacterDirty).not.toHaveBeenCalled()
        expect(db.characters).toEqual([])
    })

    test('new-character package with no chats section still succeeds', async () => {
        const db = { characters: [] as any[], personas: [] }
        const blankCharacter = { chaId: 'new-character', name: '', chats: [] }
        mocks.getDatabase.mockReturnValue(db)
        mocks.createBlankChar.mockReturnValue(blankCharacter)
        mocks.selectFileByDom.mockResolvedValue([buildPackageFile(baseManifest())])

        await importCharacterPackage()

        expect(mocks.alertError).not.toHaveBeenCalled()
        expect(mocks.notifySuccess).toHaveBeenCalledWith('Character package imported successfully.')
        expect(mocks.saveChatToServer).not.toHaveBeenCalled()
        expect(mocks.markCharacterDirty).toHaveBeenCalledWith('new-character')
        expect(db.characters).toEqual([{ ...blankCharacter, name: 'Fixture' }])
    })
})
