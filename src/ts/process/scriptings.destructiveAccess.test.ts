import { beforeEach, describe, expect, test, vi } from 'vitest'
import { writable } from 'svelte/store'

const fakeLua = vi.hoisted(() => ({
    globals: new Map<string, any>(),
}))
const runtime = vi.hoisted(() => ({
    db: { characters: [] } as any,
    selectedCharacterIndex: 0,
    backupReason: vi.fn(),
    delay: null as any,
}))

vi.mock('wasmoon', () => ({
    LuaFactory: class {
        async mountFile() {}
        async createEngine() {
            fakeLua.globals = new Map()
            return {
                global: {
                    set: (name: string, value: any) => fakeLua.globals.set(name, value),
                    get: (name: string) => fakeLua.globals.get(name),
                    close: vi.fn(),
                },
                doString: async (source: string) => {
                    const mutate = (id: string) => {
                        if (source.includes('-- TEST_SET')) {
                            fakeLua.globals.get('setChat')(id, 1, 'updated')
                        } else if (source.includes('-- TEST_ADD')) {
                            fakeLua.globals.get('addChat')(id, 'char', 'hook marker')
                        } else if (source.includes('-- TEST_CUT')) {
                            fakeLua.globals.get('cutChat')(id, 1, 3)
                        } else if (source.includes('-- TEST_REMOVE')) {
                            fakeLua.globals.get('removeChat')(id, 1)
                        } else if (source.includes('-- TEST_REPLACE')) {
                            fakeLua.globals.get('setFullChatMain')(
                                id,
                                JSON.stringify([{ role: 'char', data: 'replacement' }]),
                            )
                        }
                    }
                    const mutateAndWait = async (id: string) => {
                        mutate(id)
                        if(source.includes('-- TEST_DELAY')){
                            runtime.delay?.started()
                            await runtime.delay?.wait
                        }
                    }
                    fakeLua.globals.set('onInput', mutateAndWait)
                    fakeLua.globals.set('onButtonClick', async (id: string) => mutateAndWait(id))
                    fakeLua.globals.set(
                        'callListenMain',
                        async (_mode: string, id: string, data: string) => {
                            await mutateAndWait(id)
                            return data
                        },
                    )
                },
            }
        }
    },
}))
vi.mock('../parser/chatVar.svelte', () => ({
    getChatVar: vi.fn(),
    getGlobalChatVar: vi.fn(),
    setChatVar: vi.fn(),
}))
vi.mock('../parser/parser.svelte', () => ({
    hasher: vi.fn(),
    risuChatParser: (value: unknown) => String(value ?? ''),
}))
vi.mock('../storage/database.svelte', () => ({
    getCurrentCharacter: vi.fn(() => runtime.db.characters[runtime.selectedCharacterIndex] ?? null),
    getCurrentChat: vi.fn(() => {
        const character = runtime.db.characters[runtime.selectedCharacterIndex]
        return character?.chats?.[character.chatPage] ?? null
    }),
    getDatabase: vi.fn(() => runtime.db),
    setDatabase: vi.fn(),
}))
vi.mock('../stores.svelte', () => ({
    ReloadChatPointer: writable(0),
    ReloadGUIPointer: writable(0),
    selectedCharID: writable(0),
}))
vi.mock('../alert', () => ({
    alertSelect: vi.fn(),
    alertError: vi.fn(),
    alertInput: vi.fn(),
    alertNormal: vi.fn(),
    alertConfirm: vi.fn(),
}))
vi.mock('./memory/hypamemory', () => ({ HypaProcesser: class {} }))
vi.mock('./stableDiff', () => ({ generateAIImage: vi.fn() }))
vi.mock('./files/inlays', () => ({
    writeInlayImage: vi.fn(),
    getInlayAsset: vi.fn(),
}))
vi.mock('./request/request', () => ({ requestChatData: vi.fn() }))
vi.mock('./modules', () => ({
    getModuleLorebooks: () => [],
    getModuleTriggers: () => [],
}))
vi.mock('../tokenizer', () => ({ tokenize: vi.fn(async () => 0) }))
vi.mock('../globalApi.svelte', () => ({
    fetchNative: vi.fn(),
    readImage: vi.fn(),
}))
vi.mock('./lorebook.svelte', () => ({ loadLoreBookV3Prompt: vi.fn() }))
vi.mock('../util', () => ({
    asBuffer: vi.fn(),
    getPersonaPrompt: vi.fn(),
    getUserName: vi.fn(),
    getUserIcon: vi.fn(),
}))
vi.mock('../storage/chatStorage', () => ({ setChatBackupReason: runtime.backupReason }))

