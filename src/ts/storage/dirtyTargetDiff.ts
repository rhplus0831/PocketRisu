import isEqual from 'lodash/isEqual'
import type { Chat, Database, character } from './database.svelte'

export interface DirtySaveTargets {
    characters: string[]
    chats: [chaId: string, chatId: string][]
}

type CharacterLike = Partial<character> & Pick<character, 'chats'>

const CHAT_STUB_FIELDS = ['id', 'name', 'lastDate', 'folderId', 'modules'] as const

function durableCharacterId(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined
}

function durableChatId(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isFullAuthoritativeChat(chat: unknown): chat is Chat & { id: string } {
    if (!chat || typeof chat !== 'object') return false
    const candidate = chat as Partial<Chat>
    return candidate._placeholder !== true
        && Array.isArray(candidate.message)
        && durableChatId(candidate.id) !== undefined
}

function chatStubProjection(chat: unknown): Record<string, unknown> {
    if (!chat || typeof chat !== 'object') return { invalid: chat }
    const projection: Record<string, unknown> = {}
    for (const field of CHAT_STUB_FIELDS) {
        if (field in chat) projection[field] = (chat as Record<string, unknown>)[field]
    }
    return projection
}

function chatsOf(char: Pick<CharacterLike, 'chats'> | undefined): Chat[] {
    return Array.isArray(char?.chats) ? char.chats : []
}

function characterBodyProjection(char: CharacterLike): Omit<CharacterLike, 'chats'> {
    const { chats: _chats, ...body } = char
    return body
}

function characterStubProjection(char: CharacterLike): Record<string, unknown>[] {
    return chatsOf(char).map(chatStubProjection)
}

function characterMap(characters: character[]): Map<string, character> {
    const result = new Map<string, character>()
    for (const char of characters) {
        const chaId = durableCharacterId(char?.chaId)
        if (chaId) result.set(chaId, char)
    }
    return result
}

/**
 * Determine the exact character blocks and authoritative chat rows affected by
 * a character-array replacement. Runtime placeholders are deliberately never
 * classified as row data: their empty bodies only stand in for an existing
 * server row and must not become authoritative.
 */
export function collectDirtySaveTargets(
    beforeCharacters: Database['characters'] | null | undefined,
    afterCharacters: Database['characters'] | null | undefined,
): DirtySaveTargets {
    const before = Array.isArray(beforeCharacters) ? beforeCharacters : []
    const after = Array.isArray(afterCharacters) ? afterCharacters : []
    const beforeById = characterMap(before)
    const afterById = characterMap(after)
    const dirtyCharacters = new Set<string>()
    const dirtyChats = new Map<string, [string, string]>()

    const beforeIdOrder = before.map(char => durableCharacterId(char?.chaId) ?? null)
    const afterIdOrder = after.map(char => durableCharacterId(char?.chaId) ?? null)
    if (!isEqual(beforeIdOrder, afterIdOrder)) {
        for (const chaId of [...beforeIdOrder, ...afterIdOrder]) {
            if (chaId) dirtyCharacters.add(chaId)
        }
    }

    for (const [chaId, previous] of beforeById) {
        const current = afterById.get(chaId)
        if (!current) {
            dirtyCharacters.add(chaId)
            continue
        }
        if (
            !isEqual(characterBodyProjection(previous), characterBodyProjection(current))
            || !isEqual(characterStubProjection(previous), characterStubProjection(current))
        ) {
            dirtyCharacters.add(chaId)
        }
    }

    for (const [chaId, current] of afterById) {
        const previous = beforeById.get(chaId)
        if (!previous) dirtyCharacters.add(chaId)

        const previousChats = new Map<string, Chat>()
        for (const chat of chatsOf(previous)) {
            const chatId = durableChatId(chat?.id)
            if (chatId) previousChats.set(chatId, chat)
        }

        for (const chat of chatsOf(current)) {
            if (!isFullAuthoritativeChat(chat)) continue
            const chatId = chat.id
            const previousChat = previousChats.get(chatId)
            if (!previousChat || !isEqual(previousChat, chat)) {
                dirtyChats.set(`${chaId}\0${chatId}`, [chaId, chatId])
            }
        }
    }

    return {
        characters: [...dirtyCharacters],
        chats: [...dirtyChats.values()],
    }
}

/** Return dirty intent for a validated character-package chat publication. */
export function collectImportedChatDirtyTargets(
    chaId: string,
    importedChats: Chat[] | null,
): DirtySaveTargets {
    if (!chaId || importedChats === null) return { characters: [], chats: [] }
    return {
        characters: [chaId],
        chats: importedChats
            .filter(isFullAuthoritativeChat)
            .map((chat): [string, string] => [chaId, chat.id]),
    }
}
