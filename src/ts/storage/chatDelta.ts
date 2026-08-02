import { compare } from 'fast-json-patch'
import { normalizeJSON } from './legacyRisuSaveCodec'

export const CHAT_DELTA_VERSION = 1 as const
export const CHAT_DELTA_CONTENT_TYPE = 'application/vnd.pocketrisu.chat-delta+json'
export const CHAT_DELTA_MAX_OPERATIONS = 1024
// The route shares `/api/patch`'s 32 MiB JSON admission ceiling; reserve room
// for hashes, size, version, and JSON punctuation outside the patch array.
export const CHAT_DELTA_MAX_BYTES = 32 * 1024 * 1024 - 4096

export type ChatDeltaOperation =
    | { op: 'replace'; path: `/message/${number}`; value: unknown }
    | { op: 'add'; path: '/message/-'; value: unknown }

export interface ChatDeltaRequest {
    version: typeof CHAT_DELTA_VERSION
    baseHash: string
    resultHash: string
    resultSize: number
    patch: ChatDeltaOperation[]
}

export function prepareChatDeltaPatch(
    previousChat: unknown,
    currentChat: unknown,
): ChatDeltaOperation[] | null {
    const previous = normalizeJSON(previousChat)
    const current = normalizeJSON(currentChat)
    if (!previous || typeof previous !== 'object' || Array.isArray(previous)
        || !current || typeof current !== 'object' || Array.isArray(current)
        || !Array.isArray((previous as any).message)
        || !Array.isArray((current as any).message)) return null

    const previousMessages = (previous as any).message as unknown[]
    const currentMessages = (current as any).message as unknown[]
    if (currentMessages.length < previousMessages.length) return null

    const changedMessageIndexes = new Set<number>()
    for (const operation of compare(previous, current)) {
        const match = /^\/message\/(0|[1-9]\d*)(?:\/|$)/.exec(operation.path)
        if (!match) return null
        const index = Number(match[1])
        if (!Number.isSafeInteger(index) || index < 0) return null
        changedMessageIndexes.add(index)
    }
    if (changedMessageIndexes.size === 0) return null

    const patch: ChatDeltaOperation[] = []
    for (const index of [...changedMessageIndexes].sort((left, right) => left - right)) {
        if (index < previousMessages.length) {
            if (index >= currentMessages.length) return null
            patch.push({
                op: 'replace',
                path: `/message/${index}`,
                value: currentMessages[index],
            })
        }
    }
    for (let index = previousMessages.length; index < currentMessages.length; index++) {
        patch.push({ op: 'add', path: '/message/-', value: currentMessages[index] })
    }
    if (patch.length === 0 || patch.length > CHAT_DELTA_MAX_OPERATIONS) return null
    if (new TextEncoder().encode(JSON.stringify(patch)).byteLength > CHAT_DELTA_MAX_BYTES) {
        return null
    }
    return patch
}
