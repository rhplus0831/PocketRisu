import type { Chat, Database, Message, character } from '../storage/database.svelte'
import isEqual from 'lodash/isEqual'
import { safeStructuredClone } from '../polyfill'

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

export interface ChatExecutionTarget extends ChatSendTarget {
    chat: Chat
}

export interface ChatPublicationGuard {
    sourceChat: Chat
    sourceSnapshot: Chat
}

export interface ChatRerollSettlement {
    originalMessages: Message[]
    trailingMessages: Message[]
    savedSwipes: string[]
}

type ChatTargetDatabase = Pick<Database, 'characters' | 'useSayNothing'>

interface InputTriggerResult {
    chat?: Chat
    destructiveChatMutation?: boolean
    chatPublicationGuard?: ChatPublicationGuard
}

interface TriggerChatPublicationResult {
    chat?: Chat
    destructiveChatMutation?: boolean
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

export function resolveChatExecutionTarget(
    db: Pick<Database, 'characters'>,
    target: ChatSendTarget,
): ChatExecutionTarget | null {
    const resolvedTarget = resolveChatSendTarget(db, target)
    if (!resolvedTarget || resolvedTarget.chat._placeholder) return null
    return { ...target, chat: resolvedTarget.chat }
}

export function captureChatPublicationGuard(chat: Chat): ChatPublicationGuard {
    return {
        sourceChat: chat,
        sourceSnapshot: safeStructuredClone(chat),
    }
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

/**
 * Publish a trigger-produced chat to the durable target captured before the
 * trigger awaited. Selection changes are irrelevant. With a publication
 * guard, a removed/replaced target or any in-place source change is treated as
 * stale and receives no publication or backup marker.
 */
export function publishTriggerChatToTarget(
    db: Pick<Database, 'characters'>,
    target: ChatSendTarget,
    result: TriggerChatPublicationResult | null | undefined,
    onDestructiveChatMutation?: (target: ChatSendTarget) => void,
    guard?: ChatPublicationGuard,
): ResolvedChatSendTarget | null {
    if (!result?.chat || result.chat.id !== target.chatId) return null

    const resolvedTarget = resolveChatSendTarget(db, target)
    if (!resolvedTarget || resolvedTarget.chat._placeholder) return null
    if (guard && (
        resolvedTarget.chat !== guard.sourceChat
        || !isEqual(resolvedTarget.chat, guard.sourceSnapshot)
    )) return null

    if (result.destructiveChatMutation === true) {
        onDestructiveChatMutation?.(target)
    }
    resolvedTarget.character.chats[resolvedTarget.chatIndex] = result.chat

    return { ...resolvedTarget, chat: result.chat }
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
    runInputTrigger: (
        character: character,
        chat: Chat,
        guard: ChatPublicationGuard,
    ) => Promise<InputTriggerResult | null | undefined>
    onDestructiveChatMutation?: (target: ChatSendTarget) => void
    processInput: (
        character: character,
        input: string,
        target: ResolvedChatSendTarget,
    ) => Promise<string>
}): Promise<ResolvedChatSendTarget | null> {
    const initialTarget = resolveChatSendTarget(options.getDatabase(), options.target)
    if (!initialTarget || initialTarget.chat._placeholder) return null

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
        const triggerPublicationGuard = captureChatPublicationGuard(initialTarget.chat)
        const triggerResult = await options.runInputTrigger(
            initialTarget.character,
            initialTarget.chat,
            triggerPublicationGuard,
        )
        if (options.signal?.aborted) return null
        if (Array.isArray(triggerResult?.chat?.message)) {
            // Input triggers run before editinput handlers. Publish their
            // cloned chat result to the durable target before a handler can
            // start a child turn, so that turn builds on the trigger result
            // and cannot later be overwritten by the outer send.
            const triggeredTarget = publishTriggerChatToTarget(
                options.getDatabase(),
                options.target,
                triggerResult,
                options.onDestructiveChatMutation,
                triggerResult.chatPublicationGuard ?? triggerPublicationGuard,
            )
            if (!triggeredTarget) return null
        }

        const processingTarget = resolveChatSendTarget(options.getDatabase(), options.target)
        if (!processingTarget || processingTarget.chat._placeholder) return null
        const processedInput = await options.processInput(
            processingTarget.character,
            options.input,
            processingTarget,
        )
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

    if (nextMessage) finalTarget.chat.message.push(nextMessage)
    return finalTarget
}
