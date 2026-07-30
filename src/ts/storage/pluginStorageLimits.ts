/** Legacy-server fallback. Current servers advertise their configured limit. */
export const DEFAULT_PLUGIN_VALUE_MAX_BYTES = 128 * 1024 * 1024

export interface PluginStorageCapabilities {
    maxValueBytes: number;
}

export function parsePluginStorageCapabilities(
    value: unknown,
): PluginStorageCapabilities | null {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null
    const maxValueBytes = (value as { maxValueBytes?: unknown }).maxValueBytes
    if (!Number.isSafeInteger(maxValueBytes) || Number(maxValueBytes) < 1) return null
    return { maxValueBytes: Number(maxValueBytes) }
}

/** Values at or above this size use parser-free mode on the atomic mutation route. */
export const PLUGIN_VALUE_STREAM_THRESHOLD_BYTES = 1024 * 1024

export function pluginStorageLimitMessage(actualBytes: number, limitBytes: number): string {
    return `Plugin value is ${actualBytes} bytes; the per-value limit is ${limitBytes} bytes. Split the value into smaller records.`
}
