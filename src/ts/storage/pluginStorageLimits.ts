/** Keep in sync with server/node/pluginStorageLimits.cjs. */
export const PLUGIN_VALUE_MAX_BYTES = 128 * 1024 * 1024

/** Values at or above this size use parser-free mode on the atomic mutation route. */
export const PLUGIN_VALUE_STREAM_THRESHOLD_BYTES = 1024 * 1024

export function pluginStorageLimitMessage(actualBytes: number): string {
    return `Plugin value is ${actualBytes} bytes; the per-value limit is ${PLUGIN_VALUE_MAX_BYTES} bytes. Split the value into smaller records.`
}
