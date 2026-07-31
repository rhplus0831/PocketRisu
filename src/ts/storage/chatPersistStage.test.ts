import { describe, expect, test, vi } from 'vitest'
import type { Chat, Database } from './database.svelte'
import type { toSaveType } from './risuSave'
import {
    buildKnownChatIdsByCharacter,
    CHECKPOINT_INTERVAL_MS,
    ChatRowPersistError,
    capturePreTrackingFullChatChanges,
    chatPersistKey,
    runChatPersistStage,
} from './chatPersistStage'

function makeChat(id = 'chat-new'): Chat {
    return {
        id,
        name: 'New chat',
        note: '',
        localLore: [],
        message: [{ role: 'user', data: 'pre-generation user message' }],
    }
}

function makeDatabase(chat = makeChat()): Database {
    return {
        characters: [{
            chaId: 'char-1',
            chats: [chat],
        }],
    } as unknown as Database
}

function makeDatabaseWithChats(chats: Chat[]): Database {
    return {
        characters: [{
            chaId: 'char-1',
            chats,
        }],
    } as unknown as Database
}

function makeStub(id: string): Chat {
    return {
        id,
        name: `Stub ${id}`,
        _stub: true,
    } as unknown as Chat
}

function makePlaceholder(id: string): Chat {
    return {
        id,
        name: `Placeholder ${id}`,
        note: '',
        localLore: [],
        message: [],
        _placeholder: true,
    }
}

function makeTrackedChanges(overrides: Partial<toSaveType> = {}): toSaveType {
    return {
        character: [],
        chat: [],
        root: false,
        botPreset: false,
        modules: false,
        plugins: false,
        pluginCustomStorage: false,
        ...overrides,
    }
}

function clone<T>(value: T): T {
    return structuredClone(value)
}

