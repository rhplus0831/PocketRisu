import { beforeEach, describe, expect, test, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
    db: { characters: [] } as any,
    selectedIndex: 0,
    backupReason: vi.fn(),
    sendChat: vi.fn(),
    setDatabase: vi.fn(),
    alertInput: vi.fn(),
    runTrigger: vi.fn(),
    generations: new Map<string, {
        generationId: string
        kind: 'live' | 'background'
        ownership: object
    }>(),
    endGenerationIfOwned: vi.fn(),
}))

vi.mock('../storage/database.svelte', () => ({
    getDatabase: () => runtime.db,
    setDatabase: runtime.setDatabase,
}))
vi.mock('../stores.svelte', () => ({
    selectedCharID: {
        subscribe: (run: (value: number) => void) => {
            run(runtime.selectedIndex)
            return () => {}
        },
    },
}))
vi.mock('../alert', () => ({
    alertInput: runtime.alertInput,
    alertMd: vi.fn(),
    alertNormal: vi.fn(),
    alertSelect: vi.fn(),
}))
vi.mock('./tts', () => ({ sayTTS: vi.fn() }))
vi.mock('../parser/parser.svelte', () => ({
    risuChatParser: (value: unknown) => String(value ?? ''),
}))
vi.mock('./index.svelte', () => ({ sendChat: runtime.sendChat }))
vi.mock('./generationState', () => ({
    chatGenKey: (chatId: string) => chatId,
    isChatGenerating: (chatId: string) => runtime.generations.has(chatId),
    captureGenerationOwnership: (chatId: string) => runtime.generations.get(chatId)?.ownership,
    endGenerationIfOwned: runtime.endGenerationIfOwned,
}))
vi.mock('./lorebook.svelte', () => ({ loadLoreBookV3Prompt: vi.fn() }))
vi.mock('./triggers', () => ({ runTrigger: runtime.runTrigger }))
vi.mock('../storage/chatStorage', () => ({
    setChatBackupReason: runtime.backupReason,
}))

const { processMultiCommand, processTriggerMultiCommand } = await import('./command')
const {
    captureChatPublicationGuard,
    publishTriggerChatToTarget,
    resolveChatSendTarget,
} = await import('./chatSendTarget')

function messages() {
    return [
        { role: 'user', data: 'one', chatId: 'one' },
        { role: 'char', data: 'two', chatId: 'two' },
        { role: 'user', data: 'three', chatId: 'three' },
    ]
}

function setup() {
    const selectedChat = { id: 'selected-chat', message: messages(), scriptstate: {} }
    const ownerChat = { id: 'owner-chat', message: messages(), scriptstate: {} }
    const selectedCharacter = {
        type: 'character',
        chaId: 'selected-character',
        chatPage: 0,
        chats: [selectedChat],
    }
    const ownerCharacter = {
        type: 'character',
        chaId: 'owner-character',
        chatPage: 0,
        chats: [ownerChat],
    }
    runtime.db = { characters: [selectedCharacter, ownerCharacter] }
    runtime.selectedIndex = 0
    return { selectedChat, ownerChat, selectedCharacter, ownerCharacter }
}

function context(ownerCharacter: any, ownerChat: any) {
    return {
        target: { chaId: ownerCharacter.chaId, chatId: ownerChat.id },
        character: structuredClone(ownerCharacter),
        chat: structuredClone(ownerChat),
        chatPublicationGuard: captureChatPublicationGuard(ownerChat),
    }
}

function installGeneration(chatId: string, generationId: string) {
    const ownership = { generationId }
    runtime.generations.set(chatId, {
        generationId,
        kind: 'live',
        ownership,
    })
    return ownership
}

beforeEach(() => {
    runtime.backupReason.mockReset()
    runtime.sendChat.mockReset()
    runtime.setDatabase.mockReset()
    runtime.alertInput.mockReset()
    runtime.runTrigger.mockReset()
    runtime.generations.clear()
    runtime.endGenerationIfOwned.mockReset()
    runtime.endGenerationIfOwned.mockImplementation((chatId: string, ownership: object) => {
        if(runtime.generations.get(chatId)?.ownership !== ownership) return false
        runtime.generations.delete(chatId)
        return true
    })
})

