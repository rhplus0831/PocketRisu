import { beforeEach, describe, test, expect, vi } from 'vitest'

// Stub out the heavy reactive modules so loading chatStorage.ts doesn't trigger
// unrelated $effect chains that fail in a stripped-down test environment.
// Mirror the production isChatStub semantics including the hybrid guard so
// the chat-data-loss tests below exercise the real intent.
const { mockSaveChatContent, mockMarkCharacterDirty, mockDbState } = vi.hoisted(() => ({
    mockSaveChatContent: vi.fn(),
    mockMarkCharacterDirty: vi.fn(),
    mockDbState: { characters: [] as any[] },
}))

vi.mock('../globalApi.svelte', () => ({
    forageStorage: {
        realStorage: {
            saveChatContent: mockSaveChatContent,
        },
    },
    markCharacterDirty: mockMarkCharacterDirty,
}))
vi.mock('./database.svelte', () => ({
    getDatabase: () => mockDbState,
    isChatStub: (chat: any) => chat
        && chat._stub === true
        && !Array.isArray(chat.message),
}))

const {
    chatToStub,
    stubToPlaceholder,
    convertStubsToPlaceholders,
    classifyChat,
    consumeChatBackupReason,
    importChatBackup,
    prepareChatForImport,
    saveChatToServer,
    setChatBackupReason,
    transformChatBackupForImport,
} = await import('./chatStorage')
type Chat = any
type ChatStub = any

beforeEach(() => {
    mockSaveChatContent.mockReset()
    mockMarkCharacterDirty.mockReset()
    mockDbState.characters = []
})

// Round-trip tests for stub ↔ placeholder conversions. The server merge layer
// relies on key presence ('in' semantics) to distinguish "user cleared this
// field" from "field is absent". Both client converters must preserve key
// presence end-to-end, otherwise null clears get dropped on the way out and
// stale fullChat metadata resurfaces on the next persist.

const blankChat = (overrides: Partial<Chat> = {}): Chat => ({
    message: [],
    note: '',
    name: 'test',
    localLore: [],
    id: 'c1',
    ...overrides,
})

describe('pending chat backup reasons', () => {
    test('stores reasons per chat and consumes each one once', () => {
        setChatBackupReason('char-a', 'chat-1', 'reroll')
        setChatBackupReason('char-a', 'chat-2', 'edit-message')

        expect(consumeChatBackupReason('char-a', 'chat-1')).toBe('reroll')
        expect(consumeChatBackupReason('char-a', 'chat-1')).toBeUndefined()
        expect(consumeChatBackupReason('char-a', 'chat-2')).toBe('edit-message')
    })

    test('passes a pending reason only to the next server save', async () => {
        const chat = blankChat()
        setChatBackupReason('char-b', chat.id, 'delete-message')

        await saveChatToServer('char-b', 0, chat.id, chat)
        await saveChatToServer('char-b', 0, chat.id, chat)

        expect(mockSaveChatContent).toHaveBeenNthCalledWith(
            1,
            'char-b',
            0,
            chat.id,
            chat,
            'delete-message',
        )
        expect(mockSaveChatContent).toHaveBeenNthCalledWith(
            2,
            'char-b',
            0,
            chat.id,
            chat,
            undefined,
        )
    })
})

