import { Buffer } from "buffer";

/**
 * Encode bytes with the unpadded RFC 4648 base64url alphabet.
 *
 * The browser app installs the `buffer` package's Buffer polyfill, which
 * supports ordinary base64 but not Node's `base64url` encoding alias. Keep the
 * URL-safe conversion explicit so this behaves identically in both runtimes.
 */
export function encodeBase64UrlBytes(value: Uint8Array | ArrayBuffer): string {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    return Buffer.from(bytes)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

export function encodeUtf8Base64Url(value: string): string {
    return encodeBase64UrlBytes(new TextEncoder().encode(value));
}