describe('target-aware trigger commands', () => {
    test.each([
        ['/cut 1-3', ['two', 'three']],
        ['/cut two', ['one', 'three']],
        ['/del 1', ['three']],
    ])('runs and marks %s without a consent grant or touching the selected chat', async (command, expected) => {
        const { selectedChat, ownerChat, ownerCharacter } = setup()
        const execution = context(ownerCharacter, ownerChat)

        const result = await processTriggerMultiCommand(command as string, execution)

        expect(result.chat.message.map((message: any) => message.data)).toEqual(expected)
        expect(result.destructiveChatMutation).toBe(true)
        expect(ownerChat.message).toEqual(messages())
        expect(selectedChat.message).toEqual(messages())

        const published = publishTriggerChatToTarget(
            runtime.db,
            execution.target,
            result,
            ({ chaId, chatId }) => runtime.backupReason(
                chaId,
                chatId,
                'script-bulk-chat',
            ),
            result.chatPublicationGuard,
        )
        expect(published?.chat).toBe(result.chat)
        expect(runtime.db.characters[1].chats[0].message.map((message: any) => message.data))
            .toEqual(expected)
        expect(runtime.db.characters[0].chats[0].message).toEqual(messages())
        expect(runtime.backupReason).toHaveBeenCalledWith(
            'owner-character',
            'owner-chat',
            'script-bulk-chat',
        )
    })

    test('ignores a stale false character capability for /cut', async () => {
        const { ownerChat, ownerCharacter } = setup()
        const execution = context(ownerCharacter, ownerChat)
        Object.assign(execution.character, { destructiveAccess: false })

        const result = await processTriggerMultiCommand('/cut 1-3', execution)

        expect(result.chat.message.map((message: any) => message.data))
            .toEqual(['two', 'three'])
        expect(result.destructiveChatMutation).toBe(true)
    })

    test('targets and backs up an ungated multisend clear before its nested send', async () => {
        const { selectedChat, ownerChat, ownerCharacter } = setup()
        runtime.sendChat.mockImplementation(async (_index: number, options: any) => {
            const resolved = resolveChatSendTarget(runtime.db, options.target)
            resolved?.chat.message.push({ role: 'char', data: 'generated' })
            return true
        })

        const result = await processTriggerMultiCommand(
            '/multisend clear|||replacement',
            context(ownerCharacter, ownerChat),
        )

        expect(result.destructiveChatMutation).toBe(true)
        expect(result.chat.message.map((message: any) => message.data))
            .toEqual(['replacement', 'generated'])
        expect(runtime.db.characters[1].chats[0].message.map((message: any) => message.data))
            .toEqual(['replacement', 'generated'])
        expect(result.chatPublicationGuard?.sourceChat)
            .toBe(runtime.db.characters[1].chats[0])
        expect(result.chatPublicationGuard?.sourceSnapshot.message.map((message: any) => message.data))
            .toEqual(['replacement', 'generated'])
        expect(publishTriggerChatToTarget(
            runtime.db,
            context(ownerCharacter, ownerChat).target,
            result,
            undefined,
            result.chatPublicationGuard,
        )?.chat.message.map((message: any) => message.data)).toEqual([
            'replacement',
            'generated',
        ])
        expect(selectedChat.message).toEqual(messages())
        expect(runtime.sendChat).toHaveBeenCalledWith(-1, {
            target: { chaId: 'owner-character', chatId: 'owner-chat' },
        })
        expect(runtime.backupReason).toHaveBeenCalledWith(
            'owner-character',
            'owner-chat',
            'script-bulk-chat',
        )
    })

    test('preserves a pre-existing outer generation when nested trigger send is rejected', async () => {
        const { ownerChat, ownerCharacter } = setup()
        installGeneration('owner-chat', 'outer-generation')
        runtime.sendChat.mockResolvedValue(false)

        const result = await processTriggerMultiCommand(
            '/multisend clear|||replacement',
            context(ownerCharacter, ownerChat),
        )

        expect(result.result).toBe(false)
        expect(runtime.generations.has('owner-chat')).toBe(true)
        expect(runtime.endGenerationIfOwned).not.toHaveBeenCalled()
        expect(runtime.sendChat).not.toHaveBeenCalled()
        expect(ownerChat.message).toEqual(messages())
        expect(runtime.backupReason).not.toHaveBeenCalled()
    })

    test('releases only a generation acquired by a successful nested send', async () => {
        const { ownerChat, ownerCharacter } = setup()
        runtime.sendChat.mockImplementationOnce(async (_index, options) => {
            installGeneration('owner-chat', 'nested-generation')
            const resolved = resolveChatSendTarget(runtime.db, options.target)
            resolved?.chat.message.push({ role: 'char', data: 'generated' })
            return true
        })

        const result = await processTriggerMultiCommand(
            '/multisend replacement',
            context(ownerCharacter, ownerChat),
        )

        expect(result.result).toBe('')
        expect(runtime.generations.has('owner-chat')).toBe(false)
        expect(runtime.endGenerationIfOwned).toHaveBeenCalledOnce()
        expect(runtime.endGenerationIfOwned).toHaveBeenCalledWith(
            'owner-chat',
            expect.any(Object),
        )
    })

    test('releases a generation acquired by a nested send that later returns false', async () => {
        const { ownerChat, ownerCharacter } = setup()
        runtime.sendChat.mockImplementationOnce(async () => {
            installGeneration('owner-chat', 'nested-generation')
            return false
        })

        const result = await processTriggerMultiCommand(
            '/multisend replacement',
            context(ownerCharacter, ownerChat),
        )

        expect(result.result).toBe(false)
        expect(runtime.generations.has('owner-chat')).toBe(false)
        expect(runtime.endGenerationIfOwned).toHaveBeenCalledOnce()
        expect(runtime.endGenerationIfOwned).toHaveBeenCalledWith(
            'owner-chat',
            expect.any(Object),
        )
    })

    test('releases a nested send generation when that owned send throws', async () => {
        const { ownerChat, ownerCharacter } = setup()
        runtime.sendChat.mockImplementationOnce(async () => {
            installGeneration('owner-chat', 'nested-generation')
            throw new Error('nested send failed')
        })

        await expect(processTriggerMultiCommand(
            '/multisend replacement',
            context(ownerCharacter, ownerChat),
        )).rejects.toThrow('nested send failed')

        expect(runtime.generations.has('owner-chat')).toBe(false)
        expect(runtime.endGenerationIfOwned).toHaveBeenCalledOnce()
        expect(runtime.endGenerationIfOwned).toHaveBeenCalledWith(
            'owner-chat',
            expect.any(Object),
        )
    })

    test('preserves a same-key replacement acquired after the nested send ends', async () => {
        const { ownerChat, ownerCharacter } = setup()
        let settle!: (result: boolean) => void
        let nestedOwnership!: object
        runtime.sendChat.mockImplementationOnce(() => {
            nestedOwnership = installGeneration('owner-chat', 'nested-generation')
            return new Promise<boolean>(resolve => {
                settle = resolve
            })
        })

        const command = processTriggerMultiCommand(
            '/multisend replacement',
            context(ownerCharacter, ownerChat),
        )
        expect(runtime.generations.get('owner-chat')?.ownership).toBe(nestedOwnership)

        // The nested send releases itself before its promise settles. A new
        // owner then legitimately takes the same key.
        runtime.generations.delete('owner-chat')
        const replacementOwnership = installGeneration('owner-chat', 'replacement-generation')
        settle(false)

        const result = await command
        expect(result.result).toBe(false)
        expect(runtime.generations.get('owner-chat')?.ownership).toBe(replacementOwnership)
        expect(runtime.endGenerationIfOwned).toHaveBeenCalledWith(
            'owner-chat',
            nestedOwnership,
        )
    })

    test('preserves a pre-existing outer generation in ordinary multisend', async () => {
        const { selectedChat } = setup()
        installGeneration('selected-chat', 'outer-generation')
        runtime.sendChat.mockResolvedValue(false)

        const result = await processMultiCommand('/multisend replacement')

        expect(result).toBe(false)
        expect(runtime.generations.has('selected-chat')).toBe(true)
        expect(runtime.endGenerationIfOwned).not.toHaveBeenCalled()
        expect(runtime.sendChat).not.toHaveBeenCalled()
        expect(selectedChat.message).toEqual(messages())
    })

    test.each([
        ['success', true, false],
        ['false result', false, false],
        ['exception', undefined, true],
    ])('cleans up an ordinary multisend generation after %s', async (_name, result, throws) => {
        setup()
        let ownership!: object
        runtime.sendChat.mockImplementationOnce(async () => {
            ownership = installGeneration('selected-chat', 'nested-generation')
            if(throws) throw new Error('ordinary nested send failed')
            return result
        })

        const command = processMultiCommand('/multisend replacement')
        if(throws){
            await expect(command).rejects.toThrow('ordinary nested send failed')
        } else {
            await expect(command).resolves.toBe(result ? '' : false)
        }

        expect(runtime.generations.has('selected-chat')).toBe(false)
        expect(runtime.endGenerationIfOwned).toHaveBeenCalledOnce()
        expect(runtime.endGenerationIfOwned).toHaveBeenCalledWith(
            'selected-chat',
            ownership,
        )
    })

    test('queues the mandatory reason before publishing a destructive snapshot', async () => {
        const { ownerChat, ownerCharacter } = setup()
        const execution = context(ownerCharacter, ownerChat)
        const result = await processTriggerMultiCommand('/cut 1-3', execution)
        let durableDataAtBackup: string[] | undefined
        runtime.backupReason.mockImplementationOnce(() => {
            durableDataAtBackup = runtime.db.characters[1].chats[0].message
                .map((message: any) => message.data)
        })

        publishTriggerChatToTarget(
            runtime.db,
            execution.target,
            result,
            ({ chaId, chatId }) => runtime.backupReason(
                chaId,
                chatId,
                'script-bulk-chat',
            ),
            result.chatPublicationGuard,
        )

        expect(durableDataAtBackup).toEqual(['one', 'two', 'three'])
        expect(runtime.db.characters[1].chats[0].message.map((message: any) => message.data))
            .toEqual(['two', 'three'])
    })

    test('keeps a post-await destructive pipeline bound across navigation', async () => {
        const { selectedChat, ownerChat, ownerCharacter } = setup()
        runtime.selectedIndex = 1
        let release!: (value: string) => void
        runtime.alertInput.mockImplementationOnce(() => new Promise<string>(resolve => {
            release = resolve
        }))
        const execution = context(ownerCharacter, ownerChat)
        const command = processTriggerMultiCommand('/input | /cut 1-3', execution)

        runtime.selectedIndex = 0
        release('ignored')
        const result = await command
        publishTriggerChatToTarget(
            runtime.db,
            execution.target,
            result,
            undefined,
            result.chatPublicationGuard,
        )

        expect(runtime.db.characters[1].chats[0].message.map((message: any) => message.data))
            .toEqual(['two', 'three'])
        expect(selectedChat.message).toEqual(messages())
    })

    test('publishes nothing when the captured target disappears during an await', async () => {
        const { ownerChat, ownerCharacter } = setup()
        let release!: (value: string) => void
        runtime.alertInput.mockImplementationOnce(() => new Promise<string>(resolve => {
            release = resolve
        }))
        const command = processTriggerMultiCommand(
            '/input | /cut 1-3',
            context(ownerCharacter, ownerChat),
        )

        runtime.db.characters.pop()
        release('ignored')
        const result = await command

        expect(result.targetMissing).toBe(true)
        expect(result.destructiveChatMutation).toBe(false)
        expect(result.chat.message).toEqual(messages())
        expect(runtime.backupReason).not.toHaveBeenCalled()
    })

    test('rejects awaited multisend publication after a concurrent same-ID append', async () => {
        const { ownerChat, ownerCharacter } = setup()
        let release!: (value: string) => void
        runtime.alertInput.mockImplementationOnce(() => new Promise<string>(resolve => {
            release = resolve
        }))
        const execution = context(ownerCharacter, ownerChat)
        const command = processTriggerMultiCommand(
            '/input | /multisend clear|||replacement',
            execution,
        )
        ownerChat.message.push({
            role: 'char',
            data: 'concurrent response',
            chatId: 'concurrent',
        })

        release('ignored')
        const result = await command

        expect(result.result).toBe(false)
        expect(result.targetMissing).toBe(true)
        expect(ownerChat.message.map((message: any) => message.data)).toEqual([
            'one',
            'two',
            'three',
            'concurrent response',
        ])
        expect(runtime.sendChat).not.toHaveBeenCalled()
        expect(runtime.backupReason).not.toHaveBeenCalled()
    })

    test('propagates a nested trigger refreshed guard into later pipeline publication', async () => {
        const { ownerChat, ownerCharacter } = setup()
        const execution = context(ownerCharacter, ownerChat)
        const initialGuard = execution.chatPublicationGuard
        runtime.runTrigger.mockImplementationOnce(async (_character, _mode, arg) => {
            const ownedSource = structuredClone(ownerChat)
            ownedSource.message.push({
                role: 'char',
                data: 'nested transition',
                chatId: 'nested',
            })
            runtime.db.characters[1].chats[0] = ownedSource
            return {
                chat: structuredClone(ownedSource),
                destructiveChatMutation: false,
                chatPublicationGuard: captureChatPublicationGuard(ownedSource as any),
            }
        })
        runtime.sendChat.mockImplementationOnce(async (_index, options) => {
            const resolved = resolveChatSendTarget(runtime.db, options.target)
            resolved?.chat.message.push({ role: 'char', data: 'generated' })
            return true
        })

        const result = await processTriggerMultiCommand(
            '/trigger nested | /multisend followup',
            execution,
        )

        expect(result.result).toBe('')
        expect(result.targetMissing).toBe(false)
        expect(runtime.runTrigger).toHaveBeenCalledWith(
            expect.anything(),
            'manual',
            expect.objectContaining({
                manualName: 'nested',
                chatPublicationGuard: initialGuard,
            }),
        )
        expect(runtime.db.characters[1].chats[0].message.map((message: any) => message.data))
            .toEqual([
                'one',
                'two',
                'three',
                'nested transition',
                'followup',
                'generated',
            ])
        expect(result.chatPublicationGuard?.sourceChat)
            .toBe(runtime.db.characters[1].chats[0])
    })

    test('marks only an actual deletion', async () => {
        const { ownerChat, ownerCharacter } = setup()

        const result = await processTriggerMultiCommand(
            '/cut missing',
            context(ownerCharacter, ownerChat),
        )

        expect(result.chat.message).toEqual(messages())
        expect(result.destructiveChatMutation).toBe(false)
    })

    test('does not mark multisend clear when it has no payload and changes nothing', async () => {
        const { ownerChat, ownerCharacter } = setup()

        const result = await processTriggerMultiCommand(
            '/multisend clear',
            context(ownerCharacter, ownerChat),
        )

        expect(result.chat.message).toEqual(messages())
        expect(result.destructiveChatMutation).toBe(false)
        expect(runtime.sendChat).not.toHaveBeenCalled()
        expect(runtime.backupReason).not.toHaveBeenCalled()
    })

    test('keeps ordinary user command selection behavior', async () => {
        const { selectedChat, ownerChat } = setup()

        await processMultiCommand('/cut 1-3')

        expect(selectedChat.message.map((message: any) => message.data))
            .toEqual(['two', 'three'])
        expect(ownerChat.message).toEqual(messages())
        expect(runtime.setDatabase).toHaveBeenCalled()
    })
})
