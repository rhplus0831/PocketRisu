import type { Chat, Database } from './database.svelte'
import type { toSaveType } from './risuSave'

export type ChatPersistId = [chaId: string, chatId: string]
export type ChatCheckpointTracker = Map<string, number>

// The server throttles chat pre-image backups to 45s per chat, so 20s client
// checkpoints improve crash durability without creating a backup per fragment.
export const CHECKPOINT_INTERVAL_MS = 20_000

export function chatPersistKey(chaId: string, chatId: string): string {
    return `${chaId}|${chatId}`
}

export function collectChatsToPersist(
    db: Database,
    toSave: toSaveType,
    knownChatIdsByCharacter: Map<string, Set<string>>,
): ChatPersistId[] {
    const chatsToPersist: ChatPersistId[] = []
    const seen = new Set<string>()
    const pushChat = (chaId: string, chatId: string) => {
        if (!chaId || !chatId) return
        const key = chatPersistKey(chaId, chatId)
        if (seen.has(key)) return
        seen.add(key)
        chatsToPersist.push([chaId, chatId])
    }

    for (const [chaId, chatId] of toSave.chat) {
        pushChat(chaId, chatId)
    }

    for (const chaId of toSave.character) {
        const char = db.characters.find(character => character?.chaId === chaId)
        if (!char) continue
        const knownChatIds = knownChatIdsByCharacter.get(chaId) ?? new Set<string>()
        for (const chat of char.chats ?? []) {
            if (!chat?.id || chat._placeholder) continue
            if (!knownChatIds.has(chat.id)) {
                pushChat(chaId, chat.id)
            }
        }
    }

    return chatsToPersist
}

/**
 * Update the discovery baseline only after database.bin has committed.
 *
 * A chat can enter the known set only if it was already known (and still
 * exists) or the row stage supplied explicit durability proof for it. This
 * keeps a newly committed stub from becoming a permanent phantom row.
 */
export function updateKnownChatsAfterSuccessfulSave(
    db: Database,
    toSave: toSaveType,
    knownChatIdsByCharacter: Map<string, Set<string>>,
    durableChats: ChatPersistId[],
): void {
    const durableKeys = new Set(
        durableChats.map(([chaId, chatId]) => chatPersistKey(chaId, chatId))
    )

    for (const chaId of toSave.character) {
        const char = db.characters.find(character => character?.chaId === chaId)
        if (!char) {
            knownChatIdsByCharacter.delete(chaId)
            continue
        }

        const currentChatIds = new Set(
            (char.chats ?? []).map(chat => chat?.id).filter((id): id is string => !!id)
        )
        const previouslyKnown = knownChatIdsByCharacter.get(chaId) ?? new Set<string>()
        const nextKnown = new Set(
            [...previouslyKnown].filter(chatId => currentChatIds.has(chatId))
        )

        for (const chatId of currentChatIds) {
            if (durableKeys.has(chatPersistKey(chaId, chatId))) {
                nextKnown.add(chatId)
            }
        }
        knownChatIdsByCharacter.set(chaId, nextKnown)
    }

    for (const [chaId, chatId] of durableChats) {
        const char = db.characters.find(character => character?.chaId === chaId)
        if (!char?.chats?.some(chat => chat?.id === chatId)) continue
        const knownChatIds = knownChatIdsByCharacter.get(chaId) ?? new Set<string>()
        knownChatIds.add(chatId)
        knownChatIdsByCharacter.set(chaId, knownChatIds)
    }
}

export class ChatRowPersistError extends Error {
    constructor(public readonly failedChats: ChatPersistId[]) {
        super(`Failed to save ${failedChats.length} chat${failedChats.length === 1 ? '' : 's'}`)
        this.name = 'ChatRowPersistError'
    }
}

export interface StubCommitResult<T> {
    committed: boolean
    result: T
}

export interface ChatRowPersistStageOptions {
    db: Database
    toSave: toSaveType
    doingChat: boolean
    forceChatPersist?: boolean
    knownChatIdsByCharacter: Map<string, Set<string>>
    generationCheckpoints: ChatCheckpointTracker
    saveChat: (chaId: string, chatIndex: number, chatId: string, chat: Chat) => Promise<void>
    requeueChats: (chats: ChatPersistId[]) => void
    now?: () => number
    onRowWriteFailure?: (chaId: string, chatId: string, error: unknown) => void
}

export interface ChatPersistStageOptions<T> extends ChatRowPersistStageOptions {
    commitStubDatabase: () => Promise<StubCommitResult<T>>
}

export interface PreparedChatPersistStage {
    completeStubCommit: <T>(commitResult: StubCommitResult<T>) => T
}

/**
 * Persist authoritative chat rows before allowing the stub database commit.
 * A row failure rejects this preparation step, so callers cannot proceed to
 * database.bin. Known ids are updated only through completeStubCommit.
 */
export async function prepareChatPersistStage(
    options: ChatRowPersistStageOptions,
): Promise<PreparedChatPersistStage> {
    const chatsToPersist = collectChatsToPersist(
        options.db,
        options.toSave,
        options.knownChatIdsByCharacter,
    )
    const isThrottledGenerationSave = options.doingChat && !options.forceChatPersist
    if (isThrottledGenerationSave) {
        // Keep every candidate dirty so the true -> false transition writes
        // the authoritative final response even after successful checkpoints.
        options.requeueChats(chatsToPersist)
    }

    const now = options.now ?? Date.now
    const durableChats: ChatPersistId[] = []
    const failedChats: ChatPersistId[] = []

    for (const [chaId, chatId] of chatsToPersist) {
        const char = options.db.characters.find(character => character?.chaId === chaId)
        if (!char) continue
        const chatIndex = char.chats.findIndex(chat => chat?.id === chatId)
        if (chatIndex === -1) continue
        const chat = char.chats[chatIndex]
        // Placeholders carry no authoritative content; their server row was
        // established before hydration and is represented by the known set.
        if (!chat || chat._placeholder) continue

        const key = chatPersistKey(chaId, chatId)
        const lastCheckpointMs = options.generationCheckpoints.get(key)
        const shouldWrite = !isThrottledGenerationSave
            || lastCheckpointMs === undefined
            || now() - lastCheckpointMs >= CHECKPOINT_INTERVAL_MS

        if (!shouldWrite) {
            // A checkpoint entry is explicit proof that this row was written
            // successfully earlier in the same generation.
            durableChats.push([chaId, chatId])
            continue
        }

        try {
            await options.saveChat(chaId, chatIndex, chatId, chat)
            options.generationCheckpoints.set(key, now())
            durableChats.push([chaId, chatId])
        } catch (error) {
            options.onRowWriteFailure?.(chaId, chatId, error)
            failedChats.push([chaId, chatId])
        }
    }

    if (failedChats.length > 0) {
        throw new ChatRowPersistError(failedChats)
    }

    return {
        completeStubCommit: <T>(commitResult: StubCommitResult<T>): T => {
            if (commitResult.committed) {
                updateKnownChatsAfterSuccessfulSave(
                    options.db,
                    options.toSave,
                    options.knownChatIdsByCharacter,
                    durableChats,
                )
            }
            return commitResult.result
        },
    }
}

/** Test-friendly one-shot wrapper around the production two-phase stage. */
export async function runChatPersistStage<T>(options: ChatPersistStageOptions<T>): Promise<T> {
    const preparedStage = await prepareChatPersistStage(options)
    const commitResult = await options.commitStubDatabase()
    return preparedStage.completeStubCommit(commitResult)
}
