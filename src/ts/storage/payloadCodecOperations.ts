import { encodeRisuSaveLegacy } from './legacyRisuSaveCodec'
import { sha256OwnedBytes } from './payloadHash'
import {
    decodeStrictRisuSaveBlocks,
    type StrictRisuSaveDatabase,
} from './strictRisuSaveCodec'

export type PayloadCodecOperation =
    | { kind: 'encode-chat'; chat: unknown; hash: boolean }
    | { kind: 'decode-strict-block'; bytes: Uint8Array }

export type PayloadCodecResult =
    | { kind: 'encode-chat'; bytes: Uint8Array; hash: string | null }
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
    return {
        kind: 'decode-strict-block',
        database: await decodeStrictRisuSaveBlocks(operation.bytes),
    }
}
