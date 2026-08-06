import { describe, expect, test, vi } from 'vitest'
import {
    applyChatInputToTarget,
    captureChatPublicationGuard,
    captureChatSendTarget,
    publishTriggerChatToTarget,
    resolveChatExecutionTarget,
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

    test('queues destructive backup work only when the trigger snapshot is published to its durable target', async () => {
        const db = makeDatabase()
        const target = captureChatSendTarget(db, 0)!
        const published = vi.fn()

        await applyChatInputToTarget({
            getDatabase: () => db,
            target,
            input: 'outer message',
            runInputTrigger: async (_character, chat) => ({
                chat: { ...structuredClone(chat), message: [] },
                destructiveChatMutation: true,
            }),
            onDestructiveChatMutation: published,
            processInput: async (_character, input) => input,
        })

        expect(published).toHaveBeenCalledOnce()
        expect(published).toHaveBeenCalledWith({
            chaId: 'character-a',
            chatId: 'chat-a',
        })
    })

    test('does not queue destructive backup work when the durable target disappears before publication', async () => {
        const db = makeDatabase()
        const target = captureChatSendTarget(db, 0)!
        const published = vi.fn()

        const result = await applyChatInputToTarget({
            getDatabase: () => db,
            target,
            input: 'outer message',
            runInputTrigger: async (_character, chat) => {
                db.characters[0].chats.shift()
                return {
                    chat: { ...structuredClone(chat), message: [] },
                    destructiveChatMutation: true,
                }
            },
            onDestructiveChatMutation: published,
            processInput: async (_character, input) => input,
        })

        expect(result).toBeNull()
        expect(published).not.toHaveBeenCalled()
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

    test('publishes a trigger result by durable IDs after reordering', () => {
        const db = makeDatabase()
        const target = captureChatSendTarget(db, 0)!
        const triggeredChat = {
            ...structuredClone(db.characters[0].chats[0]),
            message: [{ role: 'char', data: 'triggered A' }],
        }
        db.characters.unshift({ chaId: 'other', chatPage: 0, chats: [] })
        db.characters[1].chats.reverse()

        const published = publishTriggerChatToTarget(db, target, { chat: triggeredChat })

        expect(published?.characterIndex).toBe(1)
        expect(published?.chatIndex).toBe(1)
        expect(db.characters[1].chats[1].message).toEqual([
            { role: 'char', data: 'triggered A' },
        ])
    })

    test('resolves a fresh execution source after a same-ID row replacement', () => {
        const db = makeDatabase()
        const target = captureChatSendTarget(db, 0)!
        const first = resolveChatExecutionTarget(db, target)!
        const replacement = structuredClone(first.chat)
        replacement.message.push({ role: 'char', data: 'new response' })
        db.characters[0].chats[0] = replacement

        const second = resolveChatExecutionTarget(db, target)!

        expect(second.chat).toBe(replacement)
        expect(second.chat).not.toBe(first.chat)
        expect(second.chat.message.at(-1)?.data).toBe('new response')
    })

    test('rejects stale publication after the same-ID row is replaced during an await', () => {
        const db = makeDatabase()
        const target = captureChatSendTarget(db, 0)!
        const sourceChat = db.characters[0].chats[0]
        const guard = captureChatPublicationGuard(sourceChat)
        const triggeredChat = structuredClone(sourceChat)
        triggeredChat.message = []
        const concurrentReplacement = structuredClone(sourceChat)
        concurrentReplacement.message.push({ role: 'char', data: 'concurrent response' })
        db.characters[0].chats[0] = concurrentReplacement
        const backupReason = vi.fn()

        const published = publishTriggerChatToTarget(
            db,
            target,
            { chat: triggeredChat, destructiveChatMutation: true },
            backupReason,
            guard,
        )

        expect(published).toBeNull()
        expect(db.characters[0].chats[0]).toBe(concurrentReplacement)
        expect(db.characters[0].chats[0].message.at(-1)?.data).toBe('concurrent response')
        expect(backupReason).not.toHaveBeenCalled()
    })

    test('rejects stale publication after in-place source state changes during an await', () => {
        const db = makeDatabase()
        const target = captureChatSendTarget(db, 0)!
        const sourceChat = db.characters[0].chats[0]
        const guard = captureChatPublicationGuard(sourceChat)
        const triggeredChat = structuredClone(sourceChat)
        triggeredChat.message = []
        sourceChat.message.push({ role: 'char', data: 'concurrent response' })
        const backupReason = vi.fn()

        const published = publishTriggerChatToTarget(
            db,
            target,
            { chat: triggeredChat, destructiveChatMutation: true },
            backupReason,
            guard,
        )

        expect(published).toBeNull()
        expect(db.characters[0].chats[0]).toBe(sourceChat)
        expect(sourceChat.message.at(-1)?.data).toBe('concurrent response')
        expect(backupReason).not.toHaveBeenCalled()
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
