import { beforeEach, describe, expect, test } from 'vitest'
import { selectedCharID } from '../stores.svelte'
import {
    getCharacterByIndex,
    getCharacterChatSnapshot,
    getCharacterInterchangeSnapshot,
    getCharacterSnapshot,
    getCurrentCharacter,
    getDatabase,
    getDatabaseFieldsSnapshot,
    setDatabaseLite,
} from './database.svelte'

function installDatabase() {
    let unrelatedReads = 0
    const database = {
        characters: [{
            chaId: 'character-a',
            name: 'Character A',
            chats: [],
            chatPage: 0,
            nested: { value: 'live' },
        }],
        modules: [],
        enabledModules: [],
        moduleIntergration: '',
        language: 'en',
        statics: { messages: 3, imports: 1 },
        dynamicOutput: {
            autoAdjustSchema: true,
            dynamicMessages: false,
        },
    } as Record<string, unknown>
    Object.defineProperty(database, 'pluginCustomStorage', {
        configurable: true,
        enumerable: true,
        get() {
            unrelatedReads++
            return { huge: 'unrelated plugin value' }
        },
    })
    setDatabaseLite(database as any)
    unrelatedReads = 0
    return { getUnrelatedReads: () => unrelatedReads }
}

describe('narrow database snapshots', () => {
    beforeEach(() => {
        selectedCharID.set(0)
    })

    test('snapshots only the selected character and keeps it detached', () => {
        const reads = installDatabase()

        const snapshot = getCurrentCharacter({ snapshot: true }) as any
        const live = getCharacterByIndex(0) as any

        expect(reads.getUnrelatedReads()).toBe(0)
        expect(snapshot).toEqual(live)
        expect(snapshot).not.toBe(live)
        expect(snapshot.nested).not.toBe(live.nested)

        snapshot.nested.value = 'snapshot mutation'
        expect(live.nested.value).toBe('live')
        live.name = 'Live mutation'
        expect(snapshot.name).toBe('Character A')
    })

    test('snapshots only requested root fields', () => {
        const reads = installDatabase()

        const snapshot = getDatabaseFieldsSnapshot([
            'language',
            'statics',
            'dynamicOutput',
        ] as const)

        expect(reads.getUnrelatedReads()).toBe(0)
        expect(Object.keys(snapshot)).toEqual(['language', 'statics', 'dynamicOutput'])
        expect(snapshot.statics).not.toBe(getDatabase().statics)
        expect(snapshot.dynamicOutput).not.toBe(getDatabase().dynamicOutput)

        snapshot.statics.messages = 99
        expect(getDatabase().statics.messages).toBe(3)
    })

    test('returns undefined for a missing character snapshot', () => {
        installDatabase()
        expect(getCharacterSnapshot(99)).toBeUndefined()
        selectedCharID.set(99)
        expect(getCurrentCharacter({ snapshot: true })).toBeUndefined()
    })

    test('interchange metadata does not traverse chat bodies and rows snapshot individually', () => {
        installDatabase()
        let messageReads = 0
        const chat = {
            id: 'chat-a',
            name: 'Chat A',
            note: '',
            localLore: [],
            fmIndex: -1,
            get message() {
                messageReads++
                return [{ role: 'user', data: 'large row' }]
            },
        }
        ;(getCharacterByIndex(0) as any).chats = [chat]

        const snapshot = getCharacterInterchangeSnapshot(0)!
        expect(messageReads).toBe(0)
        expect(snapshot.character.chats).toEqual([])
        expect(snapshot.chats).toEqual([{ index: 0, id: 'chat-a', name: 'Chat A' }])

        const row = getCharacterChatSnapshot(0, snapshot.chats[0])!
        expect(messageReads).toBe(1)
        expect(row.message).toEqual([{ role: 'user', data: 'large row' }])
        expect(row).not.toBe(chat)
    })
})
