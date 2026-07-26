import { describe, expect, test } from 'vitest'
import {
    loadPluginStorageViewerPage,
    PluginStorageViewerLoadCancelled,
} from './pluginStorageViewerPage'

describe('loadPluginStorageViewerPage', () => {
    test('high-cardinality repositories retain and read only the requested page', async () => {
        const keys = Array.from({ length: 10_000 }, (_, index) => ({
            key: `key-${index.toString().padStart(5, '0')}`,
            owner: `plugin-${index % 7}`,
        }))
        const reads: string[] = []
        let active = 0
        let maxActive = 0
        const result = await loadPluginStorageViewerPage({
            keys,
            page: 123,
            pageSize: 40,
            read: async (key) => {
                active++
                maxActive = Math.max(maxActive, active)
                await Promise.resolve()
                reads.push(key)
                active--
                return { key, body: 'x'.repeat(256 * 1024) }
            },
        })

        expect(result.entries).toHaveLength(40)
        expect(reads).toHaveLength(40)
        expect(reads[0]).toBe('key-04920')
        expect(maxActive).toBe(1)
        expect(result.entries.every(entry => !('raw' in entry))).toBe(true)
    })

    test('cancellation releases partially assembled page bodies', async () => {
        let reads = 0
        let cancel = false
        let lastProgress = 0
        const pending = loadPluginStorageViewerPage({
            keys: Array.from({ length: 100 }, (_, index) => ({ key: `key-${index}` })),
            page: 0,
            pageSize: 50,
            cancelled: () => cancel,
            onProgress: (completed) => {
                lastProgress = completed
                if (completed === 3) cancel = true
            },
            read: async () => ({ body: 'x'.repeat(1024 * 1024), read: reads++ }),
        })

        await expect(pending).rejects.toBeInstanceOf(PluginStorageViewerLoadCancelled)
        expect(reads).toBe(3)
        expect(lastProgress).toBe(3)
    })

    test('read errors stop the page immediately without launching later reads', async () => {
        const reads: string[] = []
        await expect(loadPluginStorageViewerPage({
            keys: Array.from({ length: 50 }, (_, index) => ({ key: `key-${index}` })),
            page: 0,
            read: async (key) => {
                reads.push(key)
                if (key === 'key-4') throw new Error('injected read failure')
                return key
            },
        })).rejects.toThrow('injected read failure')
        expect(reads).toEqual(['key-0', 'key-1', 'key-2', 'key-3', 'key-4'])
    })
})
