/** Deterministic binary-byte display used by plugin transition preflight UI. */
export function formatPluginStorageTransitionBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
    if (bytes < 1024) return `${Math.floor(bytes)} B`;
    const units = ["KiB", "MiB", "GiB"] as const;
    let value = bytes / 1024;
    let unit: typeof units[number] = units[0];
    for (let index = 1; index < units.length && value >= 1024; index += 1) {
        value /= 1024;
        unit = units[index];
    }
    return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}
