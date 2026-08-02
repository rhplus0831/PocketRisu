export const MSGPACKR_MAX_RETAINED_TARGET_BYTES = 32 * 1024 * 1024;
const MSGPACKR_RESET_TARGET_BYTES = 8 * 1024;

interface ReusableMsgpackEncoder {
    encode(value: unknown): Uint8Array;
    useBuffer(buffer: Uint8Array): void;
}

function resetSharedEncodeTarget(encoder: ReusableMsgpackEncoder): void {
    // msgpackr selects Buffer-backed writes when the browser Buffer polyfill is
    // installed. Use the same global constructor that msgpackr inspected when
    // its module loaded; importing another Buffer implementation can make its
    // optimized copy path reject the replacement target in browser-mode tests.
    const replacement = typeof globalThis.Buffer?.alloc === "function"
        ? globalThis.Buffer.alloc(MSGPACKR_RESET_TARGET_BYTES)
        : new Uint8Array(MSGPACKR_RESET_TARGET_BYTES);
    encoder.useBuffer(replacement);
}

/**
 * Keep msgpackr's module-global encode arena from retaining a one-off large
 * payload. The returned view continues to own the old arena after useBuffer()
 * switches future encodes to a fresh, small target.
 */
export function createBoundedMsgpackEncoder(
    encoder: ReusableMsgpackEncoder,
    maxRetainedTargetBytes = MSGPACKR_MAX_RETAINED_TARGET_BYTES,
): (value: unknown) => Uint8Array {
    if (!Number.isSafeInteger(maxRetainedTargetBytes)
        || maxRetainedTargetBytes < MSGPACKR_RESET_TARGET_BYTES) {
        throw new RangeError(
            `msgpackr retained-target limit must be at least ${MSGPACKR_RESET_TARGET_BYTES} bytes.`,
        );
    }

    return (value: unknown): Uint8Array => {
        let encoded: Uint8Array;
        try {
            encoded = encoder.encode(value);
        } catch (error) {
            // A failed encode can grow the shared arena before a getter or
            // extension throws. Release it without replacing the real error.
            try {
                resetSharedEncodeTarget(encoder);
            } catch {
                // Preserve the encode error; a reset failure must not mask it.
            }
            throw error;
        }

        // Ordinary results are subarray views over the shared arena, so the
        // backing buffer exposes retained capacity. Structured-clone encodes
        // with inserted reference IDs can return a separate exact-sized buffer;
        // encoded length still tells us that the hidden arena grew past the cap.
        if (encoded.byteLength > maxRetainedTargetBytes
            || encoded.buffer.byteLength > maxRetainedTargetBytes) {
            resetSharedEncodeTarget(encoder);
        }
        return encoded;
    };
}
