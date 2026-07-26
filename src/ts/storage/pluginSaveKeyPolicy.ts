import policy from "../../../shared/plugin-save-key-policy.json";
import { makeEncodedStorageKey } from "./persistentKv";

export const BACKUP_ENTRY_NAME_MAX_BYTES = policy.backupEntryNameMaxBytes;
export const PLUGIN_SAVE_PREFIX = policy.valuePrefix;
export const PLUGIN_SAVE_META_PREFIX = policy.metaPrefix;

export type PluginSaveStoragePrefix =
    | typeof PLUGIN_SAVE_PREFIX
    | typeof PLUGIN_SAVE_META_PREFIX;

const encoder = new TextEncoder();

/**
 * Encode an external plugin row name and enforce the archive parser's exact
 * UTF-8 byte limit. `makeEncodedStorageKey` performs the shared well-formed
 * Unicode validation before base64url encoding.
 */
export function makeArchiveSafePluginSaveStorageKey(
    prefix: PluginSaveStoragePrefix,
    rawKey: string,
): string {
    const storageKey = makeEncodedStorageKey(prefix, rawKey);
    if (encoder.encode(storageKey).byteLength > BACKUP_ENTRY_NAME_MAX_BYTES) {
        throw new RangeError(
            `Plugin storage key is too long for backup archives (maximum entry name: ${BACKUP_ENTRY_NAME_MAX_BYTES} UTF-8 bytes).`,
        );
    }
    return storageKey;
}
