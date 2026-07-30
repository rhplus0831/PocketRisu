import { describe, expect, test } from 'vitest'
import {
    applyChatInputToTarget,
    captureChatSendTarget,
    resolveChatSendTarget,
    settleChatRerollToTarget,
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

    test('publishes an input-trigger snapshot before editinput processing', async () => {
        const db = makeDatabase()
        const target = captureChatSendTarget(db, 0)!

        await applyChatInputToTarget({
            getDatabase: () => db,
            target,
            input: 'outer message',
            now: () => 123,
            runInputTrigger: async (_character, chat) => {
                const triggeredChat = structuredClone(chat)
                triggeredChat.message.push({ role: 'char', data: 'trigger message' })
                return { chat: triggeredChat }
            },
            processInput: async (_character, input) => {
                db.characters[0].chats[0].message.push({ role: 'char', data: 'child turn' })
                return input
            },
        })

        expect(db.characters[0].chats[0].message).toEqual([
            { role: 'char', data: 'history A' },
            { role: 'char', data: 'trigger message' },
            { role: 'char', data: 'child turn' },
            { role: 'user', data: 'outer message', time: 123, name: null },
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

    test('restores a failed reroll to its originating chat after selection changes', () => {
        const db = makeDatabase()
        db.characters[0].chats[0].message = [
            { role: 'user', data: 'prompt A' },
            { role: 'char', data: 'response A', swipes: ['older response A'] },
        ]
        const target = captureChatSendTarget(db, 0)!
        const originalMessages = structuredClone(db.characters[0].chats[0].message)

        db.characters[0].chats[0].message = [{ role: 'user', data: 'prompt A' }]
        db.characters[0].chatPage = 1

        const settled = settleChatRerollToTarget(db, target, false, {
            originalMessages,
            trailingMessages: [],
            savedSwipes: ['older response A', 'response A'],
        })

        expect(settled?.chat.id).toBe('chat-a')
        expect(db.characters[0].chats[0].message).toEqual(originalMessages)
        expect(db.characters[0].chats[1].message).toEqual([
            { role: 'char', data: 'history B' },
        ])
    })

    test('applies successful reroll comments and swipes to the originating chat', () => {
        const db = makeDatabase()
        const target = captureChatSendTarget(db, 0)!
        db.characters[0].chats[0].message = [
            { role: 'user', data: 'prompt A' },
            { role: 'char', data: 'new response A' },
        ]
        db.characters[0].chatPage = 1

        settleChatRerollToTarget(db, target, true, {
            originalMessages: [],
            trailingMessages: [{ role: 'user', data: 'branch note', isComment: true }],
            savedSwipes: ['old response A'],
        })

        expect(db.characters[0].chats[0].message).toEqual([
            { role: 'user', data: 'prompt A' },
            {
                role: 'char',
                data: 'new response A',
                swipes: ['old response A', 'new response A'],
                swipeId: 1,
            },
            { role: 'user', data: 'branch note', isComment: true },
        ])
        expect(db.characters[0].chats[1].message).toEqual([
            { role: 'char', data: 'history B' },
        ])
    })
})
