import { createBotPresetTemplate, type Database } from './database.svelte'
import { decodeAuthoritativeRisuSave } from './risuSave'
import { PayloadCodecService } from './payloadCodecService'
import {
    applyRisuSaveBotPresetDefault,
    hasRisuSaveRemoteBlock,
    isRisuSaveBlockFormat,
} from './strictRisuSaveCodec'
import { snapshotPayload } from './payloadSnapshot'

let payloadCodecService = new PayloadCodecService()

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
    const snapshot = snapshotPayload(chat)
    return payloadCodecService.encodeChat(snapshot, hash)
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