describe('chat backup import transformation', () => {
    test('shared import preparation clones content, strips cold markers, and assigns a fresh id', () => {
        const original = blankChat({
            id: 'source-id',
            message: [{ role: 'user', data: 'portable content' }] as any,
            _stub: true,
            _placeholder: true,
        } as any)

        const imported = prepareChatForImport(original, () => 'fresh-id')

        expect(imported).not.toBe(original)
        expect(imported.message).not.toBe(original.message)
        expect(imported.message).toEqual(original.message)
        expect(imported.id).toBe('fresh-id')
        expect(imported).not.toHaveProperty('_stub')
        expect(imported).not.toHaveProperty('_placeholder')
        expect(original.id).toBe('source-id')
        expect(original).toHaveProperty('_stub', true)
    })

    test('shared import preparation restores required full-chat fields', () => {
        const imported = prepareChatForImport({ id: 'source-id' } as any, () => 'fresh-id')

        expect(imported).toMatchObject({
            id: 'fresh-id',
            message: [],
            note: '',
            name: '',
            localLore: [],
        })
    })

    test('clones into a full chat with a fresh id and restored-name suffix', () => {
        const original = blankChat({
            id: 'original-chat-id',
            name: 'Recovered conversation',
            message: [{ role: 'user', data: 'keep me' }] as any,
            lastDate: 123,
            _placeholder: true,
            _stub: true,
        } as any)

        const restored = transformChatBackupForImport(original, 1_700_000_000_000)

        expect(restored).not.toBe(original)
        expect(restored.message).not.toBe(original.message)
        expect(restored.message).toEqual(original.message)
        expect(restored.id).not.toBe(original.id)
        expect(restored.id).toMatch(/^[0-9a-f-]{36}$/)
        expect(restored.name).toContain('Recovered conversation')
        expect(restored.name).toContain('(restored ')
        expect(restored.lastDate).toBe(1_700_000_000_000)
        expect(restored).not.toHaveProperty('_stub')
        expect(restored).not.toHaveProperty('_placeholder')
        expect(original).toHaveProperty('_stub', true)
        expect(original).toHaveProperty('_placeholder', true)
    })

    test('replaces a missing message list with an empty array', () => {
        const restored = transformChatBackupForImport(
            blankChat({ message: undefined as any }),
            1_700_000_000_000,
        )

        expect(restored.message).toEqual([])
    })

    test('import appends to the target character and marks it dirty', () => {
        const target = { chaId: 'char-t', chats: [blankChat({ id: 'existing' })] }
        mockDbState.characters = [target]

        const restored = importChatBackup('char-t', blankChat({ id: 'backup-id' }))

        expect(target.chats).toHaveLength(2)
        expect(target.chats[1]).toBe(restored)
        expect(restored.id).not.toBe('backup-id')
        // Without the explicit dirty mark, imports into non-selected
        // characters never persist — see markCharacterDirty in globalApi.
        expect(mockMarkCharacterDirty).toHaveBeenCalledWith('char-t')
    })

    test('import throws when the target character is missing', () => {
        expect(() => importChatBackup('missing', blankChat())).toThrow()
        expect(mockMarkCharacterDirty).not.toHaveBeenCalled()
    })
})

describe('chatToStub', () => {
    test('preserves explicit null folderId as a key', () => {
        const stub = chatToStub(blankChat({ folderId: null as any }))
        expect('folderId' in stub).toBe(true)
        expect(stub.folderId).toBeNull()
    })

    test('omits folderId when the chat has no such key', () => {
        const stub = chatToStub(blankChat())
        expect('folderId' in stub).toBe(false)
    })

    test('preserves a non-null folderId', () => {
        const stub = chatToStub(blankChat({ folderId: 'F1' }))
        expect(stub.folderId).toBe('F1')
    })

    test('same key-presence semantics applies to modules', () => {
        expect('modules' in chatToStub(blankChat({ modules: null as any }))).toBe(true)
        expect('modules' in chatToStub(blankChat({ modules: [] }))).toBe(true)
        expect('modules' in chatToStub(blankChat())).toBe(false)
    })

    test('same key-presence semantics applies to lastDate', () => {
        expect('lastDate' in chatToStub(blankChat({ lastDate: null as any }))).toBe(true)
        expect('lastDate' in chatToStub(blankChat({ lastDate: 0 }))).toBe(true)
        expect('lastDate' in chatToStub(blankChat())).toBe(false)
    })

    test('returns input untouched when already a stub', () => {
        const stub: ChatStub = { id: 'c1', name: 't', _stub: true }
        expect(chatToStub(stub)).toBe(stub)
    })
})

describe('stubToPlaceholder', () => {
    test('preserves explicit null folderId from server', () => {
        const stub: ChatStub = {
            id: 'c1',
            name: 't',
            _stub: true,
            folderId: null as any,
        }
        const placeholder = stubToPlaceholder(stub)
        expect('folderId' in placeholder).toBe(true)
        expect(placeholder.folderId).toBeNull()
    })

    test('omits folderId when stub has no such key', () => {
        const stub: ChatStub = { id: 'c1', name: 't', _stub: true }
        const placeholder = stubToPlaceholder(stub)
        expect('folderId' in placeholder).toBe(false)
    })

    test('marks placeholder for hydration', () => {
        const stub: ChatStub = { id: 'c1', name: 't', _stub: true }
        const placeholder = stubToPlaceholder(stub)
        expect(placeholder._placeholder).toBe(true)
        expect(placeholder.fmIndex).toBe(-1)
        expect(placeholder.message).toEqual([])
    })

    test('preserves modules key (null and array)', () => {
        const nullStub: ChatStub = { id: 'c1', name: 't', _stub: true, modules: null as any }
        expect('modules' in stubToPlaceholder(nullStub)).toBe(true)
        expect(stubToPlaceholder(nullStub).modules).toBeNull()

        const arrStub: ChatStub = { id: 'c1', name: 't', _stub: true, modules: ['m1'] }
        expect(stubToPlaceholder(arrStub).modules).toEqual(['m1'])
    })
})

