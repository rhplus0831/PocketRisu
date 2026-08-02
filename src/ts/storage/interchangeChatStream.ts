import type { Chat, CharacterInterchangeSnapshot } from './database.svelte'
import { getCharacterChatSnapshot } from './database.svelte'
import { fetchChatFromServer } from './chatStorage'

export const INTERCHANGE_CHAT_LOOKAHEAD = 2

export class MissingInterchangeChatError extends Error {
    constructor(
        readonly characterName: string,
        readonly chatName: string,
    ) {
        super(`Chat data missing for "${characterName}" / "${chatName}".`)
        this.name = 'MissingInterchangeChatError'
    }
}

async function loadChat(
    characterIndex: number,
    snapshot: CharacterInterchangeSnapshot,
    refIndex: number,
): Promise<Chat> {
    const ref = snapshot.chats[refIndex]
    const local = getCharacterChatSnapshot(characterIndex, ref)
    if (local && (!local._placeholder || !local.id)) return local

    const chatId = local?.id ?? ref.id
    if (chatId) {
        const full = await fetchChatFromServer(
            snapshot.character.chaId,
            ref.index,
            chatId,
        )
        if (full) return full
    }

    throw new MissingInterchangeChatError(
        snapshot.character.name ?? '',
        local?.name ?? ref.name ?? '',
    )
}

/**
 * Resolve chats in stable source order with a two-row lookahead. Resolved rows
 * leave the pending map as soon as they are yielded, so callers retain only
 * the current row plus the bounded fetch window.
 */
export async function* streamCharacterChats(
    characterIndex: number,
    snapshot: CharacterInterchangeSnapshot,
    lookahead = INTERCHANGE_CHAT_LOOKAHEAD,
): AsyncGenerator<Chat> {
    const concurrency = Math.max(1, Math.floor(lookahead))
    const pending = new Map<number, Promise<Chat>>()
    let nextToStart = 0

    const fill = () => {
        while (nextToStart < snapshot.chats.length && pending.size < concurrency) {
            const index = nextToStart++
            const promise = loadChat(characterIndex, snapshot, index)
            // Observe immediately so a later lookahead failure cannot become an
            // unhandled rejection while an earlier row is still in source order.
            void promise.catch(() => {})
            pending.set(index, promise)
        }
    }

    fill()
    try {
        for (let index = 0; index < snapshot.chats.length; index++) {
            const chat = await pending.get(index)!
            pending.delete(index)
            fill()
            yield chat
        }
    } finally {
        // A missing/failed earlier row can leave lookahead reads unsettled.
        // Observe their failures without retaining or replaying their payloads.
        for (const promise of pending.values()) void promise.catch(() => {})
        pending.clear()
    }
}