describe('chat persistence stage', () => {
    test('persists a synchronous startup-created chat before an unrelated save publishes its stub', async () => {
        const persisted = makeDatabaseWithChats([makeStub('chat-existing')])
        const startupChat = makeChat('chat-startup')
        const live = makeDatabaseWithChats([
            makePlaceholder('chat-existing'),
            startupChat,
        ])
        const tracker = makeTrackedChanges({ root: true })
        const knownChatIdsByCharacter = buildKnownChatIdsByCharacter(persisted)
        const rowStore = new Map<string, Chat>([[
            chatPersistKey('char-1', 'chat-existing'),
            makeChat('chat-existing'),
        ]])
        const order: string[] = []

        expect(capturePreTrackingFullChatChanges(tracker, live, persisted)).toBe(true)
        expect(tracker.chat).toEqual([['char-1', 'chat-startup']])
        expect(knownChatIdsByCharacter.get('char-1')).toEqual(new Set(['chat-existing']))

        await runChatPersistStage({
            db: live,
            toSave: tracker,
            doingChat: false,
            knownChatIdsByCharacter,
            generationCheckpoints: new Map(),
            requeueChats: vi.fn(),
            saveChat: async (chaId, _chatIndex, chatId, chat) => {
                order.push(`row:${chatId}`)
                rowStore.set(chatPersistKey(chaId, chatId), clone(chat))
            },
            commitStubDatabase: async () => {
                order.push('stub-db')
                expect(rowStore.has(chatPersistKey('char-1', 'chat-startup'))).toBe(true)
                expect(knownChatIdsByCharacter.get('char-1')?.has('chat-startup')).toBe(false)
                return { committed: true, result: undefined }
            },
        })

        expect(order).toEqual(['row:chat-startup', 'stub-db'])
        expect(knownChatIdsByCharacter.get('char-1')).toEqual(
            new Set(['chat-existing', 'chat-startup']),
        )
        for (const chat of live.characters[0].chats) {
            expect(
                rowStore.has(chatPersistKey('char-1', chat.id ?? '')),
                `${chat.id} stub must resolve after reload`,
            ).toBe(true)
        }
    })

    test('persists a startup chat whose id was repaired before promoting the repaired id', async () => {
        const persisted = makeDatabaseWithChats([makeStub('chat-duplicate')])
        const repairedChat = makeChat('chat-repaired')
        const live = makeDatabaseWithChats([repairedChat])
        const tracker = makeTrackedChanges({ root: true })
        const knownChatIdsByCharacter = buildKnownChatIdsByCharacter(persisted)
        const rowStore = new Map<string, Chat>()

        expect(capturePreTrackingFullChatChanges(tracker, live, persisted)).toBe(true)
        expect(tracker.chat).toEqual([['char-1', 'chat-repaired']])

        await runChatPersistStage({
            db: live,
            toSave: tracker,
            doingChat: false,
            knownChatIdsByCharacter,
            generationCheckpoints: new Map(),
            requeueChats: vi.fn(),
            saveChat: async (chaId, _chatIndex, chatId, chat) => {
                rowStore.set(chatPersistKey(chaId, chatId), clone(chat))
            },
            commitStubDatabase: async () => {
                expect(rowStore.has(chatPersistKey('char-1', 'chat-repaired'))).toBe(true)
                expect(knownChatIdsByCharacter.get('char-1')?.has('chat-repaired')).toBe(false)
                return { committed: true, result: undefined }
            },
        })

        expect(knownChatIdsByCharacter.get('char-1')?.has('chat-repaired')).toBe(true)
        expect(rowStore.get(chatPersistKey('char-1', 'chat-repaired'))?.message)
            .toEqual(repairedChat.message)
    })

    test('persists a full startup replacement even when its id was already durable', async () => {
        const persisted = makeDatabaseWithChats([makeStub('chat-existing')])
        const replacement = makeChat('chat-existing')
        replacement.message = [{ role: 'user', data: 'replaced during plugin startup' }]
        const live = makeDatabaseWithChats([replacement])
        const tracker = makeTrackedChanges({ root: true })
        const knownChatIdsByCharacter = buildKnownChatIdsByCharacter(persisted)
        const saveChat = vi.fn(async () => {})

        expect(capturePreTrackingFullChatChanges(tracker, live, persisted)).toBe(true)
        expect(tracker.chat).toEqual([['char-1', 'chat-existing']])

        await runChatPersistStage({
            db: live,
            toSave: tracker,
            doingChat: false,
            knownChatIdsByCharacter,
            generationCheckpoints: new Map(),
            requeueChats: vi.fn(),
            saveChat,
            commitStubDatabase: async () => ({ committed: true, result: undefined }),
        })

        expect(saveChat).toHaveBeenCalledWith(
            'char-1',
            0,
            'chat-existing',
            replacement,
        )
    })

    test('does not treat an ordinary persisted placeholder as a new chat body', () => {
        const persisted = makeDatabaseWithChats([makeStub('chat-existing')])
        const live = makeDatabaseWithChats([makePlaceholder('chat-existing')])
        const tracker = makeTrackedChanges()

        expect(capturePreTrackingFullChatChanges(tracker, live, persisted)).toBe(false)
        expect(tracker.chat).toEqual([])
    })

    test('checkpoints every new chat row before committing crash-resolvable stubs', async () => {
        const db = makeDatabase()
        const knownChatIdsByCharacter = new Map<string, Set<string>>()
        const generationCheckpoints = new Map<string, number>()
        const rowStore = new Map<string, Chat>()
        const requeueChats = vi.fn()
        let committedStubDb: Array<{ chaId: string, chats: Array<{ id: string, name: string }> }> = []

        await runChatPersistStage({
            db,
            toSave: makeTrackedChanges({ character: ['char-1'] }),
            doingChat: true,
            knownChatIdsByCharacter,
            generationCheckpoints,
            requeueChats,
            now: () => 1_000,
            saveChat: async (chaId, _chatIndex, chatId, chat) => {
                rowStore.set(chatPersistKey(chaId, chatId), clone(chat))
            },
            commitStubDatabase: async () => {
                committedStubDb = db.characters.map(character => ({
                    chaId: character.chaId,
                    chats: character.chats.map(chat => ({
                        id: chat.id ?? '',
                        name: chat.name,
                    })),
                }))
                return { committed: true, result: undefined }
            },
        })

        expect(requeueChats).toHaveBeenCalledWith([['char-1', 'chat-new']])

        // Simulate losing every in-memory queue/checkpoint after the commit.
        const reloadedTracker = new Map<string, number>()
        const reloadedQueue: Array<[string, string]> = []
        expect(reloadedTracker.size).toBe(0)
        expect(reloadedQueue).toHaveLength(0)

        for (const character of committedStubDb) {
            for (const stub of character.chats) {
                const row = rowStore.get(chatPersistKey(character.chaId, stub.id))
                expect(row, `${character.chaId}/${stub.id} must resolve`).toBeDefined()
                expect(row?.message).toContainEqual({
                    role: 'user',
                    data: 'pre-generation user message',
                })
            }
        }
    })

    test('does not invoke the stub commit when an authoritative row write fails', async () => {
        const commitStubDatabase = vi.fn(async () => ({ committed: true, result: undefined }))

        const attempt = runChatPersistStage({
            db: makeDatabase(),
            toSave: makeTrackedChanges({ character: ['char-1'] }),
            doingChat: true,
            knownChatIdsByCharacter: new Map(),
            generationCheckpoints: new Map(),
            requeueChats: vi.fn(),
            saveChat: async () => {
                throw new Error('row store unavailable')
            },
            commitStubDatabase,
        })

        await expect(attempt).rejects.toEqual(
            expect.objectContaining<Partial<ChatRowPersistError>>({
                name: 'ChatRowPersistError',
                failedChats: [['char-1', 'chat-new']],
            })
        )
        expect(commitStubDatabase).not.toHaveBeenCalled()
    })

    test('throttles generation checkpoints until the interval elapses but lets forced saves through', async () => {
        const db = makeDatabase()
        const knownChatIdsByCharacter = new Map([['char-1', new Set(['chat-new'])]])
        const generationCheckpoints = new Map<string, number>()
        const saveChat = vi.fn(async () => {})
        let currentTime = 5_000
        const runCheckpoint = (forceChatPersist = false) => runChatPersistStage({
            db,
            toSave: makeTrackedChanges({ chat: [['char-1', 'chat-new']] }),
            doingChat: true,
            forceChatPersist,
            knownChatIdsByCharacter,
            generationCheckpoints,
            requeueChats: vi.fn(),
            now: () => currentTime,
            saveChat,
            commitStubDatabase: async () => ({ committed: true, result: undefined }),
        })

        await runCheckpoint()
        currentTime += CHECKPOINT_INTERVAL_MS - 1
        await runCheckpoint()
        expect(saveChat).toHaveBeenCalledTimes(1)

        currentTime += 1
        await runCheckpoint()
        expect(saveChat).toHaveBeenCalledTimes(2)
        expect(generationCheckpoints.get(chatPersistKey('char-1', 'chat-new'))).toBe(currentTime)

        currentTime += 1
        await runCheckpoint(true)
        expect(saveChat).toHaveBeenCalledTimes(3)
        expect(generationCheckpoints.get(chatPersistKey('char-1', 'chat-new'))).toBe(currentTime)
    })

    test('writes final content normally and marks a new chat known only after stub commit', async () => {
        const chat = makeChat()
        const db = makeDatabase(chat)
        const knownChatIdsByCharacter = new Map<string, Set<string>>()
        const generationCheckpoints = new Map<string, number>()
        const rowStore = new Map<string, Chat>()
        const requeuedChats: Array<[string, string]> = []
        const saveChat = vi.fn(async (chaId: string, _chatIndex: number, chatId: string, row: Chat) => {
            rowStore.set(chatPersistKey(chaId, chatId), clone(row))
        })

        const firstResult = await runChatPersistStage({
            db,
            toSave: makeTrackedChanges({ character: ['char-1'] }),
            doingChat: true,
            knownChatIdsByCharacter,
            generationCheckpoints,
            requeueChats: chats => requeuedChats.push(...chats),
            now: () => 10_000,
            saveChat,
            commitStubDatabase: async () => ({ committed: false, result: 'noop' as const }),
        })

        expect(firstResult).toBe('noop')
        expect(rowStore.get(chatPersistKey('char-1', 'chat-new'))?.message).toHaveLength(1)
        expect(knownChatIdsByCharacter.get('char-1')?.has('chat-new')).not.toBe(true)

        chat.message.push({ role: 'char', data: 'complete response' })
        await runChatPersistStage({
            db,
            toSave: makeTrackedChanges({ chat: requeuedChats }),
            doingChat: false,
            knownChatIdsByCharacter,
            generationCheckpoints,
            requeueChats: vi.fn(),
            now: () => 10_100,
            saveChat,
            commitStubDatabase: async () => ({ committed: true, result: 'saved' as const }),
        })

        expect(saveChat).toHaveBeenCalledTimes(2)
        expect(rowStore.get(chatPersistKey('char-1', 'chat-new'))?.message).toContainEqual({
            role: 'char',
            data: 'complete response',
        })
        expect(knownChatIdsByCharacter.get('char-1')).toEqual(new Set(['chat-new']))
        expect(generationCheckpoints.get(chatPersistKey('char-1', 'chat-new'))).toBe(10_100)
    })

    test('skips pre-existing placeholders without losing their known-row proof', async () => {
        const placeholder = {
            ...makeChat('chat-placeholder'),
            message: [],
            _placeholder: true,
        }
        const knownChatIdsByCharacter = new Map([
            ['char-1', new Set(['chat-placeholder'])],
        ])
        const saveChat = vi.fn(async () => {})

        await runChatPersistStage({
            db: makeDatabase(placeholder),
            toSave: makeTrackedChanges({ chat: [['char-1', 'chat-placeholder']] }),
            doingChat: false,
            knownChatIdsByCharacter,
            generationCheckpoints: new Map(),
            requeueChats: vi.fn(),
            saveChat,
            commitStubDatabase: async () => ({ committed: true, result: undefined }),
        })

        expect(saveChat).not.toHaveBeenCalled()
        expect(knownChatIdsByCharacter.get('char-1')).toEqual(new Set(['chat-placeholder']))
    })
})
