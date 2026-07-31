import policy from "../../../shared/plugin-save-key-policy.json";
import { Sha256 } from "@aws-crypto/sha256-js";
import { Buffer } from "buffer";
import { encodeBase64UrlBytes, encodeUtf8Base64Url } from "./base64Url";
import { isWellFormedUnicode } from "./unicodeWellFormed";

export const BACKUP_ENTRY_NAME_MAX_BYTES = policy.backupEntryNameMaxBytes;
export const PLUGIN_SAVE_PREFIX = policy.valuePrefix;
export const PLUGIN_SAVE_META_PREFIX = policy.metaPrefix;
export const PLUGIN_SAVE_ILL_FORMED_UTF16_TAG = policy.illFormedUtf16Tag;
export const PLUGIN_SAVE_HASHED_KEY_TAG = policy.hashedKeyTag;
export const PLUGIN_SAVE_HASHED_KEY_DOMAIN = policy.hashedKeyDomain;

export type PluginSaveStoragePrefix =
    | typeof PLUGIN_SAVE_PREFIX
    | typeof PLUGIN_SAVE_META_PREFIX;

const encoder = new TextEncoder();
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
const HASHED_COMPONENT_PATTERN = new RegExp(
    `^${PLUGIN_SAVE_HASHED_KEY_TAG.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[0-9a-f]{64}\\.json$`,
);

function encodeUtf16CodeUnitBytes(value: string): Uint8Array {
    const bytes = new Uint8Array(value.length * 2);
    for (let index = 0; index < value.length; index++) {
        const codeUnit = value.charCodeAt(index);
        bytes[index * 2] = codeUnit >>> 8;
        bytes[index * 2 + 1] = codeUnit & 0xff;
    }
    return bytes;
}

function hashedPluginStorageComponent(rawKey: string): string {
    const domain = encoder.encode(`${PLUGIN_SAVE_HASHED_KEY_DOMAIN}\0utf16be\0`);
    const keyBytes = encodeUtf16CodeUnitBytes(rawKey);
    const input = new Uint8Array(domain.byteLength + keyBytes.byteLength);
    input.set(domain);
    input.set(keyBytes, domain.byteLength);
    const hash = new Sha256();
    hash.update(input);
    return `${PLUGIN_SAVE_HASHED_KEY_TAG}${Buffer.from(hash.digestSync()).toString("hex")}.json`;
}

export function isHashedPluginSaveStorageKey(
    storageKey: string,
    prefix: PluginSaveStoragePrefix,
): boolean {
    return storageKey.startsWith(prefix)
        && HASHED_COMPONENT_PATTERN.test(storageKey.slice(prefix.length));
}

export function pluginSaveStorageKeyMappingComponent(
    storageKey: string,
    prefix: PluginSaveStoragePrefix,
): string | null {
    return isHashedPluginSaveStorageKey(storageKey, prefix)
        ? storageKey.slice(prefix.length)
        : null;
}

function decodeCanonicalBase64Url(value: string): Uint8Array {
    if (!/^[A-Za-z0-9_-]*$/.test(value)) {
        throw new Error("Invalid encoded plugin storage key.");
    }
    const padded = value
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const bytes = new Uint8Array(Buffer.from(padded, "base64"));
    if (encodeBase64UrlBytes(bytes) !== value) {
        throw new Error("Non-canonical plugin storage key.");
    }
    return bytes;
}

function encodeUtf16CodeUnits(value: string): string {
    const bytes = new Uint8Array(value.length * 2);
    for (let index = 0; index < value.length; index++) {
        const codeUnit = value.charCodeAt(index);
        bytes[index * 2] = codeUnit >>> 8;
        bytes[index * 2 + 1] = codeUnit & 0xff;
    }
    return encodeBase64UrlBytes(bytes);
}

function decodeUtf16CodeUnits(value: string): string {
    const bytes = decodeCanonicalBase64Url(value);
    if (bytes.length === 0 || bytes.length % 2 !== 0) {
        throw new Error("Invalid UTF-16 plugin storage key.");
    }
    let decoded = "";
    for (let index = 0; index < bytes.length; index += 2) {
        decoded += String.fromCharCode((bytes[index] << 8) | bytes[index + 1]);
    }
    return decoded;
}

/**
 * Decode one canonical plugin value/metadata row name. Historical ill-formed
 * JavaScript keys use a tagged UTF-16-code-unit representation so distinct
 * lone surrogates never collapse through UTF-8 replacement.
 */
export function decodePluginSaveStorageKey(
    storageKey: string,
    prefix: PluginSaveStoragePrefix,
    mappedRawKey?: string,
): string {
    if (encoder.encode(storageKey).byteLength > BACKUP_ENTRY_NAME_MAX_BYTES) {
        throw new RangeError("Plugin storage key is too long for backup archives.");
    }
    if (!storageKey.startsWith(prefix) || !storageKey.endsWith(".json")) {
        throw new Error("Invalid external plugin storage key.");
    }
    const component = storageKey.slice(prefix.length, -".json".length);
    if (component.startsWith(PLUGIN_SAVE_HASHED_KEY_TAG)) {
        if (!HASHED_COMPONENT_PATTERN.test(`${component}.json`)
            || typeof mappedRawKey !== "string"
            || `${prefix}${hashedPluginStorageComponent(mappedRawKey)}` !== storageKey) {
            throw new Error("Invalid or unmapped hashed plugin storage key.");
        }
        return mappedRawKey;
    }
    if (component.startsWith(PLUGIN_SAVE_ILL_FORMED_UTF16_TAG)) {
        const decoded = decodeUtf16CodeUnits(
            component.slice(PLUGIN_SAVE_ILL_FORMED_UTF16_TAG.length),
        );
        if (isWellFormedUnicode(decoded)) {
            throw new Error("Non-canonical plugin storage key.");
        }
        return decoded;
    }

    const bytes = decodeCanonicalBase64Url(component);
    const decoded = fatalUtf8Decoder.decode(bytes);
    if (!isWellFormedUnicode(decoded) || encodeUtf8Base64Url(decoded) !== component) {
        throw new Error("Non-canonical plugin storage key.");
    }
    return decoded;
}

/**
 * Encode an external plugin row name and enforce the archive parser's exact
 * UTF-8 byte limit. Well-formed keys retain the original UTF-8/base64url
 * representation. Ill-formed legacy JavaScript strings use tagged UTF-16 code
 * units, preserving them losslessly without colliding with ordinary Unicode.
 */
export function makeArchiveSafePluginSaveStorageKey(
    prefix: PluginSaveStoragePrefix,
    rawKey: string,
): string {
    const component = isWellFormedUnicode(rawKey)
        ? encodeUtf8Base64Url(rawKey)
        : `${PLUGIN_SAVE_ILL_FORMED_UTF16_TAG}${encodeUtf16CodeUnits(rawKey)}`;
    const legacyStorageKey = `${prefix}${component}.json`;
    const storageKey = encoder.encode(legacyStorageKey).byteLength <= BACKUP_ENTRY_NAME_MAX_BYTES
        ? legacyStorageKey
        : `${prefix}${hashedPluginStorageComponent(rawKey)}`;
    if (decodePluginSaveStorageKey(
        storageKey,
        prefix,
        isHashedPluginSaveStorageKey(storageKey, prefix) ? rawKey : undefined,
    ) !== rawKey) {
        throw new Error("Plugin storage key did not round-trip canonically.");
    }
    return storageKey;
}
