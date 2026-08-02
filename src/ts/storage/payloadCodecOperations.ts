import { encodeRisuSaveLegacy } from './legacyRisuSaveCodec'
import { sha256OwnedBytes } from './payloadHash'
import {
    decodeStrictRisuSaveBlocks,
    type StrictRisuSaveDatabase,
} from './strictRisuSaveCodec'
import { prepareChatDeltaPatch, type ChatDeltaOperation } from './chatDelta'
import { applyPatch } from 'fast-json-patch'
import { normalizeJSON } from './legacyRisuSaveCodec'

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    if (left.byteLength !== right.byteLength) return false
    for (let index = 0; index < left.byteLength; index++) {
        if (left[index] !== right[index]) return false
    }
    return true
}

export type PayloadCodecOperation =
    | { kind: 'encode-chat'; chat: unknown; hash: boolean }
    | { kind: 'prepare-chat-checkpoint'; previousChat: unknown | null; chat: unknown }
    | { kind: 'decode-strict-block'; bytes: Uint8Array }

export type PayloadCodecResult =
    | { kind: 'encode-chat'; bytes: Uint8Array; hash: string | null }
    | {
        kind: 'prepare-chat-checkpoint'
        bytes: Uint8Array
        hash: string | null
        patch: ChatDeltaOperation[] | null
    }
    | { kind: 'decode-strict-block'; database: StrictRisuSaveDatabase }

export async function runPayloadCodecOperation(
    operation: PayloadCodecOperation,
): Promise<PayloadCodecResult> {
    if (operation.kind === 'encode-chat') {
        const bytes = encodeRisuSaveLegacy(operation.chat)
        const hash = operation.hash
            ? await sha256OwnedBytes(bytes).catch(() => null)
            : null
        return { kind: 'encode-chat', bytes, hash }
    }
    if (operation.kind === 'prepare-chat-checkpoint') {
        const bytes = encodeRisuSaveLegacy(operation.chat)
        const hash = await sha256OwnedBytes(bytes).catch(() => null)
        let patch = operation.previousChat === null
            ? null
            : prepareChatDeltaPatch(operation.previousChat, operation.chat)
        // JSON Patch equality does not observe object-key insertion order, but
        // MessagePack does. Prove that replaying the candidate against the
        // acknowledged base produces the exact bytes whose digest we will ask
        // the server to acknowledge; otherwise the full-row path is required.
        if (patch) {
            try {
                const materialized = applyPatch(
                    normalizeJSON(operation.previousChat),
                    patch,
                    true,
                    false,
                    true,
                ).newDocument
                if (!equalBytes(encodeRisuSaveLegacy(materialized), bytes)) patch = null
            } catch {
                patch = null
            }
        }
        return { kind: 'prepare-chat-checkpoint', bytes, hash, patch }
    }
    return {
        kind: 'decode-strict-block',
        database: await decodeStrictRisuSaveBlocks(operation.bytes),
    }
}
