import { beforeEach, describe, expect, test, vi } from 'vitest'
import { writable } from 'svelte/store'

const state = vi.hoisted(() => ({
    db: null as any,
    processTriggerMultiCommand: vi.fn(),
}))

vi.mock('../parser/parser.svelte', () => ({
    risuChatParser: (value: unknown) => String(value ?? ''),
}))
vi.mock('../parser/chatML', () => ({ parseChatML: vi.fn() }))
vi.mock('../storage/database.svelte', () => ({
    getCurrentCharacter: () => state.db.characters[0],
    getCurrentChat: () => state.db.characters[0].chats[0],
    getDatabase: () => state.db,
    setCurrentCharacter: (character: any) => { state.db.characters[0] = character },
    setDatabase: (db: any) => { state.db = db },
}))
vi.mock('./modules', () => ({ getModuleTriggers: () => [] }))
vi.mock('../stores.svelte', () => ({
    ReloadChatPointer: writable(0),
    ReloadGUIPointer: writable(0),
    selectedCharID: writable(0),
    CurrentTriggerIdStore: writable(null),
}))
vi.mock('./command', () => ({
    processTriggerMultiCommand: state.processTriggerMultiCommand,
}))
vi.mock('../alert', () => ({
    alertError: vi.fn(),
    alertInput: vi.fn(),
    alertNormal: vi.fn(),
    alertSelect: vi.fn(),
}))
vi.mock('../tokenizer', () => ({ tokenize: vi.fn(async () => 0) }))
vi.mock('./memory/hypamemory', () => ({ HypaProcesser: class {} }))
vi.mock('./request/request', () => ({ requestChatData: vi.fn() }))
vi.mock('./request/shared', () => ({ collectStreamingText: vi.fn() }))
vi.mock('./stableDiff', () => ({ generateAIImage: vi.fn() }))
vi.mock('./files/inlays', () => ({ writeInlayImage: vi.fn() }))
vi.mock('./scriptings', () => ({ runScripted: vi.fn() }))
vi.mock('./infunctions', () => ({ calcString: vi.fn() }))

const { runTrigger } = await import('./triggers')
const {
    applyChatInputToTarget,
    captureChatPublicationGuard,
    publishTriggerChatToTarget,
    resolveChatExecutionTarget,
} = await import('./chatSendTarget')

function makeState(effect: Record<string, unknown>, destructiveAccess: unknown) {
    const chat = {
        id: 'chat',
        message: [
            { role: 'user', data: 'one' },
            { role: 'char', data: 'two' },
            { role: 'user', data: 'three' },
        ],
        scriptstate: {},
    }
    const character = {
        type: 'character',
        chaId: 'character',
        chatPage: 0,
        chats: [chat],
        defaultVariables: '',
        globalLore: [
            { comment: 'keep', key: '', content: 'first', insertorder: 0 },
            { comment: 'delete', key: '', content: 'second', insertorder: 0 },
        ],
        triggerscript: [{
            comment: 'destructive test',
            type: 'input',
            conditions: [],
            effect: [effect],
        }],
        destructiveAccess,
    }
    state.db = {
        characters: [character],
        templateDefaultVariables: '',
    }
    return { character, chat }
}

beforeEach(() => {
    state.db = null
    state.processTriggerMultiCommand.mockReset()
    state.processTriggerMultiCommand.mockImplementation(async (command: string, context: any) => {
        const destructive = command.startsWith('/cut')
            || command.startsWith('/del')
            || command.startsWith('/multisend clear')
        if(destructive && context.destructiveAccess !== true){
            return {
                result: '',
                chat: context.chat,
                destructiveChatMutation: false,
                targetMissing: false,
            }
        }
        const chat = structuredClone(context.chat)
        if(command.startsWith('/cut')){
            chat.message = chat.message.slice(1, 3)
        }
        return {
            result: '',
            chat,
            destructiveChatMutation: destructive,
            targetMissing: false,
        }
    })
})

