import { createBotPresetTemplate, type Database } from './database.svelte'
import { decodeAuthoritativeRisuSave } from './risuSave'
import { PayloadCodecService } from './payloadCodecService'
import {
    applyRisuSaveBotPresetDefault,
    hasRisuSaveRemoteBlock,
    isRisuSaveBlockFormat,
} from './strictRisuSaveCodec'
import { snapshotPayload } from './payloadSnapshot'
import type { ChatDeltaOperation } from './chatDelta'

let payloadCodecService = new PayloadCodecService()

const CHAT_ROW_RUNTIME_FIELDS = [
    'isStreaming',
    'activeStreamingDisplayOptimizationMode',
    '_placeholder',
] as const

function snapshotCurrentChatRow(chat: unknown): unknown {
    const snapshot = snapshotPayload(chat)
    if (snapshot !== null && typeof snapshot === 'object') {
        const row = snapshot as Record<string, unknown>
        for (const field of CHAT_ROW_RUNTIME_FIELDS) delete row[field]
    }
    return snapshot
}

export function setPayloadCodecServiceForTests(service: PayloadCodecService | null): void {
    payloadCodecService.dispose()
    payloadCodecService = service ?? new PayloadCodecService()
}

export async function encodeChatRowPayload(
    chat: unknown,
    hash: boolean,
): Promise<{ bytes: Uint8Array; hash: string | null }> {
    // Live Svelte proxies are not structured-cloneable. Capture the same graph
    // synchronously at the old encode point, before any awaited worker work.
    const snapshot = snapshotCurrentChatRow(chat)
    return payloadCodecService.encodeChat(snapshot, hash)
}

export async function prepareChatRowCheckpoint(
    previousChat: unknown | null,
    chat: unknown,
): Promise<{
    bytes: Uint8Array
    hash: string | null
    patch: ChatDeltaOperation[] | null
    snapshot: unknown
}> {
    // Both graphs are captured before the worker boundary. The returned current
    // snapshot becomes the next acknowledged baseline only after an exact hash
    // acknowledgement; failed/refused requests retain the previous baseline.
    const previousSnapshot = previousChat === null ? null : snapshotPayload(previousChat)
    const snapshot = snapshotCurrentChatRow(chat)
    const result = await payloadCodecService.prepareChatCheckpoint(
        previousSnapshot,
        snapshot,
    )
    return { ...result, snapshot }
}

export async function decodeAuthoritativeRisuSaveWithCodecWorker(
    data: Uint8Array,
): Promise<Database> {
    if (!isRisuSaveBlockFormat(data) || hasRisuSaveRemoteBlock(data)) {
        return decodeAuthoritativeRisuSave(data)
    }
    const decoded = await payloadCodecService.decodeStrictBlock(data)
    return applyRisuSaveBotPresetDefault(
        decoded,
        createBotPresetTemplate,
    ) as Database
}
