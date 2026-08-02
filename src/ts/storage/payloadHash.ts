export function formatHashBytes(bytes: Uint8Array): string {
    return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Hash a fresh immutable caller-owned buffer without another full-size copy. */
export async function sha256OwnedBytes(bytes: Uint8Array): Promise<string> {
    const subtle = globalThis.crypto?.subtle
    if (!subtle) throw new Error('Web Crypto SHA-256 is unavailable')
    const digest = await subtle.digest('SHA-256', bytes as BufferSource)
    return formatHashBytes(new Uint8Array(digest))
}