describe('destructive trigger runtime gating', () => {
    test.each([
        { type: 'cutchat', start: '1', end: '3' },
        {
            type: 'v2CutChat',
            start: '1',
            end: '3',
            startType: 'value',
            endType: 'value',
            indent: 0,
        },
    ])('blocks $type without destructive access', async effect => {
        const { character, chat } = makeState(effect, false)

        const result = await runTrigger(character as any, 'input', { chat: chat as any })

        expect(result?.chat.message.map((message: any) => message.data))
            .toEqual(['one', 'two', 'three'])
        expect(result?.destructiveChatMutation).toBe(false)
    })

    test.each([
        { type: 'cutchat', start: '1', end: '3' },
        {
            type: 'v2CutChat',
            start: '1',
            end: '3',
            startType: 'value',
            endType: 'value',
            indent: 0,
        },
    ])('treats malformed truthy owner access as denied for $type', async effect => {
        const { character, chat } = makeState(effect, 'false')

        const result = await runTrigger(character as any, 'input', { chat: chat as any })

        expect(result?.chat.message.map((message: any) => message.data))
            .toEqual(['one', 'two', 'three'])
        expect(result?.destructiveChatMutation).toBe(false)
    })

    test.each([
        { type: 'cutchat', start: '1', end: '3' },
        {
            type: 'v2CutChat',
            start: '1',
            end: '3',
            startType: 'value',
            endType: 'value',
            indent: 0,
        },
    ])('allows and marks $type with destructive access', async effect => {
        const { character, chat } = makeState(effect, true)

        const result = await runTrigger(character as any, 'input', { chat: chat as any })

        expect(result?.chat.message.map((message: any) => message.data))
            .toEqual(['two', 'three'])
        expect(result?.destructiveChatMutation).toBe(true)
    })

    test('gates V2 lorebook deletion on the same separate capability', async () => {
        const effect = {
            type: 'v2DeleteLorebookByIndex',
            index: '1',
            indexType: 'value',
            indent: 0,
        }
        const denied = makeState(effect, false)
        await runTrigger(denied.character as any, 'input', { chat: denied.chat as any })
        expect(state.db.characters[0].globalLore.map((entry: any) => entry.comment))
            .toEqual(['keep', 'delete'])

        const allowed = makeState(effect, true)
        await runTrigger(allowed.character as any, 'input', { chat: allowed.chat as any })
        expect(state.db.characters[0].globalLore.map((entry: any) => entry.comment))
            .toEqual(['keep'])
    })

    test('publishes V2 lorebook deletion to the owning nonselected character', async () => {
        const effect = {
            type: 'v2DeleteLorebookByIndex',
            index: '1',
            indexType: 'value',
            indent: 0,
        }
        const { character: owner, chat } = makeState(effect, true)
        const selectedCharacter = {
            ...structuredClone(owner),
            chaId: 'selected-character',
            triggerscript: [],
            globalLore: [{ comment: 'selected', key: '', content: 'unchanged', insertorder: 0 }],
        }
        state.db.characters = [selectedCharacter, owner]

        await runTrigger(owner as any, 'input', { chat: chat as any })

        expect(state.db.characters[0].globalLore.map((entry: any) => entry.comment))
            .toEqual(['selected'])
        expect(state.db.characters[1].globalLore.map((entry: any) => entry.comment))
            .toEqual(['keep'])
    })

    test('publishes no V2 lorebook deletion when the owner disappears', async () => {
        const effect = {
            type: 'v2DeleteLorebookByIndex',
            index: '1',
            indexType: 'value',
            indent: 0,
        }
        const { character: owner, chat } = makeState(effect, true)
        const remainingCharacter = {
            ...structuredClone(owner),
            chaId: 'remaining-character',
            triggerscript: [],
        }
        state.db.characters = [remainingCharacter]

        await runTrigger(owner as any, 'input', { chat: chat as any })

        expect(state.db.characters[0].globalLore.map((entry: any) => entry.comment))
            .toEqual(['keep', 'delete'])
    })

    test('keeps script variables isolated until guarded publication', async () => {
        const effect = {
            type: 'setvar',
            var: 'answer',
            value: '42',
            operator: '=',
        }
        const { character: owner, chat: ownerChat } = makeState(effect, false)
        owner.chaId = 'owner-character'
        ownerChat.id = 'owner-chat'
        const selectedCharacter = {
            ...structuredClone(owner),
            chaId: 'selected-character',
            triggerscript: [],
            chats: [{ ...structuredClone(ownerChat), id: 'selected-chat', scriptstate: {} }],
        }
        state.db.characters = [selectedCharacter, owner]

        const guard = captureChatPublicationGuard(ownerChat as any)
        const result = await runTrigger(owner as any, 'input', { chat: ownerChat as any })

        expect(state.db.characters[0].chats[0].scriptstate).toEqual({})
        expect(state.db.characters[1].chats[0].scriptstate).toEqual({})
        expect(result?.chat.scriptstate).toEqual({ $answer: '42' })

        publishTriggerChatToTarget(
            state.db,
            { chaId: owner.chaId, chatId: ownerChat.id },
            result,
            undefined,
            guard,
        )

        expect(state.db.characters[1].chats[0].scriptstate).toEqual({ $answer: '42' })
    })

    test.each([
        {
            name: 'V1 setvar',
            effect: {
                type: 'setvar',
                var: 'answer',
                value: '42',
                operator: '=',
            },
            expected: { $answer: '42' },
        },
        {
            name: 'V2 getter outputVar',
            effect: {
                type: 'v2GetMessageCount',
                outputVar: 'messageCount',
                indent: 0,
            },
            expected: { $messageCount: '3' },
        },
    ])('publishes input $name once and appends the user message', async ({ effect, expected }) => {
        const { character, chat } = makeState(effect, false)

        const applied = await applyChatInputToTarget({
            getDatabase: () => state.db,
            target: { chaId: character.chaId, chatId: chat.id },
            input: 'new user message',
            now: () => 123,
            runInputTrigger: (owner, sourceChat) => runTrigger(owner, 'input', {
                chat: sourceChat,
            }),
            processInput: async (_owner, input) => input,
        })

        expect(applied?.chat.scriptstate).toEqual(expected)
        expect(applied?.chat.message.map((message: any) => message.data)).toEqual([
            'one',
            'two',
            'three',
            'new user message',
        ])
    })

    test('publishes V2 author note once and appends the user message', async () => {
        const { character, chat } = makeState({
            type: 'v2SetAuthorNote',
            value: 'isolated note',
            valueType: 'value',
            indent: 0,
        }, false)

        const applied = await applyChatInputToTarget({
            getDatabase: () => state.db,
            target: { chaId: character.chaId, chatId: chat.id },
            input: 'new user message',
            runInputTrigger: (owner, sourceChat) => runTrigger(owner, 'input', {
                chat: sourceChat,
            }),
            processInput: async (_owner, input) => input,
        })

        expect(applied?.chat.note).toBe('isolated note')
        expect(applied?.chat.message.at(-1)?.data).toBe('new user message')
    })

    test('rejects a destructive input trigger after a genuine concurrent append', async () => {
        const { character, chat } = makeState({
            type: 'command',
            value: '/cut 1-3',
        }, true)
        let release!: () => void
        let markStarted!: () => void
        const started = new Promise<void>(resolve => { markStarted = resolve })
        const wait = new Promise<void>(resolve => { release = resolve })
        state.processTriggerMultiCommand.mockImplementationOnce(async (_command, context) => {
            markStarted()
            await wait
            const resultChat = structuredClone(context.chat)
            resultChat.message = resultChat.message.slice(1, 3)
            return {
                result: '',
                chat: resultChat,
                destructiveChatMutation: true,
                targetMissing: false,
            }
        })
        const backupReason = vi.fn()

        const running = applyChatInputToTarget({
            getDatabase: () => state.db,
            target: { chaId: character.chaId, chatId: chat.id },
            input: 'new user message',
            runInputTrigger: (owner, sourceChat) => runTrigger(owner, 'input', {
                chat: sourceChat,
            }),
            onDestructiveChatMutation: backupReason,
            processInput: async (_owner, input) => input,
        })
        await started
        chat.message.push({ role: 'char', data: 'concurrent response' })
        release()
        const applied = await running

        expect(applied).toBeNull()
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'one',
            'two',
            'three',
            'concurrent response',
        ])
        expect(backupReason).not.toHaveBeenCalled()
    })

    test('repeated output and manual publication preserve the latest durable chat', async () => {
        const effect = {
            type: 'setvar',
            var: 'answer',
            value: '42',
            operator: '=',
        }
        const { character, chat } = makeState(effect, false)
        character.triggerscript[0].type = 'output'
        const target = { chaId: character.chaId, chatId: chat.id }

        for(let iteration = 0; iteration < 2; iteration++){
            const executionTarget = resolveChatExecutionTarget(state.db, target)!
            const guard = captureChatPublicationGuard(executionTarget.chat)
            const result = await runTrigger(character as any, 'output', {
                chat: executionTarget.chat,
            })
            publishTriggerChatToTarget(state.db, target, result, undefined, guard)
            if(iteration === 0){
                state.db.characters[0].chats[0].message.push({
                    role: 'char',
                    data: 'first output',
                })
            }
        }

        character.triggerscript[0].type = 'input'
        const manualTarget = resolveChatExecutionTarget(state.db, target)!
        const manualGuard = captureChatPublicationGuard(manualTarget.chat)
        const manualResult = await runTrigger(character as any, 'manual', {
            chat: manualTarget.chat,
            manualName: 'destructive test',
        })
        publishTriggerChatToTarget(state.db, target, manualResult, undefined, manualGuard)

        expect(state.db.characters[0].chats[0].message.at(-1)?.data).toBe('first output')
        expect(state.db.characters[0].chats[0].scriptstate).toEqual({ $answer: '42' })
    })

    test.each([
        ['start', 'in-place'],
        ['start', 'replacement'],
        ['output', 'in-place'],
        ['output', 'replacement'],
        ['manual', 'in-place'],
        ['manual', 'replacement'],
    ] as const)(
        'guarded %s publication rejects a concurrent same-ID %s change',
        async (mode, concurrentKind) => {
            const { character, chat } = makeState({
                type: 'command',
                value: '/cut 1-3',
            }, true)
            if(mode !== 'manual') character.triggerscript[0].type = mode
            let release!: () => void
            let markStarted!: () => void
            const started = new Promise<void>(resolve => { markStarted = resolve })
            const wait = new Promise<void>(resolve => { release = resolve })
            state.processTriggerMultiCommand.mockImplementationOnce(async (_command, context) => {
                markStarted()
                await wait
                const resultChat = structuredClone(context.chat)
                resultChat.message = resultChat.message.slice(1, 3)
                return {
                    result: '',
                    chat: resultChat,
                    destructiveChatMutation: true,
                    targetMissing: false,
                    chatPublicationGuard: context.chatPublicationGuard,
                }
            })
            const target = { chaId: character.chaId, chatId: chat.id }
            const initialGuard = captureChatPublicationGuard(chat as any)
            const running = runTrigger(character as any, mode, {
                chat: chat as any,
                manualName: mode === 'manual' ? 'destructive test' : undefined,
                chatPublicationGuard: initialGuard,
            })
            await started
            const durableChat = concurrentKind === 'in-place'
                ? chat
                : structuredClone(chat)
            durableChat.message.push({ role: 'char', data: 'concurrent response' })
            if(concurrentKind === 'replacement'){
                state.db.characters[0].chats[0] = durableChat
            }
            const backupReason = vi.fn()

            release()
            const triggerResult = await running
            const published = publishTriggerChatToTarget(
                state.db,
                target,
                triggerResult,
                backupReason,
                triggerResult?.chatPublicationGuard ?? initialGuard,
            )

            expect(published).toBeNull()
            expect(state.db.characters[0].chats[0]).toBe(durableChat)
            expect(durableChat.message.at(-1)?.data).toBe('concurrent response')
            expect(backupReason).not.toHaveBeenCalled()
        },
    )

    test.each([
        {
            name: 'V1 literal command',
            effect: { type: 'command', value: '/cut 1-3' },
            prepare: (_chat: any) => {},
        },
        {
            name: 'V2 dynamic command',
            effect: {
                type: 'v2Command',
                value: 'dynamicCommand',
                valueType: 'var',
                indent: 0,
            },
            prepare: (chat: any) => { chat.scriptstate.$dynamicCommand = '/cut 1-3' },
        },
    ])('passes owner access and durable target into $name execution', async ({ effect, prepare }) => {
        const denied = makeState(effect, false)
        prepare(denied.chat)
        const deniedResult = await runTrigger(denied.character as any, 'input', {
            chat: denied.chat as any,
        })
        expect(deniedResult?.chat.message.map((message: any) => message.data))
            .toEqual(['one', 'two', 'three'])
        expect(deniedResult?.destructiveChatMutation).toBe(false)
        expect(state.processTriggerMultiCommand).toHaveBeenLastCalledWith(
            '/cut 1-3',
            expect.objectContaining({
                target: { chaId: 'character', chatId: 'chat' },
                destructiveAccess: false,
            }),
        )

        const allowed = makeState(effect, true)
        prepare(allowed.chat)
        const allowedResult = await runTrigger(allowed.character as any, 'input', {
            chat: allowed.chat as any,
        })
        expect(allowedResult?.chat.message.map((message: any) => message.data))
            .toEqual(['two', 'three'])
        expect(allowedResult?.destructiveChatMutation).toBe(true)
        expect(state.processTriggerMultiCommand).toHaveBeenLastCalledWith(
            '/cut 1-3',
            expect.objectContaining({
                target: { chaId: 'character', chatId: 'chat' },
                destructiveAccess: true,
            }),
        )
    })
})