// The bug this branch fixes: a user clearing folderId would round-trip into
// a "remove" patch op once the placeholder dropped the null key. With key
// presence preserved end-to-end, the explicit null survives placeholder →
// stub conversion and reaches the server merge layer as a real value.
describe('chat → stub → placeholder → stub round-trip', () => {
    test('null folderId survives the full round-trip', () => {
        const original = blankChat({ folderId: null as any })
        const stub1 = chatToStub(original)
        const placeholder = stubToPlaceholder({ ...stub1, _stub: true })
        const stub2 = chatToStub(placeholder)
        expect('folderId' in stub2).toBe(true)
        expect(stub2.folderId).toBeNull()
    })

    test('null modules survives the full round-trip', () => {
        const original = blankChat({ modules: null as any })
        const stub1 = chatToStub(original)
        const placeholder = stubToPlaceholder({ ...stub1, _stub: true })
        const stub2 = chatToStub(placeholder)
        expect('modules' in stub2).toBe(true)
        expect(stub2.modules).toBeNull()
    })

    test('absent folderId stays absent through the round-trip', () => {
        const original = blankChat()
        const stub1 = chatToStub(original)
        const placeholder = stubToPlaceholder({ ...stub1, _stub: true })
        const stub2 = chatToStub(placeholder)
        expect('folderId' in stub2).toBe(false)
    })

    test('non-null folderId survives the round-trip unchanged', () => {
        const original = blankChat({ folderId: 'F1' })
        const stub1 = chatToStub(original)
        const placeholder = stubToPlaceholder({ ...stub1, _stub: true })
        const stub2 = chatToStub(placeholder)
        expect(stub2.folderId).toBe('F1')
    })
})

// Hybrid corruption: a chat with `_stub: true` AND a real message array.
// Came from v1.4.x disk corruption. The lazy-loading invariants assume
// `_stub: true` means "metadata only", so the hybrid leaks Chat fields into
// patcher diffs and trips the chat-data guard. The fix self-heals by
// excluding hybrids from isChatStub (so chatToStub strips them properly)
// and by stripping the corrupt _stub flag in convertStubsToPlaceholders
// (preserving the real message data instead of resetting to placeholder).
describe('hybrid corruption (chat with _stub:true + message)', () => {
    const hybridChat = (overrides: any = {}): any => ({
        message: [{ role: 'user', data: 'hello' }],
        note: 'old note',
        name: 'h',
        localLore: [{ key: 'k' }],
        id: 'c-hybrid',
        _stub: true,
        ...overrides,
    })

    test('classifyChat tags _stub + message as "hybrid"', () => {
        expect(classifyChat(hybridChat())).toBe('hybrid')
    })

    test('chatToStub collapses hybrid down to a real stub (drops message)', () => {
        const result = chatToStub(hybridChat()) as any
        expect(result._stub).toBe(true)
        expect('message' in result).toBe(false)
        expect('note' in result).toBe(false)
        expect('localLore' in result).toBe(false)
        expect(result.id).toBe('c-hybrid')
        expect(result.name).toBe('h')
    })

    test('convertStubsToPlaceholders keeps hybrid as a Chat with message preserved', () => {
        const [recovered] = convertStubsToPlaceholders([hybridChat()])
        // _stub flag must be gone — leaving it would re-enter the hybrid loop.
        expect((recovered as any)._stub).toBeUndefined()
        // Original message must survive — converting to a placeholder would
        // reset it to [], which IS the data-loss bug we're guarding against.
        expect(Array.isArray(recovered.message)).toBe(true)
        expect(recovered.message.length).toBe(1)
        expect(recovered.message[0].data).toBe('hello')
        expect(recovered.note).toBe('old note')
        expect(recovered.localLore.length).toBe(1)
    })

    test('convertStubsToPlaceholders still converts real stubs to placeholders', () => {
        const realStub: ChatStub = { id: 'c1', name: 't', _stub: true }
        const [result] = convertStubsToPlaceholders([realStub])
        expect((result as any)._placeholder).toBe(true)
        expect(result.message).toEqual([])
        expect(result.fmIndex).toBe(-1)
    })

    test('convertStubsToPlaceholders leaves real Chats alone', () => {
        const realChat: Chat = {
            message: [], note: '', name: 'x', localLore: [], id: 'c2',
        }
        const [result] = convertStubsToPlaceholders([realChat])
        expect(result).toBe(realChat)   // same reference, untouched
    })

    test('hybrid round-trip self-heals: convert → chatToStub → no message leakage', () => {
        // Simulate the actual v1.4.x bug path:
        //   disk → decoded chat is hybrid → convertStubsToPlaceholders → patcher diff
        const [recovered] = convertStubsToPlaceholders([hybridChat()])
        const stub = chatToStub(recovered) as any
        expect(stub._stub).toBe(true)
        expect('message' in stub).toBe(false)
        expect('note' in stub).toBe(false)
        // Once stripped, the chat-data guard would see no chat-internal field
        // ops in a baseline-vs-current diff between two of these stubs.
    })
})
