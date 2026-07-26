import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    RESOURCE_CACHE_LOCAL_STORAGE_KEY,
    RESOURCE_CACHE_IO_TIMEOUT_MS,
    RESOURCE_CACHE_MAX_DB_HASHES_PER_MANIFEST,
    chainBestEffortResourceCacheOperation,
    formatHashBytes,
    getResourceCacheStats,
    isResourceCacheEnabled,
    mergeResourceManifestHashes,
    planResourceCacheRetention,
    resourceCacheManifestHashLimit,
    selectResidentManifestHashes,
    settleBestEffortResourceCache,
    setResourceCacheEnabled,
    sha256Bytes,
} from './resourceCache'

const hash = (value: number) => value.toString(16).padStart(64, '0')

afterEach(() => {
    localStorage.removeItem(RESOURCE_CACHE_LOCAL_STORAGE_KEY)
})

describe('byte resource cache helpers', () => {
    it('bounds a cache operation that never settles', async () => {
        vi.useFakeTimers()
        try {
            const result = settleBestEffortResourceCache(
                new Promise<string>(() => undefined),
                'authoritative-fallback',
            )
            await vi.advanceTimersByTimeAsync(RESOURCE_CACHE_IO_TIMEOUT_MS)
            await expect(result).resolves.toBe('authoritative-fallback')
        } finally {
            vi.useRealTimers()
        }
    })

    it('recovers a cache write chain from stalled predecessors and work', async () => {
        vi.useFakeTimers()
        try {
            const firstWork = vi.fn(() => new Promise<never>(() => undefined))
            const first = chainBestEffortResourceCacheOperation(
                new Promise<never>(() => undefined),
                firstWork,
            )

            await vi.advanceTimersByTimeAsync(RESOURCE_CACHE_IO_TIMEOUT_MS)
            expect(firstWork).toHaveBeenCalledOnce()
            await vi.advanceTimersByTimeAsync(RESOURCE_CACHE_IO_TIMEOUT_MS)
            await expect(first).resolves.toBeUndefined()

            const laterWork = vi.fn(async () => undefined)
            const later = chainBestEffortResourceCacheOperation(first, laterWork)
            await vi.advanceTimersByTimeAsync(0)
            await expect(later).resolves.toBeUndefined()
            expect(laterWork).toHaveBeenCalledOnce()
        } finally {
            vi.useRealTimers()
        }
    })

    it('formats and hashes exact bytes as lowercase SHA-256 hex', async () => {
        expect(formatHashBytes(new Uint8Array([0, 10, 255]))).toBe('000aff')
        await expect(sha256Bytes(new TextEncoder().encode('hello'))).resolves.toBe(
            '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        )
        await expect(sha256Bytes(new Uint8Array([0, 255, 1]))).resolves.not.toBe(
            await sha256Bytes(new Uint8Array([0, 255, 2])),
        )
    })

    it('keeps four newest unique hashes per manifest', () => {
        expect(mergeResourceManifestHashes([hash(2), hash(1), hash(3), hash(4)], hash(1))).toEqual([
            hash(1),
            hash(2),
            hash(3),
            hash(4),
        ])
        expect(mergeResourceManifestHashes([hash(1), 'invalid', hash(2)], hash(3), 2)).toEqual([
            hash(3),
            hash(1),
        ])
    })

    it('advertises only de-duplicated resident manifest entries', () => {
        const resident = new Set([hash(1), hash(3)])
        expect(selectResidentManifestHashes(
            [hash(1), hash(2), hash(1), 'invalid', hash(3)],
            resident,
        )).toEqual([hash(1), hash(3)])
    })

    it('prunes unreferenced and oldest entries to global bounds', () => {
        const plan = planResourceCacheRetention([
            { key: 'chat:new', hashes: [hash(1), hash(2)], sizes: [6, 6], updatedAt: 20 },
            { key: 'chat:old', hashes: [hash(3)], sizes: [6], updatedAt: 10 },
        ], [hash(1), hash(2), hash(3), hash(4)], {
            maxStoredBytes: 12,
            maxValueBytes: 10,
        })

        expect(plan.manifests).toEqual([
            { key: 'chat:new', hashes: [hash(1), hash(2)], sizes: [6, 6], updatedAt: 20 },
        ])
        expect(plan.referencedHashes).toEqual([hash(1), hash(2)])
        expect(plan.manifestDeletes).toEqual(['chat:old'])
        expect(plan.entryDeletes).toEqual([hash(3), hash(4)])
    })

    it('caps manifest count and drops missing content entries', () => {
        const plan = planResourceCacheRetention([
            { key: 'chat:one', hashes: [hash(1)], sizes: [1], updatedAt: 30 },
            { key: 'chat:two', hashes: [hash(2)], sizes: [1], updatedAt: 20 },
            { key: 'chat:three', hashes: [hash(3)], sizes: [1], updatedAt: 10 },
        ], [hash(1), hash(2)], { maxManifests: 1 })

        expect(plan.manifests.map(({ key }) => key)).toEqual(['chat:one'])
        expect(plan.manifestDeletes).toEqual(['chat:two', 'chat:three'])
        expect(plan.entryDeletes).toEqual([hash(2)])
    })

    it('keeps database manifests large while chat and KV items stay capped at four', () => {
        const hashes = Array.from({ length: 12 }, (_, index) => hash(index + 1))
        const records = [
            { key: 'db:characters', hashes, sizes: hashes.map(() => 1), updatedAt: 20 },
            { key: 'chat:char/chat', hashes, sizes: hashes.map(() => 1), updatedAt: 10 },
            { key: 'kv:pluginsave/value.json', hashes, sizes: hashes.map(() => 1), updatedAt: 5 },
        ]
        const plan = planResourceCacheRetention(records, hashes)

        expect(resourceCacheManifestHashLimit('database')).toBe(RESOURCE_CACHE_MAX_DB_HASHES_PER_MANIFEST)
        expect(resourceCacheManifestHashLimit('item')).toBe(4)
        expect(plan.manifests.find(({ key }) => key === 'db:characters')?.hashes).toHaveLength(12)
        expect(plan.manifests.find(({ key }) => key === 'chat:char/chat')?.hashes).toHaveLength(4)
        expect(plan.manifests.find(({ key }) => key === 'kv:pluginsave/value.json')?.hashes).toHaveLength(4)
    })

    it('stays disabled when IndexedDB is unavailable', async () => {
        localStorage.setItem(RESOURCE_CACHE_LOCAL_STORAGE_KEY, 'true')
        expect(globalThis.indexedDB).toBeUndefined()
        expect(isResourceCacheEnabled()).toBe(false)
        await expect(getResourceCacheStats()).resolves.toEqual({
            enabled: false,
            supported: false,
            manifestCount: 0,
            entryCount: 0,
            totalBytes: 0,
        })

        await setResourceCacheEnabled(false)
        expect(localStorage.getItem(RESOURCE_CACHE_LOCAL_STORAGE_KEY)).toBeNull()
    })
})
