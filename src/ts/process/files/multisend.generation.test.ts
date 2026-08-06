import { beforeEach, describe, expect, test, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
    db: { characters: [] } as any,
    selectedIndex: 0,
    sendChat: vi.fn(),
    downloadFile: vi.fn(),
}))

vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => runtime.db,
    setDatabase: vi.fn(),
}))
vi.mock('src/ts/stores.svelte', () => ({
    selectedCharID: {
        subscribe: (run: (value: number) => void) => {
            run(runtime.selectedIndex)
            return () => {}
        },
    },
}))
vi.mock('../index.svelte', () => ({ sendChat: runtime.sendChat }))
vi.mock('src/ts/globalApi.svelte', () => ({ downloadFile: runtime.downloadFile }))
vi.mock('../memory/hypamemory', () => ({ HypaProcesser: class {} }))
vi.mock('src/ts/util', () => ({
    BufferToText: vi.fn(),
    selectMultipleFile: vi.fn(),
}))
vi.mock('./inlays', () => ({ postInlayAsset: vi.fn() }))

const { sendPofile } = await import('./multisend')
const {
    captureGenerationOwnership,
    endAllGenerations,
    endGenerationIfOwned,
    generationStates,
    isChatGenerating,
    startGeneration,
} = await import('../generationState')

function setup() {
    const chat = { id: 'po-chat', message: [] as any[] }
    const character = {
        type: 'character',
        chaId: 'po-character',
        chatPage: 0,
        chats: [chat],
    }
    const otherChat = {
        id: 'other-chat-row',
        message: [{ role: 'char', data: 'preserve B' }],
    }
    const otherCharacter = {
        type: 'character',
        chaId: 'other-character',
        chatPage: 0,
        chats: [otherChat],
    }
    runtime.db = { characters: [character, otherCharacter] }
    runtime.selectedIndex = 0
    return { chat, character, otherChat, otherCharacter }
}

const poFile = 'msgid "hello"\nmsgstr ""\n\n'
const multiPoFile = [
    'msgid "first"',
    'msgstr ""',
    '',
    'msgid "second"',
    'msgstr ""',
    '',
].join('\n')

beforeEach(() => {
    generationStates.set(new Map())
    endAllGenerations()
    runtime.sendChat.mockReset()
    runtime.selectedIndex = 0
    runtime.downloadFile.mockReset()
    runtime.downloadFile.mockResolvedValue(undefined)
})

describe('PO file multisend generation ownership', () => {
    test('concludes the final iteration without clearing an unrelated live owner', async () => {
        const { chat } = setup()
        startGeneration('unrelated-chat', 'unrelated-live')
        runtime.sendChat.mockImplementationOnce(async (_index, options) => {
            expect(options.target).toEqual({
                chaId: 'po-character',
                chatId: 'po-chat',
            })
            startGeneration('po-chat', 'po-request')
            chat.message.push({ role: 'char', data: 'translated' })
            return true
        })

        await sendPofile({ file: poFile, query: '' })

        expect(runtime.sendChat).toHaveBeenCalledOnce()
        expect(isChatGenerating('po-chat')).toBe(false)
        expect(isChatGenerating('unrelated-chat')).toBe(true)
    })

    test('releases its own final iteration on throw and preserves unrelated background work', async () => {
        setup()
        startGeneration('unrelated-chat', 'unrelated-background', 'background')
        const failure = new Error('PO generation failed')
        runtime.sendChat.mockImplementationOnce(async () => {
            startGeneration('po-chat', 'po-request')
            throw failure
        })

        await expect(sendPofile({ file: poFile, query: '' })).rejects.toBe(failure)

        expect(isChatGenerating('po-chat')).toBe(false)
        expect(isChatGenerating('unrelated-chat')).toBe(true)
    })

    test('preserves a same-key replacement acquired before the iteration settles', async () => {
        const { chat } = setup()
        let settle!: (value: boolean) => void
        let requestOwnership!: ReturnType<typeof captureGenerationOwnership>
        runtime.sendChat.mockImplementationOnce(() => {
            startGeneration('po-chat', 'po-request')
            requestOwnership = captureGenerationOwnership('po-chat')
            chat.message.push({ role: 'char', data: 'translated' })
            return new Promise<boolean>(resolve => {
                settle = resolve
            })
        })

        const sending = sendPofile({ file: poFile, query: '' })
        expect(requestOwnership).toBeDefined()
        endGenerationIfOwned('po-chat', requestOwnership!)
        const replacement = startGeneration('po-chat', 'replacement', 'background')
        settle(true)

        await sending
        expect(captureGenerationOwnership('po-chat')).toBe(replacement)
    })

    test('keeps a multi-entry batch on its captured owner across navigation during download', async () => {
        const { chat, otherChat } = setup()
        let request = 0
        runtime.sendChat.mockImplementation(async (_index, options) => {
            request += 1
            startGeneration('po-chat', `po-request-${request}`)
            const owner = runtime.db.characters.find(
                (character: any) => character.chaId === options.target.chaId,
            )
            const targetChat = owner.chats.find(
                (candidate: any) => candidate.id === options.target.chatId,
            )
            targetChat.message.push({ role: 'char', data: `translated ${request}` })
            return true
        })
        runtime.downloadFile.mockImplementation(async () => {
            if(runtime.downloadFile.mock.calls.length === 1){
                runtime.selectedIndex = 1
            }
        })

        await sendPofile({ file: multiPoFile, query: '' })

        expect(runtime.sendChat).toHaveBeenCalledTimes(2)
        expect(chat.message.map(message => message.data)).toEqual([
            'first',
            'translated 1',
            'second',
            'translated 2',
        ])
        expect(otherChat.message).toEqual([{ role: 'char', data: 'preserve B' }])
        expect(runtime.db.characters[1].chaId).toBe('other-character')
        expect(isChatGenerating('po-chat')).toBe(false)
    })

    test('aborts safely when the captured owner disappears between entries', async () => {
        const { chat, otherCharacter, otherChat } = setup()
        runtime.sendChat.mockImplementationOnce(async () => {
            startGeneration('po-chat', 'po-request')
            chat.message.push({ role: 'char', data: 'translated 1' })
            return true
        })
        runtime.downloadFile.mockImplementationOnce(async () => {
            runtime.db.characters = [otherCharacter]
            runtime.selectedIndex = 0
        })

        await expect(sendPofile({ file: multiPoFile, query: '' })).resolves.toBeUndefined()

        expect(runtime.sendChat).toHaveBeenCalledOnce()
        expect(runtime.db.characters[0]).toBe(otherCharacter)
        expect(otherChat.message).toEqual([{ role: 'char', data: 'preserve B' }])
        expect(isChatGenerating('po-chat')).toBe(false)
    })
})
