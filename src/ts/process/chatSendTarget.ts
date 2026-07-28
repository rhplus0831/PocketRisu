import type { Chat, Database, Message, character } from '../storage/database.svelte'

export interface ChatSendTarget {
    chaId: string
    chatId: string
}

export interface ResolvedChatSendTarget {
    character: character
    chat: Chat
    characterIndex: number
    chatIndex: number
}

export interface ChatRerollSettlement {
    originalMessages: Message[]
    trailingMessages: Message[]
    savedSwipes: string[]
}

type ChatTargetDatabase = Pick<Database, 'characters' | 'useSayNothing'>

interface InputTriggerResult {
    chat?: {
        message?: Message[]
    }
}

export function captureChatSendTarget(
    db: Pick<Database, 'characters'>,
    selectedCharacterIndex: number,
): ChatSendTarget | null {
    const character = db.characters?.[selectedCharacterIndex]
    const chat = character?.chats?.[character.chatPage]
    if (!character?.chaId || !chat?.id) return null
    return { chaId: character.chaId, chatId: chat.id }
}

export function resolveChatSendTarget(
    db: Pick<Database, 'characters'>,
    target: ChatSendTarget,
): ResolvedChatSendTarget | null {
    const characterIndex = db.characters?.findIndex(character => character?.chaId === target.chaId) ?? -1
    if (characterIndex < 0) return null

    const character = db.characters[characterIndex]
    const chatIndex = character.chats?.findIndex(chat => chat?.id === target.chatId) ?? -1
    if (chatIndex < 0) return null

    const chat = character.chats[chatIndex]
    if (!chat) return null
    return { character, chat, characterIndex, chatIndex }
}

export function isChatSendTargetActive(
    db: Pick<Database, 'characters'>,
    selectedCharacterIndex: number,
    target: ChatSendTarget,
): boolean {
    const character = db.characters?.[selectedCharacterIndex]
    const chat = character?.chats?.[character.chatPage]
    return character?.chaId === target.chaId && chat?.id === target.chatId
}

export function findLastCharacterMessage(messages: Message[]): Message | null {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index]
        if (message.role === 'char' && !message.isComment && !message.disabled) return message
    }
    return null
}

/**
 * Apply reroll completion to the chat that initiated the operation. The live
 * character/chat selection may have changed while generation was awaiting the
 * model, so every post-await mutation resolves the durable target again.
 */
export function settleChatRerollToTarget(
    db: Pick<Database, 'characters'>,
    target: ChatSendTarget,
    generated: boolean,
    settlement: ChatRerollSettlement,
): ResolvedChatSendTarget | null {
    const resolvedTarget = resolveChatSendTarget(db, target)
    if (!resolvedTarget || resolvedTarget.chat._placeholder) return null

    if (!generated) {
        resolvedTarget.chat.message = settlement.originalMessages
        return resolvedTarget
    }

    if (settlement.trailingMessages.length > 0) {
        resolvedTarget.chat.message.push(...settlement.trailingMessages)
    }

    const newLastMessage = findLastCharacterMessage(resolvedTarget.chat.message)
    if (newLastMessage && !newLastMessage.swipes) {
        newLastMessage.swipes = [...settlement.savedSwipes, newLastMessage.data]
        newLastMessage.swipeId = newLastMessage.swipes.length - 1
    }

    return resolvedTarget
}

/**
 * Run the asynchronous input hooks and publish their result back to the chat
 * identified at send start. The final lookup by durable IDs is intentional:
 * chatPage and character indexes may have changed while a hook was awaiting.
 */
export async function applyChatInputToTarget(options: {
    getDatabase: () => ChatTargetDatabase
    target: ChatSendTarget
    input: string
    signal?: AbortSignal
    now?: () => number
    runInputTrigger: (character: character, chat: Chat) => Promise<InputTriggerResult | null | undefined>
    processInput: (character: character, input: string) => Promise<string>
}): Promise<ResolvedChatSendTarget | null> {
    const initialTarget = resolveChatSendTarget(options.getDatabase(), options.target)
    if (!initialTarget || initialTarget.chat._placeholder) return null

    let triggeredMessages: Message[] | null = null
    let nextMessage: Message | null = null

    if (options.input === '') {
        const messages = initialTarget.chat.message
        if ((messages.length === 0 || messages[messages.length - 1].role !== 'user')
            && options.getDatabase().useSayNothing) {
            nextMessage = {
                role: 'user',
                data: '*says nothing*',
                name: null,
            }
        }
    } else if (initialTarget.character.type === 'character') {
        const triggerResult = await options.runInputTrigger(initialTarget.character, initialTarget.chat)
        if (options.signal?.aborted) return null
        if (Array.isArray(triggerResult?.chat?.message)) {
            triggeredMessages = triggerResult.chat.message
        }

        const processedInput = await options.processInput(initialTarget.character, options.input)
        if (options.signal?.aborted) return null
        nextMessage = {
            role: 'user',
            data: processedInput,
            time: (options.now ?? Date.now)(),
            name: null,
        }
    } else {
        nextMessage = {
            role: 'user',
            data: options.input,
            time: (options.now ?? Date.now)(),
            name: null,
        }
    }

    const finalTarget = resolveChatSendTarget(options.getDatabase(), options.target)
    if (!finalTarget || finalTarget.chat._placeholder || options.signal?.aborted) return null

    const messages = triggeredMessages ?? finalTarget.chat.message
    if (nextMessage) messages.push(nextMessage)
    finalTarget.chat.message = messages
    return finalTarget
}
