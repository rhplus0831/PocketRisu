let pluginStorageKeySetGeneration = 0;

/** Publish a synchronous or asynchronous change to the authoritative key set. */
export function markPluginStorageKeySetChanged(): void {
    pluginStorageKeySetGeneration += 1;
}

/** Generation shared by V2 inline mutations and V3 enumeration snapshots. */
export function getPluginStorageKeySetGeneration(): number {
    return pluginStorageKeySetGeneration;
}
