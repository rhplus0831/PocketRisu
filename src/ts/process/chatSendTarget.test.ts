import { describe, expect, test } from 'vitest'
import {
    applyChatInputToTarget,
    captureChatSendTarget,
    resolveChatSendTarget,
} from './chatSendTarget'

function makeDatabase() {
    return {
        useSayNothing: false,
        characters: [{
            chaId: 'character-a',
            type: 'character',
            chatPage: 0,
            chats: [
                { id: 'chat-a', message: [{ role: 'char', data: 'history A' }] },
                { id: 'chat-b', message: [{ role: 'char', data: 'history B' }] },
            ],
        }],
    } as any
}

describe('chat send target', () => {
    test('keeps a delayed input-trigger send bound to its originating chat', async () => {
        const db = makeDatabase()
        const target = captureChatSendTarget(db, 0)
        expect(target).toEqual({ chaId: 'character-a', chatId: 'chat-a' })

        let releaseTrigger!: () => void
        const triggerGate = new Promise<void>(resolve => {
            releaseTrigger = resolve
        })
        let triggerStarted!: () => void
        const started = new Promise<void>(resolve => {
            triggerStarted = resolve
        })

        const send = applyChatInputToTarget({
            getDatabase: () => db,
            target: target!,
            input: 'new message',
            now: () => 123,
            runInputTrigger: async (_character, chat) => {
                triggerStarted()
                await triggerGate
                return { chat: structuredClone(chat) }
            },
            processInput: async (_character, input) => input,
        })

        await started
        db.characters[0].chatPage = 1
        releaseTrigger()
        await send

        expect(db.characters[0].chats[0].message).toEqual([
            { role: 'char', data: 'history A' },
            { role: 'user', data: 'new message', time: 123, name: null },
        ])
        expect(db.characters[0].chats[1].message).toEqual([
            { role: 'char', data: 'history B' },
        ])
    })

    test('resolves the target by durable IDs after character and chat reordering', () => {
        const db = makeDatabase()
        const target = captureChatSendTarget(db, 0)!
        db.characters.unshift({ chaId: 'other', chatPage: 0, chats: [] })
        db.characters[1].chats.reverse()

        const resolved = resolveChatSendTarget(db, target)
        expect(resolved?.characterIndex).toBe(1)
        expect(resolved?.chatIndex).toBe(1)
        expect(resolved?.chat.id).toBe('chat-a')
    })
})
