import { describe, expect, test } from 'vitest'
import {
    loadPluginStorageViewerPage,
    PluginStorageViewerLoadCoordinator,
    PluginStorageViewerLoadCancelled,
} from './pluginStorageViewerPage'
import {
    comparePluginStorageKeys,
    orderPluginStorageKeys,
} from './pluginStorageRecord'

describe('plugin storage canonical ordering', () => {
    test('uses array-index order followed by raw UTF-16 code-unit order', () => {
        const composed = '\u00e9'
        const decomposed = 'e\u0301'
        expect(orderPluginStorageKeys([
            composed, '10', '01', '\ue000', '2', decomposed, '0', '\ud83d\ude00', '4294967295',
        ])).toEqual([
            '0', '2', '10', '01', '4294967295', decomposed, composed, '\ud83d\ude00', '\ue000',
        ])
        expect(comparePluginStorageKeys(composed, decomposed)).not.toBe(0)
    })
})

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

    test('passes one abort signal through serial reads and stops before the next body', async () => {
        const controller = new AbortController()
        const seenSignals: Array<AbortSignal | null | undefined> = []
        let reads = 0
        const pending = loadPluginStorageViewerPage({
            keys: Array.from({ length: 50 }, (_, index) => ({ key: `key-${index}` })),
            page: 0,
            signal: controller.signal,
            read: async (_key, signal) => {
                seenSignals.push(signal)
                reads += 1
                if (reads === 3) controller.abort(new DOMException('stop page', 'AbortError'))
                return { body: 'x'.repeat(1024 * 1024) }
            },
        })

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
        expect(reads).toBe(3)
        expect(seenSignals.every(signal => signal === controller.signal)).toBe(true)
    })
})

describe('PluginStorageViewerLoadCoordinator', () => {
    test('a newer load aborts its predecessor and keeps an identity guard', () => {
        const coordinator = new PluginStorageViewerLoadCoordinator()
        const first = coordinator.start()
        const second = coordinator.start()

        expect(first.signal.aborted).toBe(true)
        expect(first.isCurrent()).toBe(false)
        expect(second.signal.aborted).toBe(false)
        expect(second.isCurrent()).toBe(true)
        first.finish()
        expect(second.isCurrent()).toBe(true)
    })

    test('dispose aborts the active load and prevents a late commit', () => {
        const coordinator = new PluginStorageViewerLoadCoordinator()
        const load = coordinator.start()
        coordinator.dispose()

        expect(load.signal.aborted).toBe(true)
        expect(load.isCurrent()).toBe(false)
    })
})