const { runLuaButtonTrigger, runLuaEditTrigger, runScripted } = await import('./scriptings')
const { resolveChatExecutionTarget } = await import('./chatSendTarget')

function chat() {
    return {
        message: [
            { role: 'user', data: 'one' },
            { role: 'char', data: 'two' },
            { role: 'user', data: 'three' },
        ],
    } as any
}

function delayedExecution() {
    let release!: () => void
    let signalStarted!: () => void
    const started = new Promise<void>(resolve => { signalStarted = resolve })
    const wait = new Promise<void>(resolve => { release = resolve })
    runtime.delay = { started: signalStarted, wait }
    return { started, release }
}

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('return {}')))
    runtime.db = { characters: [] }
    runtime.selectedCharacterIndex = 0
    runtime.backupReason.mockReset()
    runtime.delay = null
})

describe('Lua destructive chat API gating', () => {
    test.each([
        ['cutChat', '-- TEST_CUT'],
        ['removeChat', '-- TEST_REMOVE'],
        ['setFullChat', '-- TEST_REPLACE'],
    ])('blocks %s without destructive access', async (_api, code) => {
        const original = chat()

        const result = await runScripted(code, {
            chat: original,
            mode: 'input',
            destructiveAccess: false,
        })

        expect(result.chat.message.map((message: any) => message.data))
            .toEqual(['one', 'two', 'three'])
        expect(result.destructiveChatMutation).toBe(false)
    })

    test.each([
        ['cutChat', '-- TEST_CUT', ['two', 'three']],
        ['removeChat', '-- TEST_REMOVE', ['one', 'three']],
        ['setFullChat', '-- TEST_REPLACE', ['replacement']],
    ])('allows and marks %s with destructive access', async (_api, code, expected) => {
        const original = chat()

        const result = await runScripted(code as string, {
            chat: original,
            mode: 'input',
            destructiveAccess: true,
        })

        expect(result.chat.message.map((message: any) => message.data)).toEqual(expected)
        expect(result.destructiveChatMutation).toBe(true)
    })

    test('treats malformed truthy per-run grants as denied', async () => {
        const original = chat()

        const result = await runScripted('-- TEST_CUT', {
            chat: original,
            mode: 'input',
            destructiveAccess: 'false' as any,
        })

        expect(result.chat.message.map((message: any) => message.data))
            .toEqual(['one', 'two', 'three'])
        expect(result.destructiveChatMutation).toBe(false)
    })

    test('binds a nonselected edit hook to its explicit durable owner target', async () => {
        const selectedChat = { ...chat(), id: 'selected-chat' }
        const ownerChat = { ...chat(), id: 'owner-chat' }
        const selectedCharacter = {
            type: 'character',
            chaId: 'selected-character',
            chatPage: 0,
            chats: [selectedChat],
            triggerscript: [],
        }
        const ownerCharacter = {
            type: 'character',
            chaId: 'owner-character',
            chatPage: 0,
            chats: [ownerChat],
            triggerscript: [{ effect: [{ type: 'triggerlua', code: '-- TEST_CUT' }] }],
            destructiveAccess: true,
        }
        runtime.db = { characters: [selectedCharacter, ownerCharacter] }

        await runLuaEditTrigger(ownerCharacter as any, 'editinput', 'payload', {}, {
            chaId: ownerCharacter.chaId,
            chatId: ownerChat.id,
            chat: ownerChat as any,
        })

        expect(ownerChat.message.map((message: any) => message.data))
            .toEqual(['one', 'two', 'three'])
        expect(runtime.db.characters[1].chats[0].message.map((message: any) => message.data))
            .toEqual(['two', 'three'])
        expect(selectedChat.message.map((message: any) => message.data))
            .toEqual(['one', 'two', 'three'])
        expect(runtime.backupReason).toHaveBeenCalledWith(
            'owner-character',
            'owner-chat',
            'script-bulk-chat',
        )
    })

    test('treats malformed truthy owner grants as denied', async () => {
        const ownerChat = { ...chat(), id: 'owner-chat' }
        const ownerCharacter = {
            type: 'character',
            chaId: 'owner-character',
            chatPage: 0,
            chats: [ownerChat],
            triggerscript: [{ effect: [{ type: 'triggerlua', code: '-- TEST_CUT' }] }],
            destructiveAccess: 'false',
        }
        runtime.db = { characters: [ownerCharacter] }

        await runLuaEditTrigger(ownerCharacter as any, 'editinput', 'payload', {}, {
            chaId: ownerCharacter.chaId,
            chatId: ownerChat.id,
            chat: ownerChat as any,
        })

        expect(ownerChat.message.map((message: any) => message.data))
            .toEqual(['one', 'two', 'three'])
        expect(runtime.backupReason).not.toHaveBeenCalled()
    })

    test('isolates a delayed destructive edit hook and queues backup before replacement', async () => {
        const ownerChat = { ...chat(), id: 'owner-chat' }
        const otherChat = { ...chat(), id: 'other-chat' }
        const ownerCharacter = {
            type: 'character',
            chaId: 'owner-character',
            chatPage: 0,
            chats: [ownerChat],
            triggerscript: [{
                effect: [{ type: 'triggerlua', code: '-- TEST_CUT\n-- TEST_DELAY' }],
            }],
            destructiveAccess: true,
        }
        runtime.db = {
            characters: [
                ownerCharacter,
                {
                    type: 'character',
                    chaId: 'other-character',
                    chatPage: 0,
                    chats: [otherChat],
                    triggerscript: [],
                },
            ],
        }
        const delay = delayedExecution()
        let durableDataAtBackup: string[] | undefined
        runtime.backupReason.mockImplementationOnce(() => {
            durableDataAtBackup = runtime.db.characters[0].chats[0].message
                .map((message: any) => message.data)
        })

        const running = runLuaEditTrigger(ownerCharacter as any, 'editinput', 'payload', {}, {
            chaId: ownerCharacter.chaId,
            chatId: ownerChat.id,
            chat: ownerChat as any,
        })
        await delay.started
        runtime.selectedCharacterIndex = 1

        expect(ownerChat.message.map((message: any) => message.data))
            .toEqual(['one', 'two', 'three'])
        expect(runtime.backupReason).not.toHaveBeenCalled()

        delay.release()
        await running

        expect(durableDataAtBackup).toEqual(['one', 'two', 'three'])
        expect(runtime.db.characters[0].chats[0].message.map((message: any) => message.data))
            .toEqual(['two', 'three'])
        expect(otherChat.message.map((message: any) => message.data))
            .toEqual(['one', 'two', 'three'])
    })

    test('isolates a delayed destructive button hook and handles publication once', async () => {
        const selectedChat = { ...chat(), id: 'selected-chat' }
        const ownerChat = { ...chat(), id: 'owner-chat' }
        const ownerCharacter = {
            type: 'character',
            chaId: 'owner-character',
            chatPage: 0,
            chats: [ownerChat],
            triggerscript: [{
                effect: [{
                    type: 'triggerlua',
                    code: '-- TEST_REMOVE\n-- TEST_DELAY\n-- TEST_STALE_BUTTON',
                }],
            }],
            destructiveAccess: true,
        }
        runtime.db = {
            characters: [
                {
                    type: 'character',
                    chaId: 'selected-character',
                    chatPage: 0,
                    chats: [selectedChat],
                    triggerscript: [],
                },
                ownerCharacter,
            ],
        }
        const delay = delayedExecution()
        let durableDataAtBackup: string[] | undefined
        runtime.backupReason.mockImplementationOnce(() => {
            durableDataAtBackup = runtime.db.characters[1].chats[0].message
                .map((message: any) => message.data)
        })

        const running = runLuaButtonTrigger(ownerCharacter as any, 'button', {
            chaId: ownerCharacter.chaId,
            chatId: ownerChat.id,
            chat: ownerChat as any,
        })
        await delay.started

        expect(ownerChat.message.map((message: any) => message.data))
            .toEqual(['one', 'two', 'three'])
        expect(runtime.backupReason).not.toHaveBeenCalled()

        delay.release()
        const result = await running

        expect(result.chatPublicationHandled).toBe(true)
        expect(result.destructiveChatMutation).toBe(true)
        expect(durableDataAtBackup).toEqual(['one', 'two', 'three'])
        expect(runtime.db.characters[1].chats[0].message.map((message: any) => message.data))
            .toEqual(['one', 'three'])
        expect(selectedChat.message.map((message: any) => message.data))
            .toEqual(['one', 'two', 'three'])
        expect(runtime.backupReason).toHaveBeenCalledOnce()
    })

    test('publishes no delayed Lua edit when the stable target disappears', async () => {
        const ownerChat = { ...chat(), id: 'owner-chat' }
        const ownerCharacter = {
            type: 'character',
            chaId: 'owner-character',
            chatPage: 0,
            chats: [ownerChat],
            triggerscript: [{
                effect: [{ type: 'triggerlua', code: '-- TEST_CUT\n-- TEST_DELAY' }],
            }],
            destructiveAccess: true,
        }
        runtime.db = { characters: [ownerCharacter] }
        const delay = delayedExecution()

        const running = runLuaEditTrigger(ownerCharacter as any, 'editinput', 'payload', {}, {
            chaId: ownerCharacter.chaId,
            chatId: ownerChat.id,
            chat: ownerChat as any,
        })
        await delay.started
        runtime.db.characters = []
        delay.release()
        await running

        expect(ownerChat.message.map((message: any) => message.data))
            .toEqual(['one', 'two', 'three'])
        expect(runtime.backupReason).not.toHaveBeenCalled()
    })

    test('publishes isolated non-destructive Lua edits without a forced reason', async () => {
        const ownerChat = { ...chat(), id: 'owner-chat' }
        const ownerCharacter = {
            type: 'character',
            chaId: 'owner-character',
            chatPage: 0,
            chats: [ownerChat],
            triggerscript: [{ effect: [{ type: 'triggerlua', code: '-- TEST_SET' }] }],
            destructiveAccess: false,
        }
        runtime.db = { characters: [ownerCharacter] }

        await runLuaEditTrigger(ownerCharacter as any, 'editinput', 'payload', {}, {
            chaId: ownerCharacter.chaId,
            chatId: ownerChat.id,
            chat: ownerChat as any,
        })

        expect(ownerChat.message.map((message: any) => message.data))
            .toEqual(['one', 'two', 'three'])
        expect(runtime.db.characters[0].chats[0].message.map((message: any) => message.data))
            .toEqual(['one', 'updated', 'three'])
        expect(runtime.backupReason).not.toHaveBeenCalled()
    })

    test('repeated multiline editoutput hooks clone the latest durable row', async () => {
        const ownerChat = { ...chat(), id: 'owner-chat' }
        const ownerCharacter = {
            type: 'character',
            chaId: 'owner-character',
            chatPage: 0,
            chats: [ownerChat],
            triggerscript: [{ effect: [{ type: 'triggerlua', code: '-- TEST_ADD' }] }],
            destructiveAccess: false,
        }
        runtime.db = { characters: [ownerCharacter] }
        const target = { chaId: ownerCharacter.chaId, chatId: ownerChat.id }

        await runLuaEditTrigger(
            ownerCharacter as any,
            'editoutput',
            'first output',
            {},
            resolveChatExecutionTarget(runtime.db, target)!,
        )
        runtime.db.characters[0].chats[0].message.push({
            role: 'char',
            data: 'first appended response',
        })
        await runLuaEditTrigger(
            ownerCharacter as any,
            'editoutput',
            'second output',
            {},
            resolveChatExecutionTarget(runtime.db, target)!,
        )

        expect(runtime.db.characters[0].chats[0].message.map((message: any) => message.data))
            .toEqual([
                'one',
                'two',
                'three',
                'hook marker',
                'first appended response',
                'hook marker',
            ])
        expect(runtime.backupReason).not.toHaveBeenCalled()
    })

    test('drops a delayed destructive hook after a same-ID concurrent replacement', async () => {
        const ownerChat = { ...chat(), id: 'owner-chat' }
        const ownerCharacter = {
            type: 'character',
            chaId: 'owner-character',
            chatPage: 0,
            chats: [ownerChat],
            triggerscript: [{
                effect: [{ type: 'triggerlua', code: '-- TEST_CUT\n-- TEST_DELAY' }],
            }],
            destructiveAccess: true,
        }
        runtime.db = { characters: [ownerCharacter] }
        const delay = delayedExecution()
        const running = runLuaEditTrigger(ownerCharacter as any, 'editoutput', 'payload', {}, {
            chaId: ownerCharacter.chaId,
            chatId: ownerChat.id,
            chat: ownerChat as any,
        })
        await delay.started
        const concurrentReplacement = structuredClone(ownerChat)
        concurrentReplacement.message.push({ role: 'char', data: 'concurrent response' })
        runtime.db.characters[0].chats[0] = concurrentReplacement

        delay.release()
        await running

        expect(runtime.db.characters[0].chats[0]).toBe(concurrentReplacement)
        expect(concurrentReplacement.message.map((message: any) => message.data))
            .toEqual(['one', 'two', 'three', 'concurrent response'])
        expect(runtime.backupReason).not.toHaveBeenCalled()
    })

    test('drops a delayed destructive button after a same-ID concurrent replacement', async () => {
        const ownerChat = { ...chat(), id: 'owner-chat' }
        const ownerCharacter = {
            type: 'character',
            chaId: 'owner-character',
            chatPage: 0,
            chats: [ownerChat],
            triggerscript: [{
                effect: [{ type: 'triggerlua', code: '-- TEST_REMOVE\n-- TEST_DELAY' }],
            }],
            destructiveAccess: true,
        }
        runtime.db = { characters: [ownerCharacter] }
        const delay = delayedExecution()
        const running = runLuaButtonTrigger(ownerCharacter as any, 'button', {
            chaId: ownerCharacter.chaId,
            chatId: ownerChat.id,
            chat: ownerChat as any,
        })
        await delay.started
        const concurrentReplacement = structuredClone(ownerChat)
        concurrentReplacement.message.push({ role: 'char', data: 'concurrent response' })
        runtime.db.characters[0].chats[0] = concurrentReplacement

        delay.release()
        const result = await running

        expect(result.chatPublicationHandled).toBe(true)
        expect(result.destructiveChatMutation).toBe(true)
        expect(runtime.db.characters[0].chats[0]).toBe(concurrentReplacement)
        expect(concurrentReplacement.message.map((message: any) => message.data))
            .toEqual(['one', 'two', 'three', 'concurrent response'])
        expect(runtime.backupReason).not.toHaveBeenCalled()
    })
})
