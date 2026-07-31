import { describe, expect, test, vi } from 'vitest'
import type { Chat, Database } from './storage/database.svelte'
import type { toSaveType } from './storage/risuSave'
import {
    buildKnownChatIdsByCharacter,
    chatPersistKey,
    runChatPersistStage,
} from './storage/chatPersistStage'

vi.mock('./globalApi.svelte', () => ({
    forageStorage: { realStorage: {} },
    markCharacterDirty: vi.fn(),
    markChatDirty: vi.fn(),
}))
vi.mock('./storage/database.svelte', () => ({
    getDatabase: () => ({ characters: [] }),
    isChatStub: (chat: any) => chat?._stub === true && !Array.isArray(chat.message),
}))

const { encodeChatHtmlPayload, parseChatHtmlExport } = await import('./chatImport')

function sourceChat(): Chat {
    return {
        id: 'source-chat-id',
        name: '',
        note: '',
        localLore: [],
        message: [{ role: 'user', data: 'source &lt; <message>' }],
    }
}

function trackedCharacter(): toSaveType {
    return {
        character: ['source-character'],
        chat: [],
        root: false,
        botPreset: false,
        modules: false,
        plugins: false,
        pluginCustomStorage: false,
    }
}

describe('HTML chat import', () => {
    test('extracts the lossless payload with a fresh local identity', () => {
        const source = sourceChat()
        const html = `<html><body><div class="idat">${encodeChatHtmlPayload(source)}</div></body></html>`

        const imported = parseChatHtmlExport(html, () => 'imported-chat-id')

        expect(imported).not.toBeNull()
        expect(imported?.id).toBe('imported-chat-id')
        expect(imported?.id).not.toBe(source.id)
        expect(imported?.message).toEqual(source.message)
        expect(imported?.message[0].data).toBe('source &lt; <message>')
        expect(source.id).toBe('source-chat-id')
    })

    test('export, import, edit, save, and reload preserve independent chat rows', async () => {
        const source = sourceChat()
        const html = `<div class="idat">${encodeChatHtmlPayload(source)}</div>`
        const imported = parseChatHtmlExport(html, () => 'imported-chat-id')!
        imported.message.push({ role: 'char', data: 'new imported work' })

        const persistedBaseline = {
            characters: [{
                chaId: 'source-character',
                chats: [{ id: source.id, name: source.name, _stub: true }],
            }],
        } as unknown as Database
        const live = {
            characters: [{
                chaId: 'source-character',
                chats: [imported, source],
            }],
        } as unknown as Database
        const rows = new Map<string, Chat>([[
            chatPersistKey('source-character', source.id!),
            structuredClone(source),
        ]])
        let committedStubs: Array<{ id: string; name: string; _stub: true }> = []

        await runChatPersistStage({
            db: live,
            toSave: trackedCharacter(),
            doingChat: false,
            knownChatIdsByCharacter: buildKnownChatIdsByCharacter(persistedBaseline),
            generationCheckpoints: new Map(),
            requeueChats: vi.fn(),
            saveChat: async (chaId, _chatIndex, chatId, chat) => {
                rows.set(chatPersistKey(chaId, chatId), structuredClone(chat))
            },
            commitStubDatabase: async () => {
                committedStubs = live.characters[0].chats.map(chat => ({
                    id: chat.id!,
                    name: chat.name,
                    _stub: true,
                }))
                return { committed: true, result: undefined }
            },
        })

        expect(committedStubs.map(chat => chat.id)).toEqual([
            'imported-chat-id',
            'source-chat-id',
        ])
        expect(rows.size).toBe(2)

        const reloaded = committedStubs.map(stub => (
            rows.get(chatPersistKey('source-character', stub.id))!
        ))
        expect(reloaded[0].message).toContainEqual({ role: 'char', data: 'new imported work' })
        expect(reloaded[1].message).toEqual([{ role: 'user', data: 'source &lt; <message>' }])
    })
})
