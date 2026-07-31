import { describe, expect, test } from 'vitest'
import type { Chat, character } from './database.svelte'
import { collectDirtySaveTargets, collectImportedChatDirtyTargets } from './dirtyTargetDiff'

function chat(id: string, overrides: Partial<Chat> = {}): Chat {
    return {
        id,
        name: id,
        note: '',
        localLore: [],
        message: [{ role: 'user', data: id }],
        ...overrides,
    }
}

function placeholder(id: string, overrides: Partial<Chat> = {}): Chat {
    return chat(id, {
        message: [],
        _placeholder: true,
        ...overrides,
    })
}

function characterWith(id: string, chats: Chat[], overrides: Partial<character> = {}): character {
    return {
        chaId: id,
        name: id,
        chats,
        ...overrides,
    } as character
}

describe('target-aware dirty diff', () => {
    test('separates character metadata from an existing full chat body change', () => {
        const before = [characterWith('char-a', [chat('chat-a')])]
        const afterCharacter = structuredClone(before)
        afterCharacter[0].name = 'renamed'

        expect(collectDirtySaveTargets(before, afterCharacter)).toEqual({
            characters: ['char-a'],
            chats: [],
        })

        const afterChat = structuredClone(before)
        afterChat[0].chats[0].message.push({ role: 'char', data: 'changed' })
        expect(collectDirtySaveTargets(before, afterChat)).toEqual({
            characters: [],
            chats: [['char-a', 'chat-a']],
        })
    })

    test.each(['name', 'lastDate', 'folderId', 'modules'] as const)(
        'marks the character block when chat stub field %s changes',
        field => {
            const before = [characterWith('char-a', [chat('chat-a')])]
            const after = structuredClone(before)
            const values = {
                name: 'renamed',
                lastDate: 123,
                folderId: 'folder-b',
                modules: ['module-b'],
            }
            Object.assign(after[0].chats[0], { [field]: values[field] })

            expect(collectDirtySaveTargets(before, after)).toEqual({
                characters: ['char-a'],
                chats: [['char-a', 'chat-a']],
            })
        },
    )

    test('marks removed and added identities and writes only the new full chat row', () => {
        const before = [characterWith('char-old', [chat('chat-old')])]
        const after = [characterWith('char-new', [chat('chat-new')])]

        expect(collectDirtySaveTargets(before, after)).toEqual({
            characters: ['char-old', 'char-new'],
            chats: [['char-new', 'chat-new']],
        })
    })

    test('wakes character persistence for reorder and duplicate structural changes', () => {
        const charA = characterWith('char-a', [])
        const charB = characterWith('char-b', [])

        expect(collectDirtySaveTargets([charA, charB], [charB, charA]).characters).toEqual([
            'char-a',
            'char-b',
        ])
        expect(collectDirtySaveTargets([charA], [charA, structuredClone(charA)]).characters).toEqual([
            'char-a',
        ])
    })

    test('never treats an unchanged or newly installed placeholder as row data', () => {
        const before = [characterWith('char-a', [placeholder('chat-a')])]
        const metadataChange = [characterWith('char-a', [placeholder('chat-a', { modules: ['m'] })])]

        expect(collectDirtySaveTargets(before, metadataChange)).toEqual({
            characters: ['char-a'],
            chats: [],
        })
        expect(collectDirtySaveTargets([], [characterWith('char-a', [placeholder('chat-a')])])).toEqual({
            characters: ['char-a'],
            chats: [],
        })
    })

    test('queues a row when a placeholder is replaced by authoritative full data', () => {
        const before = [characterWith('char-a', [placeholder('chat-a')])]
        const after = [characterWith('char-a', [chat('chat-a')])]

        expect(collectDirtySaveTargets(before, after)).toEqual({
            characters: [],
            chats: [['char-a', 'chat-a']],
        })
    })

    test('publishes only full character-package chats while retaining character intent', () => {
        expect(collectImportedChatDirtyTargets('char-a', [
            chat('chat-full'),
            placeholder('chat-placeholder'),
        ])).toEqual({
            characters: ['char-a'],
            chats: [['char-a', 'chat-full']],
        })
        expect(collectImportedChatDirtyTargets('char-a', [])).toEqual({
            characters: ['char-a'],
            chats: [],
        })
        expect(collectImportedChatDirtyTargets('char-a', null)).toEqual({
            characters: [],
            chats: [],
        })
    })
})
