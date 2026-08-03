import { describe, expect, test } from 'vitest'
import {
    calculateStorageDashboardUsage,
    type StorageDashboardStatsInput,
} from './storageDashboardUsage'

function statsFixture(): StorageDashboardStatsInput {
    return {
        files: { db: 2_000 },
        sqlite: { reclaimable: 50 },
        chunks: { bytes: 500, liveChunked: false },
        prefixes: {
            'database/database.bin': { totalSize: 100, count: 1 },
            'chats/': {
                totalSize: 240,
                count: 2,
                physicalSize: 220,
                kvRowSize: 20,
                chunkBytes: 200,
            },
            'assets/': { totalSize: 300, count: 2 },
            'inlay/': { totalSize: 30, count: 1 },
            'inlay_thumb/': { totalSize: 10, count: 1 },
            'inlay_meta/': { totalSize: 5, count: 1 },
            'inlay_info/': { totalSize: 3, count: 1 },
            'remotes/': { totalSize: 40, count: 1 },
            'coldstorage/': { totalSize: 60, count: 1 },
        },
        pluginStorage: {
            count: 3,
            totalSize: 340,
            physicalSize: 320,
            kvRowSize: 20,
            chunkBytes: 300,
        },
        kvTotalBytes: 403,
        assetFsBytes: 200,
        inlayFsBytes: 100,
    }
}

describe('storage dashboard usage', () => {
    test('classifies optimized plugin rows and chunks outside Other data', () => {
        const usage = calculateStorageDashboardUsage(statsFixture())

        expect(usage.pluginStoragePhysical).toBe(320)
        expect(usage.databasePhysical).toBe(100)
        expect(usage.uncategorizedKv).toBe(15)
    })

    test('does not subtract chunk bodies from the KV residual', () => {
        const stats = statsFixture()
        stats.pluginStorage = {
            ...stats.pluginStorage!,
            physicalSize: 420,
            chunkBytes: 400,
        }
        stats.chunks = { bytes: 600, liveChunked: false }

        const usage = calculateStorageDashboardUsage(stats)

        expect(usage.pluginStoragePhysical).toBe(420)
        expect(usage.uncategorizedKv).toBe(15)
        expect(usage.databasePhysical).toBe(100)
    })
})
