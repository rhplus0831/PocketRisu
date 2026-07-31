import { describe, expect, test, vi } from 'vitest'
import type { Chat, Database } from './database.svelte'
import { DirtyTargetBridge } from './dirtyTargetBridge'
import { buildKnownChatIdsByCharacter, runChatPersistStage } from './chatPersistStage'
import type { toSaveType } from './risuSave'

function trackedChanges(): toSaveType {
    return {
        character: [],
        chat: [],
        root: false,
        botPreset: false,
        modules: false,
        plugins: false,
        pluginCustomStorage: false,
    }
}

function fullChat(): Chat {
    return {
        id: 'chat-target',
        name: 'Target chat',
        note: '',
        localLore: [],
        message: [{ role: 'user', data: 'changed while inactive' }],
    }
}

describe('explicit dirty target bridge', () => {
    test('deduplicates startup targets and forwards later targets after activation', () => {
        const bridge = new DirtyTargetBridge()
        const character = vi.fn()
        const chat = vi.fn()

        bridge.markCharacter('char-a')
        bridge.markCharacter('char-a')
        bridge.markChat('char-a', 'chat-a')
        bridge.markChat('char-a', 'chat-a')
        bridge.markChat('', 'ignored')
        bridge.activate({ character, chat })

        expect(character).toHaveBeenCalledTimes(1)
        expect(character).toHaveBeenCalledWith('char-a')
        expect(chat).toHaveBeenCalledTimes(1)
        expect(chat).toHaveBeenCalledWith('char-a', 'chat-a')

        bridge.markCharacter('char-b')
        bridge.markChat('char-b', 'chat-b')
        expect(character).toHaveBeenLastCalledWith('char-b')
        expect(chat).toHaveBeenLastCalledWith('char-b', 'chat-b')
    })

    test('drives an inactive chat row write without any selected-character dependency', async () => {
        const db = {
            characters: [{ chaId: 'char-target', chats: [fullChat()] }],
        } as Database
        const persistedBaseline = {
            characters: [{
                chaId: 'char-target',
                chats: [{ id: 'chat-target', name: 'Target chat', _stub: true }],
            }],
        } as unknown as Database
        const toSave = trackedChanges()
        const bridge = new DirtyTargetBridge()
        const saveChat = vi.fn(async () => {})

        bridge.activate({
            character: chaId => {
                toSave.character = [chaId, ...toSave.character.filter(id => id !== chaId)]
            },
            chat: (chaId, chatId) => {
                toSave.chat = [
                    [chaId, chatId],
                    ...toSave.chat.filter(([queuedChaId, queuedChatId]) => (
                        queuedChaId !== chaId || queuedChatId !== chatId
                    )),
                ]
            },
        })
        bridge.markCharacter('char-target')
        bridge.markChat('char-target', 'chat-target')

        await runChatPersistStage({
            db,
            toSave,
            doingChat: false,
            knownChatIdsByCharacter: buildKnownChatIdsByCharacter(persistedBaseline),
            generationCheckpoints: new Map(),
            requeueChats: vi.fn(),
            saveChat,
            commitStubDatabase: async () => ({ committed: true, result: undefined }),
        })

        expect(toSave.character).toEqual(['char-target'])
        expect(saveChat).toHaveBeenCalledWith(
            'char-target',
            0,
            'chat-target',
            db.characters[0].chats[0],
        )
    })
})
