import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    getCharacterChatSnapshot: vi.fn(),
    fetchChatFromServer: vi.fn(),
}))

vi.mock('./database.svelte', () => ({
    getCharacterChatSnapshot: mocks.getCharacterChatSnapshot,
}))
vi.mock('./chatStorage', () => ({
    fetchChatFromServer: mocks.fetchChatFromServer,
}))

const {
    MissingInterchangeChatError,
    streamCharacterChats,
} = await import('./interchangeChatStream')

const snapshot = {
    character: { chaId: 'character-a', name: 'Character A', chats: [] },
    chats: Array.from({ length: 5 }, (_, index) => ({
        index,
        id: `chat-${index}`,
        name: `Chat ${index}`,
    })),
} as any

describe('bounded interchange chat reads', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCharacterChatSnapshot.mockImplementation((_characterIndex, ref) => ({
            id: ref.id,
            name: ref.name,
            message: [],
            _placeholder: true,
        }))
    })

    test('uses two-row lookahead while yielding stable source order', async () => {
        let active = 0
        let maxActive = 0
        mocks.fetchChatFromServer.mockImplementation(async (_chaId, index, id) => {
            active++
            maxActive = Math.max(maxActive, active)
            await new Promise(resolve => setTimeout(resolve, index % 2 === 0 ? 4 : 1))
            active--
            return { id, name: `Chat ${index}`, message: [{ role: 'user', data: String(index) }] }
        })

        const ids: string[] = []
        for await (const chat of streamCharacterChats(0, snapshot)) {
            ids.push(chat.id)
        }

        expect(ids).toEqual(['chat-0', 'chat-1', 'chat-2', 'chat-3', 'chat-4'])
        expect(maxActive).toBe(2)
    })

    test('fails closed when an authoritative placeholder row is missing', async () => {
        mocks.fetchChatFromServer.mockResolvedValue(null)
        const iterator = streamCharacterChats(0, {
            ...snapshot,
            chats: snapshot.chats.slice(0, 1),
        })

        await expect(iterator.next()).rejects.toEqual(expect.objectContaining({
            name: MissingInterchangeChatError.name,
            characterName: 'Character A',
            chatName: 'Chat 0',
        }))
    })
})
