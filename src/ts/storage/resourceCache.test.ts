import { afterEach, describe, expect, it } from 'vitest'
import {
    RESOURCE_CACHE_LOCAL_STORAGE_KEY,
    formatHashBytes,
    isResourceCacheEnabled,
    mergeResourceManifestHashes,
    planResourceCacheRetention,
    selectResidentManifestHashes,
    setResourceCacheEnabled,
    sha256Bytes,
} from './resourceCache'

const hash = (value: number) => value.toString(16).padStart(64, '0')

afterEach(() => {
    localStorage.removeItem(RESOURCE_CACHE_LOCAL_STORAGE_KEY)
})

describe('byte resource cache helpers', () => {
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

    it('stays disabled when IndexedDB is unavailable', async () => {
        localStorage.setItem(RESOURCE_CACHE_LOCAL_STORAGE_KEY, 'true')
        expect(globalThis.indexedDB).toBeUndefined()
        expect(isResourceCacheEnabled()).toBe(false)

        await setResourceCacheEnabled(false)
        expect(localStorage.getItem(RESOURCE_CACHE_LOCAL_STORAGE_KEY)).toBeNull()
    })
})
