export interface StorageDashboardPrefixInfo {
    totalSize: number
    count: number
    physicalSize?: number
    kvRowSize?: number
    chunkBytes?: number
}

export interface OptimizedPluginStorageStats extends StorageDashboardPrefixInfo {
    physicalSize: number
    kvRowSize: number
    chunkBytes: number
}

export interface StorageDashboardStatsInput {
    files: { db: number }
    sqlite: { reclaimable: number }
    chunks?: { bytes: number; liveChunked: boolean }
    prefixes: Record<string, StorageDashboardPrefixInfo>
    pluginStorage?: OptimizedPluginStorageStats
    kvTotalBytes: number
    assetFsBytes?: number
    inlayFsBytes?: number
}

export interface StorageDashboardUsage {
    assetTotal: number
    chatPhysical: number
    inlayTotal: number
    remoteTotal: number
    coldStorageTotal: number
    pluginStoragePhysical: number
    databasePhysical: number
    uncategorizedKv: number
    structuralOverhead: number
}

/**
 * Reconcile logical dashboard categories with their physical SQLite storage.
 * Chunk bodies are outside kvTotalBytes, while their marker rows remain in it.
 */
export function calculateStorageDashboardUsage(
    stats: StorageDashboardStatsInput,
): StorageDashboardUsage {
    const get = (key: string) => stats.prefixes[key]?.totalSize ?? 0
    const assetFsBytes = stats.assetFsBytes ?? 0
    const assetTotal = get('assets/')
    const assetKvTotal = Math.max(0, assetTotal - assetFsBytes)
    const chatTotal = get('chats/')
    const chatPhysical = stats.prefixes['chats/']?.physicalSize ?? chatTotal
    const chatKvRowSize = stats.prefixes['chats/']?.kvRowSize ?? chatTotal
    const chatChunkBytes = stats.prefixes['chats/']?.chunkBytes ?? 0
    const inlayKvTotal = get('inlay/') + get('inlay_thumb/')
        + get('inlay_meta/') + get('inlay_info/')
    const inlayTotal = inlayKvTotal + (stats.inlayFsBytes ?? 0)
    const chunkedBytes = stats.chunks?.bytes ?? 0
    const rawDatabaseBlob = stats.chunks?.liveChunked
        ? 0
        : get('database/database.bin')
    const pluginKvRowSize = stats.pluginStorage?.kvRowSize ?? 0
    const pluginChunkBytes = stats.pluginStorage?.chunkBytes ?? 0
    const pluginStoragePhysical = stats.pluginStorage?.physicalSize
        ?? pluginKvRowSize + pluginChunkBytes
    const databasePhysical = Math.max(
        0,
        chunkedBytes - chatChunkBytes - pluginChunkBytes,
    ) + rawDatabaseBlob
    const remoteTotal = get('remotes/')
    const coldStorageTotal = get('coldstorage/')
    const knownKv = assetKvTotal + chatKvRowSize + inlayKvTotal
        + remoteTotal + coldStorageTotal + rawDatabaseBlob + pluginKvRowSize
    const uncategorizedKv = Math.max(0, stats.kvTotalBytes - knownKv)
    const structuralOverhead = Math.max(
        0,
        stats.files.db - stats.kvTotalBytes - chunkedBytes - stats.sqlite.reclaimable,
    )

    return {
        assetTotal,
        chatPhysical,
        inlayTotal,
        remoteTotal,
        coldStorageTotal,
        pluginStoragePhysical,
        databasePhysical,
        uncategorizedKv,
        structuralOverhead,
    }
}
