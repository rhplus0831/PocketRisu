import { describe, expect, it } from 'vitest'
import policy from '../../shared/character-defaults-policy.json'
import {
    BOT_PRESET_ID_ASSIGNMENT as CLIENT_BOT_PRESET_ID_ASSIGNMENT,
    CHARACTER_DEFAULTS as CLIENT_CHARACTER_DEFAULTS,
    CHARACTER_ID_ASSIGNMENT as CLIENT_CHARACTER_ID_ASSIGNMENT,
    CHARACTER_TYPE_DEFAULTS as CLIENT_CHARACTER_TYPE_DEFAULTS,
    PERSONA_ID_ASSIGNMENT as CLIENT_PERSONA_ID_ASSIGNMENT,
    assignBotPresetId,
    assignCharacterId,
    assignPersonaId,
    fillCharacterDefaults as fillClientCharacterDefaults,
} from '../../src/ts/storage/characterDefaults'
import serverDefaultsPkg from './characterDefaults.cjs'

const {
    BOT_PRESET_ID_ASSIGNMENT: SERVER_BOT_PRESET_ID_ASSIGNMENT,
    CHARACTER_DEFAULTS: SERVER_CHARACTER_DEFAULTS,
    CHARACTER_ID_ASSIGNMENT: SERVER_CHARACTER_ID_ASSIGNMENT,
    CHARACTER_TYPE_DEFAULTS: SERVER_CHARACTER_TYPE_DEFAULTS,
    PERSONA_ID_ASSIGNMENT: SERVER_PERSONA_ID_ASSIGNMENT,
    applyDatabaseCharacterDefaults,
    fillCharacterDefaults: fillServerCharacterDefaults,
} = serverDefaultsPkg as any

describe('shared character defaults contract', () => {
    it('keeps the client and server fill sets pinned to the shared values', () => {
        expect(CLIENT_CHARACTER_DEFAULTS).toEqual(policy.characterDefaults)
        expect(SERVER_CHARACTER_DEFAULTS).toEqual(policy.characterDefaults)
        expect(CLIENT_CHARACTER_TYPE_DEFAULTS).toEqual(policy.characterTypeDefaults)
        expect(SERVER_CHARACTER_TYPE_DEFAULTS).toEqual(policy.characterTypeDefaults)

        const clientCharacter: Record<string, unknown> = {}
        const serverCharacter: Record<string, unknown> = {}
        fillClientCharacterDefaults(clientCharacter)
        fillServerCharacterDefaults(serverCharacter)

        const expected = {
            ...policy.characterDefaults,
            ...policy.characterTypeDefaults,
        }
        expect(clientCharacter).toEqual(expected)
        expect(serverCharacter).toEqual(expected)
        expect(Object.keys(clientCharacter)).toEqual(Object.keys(expected))
        expect(Object.keys(serverCharacter)).toEqual(Object.keys(expected))
    })

    it('uses fresh array defaults and limits character-only fields to character records', () => {
        const first: Record<string, any> = {}
        const second: Record<string, any> = { type: 'group' }
        fillServerCharacterDefaults(first)
        fillServerCharacterDefaults(second)

        expect(first.chats).not.toBe(policy.characterDefaults.chats)
        expect(first.chats).not.toBe(second.chats)
        expect(second).not.toHaveProperty('bias')
        expect(second).not.toHaveProperty('scenario')
    })

    it('keeps character and preset IDs falsy-assigned and persona IDs nullish-assigned', () => {
        expect(CLIENT_CHARACTER_ID_ASSIGNMENT).toEqual(policy.idAssignments.character)
        expect(SERVER_CHARACTER_ID_ASSIGNMENT).toEqual(policy.idAssignments.character)
        expect(CLIENT_PERSONA_ID_ASSIGNMENT).toEqual(policy.idAssignments.persona)
        expect(SERVER_PERSONA_ID_ASSIGNMENT).toEqual(policy.idAssignments.persona)
        expect(CLIENT_BOT_PRESET_ID_ASSIGNMENT).toEqual(policy.idAssignments.botPreset)
        expect(SERVER_BOT_PRESET_ID_ASSIGNMENT).toEqual(policy.idAssignments.botPreset)

        const client = {
            character: { chaId: '' },
            personaEmpty: { id: '' },
            personaNull: { id: null },
            preset: { id: '' },
        }
        let clientId = 0
        const makeClientId = () => `client-${++clientId}`
        assignCharacterId(client.character, makeClientId)
        assignPersonaId(client.personaEmpty, makeClientId)
        assignPersonaId(client.personaNull, makeClientId)
        assignBotPresetId(client.preset, makeClientId)
        expect(client).toMatchObject({
            character: { chaId: 'client-1' },
            personaEmpty: { id: '' },
            personaNull: { id: 'client-2' },
            preset: { id: 'client-3' },
        })

        let serverId = 0
        const server = {
            characters: [{ chaId: '' }],
            personas: [{ id: '' }, { id: null }],
            botPresets: [{ id: '' }],
        }
        applyDatabaseCharacterDefaults(server, () => `server-${++serverId}`)
        expect(server).toMatchObject({
            characters: [{ chaId: 'server-1' }],
            personas: [{ id: '' }, { id: 'server-2' }],
            botPresets: [{ id: 'server-3' }],
        })
    })
})
